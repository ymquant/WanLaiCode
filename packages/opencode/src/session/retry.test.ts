import { describe, expect, test } from "bun:test"
import { MessageV2 } from "./message-v2"
import { SessionRetry } from "./retry"

describe("SessionRetry.retryable", () => {
  test("does not retry auth and entitlement failures", () => {
    const errors = [
      new MessageV2.APIError({ message: "Unauthorized", statusCode: 401, isRetryable: true }).toObject(),
      new MessageV2.APIError({ message: "Forbidden", statusCode: 403, isRetryable: true }).toObject(),
      new MessageV2.APIError({ message: "Invalid API key", isRetryable: true }).toObject(),
      new MessageV2.APIError({ message: "API_KEY_DISABLED", isRetryable: true }).toObject(),
      new MessageV2.APIError({ message: "Payment Required: 没有套餐", statusCode: 402, isRetryable: true }).toObject(),
      new MessageV2.APIError({ message: "套餐已过期", isRetryable: true }).toObject(),
      new MessageV2.APIError({ message: "模型无权限", isRetryable: true }).toObject(),
    ]

    for (const error of errors) {
      expect(SessionRetry.retryable(error)).toBeUndefined()
    }
  })

  test("still retries transient server failures", () => {
    const error = new MessageV2.APIError({
      message: "upstream unavailable",
      statusCode: 503,
      isRetryable: false,
    }).toObject()

    expect(SessionRetry.retryable(error)).toBe("upstream unavailable")
  })

  test("still retries rate limits even when provider marks them non-retryable", () => {
    const error = new MessageV2.APIError({
      message: "Too Many Requests",
      statusCode: 429,
      isRetryable: false,
    }).toObject()

    expect(SessionRetry.retryable(error)).toBe("Rate Limited")
  })

  test("keeps generic 402 provider handling", () => {
    const error = new MessageV2.APIError({
      message: "Payment Required",
      statusCode: 402,
      isRetryable: true,
    }).toObject()

    expect(SessionRetry.retryable(error)).toBe("Payment Required")
  })
})

describe("SessionRetry.isStreamStall", () => {
  test("recognizes a STREAM_STALL APIError", () => {
    const error = new MessageV2.APIError({
      message: "Stream stalled",
      isRetryable: true,
      metadata: { code: "STREAM_STALL", message: "no SSE chunk for 120000ms" },
    }).toObject()

    expect(SessionRetry.isStreamStall(error)).toBe(true)
  })

  test("does not match ordinary retryable errors", () => {
    const rate = new MessageV2.APIError({ message: "Rate Limited", statusCode: 429, isRetryable: true }).toObject()
    const server = new MessageV2.APIError({ message: "boom", statusCode: 503, isRetryable: false }).toObject()
    const aborted = new MessageV2.AbortedError({ message: "aborted" }).toObject()

    expect(SessionRetry.isStreamStall(rate)).toBe(false)
    expect(SessionRetry.isStreamStall(server)).toBe(false)
    expect(SessionRetry.isStreamStall(aborted)).toBe(false)
  })
})

describe("SessionRetry.isStreamFailed", () => {
  test("recognizes a STREAM_FAILED APIError", () => {
    const error = new MessageV2.APIError({
      message: "Stream failed",
      isRetryable: true,
      metadata: { code: "STREAM_FAILED", message: "unexpected EOF" },
    }).toObject()

    expect(SessionRetry.isStreamFailed(error)).toBe(true)
  })

  test("does not match stalls or ordinary errors", () => {
    const stall = new MessageV2.APIError({
      message: "Stream stalled",
      isRetryable: true,
      metadata: { code: "STREAM_STALL" },
    }).toObject()
    const rate = new MessageV2.APIError({ message: "Rate Limited", statusCode: 429, isRetryable: true }).toObject()

    expect(SessionRetry.isStreamFailed(stall)).toBe(false)
    expect(SessionRetry.isStreamFailed(rate)).toBe(false)
  })
})

describe("SessionRetry.isMidStreamInterruption", () => {
  test("covers both stalls and failures", () => {
    const stall = new MessageV2.APIError({
      message: "Stream stalled",
      isRetryable: true,
      metadata: { code: "STREAM_STALL" },
    }).toObject()
    const failed = new MessageV2.APIError({
      message: "Stream failed",
      isRetryable: true,
      metadata: { code: "STREAM_FAILED" },
    }).toObject()

    expect(SessionRetry.isMidStreamInterruption(stall)).toBe(true)
    expect(SessionRetry.isMidStreamInterruption(failed)).toBe(true)
  })

  test("does not match ordinary retryable errors", () => {
    const rate = new MessageV2.APIError({ message: "Rate Limited", statusCode: 429, isRetryable: true }).toObject()
    const aborted = new MessageV2.AbortedError({ message: "aborted" }).toObject()

    expect(SessionRetry.isMidStreamInterruption(rate)).toBe(false)
    expect(SessionRetry.isMidStreamInterruption(aborted)).toBe(false)
  })
})
