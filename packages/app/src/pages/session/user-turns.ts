import type { UserMessage } from "@opencode-ai/sdk/v2"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import { compareMessageOrder, sortMessages } from "@/context/message-order"
import { assistantTurnActive, assistantTurnTerminal, manualSteerStepInFlight } from "./followup-queue"

const DUPLICATE_USER_TURN_MS = 10_000
const PENDING_EXECUTED_DUPLICATE_USER_TURN_MS = 120_000
type UserTurnSignaturePart =
  | { type: "text"; text: string }
  | { type: "files"; imageCount: number; fileCount: number }
  | { type: "agent"; name: string }

// 用户气泡、图片继承和一级物理 turn 都按消息创建时间扫描，避免分页/实时合并顺序把新回合插到旧回合前面。
const sortUserMessages = (messages: readonly UserMessage[]) => [...messages].sort(compareMessageOrder)

// 时间线以逻辑回合为容器；引导用户消息只是容器中的顺序成员，不会再创建新的顶层回合。
export type TimelineTurnMember = {
  type: "user" | "assistant"
  messageID: string
  steering?: boolean
}

export type TimelineTurn = {
  id: string
  rootMessageID?: string
  orphan: boolean
  members: TimelineTurnMember[]
  userMessageIDs: string[]
  assistantMessageIDs: string[]
}

export function timelineTurnAnchorMessageID(turn: TimelineTurn, loadedMessageIDs: { has(messageID: string): boolean }) {
  // 一级时间线只能锚定当前页面真实存在的 user DOM；分页元数据里的缺失 root 不能覆盖已加载 steer。
  if (turn.rootMessageID && loadedMessageIDs.has(turn.rootMessageID)) return turn.rootMessageID
  return turn.userMessageIDs.find((messageID) => loadedMessageIDs.has(messageID))
}

type UserTurnView = {
  messages: readonly UserMessage[]
  parentAliases: Readonly<Record<string, string>>
  steeredByMessageID: Readonly<Record<string, number>>
  turns: readonly TimelineTurn[]
  turnIDByMessageID: Readonly<Record<string, string>>
}

const sameList = <T>(left: readonly T[], right: readonly T[], equals: (a: T, b: T) => boolean) =>
  left === right || (left.length === right.length && left.every((item, index) => equals(item, right[index])))

const sameRecord = <T extends string | number>(
  left: Readonly<Record<string, T>>,
  right: Readonly<Record<string, T>>,
) => {
  if (left === right) return true
  const keys = Object.keys(left)
  return keys.length === Object.keys(right).length && keys.every((key) => left[key] === right[key])
}

const sameTimelineTurn = (left: TimelineTurn, right: TimelineTurn) =>
  left === right ||
  (left.id === right.id &&
    left.rootMessageID === right.rootMessageID &&
    left.orphan === right.orphan &&
    sameList(
      left.members,
      right.members,
      (a, b) => a.type === b.type && a.messageID === b.messageID && a.steering === b.steering,
    ) &&
    sameList(left.userMessageIDs, right.userMessageIDs, (a, b) => a === b) &&
    sameList(left.assistantMessageIDs, right.assistantMessageIDs, (a, b) => a === b))

export function sameUserTurnView(left: UserTurnView, right: UserTurnView) {
  if (left === right) return true
  // assistant 每个 token 都会更新全局 part store，但逻辑 turn 通常没有变化；复用旧视图可阻断整棵历史活动树重挂载。
  return (
    sameList(left.messages, right.messages, (a, b) => a === b) &&
    sameRecord(left.parentAliases, right.parentAliases) &&
    sameRecord(left.steeredByMessageID, right.steeredByMessageID) &&
    sameList(left.turns, right.turns, sameTimelineTurn) &&
    sameRecord(left.turnIDByMessageID, right.turnIDByMessageID)
  )
}

export function orderTimelineMessages(messages: readonly Message[]) {
  // 同步层会混合历史分页、实时事件和 optimistic 消息；展示层统一按 created 排序，保证已回答回合在更新回合前面。
  return sortMessages(messages)
}

