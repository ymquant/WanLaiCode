import { Effect } from "effect"
import * as Log from "@opencode-ai/core/util/log"
import { AppRuntime } from "@/effect/app-runtime"
import { WithInstance } from "@/project/with-instance"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { SessionRunState } from "@/session/run-state"
import { Permission } from "@/permission"
import { Question } from "@/question"
import { GlobalBus } from "@/bus/global"
import type { SessionID } from "@/session/schema"
import CONTINUATION from "./prompt/goal/continuation.txt"

const log = Log.create({ service: "goal-runtime" })

function maxAutoContinuations(): number {
  const raw = process.env["WANLAICODE_GOAL_MAX_CONTINUATIONS"] ?? process.env["OPENCODE_GOAL_MAX_CONTINUATIONS"]
  const n = raw === undefined ? 25 : Number(raw)
  return Number.isFinite(n) && n > 0 ? n : 25
}

const autoContinuationCounts = new Map<string, number>()

// 中断纪元：目标变为非 active（ESC 暂停/清除等）时同步 bump；在途的续跑起轮前对比，
// 纪元变了就放弃——堵住「idle 触发续跑读到 active → 用户 ESC → 续跑仍起新轮」的竞态。
const interruptEpochs = new Map<string, number>()

function bumpGoalInterrupt(sessionID: SessionID): void {
  interruptEpochs.set(sessionID, (interruptEpochs.get(sessionID) ?? 0) + 1)
}

export function resetGoalContinuation(sessionID: SessionID): void {
  autoContinuationCounts.delete(sessionID)
}

// 用户中断（abort）后的短窗抑制：被中断轮触发的 idle 不应自动续跑。
// 这是不依赖「写库成败/事件链时序」的硬闸——abort handler 同进程直接调用。
const suppressedUntil = new Map<string, number>()

export function suppressGoalContinuation(sessionID: SessionID, ms = 3000): void {
  suppressedUntil.set(sessionID, Date.now() + ms)
}

export function consumeGoalSuppression(sessionID: SessionID): boolean {
  const until = suppressedUntil.get(sessionID)
  if (until === undefined) return false
  suppressedUntil.delete(sessionID)
  return Date.now() < until
}

export function renderContinuation(objective: string): string {
  // 用函数形式替换，避免 objective 里的 $$/$&/$' 被当作替换模式展开（prompt 失真 + token 放大）
  return CONTINUATION.replaceAll("{{objective}}", () => objective)
}

// 用户从目标面板点「暂停」。只写 paused 是不够的：状态转非 active 只会让「还没起轮」的
// idle 续跑放弃，在途回合不受影响，会一直跑到自然结束——表现成「暂停了还在继续执行」。
// 这里与 abort（ESC/停止按钮）走同一套硬闸：
//   1. 同进程抑制下一次 idle 续跑，不依赖写库成败与事件链时序；
//   2. 先写 paused 再 cancel，否则 cancel 触发的 idle 事件会读到仍 active 的目标又拉起一轮；
//   3. cancel 传 resumeQueued: false——暂停是「全停下来」，不能让排队消息被 post-cancel resume 接着跑。
// 写 paused 失败（DB 瞬时错误，或读到 active 之后目标被并发清除/改掉）不能挡住 cancel：
// 停下在途回合才是「暂停」的本职，写库失败只降级成告警 + 让调用方报错，与 abort handler 同款。
export const pauseActiveGoal = Effect.fn("GoalRuntime.pauseActiveGoal")(function* (sessionID: SessionID) {
  const session = yield* Session.Service
  suppressGoalContinuation(sessionID)
  const paused = yield* session.setGoalStatus({ sessionID, status: "paused" }).pipe(
    Effect.catchCause((cause) =>
      Effect.sync(() => {
        log.warn("failed to pause active goal", { sessionID, cause: String(cause) })
        return null
      }),
    ),
  )
  yield* (yield* SessionPrompt.Service).cancel(sessionID, { resumeQueued: false })
  return paused
})

