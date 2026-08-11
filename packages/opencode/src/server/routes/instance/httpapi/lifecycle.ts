import { EffectBridge } from "@/effect/bridge"
import type { InstanceContext } from "@/project/instance"
import { InstanceStore } from "@/project/instance-store"
import { Effect } from "effect"
import { HttpEffect, HttpMiddleware, HttpServerRequest } from "effect/unstable/http"

type MarkedInstance = {
  ctx: InstanceContext
  store: InstanceStore.Interface
  bridge: EffectBridge.Shape
  reason: string
}

// Disposal is requested by an endpoint handler, but must run from the outer
// server middleware after the response has been produced. The original Request
// object is the stable handoff key between those two phases.
const disposeAfterResponse = new WeakMap<object, MarkedInstance>()

const mark = (ctx: InstanceContext, reason: string) =>
  Effect.gen(function* () {
    return { ctx, store: yield* InstanceStore.Service, bridge: yield* EffectBridge.make(), reason }
  })

export const markInstanceForDisposal = (ctx: InstanceContext, reason = "dispose") =>
  Effect.gen(function* () {
    const marked = yield* mark(ctx, reason)
    return yield* HttpEffect.appendPreResponseHandler((request, response) =>
      Effect.sync(() => {
        // The response is sent before disposeMiddleware performs the teardown.
        disposeAfterResponse.set(request.source, marked)
        return response
      }),
    )
  })

export const markInstanceForReload = (ctx: InstanceContext, next: InstanceStore.LoadInput, reason = "reload") =>
  Effect.gen(function* () {
    const marked = yield* mark(ctx, reason)
    return yield* HttpEffect.appendPreResponseHandler((_request, response) =>
      // 后台执行重载：reload 现在会先排空活跃回合再拆旧实例，同步等待会阻塞 HTTP 响应。
      // bridge.fork 在 AppRuntime 上分离执行，响应立即返回，旧实例在回合跑完后才重载，不砍断生成。
      Effect.as(
        Effect.sync(() => marked.bridge.fork(marked.store.reload(next, reason))),
        response,
      ),
    )
  })

export const disposeMiddleware: HttpMiddleware.HttpMiddleware = (effect) =>
  Effect.gen(function* () {
    const response = yield* effect
    const request = yield* HttpServerRequest.HttpServerRequest
    const marked = disposeAfterResponse.get(request.source)
    if (!marked) return response
    disposeAfterResponse.delete(request.source)
    // 后台执行拆除：dispose 现在会先排空活跃回合（最长 DRAIN_TIMEOUT），若在此同步等待会把
    // HTTP 响应阻塞数分钟。bridge.fork 在 AppRuntime 上分离执行，让响应立即返回，实例在活跃回合
    // 跑完后才真正拆除并生效，既不阻塞请求也不砍断正在生成的回答。
    yield* Effect.sync(() => marked.bridge.fork(marked.store.dispose(marked.ctx, marked.reason)))
    return response
  })
