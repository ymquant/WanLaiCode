import { describe, expect, test } from "bun:test"

describe("global toast region", () => {
  test("AppBaseProviders renders toast region outside route layout", async () => {
    const source = await Bun.file(new URL("./app.tsx", import.meta.url)).text()
    const body = source.slice(source.indexOf("export function AppBaseProviders"), source.indexOf("function ConnectionGate"))

    expect(body).toContain("<Toast.Region />")
  })
})
