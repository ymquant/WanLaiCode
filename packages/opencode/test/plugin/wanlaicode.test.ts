import { expect, test } from "bun:test"
import { oauthCallbackResult, WanlaiCodeAuthPlugin } from "@/plugin/wanlaicode"

const pluginInput = {
  client: {} as never,
  project: {} as never,
  directory: "",
  worktree: "",
  experimental_workspace: {
    register() {},
  },
  serverUrl: new URL("https://example.com"),
  $: {} as never,
}

function makeHookInput(providerID = "wanlaicode") {
  return {
    sessionID: "s",
    agent: "a",
    provider: {} as never,
    message: {} as never,
    model: {
      providerID,
      api: { id: "gpt-5", url: "", npm: "@ai-sdk/openai-compatible" },
      capabilities: {
        reasoning: true,
        temperature: false,
        attachment: true,
        toolcall: true,
        input: { text: true, audio: false, image: false, video: false, pdf: false },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
        interleaved: false,
      },
    } as never,
  }
}

function makeHookOutput() {
  return { temperature: 0, topP: 1, topK: 0, maxOutputTokens: 32_000 as number | undefined, options: {} }
}

test("omits maxOutputTokens for wanlaicode models", async () => {
  const hooks = await WanlaiCodeAuthPlugin(pluginInput)
  const out = makeHookOutput()
  await hooks["chat.params"]!(makeHookInput(), out)
  expect(out.maxOutputTokens).toBeUndefined()
})

test("keeps maxOutputTokens for non-wanlaicode models", async () => {
  const hooks = await WanlaiCodeAuthPlugin(pluginInput)
  const out = makeHookOutput()
  await hooks["chat.params"]!(makeHookInput("openai"), out)
  expect(out.maxOutputTokens).toBe(32_000)
})

test("OAuth callback keeps the software token when no inference key is available", () => {
  // 没有套餐时 runtime key 可以为空，但手机远控依赖的 OAuth access token 必须随登录结果保存。
  const result = oauthCallbackResult({
    tokens: { access_token: "software-jwt", refresh_token: "refresh-2", expires_in: 7200 },
    profile: { account: { uuid: "acct-1", email: "user@example.com", display_name: "测试用户" } },
    runtimeKey: "",
    now: 1_000_000,
  })

  expect(result).toMatchObject({
    type: "success",
    provider: "wanlaicode",
    refresh: "refresh-2",
    access: "",
    softwareToken: "software-jwt",
    expires: 8200,
    accountId: "acct-1",
    accountEmail: "user@example.com",
    accountName: "测试用户",
  })
})

test("OAuth callback uses JWT exp when expires_in is missing", () => {
  const expires = 9_000
  const payload = Buffer.from(JSON.stringify({ exp: expires })).toString("base64url")

  // 桌面登录的真实 callback 入口必须尊重服务端 JWT 绝对过期时间，不能默认再延长一小时。
  const result = oauthCallbackResult({
    tokens: { access_token: `header.${payload}.signature`, refresh_token: "refresh-jwt" },
    profile: { account: { uuid: "acct-jwt" } },
    runtimeKey: "runtime-jwt",
    now: 1_000_000,
  })

  expect(result.expires).toBe(expires)
})
