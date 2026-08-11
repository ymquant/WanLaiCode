import { InstanceState } from "@/effect/instance-state"
import { registerDrainer } from "@/effect/instance-registry"
import { Runner } from "@/effect/runner"
import * as Log from "@opencode-ai/core/util/log"
import { Effect, Latch, Layer, Scope, Context } from "effect"
import * as Session from "./session"
import { MessageV2 } from "./message-v2"
import { SessionID } from "./schema"
import { SessionStatus } from "./status"

const log = Log.create({ service: "session.run-state" })

// 跨实例的 cancel 索引（按 sessionID）。
// SessionRunState 会被实例化多份：HTTP 服务端自建一套服务图、AppRuntime 另有一套，各持一张
// 每实例私有的 runners 表。普通对话经 HTTP 起轮、cancel 也走 HTTP，命中同一份实例的表能停下；
// 但目标模式的续跑是 AppRuntime.runPromise 起的，runner 落在 AppRuntime 那份表里，HTTP 的
// cancel 在服务端那份表里永远找不到——表现成「目标模式暂停/停止点了没反应」。状态事件没露馅是
// 因为它们经模块级 GlobalBus 桥接跨了过去，而 runner 注册表原本没这层桥接。
//
// 这里只加一张模块级「谁在跑」的索引供 cancel/assertNotBusy 跨实例查到 runner，runners 主表仍
// 保持每实例私有——所以 finalizer 只取消/清理自己那份表，不会误伤另一存活实例的 runner；索引
// 条目在 runner idle 时删除，不随进程无界增长。session 同一时刻只在一处跑，故按 sessionID 足够。
const runnerIndex = new Map<SessionID, Runner.Runner<MessageV2.WithParts>>()

export interface Interface {
  readonly assertNotBusy: (sessionID: SessionID) => Effect.Effect<void>
  readonly cancel: (sessionID: SessionID) => Effect.Effect<void>
  readonly ensureRunning: (
    sessionID: SessionID,
    onInterrupt: Effect.Effect<MessageV2.WithParts>,
    work: Effect.Effect<MessageV2.WithParts>,
  ) => Effect.Effect<MessageV2.WithParts>
  readonly startShell: (
    sessionID: SessionID,
    onInterrupt: Effect.Effect<MessageV2.WithParts>,
    work: Effect.Effect<MessageV2.WithParts>,
    ready?: Latch.Latch,
  ) => Effect.Effect<MessageV2.WithParts>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionRunState") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const status = yield* SessionStatus.Service

    const state = yield* InstanceState.make(
      Effect.fn("SessionRunState.state")(function* (ctx) {
        const scope = yield* Scope.Scope
        const runners = new Map<SessionID, Runner.Runner<MessageV2.WithParts>>()
        // churn（配置写入/项目重载/驱逐/显式 dispose）拆掉本实例前，先等本目录在跑的回合
        // 自然结束，避免被动中断砍断生成；同时落一条 WARN 记下触发来源，便于定位。
        const off = registerDrainer((directory, reason) =>
          directory !== ctx.directory
            ? Effect.void
            : Effect.gen(function* () {
                const busy = [...runners.values()].filter((runner) => runner.busy)
                if (busy.length === 0) return
                yield* Effect.sync(() =>
                  log.warn("draining active sessions before instance teardown", {
                    directory: ctx.directory,
                    reason,
                    activeRuns: busy.length,
                  }),
                )
                // 等各 runner 自然结束；总时长上限由 drainInstance 统一兜底。
                yield* Effect.forEach(busy, (runner) => runner.awaitIdle, {
                  concurrency: "unbounded",
                  discard: true,
                })
              }),
        )
        yield* Effect.addFinalizer(
          Effect.fnUntraced(function* () {
            off()
            yield* Effect.forEach(runners.values(), (runner) => runner.cancel, {
              concurrency: "unbounded",
              discard: true,
            })
            // 只清理本实例注册进索引的条目（cancel 触发的 onIdle 通常已删，这里兜底残留），
            // 不动别的实例的条目。
            for (const [sessionID, runner] of runners) if (runnerIndex.get(sessionID) === runner) runnerIndex.delete(sessionID)
            runners.clear()
          }),
        )
        return { runners, scope }
      }),
    )

