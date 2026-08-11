import contract from "./error-codes.json"

// 与后端契约的 category 取值保持一致（来源 error-codes.json）。
export type ErrorCategory =
  | "auth_expired"
  | "auth_invalid"
  | "entitlement_missing"
  | "upgrade_required"
  | "subscription_expired"
  | "subscription_suspended"
  | "quota_exhausted"
  | "rate_limited"
  | "account_disabled"
  | "api_key_invalid"
  | "upstream_error"
  | "invalid_request"
  | "service_unavailable"
  | "internal"
  | "unknown"

// 从契约快照构建 reason→category 真相表（单一来源，无 drift）。
export const REASON_TO_CATEGORY: Record<string, ErrorCategory> = Object.fromEntries(
  (contract.entries as Array<{ reason: string; category: string }>).map((e) => [e.reason, e.category as ErrorCategory]),
)

export type ClassifyInput = {
  reason?: string // 业务 envelope 顶层 reason / OAuth raw reason
  errorCode?: string // 网关 chat/messages error.code
  subCode?: string // 网关 responses API error.sub_code
  httpStatus?: number
  message?: string // 降级文本兜底
  // 无 reason 码时是否信任 status/text 启发式兜底。
  // 默认（false）：无 reason 时不猜——避免把用户自配 provider（OpenAI/DeepSeek 等）的
  // 401/429/"quota" 误判成万来 category（指向万来 OAuth/套餐的误导文案）。
  // 仅当调用点能担保错误来自万来网关/后端（如 session-turn 的 isWanlai gate）时传 true。
  // 注意：有 reason 码（万来后端专属）时启发式兜底无条件启用——reason 已证明来源，不受此 flag 影响。
  trustHeuristics?: boolean
}

export type Classified = {
  category: ErrorCategory
  reason?: string
}

function categoryByStatus(status: number): ErrorCategory {
  switch (status) {
    case 401:
      return "auth_invalid"
    case 429:
      return "rate_limited"
    case 503:
      return "service_unavailable"
    default:
      if (status >= 500) return "upstream_error"
      if (status === 400 || status === 404 || status === 409) return "invalid_request"
      return "unknown"
  }
}

function categoryByText(message: string): ErrorCategory {
  const m = message.toLowerCase()
  if (m.includes("oauth authorization expired")) return "auth_expired"
  if (m.includes("oauth login is required")) return "auth_invalid"
  if (m.includes("entitlement") || m.includes("无可用万来code套餐权益")) return "entitlement_missing"
  if (m.includes("insufficient_quota") || m.includes("quota_exhausted") || m.includes("quota exhausted"))
    return "quota_exhausted"
  return "unknown"
}

function categoryByReason(reason: string): ErrorCategory | undefined {
  const category = REASON_TO_CATEGORY[reason] ?? REASON_TO_CATEGORY[reason.toUpperCase()]
  if (category) return category
  const normalized = reason.toLowerCase()
  if (normalized === "upstream_error" || normalized === "upstream_request_failed") return "upstream_error"
  if (normalized === "service_unavailable") return "service_unavailable"
  if (normalized === "rate_limit_exceeded") return "rate_limited"
  if (normalized === "invalid_request_error") return "invalid_request"
  return undefined
}

// 读码优先（reason → error.code → sub_code），退 HTTP status，退文本，最后 unknown。
export function classifyError(input: ClassifyInput): Classified {
  const reason = input.reason ?? input.errorCode ?? input.subCode
  // status/text 启发式兜底：退 HTTP status，退文本，最后 unknown（始终透传 reason）。
  const heuristicFallback = (): Classified => {
    if (typeof input.httpStatus === "number") {
      const category = categoryByStatus(input.httpStatus)
      if (category !== "unknown") return { category, reason }
    }
    if (input.message) {
      const category = categoryByText(input.message)
      if (category !== "unknown") return { category, reason }
    }
    return { category: "unknown", reason }
  }
  if (reason) {
    const category = categoryByReason(reason)
    if (category) return { category, reason }
    // 有 reason 但未识别（契约漂移期，JSON 尚未同步新码）：不短路成 unknown，
    // 退回 status/text 兜底——reason 已证明来自后端契约，启发式在此安全。
    return heuristicFallback()
  }
  // 无 reason：仅当调用点担保万来来源（trustHeuristics）时才启用启发式兜底；
  // 否则不猜，直接 unknown（自配 provider / 本地操作错误保持原样，不被误判）。
  if (input.trustHeuristics) return heuristicFallback()
  return { category: "unknown" }
}
