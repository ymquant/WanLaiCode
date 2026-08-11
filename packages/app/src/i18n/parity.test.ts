import { describe, expect, test } from "bun:test"
import { dict as en } from "./en"
import { dict as ar } from "./ar"
import { dict as br } from "./br"
import { dict as bs } from "./bs"
import { dict as da } from "./da"
import { dict as de } from "./de"
import { dict as es } from "./es"
import { dict as fr } from "./fr"
import { dict as ja } from "./ja"
import { dict as ko } from "./ko"
import { dict as no } from "./no"
import { dict as pl } from "./pl"
import { dict as ru } from "./ru"
import { dict as th } from "./th"
import { dict as zh } from "./zh"
import { dict as zht } from "./zht"
import { dict as tr } from "./tr"
import { dict as uiEn } from "@opencode-ai/ui/i18n/en"
import { dict as uiZh } from "@opencode-ai/ui/i18n/zh"
import { dict as uiZht } from "@opencode-ai/ui/i18n/zht"

const locales = [ar, br, bs, da, de, es, fr, ja, ko, no, pl, ru, th, tr, zh, zht]
const keys = ["command.session.previous.unseen", "command.session.next.unseen"] as const
const pluginPublishKeys = [
  "plugins.hero.tryInChat",
  "plugins.skills.search.placeholder",
  "plugins.skills.enable",
  "plugins.skills.disable",
  "plugins.skills.error.load",
  "plugins.skills.empty.title",
  "plugins.skills.empty.description",
  "plugins.skills.empty.search",
  "plugins.skills.create.button",
  "plugins.skills.badge.builtin",
  "plugins.install",
  "plugins.migrate",
  "plugins.migrate.failed",
  "plugins.migrate.success",
  "plugins.migrate.title",
  "plugins.migrate.tooltip",
  "plugins.uninstall.failed",
  "plugins.detail.uninstall",
  "plugins.detail.upload.action",
  "plugins.detail.upload.uploading",
  "plugins.detail.upload.success",
  "plugins.detail.upload.failed",
  "plugins.detail.versions.title",
  "plugins.detail.versions.manage",
  "plugins.detail.versions.loading",
  "plugins.detail.versions.count",
  "plugins.detail.versions.empty",
  "plugins.detail.versions.meta",
  "plugins.detail.versions.delete",
  "plugins.detail.versions.deleteSuccess",
  "plugins.detail.versions.deleteFailed",
  "plugins.detail.versions.openFailed",
  "plugins.detail.versions.deleteConfirm.title",
  "plugins.detail.versions.deleteConfirm.description",
  "plugins.detail.stats.installs",
  "plugins.detail.includes.skill",
] as const
const registryModalKeys = [
  "plugins.namespace.dialog.title",
  "plugins.namespace.dialog.description",
  "plugins.namespace.dialog.immutable",
  "plugins.namespace.dialog.placeholder",
  "plugins.namespace.dialog.action",
  "plugins.namespace.dialog.failed",
  "plugins.namespace.dialog.noSpaces",
  "plugins.namespace.created",
  "plugins.namespace.checkFailed",
  "plugins.published.title",
  "plugins.published.namespace",
  "plugins.published.namespaceNotSet",
  "plugins.published.setNamespace",
  "plugins.published.namespaceMissing",
  "plugins.published.empty",
  "plugins.published.noVersion",
  "plugins.published.downloads",
  "plugins.published.delete.action",
  "plugins.published.delete.success",
  "plugins.published.delete.failed",
  "plugins.published.delete.confirm.title",
  "plugins.published.delete.confirm.description",
] as const

describe("i18n parity", () => {
  test("non-English locales translate targeted unseen session keys", () => {
    for (const locale of locales) {
      for (const key of keys) {
        expect(locale[key]).toBeDefined()
        expect(locale[key]).not.toBe(en[key])
      }
    }
  })

  test("zht translates plugin publish and version management keys", () => {
    for (const key of pluginPublishKeys) {
      expect(zht[key]).toBeDefined()
      expect(zht[key]).not.toBe(en[key])
    }
  })

  test("all app locales define registry namespace and published plugin modal keys", () => {
    for (const locale of locales) {
      for (const key of registryModalKeys) {
        expect(locale[key]).toBeDefined()
      }
    }
  })

  test("registry namespace labels use lowercase namespace", () => {
    for (const locale of [en, ...locales]) {
      for (const key of registryModalKeys) {
        expect(locale[key]).not.toContain("Namespace")
      }
    }
  })
})

// 错误码契约文案在 app（ErrorActionView）与 ui（session-turn）各存一份；
// 抽 shared 成本高，改用对比测试防止两端 errors.* key 漂移（新增/改 category 时漏改一边会失败）。
function errorKeys(dict: Record<string, string>, prefix: string): string[] {
  return Object.keys(dict)
    .filter((k) => k.startsWith(prefix))
    .sort()
}

describe("errors.* i18n app↔ui 同步", () => {
  test("errors.category.* key 集合在 app 与 ui 一致（en）", () => {
    expect(errorKeys(en, "errors.category.")).toEqual(errorKeys(uiEn, "errors.category."))
  })
  test("errors.action.* key 集合在 app 与 ui 一致（en）", () => {
    expect(errorKeys(en, "errors.action.")).toEqual(errorKeys(uiEn, "errors.action."))
  })
  test("errors.category.* key 集合在 app 与 ui 一致（zh）", () => {
    expect(errorKeys(zh, "errors.category.")).toEqual(errorKeys(uiZh, "errors.category."))
  })
  test("errors.action.* key 集合在 app 与 ui 一致（zh）", () => {
    expect(errorKeys(zh, "errors.action.")).toEqual(errorKeys(uiZh, "errors.action."))
  })
  test("errors.category.* key 集合在 app 与 ui 一致（zht）", () => {
    expect(errorKeys(zht, "errors.category.")).toEqual(errorKeys(uiZht, "errors.category."))
  })
  test("errors.action.* key 集合在 app 与 ui 一致（zht）", () => {
    expect(errorKeys(zht, "errors.action.")).toEqual(errorKeys(uiZht, "errors.action."))
  })
  test("每个 locale 内部 en/zh 的 errors.* key 一致（无单语言遗漏）", () => {
    expect(errorKeys(en, "errors.")).toEqual(errorKeys(zh, "errors."))
    expect(errorKeys(en, "errors.")).toEqual(errorKeys(zht, "errors."))
    expect(errorKeys(uiEn, "errors.")).toEqual(errorKeys(uiZh, "errors."))
    expect(errorKeys(uiEn, "errors.")).toEqual(errorKeys(uiZht, "errors."))
  })
})
