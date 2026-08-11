import { describe, expect, test } from "bun:test"
import { gatewayReasonFromBody } from "./gateway-reason"

describe("gatewayReasonFromBody", () => {
  test("提取契约内唯一小写码 api_key_in_query_deprecated（嵌套 error.code）", () => {
    expect(gatewayReasonFromBody({ error: { code: "api_key_in_query_deprecated", message: "x" } })).toBe(
      "api_key_in_query_deprecated",
    )
  })

  test("提取契约内小写码（鉴权中间件裸顶层 code）", () => {
    expect(gatewayReasonFromBody({ code: "api_key_in_query_deprecated", message: "x" })).toBe(
      "api_key_in_query_deprecated",
    )
  })

  test("提取契约内大写码（嵌套 error.code）", () => {
    expect(gatewayReasonFromBody({ type: "error", error: { type: "rate_limit_exceeded", code: "API_KEY_RATE_5H_EXCEEDED" } })).toBe(
      "API_KEY_RATE_5H_EXCEEDED",
    )
  })

  test("sub_code 优先于 code", () => {
    expect(gatewayReasonFromBody({ error: { code: "rate_limit_exceeded", sub_code: "USER_PLATFORM_DAILY_QUOTA_EXHAUSTED" } })).toBe(
      "USER_PLATFORM_DAILY_QUOTA_EXHAUSTED",
    )
  })

  test("拒绝原型链继承属性名（in 判定漏洞）", () => {
    expect(gatewayReasonFromBody({ error: { code: "toString" } })).toBeUndefined()
    expect(gatewayReasonFromBody({ code: "hasOwnProperty" })).toBeUndefined()
    expect(gatewayReasonFromBody({ reason: "constructor" })).toBeUndefined()
  })

  test("拒绝契约外的 sub_code", () => {
    expect(gatewayReasonFromBody({ error: { sub_code: "NOT_A_REAL_CODE" } })).toBeUndefined()
    expect(gatewayReasonFromBody({ error: { sub_code: "toString" } })).toBeUndefined()
  })

  test("拒绝契约外的 OpenAI 风格小写码", () => {
    expect(gatewayReasonFromBody({ error: { code: "invalid_request_error", message: "x" } })).toBeUndefined()
    expect(gatewayReasonFromBody({ code: "rate_limit_exceeded" })).toBeUndefined()
  })

  test("拒绝契约外的大写码（不再靠大小写正则放行）", () => {
    expect(gatewayReasonFromBody({ error: { code: "SOME_UNKNOWN_UPPER_CODE" } })).toBeUndefined()
    expect(gatewayReasonFromBody({ code: "SOME_UNKNOWN_UPPER_CODE" })).toBeUndefined()
    expect(gatewayReasonFromBody({ reason: "SOME_UNKNOWN_UPPER_CODE" })).toBeUndefined()
  })

  test("提取契约内顶层 reason", () => {
    expect(gatewayReasonFromBody({ reason: "NO_PLAN_NO_BALANCE" })).toBe("NO_PLAN_NO_BALANCE")
  })

  test("非对象/无码输入返回 undefined", () => {
    expect(gatewayReasonFromBody(undefined)).toBeUndefined()
    expect(gatewayReasonFromBody({ error: { type: "x", message: "y" } })).toBeUndefined()
  })
})
