import { describe, expect, test } from "bun:test"
import { reasonFromMessage } from "./parse-reason"

describe("reasonFromMessage", () => {
  test("extracts reason from CODE: description messages", () => {
    expect(reasonFromMessage("SOFTWARE_BILLING_COST_UNAVAILABLE: The requested model is not available")).toBe(
      "SOFTWARE_BILLING_COST_UNAVAILABLE",
    )
  })

  test("extracts bare machine codes", () => {
    expect(reasonFromMessage("SUBSCRIPTION_EXPIRED")).toBe("SUBSCRIPTION_EXPIRED")
  })

  test("returns undefined for plain text", () => {
    expect(reasonFromMessage("Request failed")).toBeUndefined()
  })
})
