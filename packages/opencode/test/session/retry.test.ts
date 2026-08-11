import { describe, expect, test } from "bun:test"
import type { NamedError } from "@opencode-ai/core/util/error"
import { APICallError } from "ai"
import { setTimeout as sleep } from "node:timers/promises"
import { Effect, Exit, Fiber, Layer, Schedule } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { SessionRetry } from "../../src/session/retry"
import { MessageV2 } from "../../src/session/message-v2"
import { ProviderID } from "../../src/provider/schema"
import { SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const providerID = ProviderID.make("test")
const it = testEffect(Layer.mergeAll(SessionStatus.defaultLayer, CrossSpawnSpawner.defaultLayer))

function apiError(headers?: Record<string, string>): MessageV2.APIError {
  return MessageV2.APIError.Schema.parse(
    new MessageV2.APIError({
      message: "boom",
      isRetryable: true,
      responseHeaders: headers,
    }).toObject(),
  )
}

function wrap(message: unknown): ReturnType<NamedError["toObject"]> {
  return { name: "", data: { message } }
}

describe("session.retry.delay", () => {
  test("caps delay at 60 seconds when headers missing", () => {
    const error = apiError()
    const delays = Array.from({ length: 10 }, (_, index) => SessionRetry.delay(index + 1, error, () => 0.5))
    expect(delays).toStrictEqual([2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000, 60000, 60000])
  })

  test("caps exponential backoff at 60 seconds when headers present without retry-after", () => {
    const error = apiError({ "x-request-id": "abc" })
    const delays = Array.from({ length: 10 }, (_, index) => SessionRetry.delay(index + 1, error, () => 0.5))
    expect(delays).toStrictEqual([2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000, 60000, 60000])
  })

  test("applies ±10% jitter around the backoff", () => {
    const error = apiError()
    expect(SessionRetry.delay(7, error, () => 0)).toBe(54000)
    expect(SessionRetry.delay(7, error, () => 0.5)).toBe(60000)
    expect(SessionRetry.delay(7, error, () => 1)).toBe(66000)
  })

  test("uses a small fixed backoff for empty responses", () => {
    const error = MessageV2.APIError.Schema.parse(
      new MessageV2.APIError({
        message: "empty",
        isRetryable: true,
        metadata: { code: "EMPTY_RESPONSE" },
      }).toObject(),
    )
    expect(SessionRetry.delay(1, error)).toBe(SessionRetry.RETRY_EMPTY_RESPONSE_DELAY)
  })

  test("prefers retry-after-ms when shorter than exponential", () => {
    const error = apiError({ "retry-after-ms": "1500" })
    expect(SessionRetry.delay(4, error)).toBe(1500)
  })

  test("uses retry-after seconds when reasonable", () => {
    const error = apiError({ "retry-after": "30" })
    expect(SessionRetry.delay(3, error)).toBe(30000)
  })

  test("accepts http-date retry-after values", () => {
    const date = new Date(Date.now() + 20000).toUTCString()
    const error = apiError({ "retry-after": date })
    const d = SessionRetry.delay(1, error)
    expect(d).toBeGreaterThanOrEqual(19000)
    expect(d).toBeLessThanOrEqual(20000)
  })

  test("ignores invalid retry hints", () => {
    const error = apiError({ "retry-after": "not-a-number" })
    expect(SessionRetry.delay(1, error, () => 0.5)).toBe(2000)
  })

  test("ignores malformed date retry hints", () => {
    const error = apiError({ "retry-after": "Invalid Date String" })
    expect(SessionRetry.delay(1, error, () => 0.5)).toBe(2000)
  })

  test("ignores past date retry hints", () => {
    const pastDate = new Date(Date.now() - 5000).toUTCString()
    const error = apiError({ "retry-after": pastDate })
    expect(SessionRetry.delay(1, error, () => 0.5)).toBe(2000)
  })

  test("uses retry-after values even when exceeding 10 minutes with headers", () => {
    const error = apiError({ "retry-after": "50" })
    expect(SessionRetry.delay(1, error)).toBe(50000)

    const longError = apiError({ "retry-after-ms": "700000" })
    expect(SessionRetry.delay(1, longError)).toBe(700000)
  })

  test("caps oversized header delays to the runtime timer limit", () => {
    const error = apiError({ "retry-after-ms": "999999999999" })
    expect(SessionRetry.delay(1, error)).toBe(SessionRetry.RETRY_MAX_DELAY)
  })

  it.live("policy updates retry status and increments attempts", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessionID = SessionID.make("session-retry-test")
        const error = apiError({ "retry-after-ms": "0" })
        const status = yield* SessionStatus.Service

        const step = yield* Schedule.toStepWithMetadata(
          SessionRetry.policy({
            parse: (err) => MessageV2.APIError.Schema.parse(err),
            set: (info) =>
              status.set(sessionID, {
                type: "retry",
                attempt: info.attempt,
                message: info.message,
                next: info.next,
              }),
          }),
        )
        yield* step(error)
        yield* step(error)

        expect(yield* status.get(sessionID)).toMatchObject({
          type: "retry",
          attempt: 2,
          message: "boom",
        })
      }),
    ),
  )

  it.effect("policy retries without an attempt cap and stops only after RETRY_MAX_DURATION", () =>
    Effect.gen(function* () {
      const error = apiError({ "retry-after-ms": "0" })

      const step = yield* Schedule.toStepWithMetadata(
        SessionRetry.policy({
          parse: (err) => MessageV2.APIError.Schema.parse(err),
          set: () => Effect.void,
        }),
      )

      // 虚拟时间未推进（elapsed≈0）：远超旧的 5 次上限仍持续重试，证明次数上限已移除。
      for (let i = 0; i < 50; i++) {
        expect((yield* Effect.exit(step(error)))._tag).toBe("Success")
      }

      // 差 1ms 未到兜底：仍继续重试。
      yield* TestClock.adjust(SessionRetry.RETRY_MAX_DURATION - 1)
      expect((yield* Effect.exit(step(error)))._tag).toBe("Success")

      // 恰好到达 12 小时兜底（判停含等号 elapsed>=上限）：停止上抛。
      yield* TestClock.adjust(1)
      expect((yield* Effect.exit(step(error)))._tag).toBe("Failure")
    }),
  )

  it.effect("clamps a long server retry-after so retrying never overshoots RETRY_MAX_DURATION", () =>
    Effect.gen(function* () {
      // 服务器持续要求等 5 小时。不夹逼时：t=10h 处会再睡满 5h → 15h 才终止；
      // 夹逼后末次睡眠被压到剩余预算内，整轮必在 12h 处终止。
      const error = apiError({ "retry-after": "18000" })
      const fiber = yield* Effect.fail(error).pipe(
        Effect.retry(
          SessionRetry.policy({
            parse: (err) => MessageV2.APIError.Schema.parse(err),
            set: () => Effect.void,
          }),
        ),
        Effect.forkChild({ startImmediately: true }),
      )

      // 只推进 12h：夹逼下整轮此刻已终止；若未夹逼，末次睡到 15h，fiber 会悬挂到超时。
      yield* TestClock.adjust(SessionRetry.RETRY_MAX_DURATION)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )
})

