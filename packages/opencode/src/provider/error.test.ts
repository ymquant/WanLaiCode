import { expect, test, describe } from "bun:test"
import { APICallError } from "ai"
import { gatewayReasonFromBody, parseAPICallError, parseStreamError } from "./error"
import { ProviderID } from "./schema"

describe("gatewayReasonFromBody", () => {
  test("reads error.code (chat/messages)", () => {
    expect(gatewayReasonFromBody({ type: "error", error: { type: "rate_limit_exceeded", code: "API_KEY_RATE_5H_EXCEEDED" } }))
      .toBe("API_KEY_RATE_5H_EXCEEDED")
  })
  test("reads error.sub_code (responses API)", () => {
    expect(gatewayReasonFromBody({ error: { code: "rate_limit_exceeded", sub_code: "USER_PLATFORM_DAILY_QUOTA_EXHAUSTED" } }))
      .toBe("USER_PLATFORM_DAILY_QUOTA_EXHAUSTED")
  })
  test("undefined when neither present", () => {
    expect(gatewayReasonFromBody({ error: { type: "x", message: "y" } })).toBeUndefined()
    expect(gatewayReasonFromBody(undefined)).toBeUndefined()
  })
})

describe("parseStreamError context overflow", () => {
  test("detects overflow from error message text without a standard code (chat/completions style)", () => {
    // 网关 OpenAI 兼容路径下 context 超限返回的结构：无 type:"error"、code 为 server_error，
    // 仅 message 里含上游原文。必须靠文本兜底识别，否则被动压缩永不触发。
    const body = {
      error: {
        message:
          "This model's maximum context length is 1048565 tokens. However, you requested 7834247 tokens. Please reduce the length of the messages or completion.",
        type: "server_error",
      },
    }
    expect(parseStreamError(body)?.type).toBe("context_overflow")
  })

  test("detects overflow phrased as 'exceeds the context window'", () => {
    const body = { error: { message: "Your input exceeds the context window of this model.", type: "server_error" } }
    expect(parseStreamError(body)?.type).toBe("context_overflow")
  })

  test("does not misclassify an unrelated server error as overflow", () => {
    const body = { error: { message: "The server had an error processing your request.", type: "server_error" } }
    expect(parseStreamError(body)?.type).not.toBe("context_overflow")
  })

  test("still detects overflow via standard code (type:error)", () => {
    const body = { type: "error", error: { code: "context_length_exceeded", message: "too long" } }
    expect(parseStreamError(body)?.type).toBe("context_overflow")
  })
})

describe("parseAPICallError stream failures", () => {
  test("preserves socket failures as STREAM_FAILED metadata", () => {
    // 代理层断开 SSE 时保留底层 socket 码，处理器才能按“已产出内容”收口当前回合。
    const error = new APICallError({
      message: "fetch failed",
      url: "https://api.example.com/v1/chat/completions",
      requestBodyValues: {},
      cause: Object.assign(new Error("socket connection closed unexpectedly"), {
        name: "SocketError",
        code: "UND_ERR_SOCKET",
      }),
      isRetryable: true,
    })

    expect(parseAPICallError({ providerID: ProviderID.make("wanlaicode"), error })).toMatchObject({
      type: "api_error",
      isRetryable: true,
      metadata: {
        code: "STREAM_FAILED",
        transportCode: "UND_ERR_SOCKET",
        transportName: "SocketError",
      },
    })
  })

  test("does not mark ordinary provider errors as stream failures", () => {
    const error = new APICallError({
      message: "bad request",
      url: "https://api.example.com/v1/chat/completions",
      requestBodyValues: {},
      statusCode: 400,
      isRetryable: false,
    })

    const parsed = parseAPICallError({ providerID: ProviderID.make("wanlaicode"), error })
    // 普通 400 必须保持 api_error 分支，才能安全断言其传输元数据未被污染。
    expect(parsed.type).toBe("api_error")
    if (parsed.type !== "api_error") return
    expect(parsed.metadata).toEqual({
      url: "https://api.example.com/v1/chat/completions",
    })
  })
})
