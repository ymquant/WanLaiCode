import type { Locale } from "@/context/language"

const slashes: Record<Locale, string> = {
  en: "goal",
  zh: "目标",
  zht: "目標",
  ko: "목표",
  de: "ziel",
  es: "objetivo",
  fr: "objectif",
  da: "mål",
  ja: "目標",
  pl: "cel",
  ru: "цель",
  ar: "هدف",
  no: "mål",
  br: "objetivo",
  th: "เป้าหมาย",
  bs: "cilj",
  tr: "hedef",
}

export const goalSlashForLocale = (locale: Locale) => {
  return slashes[locale]
}

export const goalSlashAliasesForLocale = (locale: Locale) => {
  const current = goalSlashForLocale(locale)
  return ["goal", "目标", "目標"].filter((slash) => slash !== current)
}
