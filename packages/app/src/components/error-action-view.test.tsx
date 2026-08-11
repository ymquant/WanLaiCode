import { describe, expect, test } from "bun:test"
import { resolveError } from "@opencode-ai/core/error/resolve"

// 本文件测试策略：
// 1. 逻辑层测试 —— 直接调用 resolveError 验证 category/action，
//    确认组件会拿到正确的派生值（无需 DOM 渲染）。
// 2. 源码结构测试 —— 读组件源码，断言关键渲染逻辑与 API 存在，
//    符合仓库现有测试惯例（参考 settings-environment.test.tsx 等）。

const SOURCE_PATH = new URL("./error-action-view.tsx", import.meta.url)

describe("resolveError 逻辑验证（组件数据来源）", () => {
  test("quota_exhausted 错误 → category=quota_exhausted, action=show_quota", () => {
    const err = { status: 429, reason: "USER_PLATFORM_DAILY_QUOTA_EXHAUSTED" }
    const result = resolveError(err)
    expect(result.category).toBe("quota_exhausted")
    expect(result.action).toBe("show_quota")
    expect(result.messageKey).toBe("errors.category.quota_exhausted")
  })

  test("未知错误 → category=unknown, action=show_message", () => {
    const result = resolveError(new Error("boom"))
    expect(result.category).toBe("unknown")
    expect(result.action).toBe("show_message")
    expect(result.messageKey).toBe("errors.category.unknown")
    expect(result.rawMessage).toBe("boom")
  })

  test("auth_invalid 错误 → action=show_message", () => {
    const result = resolveError({ status: 401, reason: "INVALID_TOKEN" })
    expect(result.category).toBe("auth_invalid")
    expect(result.action).toBe("show_message")
  })

  test("entitlement_missing → action=open_purchase", () => {
    const result = resolveError({ status: 403, reason: "SOFTWARE_ENTITLEMENT_NOT_FOUND" })
    expect(result.category).toBe("entitlement_missing")
    expect(result.action).toBe("open_purchase")
  })

  test("rate_limited → action=backoff_retry", () => {
    const result = resolveError({ status: 429, reason: "RATE_LIMITED" })
    expect(result.category).toBe("rate_limited")
    expect(result.action).toBe("backoff_retry")
  })

  test("account_disabled → action=show_blocked", () => {
    const result = resolveError({ status: 403, reason: "USER_BANNED" })
    expect(result.category).toBe("account_disabled")
    expect(result.action).toBe("show_blocked")
  })
})

describe("ErrorActionView 组件源码结构", () => {
  test("从 resolveError 解析错误并用 messageKey 查 i18n", async () => {
    const source = await Bun.file(SOURCE_PATH).text()

    expect(source).toContain('from "@opencode-ai/core/error/resolve"')
    expect(source).toContain("resolveError(props.error)")
    expect(source).toContain("resolved().messageKey")
    expect(source).toContain("language.t(")
  })

  test("按钮仅在 ACTION_BUTTON_SET 内的 action 时渲染", async () => {
    const source = await Bun.file(SOURCE_PATH).text()

    // ACTION_BUTTON_SET 收录了 5 个行为按钮 action
    expect(source).toContain('"relogin"')
    expect(source).toContain('"open_purchase"')
    expect(source).toContain('"show_quota"')
    expect(source).toContain('"backoff_retry"')
    expect(source).toContain('"show_blocked"')

    // show_message 不在按钮集合内
    expect(source).not.toContain('"show_message"')

    // 条件渲染门控
    expect(source).toContain("showButton()")
  })

  test("按钮点击调用 onAction 回调并传入当前 action", async () => {
    const source = await Bun.file(SOURCE_PATH).text()

    expect(source).toContain("props.onAction?.(resolved().action)")
  })

  test("按钮文案从 errors.action.<action> i18n 键取", async () => {
    const source = await Bun.file(SOURCE_PATH).text()

    expect(source).toContain('"errors.action." + resolved().action')
  })

  test("rawMessage 展示：有值时作为 description 附带展示，防重复", async () => {
    const source = await Bun.file(SOURCE_PATH).text()

    expect(source).toContain("rawMessage")
    expect(source).toContain("description()")
  })

  test("复用 SettingsRow 展示外观（与 InlineState 同源），保持视觉统一", async () => {
    const source = await Bun.file(SOURCE_PATH).text()

    expect(source).toContain('from "@/pages/users/shared"')
    expect(source).toContain("<SettingsRow")
    expect(source).toContain('name="warning"')
  })

  test("使用 Button 组件 variant=secondary", async () => {
    const source = await Bun.file(SOURCE_PATH).text()

    expect(source).toContain('from "@opencode-ai/ui/button"')
    expect(source).toContain('<Button')
    expect(source).toContain('variant="secondary"')
  })

  test("导出函数 ErrorActionView，接收 error 和可选 onAction props", async () => {
    const source = await Bun.file(SOURCE_PATH).text()

    expect(source).toContain("export function ErrorActionView")
    expect(source).toContain("props: { error: unknown")
    expect(source).toContain("onAction?: (action: ErrorAction) => void")
  })

  test("使用 createMemo 保持响应式", async () => {
    const source = await Bun.file(SOURCE_PATH).text()

    expect(source).toContain("createMemo")
    expect(source).toContain("resolveError(props.error)")
  })
})
