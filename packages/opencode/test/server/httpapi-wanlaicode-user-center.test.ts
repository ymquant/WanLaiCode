import { afterEach, describe, expect, test } from "bun:test"
import { WanlaiCodeAuth } from "../../src/provider/wanlaicode"
import { WanlaiCodeRefreshCoordinator } from "../../src/provider/wanlaicode-refresh-coordinator"
import { ExperimentalHttpApiServer } from "../../src/server/routes/instance/httpapi/server"
import { WanlaiCodeUserCenterPaths } from "../../src/server/routes/instance/httpapi/groups/wanlaicode-user-center"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

const originalFetch = globalThis.fetch
const originalAuthContent = process.env.WANLAICODE_AUTH_CONTENT
const originalLegacyAuthContent = process.env.OPENCODE_AUTH_CONTENT

function restoreEnvironment(name: "WANLAICODE_AUTH_CONTENT" | "OPENCODE_AUTH_CONTENT", value: string | undefined) {
  if (value === undefined) {
    delete process.env[name]
    return
  }
  process.env[name] = value
}

function request(path: string, directory: string) {
  return ExperimentalHttpApiServer.webHandler().handler(
    new Request(`http://localhost${path}`, {
      headers: { "x-opencode-directory": directory },
    }),
    ExperimentalHttpApiServer.context,
  )
}

afterEach(async () => {
  // 测试会替换进程级认证与网络入口，结束后必须完整恢复，避免影响同进程的其它服务用例。
  restoreEnvironment("WANLAICODE_AUTH_CONTENT", originalAuthContent)
  restoreEnvironment("OPENCODE_AUTH_CONTENT", originalLegacyAuthContent)
  WanlaiCodeAuth.setFetchWithoutProxyForTesting(undefined)
  // coordinator 保存进程级 single-flight、shared 与 invalid revision；端点测试结束必须同步复位。
  WanlaiCodeRefreshCoordinator.resetForTest()
  globalThis.fetch = originalFetch
  await disposeAllInstances()
  await resetDatabase()
})

describe("WanlaiCode user center HttpApi", () => {
  test("status 端点区分有效 OAuth 与需要重新认证的失效 OAuth", async () => {
    // 测试起点显式清空上一个用例可能留下的失效代次，保证首次 callback 凭据按新登录处理。
    WanlaiCodeRefreshCoordinator.resetForTest()
    await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })
    let rejectRefresh = false
    let rejectedRefreshAttempts = 0

    // 用户中心同时包含直连 OAuth 请求和代理感知的业务请求；两条入口都固定在本地假响应中，
    // 让测试只验证认证状态投影，不依赖开发机正在运行的后端或系统代理。
    const fakeFetch = Object.assign(
      async (input: string | URL | Request) => {
        const url = new URL(input instanceof Request ? input.url : input.toString())
        if (url.pathname === "/v1/oauth/token" && rejectRefresh) {
          rejectedRefreshAttempts++
          return Response.json({ error: "invalid_grant" }, { status: 401 })
        }
        if (url.pathname === "/api/v1/settings/public") {
          return Response.json({ data: { purchase_subscription_url: "https://pay.example.com/pay" } })
        }
        if (url.pathname === "/api/v1/auth/me") {
          return Response.json({ code: 0, data: { email: "user@example.com", username: "测试账号" } })
        }
        if (url.pathname === "/api/wanlaicode_profile") {
          return Response.json({ reason: "SOFTWARE_OAUTH_REFRESH_TOKEN_INVALID" }, { status: 401 })
        }
        return Response.json({ code: 0, data: { items: [] } })
      },
      { preconnect: originalFetch.preconnect },
    ) as typeof globalThis.fetch
    WanlaiCodeAuth.setFetchWithoutProxyForTesting(fakeFetch)
    globalThis.fetch = fakeFetch

    // 新登录凭据带有未过期的软件 JWT；状态端点必须直接确认登录并返回账号资料。
    process.env.WANLAICODE_AUTH_CONTENT = JSON.stringify({
      wanlaicode: {
        type: "oauth",
        access: "sk-valid",
        softwareToken: "jwt-valid",
        refresh: "refresh-valid-status-test",
        expires: Math.floor(Date.now() / 1000) + 3600,
        accountId: "acct_123",
        accountEmail: "user@example.com",
        accountName: "测试账号",
      },
    })
    delete process.env.OPENCODE_AUTH_CONTENT

    const valid = await request(WanlaiCodeUserCenterPaths.status, tmp.path)
    expect(valid.status).toBe(200)
    expect(await valid.json()).toMatchObject({
      authenticated: true,
      auth_type: "oauth",
      requires_oauth: false,
      oauth_reauth_required: false,
      account_id: "acct_123",
      account_email: "user@example.com",
      account_name: "测试账号",
    })

    // 先通过受保护端点触发一次真实 refresh 失败，使 handler 记录该认证代次已经失效；
    // 随后的 status 响应必须撤销登录态，并明确告诉桌面与手机端需要重新认证。
    process.env.WANLAICODE_AUTH_CONTENT = JSON.stringify({
      wanlaicode: {
        type: "oauth",
        access: "sk-stale",
        softwareToken: "jwt-stale",
        refresh: "refresh-invalid-status-test",
        expires: 0,
        accountId: "acct_stale",
        accountEmail: "stale@example.com",
        accountName: "陈旧账号",
      },
    })
    rejectRefresh = true
    await request(WanlaiCodeUserCenterPaths.entitlements, tmp.path)
    // 受保护端点必须通过全局协调器触发一次 token exchange，并由协调器登记当前 revision 失效。
    expect(rejectedRefreshAttempts).toBe(1)

    const invalid = await request(WanlaiCodeUserCenterPaths.status, tmp.path)
    expect(invalid.status).toBe(200)
    const invalidBody = await invalid.json()
    expect(invalidBody).toMatchObject({
      authenticated: false,
      requires_oauth: true,
      oauth_reauth_required: true,
    })
    expect(invalidBody).not.toHaveProperty("account_id")
    expect(invalidBody).not.toHaveProperty("account_email")
    expect(invalidBody).not.toHaveProperty("account_name")
  }, 30_000)
})
