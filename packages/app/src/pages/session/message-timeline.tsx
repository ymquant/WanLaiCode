import { For, createEffect, createMemo, on, onCleanup, Show, Index, type JSX, createSignal } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { useNavigate } from "@solidjs/router"
import { openSettingsOverlay } from "@/context/open-settings"
import { openUserCenterOverlay } from "@/context/open-user-center"
import type { TabID } from "@/pages/users/types"
import { useMutation, useQueryClient } from "@tanstack/solid-query"
import { Button } from "@opencode-ai/ui/button"
import { FileIcon } from "@opencode-ai/ui/file-icon"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Dialog } from "@opencode-ai/ui/dialog"
import { InlineInput } from "@opencode-ai/ui/inline-input"
import { SessionTurn } from "@opencode-ai/ui/session-turn"
import type { EditSummaryOpener } from "@opencode-ai/ui/message-part"
import type { ErrorAction } from "@opencode-ai/core/error/error-actions"
import { DialogConnectProvider } from "@/components/dialog-connect-provider"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import type { AutoScrollDirection } from "@opencode-ai/ui/hooks"
import { TextField } from "@opencode-ai/ui/text-field"
import type {
  AssistantMessage,
  Message as MessageType,
  Part,
  SnapshotFileDiff,
  TextPart,
  UserMessage,
  VcsFileDiff,
} from "@opencode-ai/sdk/v2"
import { showToast } from "@opencode-ai/ui/toast"
import { getFilename } from "@opencode-ai/core/util/path"
import { resolveError } from "@opencode-ai/core/error/resolve"
import { formatServerError } from "@/utils/server-errors"
import { Popover as KobaltePopover } from "@kobalte/core/popover"
import { shouldMarkBoundaryGesture, normalizeWheelDelta } from "@/pages/session/message-gesture"
import {
  conversationMinimapIndexAtOffset,
  conversationMinimapTop,
  shouldShowConversationMinimap,
} from "@/pages/session/conversation-minimap"
import { SessionContextUsage } from "@/components/session-context-usage"
import { AddToChatBubble } from "@/components/add-to-chat-bubble"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useLanguage } from "@/context/language"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { useSessionKey } from "@/pages/session/session-layout"
import { useGlobalSDK } from "@/context/global-sdk"
import { usePlatform } from "@/context/platform"
import { fileManagerInfo } from "@/utils/file-manager"
import { useLayout } from "@/context/layout"
import { useCommand } from "@/context/command"
import { useTerminal } from "@/context/terminal"
import { Tooltip, TooltipKeybind } from "@opencode-ai/ui/tooltip"
import { useSessionLayout } from "@/pages/session/session-layout"
import { focusTerminalById, createSessionDesktopLayout, runStateTimerShouldRun } from "@/pages/session/helpers"
import { useSettings } from "@/context/settings"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import {
  invalidateArchivedSessionsList,
  mergeArchivedSessionIntoListCache,
  removeSessionFromSidebar,
  settleSessionRemovals,
  runArchiveInflight,
  requireArchivedSession,
} from "@/components/settings-archived-sessions/sync"
import { showArchiveSessionToast } from "@/components/settings-archived-sessions/archive-toast"
import { unarchiveSession, restoreArchivedSessionsToSidebar } from "@/components/settings-archived-sessions/unarchive"
import { useGlobalSync } from "@/context/global-sync"
import { sessionTitle } from "@/utils/session-title"
import { parseCommentNote, readCommentMetadata } from "@/utils/comment-note"
import { useLocal, type ModelSwitchNotice } from "@/context/local"
import { sessionTimelinePreview } from "@/components/session-timeline-preview"
import {
  AWAITING_USER_RUNNING_GRACE_MS,
  assistantTurnActive,
  hasAwaitingUserMessages,
  latestAwaitingUserMessageID,
  resolvedSessionStatusBusy,
  sessionActiveTurnID,
  trailingManualSteerMessageID,
} from "@/pages/session/followup-queue"
import { timelineTurnAnchorMessageID, type TimelineTurn } from "@/pages/session/user-turns"
import { TimelineTurnAnchor } from "@/pages/session/timeline-turn-anchor"
import { same } from "@/utils/same"

type MessageComment = {
  path: string
  comment: string
  selection?: {
    startLine: number
    endLine: number
  }
}

const emptyMessages: MessageType[] = []
const idle = { type: "idle" as const }
type UserActions = {
  fork?: (input: { sessionID: string; messageID: string }) => Promise<void> | void
  revert?: (input: { sessionID: string; messageID: string }) => Promise<void> | void
  goalObjective?: (sessionID: string) => string | undefined
  openReviewPanel?: (mode?: "turn" | "unstaged" | "staged" | "branch") => void | Promise<void>
  editSummaryRevertPending?: () => boolean
  sessionBusy?: () => boolean
  canRevertEditSummary?: (messageID: string) => boolean
  editSummaryOpeners?: () => EditSummaryOpener[]
}

const messageComments = (parts: Part[]): MessageComment[] =>
  parts.flatMap((part) => {
    if (part.type !== "text" || !(part as TextPart).synthetic) return []
    const next = readCommentMetadata(part.metadata) ?? parseCommentNote(part.text)
    if (!next) return []
    return [
      {
        path: next.path,
        comment: next.comment,
        selection: next.selection
          ? {
              startLine: next.selection.startLine,
              endLine: next.selection.endLine,
            }
          : undefined,
      },
    ]
  })

const taskDescription = (part: Part, sessionID: string) => {
  if (part.type !== "tool" || part.tool !== "task") return
  const metadata = "metadata" in part.state ? part.state.metadata : undefined
  if (metadata?.sessionId !== sessionID) return
  const value = part.state.input?.description
  if (typeof value === "string" && value) return value
}

const formatMessageTimestamp = (value: number, locale: string) =>
  new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value))

type ConversationMinimapItem = {
  id: string
  title: string
  body: string
  time?: string
  footer: ConversationMinimapFooterItem[]
}

type ConversationMinimapFooterItem = {
  kind: "file" | "tool"
  label: string
  path?: string
}

function MessageCommentStrip(props: { comments: readonly MessageComment[]; nested?: boolean }) {
  // 根消息位于 SessionTurn 外层，需要页面横向留白；steer 已在 turn 容器内，只保留垂直间距即可原位展示。
  return (
    <Show when={props.comments.length > 0}>
      <div
        classList={{
          "w-full pb-2": true,
          "px-4 md:px-5": !props.nested,
        }}
      >
        <div class="ml-auto max-w-[82%] overflow-x-auto no-scrollbar">
          <div class="flex w-max min-w-full justify-end gap-2">
            <Index each={props.comments}>
              {(commentAccessor: () => MessageComment) => {
                const comment = createMemo(() => commentAccessor())
                return (
                  <Show when={comment()}>
                    {(value) => (
                      <div class="shrink-0 max-w-[260px] rounded-[6px] border border-border-weak-base bg-background-stronger px-2.5 py-2">
                        <div class="flex items-center gap-1.5 min-w-0 text-11-medium text-text-strong">
                          <FileIcon node={{ path: value().path, type: "file" }} class="size-3.5 shrink-0" />
                          <span class="truncate">{getFilename(value().path)}</span>
                          <Show when={value().selection}>
                            {(selection) => (
                              <span class="shrink-0 text-text-weak">
                                {selection().startLine === selection().endLine
                                  ? `:${selection().startLine}`
                                  : `:${selection().startLine}-${selection().endLine}`}
                              </span>
                            )}
                          </Show>
                        </div>
                        <div class="pt-1 text-12-regular text-text-strong whitespace-pre-wrap break-words">
                          {value().comment}
                        </div>
                      </div>
                    )}
                  </Show>
                )
              }}
            </Index>
          </div>
        </div>
      </div>
    </Show>
  )
}

const conversationMinimapWidth = (input: { index: number; hoveredIndex: number | undefined; active: boolean }) => {
  if (input.hoveredIndex === undefined) return 7
  const distance = Math.abs(input.index - input.hoveredIndex)
  if (distance === 0) return 20
  if (distance === 1) return 16
  if (distance === 2) return 12
  if (distance === 3) return 9
  return input.active ? 12 : 5
}

const conversationMinimapIndexFromPointer = (input: {
  root: HTMLElement
  clientY: number
  total: number
  height: number
}) => {
  return conversationMinimapIndexAtOffset({
    pointer: input.clientY - input.root.getBoundingClientRect().top,
    total: input.total,
    height: input.height,
  })
}

const recordValue = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null

const stringField = (record: Record<string, unknown>, keys: string[]) =>
  keys.map((key) => record[key]).find((value): value is string => typeof value === "string" && value.trim().length > 0)

const minimapFooterLabel = (path: string) => getFilename(path) || path

const conversationMinimapFooterFromPart = (part: Part): ConversationMinimapFooterItem[] => {
  if (part.type === "file") {
    const path = part.filename || part.url
    if (!path) return []
    return [{ kind: "file", label: minimapFooterLabel(path), path }]
  }

  if (part.type !== "tool") return []

  const state = part.state as { input?: unknown; metadata?: unknown; attachments?: unknown }
  const input = recordValue(state.input) ? state.input : {}
  const metadata = recordValue(state.metadata) ? state.metadata : {}
  const filediff = recordValue(metadata.filediff) ? metadata.filediff : {}
  const primaryPath =
    stringField(filediff, ["file"]) ?? stringField(input, ["filePath", "path", "file", "target", "source"])
  const metadataFiles = Array.isArray(metadata.files) ? metadata.files : []
  const attachmentFiles = Array.isArray(state.attachments) ? state.attachments : []
  const paths = [
    primaryPath,
    ...metadataFiles.flatMap((entry) => {
      if (!recordValue(entry)) return []
      return [stringField(entry, ["filePath", "relativePath", "path", "file"])].filter(
        (value): value is string => !!value,
      )
    }),
    ...attachmentFiles.flatMap((entry) => {
      if (!recordValue(entry) || entry.type !== "file") return []
      return [stringField(entry, ["filename", "url", "path"])].filter((value): value is string => !!value)
    }),
  ].filter((path): path is string => !!path)

  if (paths.length > 0) return paths.map((path) => ({ kind: "file", label: minimapFooterLabel(path), path }))
  return [{ kind: "tool", label: part.tool.replaceAll("_", " ") }]
}

