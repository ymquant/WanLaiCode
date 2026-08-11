// 工具调用参数解析失败时的修复逻辑（供 streamText 的 experimental_repairToolCall 使用）。
//
// 背景：当模型在工具调用参数（典型是 write 的 content）写到一半就达到输出 token 上限
// （finish_reason=length）时,累积出的 arguments JSON 是「未闭合」的,@ai-sdk 用
// JSON.parse 解析会抛 InvalidToolInputError,错误形如:
//   "Invalid input for tool write: JSON parsing failed: Text: {...}. Error message:
//    Unterminated string in JSON at position N"
//
// 这类截断与「特殊字符 / 转义」无关（% 等都是合法 JSON）,但默认把原始 JSON 错误透传给
// 模型会误导它往「转义/特殊字符」方向反复重试同一个过长的 write,白白空转多轮。本模块在
// 识别出截断后,改给模型一段可操作的指引:分块写入 / 减少单次内容,从而打断空转循环。

// 主判别：累积的参数串是否为「未闭合的 JSON 前缀」。截断必然未闭合（结尾仍在字符串内,
// 或括号/方括号未配平）；而真·非法 JSON（如未加引号的 key、缺逗号、单引号、未转义控制符）
// 通常是「配平且完整」的,只是语法非法 —— 据此把二者区分开,且与 JS 运行时的报错措辞无关
// （Node/V8 与 Bun/JSC 的 JSON 报错文案不同,纯靠正则匹配既会漏判也会误判）。
export function endsTruncated(raw: string): boolean {
  let inString = false
  let escaped = false
  let depth = 0
  for (const ch of raw) {
    if (escaped) {
      escaped = false
      continue
    }
    if (inString) {
      if (ch === "\\") escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === "{" || ch === "[") depth++
    else if (ch === "}" || ch === "]") depth--
  }
  // 结尾仍在字符串里 → 截断；括号未配平（开 > 闭）→ 截断。
  return inString || depth > 0
}

// 运行时无关的高置信度报错文案,仅在拿不到原始参数串时作兜底（结构判别为主）。
const TRUNCATION_SIGNATURES = [/unterminated string/i, /unexpected end of (json input|json|data|input)/i, /unexpected eof/i]

export function errorMessageOf(error: unknown): string {
  if (typeof error === "string") return error
  if (error instanceof Error) return error.message
  if (error && typeof error === "object" && "message" in error) return String((error as { message: unknown }).message)
  return String(error)
}

// 判断一次工具参数解析失败是否由「参数 JSON 被截断」引起（而非真正的非法 JSON）。
// 主用结构判别（拿得到原始参数串时）；拿不到时退回高置信度文案匹配。
export function isTruncatedToolInput(rawInput: unknown, errorMessage?: string): boolean {
  if (typeof rawInput === "string") {
    const trimmed = rawInput.trim()
    if (trimmed !== "" && (trimmed.startsWith("{") || trimmed.startsWith("["))) {
      return endsTruncated(rawInput)
    }
  }
  return !!errorMessage && TRUNCATION_SIGNATURES.some((re) => re.test(errorMessage))
}

// 截断场景下给模型的可操作指引。明确否定「特殊字符/转义」这一常见误判,引导分块写入。
// 注意只引用仓库真实存在的工具（write / edit）,不提不存在的 append 工具。
export function truncationGuidance(toolName: string, originalError: string): string {
  return (
    `Output was truncated: the previous \`${toolName}\` call was cut off before it finished because the ` +
    `response reached the model's output token limit, so its arguments JSON was incomplete and could not be parsed. ` +
    `This is NOT caused by special characters or escaping — characters like % are valid JSON and need no encoding. ` +
    `It means the arguments (typically the file \`content\`) are too large to send in a single tool call. ` +
    `Do NOT repeat the same call. Write less per call: create the file with the first portion using \`write\`, then ` +
    `add each remaining portion with the \`edit\` tool; or split the content across multiple files. ` +
    `(original parser error: ${originalError})`
  )
}

// 决定要写进 invalid 工具的 error 文案：截断 → 可操作指引；其余 → 透传原始错误。
export function describeToolInputError(toolName: string, errorMessage: string, rawInput?: unknown): string {
  return isTruncatedToolInput(rawInput, errorMessage) ? truncationGuidance(toolName, errorMessage) : errorMessage
}

export interface FailedToolCall {
  toolCall: { toolName: string; input?: unknown; [key: string]: unknown }
  error: unknown
}

export interface RepairedToolCall {
  toolName: string
  input?: unknown
  [key: string]: unknown
}

// 纯函数版的 experimental_repairToolCall。
// 1) 大小写修复：模型把工具名写成 "Write" 而存在 "write" 时,直接改名重试。
// 2) 其余（含所有 JSON 解析失败）：改写成对 invalid 工具的合法调用,error 文案按截断与否区分。
export function repairToolCall(failed: FailedToolCall, tools: Record<string, unknown>): RepairedToolCall {
  const original = failed.toolCall.toolName
  const lower = original.toLowerCase()
  if (lower !== original && lower in tools) {
    return { ...failed.toolCall, toolName: lower }
  }

  const errorMessage = errorMessageOf(failed.error)
  return {
    ...failed.toolCall,
    input: JSON.stringify({ tool: original, error: describeToolInputError(original, errorMessage, failed.toolCall.input) }),
    toolName: "invalid",
  }
}
