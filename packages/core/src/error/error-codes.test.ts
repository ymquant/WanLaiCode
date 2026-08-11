import { expect, test, describe } from "bun:test"
import { classifyError, REASON_TO_CATEGORY, type ErrorCategory } from "./error-codes"
import contract from "./error-codes.json"

describe("REASON_TO_CATEGORY", () => {
  test("covers every reason in the contract snapshot", () => {
    for (const e of contract.entries) {
      expect(REASON_TO_CATEGORY[e.reason]).toBe(e.category as ErrorCategory)
    }
  })
})

describe("classifyError", () => {
  test("reads reason first", () => {
    expect(classifyError({ reason: "TOKEN_EXPIRED" }).category).toBe("auth_expired")
    expect(classifyError({ reason: "SUBSCRIPTION_EXPIRED" }).category).toBe("subscription_expired")
    expect(classifyError({ reason: "USER_PLATFORM_DAILY_QUOTA_EXHAUSTED" }).category).toBe("quota_exhausted")
    expect(classifyError({ reason: "MODEL_NOT_AVAILABLE_FOR_SOFTWARE_PACKAGE" }).category).toBe("upgrade_required")
    expect(classifyError({ reason: "software_oauth_refresh_token_invalid" }).category).toBe("auth_expired")
  })
  test("reads gateway error.code and responses sub_code", () => {
    expect(classifyError({ errorCode: "API_KEY_RATE_5H_EXCEEDED" }).category).toBe("quota_exhausted")
    expect(classifyError({ subCode: "USER_PLATFORM_WEEKLY_QUOTA_EXHAUSTED" }).category).toBe("quota_exhausted")
  })
  test("reads OpenAI-compatible lowercase image error types", () => {
    expect(classifyError({ reason: "upstream_error" }).category).toBe("upstream_error")
    expect(classifyError({ reason: "service_unavailable" }).category).toBe("service_unavailable")
    expect(classifyError({ reason: "rate_limit_exceeded" }).category).toBe("rate_limited")
    expect(classifyError({ reason: "invalid_request_error" }).category).toBe("invalid_request")
  })
  // 问题一：无 reason 码时启发式兜底默认关闭，避免把自配 provider 的 401/429/quota 误判成万来 category。
  test("no reason + no trustHeuristics → unknown (does not guess)", () => {
    expect(classifyError({ httpStatus: 401 }).category).toBe("unknown")
    expect(classifyError({ httpStatus: 429 }).category).toBe("unknown")
    expect(classifyError({ httpStatus: 503 }).category).toBe("unknown")
    expect(classifyError({ message: "invalid software oauth refresh token" }).category).toBe("unknown")
    expect(classifyError({ message: "you exceeded your quota" }).category).toBe("unknown")
  })
  // 调用点担保万来来源（trustHeuristics）时，无 reason 也退 HTTP status / 文本兜底。
  test("no reason + trustHeuristics → status/text fallback", () => {
    expect(classifyError({ httpStatus: 401, trustHeuristics: true }).category).toBe("auth_invalid")
    expect(classifyError({ httpStatus: 429, trustHeuristics: true }).category).toBe("rate_limited")
    expect(classifyError({ httpStatus: 503, trustHeuristics: true }).category).toBe("service_unavailable")
    expect(classifyError({ httpStatus: 502, trustHeuristics: true }).category).toBe("upstream_error")
    expect(classifyError({ httpStatus: 400, trustHeuristics: true }).category).toBe("invalid_request")
    expect(classifyError({ message: "invalid software oauth refresh token", trustHeuristics: true }).category).toBe("unknown")
    expect(classifyError({ message: "you exceeded your quota", trustHeuristics: true }).category).toBe("unknown")
    expect(classifyError({ message: "WanlaiCode OAuth authorization expired", trustHeuristics: true }).category).toBe(
      "auth_expired",
    )
    expect(classifyError({ message: "OAuth login is required", trustHeuristics: true }).category).toBe("auth_invalid")
    expect(classifyError({ message: "totally unrecognized", trustHeuristics: true }).category).toBe("unknown")
    expect(classifyError({ trustHeuristics: true }).category).toBe("unknown")
    expect(classifyError({}).category).toBe("unknown")
  })
  // 问题二：有 reason 但未识别（契约漂移期）→ 退 HTTP status 兜底（reason 已证明后端来源，无条件安全），并透传 reason。
  test("unrecognized reason → falls back to status (drift safety), keeps reason", () => {
    const r = classifyError({ reason: "NOT_A_REAL_CODE", httpStatus: 429 })
    expect(r.category).toBe("rate_limited")
    expect(r.reason).toBe("NOT_A_REAL_CODE")
  })
  test("unrecognized reason without status → unknown but keeps reason", () => {
    const r = classifyError({ reason: "NOT_A_REAL_CODE" })
    expect(r.category).toBe("unknown")
    expect(r.reason).toBe("NOT_A_REAL_CODE")
  })
})
