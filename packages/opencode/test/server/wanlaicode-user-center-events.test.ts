import { beforeEach, describe, expect, test } from "bun:test"
import * as WanlaiCodeAuth from "../../src/provider/wanlaicode"
import { WanlaiCodeRefreshCoordinator } from "../../src/provider/wanlaicode-refresh-coordinator"
import {
  invalidateCredentialForBackendEvent,
  isAuthFailure,
  refreshAccessToken,
  resourcesFromBackendEvent,
} from "../../src/server/wanlaicode-user-center-events"

describe("WanlaiCode user center events", () => {
  beforeEach(() => WanlaiCodeRefreshCoordinator.resetForTest())

  test("maps model change event type to provider refresh resources", () => {
    expect(resourcesFromBackendEvent({ type: "software.models.changed" })).toEqual(["models", "providers"])
  })

  test("keeps explicit backend resources", () => {
    expect(resourcesFromBackendEvent({ type: "software.status.changed", resources: ["entitlements"] })).toEqual([
      "entitlements",
    ])
  })

  test("normalizes explicit backend resources", () => {
    expect(
      resourcesFromBackendEvent({ type: "software.status.changed", resources: [" Models ", "PROVIDERS", ""] }),
    ).toEqual(["models", "providers"])
  })

  test("maps entitlement and api key event types to provider refresh resources", () => {
    expect(resourcesFromBackendEvent({ type: "software.entitlements.changed" })).toEqual(["status", "entitlements"])
    expect(resourcesFromBackendEvent({ type: "software.api_key.changed" })).toEqual(["status", "api_key"])
  })

  test("software.auth.expired 会标记建立事件 socket 时使用的凭据", () => {
    const credential = {
      type: "oauth" as const,
      access: "sk-old",
      refresh: "R0",
      softwareToken: "jwt-old",
      expires: 100,
    }

    // 迟到事件传入的是 socket 捕获值，调用方不会重读并误伤同时完成的新登录。
    expect(invalidateCredentialForBackendEvent({ type: "software.auth.expired" }, credential)).toBe(true)
    expect(WanlaiCodeRefreshCoordinator.isCredentialInvalid(credential)).toBe(true)
  })

  test("旧 socket 的过期事件不会广播到新登录 revision", () => {
    const stale = {
      type: "oauth" as const,
      access: "sk-old",
      refresh: "R0",
      softwareToken: "jwt-old",
      expires: 100,
    }
    const current = { ...stale, access: "sk-new", refresh: "R1", softwareToken: "jwt-new", expires: 200 }

    // 迟到事件仍需永久标记旧 revision，但当前 Auth 已切换时调用方不得广播 UserCenterAuthExpired。
    expect(invalidateCredentialForBackendEvent({ type: "software.auth.expired" }, stale, current)).toBe(false)
    expect(WanlaiCodeRefreshCoordinator.isCredentialInvalid(stale)).toBe(true)
    expect(WanlaiCodeRefreshCoordinator.isCredentialInvalid(current)).toBe(false)
  })

  test("已撤权凭据不能复用未过期 JWT 重连事件 socket", async () => {
    const credential = {
      type: "oauth" as const,
      access: "sk-revoked",
      refresh: "R-revoked",
      softwareToken: "jwt-revoked",
      expires: Math.floor(Date.now() / 1000) + 3600,
    }
    WanlaiCodeRefreshCoordinator.markCredentialInvalid(credential)

    // 即使 JWT 的本地时间尚未到期，明确撤权结论也必须优先，禁止 socket close 后再次连接。
    await expect(
      refreshAccessToken({
        credential,
        runtimeKey: credential.access,
        softwareToken: credential.softwareToken,
        refreshToken: credential.refresh,
        accountId: undefined,
        accountEmail: undefined,
        accountName: undefined,
        siteUrl: undefined,
        expiresIn: 3600,
        apiBase: undefined,
      }),
    ).rejects.toBeInstanceOf(WanlaiCodeAuth.OAuthExpiredError)
  })

  test("只有明确 OAuth 过期或结构化 refresh-token 失效才发送过期事件", () => {
    // 协调器已经确认当前凭据代次失效时，事件服务必须通知桌面与手机重新登录。
    expect(isAuthFailure(new WanlaiCodeAuth.OAuthExpiredError())).toBe(true)

    // token 端点的结构化 reason 是唯一允许直接从刷新响应判定失效的原始错误。
    expect(
      isAuthFailure(
        new WanlaiCodeAuth.OAuthRefreshError({
          status: 401,
          reason: "software_oauth_refresh_token_invalid",
          body: JSON.stringify({ reason: "software_oauth_refresh_token_invalid" }),
        }),
      ),
    ).toBe(true)
  })

  test.each([401, 403])("profile 普通 %d 不发送过期事件", (status) => {
    // profile 授权失败可能来自权限配置或后端过渡态，缺少 refresh-token reason 时不能清空登录态。
    expect(isAuthFailure(new Error(`WanlaiCode OAuth profile request failed: ${status} Unauthorized`))).toBe(false)
  })

  test("refresh 5xx 即使带失效 reason 也不发送过期事件", () => {
    // 服务端故障可能复用业务错误体；状态不是 token 端点确认的 401 时仍应走重试路径。
    const error = new WanlaiCodeAuth.OAuthRefreshError({
      status: 503,
      reason: "software_oauth_refresh_token_invalid",
      body: JSON.stringify({ reason: "software_oauth_refresh_token_invalid" }),
    })
    expect(isAuthFailure(error)).toBe(false)
  })

  test("refresh 网络错误不发送过期事件", () => {
    // 网络断开只影响本次刷新请求，错误文本即使提到 token 也不能被正则误判为凭据撤销。
    expect(isAuthFailure(new Error("WanlaiCode OAuth token refresh failed: fetch ECONNRESET"))).toBe(false)
  })
})
