import { Component, createSignal } from "solid-js"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useLanguage } from "@/context/language"

export const DialogForkFromMessage: Component<{
  onForkLocal: () => void | Promise<void>
  /** 派生到新 git worktree 的处理函数；未传则按钮禁用 */
  onForkWorktree?: () => void | Promise<void>
}> = (props) => {
  const language = useLanguage()
  const dialog = useDialog()
  const [busy, setBusy] = createSignal(false)

  const choose = async (act: () => void | Promise<void>) => {
    if (busy()) return
    setBusy(true)
    dialog.close()
    try {
      await act()
    } finally {
      setBusy(false)
    }
  }

  const worktreeAvailable = !!props.onForkWorktree

  // 不用 Dialog 自带 title/description——Codex 风格弹窗需要：左上 icon 角标 + 标题 + 描述 + 选项卡 + 底部取消，结构与默认 header 不一致
  return (
    <Dialog size="normal">
      <div data-component="dialog-fork-from-message">
        <div data-slot="dialog-fork-header-icon">
          <Icon name="git-branch" size="normal" />
        </div>
        <h2 data-slot="dialog-fork-title">{language.t("dialog.fork.title")}</h2>
        <p data-slot="dialog-fork-description">{language.t("dialog.fork.description")}</p>
        <div data-slot="dialog-fork-options">
          <button
            type="button"
            data-slot="dialog-fork-option"
            disabled={busy()}
            onClick={() => void choose(props.onForkLocal)}
          >
            <span data-slot="dialog-fork-option-icon">
              <Icon name="laptop" size="medium" />
            </span>
            <span data-slot="dialog-fork-option-body">
              <span data-slot="dialog-fork-option-title">{language.t("sidebar.thread.menu.forkLocal")}</span>
              <span data-slot="dialog-fork-option-desc">{language.t("dialog.fork.local.description")}</span>
            </span>
          </button>
          <button
            type="button"
            data-slot="dialog-fork-option"
            data-secondary=""
            data-disabled={worktreeAvailable ? undefined : ""}
            disabled={!worktreeAvailable || busy()}
            aria-disabled={!worktreeAvailable}
            title={worktreeAvailable ? undefined : language.t("dialog.fork.worktree.unavailable")}
            onClick={() => props.onForkWorktree && void choose(props.onForkWorktree)}
          >
            <span data-slot="dialog-fork-option-icon">
              <Icon name="fork-split" size="medium" />
            </span>
            <span data-slot="dialog-fork-option-body">
              <span data-slot="dialog-fork-option-title">{language.t("sidebar.thread.menu.forkWorktree")}</span>
              <span data-slot="dialog-fork-option-desc">{language.t("dialog.fork.worktree.description")}</span>
            </span>
          </button>
        </div>
        <button
          type="button"
          data-slot="dialog-fork-cancel"
          disabled={busy()}
          onClick={() => dialog.close()}
        >
          {language.t("common.cancel")}
        </button>
      </div>
    </Dialog>
  )
}
