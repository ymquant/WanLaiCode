import { describe, expect, test } from "bun:test"

describe("settings providers WanlaiCode auth tag", () => {
  test("uses WanlaiCode user-center auth type for the connected provider tag", async () => {
    const source = await Bun.file(new URL("./settings-providers.tsx", import.meta.url)).text()

    expect(source).toContain("wanlaicodeUserCenter.status()")
    expect(source).toContain('item.id === "wanlaicode"')
    expect(source).toContain('wanlaiCodeStatus.latest?.auth_type === "oauth"')
    expect(source).toContain('language.t("settings.providers.tag.accountLogin")')
    expect(source).toContain('wanlaiCodeStatus.latest?.auth_type === "api"')
    expect(source).toContain('language.t("provider.connect.method.apiKey")')
  })

  test("keeps source-based tags for non-WanlaiCode providers", async () => {
    const source = await Bun.file(new URL("./settings-providers.tsx", import.meta.url)).text()

    expect(source).toContain("const current = source(item)")
    expect(source).toContain('if (current === "env")')
    expect(source).toContain('if (current === "config")')
    expect(source).toContain('if (current === "custom")')
  })
})
