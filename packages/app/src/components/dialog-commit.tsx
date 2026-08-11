import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { Switch } from "@opencode-ai/ui/switch"
import { TextField } from "@opencode-ai/ui/text-field"
import { showToast } from "@opencode-ai/ui/toast"
import type { VcsFileDiff } from "@opencode-ai/sdk/v2"
import { createMemo, createSignal, onMount, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { formatServerError } from "@/utils/server-errors"
import {
  commitDiffFiles,
  commitHasChanges,
  commitNoChangesMessage,
  diffStats,
} from "@/utils/git-commit-diff"
import { envBranchIconProps } from "@/components/session-details-card-git-ops"
import { GitGenerateButton } from "@/components/git-generate-button"

export interface DialogCommitProps {
  onCommitted?: (hash: string) => void
}

export function DialogCommit(props: DialogCommitProps) {
  const dialog = useDialog()
  const language = useLanguage()
  const sdk = useSDK()
  const sync = useSync()

  const [message, setMessage] = createSignal("")
  const [stageAll, setStageAll] = createSignal(true)
  const [submitting, setSubmitting] = createSignal(false)
  const [generating, setGenerating] = createSignal(false)
  const [unstagedDiff, setUnstagedDiff] = createSignal<VcsFileDiff[]>([])
  const [stagedDiff, setStagedDiff] = createSignal<VcsFileDiff[]>([])

  const branchName = createMemo(() => sync.data.vcs?.branch ?? sync.data.vcs?.default_branch ?? "main")

  onMount(() => {
    void Promise.all([sdk.client.vcs.diff({ mode: "unstaged" }), sdk.client.vcs.diff({ mode: "staged" })])
      .then(([unstaged, staged]) => {
        setUnstagedDiff(unstaged.data ?? [])
        setStagedDiff(staged.data ?? [])
      })
      .catch(() => undefined)
  })

  const commitScope = createMemo(() =>
    commitDiffFiles({
      stageAll: stageAll(),
      unstaged: unstagedDiff(),
      staged: stagedDiff(),
    }),
  )
  const stats = createMemo(() => diffStats(commitScope()))
  const hasChanges = () =>
    commitHasChanges({
      stageAll: stageAll(),
      unstaged: unstagedDiff(),
      staged: stagedDiff(),
    })

  const showGenerateNoChangesToast = () => {
    showToast({
      title: language.t("dialog.gitGenerate.toast.noChanges.title"),
      description: commitNoChangesMessage(stageAll(), language.t),
    })
  }

  const showCommitNoChangesToast = () => {
    showToast({
      title: language.t("dialog.commit.toast.noChanges.title"),
      description: commitNoChangesMessage(stageAll(), language.t),
    })
  }

  const canSubmit = () => !submitting() && !generating()

  const generateCommitMessage = async () => {
    const result = await sdk.client.vcs.generateCommitMessage({
      vcsGenerateCommitMessageInput: {
        stageAll: stageAll(),
        previous: message().trim() || undefined,
        locale: language.locale(),
      },
    })
    const text = result.data?.message?.trim()
    if (text) {
      setMessage(text)
      return true
    }
    return false
  }

  const withGenerating = async <T,>(task: () => Promise<T>) => {
    if (generating()) return undefined
    setGenerating(true)
    try {
      return await task()
    } finally {
      setGenerating(false)
    }
  }

  const ensureCommitMessage = async () => {
    if (message().trim()) return true
    const ok = await withGenerating(() => generateCommitMessage())
    return ok ?? false
  }

  const handleGenerate = async () => {
    if (generating()) return
    if (!hasChanges()) {
      showGenerateNoChangesToast()
      return
    }
    await withGenerating(async () => {
      try {
        if (await generateCommitMessage()) return
        showToast({
          title: language.t("dialog.gitGenerate.toast.failed"),
          description: language.t("dialog.gitGenerate.toast.empty"),
        })
      } catch (err: unknown) {
        showToast({
          title: language.t("dialog.gitGenerate.toast.failed"),
          description: formatServerError(err, language.t, language.t("common.requestFailed")),
        })
      }
    })
  }

  const handleSubmit = async () => {
    if (!canSubmit()) return
    if (!hasChanges()) {
      showCommitNoChangesToast()
      return
    }
    setSubmitting(true)
    try {
      if (!(await ensureCommitMessage())) {
        showToast({
          title: language.t("dialog.gitGenerate.toast.failed"),
          description: language.t("dialog.gitGenerate.toast.empty"),
        })
        return
      }
      const text = message().trim()
      const result = await sdk.client.vcs.commit({
        vcsCommitInput: { message: text, stageAll: stageAll() },
      })
      props.onCommitted?.(result.data?.hash ?? "")
      dialog.close()
    } catch (err: unknown) {
      const detail = formatServerError(err, language.t, language.t("common.requestFailed"))
      showToast({ title: language.t("dialog.commit.toast.failed"), description: detail })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog
      fit
      title={
        <div class="flex flex-col items-start gap-3">
          <svg
            viewBox="0 0 20 20"
            fill="none"
            class="size-[18px] text-icon-base"
            aria-hidden="true"
          >
            <path d="M1.5 10H7M13 10H18.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
            <circle cx="10" cy="10" r="3" stroke="currentColor" stroke-width="1.4" fill="none" />
          </svg>
          <span class="text-16-medium text-text-strong">{language.t("dialog.commit.title")}</span>
        </div>
      }
      class="codex-dialog codex-dialog-narrow w-full mx-auto !min-h-0"
    >
      <div class="codex-dialog-narrow flex flex-col gap-3 px-5 pt-1 pb-5">
        <div class="flex items-center justify-between">
          <span class="text-13-regular text-text-base">{language.t("dialog.commit.row.branch")}</span>
          <span class="flex items-center gap-1.5 text-13-regular text-text-strong">
            <Icon {...envBranchIconProps} />
            <span class="truncate max-w-[220px]">{branchName()}</span>
          </span>
        </div>
        <Show when={stats().files > 0 || unstagedDiff().length > 0 || stagedDiff().length > 0}>
          <div class="flex items-center justify-between">
            <span class="text-13-regular text-text-base">{language.t("dialog.commit.row.changes")}</span>
            <span class="flex items-center gap-2 text-13-regular text-text-weak">
              <span>{language.t("dialog.commit.row.filesCount", { count: stats().files })}</span>
              <span class="text-[rgb(48,164,108)] font-mono">+{stats().additions}</span>
              <span class="text-[rgb(217,72,72)] font-mono">-{stats().deletions}</span>
            </span>
          </div>
        </Show>

        <div class="flex items-center justify-between">
          <span class="flex items-center gap-2 text-13-regular text-text-strong">
            <Switch class="commit-stage-switch" checked={stageAll()} onChange={setStageAll} />
            <span>{language.t("dialog.commit.row.includeUnstaged")}</span>
          </span>
        </div>

        <div class="git-generate-field flex flex-col gap-1.5">
          <div class="git-generate-field__toolbar">
            <span class="git-generate-field__label text-13-medium text-text-strong">
              {language.t("dialog.commit.field.message")}
            </span>
            <GitGenerateButton generating={generating} disabled={submitting()} onGenerate={() => void handleGenerate()} />
          </div>
          <TextField
            type="text"
            label={language.t("dialog.commit.field.message")}
            hideLabel
            multiline
            value={message()}
            onChange={setMessage}
            class="max-h-[40vh] overflow-y-auto"
            placeholder={language.t("dialog.commit.field.placeholder")}
            spellcheck={false}
            autocorrect="off"
            autocomplete="off"
            autocapitalize="off"
          />
        </div>

        <div class="flex justify-end">
          <Button
            type="button"
            variant="primary"
            disabled={!canSubmit()}
            class="!border-transparent !shadow-none"
            style={{
              "background-color": canSubmit() ? "rgb(25,28,31)" : "rgb(186,189,192)",
              color: "rgb(255,255,255)",
              padding: "6px 22px",
              "border-radius": "999px",
              "font-size": "14px",
              "font-weight": "500",
              "line-height": "20px",
              height: "auto",
              "min-height": "0",
            }}
            onClick={() => void handleSubmit()}
          >
            {submitting() ? language.t("dialog.commit.action.submitting") : language.t("dialog.commit.action.continue")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
