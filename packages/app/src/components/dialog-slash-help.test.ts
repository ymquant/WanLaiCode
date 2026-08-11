import { describe, expect, test } from "bun:test"

describe("DialogSlashHelp", () => {
  test("waits for the help dialog to close before triggering selected slash commands", async () => {
    const source = await Bun.file(new URL("./dialog-slash-help.tsx", import.meta.url)).text()

    expect(source).toContain("const HELP_COMMAND_TRIGGER_DELAY_MS = 120")
    expect(source).toContain('setTimeout(() => command.trigger(id, "slash"), HELP_COMMAND_TRIGGER_DELAY_MS)')
    expect(source).not.toContain('setTimeout(() => command.trigger(id, "slash"), 50)')
  })
})
