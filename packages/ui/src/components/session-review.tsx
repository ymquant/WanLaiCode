import { Accordion } from "./accordion"
import { Button } from "./button"
import { DropdownMenu } from "./dropdown-menu"
import { DiffChanges } from "./diff-changes"
import { FileIcon } from "./file-icon"
import { Icon } from "./icon"
import { IconButton } from "./icon-button"
import { StickyAccordionHeader } from "./sticky-accordion-header"
import { Tooltip } from "./tooltip"
import { ScrollView } from "./scroll-view"
import { useFileComponent } from "../context/file"
import { useI18n } from "../context/i18n"
import { getDirectory, getFilename } from "@opencode-ai/core/util/path"
import { checksum } from "@opencode-ai/core/util/encode"
import { createEffect, createMemo, For, Match, onCleanup, Show, Switch, untrack, type JSX } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { type FileContent, type SnapshotFileDiff, type VcsFileDiff } from "@opencode-ai/sdk/v2"
import { PreloadMultiFileDiffResult } from "@pierre/diffs/ssr"
import { type SelectedLineRange } from "@pierre/diffs"
import { Dynamic } from "solid-js/web"
import { mediaKindFromPath } from "../pierre/media"
import { cloneSelectedLineRange, previewSelectedLines } from "../pierre/selection-bridge"
import { createLineCommentController } from "./line-comment-annotations"
import type { LineCommentEditorProps } from "./line-comment"
import { diffRowCanExpand, normalize, text, type ViewDiff } from "./session-diff"
import {
  isLargeSessionReview,
  sessionReviewHasPatch,
  sessionReviewPatchClipboardText,
  visibleSessionReviewDiffs,
} from "./session-review-performance"

const MAX_DIFF_CHANGED_LINES = 500
const MAX_INLINE_DIFF_RENDER_LINES = 2_000
const MAX_INLINE_DIFF_RENDER_CHARS = 500_000

export type SessionReviewDiffStyle = "unified" | "split"

export type SessionReviewDiffPreferences = {
  wordWrap: () => boolean
  setWordWrap: (value: boolean) => void
  dontLoadFullFiles: () => boolean
  setDontLoadFullFiles: (value: boolean) => void
  richPreview: () => boolean
  setRichPreview: (value: boolean) => void
  wordDiffs: () => boolean
  setWordDiffs: (value: boolean) => void
  ignoreWhitespace: () => boolean
  setIgnoreWhitespace: (value: boolean) => void
}

/** Commit / push / create branch — same actions as the branch details card Git menu. */
export type SessionReviewGitOpsMenu = {
  busy: () => boolean
  commitDisabled: () => boolean
  onCommit: () => void
  onPush: () => void
  onCreateBranch: () => void
}

export type SessionReviewComment = {
  id: string
  file: string
  selection: SelectedLineRange
  comment: string
}

export type SessionReviewLineComment = {
  file: string
  selection: SelectedLineRange
  comment: string
  preview?: string
}

export type SessionReviewCommentCreate = SessionReviewLineComment & {
  id: string
}

export type SessionReviewCommentUpdate = SessionReviewLineComment & {
  id: string
}

export type SessionReviewCommentDelete = {
  id: string
  file: string
}

export type SessionReviewCommentActions = {
  moreLabel: string
  editLabel: string
  deleteLabel: string
  cancelLabel: string
  saveLabel: string
}

export type SessionReviewFocus = { file: string; id: string }

type ReviewDiff = (SnapshotFileDiff | VcsFileDiff) & { preloaded?: PreloadMultiFileDiffResult<any> }
type Item = ViewDiff & { preloaded?: PreloadMultiFileDiffResult<any>; signature: string }

function sameRange(a: SelectedLineRange, b: SelectedLineRange) {
  return a.start === b.start && a.end === b.end && (a.side ?? "both") === (b.side ?? "both")
}

function diff(value: unknown): value is ReviewDiff {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  if (!("file" in value) || typeof value.file !== "string") return false
  if (!("additions" in value) || typeof value.additions !== "number") return false
  if (!("deletions" in value) || typeof value.deletions !== "number") return false
  if ("patch" in value && value.patch !== undefined && typeof value.patch !== "string") return false
  if ("before" in value && value.before !== undefined && typeof value.before !== "string") return false
  if ("after" in value && value.after !== undefined && typeof value.after !== "string") return false
  if (!("status" in value) || value.status === undefined) return true
  return value.status === "added" || value.status === "deleted" || value.status === "modified"
}

function list(value: unknown): ReviewDiff[] {
  if (Array.isArray(value) && value.every(diff)) return value
  if (Array.isArray(value)) return value.filter(diff)
  if (diff(value)) return [value]
  if (!value || typeof value !== "object") return []
  return Object.values(value).filter(diff)
}

