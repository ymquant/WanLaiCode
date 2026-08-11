import { describe, expect, test } from "bun:test"
import { resolveUninstallFeedbackEndpoint } from "./endpoint"

describe("resolveUninstallFeedbackEndpoint", () => {
  const want = "https://api.example.com/api/v1/software/uninstall-feedback"
  test("strips trailing /v1", () => {
    expect(resolveUninstallFeedbackEndpoint("https://api.example.com/v1")).toBe(want)
  })
  test("strips trailing /api/v1", () => {
    expect(resolveUninstallFeedbackEndpoint("https://api.example.com/api/v1")).toBe(want)
  })
  test("strips trailing slashes", () => {
    expect(resolveUninstallFeedbackEndpoint("https://api.example.com/")).toBe(want)
    expect(resolveUninstallFeedbackEndpoint("https://api.example.com")).toBe(want)
  })
})
