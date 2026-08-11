import type { NamedError } from "@opencode-ai/core/util/error"
import { resolveError } from "@opencode-ai/core/error/resolve"
import type { ErrorCategory } from "@opencode-ai/core/error/error-codes"
import { Cause, Clock, Duration, Effect, Schedule } from "effect"
import { MessageV2 } from "./message-v2"
import { iife } from "@/util/iife"

export type Err = ReturnType<NamedError["toObject"]>

// This exported message is shared with the TUI upsell detector. Matching on a
// literal error string kind of sucks, but it is the simplest for now.
export const GO_UPSELL_MESSAGE = "Free usage exceeded, subscribe to Go https://opencode.ai/go"

export const RETRY_INITIAL_DELAY = 2000
export const RETRY_EMPTY_RESPONSE_DELAY = 500
export const RETRY_BACKOFF_FACTOR = 2
export const RETRY_MAX_DELAY_NO_HEADERS = 60_000 // 60 seconds
export const RETRY_MAX_DELAY = 2_147_483_647 // max 32-bit signed integer for setTimeout
// 无限重试的总时长兜底：可重试错误在此时长内不限次数重试（等服务器恢复自动续跑），
// 累计重试时长超过后才上抛终态错误，避免永久性故障无声无息挂一整夜。
export const RETRY_MAX_DURATION = 12 * 60 * 60 * 1000 // 12 小时（覆盖过夜恢复，够久到正常故障必已恢复，又能在真死透时给终态）

function cap(ms: number) {
  return Math.min(ms, RETRY_MAX_DELAY)
}

// 无服务器 retry-after 指示时的指数退避兜底：封顶 60s，避免无限重试模式下单次 sleep
// 随 attempt 无界膨胀（会一口气睡几个小时、越过 12h 兜底且期间静默）。
function backoff(attempt: number) {
  return cap(Math.min(RETRY_INITIAL_DELAY * Math.pow(RETRY_BACKOFF_FACTOR, attempt - 1), RETRY_MAX_DELAY_NO_HEADERS))
}

function collectText(input: unknown): string[] {
  const result: string[] = []
  const visit = (value: unknown) => {
    if (typeof value === "string") {
      result.push(value)
      return
    }
    if (!value || typeof value !== "object") return
    for (const item of Object.values(value)) visit(item)
  }
  visit(input)
  return result
}

function nonRetryableAuthOrEntitlementError(error: Err) {
  const status = MessageV2.APIError.isInstance(error) ? error.data.statusCode : undefined
  if (status === 401 || status === 403) return true
  const values = [
    error.data?.message,
    MessageV2.APIError.isInstance(error) ? error.data.responseBody : undefined,
    ...collectText(error.data),
  ]
  const text = values.filter(Boolean).join("\n").toLowerCase()
  return [
    "invalid api key",
    "invalid_api_key",
    "api_key_disabled",
    "登录已过期",
    "wanlaicode_oauth_expired",
    "no_entitlement",
    "software_product_not_entitled",
    "software_entitlement_not_found",
    "entitlement expired",
    "subscription expired",
    "套餐过期",
    "套餐已过期",
    "没有套餐",
    "无可用套餐",
    "模型无权限",
    "没有模型权限",
    "无此模型权限",
  ].some((pattern) => text.includes(pattern))
}

// 终态类目：确定性失败，重试不会变好——与 rate_limited / service_unavailable 等瞬态类目相对。
// 覆盖账号停用、API Key 失效、鉴权失效/过期、无套餐权益、套餐额度用尽、订阅过期/停用。
const NON_RETRYABLE_CATEGORIES = new Set<ErrorCategory>([
  "account_disabled",
  "api_key_invalid",
  "auth_expired",
  "auth_invalid",
  "entitlement_missing",
  "quota_exhausted",
  "subscription_expired",
  "subscription_suspended",
])

// 终态不可重试的单一入口。契约优先：带后端 reason 码时按类目判定，随 error-codes.json 演进
// 自动覆盖新增的额度/套餐/鉴权/账号码（如各 SOFTWARE_TOKEN_LIMIT_*_EXCEEDED）。无 reason 码时
// 退回关键字/status 兜底，覆盖旧格式与上游原生 401/403。resolveError 默认 trustHeuristics 关，
// 只采信后端专属机读码，不误伤自配 provider 的模糊 429/quota 文本（其瞬态性交由下游逻辑判定）。
function nonRetryableTerminal(error: Err): boolean {
  if (NON_RETRYABLE_CATEGORIES.has(resolveError(error).category)) return true
  return nonRetryableAuthOrEntitlementError(error)
}

export function delay(attempt: number, error?: MessageV2.APIError, rng: () => number = Math.random) {
  // 对指数退避加 ±10% 抖动：无限重试稳态封顶 60s，多客户端卡同一上游故障时会周期性齐射，
  // 抖动把它们错开，避免 thundering herd。先 cap 再乘抖动，否则高次数都撞封顶、抖动失效。
  const jitter = (ms: number) => Math.round(ms * (0.9 + rng() * 0.2))
  if (error) {
    if (isEmptyResponse(error)) return RETRY_EMPTY_RESPONSE_DELAY
    const headers = error.data.responseHeaders
    if (headers) {
      const retryAfterMs = headers["retry-after-ms"]
      if (retryAfterMs) {
        const parsedMs = Number.parseFloat(retryAfterMs)
        if (!Number.isNaN(parsedMs)) {
          return cap(parsedMs)
        }
      }

      const retryAfter = headers["retry-after"]
      if (retryAfter) {
        const parsedSeconds = Number.parseFloat(retryAfter)
        if (!Number.isNaN(parsedSeconds)) {
          // convert seconds to milliseconds
          return cap(Math.ceil(parsedSeconds * 1000))
        }
        // Try parsing as HTTP date format
        const parsed = Date.parse(retryAfter) - Date.now()
        if (!Number.isNaN(parsed) && parsed > 0) {
          return cap(Math.ceil(parsed))
        }
      }

      return jitter(backoff(attempt))
    }
  }

  return jitter(backoff(attempt))
}

