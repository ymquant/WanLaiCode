import { describe, expect, test } from "bun:test"

describe("message timeline title editor", () => {
  test("saves on blur but keeps escape as a pure cancel path", async () => {
    const source = await Bun.file(new URL("./message-timeline.tsx", import.meta.url)).text()
    const editor = source.slice(
      source.indexOf('data-slot="session-title-child"'),
      source.indexOf('/>', source.indexOf('data-slot="session-title-child"')),
    )

    expect(editor).toContain('if (event.key === "Enter")')
    expect(editor).toContain("void saveTitleEditor()")
    expect(editor).toContain('if (event.key === "Escape")')
    expect(editor).toContain("closeTitleEditor()")
    expect(editor).toContain("if (title.suppressBlurSave)")
    expect(editor).toContain('setTitle("suppressBlurSave", false)')
  })
})