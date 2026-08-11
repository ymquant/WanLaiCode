import { describe, expect, test } from "bun:test"
import { pluginCategoryKey, pluginCategoryLabel } from "./plugin-category"
import { dict as en } from "../i18n/en"
import { dict as zh } from "../i18n/zh"
import { dict as zht } from "../i18n/zht"

// 用 key 本身当「翻译」,方便断言命中了哪个 i18n key。
const echo = (key: string) => `t:${key}`

describe("pluginCategoryKey", () => {
  test("maps a known category to its i18n key", () => {
    expect(pluginCategoryKey("Developer Tools")).toBe("plugins.category.developerTools")
  })

  test("normalizes case and surrounding whitespace", () => {
    expect(pluginCategoryKey("  design  ")).toBe("plugins.category.design")
  })

  test("matches compound categories containing &", () => {
    expect(pluginCategoryKey("Business & Operations")).toBe("plugins.category.business")
    expect(pluginCategoryKey("Data & Analytics")).toBe("plugins.category.dataAnalytics")
    expect(pluginCategoryKey("Education & Research")).toBe("plugins.category.education")
  })

  test("returns undefined for an unknown category", () => {
    expect(pluginCategoryKey("Knitting")).toBeUndefined()
  })
})

describe("pluginCategoryLabel", () => {
  test("translates a known category through the provided translator", () => {
    expect(pluginCategoryLabel("Design", echo)).toBe("t:plugins.category.design")
  })

  test("falls back to the original text for an unknown category", () => {
    expect(pluginCategoryLabel("Knitting", echo)).toBe("Knitting")
  })

  test("preserves the original casing of the fallback text", () => {
    expect(pluginCategoryLabel("My Custom Bucket", echo)).toBe("My Custom Bucket")
  })
})

// 用户实际会遇到的分类全集 —— 取自官方 registry(plugin.wanlai.ai)与历史 marketplace
// 真实数据(2026-06 抓取)。新分类出现时回退英文不会崩,但应在此补齐并加翻译。
const REAL_CATEGORIES = [
  "Business & Operations",
  "Communication",
  "Creativity",
  "Data & Analytics",
  "Design",
  "Developer Tools",
  "Education & Research",
  "Engineering",
  "Finance",
  "Lifestyle",
  "Other",
  "Productivity",
  "Research",
  "Security",
  "Travel",
] as const

describe("known plugin categories are fully localized", () => {
  const dicts: Record<string, Record<string, string>> = {
    en: en as Record<string, string>,
    zh: zh as Record<string, string>,
    zht: zht as Record<string, string>,
  }
  for (const category of REAL_CATEGORIES) {
    test(`"${category}" maps to a key translated in en/zh/zht`, () => {
      const key = pluginCategoryKey(category)
      expect(key).toBeDefined()
      for (const [locale, dict] of Object.entries(dicts)) {
        expect(dict[key!], `${locale} missing ${key}`).toBeTruthy()
      }
    })
  }
})
