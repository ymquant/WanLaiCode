import type { AssistantMessage, Message, Part, TextPart, UserMessage } from "@opencode-ai/sdk/v2/client"

export type SessionTurnActivityMember =
  | { type: "assistant"; message: AssistantMessage; final: boolean }
  | { type: "steering"; message: UserMessage }

export type SessionTurnActivitySegment = {
  id: string
  steering?: UserMessage
  members: Extract<SessionTurnActivityMember, { type: "assistant" }>[]
}

export function reconcileSessionTurnActivityMembers(
  previous: readonly SessionTurnActivityMember[],
  next: readonly SessionTurnActivityMember[],
) {
  if (previous === next) return previous
  const byKey = new Map(previous.map((member) => [`${member.type}:${member.message.id}`, member] as const))
  // presentation 会在消息数组变化时创建新包装对象；按稳定消息身份复用旧成员，让 Solid 只挂载真正新增的活动节点。
  return next.map((member) => {
    const existing = byKey.get(`${member.type}:${member.message.id}`)
    if (!existing || existing.message !== member.message || existing.type !== member.type) return member
    if (existing.type === "assistant" && member.type === "assistant" && existing.final !== member.final) return member
    return existing
  })
}

export type AssistantTextPhase = NonNullable<TextPart["phase"]>

// 官方 phase 优先；历史/兼容数据没有 phase 时，用 assistant 终止原因与当前工具活动恢复同一展示语义。
export function assistantTextPhase(input: {
  part: Pick<TextPart, "id" | "phase" | "metadata">
  message: Pick<AssistantMessage, "finish">
  parts: readonly Part[]
}): AssistantTextPhase {
  if (input.part.phase) return input.part.phase
  // 历史 Responses 数据只把 phase 放在 provider metadata 中；升级后读取时仍要保持原来的官方语义。
  const metadataPhase = Object.values(input.part.metadata ?? {}).find(
    (value): value is { phase: AssistantTextPhase } =>
      !!value &&
      typeof value === "object" &&
      "phase" in value &&
      (value.phase === "commentary" || value.phase === "final_answer"),
  )?.phase
  if (metadataPhase) return metadataPhase
  if (input.message.finish === "tool-calls" || input.message.finish === "unknown") return "commentary"
  // 流式步骤尚未收到 finish 时，只把后面仍有工具的文字留在活动流；工具后的尾部正文仍是最终回复。
  // 这样既能在 tool 出现时把此前说明归回 commentary，也不会吞掉旧会话里“工具 -> 最终正文”的回答。
  if (!input.message.finish) {
    const index = input.parts.findIndex((part) => part.id === input.part.id)
    if (input.parts.slice(index + 1).some((part) => part.type === "tool")) return "commentary"
  }
  return "final_answer"
}

function visibleAssistantTextPart(part: Part): part is TextPart {
  return part.type === "text" && !part.synthetic && !part.ignored && !!part.text?.trim()
}

// 活动区保留所有真实文本，只排除已经被选作底部最终回复的唯一 item。
export function assistantTextPartInActivity(part: Part, finalTextPartID?: string): part is TextPart {
  return visibleAssistantTextPart(part) && part.id !== finalTextPartID
}

// Codex 每个响应段只把最后一个真实 final_answer item 抽到回合底部；返回原对象以保持 Solid store 代理稳定。
export function selectFinalAssistantTextPart(items: readonly { message: AssistantMessage; parts: readonly Part[] }[]) {
  const activity = items.flatMap((item) => {
    if (item.message.summary === true) return []
    // 中间序列同时承载文本、工具和推理，显式保留通用 Part 类型供尾部规则统一判定。
    return item.parts.flatMap<{ message: AssistantMessage; parts: readonly Part[]; part: Part }>((part) => {
      // text-start 会先创建空 item，首个 delta 稍后才填入正文；真实空 item 也必须立即占据原始顺序，
      // 否则它从不可见变为可见时，会把此前已抽到底部的 final_answer 突然推回活动区。
      if (part.type === "text" && !part.synthetic && !part.ignored)
        return [{ message: item.message, parts: item.parts, part }]
      // 官方只让真实活动 item 阻挡最终回复提取；运行中 reasoning 即使尚无首个 delta，也已经占据原始顺序。
      if (part.type === "tool") return [{ message: item.message, parts: item.parts, part }]
      if (part.type === "reasoning") return [{ message: item.message, parts: item.parts, part }]
      // step/snapshot 等内部 part 不参与展示顺序。
      return []
    })
  })

  // 官方允许最终回复后跟随已完成的 reasoning 快照，但运行中的 reasoning 或后续工具仍表示活动尚未结束。
  const index = activity.findLastIndex(
    (item) => item.part.type !== "reasoning" || typeof item.part.time?.end !== "number",
  )
  const selected = activity[index]
  // 空文本只承担稳定排序的占位职责；有实际正文后才允许成为底部最终回复。
  if (!selected || !visibleAssistantTextPart(selected.part)) return undefined
  if (assistantTextPhase({ part: selected.part, message: selected.message, parts: selected.parts }) !== "final_answer")
    return undefined
  return { message: selected.message, part: selected.part }
}