// 目标模式的每一轮都显式带上会话当前选定的模型。不传的话 prompt 会走它自己的回退链
// （input.model ?? agent.model ?? lastModel：历史用户消息 → provider 全局默认）——新会话没有
// 历史消息、也没显式传，就落到默认 agent 的模型或 provider 全局默认，都不是用户在选择器里选的那个；
// 会话中途换过模型时也一样会锁死在旧模型上。表现成「明明选了 A，跑的却是 B」，撞上账号池里
// 没有 B 时更会一路 503 无限重试。
// variant（思考强度 high 等）是 PromptInput 的顶层字段，和 model 分开传；不带的话目标模式会
// 悄悄退回默认强度。这里连 variant 一并透出，供两个续跑入口 spread 进 prompt。
const selectedModel = Effect.fnUntraced(function* (sessionID: SessionID) {
  const session = yield* Session.Service
  const info = yield* session.get(sessionID).pipe(Effect.orElseSucceed(() => undefined))
  if (!info?.model) return undefined
  return {
    model: { providerID: info.model.providerID, modelID: info.model.id },
    ...(info.model.variant ? { variant: info.model.variant } : {}),
  }
})

export const shouldContinue = Effect.fn("GoalRuntime.shouldContinue")(function* (sessionID: SessionID) {
  const session = yield* Session.Service
  const goal = yield* session.getGoal(sessionID)
  return goal?.status === "active"
})

const lastAssistantIsPlan = Effect.fn("GoalRuntime.lastAssistantIsPlan")(function* (sessionID: SessionID) {
  const session = yield* Session.Service
  const msgs = yield* session.messages({ sessionID })
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].info.role === "assistant") return msgs[i].info.agent === "plan"
  }
  return false
})

const hasPendingRequests = Effect.fn("GoalRuntime.hasPendingRequests")(function* (sessionID: SessionID) {
  const permission = yield* Permission.Service
  const question = yield* Question.Service
  const permissions = yield* permission.list()
  const questions = yield* question.list()
  const hasPendingPermission = permissions.some((r) => r.sessionID === sessionID)
  const hasPendingQuestion = questions.some((r) => r.sessionID === sessionID)
  return hasPendingPermission || hasPendingQuestion
})

export const runContinuation = (sessionID: SessionID) =>
  Effect.gen(function* () {
    const epoch = interruptEpochs.get(sessionID) ?? 0
    const session = yield* Session.Service
    const goal = yield* session.getGoal(sessionID)
    if (goal?.status !== "active") {
      resetGoalContinuation(sessionID)
      return
    }
    if (yield* lastAssistantIsPlan(sessionID)) return
    if (yield* hasPendingRequests(sessionID)) return
    // busy（在途轮未结束）时本次续跑直接跳过，等下个 idle tick 接力。
    // assertNotBusy busy 时是 throw（defect 通道），必须用 catchCause 收敛成布尔，
    // 否则每个 busy tick 都抛 Die(Session is busy) 被外层 catchCause 吞成 error 噪声。
    const busy = yield* (yield* SessionRunState.Service).assertNotBusy(sessionID).pipe(
      Effect.map(() => false),
      Effect.catchCause(() => Effect.succeed(true)),
    )
    if (busy) return
    const cap = maxAutoContinuations()
    const count = autoContinuationCounts.get(sessionID) ?? 0
    if (count >= cap) {
      log.info("goal auto-continuation cap reached, stopping", { sessionID, cap })
      return
    }
    // 起轮前最后一刻 double-check：上面几步 IO 期间用户可能已 ESC 暂停/清除目标
    const fresh = yield* session.getGoal(sessionID)
    if (fresh?.status !== "active" || (interruptEpochs.get(sessionID) ?? 0) !== epoch) return
    autoContinuationCounts.set(sessionID, count + 1)
    const prompt = yield* SessionPrompt.Service
    const selected = yield* selectedModel(sessionID)
    yield* prompt.prompt({
      sessionID,
      ...(selected ?? {}),
      parts: [{ type: "text", text: renderContinuation(goal.objective), synthetic: true }],
    })
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.sync(() => log.error("goal continuation failed", { sessionID, cause: String(cause) })),
    ),
  )

