import { describe, expect, test } from "bun:test"

describe("automation route", () => {
  test("app.tsx registers /automations with a lazy page", async () => {
    const src = await Bun.file(new URL("./app.tsx", import.meta.url)).text()
    expect(src).toContain('import("@/pages/automation")')
    expect(src).toContain('path="/automations"')
  })

  test("app.tsx can skip only the blocking startup health gate", async () => {
    const src = await Bun.file(new URL("./app.tsx", import.meta.url)).text()
    expect(src).toContain("skipStartupHealthGate?: boolean")
    expect(src).toContain("props.disableHealthCheck || props.skipStartupHealthGate")
    expect(src).toContain("skipStartupHealthGate={props.skipStartupHealthGate}")
  })
})
