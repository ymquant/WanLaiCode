export const CONTEXT_MESSAGES = 6
export const CONTEXT_CHARS = 2000
export const MAX_LENGTH = 100
export const MAX_OUTPUT_TOKENS = 1024

// 按 UTF-16 码元截断，但不在代理对中间切断（emoji 等增补平面字符）
function truncate(text: string, max: number) {
  const sliced = text.slice(0, max)
  return /[\uD800-\uDBFF]$/.test(sliced) ? sliced.slice(0, -1) : sliced
}

// 结构化最小类型，兼容 MessageV2.WithParts，便于纯函数测试
export type TranscriptMessage = {
  readonly info: { readonly role: string }
  readonly parts: ReadonlyArray<{
    readonly type: string
    readonly text?: string
    readonly synthetic?: boolean
    readonly ignored?: boolean
  }>
}

export function transcript(messages: ReadonlyArray<TranscriptMessage>) {
  return messages
    .flatMap((m) => {
      if (m.info.role !== "user" && m.info.role !== "assistant") return []
      const text = m.parts
        .filter((p) => p.type === "text" && !p.synthetic && !p.ignored && !!p.text?.trim())
        .map((p) => p.text)
        .join("\n")
      if (!text) return []
      return [truncate(`${m.info.role}: ${text}`, m.info.role.length + 2 + CONTEXT_CHARS)]
    })
    .slice(-CONTEXT_MESSAGES)
    .join("\n\n")
}

export function clean(text: string) {
  const line = text
    // 未闭合的 <think> 一并丢弃到结尾，避免把推理文本泄漏成建议
    .replace(/<think>[\s\S]*?(?:<\/think>\s*|$)/g, "")
    .split("\n")
    .map((item) => item.trim())
    .find((item) => item.length > 0)
  if (!line) return undefined
  const unquoted = line.replace(/^["'“”‘’「『]+|["'“”‘’」』]+$/g, "").trim()
  if (!unquoted) return undefined
  if (/^(none|nothing|n\/a)[.!]?$/i.test(unquoted)) return undefined
  if (unquoted.length <= MAX_LENGTH) return unquoted
  return truncate(unquoted, MAX_LENGTH - 3) + "..."
}

// 防过期守卫：检查 first-seen 时间轴中 lastUserID 之后是否出现了用户消息；
// 远控 ID 与本地 ID 都只负责唯一标识，绝不参与先后顺序推断。
export function hasNewerUserMessage(
  messages: ReadonlyArray<{ readonly info: { readonly role: string; readonly id: string } }>,
  lastUserID: string,
) {
  // ID 可能由离线客户端提前生成，不能代表到达顺序；目标不在窗口时也不凭 ID 猜测新旧。
  const lastUserIndex = messages.findIndex((message) => message.info.id === lastUserID)
  if (lastUserIndex < 0) return false
  return messages.slice(lastUserIndex + 1).some((message) => message.info.role === "user")
}

export * as SessionSuggestion from "./suggestion"
