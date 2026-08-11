import * as i18n from "@solid-primitives/i18n"
import { app } from "electron"
import { brandNameForLocale } from "@opencode-ai/brand"

import { dict as desktopEn } from "../renderer/i18n/en"
import { dict as desktopZh } from "../renderer/i18n/zh"
import { dict as desktopZht } from "../renderer/i18n/zht"
import { dict as desktopKo } from "../renderer/i18n/ko"
import { dict as desktopDe } from "../renderer/i18n/de"
import { dict as desktopEs } from "../renderer/i18n/es"
import { dict as desktopFr } from "../renderer/i18n/fr"
import { dict as desktopDa } from "../renderer/i18n/da"
import { dict as desktopJa } from "../renderer/i18n/ja"
import { dict as desktopPl } from "../renderer/i18n/pl"
import { dict as desktopRu } from "../renderer/i18n/ru"
import { dict as desktopAr } from "../renderer/i18n/ar"
import { dict as desktopNo } from "../renderer/i18n/no"
import { dict as desktopBr } from "../renderer/i18n/br"
import { dict as desktopBs } from "../renderer/i18n/bs"
import { dict as desktopTh } from "../renderer/i18n/th"
import { dict as desktopTr } from "../renderer/i18n/tr"

import { dict as appEn } from "../../../app/src/i18n/en"
import { dict as appZh } from "../../../app/src/i18n/zh"
import { dict as appZht } from "../../../app/src/i18n/zht"
import { dict as appKo } from "../../../app/src/i18n/ko"
import { dict as appDe } from "../../../app/src/i18n/de"
import { dict as appEs } from "../../../app/src/i18n/es"
import { dict as appFr } from "../../../app/src/i18n/fr"
import { dict as appDa } from "../../../app/src/i18n/da"
import { dict as appJa } from "../../../app/src/i18n/ja"
import { dict as appPl } from "../../../app/src/i18n/pl"
import { dict as appRu } from "../../../app/src/i18n/ru"
import { dict as appAr } from "../../../app/src/i18n/ar"
import { dict as appNo } from "../../../app/src/i18n/no"
import { dict as appBr } from "../../../app/src/i18n/br"
import { dict as appBs } from "../../../app/src/i18n/bs"
import { dict as appTh } from "../../../app/src/i18n/th"
import { dict as appTr } from "../../../app/src/i18n/tr"

import { getStore } from "./store"

export type Locale =
  | "en"
  | "zh"
  | "zht"
  | "ko"
  | "de"
  | "es"
  | "fr"
  | "da"
  | "ja"
  | "pl"
  | "ru"
  | "ar"
  | "no"
  | "br"
  | "th"
  | "bs"
  | "tr"

type RawDictionary = typeof appEn & typeof desktopEn
export type Dictionary = i18n.Flatten<RawDictionary>

const LOCALES: readonly Locale[] = [
  "en",
  "zh",
  "zht",
  "ko",
  "de",
  "es",
  "fr",
  "da",
  "ja",
  "pl",
  "ru",
  "ar",
  "no",
  "br",
  "th",
  "bs",
  "tr",
]

const localeMatchers: Array<{ locale: Locale; match: (language: string) => boolean }> = [
  { locale: "en", match: (language) => language.startsWith("en") },
  { locale: "zht", match: (language) => language.startsWith("zh") && language.includes("hant") },
  { locale: "zh", match: (language) => language.startsWith("zh") },
  { locale: "ko", match: (language) => language.startsWith("ko") },
  { locale: "de", match: (language) => language.startsWith("de") },
  { locale: "es", match: (language) => language.startsWith("es") },
  { locale: "fr", match: (language) => language.startsWith("fr") },
  { locale: "da", match: (language) => language.startsWith("da") },
  { locale: "ja", match: (language) => language.startsWith("ja") },
  { locale: "pl", match: (language) => language.startsWith("pl") },
  { locale: "ru", match: (language) => language.startsWith("ru") },
  { locale: "ar", match: (language) => language.startsWith("ar") },
  {
    locale: "no",
    match: (language) => language.startsWith("no") || language.startsWith("nb") || language.startsWith("nn"),
  },
  { locale: "br", match: (language) => language.startsWith("pt") },
  { locale: "th", match: (language) => language.startsWith("th") },
  { locale: "bs", match: (language) => language.startsWith("bs") },
  { locale: "tr", match: (language) => language.startsWith("tr") },
]

