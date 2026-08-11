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
import { dict as tr } from "./tr"
import { dict as zh } from "./zh"
import { dict as zht } from "./zht"

const locales = { ar, br, bs, da, de, es, fr, ja, ko, no, pl, ru, th, tr, zh, zht }

const questionKeys = [
  "ui.question.multiHint.selected",
  "ui.question.badge.selected",
  "ui.question.badge.recommended",
  "ui.question.action.skip",
] as const

describe("ui i18n question keys", () => {
  test("english defines every question panel key", () => {
    for (const key of questionKeys) {
      expect(en[key]).toBeDefined()
    }
  })

  test("every locale translates the question panel keys", () => {
    for (const [name, locale] of Object.entries(locales)) {
      for (const key of questionKeys) {
        expect(locale[key], `${name} missing ${key}`).toBeDefined()
        expect(locale[key], `${name} left ${key} untranslated`).not.toBe(en[key])
      }
    }
  })
})
