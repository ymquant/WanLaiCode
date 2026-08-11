import { describe, expect, test } from "bun:test"

describe("Select", () => {
  test("forwards optionDisabled to Kobalte and guards onChange", async () => {
    const source = await Bun.file(new URL("./select.tsx", import.meta.url)).text()

    expect(source).toContain("optionDisabled={local.optionDisabled}")
    expect(source).toContain("if (v && local.optionDisabled?.(v)) return")
  })
})
