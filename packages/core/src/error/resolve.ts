import { classifyError, type ErrorCategory } from "./error-codes"
import { errorAction, type ErrorAction } from "./error-actions"
import { gatewayReasonFromBody } from "./gateway-reason"
import { reasonFromMessage } from "./parse-reason"

export type ResolvedError = {
  category: ErrorCategory
  action: ErrorAction
  reason?: string
  messageKey: string // "errors.category.<category>"
  rawMessage?: string
}

// 网关 sub_code/code 与 envelope reason 已在此统一合并为单一 reason 传给 classifyError；
// classifyError 的 errorCode/subCode 参数留给直接调用它的其它调用方。
function toClassifyInput(error: unknown): { reason?: string; httpStatus?: number; message?: string; rawMessage?: string } {
  if (error == null) return {}
  if (typeof error === "string") return { message: error, rawMessage: error }
  if (typeof error !== "object") return {}
  const obj = error as Record<string, unknown>
  const data = (obj.data && typeof obj.data === "object" ? (obj.data as Record<string, unknown>) : obj) as Record<string, unknown>
  const directReason = typeof obj.reason === "string" ? obj.reason : typeof data.reason === "string" ? data.reason : undefined
  const responseBody = typeof data.responseBody === "string" ? data.responseBody : undefined
  let gatewayReason: string | undefined
  if (responseBody) {
    try { gatewayReason = gatewayReasonFromBody(JSON.parse(responseBody)) } catch { /* ignore */ }
  }
  const status = typeof obj.status === "number" ? obj.status : typeof data.statusCode === "number" ? data.statusCode : undefined
  const message = typeof obj.message === "string" ? obj.message : typeof data.message === "string" ? data.message : undefined
  const reason = directReason ?? gatewayReason ?? reasonFromMessage(message)
  return { reason, httpStatus: status, message, rawMessage: message }
}

// opts.trustHeuristics：调用点担保错误来自万来网关/后端时传 true，
// 允许无 reason 码时退 HTTP status / 文本启发式兜底（如 session-turn 的 isWanlai 路径）。
// 默认 false——app 层通用 toast 调用点（可能承载本地操作 / 自配 provider 错误）保持安全：
// 无 reason 时不做启发式分类，直接 unknown → 调用方用 formatServerError 原样展示。
export function resolveError(error: unknown, opts?: { trustHeuristics?: boolean }): ResolvedError {
  const input = toClassifyInput(error)
  const { category, reason } = classifyError({
    reason: input.reason,
    httpStatus: input.httpStatus,
    message: input.message,
    trustHeuristics: opts?.trustHeuristics ?? false,
  })
  return {
    category,
    action: errorAction(category),
    reason,
    messageKey: `errors.category.${category}`,
    rawMessage: input.rawMessage,
  }
}
