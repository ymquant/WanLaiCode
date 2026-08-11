import { type DiffLineAnnotation, type SelectedLineRange } from "@pierre/diffs"
import { createEffect, createMemo, createSignal, getOwner, onCleanup, runWithOwner, Show, type Accessor, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { render as renderSolid } from "solid-js/web"
import { useI18n } from "../context/i18n"
import { createHoverCommentUtility } from "../pierre/comment-hover"
import { cloneSelectedLineRange, formatSelectedLineLabel, lineInSelectedRange } from "../pierre/selection-bridge"
import { LineComment, LineCommentEditor, type LineCommentEditorProps } from "./line-comment"

export type LineCommentAnnotationMeta<T> =
  | { kind: "comment"; key: string; comment: T }
  | { kind: "draft"; key: string; range: SelectedLineRange }

export type LineCommentAnnotation<T> = {
  lineNumber: number
  side?: "additions" | "deletions"
  metadata: LineCommentAnnotationMeta<T>
}

type DraftRangeEntry = { key: string; range: SelectedLineRange }

type LineCommentAnnotationsProps<T> = {
  comments: Accessor<T[]>
  getCommentId: (comment: T) => string
  getCommentSelection: (comment: T) => SelectedLineRange
  draftRanges: Accessor<DraftRangeEntry[]>
}

type LineCommentAnnotationsWithSideProps<T> = LineCommentAnnotationsProps<T> & {
  getSide: (range: SelectedLineRange) => "additions" | "deletions"
}

function makeDraftKey(range: SelectedLineRange): string {
  return `${range.start}-${range.end}-${range.side || "both"}`
}

type HoverCommentLine = {
  lineNumber: number
  side?: "additions" | "deletions"
}

type LineCommentStateProps<T> = {
  opened: Accessor<T | null>
  setOpened: (id: T | null) => void
  selected: Accessor<SelectedLineRange | null>
  setSelected: (range: SelectedLineRange | null) => void
  commentingRanges: Accessor<DraftRangeEntry[]>
  addCommenting: (key: string, range: SelectedLineRange) => void
  removeCommenting: (key: string) => void
  getDraftKey?: (range: SelectedLineRange) => string
  syncSelected?: (range: SelectedLineRange | null) => void
  hoverSelected?: (range: SelectedLineRange) => void
}

type LineCommentShape = {
  id: string
  selection: SelectedLineRange
  comment: string
}

type LineCommentControllerProps<T extends LineCommentShape> = {
  comments: Accessor<T[]>
  label: string
  getDraftKey?: (range: SelectedLineRange) => string
  mention?: LineCommentEditorProps["mention"]
  state: LineCommentStateProps<string>
  onSubmit: (input: { comment: string; selection: SelectedLineRange }) => void
  onUpdate?: (input: { id: string; comment: string; selection: SelectedLineRange }) => void
  onDelete?: (comment: T) => void
  renderCommentActions?: (comment: T, controls: { edit: VoidFunction; remove: VoidFunction }) => JSX.Element
  cancelLabel?: string
  deleteLabel?: string
  editSubmitLabel?: string
  onDraftPopoverFocusOut?: JSX.EventHandlerUnion<HTMLDivElement, FocusEvent>
  getHoverSelectedRange?: Accessor<SelectedLineRange | null>
  cancelDraftOnCommentToggle?: boolean
  clearSelectionOnSelectionEndNull?: boolean
}

type LineCommentControllerWithSideProps<T extends LineCommentShape> = LineCommentControllerProps<T> & {
  getSide: (range: SelectedLineRange) => "additions" | "deletions"
}

type CommentProps = {
  id?: string
  open: boolean
  comment: JSX.Element
  selection: JSX.Element
  actions?: JSX.Element
  editor?: DraftProps
  onClick?: JSX.EventHandlerUnion<HTMLButtonElement, MouseEvent>
  onMouseEnter?: JSX.EventHandlerUnion<HTMLButtonElement, MouseEvent>
}

type DraftProps = {
  value: string
  selection: JSX.Element
  mention?: LineCommentEditorProps["mention"]
  onInput: (value: string) => void
  onCancel: VoidFunction
  onDelete?: VoidFunction
  onSubmit: (value: string) => void
  onPopoverFocusOut?: JSX.EventHandlerUnion<HTMLDivElement, FocusEvent>
  title?: JSX.Element
  cancelLabel?: string
  deleteLabel?: string
  submitLabel?: string
}

export function createLineCommentAnnotationRenderer<T>(props: {
  renderComment: (comment: T) => CommentProps
  renderDraft: (range: SelectedLineRange) => DraftProps
}) {
  const owner = getOwner()
  const nodes = new Map<
    string,
    {
      host: HTMLDivElement
      dispose: VoidFunction
      setMeta: (meta: LineCommentAnnotationMeta<T>) => void
    }
  >()

  const mount = (meta: LineCommentAnnotationMeta<T>) => {
    if (typeof document === "undefined") return

    const host = document.createElement("div")
    host.setAttribute("data-prevent-autofocus", "")
    const [current, setCurrent] = createSignal(meta)

    const dispose = renderSolid(
      () =>
        runWithOwner(owner, () => {
          const active = current()
          if (active.kind === "comment") {
            const view = createMemo(() => {
              const next = current()
              if (next.kind !== "comment") return props.renderComment(active.comment)
              return props.renderComment(next.comment)
            })
            return (
              <Show
                when={view().editor}
                fallback={
                  <LineComment
                    inline
                    id={view().id}
                    open={view().open}
                    comment={view().comment}
                    selection={view().selection}
                    actions={view().actions}
                    onClick={view().onClick}
                    onMouseEnter={view().onMouseEnter}
                  />
                }
              >
                <LineCommentEditor
                  inline
                  id={view().id}
                  value={view().editor!.value}
                  selection={view().editor!.selection}
                  onInput={view().editor!.onInput}
                  onCancel={view().editor!.onCancel}
                  onDelete={view().editor!.onDelete}
                  onSubmit={view().editor!.onSubmit}
                  onPopoverFocusOut={view().editor!.onPopoverFocusOut}
                  cancelLabel={view().editor!.cancelLabel}
                  deleteLabel={view().editor!.deleteLabel}
                  submitLabel={view().editor!.submitLabel}
                  title={view().editor!.title}
                  mention={view().editor!.mention}
                />
              </Show>
            )
          }

          const view = createMemo(() => {
            const next = current()
            if (next.kind !== "draft") return props.renderDraft(active.range)
            return props.renderDraft(next.range)
          })
          return (
            <LineCommentEditor
              inline
              value={view().value}
              selection={view().selection}
              onInput={view().onInput}
              onCancel={view().onCancel}
              onDelete={view().onDelete}
              onSubmit={view().onSubmit}
              onPopoverFocusOut={view().onPopoverFocusOut}
              cancelLabel={view().cancelLabel}
              deleteLabel={view().deleteLabel}
              submitLabel={view().submitLabel}
              title={view().title}
              mention={view().mention}
            />
          )
        }),
      host,
    )

    host.setAttribute("data-lc-host", "")
    host.style.setProperty("overflow-x", "hidden", "important")
    host.style.width = "100%"

    const node = { host, dispose, setMeta: setCurrent }
    nodes.set(meta.key, node)
    return node
  }

  const render = <A extends { metadata: LineCommentAnnotationMeta<T> }>(annotation: A) => {
    const meta = annotation.metadata
    const node = nodes.get(meta.key) ?? mount(meta)
    if (!node) return
    node.setMeta(meta)
    return node.host
  }

  const reconcile = <A extends { metadata: LineCommentAnnotationMeta<T> }>(annotations: A[]) => {
    const next = new Set(annotations.map((annotation) => annotation.metadata.key))
    for (const [key, node] of nodes) {
      if (next.has(key)) continue
      node.dispose()
      nodes.delete(key)
    }
  }

  const cleanup = () => {
    for (const [, node] of nodes) node.dispose()
    nodes.clear()
  }

  return { render, reconcile, cleanup }
}

export function createLineCommentState<T>(props: LineCommentStateProps<T>) {
  const [state, setState] = createStore<{
    draft: string
    drafts: Record<string, string>
    editing: T | null
  }>({
    draft: "",
    drafts: {},
    editing: null,
  })
  const draft = () => state.draft
  const setDraft = (value: string) => setState("draft", value)
  const getDraftText = (key: string) => state.drafts[key] ?? ""
  const setDraftText = (key: string, value: string) => setState("drafts", key, value)
  const removeDraftText = (key: string) => {
    setState("drafts", (drafts) => {
      const next = { ...drafts }
      delete next[key]
      return next
    })
  }
  const editing = () => state.editing
  const setEditing = (value: T | null) => setState("editing", typeof value === "function" ? () => value : value)

  const toRange = (range: SelectedLineRange | null) => (range ? cloneSelectedLineRange(range) : null)
  const setSelected = (range: SelectedLineRange | null) => {
    const next = toRange(range)
    props.setSelected(next)
    props.syncSelected?.(toRange(next))
    return next
  }

  const closeComment = () => {
    props.setOpened(null)
  }

  const cancelDraft = (key?: string) => {
    if (key) {
      removeDraftText(key)
      props.removeCommenting(key)
    } else {
      setDraft("")
      const ranges = props.commentingRanges()
      for (const { key: k } of ranges) {
        removeDraftText(k)
        props.removeCommenting(k)
      }
    }
    setEditing(null)
  }

  const reset = () => {
    setDraft("")
    setState("drafts", {})
    setEditing(null)
    props.setOpened(null)
    props.setSelected(null)
    const ranges = props.commentingRanges()
    for (const { key } of ranges) {
      props.removeCommenting(key)
    }
  }

  const openComment = (id: T, range: SelectedLineRange, options?: { cancelDraft?: boolean }) => {
    if (options?.cancelDraft) cancelDraft()
    props.setOpened(id)
    setSelected(range)
  }

  const toggleComment = (id: T, range: SelectedLineRange, options?: { cancelDraft?: boolean }) => {
    if (options?.cancelDraft) cancelDraft()
    const next = props.opened() === id ? null : id
    props.setOpened(next)
    setSelected(range)
  }

  const openDraft = (range: SelectedLineRange) => {
    const next = toRange(range)
    if (!next) return
    const key = props.getDraftKey?.(next) ?? makeDraftKey(next)
    if (props.commentingRanges().some((item) => item.key === key)) {
      closeComment()
      setSelected(next)
      return
    }
    setDraftText(key, "")
    setEditing(null)
    closeComment()
    setSelected(next)
    props.addCommenting(key, next)
  }

  const openEditor = (id: T, range: SelectedLineRange, value: string) => {
    closeComment()
    setSelected(range)
    setEditing(id)
    setDraft(value)
  }

  const cancelEditor = (id: T, range: SelectedLineRange) => {
    setEditing(null)
    props.setOpened(id)
    setSelected(range)
    setDraft("")
  }

  const hoverComment = (range: SelectedLineRange) => {
    const next = toRange(range)
    if (!next) return
    if (props.hoverSelected) {
      props.hoverSelected(next)
      return
    }

    setSelected(next)
  }

  const finishSelection = (range: SelectedLineRange) => {
    closeComment()
    setSelected(range)
  }

  return {
    draft,
    setDraft,
    getDraftText,
    setDraftText,
    editing,
    opened: props.opened,
    selected: props.selected,
    commentingRanges: props.commentingRanges,
    isOpen: (id: T) => props.opened() === id,
    isEditing: (id: T) => editing() === id,
    closeComment,
    openComment,
    toggleComment,
    openDraft,
    openEditor,
    cancelEditor,
    hoverComment,
    cancelDraft,
    finishSelection,
    select: setSelected,
    reset,
  }
}

export function createLineCommentController<T extends LineCommentShape>(
  props: LineCommentControllerWithSideProps<T>,
): {
  note: ReturnType<typeof createLineCommentState<string>>
  annotations: Accessor<DiffLineAnnotation<LineCommentAnnotationMeta<T>>[]>
  renderAnnotation: ReturnType<typeof createManagedLineCommentAnnotationRenderer<T>>["renderAnnotation"]
  renderHoverUtility: ReturnType<typeof createLineCommentHoverRenderer>
  onLineSelected: (range: SelectedLineRange | null) => void
  onLineSelectionEnd: (range: SelectedLineRange | null) => void
  onLineNumberSelectionEnd: (range: SelectedLineRange | null) => void
}
export function createLineCommentController<T extends LineCommentShape>(
  props: LineCommentControllerProps<T>,
): {
  note: ReturnType<typeof createLineCommentState<string>>
  annotations: Accessor<LineCommentAnnotation<T>[]>
  renderAnnotation: ReturnType<typeof createManagedLineCommentAnnotationRenderer<T>>["renderAnnotation"]
  renderHoverUtility: ReturnType<typeof createLineCommentHoverRenderer>
  onLineSelected: (range: SelectedLineRange | null) => void
  onLineSelectionEnd: (range: SelectedLineRange | null) => void
  onLineNumberSelectionEnd: (range: SelectedLineRange | null) => void
}
export function createLineCommentController<T extends LineCommentShape>(
  props: LineCommentControllerProps<T> | LineCommentControllerWithSideProps<T>,
) {
  const i18n = useI18n()
  const draftKey = (range: SelectedLineRange) => props.getDraftKey?.(range) ?? makeDraftKey(range)
  const note = createLineCommentState<string>({ ...props.state, getDraftKey: props.getDraftKey })
  const sameRange = (a: SelectedLineRange, b: SelectedLineRange) =>
    a.start === b.start &&
    a.end === b.end &&
    (a.side ?? "both") === (b.side ?? "both")
  const findComment = (range: SelectedLineRange) =>
    props.comments().find((comment) => sameRange(comment.selection, range))
  const openCommentOrDraft = (range: SelectedLineRange) => {
    const comment = findComment(range)
    if (comment) {
      note.openComment(comment.id, comment.selection, { cancelDraft: true })
      return
    }

    note.openDraft(range)
  }

  const annotations =
    "getSide" in props
      ? createLineCommentAnnotations({
          comments: props.comments,
          getCommentId: (comment) => comment.id,
          getCommentSelection: (comment) => comment.selection,
          draftRanges: note.commentingRanges,
          getSide: props.getSide,
        })
      : createLineCommentAnnotations({
          comments: props.comments,
          getCommentId: (comment) => comment.id,
          getCommentSelection: (comment) => comment.selection,
          draftRanges: note.commentingRanges,
        })

  const { renderAnnotation } = createManagedLineCommentAnnotationRenderer<T>({
    annotations,
    renderComment: (comment) => {
      const edit = () => note.openEditor(comment.id, comment.selection, comment.comment)
      const remove = () => {
        note.closeComment()
        note.select(null)
        props.onDelete?.(comment)
      }

      return {
        id: comment.id,
        get open() {
          return note.isOpen(comment.id) || note.isEditing(comment.id)
        },
        title: i18n.t("ui.lineComment.localTitle"),
        comment: comment.comment,
        selection: formatSelectedLineLabel(comment.selection, i18n.t),
        get actions() {
          return props.renderCommentActions?.(comment, { edit, remove })
        },
        get editor() {
          return note.isEditing(comment.id)
            ? {
                get value() {
                  return note.draft()
                },
                selection: formatSelectedLineLabel(comment.selection, i18n.t),
                mention: props.mention,
                onInput: note.setDraft,
                onCancel: () => note.cancelEditor(comment.id, comment.selection),
                onDelete: remove,
                onSubmit: (value: string) => {
                  props.onUpdate?.({
                    id: comment.id,
                    comment: value,
                    selection: cloneSelectedLineRange(comment.selection),
                  })
                  note.cancelEditor(comment.id, comment.selection)
                },
                cancelLabel: props.cancelLabel,
                deleteLabel: props.deleteLabel,
                submitLabel: props.editSubmitLabel,
                title: i18n.t("ui.lineComment.localTitle"),
              }
            : undefined
        },
        onMouseEnter: () => note.hoverComment(comment.selection),
        onClick: () => {
          if (note.isEditing(comment.id)) return
          note.openEditor(comment.id, comment.selection, comment.comment)
        },
      }
    },
    renderDraft: (range) => {
      const key = draftKey(range)
      return {
        get value() {
          return note.getDraftText(key)
        },
        selection: formatSelectedLineLabel(range, i18n.t),
        mention: props.mention,
        onInput: (value) => note.setDraftText(key, value),
        onCancel: () => {
          note.cancelDraft(key)
          note.closeComment()
          note.select(null)
        },
        cancelLabel: props.cancelLabel,
        deleteLabel: props.deleteLabel,
        onSubmit: (comment) => {
          props.onSubmit({ comment, selection: cloneSelectedLineRange(range) })
          note.cancelDraft(key)
        },
        title: i18n.t("ui.lineComment.localTitle"),
        onPopoverFocusOut: props.onDraftPopoverFocusOut,
      }
    },
  })

  const renderHoverUtility = createLineCommentHoverRenderer({
    label: props.label,
    getSelectedRange: () => {
      if (note.opened()) return null
      return props.getHoverSelectedRange?.() ?? note.selected()
    },
    onOpenDraft: openCommentOrDraft,
  })

  const onLineSelected = (range: SelectedLineRange | null) => {
    if (!range) {
      note.select(null)
      return
    }

    note.select(range)
  }

  const onLineSelectionEnd = (range: SelectedLineRange | null) => {
    if (!range) {
      if (props.clearSelectionOnSelectionEndNull) note.select(null)
      return
    }

    note.finishSelection(range)
  }

  const onLineNumberSelectionEnd = (range: SelectedLineRange | null) => {
    if (!range) return
    openCommentOrDraft(range)
  }

  return {
    note,
    annotations,
    renderAnnotation,
    renderHoverUtility,
    onLineSelected,
    onLineSelectionEnd,
    onLineNumberSelectionEnd,
  }
}

export function createLineCommentAnnotations<T>(
  props: LineCommentAnnotationsWithSideProps<T>,
): Accessor<DiffLineAnnotation<LineCommentAnnotationMeta<T>>[]>
export function createLineCommentAnnotations<T>(
  props: LineCommentAnnotationsProps<T>,
): Accessor<LineCommentAnnotation<T>[]>
export function createLineCommentAnnotations<T>(
  props: LineCommentAnnotationsProps<T> | LineCommentAnnotationsWithSideProps<T>,
) {
  const line = (range: SelectedLineRange) => Math.max(range.start, range.end)
  const sameRange = (a: SelectedLineRange, b: SelectedLineRange) =>
    a.start === b.start &&
    a.end === b.end &&
    (a.side ?? "both") === (b.side ?? "both")

  if ("getSide" in props) {
    return createMemo<DiffLineAnnotation<LineCommentAnnotationMeta<T>>[]>(() => {
      const drafts = props.draftRanges()
      const list = props.comments()
        .filter((comment) => !drafts.some(({ range }) => sameRange(props.getCommentSelection(comment), range)))
        .map((comment) => {
        const range = props.getCommentSelection(comment)
        return {
          side: props.getSide(range),
          lineNumber: line(range),
          metadata: {
            kind: "comment",
            key: `comment:${props.getCommentId(comment)}`,
            comment,
          } satisfies LineCommentAnnotationMeta<T>,
        }
      })

      const draftAnnotations = drafts.map(({ key, range }) => ({
        side: props.getSide(range),
        lineNumber: line(range),
        metadata: {
          kind: "draft",
          key: `draft:${key}`,
          range,
        } satisfies LineCommentAnnotationMeta<T>,
      }))

      return [...list, ...draftAnnotations]
    })
  }

  return createMemo<LineCommentAnnotation<T>[]>(() => {
    const drafts = props.draftRanges()
    const list = props.comments()
      .filter((comment) => !drafts.some(({ range }) => sameRange(props.getCommentSelection(comment), range)))
      .map((comment) => {
      const range = props.getCommentSelection(comment)
      const entry: LineCommentAnnotation<T> = {
        lineNumber: line(range),
        metadata: {
          kind: "comment",
          key: `comment:${props.getCommentId(comment)}`,
          comment,
        },
      }

      return entry
    })

    const draftAnnotations = drafts.map(
      ({ key, range }): LineCommentAnnotation<T> => ({
        lineNumber: line(range),
        metadata: {
          kind: "draft",
          key: `draft:${key}`,
          range,
        },
      }),
    )

    return [...list, ...draftAnnotations]
  })
}

export function createManagedLineCommentAnnotationRenderer<T>(props: {
  annotations: Accessor<LineCommentAnnotation<T>[]>
  renderComment: (comment: T) => CommentProps
  renderDraft: (range: SelectedLineRange) => DraftProps
}) {
  const renderer = createLineCommentAnnotationRenderer<T>({
    renderComment: props.renderComment,
    renderDraft: props.renderDraft,
  })

  createEffect(() => {
    renderer.reconcile(props.annotations())
  })

  onCleanup(() => {
    renderer.cleanup()
  })

  return {
    renderAnnotation: renderer.render,
  }
}

export function createLineCommentHoverRenderer(props: {
  label: string
  getSelectedRange: Accessor<SelectedLineRange | null>
  onOpenDraft: (range: SelectedLineRange) => void
}) {
  return (getHoveredLine: () => HoverCommentLine | undefined) =>
    createHoverCommentUtility({
      label: props.label,
      getHoveredLine,
      onSelect: (hovered) => {
        const current = props.getSelectedRange()
        if (current && lineInSelectedRange(current, hovered.lineNumber, hovered.side)) {
          props.onOpenDraft(cloneSelectedLineRange(current))
          return
        }

        const range: SelectedLineRange = {
          start: hovered.lineNumber,
          end: hovered.lineNumber,
        }
        if (hovered.side) range.side = hovered.side
        props.onOpenDraft(range)
      },
    })
}