const conversationMinimapFooter = (parts: Part[]) => {
  const seen = new Set<string>()
  return parts
    .flatMap(conversationMinimapFooterFromPart)
    .reverse()
    .filter((item) => {
      const key = `${item.kind}:${item.path ?? item.label}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
}

const assistantMessagePreview = (parts: Part[], maxLength: number) => {
  const text = parts
    .filter((part): part is TextPart => part.type === "text")
    .map((part) => part.text)
    .join("")
    .replace(/\s+/g, " ")
    .trim()
  if (text.length <= maxLength) return text
  return text.slice(0, maxLength) + "..."
}

const visibleMessageIDFromScroll = (root: HTMLDivElement, fallback?: string) => {
  const box = root.getBoundingClientRect()
  const line = box.top + Math.min(Math.max(box.height * 0.28, 96), 180)
  const list = [...root.querySelectorAll<HTMLElement>("[data-message-id]")]
    .map((el) => {
      const id = el.dataset.messageId
      if (!id) return
      const rect = el.getBoundingClientRect()
      return { id, top: rect.top, bottom: rect.bottom }
    })
    .filter((item): item is { id: string; top: number; bottom: number } => !!item)

  const shown = list.filter((item) => item.bottom > box.top && item.top < box.bottom)
  const hit = shown.find((item) => item.top <= line && item.bottom >= line)
  if (hit) return hit.id

  const near = [...shown].sort((a, b) => {
    const da = Math.abs(a.top - line)
    const db = Math.abs(b.top - line)
    if (da !== db) return da - db
    return a.top - b.top
  })[0]
  if (near) return near.id

  return list.filter((item) => item.top <= line).at(-1)?.id ?? list[0]?.id ?? fallback
}

function ConversationMinimap(props: {
  label: string
  items: () => ConversationMinimapItem[]
  activeMessageID: () => string | undefined
  onSelect: (id: string) => void
}) {
  const [hoveredIndex, setHoveredIndex] = createSignal<number>()
  const [railHeight, setRailHeight] = createSignal(220)
  let railResize: ResizeObserver | undefined
  const setRailRef = (el: HTMLDivElement) => {
    railResize?.disconnect()
    setRailHeight(el.clientHeight)
    railResize = new ResizeObserver((entries) => setRailHeight(entries[0]?.contentRect.height ?? el.clientHeight))
    railResize.observe(el)
  }
  const setHoveredIndexFromPointer = (event: MouseEvent & { currentTarget: HTMLDivElement }) => {
    const index = conversationMinimapIndexFromPointer({
      root: event.currentTarget,
      clientY: event.clientY,
      total: props.items().length,
      height: railHeight(),
    })
    setHoveredIndex(index)
    return index
  }
  const selectFromPointer = (event: MouseEvent & { currentTarget: HTMLDivElement }) => {
    const index = setHoveredIndexFromPointer(event)
    if (index === undefined) return
    const item = props.items()[index]
    if (item) props.onSelect(item.id)
  }
  onCleanup(() => railResize?.disconnect())

  return (
    // 物理 user/steer 聚合后可能只剩一个逻辑 turn；只要有可跳转锚点就继续展示 Minimap。
    <Show when={shouldShowConversationMinimap(props.items().length)}>
      <nav
        data-component="conversation-minimap"
        aria-label={props.label}
        // 是否显示由 session panel 的容器宽度决定，不能再用包含侧栏宽度的 viewport 断点。
        class="pointer-events-none absolute top-0 bottom-0 left-4 z-[45]"
      >
        <div
          class="sticky w-12"
          style={{
            top: "calc(var(--session-title-height, 0px) + 72px)",
            height: "max(220px, calc(100dvh - var(--session-title-height, 0px) - 220px))",
          }}
        >
          <div
            ref={setRailRef}
            class="pointer-events-auto relative h-full w-12 overflow-visible"
            onClick={selectFromPointer}
            onPointerMove={setHoveredIndexFromPointer}
            onMouseLeave={() => setHoveredIndex(undefined)}
          >
            <div class="relative h-full w-12 overflow-visible">
              <For each={props.items()}>
                {(item, index) => {
                  const active = createMemo(() => props.activeMessageID() === item.id)
                  const preview = createMemo(() => hoveredIndex() === index())
                  return (
                    <div
                      data-message-minimap-id={item.id}
                      class="pointer-events-none absolute left-0 flex h-2.5 w-12 -translate-y-1/2 items-center"
                      style={{
                        top: `${conversationMinimapTop({
                          index: index(),
                          total: props.items().length,
                          height: railHeight(),
                        })}px`,
                      }}
                      onMouseEnter={() => setHoveredIndex(index())}
                      onMouseMove={() => setHoveredIndex(index())}
                      onPointerEnter={() => setHoveredIndex(index())}
                      onPointerMove={() => setHoveredIndex(index())}
                    >
                      <button
                        type="button"
                        aria-label={item.title}
                        class="pointer-events-none flex h-2.5 w-12 items-center justify-start rounded-[4px] border-none bg-transparent p-0 outline-none focus-visible:ring-2 focus-visible:ring-border-active"
                        onClick={() => props.onSelect(item.id)}
                        onFocus={() => setHoveredIndex(index())}
                        onBlur={() => setHoveredIndex(undefined)}
                      >
                        <div
                          data-minimap-bar
                          aria-hidden="true"
                          class="block h-0.5 shrink-0 rounded-full transition-[width,background-color,opacity] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]"
                          classList={{
                            "bg-text-strong opacity-100": preview(),
                            "bg-text-strong opacity-95": !preview() && active(),
                            "bg-border-strong-base opacity-75": !preview() && !active(),
                          }}
                          style={{
                            width: `${conversationMinimapWidth({
                              index: index(),
                              hoveredIndex: hoveredIndex(),
                              active: active(),
                            })}px`,
                          }}
                        />
                      </button>
                      <Show when={preview()}>
                        <div
                          data-component="conversation-minimap-preview"
                          aria-hidden="true"
                          class="pointer-events-none absolute left-11 top-1/2 w-[420px] -translate-y-1/2 rounded-[8px] border border-border-weak-base bg-background-base px-3 py-2.5 text-left shadow-[0_16px_40px_rgba(15,23,42,0.18)]"
                        >
                          <div class="flex min-w-0 items-center gap-3 text-14-medium text-text-strong">
                            <span class="min-w-0 flex-1 truncate">{item.title}</span>
                            <Show when={item.time}>
                              {(time) => <span class="shrink-0 text-12-regular text-text-weaker">{time()}</span>}
                            </Show>
                          </div>
                          <div class="mt-1 max-h-[72px] overflow-hidden break-words text-13-regular leading-6 text-text-weak">
                            {item.body}
                          </div>
                          <Show when={item.footer.length > 0}>
                            <div class="mt-2 flex min-w-0 items-center gap-3 border-t border-border-weak-base pt-2 text-12-regular text-text-weaker">
                              <For each={item.footer.slice(0, 2)}>
                                {(footer) => (
                                  <span class="flex min-w-0 items-center gap-1.5">
                                    <Show
                                      when={footer.kind === "tool"}
                                      fallback={
                                        <FileIcon
                                          node={{ path: footer.path ?? footer.label, type: "file" }}
                                          class="size-3.5 shrink-0"
                                        />
                                      }
                                    >
                                      <Icon name="terminal" size="small" class="size-3.5 shrink-0 text-icon-weak" />
                                    </Show>
                                    <span class="min-w-0 max-w-[160px] truncate">{footer.label}</span>
                                  </span>
                                )}
                              </For>
                              <Show when={item.footer.length > 2}>
                                <span class="ml-auto shrink-0">+{item.footer.length - 2}</span>
                              </Show>
                            </div>
                          </Show>
                        </div>
                      </Show>
                    </div>
                  )
                }}
              </For>
            </div>
          </div>
        </div>
      </nav>
    </Show>
  )
}

const boundaryTarget = (root: HTMLElement, target: EventTarget | null) => {
  const current = target instanceof Element ? target : undefined
  const nested = current?.closest("[data-scrollable]")
  if (!nested || nested === root) return root
  if (!(nested instanceof HTMLElement)) return root
  return nested
}

const markBoundaryGesture = (input: {
  root: HTMLDivElement
  target: EventTarget | null
  delta: number
  onMarkScrollGesture: (target?: EventTarget | null, direction?: AutoScrollDirection) => void
}) => {
  const target = boundaryTarget(input.root, input.target)
  if (target === input.root) {
    input.onMarkScrollGesture(input.root, input.delta < 0 ? "away" : "toward")
    return
  }
  if (
    shouldMarkBoundaryGesture({
      delta: input.delta,
      scrollTop: target.scrollTop,
      scrollHeight: target.scrollHeight,
      clientHeight: target.clientHeight,
    })
  ) {
    input.onMarkScrollGesture(input.root, input.delta < 0 ? "away" : "toward")
  }
}

type StageConfig = {
  init: number
  batch: number
}

type TimelineStageInput = {
  sessionKey: () => string
  turnStart: () => number
  messages: () => UserMessage[]
  config: StageConfig
}

/**
 * Defer-mounts small timeline windows so revealing older turns does not
 * block first paint with a large DOM mount.
 *
 * Once staging completes for a session it never re-stages — backfill and
 * new messages render immediately.
 */
function createTimelineStaging(input: TimelineStageInput) {
  const [state, setState] = createStore({
    activeSession: "",
    completedSession: "",
    count: 0,
  })

  const stagedCount = createMemo(() => {
    const total = input.messages().length
    if (input.turnStart() <= 0) return total
    if (state.completedSession === input.sessionKey()) return total
    const init = Math.min(total, input.config.init)
    if (state.count <= init) return init
    if (state.count >= total) return total
    return state.count
  })

  const stagedUserMessages = createMemo(() => {
    const list = input.messages()
    const count = stagedCount()
    if (count >= list.length) return list
    return list.slice(Math.max(0, list.length - count))
  })

  let frame: number | undefined
  const cancel = () => {
    if (frame === undefined) return
    cancelAnimationFrame(frame)
    frame = undefined
  }

  createEffect(
    on(
      () => [input.sessionKey(), input.turnStart() > 0, input.messages().length] as const,
      ([sessionKey, isWindowed, total]) => {
        cancel()
        const shouldStage =
          isWindowed &&
          total > input.config.init &&
          state.completedSession !== sessionKey &&
          state.activeSession !== sessionKey
        if (!shouldStage) {
          setState({ activeSession: "", count: total })
          return
        }

        let count = Math.min(total, input.config.init)
        setState({ activeSession: sessionKey, count })

        const step = () => {
          if (input.sessionKey() !== sessionKey) {
            frame = undefined
            return
          }
          const currentTotal = input.messages().length
          count = Math.min(currentTotal, count + input.config.batch)
          setState("count", count)
          if (count >= currentTotal) {
            setState({ completedSession: sessionKey, activeSession: "" })
            frame = undefined
            return
          }
          frame = requestAnimationFrame(step)
        }
        frame = requestAnimationFrame(step)
      },
    ),
  )

  const isStaging = createMemo(() => {
    const key = input.sessionKey()
    return state.activeSession === key && state.completedSession !== key
  })

  onCleanup(cancel)
  return { messages: stagedUserMessages, isStaging }
}

export function MessageTimeline(props: {
  mobileChanges: boolean
  mobileFallback: JSX.Element
  actions?: UserActions
  scroll: { overflow: boolean; bottom: boolean; jump: boolean }
  onResumeScroll: () => void
  setScrollRef: (el: HTMLDivElement | undefined) => void
  onScheduleScrollState: (el: HTMLDivElement) => void
  onAutoScrollHandleUserScroll: () => void
  onMarkScrollGesture: (target?: EventTarget | null, direction?: AutoScrollDirection) => void
  hasScrollGesture: () => boolean
  onUserScroll: () => void
  onTurnBackfillScroll: () => void
  onAutoScrollInteraction: (event: MouseEvent) => void
  centered: boolean
  setContentRef: (el: HTMLDivElement) => void
  turnStart: number
  historyMore: boolean
  historyLoading: boolean
  onLoadEarlier: () => void
  renderedUserMessages: UserMessage[]
  /** Minimap 与 hash/命令面板共用页面级跳转入口，统一处理 sticky 标题偏移和滚动状态。 */
  onJumpToMessage: (message: UserMessage) => void
  steeredByMessageID?: Record<string, number>
  /** 服务端物理 turn 的一级时间线；steer 只作为其中的有序成员。 */
  timelineTurns?: readonly TimelineTurn[]
  /** 任意 user/assistant 消息到逻辑 turn 的稳定索引，用于活动态、迷你图与滚动锚点。 */
  turnIDByMessageID?: Record<string, string>
  messages?: MessageType[]
  parts?: Record<string, Part[] | undefined>
  anchor: (id: string) => string
  diffOverlay?: () => ReadonlyArray<SnapshotFileDiff | VcsFileDiff>
  diffOverlayWorkspaceRoot?: () => string | undefined
  /** 当前会话是从哪个 session/message 派生而来；存在则在派生分界处显示 banner，点击跳回源会话 */
  forkedFrom?: () => { sessionID: string; messageID?: string } | undefined
  /** banner 应该出现在哪条 user message 之前（= fork 后第一条新消息；新消息必为最近、必已加载，
   *  不依赖懒加载的旧导入消息，避免旧消息未加载时 banner 落到对话末尾） */
  forkBoundaryBeforeMessageID?: () => string | undefined
  /** banner 跳转：解析源会话的 directory（用于构造 URL） */
  resolveSessionDirectory?: (sessionID: string) => string | undefined
  /** goal 达成完成行：goal 变 complete 时在消息流末尾显示「Goal achieved in {totalTime}」 */
  goalAchieved?: () => { totalTime: string; afterMessageID?: string } | undefined
}) {
  let touchGesture: number | undefined

  const navigate = useNavigate()
  const globalSDK = useGlobalSDK()
  const globalSync = useGlobalSync()
  const sdk = useSDK()
  const sync = useSync()
  const queryClient = useQueryClient()
  const local = useLocal()
  const settings = useSettings()
  const dialog = useDialog()
  const language = useLanguage()
  const { params, sessionKey } = useSessionKey()
  const platform = usePlatform()
  const layout = useLayout()
  const command = useCommand()
  const terminal = useTerminal()
  const { view } = useSessionLayout()
  const isDesktop = createSessionDesktopLayout(platform)
  const desktopSidePanelOpen = createMemo(
    () => isDesktop() && (view().reviewPanel.opened() || layout.fileTree.opened()),
  )
  // 1:1 复刻 Codex：合并 titlebar 后，chat header 接管终端 toggle
  const toggleTerminal = () => {
    const next = !view().terminal.opened()
    view().terminal.toggle()
    if (!next) return
    const id = terminal.active()
    if (!id) return
    focusTerminalById(id)
  }

  // 跳转用户中心（可选 tab）；复刻 layout.tsx 的 openUserCenter，保留来源用于返回。
  const openUserCenter = (tab?: TabID) => {
    openUserCenterOverlay(tab)
  }

  // 对话错误卡片行为按钮的执行入口（由 SessionTurn 的 onErrorAction 注入）。
  // reason 码契约 → action 路由到现有锚点：开通/额度走用户中心，重新登录走 OAuth 弹窗。
  const handleErrorAction = (action: ErrorAction) => {
    switch (action) {
      case "open_purchase":
        openUserCenter("purchase")
        return
      case "show_quota":
        openUserCenter("quota")
        return
      case "show_blocked":
        // 账号封禁 / 订阅暂停：引导至用户中心查看账号状态与客服信息。
        openUserCenter()
        return
      case "relogin":
        // 复用现有 OAuth 授权流程（与 wanlaicode-login-gate 一致）。
        dialog.show(() => <DialogConnectProvider provider="wanlaicode" preferredMethod="oauth" hideBackButton />)
        return
      case "backoff_retry":
        // 限流退避：实际重试由 session/retry 策略自动接管，这里只给用户一个明确反馈。
        showToast({ title: language.t("errors.action.backoff_retry") })
        return
      default:
        return
    }
  }

  const rendered = createMemo(() => props.renderedUserMessages.map((message) => message.id))
  const renderedSet = createMemo(() => new Set(rendered()))
  // 官方列表用物理 turnKey 维持行身份；根消息分页回填时锚点可变，但同一行不能被重建。
  const renderedTurnIDs = createMemo(() =>
    props.renderedUserMessages.map((message) => props.turnIDByMessageID?.[message.id] ?? message.id),
  )
  const lastRenderedUserMessageID = createMemo(() => props.renderedUserMessages.at(-1)?.id)
  const timelineTurnByID = createMemo(
    () => new Map((props.timelineTurns ?? []).map((turn) => [turn.id, turn] as const)),
  )
  const timelineTurnByAnchorID = createMemo(() => {
    const result = new Map<string, TimelineTurn>()
    for (const turn of props.timelineTurns ?? []) {
      // 分页缺根时映射表必须与实际行 DOM 一起回退到已加载 steer，不能重新指向不可渲染 root。
      const anchorID = timelineTurnAnchorMessageID(turn, renderedSet())
      if (anchorID) result.set(anchorID, turn)
    }
    return result
  })
  const timelineAnchorByTurnID = createMemo(() => {
    const result = new Map<string, string>()
    for (const [anchorID, turn] of timelineTurnByAnchorID()) result.set(turn.id, anchorID)
    return result
  })
  const timelineAnchorForMessage = (messageID: string | undefined) => {
    if (!messageID) return undefined
    const turnID = props.turnIDByMessageID?.[messageID]
    return (turnID ? timelineAnchorByTurnID().get(turnID) : undefined) ?? messageID
  }
  // 派生分界消息是否落在当前渲染窗口内：否则（边界在窗口之上，渲染的全是新消息）banner 回落到顶部
  const forkBoundaryInWindow = createMemo(() => {
    const id = props.forkBoundaryBeforeMessageID?.()
    return !!id && rendered().includes(id)
  })
  const modelSwitchNotice = createMemo(() => local.modelSwitchNotice())
  // 内联锚定：提示固定显示在切换当时那条用户消息下方，不随后续新消息漂移或消失
  const modelSwitchMessageID = createMemo(() => modelSwitchNotice()?.afterMessageID)
  const modelName = (model: ModelSwitchNotice["to"]) =>
    local.model.list().find((item) => item.provider.id === model.providerID && item.id === model.modelID)?.name ??
    `${model.providerID}/${model.modelID}`
  // 派生 banner 渲染函数（在 For-loop 边界处 + 兜底位置共用）
  const renderForkedFromBanner = () => (
    <Show when={props.forkedFrom?.()}>
      {(forked) => {
        const targetDir = createMemo(() => props.resolveSessionDirectory?.(forked().sessionID))
        const handleClick = () => {
          const dir = targetDir()
          if (!dir) return
          const slug = base64Encode(dir)
          const fragment = forked().messageID ? `#m-${forked().messageID}` : ""
          navigate(`/${slug}/session/${forked().sessionID}${fragment}`)
        }
        return (
          <div data-slot="session-forked-from-banner" class="w-full px-4 md:px-5 py-4">
            <button
              type="button"
              class="w-full flex items-center justify-center gap-2 text-12-medium text-text-interactive-base hover:text-text-interactive-stronger cursor-pointer disabled:cursor-default disabled:opacity-60"
              onClick={handleClick}
              disabled={!targetDir()}
              aria-label={language.t("session.forkedFrom.banner")}
            >
              <span class="flex-1 h-px bg-border-weak-base" />
              <Icon name="fork" size="small" />
              <span>{language.t("session.forkedFrom.banner")}</span>
              <span class="flex-1 h-px bg-border-weak-base" />
            </button>
          </div>
        )
      }}
    </Show>
  )
  const renderModelSwitchNotice = () => {
    const notice = modelSwitchNotice()
    if (!notice) return null
    return (
      <div class="w-full px-4 md:px-5 py-3" data-component="session-model-switch-notice">
        <div class="flex items-center gap-2 text-13-regular text-text-weak">
          <span class="flex-1 h-px bg-border-weak-base" />
          <Icon name="models" size="small" class="shrink-0 text-icon-weak" />
          <span class="shrink-0 whitespace-nowrap">
            {language.t("session.model.switch", {
              from: modelName(notice.from),
              to: modelName(notice.to),
            })}
          </span>
          <span class="flex-1 h-px bg-border-weak-base" />
        </div>
      </div>
    )
  }

  // goal 达成行（复刻 Codex：左对齐灰字「已在 {totalTime} 内达成目标」），在完成轮之后 + 末尾兜底两处共用
  const renderGoalAchieved = (totalTime: string) => (
    <div class="w-full px-4 md:px-5 pt-1 pb-1" data-component="session-goal-achieved">
      <div class="flex items-center justify-start gap-1.5 text-13-regular text-text-weak">
        <Icon name="circle-check" size="small" class="text-icon-weak" />
        <span>{language.t("session.goal.achieved", { totalTime })}</span>
      </div>
    </div>
  )
  const sessionID = createMemo(() => params.id)
  // 选中 AI 回复时弹出的 "Add to chat" 浮窗根容器，限制选区只在该容器内才生效。
  const [timelineRoot, setTimelineRoot] = createSignal<HTMLDivElement | undefined>()
  const [scrollRoot, setScrollRoot] = createSignal<HTMLDivElement | undefined>()
  const [visibleMessageID, setVisibleMessageID] = createSignal<string | undefined>()
  let visibleMessageFrame: number | undefined
  const updateVisibleMessageID = (root = scrollRoot()) => {
    if (!root) return
    setVisibleMessageID(visibleMessageIDFromScroll(root, activeMessageID()))
  }
  const scheduleVisibleMessageIDUpdate = (root = scrollRoot()) => {
    if (!root) return
    if (visibleMessageFrame !== undefined) cancelAnimationFrame(visibleMessageFrame)
    visibleMessageFrame = requestAnimationFrame(() => {
      visibleMessageFrame = undefined
      updateVisibleMessageID(root)
    })
  }
  const setScrollRef = (el: HTMLDivElement | undefined) => {
    setScrollRoot(el)
    props.setScrollRef(el)
    scheduleVisibleMessageIDUpdate(el)
  }
  onCleanup(() => {
    if (visibleMessageFrame !== undefined) cancelAnimationFrame(visibleMessageFrame)
  })
  // 1:1 复刻 Codex：chat header ... 菜单复用 sidebar thread context menu 的 11 项行为
  const copyText = (text: string) => {
    void navigator.clipboard.writeText(text).then(() => showToast({ title: language.t("sidebar.thread.menu.copied") }))
  }
  const isCurrentPinned = createMemo(() => {
    const id = sessionID()
    return id ? layout.tree.pinnedThreadList().includes(id) : false
  })
  const onTogglePin = () => {
    const id = sessionID()
    if (!id) return
    layout.tree.toggleThreadPin(id)
  }
  const onRevealInFinder = () => {
    void platform.openPath?.(sdk.directory)
  }
  const onCopyDirectory = () => copyText(sdk.directory)
  const onCopyId = () => {
    const id = sessionID()
    if (id) copyText(id)
  }
  const onCopyLink = () => {
    const id = sessionID()
    if (!id) return
    copyText(`wanlaicode://open-session?directory=${encodeURIComponent(sdk.directory)}&id=${encodeURIComponent(id)}`)
  }
  // 判活谓词里的 45s / 30min 时间宽限，只有当 memo 依赖里存在会推进的时间信号时才会到期重算。
  // 不传 now 会回落到 followup-queue 内部的 Date.now()，而 memo 不因时间流逝重算 ——
  // 「处理中」就冻在 true，直到切会话或重载才释放（「任务输出完还在思考中」反馈的形态之一）。
  // session.tsx / sidebar-items.tsx 早已按此传参，这里是漏网的三处。
  const sessionMessages = createMemo(() => {
    if (props.messages) return props.messages
    const id = sessionID()
    if (!id) return emptyMessages
    return sync.data.message[id] ?? emptyMessages
  })
  const sessionStatus = createMemo(() => {
    const id = sessionID()
    if (!id) return idle
    return sync.data.session_status[id] ?? idle
  })
  const sessionStatusBusy = createMemo<boolean | undefined>(() => {
    const id = sessionID()
    if (!id) return undefined
    const status = sync.data.session_status[id]
    // 稀疏 map 的缺失 key 在 ready 后就是权威 idle；只有首次快照前继续保留未知三态。
    return resolvedSessionStatusBusy({
      status,
      snapshotReady: sync.data.session_status_ready,
      sessionKnown: sync.data.session_status_known[id],
    })
  })
  // 「有活才起表」：跟 session.tsx:3542-3561 / sidebar-items.tsx:180-191 保持同一守卫模式 ——
  // status 尚未加载且没有未收尾 assistant 时不起表，避免会话彻底空闲也常驻 1Hz 定时器唤醒渲染。
  const [runStateNow, setRunStateNow] = createSignal(Date.now())
  createEffect(() => {
    const id = sessionID()
    // ready 覆盖“完整快照为空”和“收到 idle 事件后删除 key”两种情况，避免空 assistant 常驻 1Hz 假运行态。
    const statusLoaded =
      id !== undefined && (sync.data.session_status_ready || sync.data.session_status_known[id] === true)
    if (!runStateTimerShouldRun({ statusLoaded, messages: sessionMessages() })) return

    const runStateTimer = setInterval(() => setRunStateNow(Date.now()), 1_000)
    onCleanup(() => clearInterval(runStateTimer))
  })
  const pending = createMemo(() => {
    // 只检查最新一条 assistant 消息的活跃状态,与 sessionHasRunningTurn 语义一致:
    // 避免已完成工具轮里的中间 tool-calls 步在 45s 宽限内仍被判为"运行中"并显示 spinner
    const last = sessionMessages().findLast((item): item is AssistantMessage => item.role === "assistant")
    if (!last) return undefined
    // 自动重试仍使用同一条 assistant；上一 attempt 的 step-finish 只是传输边界，
    // retry 状态必须把它继续固定为时间线活动锚点，确保“正在重试”始终显示在原回合下方。
    if (sessionStatus().type === "retry") return last
    return assistantTurnActive(last, {
      statusBusy: sessionStatusBusy(),
      now: runStateNow(),
      parts: (props.parts ?? sync.data.part)[last.id],
    })
      ? last
      : undefined
  })
  const awaitingUserMessageID = createMemo(() => {
    const id = sessionID()
    const status = sessionStatus()
    if (!id || status.type === "idle") return undefined

    // 用户消息先落入时间线、assistant 首包稍后到达；这段空窗仍然属于同一轮处理，不能让消息区闪成空白。
    return latestAwaitingUserMessageID(sessionMessages(), props.parts ?? sync.data.part, {
      ignoredUserMessageIDs: new Set(Object.keys(props.steeredByMessageID ?? {})),
      maxAgeMs: AWAITING_USER_RUNNING_GRACE_MS,
      now: runStateNow(),
    })
  })
  const activeStatusAnchorID = createMemo(() => {
    // 官方 turn.status=inProgress 在 steer 首包空窗仍保持权威活动态；映射成功时不能等下一条 assistant 才重新展开。
    const turnID = sessionActiveTurnID(sessionStatus())
    return turnID ? timelineAnchorByTurnID().get(turnID) : undefined
  })
  const trailingSteerAnchorID = createMemo(() => {
    // 旧 status 协议只有 busy、没有 turnID；steer 已落位但下一条 assistant 尚未出现时，工作态仍要紧跟最新引导。
    if (sessionStatus().type === "idle") return undefined
    return timelineAnchorForMessage(
      trailingManualSteerMessageID(sessionMessages(), props.steeredByMessageID ?? {}),
    )
  })
  const activeMessageID = createMemo(() => {
    // status.turnID 是活动物理 turn 的权威身份；流式 assistant 与乐观 user 只作为事件乱序时的回退。
    if (activeStatusAnchorID()) return activeStatusAnchorID()
    const activeAssistant = pending()
    const assistantAnchor = timelineAnchorForMessage(activeAssistant?.id)
    if (assistantAnchor && assistantAnchor !== activeAssistant?.id) return assistantAnchor
    const parentAnchor = timelineAnchorForMessage(activeAssistant?.parentID)
    if (parentAnchor) return parentAnchor
    return timelineAnchorForMessage(awaitingUserMessageID()) ?? trailingSteerAnchorID()
  })
  const minimapActiveMessageID = createMemo(() => visibleMessageID() ?? activeMessageID())
  const activeTurnWorking = createMemo(() => {
    // 已确认的物理 turn 即使处于“旧 assistant 已完成、新 assistant 尚未创建”的 steer 空窗也仍在处理。
    if (activeStatusAnchorID()) return true
    if (pending()) return true
    if (trailingSteerAnchorID()) return true
    if (!awaitingUserMessageID()) return false
    return hasAwaitingUserMessages(sessionMessages(), props.parts ?? sync.data.part, {
      ignoredUserMessageIDs: new Set(Object.keys(props.steeredByMessageID ?? {})),
      maxAgeMs: AWAITING_USER_RUNNING_GRACE_MS,
      now: runStateNow(),
    })
  })
  const info = createMemo(() => {
    const id = sessionID()
    if (!id) return
    return sync.session.get(id)
  })
  const titleValue = createMemo(() => info()?.title)
  const titleLabel = createMemo(() => sessionTitle(titleValue()))
  const shareUrl = createMemo(() => info()?.share?.url)
  const shareEnabled = createMemo(() => sync.data.config.share !== "disabled")
  const parentID = createMemo(() => info()?.parentID)
  const parent = createMemo(() => {
    const id = parentID()
    if (!id) return
    return sync.session.get(id)
  })
  const parentMessages = createMemo(() => {
    const id = parentID()
    if (!id) return emptyMessages
    return sync.data.message[id] ?? emptyMessages
  })
  const parentTitle = createMemo(() => sessionTitle(parent()?.title) ?? language.t("command.session.new"))
  const childTaskDescription = createMemo(() => {
    const id = sessionID()
    if (!id) return
    return parentMessages()
      .flatMap((message) => sync.data.part[message.id] ?? [])
      .map((part) => taskDescription(part, id))
      .findLast((value): value is string => !!value)
  })
  const childTitle = createMemo(() => {
    if (!parentID()) return titleLabel() ?? ""
    if (childTaskDescription()) return childTaskDescription()
    const value = titleLabel()?.replace(/\s+\(@[^)]+ subagent\)$/, "")
    if (value) return value
    return language.t("command.session.new")
  })
  const showHeader = createMemo(() => !!(titleValue() || parentID()))
  const stageCfg = { init: 1, batch: 3 }
  const staging = createTimelineStaging({
    sessionKey,
    turnStart: () => props.turnStart,
    messages: () => props.renderedUserMessages,
    config: stageCfg,
  })
  const minimapItems = createMemo(() =>
    staging.messages().map((message) => {
      const displayPartsByMessage = props.parts ?? sync.data.part
      const rawPartsByMessage = sync.data.part
      const title =
        sessionTimelinePreview({
          parts: displayPartsByMessage[message.id] ?? [],
          directory: sdk.directory,
          attachmentName: language.t("common.attachment"),
          addToChatLabel: language.t("session.addToChat.selectionCount.one", { count: 1 }),
          maxLength: 96,
        }) || language.t("dialog.sessionTimeline.untitled")
      const messages = sessionMessages()
      const turn = timelineTurnByAnchorID().get(message.id)
      const memberIDs = turn ? new Set(turn.members.map((member) => member.messageID)) : undefined
      const index = memberIDs ? -1 : messages.findIndex((item) => item.id === message.id)
      const nextUser = index === -1 ? -1 : messages.findIndex((item, next) => next > index && item.role === "user")
      // 新协议按物理 turn 收集全部成员；旧历史仍以相邻 user 边界构造迷你图。
      const turnMessages = memberIDs
        ? messages.filter((item) => memberIDs.has(item.id))
        : index === -1
          ? [message]
          : messages.slice(index, nextUser === -1 ? undefined : nextUser)
      const assistant = turnMessages.findLast((item): item is AssistantMessage => item.role === "assistant")
      const body = assistantMessagePreview(rawPartsByMessage[assistant?.id ?? ""] ?? [], 180) || title
      return {
        id: message.id,
        title,
        body,
        footer: conversationMinimapFooter(turnMessages.flatMap((item) => rawPartsByMessage[item.id] ?? [])),
        time: message.time.created ? formatMessageTimestamp(message.time.created, language.intl()) : undefined,
      }
    }),
  )
  createEffect(on(rendered, () => scheduleVisibleMessageIDUpdate(), { defer: true }))
  const jumpToMinimapMessage = (id: string) => {
    const message = props.renderedUserMessages.find((item) => item.id === id)
    if (!message) return
    // Minimap 只负责选中逻辑 turn，不在组件内维护第二套滚动坐标算法。
    props.onJumpToMessage(message)
  }

  const [title, setTitle] = createStore({
    draft: "",
    editing: false,
    menuOpen: false,
    pendingRename: false,
    pendingShare: false,
    suppressBlurSave: false,
  })
  let titleRef: HTMLInputElement | undefined

  const [share, setShare] = createStore({
    open: false,
    dismiss: null as "escape" | "outside" | null,
  })

  let more: HTMLButtonElement | undefined

  const viewShare = () => {
    const url = shareUrl()
    if (!url) return
    platform.openLink(url)
  }

  const errorMessage = (err: unknown) => {
    // resolveError 精确分类后端认证/权益/额度/限速错误；返回 unknown 时用 formatServerError 保留丰富格式化
    const resolved = resolveError(err)
    if (resolved.category !== "unknown") {
      return language.t(resolved.messageKey as any)
    }
    return formatServerError(err, language.t, language.t("common.requestFailed"))
  }

  const shareMutation = useMutation(() => ({
    mutationFn: (id: string) => globalSDK.client.session.share({ sessionID: id, directory: sdk.directory }),
    onError: (err) => {
      console.error("Failed to share session", err)
    },
  }))

  const unshareMutation = useMutation(() => ({
    mutationFn: (id: string) => globalSDK.client.session.unshare({ sessionID: id, directory: sdk.directory }),
    onError: (err) => {
      console.error("Failed to unshare session", err)
    },
  }))

  const titleMutation = useMutation(() => ({
    mutationFn: (input: { id: string; title: string }) =>
      sdk.client.session.update({ sessionID: input.id, title: input.title }),
    onSuccess: (_, input) => {
      sync.set(
        produce((draft) => {
          const index = draft.session.findIndex((s) => s.id === input.id)
          if (index !== -1) draft.session[index].title = input.title
        }),
      )
      setTitle({ editing: false, suppressBlurSave: true })
    },
    onError: (err) => {
      showToast({
        title: language.t("common.requestFailed"),
        description: errorMessage(err),
      })
    },
  }))

  const shareSession = () => {
    const id = sessionID()
    if (!id || shareMutation.isPending) return
    if (!shareEnabled()) return
    shareMutation.mutate(id)
  }

  const unshareSession = () => {
    const id = sessionID()
    if (!id || unshareMutation.isPending) return
    if (!shareEnabled()) return
    unshareMutation.mutate(id)
  }

  createEffect(
    on(
      sessionKey,
      () =>
        setTitle({
          draft: "",
          editing: false,
          menuOpen: false,
          pendingRename: false,
          pendingShare: false,
          suppressBlurSave: false,
        }),
      { defer: true },
    ),
  )

  createEffect(
    on(
      () => [parentID(), childTaskDescription()] as const,
      ([id, description]) => {
        if (!id || description) return
        if (sync.data.message[id] !== undefined) return
        void sync.session.sync(id).catch(() => undefined)
      },
      { defer: true },
    ),
  )

  const openTitleEditor = () => {
    if (!sessionID() || parentID()) return
    setTitle({ editing: true, draft: titleLabel() ?? "", suppressBlurSave: false })
    requestAnimationFrame(() => {
      titleRef?.focus()
      titleRef?.select()
    })
  }

  const closeTitleEditor = () => {
    if (titleMutation.isPending) return
    setTitle({ editing: false, suppressBlurSave: true })
  }

  const saveTitleEditor = () => {
    const id = sessionID()
    if (!id) return
    if (titleMutation.isPending) return

    const next = title.draft.trim()
    if (!next || next === (titleLabel() ?? "")) {
      setTitle({ editing: false, suppressBlurSave: true })
      return
    }

    titleMutation.mutate({ id, title: next })
  }

  const navigateAfterSessionRemoval = (sessionID: string, parentID?: string, nextSessionID?: string) => {
    if (params.id !== sessionID) return
    if (parentID) {
      navigate(`/${params.dir}/session/${parentID}`)
      return
    }
    if (nextSessionID) {
      navigate(`/${params.dir}/session/${nextSessionID}`)
      return
    }
    navigate(`/${params.dir}/session`)
  }

  const archiveSession = (sessionID: string) =>
    runArchiveInflight(sessionID, async () => {
      const session = sync.session.get(sessionID)
      if (!session) return

      const sessions = sync.data.session ?? []
      const index = sessions.findIndex((s) => s.id === sessionID)
      const nextSession = index === -1 ? undefined : (sessions[index + 1] ?? sessions[index - 1])

      const wasViewing = params.id === sessionID

      const removed = removeSessionFromSidebar(globalSync, session)

      try {
        const response = await sdk.client.session.update({
          sessionID,
          directory: session.directory,
          time: { archived: Date.now() },
        })
        const archived = requireArchivedSession(response.data)
        // 成功后基于首次 removed 快照做终态结算（与 SSE 先到/后到经双向结算器去重）
        settleSessionRemovals(globalSync, removed, session.id)
        mergeArchivedSessionIntoListCache(queryClient, archived)
        invalidateArchivedSessionsList(queryClient)
        navigateAfterSessionRemoval(sessionID, session.parentID, nextSession?.id)
        const archivedSnapshot = archived
        showArchiveSessionToast({
          undoLabel: language.t("sidebar.thread.archive.toast.undo"),
          middleLabel: language.t("sidebar.thread.archive.toast.middle"),
          settingsLabel: language.t("sidebar.thread.archive.toast.settings"),
          suffixLabel: language.t("sidebar.thread.archive.toast.suffix"),
          onUndo: async () => {
            try {
              await unarchiveSession({
                client: globalSDK.client,
                globalSync,
                queryClient,
                session,
              })
              restoreArchivedSessionsToSidebar(globalSync, removed)
              if (wasViewing) navigate(`/${params.dir}/session/${sessionID}`)
            } catch (undoErr) {
              if (archivedSnapshot) mergeArchivedSessionIntoListCache(queryClient, archivedSnapshot)
              showToast({
                variant: "error",
                title: language.t("settings.archivedSessions.unarchive.failed"),
                description: formatServerError(undoErr, language.t, language.t("common.requestFailed")),
              })
            }
          },
          onOpenArchivedSettings: () => {
            openSettingsOverlay("archivedSessions")
          },
        })
      } catch (err) {
        restoreArchivedSessionsToSidebar(globalSync, removed)
        showToast({
          title: language.t("common.requestFailed"),
          description: errorMessage(err),
        })
      }
    })

  const deleteSession = async (sessionID: string) => {
    const session = sync.session.get(sessionID)
    if (!session) return false

    const sessions = (sync.data.session ?? []).filter((s) => !s.parentID && !s.time?.archived)
    const index = sessions.findIndex((s) => s.id === sessionID)
    const nextSession = index === -1 ? undefined : (sessions[index + 1] ?? sessions[index - 1])

    const result = await sdk.client.session
      .delete({ sessionID })
      .then((x) => x.data)
      .catch((err) => {
        showToast({
          title: language.t("session.delete.failed.title"),
          description: errorMessage(err),
        })
        return false
      })

    if (!result) return false

    sync.set(
      produce((draft) => {
        const removed = new Set<string>([sessionID])

        const byParent = new Map<string, string[]>()
        for (const item of draft.session) {
          const parentID = item.parentID
          if (!parentID) continue
          const existing = byParent.get(parentID)
          if (existing) {
            existing.push(item.id)
            continue
          }
          byParent.set(parentID, [item.id])
        }

        const stack = [sessionID]
        while (stack.length) {
          const parentID = stack.pop()
          if (!parentID) continue

          const children = byParent.get(parentID)
          if (!children) continue

          for (const child of children) {
            if (removed.has(child)) continue
            removed.add(child)
            stack.push(child)
          }
        }

        draft.session = draft.session.filter((s) => !removed.has(s.id))
      }),
    )

    navigateAfterSessionRemoval(sessionID, session.parentID, nextSession?.id)
    return true
  }

  const navigateParent = () => {
    const id = parentID()
    if (!id) return
    navigate(`/${params.dir}/session/${id}`)
  }

  function DialogDeleteSession(props: { sessionID: string }) {
    const name = createMemo(
      () => sessionTitle(sync.session.get(props.sessionID)?.title) ?? language.t("command.session.new"),
    )
    const handleDelete = async () => {
      await deleteSession(props.sessionID)
      dialog.close()
    }

    return (
      <Dialog title={language.t("session.delete.title")} fit>
        <div class="flex flex-col gap-4 pl-6 pr-2.5 pb-3">
          <div class="flex flex-col gap-1">
            <span class="text-14-regular text-text-strong">
              {language.t("session.delete.confirm", { name: name() })}
            </span>
          </div>
          <div class="flex justify-end gap-2">
            <Button variant="ghost" size="large" onClick={() => dialog.close()}>
              {language.t("common.cancel")}
            </Button>
            <Button variant="primary" size="large" onClick={handleDelete}>
              {language.t("session.delete.button")}
            </Button>
          </div>
        </div>
      </Dialog>
    )
  }

  return (
    <Show
      when={!props.mobileChanges}
      fallback={<div class="relative h-full overflow-hidden">{props.mobileFallback}</div>}
    >
      <div ref={setTimelineRoot} class="relative w-full h-full min-w-0">
        <AddToChatBubble container={timelineRoot} />
        <div
          data-component="session-scroll-jump"
          class="absolute left-1/2 -translate-x-1/2 bottom-5 z-[60] pointer-events-none transition-all duration-200 ease-out"
          classList={{
            "opacity-100 translate-y-0 scale-100": props.scroll.overflow && props.scroll.jump && !staging.isStaging(),
            "opacity-0 translate-y-2 scale-95 pointer-events-none":
              !props.scroll.overflow || !props.scroll.jump || staging.isStaging(),
          }}
        >
          <button
            class="pointer-events-auto flex items-center justify-center w-8 h-8 bg-transparent border-none cursor-pointer p-0 group"
            onClick={props.onResumeScroll}
          >
            <div
              class="flex items-center justify-center w-8 h-8 rounded-full transition-all duration-200 ease-out group-hover:-translate-y-px group-active:translate-y-0"
              style={{
                background: "var(--background-base)",
                color: "light-dark(#4f5561, rgba(255, 255, 255, 0.72))",
                border: "1px solid light-dark(rgba(17, 24, 39, 0.07), rgba(255, 255, 255, 0.16))",
                "box-shadow":
                  "light-dark(0 1px 2px rgba(17, 24, 39, 0.04), 0 0 0 1px rgba(255, 255, 255, 0.03), 0 6px 16px rgba(0, 0, 0, 0.18))",
              }}
            >
              <Icon name="arrow-down-to-line" size="small" />
            </div>
          </button>
        </div>
        <ScrollView
          viewportRef={setScrollRef}
          onUserScrollGesture={(viewport, direction) => props.onMarkScrollGesture(viewport, direction)}
          onWheel={(e) => {
            const root = e.currentTarget
            const delta = normalizeWheelDelta({
              deltaY: e.deltaY,
              deltaMode: e.deltaMode,
              rootHeight: root.clientHeight,
            })
            if (!delta) return
            markBoundaryGesture({ root, target: e.target, delta, onMarkScrollGesture: props.onMarkScrollGesture })
          }}
          onTouchStart={(e) => {
            touchGesture = e.touches[0]?.clientY
          }}
          onTouchMove={(e) => {
            const next = e.touches[0]?.clientY
            const prev = touchGesture
            touchGesture = next
            if (next === undefined || prev === undefined) return

            const delta = prev - next
            if (!delta) return

            const root = e.currentTarget
            markBoundaryGesture({ root, target: e.target, delta, onMarkScrollGesture: props.onMarkScrollGesture })
          }}
          onTouchEnd={() => {
            touchGesture = undefined
          }}
          onTouchCancel={() => {
            touchGesture = undefined
          }}
          onPointerDown={(e) => {
            if (e.target !== e.currentTarget) return
            props.onMarkScrollGesture(e.currentTarget)
          }}
          onScroll={(e) => {
            updateVisibleMessageID(e.currentTarget)
            props.onScheduleScrollState(e.currentTarget)
            props.onTurnBackfillScroll()
            if (!props.hasScrollGesture()) return
            props.onUserScroll()
            // 这里已经由 wheel、触摸、键盘或滚动条拖拽确认是用户滚动，不能再让旧的自动滚动标记覆盖它。
            // 输入入口已经记录了方向和惯性窗口；这里不能用未知方向再次上报，否则底部向上轻滚会被误恢复。
            props.onAutoScrollHandleUserScroll()
          }}
          onClick={props.onAutoScrollInteraction}
          class="relative min-w-0 w-full h-full"
          style={{
            "--session-title-height": showHeader() ? "40px" : "0px",
            "--sticky-accordion-top": showHeader() ? "48px" : "0px",
            "--scroll-view-thumb-color": "color-mix(in srgb, var(--text-strong) 54%, transparent)",
            "--scroll-view-thumb-active-color": "color-mix(in srgb, var(--text-strong) 78%, transparent)",
            "--scroll-view-thumb-dark-color": "var(--text-weak)",
            "--scroll-view-thumb-active-dark-color": "color-mix(in srgb, var(--text-strong) 68%, transparent)",
          }}
        >
          <div ref={props.setContentRef} class="min-w-0 w-full">
            <Show when={showHeader()}>
              <div
                data-session-title
                classList={{
                  "sticky top-0 z-[60] bg-[linear-gradient(to_bottom,var(--background-stronger)_48px,transparent)]": true,
                  relative: true,
                  "w-full": true,
                  "pl-2 pr-3 md:pl-4 md:pr-3": true,
                  "border-b border-border-weaker-base": true,
                }}
              >
                <div
                  class="h-11 w-full flex items-center gap-2"
                  // macOS 折叠 sidebar 时 chat header 顶到 left=0，让 252px 避开左上浮动 chrome 按钮组
                  // （80px 红绿灯 + 5×28px(size-7) 按钮 + 4×6px(gap-1.5) + 8px(pr-2) ≈ 252px）；
                  // 右栏关闭时 drag spacer 顶到 viewport 右边会盖到右上按钮组导致 mousedown 被当成窗口拖拽，
                  // 预留 170px 让 drag spacer 不延伸到快捷操作、打开项目、终端和右栏按钮区；桌面端右侧面板打开时主列变窄，改为 140px。
                  // Windows 无浮动栏 + drag region，按默认 12px
                  style={{
                    "padding-left":
                      layout.sidebar.opened() || (platform.platform === "desktop" && platform.os === "windows")
                        ? "12px"
                        : "252px",
                    "padding-right":
                      platform.platform === "desktop" && platform.os === "windows"
                        ? "12px"
                        : desktopSidePanelOpen()
                          ? "calc(135px + var(--remote-control-presence-reserve, 0px))"
                          : "calc(170px + var(--remote-control-presence-reserve, 0px))",
                  }}
                >
                  <div
                    class="flex items-center gap-1 min-w-0 max-w-[60%] select-text"
                    style={{ "-webkit-app-region": "no-drag" } as Record<string, string>}
                  >
                    <div class="flex items-center min-w-0 grow-1">
                      <Show when={parentID()}>
                        <button
                          type="button"
                          data-slot="session-title-parent"
                          class="min-w-0 max-w-[40%] truncate text-14-medium text-text-weak transition-colors hover:text-text-base"
                          onClick={navigateParent}
                        >
                          {parentTitle()}
                        </button>
                        <span
                          data-slot="session-title-separator"
                          class="px-2 text-14-medium text-text-weak"
                          aria-hidden="true"
                        >
                          /
                        </span>
                      </Show>
                      <Show when={childTitle() || title.editing}>
                        <Show
                          when={title.editing}
                          fallback={
                            <h1
                              data-slot="session-title-child"
                              class="text-14-medium text-text-strong truncate grow-1 min-w-0"
                              onDblClick={openTitleEditor}
                            >
                              {childTitle()}
                            </h1>
                          }
                        >
                          <InlineInput
                            ref={(el) => {
                              titleRef = el
                            }}
                            data-slot="session-title-child"
                            value={title.draft}
                            disabled={titleMutation.isPending}
                            class="text-14-medium text-text-strong grow-1 min-w-0 rounded-[6px] pl-1 -ml-1"
                            style={{ "--inline-input-shadow": "var(--shadow-xs-border-select)" }}
                            onInput={(event) => setTitle("draft", event.currentTarget.value)}
                            onKeyDown={(event) => {
                              event.stopPropagation()
                              if (event.key === "Enter") {
                                event.preventDefault()
                                void saveTitleEditor()
                                return
                              }
                              if (event.key === "Escape") {
                                event.preventDefault()
                                closeTitleEditor()
                              }
                            }}
                            onBlur={() => {
                              if (title.suppressBlurSave) {
                                setTitle("suppressBlurSave", false)
                                return
                              }
                              void saveTitleEditor()
                            }}
                          />
                        </Show>
                      </Show>
                    </div>
                  </div>
                  <Show when={sessionID()} keyed>
                    {(id) => (
                      <div
                        class="shrink-0 flex items-center gap-3"
                        style={{ "-webkit-app-region": "no-drag" } as Record<string, string>}
                      >
                        {/* 1:1 复刻 Codex：context usage 已挪到 composer 模型按钮左侧 */}
                        <Show when={!parentID()}>
                          <DropdownMenu
                            gutter={4}
                            placement="bottom-end"
                            open={title.menuOpen}
                            onOpenChange={(open) => {
                              setTitle("menuOpen", open)
                              if (open) return
                            }}
                          >
                            <DropdownMenu.Trigger
                              as={IconButton}
                              icon="dot-grid"
                              variant="ghost"
                              class="size-6 rounded-md data-[expanded]:bg-surface-base-active"
                              classList={{
                                "bg-surface-base-active": share.open || title.pendingShare,
                              }}
                              aria-label={language.t("common.moreOptions")}
                              aria-expanded={title.menuOpen || share.open || title.pendingShare}
                              ref={(el: HTMLButtonElement) => {
                                more = el
                              }}
                            />
                            <DropdownMenu.Portal>
                              <DropdownMenu.Content
                                class="codex-chat-menu"
                                style={{ "min-width": "104px" }}
                                onCloseAutoFocus={(event) => {
                                  if (title.pendingRename) {
                                    event.preventDefault()
                                    setTitle("pendingRename", false)
                                    openTitleEditor()
                                    return
                                  }
                                  if (title.pendingShare) {
                                    event.preventDefault()
                                    requestAnimationFrame(() => {
                                      setShare({ open: true, dismiss: null })
                                      setTitle("pendingShare", false)
                                    })
                                  }
                                }}
                              >
                                {/* 1:1 复刻 Codex：与 sidebar thread 右键菜单 11 项保持一致 */}
                                <DropdownMenu.Item onSelect={onTogglePin}>
                                  <DropdownMenu.ItemLabel>
                                    {isCurrentPinned()
                                      ? language.t("sidebar.thread.menu.unpin")
                                      : language.t("sidebar.thread.menu.pin")}
                                  </DropdownMenu.ItemLabel>
                                </DropdownMenu.Item>
                                <DropdownMenu.Item
                                  onSelect={() => {
                                    setTitle("pendingRename", true)
                                    setTitle("menuOpen", false)
                                  }}
                                >
                                  <DropdownMenu.ItemLabel>
                                    {language.t("sidebar.thread.menu.rename")}
                                  </DropdownMenu.ItemLabel>
                                </DropdownMenu.Item>
                                <DropdownMenu.Item onSelect={() => void archiveSession(id)}>
                                  <DropdownMenu.ItemLabel>
                                    {language.t("sidebar.thread.menu.archive")}
                                  </DropdownMenu.ItemLabel>
                                </DropdownMenu.Item>
                                <DropdownMenu.Separator />
                                <DropdownMenu.Item onSelect={onRevealInFinder}>
                                  <DropdownMenu.ItemLabel>
                                    {language.t("sidebar.thread.menu.revealInFinder", {
                                      name: language.t(fileManagerInfo(platform.os).nameKey),
                                    })}
                                  </DropdownMenu.ItemLabel>
                                </DropdownMenu.Item>
                                <DropdownMenu.Item onSelect={onCopyDirectory}>
                                  <DropdownMenu.ItemLabel>
                                    {language.t("sidebar.thread.menu.copyDirectory")}
                                  </DropdownMenu.ItemLabel>
                                </DropdownMenu.Item>
                                <DropdownMenu.Item onSelect={onCopyId}>
                                  <DropdownMenu.ItemLabel>
                                    {language.t("sidebar.thread.menu.copyId")}
                                  </DropdownMenu.ItemLabel>
                                </DropdownMenu.Item>
                                <DropdownMenu.Item onSelect={onCopyLink}>
                                  <DropdownMenu.ItemLabel>
                                    {language.t("sidebar.thread.menu.copyLink")}
                                  </DropdownMenu.ItemLabel>
                                </DropdownMenu.Item>
                                {/* 1:1 复刻 Codex：标记未读 / 派生到本地 / 派生到新工作树 / 在迷你窗口打开 暂为 stub，
                                    本 PR 仅做视觉和结构对齐，未完成功能不暴露在正式菜单中（reviewer 反馈） */}
                              </DropdownMenu.Content>
                            </DropdownMenu.Portal>
                          </DropdownMenu>

                          <KobaltePopover
                            open={share.open}
                            anchorRef={() => more}
                            placement="bottom-end"
                            gutter={4}
                            modal={false}
                            onOpenChange={(open) => {
                              if (open) setShare("dismiss", null)
                              setShare("open", open)
                            }}
                          >
                            <KobaltePopover.Portal>
                              <KobaltePopover.Content
                                data-component="popover-content"
                                style={{ "min-width": "320px" }}
                                onEscapeKeyDown={(event) => {
                                  setShare({ dismiss: "escape", open: false })
                                  event.preventDefault()
                                  event.stopPropagation()
                                }}
                                onPointerDownOutside={() => {
                                  setShare({ dismiss: "outside", open: false })
                                }}
                                onFocusOutside={() => {
                                  setShare({ dismiss: "outside", open: false })
                                }}
                                onCloseAutoFocus={(event) => {
                                  if (share.dismiss === "outside") event.preventDefault()
                                  setShare("dismiss", null)
                                }}
                              >
                                <div class="flex flex-col p-3">
                                  <div class="flex flex-col gap-1">
                                    <div class="text-13-medium text-text-strong">
                                      {language.t("session.share.popover.title")}
                                    </div>
                                    <div class="text-12-regular text-text-weak">
                                      {shareUrl()
                                        ? language.t("session.share.popover.description.shared")
                                        : language.t("session.share.popover.description.unshared")}
                                    </div>
                                  </div>
                                  <div class="mt-3 flex flex-col gap-2">
                                    <Show
                                      when={shareUrl()}
                                      fallback={
                                        <Button
                                          size="large"
                                          variant="primary"
                                          class="w-full"
                                          onClick={shareSession}
                                          disabled={shareMutation.isPending}
                                        >
                                          {shareMutation.isPending
                                            ? language.t("session.share.action.publishing")
                                            : language.t("session.share.action.publish")}
                                        </Button>
                                      }
                                    >
                                      <div class="flex flex-col gap-2">
                                        <TextField
                                          value={shareUrl() ?? ""}
                                          readOnly
                                          copyable
                                          copyKind="link"
                                          tabIndex={-1}
                                          class="w-full"
                                        />
                                        <div class="grid grid-cols-2 gap-2">
                                          <Button
                                            size="large"
                                            variant="secondary"
                                            class="w-full shadow-none border border-border-weak-base"
                                            onClick={unshareSession}
                                            disabled={unshareMutation.isPending}
                                          >
                                            {unshareMutation.isPending
                                              ? language.t("session.share.action.unpublishing")
                                              : language.t("session.share.action.unpublish")}
                                          </Button>
                                          <Button
                                            size="large"
                                            variant="primary"
                                            class="w-full"
                                            onClick={viewShare}
                                            disabled={unshareMutation.isPending}
                                          >
                                            {language.t("session.share.action.view")}
                                          </Button>
                                        </div>
                                      </div>
                                    </Show>
                                  </div>
                                </div>
                              </KobaltePopover.Content>
                            </KobaltePopover.Portal>
                          </KobaltePopover>
                        </Show>
                      </div>
                    )}
                  </Show>
                  {/* chat header 末尾的 drag spacer：剩余空白当作窗口拖拽区。
                      这里不能设置 pointer-events:none，否则 Chromium 命中测试会直接跳过该元素，Electron 收不到 drag region。
                      Windows 有自己的 titlebar 承担拖拽，再标 drag 会劫持右上按钮的 click。 */}
                  <div
                    class="flex-1 min-w-0 self-stretch"
                    style={
                      platform.platform === "desktop" && platform.os === "windows"
                        ? undefined
                        : ({ "-webkit-app-region": "drag" } as Record<string, string>)
                    }
                    aria-hidden
                  />
                </div>
              </div>
            </Show>
            <ConversationMinimap
              label={language.t("dialog.sessionTimeline.title")}
              items={minimapItems}
              activeMessageID={minimapActiveMessageID}
              onSelect={jumpToMinimapMessage}
            />
            <div
              role="log"
              data-slot="session-turn-list"
              // transform 动画由 index.css 里 [data-card-open="true"] 规则驱动；
              // 必须把 transform 写进 transition-property（带 duration/ease），
              // 否则 Tailwind utilities 层只声明 transition-[margin] 会覆盖 components 层的 transition: transform 简写，
              // 导致整列瞬移（composer 因无 transition-* 类不受影响，所以才出现「输入框平滑、历史瞬移」的不对称）。
              // 注意：max-width 由 index.css 的 [data-slot="session-turn-list"] 统一控制为 800px，
              // 不再用 Tailwind 的 md:max-w-200 / 2xl:max-w-[1000px]，避免视窗跨 2xl 断点时宽度瞬跳 200px。
              class="flex flex-col items-start justify-start pb-16 w-full transition-[margin,transform] duration-[280ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none"
              classList={{
                "mt-0.5": props.centered,
                "mt-0": !props.centered,
              }}
            >
              <Show when={props.turnStart > 0 || props.historyMore}>
                <div class="w-full flex justify-center">
                  <Button
                    variant="ghost"
                    size="large"
                    class="text-12-medium opacity-50"
                    disabled={props.historyLoading}
                    onClick={props.onLoadEarlier}
                  >
                    {props.historyLoading
                      ? language.t("session.messages.loadingEarlier")
                      : language.t("session.messages.loadEarlier")}
                  </Button>
                </div>
              </Show>
              {/* 派生分界在渲染窗口之上（旧导入消息未加载、当前全是新消息）：banner 落到窗口顶部 */}
              <Show when={props.forkedFrom?.() && props.forkBoundaryBeforeMessageID?.() && !forkBoundaryInWindow()}>
                {renderForkedFromBanner()}
              </Show>
              <For each={renderedTurnIDs()}>
                {(turnID) => {
                  const turn = createMemo(() => timelineTurnByID().get(turnID))
                  const messageID = createMemo(() => {
                    const current = turn()
                    return (current ? timelineTurnAnchorMessageID(current, renderedSet()) : undefined) ?? turnID
                  })
                  const active = createMemo(() => activeMessageID() === messageID())
                  // 聚合后 messageID 是响应式 accessor，列表仍以物理 turnID 保持行身份，同时允许分页回填更新根锚点。
                  const isLatestTurn = createMemo(() => lastRenderedUserMessageID() === messageID())
                  const working = createMemo(() => activeTurnWorking() && active())
                  const message = createMemo(() => sessionMessages().find((item) => item.id === messageID()))
                  const turnMemberIDs = createMemo(
                    () => turn()?.members.map((member) => member.messageID),
                    undefined,
                    {
                      // 根锚点等外围元数据变化时成员序列仍可复用，避免 SessionTurn 无意义重算展示树。
                      equals: same,
                    },
                  )
                  const steeringUserMessageIDs = createMemo(
                    () =>
                      (turn()?.members ?? []).flatMap((member) =>
                        member.type === "user" && member.steering ? [member.messageID] : [],
                      ),
                    [],
                    { equals: same },
                  )
                  const comments = createMemo(
                    () => messageComments(sync.data.part[messageID()] ?? []),
                    [],
                    {
                      equals: (a, b) =>
                        a.length === b.length &&
                        a.every(
                          (c, i) =>
                            c.path === b[i].path &&
                            c.comment === b[i].comment &&
                            c.selection?.startLine === b[i].selection?.startLine &&
                            c.selection?.endLine === b[i].selection?.endLine,
                        ),
                    },
                  )
                  const turnContainsMessage = (candidate: string | undefined) =>
                    !!candidate &&
                    (candidate === messageID() ||
                      turn()?.members.some((member) => member.messageID === candidate) === true)
                  return (
                    <>
                      {/* 派生 banner 卡在「fork 后第一条新消息」之前——即克隆历史与用户后续输入的分界 */}
                      <Show when={props.forkedFrom?.() && props.forkBoundaryBeforeMessageID?.() === messageID()}>
                        {renderForkedFromBanner()}
                      </Show>
                      <TimelineTurnAnchor
                        messageID={messageID()}
                        turnID={turn()?.id}
                        anchor={props.anchor}
                        active={active()}
                        latest={isLatestTurn()}
                      >
                        <Show when={settings.general.showTimestamps() && message()?.time.created}>
                          {(created) => (
                            <div class="w-full px-4 md:px-5 pb-2 text-11-regular text-text-weaker">
                              {formatMessageTimestamp(created(), language.intl())}
                            </div>
                          )}
                        </Show>
                        <MessageCommentStrip comments={comments()} />
                        <SessionTurn
                          sessionID={sessionID() ?? ""}
                          messageID={messageID()}
                          messages={sessionMessages()}
                          parts={props.parts}
                          memberMessageIDs={turnMemberIDs()}
                          steeringUserMessageIDs={steeringUserMessageIDs()}
                          messageAnchor={props.anchor}
                          beforeSteeringMessage={(steeringMessageID) => (
                            <MessageCommentStrip
                              comments={messageComments(sync.data.part[steeringMessageID] ?? [])}
                              nested
                            />
                          )}
                          afterSteeringMessage={(steeringMessageID) =>
                            modelSwitchMessageID() === steeringMessageID ? renderModelSwitchNotice() : undefined
                          }
                          diffOverlay={props.diffOverlay}
                          diffOverlayWorkspaceRoot={props.diffOverlayWorkspaceRoot}
                          actions={props.actions}
                          isLatestUserTurn={lastRenderedUserMessageID() === messageID()}
                          afterUserContent={
                            modelSwitchMessageID() === messageID() ? renderModelSwitchNotice() : undefined
                          }
                          onErrorAction={handleErrorAction}
                          active={active()}
                          working={working()}
                          // SessionTurn 完成态折叠需要主时间线真实视口，不能使用自身 overflow-visible 的内容 wrapper。
                          scrollContainer={scrollRoot}
                          status={active() ? sessionStatus() : undefined}
                          showReasoningSummaries={settings.general.showReasoningSummaries()}
                          shellToolDefaultOpen={settings.general.shellToolPartsExpanded()}
                          editToolDefaultOpen={settings.general.editToolPartsExpanded()}
                          classes={{
                            root: "min-w-0 w-full relative",
                            content: "flex flex-col justify-between !overflow-visible",
                            container: "w-full px-4 md:px-5",
                          }}
                        />
                      </TimelineTurnAnchor>
                      {/* goal 达成行绑定在「调用 update_goal complete 的那一轮」之后，不随新消息漂移 */}
                      <Show
                        when={turnContainsMessage(props.goalAchieved?.()?.afterMessageID) && props.goalAchieved?.()}
                        keyed
                      >
                        {(achieved) => renderGoalAchieved(achieved.totalTime)}
                      </Show>
                    </>
                  )
                }}
              </For>
              {/* 兜底：没有任何「新消息」（fork 后未继续，全是导入历史）时，banner 落到列表末尾标记继续点 */}
              <Show when={props.forkedFrom?.() && !props.forkBoundaryBeforeMessageID?.()}>
                {renderForkedFromBanner()}
              </Show>
              {/* goal 达成行兜底：定位不到完成轮（如旧会话无工具记录）时回落到列表末尾 */}
              <Show
                when={props.goalAchieved?.() && !props.goalAchieved()?.afterMessageID && props.goalAchieved?.()}
                keyed
              >
                {(achieved) => renderGoalAchieved(achieved.totalTime)}
              </Show>
            </div>
          </div>
        </ScrollView>
      </div>
    </Show>
  )
}