function signature(diff: ReviewDiff) {
  const before = "before" in diff && typeof diff.before === "string" ? diff.before : ""
  const after = "after" in diff && typeof diff.after === "string" ? diff.after : ""
  return (
    checksum(
      [diff.file, diff.status ?? "", `${diff.additions}`, `${diff.deletions}`, diff.patch ?? "", before, after].join(
        "\u0000",
      ),
    ) ?? ""
  )
}

export interface SessionReviewProps {
  title?: JSX.Element
  notice?: JSX.Element
  empty?: JSX.Element
  split?: boolean
  diffStyle?: SessionReviewDiffStyle
  onDiffStyleChange?: (diffStyle: SessionReviewDiffStyle) => void
  onDiffRendered?: VoidFunction
  /** Refresh diff data (e.g. invalidate VCS query). Shown in the ⋯ toolbar menu when set. */
  onDiffToolbarRefresh?: () => void
  /** Persisted diff viewer toggles (word wrap, caps, media, word-level, ignore whitespace). When omitted, toggles apply per view only. */
  diffPreferences?: SessionReviewDiffPreferences
  /** When true, the hide/show whitespace menu row is disabled (e.g. last-turn diff is not git-backed). */
  diffWhitespaceMenuDisabled?: () => boolean
  /** Git repo: toolbar control between split diff and file tree (commit / push / create branch). */
  gitOpsMenu?: SessionReviewGitOpsMenu
  onLineComment?: (comment: SessionReviewLineComment) => SessionReviewCommentCreate | undefined
  onLineCommentUpdate?: (comment: SessionReviewCommentUpdate) => void
  onLineCommentDelete?: (comment: SessionReviewCommentDelete) => void
  lineCommentActions?: SessionReviewCommentActions
  comments?: SessionReviewComment[]
  focusedComment?: SessionReviewFocus | null
  onFocusedCommentChange?: (focus: SessionReviewFocus | null) => void
  focusedFile?: string
  onFocusedFileChange?: (file: string) => void
  open?: string[]
  onOpenChange?: (open: string[]) => void
  scrollRef?: (el: HTMLDivElement) => void
  onScroll?: JSX.EventHandlerUnion<HTMLDivElement, Event>
  class?: string
  classList?: Record<string, boolean | undefined>
  classes?: { root?: string; header?: string; container?: string }
  actions?: JSX.Element
  /** Desktop: toggle the in-review file tree rail (replaces expand-all toolbar button). */
  fileTreeToggle?: {
    opened: () => boolean
    onToggle: () => void
    title: () => string
  }
  /** Rendered beside the diff list inside the review body (header stays full width). */
  fileTreeRail?: JSX.Element
  diffs: ReviewDiff[]
  onViewFile?: (file: string) => void
  readFile?: (path: string) => Promise<FileContent | undefined>
  lineCommentMention?: LineCommentEditorProps["mention"]
}

function diffId(file: string): string | undefined {
  const sum = checksum(file)
  if (!sum) return
  return `session-review-diff-${sum}`
}

function removeMatchingDraft(
  commenting: Record<string, SessionReviewSelection>,
  file: string,
  range: SelectedLineRange,
) {
  const next = { ...commenting }
  const key = Object.entries(commenting).find(
    ([, value]) => value.file === file && sameRange(value.range, range),
  )?.[0]
  if (key) delete next[key]
  return next
}

type SessionReviewSelection = {
  file: string
  range: SelectedLineRange
}

