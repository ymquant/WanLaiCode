import { describe, expect, test } from "bun:test"

describe("automation page", () => {
  test("renders empty state with title, top actions and three templates", async () => {
    const src = await Bun.file(new URL("./index.tsx", import.meta.url)).text()
    expect(src).toContain('language.t("automation.title")')
    expect(src).toContain('language.t("automation.subtitle")')
    expect(src).toContain('language.t("automation.empty.title")')
    expect(src).toContain('language.t("automation.viewTemplates")')
    expect(src).toContain('language.t("automation.createViaChat")')
    expect(src).toContain('language.t("automation.createManually")')
    expect(src).toContain("automation.template.dailyBrief")
    expect(src).toContain("automation.template.weeklyReview")
    expect(src).toContain("automation.template.projectMonitor")
  })

  test("renders the three template suggestions below populated automation lists", async () => {
    const src = await Bun.file(new URL("./index.tsx", import.meta.url)).text()
    expect(src).toContain('language.t("automation.suggestions.title")')
    expect(src).toContain("cdx-suggestion-list")
    expect(src).toContain("automation.suggestion.dailyBrief.description")
    expect(src).toContain("automation.suggestion.weeklyReview.description")
    expect(src).toContain("automation.suggestion.projectMonitor.description")
    expect(src).toContain("openEditorFromPresetKey(suggestion.titleKey)")
    expect(src.indexOf("cdx-suggestion-list")).toBeGreaterThan(src.indexOf("pausedList"))
  })

  // 侧栏「自动化」区靠根级 provider 的目录集合发现不属于任何项目的隐藏目录。
  // 任何改动自动化配置的写操作若只刷新本页 resource,侧栏就要等 60s 兜底轮询才跟上。
  test("增删改都同时刷新本页资源与根级 provider", async () => {
    for (const file of ["./index.tsx", "./detail.tsx"]) {
      const src = await Bun.file(new URL(file, import.meta.url)).text()
      expect(src, `${file} 缺少 refresh 辅助`).toMatch(
        /async function refresh\(\)\s*\{\s*await refetch\(\)\s*automationSessions\?\.refetch\(\)\s*\}/,
      )
      // 写操作收尾不允许只刷新本页 resource
      expect(src.includes("await refetch()\n  }"), `${file} 仍有只刷新本页的写操作`).toBe(false)
    }

    const index = await Bun.file(new URL("./index.tsx", import.meta.url)).text()
    expect(index).not.toContain("onCreated={() => refetch()}")

    const detail = await Bun.file(new URL("./detail.tsx", import.meta.url)).text()
    expect(detail).toMatch(/automation\.remove\([^)]*\)\s*automationSessions\?\.refetch\(\)/)
  })
})
