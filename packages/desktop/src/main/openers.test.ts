import { describe, expect, test } from "bun:test"

import { resolveOpenPathApp } from "./openers"

describe("resolveOpenPathApp", () => {
  test("rejects empty and control characters", async () => {
    await expect(resolveOpenPathApp("")).rejects.toThrow("Invalid app")
    await expect(resolveOpenPathApp("code\u0000")).rejects.toThrow("Invalid app")
  })
})
