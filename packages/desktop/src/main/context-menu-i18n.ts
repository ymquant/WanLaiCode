import type { Labels } from "electron-context-menu"

import { createMainTranslator, normalizeLocale } from "./i18n"

export const contextMenuLabels: Labels = {}

export function refreshContextMenuLabels(locale?: string) {
  const t = createMainTranslator(locale ? normalizeLocale(locale) : undefined)
  Object.assign(contextMenuLabels, {
    saveImageAs: t("desktop.contextMenu.saveImageAs"),
    copyImage: t("desktop.contextMenu.copyImage"),
    inspect: t("desktop.contextMenu.inspect"),
  })
}