export const runObjectiveUpdated = (sessionID: SessionID, objective: string) =>
  Effect.gen(function* () {
    const epoch = interruptEpochs.get(sessionID) ?? 0
    const session = yield* Session.Service
    const goal = yield* session.getGoal(sessionID)
    if (goal?.status !== "active") return
    // 把 objective 作为「可见的用户消息」入会话（非 synthetic、干净文本），让用户在对话里看到自己设的目标。
    // 空闲时由这条消息直接发起一轮；正在跑 turn 时只写入历史（noReply），由后续 idle 续跑接力。
    // 注意 assertNotBusy busy 时是 throw（defect 通道），必须用 catchCause（捕获全部 cause）而非 orElseSucceed
    const busy = yield* (yield* SessionRunState.Service).assertNotBusy(sessionID).pipe(
      Effect.map(() => false),
      Effect.catchCause(() => Effect.succeed(true)),
    )
    // 起轮前最后一刻 double-check：上面几步 IO 期间用户可能已 ESC 暂停/清除目标（与 runContinuation 同款竞态闸）
    const fresh = yield* session.getGoal(sessionID)
    if (fresh?.status !== "active" || (interruptEpochs.get(sessionID) ?? 0) !== epoch) return
    const prompt = yield* SessionPrompt.Service
    const selected = yield* selectedModel(sessionID)
    yield* prompt.prompt({
      sessionID,
      ...(selected ?? {}),
      ...(busy ? { noReply: true } : {}),
      parts: [
        // 可见的目标气泡（用户在对话里看到自己设的目标）
        { type: "text", text: objective },
        // 隐藏的目标框架（completion audit 等）：让模型首轮干完就调 update_goal complete，不必多一轮复核。
        // 仅在「立即起轮」时附带；busy（noReply）时不放，否则在途轮结束后 runContinuation 会再注入一次，导致框架在历史中重复。
        ...(busy ? [] : [{ type: "text" as const, text: renderContinuation(objective), synthetic: true }]),
      ],
    })
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.sync(() => log.error("goal objective-updated failed", { sessionID, cause: String(cause) })),
    ),
  )

let started = false

function runInInstance(directory: string, fn: () => Promise<unknown>): void {
  void WithInstance.provide({ directory, fn }).catch(() => {})
}

export function ensureGoalRuntime(): void {
  if (started) return
  started = true
  // 订阅跨实例 GlobalBus：每请求实例发布的 session 事件都桥接到这里（带 directory）。
  // 不能用 Bus.Service.subscribe——那只订阅启动期实例的 PubSub，收不到请求实例的 idle 事件。
  GlobalBus.on("event", (event) => {
    const directory = event?.directory
    const payload = event?.payload
    if (!directory || !payload) return
    if (payload.type === "session.goal.cleared") {
      const sessionID = payload.properties?.sessionID
      if (sessionID) {
        bumpGoalInterrupt(sessionID)
        resetGoalContinuation(sessionID)
      }
      return
    }
    if (payload.type === "session.idle") {
      const sessionID = payload.properties?.sessionID
      if (!sessionID) return
      // 用户刚 abort 过：这次 idle 是被中断轮触发的，不续跑
      if (consumeGoalSuppression(sessionID)) return
      runInInstance(directory, () => AppRuntime.runPromise(runContinuation(sessionID)))
      return
    }
    if (payload.type === "session.goal.updated") {
      const props = payload.properties ?? {}
      const goal = props.goal
      if (!props.sessionID) return
      if (goal?.status !== "active") {
        // 暂停/阻塞/完成：同步抬升中断纪元，让在途的续跑在起轮前放弃
        bumpGoalInterrupt(props.sessionID)
        return
      }
      // 目标转回 active（恢复/设定）：用户明确要继续，清掉 abort 留下的续跑抑制
      suppressedUntil.delete(props.sessionID)
      if (props.objectiveChanged) {
        // 设/改目标（含首次）：把 objective 作为可见用户消息入会话并发起一轮
        resetGoalContinuation(props.sessionID)
        runInInstance(directory, () => AppRuntime.runPromise(runObjectiveUpdated(props.sessionID, goal.objective)))
      } else {
        // 状态恢复（暂停→继续）或重设相同 objective：直接续跑
        runInInstance(directory, () => AppRuntime.runPromise(runContinuation(props.sessionID)))
      }
    }
  })
  log.info("goal runtime started")
}

export * as GoalRuntime from "./goal-runtime"
