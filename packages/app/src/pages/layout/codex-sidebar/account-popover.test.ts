import { describe, expect, test } from "bun:test"
import type { UserCenterStatus } from "@/pages/users/types"
import { accountPopoverState, authenticatedAccountStatus, isLatestAccountStatusRequest } from "./account-status"

function status(authenticated: boolean): UserCenterStatus {
  return {
    authenticated,
    auth_type: authenticated ? "oauth" : undefined,
    requires_oauth: !authenticated,
    // fixture 默认模拟普通未登录；失效 OAuth 的独立状态由远控投影测试覆盖。
    oauth_reauth_required: false,
    product_code: "wanlaicode",
    api_base: "https://api.example.com",
    codex_base_url: "https://api.example.com",
    site_url: "https://example.com",
    purchase_url: "https://example.com/plus",
    account_email: "cached@example.com",
    account_name: "缓存账号",
  }
}

describe("account popover auth projection", () => {
  test("授权失效后不再把缓存账号资料投影成已登录", () => {
    // 后端或 createResource.latest 仍带旧资料时，认证布尔值必须是展示账号菜单的唯一边界。
    expect(authenticatedAccountStatus(status(false))).toBeUndefined()
  })

  test("有效授权继续展示当前账号资料", () => {
    // 正常 OAuth 登录仍保留原账号菜单，避免修复失效态时影响有效用户。
    expect(authenticatedAccountStatus(status(true))?.account_email).toBe("cached@example.com")
  })

  test("加载、请求失败、普通未登录和授权失效使用不同展示状态", () => {
    // auth.expired 事件必须立即压过 createResource.latest，不能等状态请求完成后才隐藏旧账号。
    expect(accountPopoverState(undefined, true, false)).toBe("loading")
    expect(accountPopoverState(status(true), false, true)).toBe("error")
    expect(accountPopoverState(status(false), false, false)).toBe("signed_out")
    expect(accountPopoverState(status(true), true, false, true)).toBe("reauth_required")
    expect(accountPopoverState(status(true), false, false)).toBe("authenticated")
  })

  test("旧账号状态请求不能解除新登录建立的认证边界", () => {
    // 只有最后一代请求可以更新 authBoundary，避免旧响应把失效账号重新显示为已登录。
    expect(isLatestAccountStatusRequest(1, 2)).toBe(false)
    expect(isLatestAccountStatusRequest(2, 2)).toBe(true)
  })
})
