import { brandNameForLocale } from "@opencode-ai/brand"

import { CHANNEL } from "./constants"
import { readStoredLocale } from "./i18n"

export function trayTooltip() {
  const name = brandNameForLocale(readStoredLocale())
  if (CHANNEL === "dev") return `${name} Dev`
  if (CHANNEL === "beta") return `${name} Beta`
  return name
}
