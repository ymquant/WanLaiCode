import { describe, expect, test } from "bun:test"

describe("automation tool card", () => {
  test("registers a created automation inline UI card", async () => {
    const source = await Bun.file(new URL("./tool-card.tsx", import.meta.url)).text()

    expect(source).toContain('registerTool({ name: "automation_create", render: AutomationCreateCard })')
    expect(source).toContain('class="cdx cdx-inline-card"')
    expect(source).toContain('class="cdx-inline-card__icon"')
    expect(source).toContain('class="cdx-inline-card__action"')
    expect(source).toContain('language.t("automation.card.open")')
    expect(source).toContain("scheduleSummary(card().schedule, language.t)")
    expect(source).toContain("openAutomationPanel(sessionLayout.sessionKey(), id)")
  })
})
