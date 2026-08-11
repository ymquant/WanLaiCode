import type { Accessor, JSX } from "solid-js"
import { ContextMenu } from "@opencode-ai/ui/context-menu"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { fileManagerInfo } from "@/utils/file-manager"

export type ProjectMenuActions = {
  isPinned: Accessor<boolean>
  hasActiveThread: Accessor<boolean>
  onTogglePin: () => void
  onRevealInFinder: () => void
  onCreateWorktree: () => void
  onRename: () => void
  onArchiveActive: () => void
  onRemove: () => void
}

// Codex 风格 6 项 project 菜单内容
export const ProjectContextMenuContent = (props: ProjectMenuActions): JSX.Element => {
  const language = useLanguage()
  const platform = usePlatform()
  const fmName = () => language.t(fileManagerInfo(platform.os).nameKey)
  return (
    <ContextMenu.Content>
      <ContextMenu.Item onSelect={props.onTogglePin}>
        <ContextMenu.ItemLabel>
          {props.isPinned() ? language.t("sidebar.project.menu.unpin") : language.t("sidebar.project.menu.pin")}
        </ContextMenu.ItemLabel>
      </ContextMenu.Item>
      <ContextMenu.Item onSelect={props.onRevealInFinder}>
        <ContextMenu.ItemLabel>
          {language.t("sidebar.project.menu.revealInFinder", { name: fmName() })}
        </ContextMenu.ItemLabel>
      </ContextMenu.Item>
      <ContextMenu.Item onSelect={props.onCreateWorktree}>
        <ContextMenu.ItemLabel>{language.t("sidebar.project.menu.createWorktree")}</ContextMenu.ItemLabel>
      </ContextMenu.Item>
      <ContextMenu.Item onSelect={props.onRename}>
        <ContextMenu.ItemLabel>{language.t("sidebar.project.menu.rename")}</ContextMenu.ItemLabel>
      </ContextMenu.Item>
      <ContextMenu.Item disabled={!props.hasActiveThread()} onSelect={props.onArchiveActive}>
        <ContextMenu.ItemLabel>{language.t("sidebar.project.menu.archiveActive")}</ContextMenu.ItemLabel>
      </ContextMenu.Item>
      <ContextMenu.Separator />
      <ContextMenu.Item onSelect={props.onRemove}>
        <ContextMenu.ItemLabel>{language.t("sidebar.project.menu.remove")}</ContextMenu.ItemLabel>
      </ContextMenu.Item>
    </ContextMenu.Content>
  )
}
