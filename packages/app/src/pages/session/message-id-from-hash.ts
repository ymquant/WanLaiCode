import type { UserMessage } from "@opencode-ai/sdk/v2"

export const messageIdFromHash = (hash: string) => {
  const value = hash.startsWith("#") ? hash.slice(1) : hash
  const match = value.match(/^message-(.+)$/)
  if (!match) return
  return match[1]
}

export function resolveMessageHashTarget(input: {
  messageID: string
  visibleUserMessages: readonly UserMessage[]
  messageAnchorID?: (messageID: string) => string | undefined
}) {
  const direct = input.visibleUserMessages.find((message) => message.id === input.messageID)
  if (direct) return { message: direct, targetMessageID: input.messageID }
  // steer 不是一级历史行；先找到它所属 turn 的可见 user 锚点，最终仍滚到 steer 自己的 DOM ID。
  const anchorID = input.messageAnchorID?.(input.messageID)
  if (!anchorID) return
  const message = input.visibleUserMessages.find((item) => item.id === anchorID)
  if (!message) return
  return { message, targetMessageID: input.messageID }
}
