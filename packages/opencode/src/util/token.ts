const CHARS_PER_TOKEN = 4

export function estimate(input: string) {
  const text = input || ""
  if (!text) return 0
  return Math.max(0, Math.round(text.length / CHARS_PER_TOKEN))
}

export function estimateRequest(input: string) {
  const text = input || ""
  if (!text) return 0
  // 仅用于“请求体已经大到上游可能空流”的兜底判断；不改变全局压缩估算，避免旧中文会话刷新后突然压缩。
  const ascii = text.match(/[\u0000-\u007f]/g)?.length ?? 0
  return Math.max(0, Math.round(ascii / CHARS_PER_TOKEN + (text.length - ascii)))
}

export * as Token from "./token"
