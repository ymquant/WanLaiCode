import { OpenAIResponsesLanguageModel } from "@/provider/sdk/copilot/responses/openai-responses-language-model"
import { convertToOpenAIResponsesInput } from "@/provider/sdk/copilot/responses/convert-to-openai-responses-input"
import { MessageV2 } from "@/session/message-v2"
import { SessionRetry } from "@/session/retry"
import { ProviderID } from "@/provider/schema"
import type { LanguageModelV3Prompt } from "@ai-sdk/provider"
import { describe, test, expect, mock } from "bun:test"

async function convertReadableStreamToArray<T>(stream: ReadableStream<T>): Promise<T[]> {
  const reader = stream.getReader()
  const result: T[] = []
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    result.push(value)
  }
  return result
}

const TEST_PROMPT: LanguageModelV3Prompt = [{ role: "user", content: [{ type: "text", text: "Hello" }] }]

// 上游在已出内容后掐断时,网关如实转发 response.failed(见 aitoken_go 网关
// openAIResponsesFailedSSEPayload)。客户端必须把它当作「流中断」交给 processor 的重试门控,
// 而不是静默丢弃(否则回合无声结束)。门控再按「是否已出内容」决定重试自愈还是标红。
const FAILED_AFTER_CONTENT = [
  `data: {"type":"response.created","response":{"id":"resp_1"}}`,
  `data: {"type":"response.output_text.delta","item_id":"msg_1","delta":"Partial"}`,
  `data: {"type":"response.failed","response":{"id":"resp_1","status":"failed","error":{"code":"upstream_error","message":"unexpected EOF"}}}`,
]

const PHASE_CORRECTION_MESSAGE = [
  `data: {"type":"response.created","response":{"id":"resp_1","created_at":1,"model":"gpt-5.5","service_tier":null}}`,
  `data: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"msg_1","phase":"commentary"}}`,
  `data: {"type":"response.output_text.delta","item_id":"msg_1","delta":"Checking","logprobs":null}`,
  `data: {"type":"response.output_item.done","output_index":0,"item":{"type":"message","id":"msg_done","phase":"final_answer"}}`,
  `data: {"type":"response.completed","response":{"incomplete_details":null,"service_tier":null,"usage":{"input_tokens":1,"input_tokens_details":{"cached_tokens":0},"output_tokens":1,"output_tokens_details":{"reasoning_tokens":0}}}}`,
]

const COMMENTARY_NULL_DONE_MESSAGE = [
  `data: {"type":"response.created","response":{"id":"resp_1","created_at":1,"model":"gpt-5.5","service_tier":null}}`,
  `data: {"type":"response.output_item.added","output_index":7,"item":{"type":"message","id":"msg_1","phase":"commentary"}}`,
  `data: {"type":"response.output_text.delta","item_id":"msg_1","delta":"Checking","logprobs":null}`,
  `data: {"type":"response.output_item.done","output_index":7,"item":{"type":"message","id":"msg_1","phase":null}}`,
  `data: {"type":"response.completed","response":{"incomplete_details":null,"service_tier":null,"usage":{"input_tokens":1,"input_tokens_details":{"cached_tokens":0},"output_tokens":1,"output_tokens_details":{"reasoning_tokens":0}}}}`,
]

const NON_STREAM_COMMENTARY_RESPONSE = {
  id: "resp_1",
  created_at: 1,
  error: null,
  model: "gpt-5.5",
  output: [
    {
      type: "message",
      role: "assistant",
      id: "msg_1",
      phase: "commentary",
      content: [{ type: "output_text", text: "Checking", logprobs: null, annotations: [] }],
    },
  ],
  service_tier: null,
  incomplete_details: null,
  usage: {
    input_tokens: 1,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: 1,
    output_tokens_details: { reasoning_tokens: 0 },
  },
}

function createMockFetch(chunks: string[]) {
  return mock(async () => {
    const body = new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(new TextEncoder().encode(chunk + "\n\n"))
        }
        controller.close()
      },
    })
    return new Response(body, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    })
  })
}

