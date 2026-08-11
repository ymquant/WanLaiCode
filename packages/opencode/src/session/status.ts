import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { InstanceState } from "@/effect/instance-state"
import { MessageID, SessionID } from "./schema"
import { Goal } from "./goal"
import { zod } from "@/util/effect-zod"
import { NonNegativeInt, withStatics } from "@/util/schema"
import { Effect, Layer, Context, Schema } from "effect"
import z from "zod"

export const Info = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("idle"),
  }),
  Schema.Struct({
    type: Schema.Literal("retry"),
    // retry 仍属于同一个逻辑回合；携带 turnID 让前端在重试窗口继续把引导绑定到原回合。
    turnID: Schema.optional(MessageID),
    // startedAt 标识同一次 active run；即使 turnID 尚未发布，前端也能防止 unresolved steer 绑定到后来回合。
    startedAt: Schema.optional(NonNegativeInt),
    attempt: NonNegativeInt,
    // 无限重试模式下不设总次数，故 total 可选；UI 有 total 才显示分母。
    total: Schema.optional(NonNegativeInt),
    message: Schema.String,
    next: NonNegativeInt,
    code: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("busy"),
    // turnID 是服务端当前活动回合的权威标识；旧事件与尚未建立回合的短窗口允许缺省。
    turnID: Schema.optional(MessageID),
    // busy/retry 往返时继承同一时间戳，idle 后新启动的活动必须获得新的代次。
    startedAt: Schema.optional(NonNegativeInt),
  }),
])
  .annotate({ identifier: "SessionStatus" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type Info = Schema.Schema.Type<typeof Info>

export const Event = {
  Status: BusEvent.define(
    "session.status",
    Schema.Struct({
      sessionID: SessionID,
      status: Info,
    }),
  ),
  // deprecated
  Idle: BusEvent.define(
    "session.idle",
    Schema.Struct({
      sessionID: SessionID,
    }),
  ),
  GoalUpdated: BusEvent.define(
    "session.goal.updated",
    Schema.Struct({
      sessionID: SessionID,
      goal: Goal,
      // setGoal（用户设定目标的动作）恒为 true——重设相同文本也算；setGoalStatus 不带此字段。
      // goal-runtime 据此区分「设定目标 → 注入可见 objective 消息」和「状态恢复 → 续跑」。
      objectiveChanged: Schema.optional(Schema.Boolean),
    }),
  ),
  GoalCleared: BusEvent.define(
    "session.goal.cleared",
    Schema.Struct({
      sessionID: SessionID,
    }),
  ),
}

export interface Interface {
  readonly get: (sessionID: SessionID) => Effect.Effect<Info>
  readonly list: () => Effect.Effect<Map<SessionID, Info>>
  readonly set: (sessionID: SessionID, status: Info) => Effect.Effect<void>
  // 标记「当前中断由用户主动发起」（点击停止）。SessionRunState.cancel 打标，
  // processor 的 onInterrupt 读标以区分用户主动中断与被动中断（实例 scope 关闭 / 重启）。
  readonly markUserAbort: (sessionID: SessionID) => Effect.Effect<void>
  // 读取并清除用户主动取消标记，返回是否命中；未命中即视为被动中断，静默恢复不落错误。
  readonly takeUserAbort: (sessionID: SessionID) => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionStatus") {}

// HTTP 与 AppRuntime 使用不同的 SessionStatus Layer；主动停止标记必须跨 Layer 传给真正持有 processor 的实例。
// 标记会被 processor 或 cancel 的 ensuring 立即消费，按全局唯一 sessionID 存储不会跨会话串扰。
const userAbort = new Set<SessionID>()

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service

    const state = yield* InstanceState.make(
      Effect.fn("SessionStatus.state")(() => Effect.succeed(new Map<SessionID, Info>())),
    )

    const runStartedAt = yield* InstanceState.make(
      Effect.fn("SessionStatus.runStartedAt")(() => Effect.succeed(new Map<SessionID, number>())),
    )

    const get = Effect.fn("SessionStatus.get")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      return data.get(sessionID) ?? { type: "idle" as const }
    })

    const list = Effect.fn("SessionStatus.list")(function* () {
      return new Map(yield* InstanceState.get(state))
    })

    const set = Effect.fn("SessionStatus.set")(function* (sessionID: SessionID, status: Info) {
      const data = yield* InstanceState.get(state)
      const previous = data.get(sessionID)
      const starts = yield* InstanceState.get(runStartedAt)
      const inheritedStartedAt = previous?.type !== "idle" ? previous?.startedAt : undefined
      // 同一毫秒内 idle→busy 也必须产生不同代次；单独保存高水位，避免 Date.now() 碰撞导致旧 steer 误绑。
      const nextStartedAt =
        status.type === "idle"
          ? undefined
          : (status.startedAt ?? inheritedStartedAt ?? Math.max(Date.now(), (starts.get(sessionID) ?? 0) + 1))
      if (nextStartedAt !== undefined) starts.set(sessionID, Math.max(starts.get(sessionID) ?? 0, nextStartedAt))
      // processor 的 retry 与循环内 busy 更新不感知 run-state；同一活动同时继承 turnID 和 startedAt，idle 后再 busy 才开启新代次。
      const next =
        status.type === "idle"
          ? status
          : {
              ...status,
              turnID: status.turnID ?? (previous?.type !== "idle" ? previous?.turnID : undefined),
              startedAt: nextStartedAt,
            }
      yield* bus.publish(Event.Status, { sessionID, status: next })
      if (next.type === "idle") {
        yield* bus.publish(Event.Idle, { sessionID })
        data.delete(sessionID)
        return
      }
      data.set(sessionID, next)
    })

    const markUserAbort = Effect.fn("SessionStatus.markUserAbort")(function* (sessionID: SessionID) {
      userAbort.add(sessionID)
    })

    const takeUserAbort = Effect.fn("SessionStatus.takeUserAbort")(function* (sessionID: SessionID) {
      return userAbort.delete(sessionID)
    })

    return Service.of({ get, list, set, markUserAbort, takeUserAbort })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Bus.layer))

export * as SessionStatus from "./status"
