import { createEffect, createMemo, createSignal, onCleanup, Show, type JSX } from "solid-js"
import { createMediaQuery } from "@solid-primitives/media"
import { makeEventListener } from "@solid-primitives/event-listener"
import type { SnapshotFileDiff, VcsFileDiff } from "@opencode-ai/sdk/v2"
import { SessionReview } from "@opencode-ai/ui/session-review"
import { useI18n } from "@opencode-ai/ui/context/i18n"
import type {
  SessionReviewCommentActions,
  SessionReviewCommentDelete,
  SessionReviewCommentUpdate,
  SessionReviewGitOpsMenu,
} from "@opencode-ai/ui/session-review"
import { Icon } from "@opencode-ai/ui/icon"
import { ResizeHandle } from "@opencode-ai/ui/resize-handle"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import type { SelectedLineRange } from "@/context/file"
import { useSDK } from "@/context/sdk"
import { useLayout } from "@/context/layout"
import { useLanguage } from "@/context/language"
import type { LineComment } from "@/context/comments"
import FileTree from "@/components/file-tree"

export type DiffStyle = "unified" | "split"

type ReviewDiff = SnapshotFileDiff | VcsFileDiff

function reviewDiffKinds(diffs: readonly ReviewDiff[]) {
  const out = new Map<string, "add" | "del" | "mix">()
  for (const diff of diffs) {
    const file = diff.file.replaceAll("\\\\", "/").replace(/\/+$/, "")
    const kind = diff.status === "added" ? "add" : diff.status === "deleted" ? "del" : "mix"
    out.set(file, kind)
    const parts = file.split("/")
    for (const [idx] of parts.slice(0, -1).entries()) {
      const dir = parts.slice(0, idx + 1).join("/")
      if (!dir) continue
      const prev = out.get(dir)
      if (!prev) {
        out.set(dir, kind)
        continue
      }
      if (prev === kind) continue
      out.set(dir, "mix")
    }
  }
  return out
}

function ReviewFileTreeRail(props: {
  diffs: () => ReviewDiff[]
  active?: string
  onFileClick: (path: string) => void
  width: () => number
  onResize: (width: number) => void
  filterPlaceholder: string
}) {
  const [query, setQuery] = createSignal("")
  const kinds = createMemo(() => reviewDiffKinds(props.diffs()))
  const diffFiles = createMemo(() => props.diffs().map((d) => d.file))
  const allowed = createMemo(() => {
    const q = query().trim().toLowerCase()
    if (!q) return diffFiles()
    return diffFiles().filter((file) => file.toLowerCase().includes(q))
  })

  return (
    <div
      data-slot="session-review-file-tree-rail"
      class="relative shrink-0 h-full flex flex-col border-l border-border-weaker-base bg-background-base overflow-hidden"
      style={{ width: `${props.width()}px` }}
    >
      <div class="shrink-0 px-3 pt-2 pb-2">
        <div class="flex items-center gap-1.5 h-7 px-2 rounded-md border border-border-weak-base bg-surface-panel focus-within:border-border-strong-base">
          <Icon name="magnifying-glass" size="small" class="shrink-0 text-icon-weak-base" />
          <input
            type="search"
            class="min-w-0 flex-1 bg-transparent border-0 outline-none text-12-regular text-text-strong placeholder:text-text-weak"
            placeholder={props.filterPlaceholder}
            value={query()}
            onInput={(event) => setQuery(event.currentTarget.value)}
          />
        </div>
      </div>
      <ScrollView class="flex-1 min-h-0 px-3 pb-3">
        <FileTree
          path=""
          class="pt-1"
          variant="review"
          allowed={allowed()}
          kinds={kinds()}
          draggable={false}
          active={props.active}
          onFileClick={(node) => props.onFileClick(node.path)}
        />
      </ScrollView>
      <div class="absolute inset-y-0 left-0">
        <ResizeHandle
          direction="horizontal"
          edge="start"
          size={props.width()}
          min={200}
          max={480}
          onResize={props.onResize}
        />
      </div>
    </div>
  )
}