// 「空回复」提示只适用于模型确实以终止原因收尾（finish=stop 等）却没有可显示内容的情况。
// finish 未定说明这条 assistant 是被截断的：用户主动停止/暂停、被动中断（实例 scope 关闭、崩溃重启）
// 都可能只留下「无 finish、无错误」的半成品——把它当成「空回复，请重试或切换模型」会误导用户，
// 尤其是自己刚暂停目标的场景。工具步骤（tool-calls/unknown）也不是最终回复，同样排除。
export function assistantEndedWithResponse(message: Pick<AssistantMessage, "finish"> | undefined): boolean {
  return !!message?.finish && !["tool-calls", "unknown"].includes(message.finish)
}

// 一条 assistant 是否已经走到终点。判定顺序即契约：
// 后端在空回复重试期间会把上一轮 attempt 的 finish 清掉（processor.ts 的空流分支），
// 让这里回到「未结束」，重试窗口才会显示「正在重试」而不是误报空回复。
export function assistantTurnTerminal(message: Pick<AssistantMessage, "error" | "finish" | "time">): boolean {
  if (message.error) return true
  if (message.finish) return !["tool-calls", "unknown"].includes(message.finish)
  return typeof message.time?.completed === "number"
}

// 压缩摘要 assistant 通过 parentID 挂在压缩触发 user 上；收尾（完成或失败）即视为压缩结束。
// overflow 自动压缩与后续续跑共享同一回合，分割线时态只能看摘要自身，不能绑整回合 working。
export function compactionFinished(messages: readonly Message[], compactionUserMessageID: string): boolean {
  const summary = messages.findLast(
    (message): message is AssistantMessage =>
      message.role === "assistant" && message.summary === true && message.parentID === compactionUserMessageID,
  )
  if (!summary) return false
  return !!summary.time.completed || !!summary.error
}

export function sessionTurnPresentation(input: {
  messages: readonly Message[]
  rootMessageID: string
  memberMessageIDs?: readonly string[]
  steeringUserMessageIDs?: readonly string[]
}) {
  const byID = new Map(input.messages.map((message) => [message.id, message]))
  // 新时间线直接传入服务端顺序；旧调用方没有成员列表时继续沿用 root parent 关系，避免升级破坏历史页面。
  const rawMembers = input.memberMessageIDs
    ? input.memberMessageIDs.flatMap((messageID) => {
        const message = byID.get(messageID)
        return message ? [message] : []
      })
    : input.messages.filter(
        (message) =>
          message.id === input.rootMessageID ||
          (message.role === "assistant" && message.parentID === input.rootMessageID),
      )
  // 压缩摘要是内部产物：即便因折叠被重挂到本轮（自动压缩），也不作为回合内容展示，
  // 否则摘要 agent 的 reasoning 会漏进思考组、完成时长也会被压缩时间污染。
  // 但压缩失败(带 error)时保留，让错误卡片仍能展示。
  const members = rawMembers.filter(
    (message) => !(message.role === "assistant" && message.summary === true && !message.error),
  )
  const steeringIDs = new Set([
    ...(input.steeringUserMessageIDs ?? []),
    // ACK 与时间线标记可能分开到达；持久化目标本身足以证明这是一条 steer，不能在竞态窗口退回旧布局。
    ...members.flatMap((message) =>
      message.role === "user" && message.id !== input.rootMessageID && message.steerTargetTurnID ? [message.id] : [],
    ),
  ])
  const assistants = members.filter((message): message is AssistantMessage => message.role === "assistant")
  const lastSteeringIndex = members.findLastIndex((message) => message.role === "user" && steeringIDs.has(message.id))
  // 错误、停止和空回复状态只属于最后一次 steer 开始的响应段；此前步骤仍作为历史活动展示，但不能污染新结果。
  const currentMembers = members.slice(lastSteeringIndex < 0 ? 0 : lastSteeringIndex)
  const currentAssistants = currentMembers.filter(
    (message): message is AssistantMessage => message.role === "assistant",
  )
  const currentUsers = currentMembers.filter((message): message is UserMessage => message.role === "user")
  // 最新 assistant 只负责当前响应段的终态判断；真正的 final_answer 需由渲染层结合其 parts 另行选择。
  const finalAssistant = currentAssistants.findLast((message) => message.summary !== true)
  const steering = members.filter(
    (message): message is UserMessage =>
      message.role === "user" && message.id !== input.rootMessageID && steeringIDs.has(message.id),
  )
  const activity = members.flatMap<SessionTurnActivityMember>((message) => {
    if (message.role === "assistant") {
      return [{ type: "assistant", message, final: message.id === finalAssistant?.id }]
    }
    if (message.id === input.rootMessageID || !steeringIDs.has(message.id)) return []
    return [{ type: "steering", message }]
  })

  // 响应段只隔离最新错误与最终回答选择；UI 仍按 activity 原序放进同一个 turn 级处理容器。
  const activitySegments = activity.reduce<SessionTurnActivitySegment[]>(
    (segments, member) => {
      if (member.type === "steering") {
        segments.push({ id: member.message.id, steering: member.message, members: [] })
        return segments
      }
      const current = segments.at(-1)
      if (current) current.members.push(member)
      return segments
    },
    [{ id: input.rootMessageID, members: [] }],
  )

  return {
    members,
    assistants,
    steering,
    activity,
    activitySegments,
    currentMembers,
    currentAssistants,
    currentUsers,
    finalAssistant,
  }
}
