import { fileUrlFromAbsolutePath, isHtmlFilePath, isSystemBrowserModifier } from "./markdown-local-path"

export function resolveEditActivityFileClick(input: {
  absolutePath: string
  ctrlKey?: boolean
  metaKey?: boolean
  canOpenExternal: boolean
  canOpenSystem: boolean
  platform?: { isMac?: boolean }
}) {
  if (!isHtmlFilePath(input.absolutePath)) return undefined
  if (isSystemBrowserModifier(input, input.platform)) {
    if (input.canOpenSystem) return { type: "system" as const, value: fileUrlFromAbsolutePath(input.absolutePath) }
    return undefined
  }
  if (input.canOpenExternal) return { type: "builtin" as const, value: fileUrlFromAbsolutePath(input.absolutePath) }
  return undefined
}
