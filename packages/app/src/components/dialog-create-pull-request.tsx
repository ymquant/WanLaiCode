import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { GitPullRequestCreateIcon } from "@opencode-ai/ui/git-pull-request-create-icon"
import { Icon } from "@opencode-ai/ui/icon"
import { Switch } from "@opencode-ai/ui/switch"
import { TextField } from "@opencode-ai/ui/text-field"
import { showToast } from "@opencode-ai/ui/toast"
import type {
  VcsCreatePullRequestInput,
  VcsFileDiff,
  VcsPullRequestReadiness,
} from "@opencode-ai/sdk/v2"
import { createEffect, createMemo, createSignal, For, onMount, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { formatServerError } from "@/utils/server-errors"
import {
  defaultPrMode,
  openPageBlockReason,
  prModeStepHint,
  prModeUnlock,
  type PrMode,
  type PrUnlockReason,
} from "./dialog-create-pull-request-unlock"
import { GitCommitIcon } from "@/components/git-commit-icon"
import { GitGenerateButton } from "@/components/git-generate-button"

export type { PrMode } from "./dialog-create-pull-request-unlock"

export interface DialogCreatePullRequestInitialSnapshot {
  readiness?: VcsPullRequestReadiness
  branchDiff?: VcsFileDiff[]
  unstagedDiff?: VcsFileDiff[]
  stagedDiff?: VcsFileDiff[]
}

export interface DialogCreatePullRequestProps {
  onCreated?: (result: { url?: string; title?: string }) => void
  initialSnapshot?: DialogCreatePullRequestInitialSnapshot
}

interface Option {
  mode: PrMode
  label: string
  icon: () => unknown
}

const emptyReadiness = (): VcsPullRequestReadiness => ({
  git_repo: false,
  gh_cli: false,
  gh_authenticated: false,
  remote: false,
  has_commits: false,
  worktree_changes: false,
  staged_changes: false,
  unpushed_commits: false,
  branch_on_remote: false,
})

function createPullRequestStateFromSnapshot(snapshot: DialogCreatePullRequestInitialSnapshot) {
  const readiness = snapshot.readiness ?? emptyReadiness()
  const branchDiff = snapshot.branchDiff ?? []
  const unstagedDiff = snapshot.unstagedDiff ?? []
  const stagedDiff = snapshot.stagedDiff ?? []
  let additions = 0
  let deletions = 0
  for (const d of branchDiff) {
    additions += d.additions ?? 0
    deletions += d.deletions ?? 0
  }
  const paths = new Set<string>()
  for (const d of [...unstagedDiff, ...stagedDiff]) {
    if (d.file) paths.add(d.file)
  }
  return {
    readiness,
    mode: defaultPrMode(readiness),
    stats: { files: branchDiff.length, additions, deletions },
    commitPaths: [...paths],
    branchDiff,
  }
}

function snapshotReady(snapshot?: DialogCreatePullRequestInitialSnapshot) {
  return (
    snapshot?.readiness !== undefined &&
    snapshot.branchDiff !== undefined &&
    snapshot.unstagedDiff !== undefined &&
    snapshot.stagedDiff !== undefined
  )
}

function commitMessageFromPullRequest(title: string, body: string, fallback: string) {
  const trimmed = title.trim()
  if (trimmed) return trimmed
  const line = body
    .split("\n")
    .map((item) => item.trim())
    .find((item) => item.length > 0)
  if (!line) return fallback
  if (line.length <= 200) return line
  return `${line.slice(0, 200)}…`
}

export function DialogCreatePullRequest(props: DialogCreatePullRequestProps) {
  const dialog = useDialog()
  const language = useLanguage()
  const sdk = useSDK()
  const sync = useSync()

  const sourceBranch = createMemo(() => sync.data.vcs?.branch ?? "main")
  const targetBranch = createMemo(() => sync.data.vcs?.default_branch ?? "main")
  const branchFlow = createMemo(() =>
    language.t("dialog.createPullRequest.row.branchFlow", {
      source: sourceBranch(),
      target: targetBranch(),
    }),
  )

  const initial = props.initialSnapshot
  const initialReady = snapshotReady(initial)
  const initialState = initialReady && initial ? createPullRequestStateFromSnapshot(initial) : undefined

  const [readiness, setReadiness] = createSignal<VcsPullRequestReadiness>(
    initialState?.readiness ?? emptyReadiness(),
  )
  const [readinessLoaded, setReadinessLoaded] = createSignal(initialReady)
  const [title, setTitle] = createSignal("")
  const [body, setBody] = createSignal("")
  const [draft, setDraft] = createSignal(true)
  const [mode, setMode] = createSignal<PrMode>(initialState?.mode ?? "commit-push-and-create")
  const [submitting, setSubmitting] = createSignal(false)
  const [generating, setGenerating] = createSignal(false)
  const [stats, setStats] = createSignal<{ files: number; additions: number; deletions: number } | undefined>(
    initialState?.stats,
  )
  const [branchDiffFiles, setBranchDiffFiles] = createSignal<VcsFileDiff[]>(initial?.branchDiff ?? [])
  const [commitPaths, setCommitPaths] = createSignal<string[]>(initialState?.commitPaths ?? [])
  const [hoveredStep, setHoveredStep] = createSignal<number | undefined>(undefined)

  const unlockLabel = (reason?: PrUnlockReason) =>
    reason ? language.t(`dialog.createPullRequest.unlock.${reason}`) : undefined

  onMount(() => {
    if (initialReady) return
    const snapshot = initial
    void Promise.all([
      snapshot?.readiness
        ? Promise.resolve({ data: snapshot.readiness })
        : sdk.client.vcs.pullRequestReadiness(),
      snapshot?.branchDiff !== undefined
        ? Promise.resolve({ data: snapshot.branchDiff })
        : sdk.client.vcs.diff({ mode: "branch" }),
      snapshot?.unstagedDiff !== undefined
        ? Promise.resolve({ data: snapshot.unstagedDiff })
        : sdk.client.vcs.diff({ mode: "unstaged" }),
      snapshot?.stagedDiff !== undefined
        ? Promise.resolve({ data: snapshot.stagedDiff })
        : sdk.client.vcs.diff({ mode: "staged" }),
    ])
      .then(([readinessRes, branchDiff, unstagedDiff, stagedDiff]) => {
        const next = createPullRequestStateFromSnapshot({
          readiness: readinessRes.data,
          branchDiff: branchDiff.data,
          unstagedDiff: unstagedDiff.data,
          stagedDiff: stagedDiff.data,
        })
        setReadiness(next.readiness)
        setMode(next.mode)
        setStats(next.stats)
        setCommitPaths(next.commitPaths)
        setBranchDiffFiles(next.branchDiff ?? [])
      })
      .catch(() => undefined)
      .finally(() => setReadinessLoaded(true))
  })

  const options = createMemo<Option[]>(() => [
    {
      mode: "create",
      label: language.t("dialog.createPullRequest.option.create"),
      icon: () => <GitPullRequestCreateIcon size="step" class="dialog-create-pull-request-step-icon" />,
    },
    {
      mode: "push-and-create",
      label: language.t("dialog.createPullRequest.option.pushAndCreate"),
      icon: () => <Icon name="arrow-up" size="normal" class="dialog-create-pull-request-step-icon text-icon-base" />,
    },
    {
      mode: "commit-push-and-create",
      label: language.t("dialog.createPullRequest.option.commitPushAndCreate"),
      icon: () => (
        <GitCommitIcon class="dialog-create-pull-request-step-icon text-icon-base" />
      ),
    },
  ])

  const createdResult = (url?: string) => ({
    url,
    title: title().trim() || undefined,
  })

  createEffect(() => {
    if (!readinessLoaded()) return
    if (prModeUnlock(readiness(), mode()).enabled) return
    setMode(defaultPrMode(readiness()))
  })

  const selectedUnlock = createMemo(() => prModeUnlock(readiness(), mode()))
  const canSubmit = () => readinessLoaded() && !submitting() && !generating() && selectedUnlock().enabled
  const openPageHint = createMemo(() =>
    readinessLoaded() && !submitting() && !generating()
      ? unlockLabel(openPageBlockReason(readiness(), mode()))
      : undefined,
  )

  const stepHint = (index: number) => {
    const opt = options()[index]
    if (!opt || !readinessLoaded()) return undefined
    return unlockLabel(prModeStepHint(readiness(), opt.mode))
  }

  const pullRequestInput = (web: boolean): VcsCreatePullRequestInput => {
    const trimmedTitle = title().trim()
    const trimmedBody = body().trim()
    return {
      title: trimmedTitle || undefined,
      body: trimmedBody || undefined,
      draft: draft(),
      web,
      fill: !trimmedTitle && !trimmedBody,
    }
  }

  const hasBranchChanges = () => branchDiffFiles().length > 0

  const hasPendingCommitChanges = () => {
    const r = readiness()
    return commitPaths().length > 0 || r.worktree_changes || r.staged_changes
  }

  const prDiffAvailable = () =>
    hasBranchChanges() || (mode() === "commit-push-and-create" && hasPendingCommitChanges())

  const refreshBranchDiffFromApi = async () => {
    const branchDiff = await sdk.client.vcs.diff({ mode: "branch" })
    const files = branchDiff.data ?? []
    setBranchDiffFiles(files)
    let additions = 0
    let deletions = 0
    for (const d of files) {
      additions += d.additions ?? 0
      deletions += d.deletions ?? 0
    }
    setStats({ files: files.length, additions, deletions })
  }

  const showBranchNoChangesToast = () => {
    showToast({
      title: language.t("dialog.gitGenerate.toast.noChanges.title"),
      description: language.t("dialog.createPullRequest.noChanges.branch"),
    })
  }

  const generatePullRequestContent = async (includePending?: boolean) => {
    const result = await sdk.client.vcs.generatePullRequest({
      vcsGeneratePullRequestInput: {
        previousTitle: title().trim() || undefined,
        previousBody: body().trim() || undefined,
        includePendingChanges:
          includePending ??
          (mode() === "commit-push-and-create" && hasPendingCommitChanges() ? true : undefined),
        locale: language.locale(),
      },
    })
    const nextTitle = result.data?.title?.trim()
    const nextBody = result.data?.body?.trim()
    if (!title().trim() && nextTitle) setTitle(nextTitle)
    if (!body().trim() && nextBody) setBody(nextBody)
    const mergedTitle = title().trim() || nextTitle
    const mergedBody = body().trim() || nextBody
    return !!(mergedTitle || mergedBody)
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

  const ensurePullRequestContent = async (includePending?: boolean) => {
    if (title().trim() && body().trim()) return true
    if (!prDiffAvailable()) {
      showBranchNoChangesToast()
      return false
    }
    const ok = await withGenerating(() => generatePullRequestContent(includePending))
    return ok ?? false
  }

  const handleGenerate = async () => {
    if (generating()) return
    if (!prDiffAvailable()) {
      showBranchNoChangesToast()
      return
    }
    await withGenerating(async () => {
      try {
        if (await generatePullRequestContent()) return
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

  const runPreCreateSteps = async () => {
    const selected = mode()
    if (selected === "commit-push-and-create") {
      const paths = commitPaths()
      await sdk.client.vcs.commit({
        vcsCommitInput: {
          message: commitMessageFromPullRequest(title(), body(), language.t("dialog.commit.defaultMessage")),
          ...(paths.length > 0 ? { stageAll: false, files: paths } : { stageAll: true }),
        },
      })
    }
    if (selected === "push-and-create" || selected === "commit-push-and-create") {
      await sdk.client.vcs.push({ vcsPushInput: {} })
    }
  }

  const createPullRequest = async (web: boolean) => {
    if (!canSubmit()) return
    setSubmitting(true)
    try {
      const commitFirst = mode() === "commit-push-and-create"
      if (!(await ensurePullRequestContent(commitFirst ? true : undefined))) {
        if (prDiffAvailable()) {
          showToast({
            title: language.t("dialog.gitGenerate.toast.failed"),
            description: language.t("dialog.gitGenerate.toast.empty"),
          })
        }
        return
      }
      if (commitFirst) {
        await runPreCreateSteps()
        await refreshBranchDiffFromApi()
      } else if (!web) {
        await runPreCreateSteps()
      }
      const result = await sdk.client.vcs.createPullRequest({
        vcsCreatePullRequestInput: pullRequestInput(web),
      })
      if (!web) props.onCreated?.(createdResult(result.data?.url))
      dialog.close()
    } catch (err: unknown) {
      showToast({
        title: language.t("dialog.createPullRequest.toast.failed"),
        description: formatServerError(err, language.t, language.t("common.requestFailed")),
      })
    } finally {
      setSubmitting(false)
    }
  }

  const openPullRequestPage = async () => {
    if (!canSubmit()) return
    setSubmitting(true)
    try {
      const commitFirst = mode() === "commit-push-and-create"
      if (!(await ensurePullRequestContent(commitFirst ? true : undefined))) {
        if (prDiffAvailable()) {
          showToast({
            title: language.t("dialog.gitGenerate.toast.failed"),
            description: language.t("dialog.gitGenerate.toast.empty"),
          })
        }
        return
      }
      if (commitFirst) {
        await runPreCreateSteps()
        await refreshBranchDiffFromApi()
      } else {
        await runPreCreateSteps()
      }
      const result = await sdk.client.vcs.createPullRequest({
        vcsCreatePullRequestInput: pullRequestInput(true),
      })
      props.onCreated?.(createdResult(result.data?.url))
      dialog.close()
    } catch (err: unknown) {
      showToast({
        title: language.t("dialog.createPullRequest.toast.failed"),
        description: formatServerError(err, language.t, language.t("common.requestFailed")),
      })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog
      fit
      class="codex-dialog codex-dialog-narrow dialog-create-pull-request w-full mx-auto !min-h-0"
      title={
        <div class="flex flex-col items-start" style={{ gap: "14px" }}>
          <div
            class="flex items-center justify-center"
            style={{
              width: "36px",
              height: "36px",
              "border-radius": "10px",
              "background-color": "rgb(255,255,255)",
              border: "1px solid rgb(232,233,236)",
              "box-shadow": "0 1px 2px rgba(0,0,0,0.04)",
            }}
          >
            <GitPullRequestCreateIcon size="title" />
          </div>
          <div class="flex flex-col items-start gap-1">
            <span
              style={{
                "font-size": "22px",
                "font-weight": "600",
                color: "rgb(25,28,31)",
                "line-height": "28px",
                "letter-spacing": "-0.01em",
              }}
            >
              {language.t("dialog.createPullRequest.title")}
            </span>
            <span style={{ "font-size": "14px", color: "rgb(107,111,118)", "line-height": "20px" }}>{branchFlow()}</span>
          </div>
        </div>
      }
    >
      <div class="codex-dialog-narrow dialog-create-pull-request-body flex flex-col min-h-full">
        <div class="dialog-create-pull-request-scroll flex flex-col flex-1 min-h-0" style={{ gap: "12px" }}>
        <Show when={stats()} keyed>
          {(s) => (
            <div class="flex items-center justify-between">
              <span style={{ "font-size": "14px", "font-weight": "600", color: "rgb(25,28,31)" }}>
                {language.t("dialog.createPullRequest.row.changes")}
              </span>
              <span class="flex items-center gap-2" style={{ "font-size": "14px", color: "rgb(107,111,118)" }}>
                <span>{language.t("dialog.commit.row.filesCount", { count: s.files })}</span>
                <span class="text-[rgb(48,164,108)] font-mono">+{s.additions}</span>
                <span class="text-[rgb(217,72,72)] font-mono">-{s.deletions}</span>
              </span>
            </div>
          )}
        </Show>

        <div class="git-generate-field flex flex-col gap-1.5">
          <div class="git-generate-field__toolbar">
            <span
              class="git-generate-field__label text-13-medium text-text-strong"
              style={{ "font-size": "14px", "font-weight": "600", color: "rgb(25,28,31)" }}
            >
              {language.t("dialog.createPullRequest.field.title")}
            </span>
            <GitGenerateButton generating={generating} disabled={submitting()} onGenerate={() => void handleGenerate()} />
          </div>
          <div class="dialog-create-pull-request-title-field">
            <TextField
              type="text"
              label={language.t("dialog.createPullRequest.field.title")}
              hideLabel
              value={title()}
              onChange={setTitle}
              placeholder={language.t("dialog.createPullRequest.field.titlePlaceholder")}
              spellcheck={false}
              autocorrect="off"
              autocomplete="off"
              autocapitalize="off"
            />
          </div>
        </div>

        <div class="flex flex-col gap-1.5">
          <span style={{ "font-size": "14px", "font-weight": "600", color: "rgb(25,28,31)" }}>
            {language.t("dialog.createPullRequest.field.body")}
          </span>
          <div class="dialog-create-pull-request-body-field">
            <TextField
              type="text"
              label={language.t("dialog.createPullRequest.field.body")}
              hideLabel
              multiline
              value={body()}
              onChange={setBody}
              placeholder={language.t("dialog.createPullRequest.field.bodyPlaceholder")}
              spellcheck={false}
              autocorrect="off"
              autocomplete="off"
              autocapitalize="off"
            />
          </div>
        </div>

        <div class="dialog-create-pull-request-steps-block">
          <div class="dialog-create-pull-request-steps-header">
            <span style={{ "font-size": "14px", "font-weight": "600", color: "rgb(25,28,31)" }}>
              {language.t("dialog.createPullRequest.steps")}
            </span>
          </div>

          <div
            class="dialog-create-pull-request-steps relative flex flex-col"
            style={{
              "margin-top": "8px",
              "border-radius": "12px",
              border: "1px solid rgb(232,233,236)",
              "background-color": "rgb(255,255,255)",
            }}
          >
            <Show when={stepHint(0)}>
              {(text) => (
                <span
                  class="dialog-create-pull-request-step-hint-slot dialog-create-pull-request-step-hint-slot--first"
                  classList={{ "is-visible": hoveredStep() === 0 }}
                  role="tooltip"
                >
                  {text()}
                </span>
              )}
            </Show>
            <For each={options()}>
              {(opt, idx) => {
                const unlock = () => prModeUnlock(readiness(), opt.mode)
                const disabled = () => !readinessLoaded() || !unlock().enabled
                const hint = () => stepHint(idx())
                return (
                  <div
                    class="dialog-create-pull-request-step relative"
                    data-step-index={idx()}
                    data-disabled={disabled() && hint() ? "" : undefined}
                    style={{ "border-top": idx() === 0 ? "none" : "1px solid rgb(238,239,242)" }}
                    onMouseEnter={() => {
                      if (disabled() && hint()) setHoveredStep(idx())
                    }}
                    onMouseLeave={() => {
                      if (hoveredStep() === idx()) setHoveredStep(undefined)
                    }}
                  >
                    <button
                      type="button"
                      class="dialog-create-pull-request-step-button flex w-full items-center gap-3 text-left transition-colors"
                      classList={{ "opacity-50 cursor-not-allowed": disabled() }}
                      aria-disabled={disabled()}
                      onmouseover={(e) => {
                        if (disabled()) return
                        e.currentTarget.style.backgroundColor = "rgba(0,0,0,0.025)"
                      }}
                      onmouseout={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
                      onClick={() => {
                        if (disabled()) return
                        setMode(opt.mode)
                      }}
                    >
                      <span
                        class="shrink-0 flex items-center justify-center"
                        style={{ width: "22px", height: "22px" }}
                      >
                        {opt.icon() as never}
                      </span>
                      <span class="flex-1 truncate" style={{ "font-size": "14px", color: "rgb(25,28,31)" }}>
                        {opt.label}
                      </span>
                      <Show when={mode() === opt.mode}>
                        <Icon name="check" size="medium" class="dialog-create-pull-request-step-check shrink-0" />
                      </Show>
                    </button>
                    <Show when={stepHint(idx() + 1)}>
                      {(text) => (
                        <span
                          class="dialog-create-pull-request-step-hint-slot"
                          classList={{ "is-visible": hoveredStep() === idx() + 1 }}
                          role="tooltip"
                        >
                          {text()}
                        </span>
                      )}
                    </Show>
                  </div>
                )
              }}
            </For>
          </div>
        </div>
        </div>

        <div class="dialog-create-pull-request-footer flex items-center justify-between gap-3" style={{ "margin-top": "auto" }}>
          <span class="dialog-create-pull-request-draft flex items-center gap-2 shrink-0 text-13-regular text-text-strong">
            <Switch class="dialog-create-pull-request-draft-switch" checked={draft()} onChange={setDraft} />
            <span>{language.t("dialog.createPullRequest.draft")}</span>
          </span>
          <div class="flex items-center gap-3 min-w-0">
            <div
              class="dialog-create-pull-request-open-page-wrap relative shrink-0"
              data-disabled={!canSubmit() && openPageHint() ? "" : undefined}
            >
              <button
                type="button"
                class="dialog-create-pull-request-open-page shrink-0 transition-colors"
                style={{
                  color: canSubmit() ? "rgb(107,111,118)" : "rgb(186,189,192)",
                }}
                disabled={!canSubmit()}
                onClick={() => void openPullRequestPage()}
              >
                {language.t("dialog.createPullRequest.action.openPage")}
              </button>
              <Show when={openPageHint()}>
                {(text) => (
                  <span class="dialog-create-pull-request-open-page-hint" role="tooltip">
                    {text()}
                  </span>
                )}
              </Show>
            </div>
            <Button
              type="button"
              variant="primary"
              disabled={!canSubmit()}
              class="dialog-create-pull-request-submit !border-transparent !shadow-none shrink-0"
              style={{
                "background-color": canSubmit() ? "rgb(25,28,31)" : "rgb(156,160,166)",
                color: "rgb(255,255,255)",
                "border-radius": "999px",
                "font-size": "14px",
                "font-weight": "500",
              }}
              onClick={() => void createPullRequest(false)}
            >
              {submitting()
                ? language.t("dialog.createPullRequest.action.submitting")
                : language.t("dialog.createPullRequest.action.submit")}
            </Button>
          </div>
        </div>
      </div>
    </Dialog>
  )
}