describe("session.retry.retryable", () => {
  test("maps too_many_requests json messages", () => {
    const error = wrap(JSON.stringify({ type: "error", error: { type: "too_many_requests" } }))
    expect(SessionRetry.retryable(error)).toBe("Too Many Requests")
  })

  test("maps overloaded provider codes", () => {
    const error = wrap(JSON.stringify({ code: "resource_exhausted" }))
    expect(SessionRetry.retryable(error)).toBe("Provider is overloaded")
  })

  test("does not retry unknown json messages", () => {
    const error = wrap(JSON.stringify({ error: { message: "no_kv_space" } }))
    expect(SessionRetry.retryable(error)).toBeUndefined()
  })

  test("does not throw on numeric error codes", () => {
    const error = wrap(JSON.stringify({ type: "error", error: { code: 123 } }))
    const result = SessionRetry.retryable(error)
    expect(result).toBeUndefined()
  })

  test("returns undefined for non-json message", () => {
    const error = wrap("not-json")
    expect(SessionRetry.retryable(error)).toBeUndefined()
  })

  test("retries plain text rate limit errors from Alibaba", () => {
    const msg =
      "Upstream error from Alibaba: Request rate increased too quickly. To ensure system stability, please adjust your client logic to scale requests more smoothly over time."
    const error = wrap(msg)
    expect(SessionRetry.retryable(error)).toBe(msg)
  })

  test("retries plain text rate limit errors", () => {
    const msg = "Rate limit exceeded, please try again later"
    const error = wrap(msg)
    expect(SessionRetry.retryable(error)).toBe(msg)
  })

  test("retries too many requests in plain text", () => {
    const msg = "Too many requests, please slow down"
    const error = wrap(msg)
    expect(SessionRetry.retryable(error)).toBe(msg)
  })

  test("does not retry context overflow errors", () => {
    const error = new MessageV2.ContextOverflowError({
      message: "Input exceeds context window of this model",
      responseBody: '{"error":{"code":"context_length_exceeded"}}',
    }).toObject()

    expect(SessionRetry.retryable(error)).toBeUndefined()
  })

  test("retries 500 errors even when isRetryable is false", () => {
    const error = MessageV2.APIError.Schema.parse(
      new MessageV2.APIError({
        message: "Internal server error",
        isRetryable: false,
        statusCode: 500,
        responseBody: '{"type":"api_error","message":"Internal server error"}',
      }).toObject(),
    )

    expect(SessionRetry.retryable(error)).toBe("Internal server error")
  })

  test("retries 502 bad gateway errors", () => {
    const error = MessageV2.APIError.Schema.parse(
      new MessageV2.APIError({
        message: "Bad gateway",
        isRetryable: false,
        statusCode: 502,
      }).toObject(),
    )

    expect(SessionRetry.retryable(error)).toBe("Bad gateway")
  })

  test("retries 503 service unavailable errors", () => {
    const error = MessageV2.APIError.Schema.parse(
      new MessageV2.APIError({
        message: "Service unavailable",
        isRetryable: false,
        statusCode: 503,
      }).toObject(),
    )

    expect(SessionRetry.retryable(error)).toBe("Service unavailable")
  })

  test("does not retry 4xx errors when isRetryable is false", () => {
    const error = MessageV2.APIError.Schema.parse(
      new MessageV2.APIError({
        message: "Bad request",
        isRetryable: false,
        statusCode: 400,
      }).toObject(),
    )

    expect(SessionRetry.retryable(error)).toBeUndefined()
  })

  test("retries ZlibError decompression failures", () => {
    const error = MessageV2.APIError.Schema.parse(
      new MessageV2.APIError({
        message: "Response decompression failed",
        isRetryable: true,
        metadata: { code: "ZlibError" },
      }).toObject(),
    )

    const retryable = SessionRetry.retryable(error)
    expect(retryable).toBeDefined()
    expect(retryable).toBe("Response decompression failed")
  })

  // 套餐额度用尽：网关以 429 + rate_limit_error 下发，仅靠 error.code 区分。
  // 语义是本轮配额耗尽，不可重试——否则会被当成限流一路无限重试（12h）。
  test("does not retry plan quota exhaustion delivered as 429 rate_limit_error (streaming envelope)", () => {
    const error = MessageV2.APIError.Schema.parse(
      new MessageV2.APIError({
        message: "software package 5小时 token 已用完",
        isRetryable: true,
        statusCode: 429,
        responseBody: JSON.stringify({
          type: "error",
          error: {
            type: "rate_limit_error",
            message: "软件套餐额度已用完，请稍后再试或升级套餐",
            code: "SOFTWARE_TOKEN_LIMIT_5H_EXCEEDED",
          },
        }),
      }).toObject(),
    )

    expect(SessionRetry.retryable(error)).toBeUndefined()
  })

  test("does not retry plan quota exhaustion in auth-middleware envelope (top-level code)", () => {
    const error = MessageV2.APIError.Schema.parse(
      new MessageV2.APIError({
        message: "software package 5小时 token 已用完",
        isRetryable: true,
        statusCode: 429,
        responseBody: JSON.stringify({
          code: "SOFTWARE_TOKEN_LIMIT_5H_EXCEEDED",
          message: "software package 5小时 token 已用完",
        }),
      }).toObject(),
    )

    expect(SessionRetry.retryable(error)).toBeUndefined()
  })

  // 契约驱动：终态类目由 reason 码判定，覆盖关键字清单没有的码（如订阅停用），无需扩关键字。
  test("does not retry terminal reason codes beyond the keyword list (subscription suspended)", () => {
    const error = MessageV2.APIError.Schema.parse(
      new MessageV2.APIError({
        message: "boom",
        isRetryable: true,
        statusCode: 429,
        responseBody: JSON.stringify({ error: { type: "rate_limit_error", code: "SUBSCRIPTION_SUSPENDED" } }),
      }).toObject(),
    )

    expect(SessionRetry.retryable(error)).toBeUndefined()
  })

  // 回归保护：真限流（429 + rate_limit_error 但无套餐额度机读码）仍应重试。
  test("still retries genuine rate limit (429 without quota code)", () => {
    const error = MessageV2.APIError.Schema.parse(
      new MessageV2.APIError({
        message: "Rate limited",
        isRetryable: true,
        statusCode: 429,
        responseBody: JSON.stringify({
          type: "error",
          error: { type: "rate_limit_error", message: "Too many requests, please retry later" },
        }),
      }).toObject(),
    )

    expect(SessionRetry.retryable(error)).toBe("Rate Limited")
  })

  // 兜底路径守护：无 reason 码时（契约判 unknown）仍由关键字/status 拦住鉴权类终态。
  test("does not retry 401 without reason code (status fallback)", () => {
    const error = MessageV2.APIError.Schema.parse(
      new MessageV2.APIError({
        message: "Unauthorized",
        isRetryable: true,
        statusCode: 401,
      }).toObject(),
    )

    expect(SessionRetry.retryable(error)).toBeUndefined()
  })

  test("does not retry invalid api key text without reason code (keyword fallback)", () => {
    const error = wrap("Invalid API key provided")
    expect(SessionRetry.retryable(error)).toBeUndefined()
  })
})

