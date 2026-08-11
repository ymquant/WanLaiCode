import { expect, test, describe } from "bun:test"
import { resolveError } from "./resolve"

describe("resolveError", () => {
  test("APIError with gateway responseBody → category from sub_code", () => {
    const err = { name: "APIError", data: { message: "quota", statusCode: 429, isRetryable: false, responseBody: JSON.stringify({ error: { code: "rate_limit_exceeded", sub_code: "USER_PLATFORM_DAILY_QUOTA_EXHAUSTED" } }) } }
    const r = resolveError(err)
    expect(r.category).toBe("quota_exhausted")
    expect(r.action).toBe("show_quota")
    expect(r.messageKey).toBe("errors.category.quota_exhausted")
  })
  test("WanlaiCodeBackendError-like with reason field", () => {
    const r = resolveError({ status: 403, message: "x", reason: "SUBSCRIPTION_EXPIRED" })
    expect(r.category).toBe("subscription_expired")
    expect(r.action).toBe("open_purchase")
  })
  // 问题一：无 reason 码时默认（untrusted）不做 status 启发式——自配 provider / 本地操作错误保持原样。
  test("no reason + default (untrusted) → unknown, status not guessed", () => {
    const r = resolveError({ status: 401, message: "unauthorized" })
    expect(r.category).toBe("unknown")
    expect(r.action).toBe("show_message")
    expect(r.rawMessage).toBe("unauthorized")
  })
  // 调用点担保万来来源（trustHeuristics）时才退 HTTP status 兜底。
  test("no reason + trustHeuristics → status fallback", () => {
    const r = resolveError({ status: 401, message: "unauthorized" }, { trustHeuristics: true })
    expect(r.category).toBe("auth_invalid")
    expect(r.action).toBe("show_message")
  })
  test("unknown → show_message + rawMessage preserved", () => {
    const r = resolveError(new Error("weird backend message"))
    expect(r.category).toBe("unknown")
    expect(r.action).toBe("show_message")
    expect(r.rawMessage).toBe("weird backend message")
  })
  test("APIError with gateway responseBody → category from error.code (chat path)", () => {
    const err = { name: "APIError", data: { message: "rate", statusCode: 429, isRetryable: true, responseBody: JSON.stringify({ error: { code: "API_KEY_RATE_5H_EXCEEDED" } }) } }
    const r = resolveError(err)
    expect(r.category).toBe("quota_exhausted")
  })
  // 鉴权中间件(api_key_auth)错误体是顶层 {code,message}(非嵌套 error),如 5 小时滚动窗口用满。
  // 需据顶层 code 分类(对齐 session-turn-error 的 extractBackendCode),否则只会退 HTTP 429 → rate_limited,
  // 把「额度用完」误显示成「请求过于频繁」。
  test("APIError with top-level code in responseBody → quota_exhausted (auth-middleware envelope)", () => {
    const err = { name: "APIError", data: { message: "software package 5小时 token 已用完", statusCode: 429, isRetryable: true, responseBody: JSON.stringify({ code: "SOFTWARE_TOKEN_LIMIT_5H_EXCEEDED", message: "software package 5小时 token 已用完" }) } }
    const r = resolveError(err)
    expect(r.category).toBe("quota_exhausted")
    expect(r.action).toBe("show_quota")
  })
  // DeepSeek 独立日额度耗尽(网关 responses 出口写入 sub_code) → quota_exhausted。
  test("APIError with DeepSeek daily quota sub_code → quota_exhausted", () => {
    const err = { name: "APIError", data: { message: "DeepSeek 今日专属额度已用完", statusCode: 429, isRetryable: true, responseBody: JSON.stringify({ error: { code: "rate_limit_error", sub_code: "SOFTWARE_TOKEN_LIMIT_DEEPSEEK_DAILY_EXCEEDED" } }) } }
    const r = resolveError(err)
    expect(r.category).toBe("quota_exhausted")
    expect(r.action).toBe("show_quota")
  })
  // 顶层小写 code 不采信(MACHINE_CODE 收敛):untrusted 默认下保持 unknown,不把自配 provider 误分类。
  test("top-level lowercase code is rejected → unknown (untrusted)", () => {
    const err = { name: "APIError", data: { statusCode: 429, responseBody: JSON.stringify({ code: "insufficient_quota", message: "x" }) } }
    const r = resolveError(err)
    expect(r.category).toBe("unknown")
  })
  // 有嵌套 error 信封(provider 风格)时不回退读顶层 code,避免误采自配 provider 的顶层字段。
  test("nested error envelope present → does not fall back to top-level code", () => {
    const err = { name: "APIError", data: { statusCode: 429, responseBody: JSON.stringify({ error: { type: "rate_limit_error" }, code: "SOFTWARE_TOKEN_LIMIT_5H_EXCEEDED" }) } }
    const r = resolveError(err)
    expect(r.category).toBe("unknown")
  })
  test("no reason + message with machine reason prefix → category from reason", () => {
    const r = resolveError({
      message: "SOFTWARE_BILLING_COST_UNAVAILABLE: The requested model is not available",
    })
    expect(r.category).toBe("upgrade_required")
    expect(r.messageKey).toBe("errors.category.upgrade_required")
  })
})
