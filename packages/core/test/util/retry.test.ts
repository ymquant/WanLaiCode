import { describe, test, expect } from "bun:test"
import { retry } from "../../src/util/retry"

describe("retry transient", () => {
  test("499 / empty response body 触发重试", async () => {
    let calls = 0
    const result = await retry(
      async () => {
        calls++
        if (calls < 2) throw new Error("server GET /x → 499: (empty response body)")
        return "ok"
      },
      { delay: 1 },
    )
    expect(result).toBe("ok")
    expect(calls).toBe(2)
  })

  test("client closed 触发重试", async () => {
    let calls = 0
    const result = await retry(
      async () => {
        calls++
        if (calls < 2) throw new Error("connection error: client closed request")
        return "ok"
      },
      { delay: 1 },
    )
    expect(result).toBe("ok")
    expect(calls).toBe(2)
  })

  test("非瞬时错误不重试", async () => {
    let calls = 0
    await expect(
      retry(async () => {
        calls++
        throw new Error("permanent failure")
      }, { delay: 1 }),
    ).rejects.toThrow("permanent")
    expect(calls).toBe(1)
  })
})
