import { describe, expect, test } from "bun:test"

describe("PromptContextItems review comment preview", () => {
  test("keeps long review comment popovers internally scrollable", async () => {
    const source = await Bun.file(new URL("./context-items.tsx", import.meta.url)).text()

    expect(source).toContain("fitViewport")
    expect(source).toContain("--kb-popper-content-available-height")
    expect(source).toContain("max-h-[inherit]")
    expect(source).toContain("overflow-y-auto")
    expect(source).toContain("prompt-input-scrollbar")
  })
})
