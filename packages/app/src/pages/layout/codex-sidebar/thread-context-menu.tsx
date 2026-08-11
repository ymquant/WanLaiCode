import type { Accessor, JSX } from "solid-js"
import { ContextMenu } from "@opencode-ai/ui/context-menu"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { fileManagerInfo } from "@/utils/file-manager"

export type ThreadMenuActions = {
  isPinned: Accessor<boolean>
  onTogglePin: () => void
  onRename: () => void
  onArchive: () => void
  onRevealInFinder: () => void
  onCopyDirectory: () => void
  onCopyId: () => void
  onCopyLink: () => void
}

// Codex 风格 thread 右键菜单
// 注：mark-unread / fork-local / fork-worktree / open-mini 暂未接入后端流程，先不放出来，待能力就绪再补
export const ThreadContextMenuContent = (props: ThreadMenuActions): JSX.Element => {
  const language = useLanguage()
  const platform = usePlatform()
  const fmName = () => language.t(fileManagerInfo(platform.os).nameKey)
  return (
    <ContextMenu.Content>
      <ContextMenu.Item onSelect={props.onTogglePin}>
        <ContextMenu.ItemLabel>
          {props.isPinned() ? language.t("sidebar.thread.menu.unpin") : language.t("sidebar.thread.menu.pin")}
        </ContextMenu.ItemLabel>
      </ContextMenu.Item>
      <ContextMenu.Item onSelect={props.onRename}>
        <ContextMenu.ItemLabel>{language.t("sidebar.thread.menu.rename")}</ContextMenu.ItemLabel>
      </ContextMenu.Item>
      <ContextMenu.Item onSelect={props.onArchive}>
        <ContextMenu.ItemLabel>{language.t("sidebar.thread.menu.archive")}</ContextMenu.ItemLabel>
      </ContextMenu.Item>

      <ContextMenu.Separator />

      <ContextMenu.Item onSelect={props.onRevealInFinder}>
        <ContextMenu.ItemLabel>
          {language.t("sidebar.thread.menu.revealInFinder", { name: fmName() })}
        </ContextMenu.ItemLabel>
      </ContextMenu.Item>
      <ContextMenu.Item onSelect={props.onCopyDirectory}>
        <ContextMenu.ItemLabel>{language.t("sidebar.thread.menu.copyDirectory")}</ContextMenu.ItemLabel>
      </ContextMenu.Item>
      <ContextMenu.Item onSelect={props.onCopyId}>
        <ContextMenu.ItemLabel>{language.t("sidebar.thread.menu.copyId")}</ContextMenu.ItemLabel>
      </ContextMenu.Item>
      <ContextMenu.Item onSelect={props.onCopyLink}>
        <ContextMenu.ItemLabel>{language.t("sidebar.thread.menu.copyLink")}</ContextMenu.ItemLabel>
      </ContextMenu.Item>
    </ContextMenu.Content>
  )
}