export interface SessionReviewTabProps {
  title?: JSX.Element
  notice?: JSX.Element
  empty?: JSX.Element
  diffs: () => ReviewDiff[]
  railDiffs?: () => ReviewDiff[]
  view: () => ReturnType<ReturnType<typeof useLayout>["view"]>
  diffStyle: DiffStyle
  onDiffStyleChange?: (style: DiffStyle) => void
  onViewFile?: (file: string) => void
  onLineComment?: (comment: { file: string; selection: SelectedLineRange; comment: string; preview?: string }) => {
    id: string
    file: string
    selection: SelectedLineRange
    comment: string
  } | undefined
  onLineCommentUpdate?: (comment: SessionReviewCommentUpdate) => void
  onLineCommentDelete?: (comment: SessionReviewCommentDelete) => void
  lineCommentActions?: SessionReviewCommentActions
  comments?: LineComment[]
  focusedComment?: { file: string; id: string } | null
  onFocusedCommentChange?: (focus: { file: string; id: string } | null) => void
  focusedFile?: string
  onFocusedFileChange?: (file: string) => void
  onScrollRef?: (el: HTMLDivElement) => void
  onDiffToolbarRefresh?: () => void
  diffWhitespaceMenuDisabled?: () => boolean
  /** Git 仓库：与分支详情卡片一致的提交 / 推送 / 建分支菜单。 */
  gitOpsMenu?: SessionReviewGitOpsMenu
  commentMentions?: {
    items: (query: string) => string[] | Promise<string[]>
  }
  classes?: {
    root?: string
    header?: string
    container?: string
  }
}

