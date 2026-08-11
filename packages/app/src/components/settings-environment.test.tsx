import { describe, expect, test } from "bun:test"

describe("settings environment setup script copy affordance", () => {
  test("renders setup script copy affordances in edit and view mode", async () => {
    const source = await Bun.file(new URL("./settings-environment.tsx", import.meta.url)).text()

    expect(source).toContain('onClick={() => void copyScript("setup", setupScript())}')
    expect(source).toContain('onClick={() => void copyScript("setup", setupDisplayScript().value)}')
    expect(source).toContain('language.t("settings.environment.copySetupScript")')
  })

  test("shows copied feedback after copying scripts", async () => {
    const source = await Bun.file(new URL("./settings-environment.tsx", import.meta.url)).text()

    expect(source).toContain('const [copiedScript, setCopiedScript] = createSignal<"setup" | "cleanup" | null>(null)')
    expect(source).toContain('const writeClipboardText = async (value: string) =>')
    expect(source).toContain('document.execCommand("copy")')
    expect(source).toContain('setCopiedScript(kind)')
    expect(source).toContain('showToast({ title: language.t("settings.environment.copyFailed") })')
    expect(source).toContain('copiedScript() === "setup"')
    expect(source).toContain('copiedScript() === "cleanup"')
    expect(source).toContain("inline-flex h-9 items-center whitespace-nowrap")
    expect(source).toContain("after:absolute after:left-1/2 after:top-full")
    expect(source).toContain('language.t("settings.environment.copied")')
  })

  test("hides script copy buttons for placeholder-only empty content", async () => {
    const source = await Bun.file(new URL("./settings-environment.tsx", import.meta.url)).text()

    expect(source).toContain("<Show when={setupScript().trim()}>")
    expect(source).toContain("<Show when={cleanupScript().trim()}>")
    expect(source).toContain("<Show when={setupDisplayScript().value.trim()}>")
    expect(source).toContain("<Show when={cleanupDisplayScript().value.trim()}>")
  })

  test("renders cleanup script copy affordances in edit and view mode", async () => {
    const source = await Bun.file(new URL("./settings-environment.tsx", import.meta.url)).text()

    expect(source).toContain('onClick={() => void copyScript("cleanup", cleanupScript())}')
    expect(source).toContain('onClick={() => void copyScript("cleanup", cleanupDisplayScript().value)}')
    expect(source).toContain('language.t("settings.environment.copyCleanupScript")')
  })

  test("view mode script labels follow selected platform instead of hard-coded bash", async () => {
    const source = await Bun.file(new URL("./settings-environment.tsx", import.meta.url)).text()

    expect(source).toContain("const setupDisplayScript = createMemo(() => displayScript(store.setupScripts))")
    expect(source).toContain("const cleanupDisplayScript = createMemo(() => displayScript(store.cleanupScripts))")
    expect(source).toContain("{setupDisplayScript().label}")
    expect(source).toContain("{cleanupDisplayScript().label}")
    expect(source).not.toContain('<div class="text-12-regular text-text-weak mb-1">{language.t("settings.environment.bash")}</div>')
  })
})
