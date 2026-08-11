import type { AppIconProps } from "@opencode-ai/ui/app-icon"
import { fileManagerInfo } from "./file-manager"
import { knownOpenerOverride } from "./project-openers"
import type { InstalledOpener, Platform } from "@/context/platform"

export const REVEAL_IN_FOLDER_OPENER_ID = "reveal-in-folder"

export type PathOpenerItem = {
  id: string
  label: string
  icon: { type: "app"; id: AppIconProps["id"] } | { type: "image"; src: string } | { type: "icon"; name: "open-file" }
  onSelect: () => Promise<void> | void
}

export function createPathOpenerItems(input: {
  path: string
  openers: InstalledOpener[]
  platform: Pick<Platform, "os" | "openPath" | "invokeOpener" | "showItemInFolder">
  t: (key: string, params?: Record<string, string>) => string
  includeTerminals?: boolean
  onSelectOpener?: (opener: InstalledOpener) => void
}) {
  const openers = input.includeTerminals === false
    ? input.openers.filter((item) => item.kind !== "terminal")
    : input.openers
  const items = openers.map((item) => {
    const override = knownOpenerOverride({ bundleId: item.bundleId, app: item.app, name: item.name })
    const label = override.labelKey ? input.t(override.labelKey) : item.name
    return {
      id: item.id,
      label,
      icon: override.iconId
        ? { type: "app", id: override.iconId }
        : item.iconDataUrl
          ? { type: "image", src: item.iconDataUrl }
          : { type: "icon", name: "open-file" },
      onSelect: () =>
        {
          // 通过文件菜单选择编辑器时同步默认偏好，保证顶部按钮、附件卡片和右键菜单下一次都用同一个编辑器。
          input.onSelectOpener?.(item)
          return input.platform.invokeOpener
            ? input.platform.invokeOpener(item, input.path)
            : input.platform.openPath?.(input.path, item.app)
        },
    } as const
  })
  const fm = fileManagerInfo(input.platform.os)
  if (!input.platform.showItemInFolder) return items
  return [
    ...items,
    {
      id: REVEAL_IN_FOLDER_OPENER_ID,
      label: input.t("command.file.revealInFinder", { name: input.t(fm.nameKey) }),
      icon: { type: "app", id: fm.iconId } as const,
      onSelect: () => input.platform.showItemInFolder?.(input.path),
    },
  ]
}