export function retryable(error: Err) {
  // context overflow errors should not be retried
  if (MessageV2.ContextOverflowError.isInstance(error)) return undefined
  if (nonRetryableTerminal(error)) return undefined
  if (MessageV2.APIError.isInstance(error)) {
    const status = error.data.statusCode
    const body = typeof error.data.responseBody === "string" ? error.data.responseBody.toLowerCase() : ""
    const message = error.data.message.toLowerCase()
    const isRateLimited =
      status === 429 ||
      message.includes("rate limit") ||
      message.includes("too many requests") ||
      body.includes("rate_limit") ||
      body.includes("too_many_requests")
    // 5xx errors are transient server failures and should always be retried,
    // even when the provider SDK doesn't explicitly mark them as retryable.
    if (!error.data.isRetryable && !(status !== undefined && status >= 500) && !isRateLimited) return undefined
    if (error.data.responseBody?.includes("FreeUsageLimitError")) return GO_UPSELL_MESSAGE
    if (isRateLimited) return "Rate Limited"
    return error.data.message.includes("Overloaded") ? "Provider is overloaded" : error.data.message
  }

  // Check for rate limit patterns in plain text error messages
  const msg = error.data?.message
  if (typeof msg === "string") {
    const lower = msg.toLowerCase()
    if (
      lower.includes("rate increased too quickly") ||
      lower.includes("rate limit") ||
      lower.includes("too many requests")
    ) {
      return msg
    }
  }

  const json = iife(() => {
    try {
      if (typeof error.data?.message === "string") {
        const parsed = JSON.parse(error.data.message)
        return parsed
      }

      return JSON.parse(error.data.message)
    } catch {
      return undefined
    }
  })
  if (!json || typeof json !== "object") return undefined
  const code = typeof json.code === "string" ? json.code : ""

  if (json.type === "error" && json.error?.type === "too_many_requests") {
    return "Too Many Requests"
  }
  if (code.includes("exhausted") || code.includes("unavailable")) {
    return "Provider is overloaded"
  }
  if (json.type === "error" && typeof json.error?.code === "string" && json.error.code.includes("rate_limit")) {
    return "Rate Limited"
  }
  return undefined
}

export function policy(opts: {
  parse: (error: unknown) => Err
  retry?: (error: Err) => boolean
  set: (input: { attempt: number; message: string; next: number; code?: string }) => Effect.Effect<void>
}) {
  return Schedule.fromStepWithMetadata(
    Effect.succeed((meta: Schedule.InputMetadata<unknown>) => {
      const error = opts.parse(meta.input)
      if (opts.retry && !opts.retry(error)) return Cause.done(meta.attempt)
      const message = retryable(error)
      if (!message) return Cause.done(meta.attempt)
      // 无限重试：只受总时长兜底约束，不再限制次数。meta.elapsed 为本轮重试累计时长。
      if (meta.elapsed >= RETRY_MAX_DURATION) return Cause.done(meta.attempt)
      return Effect.gen(function* () {
        // 严格兜底：把单次退避夹到剩余预算内，任何 delay（含服务器指定的大 retry-after）
        // 都不会让累计重试时长越过 12h。判停在上面（elapsed>=上限），故 remaining 必为正。
        const remaining = RETRY_MAX_DURATION - meta.elapsed
        const wait = Math.min(delay(meta.attempt, MessageV2.APIError.isInstance(error) ? error : undefined), remaining)
        const now = yield* Clock.currentTimeMillis
        const code = MessageV2.APIError.isInstance(error) ? error.data.metadata?.code : undefined
        yield* opts.set({ attempt: meta.attempt, message, next: now + wait, code })
        return [meta.attempt, Duration.millis(wait)] as [number, Duration.Duration]
      })
    }),
  )
}

export function isStreamStall(error: Err): boolean {
  return MessageV2.APIError.isInstance(error) && error.data.metadata?.code === "STREAM_STALL"
}

export function isEmptyResponse(error: Err): boolean {
  return MessageV2.APIError.isInstance(error) && error.data.metadata?.code === "EMPTY_RESPONSE"
}

export function isStreamFailed(error: Err): boolean {
  return MessageV2.APIError.isInstance(error) && error.data.metadata?.code === "STREAM_FAILED"
}

// 流中断 = 字节级停滞(STREAM_STALL)或上游显式失败(STREAM_FAILED,来自 response.failed)。
// 二者一旦在「已产出内容后」发生都不可重试(会重复/串台已写入 part),重试门控据此拦截;
// 首 token 前发生则仍可无感重试自愈。
export function isMidStreamInterruption(error: Err): boolean {
  return isStreamStall(error) || isStreamFailed(error)
}

export * as SessionRetry from "./retry"
