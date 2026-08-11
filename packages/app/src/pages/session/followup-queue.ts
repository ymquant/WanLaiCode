import type { AssistantMessage, Message, Part, SessionStatus } from "@opencode-ai/sdk/v2/client"
import { parseAddToChatUserMessageDisplay } from "@opencode-ai/core/util/add-to-chat-composed-message"

export type FollowupTurnState = "missing" | "pending" | "completed" | "error"

export const AWAITING_USER_RUNNING_GRACE_MS = 45_000
export const ASSISTANT_TEXT_STREAMING_GRACE_MS = 12_000
export const STALE_ASSISTANT_RUNNING_MS = 30 * 60_000
export const FOLLOWUP_AWAITING_MISSING_GRACE_MS = 5 * 60_000
// 后台异步 prompt 失败时接口仍可能返回 204；顺序锁只在空闲且超过这段宽限后回收，避免输入框永久卡住。
export const MANUAL_STEER_PENDING_MISSING_GRACE_MS = 15_000

export function resolvedSessionStatusBusy(input: {
  status: SessionStatus | undefined
  snapshotReady: boolean
  sessionKnown?: boolean
}) {
  // idle 会话不会保留在稀疏 status map；只有快照/事件尚未到达时，缺失 key 才代表未知。
  if (input.status) return input.status.type !== "idle"
  return input.snapshotReady || input.sessionKnown ? false : undefined
}

export function sessionActiveTurnID(status: SessionStatus | undefined) {
  // 只有后端明确声明 busy/retry 的状态才代表可绑定回合；idle 和前端推导态都不能猜测目标。
  if (status?.type !== "busy" && status?.type !== "retry") return
  if (!status.turnID) return
  return status.turnID
}

export function sessionActiveTurnStartedAt(status: SessionStatus | undefined) {
  if (status?.type !== "busy" && status?.type !== "retry") return
  if (typeof status.startedAt !== "number" || !Number.isFinite(status.startedAt)) return
  return status.startedAt
}

export function selectManualSteerTargetTurnID(input: {
  pendingTargetTurnID?: string
  status: SessionStatus | undefined
}) {
  // 连续引导沿用当前顺序锁的权威回合；mismatch 重试会先更新该锁，普通状态事件无权改绑。
  if (input.pendingTargetTurnID) return input.pendingTargetTurnID
  return sessionActiveTurnID(input.status)
}

export function manualSteerTargetWaitState(input: {
  runtimeOwned: boolean
  originInProgressObserved: boolean
  requestedAt?: number
  targetTurnID?: string
  expectedStartedAt?: number
  activeStartedAt?: number
  expectedTurnGroupID?: string
  activeTurnGroupID?: string
  inactiveObserved: boolean
  statusKnown: boolean
  inferredBusy: boolean
  statusBusy: boolean
}) {
  // unresolved 等待只能由创建它的页面运行时继续；刷新后的草稿不能拿后来回合的 turnID 静默改绑。
  if (!input.runtimeOwned) return { type: "stale" as const }
  // 官方 conversation callback 一旦观察到原 turn 非 inProgress 就立即失效；后来新 run 的 busy/turnID 无权复活它。
  if (input.inactiveObserved) return { type: "inactive" as const }
  // startedAt 缺失时仍用意图创建时的逻辑 turn 分组隔离后来 run，避免首个迟到 status 被误当成原代次。
  if (
    input.expectedTurnGroupID !== undefined &&
    input.activeTurnGroupID !== undefined &&
    input.expectedTurnGroupID !== input.activeTurnGroupID
  )
    return { type: "inactive" as const }
  // 同一会话可能在前端未观察到 idle 的极短窗口里启动新 run；代次不一致时按原回合 inactive 处理。
  if (
    input.expectedStartedAt !== undefined &&
    input.activeStartedAt !== undefined &&
    input.expectedStartedAt !== input.activeStartedAt
  )
    return { type: "inactive" as const }
  // 若提交时没有任何可见回合身份，后来的 startedAt 只能属于新回合；宁可回退普通发送，也不能静默错绑。
  if (
    input.requestedAt !== undefined &&
    input.expectedStartedAt === undefined &&
    input.expectedTurnGroupID === undefined &&
    input.activeStartedAt !== undefined &&
    input.activeStartedAt > input.requestedAt
  )
    return { type: "inactive" as const }
  if (
    input.originInProgressObserved &&
    input.expectedStartedAt === undefined &&
    input.expectedTurnGroupID === undefined &&
    input.activeStartedAt === undefined &&
    input.activeTurnGroupID === undefined &&
    input.targetTurnID !== undefined
  )
    return { type: "inactive" as const }
  // 明确 idle 比任何本地推导和旧 pending 目标都权威，必须复用原 messageID 走 inactive fallback。
  if (input.statusKnown && !input.statusBusy) return { type: "inactive" as const }
  if (input.targetTurnID) return { type: "ready" as const, targetTurnID: input.targetTurnID }
  // 对齐官方 rfe：权威 busy 或创建时已经确认的活动代次都继续等 turnID；status 暂时缺失不等价于 inactive。
  if (input.statusBusy || (!input.statusKnown && (input.originInProgressObserved || input.inferredBusy)))
    return { type: "waiting" as const }
  return { type: "inactive" as const }
}

export function manualSteerTargetWaitInactiveObserved(input: {
  inactiveObserved: boolean
  originInProgressObserved: boolean
  statusObserved: boolean
  statusKnown: boolean
  statusBusy: boolean
  inferredBusy: boolean
}) {
  if (input.inactiveObserved) return true
  // status 可能从未赶上本次短 run；只要创建 steer 时已确认 inProgress，随后消息运行证据消失，
  // 就等价于官方 conversation callback 观察到 non-inProgress，不能继续等到超时或借用后来 turn。
  if (!input.statusKnown)
    return !input.inferredBusy && (input.statusObserved || input.originInProgressObserved)
  return !input.statusBusy
}

/**
 * 复刻 ChatGPT composer ref 与 queued follow-up conversation Set 的共同语义：同会话一次只提交一个请求，
 * 不同会话仍可并行。注册表放在页面组件外，路由卸载再挂载也不会丢掉尚未返回的 durable ACK 锁。
 */
