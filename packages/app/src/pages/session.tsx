import type { AddonAvailable, Project, UserMessage } from "@opencode-ai/sdk/v2"
import type { Session, VcsInfo } from "@opencode-ai/sdk/v2/client"
import { OPERATION_ICON_OPTIONS, OPERATION_NAME_MAX_LENGTH } from "@/utils/operation-icons"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { createQuery, skipToken, useMutation, useQueryClient } from "@tanstack/solid-query"
import {
  batch,
  onCleanup,
  Show,
  Match,
  Switch,
  createMemo,
  createEffect,
  createComputed,
  createSignal,
  on,
  onMount,
  untrack,
  createResource,
  For,
} from "solid-js"
import { makeEventListener } from "@solid-primitives/event-listener"
import { createMediaQuery } from "@solid-primitives/media"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import { useLocal } from "@/context/local"
import { selectionFromLines, useFile, type FileSelection, type SelectedLineRange } from "@/context/file"
import { createStore, type SetStoreFunction } from "solid-js/store"
import { ResizeHandle } from "@opencode-ai/ui/resize-handle"
import { Select } from "@opencode-ai/ui/select"
import { Tabs } from "@opencode-ai/ui/tabs"
import { createAutoScroll, type AutoScrollDirection } from "@opencode-ai/ui/hooks"
import { previewSelectedLines } from "@opencode-ai/ui/pierre/selection-bridge"
import { Button } from "@opencode-ai/ui/button"
import { DiffChanges } from "@opencode-ai/ui/diff-changes"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Popover } from "@opencode-ai/ui/popover"
import { Icon } from "@opencode-ai/ui/icon"
import { AppIcon } from "@opencode-ai/ui/app-icon"
import emptyFileChanges from "@/assets/empty-file-changes.svg"
import { TextField } from "@opencode-ai/ui/text-field"
import { Tooltip, TooltipKeybind } from "@opencode-ai/ui/tooltip"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { showToast } from "@opencode-ai/ui/toast"
import { checksum } from "@opencode-ai/core/util/encode"
import { getFilename } from "@opencode-ai/core/util/path"
import { useSearchParams, useNavigate } from "@solidjs/router"
import { GetPlusButton, NewSessionView } from "@/components/session"
import { createBrowserTabId, setBrowserUrl, setOpenExternalLinkHandler } from "@/components/session/browser-tab"
import { useCommand } from "@/context/command"
import { useComments } from "@/context/comments"
import { usePlatform } from "@/context/platform"
import { fileManagerInfo } from "@/utils/file-manager"
import { knownOpenerOverride } from "@/utils/project-openers"
import type { InstalledOpener } from "@/context/platform"
import type { EditSummaryOpener } from "@opencode-ai/ui/message-part"
import { getDirectory } from "@opencode-ai/core/util/path"
import { getDefaultEditorOpener, orderOpenersByDefaultEditor, setDefaultEditorOpener } from "@/utils/default-opener"
import { getSessionPrefetch, SESSION_PREFETCH_TTL } from "@/context/global-sync/session-prefetch"
import { useGlobalSDK } from "@/context/global-sdk"
import { loadMcpQuery, useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { useLayout, DEFAULT_REVIEW_PANEL_WIDTH } from "@/context/layout"
import { parsePromptWithPluginMentions, usePrompt } from "@/context/prompt"
import { useSDK } from "@/context/sdk"
import { useSettings } from "@/context/settings"
import { useServer } from "@/context/server"
import { usePermission } from "@/context/permission"
import { sessionRouteActive } from "@/context/session-active"
import { openSettingsOverlay } from "@/context/open-settings"
import { openUserCenterOverlay } from "@/context/open-user-center"
import {
  SessionDetailsCard,
  ProgressSection,
  GitSection,
  OutputSection,
  SourcesSection,
  type HeaderAction,
} from "@/components/session-details-card"
import {
  finalizeSessionOutputArtifacts,
  normalizeOutputArtifactKey,
  outputArtifactsFromParts,
  recordSessionOutputArtifact,
  removeSessionOutputArtifact,
  sessionOutputArtifactPreviewUrls,
  sessionWebSourceUrls,
  shellOutputFileEventsFromParts,
} from "@/components/session-details-card-sources"
import { generateTomlContent } from "@/components/settings-environment"
import { ScratchModeProvider } from "@/components/session-environment-controls"
import { isIconName } from "@opencode-ai/ui/icon"
import { resolveWorkspaceFilePath } from "@opencode-ai/ui/session-turn-path"
import { useSync } from "@/context/sync"
import { useTerminal } from "@/context/terminal"
import {
  buildFollowupOptimisticUser,
  type FollowupDraft,
  resolveFollowupSlashCommand,
  sendFollowupDraft,
} from "@/components/prompt-input/submit"
import { createSessionComposerState, SessionComposerRegion } from "@/pages/session/composer"
import {
  consumeSessionSyncDebugError,
  createOpenReviewFile,
  createOpenSessionFileTab,
  createSessionChromeVisible,
  createSessionDesktopLayout,
  createSessionTabs,
  createSizing,
  focusTerminalById,
  runSessionSyncAutoRetry,
  runSessionSyncRetry,
  sessionMessageRenderState,
  shouldFocusTerminalOnKeyDown,
} from "@/pages/session/helpers"
import { MessageTimeline } from "@/pages/session/message-timeline"
import { runEditMessageSubmit } from "@/pages/session/edit-message-submit"
import { formatElapsed } from "@/pages/session/composer/session-goal-dock"
import {
  clipTimelineTurns,
  dedupeUserTurnsWithAliases,
  displayUserPartsByMessage,
  orderTimelineMessages,
  sameUserTurnView,
  timelineTurnUserMessages,
} from "@/pages/session/user-turns"
import { type DiffStyle, SessionReviewTab, type SessionReviewTabProps } from "@/pages/session/review-tab"
import {
  filterDiffRowsWithMaterialChange,
  isSessionReviewFileRemoved,
  mergeDiffsWithOverlay,
  toolDiffsFromParts,
  type SessionReviewGitOpsMenu,
  type MergeableDiff,
} from "@opencode-ai/ui/session-review"
import { useSessionLayout } from "@/pages/session/session-layout"
import { syncSessionModel } from "@/pages/session/session-model-helpers"
import { SessionSidePanel } from "@/pages/session/session-side-panel"
import {
  activeTimelineTurnGroupID,
  compactionInFlight,
  followupAwaitingResult,
  confirmFollowupMessagePersisted,
  createFollowupSendClaimRegistry,
  downgradeFollowupSteerToQueue,
  followupCanAutoSend,
  followupDraftForSend,
  followupsAfterSendAck,
  followupDraftAlreadySent,
  followupFailureIsRetryableBusy,
  followupFailureIsStaleSteerTarget,
  followupMessageID,
  followupPausedQueueAllowsSend,
  followupDockMode,
  followupPostAckCanTrack,
  followupPromptMessageMatches,
  followupRestoreShouldDowngradeSteer,
  followupSendGateOpen,
  followupSendGateWorking,
  followupShouldQueueInput,
  followupShouldStoreManualSteer,
  followupShouldBlockSend,
  followupShouldPauseForManualSteer,
  followupShouldUseSteer,
  isQueuedUserMessage,
  lastAssistantMessage,
  manualSteerAcknowledgedAt,
  manualSteerHydrationState,
  manualSteerMessageMatchesTarget,
  manualSteerSendBlocker,
  manualSteerTargetWaitInactiveObserved,
  manualSteerTargetWaitState,
  nextFollowupToSend,
  pauseManualSteerState,
  promoteFollowupDraftToSteer,
  recoverStaleSteerToPausedQueue,
  recoverManualSteerDraft,
  resolvedSessionStatusBusy,
  selectManualSteerTargetTurnID,
  sessionActiveTurnID,
  sessionActiveTurnStartedAt,
  sessionHasRunningTurn,
  sessionHasStaleRunState,
  unsentFollowupDrafts,
} from "@/pages/session/followup-queue"
import {
  automationPanel,
  automationPanelCollapsed,
  toggleAutomationPanelCollapsed,
} from "@/pages/automation/panel-store"
import { TerminalPanel } from "@/pages/session/terminal-panel"
import { useSessionCommands } from "@/pages/session/use-session-commands"
import { useSessionHashScroll } from "@/pages/session/use-session-hash-scroll"
import { Identifier } from "@/utils/id"
import { diffs as list } from "@/utils/diffs"
import { Persist, persisted, scopedInstance } from "@/utils/persist"
import { restoreEditorFromUserParts } from "@/utils/prompt"
import { buildRequestParts } from "@/components/prompt-input/build-request-parts"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { decode64 } from "@/utils/base64"
import {
  removeSessionFromSidebar,
  purgeSessionFromSidebar,
  getSessionAcrossDirectories,
  findSessionInStores,
  isSessionNotFoundError,
} from "@/components/settings-archived-sessions/sync"
import { Worktree as WorktreeState } from "@/utils/worktree"
import { isTransportError } from "@/components/prompt-input/optimistic-session"
import { same } from "@/utils/same"
import { formatServerError } from "@/utils/server-errors"
import {
  acceptReviewChangeSelection,
  coerceReviewChangeModeWhenBlocked,
  defaultReviewChangeMode,
  gitFeaturesEnabled as reviewGitFeaturesEnabled,
  gitReviewBlocked as reviewGitReviewBlocked,
  isReviewChangeModeDisabled,
  reviewChangeModeOptions,
  type ReviewChangeMode,
  vcsGitStatusKnown as reviewVcsGitStatusKnown,
} from "@/pages/session/review-git-gate"
import { resolveError } from "@opencode-ai/core/error/resolve"
import { openHttpUrl } from "@/utils/open-http-url"

const emptyUserMessages: UserMessage[] = []
type FollowupItem = FollowupDraft & {
  id: string
  // 服务端消息 ID 必须随草稿持久化，网络状态不确定后的重试才能保持幂等。
  messageID?: string
  afterMessageID?: string
  // 边界消息可能在分页后暂时不可见；持久化创建时间才能在远程 ID 不可排序时继续判断先后。
  afterMessageCreated?: number
  // 直接回车产生的 steer 必须优先于普通本地队列，并在刷新后继续保持该意图。
  manualSteer?: boolean
  // 引导意图产生时锁定的逻辑回合；服务端回报实际活动回合时会按官方逻辑更新一次。
  targetTurnID?: string
  // 用户产生引导意图时的 active run 代次；等待器只接受同一代次后来发布的 turnID。
  targetTurnStartedAt?: number
  // 权威 turnID 尚未发布时，用当前可见逻辑回合临时归组 optimistic user；该值绝不发给 steer API。
  optimisticTurnID?: string
}
type FollowupEdit = Pick<FollowupItem, "id" | "prompt" | "context" | "addToChatSnippets">
type FollowupAwaiting = { messageID: string; startedAt: number }
type ManualSteerPending = {
  messageID: string
  startedAt: number
  // RPC 已接受后仍保留 recovery，直到精确 marker/终态完成；该标记阻止停止操作重复恢复草稿。
  acknowledged?: boolean
  // 连续引导沿用这份权威目标；普通 status 抖动不能改绑，只有 steer mismatch 响应可以更新。
  targetTurnID?: string
  // inactive fallback 已经切换为普通 start-turn，但 durable ACK 尚未返回；此标记阻止 hydration 把它误当成未绑定 steer。
  fallback?: boolean
  // durable ACK 前刷新或停止时保留原草稿，避免用户看到引导气泡后队列项永久消失。
  recovery?: { item: FollowupItem; index: number }
}
// 将旧版单条待处理引导和新版数组统一成可安全修改的数组，兼容历史持久化状态。
const manualSteerPendingList = (value: ManualSteerPending | ManualSteerPending[] | undefined): ManualSteerPending[] =>
  Array.isArray(value) ? value.slice() : value ? [value] : []
// 会话提交锁必须跨 Page 卸载保留；否则 ACK 返回前离开再回来会并发发出下一条 steer。
const followupSendClaimRegistry = createFollowupSendClaimRegistry()
// 官方只维护一份 conversation state；本地页面重挂时用模块级所有者和停止代次模拟同一生命周期，旧页面不得回写同一持久化键。
const followupLifecycleOwners = new Map<string, symbol>()
const followupAbortEpochs = new Map<string, number>()
const followupLifecycleKey = (directory: string, sessionID: string) => `${directory}\u0000${sessionID}`
const followupAbortEpoch = (directory: string, sessionID: string) =>
  followupAbortEpochs.get(followupLifecycleKey(directory, sessionID)) ?? 0
const emptyFollowups: FollowupItem[] = []

type ChangeMode = ReviewChangeMode
type VcsMode = "unstaged" | "staged" | "branch"

function createHeaderActionID() {
  if (typeof crypto === "object" && "randomUUID" in crypto) return crypto.randomUUID()
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function headerActionKey(item: { name?: string; command?: string }) {
  return `${item.name ?? ""}\u0000${item.command ?? ""}`
}

function DialogAddHeaderAction(props: {
  projectName: string
  action?: HeaderAction
  onSave: (action: HeaderAction) => void
}) {
  const dialog = useDialog()
  const language = useLanguage()
  const [store, setStore] = createStore({
    name: props.action?.name ?? "",
    command: props.action?.command ?? "",
    icon: props.action?.icon ?? ("run" as const),
  })
  const [iconPickerOpen, setIconPickerOpen] = createSignal(false)

  const iconOptions = OPERATION_ICON_OPTIONS.map((option) => ({ ...option, label: language.t(option.label) }))
  const selectedIcon = () => iconOptions.find((o) => o.icon === store.icon) ?? iconOptions[0]

  const save = () => {
    const name = store.name.trim()
    const command = store.command.trim()
    if (!name || !command) return
    props.onSave({ id: props.action?.id ?? createHeaderActionID(), name, command, icon: store.icon })
    dialog.close()
  }

  function handleSubmit(e: SubmitEvent) {
    e.preventDefault()
    save()
  }

  return (
    <Dialog
      fit
      title={language.t(props.action ? "dialog.operation.edit.title" : "dialog.operation.add.title")}
      description={
        !props.action ? (
          <p class="text-13-regular text-text-weak">{language.t("dialog.operation.add.subtitle")}</p>
        ) : undefined
      }
      class="codex-dialog operation-dialog w-full max-w-[480px] mx-auto !min-h-0"
    >
      <form onSubmit={handleSubmit} class="flex flex-col gap-4 px-6 pt-1 pb-6 text-text-weak">
        {/* 名称 */}
        <div class="flex flex-col gap-1.5">
          <label class="text-13-medium text-text-weak">{language.t("dialog.operation.add.name")}</label>
          <div class="flex items-center gap-2">
            <Popover
              open={iconPickerOpen()}
              onOpenChange={setIconPickerOpen}
              triggerAs={Button}
              triggerProps={{
                type: "button",
                variant: "secondary",
                size: "small",
                class: "!border-0 !shadow-none !rounded-lg px-2 [&:hover:not(:disabled)]:!bg-surface-weak shrink-0",
                style: { "--button-secondary-base": "var(--background-weak)" } as any,
              }}
              trigger={<Icon name={selectedIcon().icon} size="small" class="text-icon-strong-base" />}
              // Dialog 根容器 z-index 为 300，Popover content 默认 z-50 会被覆盖，需显式提升到 310
              class="[&_[data-slot=popover-body]]:p-0 w-auto bg-transparent border-0 shadow-none !z-[310]"
              gutter={4}
              placement="bottom-start"
            >
              <Show when={iconPickerOpen()}>
                <div class="rounded-xl bg-surface-raised-stronger-non-alpha shadow-[var(--shadow-lg-border-base)] p-1 min-w-[160px]">
                  <For each={iconOptions}>
                    {(option) => (
                      <button
                        type="button"
                        onClick={() => {
                          setStore("icon", option.icon)
                          setIconPickerOpen(false)
                        }}
                        class="flex items-center gap-2 w-full px-3 py-2 rounded-lg text-13-regular text-text-strong hover:bg-surface-base-hover transition-colors"
                      >
                        <Icon name={option.icon} size="small" class="text-icon-strong-base" />
                        <span>{option.label}</span>
                        <Show when={store.icon === option.icon}>
                          <Icon name="check" size="small" class="ml-auto text-icon-weak" />
                        </Show>
                      </button>
                    )}
                  </For>
                </div>
              </Show>
            </Popover>
            <TextField
              type="text"
              hideLabel
              maxLength={OPERATION_NAME_MAX_LENGTH}
              value={store.name}
              onChange={(value) => setStore("name", value.slice(0, OPERATION_NAME_MAX_LENGTH))}
              class="flex-1"
            />
          </div>
        </div>
        {/* 命令 */}
        <div class="flex flex-col gap-1.5">
          <label class="text-13-medium text-text-weak">{language.t("dialog.operation.add.command")}</label>
          <textarea
            class="w-full rounded-xl border border-border-weaker-base bg-surface-raised-stronger-non-alpha px-4 py-3 text-13-regular text-text-base placeholder:text-text-weak focus:border-border-weak-base focus:outline-none resize-none font-mono"
            style={{ height: "90px" }}
            placeholder={language.t("dialog.operation.add.commandPlaceholder")}
            value={store.command}
            onInput={(e) => setStore("command", e.currentTarget.value)}
          />
        </div>
        {/* 底部按钮 */}
        <div class="flex justify-end gap-2 pt-2">
          <Button
            type="button"
            variant="ghost"
            size="large"
            class="!text-text-weak"
            onClick={() => {
              dialog.close()
              void import("@/components/dialog-settings").then((s) => {
                dialog.show(() => <s.DialogSettings tab="environment" />)
              })
            }}
          >
            {language.t("dialog.operation.add.environmentSettings")}
          </Button>
          <Button type="submit" variant="primary" size="large" disabled={!store.name.trim() || !store.command.trim()}>
            {language.t("common.save")}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

function DialogDeleteHeaderAction(props: { action: HeaderAction; onDelete: (id: string) => void }) {
  const dialog = useDialog()
  const language = useLanguage()

  return (
    <Dialog
      fit
      title={language.t("dialog.operation.delete.title")}
      description={language.t("dialog.operation.delete.description", { name: props.action.name })}
      class="codex-dialog w-full max-w-[440px] mx-auto !min-h-0"
    >
      <div class="flex justify-end gap-2 p-6 pt-0">
        <Button type="button" variant="ghost" size="large" onClick={() => dialog.close()}>
          {language.t("common.cancel")}
        </Button>
        <button
          type="button"
          onClick={() => {
            props.onDelete(props.action.id)
            dialog.close()
          }}
          class="h-9 px-4 rounded-lg text-14-medium transition-colors"
          style={{
            "background-color": "rgba(232,79,79,0.12)",
            color: "#E5484D",
          }}
        >
          {language.t("common.delete")}
        </button>
      </div>
    </Dialog>
  )
}

function DialogRunHeaderAction(props: { onSave: (action: HeaderAction) => void | Promise<void> }) {
  const dialog = useDialog()
  const language = useLanguage()
  const [store, setStore] = createStore({
    command: "",
  })

  const save = async () => {
    const command = store.command.trim()
    if (!command) return
    await props.onSave({ id: createHeaderActionID(), name: language.t("project.edit.iconRun"), command })
    dialog.close()
  }

  function handleSubmit(e: SubmitEvent) {
    e.preventDefault()
    void save()
  }

  return (
    <Dialog
      fit
      title={language.t("dialog.operation.run.title")}
      description={language.t("dialog.operation.add.subtitle")}
      class="codex-dialog w-full max-w-[440px] mx-auto !min-h-0"
    >
      <form onSubmit={handleSubmit} class="flex flex-col gap-4 p-6 pt-0">
        <TextField
          autofocus
          multiline
          label={language.t("dialog.operation.run.command")}
          placeholder={language.t("dialog.operation.run.commandPlaceholder")}
          value={store.command}
          onChange={(value) => setStore("command", value)}
        />
        <div class="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="large" onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" size="large" disabled={!store.command.trim()}>
            {language.t("common.save")}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

type SessionHistoryWindowInput = {
  sessionID: () => string | undefined
  messagesReady: () => boolean
  loaded: () => number
  visibleUserMessages: () => UserMessage[]
  historyMore: () => boolean
  historyLoading: () => boolean
  loadMore: (sessionID: string) => Promise<void>
  userScrolled: () => boolean
  scroller: () => HTMLDivElement | undefined
}

/**
 * Maintains the rendered history window for a session timeline.
 *
 * It keeps initial paint bounded to recent turns, reveals cached turns in
 * small batches while scrolling upward, and prefetches older history near top.
 */
function createSessionHistoryWindow(input: SessionHistoryWindowInput) {
  const turnInit = 10
  const turnBatch = 8
  const turnScrollThreshold = 200
  const turnPrefetchBuffer = 16
  const prefetchCooldownMs = 400
  const prefetchNoGrowthLimit = 2

  const [state, setState] = createStore({
    turnID: undefined as string | undefined,
    turnStart: 0,
    prefetchUntil: 0,
    prefetchNoGrowth: 0,
  })

  const initialTurnStart = (len: number) => (len > turnInit ? len - turnInit : 0)

  const turnStart = createMemo(() => {
    const id = input.sessionID()
    const len = input.visibleUserMessages().length
    if (!id || len <= 0) return 0
    if (state.turnID !== id) return initialTurnStart(len)
    if (state.turnStart <= 0) return 0
    if (state.turnStart >= len) return initialTurnStart(len)
    return state.turnStart
  })

  const setTurnStart = (start: number) => {
    const id = input.sessionID()
    const next = start > 0 ? start : 0
    if (!id) {
      setState({ turnID: undefined, turnStart: next })
      return
    }
    setState({ turnID: id, turnStart: next })
  }

  const renderedUserMessages = createMemo(
    () => {
      const msgs = input.visibleUserMessages()
      const start = turnStart()
      if (start <= 0) return msgs
      return msgs.slice(start)
    },
    emptyUserMessages,
    {
      equals: same,
    },
  )

  const preserveScroll = (fn: () => void) => {
    const el = input.scroller()
    if (!el) {
      fn()
      return
    }
    const beforeTop = el.scrollTop
    const beforeHeight = el.scrollHeight
    fn()
    requestAnimationFrame(() => {
      const delta = el.scrollHeight - beforeHeight
      if (!delta) return
      el.scrollTop = beforeTop + delta
    })
  }

  const backfillTurns = () => {
    const start = turnStart()
    if (start <= 0) return

    const next = start - turnBatch
    const nextStart = next > 0 ? next : 0

    preserveScroll(() => setTurnStart(nextStart))
  }

  /** Button path: reveal all cached turns, fetch older history, reveal one batch. */
  const loadAndReveal = async () => {
    const id = input.sessionID()
    if (!id) return

    const start = turnStart()
    const beforeVisible = input.visibleUserMessages().length
    let loaded = input.loaded()

    if (start > 0) setTurnStart(0)

    if (!input.historyMore() || input.historyLoading()) return

    let afterVisible = beforeVisible
    let added = 0

    while (true) {
      await input.loadMore(id)
      if (input.sessionID() !== id) return

      afterVisible = input.visibleUserMessages().length
      const nextLoaded = input.loaded()
      const raw = nextLoaded - loaded
      added += raw
      loaded = nextLoaded

      if (afterVisible > beforeVisible) break
      if (raw <= 0) break
      if (!input.historyMore()) break
    }

    if (added <= 0) return
    if (state.prefetchNoGrowth) setState("prefetchNoGrowth", 0)

    const growth = afterVisible - beforeVisible
    if (growth <= 0) return
    if (turnStart() !== 0) return

    const target = Math.min(afterVisible, beforeVisible + turnBatch)
    setTurnStart(Math.max(0, afterVisible - target))
  }

  /** Scroll/prefetch path: fetch older history from server. */
  const fetchOlderMessages = async (opts?: { prefetch?: boolean }) => {
    const id = input.sessionID()
    if (!id) return
    if (!input.historyMore() || input.historyLoading()) return

    if (opts?.prefetch) {
      const now = Date.now()
      if (state.prefetchUntil > now) return
      if (state.prefetchNoGrowth >= prefetchNoGrowthLimit) return
      setState("prefetchUntil", now + prefetchCooldownMs)
    }

    const start = turnStart()
    const beforeVisible = input.visibleUserMessages().length
    const beforeRendered = start <= 0 ? beforeVisible : renderedUserMessages().length
    let loaded = input.loaded()
    let added = 0
    let growth = 0

    while (true) {
      await input.loadMore(id)
      if (input.sessionID() !== id) return

      const nextLoaded = input.loaded()
      const raw = nextLoaded - loaded
      added += raw
      loaded = nextLoaded
      growth = input.visibleUserMessages().length - beforeVisible

      if (growth > 0) break
      if (raw <= 0) break
      if (opts?.prefetch) break
      if (!input.historyMore()) break
    }

    const afterVisible = input.visibleUserMessages().length

    if (opts?.prefetch) {
      setState("prefetchNoGrowth", added > 0 ? 0 : state.prefetchNoGrowth + 1)
    } else if (added > 0 && state.prefetchNoGrowth) {
      setState("prefetchNoGrowth", 0)
    }

    if (added <= 0) return
    if (growth <= 0) return

    if (opts?.prefetch) {
      const current = turnStart()
      preserveScroll(() => setTurnStart(current + growth))
      return
    }

    if (turnStart() !== start) return

    const currentRendered = renderedUserMessages().length
    const base = Math.max(beforeRendered, currentRendered)
    const target = Math.min(afterVisible, base + turnBatch)
    preserveScroll(() => setTurnStart(Math.max(0, afterVisible - target)))
  }

  const onScrollerScroll = () => {
    if (!input.userScrolled()) return
    const el = input.scroller()
    if (!el) return
    if (el.scrollTop >= turnScrollThreshold) return

    const start = turnStart()
    if (start > 0) {
      if (start <= turnPrefetchBuffer) {
        void fetchOlderMessages({ prefetch: true })
      }
      backfillTurns()
      return
    }

    void fetchOlderMessages()
  }

  createEffect(
    on(
      input.sessionID,
      () => {
        setState({ prefetchUntil: 0, prefetchNoGrowth: 0 })
      },
      { defer: true },
    ),
  )

  createEffect(
    on(
      () => [input.sessionID(), input.messagesReady()] as const,
      ([id, ready]) => {
        if (!id || !ready) return
        setTurnStart(initialTurnStart(input.visibleUserMessages().length))
      },
      { defer: true },
    ),
  )

  return {
    turnStart,
    setTurnStart,
    renderedUserMessages,
    loadAndReveal,
    onScrollerScroll,
  }
}

export default function Page() {
  const globalSync = useGlobalSync()
  const layout = useLayout()
  const local = useLocal()
  const file = useFile()
  const sync = useSync()
  const queryClient = useQueryClient()
  const dialog = useDialog()
  const language = useLanguage()
  const permission = usePermission()

  // 复用：分支创建对话框 + 内嵌「设置前缀」入口跳到 settings 的 Git tab
  const openBranchCreateDialog = () => {
    void import("@/components/dialog-branch-create").then((branch) => {
      dialog.show(() => (
        <branch.DialogBranchCreate
          onOpenPrefixSettings={() => {
            void import("@/components/dialog-settings").then((s) => {
              dialog.show(() => <s.DialogSettings tab="git" />)
            })
          }}
        />
      ))
    })
  }

  // Git 操作（提交 / 推送）的 busy 标记 + 调用包装
  const [gitOpsBusy, setGitOpsBusy] = createSignal(false)
  const openCommitDialog = () => {
    void import("@/components/dialog-commit").then((mod) => {
      dialog.show(() => (
        <mod.DialogCommit
          onCommitted={() => {
            refreshVcs()
            void queryClient.invalidateQueries({ queryKey: [...vcsKey(), "card-unstaged"] })
          }}
        />
      ))
    })
  }
  // 提取 hey-api 抛出对象里的可读消息（兼容 Error / string / { message } / { error } / { data: { message } }）
  const extractPushError = (err: unknown): string => {
    if (err instanceof Error && err.message) return err.message
    if (typeof err === "string" && err) return err
    if (err && typeof err === "object") {
      const obj = err as Record<string, unknown>
      if (typeof obj.message === "string" && obj.message) return obj.message
      if (typeof obj.error === "string" && obj.error) return obj.error
      if (obj.data && typeof obj.data === "object") {
        const d = obj.data as Record<string, unknown>
        if (typeof d.message === "string" && d.message) return d.message
      }
    }
    return language.t("common.requestFailed")
  }
  const showPushFailedDialog = (output: string, force: boolean) => {
    void import("@/components/dialog-push-failed").then((mod) => {
      const branchName = sync.data.vcs?.branch
      const command = force
        ? `git push --porcelain --force-with-lease${branchName ? ` -u origin ${branchName}` : ""}`
        : `git push --porcelain${branchName ? ` -u origin ${branchName}` : ""}`
      dialog.show(() => (
        <mod.DialogPushFailed command={command} output={output} onForcePush={() => void runPush(true)} />
      ))
    })
  }
  const runPush = async (force: boolean) => {
    if (gitOpsBusy()) return
    setGitOpsBusy(true)
    try {
      await sdk.client.vcs.push({ vcsPushInput: { force } })
      refreshVcs()
      showToast({
        variant: "success",
        title: language.t("branch.details.card.push"),
        description: language.t("toast.git.push.success"),
      })
    } catch (err: unknown) {
      // 失败弹 dialog 显示完整命令 + 错误输出；强制推送失败也走同一条路径再次弹窗
      showPushFailedDialog(extractPushError(err), force)
    } finally {
      setGitOpsBusy(false)
    }
  }
  const handlePush = () => {
    void import("@/components/dialog-push").then((mod) => {
      dialog.show(() => (
        <mod.DialogPush
          hasUncommitted={() => cardUncommittedCount() > 0}
          onContinue={(mode) => {
            if (mode === "push") {
              void runPush(false)
            } else {
              // commit-and-push：先开 commit dialog；提交完成后自动推送
              void import("@/components/dialog-commit").then((commit) => {
                dialog.show(() => (
                  <commit.DialogCommit
                    onCommitted={() => {
                      refreshVcs()
                      void queryClient.invalidateQueries({ queryKey: [...vcsKey(), "card-unstaged"] })
                      void runPush(false)
                    }}
                  />
                ))
              })
            }
          }}
        />
      ))
    })
  }

  const sdk = useSDK()
  const globalSDK = useGlobalSDK()
  const settings = useSettings()
  const server = useServer()
  const prompt = usePrompt()
  const comments = useComments()
  const terminal = useTerminal()
  const command = useCommand()
  const platform = usePlatform()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams<{ prompt?: string }>()
  const { params, sessionKey, tabs, view } = useSessionLayout()

  createEffect(() => {
    if (!params.id) return
    void queryClient.fetchQuery(loadMcpQuery(sync.directory, sdk.client))
  })

  createEffect(() => {
    if (!prompt.ready()) return
    untrack(() => {
      if (params.id) return
      const text = searchParams.prompt
      if (!text) return
      // 把 markdown 里的 lowercase name 提升成 display_name(读 addon.available 缓存)
      const resolveDisplayName = (addonKey: string) => {
        const list = queryClient.getQueryData<AddonAvailable[]>(["addon", "available", "global", language.locale()])
        return list?.find((p) => p.key === addonKey)?.display_name
      }
      const parts = parsePromptWithPluginMentions(text, resolveDisplayName)
      const totalLen = parts.reduce((s, p) => s + (p.type === "image" ? 0 : p.content.length), 0)
      prompt.set(parts, totalLen)
      setSearchParams({ ...searchParams, prompt: undefined })
    })
  })

  const [ui, setUi] = createStore({
    pendingMessage: undefined as string | undefined,
    reviewSnap: false,
    reviewExpanded: false,
    scrollGesture: 0,
    scroll: {
      overflow: false,
      bottom: true,
      jump: false,
    },
  })

  const workspaceKey = createMemo(() => params.dir ?? "")
  const workspaceTabs = createMemo(() => layout.tabs(workspaceKey))

  createEffect(
    on(
      () => params.id,
      (id, prev) => {
        if (!id) return
        if (prev) return

        const pending = layout.handoff.tabs()
        if (!pending) return
        if (Date.now() - pending.at > 60_000) {
          layout.handoff.clearTabs()
          return
        }

        if (pending.id !== id) return
        layout.handoff.clearTabs()
        if (pending.dir !== (params.dir ?? "")) return

        const from = workspaceTabs().tabs()
        if (from.all.length === 0 && !from.active) return

        const current = tabs().tabs()
        if (current.all.length > 0 || current.active) return

        const all = normalizeTabs(from.all)
        const active = from.active ? normalizeTab(from.active) : undefined
        tabs().setAll(all)
        tabs().setActive(active && all.includes(active) ? active : all[0])

        workspaceTabs().setAll([])
        workspaceTabs().setActive(undefined)
      },
      { defer: true },
    ),
  )

  const isDesktop = createSessionDesktopLayout(platform)
  /** Web 端审查 Tab 与右上角按钮仍用 lg；桌面端随 session 布局显示。 */
  const reviewLayoutControlsVisible = createMediaQuery("(min-width: 1024px)")
  const sessionChromeVisible = createSessionChromeVisible(platform, isDesktop, reviewLayoutControlsVisible)
  const size = createSizing()
  const desktopReviewOpen = createMemo(() => isDesktop() && view().reviewPanel.opened())
  const desktopFileTreeOpen = createMemo(() => isDesktop() && layout.fileTree.opened())
  // 自动化详情面板(点对话内联卡片打开):需让会话内容收缩 360px 给面板让位;折叠时不让位
  const desktopAutoPanelOpen = createMemo(
    () => isDesktop() && automationPanel()?.sessionKey === sessionKey() && !automationPanelCollapsed(),
  )
  const desktopSidePanelOpen = createMemo(() => desktopReviewOpen() || desktopFileTreeOpen() || desktopAutoPanelOpen())
  const gitInstalled = createMemo(() => sync.data.vcs?.git_installed === true)
  const localGit = createMemo(() => sync.data.vcs?.local_git === true)
  const vcsGitStatusKnown = createMemo(() => reviewVcsGitStatusKnown(sync.data.vcs))
  const gitFeaturesEnabled = createMemo(() => reviewGitFeaturesEnabled(sync.data.vcs))
  const gitReviewBlocked = createMemo(() => reviewGitReviewBlocked(sync.data.vcs))
  const defaultChangeMode = createMemo<ChangeMode>(() => defaultReviewChangeMode(sync.data.vcs))
  const vcsGitEnabled = gitFeaturesEnabled
  // 审查页「创建 Git 仓库」入口，后期启用改为 true
  const reviewCreateGitEnabled = false
  const showCreateGit = createMemo(
    () => reviewCreateGitEnabled && !!sync.project && !gitFeaturesEnabled() && gitInstalled() && !localGit(),
  )
  // 会话详情浮层：git 可用时显示完整环境卡片；无 git / 无 .git 时显示输出与来源摘要。
  const branchCardShown = createMemo(() => isDesktop() && !!params.id && (gitFeaturesEnabled() || gitReviewBlocked()))
  const MIN_SESSION_WIDTH = 450
  const MIN_MAIN_ROW_WIDTH_FOR_REVIEW_PANEL = MIN_SESSION_WIDTH + DEFAULT_REVIEW_PANEL_WIDTH
  const [mainRowWidth, setMainRowWidth] = createSignal(typeof window !== "undefined" ? window.innerWidth : 1200)
  const sessionWidthForReviewPanel = (row = mainRowWidth()) =>
    Math.max(MIN_SESSION_WIDTH, row - DEFAULT_REVIEW_PANEL_WIDTH)
  const sessionWidthForPinnedReviewPanel = (row = mainRowWidth()) => Math.max(0, row - DEFAULT_REVIEW_PANEL_WIDTH)
  const sessionResizeBounds = createMemo(() => ({
    min: MIN_SESSION_WIDTH,
    max: sessionWidthForReviewPanel(mainRowWidth()),
  }))
  const clampSessionWidthForReview = (width: number, row = mainRowWidth()) =>
    Math.min(Math.max(width, MIN_SESSION_WIDTH), sessionWidthForReviewPanel(row))
  const [reviewAutoCollapsed, setReviewAutoCollapsed] = createSignal(false)
  const [reviewPinnedOpenInNarrow, setReviewPinnedOpenInNarrow] = createSignal(false)
  const reviewPanelFitsMainRow = (row = mainRowWidth()) => row >= MIN_MAIN_ROW_WIDTH_FOR_REVIEW_PANEL
  const applyReviewPanelLayout = (row = mainRowWidth()) => {
    if (row <= 0) return
    const shouldPin =
      reviewPinnedOpenInNarrow() || (desktopReviewOpen() && !ui.reviewExpanded && !reviewPanelFitsMainRow(row))
    if (shouldPin) {
      if (!reviewPinnedOpenInNarrow()) setReviewPinnedOpenInNarrow(true)
      layout.session.resize(sessionWidthForPinnedReviewPanel(row))
      return
    }
    const session = layout.session.width()
    const max = sessionWidthForReviewPanel(row)
    const review = row - session
    if (review >= DEFAULT_REVIEW_PANEL_WIDTH) {
      if (session > max) layout.session.resize(max)
      if (session < MIN_SESSION_WIDTH) layout.session.resize(MIN_SESSION_WIDTH)
      return
    }
    layout.session.resize(max)
  }
  let previousMainRowWidth: number | undefined
  let mainRowResizeTimer: number | undefined
  const snapMainRowResize = () => {
    if (mainRowResizeTimer !== undefined) window.clearTimeout(mainRowResizeTimer)
    setUi("reviewSnap", true)
    mainRowResizeTimer = window.setTimeout(() => {
      mainRowResizeTimer = undefined
      setUi("reviewSnap", false)
    }, 120)
  }
  const updateMainRowWidth = (rawWidth: number) => {
    const width = Math.round(rawWidth)
    const previous = previousMainRowWidth
    if (previous === width) {
      setMainRowWidth(width)
      return
    }
    previousMainRowWidth = width
    const shrinking = previous !== undefined && previous > 0 && width < previous
    if (
      previous === undefined ||
      previous <= 0 ||
      width <= 0 ||
      !desktopReviewOpen() ||
      ui.reviewExpanded ||
      size.active()
    ) {
      setMainRowWidth(width)
      return
    }
    const delta = width - previous
    if (delta === 0) {
      setMainRowWidth(width)
      return
    }
    if (shrinking && !reviewPinnedOpenInNarrow() && !reviewPanelFitsMainRow(width)) {
      batch(() => {
        setMainRowWidth(width)
        setReviewAutoCollapsed(true)
        view().reviewPanel.close()
        setUi("reviewExpanded", false)
      })
      return
    }
    const current = layout.session.width()
    const next = reviewPinnedOpenInNarrow()
      ? sessionWidthForPinnedReviewPanel(width)
      : clampSessionWidthForReview(current + delta, width)
    batch(() => {
      snapMainRowResize()
      setMainRowWidth(width)
      if (Math.abs(next - current) >= 1) layout.session.resize(next)
    })
  }

  const sessionPanelWidth = createMemo(() => {
    // SessionDetailsCard 改为 absolute 浮层后不再占据独立列，session panel 始终满宽。
    if (!desktopSidePanelOpen()) return "100%"
    if (desktopAutoPanelOpen()) return "calc(100% - 360px)"
    if (desktopReviewOpen() && ui.reviewExpanded) return "0px"
    if (desktopReviewOpen()) return `${layout.session.width()}px`
    return `calc(100% - ${layout.fileTree.width()}px)`
  })

  const collapseReviewPanel = () => {
    setReviewAutoCollapsed(false)
    setReviewPinnedOpenInNarrow(false)
    view().reviewPanel.close()
    setUi("reviewExpanded", false)
  }

  const openReviewPanel = (input?: { manual?: boolean }) => {
    if (view().reviewPanel.opened()) return true
    if (platform.platform === "desktop" && !isDesktop()) {
      showToast({
        variant: "error",
        title: language.t("toast.review.narrowWindow.title"),
        description: language.t("toast.review.narrowWindow.description"),
      })
      return false
    }
    if (input?.manual === true) setReviewAutoCollapsed(false)
    view().reviewPanel.open()
    return true
  }

  const toggleReviewPanel = () => {
    if (view().reviewPanel.opened()) {
      collapseReviewPanel()
      return
    }
    openReviewPanel({ manual: true })
  }

  const toggleReviewPanelWidth = () => {
    if (!desktopReviewOpen()) return
    setUi("reviewExpanded", (expanded) => !expanded)
  }

  createEffect(() => {
    if (desktopReviewOpen()) return
    if (!ui.reviewExpanded) return
    setUi("reviewExpanded", false)
  })

  createEffect(() => {
    if (view().reviewPanel.opened()) return
    if (reviewAutoCollapsed()) return
    if (!reviewPinnedOpenInNarrow()) return
    setReviewPinnedOpenInNarrow(false)
  })

  createEffect(() => {
    if (!desktopReviewOpen() || ui.reviewExpanded) return
    if (reviewPinnedOpenInNarrow() && reviewPanelFitsMainRow(mainRowWidth())) {
      setReviewPinnedOpenInNarrow(false)
    }
    applyReviewPanelLayout(mainRowWidth())
  })

  createEffect(() => {
    if (isDesktop()) return
    collapseReviewPanel()
    if (layout.fileTree.opened()) layout.fileTree.close()
    if (store.mobileTab === "changes") setStore("mobileTab", "session")
  })

  // 浮层双行为模式：
  // - 宽屏（session-panel ≥ 1100px）：浮层是右上角的固定 floating 卡片，按钮控制 wideIntent（持久化 localStorage）。
  // - 窄屏：浮层是从按钮下拉的 dropdown（scale+fade 动画），narrowOpen 是瞬时状态。
  // 关闭语义：审查页未打开时仅再次点击 ℹ️ 可关；审查页已打开时允许点空白关闭。
  // 跨模式语义：宽→窄 自动收起（不动 wideIntent），窄→宽 恢复 wideIntent；narrowOpen 在每次模式切换时都重置。
  const OVERLAY_OPEN_KEY = "session-details-overlay.open"
  const PANEL_WIDE_THRESHOLD_PX = 1100
  const [wideIntent, setWideIntent] = createSignal(
    (() => {
      try {
        return window.localStorage.getItem(OVERLAY_OPEN_KEY) !== "0"
      } catch {
        return true
      }
    })(),
  )
  const [narrowOpen, setNarrowOpen] = createSignal(false)
  let syncPrReadiness: (existing?: { title: string; url: string }, retry?: boolean) => Promise<void> = async () => {}
  // 容器宽度首次估算用 viewport（sidebar/review 没考虑，仅避免 mount 第一帧 isWideContainer=false 闪一下）；
  // ResizeObserver 一旦挂上去会立即用 session-panel 真实 inline-size 校正。
  const [isWideContainer, setIsWideContainer] = createSignal(
    typeof window !== "undefined" && window.innerWidth >= PANEL_WIDE_THRESHOLD_PX,
  )
  // 模式切换时重置 narrowOpen（窄屏的瞬时状态不该残留到宽屏）。宽屏切换由 wideIntent 直接接管，无需额外处理。
  createEffect(() => {
    isWideContainer()
    setNarrowOpen(false)
  })
  const overlayOpen = createMemo(() => (isWideContainer() ? wideIntent() : narrowOpen()))
  const closeOverlay = () => {
    if (isWideContainer()) {
      setWideIntent(false)
      try {
        window.localStorage.setItem(OVERLAY_OPEN_KEY, "0")
      } catch {
        // ignore (private mode / quota)
      }
    } else {
      setNarrowOpen(false)
    }
  }
  const openOverlay = () => {
    if (isWideContainer()) {
      setWideIntent(true)
      try {
        window.localStorage.setItem(OVERLAY_OPEN_KEY, "1")
      } catch {
        // ignore (private mode / quota)
      }
      scheduleSyncPrReadiness()
    } else {
      setNarrowOpen(true)
      scheduleSyncPrReadiness()
    }
  }
  const [outputFileFlow, setOutputFileFlow] = createSignal(false)
  const sessionFileTabs = createMemo(() =>
    tabs()
      .all()
      .filter((tab) => file.pathFromTab(tab)),
  )
  createEffect(
    on(
      () => [outputFileFlow(), sessionFileTabs().length] as const,
      ([flow, count]) => {
        if (!flow) return
        if (count > 0) return
        collapseReviewPanel()
        openOverlay()
        setOutputFileFlow(false)
      },
    ),
  )
  const toggleOverlay = () => {
    if (isWideContainer()) {
      const next = !wideIntent()
      setWideIntent(next)
      try {
        window.localStorage.setItem(OVERLAY_OPEN_KEY, next ? "1" : "0")
      } catch {
        // ignore (private mode / quota)
      }
      if (next) scheduleSyncPrReadiness()
    } else {
      setNarrowOpen((v) => {
        const next = !v
        if (next) scheduleSyncPrReadiness()
        return next
      })
    }
  }
  let overlayEl: HTMLDivElement | undefined
  let toggleBtnEl: HTMLButtonElement | undefined
  createEffect(() => {
    if (!desktopReviewOpen()) return
    if (!overlayOpen()) return
    const handler = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (overlayEl?.contains(target)) return
      if (!sessionRouteActive()) return
      if (toggleBtnEl?.contains(target)) return
      if (target instanceof Element) {
        if (target.closest('[data-component="dropdown-menu-content"]')) return
        if (target.closest('[data-component="dialog"]')) return
        if (target.closest(".codex-chat-menu")) return
      }
      closeOverlay()
    }
    document.addEventListener("pointerdown", handler)
    onCleanup(() => document.removeEventListener("pointerdown", handler))
  })
  const cardVisible = createMemo(() => branchCardShown() && overlayOpen())
  // centered 控制消息列「内容宽度」（max-w-200），不参与「整列左右位移」。
  // 浮层打开时整列由 CSS transform 平移，对话本体宽度保持不变 —— 因此这里不再依赖 cardVisible()。
  const centered = createMemo(() => isDesktop() && !desktopReviewOpen())

  // renderMode 是「视觉模式」，跟 isWideContainer 大多数时候同步；
  // 但当「宽+开 → 窄」自动收起时，先保持 wide 跑完 280ms slide-out 动画，再切到 narrow——
  // 否则 data-mode 跳变会让 top/right 这两个非过渡属性瞬间从 wide 位置（top-24 right-6）跳到 narrow 位置（top-12 right-11），
  // 视觉上出现「先位移再消失」的两段感。
  const PANEL_WIDE_CLOSE_MS = 280
  const [renderMode, setRenderMode] = createSignal<"wide" | "narrow">(isWideContainer() ? "wide" : "narrow")
  let modeSwitchTimer: number | undefined
  let prevIsWide = isWideContainer()
  let prevWideIntent = wideIntent()
  createEffect(() => {
    const wide = isWideContainer()
    const intent = wideIntent()
    if (modeSwitchTimer !== undefined) {
      window.clearTimeout(modeSwitchTimer)
      modeSwitchTimer = undefined
    }
    if (wide) {
      // → 宽：直接切，让 panel 用 wide 样式 slide-in
      setRenderMode("wide")
    } else if (prevIsWide && prevWideIntent) {
      // 宽+开 → 窄：延后切，让 wide-close 动画在原位跑完
      modeSwitchTimer = window.setTimeout(() => {
        setRenderMode("narrow")
        modeSwitchTimer = undefined
      }, PANEL_WIDE_CLOSE_MS + 20) // +20ms 安全余量，确保 transitionend 已触发
    } else {
      // 宽+关 → 窄 / 窄→窄：panel 不可见，无视觉副作用，直接切
      setRenderMode("narrow")
    }
    prevIsWide = wide
    prevWideIntent = intent
  })
  // 延迟期间用户手动打开窄屏 panel：取消延迟、立即切 narrow，否则 panel 会用 wide 样式渲染（位置错乱）
  createEffect(() => {
    if (!isWideContainer() && narrowOpen() && modeSwitchTimer !== undefined) {
      window.clearTimeout(modeSwitchTimer)
      modeSwitchTimer = undefined
      setRenderMode("narrow")
    }
  })
  onCleanup(() => {
    if (modeSwitchTimer !== undefined) window.clearTimeout(modeSwitchTimer)
  })

  // 浮层 + 切换按钮的 DOM 引用，click-outside 关闭仅在窄模式下生效（宽模式按要求只受按钮控制）。
  createEffect(() => {
    if (isWideContainer()) return
    if (!narrowOpen()) return
    const handler = (event: PointerEvent) => {
      const target = event.target as Node | null
      if (!target) return
      if (!sessionRouteActive()) return
      if (overlayEl?.contains(target)) return
      if (toggleBtnEl?.contains(target)) return
      // 排除 dropdown menu（codex-chat-menu）内部点击，避免点击「项目操作/选择环境」下拉菜单时误关浮层
      const menuEl = (target as Element).closest(".codex-chat-menu")
      if (menuEl) return
      setNarrowOpen(false)
    }
    document.addEventListener("pointerdown", handler)
    onCleanup(() => document.removeEventListener("pointerdown", handler))
  })

  function normalizeTab(tab: string) {
    if (!tab.startsWith("file://")) return tab
    return file.tab(tab)
  }

  function normalizeTabs(list: string[]) {
    const seen = new Set<string>()
    const next: string[] = []
    for (const item of list) {
      const value = normalizeTab(item)
      if (seen.has(value)) continue
      seen.add(value)
      next.push(value)
    }
    return next
  }

  const openReviewFromTurn = (mode: ChangeMode = "turn") => {
    const next = gitReviewBlocked() ? "turn" : gitFeaturesEnabled() ? mode : vcsGitStatusKnown() ? "turn" : mode
    setChangesAutoSet(false)
    setStore("changes", next)
    if (next === "turn") {
      const files = filterDiffRowsWithMaterialChange(turnDiffs()).map((diff) => diff.file)
      view().review.setOpen(files)
    }
    if (isDesktop()) {
      openReviewPanel({ manual: true })
      tabs().setActive("review")
      return
    }
    if (!reviewLayoutControlsVisible()) return
    setStore("mobileTab", "changes")
  }

  const info = createMemo(() => (params.id ? sync.session.get(params.id) : undefined))
  const isChildSession = createMemo(() => !!info()?.parentID)
  const diffs = createMemo(() => (params.id ? list(sync.data.session_diff[params.id]) : []))
  const canReview = createMemo(() => !!sync.project)
  const reviewTab = createMemo(() => isDesktop())
  const tabState = createSessionTabs({
    tabs,
    pathFromTab: file.pathFromTab,
    normalizeTab,
    review: reviewTab,
    hasReview: canReview,
  })
  const activeTab = tabState.activeTab
  const activeFileTab = tabState.activeFileTab
  const revertMessageID = createMemo(() => info()?.revert?.messageID)
  const handleArchivedSession = () => {
    openSettingsOverlay("archivedSessions")
    showToast({
      title: language.t("settings.archivedSessions.title"),
      description: language.t("session.archived.notAvailable"),
    })
  }
  const [sessionAccess, { mutate: mutateSessionAccess }] = createResource(
    () => (params.id ? ([params.id, sdk.directory, params.dir] as const) : undefined),
    async ([id, directory, dirParam]) => {
      const routeDirectory = decode64(dirParam)
      const projectDirectories = layout.projects
        .list()
        .flatMap((project) => [project.worktree, ...(project.sandboxes ?? [])])
      const lookup = () =>
        getSessionAcrossDirectories(globalSDK.client, globalSync, id, directory, {
          extraDirectories: [routeDirectory, ...projectDirectories].filter((dir): dir is string => !!dir),
        })
      // 迟到响应护栏：绑定完整 resource source（同一 session id 也可能随目录切换）
      const stale = () => params.id !== id || sdk.directory !== directory || params.dir !== dirParam
      // 不可访问终态（cached/非 cached、missing/archived 共用）：仅 mutate(false) 会让
      // 页面停在「加载消息」且同路由不再触发 resource 重跑。统一清理可寻的 stale 缓存、
      // 用发起时捕获的 dirParam 收敛到该目录新建页；archived 额外保留归档浮层入口
      const finalizeInaccessible = (input: {
        session?: Pick<Session, "id" | "directory" | "projectID">
        archived: boolean
      }) => {
        mutateSessionAccess(false)
        // 服务端已确认不可访问：终态清理（含分页总数/派生缓存/SSE 去重墓碑），非可回滚的乐观移除
        if (input.session) purgeSessionFromSidebar(globalSync, input.session)
        navigate(`/${dirParam}/session`, { replace: true })
        if (input.archived) handleArchivedSession()
      }
      // 侧边栏点开的会话必然已在本地 store（且未归档）：乐观放行免掉串行网络往返；
      // 服务端仍是真值，后台用缓存会话所属目录做单点严格核验（不回退本地缓存），
      // 兜住 SSE 丢失/断线期间被其它客户端归档或删除的场景
      const cached = findSessionInStores(globalSync, id, directory)
      if (cached) {
        void (async () => {
          try {
            const response = await globalSDK.client.session.get({
              sessionID: id,
              directory: cached.directory ?? directory,
            })
            if (stale()) return
            const session = response.data
            if (session && session.time.archived === undefined) return
            finalizeInaccessible({ session: session ?? cached, archived: !!session })
          } catch (error) {
            if (stale()) return
            // 仅 404（远端已删除）进入 missing 终态；网络错误保持乐观放行
            if (isSessionNotFoundError(error)) finalizeInaccessible({ session: cached, archived: false })
          }
        })()
        return true
      }
      const result = await lookup()
      if (stale()) return false
      if (!result.ok) {
        if (result.reason === "unavailable") {
          showToast({
            variant: "error",
            title: language.t("common.requestFailed"),
            description: language.t("session.archived.lookupFailed"),
          })
          throw new Error("session lookup unavailable")
        }
        finalizeInaccessible({ archived: false })
        return false
      }
      if (result.session.time.archived === undefined) return true
      finalizeInaccessible({ session: result.session, archived: true })
      return false
    },
  )
  const sessionAccessBlocked = createMemo(() => {
    const id = params.id
    if (!id) return false
    if (sessionAccess.loading) return true
    if (sessionAccess.error) return true
    return sessionAccess() === false
  })
  const messages = createMemo(() => {
    const id = params.id
    if (!id || sessionAccessBlocked()) return []
    // 全局同步层已经保留服务端 first-seen 顺序；页面直接沿用该数组，steer 才会稳定出现在提交瞬间的真实位置。
    return orderTimelineMessages(sync.data.message[id] ?? [])
  })
  const messagesReady = createMemo(() => {
    const id = params.id
    if (!id) return true
    if (sessionAccessBlocked()) return false
    return sync.data.message[id] !== undefined
  })
  const historyMore = createMemo(() => {
    const id = params.id
    if (!id) return false
    return sync.session.history.more(id)
  })
  const historyLoading = createMemo(() => {
    const id = params.id
    if (!id) return false
    return sync.session.history.loading(id)
  })
  const userTurnView = createMemo(
    () =>
      dedupeUserTurnsWithAliases(
        messages().filter((m) => m.role === "user") as UserMessage[],
        sync.data.part,
        messages(),
        {
          statusBusy: params.id
            ? (sync.data.session_status[params.id] ?? { type: "idle" as const }).type !== "idle"
            : false,
        },
      ),
    undefined,
    {
      // 流式正文只改变 part 内容时沿用原时间线对象；新增消息、引导或成员顺序变化仍会立即发布新视图。
      equals: sameUserTurnView,
    },
  )
  const userMessages = createMemo(() => userTurnView().messages, emptyUserMessages, { equals: same })
  const timelineMessages = createMemo(() => {
    const aliases = userTurnView().parentAliases
    if (Object.keys(aliases).length === 0) return messages()
    return messages().map((message) => {
      if (message.role !== "assistant") return message
      const parentID = message.parentID ? aliases[message.parentID] : undefined
      if (!parentID) return message
      return { ...message, parentID }
    })
  })
  const timelineParts = createMemo(() =>
    displayUserPartsByMessage(messages().filter((m) => m.role === "user") as UserMessage[], sync.data.part, messages()),
  )
  const visibleUserMessages = createMemo(
    () => {
      const revert = revertMessageID()
      if (!revert) return userMessages()
      const cutoff = userMessages().findIndex((message) => message.id === revert)
      // revert 水位来自消息顺序而不是 ID 字典序；远程或自定义 ID 也必须与逻辑时间线裁剪结果一致。
      if (cutoff >= 0) return userMessages().slice(0, cutoff)
      return userMessages().filter((message) => message.id < revert)
    },
    emptyUserMessages,
    {
      equals: same,
    },
  )
  const visibleTimelineTurns = createMemo(() =>
    clipTimelineTurns(
      userTurnView().turns,
      revertMessageID(),
      messages().map((message) => message.id),
    ),
  )
  const visibleTimelineTurnIDByMessageID = createMemo(() => {
    // 裁剪后的索引只暴露仍在当前 revert 水位内的成员，活动态和深链都不能重新指向已隐藏内容。
    const result: Record<string, string> = {}
    visibleTimelineTurns().forEach((turn) =>
      turn.members.forEach((member) => {
        result[member.messageID] = turn.id
      }),
    )
    return result
  })
  const visibleTimelineAnchorByMessageID = createMemo(() => {
    // turn 内 steer 的 hash 先定位稳定一级行，再由 SessionTurn 内部的真实消息锚点完成精确滚动。
    const result: Record<string, string> = {}
    visibleTimelineTurns().forEach((turn) => {
      const anchorID = turn.rootMessageID ?? turn.userMessageIDs[0]
      if (!anchorID) return
      turn.members.forEach((member) => {
        result[member.messageID] = anchorID
      })
    })
    return result
  })
  const visibleTimelineUserMessages = createMemo(
    // 主时间线、Minimap 和命令面板必须消费同一份逻辑 turn 锚点，steer 不能在其他入口重新拆成一级行。
    () => timelineTurnUserMessages(visibleTimelineTurns(), messages()),
    emptyUserMessages,
    { equals: same },
  )
  const lastUserMessage = createMemo(() => visibleUserMessages().at(-1))

  createEffect(() => {
    const tab = activeFileTab()
    if (!tab) return

    const path = file.pathFromTab(tab)
    if (path) void file.load(path)
  })

  createEffect(
    on(
      () => lastUserMessage()?.id,
      () => {
        const msg = lastUserMessage()
        if (!msg) return
        syncSessionModel(local, msg)
      },
    ),
  )

  createEffect(
    on(
      () => ({ dir: params.dir, id: params.id }),
      (next, prev) => {
        if (!prev) return
        if (next.dir === prev.dir && next.id === prev.id) return
        composer.setPendingGoalObjective(undefined)
        if (prev.id && !next.id) local.session.reset()
      },
      { defer: true },
    ),
  )

  // goal hydration：store 只靠 SSE 事件维护，刷新/重启后 paused 等不再发事件的 goal 会失联——
  // 进会话时主动拉一次并整体同步（服务端无 goal 也同步成 undefined，纠正本地 stale）
  createEffect(
    on(
      () => params.id,
      (id) => {
        if (!id) return
        // 比较-并设防陈旧覆盖：记下发起时的 store 值，响应回来时若它已被乐观 set/clear 或 SSE 改动，则放弃——
        // 否则慢响应（发起时还没目标，解析为 null）会把用户期间刚设的目标覆盖掉
        const before = globalSync.data.session_goal[id]
        void sdk.client.session
          .getGoal({ sessionID: id })
          .then((res) => {
            if (globalSync.data.session_goal[id] !== before) return
            globalSync.goal.set(id, res.data ?? undefined)
          })
          .catch(() => {})
      },
    ),
  )

  const [store, setStore] = createStore({
    messageId: undefined as string | undefined,
    mobileTab: "session" as "session" | "changes",
    changes: "turn" as ChangeMode,
    newSessionWorktree: "main",
    deferRender: false,
    headerActionMenu: {
      open: false,
      action: undefined as HeaderAction | undefined,
      position: { x: 0, y: 0 },
    },
    followupDragging: undefined as string | undefined,
    followupAwaiting: {} as Record<string, FollowupAwaiting | undefined>,
    followupSentMessageIDs: {} as Record<string, string[] | undefined>,
    followupSuggestionSuppressed: {} as Record<string, boolean | undefined>,
    // 停止请求完成后只自动接续这些未 ACK 引导，普通排队消息仍保持暂停。
    followupAbortResumeIDs: {} as Record<string, string[] | undefined>,
    staleRunClearing: {} as Record<string, boolean | undefined>,
    abortingSessions: {} as Record<string, boolean | undefined>,
  })
  const [changesAutoSet, setChangesAutoSet] = createSignal(true)
  const staleRunClearTasks = new Map<string, Promise<boolean>>()
  const [runStateNow, setRunStateNow] = createSignal(Date.now())

  const [headerActionState, setHeaderActionState] = createStore({
    running: undefined as string | undefined,
  })

  const projectWorktree = createMemo(() => sync.project?.worktree ?? sdk.directory)

  const projectDirectoryName = createMemo(() => {
    const worktree = projectWorktree()
    const parts = worktree.split(/[\\/]/)
    return parts[parts.length - 1] ?? worktree
  })

  // 环境相关状态
  const [environments, setEnvironments] = createSignal<{ name: string; filename: string }[]>([])
  // 常驻树下 directory 是运行期信号，persisted 按目录重键，避免绑死首个目录
  const currentEnvScoped = scopedInstance(
    () => sdk.directory,
    (dir) =>
      persisted(Persist.workspace(dir, "currentEnvironment"), createStore({ value: undefined as string | undefined })),
  )
  const currentEnvironment = () => currentEnvScoped()[0].value
  const setCurrentEnvironment = (v: string | undefined) => currentEnvScoped()[1]("value", v)
  const currentEnvReady = () => currentEnvScoped()[3]
  const [headerActionItems, setHeaderActionItems] = createSignal<HeaderAction[]>([])

  const projectName = createMemo(() => {
    const currentEnvironmentFile = currentEnvironment()
    const currentEnvironmentName = environments().find((item) => item.filename === currentEnvironmentFile)?.name
    if (currentEnvironmentName) return currentEnvironmentName
    const worktree = sync.project?.worktree ?? sdk.directory
    const parts = worktree.split(/[\\/]/)
    return parts[parts.length - 1] ?? worktree
  })

  const activeHeaderAction = createMemo(() => headerActionItems()[0])
  const headerActionLabel = createMemo(() => activeHeaderAction()?.name ?? "运行")

  // 请求版本护栏：目录切换后，上一目录迟到的读取结果不得覆盖新目录已就绪的状态
  // （runHeaderAction 会用当前目录当 cwd 执行这些命令，串目录是安全问题）
  let envEpoch = 0
  let headerActionsEpoch = 0
  const loadEnvironments = async () => {
    if (!platform.listEnvironments) return
    const epoch = ++envEpoch
    const worktree = projectWorktree()
    // 双维度校验：sdk.directory 变化（含同项目 worktree↔sandbox 切换，环境按它持久化/执行）
    // 或 projectWorktree 变化（gate:false 下 sandbox 直达时先回退 sandbox、bootstrap 后
    // 才解析出主 worktree，环境文件按 worktree 分区）都要作废在途读取
    const directory = sdk.directory
    const live = () => epoch === envEpoch && sdk.directory === directory && projectWorktree() === worktree
    const files = await platform.listEnvironments(worktree)
    if (!live()) return
    const sorted = [...files].sort((a, b) => {
      if (a === "environment.toml") return -1
      if (b === "environment.toml") return 1
      return 0
    })
    const environments = await Promise.all(
      sorted.map(async (filename) => {
        if (!platform.readEnvironment) return { name: projectDirectoryName(), filename }
        const content = await platform.readEnvironment(worktree, filename)
        if (!content) return { name: projectDirectoryName(), filename }
        const TOML = await import("smol-toml")
        const parsed = TOML.parse(content) as { environmentName?: string; name?: string }
        return {
          name: parsed.environmentName?.trim() || parsed.name?.trim() || projectDirectoryName(),
          filename,
        }
      }),
    )
    if (!live()) return
    setEnvironments(environments)
    await loadHeaderActionsFromEnv()
  }

  const loadHeaderActionsFromEnv = async () => {
    if (!platform.readEnvironment) return
    const epoch = ++headerActionsEpoch
    const worktree = projectWorktree()
    const directory = sdk.directory
    const live = () => epoch === headerActionsEpoch && sdk.directory === directory && projectWorktree() === worktree
    const envFile = currentEnvironment() ?? (environments().length > 0 ? environments()[0].filename : undefined)
    if (!envFile) {
      setHeaderActionItems([])
      return
    }
    try {
      const content = await platform.readEnvironment(worktree, envFile)
      if (!live()) return
      if (!content) {
        setHeaderActionItems([])
        return
      }
      const TOML = await import("smol-toml")
      if (!live()) return
      const parsed = TOML.parse(content) as {
        operations?: Array<{ name?: string; command?: string; icon?: string }>
      }
      if (parsed.operations && parsed.operations.length > 0) {
        const ops: HeaderAction[] = parsed.operations
          .filter((op) => op.name || op.command)
          .map((op, i) => ({
            id: `env-op-${i}`,
            name: op.name ?? "",
            command: op.command ?? "",
            icon: isIconName(op.icon) ? op.icon : undefined,
          }))
        setHeaderActionItems(ops)
      } else {
        setHeaderActionItems([])
      }
    } catch {
      if (live()) setHeaderActionItems([])
    }
  }

  const writeHeaderActionsToEnv = async (actions: HeaderAction[]) => {
    if (!platform.writeEnvironment) return
    const worktree = projectWorktree()
    const envFile = currentEnvironment() ?? (environments().length > 0 ? environments()[0].filename : undefined)
    if (!envFile) return
    if (platform.ensureEnvironmentsDir) {
      await platform.ensureEnvironmentsDir()
    }
    let existingEnvironmentName: string | undefined
    let existingSetup: string | { default?: string; macos?: string; linux?: string; windows?: string } | undefined
    let existingCleanup: string | { default?: string; macos?: string; linux?: string; windows?: string } | undefined
    let existingOperations:
      | Array<{ name?: string; command?: string; icon?: string; platform_specific?: boolean; platforms?: string[] }>
      | undefined
    if (platform.readEnvironment) {
      try {
        const content = await platform.readEnvironment(worktree, envFile)
        if (content) {
          const TOML = await import("smol-toml")
          const parsed = TOML.parse(content) as {
            environmentName?: string
            name?: string
            setup?: string | { default?: string; macos?: string; linux?: string; windows?: string }
            cleanup?: string | { default?: string; macos?: string; linux?: string; windows?: string }
            operations?: Array<{
              name?: string
              command?: string
              icon?: string
              platform_specific?: boolean
              platforms?: string[]
            }>
          }
          existingEnvironmentName = parsed.environmentName ?? parsed.name
          existingSetup = parsed.setup
          existingCleanup = parsed.cleanup
          existingOperations = parsed.operations
        }
      } catch {}
    }
    const existingByKey = new Map(existingOperations?.map((operation) => [headerActionKey(operation), operation]) ?? [])
    const nextOperations = actions.map((action) => {
      const existing = existingByKey.get(headerActionKey(action))
      return {
        name: action.name,
        command: action.command,
        icon: action.icon,
        platformSpecific: existing?.platform_specific ?? false,
        platforms: existing?.platforms,
      }
    })
    const tomlContent = generateTomlContent(existingEnvironmentName, existingSetup, existingCleanup, nextOperations)
    await platform.writeEnvironment(worktree, envFile, tomlContent)
  }

  const handleEnvironmentChange = async (filename: string | null) => {
    setCurrentEnvironment(filename ?? undefined)
    await loadHeaderActionsFromEnv()
  }

  const handleEnvironmentSettings = async () => {
    let scratch: string | undefined
    if (platform.ensureScratchChatDir) {
      try {
        scratch = await platform.ensureScratchChatDir()
      } catch {
        // ignore
      }
    }
    void import("@/components/dialog-settings").then((s) => {
      dialog.show(() => <s.DialogSettings tab="environment" scratchChatDir={() => scratch} />)
    })
  }

  type FollowupState = {
    items: Record<string, FollowupItem[] | undefined>
    failed: Record<string, string | undefined>
    paused: Record<string, boolean | undefined>
    edit: Record<string, FollowupEdit | undefined>
    // 手动引导锁必须跟工作区一起持久化，刷新页面后才能继续等待同一条 messageID。
    // followup.v1 旧数据可能仍是单对象；读取时统一归一成数组，连续 steer 串行提交后可分别等待同一回合完成。
    manualSteerPending: Record<string, ManualSteerPending | ManualSteerPending[] | undefined>
  }
  // 按目录重键 + Proxy 透传，让 followup 队列随常驻树的 directory 切换而切换
  const followupScoped = scopedInstance(
    () => sdk.directory,
    (dir) =>
      persisted(
        Persist.workspace(dir, "followup", ["followup.v1"]),
        createStore<FollowupState>({ items: {}, failed: {}, paused: {}, edit: {}, manualSteerPending: {} }),
      ),
  )
  // 迟到的权限/网络任务必须回到发起目录自己的持久化实例，不能跟随当前页面切换 scope。
  const followupForDirectory = (directory: string) => followupScoped.forScope(directory)
  const followup = new Proxy({} as FollowupState, {
    get: (_, key) => (followupScoped()[0] as Record<PropertyKey, unknown>)[key],
  }) as FollowupState
  const setFollowup = ((...args: unknown[]) =>
    (followupScoped()[1] as (...a: unknown[]) => void)(...args)) as SetStoreFunction<FollowupState>
  // 异步持久化尚未 hydration 时先锁住 composer，避免刷新瞬间把普通输入发到未完成的引导前面。
  const followupReady = () => followupScoped()[3]()

  // 目录切换的「安定」信号：切换后两帧内详情浮层禁用过渡动画（常驻树下随 directory 重置）
  const [shellSettled, setShellSettled] = createSignal(false)
  createEffect(
    on(
      () => sdk.directory,
      () => {
        setShellSettled(false)
        requestAnimationFrame(() => requestAnimationFrame(() => setShellSettled(true)))
      },
    ),
  )

  createComputed((prev) => {
    const key = sessionKey()
    if (key !== prev) {
      if (!params.id) {
        // 新建会话没有历史消息要渲染，无需让帧等待，立即展示
        setStore("deferRender", false)
      } else {
        setStore("deferRender", true)
        requestAnimationFrame(() => {
          setTimeout(() => setStore("deferRender", false), 0)
        })
      }
    }
    return key
  }, sessionKey())

  let reviewFrame: number | undefined
  let refreshFrame: number | undefined
  let refreshTimer: number | undefined
  let todoFrame: number | undefined
  let todoTimer: number | undefined
  let diffFrame: number | undefined
  let diffTimer: number | undefined

  createComputed((prev) => {
    const open = desktopReviewOpen()
    if (prev === undefined || prev === open) return open

    if (reviewFrame !== undefined) cancelAnimationFrame(reviewFrame)
    setUi("reviewSnap", true)
    reviewFrame = requestAnimationFrame(() => {
      reviewFrame = undefined
      setUi("reviewSnap", false)
    })
    if (open && !ui.reviewExpanded) applyReviewPanelLayout(mainRowWidth())
    return open
  }, desktopReviewOpen())

  const turnDiffs = createMemo(() => list(lastUserMessage()?.summary?.diffs))

  const turnAssistantMessages = createMemo(() => {
    const user = lastUserMessage()
    if (!user || !params.id) return []
    const msgs = sync.data.message[params.id] ?? []
    const linked = msgs.filter((message) => message.role === "assistant" && message.parentID === user.id)
    if (linked.length > 0) return linked

    const userIdx = msgs.findIndex((message) => message.id === user.id)
    if (userIdx < 0) return []
    const after: typeof msgs = []
    for (let i = userIdx + 1; i < msgs.length; i++) {
      const message = msgs[i]
      if (message.role === "user") break
      if (message.role === "assistant") after.push(message)
    }
    return after
  })
  const changesOptions = createMemo<ChangeMode[]>(() => reviewChangeModeOptions(sync.data.vcs))
  const mobileChanges = createMemo(() => !isDesktop() && reviewLayoutControlsVisible() && store.mobileTab === "changes")
  const wantsReview = createMemo(() =>
    isDesktop()
      ? desktopFileTreeOpen() || (desktopReviewOpen() && activeTab() === "review")
      : store.mobileTab === "changes",
  )

  const turnDiffQuery = createQuery(() => {
    const user = lastUserMessage()
    return {
      queryKey: ["session-turn-diff", params.id, user?.id] as const,
      enabled: !!params.id && !!user?.id && wantsReview() && store.changes === "turn",
      staleTime: 0,
      gcTime: 60_000,
      queryFn: () =>
        sdk.client.session
          .diff({ sessionID: params.id!, messageID: user!.id })
          .then((result) => list(result.data))
          .catch(() => []),
    }
  })

  const vcsMode = createMemo<VcsMode | undefined>(() => {
    if (store.changes === "unstaged" || store.changes === "staged" || store.changes === "branch") return store.changes
  })
  const vcsKey = createMemo(
    () =>
      [
        "session-vcs",
        "v3-ignore-ws",
        sdk.directory,
        sync.data.vcs?.branch ?? "",
        sync.data.vcs?.default_branch ?? "",
        layout.review.diffIgnoreWhitespace(),
      ] as const,
  )
  const vcsQuery = createQuery(() => {
    const mode = vcsMode()
    const enabled = vcsGitEnabled() && !!mode

    return {
      queryKey: [...vcsKey(), mode] as const,
      enabled,
      staleTime: 0,
      gcTime: 60 * 1000,
      refetchOnWindowFocus: true,
      queryFn: mode
        ? () =>
            sdk.client.vcs
              .diff({
                mode,
                ignoreWhitespace: layout.review.diffIgnoreWhitespace() ? "true" : "false",
              })
              .then((result) => list(result.data))
              .catch((error) => {
                console.debug("[session-review] failed to load vcs diff", { mode, error })
                return []
              })
        : skipToken,
    }
  })
  const vcsGitOverlayQuery = createQuery(() => ({
    queryKey: [...vcsKey(), "overlay", "unstaged"] as const,
    enabled: !!params.id && vcsGitEnabled() && store.changes === "turn",
    staleTime: 0,
    gcTime: 60 * 1000,
    queryFn: () =>
      sdk.client.vcs
        .diff({ mode: "unstaged", ignoreWhitespace: layout.review.diffIgnoreWhitespace() ? "true" : "false" })
        .then((result) => list(result.data))
        .catch((error) => {
          console.debug("[session-review] failed to load git overlay diff", { error })
          return []
        }),
  }))
  const prReadinessKey = () => [...vcsKey(), "pr-readiness"] as const
  const PR_READINESS_STALE_MS = 30_000
  const PR_READINESS_POLL_MS = 60_000
  const fetchPrReadiness = () =>
    sdk.client.vcs
      .pullRequestReadiness()
      .then((res) => res.data)
      .catch(() => undefined)
  const refreshPrReadiness = () =>
    queryClient.fetchQuery({
      queryKey: prReadinessKey(),
      queryFn: fetchPrReadiness,
      staleTime: 0,
    })
  let scheduleSyncPrReadiness: (opts?: {
    existing?: { title: string; url: string }
    retry?: boolean
  }) => void = () => {}
  let prReadinessTimer: ReturnType<typeof setTimeout> | undefined
  scheduleSyncPrReadiness = (opts) => {
    if (prReadinessTimer) clearTimeout(prReadinessTimer)
    prReadinessTimer = setTimeout(() => {
      prReadinessTimer = undefined
      void syncPrReadiness(opts?.existing, opts?.retry)
    }, 120)
  }
  syncPrReadiness = async (existing, retry = false) => {
    if (!gitFeaturesEnabled()) return
    if (existing?.url) {
      queryClient.setQueryData(prReadinessKey(), (old) => ({
        ...(old ?? {
          git_repo: true,
          gh_cli: false,
          gh_authenticated: false,
          remote: false,
          has_commits: false,
          worktree_changes: false,
          staged_changes: false,
          unpushed_commits: false,
          branch_on_remote: false,
        }),
        existing_pull_request: existing,
      }))
    }
    await queryClient.invalidateQueries({ queryKey: prReadinessKey() })
    await refreshPrReadiness()
    if (!retry) return
    await new Promise((resolve) => setTimeout(resolve, 500))
    await refreshPrReadiness()
  }
  const refreshVcs = () => {
    void queryClient.invalidateQueries({ queryKey: vcsKey(), refetchType: "none" })
    void queryClient.refetchQueries({ queryKey: vcsKey(), type: "active" })
    if (cardVisible()) scheduleSyncPrReadiness()
  }
  const sessionTurnDiffOverlay = createMemo(() => {
    if (!params.id || !vcsGitEnabled()) {
      return []
    }
    if (store.changes !== "turn") return []
    return filterDiffRowsWithMaterialChange(vcsGitOverlayQuery.data ?? [])
  })

  const turnReviewDiffs = createMemo(() => {
    const summary = filterDiffRowsWithMaterialChange(turnDiffs())
    const remote = filterDiffRowsWithMaterialChange(list(turnDiffQuery.data))
    const toolParts = turnAssistantMessages().flatMap((message) => sync.data.part[message.id] ?? [])
    const tools = filterDiffRowsWithMaterialChange(toolDiffsFromParts(toolParts))
    const stored = filterDiffRowsWithMaterialChange(diffs())
    const base: MergeableDiff[] =
      // compact 历史摘要可能只含文件计数；审核入口的远端 session.diff 才是完整正文。
      remote.length > 0 ? remote : summary.length > 0 ? summary : tools.length > 0 ? tools : stored
    const overlay =
      vcsGitEnabled() && store.changes === "turn" ? filterDiffRowsWithMaterialChange(vcsGitOverlayQuery.data ?? []) : []
    return mergeDiffsWithOverlay(base, overlay, { workspaceRoot: sdk.directory })
  })

  const cardDiffsActive = createMemo(() => gitFeaturesEnabled() && (cardVisible() || desktopReviewOpen()))
  const branchDiffQuery = createQuery(() => ({
    queryKey: [...vcsKey(), "branch"] as const,
    enabled: (gitFeaturesEnabled() && cardVisible()) || (vcsGitEnabled() && store.changes === "branch"),
    staleTime: 0,
    gcTime: 60 * 1000,
    refetchOnWindowFocus: true,
    queryFn: () =>
      sdk.client.vcs
        .diff({
          mode: "branch",
          ignoreWhitespace: layout.review.diffIgnoreWhitespace() ? "true" : "false",
        })
        .then((result) => list(result.data))
        .catch((error) => {
          console.debug("[session-review] failed to load branch diff", { error })
          return []
        }),
  }))
  const cardUnstagedQuery = createQuery(() => ({
    queryKey: [...vcsKey(), "card-unstaged"] as const,
    enabled: cardDiffsActive(),
    staleTime: 10_000,
    refetchInterval: gitFeaturesEnabled() && cardVisible() ? 10_000 : false,
    queryFn: () =>
      sdk.client.vcs
        .diff({ mode: "unstaged" })
        .then((res) => res.data ?? [])
        .catch(() => []),
  }))
  const cardStagedQuery = createQuery(() => ({
    queryKey: [...vcsKey(), "card-staged"] as const,
    enabled: cardDiffsActive(),
    staleTime: 10_000,
    refetchInterval: gitFeaturesEnabled() && cardVisible() ? 10_000 : false,
    queryFn: () =>
      sdk.client.vcs
        .diff({ mode: "staged" })
        .then((res) => res.data ?? [])
        .catch(() => []),
  }))
  const cardPrReadinessQuery = createQuery(() => ({
    queryKey: prReadinessKey(),
    enabled: gitFeaturesEnabled(),
    staleTime: PR_READINESS_STALE_MS,
    gcTime: 5 * 60 * 1000,
    refetchInterval: overlayOpen() ? PR_READINESS_POLL_MS : false,
    refetchOnWindowFocus: gitFeaturesEnabled(),
    queryFn: fetchPrReadiness,
  }))
  const openPullRequestInBrowser = (url: string) => openHttpUrl(url, platform.openLink)
  const pastePromptText = (text: string) => {
    if (!prompt.ready()) {
      showToast({ title: language.t("branch.details.card.pastePromptUnavailable") })
      return
    }
    const images = prompt.current().filter((part) => part.type === "image")
    prompt.set([{ type: "text", content: text, start: 0, end: text.length }, ...images], text.length)
    requestAnimationFrame(() => {
      document.querySelector<HTMLElement>('[data-component="prompt-input"]')?.focus()
    })
  }
  const handleCreatePullRequest = () => {
    const existing = cardPrReadinessQuery.data?.existing_pull_request
    if (existing?.url) {
      openPullRequestInBrowser(existing.url)
      return
    }
    void import("@/components/dialog-create-pull-request").then((mod) => {
      dialog.show(() => (
        <mod.DialogCreatePullRequest
          initialSnapshot={{
            readiness: cardPrReadinessQuery.data,
            branchDiff: branchDiffQuery.data,
            unstagedDiff: cardUnstagedQuery.data,
            stagedDiff: cardStagedQuery.data,
          }}
          onCreated={(result) => {
            void (async () => {
              await syncPrReadiness(
                result.url ? { title: result.title?.trim() || result.url, url: result.url } : undefined,
                true,
              )
              refreshVcs()
              void queryClient.invalidateQueries({ queryKey: [...vcsKey(), "card-unstaged"] })
              if (!result.url) return
              showToast({
                variant: "success",
                title: language.t("branch.details.card.createPullRequest"),
                description: language.t("toast.git.createPullRequest.success"),
              })
            })()
          }}
        />
      ))
    })
  }
  createEffect(
    on(
      () => ({
        shown: gitFeaturesEnabled(),
        overlay: overlayOpen(),
        session: sessionKey(),
        dir: sdk.directory,
        branch: sync.data.vcs?.branch ?? "",
      }),
      (cur, prev) => {
        if (!cur.shown) return
        const contextChanged =
          !prev || prev.session !== cur.session || prev.dir !== cur.dir || prev.branch !== cur.branch
        const overlayOpened = !prev?.overlay && cur.overlay
        if (contextChanged || overlayOpened) scheduleSyncPrReadiness()
      },
      { defer: true },
    ),
  )
  const cardUncommittedCount = () => {
    const files = new Set<string>()
    for (const row of cardUnstagedQuery.data ?? []) {
      if (row.file) files.add(row.file)
    }
    for (const row of cardStagedQuery.data ?? []) {
      if (row.file) files.add(row.file)
    }
    return files.size
  }
  const cardOutputFiles = createMemo(() => {
    const id = params.id
    if (!id) return []
    const messages = sync.data.message[id] ?? []
    const entries: { path: string; seq: number }[] = []
    const seq = { value: 0 }
    const key = (path: string) => normalizeOutputArtifactKey(path, sdk.directory)
    const append = (path: string | undefined) => recordSessionOutputArtifact(entries, seq, path, { key })
    // diff 行是「模型写过这个文件」的结构化证据，按生成产物收录，不受可预览类型白名单限制。
    // 删除 / 内容清空的行必须显式回收旧条目：输出区跨轮累积，只过滤会留下点不开的残留。
    const applyDiffRows = <T extends Parameters<typeof isSessionReviewFileRemoved>[0]>(
      rows: readonly T[],
      bump = false,
    ) => {
      for (const diff of rows) {
        if (isSessionReviewFileRemoved(diff)) {
          removeSessionOutputArtifact(entries, diff.file, key)
          continue
        }
        recordSessionOutputArtifact(entries, seq, diff.file, { bump, generated: true, key })
      }
    }

    for (const message of messages) {
      if (message.role === "user" && message.summary?.diffs) applyDiffRows(message.summary.diffs)
      if (message.role === "assistant") {
        const parts = sync.data.part[message.id] ?? []
        applyDiffRows(toolDiffsFromParts(parts), true)
        for (const path of outputArtifactsFromParts(parts)) append(path)
        // shell / Python 产物没有工具 diff 也没有附件：改读 shell 元数据里的 files。
        // 该字段来自服务端对命令前后 cwd 的对比，是文件系统状态而非对正文的猜测。
        // unlink 与 diff 的删除行同权：都是结构化删除证据，必须显式回收旧条目，
        // 否则「第一轮 shell 生成、第二轮 shell 删除」会永久留一行点不开的残留。
        for (const change of shellOutputFileEventsFromParts(parts)) {
          if (change.event === "unlink") {
            removeSessionOutputArtifact(entries, change.path, key)
            continue
          }
          append(change.path)
        }
      }
    }

    applyDiffRows(diffs())

    return finalizeSessionOutputArtifacts(entries, key)
  })
  const cardOutputPreviewUrls = createMemo(() => {
    const id = params.id
    if (!id) return new Map<string, string>()
    const key = (path: string) => normalizeOutputArtifactKey(path, sdk.directory)
    return sessionOutputArtifactPreviewUrls(sync.data.message[id] ?? [], sync.data.part, key)
  })
  const [cardOutputExpanded, setCardOutputExpanded] = createSignal(false)
  const cardWebSourceUrls = createMemo(() => {
    const id = params.id
    if (!id) return []
    return sessionWebSourceUrls(sync.data.message[id] ?? [], sync.data.part)
  })
  const cardNeedsPush = () => {
    const readiness = cardPrReadinessQuery.data
    if (!readiness) return false
    return readiness.unpushed_commits
  }
  const cardBranchTotals = createMemo(() =>
    (branchDiffQuery.data ?? []).reduce(
      (acc, row) => ({
        additions: acc.additions + (row.additions ?? 0),
        deletions: acc.deletions + (row.deletions ?? 0),
      }),
      { additions: 0, deletions: 0 },
    ),
  )
  const reviewGitOpsMenu = createMemo<SessionReviewGitOpsMenu | undefined>(() =>
    vcsGitEnabled()
      ? {
          busy: gitOpsBusy,
          commitDisabled: () => cardUncommittedCount() === 0,
          onCommit: openCommitDialog,
          onPush: handlePush,
          onCreateBranch: openBranchCreateDialog,
        }
      : undefined,
  )
  const reviewDiffs = () => {
    if (store.changes === "unstaged" || store.changes === "staged" || store.changes === "branch") {
      if (!vcsGitEnabled()) return []
      if (!vcsQuery.isFetched) return []
      return vcsQuery.data ?? []
    }
    return filterDiffRowsWithMaterialChange(turnReviewDiffs()).map((row) => ({
      ...row,
      patch: row.patch ?? "",
    }))
  }
  const reviewCount = () => reviewDiffs().length
  const hasReview = () => reviewCount() > 0
  const reviewDiffTotals = createMemo(() =>
    reviewDiffs().reduce(
      (acc, x) => ({
        additions: acc.additions + (x.additions ?? 0),
        deletions: acc.deletions + (x.deletions ?? 0),
      }),
      { additions: 0, deletions: 0 },
    ),
  )
  const reviewReady = () => {
    if (store.changes === "unstaged" || store.changes === "staged" || store.changes === "branch") {
      if (!vcsGitStatusKnown()) return false
      if (gitReviewBlocked()) return true
      if (!vcsGitEnabled()) return true
      return !(vcsQuery.isPending && vcsQuery.isFetching)
    }
    return true
  }

  const newSessionWorktree = createMemo(() => {
    if (store.newSessionWorktree === "create") return "create"
    const project = sync.project
    if (project && sdk.directory !== project.worktree) return sdk.directory
    return "main"
  })

  const setActiveMessage = (message: UserMessage | undefined) => {
    messageMark = scrollMark
    setStore("messageId", message?.id)
  }

  const anchor = (id: string) => `message-${id}`

  const cursor = () => {
    const root = scroller
    if (!root) return store.messageId

    const box = root.getBoundingClientRect()
    const line = box.top + 100
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

    return list.filter((item) => item.top <= line).at(-1)?.id ?? list[0]?.id ?? store.messageId
  }

  function navigateMessageByOffset(offset: number) {
    // 上下条导航以物理 turn 为单位，连续 steer 不应占用额外的一次跳转。
    const msgs = visibleTimelineUserMessages()
    if (msgs.length === 0) return

    const current = store.messageId && messageMark === scrollMark ? store.messageId : cursor()
    const base = current ? msgs.findIndex((m) => m.id === current) : msgs.length
    const currentIndex = base === -1 ? msgs.length : base
    const targetIndex = currentIndex + offset
    if (targetIndex < 0 || targetIndex > msgs.length) return

    if (targetIndex === msgs.length) {
      resumeScroll()
      return
    }

    autoScroll.pause()
    scrollToMessage(msgs[targetIndex], "auto")
  }

  function upsert(next: Project, directory = sdk.directory) {
    const list = globalSync.data.project
    // 常驻树下异步续体到达时目录可能已切换：project/vcs 是 child store 的单例字段，
    // 写回与读取都必须锚定数据所属目录的 store，而不是「写入时刻」的当前目录
    const [childStore, setChild] = globalSync.child(directory, { bootstrap: false })
    setChild("project", next.id)
    const idx = list.findIndex((item) => item.id === next.id)
    const prev = idx >= 0 ? list[idx] : undefined
    const vcs = (childStore as { vcs?: VcsInfo }).vcs
    const gitKnown = vcs?.git_installed !== undefined && vcs?.local_git !== undefined
    const liveGit = vcs?.git_installed === true && vcs?.local_git === true
    const deadGit = gitKnown && (vcs?.git_installed === false || vcs?.local_git === false)
    const merged =
      liveGit && next.vcs !== "git" && prev?.vcs === "git"
        ? { ...next, vcs: "git" as const }
        : deadGit && next.vcs === "git"
          ? { ...next, vcs: undefined }
          : next
    if (idx >= 0) {
      globalSync.set(
        "project",
        list.map((item, i) => (i === idx ? merged : item)),
      )
      return
    }
    const at = list.findIndex((item) => item.id > merged.id)
    if (at >= 0) {
      globalSync.set("project", [...list.slice(0, at), merged, ...list.slice(at)])
      return
    }
    globalSync.set("project", [...list, merged])
  }

  const gitMutation = useMutation(() => ({
    mutationFn: async () => {
      const directory = sdk.directory
      const result = await sdk.client.project.initGit()
      return { result, directory }
    },
    onSuccess: ({ result, directory }) => {
      if (!result.data) return
      upsert(result.data, directory)
    },
    onError: (err) => {
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: formatServerError(err, language.t),
      })
    },
  }))

  function initGit() {
    if (gitMutation.isPending) return
    gitMutation.mutate()
  }

  let inputRef!: HTMLDivElement
  const [promptDock, setPromptDock] = createSignal<HTMLDivElement | undefined>()
  let dockHeight = 0
  let scroller: HTMLDivElement | undefined
  let content: HTMLDivElement | undefined
  let scrollMark = 0
  let messageMark = 0

  const scrollGestureWindowMs = 250

  const markScrollGesture = (target?: EventTarget | null) => {
    const root = scroller
    if (!root) return

    const el = target instanceof Element ? target : undefined
    const nested = el?.closest("[data-scrollable]")
    if (nested && nested !== root) return

    setUi("scrollGesture", Date.now())
  }

  const hasScrollGesture = () => Date.now() - ui.scrollGesture < scrollGestureWindowMs

  const throwSessionSyncDebugError = () => {
    if (consumeSessionSyncDebugError({ enabled: import.meta.env.DEV, storage: localStorage })) {
      throw new Error("debug session sync error")
    }
  }

  const [sessionSync, { refetch: refetchSessionSync }] = createResource(
    () => {
      const id = params.id
      if (!id) return undefined
      if (sessionAccess.loading) return undefined
      if (sessionAccess() === false) return undefined
      return [sdk.directory, id] as const
    },
    ([directory, id]) => {
      if (refreshFrame !== undefined) cancelAnimationFrame(refreshFrame)
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer)
      refreshFrame = undefined
      refreshTimer = undefined
      if (!id) return
      throwSessionSyncDebugError()

      const cached = untrack(() => sync.data.message[id] !== undefined)
      const stale = !cached
        ? false
        : (() => {
            const info = getSessionPrefetch(directory, id)
            if (!info) return true
            return Date.now() - info.at > SESSION_PREFETCH_TTL
          })()

      refreshFrame = requestAnimationFrame(() => {
        refreshFrame = undefined
        refreshTimer = window.setTimeout(() => {
          refreshTimer = undefined
          if (params.id !== id) return
          untrack(() => {
            if (stale) void sync.session.sync(id, { force: true }).catch(() => undefined)
          })
        }, 0)
      })

      return sync.session.sync(id)
    },
  )

  const messageSyncError = createMemo(() => {
    const id = params.id
    if (!id) return sessionSync.error
    return sessionSync.error ?? sync.session.error(id)
  })

  const messageRender = createMemo(() =>
    sessionMessageRenderState({ messagesReady: messagesReady(), syncError: messageSyncError() }),
  )

  createEffect(() => {
    const err = sessionSync.error
    const id = params.id
    if (!err || !id) return
    let cancelled = false
    void runSessionSyncAutoRetry({
      sessionID: id,
      activeSessionID: () => (cancelled ? undefined : params.id),
      retry: () =>
        runSessionSyncRetry({
          sessionID: id,
          sync: sync.session.sync,
          refetch: refetchSessionSync,
          beforeSync: throwSessionSyncDebugError,
          activeSessionID: () => (cancelled ? undefined : params.id),
        }),
    })
    onCleanup(() => {
      cancelled = true
    })
  })

  createEffect(
    on(
      () => {
        const id = params.id
        return [
          sdk.directory,
          id,
          id ? (sync.data.session_status[id]?.type ?? "idle") : "idle",
          id ? composer.blocked() : false,
        ] as const
      },
      ([dir, id, _status, _blocked]) => {
        if (todoFrame !== undefined) cancelAnimationFrame(todoFrame)
        if (todoTimer !== undefined) window.clearTimeout(todoTimer)
        todoFrame = undefined
        todoTimer = undefined
        if (!id) return
        // 进入会话即 pull 一次，让上一轮持久化的 todos 立即可见——避免
        // 发消息后才"突然冒出"旧记录的体验。status / blocked 变化也会重新触发。
        const cached = untrack(() => sync.data.todo[id] !== undefined || globalSync.data.session_todo[id] !== undefined)

        todoFrame = requestAnimationFrame(() => {
          todoFrame = undefined
          todoTimer = window.setTimeout(() => {
            todoTimer = undefined
            if (sdk.directory !== dir || params.id !== id) return
            untrack(() => {
              void sync.session.todo(id, cached ? { force: true } : undefined)
            })
          }, 0)
        })
      },
    ),
  )

  createEffect(
    on(
      () => visibleTimelineUserMessages().at(-1)?.id,
      (lastId, prevLastId) => {
        if (lastId && prevLastId && lastId > prevLastId) {
          setStore("messageId", undefined)
        }
      },
      { defer: true },
    ),
  )

  createEffect(
    on(
      sessionKey,
      () => {
        setStore("messageId", undefined)
        setChangesAutoSet(true)
        setStore("changes", defaultChangeMode())
        setUi("pendingMessage", undefined)
      },
      { defer: true },
    ),
  )

  let vcsRefreshTimer: ReturnType<typeof setTimeout> | undefined
  let gitStateRefreshTimer: ReturnType<typeof setTimeout> | undefined
  const refreshGitState = () => {
    // 锚定发起目录：响应到达时目录可能已切换，vcs/project 是单例字段不能写进当前目录
    const directory = sdk.directory
    void Promise.all([sdk.client.vcs.get(), sdk.client.project.current()]).then(([vcsRes, projectRes]) => {
      if (vcsRes.data) {
        const [, setChild] = globalSync.child(directory, { bootstrap: false })
        setChild("vcs", vcsRes.data)
      }
      if (projectRes.data) upsert(projectRes.data, directory)
    })
  }
  const scheduleRefreshVcs = () => {
    if (vcsRefreshTimer) clearTimeout(vcsRefreshTimer)
    vcsRefreshTimer = setTimeout(() => {
      vcsRefreshTimer = undefined
      // 文件 watcher 高频事件合并后主动刷新活跃的 VCS 查询，避免固定轮询反复重绘审查内容。
      refreshVcs()
    }, 500)
  }
  const scheduleRefreshGitState = () => {
    if (gitStateRefreshTimer) clearTimeout(gitStateRefreshTimer)
    gitStateRefreshTimer = setTimeout(() => {
      gitStateRefreshTimer = undefined
      refreshGitState()
      refreshVcs()
    }, 500)
  }
  const isGitIndexChangePath = (path: string) =>
    path === ".git/index" ||
    path === ".git/index.lock" ||
    path.endsWith("/.git/index") ||
    path.endsWith("/.git/index.lock")
  const isGitMetadataPath = (path: string) =>
    path === ".git" || path.startsWith(".git/") || path.includes("/.git/") || path.endsWith("/.git")

  createEffect(() => {
    if (!params.dir) return
    refreshGitState()
    const id = setInterval(refreshGitState, 10_000)
    onCleanup(() => clearInterval(id))
  })

  createEffect(
    on(
      () => gitFeaturesEnabled(),
      (enabled, prev) => {
        if (prev === undefined) return
        if (enabled || gitReviewBlocked() || !overlayOpen()) return
        closeOverlay()
      },
    ),
  )

  const stopVcs = sdk.event.listen((evt) => {
    const type = evt.details.type
    if (type === "file.watcher.worktree_vcs_changed") {
      scheduleRefreshGitState()
      return
    }
    if (type === "vcs.branch.updated") {
      scheduleRefreshGitState()
      return
    }
    if (type !== "file.watcher.updated") return
    const props =
      typeof evt.details.properties === "object" && evt.details.properties
        ? (evt.details.properties as Record<string, unknown>)
        : undefined
    const file = typeof props?.file === "string" ? props.file : undefined
    if (!file) return
    const normalized = file.replace(/\\/g, "/")
    if (isGitIndexChangePath(normalized)) {
      scheduleRefreshVcs()
      return
    }
    if (isGitMetadataPath(normalized)) return
    scheduleRefreshVcs()
  })
  onCleanup(() => {
    stopVcs()
    if (vcsRefreshTimer) clearTimeout(vcsRefreshTimer)
    if (gitStateRefreshTimer) clearTimeout(gitStateRefreshTimer)
    if (prReadinessTimer) clearTimeout(prReadinessTimer)
  })

  createEffect(
    on(
      () => params.dir,
      (dir) => {
        if (!dir) return
        setStore("newSessionWorktree", "main")
      },
      { defer: true },
    ),
  )

  const selectionPreview = (path: string, selection: FileSelection) => {
    const content = file.get(path)?.content?.content
    if (!content) return undefined
    return previewSelectedLines(content, { start: selection.startLine, end: selection.endLine })
  }

  const addCommentToContext = (input: {
    file: string
    selection: SelectedLineRange
    comment: string
    preview?: string
    origin?: "review" | "file"
  }) => {
    const selection = selectionFromLines(input.selection)
    const preview = input.preview ?? selectionPreview(input.file, selection)
    const saved = comments.add({
      file: input.file,
      selection: input.selection,
      comment: input.comment,
    })
    prompt.context.add({
      type: "file",
      path: input.file,
      selection,
      comment: input.comment,
      commentID: saved.id,
      commentOrigin: input.origin,
      preview,
    })
    return saved
  }

  const updateCommentInContext = (input: {
    id: string
    file: string
    selection: SelectedLineRange
    comment: string
    preview?: string
  }) => {
    comments.update(input.file, input.id, input.comment)
    prompt.context.updateComment(input.file, input.id, {
      comment: input.comment,
      ...(input.preview ? { preview: input.preview } : {}),
    })
  }

  const removeCommentFromContext = (input: { id: string; file: string }) => {
    comments.remove(input.file, input.id)
    prompt.context.removeComment(input.file, input.id)
  }

  const reviewCommentActions = createMemo(() => ({
    moreLabel: language.t("common.moreOptions"),
    editLabel: language.t("common.edit"),
    deleteLabel: language.t("common.delete"),
    cancelLabel: language.t("common.cancel"),
    saveLabel: language.t("common.save"),
  }))

  const isEditableTarget = (target: EventTarget | null | undefined) => {
    if (!(target instanceof HTMLElement)) return false
    return /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(target.tagName) || target.isContentEditable
  }

  const deepActiveElement = () => {
    let current: Element | null = document.activeElement
    while (current instanceof HTMLElement && current.shadowRoot?.activeElement) {
      current = current.shadowRoot.activeElement
    }
    return current instanceof HTMLElement ? current : undefined
  }

  const handleKeyDown = (event: KeyboardEvent) => {
    if (!sessionRouteActive()) return
    const path = event.composedPath()
    const target = path.find((item): item is HTMLElement => item instanceof HTMLElement)
    const activeElement = deepActiveElement()

    const protectedTarget = path.some(
      (item) => item instanceof HTMLElement && item.closest("[data-prevent-autofocus]") !== null,
    )
    if (protectedTarget || isEditableTarget(target)) return

    if (activeElement) {
      const isProtected = activeElement.closest("[data-prevent-autofocus]")
      const isInput = isEditableTarget(activeElement)
      if (isProtected || isInput) return
    }
    if (dialog.active) return

    if (activeElement === inputRef) {
      if (event.key === "Escape") inputRef?.blur()
      return
    }

    // Prefer the open terminal over the composer when it can take focus
    if (view().terminal.opened()) {
      const id = terminal.active()
      if (id && shouldFocusTerminalOnKeyDown(event) && focusTerminalById(id)) return
    }

    // Only treat explicit scroll keys as potential "user scroll" gestures.
    // 向下的键（PageDown/End）同样要上报：handleScroll 里「滚到底部附近就恢复跟随」
    // 是唯一的恢复路径，而它被 hasScrollGesture() 门控 —— 不上报就等于按 End 回到底部
    // 也恢复不了自动跟随。滚动中途的 stop() 会在落到底部时被那个分支自愈。
    if (event.key === "PageUp" || event.key === "PageDown" || event.key === "Home" || event.key === "End") {
      markScrollGesture()
      return
    }

    if (event.key.length === 1 && event.key !== "Unidentified" && !(event.ctrlKey || event.metaKey)) {
      if (composer.blocked() || isChildSession()) return
      inputRef?.focus()
    }
  }

  createEffect(() => {
    const list = changesOptions()
    if (list.includes(store.changes)) return
    setChangesAutoSet(true)
    setStore("changes", list[0] ?? "turn")
  })

  createEffect(() => {
    if (!gitReviewBlocked()) return
    const next = coerceReviewChangeModeWhenBlocked(store.changes, sync.data.vcs)
    if (next === store.changes) return
    setChangesAutoSet(true)
    setStore("changes", next)
  })

  createEffect(
    on(gitFeaturesEnabled, (enabled, prev) => {
      if (prev === undefined) return
      if (!enabled) return
      if (prev) return
      if (store.changes !== "turn" || !changesAutoSet()) return
      setChangesAutoSet(true)
      setStore("changes", "unstaged")
    }),
  )

  createEffect(
    on(
      () => store.changes,
      (mode) => {
        if (mode !== "turn") return
        void queryClient.invalidateQueries({ queryKey: ["session-turn-diff"] })
      },
    ),
  )

  createEffect(
    on(
      () => sync.data.session_status[params.id ?? ""]?.type,
      (next, prev) => {
        if (next !== "idle" || prev === undefined || prev === "idle") return
        refreshVcs()
        const id = params.id
        if (!id) return
        void sync.session.sync(id, { force: true }).catch(() => undefined)
        void queryClient.invalidateQueries({ queryKey: ["session-turn-diff"] })
      },
      { defer: true },
    ),
  )

  const fileTreeTab = () => layout.fileTree.tab()
  const setFileTreeTab = (value: "changes" | "all") => layout.fileTree.setTab(value)

  const [tree, setTree] = createStore({
    reviewScroll: undefined as HTMLDivElement | undefined,
    pendingDiff: undefined as string | undefined,
    activeDiff: undefined as string | undefined,
  })
  const reviewPathKey = (path: string) => path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/+$/, "")
  const reviewDiffForPath = (path: string, rows = reviewDiffs()) => {
    const key = reviewPathKey(path)
    return rows.find((row) => row.file === path) ?? rows.find((row) => reviewPathKey(row.file) === key)
  }
  const reviewFocusedDiff = createMemo(() => {
    const rows = reviewDiffs()
    if (rows.length === 0) return undefined
    const active = tree.activeDiff
    if (active) {
      const match = reviewDiffForPath(active, rows)
      if (match) return match.file
    }
    return rows[0]?.file
  })
  const reviewSingleFileMode = createMemo(() => store.changes !== "turn" && reviewCount() > 120)
  const visibleReviewDiffs = createMemo(() => {
    const rows = reviewDiffs()
    if (!reviewSingleFileMode()) return rows
    const focused = reviewFocusedDiff()
    if (!focused) return rows.slice(0, 1)
    return rows.filter((row) => row.file === focused)
  })
  const reviewNotice = createMemo(() => {
    if (!reviewSingleFileMode()) return undefined
    return language.t("ui.sessionReview.largeDiff.singleFileNotice")
  })

  createEffect(
    on(
      sessionKey,
      () => {
        setTree({
          reviewScroll: undefined,
          pendingDiff: undefined,
          activeDiff: undefined,
        })
      },
      { defer: true },
    ),
  )

  createEffect(() => {
    const focused = reviewFocusedDiff()
    if (!focused) {
      if (tree.activeDiff !== undefined) setTree("activeDiff", undefined)
      return
    }
    if (tree.activeDiff === focused) return
    setTree("activeDiff", focused)
  })

  const showAllFiles = () => {
    if (fileTreeTab() !== "changes") return
    setFileTreeTab("all")
  }

  const focusInput = () => {
    if (isChildSession()) return
    inputRef?.focus()
  }

  const openReviewFile = createOpenReviewFile({
    showAllFiles,
    tabForPath: file.tab,
    openTab: tabs().open,
    setActive: tabs().setActive,
    loadFile: file.load,
  })

  const openOutputFile = createOpenSessionFileTab({
    normalizeTab,
    openTab: tabs().open,
    pathFromTab: file.pathFromTab,
    loadFile: file.load,
    openReviewPanel: () => openReviewPanel({ manual: true }),
    setActive: tabs().setActive,
  })

  const openOutputFileFromCard = (path: string) => {
    if (!openReviewPanel({ manual: true })) return
    closeOverlay()
    openOutputFile(file.tab(path))
    setOutputFileFlow(true)
  }

  const changesTitle = () => {
    if (!canReview()) {
      return null
    }

    const changeModeTitle = (option: ChangeMode) =>
      option === "unstaged"
        ? language.t("ui.sessionReview.title.unstaged")
        : option === "staged"
          ? language.t("ui.sessionReview.title.staged")
          : option === "branch"
            ? language.t("ui.sessionReview.title.branch")
            : language.t("ui.sessionReview.title.lastTurn")

    const label = (option: ChangeMode) => {
      const text = changeModeTitle(option)
      const count =
        option === store.changes && option !== "branch" && option !== "turn" && reviewCount() > 0
          ? reviewCount()
          : undefined
      if (!count) return text
      return (
        <span class="inline-flex items-center gap-1.5">
          <span>{text}</span>
          <span class="inline-flex min-h-5 min-w-5 shrink-0 items-center justify-center rounded-md border border-border-weaker-base bg-surface-weak px-1.5 text-12-medium leading-none text-text-strong tabular-nums">
            {reviewCount().toLocaleString()}
          </span>
        </span>
      )
    }

    return (
      <div class="inline-flex items-center gap-2">
        <Select
          options={changesOptions()}
          current={store.changes}
          label={label}
          optionDisabled={(option: ChangeMode) => isReviewChangeModeDisabled(option, sync.data.vcs)}
          optionTextValue={(option: ChangeMode) => {
            const base = changeModeTitle(option)
            const count =
              option === store.changes && option !== "branch" && option !== "turn" ? reviewCount() : undefined
            return count && count > 0 ? `${base} ${count.toLocaleString()}` : base
          }}
          onSelect={(option) => {
            const next = acceptReviewChangeSelection(option, sync.data.vcs)
            if (!next) return
            setChangesAutoSet(false)
            setStore("changes", next)
          }}
          variant="ghost"
          size="small"
          valueClass="text-14-medium"
        />
        <Show when={store.changes !== "turn" && reviewCount() > 0}>
          <DiffChanges changes={reviewDiffTotals()} />
        </Show>
      </div>
    )
  }

  const empty = (text: string) => (
    <div class="h-full pb-64 -mt-4 flex flex-col items-center justify-center text-center gap-6">
      <img src={emptyFileChanges} alt="" aria-hidden="true" class="size-16 shrink-0 object-contain" />
      <div class="text-14-regular text-text-weak max-w-56">{text}</div>
    </div>
  )

  const createGit = (input: { emptyClass: string }) => (
    <div class={input.emptyClass}>
      <div class="flex flex-col gap-3">
        <div class="text-14-medium text-text-strong">{language.t("session.review.noVcs.createGit.title")}</div>
        <div class="text-14-regular text-text-base max-w-md" style={{ "line-height": "var(--line-height-normal)" }}>
          {language.t("session.review.noVcs.createGit.description")}
        </div>
      </div>
      <Button size="large" disabled={gitMutation.isPending} onClick={initGit}>
        {gitMutation.isPending
          ? language.t("session.review.noVcs.createGit.actionLoading")
          : language.t("session.review.noVcs.createGit.action")}
      </Button>
    </div>
  )

  const reviewEmptyText = createMemo(() => {
    if (store.changes === "unstaged") return language.t("session.review.noUnstagedChanges")
    if (store.changes === "staged") return language.t("session.review.noStagedChanges")
    if (store.changes === "branch") return language.t("session.review.noBranchChanges")
    return language.t("session.review.noChanges")
  })

  const reviewEmpty = (input: { loadingClass: string; emptyClass: string }) => {
    if (store.changes === "unstaged" || store.changes === "staged" || store.changes === "branch") {
      if (!vcsGitStatusKnown())
        return <div class={input.loadingClass}>{language.t("session.review.loadingChanges")}</div>
      if (gitReviewBlocked()) return empty(language.t("session.review.noChanges"))
      if (!reviewReady()) return <div class={input.loadingClass}>{language.t("session.review.loadingChanges")}</div>
      if (showCreateGit()) return createGit(input)
      return empty(reviewEmptyText())
    }

    if (store.changes === "turn") {
      return empty(reviewEmptyText())
    }

    return (
      <div class={input.emptyClass}>
        <div class="text-14-regular text-text-weak max-w-56">{reviewEmptyText()}</div>
      </div>
    )
  }

  const reviewContent = (input: {
    diffStyle: DiffStyle
    onDiffStyleChange?: (style: DiffStyle) => void
    classes?: SessionReviewTabProps["classes"]
    loadingClass: string
    emptyClass: string
  }) => (
    <Show when={!store.deferRender}>
      <SessionReviewTab
        title={changesTitle()}
        notice={reviewNotice()}
        empty={reviewEmpty(input)}
        diffs={visibleReviewDiffs}
        railDiffs={reviewDiffs}
        view={view}
        diffStyle={input.diffStyle}
        onDiffStyleChange={input.onDiffStyleChange}
        onDiffToolbarRefresh={refreshVcs}
        diffWhitespaceMenuDisabled={() => store.changes === "turn"}
        gitOpsMenu={reviewGitOpsMenu()}
        onScrollRef={(el) => setTree("reviewScroll", el)}
        focusedFile={tree.activeDiff}
        onFocusedFileChange={(file) => focusReviewDiff(file)}
        onLineComment={(comment) => addCommentToContext({ ...comment, origin: "review" })}
        onLineCommentUpdate={updateCommentInContext}
        onLineCommentDelete={removeCommentFromContext}
        lineCommentActions={reviewCommentActions()}
        commentMentions={{
          items: file.searchFilesAndDirectories,
        }}
        comments={comments.all()}
        focusedComment={comments.focus()}
        onFocusedCommentChange={comments.setFocus}
        onViewFile={openReviewFile}
        classes={input.classes}
      />
    </Show>
  )

  const reviewPanel = () => (
    <div class="flex flex-col h-full overflow-hidden bg-background-base contain-strict">
      <div class="relative pt-2 flex-1 min-h-0 overflow-hidden">
        {reviewContent({
          diffStyle: layout.review.diffStyle(),
          onDiffStyleChange: layout.review.setDiffStyle,
          loadingClass: "px-6 py-4 text-text-weak",
          emptyClass: "h-full pb-64 -mt-4 flex flex-col items-center justify-center text-center gap-6",
        })}
      </div>
    </div>
  )

  createEffect(
    on(
      activeFileTab,
      (active) => {
        if (!active) return
        if (fileTreeTab() !== "changes") return
        showAllFiles()
      },
      { defer: true },
    ),
  )

  const reviewDiffId = (path: string) => {
    const file = reviewDiffForPath(path)?.file ?? path
    const sum = checksum(file)
    if (!sum) return
    return `session-review-diff-${sum}`
  }

  const reviewDiffTop = (path: string) => {
    const root = tree.reviewScroll
    if (!root) return

    const id = reviewDiffId(path)
    if (!id) return

    const el = document.getElementById(id)
    if (!(el instanceof HTMLElement)) return
    if (!root.contains(el)) return
    if (reviewPathKey(el.dataset.file ?? "") !== reviewPathKey(path)) return

    const a = el.getBoundingClientRect()
    const b = root.getBoundingClientRect()
    return a.top - b.top + root.scrollTop
  }

  const scrollToReviewDiff = (path: string) => {
    const root = tree.reviewScroll
    if (!root) return false

    const top = reviewDiffTop(path)
    if (top === undefined) return false

    view().setScroll("review", { x: root.scrollLeft, y: top })
    root.scrollTo({ top, behavior: "auto" })
    return true
  }

  const focusReviewDiff = (path: string) => {
    const file = reviewDiffForPath(path)?.file ?? path
    openReviewPanel({ manual: true })
    view().review.openPath(file)
    setTree({ activeDiff: file, pendingDiff: file })
  }

  createEffect(() => {
    const pending = tree.pendingDiff
    if (!pending) return
    if (!tree.reviewScroll) return
    if (!reviewReady()) return

    const attempt = (count: number) => {
      if (tree.pendingDiff !== pending) return
      if (count > 60) {
        setTree("pendingDiff", undefined)
        return
      }

      const root = tree.reviewScroll
      if (!root) {
        requestAnimationFrame(() => attempt(count + 1))
        return
      }

      if (!scrollToReviewDiff(pending)) {
        requestAnimationFrame(() => attempt(count + 1))
        return
      }

      const top = reviewDiffTop(pending)
      if (top === undefined) {
        requestAnimationFrame(() => attempt(count + 1))
        return
      }

      if (Math.abs(root.scrollTop - top) <= 1) {
        setTree("pendingDiff", undefined)
        return
      }

      requestAnimationFrame(() => attempt(count + 1))
    }

    requestAnimationFrame(() => attempt(0))
  })

  createEffect(() => {
    const id = params.id
    if (!id) return

    if (!wantsReview()) return
    if (sync.data.session_diff[id] !== undefined) return
    if (sync.status === "loading") return

    void sync.session.diff(id)
  })

  createEffect(
    on(
      () => [sessionKey(), wantsReview()] as const,
      ([key, wants]) => {
        if (diffFrame !== undefined) cancelAnimationFrame(diffFrame)
        if (diffTimer !== undefined) window.clearTimeout(diffTimer)
        diffFrame = undefined
        diffTimer = undefined
        if (!wants) return

        const id = params.id
        if (!id) return
        if (!untrack(() => sync.data.session_diff[id] !== undefined)) return

        diffFrame = requestAnimationFrame(() => {
          diffFrame = undefined
          diffTimer = window.setTimeout(() => {
            diffTimer = undefined
            if (sessionKey() !== key) return
            void sync.session.diff(id, { force: true })
          }, 0)
        })
      },
      { defer: true },
    ),
  )

  let treeDir: string | undefined
  createEffect(() => {
    const dir = sdk.directory
    if (!isDesktop()) return
    if (!layout.fileTree.opened()) return
    if (sync.status === "loading") return

    fileTreeTab()
    const refresh = treeDir !== dir
    treeDir = dir

    const state = file.tree.state("")
    if (!refresh && (state?.loaded || state?.loading)) return

    void (refresh ? file.tree.refresh("") : file.tree.list(""))
  })

  createEffect(
    on(
      () => sdk.directory,
      () => {
        const tab = activeFileTab()
        if (!tab) return
        const path = file.pathFromTab(tab)
        if (!path) return
        void file.load(path, { force: true })
      },
      { defer: true },
    ),
  )

  const autoScroll = createAutoScroll({
    working: () => true,
    overflowAnchor: "auto",
  })

  const markTimelineScrollGesture = (target?: EventTarget | null, direction?: AutoScrollDirection) => {
    // 手势开始即把滚动权交给用户，不再等浏览器先改 scrollTop、再由 scroll 事件补救。
    // 同时传递方向：向上立即暂停，向下抵达底部则像官方 Codex 一样立即恢复跟随。
    markScrollGesture(target)
    autoScroll.beginUserControl(direction)
  }

  let scrollStateFrame: number | undefined
  let scrollStateTarget: HTMLDivElement | undefined
  let fillFrame: number | undefined

  const jumpThreshold = (el: HTMLDivElement) => Math.max(400, el.clientHeight)

  const updateScrollState = (el: HTMLDivElement) => {
    const max = el.scrollHeight - el.clientHeight
    const distance = max - el.scrollTop
    const overflow = max > 1
    const bottom = !overflow || distance <= 2
    const jump = overflow && distance > jumpThreshold(el)

    if (ui.scroll.overflow === overflow && ui.scroll.bottom === bottom && ui.scroll.jump === jump) return
    setUi("scroll", { overflow, bottom, jump })
  }

  const scheduleScrollState = (el: HTMLDivElement) => {
    scrollStateTarget = el
    if (scrollStateFrame !== undefined) return

    scrollStateFrame = requestAnimationFrame(() => {
      scrollStateFrame = undefined

      const target = scrollStateTarget
      scrollStateTarget = undefined
      if (!target) return

      updateScrollState(target)
    })
  }

  const resumeScroll = () => {
    setStore("messageId", undefined)
    autoScroll.forceScrollToBottom()
    clearMessageHash()

    const el = scroller
    if (el) scheduleScrollState(el)
  }

  // When the user returns to the bottom, treat the active message as "latest".
  createEffect(
    on(
      autoScroll.userScrolled,
      (scrolled) => {
        // 切会话时的程序化重置也会让 userScrolled 翻成 false，但那不是「用户滚回底部」。
        // 若照常清 hash，会把刚打开的会话上的深链目标一并抹掉。
        // 必须无条件消费：若同一次冲刷里 userScrolled 又被顶回 true（深链跳转会 pause），
        // 本回调以 scrolled=true 提前返回，标志残留下来会误吞下一次真正的转换。
        const programmatic = autoScroll.consumeReset()
        if (scrolled || programmatic) return
        setStore("messageId", undefined)
        clearMessageHash()
      },
      { defer: true },
    ),
  )

  let fill = () => {}

  const setScrollRef = (el: HTMLDivElement | undefined) => {
    scroller = el
    autoScroll.scrollRef(el)
    if (!el) return
    scheduleScrollState(el)
    fill()
  }

  const markUserScroll = () => {
    scrollMark += 1
  }

  createResizeObserver(
    () => content,
    () => {
      const el = scroller
      if (el) scheduleScrollState(el)
      fill()
    },
  )

  const historyWindow = createSessionHistoryWindow({
    sessionID: () => params.id,
    messagesReady,
    loaded: () => messages().length,
    visibleUserMessages: visibleTimelineUserMessages,
    historyMore,
    historyLoading,
    loadMore: (sessionID) => sync.session.history.loadMore(sessionID),
    userScrolled: autoScroll.userScrolled,
    scroller: () => scroller,
  })

  fill = () => {
    if (fillFrame !== undefined) return

    fillFrame = requestAnimationFrame(() => {
      fillFrame = undefined

      if (!params.id || !messagesReady()) return
      if (autoScroll.userScrolled() || historyLoading()) return

      const el = scroller
      if (!el) return
      if (el.scrollHeight > el.clientHeight + 1) return
      if (historyWindow.turnStart() <= 0 && !historyMore()) return

      void historyWindow.loadAndReveal()
    })
  }

  createEffect(
    on(
      () =>
        [
          params.id,
          messagesReady(),
          historyWindow.turnStart(),
          historyMore(),
          historyLoading(),
          autoScroll.userScrolled(),
          visibleTimelineUserMessages().length,
        ] as const,
      ([id, ready, start, more, loading, scrolled]) => {
        if (!id || !ready || loading || scrolled) return
        if (start <= 0 && !more) return
        fill()
      },
      { defer: true },
    ),
  )

  const draft = (id: string) =>
    restoreEditorFromUserParts(sync.data.part[id] ?? [], {
      directory: sdk.directory,
      attachmentName: language.t("common.attachment"),
    }).prompt

  const line = (id: string) => {
    const { prompt: restored, addToChatSnippets } = restoreEditorFromUserParts(sync.data.part[id] ?? [], {
      directory: sdk.directory,
      attachmentName: language.t("common.attachment"),
    })
    if (addToChatSnippets.length > 0) {
      const bodyLine = restored
        .map((part) => (part.type === "image" ? `[image:${part.filename}]` : part.content))
        .join("")
        .replace(/\s+/g, " ")
        .trim()
      if (bodyLine.length > 0) return bodyLine.length > 120 ? `${bodyLine.slice(0, 120)}…` : bodyLine
      return language.t(
        addToChatSnippets.length === 1
          ? "session.addToChat.selectionCount.one"
          : "session.addToChat.selectionCount.other",
        { count: addToChatSnippets.length },
      )
    }
    const text = restored
      .map((part) => (part.type === "image" ? `[image:${part.filename}]` : part.content))
      .join("")
      .replace(/\s+/g, " ")
      .trim()
    if (text) return text
    return `[${language.t("common.attachment")}]`
  }

  const fail = (err: unknown) => {
    // resolveError 精确分类后端认证/权益/额度/限速错误；返回 unknown 时兜底 formatServerError（本地/旧格式错误安全）
    const resolved = resolveError(err)
    showToast({
      variant: "error",
      title: language.t("common.requestFailed"),
      description:
        resolved.category !== "unknown" ? language.t(resolved.messageKey as any) : formatServerError(err, language.t),
    })
  }

  const addHeaderAction = async (action: HeaderAction) => {
    const items = [...headerActionItems(), action]
    setHeaderActionItems(items)
    await writeHeaderActionsToEnv(items)
  }

  const updateHeaderAction = async (action: HeaderAction) => {
    const items = headerActionItems().map((item) => (item.id === action.id ? action : item))
    setHeaderActionItems(items)
    await writeHeaderActionsToEnv(items)
  }

  const deleteHeaderAction = async (id: string) => {
    const items = headerActionItems().filter((item) => item.id !== id)
    setHeaderActionItems(items)
    await writeHeaderActionsToEnv(items)
  }

  const pinHeaderAction = async (id: string) => {
    const items = headerActionItems()
    const action = items.find((item) => item.id === id)
    if (!action) return
    const pinned = [action, ...items.filter((item) => item.id !== id)]
    setHeaderActionItems(pinned)
    await writeHeaderActionsToEnv(pinned)
  }

  const openAddHeaderAction = () => {
    dialog.show(() => <DialogAddHeaderAction projectName={projectName()} onSave={addHeaderAction} />)
  }

  const openEditHeaderAction = (action: HeaderAction) => {
    setStore("headerActionMenu", "open", false)
    requestAnimationFrame(() => {
      dialog.show(() => (
        <DialogAddHeaderAction projectName={projectName()} action={action} onSave={updateHeaderAction} />
      ))
    })
  }

  const openDeleteHeaderAction = (action: HeaderAction) => {
    setStore("headerActionMenu", "open", false)
    requestAnimationFrame(() => {
      dialog.show(() => <DialogDeleteHeaderAction action={action} onDelete={deleteHeaderAction} />)
    })
  }

  const openHeaderActionContextMenu = (event: MouseEvent, action: HeaderAction) => {
    event.preventDefault()
    event.stopPropagation()
    if (headerActionState.running !== undefined) return
    setStore("headerActionMenu", {
      open: true,
      action,
      position: { x: event.clientX, y: event.clientY },
    })
  }

  const openRunHeaderAction = () => {
    dialog.show(() => (
      <DialogRunHeaderAction
        onSave={(action) => {
          addHeaderAction(action)
        }}
      />
    ))
  }

  const runHeaderAction = async (action: HeaderAction) => {
    if (headerActionState.running) return

    setHeaderActionState("running", action.id)
    try {
      const id = await terminal.run({
        title: action.name,
        command: action.command,
        cwd: sdk.directory,
        os: platform.os,
      })
      view().terminal.open()
      if (id) setTimeout(() => focusTerminalById(id), 0)
    } catch (err) {
      fail(err)
    } finally {
      setHeaderActionState("running", undefined)
    }
  }

  const merge = (next: NonNullable<ReturnType<typeof info>>) =>
    sync.set("session", (list) => {
      const idx = list.findIndex((item) => item.id === next.id)
      if (idx < 0) return list
      const out = list.slice()
      out[idx] = next
      return out
    })

  const roll = (sessionID: string, next: NonNullable<ReturnType<typeof info>>["revert"]) =>
    sync.set("session", (list) => {
      const idx = list.findIndex((item) => item.id === sessionID)
      if (idx < 0) return list
      const out = list.slice()
      out[idx] = { ...out[idx], revert: next }
      return out
    })

  const runStateInput = (sessionID: string) => {
    const status = sync.data.session_status[sessionID]
    return {
      messages: sync.data.message[sessionID],
      partsByMessage: sync.data.part,
      // status map 只保存活动会话；用独立 ready 区分“已确认 idle”和“bootstrap 尚未完成”。
      statusBusy: resolvedSessionStatusBusy({
        status,
        snapshotReady: sync.data.session_status_ready,
        sessionKnown: sync.data.session_status_known[sessionID],
      }),
      // retry 期间上一 attempt 已有 step-finish；必须保留独立标记，不能压扁成普通 busy 后被完成证据盖掉。
      statusRetry: status?.type === "retry",
      ignoredUserMessageIDs: new Set(Object.keys(userTurnView().steeredByMessageID)),
      now: runStateNow(),
    }
  }
  createEffect(() => {
    const id = params.id
    if (!id) return
    const status = sync.data.session_status[id]
    const messages = sync.data.message[id]
    if (
      !status &&
      !store.followupAwaiting[id] &&
      manualSteerPendingList(followup.manualSteerPending?.[id]).length === 0 &&
      (followup.items[id]?.length ?? 0) === 0 &&
      !messages?.some((message) => message.role === "assistant" && typeof message.time.completed !== "number")
    )
      return

    // 运行态里有多个时间宽限窗口(流式 text 缺 end、乐观 user、stale run)。
    // Date.now() 本身不是响应式；这里定时推动重算，避免必须切换会话/重载窗口才释放卡住的停止态。
    // follow-up 队列/手动引导接力的等待锁也依赖时间宽限，空闲但仍有队列/awaiting 时同样需要 tick 推进。
    const timer = setInterval(() => setRunStateNow(Date.now()), 1_000)
    onCleanup(() => clearInterval(timer))
  })
  function busy(sessionID: string) {
    if (store.abortingSessions[sessionID]) return false
    return sessionHasRunningTurn(runStateInput(sessionID))
  }
  // steer 同时参考前端推导态和后端 status，覆盖工具事件与状态事件到达顺序不同的短窗口。
  const sessionStatusBusy = (sessionID: string) =>
    (sync.data.session_status[sessionID] ?? { type: "idle" as const }).type !== "idle"
  // 压缩会重写会话历史；发送路径据此把引导强制降级为入队，避免和压缩竞争同一份快照。
  const sessionCompacting = (sessionID: string) =>
    compactionInFlight({
      messages: sync.data.message[sessionID] ?? [],
      partsByMessage: sync.data.part,
      statusBusy: sessionStatusBusy(sessionID),
      now: runStateNow(),
    })
  const manualSteerPendings = (sessionID: string, directory = sdk.directory) =>
    manualSteerPendingList(followupForDirectory(directory)[0].manualSteerPending?.[sessionID])
  const currentManualSteerPending = (sessionID: string, directory = sdk.directory) =>
    manualSteerPendings(sessionID, directory).at(-1)
  const currentManualSteerTargetTurnID = (sessionID: string, directory = sdk.directory) => {
    const pending = currentManualSteerPending(sessionID, directory)
    // 旧顺序锁若缺目标也不能回退读取新 status，否则刷新后会把旧引导静默附到后来启动的回合。
    if (pending) return pending.targetTurnID
    const data = directory === sdk.directory ? sync.data : globalSync.child(directory, { bootstrap: false })[0]
    return selectManualSteerTargetTurnID({ status: data.session_status[sessionID] })
  }
  const manualSteerRuntime = (directory: string, sessionID: string) => {
    const data = directory === sdk.directory ? sync.data : globalSync.child(directory, { bootstrap: false })[0]
    const status = data.session_status[sessionID]
    const statusBusy = (status ?? { type: "idle" as const }).type !== "idle"
    const runtimeMessages = orderTimelineMessages(data.message[sessionID] ?? [])
    const view =
      directory === sdk.directory && params.id === sessionID
        ? userTurnView()
        : dedupeUserTurnsWithAliases(
            runtimeMessages.filter((message) => message.role === "user") as UserMessage[],
            data.part,
            runtimeMessages,
            { statusBusy, now: runStateNow() },
          )
    const inferredBusy =
      !store.abortingSessions[sessionID] &&
      sessionHasRunningTurn({
        messages: runtimeMessages,
        partsByMessage: data.part,
        statusBusy,
        // 跨会话引导目标同样以 retry 为活动态，避免当前页面正确、后台会话却错误进入普通队列。
        statusRetry: status?.type === "retry",
        ignoredUserMessageIDs: new Set(Object.keys(view.steeredByMessageID)),
        now: runStateNow(),
      })

    return {
      status,
      statusBusy,
      inferredBusy,
      startedAt: sessionActiveTurnStartedAt(status),
      // 官方把 steering item push 到当前 inProgress turn；没有活动证据时继续等 turnID，绝不猜最后一个普通队列回合。
      turnGroupID: activeTimelineTurnGroupID({
        status,
        messages: runtimeMessages,
        partsByMessage: data.part,
        turnIDByMessageID: view.turnIDByMessageID,
        now: runStateNow(),
      }),
    }
  }
  const currentManualSteerTurnGroupID = (sessionID: string, directory = sdk.directory) =>
    manualSteerRuntime(directory, sessionID).turnGroupID
  type ManualSteerTargetWaiter = {
    directory: string
    sessionID: string
    messageID: string
    promise: Promise<string>
    resolve: (turnID: string) => void
    reject: (error: Error) => void
    timeoutID?: number
  }
  type ManualSteerTargetWaitIntent = {
    directory: string
    requestedAt: number
    startedAt?: number
    expectedTurnGroupID?: string
    inactiveObserved: boolean
    originInProgressObserved: boolean
    statusObserved: boolean
  }
  // 运行时所有权等价于官方 conversation callback 的生命周期：刷新后 Set 为空，旧 unresolved steer 绝不绑定后来回合。
  const manualSteerTargetWaitIntents = new Map<string, ManualSteerTargetWaitIntent>()
  const manualSteerTargetWaiters = new Map<string, ManualSteerTargetWaiter>()
  const [manualSteerTargetWaitRevision, setManualSteerTargetWaitRevision] = createSignal(0)
  const manualSteerTargetWaitKey = (sessionID: string, messageID: string) => `${sessionID}\u0000${messageID}`
  const manualSteerTargetWaitOwned = (sessionID: string, messageID: string) =>
    manualSteerTargetWaitIntents.has(manualSteerTargetWaitKey(sessionID, messageID))
  const manualSteerWaitError = (name: "SteerTurnInactiveError" | "AbortError" | "MissingSteerTargetError") =>
    Object.assign(
      new Error(
        name === "SteerTurnInactiveError"
          ? "Active turn ended before its turn ID became available"
          : name === "AbortError"
            ? "Manual steer target wait was cancelled"
            : "Timed out waiting for the active turn ID",
      ),
      { name },
    )
  const settleManualSteerTargetWait = (key: string, result: { turnID: string } | { error: Error }) => {
    const waiter = manualSteerTargetWaiters.get(key)
    if (!waiter) return
    manualSteerTargetWaiters.delete(key)
    if (waiter.timeoutID !== undefined) window.clearTimeout(waiter.timeoutID)
    if ("turnID" in result) {
      waiter.resolve(result.turnID)
      return
    }
    waiter.reject(result.error)
  }
  const markManualSteerTargetWait = (
    sessionID: string,
    messageID: string,
    input: {
      directory: string
      requestedAt?: number
      startedAt?: number
      expectedTurnGroupID?: string
      originInProgressObserved?: boolean
    },
  ) => {
    // 官方 callback 绑定的是创建引导时的 conversation 代次；idle 一旦被观察到就永久终止，不能被后来 run 借用。
    manualSteerTargetWaitIntents.set(manualSteerTargetWaitKey(sessionID, messageID), {
      directory: input.directory,
      // 记录点击引导时刻；若当时没有任何回合身份，后续更晚的 startedAt 只能来自新回合。
      requestedAt: input.requestedAt ?? Date.now(),
      startedAt: input?.startedAt,
      expectedTurnGroupID: input?.expectedTurnGroupID,
      inactiveObserved: false,
      originInProgressObserved: input?.originInProgressObserved === true,
      statusObserved:
        globalSync.child(input.directory, { bootstrap: false })[0].session_status[sessionID] !== undefined,
    })
    setManualSteerTargetWaitRevision((value) => value + 1)
  }
  const clearManualSteerTargetWait = (sessionID: string, messageID: string) => {
    const key = manualSteerTargetWaitKey(sessionID, messageID)
    manualSteerTargetWaitIntents.delete(key)
    settleManualSteerTargetWait(key, { error: manualSteerWaitError("AbortError") })
    setManualSteerTargetWaitRevision((value) => value + 1)
  }
  const waitForManualSteerTarget = (sessionID: string, messageID: string) => {
    const key = manualSteerTargetWaitKey(sessionID, messageID)
    const existing = manualSteerTargetWaiters.get(key)
    if (existing) return existing.promise
    const intent = manualSteerTargetWaitIntents.get(key)
    if (!intent) return Promise.reject(manualSteerWaitError("AbortError"))

    let resolve!: (turnID: string) => void
    let reject!: (error: Error) => void
    const promise = new Promise<string>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise
      reject = rejectPromise
    })
    const waiter: ManualSteerTargetWaiter = {
      directory: intent.directory,
      sessionID,
      messageID,
      promise,
      resolve,
      reject,
    }
    // 与官方 rfe 一样给等待 active turn ID 设置上限；超时只恢复草稿，不会擅自启动普通回合。
    waiter.timeoutID = window.setTimeout(
      () => settleManualSteerTargetWait(key, { error: manualSteerWaitError("MissingSteerTargetError") }),
      120_000,
    )
    manualSteerTargetWaiters.set(key, waiter)
    setManualSteerTargetWaitRevision((value) => value + 1)
    return promise
  }
  createEffect(() => {
    manualSteerTargetWaitRevision()
    for (const [key, waiter] of manualSteerTargetWaiters) {
      const intent = manualSteerTargetWaitIntents.get(key)
      // 等待器固定读取提交时的目录；切换工作区只改变当前视图，不代表原 conversation 已结束。
      const runtime = manualSteerRuntime(waiter.directory, waiter.sessionID)
      const status = runtime.status
      const statusKnown = status !== undefined
      const statusBusy = runtime.statusBusy
      const activeStartedAt = runtime.startedAt
      const inferredBusy = runtime.inferredBusy
      if (intent) {
        // 记录本次 run 曾发布过权威状态，后续 status 被 idle 事件删除时才能和“首次尚未加载”区分。
        if (statusKnown) intent.statusObserved = true
        intent.inactiveObserved = manualSteerTargetWaitInactiveObserved({
          inactiveObserved: intent.inactiveObserved,
          originInProgressObserved: intent.originInProgressObserved,
          statusObserved: intent.statusObserved,
          statusKnown,
          statusBusy,
          inferredBusy,
        })
      }
      // 意图产生时若 status 尚未到达，就把当前运行时观察到的首个 active 代次作为 origin；之后不再改写。
      if (intent && intent.startedAt === undefined && activeStartedAt !== undefined) intent.startedAt = activeStartedAt
      const state = manualSteerTargetWaitState({
        runtimeOwned: !!intent,
        originInProgressObserved: intent?.originInProgressObserved ?? false,
        requestedAt: intent?.requestedAt,
        // 只有这次运行时持有等待意图时才能从 status 补齐目标；旧持久化 pending 不会走到这里。
        targetTurnID: selectManualSteerTargetTurnID({ status }),
        expectedStartedAt: intent?.startedAt,
        activeStartedAt,
        expectedTurnGroupID: intent?.expectedTurnGroupID,
        activeTurnGroupID: runtime.turnGroupID,
        inactiveObserved: intent?.inactiveObserved ?? false,
        // 这里表示当前权威状态是否已加载；历史 idle 另由 inactiveObserved 跨事件记忆。
        statusKnown,
        inferredBusy,
        statusBusy,
      })
      if (state.type === "waiting") continue
      if (state.type === "ready") {
        settleManualSteerTargetWait(key, { turnID: state.targetTurnID })
        continue
      }
      settleManualSteerTargetWait(key, {
        error: manualSteerWaitError(state.type === "inactive" ? "SteerTurnInactiveError" : "AbortError"),
      })
    }
  })
  onCleanup(() => {
    for (const key of [...manualSteerTargetWaiters.keys()])
      settleManualSteerTargetWait(key, { error: manualSteerWaitError("AbortError") })
    manualSteerTargetWaitIntents.clear()
  })
  const manualSteerWaiting = (sessionID: string) =>
    !followupReady() ||
    // 普通 follow-up 在 ACK 后仍要等待它对应的 assistant 回合收尾；这段 idle 接力窗口也不能让新输入越过队列。
    !!store.followupAwaiting[sessionID] ||
    manualSteerPendings(sessionID).length > 0 ||
    (followup.items[sessionID] ?? []).some((item) => item.manualSteer === true && !item.targetTurnID)
  const sessionWorking = (sessionID: string) => busy(sessionID) || manualSteerWaiting(sessionID)
  const composer = createSessionComposerState({
    // composer 会同步读取 working；必须等 store/runStateInput 初始化后再创建，避免切换会话时踩到 TDZ。
    // 手动引导在 idle 接力窗口内也必须保持工作态，
    // 否则普通输入会越过待执行引导直接发往后端，重新打乱消息顺序。
    working: () => (params.id ? sessionWorking(params.id) : false),
  })
  const staleRun = (sessionID: string) => sessionHasStaleRunState(runStateInput(sessionID))
  const clearStaleRun = async (sessionID: string) => {
    if (!staleRun(sessionID)) return true
    const existing = staleRunClearTasks.get(sessionID)
    if (existing) return existing

    setStore("staleRunClearing", sessionID, true)
    const task = (async () => {
      // 自动清理只修正前端残留的 running 状态；真正中断只允许由用户点击停止触发。
      // 这里调用 abort 会把已经产出内容但缺 completed 事件的回合错误标成“你停止了”。
      sync.set("session_status", sessionID, { type: "idle" })
      void sync.session.sync(sessionID, { force: true }).catch(() => undefined)
      return true
    })().finally(() => {
      staleRunClearTasks.delete(sessionID)
      setStore("staleRunClearing", sessionID, undefined)
    })
    staleRunClearTasks.set(sessionID, task)
    return task
  }

  // 回合收尾瞬间(最新 assistant 刚 finish、但 session.status idle 事件还没到)会短暂满足「status 仍 busy、
  // 但已无运行回合」——这不是 stale,稍等其 idle 事件即可,不要清理;否则每个工具轮结束都会误触发一次
  //(no-op 的)session.abort + 强制 resync。用「最新 assistant 刚 completed(在收尾宽限内)」识别这种收尾
  // 过渡态并跳过。真正卡死的会话其最新 assistant 早已完成(或压根没有完成时间),不在宽限内 → 照常同步清理,
  // 短暂访问也能立即恢复(不依赖定时器存活)。
  const TURN_END_SETTLE_MS = 10_000
  const recentlyCompletedTurn = (sessionID: string) => {
    const completed = lastAssistantMessage(sync.data.message[sessionID] ?? [])?.time.completed
    return completed !== undefined && Date.now() - completed <= TURN_END_SETTLE_MS
  }
  // 用于在 TURN_END_SETTLE_MS 后强制重跑 stale 检测 effect:
  // Date.now() 非响应式,effect 在宽限内命中 guard 后若无其他响应式变化不会自动重跑
  const [_staleCheckBump, _bumpStaleCheck] = createSignal(0)
  createEffect(() => {
    const sessionID = params.id
    if (!sessionID) return
    const status = sync.data.session_status[sessionID]
    _staleCheckBump() // 订阅,让 setTimeout 到期后触发重跑
    if (!status || status.type === "idle") return
    if (busy(sessionID)) return
    if (recentlyCompletedTurn(sessionID)) {
      const t = setTimeout(() => _bumpStaleCheck((v) => v + 1), TURN_END_SETTLE_MS)
      onCleanup(() => clearTimeout(t))
      return
    }
    void clearStaleRun(sessionID)
  })

  const queuedFollowups = createMemo(() => {
    const id = params.id
    if (!id) return emptyFollowups
    return followup.items[id] ?? emptyFollowups
  })

  const editingFollowup = createMemo(() => {
    const id = params.id
    if (!id) return
    return followup.edit[id]
  })

  // 模块级注册表对应官方 composer ref / conversation Set；本地 revision 只负责唤醒当前页面的队列 effect。
  const [followupSendClaimRevision, setFollowupSendClaimRevision] = createSignal(0)
  const unsubscribeFollowupSendClaims = followupSendClaimRegistry.subscribe(() =>
    setFollowupSendClaimRevision((value) => value + 1),
  )
  onCleanup(unsubscribeFollowupSendClaims)
  const followupLifecycleOwner = Symbol("session-followup-owner")
  const ownedFollowupLifecycleKeys = new Set<string>()
  const followupRequestControllers = new Map<string, AbortController>()
  const activateFollowupLifecycleOwner = (directory: string, sessionID: string) => {
    const key = followupLifecycleKey(directory, sessionID)
    followupLifecycleOwners.set(key, followupLifecycleOwner)
    ownedFollowupLifecycleKeys.add(key)
    return key
  }
  const ownsFollowupLifecycle = (key: string) => followupLifecycleOwners.get(key) === followupLifecycleOwner
  const activateCurrentFollowupLifecycle = () => {
    const sessionID = params.id
    if (!sessionID) return
    activateFollowupLifecycleOwner(sdk.directory, sessionID)
  }
  // 新页面构造阶段立即接管当前会话，保证旧页面的 Promise 微任务没有机会在首个 effect 前覆盖新持久化实例。
  activateCurrentFollowupLifecycle()
  createEffect(activateCurrentFollowupLifecycle)
  onCleanup(() => {
    // 卸载只撤销自己仍持有的键；后来页面已经接管的 owner 不能被旧 cleanup 一并删除。
    ownedFollowupLifecycleKeys.forEach((key) => {
      if (ownsFollowupLifecycle(key)) followupLifecycleOwners.delete(key)
      // 页面卸载时终止尚未 ACK 的 follow-up 请求，避免旧页面继续占用会话级发送锁。
      followupRequestControllers.get(key)?.abort(Object.assign(new Error("Follow-up page unmounted"), { name: "AbortError" }))
    })
  })

  const followupMutation = useMutation(() => ({
    mutationFn: async (input: {
      directory: string
      sessionID: string
      id: string
      manual?: boolean
      source?: "automatic" | "dock"
      resumeAfterAbort?: boolean
    }) => {
      // 发送期间用户可能切目录：所有异步后的 followup 写入锚定发起时的目录实例，
      // 否则失败恢复/afterMessageID 更新会写进切换后目录的 store
      const directory = input.directory
      const client =
        directory === sdk.directory ? sdk.client : sdk.createClient({ directory, throwOnError: true })
      const [followupHere, setFollowupHere, , followupReadyHere] = followupForDirectory(directory)
      // 发送期间目录可能切换；从发起时捕获的持久化实例读取，避免新目录把旧队列项判成不存在。
      const items = followupHere.items[input.sessionID] ?? []
      const index = items.findIndex((entry) => entry.id === input.id)
      const item = items[index]
      if (!item) return
      const lifecycleKey = followupLifecycleKey(directory, input.sessionID)
      // mutation 只接受调用 sendFollowup 时已经激活的当前页面；旧页面失去 owner 后只剩 finally 释放 claim 的权限。
      if (!ownsFollowupLifecycle(lifecycleKey)) return
      const abortEpoch = followupAbortEpoch(directory, input.sessionID)
      const requestCanWrite = () =>
        ownsFollowupLifecycle(lifecycleKey) && followupAbortEpoch(directory, input.sessionID) === abortEpoch
      // 每条 steer 都有独立 durable ACK；数组兼容旧版单对象，并分别跟踪已串行提交到同一 active turn 的引导。
      const previousManualSteerPending = manualSteerPendingList(followupHere.manualSteerPending?.[input.sessionID]).at(
        -1,
      )
      const requestedManualSteer = input.manual === true && item.manualSteer === true
      // 后续 steer 可能在首条等待 turnID 时已经入队；真正轮到发送时优先继承同一 active turn 的已确认目标。
      const targetTurnID = requestedManualSteer
        ? (item.targetTurnID ?? previousManualSteerPending?.targetTurnID)
        : undefined
      const targetPending =
        requestedManualSteer &&
        !targetTurnID &&
        !!item.messageID &&
        manualSteerTargetWaitOwned(input.sessionID, item.messageID)
      if (requestedManualSteer && !targetTurnID && !targetPending) {
        // 只有创建这条引导的当前页面运行时可以继续等 target；刷新后的 unresolved 草稿暂停恢复，不能绑定后来回合。
        const recovered = recoverStaleSteerToPausedQueue(item)
        setFollowupHere("items", input.sessionID, (current) =>
          (current ?? []).map((entry) => (entry.id === item.id ? recovered.item : entry)),
        )
        setFollowupHere("paused", input.sessionID, recovered.paused)
        setFollowupHere("failed", input.sessionID, undefined)
        return
      }
      const boundItem = targetTurnID && item.targetTurnID !== targetTurnID ? { ...item, targetTurnID } : item
      const currentModel = input.source === "dock" ? local.model.current() : undefined
      const currentAgent = input.source === "dock" ? local.agent.current() : undefined
      // 用户点击 Dock 的“引导”时采用当前模型；自动队列保留入队快照，避免无人值守任务被悄悄改模型。
      const draft = followupDraftForSend({
        draft: boundItem,
        source: input.source ?? "automatic",
        current:
          currentModel && currentAgent
            ? {
                agent: currentAgent.name,
                model: { providerID: currentModel.provider.id, modelID: currentModel.id },
                variant: local.model.variant.current(),
              }
            : undefined,
      })
      // 审批模式必须在创建发送身份和乐观状态前完成一次预检；等待期间若页面失去所有权则放弃旧请求。
      try {
        await permission.flush()
      } catch (err) {
        if (requestCanWrite()) {
          setFollowupHere("failed", input.sessionID, input.id)
          if (requestedManualSteer && item.messageID) {
            // 页面预检失败发生在 dequeue 前；撤销预先展示与豁免后保留原队列项，用户才能看见失败并重试。
            sync.session.optimistic.remove({
              directory,
              sessionID: input.sessionID,
              messageID: item.messageID,
            })
            setStore("followupSentMessageIDs", input.sessionID, (ids) => ids?.filter((id) => id !== item.messageID))
          }
        }
        fail(err)
        return
      }
      if (!requestCanWrite()) return
      // 队列本地 id 可能早于运行中间产生的 assistant；实际发网时才生成消息 ID，才能让 first-seen store 保持官方追加顺序。
      const messageID = followupMessageID(boundItem, Identifier.ascending("message"))
      if (targetTurnID && item.messageID && manualSteerTargetWaitOwned(input.sessionID, item.messageID))
        clearManualSteerTargetWait(input.sessionID, item.messageID)
      // 一旦开始发送就把网络身份写入所有恢复快照；超时、停止和刷新重试必须继续复用同一 messageID 保持幂等。
      const sentItem = boundItem.messageID ? boundItem : { ...boundItem, messageID }
      const releaseAwaiting = () => setStore("followupAwaiting", input.sessionID, undefined)
      const releaseSentMessageID = () =>
        setStore("followupSentMessageIDs", input.sessionID, (ids) => ids?.filter((id) => id !== messageID))
      const releaseManualSteerPending = () =>
        batch(() => {
          clearManualSteerTargetWait(input.sessionID, messageID)
          setFollowupHere("manualSteerPending", input.sessionID, (pending) => {
            const next = manualSteerPendingList(pending).filter((entry) => entry.messageID !== messageID)
            return next.length > 0 ? next : undefined
          })
        })
      const restore = (restored: FollowupItem = sentItem) =>
        setFollowupHere("items", input.sessionID, (current) => {
          const list = current ?? []
          if (list.some((entry) => entry.id === restored.id)) return list
          const next = list.slice()
          next.splice(Math.min(index, next.length), 0, restored)
          return next
        })

      setFollowupHere("failed", input.sessionID, undefined)
      setStore("followupSentMessageIDs", input.sessionID, (ids) =>
        ids?.includes(messageID) ? ids : [...(ids ?? []), messageID],
      )
      const manualSteerActive = followupShouldUseSteer({
        manual: input.manual,
        manualSteerDraft: item.manualSteer,
        targetTurnID,
        targetPending,
        source: input.source,
        inferredBusy: busy(input.sessionID),
        statusBusy: sessionStatusBusy(input.sessionID),
        pendingManualSteer: previousManualSteerPending !== undefined,
        compacting: sessionCompacting(input.sessionID),
      })
      // 只有实际走 steer 协议的请求才建立持久化顺序锁；空闲 Dock 发送仍按普通新回合跟踪。
      const manualSteerTracked = followupShouldStoreManualSteer({
        manual: manualSteerActive,
        inferredBusy: busy(input.sessionID),
        statusBusy: sessionStatusBusy(input.sessionID),
      })
      // 官方客户端会在 expected turn 失配后改绑一次；用可变结果盒保存最终目标和是否降级为普通新回合。
      const steerOutcome = {
        mode: manualSteerActive ? ("steer" as const) : ("prompt" as const),
        targetTurnID,
        item: sentItem,
      } as {
        mode: "steer" | "prompt"
        targetTurnID?: string
        item: FollowupItem
      }
      // 停止后的第一条显式 Dock 发送属于新活动；分类时沿用停止态，分类完成后立即解除本地 idle 抑制。
      setStore("abortingSessions", input.sessionID, undefined)
      setStore("followupSuggestionSuppressed", input.sessionID, true)
      const startedAt = Date.now()
      if (manualSteerTracked) {
        // 每条顺序锁先于网络请求建立，避免 session 短暂 idle 时普通输入越过任何一条引导。
        setFollowupHere("manualSteerPending", input.sessionID, (pending) => [
          ...manualSteerPendingList(pending).filter((entry) => entry.messageID !== messageID),
          { messageID, startedAt, targetTurnID, recovery: { item: sentItem, index } },
        ])
      } else setStore("followupAwaiting", input.sessionID, { messageID, startedAt })
      setFollowupHere("items", input.sessionID, (current) => (current ?? []).filter((entry) => entry.id !== input.id))
      const result = await sendFollowupDraft({
        client,
        sync,
        globalSync,
        draft,
        messageID,
        // 手动引导也走正常 prompt/loop；后端会等待同一条消息完成，不能再用 noReply 触发第二次发送。
        optimisticBusy: true,
        // 命令分类也绑定目标目录，切页后不能用新目录的 slash command 表重解释旧草稿。
        commands: [...globalSync.child(directory, { bootstrap: false })[0].command],
        language: language.intl(),
        translateContent: settings.general.translateContent(),
        steer: manualSteerActive,
        targetTurnID,
        optimisticTargetTurnID: item.optimisticTurnID,
        waitForSteerTarget: targetPending ? () => waitForManualSteerTarget(input.sessionID, messageID) : undefined,
        // 页面重挂或停止后，发送链内部的 mismatch/fallback 也必须立即失效，不能复活旧 optimistic 气泡。
        canContinue: requestCanWrite,
        signal: (() => {
          // 同一会话只有一条提交 claim；控制器让停止操作能立即结束 ACK 等待并释放该 claim。
          const controller = new AbortController()
          followupRequestControllers.set(lifecycleKey, controller)
          return controller.signal
        })(),
        // 官方只在本地主机兼容 NoActiveTurn 文本；远程连接必须返回 SteerTurnInactiveError。
        localHost: !!server.isLocal(),
        onSteerRetarget: (actualTurnID) => {
          steerOutcome.targetTurnID = actualTurnID
          steerOutcome.item = { ...steerOutcome.item, targetTurnID: actualTurnID }
          // 停止或页面重挂后，迟到 mismatch 只能更新请求自己的局部结果，不能重新建立已清理的持久化顺序锁。
          if (!requestCanWrite()) return
          // 同步更新顺序锁和失败恢复快照；第二条连续引导随后只能继续绑定这个服务端权威回合。
          clearManualSteerTargetWait(input.sessionID, messageID)
          setFollowupHere("manualSteerPending", input.sessionID, (pending) => {
            const next = manualSteerPendingList(pending)
            return next.map((entry) => {
              if (entry.messageID !== messageID) return entry
              return {
                ...entry,
                targetTurnID: actualTurnID,
                recovery: entry.recovery
                  ? { ...entry.recovery, item: { ...entry.recovery.item, targetTurnID: actualTurnID } }
                  : undefined,
              }
            })
          })
        },
        onSteerFallback: () => {
          steerOutcome.mode = "prompt"
          steerOutcome.targetTurnID = undefined
          steerOutcome.item = downgradeFollowupSteerToQueue(steerOutcome.item)
          // 停止或新页面接管后，旧请求不得用迟到 fallback 回调覆盖暂停队列与新页面的停止状态。
          if (!requestCanWrite()) return
          // 原回合确实结束时立即切换普通跟踪；在普通 start-turn ACK 返回前仍保留降级后的 recovery，
          // 这样停止或页面重载时可以恢复同一 messageID，而不会丢失用户刚提交的草稿。
          clearManualSteerTargetWait(input.sessionID, messageID)
          setFollowupHere("manualSteerPending", input.sessionID, (pending) =>
            manualSteerPendingList(pending).map((entry) => {
              if (entry.messageID !== messageID) return entry
              return {
                ...entry,
                targetTurnID: undefined,
                fallback: true,
                recovery: entry.recovery ? { ...entry.recovery, item: steerOutcome.item } : undefined,
              }
            }),
          )
          setStore("followupAwaiting", input.sessionID, { messageID, startedAt })
        },
        preflight: async () => {
          // 首次预检与真正发网之间仍可能切换审批模式；落请求前先刷新权限，再复核发起目录的真实状态。
          await permission.flush()
          const runtime = manualSteerRuntime(directory, input.sessionID)
          const working = followupSendGateWorking({
            inferredBusy: runtime.inferredBusy,
            statusBusy: runtime.statusBusy,
            followupReady: followupReadyHere(),
            // 当前消息自己的锁已在预检前建立；这里只查找其它锁，确保更早 steer 仍能阻止后续请求越序。
            // 会话 claim 已保证请求串行；这里只拦截尚未 ACK 的旧请求，不能让“等待回复”阻断后续 steer。
            pendingMessageID: manualSteerSendBlocker(
              manualSteerPendingList(followupHere.manualSteerPending?.[input.sessionID]),
              messageID,
            ),
            sendingMessageID: messageID,
            allowActiveTurn: manualSteerActive,
          })
          if (
            followupSendGateOpen({
              lifecycleOwned: ownsFollowupLifecycle(lifecycleKey),
              paused: !!followupHere.paused[input.sessionID],
              // 停止完成后的恢复项允许穿过全局暂停闸；普通排队项仍然必须等待用户显式发送。
              resumeAfterAbort: input.resumeAfterAbort === true,
              draftGeneration: abortEpoch,
              currentGeneration: followupAbortEpoch(directory, input.sessionID),
              working,
            })
          )
            return
          // 统一用 AbortError 结束失效发送；外层只做恢复/清理，不会误判成 inactive steer 再启动新回合。
          throw Object.assign(new Error("Follow-up send gate closed"), { name: "AbortError" })
        },
      })
        .then((ok) => ({ ok, acknowledgedAt: ok ? Date.now() : undefined, error: undefined }))
        .catch(async (err) => {
          const timeout = err instanceof Error && err.name === "TimeoutError"
          const aborted = err instanceof Error && err.name === "AbortError"
          if (isTransportError(err) || timeout || aborted) {
            // 网络响应丢失不等于服务端未落库；普通队列和 fallback 认同 ID 的普通 user，steer 还需核对完整 marker。
            const readMessage = client.session.message
            if (typeof readMessage !== "function") return { ok: false, acknowledgedAt: undefined, error: err }
            const confirmed = await confirmFollowupMessagePersisted({
              // 主动停止只留一个短确认窗：足以识别“已提交但 ACK 丢失”，又不会让真正未 ACK 的恢复项等待常规 3 秒。
              timeoutMs: aborted ? 500 : undefined,
              read: (signal) =>
                readMessage({ sessionID: input.sessionID, messageID }, { signal }).then((response) => {
                  if (steerOutcome.mode === "prompt") {
                    return followupPromptMessageMatches({ message: response.data?.info, messageID })
                  }
                  if (!steerOutcome.targetTurnID) return false
                  return manualSteerMessageMatchesTarget({
                    message: response.data?.info,
                    parts: response.data?.parts,
                    messageID,
                    targetTurnID: steerOutcome.targetTurnID,
                  })
                }),
            })
            if (confirmed) {
              // sync.session.sync 绑定当前目录；后台会话依赖服务端事件同步，不能误刷新用户正在看的另一个目录。
              if (directory === sdk.directory)
                void sync.session.sync(input.sessionID, { force: true }).catch(() => undefined)
              return { ok: true, acknowledgedAt: Date.now(), error: undefined }
            }
          }

          return { ok: false, acknowledgedAt: undefined, error: err }
        })
        .finally(() => followupRequestControllers.delete(lifecycleKey))
      // 官方只有一份 conversation state；当前页面失去所有权后，迟到 ACK 不得触碰旧 persisted store。
      if (!ownsFollowupLifecycle(lifecycleKey)) return
      if (result.ok) {
        // 对齐官方 queued follow-up：durable ACK 一成功就先移除已发送草稿。
        // 即使停止回调在等待期间临时恢复了同一项，也不能让后面的代次检查把它遗留在队列中再次发送。
        setFollowupHere("items", input.sessionID, (current) =>
          followupsAfterSendAck(current ?? [], input.id, messageID, result.acknowledgedAt),
        )
        // 恢复项 durable ACK 后立即退出白名单；全局暂停继续拦住后面的普通排队消息。
        setStore("followupAbortResumeIDs", input.sessionID, (ids) => ids?.filter((id) => id !== input.id))
      }
      if (
        manualSteerTracked &&
        !followupPostAckCanTrack({
          paused: !!followupHere.paused[input.sessionID],
          draftGeneration: abortEpoch,
          currentGeneration: followupAbortEpoch(directory, input.sessionID),
        })
      ) {
        // 停止回调已经恢复 ACK 前草稿并清理 optimistic user；成功 ACK 早已在上方结算队列，失败则保持恢复项。
        if (!result.ok && steerOutcome.mode === "prompt") restore(steerOutcome.item)
        releaseAwaiting()
        releaseSentMessageID()
        releaseManualSteerPending()
        return
      }
      if (!result.ok) {
        if (manualSteerTracked) {
          // durable ACK 未确认时必须先撤销同 ID 气泡，再释放去重豁免并恢复草稿；反序会删掉草稿只留下幽灵消息。
          sync.session.optimistic.remove({
            directory,
            sessionID: input.sessionID,
            messageID,
          })
        }
        releaseAwaiting()
        releaseSentMessageID()
        releaseManualSteerPending()
        if (manualSteerTracked && steerOutcome.mode === "prompt") {
          // fallback 已经脱离旧活动回合；未能确证 ACK 时只能恢复成普通失败项，禁止再拿同 ID 调 steer。
          restore(downgradeFollowupSteerToQueue(steerOutcome.item))
          setFollowupHere("failed", input.sessionID, input.id)
          if (result.error) fail(result.error)
          return
        }
        if (manualSteerTracked && followupFailureIsStaleSteerTarget(result.error, { localHost: !!server.isLocal() })) {
          // 上面的停止代次检查已经排除了 interrupted；非中断 inactive 要按官方 turn/completed 语义
          // 保留同一 messageID 并恢复成普通队列，待会话空闲后自动启动新回合。
          restore(downgradeFollowupSteerToQueue(steerOutcome.item))
          setFollowupHere("failed", input.sessionID, undefined)
          return
        }
        if (
          followupRestoreShouldDowngradeSteer({
            manualSteerTracked,
            manualSteer: steerOutcome.item.manualSteer,
            messageID: steerOutcome.item.messageID,
          })
        ) {
          // 乐观气泡从未撤回，若直接 restore() 原样放回，去重 effect 会把它当成“时间线已有同文案消息”再次删除。
          unstageManualSteerOptimistic(steerOutcome.item)
          restore(downgradeFollowupSteerToQueue(steerOutcome.item))
        } else {
          restore()
        }
        // 最终发送闸关闭代表页面生命周期或运行态已经变化；草稿恢复后静默等待下一次合法发送，不标成用户请求失败。
        if (result.error instanceof Error && result.error.name === "AbortError") return
        if (followupFailureIsRetryableBusy(result.error) && !input.manual) return
        setFollowupHere("failed", input.sessionID, input.id)
        if (result.error) fail(result.error)
        return
      }

      if (manualSteerTracked && steerOutcome.mode === "prompt") {
        // inactive fallback 已经创建独立新 turn；释放旧 steer 锁并改用普通 awaiting，防止下一条队列越过它。
        releaseManualSteerPending()
        setStore("followupAwaiting", input.sessionID, { messageID, startedAt: result.acknowledgedAt ?? startedAt })
        if (input.manual && !autoScroll.userScrolled()) resumeScroll()
        return
      }

      if (manualSteerTracked) {
        setFollowupHere("manualSteerPending", input.sessionID, (pending) => [
          ...manualSteerPendingList(pending).filter((entry) => entry.messageID !== messageID),
          {
            messageID,
            // 顺序锁的宽限从 durable ACK 开始计算，不能把文件解析/网络延迟算进运行态超时。
            startedAt: manualSteerAcknowledgedAt({ requestedAt: startedAt, acknowledgedAt: result.acknowledgedAt }),
            targetTurnID: steerOutcome.targetTurnID,
            acknowledged: true,
            // 网络 ACK 与同步时间线之间仍可能断裂；保留恢复载荷，只有精确 marker/终态才能最终确认该 steer。
            recovery: manualSteerPendingList(pending).find((entry) => entry.messageID === messageID)?.recovery ?? {
              item: steerOutcome.item,
              index,
            },
          },
        ])
        if (input.manual && !autoScroll.userScrolled()) resumeScroll()
        return
      }
      if (input.manual && !autoScroll.userScrolled()) resumeScroll()
    },
  }))

  const followupBusy = (sessionID: string) => {
    // 注册表本身不是 Solid store；revision 让 ACK 释放后立即接力下一条引导。
    followupSendClaimRevision()
    return followupSendClaimRegistry.busy(sessionID)
  }

  const followupClaimMatchesPending = (sessionID: string, pending: ManualSteerPending) => {
    if (!followupBusy(sessionID)) return false
    const claimID = followupSendClaimRegistry.messageID(sessionID)
    // registry 记录本地队列 id，pending 记录网络 messageID；刷新时两者都可能是唯一可见身份，必须同时兼容。
    return claimID === pending.messageID || claimID === pending.recovery?.item.id
  }

  const sendingFollowup = createMemo(() => {
    const id = params.id
    if (!id) return
    if (!followupBusy(id)) return
    return followupSendClaimRegistry.messageID(id)
  })

  const followupAwaitingBlocksQueue = (sessionID: string) => {
    const awaiting = store.followupAwaiting[sessionID]
    if (!awaiting) return false

    const result = followupAwaitingResult(sync.data.message[sessionID] ?? [], awaiting.messageID, {
      startedAt: awaiting.startedAt,
      now: runStateNow(),
      partsByMessage: sync.data.part,
      sessionIdle: !busy(sessionID),
    })
    if (result.clearAwaiting) setStore("followupAwaiting", sessionID, undefined)
    if (result.pauseQueue) setFollowup("paused", sessionID, true)
    return result.blockAutoSend
  }

  createEffect(() => {
    const sessionID = params.id
    if (!sessionID || !followupReady() || !messagesReady()) return
    // ACK 后队列可能暂时为空；独立 effect 仍持续观察消息、状态和时间宽限，确保 awaiting 能在首包或超时后清理。
    followupAwaitingBlocksQueue(sessionID)
  })

  const queueEnabled = createMemo(() => {
    const id = params.id
    if (!id) return false
    // 接力窗口虽然 session 已 idle，但顺序锁尚未释放；这时新输入统一进入队列，
    // 避免 steer 模式下的普通提交抢在已确认引导之前执行。
    return (
      followupShouldQueueInput({
        queueingEnabled: settings.general.followup() === "queue",
        inferredBusy: busy(id),
        statusBusy: sessionStatusBusy(id),
        manualSteerWaiting: manualSteerWaiting(id),
        compacting: sessionCompacting(id),
      }) &&
      !composer.blocked() &&
      !isChildSession()
    )
  })

  const steerEnabled = createMemo(() => {
    const id = params.id
    if (!id) return false
    // 只有设置为 steer 且确有 active turn 时，直接回车才注入当前回合；空闲输入仍走普通提交。
    // 压缩进行中必须走队列而非 steer：否则乐观气泡会先插入，再被发送前置检查挡下却无法撤回。
    return (
      settings.general.followup() === "steer" &&
      (busy(id) || sessionStatusBusy(id) || !!currentManualSteerPending(id)) &&
      !sessionCompacting(id) &&
      !composer.blocked() &&
      !isChildSession()
    )
  })

  const followupText = (item: FollowupDraft) => {
    const text = item.prompt
      .map((part) => {
        if (part.type === "text") return part.content
        if (part.type === "plugin") return part.content
        if (part.type === "agent") return part.content || `@${part.name}`
        if (part.type === "file") return part.content
        if (part.type === "link" || part.type === "file-reference") return part.content
        return ""
      })
      .join("")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => !!line)

    if (text) return text
    const snippets = item.addToChatSnippets ?? []
    if (snippets.length > 0) {
      return language.t(
        snippets.length === 1 ? "session.addToChat.selectionCount.one" : "session.addToChat.selectionCount.other",
        { count: snippets.length },
      )
    }
    return `[${language.t("common.attachment")}]`
  }

  const followupIgnoredMessageIDs = (sessionID: string, currentMessageID?: string) => {
    const sent = store.followupSentMessageIDs[sessionID] ?? []
    const awaiting = store.followupAwaiting[sessionID]?.messageID
    // 发送前复核必须显式忽略当前 steer；即使响应式登记尚未传播，也不能让 optimistic user 把自己判成重复消息。
    const ignored = [...sent, ...(awaiting ? [awaiting] : []), ...(currentMessageID ? [currentMessageID] : [])]
    if (ignored.length === 0) return undefined
    return new Set(ignored)
  }

  const visibleFollowups = createMemo(() => {
    const id = params.id
    if (!id) return emptyFollowups
    return unsentFollowupDrafts({
      drafts: queuedFollowups(),
      draftText: followupText,
      afterMessageID: (item) => item.afterMessageID,
      afterMessageCreated: (item) => item.afterMessageCreated,
      messages: sync.data.message[id] ?? [],
      partsByMessage: sync.data.part,
      ignoredMessageIDs: followupIgnoredMessageIDs(id),
    })
  })

  createEffect(() => {
    const id = params.id
    if (!id) return
    const items = followup.items[id] ?? []
    if (items.length === 0) return
    const next = unsentFollowupDrafts({
      drafts: items,
      draftText: followupText,
      afterMessageID: (item) => item.afterMessageID,
      afterMessageCreated: (item) => item.afterMessageCreated,
      messages: sync.data.message[id] ?? [],
      partsByMessage: sync.data.part,
      ignoredMessageIDs: followupIgnoredMessageIDs(id),
    })
    if (next.length === items.length) return
    setFollowup("items", id, next)
    setFollowup("failed", id, (value) => (value && next.some((item) => item.id === value) ? value : undefined))
    setFollowup("edit", id, (value) => (value && next.some((item) => item.id === value.id) ? value : undefined))
  })

  const enqueueFollowup = (
    draft: FollowupDraft,
    options?: {
      manualSteer?: boolean
      targetTurnID?: string
      targetTurnStartedAt?: number
      messageID?: string
      optimisticTurnID?: string
    },
  ) => {
    const data =
      draft.sessionDirectory === sdk.directory
        ? sync.data
        : globalSync.child(draft.sessionDirectory, { bootstrap: false })[0]
    const [, setFollowupHere] = followupForDirectory(draft.sessionDirectory)
    const messages = data.message[draft.sessionID] ?? []
    const boundaryMessage = messages.at(-1)
    const afterMessageID = boundaryMessage?.id
    const afterMessageCreated = boundaryMessage?.time.created
    // 状态事件抖动时，同一个用户输入可能先作为正常消息落库，又被误判成 follow-up。
    // 入队前只检查当前边界之后的可见文本，避免历史里相同文案把新的排队消息吞掉。
    if (
      followupDraftAlreadySent({
        draftText: followupText(draft),
        afterMessageID,
        afterMessageCreated,
        messages,
        partsByMessage: data.part,
        // 正在发送的队列项会先写入 optimistic user；必须忽略这些已认领消息，才能保留用户有意连续发送的同文案。
        ignoredMessageIDs: followupIgnoredMessageIDs(draft.sessionID),
      })
    )
      return

    const id = Identifier.ascending("message")
    setFollowupHere("items", draft.sessionID, (items) => [
      ...(items ?? []),
      // 普通队列延迟生成网络 ID；手动引导则在用户提交瞬间固定 ID，才能像官方一样先追加 optimistic item 再等 turnID。
      {
        id,
        afterMessageID,
        ...(afterMessageCreated === undefined ? {} : { afterMessageCreated }),
        ...draft,
        ...(options?.messageID ? { messageID: options.messageID } : {}),
        ...(options?.manualSteer ? { manualSteer: true } : {}),
        ...(options?.targetTurnID ? { targetTurnID: options.targetTurnID } : {}),
        ...(options?.targetTurnStartedAt !== undefined ? { targetTurnStartedAt: options.targetTurnStartedAt } : {}),
        ...(options?.optimisticTurnID ? { optimisticTurnID: options.optimisticTurnID } : {}),
      },
    ])
    setFollowupHere("failed", draft.sessionID, undefined)
    setFollowupHere("paused", draft.sessionID, undefined)
    return id
  }

  const queueFollowup = (draft: FollowupDraft) => {
    enqueueFollowup(draft)
  }

  const stageManualSteerOptimistic = (item: FollowupItem) => {
    if (!item.messageID) return
    const optimistic = buildFollowupOptimisticUser({
      draft: item,
      messageID: item.messageID,
      steerTargetTurnID: item.targetTurnID ?? item.optimisticTurnID,
    })
    batch(() => {
      // 先登记网络身份再插入 optimistic user；插入会同步触发队列去重，反序会在 POST /steer 前误删当前引导。
      setStore("followupSentMessageIDs", item.sessionID, (ids) =>
        ids?.includes(item.messageID!) ? ids : [...(ids ?? []), item.messageID!],
      )
      // 官方 l9 在 await rfe 前立即 push；原子提交让去重 effect 只能看见“气泡与豁免 ID 同时存在”的完整状态。
      sync.session.optimistic.add({
        directory: item.sessionDirectory,
        sessionID: item.sessionID,
        message: optimistic.message,
        parts: optimistic.parts,
      })
    })
  }

  const unstageManualSteerOptimistic = (item: FollowupItem) => {
    if (!item.messageID) return
    clearManualSteerTargetWait(item.sessionID, item.messageID)
    sync.session.optimistic.remove({
      directory: item.sessionDirectory,
      sessionID: item.sessionID,
      messageID: item.messageID,
    })
    setStore("followupSentMessageIDs", item.sessionID, (ids) => ids?.filter((id) => id !== item.messageID))
  }

  const followupDock = createMemo(() =>
    visibleFollowups()
      // 已经作为 steering item 出现在时间线的草稿不再重复显示在 Dock；失败恢复后 transient ID 释放，会重新出现供用户处理。
      .filter(
        (item) =>
          item.manualSteer !== true ||
          !item.messageID ||
          !(store.followupSentMessageIDs[item.sessionID] ?? []).includes(item.messageID),
      )
      .map((item) => ({
        id: item.id,
        text: followupText(item),
        // command API 不能加入 active turn；忙态 Dock 隐藏“立即发送”，等空闲后再按普通命令执行。
        canSteer: !resolveFollowupSlashCommand(item, sync.data.command),
        // 压缩会重写会话历史，禁用引导按钮但保持可见，避免用户在压缩完成前误触发。
        steerDisabledReason: sessionCompacting(item.sessionID)
          ? language.t("session.followupDock.sendNowCompacting")
          : undefined,
      })),
  )

  const followupMode = createMemo(() => {
    const id = params.id
    if (!id) return "ready" as const
    return followupDockMode({
      // 服务端仍忙或引导接力期间都按排队态展示，避免前端推导态短暂失效时闪成“可立即发送”。
      busy: busy(id) || sessionStatusBusy(id) || manualSteerWaiting(id),
      paused: !!followup.paused[id],
      failed: visibleFollowups().some((item) => item.id === followup.failed[id]),
    })
  })
  const sendFollowup = (
    sessionID: string,
    id: string,
    opts?: { directory?: string; manual?: boolean; source?: "automatic" | "dock" },
  ) => {
    const directory = opts?.directory ?? sdk.directory
    const data = directory === sdk.directory ? sync.data : globalSync.child(directory, { bootstrap: false })[0]
    const [followupHere, setFollowupHere] = followupForDirectory(directory)
    // 官方 direct composer 与 queued SendNow 虽使用不同锁，语义都只允许同一会话有一个提交请求；重复触发静默交给 ACK 后的 effect。
    if (followupSendClaimRegistry.busy(sessionID)) return Promise.resolve()
    if (data.session.find((session) => session.id === sessionID)?.parentID) return Promise.resolve()
    const item = (followupHere.items[sessionID] ?? []).find((entry) => entry.id === id)
    if (!item) return Promise.resolve()
    // 停止 RPC 尚未完成时不能抢先启动恢复项；完成回调会清掉该闸并重新触发队列 effect。
    if (store.abortingSessions[sessionID]) return Promise.resolve()
    const resumeAfterAbort = (store.followupAbortResumeIDs[sessionID] ?? []).includes(item.id)
    // 用户操作和自动接力都由当前页面显式接管；mutation 随后只认这一个 owner，页面重挂会让旧请求失去写权限。
    activateFollowupLifecycleOwner(directory, sessionID)
    // 普通输入必须等待上一条 steer；新的引导只先进入时间线，真正发网同样服从会话级 ACK 单飞。
    if (!opts?.manual && manualSteerWaiting(sessionID)) {
      return Promise.resolve()
    }
    if (followupBusy(sessionID)) return Promise.resolve()
    if (!opts?.manual && followupShouldBlockSend({ manual: false, awaitingBlocked: followupAwaitingBlocksQueue(sessionID) }))
      return Promise.resolve()
    // 队列项可能是在历史消息同步前入队的；真正发送前必须再按最新历史复核一次。
    // 否则同一句用户输入会先显示为 steer,随后又被队列自动发送成一轮新请求。
    if (
      followupDraftAlreadySent({
        draftText: followupText(item),
        afterMessageID: item.afterMessageID,
        afterMessageCreated: item.afterMessageCreated,
        messages: data.message[sessionID] ?? [],
        partsByMessage: data.part,
        // 手动引导在发网前已经按官方逻辑出现在时间线；去重必须忽略它自己的稳定 messageID。
        ignoredMessageIDs: followupIgnoredMessageIDs(sessionID, item.manualSteer === true ? item.messageID : undefined),
      })
    ) {
      setFollowupHere("items", sessionID, (items) => (items ?? []).filter((entry) => entry.id !== id))
      setFollowupHere("failed", sessionID, (value) => (value === id ? undefined : value))
      setFollowupHere("edit", sessionID, (value) => (value?.id === id ? undefined : value))
      setStore("followupAbortResumeIDs", sessionID, (ids) => ids?.filter((entry) => entry !== id))
      return Promise.resolve()
    }

    // 认领必须在调用 mutateAsync 前同步建立；失败项由 failed 标记拦截，成功 ACK 则唤醒下一条 steer。
    if (!followupSendClaimRegistry.claim(sessionID, id)) return Promise.resolve()
    return followupMutation
      .mutateAsync({ directory, sessionID, id, manual: opts?.manual, source: opts?.source, resumeAfterAbort })
      .finally(() => followupSendClaimRegistry.release(sessionID, id))
  }

  const steerFollowup = async (draft: FollowupDraft) => {
    // 直接回车时快照目标；后续状态切换只能影响新意图，不能改变这条草稿的绑定。
    const runtime = manualSteerRuntime(draft.sessionDirectory, draft.sessionID)
    const targetTurnID = currentManualSteerTargetTurnID(draft.sessionID, draft.sessionDirectory)
    const targetTurnStartedAt = runtime.startedAt
    const messageID = Identifier.ascending("message")
    const optimisticTurnID = runtime.turnGroupID
    if (!targetTurnID)
      markManualSteerTargetWait(draft.sessionID, messageID, {
        directory: draft.sessionDirectory,
        requestedAt: Date.now(),
        startedAt: targetTurnStartedAt,
        expectedTurnGroupID: optimisticTurnID,
        originInProgressObserved: runtime.inferredBusy || runtime.statusBusy,
      })
    const id = enqueueFollowup(draft, {
      manualSteer: true,
      targetTurnID,
      targetTurnStartedAt,
      messageID,
      optimisticTurnID,
    })
    if (!id) {
      clearManualSteerTargetWait(draft.sessionID, messageID)
      return
    }
    const [followupHere] = followupForDirectory(draft.sessionDirectory)
    const item = (followupHere.items[draft.sessionID] ?? []).find((entry) => entry.id === id)
    if (!item) return
    stageManualSteerOptimistic(item)
    // 失败/停止恢复的旧 steer 仍在前面时必须先发送旧项；若会话正在提交，ACK 后的 effect 会继续队首。
    const next = nextFollowupToSend(followupHere.items[draft.sessionID] ?? [], { paused: false })
    if (!next || next.manualSteer !== true) return
    // 直接 composer 的提交 Promise 必须覆盖 durable ACK，和官方 Qa.current 的生命周期保持一致。
    await sendFollowup(draft.sessionID, next.id, {
      directory: draft.sessionDirectory,
      manual: true,
      source: "automatic",
    })
  }

  const promoteFollowupToSteer = (sessionID: string, id: string) => {
    // 第二层防线：禁用态只是 UI 展示，压缩期间必须在函数入口就短路，
    // 否则乐观气泡插入后会被发送前置检查的 AbortError 挡下却不会 unstage，留下鬼气泡。
    if (sessionCompacting(sessionID)) return
    const selected = (followup.items[sessionID] ?? []).find((item) => item.id === id)
    if (!selected) return
    const command = resolveFollowupSlashCommand(selected, sync.data.command)
    if (command) {
      // slash command 只在完全空闲时按普通请求发送，绝不伪装成 steer 注入当前回合。
      if (busy(sessionID) || sessionStatusBusy(sessionID) || manualSteerWaiting(sessionID)) return
      setFollowup("failed", sessionID, undefined)
      setFollowup("paused", sessionID, undefined)
      void sendFollowup(sessionID, id, { manual: false, source: "dock" })
      return
    }
    const currentModel = local.model.current()
    const currentAgent = local.agent.current()
    const current =
      currentModel && currentAgent
        ? {
            agent: currentAgent.name,
            model: { providerID: currentModel.provider.id, modelID: currentModel.id },
            variant: local.model.variant.current(),
          }
        : undefined
    // 已绑定草稿的重试必须复用原目标；首次点击则优先沿用当前 pending，再读取权威 session.status。
    const targetTurnID = selected.targetTurnID ?? currentManualSteerTargetTurnID(sessionID)
    if (!targetTurnID) {
      const activeWithoutTarget = busy(sessionID) || sessionStatusBusy(sessionID) || manualSteerWaiting(sessionID)
      setFollowup("failed", sessionID, undefined)
      setFollowup("paused", sessionID, undefined)
      // 真正空闲时 Dock 按钮仍是普通发送；只有仍属于当前活动代次时，缺 turnID 的点击才进入官方式等待。
      if (!activeWithoutTarget) {
        void sendFollowup(sessionID, id, { manual: false, source: "dock" })
        return
      }
    }
    const messageID = selected.messageID ?? Identifier.ascending("message")
    const optimisticTurnID = selected.optimisticTurnID ?? currentManualSteerTurnGroupID(sessionID)
    const targetTurnStartedAt =
      selected.targetTurnStartedAt ?? sessionActiveTurnStartedAt(sync.data.session_status[sessionID])
    if (!targetTurnID)
      markManualSteerTargetWait(sessionID, messageID, {
        directory: selected.sessionDirectory,
        requestedAt: Date.now(),
        startedAt: targetTurnStartedAt,
        expectedTurnGroupID: optimisticTurnID,
        originInProgressObserved: busy(sessionID) || sessionStatusBusy(sessionID),
      })
    // Dock 点击会把普通项提升为 steer；已有 steer 保持顺序，普通队列整体后移。
    setFollowup("items", sessionID, (items) => {
      const prepared = (items ?? []).map((item) =>
        item.id === id ? { ...item, messageID, optimisticTurnID, targetTurnStartedAt } : item,
      )
      return promoteFollowupDraftToSteer({ items: prepared, id, targetTurnID, current })
    })
    setFollowup("failed", sessionID, undefined)
    setFollowup("paused", sessionID, undefined)
    const promoted = (followup.items[sessionID] ?? []).find((item) => item.id === id)
    if (promoted) stageManualSteerOptimistic(promoted)
    // 提升只改变队列优先级；真正发送仍从最早的 steer 取，会话锁保证连续点击按 durable ACK 严格串行。
    const next = nextFollowupToSend(followup.items[sessionID] ?? [], { paused: false })
    if (!next || next.manualSteer !== true) return
    void sendFollowup(sessionID, next.id, {
      manual: true,
      source: next.id === id ? "dock" : "automatic",
    })
  }

  const editFollowup = (id: string) => {
    const sessionID = params.id
    if (!sessionID) return
    if (followupBusy(sessionID)) return

    const item = visibleFollowups().find((entry) => entry.id === id)
    if (!item) return

    if (item.manualSteer === true) unstageManualSteerOptimistic(item)
    setFollowup("items", sessionID, (items) => (items ?? []).filter((entry) => entry.id !== id))
    setFollowup("failed", sessionID, (value) => (value === id ? undefined : value))
    setFollowup("edit", sessionID, {
      id: item.id,
      prompt: item.prompt,
      context: item.context,
      addToChatSnippets: item.addToChatSnippets,
    })
  }

  const deleteFollowup = (id: string) => {
    const sessionID = params.id
    if (!sessionID) return
    if (sendingFollowup() === id) return

    const item = (followup.items[sessionID] ?? []).find((entry) => entry.id === id)
    if (item?.manualSteer === true) unstageManualSteerOptimistic(item)
    setFollowup("items", sessionID, (items) => (items ?? []).filter((entry) => entry.id !== id))
    setFollowup("failed", sessionID, (value) => (value === id ? undefined : value))
    setFollowup("edit", sessionID, (value) => (value?.id === id ? undefined : value))
  }

  const reorderFollowups = (ids: string[]) => {
    const sessionID = params.id
    if (!sessionID) return
    const byID = new Map((followup.items[sessionID] ?? []).map((item) => [item.id, item]))
    const next = ids.map((id) => byID.get(id)).filter((item): item is FollowupItem => !!item)
    if (next.length === 0) return
    const seen = new Set(next.map((item) => item.id))
    setFollowup("items", sessionID, [
      ...next,
      ...(followup.items[sessionID] ?? []).filter((item) => !seen.has(item.id)),
    ])
  }

  const clearFollowupEdit = () => {
    const id = params.id
    if (!id) return
    setFollowup("edit", id, undefined)
  }

  const halt = (sessionID: string) => {
    if (!busy(sessionID)) return Promise.resolve()
    // 必须在乐观 idle 删除活动身份前快照 turnID；否则停止会退化成无目标 abort，无法精确结算卡住回合。
    const turnID = sessionActiveTurnID(sync.data.session_status[sessionID])
    // 停止是用户的显式操作；先乐观清掉本地 busy，避免 abort 请求/事件同步期间停止按钮还能重复点击。
    setStore("abortingSessions", sessionID, true)
    sync.set("session_status", sessionID, { type: "idle" })
    // 停止请求绑定当前活动回合；旧页面的迟到点击到达服务端后会被安全忽略。
    return sdk.client.session.abort({ sessionID, turnID }).catch(() => {})
  }

  const editMessage = async (input: { sessionID: string; messageID: string; newText: string }) => {
    if (busy(input.sessionID)) return

    const msgs = sync.data.message[input.sessionID] ?? []
    const msgIdx = msgs.findIndex((m) => m.id === input.messageID)
    if (msgIdx < 0) return
    // 编辑是否需要先 revert 只看真实时间线位置，消息 ID 不再承担先后语义。
    const hasLaterMessages = msgIdx < msgs.length - 1
    const last = info()?.revert

    await runEditMessageSubmit({
      sessionID: input.sessionID,
      messageID: input.messageID,
      hasLaterMessages,
      previousRevert: last,
      preflight: permission.flush,
      busy: () => busy(input.sessionID),
      setBusy: (value) => sync.set("session_status", input.sessionID, { type: value ? "busy" : "idle" }),
      setLocalRevert: (revert) => roll(input.sessionID, revert),
      revert: (messageID) =>
        sdk.client.session.revert({ sessionID: input.sessionID, messageID }).then(() => undefined),
      unrevert: () => sdk.client.session.unrevert({ sessionID: input.sessionID }).then(() => undefined),
      send: async () => {
        const currentModel = local.model.current()
        const currentAgent = local.agent.current()
        const original = restoreEditorFromUserParts(sync.data.part[input.messageID] ?? [], {
          directory: sdk.directory,
          attachmentName: language.t("common.attachment"),
        })
        const nextText = input.newText.trim()
        const { requestParts } = buildRequestParts({
          prompt: [
            { type: "text", content: nextText, start: 0, end: nextText.length },
            ...original.prompt.filter((part) => part.type === "image" || part.type === "file"),
          ],
          context: [],
          images: original.prompt.filter((part) => part.type === "image"),
          text: nextText,
          sessionID: input.sessionID,
          messageID: Identifier.ascending("message"),
          sessionDirectory: sdk.directory,
        })

        await sdk.client.session.promptAsync({
          sessionID: input.sessionID,
          parts: requestParts,
          model: currentModel ? { providerID: currentModel.provider.id, modelID: currentModel.id } : undefined,
          agent: currentAgent?.name,
          variant: local.model.variant.current(),
          language: language.intl(),
          translateContent: settings.general.translateContent(),
        })
      },
      fail,
    })
  }

  const revertMutation = useMutation(() => ({
    mutationFn: async (input: { sessionID: string; messageID: string }) => {
      const prev = prompt.current().slice()
      const prevSnippets = prompt.addToChat.snippets()
      const last = info()?.revert
      const restored = restoreEditorFromUserParts(sync.data.part[input.messageID] ?? [], {
        directory: sdk.directory,
        attachmentName: language.t("common.attachment"),
      })
      batch(() => {
        roll(input.sessionID, { messageID: input.messageID })
        prompt.set(restored.prompt)
        prompt.addToChat.replace(restored.addToChatSnippets)
      })
      await halt(input.sessionID)
        .then(() => sdk.client.session.revert(input))
        .then((result) => {
          if (result.data) merge(result.data)
        })
        .catch((err) => {
          batch(() => {
            roll(input.sessionID, last)
            prompt.set(prev)
            prompt.addToChat.replace(prevSnippets)
          })
          fail(err)
        })
    },
  }))

  const restoreMutation = useMutation(() => ({
    mutationFn: async (id: string) => {
      const sessionID = params.id
      if (!sessionID) return

      const current = userMessages().findIndex((item) => item.id === id)
      // “再前进一步”沿服务端用户消息顺序取下一项；消息 ID 只负责身份，不承担时间比较。
      const next = current >= 0 ? userMessages()[current + 1] : userMessages().find((item) => item.id > id)
      const prev = prompt.current().slice()
      const prevSnippets = prompt.addToChat.snippets()
      const last = info()?.revert

      batch(() => {
        roll(sessionID, next ? { messageID: next.id } : undefined)
        if (next) {
          const restored = restoreEditorFromUserParts(sync.data.part[next.id] ?? [], {
            directory: sdk.directory,
            attachmentName: language.t("common.attachment"),
          })
          prompt.set(restored.prompt)
          prompt.addToChat.replace(restored.addToChatSnippets)
          return
        }
        prompt.reset()
      })

      const task = !next
        ? halt(sessionID).then(() => sdk.client.session.unrevert({ sessionID }))
        : halt(sessionID).then(() =>
            sdk.client.session.revert({
              sessionID,
              messageID: next.id,
            }),
          )

      await task
        .then((result) => {
          if (result.data) merge(result.data)
        })
        .catch((err) => {
          batch(() => {
            roll(sessionID, last)
            prompt.set(prev)
            prompt.addToChat.replace(prevSnippets)
          })
          fail(err)
        })
    },
  }))

  const reverting = createMemo(() => revertMutation.isPending || restoreMutation.isPending)
  const restoring = createMemo(() => (restoreMutation.isPending ? restoreMutation.variables : undefined))

  const revert = (input: { sessionID: string; messageID: string }) => {
    if (reverting()) return
    return revertMutation.mutateAsync(input)
  }

  const restore = (id: string) => {
    if (!params.id || reverting()) return
    return restoreMutation.mutateAsync(id)
  }

  const rolled = createMemo(() => {
    const id = revertMessageID()
    if (!id) return []
    const cutoff = userMessages().findIndex((item) => item.id === id)
    // 已回退列表与 restoreMutation 使用同一位置水位，确保按钮顺序和实际恢复目标完全一致。
    const messages = cutoff >= 0 ? userMessages().slice(cutoff) : userMessages().filter((item) => item.id >= id)
    return messages.map((item) => ({ id: item.id, text: line(item.id) }))
  })

  const absolutePath = (file: string) => (sdk.directory ? resolveWorkspaceFilePath(sdk.directory, file) : file)
  const parentDirOf = (file: string) => {
    const abs = absolutePath(file)
    const parent = getDirectory(abs)
    return parent || abs
  }
  const terminalApp = () => (platform.os === "windows" ? "wt.exe" : "Terminal")
  const terminalLabel = () => (platform.os === "windows" ? "Windows Terminal" : "Terminal")

  const editSummaryOpeners = createMemo<EditSummaryOpener[]>(() => {
    if (platform.platform !== "desktop") return []
    if (!platform.openPath) return []
    const items: EditSummaryOpener[] = []

    items.push({
      id: "cursor",
      label: "Cursor",
      icon: () => <AppIcon id="cursor" alt="" class="size-4" />,
      onSelect: (file) => void platform.openPath?.(absolutePath(file), "Cursor"),
    })

    items.push({
      id: "default",
      label: language.t("session.openWith.defaultApp"),
      icon: () => <Icon name="open-file" size="small" />,
      onSelect: (file) => void platform.openPath?.(absolutePath(file)),
    })

    items.push({
      id: "terminal",
      label: terminalLabel(),
      icon: () => <AppIcon id={platform.os === "windows" ? "powershell" : "terminal"} alt="" class="size-4" />,
      onSelect: (file) => void platform.openPath?.(parentDirOf(file), terminalApp()),
    })

    const fm = fileManagerInfo(platform.os)
    items.push({
      id: "reveal-in-folder",
      label: language.t("session.openWith.revealInFolder"),
      icon: () => <AppIcon id={fm.iconId} alt="" class="size-4" />,
      onSelect: (file) => void platform.openPath?.(parentDirOf(file)),
    })

    return items
  })

  // 顶部「在编辑器中打开」下拉的候选项：从主进程动态扫描已安装的编辑器/终端
  // （macOS 走 Info.plist；Windows 走注册表；Linux 走 which）。
  // source 是 constant true → resource 仅挂载时跑一次；用 refetch 在下拉打开时刷新，
  // 配合主进程 60s 缓存：快速反复打开走缓存，跨 60s 重开会重新扫描。
  const [projectOpeners, { refetch: refetchOpeners }] = createResource<InstalledOpener[], boolean>(
    () => platform.platform === "desktop" && typeof platform.listInstalledOpeners === "function",
    async (enabled) => {
      if (!enabled) return []
      return (await platform.listInstalledOpeners?.()) ?? []
    },
  )
  const orderedProjectOpeners = createMemo(() => orderOpenersByDefaultEditor(projectOpeners() ?? []))
  const defaultProjectEditor = createMemo(() => getDefaultEditorOpener(projectOpeners() ?? []))
  const defaultProjectEditorIcon = createMemo(() => {
    const item = defaultProjectEditor()
    if (!item) return { type: "app" as const, id: "vscode" as const }
    const override = knownOpenerOverride({ bundleId: item.bundleId, app: item.app, name: item.name })
    if (override.iconId) return { type: "app" as const, id: override.iconId }
    if (item.iconDataUrl) return { type: "image" as const, src: item.iconDataUrl }
    return { type: "icon" as const }
  })

  /**
   * input.messageID 是用户点击的 assistant 消息 id。
   * SDK 的 fork API 语义为「克隆 < messageID 的所有消息」，所以为了把该 assistant 自身也包含进新会话，
   * 需要传「该 assistant 之后下一条消息的 id」；若该 assistant 已是最后一条消息，则不传 messageID（克隆全部）。
   */
  // input.messageID 是用户点击的 assistant 消息 id；fork API 的 messageID 需传该 assistant 之后下一条消息 id，新会话才会含此 assistant 自身。
  const computeNextMessageID = (sessionID: string, anchorMessageID: string) => {
    const msgs = sync.data.message[sessionID] ?? []
    const idx = msgs.findIndex((m) => m.id === anchorMessageID)
    return idx >= 0 && idx < msgs.length - 1 ? msgs[idx + 1]?.id : undefined
  }

  const performForkLocal = async (input: { sessionID: string; messageID: string }) => {
    const nextMessageID = computeNextMessageID(input.sessionID, input.messageID)
    const dir = base64Encode(sdk.directory)
    try {
      const forked = await sdk.client.session.fork({
        sessionID: input.sessionID,
        ...(nextMessageID ? { messageID: nextMessageID } : {}),
      })
      if (!forked.data) {
        showToast({ title: language.t("common.requestFailed") })
        return
      }
      navigate(`/${dir}/session/${forked.data.id}`)
    } catch (err) {
      // 用 resolveError 精确分类后端语义错误；返回 unknown 时 formatServerError 拆 SDK response body 兜底
      const forkResolved = resolveError(err)
      showToast({
        title: language.t("common.requestFailed"),
        description:
          forkResolved.category !== "unknown"
            ? language.t(forkResolved.messageKey as any)
            : formatServerError(err, language.t),
      })
    }
  }

  // 派生到新工作树：
  // 1. experimental.worktree.create 让后端 git worktree add + 注册 sandbox（boot 异步进行）
  // 2. WorktreeState.pending 标记，等会儿 wait 它的 Ready 事件
  // 3. session.fork(body_directory=newDir) 在新目录下建会话（DB 立即可见）
  // 4. 等待 worktree ready（或 30s 超时）确保 git reset --hard 等 checkout 完成，避免跳过去后文件系统还空着
  // 5. refresh 源项目 sidebar + 跳到新会话
  const performForkInWorktree = async (input: { sessionID: string; messageID: string }) => {
    // sdk.directory 可能本身就是一个 worktree（fork 自 fork 时），seed 必须按 project 主 worktree 目录定位
    const sourceInfo = sync.session.get(input.sessionID)
    const sourceProject = globalSync.data.project.find((p) => p.id === sourceInfo?.projectID)
    const sidebarDirectory = sourceProject?.worktree ?? sdk.directory
    const nextMessageID = computeNextMessageID(input.sessionID, input.messageID)
    let newDir: string | undefined
    let forkedSessionID: string | undefined
    let forkedSession: Session | undefined

    const cleanupWorktree = (directory: string, message: string) => {
      WorktreeState.failed(directory, message)
      void sdk.client.worktree.remove({ worktreeRemoveInput: { directory } }).catch(() => {})
    }

    const deleteForkedSession = (session: Pick<Session, "id" | "directory" | "projectID">) => {
      void sdk.client.session
        .delete({ sessionID: session.id, directory: session.directory })
        .then((response) => {
          if (!response.data) return
          removeSessionFromSidebar(globalSync, session)
        })
        .catch(() => {})
    }

    try {
      const created = await sdk.client.worktree.create({
        worktreeCreateInput: { branchPrefix: settings.git.branchPrefix() },
      })
      newDir = created.data?.directory
      if (!newDir) {
        showToast({ title: language.t("dialog.fork.worktree.createFailed") })
        return
      }
      WorktreeState.pending(newDir)
      const forked = await sdk.client.session.fork({
        sessionID: input.sessionID,
        ...(nextMessageID ? { messageID: nextMessageID } : {}),
        body_directory: newDir,
      })
      if (!forked.data) {
        cleanupWorktree(newDir, language.t("common.requestFailed"))
        showToast({ title: language.t("common.requestFailed") })
        return
      }
      forkedSessionID = forked.data.id
      forkedSession = forked.data
      // 等 worktree ready（boot 完成 git reset --hard 等）。超时上限 30s。
      const timeoutMs = 30 * 1000
      let timerId: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<{ status: "failed"; message: string }>((resolve) => {
        timerId = setTimeout(
          () => resolve({ status: "failed", message: language.t("dialog.fork.worktree.createFailed") }),
          timeoutMs,
        )
      })
      const result = await Promise.race([WorktreeState.wait(newDir), timeout]).finally(() => {
        if (timerId !== undefined) clearTimeout(timerId)
      })
      if (result.status === "failed") {
        // worktree boot 没起来：删除刚 fork 的 session、清掉 worktree 目录，避免 DB / 文件系统留半成品
        if (forkedSession) deleteForkedSession(forkedSession)
        cleanupWorktree(newDir, result.message)
        showToast({
          title: language.t("dialog.fork.worktree.createFailed"),
          description: result.message,
        })
        return
      }
      // 用项目主目录刷新 sidebar 的 sessions（scope:"project" 会把所有 worktree/sandbox 的 session 都拉回来）
      void globalSync.project.refreshSessions(sidebarDirectory).catch(() => {})
      navigate(`/${base64Encode(newDir)}/session/${forked.data.id}`)
    } catch (err) {
      if (newDir) {
        cleanupWorktree(newDir, language.t("dialog.fork.worktree.createFailed"))
        const projectID = sourceInfo?.projectID
        if (forkedSession) deleteForkedSession(forkedSession)
        else if (forkedSessionID && projectID)
          deleteForkedSession({ id: forkedSessionID, directory: newDir, projectID })
      }
      const forkWorktreeResolved = resolveError(err)
      showToast({
        title: language.t("dialog.fork.worktree.createFailed"),
        description:
          forkWorktreeResolved.category !== "unknown"
            ? language.t(forkWorktreeResolved.messageKey as any)
            : formatServerError(err, language.t),
      })
    }
  }

  const forkFromMessage = (input: { sessionID: string; messageID: string }) => {
    const msgs = sync.data.message[input.sessionID] ?? []
    const last = msgs.at(-1)
    // 全会话最后一条且为 assistant 时直接 fork；否则（包括 streaming 中尾部为 user 的情况）弹窗
    const isLastAssistant = last?.id === input.messageID && last.role === "assistant"
    if (isLastAssistant) {
      return performForkLocal(input)
    }
    void import("@/components/dialog-fork-from-message").then((x) => {
      dialog.show(() => (
        <x.DialogForkFromMessage
          onForkLocal={() => performForkLocal(input)}
          onForkWorktree={() => performForkInWorktree(input)}
        />
      ))
    })
  }

  // 复刻 Codex：返回会话当前目标 objective，用户消息文本与之相同时气泡下方显示「◎ 目标」常驻标识
  const goalObjectiveFor = (sessionID: string) => globalSync.data.session_goal[sessionID]?.objective

  // goal 达成行（memo 化：扫描只在依赖变化时跑一次，timeline 每行读 O(1)，避免每行全量扫消息+parts）
  const goalAchievedInfo = createMemo(() => {
    const goal = composer.goal()
    if (!goal || goal.status !== "complete") return undefined
    // 完成行绑定到「调用 update_goal complete 的那一轮」：找最后一条含该工具调用的
    // assistant 消息，取它前面最近的 user message 作为承载 turn；算不出回落到列表末尾
    const id = params.id
    const msgs = id ? (sync.data.message[id] ?? []) : []
    let afterMessageID: string | undefined
    outer: for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]
      if (m.role !== "assistant") continue
      const parts = sync.data.part[m.id] ?? []
      const hit = parts.some(
        (p) =>
          p.type === "tool" &&
          p.tool === "update_goal" &&
          (p.state as { input?: { status?: string } }).input?.status === "complete",
      )
      if (!hit) continue
      for (let j = i; j >= 0; j--) {
        if (msgs[j].role === "user") {
          afterMessageID = msgs[j].id
          break outer
        }
      }
      break
    }
    return { totalTime: formatElapsed(goal.timeUsedSeconds), afterMessageID }
  })

  // 跳转到购买套餐页面（应用内导航）。
  const openPurchasePage = () => {
    openUserCenterOverlay("purchase")
  }

  // 重试触发错误的原请求：复用 sendFollowupDraft 保持与正常发送链路一致
  // （file/image/agent/addToChatSnippets + 图片意图路由全部保留）。
  const retryUserTurn = async (input: { sessionID: string; messageID: string }) => {
    if (busy(input.sessionID)) return
    const restored = restoreEditorFromUserParts(sync.data.part[input.messageID] ?? [], {
      directory: sdk.directory,
      attachmentName: language.t("common.attachment"),
    })
    const hasContent =
      restored.prompt.some((part) => {
        if (part.type === "image" || part.type === "file" || part.type === "agent") return true
        return "content" in part && part.content.trim() !== ""
      }) || (restored.addToChatSnippets?.length ?? 0) > 0
    if (!hasContent) return

    // 从原 user message 恢复 model/agent/variant，避免用户切换后重试用了新选择
    const messages = sync.data.message[input.sessionID] ?? []
    const userMessage = messages.find((m) => m.id === input.messageID && m.role === "user") as
      | ((typeof messages)[number] & {
          role: "user"
          model: { providerID: string; modelID: string; variant?: string }
          agent: string
        })
      | undefined
    if (!userMessage) return

    const originalModel = userMessage.model
    const draft: FollowupDraft = {
      sessionID: input.sessionID,
      sessionDirectory: sdk.directory,
      prompt: restored.prompt,
      addToChatSnippets: restored.addToChatSnippets,
      context: [],
      agent: userMessage.agent ?? "",
      model: { providerID: originalModel.providerID, modelID: originalModel.modelID },
      variant: originalModel.variant,
    }

    await sendFollowupDraft({
      client: sdk.client,
      sync,
      globalSync,
      draft,
      optimisticBusy: true,
      language: language.intl(),
      translateContent: settings.general.translateContent(),
      preflight: permission.flush,
    }).catch((err) => {
      fail(err)
    })
  }

  // 弹确认框 → 调接口开启余额扣费 → 成功后重试触发该错误的原请求。
  const enableBalanceBilling = (input: { sessionID: string; messageID: string }) => {
    const confirmAndEnable = async () => {
      const result = await globalSDK.client.wanlaicodeUserCenter.balanceBilling
        .update({ enabled: true })
        .then((value) => (value.error ? { ok: false as const, error: value.error } : { ok: true as const }))
        .catch((error) => ({ ok: false as const, error }))
      if (!result.ok) {
        showToast({
          variant: "error",
          title: language.t("users.balanceBilling.toast.updateFailed"),
          description: formatServerError(result.error, language.t),
        })
        return false
      }
      showToast({
        variant: "success",
        icon: "circle-check",
        title: language.t("users.balanceBilling.toast.enabled"),
      })
      void retryUserTurn(input)
      return true
    }

    dialog.show(() => (
      <Dialog title={language.t("users.balanceBilling.dialog.title")} fit>
        <div class="flex flex-col gap-6 px-2.5 pb-3">
          <div class="text-14-regular text-text-base">{language.t("users.balanceBilling.dialog.description")}</div>
          <div class="flex items-center justify-end gap-3">
            <Button
              size="large"
              variant="secondary"
              onClick={() => {
                openPurchasePage()
                dialog.close()
              }}
            >
              {language.t("users.balanceBilling.dialog.purchasePlan")}
            </Button>
            <Button
              size="large"
              variant="primary"
              onClick={async () => {
                const ok = await confirmAndEnable()
                if (ok) dialog.close()
              }}
            >
              {language.t("users.balanceBilling.dialog.confirm")}
            </Button>
          </div>
        </div>
      </Dialog>
    ))
  }

  const actions = {
    fork: forkFromMessage,
    revert,
    edit: editMessage,
    goalObjective: goalObjectiveFor,
    openReviewPanel: openReviewFromTurn,
    enableBalanceBilling,
    openPurchasePage,
    editSummaryRevertPending: () => reverting(),
    sessionBusy: () => {
      const id = params.id
      if (!id) return false
      return busy(id)
    },
    canRevertEditSummary: (messageID: string) => {
      const last = visibleTimelineUserMessages().at(-1)
      if (!last) return false
      return last.id === messageID
    },
    editSummaryOpeners: () => editSummaryOpeners(),
    isQueued: (messageID: string) => {
      const id = params.id
      if (!id || !busy(id)) return false
      return isQueuedUserMessage(sync.data.message[id] ?? [], messageID, {
        steered: (userTurnView().steeredByMessageID[messageID] ?? 0) > 0,
      })
    },
    deleteQueued: (input: { sessionID: string; messageID: string }) =>
      sdk.client.session
        .deleteMessage({ sessionID: input.sessionID, messageID: input.messageID })
        .catch((err: unknown) => fail(err)),
  }

  createEffect(() => {
    const sessionID = params.id
    if (!sessionID) return

    if (!followupReady()) return
    // 消息尚未完成首轮同步时不能把空数组当成“没有 assistant”，否则刷新会提前回收仍在执行的引导。
    if (!messagesReady()) return
    // 一次处理一条 pending；数组中的其它 steer 继续由下一轮 effect 独立确认，避免 ACK 互相覆盖。
    const pending = manualSteerPendings(sessionID)[0]
    if (!pending) return
    const messages = sync.data.message[sessionID] ?? []
    if (pending.fallback) {
      const messageObserved = followupPromptMessageMatches({
        message: messages.find((message) => message.id === pending.messageID),
        messageID: pending.messageID,
      })
      if (messageObserved) {
        // fallback 的普通 user 已经落库时，交接给普通 awaiting 锁；不能再把 recovery 恢复成第二条消息。
        batch(() => {
          setStore("followupAwaiting", sessionID, {
            messageID: pending.messageID,
            startedAt: pending.startedAt,
          })
          setFollowup("manualSteerPending", sessionID, (current) => {
            const next = manualSteerPendingList(current).filter((entry) => entry.messageID !== pending.messageID)
            return next.length > 0 ? next : undefined
          })
          setStore("followupSentMessageIDs", sessionID, (ids) =>
            ids?.filter((messageID) => messageID !== pending.messageID),
          )
        })
        return
      }
      // 当前页面仍有该会话的发送认领时，等待 mutation 的 ACK；刷新后认领不存在才恢复暂停草稿。
      if (followupClaimMatchesPending(sessionID, pending)) return
      batch(() => {
        const recovery = pending.recovery
        if (recovery) {
          const recovered = recoverStaleSteerToPausedQueue(recovery.item)
          setFollowup("items", sessionID, (items) =>
            recoverManualSteerDraft({
              items: items ?? [],
              recovery: { ...recovery, item: recovered.item },
              messageObserved: false,
            }),
          )
          setFollowup("paused", sessionID, recovered.paused)
        }
        setFollowup("manualSteerPending", sessionID, (current) => {
          const next = manualSteerPendingList(current).filter((entry) => entry.messageID !== pending.messageID)
          return next.length > 0 ? next : undefined
        })
        setStore("followupSentMessageIDs", sessionID, (ids) =>
          ids?.filter((messageID) => messageID !== pending.messageID),
        )
      })
      if (!autoScroll.userScrolled()) resumeScroll()
      return
    }
    if (!pending.targetTurnID) {
      // 当前页面仍持有官方式 rfe 等待器时继续等 status.turnID；刷新后所有权消失才恢复并暂停草稿。
      if (manualSteerTargetWaitOwned(sessionID, pending.messageID)) return
      // 页面重挂后等待器不再存在，但原页面的 steer RPC 仍可能在途；在 claim 释放前不能提前把草稿判成 missing。
      if (followupClaimMatchesPending(sessionID, pending)) return
      batch(() => {
        const recovery = pending.recovery
        if (recovery) {
          const recovered = recoverStaleSteerToPausedQueue(recovery.item)
          setFollowup("items", sessionID, (items) =>
            recoverManualSteerDraft({
              items: items ?? [],
              recovery: {
                ...recovery,
                item: recovered.item,
              },
              messageObserved: false,
            }),
          )
          setFollowup("paused", sessionID, recovered.paused)
        }
        setFollowup("manualSteerPending", sessionID, (current) => {
          const next = manualSteerPendingList(current).filter((entry) => entry.messageID !== pending.messageID)
          return next.length > 0 ? next : undefined
        })
        setStore("followupSentMessageIDs", sessionID, (ids) =>
          ids?.filter((messageID) => messageID !== pending.messageID),
        )
      })
      if (!autoScroll.userScrolled()) resumeScroll()
      return
    }
    const messageObserved = manualSteerMessageMatchesTarget({
      message: messages.find((message) => message.id === pending.messageID),
      parts: sync.data.part[pending.messageID],
      messageID: pending.messageID,
      targetTurnID: pending.targetTurnID,
    })
    const pendingState = manualSteerHydrationState({
      messages,
      messageID: pending.messageID,
      targetTurnID: pending.targetTurnID,
      partsByMessage: sync.data.part,
      startedAt: pending.startedAt,
      now: runStateNow(),
      inferredBusy: busy(sessionID),
      statusBusy: sessionStatusBusy(sessionID),
      acknowledged: pending.acknowledged === true,
      recovery: !!pending.recovery,
    })
    if (pendingState === "pending") return
    if (pendingState === "acknowledged") {
      // durable marker 已出现就升级为已接受；保留 restoreMessage 等价载荷到终态，供 marker 同步断裂时恢复。
      setFollowup("manualSteerPending", sessionID, (current) =>
        manualSteerPendingList(current).map((entry) =>
          entry.messageID === pending.messageID ? { ...entry, startedAt: runStateNow(), acknowledged: true } : entry,
        ),
      )
      return
    }

    if (pendingState === "missing") {
      // 读取窗口可能先于持久化 ACK 超时；同一条 claim 仍在途时必须继续等待，不能把用户引导恢复成重复草稿。
      if (followupClaimMatchesPending(sessionID, pending)) return
      // marker 始终未出现时先撤销 provisional steering item；即使旧持久化状态没有 recovery，也不能留下孤儿气泡。
      sync.session.optimistic.remove({
        directory: pending.recovery?.item.sessionDirectory ?? sdk.directory,
        sessionID,
        messageID: pending.messageID,
      })
      // durable user 未出现时恢复原草稿并标记失败，避免刷新/断网让引导从队列中永久消失或自动死循环重发。
      batch(() => {
        if (!messageObserved && pending.recovery) {
          setFollowup("items", sessionID, (items) =>
            recoverManualSteerDraft({ items: items ?? [], recovery: pending.recovery, messageObserved: false }),
          )
          setFollowup("failed", sessionID, pending.recovery.item.id)
        }
        setFollowup("manualSteerPending", sessionID, (current) => {
          const next = manualSteerPendingList(current).filter((entry) => entry.messageID !== pending.messageID)
          return next.length > 0 ? next : undefined
        })
        setStore("followupSentMessageIDs", sessionID, (ids) => ids?.filter((id) => id !== pending.messageID))
      })
      fail(new Error("引导请求未生成回复，已解除输入锁，请重新发送"))
      if (!autoScroll.userScrolled()) resumeScroll()
      return
    }

    // 后端已经用终态 assistant 回答或覆盖了原 messageID，说明引导已执行；这里只释放顺序锁，绝不再次创建 user。
    setFollowup("manualSteerPending", sessionID, (current) => {
      const next = manualSteerPendingList(current).filter((entry) => entry.messageID !== pending.messageID)
      return next.length > 0 ? next : undefined
    })
    setStore("followupSentMessageIDs", sessionID, (ids) => ids?.filter((id) => id !== pending.messageID))
    if (!autoScroll.userScrolled()) resumeScroll()
  })

  createEffect(() => {
    const sessionID = params.id
    if (!sessionID) return

    // 停止 RPC 返回前只保持暂停态；恢复名单要等服务端确认停止完成后再交给自动队列。
    if (store.abortingSessions[sessionID]) return
    const item = nextFollowupToSend(visibleFollowups(), {
      paused: !!followup.paused[sessionID],
      resumeIDs: new Set(store.followupAbortResumeIDs[sessionID] ?? []),
      // 压缩期间已排队的引导项必须原样留在 dock，不能先生成乐观气泡再被发送闸门打回。
      compacting: sessionCompacting(sessionID),
    })
    if (!item) return
    const resumeAfterAbort = (store.followupAbortResumeIDs[sessionID] ?? []).includes(item.id)
    if (
      item.manualSteer === true &&
      !item.targetTurnID &&
      (!item.messageID || !manualSteerTargetWaitOwned(sessionID, item.messageID))
    ) {
      // 页面刷新会丢失官方 callback 的运行代次；这类 unresolved steer 只恢复为暂停草稿，绝不自动投向新 turn。
      const recovered = recoverStaleSteerToPausedQueue(item)
      unstageManualSteerOptimistic(item)
      batch(() => {
        setFollowup("items", sessionID, (items) =>
          (items ?? []).map((entry) => (entry.id === item.id ? recovered.item : entry)),
        )
        setFollowup("paused", sessionID, recovered.paused)
      })
      return
    }
    if (followupBusy(sessionID)) return
    if (followup.failed[sessionID] === item.id) return
    if (isChildSession()) return
    if (composer.blocked()) return
    // 连续 steer 在前一条 durable ACK 后可以立刻接力；普通队列仍必须等当前 steer 完成，保持 ChatGPT 的同一回合顺序。
    const pendingManualSteer = currentManualSteerPending(sessionID)
    if (followupShouldPauseForManualSteer({ pending: !!pendingManualSteer }) && item.manualSteer !== true) return
    if (followupAwaitingBlocksQueue(sessionID) && item.manualSteer !== true) return
    if (!followupPausedQueueAllowsSend({ paused: !!followup.paused[sessionID], resumeAfterAbort })) return
    // 同一 active turn 中的下一条 steer 允许在前一条 ACK 后越过 busy 状态；普通队列仍只在完全空闲时自动发送。
    if (
      item.manualSteer !== true &&
      !followupCanAutoSend({ inferredBusy: busy(sessionID), statusBusy: sessionStatusBusy(sessionID) })
    )
      return

    void sendFollowup(sessionID, item.id, { manual: item.manualSteer === true, source: "automatic" })
  })

  createResizeObserver(
    () => promptDock(),
    ({ height }) => {
      const next = Math.ceil(height)

      if (next === dockHeight) return

      const el = scroller
      // 用户已向上滚动阅读时不能用 delta 放宽贴底阈值：dock 一变高（token 计数、状态行、
      // 问题卡）就会把人从阅读位置拽到底部。只有确实还停在底部的人才继续贴底。
      const stick = el
        ? autoScroll.userScrolled()
          ? el.scrollHeight - el.clientHeight - el.scrollTop < 10
          : true
        : false

      dockHeight = next

      if (stick) autoScroll.forceScrollToBottom()

      if (el) scheduleScrollState(el)
      fill()
    },
  )

  const { clearMessageHash, scrollToMessage } = useSessionHashScroll({
    sessionKey,
    sessionID: () => params.id,
    messagesReady,
    visibleUserMessages: visibleTimelineUserMessages,
    messageAnchorID: (messageID) => visibleTimelineAnchorByMessageID()[messageID],
    historyMore,
    historyLoading,
    loadMore: (sessionID) => sync.session.history.loadMore(sessionID),
    turnStart: historyWindow.turnStart,
    currentMessageId: () => store.messageId,
    pendingMessage: () => ui.pendingMessage,
    setPendingMessage: (value) => setUi("pendingMessage", value),
    setActiveMessage,
    setTurnStart: historyWindow.setTurnStart,
    autoScroll,
    scroller: () => scroller,
    anchor,
    scheduleScrollState,
    consumePendingMessage: layout.pendingMessage.consume,
  })

  const jumpToTimelineMessage = (message: UserMessage) => {
    // 所有时间线导航先交出自动贴底控制权，再统一处理 sticky 标题偏移、历史展开和 hash 记账。
    autoScroll.pause()
    scrollToMessage(message)
  }

  useSessionCommands({
    navigateMessageByOffset,
    setActiveMessage,
    timelineUserMessages: visibleTimelineUserMessages,
    jumpToMessage: jumpToTimelineMessage,
    focusInput: () => focusInput(),
    working: busy,
    review: reviewTab,
    toggleReviewPanel,
    enterGoalMode: () => {
      composer.setPendingGoalObjective("")
      inputRef?.focus?.()
    },
  })

  createEffect(
    on(
      () => params.id,
      (id) => {
        if (!id) requestAnimationFrame(() => inputRef?.focus())
      },
    ),
  )

  onMount(async () => {
    setOpenExternalLinkHandler((url: string) => {
      const tab = createBrowserTabId()
      setBrowserUrl(tab, url)
      tabs().open(tab)
      tabs().setActive(tab)
      openReviewPanel({ manual: true })
    })
    makeEventListener(document, "keydown", handleKeyDown)
    makeEventListener(document, "keydown", (event) => {
      if (!sessionRouteActive()) return
      if (event.key !== "Escape") return
      if (!store.headerActionMenu.open) return
      setStore("headerActionMenu", "open", false)
    })
  })

  // 常驻树下环境列表/头部操作要随目录重载（onMount 只跑一次）；
  // 先清空避免上一项目的操作命令残留到新项目（runHeaderAction 会用新目录当 cwd 执行）。
  // 依赖同时含 projectWorktree：sandbox 直达时 worktree 由回退值解析为主 worktree 后需重载
  createEffect(
    on(
      () => [sdk.directory, projectWorktree()] as const,
      ([dir, worktree]) => {
        // 一变化立即作废全部在途读取，再清空重载
        envEpoch++
        headerActionsEpoch++
        setEnvironments([])
        setHeaderActionItems([])
        void (async () => {
          if (currentEnvReady()?.promise) await currentEnvReady()!.promise
          if (sdk.directory !== dir || projectWorktree() !== worktree) return
          await loadEnvironments()
        })()
      },
    ),
  )

  createEffect(
    on(currentEnvironment, () => {
      void loadHeaderActionsFromEnv()
    }),
  )

  onCleanup(() => {
    setOpenExternalLinkHandler(undefined)
    if (reviewFrame !== undefined) cancelAnimationFrame(reviewFrame)
    if (refreshFrame !== undefined) cancelAnimationFrame(refreshFrame)
    if (refreshTimer !== undefined) window.clearTimeout(refreshTimer)
    if (todoFrame !== undefined) cancelAnimationFrame(todoFrame)
    if (todoTimer !== undefined) window.clearTimeout(todoTimer)
    if (diffFrame !== undefined) cancelAnimationFrame(diffFrame)
    if (diffTimer !== undefined) window.clearTimeout(diffTimer)
    if (mainRowResizeTimer !== undefined) window.clearTimeout(mainRowResizeTimer)
    if (scrollStateFrame !== undefined) cancelAnimationFrame(scrollStateFrame)
    if (fillFrame !== undefined) cancelAnimationFrame(fillFrame)
  })

  const sessionComposerRegion = () => (
    <SessionComposerRegion
      state={composer}
      // 持久化引导状态未完成 hydration 前先显示占位框，避免用户在顺序锁恢复前提交普通消息。
      ready={!store.deferRender && messagesReady() && (!params.id || followupReady())}
      inputRef={(el) => {
        inputRef = el
      }}
      newSessionWorktree={newSessionWorktree()}
      onNewSessionWorktreeReset={() => setStore("newSessionWorktree", "main")}
      onNewSessionWorktreeCreate={openBranchCreateDialog}
      onSubmit={() => {
        const id = params.id
        if (id) setStore("abortingSessions", id, undefined)
        if (id) setStore("followupSuggestionSuppressed", id, undefined)
        comments.clear()
        resumeScroll()
      }}
      onResponseSubmit={resumeScroll}
      onAbort={() => {
        const id = params.id
        if (!id) return
        setStore("abortingSessions", id, true)
        sync.set("session_status", id, { type: "idle" })
      }}
      activeTurnID={(sessionID) => sessionActiveTurnID(sync.data.session_status[sessionID])}
      onAbortComplete={(sessionID) => {
        // abort RPC 完成后解除停止闸；只有恢复名单中的未 ACK 引导会自动接续，普通队列仍保持暂停。
        setStore("abortingSessions", sessionID, undefined)
      }}
      // PromptInput 与 composer 使用同一顺序锁，避免 idle 空窗把停止按钮提前切回发送。
      working={() => (params.id ? sessionWorking(params.id) : false)}
      onBeforeSubmitExistingSession={(sessionID) => {
        // 刷新期间先等 follow-up 快照落定，防止普通提交越过尚未恢复的引导。
        if (!followupReady()) return false
        return clearStaleRun(sessionID)
      }}
      followup={
        params.id && !isChildSession()
          ? {
              queue: queueEnabled,
              steer: steerEnabled,
              items: followupDock(),
              mode: followupMode(),
              sending: sendingFollowup(),
              suppressSuggestion: () => !!store.followupSuggestionSuppressed[params.id!],
              queueingEnabled: settings.general.followup() === "queue",
              dragging: store.followupDragging,
              edit: editingFollowup(),
              onQueue: queueFollowup,
              onSteer: steerFollowup,
              onAbort: () => {
                const id = params.id
                if (!id) return
                // 先取消旧 steer 的 ACK 等待；其 finally 会释放 claim，恢复项才能在 abort RPC 完成后自动接力。
                followupRequestControllers
                  .get(followupLifecycleKey(sdk.directory, id))
                  ?.abort(Object.assign(new Error("Follow-up stopped before durable ACK"), { name: "AbortError" }))
                const pendings = manualSteerPendings(id)
                const acknowledgedItemIDs = new Set(
                  pendings
                    .filter((pending) => pending.acknowledged === true)
                    .flatMap((pending) => (pending.recovery ? [pending.recovery.item.id] : [])),
                )
                const resumeIDs = new Set<string>()
                let pausedItems = followup.items[id] ?? []
                for (const pending of pendings) {
                  pausedItems = pauseManualSteerState({ items: pausedItems, pending }).items
                  if (pending.acknowledged !== true && pending.recovery) resumeIDs.add(pending.recovery.item.id)
                }
                pausedItems = pausedItems.map((item) =>
                  item.manualSteer === true
                    ? (() => {
                        const recovered = recoverStaleSteerToPausedQueue(item).item
                        if (!acknowledgedItemIDs.has(item.id)) resumeIDs.add(recovered.id)
                        return recovered
                      })()
                    : item,
                )
                // 已收到 durable ACK 的引导已经属于原回合历史，不能作为普通队列再次发送。
                pausedItems = pausedItems.filter((item) => !acknowledgedItemIDs.has(item.id))
                // 停止原回合时，未接受的 steering item 从时间线撤回并降为普通草稿；RPC 完成后按恢复名单自动接续。
                const pendingRecoveryIDs = new Set(
                  pendings.flatMap((pending) => (pending.recovery ? [pending.recovery.item.id] : [])),
                )
                const staged = [
                  ...(followup.items[id] ?? []),
                  ...pendings.flatMap((pending) => (pending.recovery ? [pending.recovery.item] : [])),
                ].filter(
                  (item, index, items) =>
                    (item.manualSteer === true || pendingRecoveryIDs.has(item.id)) &&
                    !!item.messageID &&
                    items.findIndex((candidate) => candidate.messageID === item.messageID) === index,
                )
                staged.forEach(unstageManualSteerOptimistic)
                // ACK 后的 pending 可能没有可见恢复项；仍要撤销 provisional 气泡，durable 消息若存在会由同步层保留。
                pendings.forEach((pending) => {
                  sync.session.optimistic.remove({
                    directory: pending.recovery?.item.sessionDirectory ?? sdk.directory,
                    sessionID: id,
                    messageID: pending.messageID,
                  })
                  clearManualSteerTargetWait(id, pending.messageID)
                  setStore("followupSentMessageIDs", id, (ids) =>
                    ids?.filter((messageID) => messageID !== pending.messageID),
                  )
                })
                // 先推进停止代次，再原子恢复未接受草稿和清理 pending，确保迟到 ACK 看见的是完整暂停态。
                const lifecycleKey = activateFollowupLifecycleOwner(sdk.directory, id)
                followupAbortEpochs.set(lifecycleKey, followupAbortEpoch(sdk.directory, id) + 1)
                batch(() => {
                  setFollowup("paused", id, true)
                  setFollowup("items", id, pausedItems)
                  setFollowup("manualSteerPending", id, undefined)
                  setStore("followupAbortResumeIDs", id, [...resumeIDs])
                })
              },
              onDragStart: (id) => setStore("followupDragging", id),
              onDragEnd: () => setStore("followupDragging", undefined),
              onSend: (id) => {
                promoteFollowupToSteer(params.id!, id)
              },
              onEdit: editFollowup,
              onDelete: deleteFollowup,
              onQueueingChange: (enabled) => settings.general.setFollowup(enabled ? "queue" : "steer"),
              onReorder: reorderFollowups,
              onEditLoaded: clearFollowupEdit,
            }
          : undefined
      }
      revert={
        rolled().length > 0
          ? {
              items: rolled(),
              restoring: restoring(),
              disabled: reverting(),
              onRestore: restore,
            }
          : undefined
      }
      setPromptDockRef={(el) => {
        setPromptDock(el)
        if (!el) dockHeight = 0
      }}
      onGoalEdit={() => {
        const id = params.id
        const current = composer.goal()
        if (!id || !current) return
        void import("@/components/dialog-goal").then((mod) => {
          dialog.show(() => (
            <mod.DialogGoalEdit
              objective={current.objective}
              onSave={(objective) => {
                void sdk.client.session
                  .setGoal({ sessionID: id, objective })
                  .then((res) => {
                    if (res?.data) globalSync.goal.set(id, res.data)
                  })
                  .catch((err: unknown) => {
                    showToast({
                      title: language.t("common.requestFailed"),
                      description: err instanceof Error ? err.message : String(err),
                    })
                  })
              }}
            />
          ))
        })
      }}
      onGoalToggleStatus={() => {
        const id = params.id
        const current = composer.goal()
        if (!id || !current) return
        const setStatus = (status: "active" | "paused") => {
          // 恢复目标会立刻起新一轮。暂停/停止时留下的本地中止标记只在用户手动提交消息时清除
          // （onSubmit），恢复走不到那里；不清的话 busy() 恒 false，输入框右下角会一直停在
          // 发送箭头、点不出停止按钮。
          if (status === "active") setStore("abortingSessions", id, undefined)
          void sdk.client.session
            .setGoal({ sessionID: id, status })
            .then((res) => {
              if (res?.data) globalSync.goal.set(id, res.data)
            })
            .catch((err: unknown) => {
              showToast({
                title: language.t("common.requestFailed"),
                description: err instanceof Error ? err.message : String(err),
              })
            })
        }
        // paused → active：恢复前先弹确认；其余方向（active → paused）直接执行
        if (current.status === "paused") {
          void import("@/components/dialog-goal").then((mod) => {
            dialog.show(() => (
              <mod.DialogGoalConfirm
                title={language.t("session.goal.dialog.resume.title")}
                description={language.t("session.goal.dialog.resume.description")}
                confirmLabel={language.t("session.goal.dialog.resume.confirm")}
                cancelLabel={language.t("session.goal.dialog.resume.cancel")}
                onConfirm={() => setStatus("active")}
              />
            ))
          })
          return
        }
        setStatus("paused")
      }}
      onGoalClear={() => {
        const id = params.id
        if (!id) return
        const previous = composer.goal()
        globalSync.goal.set(id, undefined) // 乐观清除
        void sdk.client.session.clearGoal({ sessionID: id }).catch((err: unknown) => {
          showToast({
            title: language.t("common.requestFailed"),
            description: err instanceof Error ? err.message : String(err),
          })
          globalSync.goal.set(id, previous) // 清除失败回滚，服务端 goal 仍在、本地不能装作没有
        })
      }}
      onGoalSubmit={(objective, sessionID) => {
        // 提交时输入框已被清空：确认取消/请求失败都要把文本回填，避免用户输入丢失。
        // 但若用户在异步间隙已经打了新内容，就不覆盖（回填只是兜底，不该吃掉用户正在写的东西）
        const restore = () => {
          const typed = prompt
            .current()
            .map((part) => ("content" in part ? part.content : ""))
            .join("")
            .trim()
          if (typed.length > 0) {
            composer.setPendingGoalObjective("")
            return
          }
          composer.setPendingGoalObjective("")
          prompt.set([{ type: "text", content: objective, start: 0, end: objective.length }], objective.length)
        }
        const apply = () => {
          composer.setPendingGoalObjective(undefined)
          // 设/改目标会立刻起新一轮（同恢复分支）：清掉暂停/停止留下的本地中止标记，
          // 否则 busy() 恒 false、停止按钮点不出来（暂停→改目标→提交也会撞上）。
          setStore("abortingSessions", sessionID, undefined)
          void sdk.client.session
            .setGoal({ sessionID, objective })
            .then((res) => {
              // 乐观更新：用响应直接写 store，dock 立刻显示，不依赖 SSE 时序
              if (res?.data) globalSync.goal.set(sessionID, res.data)
            })
            .catch((err: unknown) => {
              showToast({
                title: language.t("common.requestFailed"),
                description: err instanceof Error ? err.message : String(err),
              })
              restore()
            })
        }
        // 已有未完成 goal 且 objective 不同时，先弹「替换当前目标」确认（complete 态直接覆盖，不弹误导性确认）
        const current = composer.goal()
        if (current && current.status !== "complete" && current.objective !== objective) {
          void import("@/components/dialog-goal").then((mod) => {
            dialog.show(() => (
              <mod.DialogGoalConfirm
                title={language.t("session.goal.dialog.replace.title")}
                description={language.t("session.goal.dialog.replace.description")}
                confirmLabel={language.t("session.goal.dialog.replace.confirm")}
                cancelLabel={language.t("common.cancel")}
                onConfirm={apply}
                onCancel={restore}
              />
            ))
          })
          return
        }
        apply()
      }}
      onExitGoalMode={() => composer.setPendingGoalObjective(undefined)}
      onGoalModeToggle={() => {
        const id = params.id
        if (composer.isGoalModeActive()) {
          // 退出：已有目标则清除，否则取消输入态
          if (id && composer.goal()) {
            const previous = composer.goal()
            globalSync.goal.set(id, undefined) // 乐观清除
            void sdk.client.session.clearGoal({ sessionID: id }).catch((err: unknown) => {
              showToast({
                title: language.t("common.requestFailed"),
                description: err instanceof Error ? err.message : String(err),
              })
              globalSync.goal.set(id, previous) // 清除失败回滚
            })
          }
          composer.setPendingGoalObjective(undefined)
        } else {
          // 进入 goal 输入态
          composer.setPendingGoalObjective("")
        }
      }}
    />
  )

  return (
    <ScratchModeProvider>
      <div class="relative bg-background-base size-full overflow-hidden flex flex-col" data-ui="codex-chat">
        {/* 顶部窗口拖拽条已移至 layout.tsx 最顶部（DOM 顺序优先于所有 no-drag 元素） */}
        <Show when={!params.id}>
          <div
            classList={{
              "absolute z-[100] items-center gap-1": true,
              hidden: !sessionChromeVisible(),
              flex: sessionChromeVisible(),
              "h-9": !(platform.platform === "desktop" && platform.os === "windows"),
              "top-0 h-12": platform.platform === "desktop" && platform.os === "windows",
              "top-[5px]": !(platform.platform === "desktop" && platform.os === "windows"),
              // macOS 折叠 sidebar 时 main 顶到 left=0，要避开左上浮动 chrome 按钮组
              // 80px 红绿灯 + 5×28px(size-7) 按钮 + 4×6px(gap-1.5) + 8px(pr-2) ≈ 252px
              "left-2": (platform.platform === "desktop" && platform.os === "windows") || layout.sidebar.opened(),
              "left-[252px]":
                !(platform.platform === "desktop" && platform.os === "windows") && !layout.sidebar.opened(),
              "ml-[2px]": true,
            }}
            style={{ "-webkit-app-region": "no-drag" } as Record<string, string>}
          >
            <GetPlusButton />
          </div>
        </Show>
        <div
          classList={{
            "fixed right-2 z-[101] items-center": true,
            hidden: !sessionChromeVisible(),
            flex: sessionChromeVisible(),
            "h-9": !(platform.platform === "desktop" && platform.os === "windows"),
            "top-9 h-12": platform.platform === "desktop" && platform.os === "windows",
            "top-[5px]": !(platform.platform === "desktop" && platform.os === "windows"),
            "mr-[4px]": true,
          }}
          style={{ "-webkit-app-region": "no-drag" } as Record<string, string>}
        >
          <Show when={desktopReviewOpen()}>
            <Tooltip
              placement="bottom"
              value={
                ui.reviewExpanded
                  ? language.t("command.review.restorePanelWidth")
                  : language.t("command.review.expandPanel")
              }
            >
              <Button
                variant="ghost"
                class="titlebar-icon size-7 p-0 box-border"
                onClick={toggleReviewPanelWidth}
                aria-label={
                  ui.reviewExpanded
                    ? language.t("command.review.restorePanelWidth")
                    : language.t("command.review.expandPanel")
                }
                aria-pressed={ui.reviewExpanded}
                style={{ "-webkit-app-region": "no-drag" } as Record<string, string>}
              >
                <Icon size="small" name={ui.reviewExpanded ? "collapse" : "expand"} />
              </Button>
            </Tooltip>
          </Show>
          <TooltipKeybind
            placement="bottom"
            title={language.t("command.review.toggle")}
            keybind={command.keybind("review.toggle")}
          >
            <Button
              variant="ghost"
              class="titlebar-icon size-7 p-0 box-border"
              onClick={() => {
                // 自动化面板归属当前会话时,复用此开关折叠/展开它;否则切换 review 面板
                if (automationPanel()?.sessionKey === sessionKey()) toggleAutomationPanelCollapsed()
                else toggleReviewPanel()
              }}
              aria-label={language.t("command.review.toggle")}
              aria-expanded={
                automationPanel()?.sessionKey === sessionKey()
                  ? !automationPanelCollapsed()
                  : view().reviewPanel.opened()
              }
              style={{ "-webkit-app-region": "no-drag" } as Record<string, string>}
            >
              <Icon
                size="small"
                name={
                  (
                    automationPanel()?.sessionKey === sessionKey()
                      ? !automationPanelCollapsed()
                      : view().reviewPanel.opened()
                  )
                    ? "layout-right-partial"
                    : "layout-right"
                }
              />
            </Button>
          </TooltipKeybind>
        </div>
        <div
          classList={{
            "flex-1 min-h-0 flex": true,
            "flex-row": isDesktop(),
            "flex-col": !isDesktop(),
          }}
          ref={(el) => {
            createResizeObserver(el, ({ width }) => updateMainRowWidth(width))
          }}
        >
          <Show when={!isDesktop() && (params.id || vcsGitEnabled())}>
            <Tabs value={store.mobileTab} class="h-auto">
              <Tabs.List>
                <Tabs.Trigger
                  value="session"
                  classList={{
                    "!max-w-none": true,
                    "!w-full": !reviewLayoutControlsVisible(),
                    "!w-1/2": reviewLayoutControlsVisible(),
                  }}
                  classes={{ button: "w-full" }}
                  onClick={() => setStore("mobileTab", "session")}
                >
                  {language.t("session.tab.session")}
                </Tabs.Trigger>
                <Show when={reviewLayoutControlsVisible()}>
                  <Tabs.Trigger
                    value="changes"
                    class="!w-1/2 !max-w-none !border-r-0"
                    classes={{ button: "w-full" }}
                    onClick={() => setStore("mobileTab", "changes")}
                  >
                    {hasReview()
                      ? language.t("session.review.filesChanged", { count: reviewCount() })
                      : language.t("session.review.change.other")}
                  </Tabs.Trigger>
                </Show>
              </Tabs.List>
            </Tabs>
          </Show>

          {/* Session panel */}
          <div
            ref={(el) => {
              // 首帧 paint 前用真实宽度校正（onMount 时整树已挂完、布局已定），
              // 避免 viewport 估算错导致详情浮层以错误模式挂载、被迟到的
              // ResizeObserver 回调纠正时触发一次可见的滑出动画（跨项目切换时最明显）
              onMount(() => {
                const width = el.getBoundingClientRect().width
                if (width > 0) setIsWideContainer(width >= PANEL_WIDE_THRESHOLD_PX)
              })
              // 监听 session-panel 的 inline-size，驱动 isWideContainer 信号；
              // 阈值 PANEL_WIDE_THRESHOLD_PX 跟 index.css 里 @container (min-width: 1100px) 一致。
              createResizeObserver(el, ({ width }) => {
                setIsWideContainer(width >= PANEL_WIDE_THRESHOLD_PX)
              })
            }}
            classList={{
              "@container relative shrink-0 flex flex-col min-h-0 h-full bg-background-base": true,
              "flex-1": !isDesktop(),
              "flex-none": isDesktop(),
              "transition-[width] duration-[240ms] ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[width] motion-reduce:transition-none":
                !size.active() && !ui.reviewSnap,
            }}
            style={{
              width: sessionPanelWidth(),
              // background: '#fff'
            }}
            // data-card-open 驱动 CSS @container (min-width: 1100px) 规则下的「对话整列左移 148px」；
            // 窄容器规则不命中，对话不动。
            data-card-open={cardVisible() ? "true" : "false"}
          >
            <Show when={!params.id && !(platform.platform === "desktop" && platform.os === "windows")}>
              <div
                class="hidden lg:block absolute top-0 h-12 z-[50] pointer-events-none"
                classList={{
                  // 新会话没有 message header，需要单独提供一段可拖拽空白；同时避开左侧 Plus 和右上按钮组（相对 Session panel）。
                  // 折叠 sidebar 时 GetPlus 左偏移由 218 调整为 252（5 个 chrome 按钮），drag spacer 同步推到 364。
                  "left-[118px]": layout.sidebar.opened(),
                  "left-[364px]": !layout.sidebar.opened(),
                }}
                style={{
                  right: "50px",
                  "-webkit-app-region": "drag",
                }}
                aria-hidden
              />
            </Show>
            <div
              classList={{
                "absolute z-[100] items-center gap-1": true,
                hidden: !sessionChromeVisible(),
                flex: sessionChromeVisible(),
                "h-9": !(platform.platform === "desktop" && platform.os === "windows"),
                "top-0 h-12": platform.platform === "desktop" && platform.os === "windows",
                "right-2": desktopSidePanelOpen(),
                "right-11": !desktopSidePanelOpen(),
                "top-[4px]": !(platform.platform === "desktop" && platform.os === "windows"),
              }}
              style={{ "-webkit-app-region": "no-drag" } as Record<string, string>}
            >
              {/* 在 IDE / 访达 打开项目（带下拉） */}
              <div class="flex h-7 box-border items-center rounded-xl border border-border-weak-base bg-surface-panel overflow-hidden">
                <DropdownMenu
                  placement="bottom-end"
                  gutter={4}
                  onOpenChange={(open) => {
                    // 用户每次打开下拉时重新拉取已安装清单；主进程有 60s TTL 缓存所以重复开关基本是即时
                    if (open) void refetchOpeners()
                  }}
                >
                  <Tooltip placement="bottom" value={language.t("command.project.openIn")}>
                    <DropdownMenu.Trigger
                      as={Button}
                      variant="ghost"
                      class="titlebar-icon h-7 px-1.5 box-border flex items-center gap-0.5"
                      aria-label={language.t("command.project.openIn")}
                      // 父容器虽已标 no-drag，但 macOS 会按叶子元素重判 drag 区，需逐个显式标 no-drag
                      style={{ "-webkit-app-region": "no-drag" } as Record<string, string>}
                    >
                      <Switch>
                        <Match when={defaultProjectEditorIcon().type === "image"}>
                          <img
                            src={(defaultProjectEditorIcon() as { src: string }).src}
                            alt=""
                            class="size-4"
                            draggable={false}
                          />
                        </Match>
                        <Match when={defaultProjectEditorIcon().type === "app"}>
                          <AppIcon id={(defaultProjectEditorIcon() as { id: any }).id} alt="" class="size-4" />
                        </Match>
                        <Match when={true}>
                          <Icon name="open-file" size="small" />
                        </Match>
                      </Switch>
                      <Icon size="small" name="chevron-down" class="opacity-60" />
                    </DropdownMenu.Trigger>
                  </Tooltip>
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content class="codex-chat-menu min-w-[160px]">
                      {(() => {
                        const items = orderedProjectOpeners()
                        const fm = fileManagerInfo(platform.os)
                        return (
                          <>
                            <For each={items}>
                              {(item) => {
                                const override = knownOpenerOverride({
                                  bundleId: item.bundleId,
                                  app: item.app,
                                  name: item.name,
                                })
                                const label = override.labelKey
                                  ? language.t(override.labelKey as Parameters<typeof language.t>[0])
                                  : item.name
                                return (
                                  <DropdownMenu.Item
                                    onSelect={() => {
                                      if (item.kind === "editor") setDefaultEditorOpener(item)
                                      void (platform.invokeOpener
                                        ? platform.invokeOpener(item, sdk.directory)
                                        : platform.openPath?.(sdk.directory, item.app))
                                    }}
                                  >
                                    {override.iconId ? (
                                      <AppIcon id={override.iconId} alt="" class="size-4" />
                                    ) : item.iconDataUrl ? (
                                      <img src={item.iconDataUrl} alt="" class="size-4" draggable={false} />
                                    ) : (
                                      <Icon name="open-file" size="small" />
                                    )}
                                    <DropdownMenu.ItemLabel>{label}</DropdownMenu.ItemLabel>
                                  </DropdownMenu.Item>
                                )
                              }}
                            </For>
                            <Show when={items.length > 0}>
                              <DropdownMenu.Separator />
                            </Show>
                            <DropdownMenu.Item onSelect={() => void platform.openPath?.(sdk.directory)}>
                              <AppIcon id={fm.iconId} alt="" class="size-4" />
                              <DropdownMenu.ItemLabel>
                                {language.t("command.project.openInFinder", { name: language.t(fm.nameKey) })}
                              </DropdownMenu.ItemLabel>
                            </DropdownMenu.Item>
                          </>
                        )
                      })()}
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu>
              </div>
              {/* 终端 toggle（无外壳——仅 IDE 打开按钮组需要 rounded-xl 边框） */}
              <TooltipKeybind
                placement="bottom"
                title={language.t("command.terminal.toggle")}
                keybind={command.keybind("terminal.toggle")}
              >
                <Button
                  variant="ghost"
                  class="titlebar-icon size-7 p-0 box-border"
                  onClick={() => view().terminal.toggle()}
                  aria-label={language.t("command.terminal.toggle")}
                  aria-expanded={view().terminal.opened()}
                  style={{ "-webkit-app-region": "no-drag" } as Record<string, string>}
                >
                  <Icon size="small" name={view().terminal.opened() ? "terminal-active" : "terminal"} />
                </Button>
              </TooltipKeybind>
              {/* 会话详情浮层 toggle（无外壳）。审查页未开时仅再次点击可关；审查页已开时允许点空白关闭。 */}
              <Show when={branchCardShown()}>
                <Tooltip placement="bottom" value={language.t("session.header.togglePinnedSummary")}>
                  <Button
                    ref={(el: HTMLButtonElement) => (toggleBtnEl = el)}
                    variant="ghost"
                    class="titlebar-icon size-7 p-0 box-border"
                    classList={{ "bg-surface-raised-base-active": overlayOpen() }}
                    onClick={toggleOverlay}
                    aria-label={language.t("session.header.togglePinnedSummary")}
                    aria-pressed={overlayOpen()}
                    style={{ "-webkit-app-region": "no-drag" } as Record<string, string>}
                  >
                    <Icon size="small" name="info-circle" />
                  </Button>
                </Tooltip>
              </Show>
            </div>
            {/* 1:1 复刻 Codex：移除「获取 Plus」按钮，主区顶部紧贴 thread title */}
            <div class="flex-1 min-h-0 overflow-hidden">
              <Switch>
                <Match when={params.id}>
                  <Show
                    when={messageRender().timeline}
                    fallback={
                      <Show
                        when={messageRender().blockingError}
                        fallback={
                          <div class="flex items-center justify-center h-full text-12-regular text-text-weak">
                            {language.t("session.messages.loading")}
                          </div>
                        }
                      >
                        <div class="flex flex-col items-center justify-center h-full gap-4 p-8 text-center">
                          <Icon name="alert-circle" size="large" class="text-red-500" />
                          <div class="text-14-medium text-text-strong">{language.t("session.messages.loadFailed")}</div>
                          <Button
                            variant="secondary"
                            onClick={() =>
                              void runSessionSyncRetry({
                                sessionID: params.id!,
                                sync: sync.session.sync,
                                refetch: refetchSessionSync,
                                beforeSync: throwSessionSyncDebugError,
                                activeSessionID: () => params.id,
                              }).catch(() => undefined)
                            }
                          >
                            {language.t("errors.action.backoff_retry")}
                          </Button>
                        </div>
                      </Show>
                    }
                  >
                    <div class="relative h-full min-h-0">
                      <Show when={messageRender().staleError}>
                        <div class="absolute top-3 left-1/2 -translate-x-1/2 z-[70] flex items-center gap-2 rounded-full border border-border-weak-base bg-surface-raised-base px-3 py-2 shadow-sm text-12-regular text-text-base">
                          <Icon name="alert-circle" size="small" class="text-red-500" />
                          <span>{language.t("session.messages.loadFailed")}</span>
                          <Button
                            variant="ghost"
                            class="h-6 px-2 text-12-medium"
                            onClick={() =>
                              void runSessionSyncRetry({
                                sessionID: params.id!,
                                sync: sync.session.sync,
                                refetch: refetchSessionSync,
                                beforeSync: throwSessionSyncDebugError,
                                activeSessionID: () => params.id,
                              }).catch(() => undefined)
                            }
                          >
                            {language.t("errors.action.backoff_retry")}
                          </Button>
                        </div>
                      </Show>
                      <MessageTimeline
                        mobileChanges={mobileChanges()}
                        diffOverlay={() => sessionTurnDiffOverlay()}
                        diffOverlayWorkspaceRoot={() => sdk.directory}
                        mobileFallback={reviewContent({
                          diffStyle: "unified",
                          classes: {
                            root: "pb-8",
                            header: "px-4",
                            container: "px-4",
                          },
                          loadingClass: "px-4 py-4 text-text-weak",
                          emptyClass: "h-full pb-64 -mt-4 flex flex-col items-center justify-center text-center gap-6",
                        })}
                        actions={actions}
                        forkedFrom={() => info()?.forkedFrom}
                        forkBoundaryBeforeMessageID={() => {
                          // fork 边界：派生当时新会话创建时刻；克隆消息 time.created 早于该时刻，新消息晚于。
                          // 锚到「fork 后第一条新消息」之前——新消息必为最近、必已加载；旧导入消息是分页懒加载的，
                          // 若锚到「最后一条导入消息之后」，在旧消息未加载时会算空、banner 错误回落到对话末尾。
                          const session = info()
                          const forked = session?.forkedFrom
                          if (!forked) return undefined
                          const forkTime = session.time.created
                          if (typeof forkTime !== "number") return undefined
                          return visibleTimelineUserMessages().find(
                            (m) => typeof m.time.created === "number" && m.time.created >= forkTime,
                          )?.id
                        }}
                        resolveSessionDirectory={(id) => findSessionInStores(globalSync, id, sdk.directory)?.directory}
                        goalAchieved={goalAchievedInfo}
                        scroll={ui.scroll}
                        onResumeScroll={resumeScroll}
                        setScrollRef={setScrollRef}
                        onScheduleScrollState={scheduleScrollState}
                        onAutoScrollHandleUserScroll={
                          // 时间线只在已确认真实手势后调用该入口，确保流式更新不会抢回用户正在操作的滚动条。
                          autoScroll.handleUserScroll
                        }
                        onMarkScrollGesture={markTimelineScrollGesture}
                        hasScrollGesture={hasScrollGesture}
                        onUserScroll={markUserScroll}
                        onTurnBackfillScroll={historyWindow.onScrollerScroll}
                        onAutoScrollInteraction={autoScroll.handleInteraction}
                        centered={centered()}
                        setContentRef={(el) => {
                          content = el
                          autoScroll.contentRef(el)

                          const root = scroller
                          if (root) scheduleScrollState(root)
                        }}
                        turnStart={historyWindow.turnStart()}
                        historyMore={historyMore()}
                        historyLoading={historyLoading()}
                        onLoadEarlier={() => {
                          void historyWindow.loadAndReveal()
                        }}
                        renderedUserMessages={historyWindow.renderedUserMessages()}
                        onJumpToMessage={jumpToTimelineMessage}
                        steeredByMessageID={userTurnView().steeredByMessageID}
                        timelineTurns={visibleTimelineTurns()}
                        turnIDByMessageID={visibleTimelineTurnIDByMessageID()}
                        messages={timelineMessages()}
                        parts={timelineParts()}
                        anchor={anchor}
                      />
                    </div>
                  </Show>
                </Match>
                <Match when={true}>
                  <NewSessionView worktree={newSessionWorktree()}>
                    {sessionComposerRegion()}

                    {/* 新对话页：composer 下方留一个对称的弹性空白，让 composer 作为锚点垂直居中 */}
                    <div class="flex-1 pointer-events-none" aria-hidden />
                  </NewSessionView>
                </Match>
              </Switch>
            </div>

            {/* sessionComposerRegion只会出现一次，与上面的出现条件互斥 */}
            <Show when={params.id}>{sessionComposerRegion()}</Show>

            {/* 会话详情浮层：双行为模式，定位 + 动画全部交给 index.css 里的 [data-component="session-details-overlay"] 规则按 data-mode 切换。
              - top：会话标题区分隔线（48px）下 10px，见 index.css 共享基线
              - data-mode="wide"：right-6 floating 卡片，translate-x slide-in/out（280ms cubic-bezier）
              - data-mode="narrow"：right-2/right-11 dropdown（锚定按钮），scale 0.96→1 + opacity 0→1（150ms ease-out，仿 codex-chat-menu）
              data-anchor 让 narrow 模式的 right 跟 chrome row 同步（side panel 开=right-2，关=right-11）。 */}
            <Show when={branchCardShown()}>
              <div
                ref={(el) => (overlayEl = el)}
                class="hidden lg:block absolute overflow-hidden no-scrollbar z-30"
                data-component="session-details-overlay"
                data-git-layout={gitFeaturesEnabled() ? "git" : "output"}
                data-output-expanded={!gitFeaturesEnabled() && cardOutputExpanded() ? "true" : "false"}
                data-mode={renderMode()}
                data-settled={shellSettled() ? "true" : "false"}
                data-state={overlayOpen() ? "open" : "closed"}
                data-anchor={desktopSidePanelOpen() ? "inset" : "outset"}
                aria-hidden={!overlayOpen()}
              >
                <SessionDetailsCard>
                  <div data-slot="session-details-card-scroll" class="flex min-h-0 flex-1 flex-col">
                    <div data-slot="session-details-card-main" class="flex flex-col">
                      <Switch>
                        <Match when={gitFeaturesEnabled()}>
                          <ProgressSection
                            // 外层 <Show when={branchCardShown()}> 已保证 params.id 非空。
                            todos={() => globalSync.data.session_todo[params.id!] ?? []}
                            working={() => busy(params.id!)}
                          />
                          <GitSection
                            showEnvironmentControls
                            onNewSessionWorktreeCreate={openBranchCreateDialog}
                            changesTotals={cardBranchTotals}
                            busy={gitOpsBusy}
                            gitAvailable={vcsGitEnabled}
                            ghCli={() => cardPrReadinessQuery.data?.gh_cli ?? sync.data.vcs?.gh_cli}
                            ghAuthenticated={() => cardPrReadinessQuery.data?.gh_authenticated}
                            existingPullRequest={() => cardPrReadinessQuery.data?.existing_pull_request}
                            prReadinessPending={() =>
                              !cardPrReadinessQuery.isFetched || cardPrReadinessQuery.isFetching
                            }
                            prReadinessFailed={() => cardPrReadinessQuery.isError}
                            prRefreshPending={() => cardPrReadinessQuery.isFetched && cardPrReadinessQuery.isFetching}
                            onOpenPullRequest={openPullRequestInBrowser}
                            onOpenReview={() => {
                              setChangesAutoSet(false)
                              setStore("changes", "branch")
                              openReviewPanel({ manual: true })
                            }}
                            onCommit={openCommitDialog}
                            onPush={handlePush}
                            uncommittedCount={cardUncommittedCount}
                            needsPush={cardNeedsPush}
                            onCreateBranch={openBranchCreateDialog}
                            headerActionItems={headerActionItems()}
                            headerActionRunning={headerActionState.running}
                            headerActionLabel={headerActionLabel()}
                            projectName={projectName()}
                            onHeaderActionRun={(action) => void runHeaderAction(action)}
                            onHeaderActionOpenRunDialog={openRunHeaderAction}
                            onHeaderActionPin={pinHeaderAction}
                            onHeaderActionAdd={openAddHeaderAction}
                            onHeaderActionContextMenu={openHeaderActionContextMenu}
                            onHeaderActionContextMenuClose={() => setStore("headerActionMenu", "open", false)}
                            headerActionContextMenuOpen={store.headerActionMenu.open}
                            headerActionContextMenuAction={store.headerActionMenu.action}
                            headerActionContextMenuPosition={store.headerActionMenu.position}
                            onHeaderActionEdit={openEditHeaderAction}
                            onHeaderActionDelete={openDeleteHeaderAction}
                            activeHeaderAction={activeHeaderAction()}
                            environments={environments()}
                            currentEnvironment={currentEnvironment()}
                            onEnvironmentChange={handleEnvironmentChange}
                            onEnvironmentSettings={handleEnvironmentSettings}
                            onLoadEnvironments={loadEnvironments}
                            onCreatePullRequest={handleCreatePullRequest}
                            onPastePromptText={pastePromptText}
                            onRefreshPullRequest={() => scheduleSyncPrReadiness()}
                          />
                        </Match>
                        <Match when={gitReviewBlocked()}>
                          <OutputSection
                            files={cardOutputFiles}
                            workspaceRoot={() => sdk.directory}
                            previewUrls={cardOutputPreviewUrls}
                            previewKey={(path) => normalizeOutputArtifactKey(path, sdk.directory)}
                            onExpandedChange={setCardOutputExpanded}
                            onOpenFile={(path) => {
                              if (path.startsWith("http://") || path.startsWith("https://")) {
                                openHttpUrl(path, platform.openLink)
                                return
                              }
                              openOutputFileFromCard(path)
                            }}
                          />
                        </Match>
                      </Switch>
                    </div>
                    <SourcesSection sources={cardWebSourceUrls} />
                  </div>
                </SessionDetailsCard>
              </div>
            </Show>
          </div>

          <Show when={desktopReviewOpen() && !ui.reviewExpanded}>
            <div class="relative shrink-0 self-stretch w-0 z-30">
              <ResizeHandle
                direction="horizontal"
                size={layout.session.width()}
                min={sessionResizeBounds().min}
                max={sessionResizeBounds().max}
                onResizeStart={() => size.start()}
                onResize={(width) => {
                  size.touch()
                  layout.session.resize(width)
                }}
                onCollapsePastMax={collapseReviewPanel}
                collapsePastMaxThreshold={80}
              />
            </div>
          </Show>

          <SessionSidePanel
            canReview={canReview}
            diffs={reviewDiffs}
            diffsReady={reviewReady}
            empty={reviewEmptyText}
            hasReview={hasReview}
            reviewCount={reviewCount}
            reviewPanel={reviewPanel}
            activeDiff={tree.activeDiff}
            focusReviewDiff={focusReviewDiff}
            reviewSnap={ui.reviewSnap}
            reviewExpanded={ui.reviewExpanded}
            size={size}
            onOpenReviewPanel={() => openReviewPanel({ manual: true })}
          />
        </div>
        <TerminalPanel />
      </div>
    </ScratchModeProvider>
  )
}