export function clipTimelineTurns(
  turns: readonly TimelineTurn[],
  beforeMessageID?: string,
  messageOrder?: readonly string[],
) {
  if (!beforeMessageID) return turns
  const order = new Map((messageOrder ?? turns.flatMap((turn) => turn.members.map((member) => member.messageID))).map(
    (messageID, index) => [messageID, index] as const,
  ))
  const cutoff = order.get(beforeMessageID)
  // revert 可能落在 turn 内的 steer 上；优先按服务端真实消息顺序裁成员，自定义/远程 ID 不具备可比较的时间语义。
  return turns.flatMap((turn) => {
    const members = turn.members.filter((member) => {
      if (cutoff === undefined) return member.messageID < beforeMessageID
      const index = order.get(member.messageID)
      return index !== undefined && index < cutoff
    })
    const userMessageIDs = members.flatMap((member) => (member.type === "user" ? [member.messageID] : []))
    if (userMessageIDs.length === 0) return []
    const assistantMessageIDs = members.flatMap((member) =>
      member.type === "assistant" ? [member.messageID] : [],
    )
    const rootMessageID = turn.rootMessageID && members.some((member) => member.messageID === turn.rootMessageID)
      ? turn.rootMessageID
      : undefined
    return [
      {
        ...turn,
        rootMessageID,
        orphan: rootMessageID === undefined,
        members,
        userMessageIDs,
        assistantMessageIDs,
      },
    ]
  })
}

export function timelineTurnUserMessages(turns: readonly TimelineTurn[], messages: readonly Message[]) {
  const users = new Map(
    messages
      .filter((message): message is UserMessage => message.role === "user")
      .map((message) => [message.id, message]),
  )
  // 所有一级时间线入口共用同一锚点规则：完整 turn 取根 user，分页缺根时临时取首个已加载 user。
  return turns.flatMap((turn) => {
    // selector 与真实 DOM 复用同一函数，避免 selector 已回退到 steer、渲染层却重新选择缺失 root。
    const message = users.get(timelineTurnAnchorMessageID(turn, users) ?? "")
    return message ? [message] : []
  })
}

export function userTurnSignature(message: UserMessage, parts: readonly Part[] | undefined) {
  const files = (parts ?? []).filter((part) => part.type === "file")
  return JSON.stringify({
    agent: message.agent,
    parts: [
      ...(parts ?? []).flatMap<UserTurnSignaturePart>((part) => {
        switch (part.type) {
          case "text":
            if (part.synthetic || part.ignored) return []
            return [{ type: part.type, text: part.text }]
          case "agent":
            return [{ type: part.type, name: part.name }]
          default:
            return []
        }
      }),
      ...(files.length > 0
        ? [
            {
              type: "files" as const,
              imageCount: files.filter((part) => part.mime.startsWith("image/")).length,
              fileCount: files.filter((part) => !part.mime.startsWith("image/")).length,
            },
          ]
        : []),
    ],
  })
}

const userTurnTextSignature = (message: UserMessage, parts: readonly Part[] | undefined) => {
  const text = (parts ?? [])
    .flatMap((part) => {
      if (part.type !== "text") return []
      if (part.synthetic || part.ignored) return []
      return [part.text.trim()]
    })
    .filter(Boolean)
    .join("\n")
  return text ? JSON.stringify({ agent: message.agent, text }) : undefined
}

const imageFileUrl = (part: Part) => {
  if (part.type !== "file") return undefined
  if (!part.mime.startsWith("image/")) return undefined
  return part.url
}

const imageToolUrls = (part: Part) => {
  if (part.type !== "tool" || part.tool !== "image_generation") return []
  if (part.state.status !== "running" && part.state.status !== "completed") return []
  return (part.state.attachments ?? [])
    .filter((attachment) => attachment.mime.startsWith("image/"))
    .flatMap((attachment) => (attachment.url ? [attachment.url] : []))
}

const syntheticCompactionContinue = (part: Part) => {
  if (part.type !== "text") return false
  if (!part.synthetic) return false
  const metadata = part.metadata
  if (!metadata || typeof metadata !== "object") return false
  return (metadata as Record<string, unknown>).compaction_continue === true
}

const internalContinuationUserTurn = (parts: readonly Part[] | undefined) => {
  if (!parts?.length) return false
  // 自动压缩（上下文溢出触发）和压缩后的继续提示是运行时内部回合；展示层要把它们并回上一条真实用户消息。
  // 手动 /compact 是用户显式动作，必须独立成回合：否则压缩的处理态会记到上一轮头上，
  // 计时从上一轮起点算（旧会话可达数天→异常大），且「会话已压缩」完成分割线永不渲染。
  const compaction = parts.find((part) => part.type === "compaction")
  if (compaction) return compaction.auto === true
  return parts.every(syntheticCompactionContinue)
}

