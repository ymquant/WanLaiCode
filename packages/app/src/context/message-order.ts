import type { Message } from "@opencode-ai/sdk/v2/client"

const compareID = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0)

/**
 * 消息的权威顺序与服务端数据库、分页游标保持一致：先比较创建时间，同一毫秒再用 ID 稳定排序。
 * ID 只负责标识同一条消息，不能单独代表先后；旧远控消息的 msg_remote_<hash> 尤其不具备时间顺序。
 */
export function compareMessageOrder(left: Message, right: Message) {
  if (left.time.created !== right.time.created) return left.time.created < right.time.created ? -1 : 1
  return compareID(left.id, right.id)
}

/** 消息数组改为时间排序后，按 ID 查找必须使用身份查找，不能继续对 ID 做二分搜索。 */
export function findMessageIndexByID(messages: readonly Message[], messageID: string) {
  return messages.findIndex((message) => message.id === messageID)
}

/** 在已经按 compareMessageOrder 排序的数组中查找稳定插入位置。 */
export function messageInsertionIndex(messages: readonly Message[], message: Message) {
  let left = 0
  let right = messages.length
  while (left < right) {
    const middle = Math.floor((left + right) / 2)
    if (compareMessageOrder(messages[middle]!, message) < 0) left = middle + 1
    else right = middle
  }
  return left
}

/** 返回新的时间有序数组，不修改调用方持有的原数组。 */
export function sortMessages(messages: readonly Message[]) {
  return [...messages].sort(compareMessageOrder)
}

type MessageTurnIdentity = Message & {
  turnID?: string
  steerTargetTurnID?: string
  continuationTurnID?: string
}

export function preserveKnownMessageTurnIdentity(current: Message | undefined, incoming: Message) {
  if (!current || current.id !== incoming.id || current.role !== incoming.role) return incoming

  const previous = current as MessageTurnIdentity
  const next = incoming as MessageTurnIdentity
  // 新协议返回任一回合字段时，以服务端完整身份为准；这也允许 inactive fallback 用自身 turnID 清除旧 steer 目标。
  if (next.turnID || next.steerTargetTurnID || next.continuationTurnID) return incoming
  // 旧后端确认消息时会省略新增字段；保留同 ID 乐观消息已经绑定的回合，避免 ACK 后气泡突然跳出当前 turn。
  if (!previous.turnID && !previous.steerTargetTurnID && !previous.continuationTurnID) return incoming
  return {
    ...incoming,
    ...(previous.turnID ? { turnID: previous.turnID } : {}),
    ...(previous.steerTargetTurnID ? { steerTargetTurnID: previous.steerTargetTurnID } : {}),
    ...(previous.continuationTurnID ? { continuationTurnID: previous.continuationTurnID } : {}),
  } as Message
}

/**
 * 按 ID 替换同一条消息，再按最新的权威创建时间重新定位。
 * 服务端回显可能修正乐观消息的创建时间，因此不能只在原下标覆盖。
 */
export function upsertMessage(messages: readonly Message[], message: Message) {
  const current = findMessageIndexByID(messages, message.id)
  const resolved = preserveKnownMessageTurnIdentity(current < 0 ? undefined : messages[current], message)
  const next = current < 0 ? [...messages] : [...messages.slice(0, current), ...messages.slice(current + 1)]
  next.splice(messageInsertionIndex(next, resolved), 0, resolved)
  return next
}

/** 按 ID 去重合并消息；服务端快照更新正文和时间，本地已知的旧协议 turn 身份继续保留。 */
export function mergeMessages(current: readonly Message[], incoming: readonly Message[]) {
  const byID = new Map(current.map((message) => [message.id, message] as const))
  // 侧栏预取与会话页共享同一 store；旧后端预取结果不能在后台擦掉已经由 optimistic/SSE 确认的 steer 归属。
  for (const message of incoming) byID.set(message.id, preserveKnownMessageTurnIdentity(byID.get(message.id), message))
  return sortMessages([...byID.values()])
}
