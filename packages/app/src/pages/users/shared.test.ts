import { describe, expect, test } from "bun:test"
import {
  fetchEntitlements,
  getEntitlementsCache,
  invalidateEntitlementsCache,
  isWanlaiAuthExpiredMessage,
  selectBalanceWindows,
  unwrapSDK,
  unwrapSDKSafe,
} from "./shared"
import { resolveError } from "@opencode-ai/core/error/resolve"

describe("isWanlaiAuthExpiredMessage", () => {
  test("only treats structured OAuth refresh-token failures as expired authorization", () => {
    expect(isWanlaiAuthExpiredMessage({ reason: "SOFTWARE_OAUTH_REFRESH_TOKEN_INVALID" })).toBe(true)
    expect(isWanlaiAuthExpiredMessage({ error: "software_oauth_authorization_expired" })).toBe(true)
    expect(isWanlaiAuthExpiredMessage({ status: 401, error: "SOFTWARE_OAUTH_MISSING_AUTHORIZATION" })).toBe(false)
    expect(isWanlaiAuthExpiredMessage("software_oauth_refresh_token_invalid")).toBe(false)
  })
})

// ─── I10 端到端 reason 透传链路测试 ───────────────────────────────────────────
describe("unwrapSDK reason 透传", () => {
  test("response.error 含 data.reason 时抛出的 Error 带 reason 字段", () => {
    const response = {
      data: undefined,
      error: { name: "WanlaiCodeUserCenterError", data: { message: "订阅已过期", reason: "SUBSCRIPTION_EXPIRED" } },
    }
    let thrown: unknown
    try {
      unwrapSDK(response as any)
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error & { reason?: string }).reason).toBe("SUBSCRIPTION_EXPIRED")
  })

  test("response.error 无 reason 时抛出普通 Error(不报错)", () => {
    const response = { data: undefined, error: { name: "WanlaiCodeUserCenterError", data: { message: "unknown" } } }
    let thrown: unknown
    try {
      unwrapSDK(response as any)
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as any).reason).toBeUndefined()
  })
})

describe("unwrapSDKSafe reason 透传", () => {
  test("请求失败时返回 __errorObj 含带 reason 的 Error", async () => {
    const response = {
      data: undefined,
      error: { name: "WanlaiCodeUserCenterError", data: { message: "订阅已过期", reason: "SUBSCRIPTION_EXPIRED" } },
    }
    const result = await unwrapSDKSafe(Promise.resolve(response) as any, { items: [] })
    expect(result.__error).toBe("订阅已过期")
    expect(result.__errorObj).toBeInstanceOf(Error)
    expect((result.__errorObj as any).reason).toBe("SUBSCRIPTION_EXPIRED")
  })
})

describe("entitlements cache account generation", () => {
  test("旧账号请求晚到时不覆盖新账号缓存或清理新请求", async () => {
    invalidateEntitlementsCache()
    type Result = Awaited<ReturnType<typeof fetchEntitlements>>
    let resolveOld!: (value: Result) => void
    let resolveCurrent!: (value: Result) => void
    const oldResult = { items: [] } satisfies Result
    const currentResult = { items: [] } satisfies Result
    const old = fetchEntitlements(() => new Promise<Result>((resolve) => (resolveOld = resolve)))

    // 账号切换后启动新请求；旧请求完成只能唤醒原调用者，不能重新占用共享缓存。
    invalidateEntitlementsCache()
    const current = fetchEntitlements(() => new Promise<Result>((resolve) => (resolveCurrent = resolve)))
    resolveOld(oldResult)
    await old
    expect(getEntitlementsCache()).toBeNull()

    let unexpectedFetches = 0
    const reused = fetchEntitlements(async () => {
      unexpectedFetches += 1
      return { items: [] }
    })
    expect(reused).toBe(current)
    expect(unexpectedFetches).toBe(0)

    resolveCurrent(currentResult)
    await current
    expect(getEntitlementsCache()).toBe(currentResult)
    invalidateEntitlementsCache()
  })
})

describe("unwrapSDK → resolveError 端到端 reason 链路", () => {
  test("带 reason 的 Error → resolveError → category === subscription_expired", () => {
    const err = Object.assign(new Error("订阅已过期"), { reason: "SUBSCRIPTION_EXPIRED" })
    const r = resolveError(err)
    expect(r.category).toBe("subscription_expired")
    expect(r.action).toBe("open_purchase")
  })

  test("SDK response 含 SUBSCRIPTION_EXPIRED reason → resolveError → subscription_expired", () => {
    // 模拟 unwrapSDK 抛出的 Error
    const response = {
      data: undefined,
      error: { name: "WanlaiCodeUserCenterError", data: { message: "订阅已过期", reason: "SUBSCRIPTION_EXPIRED" } },
    }
    let thrown: unknown
    try {
      unwrapSDK(response as any)
    } catch (e) {
      thrown = e
    }
    const r = resolveError(thrown)
    expect(r.category).toBe("subscription_expired")
    expect(r.action).toBe("open_purchase")
  })

  test("reason 缺失时兜底 unknown，行为与修复前一致", () => {
    const err = new Error("some disk error")
    const r = resolveError(err)
    expect(r.category).toBe("unknown")
    expect(r.action).toBe("show_message")
  })
})