const persistedMessageTurnID = (message: Message) => {
  // SDK 生成可能落后于服务端 schema；窄化读取让新 turnID 立即生效，同时继续兼容没有该字段的旧历史。
  const value = message as Message & { turnID?: unknown }
  return typeof value.turnID === "string" && value.turnID ? value.turnID : undefined
}

const manualSteerMarkerTargetTurnID = (parts: readonly Part[] | undefined) => {
  const marker = (parts ?? []).find(
    (part) => part.type === "text" && part.synthetic === true && part.metadata?.manual_steer_context === true,
  )
  if (marker?.type !== "text") return undefined
  const target = marker.metadata?.manual_steer_target_turn_id
  return typeof target === "string" && target ? target : undefined
}

const manualSteerTargetTurnID = (message: UserMessage, parts: readonly Part[] | undefined) =>
  // optimistic 字段来自发送瞬间的快照；刷新后则从 durable marker 恢复相同的目标回合。
  message.steerTargetTurnID || manualSteerMarkerTargetTurnID(parts)

const explicitManualSteerUserTurn = (message: UserMessage, parts: readonly Part[] | undefined) => {
  const targetTurnID = manualSteerTargetTurnID(message, parts)
  const persistedTurnID = persistedMessageTurnID(message)
  // inactive fallback 会复用 messageID 开新 turn；durable turnID 与旧 optimistic 目标冲突时必须以服务端身份为准。
  if (persistedTurnID && targetTurnID && persistedTurnID !== targetTurnID) return false
  // optimistic 阶段优先读取发网前快照的目标回合；durable 消息再用后端 marker 兜底。
  // 两种状态都不依赖 assistant/status 到达顺序，因此引导气泡不会在当前 turn 中间闪成普通新回合。
  return (
    !!targetTurnID ||
    (parts ?? []).some(
      (part) => part.type === "text" && part.synthetic === true && part.metadata?.manual_steer_context === true,
    )
  )
}

export function displayUserPartsByMessage(
  messages: readonly UserMessage[],
  partsByMessage: Record<string, Part[] | undefined>,
  allMessages: readonly Message[] = messages,
) {
  const orderedMessages = sortUserMessages(messages)
  const orderedAllMessages = sortMessages(allMessages)
  const userIDs = new Set(orderedMessages.map((message) => message.id))
  const previousAssistantImages = new Set<string>()
  const result: Record<string, Part[]> = {}

  for (const message of orderedAllMessages) {
    if (message.role === "assistant") {
      ;(partsByMessage[message.id] ?? [])
        .flatMap((part) => {
          const url = imageFileUrl(part)
          return url ? [url] : imageToolUrls(part)
        })
        .filter((url): url is string => !!url)
        .forEach((url) => previousAssistantImages.add(url))
      continue
    }

    if (message.role !== "user" || !userIDs.has(message.id)) continue
    result[message.id] = (partsByMessage[message.id] ?? []).filter((part) => {
      const url = imageFileUrl(part)
      return !url || !previousAssistantImages.has(url)
    })
  }

  return result
}

