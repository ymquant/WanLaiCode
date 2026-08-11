import { describe, expect, test } from "bun:test"
import * as i18n from "@solid-primitives/i18n"
import { brandNameForLocale } from "@opencode-ai/brand"
import { dict as en } from "./en"
import { dict as zh } from "./zh"

// These tests exercise the same wiring used by packages/app/src/context/language.tsx:
// inject `appName = brandNameForLocale(locale)` as a default param so values
// that contain the {{appName}} placeholder resolve to the active brand name
// in the active locale.

const renderEn = i18n.translator(() => i18n.flatten(en), i18n.resolveTemplate)
const renderZh = i18n.translator(() => i18n.flatten(zh), i18n.resolveTemplate)

function tEn(key: keyof typeof en) {
  return renderEn(key, { appName: brandNameForLocale("en") })
}

function tZh(key: keyof typeof zh) {
  return renderZh(key, { appName: brandNameForLocale("zh") })
}

describe("i18n appName placeholder", () => {
  test("EN locale renders the EN brand name (default brand: wanlai → 'WanLaiCode')", () => {
    const rendered = tEn("dialog.model.unpaid.wanlaicodeModels.title")
    expect(rendered).not.toContain("{{appName}}")
    // The default brand is 'wanlai' unless WANLAICODE_BRAND/VITE_BRAND is overridden.
    // For 'wanlai' EN that is "WanLaiCode"; for 'codex' EN that is "Codex (Wanlai)".
    expect(rendered).toContain(brandNameForLocale("en"))
  })

  test("zh locale renders the CN brand name (default brand: wanlai → '万来Code')", () => {
    const rendered = tZh("dialog.model.unpaid.wanlaicodeModels.title")
    expect(rendered).not.toContain("{{appName}}")
    expect(rendered).toContain(brandNameForLocale("zh"))
  })

  test("brandNameForLocale routes zh-* variants to the CN name", () => {
    expect(brandNameForLocale("zh")).toBe(brandNameForLocale("zh-Hans"))
    expect(brandNameForLocale("zh-Hant")).toBe(brandNameForLocale("zh"))
    expect(brandNameForLocale("en")).not.toBe(brandNameForLocale("zh"))
  })

  test("login.wanlaicode.title (welcome) resolves with the active brand", () => {
    const rendered = tEn("login.wanlaicode.title")
    expect(rendered).not.toContain("{{appName}}")
    expect(rendered).toContain(brandNameForLocale("en"))
  })
})
