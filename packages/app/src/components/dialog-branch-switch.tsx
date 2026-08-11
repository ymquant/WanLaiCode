import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { DiffChanges } from "@opencode-ai/ui/diff-changes"
import { showToast } from "@opencode-ai/ui/toast"
import { createSignal, For } from "solid-js"
import { DialogCommit } from "@/components/dialog-commit"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { formatServerError } from "@/utils/server-errors"

export type BranchSwitchChange = {
  file: string
  additions: number
  deletions: number
}

export function branchSwitchErrorMessage(
  err: unknown,
  translate?: (key: string, vars?: Record<string, string | number>) => string,
) {
  return formatServerError(err, translate, "")
}

/** Git 仅在本地修改会被目标分支检出覆盖时拒绝 switch。 */
export function branchSwitchWouldOverwrite(message: string) {
  return /would be overwritten|会被.+覆盖|local changes to the following files/i.test(message)
}

export function parseBranchSwitchOverwriteFiles(message: string) {
  const lines = message.split("\n")
  const files: string[] = []
  let inList = false
  for (const line of lines) {
    if (branchSwitchWouldOverwrite(line)) {
      inList = true
      continue
    }
    if (!inList) continue
    const trimmed = line.trim()
    if (!trimmed) break
    if (/^(please|请先)/i.test(trimmed)) break
    if (trimmed.startsWith("error:")) continue
    files.push(trimmed)
  }
  return files
}

export function isBranchSwitchOverwriteError(
  err: unknown,
  translate?: (key: string, vars?: Record<string, string | number>) => string,
) {
  return branchSwitchWouldOverwrite(branchSwitchErrorMessage(err, translate))
}

export interface DialogBranchSwitchProps {
  targetBranch: string
  changes: BranchSwitchChange[]
  onSwitched: () => void
}

export function DialogBranchSwitch(props: DialogBranchSwitchProps) {
  const dialog = useDialog()
  const language = useLanguage()
  const sdk = useSDK()
  const [busy, setBusy] = createSignal(false)

  const switchBranch = async () => {
    await sdk.client.vcs.switchBranch({ vcsSwitchBranchInput: { name: props.targetBranch } })
    props.onSwitched()
    dialog.close()
  }

  const openCommit = () => {
    dialog.show(() => (
      <DialogCommit
        onCommitted={() => {
          if (busy()) return
          setBusy(true)
          void switchBranch()
            .catch((err: unknown) => {
              const detail = formatServerError(err, language.t, language.t("common.requestFailed"))
              showToast({ title: language.t("session.new.worktree.switchFailed"), description: detail })
            })
            .finally(() => setBusy(false))
        }}
      />
    ))
  }

  return (
    <Dialog
      fit
      title={language.t("dialog.branch.switch.title")}
      class="codex-dialog codex-dialog-narrow dialog-branch-switch mx-auto !min-h-0"
    >
      <div class="codex-dialog-narrow flex flex-col gap-2 px-5 pt-0 pb-5">
        <p class="text-13-regular leading-5 text-text-weak">{language.t("dialog.branch.switch.overwriteWarning")}</p>
        <div
          data-slot="dialog-branch-switch-files"
          class="flex max-h-24 flex-col gap-1 overflow-y-auto text-13-regular leading-5 text-text-strong"
        >
          <For each={props.changes}>
            {(change) => (
              <div class="inline-flex min-h-5 max-w-full items-center gap-1.5">
                <span class="truncate">{change.file}</span>
                <DiffChanges
                  class="shrink-0"
                  changes={{ additions: change.additions, deletions: change.deletions }}
                />
              </div>
            )}
          </For>
        </div>
        <p class="text-13-regular leading-5 text-text-weak">{language.t("dialog.branch.switch.commitHint")}</p>
        <div data-slot="dialog-branch-switch-actions" class="flex items-center justify-end gap-2 pt-1">
          <Button
            type="button"
            variant="ghost"
            size="large"
            class="dialog-branch-switch-cancel"
            disabled={busy()}
            onClick={() => dialog.close()}
          >
            {language.t("dialog.branch.switch.action.cancel")}
          </Button>
          <Button
            type="button"
            variant="primary"
            size="large"
            class="dialog-branch-switch-primary !border-transparent !shadow-none"
            disabled={busy()}
            onClick={openCommit}
          >
            {language.t("dialog.branch.switch.action.commitAndSwitch", { branch: props.targetBranch })}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