function timelineTurns(input: {
  messages: readonly UserMessage[]
  visibleMessages: readonly UserMessage[]
  allMessages: readonly Message[]
  partsByMessage: Record<string, readonly Part[] | undefined>
  parentAliases: Record<string, string>
  steeredUserTurnTargets: ReadonlyMap<string, string | undefined>
  hiddenMessageIDs: ReadonlySet<string>
}) {
  const userMessages = new Map<string, UserMessage>()
  input.allMessages.forEach((message) => {
    if (message.role === "user") userMessages.set(message.id, message)
  })
  input.messages.forEach((message) => userMessages.set(message.id, message))

  const resolveAlias = (messageID: string, seen = new Set<string>()): string => {
    if (seen.has(messageID)) return messageID
    const alias = input.parentAliases[messageID]
    if (!alias) return messageID
    // alias 可能经过多轮图片回显或内部 continuation；递归压到最终可见用户，循环数据则保守停在当前节点。
    return resolveAlias(alias, new Set(seen).add(messageID))
  }

  const rawTurnIDByUserMessageID = new Map<string, string>()
  userMessages.forEach((message) => {
    // 新协议的持久化身份最权威；其后依次兼容 optimistic steer、内部续跑、durable marker 和旧时间窗推断。
    rawTurnIDByUserMessageID.set(
      message.id,
      persistedMessageTurnID(message) ??
        message.steerTargetTurnID ??
        message.continuationTurnID ??
        manualSteerMarkerTargetTurnID(input.partsByMessage[message.id]) ??
        input.steeredUserTurnTargets.get(message.id) ??
        message.id,
    )
  })

  const resolvedUserTurnIDs = new Map<string, string>()
  const resolveUserTurnID = (messageID: string, seen = new Set<string>()): string => {
    const cached = resolvedUserTurnIDs.get(messageID)
    if (cached) return cached
    const target = resolveAlias(rawTurnIDByUserMessageID.get(messageID) ?? messageID)
    if (target === messageID || !rawTurnIDByUserMessageID.has(target) || seen.has(target)) {
      resolvedUserTurnIDs.set(messageID, target)
      return target
    }
    // 旧 assistant 可能指向一个已被 alias 的 continuation user；继续解析其归属，避免同一回合被拆成两组。
    const resolved = resolveUserTurnID(target, new Set(seen).add(messageID))
    resolvedUserTurnIDs.set(messageID, resolved)
    return resolved
  }
  const resolveKnownTurnID = (turnID: string) => {
    const target = resolveAlias(turnID)
    return rawTurnIDByUserMessageID.has(target) ? resolveUserTurnID(target) : target
  }

  const loadedMessageIDs = new Set(input.allMessages.map((message) => message.id))
  const rootMessageIDByTurnID = new Map<string, string>()
  input.visibleMessages.forEach((message) => {
    if (!loadedMessageIDs.has(message.id)) return
    if (input.steeredUserTurnTargets.has(message.id)) return
    if (message.continuationTurnID || internalContinuationUserTurn(input.partsByMessage[message.id])) return
    // turnID 指向其他消息时，这条 user 是回合内 continuation；只有自身开启的真实用户请求可以成为根。
    const persistedTurnID = persistedMessageTurnID(message)
    if (persistedTurnID && persistedTurnID !== message.id) return
    const turnID = resolveUserTurnID(message.id)
    if (!rootMessageIDByTurnID.has(turnID)) rootMessageIDByTurnID.set(turnID, message.id)
  })

  const turns: TimelineTurn[] = []
  const turnsByID = new Map<string, TimelineTurn>()
  const turnIDByMessageID: Record<string, string> = {}
  const ensureTurn = (turnID: string) => {
    const existing = turnsByID.get(turnID)
    if (existing) return existing
    const rootMessageID = rootMessageIDByTurnID.get(turnID)
    const turn: TimelineTurn = {
      id: turnID,
      rootMessageID,
      orphan: rootMessageID === undefined,
      members: [],
      userMessageIDs: [],
      assistantMessageIDs: [],
    }
    turnsByID.set(turnID, turn)
    turns.push(turn)
    return turn
  }
  const resolveMessageTurnID = (message: Message) => {
    if (message.role === "user") return resolveUserTurnID(message.id)
    const persistedTurnID = persistedMessageTurnID(message)
    if (persistedTurnID) return resolveKnownTurnID(persistedTurnID)
    if (userMessages.has(message.parentID)) return resolveUserTurnID(message.parentID)
    return resolveKnownTurnID(message.parentID)
  }

  // 调用方传入的 allMessages 已经按展示顺序排列；这里同样只做归属索引，不重排 user、assistant 或连续 steer。
  input.allMessages.forEach((message) => {
    // 旧协议可能先留下 steer 占位、随后用另一条 user 真正执行；被去重的占位不能以成员身份再次显示。
    if (input.hiddenMessageIDs.has(message.id)) return
    const turnID = resolveMessageTurnID(message)
    turnIDByMessageID[message.id] = turnID
    const turn = ensureTurn(turnID)
    turn.members.push({
      type: message.role,
      messageID: message.id,
      ...(message.role === "user" && input.steeredUserTurnTargets.has(message.id) ? { steering: true } : {}),
    })
    if (message.role === "user") {
      turn.userMessageIDs.push(message.id)
      return
    }
    turn.assistantMessageIDs.push(message.id)
  })

  return { turns, turnIDByMessageID }
}