export function createFollowupSendClaimRegistry() {
  const claims = new Map<string, string>()
  const listeners = new Set<() => void>()
  const notify = () => listeners.forEach((listener) => listener())

  return {
    claim(sessionID: string, messageID: string) {
      if (claims.has(sessionID)) return false
      claims.set(sessionID, messageID)
      notify()
      return true
    },
    release(sessionID: string, messageID: string) {
      // 迟到请求只能释放自己建立的锁，不能把同会话后来请求的锁一起删掉。
      if (claims.get(sessionID) !== messageID) return false
      claims.delete(sessionID)
      notify()
      return true
    },
    busy(sessionID: string) {
      return claims.has(sessionID)
    },
    messageID(sessionID: string) {
      return claims.get(sessionID)
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      // 页面卸载只移除自己的观察者，会话中的在途认领继续保留到原请求 ACK。
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

export function manualSteerMessageMatchesTarget(input: {
  message?: Pick<Message, "id" | "role"> & { steerTargetTurnID?: string }
  parts?: readonly Part[]
  messageID: string
  targetTurnID: string
}) {
  if (input.message?.role !== "user" || input.message.id !== input.messageID) return false
  // 持久化 user message 上的目标回合是刷新后的权威 ACK；普通 user 或旧目标不能确认本次引导。
  if (input.message.steerTargetTurnID === input.targetTurnID) return true
  // marker 作为旧数据/分片同步的兼容证据，仍必须同时命中协议标记与目标回合。
  return (input.parts ?? []).some(
    (part) =>
      part.type === "text" &&
      part.synthetic === true &&
      part.metadata?.manual_steer_context === true &&
      part.metadata.manual_steer_target_turn_id === input.targetTurnID,
  )
}

export function followupPromptMessageMatches(input: {
  message?: Pick<Message, "id" | "role"> & { steerTargetTurnID?: string }
  messageID: string
}) {
  // steer fallback 的 ACK 丢失时只认后端同 ID 的普通 user；带 steer 目标的 optimistic/旧消息不能冒充新回合。
  return (
    input.message?.role === "user" &&
    input.message.id === input.messageID &&
    input.message.steerTargetTurnID === undefined
  )
}

export function assistantTurnTerminal(message: AssistantMessage) {
  if (message.error) return true
  if (typeof message.time.completed === "number") return true
  if (message.finish) return !["tool-calls", "unknown"].includes(message.finish)
  return false
}

export function manualSteerStepInFlight(message: AssistantMessage, statusBusy?: boolean) {
  // 工具循环的中间 assistant 可能先写 completed；只要后端仍 busy，tool-calls/unknown 仍属于当前步骤。
  return statusBusy === true && (message.finish === "tool-calls" || message.finish === "unknown")
}

function manualSteerAssistantTerminal(message: AssistantMessage, statusBusy?: boolean) {
  // 中间工具步骤不能释放引导顺序锁；真正终态会由后续 stop/error assistant 覆盖。
  if (manualSteerStepInFlight(message, statusBusy)) return false
  return assistantTurnTerminal(message)
}

export function assistantTurnActive(
  message: AssistantMessage,
  options?: { statusBusy?: boolean; now?: number; parts?: readonly Part[] },
) {
  // 每个工具小步骤都会先写 completed，但新鲜的 step-finish 只代表该步骤完成；只要 runner 仍 busy，
  // 下一条 assistant 首包到达前仍是同一活动回合。宽限必须从 completed 起算：若工具本身执行超过 45 秒，
  // 从 created 起算会在工具刚结束时立即耗尽宽限，让侧边栏 loading 在同一 runner 的步骤间错误消失。
  const completedToolLoopStep =
    manualSteerStepInFlight(message, options?.statusBusy) &&
    assistantPartsHaveStepFinish(options?.parts) &&
    withinGrace(message.time.completed ?? message.time.created, {
      maxAgeMs: AWAITING_USER_RUNNING_GRACE_MS,
      now: options?.now,
    })
  if (completedToolLoopStep) return true
  if (assistantTurnTerminal(message)) return false
  // 悬空 running 证据的兜底：后端进程被杀/崩溃时，最后一条 assistant 会留下永远停在
  // status=running 的 tool part。运行证据此前没有任何时间上限，判活恒为真 ——「处理中」
  // 不回落、停止按钮 ■ 不切回发送，用户只能手动点终止（「任务输出完还在思考中」的形态之一）。
  // 判据刻意保守：后端只要活着就会持续发布 busy 状态，所以仅在**会话已 idle**且这条
  // assistant 已超过 STALE_ASSISTANT_RUNNING_MS 时才不再采信运行证据；长时间的真实工具
  // 回合 statusBusy 恒为 true，不受影响。年龄基准取 message.time.created，与下方既有的
  // 陈旧判据同源（tool part 的 time.start 由后端各处写入，保真度不如消息创建时刻）。
  const runningEvidenceCredible =
    options?.statusBusy !== false ||
    withinGrace(message.time.created, { maxAgeMs: STALE_ASSISTANT_RUNNING_MS, now: options?.now })
  // 工具/图片仍在运行时，step-finish 只能说明文本步骤结束，不能提前释放整个回合。
  // 文本缺 end 仍由后面的 step-finish 释放，避免历史流式文本把输入框长期锁住。
  if (runningEvidenceCredible && assistantPartsHaveRunningEvidence(options?.parts, { ignoreText: true, now: options?.now }))
    return true
  // 多步工具回合的步间空档：某一步以 finish="tool-calls" 收尾（每步是独立 assistant 消息，见
  // sessionHasRunningTurn 注释），其 step-finish / 完成证据只标记「本步结束」，agent 循环还会继续下一步。
  // 只要会话仍 busy（后端在生成下一步），就不能据此释放整个回合，否则消息下方会提前出现时间戳、输入框
  // 停止按钮回退成发送。这类消息继续走下面的时间宽限 / statusBusy 判活跃；真正结束时后端会追加
  // finish!=="tool-calls" 的终步消息，lastAssistantMessage 随之变 terminal 自然收尾。
  // 注：会话已 idle（回合真以工具步收尾）时不豁免，仍按 step-finish/完成证据释放，避免停止按钮卡住。
  const keepAliveToolLoop = message.finish === "tool-calls" && options?.statusBusy === true
  if (!keepAliveToolLoop && assistantPartsHaveStepFinish(options?.parts)) return false
  if (runningEvidenceCredible && assistantPartsHaveRunningEvidence(options?.parts, { now: options?.now })) return true
  if (!keepAliveToolLoop && assistantPartsHaveCompletedEvidence(options?.parts, { now: options?.now })) return false
  if (withinGrace(message.time.created, { maxAgeMs: AWAITING_USER_RUNNING_GRACE_MS, now: options?.now })) return true
  // 与上面 runningEvidenceCredible 同一保守取向：只有明确读到 statusBusy === false(会话已 idle)才不再
  // 采信运行证据；undefined(状态尚未加载/bootstrap 窗口)必须跟 true 一样继续给到 30 分钟兜底窗口，
  // 否则长回合会在刷新/深链/重连时被误判成已结束（调用方必须传真三态，不能把「未知」折叠成 false）。
  if (options?.statusBusy === false) return false
  return withinGrace(message.time.created, { maxAgeMs: STALE_ASSISTANT_RUNNING_MS, now: options?.now })
}

export function compactionInFlight(input: {
  messages: readonly Message[]
  partsByMessage: Record<string, readonly Part[] | undefined>
  statusBusy: boolean
  now?: number
}): boolean {
  if (!input.statusBusy) return false
  const last = input.messages.findLast((message): message is AssistantMessage => message.role === "assistant")
  if (!last || last.summary !== true) return false
  // 终态判据必须跟 packages/ui/src/components/session-turn-members.ts 的 compactionFinished 保持同一口径
  // (只看 time.completed / error，不看 finish)；两边分叉的窗口里分割线已经显示「会话已压缩」，
  // 这里却仍判「压缩中」锁住引导按钮，UI 与闸门自相矛盾。两处不共享代码时必须手动同步这条公式。
  if (!!last.time.completed || !!last.error) return false
  if (!last.parentID) return false
  const parts = input.partsByMessage[last.parentID]
  if (!(parts ?? []).some((part) => part.type === "compaction")) return false
  // 陈旧兜底：后端进程被杀时，压缩摘要可能永远收不到 completed/error，闸门会一直锁死。
  // 与 assistantTurnActive 的 STALE_ASSISTANT_RUNNING_MS 兜底同源，超时后宁可漏拦也不能让输入框永久卡住。
  return withinGrace(last.time.created, { maxAgeMs: STALE_ASSISTANT_RUNNING_MS, now: input.now })
}

export function activeTimelineTurnGroupID(input: {
  status: SessionStatus | undefined
  messages: readonly Message[]
  partsByMessage: Record<string, readonly Part[] | undefined>
  turnIDByMessageID: Readonly<Record<string, string | undefined>>
  now?: number
}) {
  const statusTurnID = sessionActiveTurnID(input.status)
  // 官方始终从 inProgress turn 读取稳定 turnId；只要权威状态已经发布，就不能再被时间线末尾的普通队列覆盖。
  if (statusTurnID) return input.turnIDByMessageID[statusTurnID] ?? statusTurnID

  const statusBusy = input.status?.type === "busy" || input.status?.type === "retry"
  const activeAssistant = input.messages.findLast((message): message is AssistantMessage => {
    if (message.role !== "assistant") return false
    // turnID 发布前先认真实在途 assistant；工具步骤之间虽已写 completed，busy 下仍属于同一个活动 turn。
    return (
      assistantTurnActive(message, {
        statusBusy,
        now: input.now,
        parts: input.partsByMessage[message.id],
      }) || manualSteerStepInFlight(message, statusBusy)
    )
  })
  // busy 首包空窗里没有任何活动消息证据时必须继续等权威 turnID，不能把时间线最后一个普通 queued turn 当成活动回合。
  if (!activeAssistant) return

  // 新协议的映射已经吸收 assistant.turnID；其余分支只为旧历史和分页尚未加载根消息时保留兼容。
  return (
    input.turnIDByMessageID[activeAssistant.id] ??
    activeAssistant.turnID ??
    input.turnIDByMessageID[activeAssistant.parentID] ??
    activeAssistant.parentID
  )
}

function assistantTurnSettled(message: AssistantMessage, parts: readonly Part[] | undefined, now: number | undefined) {
  if (assistantTurnTerminal(message)) return true
  // 与 active 判定保持一致：step-finish 不能盖过仍在运行的工具/图片证据。
  if (assistantPartsHaveRunningEvidence(parts, { ignoreText: true, now })) return false
  if (assistantPartsHaveStepFinish(parts)) return true
  // 有些工具失败/图片生成失败会先落可见 part，再异步补 message.completed。
  // 这里按 Codex 的 turn_status 思路，把“已有完成证据且无运行证据”的 assistant 当成已结束，
  // 避免 session.status 仍是 busy 时把上一条用户消息继续判成 awaiting，导致输入框卡在停止态。
  return assistantPartsHaveCompletedEvidence(parts, { now }) && !assistantPartsHaveRunningEvidence(parts, { now })
}

function assistantTurnAnswered(message: AssistantMessage, parts: readonly Part[] | undefined) {
  if (assistantTurnTerminal(message)) return true
  // “已回应用户”和“回合已结束”不是同一件事：流式文本刚出现时，用户已被回应，
  // 但 follow-up 队列仍要等 text-end / tool-end 后才能继续自动发送。
  return assistantPartsHaveAnswerEvidence(parts)
}

function assistantPartsHaveRunningEvidence(
  parts: readonly Part[] | undefined,
  options?: { ignoreText?: boolean; now?: number },
) {
  // Codex 的引导窗口跟真实 turn 执行态走；文本 start 缺 end 只能说明时间戳不完整，
  // 不能覆盖已经可见的 assistant 输出，否则历史回复会把输入框长期锁进“引导”模式。
  // 图片生成失败时也会留下 wanlai-image-loading 占位文件；只要工具已经成功或失败落定，
  // 占位图就不应再作为运行证据，否则失败后输入框会继续显示停止按钮。
  const settledImageGeneration = assistantPartsHaveSettledImageGeneration(parts)
  const hasImageGenerationTool = (parts ?? []).some((part) => part.type === "tool" && part.tool === "image_generation")
  const visibleText = assistantPartsHaveVisibleText(parts)
  return (parts ?? []).some((part) => {
    if (part.type === "tool") return part.state.status === "pending" || part.state.status === "running"
    if (!options?.ignoreText && assistantTextStillStreaming(part, options?.now)) return true
    if (part.type === "file")
      // 生图回合会先流出说明文本，再等工具附件落盘；只要 image_generation 未落定，loading 占位仍代表真实运行态。
      return (
        !settledImageGeneration &&
        (!visibleText || hasImageGenerationTool) &&
        part.filename?.startsWith("wanlai-image-loading-")
      )
    return false
  })
}

function assistantPartsHaveCompletedEvidence(parts: readonly Part[] | undefined, options?: { now?: number }) {
  return (parts ?? []).some((part) => {
    if (part.type === "tool") return part.state.status === "completed" || part.state.status === "error"
    if (part.type === "file") return !part.filename?.startsWith("wanlai-image-loading-")
    if (part.type === "text" || part.type === "reasoning")
      return part.text.trim().length > 0 && !assistantTextStillStreaming(part, options?.now)
    return part.type === "step-finish" || part.type === "patch" || part.type === "snapshot"
  })
}

function assistantPartsHaveStepFinish(parts: readonly Part[] | undefined) {
  return (parts ?? []).some((part) => part.type === "step-finish")
}

function assistantPartsHaveAnswerEvidence(parts: readonly Part[] | undefined) {
  return (parts ?? []).some((part) => {
    if (part.type === "tool") return part.state.status === "completed" || part.state.status === "error"
    if (part.type === "file") return !part.filename?.startsWith("wanlai-image-loading-")
    if (part.type === "text" || part.type === "reasoning") return part.text.trim().length > 0
    return part.type === "step-finish" || part.type === "patch" || part.type === "snapshot"
  })
}

function assistantPartsHaveVisibleText(parts: readonly Part[] | undefined) {
  return (parts ?? []).some((part) => {
    if (part.type !== "text" && part.type !== "reasoning") return false
    if (part.type === "text" && (part.synthetic || part.ignored)) return false
    return part.text.trim().length > 0
  })
}

function assistantTextStillStreaming(part: Part, now: number | undefined) {
  if (part.type !== "text" && part.type !== "reasoning") return false
  if (part.type === "text" && (part.synthetic || part.ignored)) return false
  if (!part.text.trim()) return false
  const start = part.time?.start
  if (typeof start !== "number" || typeof part.time?.end === "number") return false
  // text-start/text-delta 到 text-end 之间要继续视为运行中；
  // 只有超过短窗口还没 end 的历史脏 part 才作为已可见输出释放输入框。
  // 可见文本已经出现但缺 text-end 时，只保留较短的流式宽限；
  // 否则一句话的引导回复会因为 provider 未及时补 end 而显示长时间“处理中”。
  return withinGrace(start, { maxAgeMs: ASSISTANT_TEXT_STREAMING_GRACE_MS, now })
}

function assistantPartsHaveSettledImageGeneration(parts: readonly Part[] | undefined) {
  return (parts ?? []).some((part) => {
    if (part.type !== "tool" || part.tool !== "image_generation") return false
    if (part.state.status === "error") return true
    if (part.state.status !== "completed") return false
    return (part.state.attachments ?? []).some(
      (attachment) => attachment.mime.startsWith("image/") && !attachment.filename?.startsWith("wanlai-image-loading-"),
    )
  })
}

function userPartNeedsReply(part: Part) {
  if (part.type === "text") return !part.ignored && !part.synthetic && part.text.trim().length > 0
  return part.type === "file"
}

function withinGrace(created: number, options?: { maxAgeMs?: number; now?: number }) {
  if (options?.maxAgeMs === undefined) return true
  return (options.now ?? Date.now()) - created <= options.maxAgeMs
}

function normalizeFollowupText(text: string) {
  const parsed = parseAddToChatUserMessageDisplay(text)
  return (parsed?.body ?? text).replace(/\s+/g, " ").trim()
}

function skillArguments(part: Part) {
  if (part.type !== "text") return undefined
  const skill = part.metadata?.skill
  if (!skill || typeof skill !== "object") return undefined
  const raw = skill as Record<string, unknown>
  if (typeof raw.arguments !== "string") return undefined
  return raw.arguments.trim() || undefined
}

export function userVisibleText(parts: readonly Part[] | undefined) {
  const argumentsText = (parts ?? [])
    .flatMap((part) => {
      if (part.type !== "text" || part.synthetic || part.ignored) return []
      const text = skillArguments(part)
      return text ? [text] : []
    })
    .join("\n")
  if (argumentsText) return normalizeFollowupText(argumentsText)

  return normalizeFollowupText(
    (parts ?? [])
      .flatMap((part) => {
        if (part.type !== "text") return []
        if (part.synthetic || part.ignored) return []
        return [part.text]
      })
      .join("\n"),
  )
}

export function hasAwaitingUserMessages(
  messages: readonly Message[],
  partsByMessage: Record<string, readonly Part[] | undefined>,
  options?: { ignoredUserMessageIDs?: ReadonlySet<string>; maxAgeMs?: number; now?: number },
) {
  return latestAwaitingUserMessageID(messages, partsByMessage, options) !== undefined
}

export function trailingManualSteerMessageID(
  messages: readonly Message[],
  steeredByMessageID: Readonly<Record<string, number>>,
) {
  const latest = messages.at(-1)
  // 只识别时间线尾部已经确认的 steer；历史 steer 或其后的普通队列都不能借用当前 session 的 busy 状态。
  if (latest?.role !== "user" || !steeredByMessageID[latest.id]) return undefined
  return latest.id
}

export function latestAwaitingUserMessageID(
  messages: readonly Message[],
  partsByMessage: Record<string, readonly Part[] | undefined>,
  options?: { ignoredUserMessageIDs?: ReadonlySet<string>; maxAgeMs?: number; now?: number },
) {
  const indexes = new Map(messages.map((message, index) => [message.id, index]))
  const completed = new Set<string>()
  const respondedThrough = messages.reduce((max, message) => {
    if (message.role !== "assistant" || !assistantTurnAnswered(message, partsByMessage[message.id])) return max
    if (message.completedUserMessageIDs) {
      // 显式列表补充同轮覆盖的旧根消息，但 assistant 自己的 parent 永远也已被回应；旧数据不保证把 parent 重复写进列表。
      if (message.parentID) completed.add(message.parentID)
      message.completedUserMessageIDs.forEach((id) => completed.add(id))
      return max
    }
    const parentIndex = message.parentID ? indexes.get(message.parentID) : undefined
    return parentIndex === undefined ? max : Math.max(max, parentIndex)
  }, -1)

  // 用户消息会先进入时间线，assistant 首包稍后才到；返回具体 ID 让 UI 能把这段空窗挂到同一轮处理态上。
  return messages.findLast((message, index) => {
    if (message.role !== "user") return false
    if (options?.ignoredUserMessageIDs?.has(message.id)) return false
    // steer 的显式覆盖列表允许跨过普通队列；位置 high-water 只用于旧 assistant，不能再按字符串 ID 推断时间。
    if (index <= respondedThrough || completed.has(message.id)) return false
    if (!withinGrace(message.time.created, options)) return false

    const parts = partsByMessage[message.id]
    if (!parts) return true
    if (parts.some((part) => part.type === "compaction" || part.type === "subtask")) return false
    return parts.some(userPartNeedsReply)
  })?.id
}

// 取最新一条 assistant 消息(数组按 id/时间升序,即最后一条 assistant)。回合的运行态/在途判定统一以它为准:
// 已完成回合的最新 assistant 是 terminal;真正在途回合的最新 assistant 是非 terminal。这样能避免把「已被
// 后续步骤取代的历史 tool-calls 步」误当在途(tool-calls 被 assistantTurnTerminal 排除为非 terminal)。
export function lastAssistantMessage(messages: readonly Message[]): AssistantMessage | undefined {
  return messages.findLast((message): message is AssistantMessage => message.role === "assistant")
}

export function sessionHasRunningTurn(input: {
  messages: readonly Message[] | undefined
  partsByMessage: Record<string, readonly Part[] | undefined>
  // undefined = 状态尚未加载(bootstrap 窗口)，不能等价于 false(已确认 idle)；
  // 调用方必须把这两种情况分开传，否则下面 assistantTurnActive 的 30 分钟兜底会失效。
  statusBusy: boolean | undefined
  statusRetry?: boolean
  ignoredUserMessageIDs?: ReadonlySet<string>
  now?: number
}) {
  // retry 是 runner 仍在执行的权威状态。失败 attempt 已经落下的 step-finish 只结束那次传输，
  // 不能让时间线、输入框和队列把整个逻辑回合误判为空闲。
  if (input.statusRetry) return true
  if (!input.messages) return false
  // 只看最新一条 assistant 消息的活跃状态:已完成回合的最新消息是 terminal → 不运行;真正在途回合的最新
  // 消息是非 terminal → 由乐观时间宽限/statusBusy 判活跃(保留刷新/深链时 session.status 未加载完的乐观态)。
  const lastAssistant = lastAssistantMessage(input.messages)
  if (
    lastAssistant &&
    assistantTurnActive(lastAssistant, {
      statusBusy: input.statusBusy,
      now: input.now,
      parts: input.partsByMessage[lastAssistant.id],
    })
  )
    return true
  if (!input.statusBusy) return false

  // Codex 只在真实运行态下把输入切到 queue/steer。这里保留一个很短的乐观窗口，
  // 只覆盖用户消息刚落库、assistant 回合事件还没到达的瞬间，避免历史脏状态继续卡住输入框。
  return hasAwaitingUserMessages(input.messages, input.partsByMessage, {
    ignoredUserMessageIDs: input.ignoredUserMessageIDs,
    maxAgeMs: AWAITING_USER_RUNNING_GRACE_MS,
    now: input.now,
  })
}

export function sessionHasStaleRunState(input: {
  messages: readonly Message[] | undefined
  partsByMessage: Record<string, readonly Part[] | undefined>
  statusBusy: boolean | undefined
  ignoredUserMessageIDs?: ReadonlySet<string>
  busyConfirmedAt?: number
  now?: number
}) {
  if (!input.messages) return false
  const running = sessionHasRunningTurn(input)
  if (running) return false
  if (!input.statusBusy) return false

  // 后端 busy 是长任务仍在执行的权威信号；可见文本超过短流式窗口只是不再点亮“处理中”，不能立即把会话改成 idle。
  // 新 user 已经落库但 assistant 首包尚未到达时，同样以 user 创建时间作为运行证据；否则长时间预处理会在 45 秒后
  // 被误清为 idle，让后续输入绕过真实任务。stale 清理故意不忽略 steer user，当前引导也必须受到这段保护。
  const lastAssistant = lastAssistantMessage(input.messages)
  const awaitingUserMessageID = latestAwaitingUserMessageID(input.messages, input.partsByMessage)
  const awaitingUser = awaitingUserMessageID
    ? input.messages.find((message) => message.role === "user" && message.id === awaitingUserMessageID)
    : undefined
  const latestEvidenceAt = Math.max(
    lastAssistant && !assistantTurnTerminal(lastAssistant) ? lastAssistant.time.created : Number.NEGATIVE_INFINITY,
    awaitingUser?.time.created ?? Number.NEGATIVE_INFINITY,
    // 超过静态时间窗后会向 sidecar 重新确认；确认仍 busy 的时刻就是新的权威运行证据。
    input.busyConfirmedAt ?? Number.NEGATIVE_INFINITY,
  )
  if (!Number.isFinite(latestEvidenceAt)) return true
  return !withinGrace(latestEvidenceAt, { maxAgeMs: STALE_ASSISTANT_RUNNING_MS, now: input.now })
}

function messageAfterFollowupBoundary(input: {
  message: Message
  index: number
  boundaryIndex: number
  boundaryID?: string
  boundaryCreated?: number
}) {
  if (input.boundaryIndex >= 0) return input.index > input.boundaryIndex
  // 边界滑出分页后优先使用持久化创建时间；空会话只有时间边界时也必须排除更早的历史消息。
  if (input.boundaryCreated === undefined || !Number.isFinite(input.boundaryCreated)) {
    // 旧 followup.v1 只有显式边界 ID 时无法证明远控消息先后；远控边界保守保留，其它旧草稿使用安全后缀兜底。
    if (!input.boundaryID) return true
    return !/remote/i.test(input.boundaryID)
  }
  const created = input.message.time?.created
  if (typeof created !== "number" || !Number.isFinite(created)) return false
  if (created !== input.boundaryCreated) return created > input.boundaryCreated
  // 创建时间相同时使用真实消息 ID 作稳定游标；没有边界 ID 的空会话无法比较，只能接收后缀消息。
  if (!input.boundaryID) return true
  return input.message.id > input.boundaryID
}

export function followupDraftAlreadySent(input: {
  draftText: string
  afterMessageID?: string
  afterMessageCreated?: number
  messages: readonly Message[]
  partsByMessage: Record<string, readonly Part[] | undefined>
  ignoredMessageIDs?: ReadonlySet<string>
}) {
  const draftText = normalizeFollowupText(input.draftText)
  if (!draftText) return false
  const boundaryIndex = input.afterMessageID
    ? input.messages.findIndex((message) => message.id === input.afterMessageID)
    : -1

  return input.messages.some((message, index) => {
    if (message.role !== "user") return false
    if (input.ignoredMessageIDs?.has(message.id)) return false
    if (
      !messageAfterFollowupBoundary({
        message,
        index,
        boundaryIndex,
        boundaryID: input.afterMessageID,
        boundaryCreated: input.afterMessageCreated,
      })
    )
      return false
    return userVisibleText(input.partsByMessage[message.id]) === draftText
  })
}

export function unsentFollowupDrafts<T extends { id: string }>(input: {
  drafts: readonly T[]
  draftText: (draft: T) => string
  afterMessageID?: (draft: T) => string | undefined
  afterMessageCreated?: (draft: T) => number | undefined
  messages: readonly Message[]
  partsByMessage: Record<string, readonly Part[] | undefined>
  ignoredMessageIDs?: ReadonlySet<string>
}) {
  const usedMessages = new Set<string>()
  return input.drafts.filter((draft) => {
    const draftText = normalizeFollowupText(input.draftText(draft))
    if (!draftText) return true
    const explicitBoundaryID = input.afterMessageID?.(draft)
    const boundaryIndex = input.messages.findIndex((message) => message.id === (explicitBoundaryID ?? draft.id))
    const boundaryCreated = input.afterMessageCreated?.(draft)

    const match = input.messages.find((message, index) => {
      if (message.role !== "user") return false
      // 每个排队项只和入队之后出现的用户消息去重，避免历史里相同文案把新的排队消息误删。
      // 边界滑出分页后只使用持久化创建时间；同毫秒无法确认先后时保守保留，不能依赖远控 ID。
      if (
        !messageAfterFollowupBoundary({
          message,
          index,
          boundaryIndex,
          boundaryID: explicitBoundaryID,
          boundaryCreated,
        })
      )
        return false
      if (usedMessages.has(message.id)) return false
      if (input.ignoredMessageIDs?.has(message.id)) return false
      return userVisibleText(input.partsByMessage[message.id]) === draftText
    })
    if (!match) return true

    usedMessages.add(match.id)
    return false
  })
}

export function nextFollowupToSend<T extends { id: string; manualSteer?: boolean }>(
  drafts: readonly T[],
  options?: { paused?: boolean; resumeIDs?: ReadonlySet<string>; compacting?: boolean },
) {
  // 压缩会重写会话历史；manualSteer 项本来就越过下方调用方的忙态判断直接投递，压缩期间必须连“选出下一条”都不做，
  // 否则被发送闸打回后乐观气泡留在时间线里，恢复的草稿会被去重 effect 误判成已发送删掉（见 session.tsx 自动续发 effect）。
  if (options?.compacting) return
  // 用户停止会把普通 follow-up 队列置为暂停；停止前尚未收到 durable ACK 的引导只能由恢复名单逐条接续。
  if (options?.paused) return drafts.find((draft) => options.resumeIDs?.has(draft.id))
  // 手动引导属于当前 active turn，必须越过更早的普通本地队列；多条引导之间仍保持原到达顺序。
  return drafts.find((draft) => draft.manualSteer === true) ?? drafts[0]
}

export function followupPausedQueueAllowsSend(input: { paused: boolean; resumeAfterAbort?: boolean }) {
  // 停止后的全局暂停只放行未 ACK 引导恢复项；普通排队消息必须继续等待用户显式恢复。
  return !input.paused || input.resumeAfterAbort === true
}

export function followupMessageID(draft: { id: string; messageID?: string }, deferredMessageID?: string) {
  // 新队列项在真正发送时才绑定 messageID，避免早先入队的 ID 把稍后产生的 assistant 插到 steer 后面；旧草稿仍兼容 id。
  return draft.messageID ?? deferredMessageID ?? draft.id
}

export function downgradeFollowupSteerToQueue<
  T extends {
    manualSteer?: boolean
    targetTurnID?: string
    targetTurnStartedAt?: number
    optimisticTurnID?: string
  },
>(
  draft: T,
): Omit<T, "manualSteer" | "targetTurnID" | "targetTurnStartedAt" | "optimisticTurnID"> {
  const queued = { ...draft }
  // 目标缺失或已经失效时只移除 steer 语义，稳定 messageID 与完整草稿必须原样保留。
  delete queued.manualSteer
  delete queued.targetTurnID
  delete queued.targetTurnStartedAt
  delete queued.optimisticTurnID
  return queued
}

export function recoverStaleSteerToPausedQueue<
  T extends {
    manualSteer?: boolean
    targetTurnID?: string
    targetTurnStartedAt?: number
    optimisticTurnID?: string
  },
>(draft: T) {
  // 只有显式中断，或刷新后已经无法确认 ACK 所有权时才保守暂停；
  // 非中断 inactive 由发送层恢复为普通队列并自动继续，保持与 ChatGPT turn/completed 一致。
  return { item: downgradeFollowupSteerToQueue(draft), paused: true as const }
}

export function followupFailureIsStaleSteerTarget(error: unknown, options?: { localHost?: boolean }): boolean {
  if (!error) return false
  if (typeof error === "string") {
    // 官方只为本地主机兼容旧 NoActiveTurn 文本；远程主机必须返回稳定的领域错误名才能降级。
    return error.includes("SteerTurnInactiveError") || (options?.localHost === true && error.includes("NoActiveTurn("))
  }
  if (error instanceof Error) {
    if (error.name === "SteerTurnInactiveError") return true
    if (
      error.message.includes("SteerTurnInactiveError") ||
      (options?.localHost === true && error.message.includes("NoActiveTurn("))
    )
      return true
  }
  if (typeof error !== "object") return false
  const value = error as Record<string, unknown>
  if (value.name === "SteerTurnInactiveError") return true
  if (
    typeof value.message === "string" &&
    (value.message.includes("SteerTurnInactiveError") ||
      (options?.localHost === true && value.message.includes("NoActiveTurn(")))
  )
    return true
  // 对齐官方壳：只沿 SDK 的错误包装寻找稳定领域错误名，裸 409 可能是权限或版本冲突，绝不能静默新开回合。
  if ("error" in value && followupFailureIsStaleSteerTarget(value.error, options)) return true
  if ("data" in value && followupFailureIsStaleSteerTarget(value.data, options)) return true
  if ("response" in value && followupFailureIsStaleSteerTarget(value.response, options)) return true
  return false
}

/**
 * 从 steer 失败响应中提取服务端当前真正活动的 turn；只有拿到这个字段时才允许按官方逻辑重试一次。
 * HTTP SDK、旧版错误包装和测试 transport 的嵌套形状都可能不同，因此这里递归读取 error/response/data。
 */
export function followupActualSteerTarget(error: unknown): string | undefined {
  if (!error) return
  const mismatch = (typeof error === "string" ? error : error instanceof Error ? error.message : undefined)?.match(
    /expected active turn id `[^`]+` but found `([^`]+)`/,
  )
  // 官方客户端只从这条精确 mismatch 文本改绑；其他错误即使碰巧带 turn 字段也不能触发重试。
  if (mismatch?.[1]) return mismatch[1]
  if (typeof error !== "object") return
  const value = error as Record<string, unknown>
  if (value.name === "SteerTurnInactiveError") {
    const data =
      typeof value.data === "object" && value.data !== null ? (value.data as Record<string, unknown>) : undefined
    const actual = data?.actualTurnID ?? value.actualTurnID
    // 本项目的后端提供等价的结构化字段；必须和领域错误名同时出现，避免把普通 409 误判为 mismatch。
    if (typeof actual === "string" && actual.length > 0) return actual
  }
  return (
    ("error" in value ? followupActualSteerTarget(value.error) : undefined) ??
    ("response" in value ? followupActualSteerTarget(value.response) : undefined) ??
    ("data" in value ? followupActualSteerTarget(value.data) : undefined)
  )
}

export function followupsForSignOutGeneration<T>(drafts: readonly T[], generation: number) {
  // 未记录代次的历史草稿属于首代；退出后只允许当前代次自动发送，旧项必须由用户重新确认。
  return drafts.filter((draft) => ((draft as T & { signOutGeneration?: number }).signOutGeneration ?? 0) === generation)
}

export function recoverManualSteerDraft<T extends { id: string }>(input: {
  items: readonly T[]
  recovery?: { item: T; index: number }
  messageObserved: boolean
}) {
  const current = input.items.slice()
  // durable ACK 前刷新时才需要恢复草稿；后端已经出现同 messageID 时禁止重发，避免生成重复用户消息。
  if (!input.recovery || input.messageObserved || current.some((item) => item.id === input.recovery?.item.id))
    return current
  current.splice(Math.min(Math.max(input.recovery.index, 0), current.length), 0, input.recovery.item)
  return current
}

export function pauseManualSteerState<T extends { id: string }>(input: {
  items: readonly T[]
  pending?: { messageID: string; acknowledged?: boolean; recovery?: { item: T; index: number } }
}) {
  if (!input.pending)
    return { items: input.items.slice(), optimisticMessageID: undefined }
  // 官方 restoreMessage 只用于尚未接受的 steering item；RPC 已接受后停止原回合不能再恢复成第二条草稿。
  if (input.pending.acknowledged || !input.pending.recovery)
    return { items: input.items.slice(), optimisticMessageID: input.pending.messageID }
  // 停止时要先移除同 ID 的 optimistic user 再恢复草稿，否则去重 effect 会把草稿再删一次。
  return {
    items: recoverManualSteerDraft({ items: input.items, recovery: input.pending.recovery, messageObserved: false }),
    optimisticMessageID: input.pending.messageID,
  }
}

export function followupsAfterSendAck<T extends { id: string; afterMessageID?: string; afterMessageCreated?: number }>(
  items: readonly T[],
  sentID: string,
  messageID: string,
  messageCreated?: number,
) {
  // durable ACK 是草稿与真实用户消息的唯一交接点：即使停止操作曾临时恢复草稿，也要删除已发送项，
  // 并把其余队列的 ID 与时间边界一起推进，分页移出该消息后仍能避免再次提交同一条引导。
  return items
    .filter((item) => item.id !== sentID)
    .map((item) => ({
      ...item,
      afterMessageID: messageID,
      ...(messageCreated === undefined ? {} : { afterMessageCreated: messageCreated }),
    }))
}

// follow-up 发送只需要覆盖这组模型快照字段，草稿中的提示词、生图参数和持久化标记必须原样保留。
type FollowupModelSnapshot = {
  agent: string
  model: { providerID: string; modelID: string }
  variant?: string
}

export function followupDraftForSend<T extends FollowupModelSnapshot>(input: {
  draft: T
  source: "automatic" | "dock"
  current?: FollowupModelSnapshot
}) {
  // 自动接力必须忠实使用输入时快照；只有用户显式点击 dock“引导”时，才采用点击瞬间的模型与 Agent。
  if (input.source !== "dock" || !input.current) return input.draft
  return { ...input.draft, ...input.current }
}

export function promoteFollowupDraftToSteer<
  T extends FollowupModelSnapshot & { id: string; manualSteer?: boolean; targetTurnID?: string },
>(input: { items: readonly T[]; id: string; targetTurnID?: string; current?: FollowupModelSnapshot }) {
  const target = input.items.find((item) => item.id === input.id)
  if (!target) return input.items.slice()
  const promoted = {
    ...followupDraftForSend({ draft: target, source: "dock", current: input.current }),
    manualSteer: true,
    // turnID 已发布时立即快照；尚未发布时仍保留 steer 身份，由当前运行时等待器补齐。
    ...(input.targetTurnID ? { targetTurnID: input.targetTurnID } : {}),
  }
  // 点击顺序就是 steer 到达顺序：已有 steer 保持在前，新点击项紧随其后，普通队列统一后移。
  return [
    ...input.items.filter((item) => item.id !== input.id && item.manualSteer === true),
    promoted,
    ...input.items.filter((item) => item.id !== input.id && item.manualSteer !== true),
  ]
}

export async function confirmFollowupMessagePersisted(input: {
  read: (signal: AbortSignal) => Promise<boolean>
  timeoutMs?: number
  intervalMs?: number
}) {
  const timeoutMs = Math.max(0, input.timeoutMs ?? 3_000)
  if (timeoutMs === 0) return false

  const controller = new AbortController()
  const deadline = Date.now() + timeoutMs
  let timeoutID: ReturnType<typeof globalThis.setTimeout> | undefined
  // 对齐官方 sendRequest 的硬超时：deadline 到达时先取消同一确认阶段的读取，再立即解除等待。
  const expired = new Promise<false>((resolve) => {
    timeoutID = globalThis.setTimeout(() => {
      controller.abort(new DOMException("Follow-up confirmation timed out", "TimeoutError"))
      resolve(false)
    }, timeoutMs)
  })

  try {
    while (!controller.signal.aborted) {
      // ACK 丢失后只接受后端 GET 的确证；同一个 signal 贯穿所有轮询，永久 pending 的读取也能被硬 deadline 截断。
      const persisted = await Promise.race([
        Promise.resolve()
          .then(() => input.read(controller.signal))
          .catch(() => false),
        expired,
      ])
      if (controller.signal.aborted || Date.now() >= deadline) return false
      if (persisted) return true

      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        controller.abort(new DOMException("Follow-up confirmation timed out", "TimeoutError"))
        return false
      }
      await Promise.race([
        new Promise<void>((resolve) =>
          globalThis.setTimeout(resolve, Math.min(input.intervalMs ?? 250, remaining)),
        ),
        expired,
      ])
    }
    return false
  } finally {
    if (timeoutID !== undefined) globalThis.clearTimeout(timeoutID)
  }
}

export function manualSteerAcknowledgedAt(input: { requestedAt: number; acknowledgedAt?: number }) {
  // ACK 丢失后的 GET 确认可能比原请求晚很久；后续 stale 判定必须以确认时间为准。
  return input.acknowledgedAt ?? input.requestedAt
}

export function manualSteerAcknowledgedPending(input: {
  messageID: string
  requestedAt: number
  acknowledgedAt?: number
  signOutGeneration?: number
  recovery?: unknown
}) {
  return {
    messageID: input.messageID,
    startedAt: manualSteerAcknowledgedAt(input),
    signOutGeneration: input.signOutGeneration,
    acknowledged: true,
    // RPC ACK 只证明服务端接受请求；保留官方 restoreMessage 等价载荷，直到精确 marker 或终态进入同步时间线。
    recovery: input.recovery,
  }
}

export function manualSteerPendingSnapshot<T extends { recovery?: unknown }>(pending: T | undefined) {
  if (!pending) return
  return {
    ...pending,
    // 连续引导失败恢复旧锁时同样经过 Solid 嵌套合并；显式字段可清除当前请求遗留的 recovery。
    recovery: pending.recovery,
  }
}

export function isQueuedUserMessage(messages: readonly Message[], messageID: string, options?: { steered?: boolean }) {
  const targetIndex = messages.findIndex((message) => message.id === messageID)
  const target = messages[targetIndex]
  if (!target || target.role !== "user") return false

  if (options?.steered) return false

  // 引导消息一旦已经落下自己的 assistant 回合，就不再是可撤销的队列项。
  if (messages.some((message) => message.role === "assistant" && message.parentID === messageID)) return false

  // 在途回合以「最新一条 assistant 消息」为准:仅当它非 terminal(回合真在途)时其 parentID 才算在途回合。
  // 旧实现用「所有非 terminal assistant」会把已被后续 stop 步取代的历史 tool-calls 步也当在途 → 刚发的、
  // 正在被处理的消息被误判为可撤销的排队项,点删除会丢失该消息。
  const lastAssistant = lastAssistantMessage(messages)
  const inFlightParent =
    lastAssistant && lastAssistant.parentID && !assistantTurnTerminal(lastAssistant)
      ? lastAssistant.parentID
      : undefined

  if (inFlightParent === undefined) return false
  const inFlightParentIndex = messages.findIndex((message) => message.id === inFlightParent)
  // 可撤销性必须服从当前时间线位置；msg_remote_* 等异构 ID 的字典序不代表先后。
  // parent 未加载时无法可靠证明目标排在运行回合之后，按不可撤销处理更安全。
  if (inFlightParentIndex < 0) return false
  return targetIndex > inFlightParentIndex
}

export function followupTurnState(
  messages: readonly Message[],
  messageID: string,
  options?: { partsByMessage?: Record<string, readonly Part[] | undefined>; now?: number },
): FollowupTurnState {
  const userIndex = messages.findIndex((message) => message.id === messageID)
  if (userIndex < 0) return "missing"

  const afterUser = messages.slice(userIndex + 1)
  const explicit = afterUser.findLast(
    (message): message is AssistantMessage =>
      message.role === "assistant" && message.completedUserMessageIDs?.includes(messageID) === true,
  )
  if (explicit) {
    // steer 的最终 assistant 可能位于下一条用户消息之后；显式覆盖列表优先于旧回合中的中断错误。
    if (!assistantTurnSettled(explicit, options?.partsByMessage?.[explicit.id], options?.now)) return "pending"
    return explicit.error ? "error" : "completed"
  }

  const nextUserIndex = afterUser.findIndex((message) => message.role === "user")
  const turn = nextUserIndex < 0 ? afterUser : afterUser.slice(0, nextUserIndex)

  const terminal = turn
    .filter((message) => {
      if (message.role !== "assistant") return false
      if (message.parentID && message.parentID !== messageID) return false
      return assistantTurnSettled(message, options?.partsByMessage?.[message.id], options?.now)
    })
    .at(-1)

  if (!terminal || terminal.role !== "assistant") return "pending"
  return terminal.error ? "error" : "completed"
}

export function followupAwaitingResult(
  messages: readonly Message[],
  messageID: string,
  options?: {
    startedAt?: number
    now?: number
    partsByMessage?: Record<string, readonly Part[] | undefined>
    sessionIdle?: boolean
  },
) {
  const state = followupTurnState(messages, messageID, { partsByMessage: options?.partsByMessage, now: options?.now })
  if (state === "completed" && options?.sessionIdle === false) {
    // queued turn 已经有可见输出但会话尚未真正 idle 时，仍要等当前回合收尾。
    // 否则长文本/工具回合超过文本宽限后会提前释放队列，把下一条误发成 steer。
    return {
      state: "pending" as const,
      clearAwaiting: false,
      pauseQueue: false,
      blockAutoSend: true,
    }
  }
  if (state === "missing" && options?.startedAt !== undefined) {
    const elapsed = (options.now ?? Date.now()) - options.startedAt
    if (elapsed <= FOLLOWUP_AWAITING_MISSING_GRACE_MS) {
      return {
        state,
        clearAwaiting: false,
        pauseQueue: false,
        blockAutoSend: true,
      }
    }

    return {
      state,
      clearAwaiting: true,
      pauseQueue: !options.sessionIdle,
      blockAutoSend: !options.sessionIdle,
    }
  }

  return {
    state,
    clearAwaiting: state !== "pending",
    pauseQueue: state === "error",
    blockAutoSend: state === "pending" || state === "error",
  }
}

export function followupShouldBlockSend(input: { manual?: boolean; awaitingBlocked: boolean }) {
  // 手动引导是用户显式立即提交，不参与自动队列的等待锁；重复点击仍由发送中的 mutation 拦截。
  return !input.manual && input.awaitingBlocked
}

export function followupFailureIsRetryableBusy(error: unknown) {
  const text =
    error instanceof Error
      ? `${error.name} ${error.message}`
      : typeof error === "string"
        ? error
        : JSON.stringify(error)
  // 自动队列可能在后端 runner 刚收尾但 status 事件尚未同步时撞到 busy。
  // 这不是用户输入失败，恢复队列等待下一轮 tick 重试即可。
  return /\b(session|runner)\b.*\bbusy\b/i.test(text)
}

export function followupCanAutoSend(input: { inferredBusy: boolean; statusBusy: boolean }) {
  // 自动队列只能在前端推导态和后端 session_status 都 idle 时发送；
  // 否则图片/工具回合收尾窗口会把普通排队项误发成 steer，导致它并入上一回合而没有独立回复。
  return !input.inferredBusy && !input.statusBusy
}

export function followupSendGateWorking(input: {
  inferredBusy: boolean
  statusBusy: boolean
  followupReady: boolean
  pendingMessageID?: string
  sendingMessageID: string
  allowActiveTurn: boolean
}) {
  // 未完成 hydration 和其它消息的顺序锁始终拦截；当前引导刚建立的自身锁不能把自己挡在网络边界外。
  if (!input.followupReady) return true
  if (input.pendingMessageID && input.pendingMessageID !== input.sendingMessageID) return true
  // direct steer 本来就要注入活动回合，因此只豁免真实运行态；普通队列在预检期间新遇到 busy 仍必须停下。
  if (input.allowActiveTurn) return false
  return input.inferredBusy || input.statusBusy
}

export function manualSteerSendBlocker(
  pending: readonly { messageID: string; acknowledged?: boolean }[],
  sendingMessageID: string,
) {
  // 官方队列只等待上一条 steer 的 durable ACK；已 ACK 项继续等待回复时不能阻塞下一条同回合引导。
  return pending.find((entry) => entry.messageID !== sendingMessageID && entry.acknowledged !== true)?.messageID
}

export function followupSendGateOpen(input: {
  lifecycleOwned: boolean
  paused: boolean
  resumeAfterAbort?: boolean
  draftGeneration: number
  currentGeneration: number
  working: boolean
}) {
  // 权限预检返回后必须重新确认页面所有权与停止代次；旧页面、已暂停会话都不能继续落网络请求。
  // 停止完成后的未 ACK 恢复项是唯一允许穿过暂停态的例外，普通队列仍需用户显式发送。
  if (!input.lifecycleOwned || !followupPausedQueueAllowsSend(input)) return false
  if (input.draftGeneration !== input.currentGeneration) return false
  if (input.working) return false
  return true
}

export function followupPostAckCanTrack(input: {
  paused: boolean
  draftGeneration: number
  currentGeneration: number
}) {
  // ACK 可能在用户停止后才返回；旧请求只能完成本地清理，不能借用新代次重建 pending 锁。
  if (input.paused) return false
  return input.draftGeneration === input.currentGeneration
}

export function followupShouldQueueInput(input: {
  queueingEnabled: boolean
  inferredBusy: boolean
  statusBusy: boolean
  manualSteerWaiting: boolean
  compacting?: boolean
}) {
  // 已有引导顺序锁时，无论当前模式如何都必须继续收进 dock，避免新输入越过尚未完成的引导。
  if (input.manualSteerWaiting) return true
  if (input.compacting) return true
  if (!input.queueingEnabled) return false
  // 长文本流可能超过前端推导态的新鲜窗口；后端仍 busy 就代表原任务确实还在执行，输入仍应保持可引导。
  return input.inferredBusy || input.statusBusy
}

export function followupShouldPauseForManualSteer(input: { pending: boolean }) {
  // 手动引导是用户显式插队的接力请求；它存在时普通队列必须让路，避免 c3 抢在 c1/c2 引导回复前执行。
  return input.pending
}

export function followupShouldUseSteer(input: {
  manual?: boolean
  manualSteerDraft?: boolean
  targetTurnID?: string
  targetPending?: boolean
  source?: "automatic" | "dock"
  inferredBusy: boolean
  statusBusy: boolean
  pendingManualSteer: boolean
  compacting?: boolean
}) {
  // 压缩会重写会话历史，引导与它并发会竞争同一份快照；此时一律退回队列。
  if (input.compacting) return false
  if (input.manual !== true) return false
  // steer 资格来自用户提交时持久化的意图；缺 target 但仍由当前运行时等待时也不能退化成普通 prompt。
  return input.manualSteerDraft === true && (!!input.targetTurnID || input.targetPending === true)
}

export function manualSteerHasAssistant(
  messages: readonly Message[],
  messageID: string,
  options?: { statusBusy?: boolean },
) {
  // 消息数组由同步层按创建时间排序；先建立 ID 到数组位置的索引，避免把远控 ID 的字典序误当成时间顺序。
  const indexes = new Map(messages.map((message, index) => [message.id, index]))
  const messageIndex = indexes.get(messageID)
  if (messageIndex === undefined) return false
  // 顺序锁只接受用户消息作为目标，避免误把同 ID 的 assistant 当成已完成引导。
  if (messages[messageIndex]?.role !== "user") return false

  // 后端用已终结 assistant 的 parentID 做 high-water；连续引导被合并时，较新的 parent 也覆盖较早消息。
  // high-water 必须比较时间线位置，才能兼容 msg_remote_* 等不具备时间顺序的历史 ID。
  const explicitlyCompleted = messages.some(
    (message) =>
      message.role === "assistant" &&
      manualSteerAssistantTerminal(message, options?.statusBusy) &&
      (message.parentID === messageID || message.completedUserMessageIDs?.includes(messageID) === true),
  )
  if (explicitlyCompleted) return true

  const respondedThrough = messages.reduce((max, message) => {
    if (
      message.role !== "assistant" ||
      !manualSteerAssistantTerminal(message, options?.statusBusy) ||
      !message.parentID
    )
      return max
    if (message.completedUserMessageIDs) return max
    const parentIndex = indexes.get(message.parentID)
    return parentIndex === undefined ? max : Math.max(max, parentIndex)
  }, -1)
  return messageIndex <= respondedThrough
}

function manualSteerHasActiveAssistant(messages: readonly Message[], messageID: string, statusBusy?: boolean) {
  const indexes = new Map(messages.map((message, index) => [message.id, index]))
  const messageIndex = indexes.get(messageID)
  if (messageIndex === undefined || messages[messageIndex]?.role !== "user") return false

  const active = lastAssistantMessage(messages)
  if (!active || manualSteerAssistantTerminal(active, statusBusy)) return false
  if (active.parentID === messageID) return true
  // 新协议的显式覆盖列表是权威边界；目标不在列表时不能再用 parent 位置兜底，
  // 否则一个只处理后续普通消息的 assistant 会把更早引导误判为仍在执行，顺序锁将一直无法释放。
  if (active.completedUserMessageIDs) return active.completedUserMessageIDs.includes(messageID)
  const parentIndex = active.parentID ? indexes.get(active.parentID) : undefined
  // 旧协议没有显式覆盖列表时，才用较新 parent 的时间线位置兼容连续引导合并。
  return parentIndex !== undefined && parentIndex >= messageIndex
}

export function manualSteerPendingState(input: {
  messages: readonly Message[]
  messageID: string
  startedAt: number
  now: number
  inferredBusy: boolean
  statusBusy: boolean
}) {
  if (manualSteerHasAssistant(input.messages, input.messageID, { statusBusy: input.statusBusy }))
    return "completed" as const
  // statusBusy 是后端仍在处理本次请求的权威信号；assistant 首包可能因预处理或 SSE 延迟晚于 15 秒，
  // 不能因为前端尚未看见 assistant 就提前释放顺序锁。只有新协议 active assistant 的显式覆盖列表明确排除目标时，
  // 才允许在 ACK 宽限后回收旧锁，避免无关的后续任务把它长期保留。
  const active = lastAssistantMessage(input.messages)
  const targetIndex = input.messages.findIndex((message) => message.id === input.messageID && message.role === "user")
  const activeIndex = active ? input.messages.indexOf(active) : -1
  const explicitlyExcludedByActive =
    !!active &&
    // 旧 A1 位于目标 m2 之前时与 m2 无关；只有目标之后的 active assistant 才能显式排除本次引导。
    targetIndex >= 0 &&
    activeIndex > targetIndex &&
    !manualSteerAssistantTerminal(active, input.statusBusy) &&
    active.completedUserMessageIDs !== undefined &&
    !manualSteerHasActiveAssistant(input.messages, input.messageID, input.statusBusy)
  const elapsed = input.now - input.startedAt
  const activeAssistant = active && !manualSteerAssistantTerminal(active, input.statusBusy)
  // 只有 status busy 同时有 assistant/推导态运行证据时才延长等待；孤立的残留 status 仍按 ACK 宽限回收。
  // 这样长工具/模型步骤不会被误解锁，而后台异常或断流也不会让输入框永久锁死。
  if (input.statusBusy && !explicitlyExcludedByActive && (input.inferredBusy || activeAssistant))
    return "pending" as const
  // status 已经 idle 后只保留 ACK 宽限；旧工具 part 推导出的 busy 不能让输入锁无限期保留。
  if (elapsed <= MANUAL_STEER_PENDING_MISSING_GRACE_MS) return "pending" as const
  return "missing" as const
}

export function manualSteerHydrationState(
  input: Parameters<typeof manualSteerPendingState>[0] & {
    acknowledged: boolean
    recovery: boolean
    targetTurnID: string
    partsByMessage: Record<string, readonly Part[] | undefined>
  },
) {
  const state = manualSteerPendingState(input)
  const message = input.messages.find((item) => item.id === input.messageID)
  const messageObserved = manualSteerMessageMatchesTarget({
    message,
    parts: input.partsByMessage[input.messageID],
    messageID: input.messageID,
    targetTurnID: input.targetTurnID,
  })
  // 冷启动时终态回复也必须有完整 marker 才能清锁，避免同 ID 普通消息误冒充已执行引导。
  if (state === "completed") return messageObserved ? state : ("missing" as const)
  // 首次观察到 durable marker 时升级本地状态；恢复载荷继续保留到终态，只靠 acknowledged 阻止重复恢复。
  if (!input.acknowledged && messageObserved) return "acknowledged" as const
  // 对齐 ChatGPT 的 accepted steering item：durable ACK 后只等待本回合的终态回复，不能再按本地 15 秒宽限判丢失。
  // status/assistant 事件可能晚到或短暂缺失；此时提前清锁会让普通队列越过已接受的 steer，错误开启新回合。
  if (messageObserved) return "pending" as const
  return state
}

export function followupShouldStoreManualSteer(input: {
  manual?: boolean
  inferredBusy: boolean
  statusBusy: boolean
}) {
  // 显式点击“引导”即使发生在 status 刚变 idle 的窗口，也必须建立持久化顺序锁，避免刷新后丢掉在途请求。
  // inferredBusy/statusBusy 参数保留给调用方的运行态判断；实际请求始终由正常 prompt/loop 幂等接力。
  return input.manual === true
}

export function followupRestoreShouldDowngradeSteer(input: {
  manualSteerTracked: boolean
  manualSteer?: boolean
  messageID?: string
}) {
  // manualSteerTracked=false 但草稿仍带 manualSteer+messageID，只可能是压缩把它强制降级又被发送闸挡下：
  // 乐观气泡从未撤回，必须先撤回气泡再恢复成普通队列项，否则去重 effect 会把它当成“时间线已有同文案消息”误删。
  return !input.manualSteerTracked && input.manualSteer === true && !!input.messageID
}

export function followupDockMode(input: { busy: boolean; paused?: boolean; failed?: boolean }) {
  if (input.failed) return "failed" as const
  if (input.paused) return "paused" as const
  if (input.busy) return "queued" as const
  return "ready" as const
}

// Dock 引导按钮：压缩期间必须保持可见但禁用（用 disabled 而非 Show 隐藏），
// 避免用户在压缩完成前误触发；发送中同理禁用，防止重复点击。
export function followupSendNowDisabled(input: { sendingAny: boolean; steerDisabledReason?: string }) {
  return input.sendingAny || !!input.steerDisabledReason
}

// 禁用原因优先于默认 tooltip 文案；没有原因时退回默认提示。
export function followupSendNowTooltip(input: { steerDisabledReason?: string; defaultTooltip: string }) {
  return input.steerDisabledReason ?? input.defaultTooltip
}