describe("sdkErrorMessage", () => {
  test("extracts nested SDK error messages", async () => {
    const { sdkErrorMessage } = await import("./shared")

    expect(sdkErrorMessage({ error: { name: "WanlaiCodeUserCenterError", data: { message: "登录已失效" } } })).toBe(
      "登录已失效",
    )
    expect(sdkErrorMessage(new Error("[object Object]", { cause: { data: { message: "购买页生成失败" } } }))).toBe(
      "购买页生成失败",
    )
  })
})

// InlineErrorState 内部逻辑：resolveError 对用户中心错误的语义分类验证。
// 测试使用契约 error-codes.json 中的真实 reason 字符串。
describe("resolveError 用户中心场景分类", () => {
  test("SOFTWARE_ENTITLEMENT_NOT_FOUND → entitlement_missing category + open_purchase action", () => {
    const r = resolveError({ reason: "SOFTWARE_ENTITLEMENT_NOT_FOUND", status: 403 })
    expect(r.category).toBe("entitlement_missing")
    expect(r.action).toBe("open_purchase")
    expect(r.messageKey).toBe("errors.category.entitlement_missing")
  })
  test("SOFTWARE_TOKEN_LIMIT_5H_EXCEEDED → quota_exhausted category + show_quota action", () => {
    const r = resolveError({ reason: "SOFTWARE_TOKEN_LIMIT_5H_EXCEEDED", status: 403 })
    expect(r.category).toBe("quota_exhausted")
    expect(r.action).toBe("show_quota")
  })
  test("SOFTWARE_OAUTH_REFRESH_TOKEN_INVALID → auth_expired category + relogin action", () => {
    const r = resolveError({ reason: "SOFTWARE_OAUTH_REFRESH_TOKEN_INVALID", status: 401 })
    expect(r.category).toBe("auth_expired")
    expect(r.action).toBe("relogin")
  })
  test("未知错误字符串(兜底) → unknown category + show_message action", () => {
    const r = resolveError("some unrelated disk error")
    expect(r.category).toBe("unknown")
    expect(r.action).toBe("show_message")
    expect(r.messageKey).toBe("errors.category.unknown")
  })
  test("SUBSCRIPTION_EXPIRED → subscription_expired category + open_purchase action", () => {
    const r = resolveError({ reason: "SUBSCRIPTION_EXPIRED", status: 403 })
    expect(r.category).toBe("subscription_expired")
    expect(r.action).toBe("open_purchase")
  })
})

describe("selectBalanceWindows", () => {
  test("总额型套餐(仅 total 有限额)只显示 total 窗口", () => {
    const usage = {
      total: { limit_tokens: 5_000_000 },
      five_hour: { limit_tokens: 0 },
      seven_day: { limit_tokens: 0 },
    }
    expect(selectBalanceWindows(usage)).toEqual(["total"])
  })

  test("滚动型套餐(5h/7d 有限额)显示 5h/7d 窗口", () => {
    const usage = {
      total: { limit_tokens: 0 },
      five_hour: { limit_tokens: 40_000_000 },
      seven_day: { limit_tokens: 200_000_000 },
    }
    expect(selectBalanceWindows(usage)).toEqual(["five_hour", "seven_day"])
  })

  test("无任何限额(loading/未配置)回退到 5h/7d", () => {
    expect(selectBalanceWindows(undefined)).toEqual(["five_hour", "seven_day"])
    expect(selectBalanceWindows({})).toEqual(["five_hour", "seven_day"])
  })

  test("includeThirtyDay:滚动型套餐含 30d 限额时一并展示 30d", () => {
    const usage = {
      total: { limit_tokens: 0 },
      five_hour: { limit_tokens: 40_000_000 },
      seven_day: { limit_tokens: 200_000_000 },
      thirty_day: { limit_tokens: 800_000_000 },
    }
    expect(selectBalanceWindows(usage, { includeThirtyDay: true })).toEqual([
      "five_hour",
      "seven_day",
      "thirty_day",
    ])
  })

  test("includeThirtyDay:总额型套餐只显示 total,不显示 30d", () => {
    const usage = {
      total: { limit_tokens: 5_000_000 },
      five_hour: { limit_tokens: 0 },
      seven_day: { limit_tokens: 0 },
      thirty_day: { limit_tokens: 0 },
    }
    expect(selectBalanceWindows(usage, { includeThirtyDay: true })).toEqual(["total"])
  })

  test("includeThirtyDay:无任何限额回退到 5h/7d/30d", () => {
    expect(selectBalanceWindows(undefined, { includeThirtyDay: true })).toEqual([
      "five_hour",
      "seven_day",
      "thirty_day",
    ])
  })

  test("includeThirtyDay:30d 无限额时不展示 30d 行", () => {
    const usage = {
      five_hour: { limit_tokens: 40_000_000 },
      seven_day: { limit_tokens: 200_000_000 },
      thirty_day: { limit_tokens: 0 },
    }
    expect(selectBalanceWindows(usage, { includeThirtyDay: true })).toEqual(["five_hour", "seven_day"])
  })
})
