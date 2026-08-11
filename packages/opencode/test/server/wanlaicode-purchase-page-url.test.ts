import { describe, expect, test } from "bun:test"
import { buildPurchasePageUrl } from "../../src/server/routes/instance/httpapi/handlers/wanlaicode-user-center"

// 购买页 URL 在保留数字 user_id（旧客户端兼容）基础上，额外透传 user_uuid。
describe("buildPurchasePageUrl", () => {
  const base = {
    purchaseUrl: "https://pay.example.com/pay",
    siteUrl: "https://wanlai.example.com",
    accessToken: "tok_123",
  }

  test("同时拼接数字 user_id 与 user_uuid", () => {
    const url = buildPurchasePageUrl({
      ...base,
      query: { user_id: 2174, user_uuid: "304a6cbc-40d1-59bf-abc2-24be7d3619bc" },
    })
    const params = new URL(url).searchParams
    expect(params.get("user_id")).toBe("2174")
    expect(params.get("user_uuid")).toBe("304a6cbc-40d1-59bf-abc2-24be7d3619bc")
  })

  // 关键兼容性：后端（auth/me）尚未返回 uuid 时，user_uuid 为空，不应拼进 URL，
  // 退化为仅传数字 user_id，旧后端/旧客户端均不受影响。
  test("uuid 缺失时不拼 user_uuid，仅保留 user_id", () => {
    const url = buildPurchasePageUrl({ ...base, query: { user_id: 2174 } })
    const params = new URL(url).searchParams
    expect(params.get("user_id")).toBe("2174")
    expect(params.has("user_uuid")).toBe(false)
  })
})
