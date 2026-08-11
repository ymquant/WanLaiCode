import { test, expect, describe } from "bun:test"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import * as ProviderTransform from "@/provider/transform"

// 会话 ID 到底有没有上到线？——直接抓最终 HTTP 请求体来判，不看中间对象。
//
// 服务端要靠会话 ID 把同一段对话的多轮请求归并到一起，读的字段名是
// `prompt_cache_key`。中间对象里键名对不对、会不会被 SDK 吃掉，光看
// hook 的出参是验不出来的，只能抓最终请求。
//
// 机制（@ai-sdk/openai-compatible 2.0.41，dist/index.js 约 540 行）：
// SDK 把 providerOptions[providerOptionsName] 里的字段**原样铺进 body**，
// 只过滤掉自身 options schema 里已有的那几个（user / reasoningEffort /
// textVerbosity / strictJsonSchema）。所以未知字段不是被丢弃，而是原样透传，
// **键名一个字符都不会被改写**——写 promptCacheKey 出去就是 promptCacheKey，
// 服务端读的 prompt_cache_key 因此永远拿不到值。

const SESSION_ID = "ses_wire_test_123"
const PROVIDER_ID = "wanlaicode"

function sseStream() {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder()
      controller.enqueue(
        enc.encode(
          'data: {"id":"c","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n',
        ),
      )
      controller.enqueue(enc.encode("data: [DONE]\n\n"))
      controller.close()
    },
  })
}

/** 发一次真实请求，抓下最终的 header 与 body。 */
async function capture(opts: { options?: Record<string, any>; headers?: Record<string, string> }) {
  const captured: { headers: Record<string, string>; body: any } = { headers: {}, body: undefined }

  const provider = createOpenAICompatible({
    name: PROVIDER_ID,
    baseURL: "http://localhost/v1",
    fetch: (async (_url: string, init: RequestInit) => {
      for (const [k, v] of new Headers(init.headers as HeadersInit).entries()) {
        captured.headers[k.toLowerCase()] = v
      }
      captured.body = JSON.parse(String(init.body))
      return new Response(sseStream(), { status: 200, headers: { "content-type": "text/event-stream" } })
    }) as unknown as typeof globalThis.fetch,
  })

  // 命名空间按生产路径推导，而不是手写字面量——
  // 写死的话，哪天 providerOptions() 改了推导规则这条测试也发现不了。
  const model = { api: { npm: "@ai-sdk/openai-compatible", id: "gpt-5.5" }, providerID: PROVIDER_ID } as any
  const providerOptions = opts.options ? ProviderTransform.providerOptions(model, opts.options) : undefined

  const result = await provider.chatModel("gpt-5.5").doStream({
    prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    ...(providerOptions ? { providerOptions } : {}),
    ...(opts.headers ? { headers: opts.headers } : {}),
  } as any)

  const reader = result.stream.getReader()
  while (!(await reader.read()).done) {
    /* 读空，确保请求确实发出 */
  }
  return captured
}

describe("会话 ID 必须真的出现在请求体里", () => {
  // 这是本 PR 的目标：服务端读 prompt_cache_key，就必须原样写这个键名。
  test("prompt_cache_key 原样进入请求体", async () => {
    const captured = await capture({ options: { prompt_cache_key: SESSION_ID } })

    expect(captured.body["prompt_cache_key"]).toBe(SESSION_ID)
  })

  // 反向证据：驼峰写法出去还是驼峰，服务端读不到。
  // 保留这条是因为 transform.ts 里有一行现成的 promptCacheKey 赋值，
  // 容易让人以为照抄就行——照抄的结果是静默失效。
  test("promptCacheKey 驼峰写法到不了 prompt_cache_key", async () => {
    const captured = await capture({ options: { promptCacheKey: SESSION_ID } })

    expect(captured.body["prompt_cache_key"]).toBeUndefined()
    expect(captured.body["promptCacheKey"]).toBe(SESSION_ID)
  })

  // SDK 自身 options schema 里已有的键会被它解析掉、不走原样透传，
  // 所以不能借道那几个键名（user / reasoningEffort / textVerbosity /
  // strictJsonSchema）来夹带会话 ID。
  test("schema 内的键不会原样透传", async () => {
    const captured = await capture({ options: { textVerbosity: "low" } })

    expect(captured.body["textVerbosity"]).toBeUndefined()
    expect(captured.body["verbosity"]).toBe("low")
  })
})
