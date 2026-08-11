import { describe, expect } from "bun:test"
import { Context, Deferred, Effect, Exit, Fiber, Layer, Ref, Scope } from "effect"
import { SessionRunState } from "@/session/run-state"
import { SessionID } from "@/session/schema"
import type { MessageV2 } from "@/session/message-v2"
import { SessionStatus } from "@/session/status"
import { it } from "../lib/effect"
import * as Log from "@opencode-ai/core/util/log"

void Log.init({ print: false })

// ensureRunning/onInterrupt 的返回类型，测试不检查其内容。
const dummy = { info: {} as MessageV2.Info, parts: [] } as MessageV2.WithParts

// 构建一套独立的 SessionRunState 实例（各自服务图）。两套实例共享模块级 runner 索引，
// 但各持一张私有 runners 表——正是线上「HTTP 服务端 vs AppRuntime」两套服务图的形态。
const buildRunState = Effect.gen(function* () {
  const scope = yield* Scope.Scope
  const ctx = yield* Layer.buildWithMemoMap(SessionRunState.defaultLayer, Layer.makeMemoMapUnsafe(), scope)
  return Context.get(ctx, SessionRunState.Service)
})

// 同时暴露每套服务图自己的状态服务，验证控制端标记能传给真正持有 runner/processor 的服务图。
const buildRunControl = Effect.gen(function* () {
  const scope = yield* Scope.Scope
  const statusLayer = SessionStatus.defaultLayer
  const ctx = yield* Layer.buildWithMemoMap(
    Layer.merge(statusLayer, SessionRunState.layer.pipe(Layer.provide(statusLayer))),
    Layer.makeMemoMapUnsafe(),
    scope,
  )
  return {
    runState: Context.get(ctx, SessionRunState.Service),
    status: Context.get(ctx, SessionStatus.Service),
  }
})

describe("SessionRunState 跨实例", () => {
  it.instance(
    "同一会话跨实例复用同一 runner：第二个实例不另起 processor，且能取消对方在跑的回合",
    () =>
      Effect.gen(function* () {
        const a = yield* buildRunState
        const b = yield* buildRunState
        const sessionID = SessionID.make("ses_crossinstance")

        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const ranB = yield* Ref.make(0)

        // A 起一轮：signal started 后挂住，直到被取消（release 只是兜底，正常走不到）。
        const workA = Effect.gen(function* () {
          yield* Deferred.succeed(started, undefined)
          yield* Deferred.await(release)
          return dummy
        })
        const fiberA = yield* a.ensureRunning(sessionID, Effect.succeed(dummy), workA).pipe(Effect.forkChild)
        yield* Deferred.await(started)

        // B 视角：assertNotBusy 应看到 busy（跨实例索引命中）。
        expect(Exit.isFailure(yield* b.assertNotBusy(sessionID).pipe(Effect.exit))).toBe(true)

        // 核心回归：B 对同一会话 ensureRunning 必须复用 A 的 runner、合并等待既有回合，
        // 绝不执行自己的 work（不另起第二个 runner / processor）。修复前 ranB 会变 1。
        const workB = Effect.gen(function* () {
          yield* Ref.update(ranB, (n) => n + 1)
          return dummy
        })
        const fiberB = yield* b.ensureRunning(sessionID, Effect.succeed(dummy), workB).pipe(Effect.forkChild)
        yield* Effect.sleep("30 millis")
        expect(yield* Ref.get(ranB)).toBe(0)

        // B cancel 应命中 A 正在跑的 runner 并中断；A、B 两个 fiber 都随之收敛。
        yield* b.cancel(sessionID)
        expect(Exit.isSuccess(yield* Fiber.await(fiberA).pipe(Effect.timeout("2 seconds"), Effect.exit))).toBe(true)
        expect(Exit.isSuccess(yield* Fiber.await(fiberB).pipe(Effect.timeout("2 seconds"), Effect.exit))).toBe(true)
      }),
  )

  it.instance(
    "跨实例取消会把主动停止标记传给 owner processor",
    () =>
      Effect.gen(function* () {
        const owner = yield* buildRunControl
        const controller = yield* buildRunControl
        const sessionID = SessionID.make("ses_crossinstance_abort")
        const started = yield* Deferred.make<void>()
        const interruptedByUser = yield* Deferred.make<boolean>()

        const work = Effect.gen(function* () {
          yield* Deferred.succeed(started, undefined)
          yield* Effect.never
          return dummy
        }).pipe(
          Effect.onInterrupt(() =>
            owner.status.takeUserAbort(sessionID).pipe(
              Effect.flatMap((marked) => Deferred.succeed(interruptedByUser, marked)),
              Effect.asVoid,
            ),
          ),
        )
        const fiber = yield* owner.runState
          .ensureRunning(sessionID, Effect.succeed(dummy), work)
          .pipe(Effect.forkChild)
        yield* Deferred.await(started)

        // 控制端与 owner 使用不同 Layer；取消仍须让 owner 把这次中断识别为用户主动停止。
        yield* controller.runState.cancel(sessionID)
        expect(yield* Deferred.await(interruptedByUser)).toBe(true)
        expect(Exit.isSuccess(yield* Fiber.await(fiber).pipe(Effect.timeout("2 seconds"), Effect.exit))).toBe(true)
      }),
  )
})
