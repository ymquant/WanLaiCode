import { describe, expect, test } from "bun:test"

describe("settings proxy", () => {
  test("saves proxy payload through global config", async () => {
    const source = await Bun.file(new URL("./settings-proxy.tsx", import.meta.url)).text()

    expect(source).toContain('globalSync.set("config", "proxy", next)')
    expect(source).toContain("globalSync.updateConfig({ proxy: next })")
  })

  test("formats save failures and rolls back optimistic proxy state", async () => {
    const source = await Bun.file(new URL("./settings-proxy.tsx", import.meta.url)).text()

    expect(source).toContain("formatServerError(err, language.t")
    expect(source).toContain("setDraft(draftFromConfig(previous))")
    expect(source).toContain('globalSync.set("config", "proxy", previous)')
  })

  test("uses neutral placeholders instead of a localhost proxy default", async () => {
    const source = await Bun.file(new URL("./settings-proxy.tsx", import.meta.url)).text()

    expect(source).not.toContain("http://127.0.0.1:7890")
    expect(source).toContain('language.t("settings.proxy.placeholder.url")')
    expect(source).toContain('language.t("settings.proxy.placeholder.noProxy")')
    expect(source).toContain('language.t("settings.proxy.placeholder.system.url")')
    expect(source).toContain('language.t("settings.proxy.placeholder.system.noProxy")')
  })

  test("shows detected system proxy values and uses SDK-authenticated global proxy endpoint", async () => {
    const source = await Bun.file(new URL("./settings-proxy.tsx", import.meta.url)).text()

    expect(source).toContain('queryKey: ["global", "proxy"]')
    expect(source).toContain("globalSDK.client.global.proxy.get()")
    expect(source).toContain('draft.mode === "system" ? systemSharedProxy() : draft.url')
    expect(source).toContain('draft.mode === "system" ? (systemProxy.data?.http ?? "") : draft.http_url')
    expect(source).toContain('draft.mode === "system" ? (systemProxy.data?.https ?? "") : draft.https_url')
    expect(source).toContain('language.t("settings.proxy.placeholder.system.url")')
  })

  test("only disables proxy inputs in no-proxy mode and switches URL edits to manual mode", async () => {
    const source = await Bun.file(new URL("./settings-proxy.tsx", import.meta.url)).text()

    expect(source).toContain('const fieldsDisabled = createMemo(() => draft.mode === "none")')
    expect(source).toContain('update({ ...patch, mode: "manual" })')
    expect(source).toContain("disabled={fieldsDisabled()}")
  })

  test("commits proxy text fields on blur or enter instead of every edit", async () => {
    const source = await Bun.file(new URL("./settings-proxy.tsx", import.meta.url)).text()

    expect(source).toContain("onChange={setValue}")
    expect(source).toContain("onBlur={commit}")
    expect(source).toContain("if (event.key === \"Enter\")")
    expect(source).toContain("props.onCommit(value())")
    expect(source).not.toContain("onChange={(url) => updateManual")
  })

  test("is available in both settings surfaces", async () => {
    const dialog = await Bun.file(new URL("./dialog-settings.tsx", import.meta.url)).text()
    const page = await Bun.file(new URL("../pages/settings.tsx", import.meta.url)).text()

    expect(dialog).toContain('Tabs.Trigger value="proxy"')
    expect(dialog).toContain("<SettingsProxy />")
    expect(page).toContain('{ id: "proxy", icon: "globe", labelKey: "settings.proxy.title" }')
    expect(page).toContain("<SettingsProxy />")
  })
})
