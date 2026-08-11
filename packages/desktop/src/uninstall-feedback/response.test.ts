import { describe, expect, test } from "bun:test"
import { parseUninstallFeedbackResponse } from "./response"

describe("parseUninstallFeedbackResponse", () => {
  test("200 + code 0 → ok", () => {
    expect(parseUninstallFeedbackResponse(200, { code: 0, data: { id: "x1" } })).toEqual({
      ok: true,
      id: "x1",
      retryable: false,
    })
  })
  test("503 → retryable, not ok", () => {
    expect(parseUninstallFeedbackResponse(503, { code: 5, message: "s3 down" })).toEqual({
      ok: false,
      retryable: true,
    })
  })
  test("400 → not ok, not retryable", () => {
    expect(parseUninstallFeedbackResponse(400, { code: 1 })).toEqual({ ok: false, retryable: false })
  })
  test("200 but code != 0 → not ok", () => {
    expect(parseUninstallFeedbackResponse(200, { code: 9 })).toEqual({ ok: false, retryable: false })
  })
})
