import { describe, expect, test } from "bun:test"

import { buildMemoryRequestURL, memoryScopePayload } from "./settings-memory-helpers"

describe("settings memory", () => {
  test("is available in both settings surfaces", async () => {
    const dialog = await Bun.file(new URL("./dialog-settings.tsx", import.meta.url)).text()
    const page = await Bun.file(new URL("../pages/settings.tsx", import.meta.url)).text()

    expect(dialog).toContain('Tabs.Trigger value="memory"')
    expect(dialog).toContain("<SettingsMemory />")
    expect(page).toContain('{ id: "memory", icon: "brain", labelKey: "settings.memory.title" }')
    expect(page).toContain("<SettingsMemory />")
  })

  test("adds directory and session context to memory API calls", () => {
    const url = buildMemoryRequestURL("http://localhost:4096", "/memory", {
      directory: "/repo/app",
      sessionID: "ses_123",
      search: "tests",
      limit: 50,
    })

    expect(url).toBe("http://localhost:4096/memory?directory=%2Frepo%2Fapp&session=ses_123&search=tests&limit=50")
  })

  test("keeps global scope in memory API calls", () => {
    const url = buildMemoryRequestURL("http://localhost:4096", "/memory", {
      directory: "/repo/app",
      scope: "global",
    })

    expect(url).toBe("http://localhost:4096/memory?directory=%2Frepo%2Fapp&scope=global")
  })

  test("writes memory scope without the app project ID", () => {
    expect(memoryScopePayload("global")).toEqual({ scope: "global" })
    expect(memoryScopePayload("project")).toEqual({ scope: "project" })
  })

  test("uses index rows and fetches detail before editing", async () => {
    const component = await Bun.file(new URL("./settings-memory.tsx", import.meta.url)).text()

    expect(component).toContain("memory.title")
    expect(component).toContain("memory.summary")
    expect(component).toContain("request<MemoryDetail>(`/memory/${memory.id}`")
    expect(component).toContain("body: { document: form.content.trim() }")
    expect(component).not.toContain("memory.projectID")
  })

  test("requires a current session for processed creation", async () => {
    const component = await Bun.file(new URL("./settings-memory.tsx", import.meta.url)).text()

    expect(component).toContain("正在整理并保存")
    expect(component).toContain("sessionID: sessionID()")
    expect(component).toContain("() => !!sessionID()")
  })

  test("disables processed creation when global memory is not writable", async () => {
    const component = await Bun.file(new URL("./settings-memory.tsx", import.meta.url)).text()

    expect(component).toContain("const canCreate")
    expect(component).toContain('state.config.default_mode === "auto"')
    expect(component).toContain("disabled={!canCreate()}")
  })
})

describe("settings rules", () => {
  test("describes all automatic import locations", async () => {
    const zh = await Bun.file(new URL("../i18n/zh.ts", import.meta.url)).text()
    const en = await Bun.file(new URL("../i18n/en.ts", import.meta.url)).text()

    expect(zh).toContain("全局配置目录和项目根目录中的 AGENTS.md")
    expect(zh).toContain("用户目录和项目根目录中的 CLAUDE.md")
    expect(en).toContain("global config directory and project root")
    expect(en).toContain("user directory and project root")
  })

  test("is available below memory in both settings surfaces", async () => {
    const dialog = await Bun.file(new URL("./dialog-settings.tsx", import.meta.url)).text()
    const page = await Bun.file(new URL("../pages/settings.tsx", import.meta.url)).text()

    expect(dialog.indexOf('Tabs.Trigger value="rules"')).toBeGreaterThan(dialog.indexOf('Tabs.Trigger value="memory"'))
    expect(dialog).toContain("<SettingsRules />")
    expect(page.indexOf('{ id: "rules",')).toBeGreaterThan(page.indexOf('{ id: "memory",'))
    expect(page).toContain("<SettingsRules />")
  })

  test("exposes independent imports and rule management", async () => {
    const component = await Bun.file(new URL("./settings-rules.tsx", import.meta.url)).text()

    expect(component).toContain("instruction_import")
    expect(component).toContain("agents_md")
    expect(component).toContain("claude_md")
    expect(component).toContain("config().rules")
    expect(component).toContain("createRule")
    expect(component).toContain("updateRule")
    expect(component).toContain("deleteRule")
  })

  test("updates config through query ownership without mutating the global store", async () => {
    const component = await Bun.file(new URL("./settings-rules.tsx", import.meta.url)).text()

    expect(component).not.toContain('globalSync.set("config"')
    expect(component).toContain("globalSync.config.error")
    expect(component).toContain("globalSync.config.refetch")
    expect(component).toContain("disabled={globalSync.config.loading || globalSync.config.error || !!state.saving}")
    expect(component).toContain('queryClient.setQueryData<Config>(["config"]')
  })

  test("deduplicates concurrent saves with saveGen counter", async () => {
    const component = await Bun.file(new URL("./settings-rules.tsx", import.meta.url)).text()

    expect(component).toContain("saveGen")
    expect(component).toContain("Map<string, number>")
    expect(component).toContain("saveGen.get(saving) !== gen")
  })

  test("closes rule form only after successful save", async () => {
    const component = await Bun.file(new URL("./settings-rules.tsx", import.meta.url)).text()

    expect(component).toContain("await save(")
    expect(component).toContain('setState("form", undefined)')
    // form close must be inside try block after await save
    const asyncIndex = component.indexOf("async function saveRule")
    const tryIndex = component.indexOf("try {", asyncIndex)
    const awaitIndex = component.indexOf("await save(", asyncIndex)
    const setFormIndex = component.indexOf('setState("form", undefined)', asyncIndex)
    const catchIndex = component.indexOf("catch", asyncIndex)
    expect(tryIndex).toBeLessThan(awaitIndex)
    expect(awaitIndex).toBeLessThan(setFormIndex)
    expect(setFormIndex).toBeLessThan(catchIndex)
  })
})