function createModel(fetchFn: ReturnType<typeof mock>) {
  return new OpenAIResponsesLanguageModel("gpt-5.5", {
    provider: "wanlai",
    url: () => "https://api.test.com/v1/responses",
    headers: () => ({ Authorization: "Bearer test-token" }),
    fetch: fetchFn as any,
  } as any)
}

describe("doStream response.failed", () => {
  test("emits a STREAM_FAILED error recognized as a retryable mid-stream interruption", async () => {
    const model = createModel(createMockFetch(FAILED_AFTER_CONTENT))

    const { stream } = await model.doStream({
      prompt: TEST_PROMPT,
      includeRawChunks: false,
    })

    const parts = await convertReadableStreamToArray(stream)
    const errorParts = parts.filter((p) => p.type === "error")
    expect(errorParts.length).toBe(1)

    const err = (errorParts[0] as { error: unknown }).error
    // 模型层只负责标成 STREAM_FAILED;是否重试由 processor 的「流中断」门控按已出内容与否决定。
    expect((err as { code?: string }).code).toBe("STREAM_FAILED")

    // 分类层:被识别为流中断(门控据此在已出内容后拦截重试),且本身可重试(首 token 前自愈)。
    const classified = MessageV2.fromError(err, { providerID: ProviderID.make("wanlai") })
    expect(SessionRetry.isMidStreamInterruption(classified)).toBe(true)
    expect(SessionRetry.retryable(classified)).toBeTruthy()
  })

  test("preserves the added item id while accepting a done phase correction", async () => {
    const model = createModel(createMockFetch(PHASE_CORRECTION_MESSAGE))
    const { stream } = await model.doStream({ prompt: TEST_PROMPT, includeRawChunks: false })
    const parts = await convertReadableStreamToArray(stream)

    // Copilot 适配器必须透传 added/done 的 phase，同时把轮换后的 done ID 归并到 added 的稳定 item。
    expect(parts.find((part) => part.type === "text-start")?.providerMetadata).toEqual({
      openai: { itemId: "msg_1", phase: "commentary" },
    })
    expect(parts.find((part) => part.type === "text-end")?.providerMetadata).toEqual({
      openai: { itemId: "msg_1", phase: "final_answer" },
    })
  })

  test("falls back to the added phase when output_item.done contains null", async () => {
    const model = createModel(createMockFetch(COMMENTARY_NULL_DONE_MESSAGE))
    const { stream } = await model.doStream({ prompt: TEST_PROMPT, includeRawChunks: false })
    const parts = await convertReadableStreamToArray(stream)

    // phase 属于 output item；done 合法省略该字段时仍要按 output_index 找回 added 的值。
    expect(parts.find((part) => part.type === "text-end")?.providerMetadata).toEqual({
      openai: { itemId: "msg_1", phase: "commentary" },
    })
  })

  test("preserves phase in non-stream generated text metadata", async () => {
    const model = createModel(
      mock(async () =>
        Response.json(NON_STREAM_COMMENTARY_RESPONSE, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    )
    const result = await model.doGenerate({ prompt: TEST_PROMPT })

    // doGenerate 与 doStream 必须产生同一 metadata，调用方不应因传输模式不同丢失展示阶段。
    expect(result.content.find((part) => part.type === "text")?.providerMetadata).toEqual({
      openai: { itemId: "msg_1", phase: "commentary" },
    })
  })

  test("replays an assistant message with its persisted phase", async () => {
    const { input } = await convertToOpenAIResponsesInput({
      prompt: [
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "Checking",
              providerOptions: { openai: { itemId: "msg_1", phase: "commentary" } },
            },
          ],
        },
      ],
      systemMessageMode: "system",
      store: true,
    })

    // 历史 commentary 必须继续作为 commentary 发送，不能在下一轮退化成普通 assistant 最终回答。
    expect(input).toEqual([
      {
        role: "assistant",
        content: [{ type: "output_text", text: "Checking" }],
        id: "msg_1",
        phase: "commentary",
      },
    ])
  })
})
