import { describe, expect, test } from "bun:test"
import { isTransportError } from "./optimistic-session"

describe("isTransportError", () => {
  test("matches known transport failures", () => {
    expect(isTransportError(new TypeError("Failed to fetch"))).toBe(true)
    expect(isTransportError(new Error("network error (no response)"))).toBe(true)
    expect(isTransportError("network request failed")).toBe(true)
  })

  test("does not treat unrelated TypeErrors as transport failures", () => {
    expect(isTransportError(new TypeError("Cannot read properties of undefined"))).toBe(false)
  })

  test("ignores abort and timeout errors", () => {
    expect(isTransportError(Object.assign(new Error("aborted"), { name: "AbortError" }))).toBe(false)
    expect(isTransportError(Object.assign(new Error("timed out"), { name: "TimeoutError" }))).toBe(false)
  })

  test("unwraps nested SDK error objects", () => {
    expect(isTransportError({ error: new TypeError("Failed to fetch") })).toBe(true)
    expect(isTransportError({ message: "network request failed" })).toBe(true)
  })
})
