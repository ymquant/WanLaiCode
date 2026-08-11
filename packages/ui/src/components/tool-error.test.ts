import { describe, expect, test } from "bun:test"
import { toolErrorText } from "./tool-error"

describe("toolErrorText", () => {
  test("keeps string errors unchanged", () => {
    expect(toolErrorText("Request failed")).toBe("Request failed")
  })

  test("uses readable fields from object errors", () => {
    expect(toolErrorText({ message: "Request failed" })).toBe("Request failed")
    expect(toolErrorText({ error: { message: "upstream failed" } })).toBe("upstream failed")
  })

  test("falls back to json for unknown object errors", () => {
    expect(toolErrorText({ code: "bad_gateway" })).toBe('{"code":"bad_gateway"}')
  })
})