    const runner = Effect.fn("SessionRunState.runner")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<MessageV2.WithParts>,
    ) {
      const data = yield* InstanceState.get(state)
      // 去重必须跨实例：同一会话若已在别的实例（目标模式在 AppRuntime）上有 runner，直接复用它，
      // 否则本实例会再起一个 runner + 覆盖索引——原 runner 丢索引后暂停/停止再也命中不了，且两个
      // processor 并发写同一会话。复用另一实例的 runner 时不放进本实例 data.runners、不覆盖索引：
      // 它归创建实例管，其 onIdle 也从创建实例的表 + 索引里删。ensureRunning 命中 busy runner 会
      // 合并等待既有回合、丢弃本次 work，不会起第二个 processor。
      const existing = data.runners.get(sessionID) ?? runnerIndex.get(sessionID)
      if (existing) return existing
      const next = Runner.make<MessageV2.WithParts>(data.scope, {
        onIdle: Effect.gen(function* () {
          data.runners.delete(sessionID)
          if (runnerIndex.get(sessionID) === next) runnerIndex.delete(sessionID)
          yield* status.set(sessionID, { type: "idle" })
        }),
        onBusy: status.set(sessionID, { type: "busy" }),
        onInterrupt,
        busy: () => {
          throw new Session.BusyError(sessionID)
        },
      })
      data.runners.set(sessionID, next)
      runnerIndex.set(sessionID, next)
      return next
    })

    // 优先本实例私有表；查不到再退到跨实例索引（目标模式 runner 在另一实例上时靠这条命中）。
    const lookup = (sessionID: SessionID, own: Map<SessionID, Runner.Runner<MessageV2.WithParts>>) =>
      own.get(sessionID) ?? runnerIndex.get(sessionID)

    const assertNotBusy = Effect.fn("SessionRunState.assertNotBusy")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      const existing = lookup(sessionID, data.runners)
      if (existing?.busy) throw new Session.BusyError(sessionID)
    })

    const cancel = Effect.fn("SessionRunState.cancel")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      const existing = lookup(sessionID, data.runners)
      if (!existing || !existing.busy) {
        yield* status.set(sessionID, { type: "idle" })
        return
      }
      // 用户主动停止：打标记，让 processor 的 onInterrupt 落成 MessageAbortedError；
      // 被动中断（实例 scope 关闭 finalizer 直接调 runner.cancel）不经过这里，故不打标记。
      // existing.cancel 会等 fiber 完全中断（onInterrupt 已消费标记）后返回，ensuring 再清掉
      // 未被消费的残留（中断落在 stream 处理区之外的情况），把标记生命周期收紧到本次 cancel 内，
      // 避免残留标记污染后续回合的被动中断判定。
      yield* status.markUserAbort(sessionID)
      yield* existing.cancel.pipe(Effect.ensuring(status.takeUserAbort(sessionID)))
    })

    const ensureRunning = Effect.fn("SessionRunState.ensureRunning")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<MessageV2.WithParts>,
      work: Effect.Effect<MessageV2.WithParts>,
    ) {
      return yield* (yield* runner(sessionID, onInterrupt)).ensureRunning(work)
    })

    const startShell = Effect.fn("SessionRunState.startShell")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<MessageV2.WithParts>,
      work: Effect.Effect<MessageV2.WithParts>,
      ready?: Latch.Latch,
    ) {
      return yield* (yield* runner(sessionID, onInterrupt)).startShell(work, ready)
    })

    return Service.of({ assertNotBusy, cancel, ensureRunning, startShell })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(SessionStatus.defaultLayer))

export * as SessionRunState from "./run-state"