export function dedupeUserTurnsWithAliases(
  messages: readonly UserMessage[],
  partsByMessage: Record<string, Part[] | undefined>,
  allMessages: readonly Message[] = messages,
  options?: { statusBusy?: boolean; now?: number },
) {
  // 旧远控消息的 ID 可能晚于新消息；去重和 steer 判定按创建时间保持用户可见顺序。
  const orderedMessages = sortUserMessages(messages)
  const orderedAllMessages = sortMessages(allMessages)
  const steeredUserTurnTargets = steeredUserTurns(orderedMessages, orderedAllMessages, partsByMessage, options)
  const assistantParents = new Set(
    orderedAllMessages.flatMap((message) => (message.role === "assistant" && message.parentID ? [message.parentID] : [])),
  )
  const executedTextTurns = new Map<string, UserMessage[]>()
  orderedMessages
    .filter((message) => assistantParents.has(message.id))
    .forEach((message) => {
      const textSignature = userTurnTextSignature(message, partsByMessage[message.id])
      if (!textSignature) return
      executedTextTurns.set(textSignature, [...(executedTextTurns.get(textSignature) ?? []), message])
    })
  const result: UserMessage[] = []
  const parentAliases: Record<string, string> = {}
  const steeredByMessageID: Record<string, number> = {}
  const hiddenTimelineMessageIDs = new Set<string>()
  let visibleMessageID: string | undefined
  let previous:
    | { signature: string; textSignature?: string; created: number; messageID: string; turnID?: string }
    | undefined
  for (const message of orderedMessages) {
    if (internalContinuationUserTurn(partsByMessage[message.id]) && visibleMessageID) {
      parentAliases[message.id] = visibleMessageID
      continue
    }

    const signature = userTurnSignature(message, partsByMessage[message.id])
    const textSignature = userTurnTextSignature(message, partsByMessage[message.id])
    const created = message.time.created
    const turnID = persistedMessageTurnID(message)
    const duplicateExecutedTurn =
      textSignature && steeredUserTurnTargets.has(message.id) && !assistantParents.has(message.id)
        ? executedTextTurns.get(textSignature)?.find((item) => item.id !== message.id && item.time.created >= created)
        : undefined
    // 两条相同文案的显式 steer 都代表独立用户提交；后一条即使已经有 assistant，也不能把前一条当成回显隐藏。
    const duplicateExecutedSteer = duplicateExecutedTurn && steeredUserTurnTargets.has(duplicateExecutedTurn.id)
    if (duplicateExecutedTurn && !duplicateExecutedSteer) {
      // 同一条输入可能先作为 steer 进入运行中的回合,随后又从队列落成自己的 assistant 回合。
      // 展示时以真正执行的用户消息为准,避免一个用户意图显示成两轮对话。
      parentAliases[message.id] = duplicateExecutedTurn.id
      hiddenTimelineMessageIDs.add(message.id)
      continue
    }
    // 引导消息自身仍作为普通用户气泡展示；计数只用于运行态、去重和队列归属，不再生成展示标签。
    if (steeredUserTurnTargets.has(message.id))
      steeredByMessageID[message.id] = (steeredByMessageID[message.id] ?? 0) + 1
    const duplicateDelay = previous ? Math.abs(created - previous.created) : Number.POSITIVE_INFINITY
    const pendingExecutedDuplicate =
      previous &&
      !!textSignature &&
      textSignature === previous.textSignature &&
      created >= previous.created &&
      created - previous.created <= PENDING_EXECUTED_DUPLICATE_USER_TURN_MS &&
      assistantParents.has(message.id) &&
      !assistantParents.has(previous.messageID)
    // 两条用户消息都已经各自拥有 assistant 时，它们是两个真实执行过的回合；即使短时间内文本相同也不能按回显去重。
    const bothTurnsExecuted = previous && assistantParents.has(message.id) && assistantParents.has(previous.messageID)
    // inactive fallback 可复用相同输入；双方 durable turnID 不同已经证明是两个回合，旧文本/时间去重不得覆盖它。
    const differentPersistedTurns = previous?.turnID && turnID && previous.turnID !== turnID
    // 同一活动回合中的连续引导即使文案相同也代表两次用户提交，必须分别保留，最终回复再按服务端顺序合并。
    const consecutiveSteers =
      !!previous && steeredUserTurnTargets.has(previous.messageID) && steeredUserTurnTargets.has(message.id)
    const duplicate =
      previous &&
      !consecutiveSteers &&
      !bothTurnsExecuted &&
      !differentPersistedTurns &&
      ((duplicateDelay <= DUPLICATE_USER_TURN_MS &&
        (signature === previous.signature ||
          (!!textSignature &&
            textSignature === previous.textSignature &&
            (assistantParents.has(message.id) || assistantParents.has(previous.messageID))))) ||
        // 生图/修图可能先显示一个本地用户轮，服务端实际执行轮稍后才到；前一轮没有 assistant 时，
        // 仍把后一轮回复归并到前一轮，避免完成后留下一个同文案空回合。
        pendingExecutedDuplicate)
    if (previous && duplicate) {
      parentAliases[message.id] = previous.messageID
      continue
    }
    result.push(message)
    visibleMessageID = message.id
    previous = { signature, textSignature, created, messageID: message.id, turnID }
  }
  const timeline = timelineTurns({
    messages: orderedMessages,
    visibleMessages: result,
    allMessages: orderedAllMessages,
    partsByMessage,
    parentAliases,
    steeredUserTurnTargets,
    hiddenMessageIDs: hiddenTimelineMessageIDs,
  })
  return { messages: result, parentAliases, steeredByMessageID, ...timeline }
}