describe("session.message-v2.fromError", () => {
  test.concurrent(
    "converts ECONNRESET socket errors to retryable APIError",
    async () => {
      using server = Bun.serve({
        port: 0,
        idleTimeout: 8,
        async fetch(_req) {
          return new Response(
            new ReadableStream({
              async pull(controller) {
                controller.enqueue("Hello,")
                await sleep(10000)
                controller.enqueue(" World!")
                controller.close()
              },
            }),
            { headers: { "Content-Type": "text/plain" } },
          )
        },
      })

      const error = await fetch(new URL("/", server.url.origin))
        .then((res) => res.text())
        .catch((e) => e)

      const result = MessageV2.fromError(error, { providerID })

      expect(MessageV2.APIError.isInstance(result)).toBe(true)
      if (!MessageV2.APIError.isInstance(result)) throw new Error("expected APIError")
      expect(result.data.isRetryable).toBe(true)
      expect(result.data.message).toBe("Connection reset by server")
      expect(result.data.metadata?.code).toBe("ECONNRESET")
      expect(result.data.metadata?.message).toInclude("socket connection")
    },
    15_000,
  )

  test("ECONNRESET socket error is retryable", () => {
    const error = MessageV2.APIError.Schema.parse(
      new MessageV2.APIError({
        message: "Connection reset by server",
        isRetryable: true,
        metadata: { code: "ECONNRESET", message: "The socket connection was closed unexpectedly" },
      }).toObject(),
    )

    const retryable = SessionRetry.retryable(error)
    expect(retryable).toBeDefined()
    expect(retryable).toBe("Connection reset by server")
  })

  test("marks OpenAI 404 status codes as retryable", () => {
    const error = new APICallError({
      message: "boom",
      url: "https://api.openai.com/v1/chat/completions",
      requestBodyValues: {},
      statusCode: 404,
      responseHeaders: { "content-type": "application/json" },
      responseBody: '{"error":"boom"}',
      isRetryable: false,
    })
    const result = MessageV2.fromError(error, { providerID: ProviderID.make("openai") })
    if (!MessageV2.APIError.isInstance(result)) throw new Error("expected APIError")
    expect(result.data.isRetryable).toBe(true)
  })

  test("converts OpenAI server_error stream chunks to retryable APIError", () => {
    const result = MessageV2.fromError(
      {
        message: JSON.stringify({
          type: "error",
          sequence_number: 2,
          error: {
            type: "server_error",
            code: "server_error",
            message: "An error occurred while processing your request.",
            param: null,
          },
        }),
      },
      { providerID: ProviderID.make("openai") },
    )

    expect(MessageV2.APIError.isInstance(result)).toBe(true)
    if (!MessageV2.APIError.isInstance(result)) throw new Error("expected APIError")
    expect(result.data.isRetryable).toBe(true)
    expect(SessionRetry.retryable(result)).toBe("An error occurred while processing your request.")
  })
})