export function SessionReviewTab(props: SessionReviewTabProps) {
  let scroll: HTMLDivElement | undefined
  let restoreFrame: number | undefined
  let userInteracted = false
  let restored: { x: number; y: number } | undefined

  const sdk = useSDK()
  const layout = useLayout()
  const language = useLanguage()
  const uiI18n = useI18n()
  const isDesktop = createMediaQuery("(min-width: 768px)")

  createEffect(() => {
    if (isDesktop()) return
    if (!layout.fileTree.opened()) return
    layout.fileTree.close()
  })

  const readFile = async (path: string) => {
    return sdk.client.file
      .read({ path })
      .then((x) => x.data)
      .catch((error) => {
        console.debug("[session-review] failed to read file", { path, error })
        return undefined
      })
  }

  const handleInteraction = () => {
    userInteracted = true

    if (restoreFrame !== undefined) {
      cancelAnimationFrame(restoreFrame)
      restoreFrame = undefined
    }
  }

  const doRestore = () => {
    restoreFrame = undefined
    const el = scroll
    if (!el || !layout.ready() || userInteracted) return
    if (el.clientHeight === 0 || el.clientWidth === 0) return

    const s = props.view().scroll("review")
    if (!s || (s.x === 0 && s.y === 0)) return

    const maxY = Math.max(0, el.scrollHeight - el.clientHeight)
    const maxX = Math.max(0, el.scrollWidth - el.clientWidth)

    const targetY = Math.min(s.y, maxY)
    const targetX = Math.min(s.x, maxX)

    if (el.scrollTop === targetY && el.scrollLeft === targetX) return

    if (el.scrollTop !== targetY) el.scrollTop = targetY
    if (el.scrollLeft !== targetX) el.scrollLeft = targetX
    restored = { x: el.scrollLeft, y: el.scrollTop }
  }

  const queueRestore = () => {
    if (userInteracted || restoreFrame !== undefined) return
    restoreFrame = requestAnimationFrame(doRestore)
  }

  const handleScroll = (event: Event & { currentTarget: HTMLDivElement }) => {
    const el = event.currentTarget
    const prev = restored
    if (prev && el.scrollTop === prev.y && el.scrollLeft === prev.x) {
      restored = undefined
      return
    }

    restored = undefined
    handleInteraction()
    if (!layout.ready()) return
    if (el.clientHeight === 0 || el.clientWidth === 0) return

    props.view().setScroll("review", {
      x: el.scrollLeft,
      y: el.scrollTop,
    })
  }

  createEffect(() => {
    props.diffs().length
    props.diffStyle
    if (!layout.ready()) return
    queueRestore()
  })

  onCleanup(() => {
    if (restoreFrame !== undefined) cancelAnimationFrame(restoreFrame)
  })

  const fileTreeRail = () =>
    isDesktop() && layout.fileTree.opened() ? (
      <ReviewFileTreeRail
        diffs={props.railDiffs ?? props.diffs}
        active={props.focusedFile}
        onFileClick={(path) => props.onFocusedFileChange?.(path)}
        width={() => layout.fileTree.width()}
        onResize={(width) => layout.fileTree.resize(width)}
        filterPlaceholder={uiI18n.t("ui.sessionReview.filterFiles")}
      />
    ) : undefined

  return (
    <SessionReview
      title={props.title}
      notice={props.notice}
      empty={props.empty}
      scrollRef={(el) => {
        scroll = el
        makeEventListener(el, "wheel", handleInteraction, { passive: true, capture: true })
        makeEventListener(el, "mousewheel", handleInteraction, { passive: true, capture: true })
        makeEventListener(el, "pointerdown", handleInteraction, { passive: true, capture: true })
        makeEventListener(el, "touchstart", handleInteraction, { passive: true, capture: true })
        makeEventListener(el, "keydown", handleInteraction, { capture: true })
        props.onScrollRef?.(el)
        queueRestore()
      }}
      onScroll={handleScroll}
      onDiffRendered={queueRestore}
      diffWhitespaceMenuDisabled={props.diffWhitespaceMenuDisabled}
      onDiffToolbarRefresh={props.onDiffToolbarRefresh}
      gitOpsMenu={props.gitOpsMenu}
      diffPreferences={{
        wordWrap: () => layout.review.diffWordWrap(),
        setWordWrap: (value) => layout.review.setDiffWordWrap(value),
        dontLoadFullFiles: () => layout.review.diffDontLoadFullFiles(),
        setDontLoadFullFiles: (value) => layout.review.setDiffDontLoadFullFiles(value),
        richPreview: () => layout.review.diffRichPreview(),
        setRichPreview: (value) => layout.review.setDiffRichPreview(value),
        wordDiffs: () => layout.review.diffWordDiffs(),
        setWordDiffs: (value) => layout.review.setDiffWordDiffs(value),
        ignoreWhitespace: () => layout.review.diffIgnoreWhitespace(),
        setIgnoreWhitespace: (value) => layout.review.setDiffIgnoreWhitespace(value),
      }}
      open={props.view().review.open()}
      onOpenChange={props.view().review.setOpen}
      classes={{
        root: props.classes?.root ?? "pr-3",
        header: props.classes?.header ?? "px-3",
        container: props.classes?.container ?? "pl-3",
      }}
      diffs={props.diffs()}
      diffStyle={props.diffStyle}
      onDiffStyleChange={props.onDiffStyleChange}
      onViewFile={props.onViewFile}
      focusedFile={props.focusedFile}
      onFocusedFileChange={props.onFocusedFileChange}
      readFile={readFile}
      onLineComment={props.onLineComment}
      onLineCommentUpdate={props.onLineCommentUpdate}
      onLineCommentDelete={props.onLineCommentDelete}
      lineCommentActions={props.lineCommentActions}
      lineCommentMention={props.commentMentions}
      comments={props.comments}
      focusedComment={props.focusedComment}
      onFocusedCommentChange={props.onFocusedCommentChange}
      fileTreeToggle={
        isDesktop()
          ? {
              opened: () => layout.fileTree.opened(),
              onToggle: () => {
                if (layout.fileTree.opened()) layout.fileTree.close()
                else layout.fileTree.open()
              },
              title: () => language.t("command.fileTree.toggle"),
            }
          : undefined
      }
      fileTreeRail={fileTreeRail()}
    />
  )
}