export function dedupeUserTurns(
  messages: readonly UserMessage[],
  partsByMessage: Record<string, Part[] | undefined>,
  allMessages: readonly Message[] = messages,
) {
  return dedupeUserTurnsWithAliases(messages, partsByMessage, allMessages).messages
}

// Codex 把运行中追加的用户消息当作 steer 活动；刷新后没有显式类型时，用 assistant 执行窗口还原。
function steeredUserTurns(
  messages: readonly UserMessage[],
  allMessages: readonly Message[],
  partsByMessage: Record<string, readonly Part[] | undefined>,
  options?: { statusBusy?: boolean; now?: number },
) {
  const assistantParents = new Set(
    allMessages.flatMap((message) => (message.role === "assistant" && message.parentID ? [message.parentID] : [])),
  )
  const assistantWindows = allMessages.flatMap((message) => {
    if (message.role !== "assistant") return []
    if (!message.parentID || typeof message.time.created !== "number") return []
    // 工具循环可能先落下 completed 的 tool-calls 步，但只要会话仍 busy，后续输入仍属于当前引导窗口。
    // 仅在展示/引导判定中临时去掉 completed；通用运行态仍保留原消息，避免停止按钮被错误锁住。
    const steerWindowMessage = manualSteerStepInFlight(message, options?.statusBusy)
      ? { ...message, time: { created: message.time.created } }
      : message
    if (
      !assistantTurnTerminal(steerWindowMessage) &&
      !assistantTurnActive(steerWindowMessage, {
        ...options,
        parts: partsByMessage[message.id],
      })
    )
      return []
    return [
      {
        parentID: message.parentID,
        // 新 assistant 直接携带稳定 turnID；旧消息继续由 parent user 反查逻辑回合。
        turnID: persistedMessageTurnID(message),
        created: message.time.created,
        completed:
          typeof steerWindowMessage.time.completed === "number"
            ? steerWindowMessage.time.completed
            : steerWindowMessage.error
              ? steerWindowMessage.time.created
              : undefined,
      },
    ]
  })
  const result = new Map<string, string | undefined>()
  for (const message of messages) {
    const active =
      typeof message.time.created === "number"
        ? assistantWindows.findLast(
            (assistant) =>
              assistant.parentID !== message.id &&
              assistant.created <= message.time.created &&
              (assistant.completed === undefined || assistant.completed > message.time.created),
          )
        : undefined
    if (explicitManualSteerUserTurn(message, partsByMessage[message.id])) {
      // 显式 steer 即使已进入 idle 也保留 durable 目标；旧 marker 缺目标时才借当前 assistant 窗口恢复。
      result.set(
        message.id,
        persistedMessageTurnID(message) ??
          manualSteerTargetTurnID(message, partsByMessage[message.id]) ??
          active?.turnID ??
          active?.parentID,
      )
      continue
    }
    // 有 durable turnID 的普通队列/continuation 已经能精确归组，不能再被旧时间窗误判成 steer。
    if (persistedMessageTurnID(message)) continue
    if (typeof message.time.created !== "number") continue
    // 一旦这条用户消息已经拥有自己的 assistant 回合，就按普通回合展示；
    // 旧协议没有显式 marker，只能继续用 assistant parent 排除普通队列，避免把新回合误标成引导。
    if (assistantParents.has(message.id)) continue
    if (active) result.set(message.id, active.turnID ?? active.parentID)
  }
  return result
}