export function normalizeLocale(value: string): Locale {
  return LOCALES.includes(value as Locale) ? (value as Locale) : "en"
}

function detectLocaleFromSystem(): Locale {
  const language = app.getLocale().toLowerCase()
  const match = localeMatchers.find((entry) => entry.match(language))
  return match?.locale ?? "en"
}

let trayLocaleOverride: Locale | null = null

export function setTrayLocale(locale: string) {
  trayLocaleOverride = normalizeLocale(locale)
}

function parseLocale(value: unknown): Locale | null {
  if (!value) return null
  if (typeof value !== "string") return null
  if ((LOCALES as readonly string[]).includes(value)) return value as Locale
  return null
}

function parseRecord(value: unknown) {
  if (!value || typeof value !== "object") return null
  if (Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function parseStored(value: unknown) {
  if (typeof value !== "string") return value
  try {
    return JSON.parse(value) as unknown
  } catch {
    return value
  }
}

function pickLocale(value: unknown): Locale | null {
  const direct = parseLocale(value)
  if (direct) return direct

  const record = parseRecord(value)
  if (!record) return null

  return parseLocale(record.locale)
}

function readLocaleFromStore(): Locale | null {
  const current = getStore("opencode.global.dat").get("language")
  const legacy = current ? undefined : getStore().get("language.v1")
  const value = parseStored(current ?? legacy)
  return pickLocale(value)
}

export function readStoredLocale(): Locale {
  if (trayLocaleOverride) return trayLocaleOverride
  const fromStore = readLocaleFromStore()
  if (fromStore) return fromStore
  return detectLocaleFromSystem()
}

const base = i18n.flatten({ ...appEn, ...desktopEn })

function build(locale: Locale): Dictionary {
  if (locale === "en") return base
  if (locale === "zh") return { ...base, ...i18n.flatten(appZh), ...i18n.flatten(desktopZh) }
  if (locale === "zht") return { ...base, ...i18n.flatten(appZht), ...i18n.flatten(desktopZht) }
  if (locale === "de") return { ...base, ...i18n.flatten(appDe), ...i18n.flatten(desktopDe) }
  if (locale === "es") return { ...base, ...i18n.flatten(appEs), ...i18n.flatten(desktopEs) }
  if (locale === "fr") return { ...base, ...i18n.flatten(appFr), ...i18n.flatten(desktopFr) }
  if (locale === "da") return { ...base, ...i18n.flatten(appDa), ...i18n.flatten(desktopDa) }
  if (locale === "ja") return { ...base, ...i18n.flatten(appJa), ...i18n.flatten(desktopJa) }
  if (locale === "pl") return { ...base, ...i18n.flatten(appPl), ...i18n.flatten(desktopPl) }
  if (locale === "ru") return { ...base, ...i18n.flatten(appRu), ...i18n.flatten(desktopRu) }
  if (locale === "ar") return { ...base, ...i18n.flatten(appAr), ...i18n.flatten(desktopAr) }
  if (locale === "no") return { ...base, ...i18n.flatten(appNo), ...i18n.flatten(desktopNo) }
  if (locale === "br") return { ...base, ...i18n.flatten(appBr), ...i18n.flatten(desktopBr) }
  if (locale === "th") return { ...base, ...i18n.flatten(appTh), ...i18n.flatten(desktopTh) }
  if (locale === "bs") return { ...base, ...i18n.flatten(appBs), ...i18n.flatten(desktopBs) }
  if (locale === "tr") return { ...base, ...i18n.flatten(appTr), ...i18n.flatten(desktopTr) }
  return { ...base, ...i18n.flatten(appKo), ...i18n.flatten(desktopKo) }
}

export function createMainTranslator(locale = readStoredLocale()) {
  const dict = build(locale)
  const translate = i18n.translator(() => dict, i18n.resolveTemplate)
  return (key: keyof Dictionary, params?: Record<string, string | number>) =>
    translate(key, { appName: brandNameForLocale(locale), ...(params ?? {}) })
}
