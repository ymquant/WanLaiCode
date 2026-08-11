import { expect, test } from "bun:test"
import { WanlaiCodeAuthPlugin } from "@/plugin/wanlaicode"

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

function makeHookInput(overrides: { providerID?: string; sessionID?: string } = {}) {
  return {
    sessionID: overrides.sessionID ?? "ses_abc123",
    agent: "a",
    provider: {} as never,
    message: {} as never,
    model: {
      providerID: overrides.providerID ?? "wanlaicode",
      api: { id: "gpt-5.5", url: "", npm: "@ai-sdk/openai" },
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
  return { temperature: 0, topP: 1, topK: 0, maxOutputTokens: 32_000 as number | undefined, options: {} as Record<string, any> }
}

// 会话 ID 必须随请求上报，服务端据此把同一会话的多轮请求归并到一起。
//
// 不带的话服务端只能拿请求内容的哈希去猜会话边界，而那是启发式的：开场
// 一字不差的两个会话分不开、上下文压缩后前缀断裂、回退分叉会把两条支线
// 并成一条。服务端实测这个 provider 的会话 100% 没带会话 ID。
test("reports sessionID as prompt_cache_key for wanlaicode", async () => {
  const hooks = await WanlaiCodeAuthPlugin(pluginInput)
  const out = makeHookOutput()

  await hooks["chat.params"]!(makeHookInput({ sessionID: "ses_xyz789" }), out)

  expect(out.options["prompt_cache_key"]).toBe("ses_xyz789")
})

// 同一会话内必须稳定：变了就等于把一段对话截成两条。
test("keeps prompt_cache_key stable across turns of the same session", async () => {
  const hooks = await WanlaiCodeAuthPlugin(pluginInput)

  const first = makeHookOutput()
  const second = makeHookOutput()
  await hooks["chat.params"]!(makeHookInput({ sessionID: "ses_same" }), first)
  await hooks["chat.params"]!(makeHookInput({ sessionID: "ses_same" }), second)

  // 断言具体值而不是两者相等：都为 undefined 时「相等」也成立，
  // 那样这条守卫在字段压根没被设置时反而是绿的。
  expect(first.options["prompt_cache_key"]).toBe("ses_same")
  expect(second.options["prompt_cache_key"]).toBe("ses_same")
})

// 不同会话不得撞车：服务端按 (user_id, session_id) 建唯一约束，
// 撞了会让两段无关对话被并成一条，而暂存原文是覆盖式的，先写的会被静默覆盖。
test("uses a distinct prompt_cache_key per session", async () => {
  const hooks = await WanlaiCodeAuthPlugin(pluginInput)

  const a = makeHookOutput()
  const b = makeHookOutput()
  await hooks["chat.params"]!(makeHookInput({ sessionID: "ses_a" }), a)
  await hooks["chat.params"]!(makeHookInput({ sessionID: "ses_b" }), b)

  expect(a.options["prompt_cache_key"]).not.toBe(b.options["prompt_cache_key"])
})

// 别的 provider 不归这个插件管，一个字段都不该动。
test("leaves other providers untouched", async () => {
  const hooks = await WanlaiCodeAuthPlugin(pluginInput)
  const out = makeHookOutput()

  await hooks["chat.params"]!(makeHookInput({ providerID: "openai" }), out)

  expect(out.options["prompt_cache_key"]).toBeUndefined()
  expect(out.maxOutputTokens).toBe(32_000)
})

// 既有行为不能被带坏：上游部分模型不接受 max_output_tokens。
test("still clears maxOutputTokens for wanlaicode", async () => {
  const hooks = await WanlaiCodeAuthPlugin(pluginInput)
  const out = makeHookOutput()

  await hooks["chat.params"]!(makeHookInput(), out)

  expect(out.maxOutputTokens).toBeUndefined()
})