export const SessionReview = (props: SessionReviewProps) => {
  let scroll: HTMLDivElement | undefined
  let focusToken = 0
  const i18n = useI18n()
  const fileComponent = useFileComponent()
  const anchors = new Map<string, HTMLElement>()
  const [store, setStore] = createStore({
    open: [] as string[],
    force: {} as Record<string, boolean>,
    selection: null as SessionReviewSelection | null,
    commenting: {} as Record<string, SessionReviewSelection>,
    opened: null as SessionReviewFocus | null,
  })
  const [localDiffPrefs, setLocalDiffPrefs] = createStore({
    wordWrap: false,
    dontLoadFullFiles: true,
    richPreview: false,
    wordDiffs: false,
    ignoreWhitespace: true,
  })
  const selection = () => store.selection
  const opened = () => store.opened

  const open = () => props.open ?? store.open
  const allDiffs = createMemo(() => list(props.diffs))
  const largeReview = createMemo(() => isLargeSessionReview(allDiffs()))
  const renderedDiffs = createMemo(() =>
    visibleSessionReviewDiffs(allDiffs(), props.focusedComment?.file ?? props.focusedFile),
  )
  const items = createMemo(
    (previous: Item[]) => {
      const previousByFile = new Map(previous.map((item) => [item.file, item]))
      return renderedDiffs().map((diff) => {
        const next = signature(diff)
        const previous = previousByFile.get(diff.file)
        if (previous?.signature === next && previous.preloaded === diff.preloaded) return previous
        return { ...normalize(diff), preloaded: diff.preloaded, signature: next }
      })
    },
    [] as Item[],
  )
  const files = createMemo(() => items().map((diff) => diff.file))
  const expandableFiles = createMemo(() => items().filter((diff) => diffRowCanExpand(diff)).map((diff) => diff.file))
  const grouped = createMemo(() => {
    const next = new Map<string, SessionReviewComment[]>()
    for (const comment of props.comments ?? []) {
      const list = next.get(comment.file)
      if (list) {
        list.push(comment)
        continue
      }
      next.set(comment.file, [comment])
    }
    return next
  })
  const diffStyle = () => props.diffStyle ?? (props.split ? "split" : "unified")
  const hasDiffs = () => files().length > 0
  /** 无变更时仍显示「⋯」偏好菜单（刷新/换行等），避免新建会话打开审查页工具栏空白。 */
  const showDiffMenu = () => hasDiffs() || props.diffPreferences != null || props.onDiffToolbarRefresh != null

  const wordWrapOn = () => props.diffPreferences?.wordWrap() ?? localDiffPrefs.wordWrap
  const setWordWrap = (value: boolean) => {
    if (props.diffPreferences) props.diffPreferences.setWordWrap(value)
    else setLocalDiffPrefs("wordWrap", value)
  }
  const dontLoadFullFilesOn = () => props.diffPreferences?.dontLoadFullFiles() ?? localDiffPrefs.dontLoadFullFiles
  const setDontLoadFullFiles = (value: boolean) => {
    if (props.diffPreferences) props.diffPreferences.setDontLoadFullFiles(value)
    else setLocalDiffPrefs("dontLoadFullFiles", value)
  }
  const richPreviewOn = () => props.diffPreferences?.richPreview() ?? localDiffPrefs.richPreview
  const setRichPreview = (value: boolean) => {
    if (props.diffPreferences) props.diffPreferences.setRichPreview(value)
    else setLocalDiffPrefs("richPreview", value)
  }
  const wordDiffsOn = () => props.diffPreferences?.wordDiffs() ?? localDiffPrefs.wordDiffs
  const setWordDiffs = (value: boolean) => {
    if (props.diffPreferences) props.diffPreferences.setWordDiffs(value)
    else setLocalDiffPrefs("wordDiffs", value)
  }
  const ignoreWhitespaceOn = () => props.diffPreferences?.ignoreWhitespace() ?? localDiffPrefs.ignoreWhitespace
  const setIgnoreWhitespace = (value: boolean) => {
    if (props.diffPreferences) props.diffPreferences.setIgnoreWhitespace(value)
    else setLocalDiffPrefs("ignoreWhitespace", value)
  }
  const whitespaceMenuDisabled = () => props.diffWhitespaceMenuDisabled?.() === true

  const canCopyGitApply = () => sessionReviewHasPatch(allDiffs())

  const fileDiffOptions = createMemo(() => ({
    overflow: wordWrapOn() ? ("wrap" as const) : ("scroll" as const),
    lineDiffType: wordDiffsOn() ? ("word-alt" as const) : ("none" as const),
    expandUnchanged: !dontLoadFullFilesOn(),
  }))

  createEffect(() => {
    const current = selection()
    if (!current) return

    const comment = (grouped().get(current.file) ?? []).find((item) => sameRange(item.selection, current.range))
    if (!comment) return

    setStore("opened", { file: current.file, id: comment.id })
    setStore("selection", null)
    setStore("commenting", reconcile(removeMatchingDraft(untrack(() => store.commenting), current.file, current.range)))
  })

  const handleScroll: JSX.EventHandler<HTMLDivElement, Event> = (event) => {
    const next = props.onScroll
    if (!next) return
    if (Array.isArray(next)) {
      const [fn, data] = next as [(data: unknown, event: Event) => void, unknown]
      fn(data, event)
      return
    }
    ;(next as JSX.EventHandler<HTMLDivElement, Event>)(event)
  }

  const handleChange = (next: string[]) => {
    props.onOpenChange?.(next)
    if (props.open === undefined) setStore("open", next)
  }

  const handleExpandOrCollapseAll = () => {
    const next = open().length > 0 ? [] : expandableFiles()
    handleChange(next)
  }

  createEffect(() => {
    items()
    const allowed = new Set(expandableFiles())
    const current = untrack(() => open())
    const next = current.filter((file) => allowed.has(file))
    if (next.length === current.length && next.every((file, index) => file === current[index])) return
    handleChange(next)
  })

  const copyGitApplyCommand = () => {
    // 复制动作必须覆盖全部文件，而不是超大评审模式下当前可见的单个文件。
    const text = sessionReviewPatchClipboardText(allDiffs())
    if (!text) return
    void navigator.clipboard.writeText(text).catch((error) => {
      console.debug("[session-review] copy git apply failed", { error })
    })
  }

  const openFileLabel = () => i18n.t("ui.sessionReview.openFile")

  const selectionSide = (range: SelectedLineRange) => range.endSide ?? range.side ?? "additions"

  const selectionPreview = (diff: ViewDiff, range: SelectedLineRange) => {
    const side = selectionSide(range)
    const contents = text(diff, side)
    if (contents.length === 0) return undefined

    return previewSelectedLines(contents, range)
  }

  createEffect(() => {
    const focus = props.focusedComment
    if (!focus) return

    untrack(() => {
      focusToken++
      const token = focusToken

      setStore("opened", focus)

      const comment = (props.comments ?? []).find((c) => c.file === focus.file && c.id === focus.id)
      if (comment) setStore("selection", { file: comment.file, range: cloneSelectedLineRange(comment.selection) })

      const current = open()
      if (!current.includes(focus.file)) {
        handleChange([...current, focus.file])
      }

      const scrollTo = (attempt: number) => {
        if (token !== focusToken) return

        const root = scroll
        if (!root) return

        const wrapper = anchors.get(focus.file)
        const anchor = wrapper?.querySelector(`[data-comment-id="${focus.id}"]`)
        const ready =
          anchor instanceof HTMLElement && anchor.style.pointerEvents !== "none" && anchor.style.opacity !== "0"

        const target = ready ? anchor : wrapper
        if (!target) {
          if (attempt >= 120) return
          requestAnimationFrame(() => scrollTo(attempt + 1))
          return
        }

        const rootRect = root.getBoundingClientRect()
        const targetRect = target.getBoundingClientRect()
        const offset = targetRect.top - rootRect.top
        const next = root.scrollTop + offset - rootRect.height / 2 + targetRect.height / 2
        root.scrollTop = Math.max(0, next)

        if (ready) return
        if (attempt >= 120) return
        requestAnimationFrame(() => scrollTo(attempt + 1))
      }

      requestAnimationFrame(() => scrollTo(0))

      requestAnimationFrame(() => props.onFocusedCommentChange?.(null))
    })
  })

  return (
    <div data-component="session-review" class={props.class} classList={props.classList}>
      <div data-slot="session-review-header" class={props.classes?.header}>
        <div data-slot="session-review-title">
          {props.title === undefined ? i18n.t("ui.sessionReview.title") : props.title}
        </div>
        <div data-slot="session-review-actions">
          <Show when={showDiffMenu()}>
            <div onMouseDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
              <DropdownMenu gutter={4} placement="bottom-end">
                <DropdownMenu.Trigger
                  as={IconButton}
                  icon="ellipsis-horizontal"
                  variant="ghost"
                  size="small"
                  class="session-review-header-action"
                  aria-label={i18n.t("ui.sessionReview.diffMenu.more")}
                />
                <DropdownMenu.Portal>
                  <DropdownMenu.Content class="codex-chat-menu min-w-[220px]">
                    <Show when={props.onDiffToolbarRefresh != null}>
                      <DropdownMenu.Item onSelect={() => props.onDiffToolbarRefresh?.()}>
                        <div class="flex size-5 shrink-0 items-center justify-center">
                          <Icon name="refresh-cw" size="small" class="text-icon-weak-base" />
                        </div>
                        <DropdownMenu.ItemLabel>{i18n.t("ui.sessionReview.diffMenu.refresh")}</DropdownMenu.ItemLabel>
                      </DropdownMenu.Item>
                      <DropdownMenu.Separator />
                    </Show>
                    <DropdownMenu.CheckboxItem checked={wordWrapOn()} onChange={setWordWrap}>
                      <div class="flex size-5 shrink-0 items-center justify-center">
                        <Icon name="auto-wrap" size="small" class="text-icon-weak-base" />
                      </div>
                      <DropdownMenu.ItemLabel>
                        {wordWrapOn()
                          ? i18n.t("ui.sessionReview.diffMenu.wordWrap.disable")
                          : i18n.t("ui.sessionReview.diffMenu.wordWrap.enable")}
                      </DropdownMenu.ItemLabel>
                    </DropdownMenu.CheckboxItem>
                    <DropdownMenu.Item onSelect={handleExpandOrCollapseAll}>
                      <div class="flex size-5 shrink-0 items-center justify-center">
                        <Icon
                          name={open().length > 0 ? "chevron-grabber-vertical-collapse" : "chevron-grabber-vertical"}
                          size="small"
                          class="text-icon-weak-base"
                        />
                      </div>
                      <DropdownMenu.ItemLabel>
                        {open().length > 0
                          ? i18n.t("ui.sessionReview.diffMenu.collapseAllDiffs")
                          : i18n.t("ui.sessionReview.diffMenu.expandAllDiffs")}
                      </DropdownMenu.ItemLabel>
                    </DropdownMenu.Item>
                    <DropdownMenu.Separator />
                    <DropdownMenu.CheckboxItem checked={dontLoadFullFilesOn()} onChange={setDontLoadFullFiles}>
                      <div class="flex size-5 shrink-0 items-center justify-center">
                        <Icon name="status" size="small" class="text-icon-weak-base" />
                      </div>
                      <DropdownMenu.ItemLabel>
                        {dontLoadFullFilesOn()
                          ? i18n.t("ui.sessionReview.diffMenu.dontLoadFullFiles")
                          : i18n.t("ui.sessionReview.diffMenu.loadFullFiles")}
                      </DropdownMenu.ItemLabel>
                    </DropdownMenu.CheckboxItem>
                    <DropdownMenu.CheckboxItem checked={richPreviewOn()} onChange={setRichPreview}>
                      <div class="flex size-5 shrink-0 items-center justify-center">
                        <Icon name="photo" size="small" class="text-icon-weak-base" />
                      </div>
                      <DropdownMenu.ItemLabel>
                        {richPreviewOn()
                          ? i18n.t("ui.sessionReview.diffMenu.richPreview.disable")
                          : i18n.t("ui.sessionReview.diffMenu.richPreview.enable")}
                      </DropdownMenu.ItemLabel>
                    </DropdownMenu.CheckboxItem>
                    <DropdownMenu.CheckboxItem checked={wordDiffsOn()} onChange={setWordDiffs}>
                      <div class="flex size-5 shrink-0 items-center justify-center">
                        <Icon name="fork" size="small" class="text-icon-weak-base" />
                      </div>
                      <DropdownMenu.ItemLabel>
                        {wordDiffsOn()
                          ? i18n.t("ui.sessionReview.diffMenu.wordDiffs.disable")
                          : i18n.t("ui.sessionReview.diffMenu.wordDiffs.enable")}
                      </DropdownMenu.ItemLabel>
                    </DropdownMenu.CheckboxItem>
                    <DropdownMenu.CheckboxItem
                      checked={!ignoreWhitespaceOn()}
                      disabled={whitespaceMenuDisabled()}
                      onChange={(show) => setIgnoreWhitespace(!show)}
                    >
                      <div class="flex size-5 shrink-0 items-center justify-center">
                        <Icon
                          name={!ignoreWhitespaceOn() ? "eye-off" : "eye"}
                          size="small"
                          class="text-icon-weak-base"
                        />
                      </div>
                      <DropdownMenu.ItemLabel>
                        {!ignoreWhitespaceOn()
                          ? i18n.t("ui.sessionReview.diffMenu.hideWhitespace")
                          : i18n.t("ui.sessionReview.diffMenu.showWhitespace")}
                      </DropdownMenu.ItemLabel>
                    </DropdownMenu.CheckboxItem>
                    <DropdownMenu.Item disabled={!canCopyGitApply()} onSelect={copyGitApplyCommand}>
                      <div class="flex size-5 shrink-0 items-center justify-center">
                        <Icon name="copy" size="small" class="text-icon-weak-base" />
                      </div>
                      <DropdownMenu.ItemLabel>{i18n.t("ui.sessionReview.diffMenu.copyGitApply")}</DropdownMenu.ItemLabel>
                    </DropdownMenu.Item>
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu>
            </div>
          </Show>
          <Show when={props.onDiffStyleChange}>
            <div onMouseDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
              <Tooltip
                value={i18n.t(
                  diffStyle() === "unified"
                    ? "ui.sessionReview.diffStyle.switchToSplit"
                    : "ui.sessionReview.diffStyle.switchToUnified",
                )}
              >
                <IconButton
                  icon={diffStyle() === "split" ? "diff-unified" : "diff-split"}
                  variant="ghost"
                  size="small"
                  iconSize="medium"
                  class="session-review-header-action session-review-diff-style-action"
                  aria-label={i18n.t(
                    diffStyle() === "unified"
                      ? "ui.sessionReview.diffStyle.switchToSplit"
                      : "ui.sessionReview.diffStyle.switchToUnified",
                  )}
                  onClick={() =>
                    props.onDiffStyleChange?.(diffStyle() === "unified" ? "split" : "unified")
                  }
                />
              </Tooltip>
            </div>
          </Show>
          <Show when={props.gitOpsMenu}>
            {(ops) => (
              <div onMouseDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
                <Tooltip value={i18n.t("ui.sessionReview.gitOps.trigger")}>
                  <DropdownMenu gutter={4} placement="bottom-end">
                    <DropdownMenu.Trigger
                      as={IconButton}
                      icon="branch-icon"
                      variant="ghost"
                      size="small"
                      class="session-review-header-action"
                      classList={{
                        "pointer-events-none opacity-60": ops().busy(),
                      }}
                      disabled={ops().busy()}
                      aria-label={i18n.t("ui.sessionReview.gitOps.trigger")}
                      aria-busy={ops().busy()}
                    />
                    <DropdownMenu.Portal>
                      <DropdownMenu.Content class="codex-chat-menu min-w-[200px]">
                        <DropdownMenu.Item
                          disabled={ops().commitDisabled()}
                          onSelect={() => {
                            if (ops().commitDisabled()) return
                            ops().onCommit()
                          }}
                        >
                          <Icon name="circle-check" size="small" class="text-icon-weak" />
                          <DropdownMenu.ItemLabel>{i18n.t("ui.sessionReview.gitOps.commit")}</DropdownMenu.ItemLabel>
                          <Show when={ops().commitDisabled()}>
                            <span class="ml-auto text-12-regular text-text-weak">
                              {i18n.t("ui.sessionReview.gitOps.nothingToCommit")}
                            </span>
                          </Show>
                        </DropdownMenu.Item>
                        <DropdownMenu.Item onSelect={() => ops().onPush()}>
                          <Icon name="cloud-upload" size="small" class="text-icon-weak" />
                          <DropdownMenu.ItemLabel>{i18n.t("ui.sessionReview.gitOps.push")}</DropdownMenu.ItemLabel>
                        </DropdownMenu.Item>
                        <DropdownMenu.Item onSelect={() => ops().onCreateBranch()}>
                          <Icon name="branch-icon" size="small" class="text-icon-weak" />
                          <DropdownMenu.ItemLabel>{i18n.t("ui.sessionReview.gitOps.createBranch")}</DropdownMenu.ItemLabel>
                        </DropdownMenu.Item>
                      </DropdownMenu.Content>
                    </DropdownMenu.Portal>
                  </DropdownMenu>
                </Tooltip>
              </div>
            )}
          </Show>
          <Show when={props.fileTreeToggle}>
            {(toggle) => (
              <div onMouseDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
                <Tooltip value={toggle().title()}>
                  <IconButton
                    icon="folder-iocn"
                    variant="ghost"
                    size="small"
                    class="session-review-header-action"
                    aria-label={toggle().title()}
                    aria-expanded={toggle().opened()}
                    onClick={() => toggle().onToggle()}
                  />
                </Tooltip>
              </div>
            )}
          </Show>
          {props.actions}
        </div>
      </div>

      <div data-slot="session-review-body" class="flex flex-1 min-h-0 min-w-0 overflow-hidden">
        <ScrollView
          data-slot="session-review-scroll"
          viewportRef={(el) => {
            scroll = el
            props.scrollRef?.(el)
          }}
          onScroll={handleScroll}
          class="flex-1 min-w-0 min-h-0"
          classList={{
            [props.classes?.root ?? ""]: !!props.classes?.root,
          }}
        >
        <div data-slot="session-review-container" class={props.classes?.container}>
          <Show when={hasDiffs()} fallback={props.empty}>
            <div class="pb-6">
              <Show
                when={props.notice ?? (largeReview() ? i18n.t("ui.sessionReview.largeDiff.singleFileNotice") : undefined)}
              >
                {(notice) => <div data-slot="session-review-notice">{notice()}</div>}
              </Show>
              <Accordion multiple value={open()} onChange={handleChange}>
                <For each={items()}>
                  {(diff) => {
                    const file = diff.file

                    const diffCanRender = () => diffRowCanExpand(diff)

                    const expanded = createMemo(() => open().includes(file))
                    const force = () => !!store.force[file]

                    const comments = createMemo(() => grouped().get(file) ?? [])
                    const commentedLines = createMemo(() => comments().map((c) => c.selection))

                    const beforeText = () => text(diff, "deletions")
                    const afterText = () => text(diff, "additions")
                    const changedLines = () => diff.additions + diff.deletions
                    const renderedLines = () => diff.fileDiff.deletionLines.length + diff.fileDiff.additionLines.length
                    const renderedChars = () => beforeText().length + afterText().length
                    const mediaKind = createMemo(() => mediaKindFromPath(file))
                    const diffNeedsLocalVirtual = createMemo(
                      () =>
                        changedLines() > MAX_DIFF_CHANGED_LINES ||
                        renderedLines() > MAX_INLINE_DIFF_RENDER_LINES ||
                        renderedChars() > MAX_INLINE_DIFF_RENDER_CHARS,
                    )

                    const tooLarge = createMemo(() => {
                      if (!expanded()) return false
                      if (force()) return false
                      if (mediaKind()) return false
                      if (!dontLoadFullFilesOn()) return false
                      return changedLines() > MAX_DIFF_CHANGED_LINES
                    })

                    const isAdded = () =>
                      diff.status === "added" || (beforeText().length === 0 && afterText().length > 0)
                    const isDeleted = () =>
                      diff.status === "deleted" || (afterText().length === 0 && beforeText().length > 0)

                    const selectedLines = createMemo(() => {
                      const current = selection()
                      if (!current || current.file !== file) return null
                      return current.range
                    })

                    const draftRanges = createMemo(() => {
                      const current = store.commenting
                      return Object.entries(current)
                        .filter(([, v]) => v.file === file)
                        .map(([key, v]) => ({ key, range: v.range }))
                    })

                    const commentsUi = createLineCommentController<SessionReviewComment>({
                      comments,
                      label: i18n.t("ui.lineComment.submit"),
                      getDraftKey: (range) => `${file}:${range.start}-${range.end}-${range.side || "both"}`,
                      mention: props.lineCommentMention,
                      cancelDraftOnCommentToggle: true,
                      state: {
                        opened: () => {
                          const current = opened()
                          if (!current || current.file !== file) return null
                          return current.id
                        },
                        setOpened: (id) => setStore("opened", id ? { file, id } : null),
                        selected: selectedLines,
                        setSelected: (range) => setStore("selection", range ? { file, range } : null),
                        commentingRanges: draftRanges,
                        addCommenting: (key, range) => setStore("commenting", key, { file, range }),
                        removeCommenting: (key) => {
                          const next = { ...untrack(() => store.commenting) }
                          delete next[key]
                          setStore("commenting", reconcile(next))
                        },
                      },
                      getSide: selectionSide,
                      clearSelectionOnSelectionEndNull: false,
                      onSubmit: ({ comment, selection }) => {
                        const created = props.onLineComment?.({
                          file,
                          selection,
                          comment,
                          preview: selectionPreview(diff, selection),
                        })
                        if (!created) return

                        setStore("opened", { file, id: created.id })
                        setStore("selection", null)
                        setStore("commenting", reconcile(removeMatchingDraft(untrack(() => store.commenting), file, selection)))
                      },
                      onUpdate: ({ id, comment, selection }) => {
                        props.onLineCommentUpdate?.({
                          id,
                          file,
                          selection,
                          comment,
                          preview: selectionPreview(diff, selection),
                        })
                      },
                      onDelete: (comment) => {
                        props.onLineCommentDelete?.({
                          id: comment.id,
                          file,
                        })
                      },
                      cancelLabel: props.lineCommentActions?.cancelLabel,
                      deleteLabel: props.lineCommentActions?.deleteLabel,
                      editSubmitLabel: props.lineCommentActions?.saveLabel,
                      renderCommentActions: props.lineCommentActions
                        ? (_comment, controls) => (
                            <button
                              type="button"
                              class="text-xs font-medium text-text-subtle transition-colors hover:text-danger-base"
                              onMouseDown={(event) => event.stopPropagation()}
                              onClick={(event) => {
                                event.stopPropagation()
                                controls.remove()
                              }}
                            >
                              {props.lineCommentActions!.deleteLabel}
                            </button>
                          )
                        : undefined,
                    })

                    onCleanup(() => {
                      anchors.delete(file)
                    })

                    const handleLineSelected = (range: SelectedLineRange | null) => {
                      if (!props.onLineComment) return
                      commentsUi.onLineSelected(range)
                    }

                    const handleLineSelectionEnd = (range: SelectedLineRange | null) => {
                      if (!props.onLineComment) return
                      commentsUi.onLineSelectionEnd(range)
                    }

                    return (
                      <Accordion.Item
                        value={file}
                        id={diffId(file)}
                        data-file={file}
                        data-slot="session-review-accordion-item"
                        data-selected={props.focusedFile === file ? "" : undefined}
                      >
                        <StickyAccordionHeader>
                          <Accordion.Trigger
                            disabled={!diffCanRender()}
                            class="cursor-default"
                          >
                            <div data-slot="session-review-trigger-content">
                              <div data-slot="session-review-file-info">
                                <Show when={diffCanRender()}>
                                  <span data-slot="session-review-diff-chevron">
                                    <Icon name="chevron-down" size="small" />
                                  </span>
                                </Show>
                                <FileIcon node={{ path: file, type: "file" }} class="shrink-0 size-4" />
                                <div data-slot="session-review-file-name-container">
                                  <Show when={file.includes("/")}>
                                    <span data-slot="session-review-directory">{`\u202A${getDirectory(file)}\u202C`}</span>
                                  </Show>
                                  <span data-slot="session-review-filename">{getFilename(file)}</span>
                                </div>
                              </div>
                              <div data-slot="session-review-trigger-actions">
                                <Switch>
                                  <Match when={isAdded()}>
                                    <div data-slot="session-review-change-group" data-type="added">
                                      <span data-slot="session-review-change" data-type="added">
                                        {i18n.t("ui.sessionReview.change.added")}
                                      </span>
                                      {/* 超大文件集的行计数只展示终值，避免每位数字创建 30 个动画轨道节点。 */}
                                      <DiffChanges changes={diff} animated={false} />
                                    </div>
                                  </Match>
                                  <Match when={isDeleted()}>
                                    <span data-slot="session-review-change" data-type="removed">
                                      {i18n.t("ui.sessionReview.change.removed")}
                                    </span>
                                  </Match>
                                  <Match when={!!mediaKind()}>
                                    <span data-slot="session-review-change" data-type="modified">
                                      {i18n.t("ui.sessionReview.change.modified")}
                                    </span>
                                  </Match>
                                  <Match when={true}>
                                    {/* 普通修改行同样使用静态计数，保证列表滚动时节点数量稳定。 */}
                                    <DiffChanges changes={diff} animated={false} />
                                  </Match>
                                </Switch>
                                <Show when={props.onViewFile && diffCanRender()}>
                                  <Tooltip value={openFileLabel()} placement="top" gutter={4}>
                                    <button
                                      data-slot="session-review-view-button"
                                      type="button"
                                      aria-label={openFileLabel()}
                                      onClick={(e) => {
                                        e.stopPropagation()
                                        props.onViewFile?.(file)
                                      }}
                                    >
                                      <Icon name="open-file" size="small" />
                                    </button>
                                  </Tooltip>
                                </Show>
                              </div>
                            </div>
                          </Accordion.Trigger>
                        </StickyAccordionHeader>
                        <Accordion.Content data-slot="session-review-accordion-content">
                          <div
                            data-slot="session-review-diff-wrapper"
                            ref={(el) => {
                              anchors.set(file, el)
                            }}
                          >
                            <Show when={expanded()}>
                              <Switch>
                                <Match when={tooLarge()}>
                                  <div data-slot="session-review-large-diff">
                                    <div data-slot="session-review-large-diff-title">
                                      {i18n.t("ui.sessionReview.largeDiff.title")}
                                    </div>
                                    <div data-slot="session-review-large-diff-meta">
                                      {i18n.t("ui.sessionReview.largeDiff.meta", {
                                        limit: MAX_DIFF_CHANGED_LINES.toLocaleString(),
                                        current: changedLines().toLocaleString(),
                                      })}
                                    </div>
                                    <div data-slot="session-review-large-diff-actions">
                                      <Button
                                        size="normal"
                                        variant="secondary"
                                        onClick={() => setStore("force", file, true)}
                                      >
                                        {i18n.t("ui.sessionReview.largeDiff.renderAnyway")}
                                      </Button>
                                    </div>
                                  </div>
                                </Match>
                                <Match when={true}>
                                  <For each={[`${file}:${diff.signature}`]}>
                                    {() => (
                                      <Dynamic
                                        component={fileComponent}
                                        mode="diff"
                                        fileDiff={diff.fileDiff}
                                        preloadedDiff={diff.preloaded}
                                        virtual={diffNeedsLocalVirtual() ? "local" : false}
                                        diffStyle={diffStyle()}
                                        {...fileDiffOptions()}
                                        onRendered={() => {
                                          props.onDiffRendered?.()
                                        }}
                                        enableLineSelection={props.onLineComment != null}
                                        enableHoverUtility={props.onLineComment != null}
                                        onLineSelected={handleLineSelected}
                                        onLineSelectionEnd={handleLineSelectionEnd}
                                        onLineNumberSelectionEnd={commentsUi.onLineNumberSelectionEnd}
                                        annotations={commentsUi.annotations()}
                                        renderAnnotation={commentsUi.renderAnnotation}
                                        renderHoverUtility={props.onLineComment ? commentsUi.renderHoverUtility : undefined}
                                        selectedLines={selectedLines()}
                                        commentedLines={commentedLines()}
                                        media={{
                                          mode: richPreviewOn() ? "auto" : "off",
                                          path: file,
                                          deleted: diff.status === "deleted",
                                          readFile: diff.status === "deleted" ? undefined : props.readFile,
                                        }}
                                      />
                                    )}
                                  </For>
                                </Match>
                              </Switch>
                            </Show>
                          </div>
                        </Accordion.Content>
                      </Accordion.Item>
                    )
                  }}
                </For>
              </Accordion>
            </div>
          </Show>
        </div>
        </ScrollView>
        {props.fileTreeRail}
      </div>
    </div>
  )
}

export {
  diffRowCanExpand,
  filterDiffRowsWithMaterialChange,
  gitPatchHasNonContextLines,
  isSessionReviewFileRemoved,
  mergeDiffsWithOverlay,
  toolDiffsFromParts,
  type MergeableDiff,
} from "./session-diff"
