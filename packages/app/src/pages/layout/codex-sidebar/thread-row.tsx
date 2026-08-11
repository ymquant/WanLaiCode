import { type Accessor, type JSX, Show, createMemo, createSignal, onCleanup } from "solid-js"
import { A } from "@solidjs/router"
import type { Session } from "@opencode-ai/sdk/v2/client"
import { ContextMenu } from "@opencode-ai/ui/context-menu"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { ProgressCircle } from "@opencode-ai/ui/progress-circle"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { HoverCard } from "@opencode-ai/ui/hover-card"
import { showToast } from "@opencode-ai/ui/toast"
import { getFilename } from "@opencode-ai/core/util/path"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useAutomationSessions } from "@/context/automation-sessions"
import { useGlobalSync } from "@/context/global-sync"
import { CdxIcon } from "@/pages/automation/cdx-icons"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { usePlatform } from "@/context/platform"
import { RenameThreadDialog } from "./rename-thread-dialog"
import { sessionTitle } from "@/utils/session-title"
import { relativeTimeUnit } from "./relative-time"
import { sessionSidebarTimestamp } from "../helpers"
import { ThreadContextMenuContent, type ThreadMenuActions } from "./thread-context-menu"
import { resolvedSessionStatusBusy, sessionHasRunningTurn } from "@/pages/session/followup-queue"
import { requestSessionPrefetch } from "@/context/global-sync/session-prefetch"
import { prewarmPromptDraft } from "@/context/prompt"
import { pathKey } from "@/utils/path-key"
import { shouldKeepActionFocus } from "./thread-row-focus"
import { SidebarHoverScrollText } from "./sidebar-hover-scroll-text"

export const ThreadRow = (props: {
  session: Session
  // 该 thread 所属 directory（worktree 或 sandbox）
  directory: string
  // 读取 live session 的 child store；项目分组下列表聚合在 worktree store
  storeDirectory?: string
  slug: string
  active: Accessor<boolean>
  now: Accessor<number>
  pinned: Accessor<boolean>
  onArchive: (session: Session) => void
  onTogglePin: (session: Session) => void
  flat?: boolean
}): JSX.Element => {
  const language = useLanguage()
  const layout = useLayout()
  const platform = usePlatform()
  const dialog = useDialog()
  const globalSync = useGlobalSync()
  const storeDirectory = () => props.storeDirectory ?? props.directory
  const [sessionStore] = globalSync.child(storeDirectory(), { bootstrap: false })
  const [statusStore] = globalSync.child(props.directory, { bootstrap: false })
  const live = createMemo(() => {
    const list = sessionStore.session ?? []
    return list.find((item) => item.id === props.session.id) ?? props.session
  })
  // 自动化产生的会话:打时钟图标;运行中右侧转圈(对照 Codex local-task-row isAutomationRun)
  const automationSessions = useAutomationSessions()
  const autoStatus = () => automationSessions?.status(live().id)
  const isAutomation = () => autoStatus() !== undefined
  const isSessionRunning = () => {
    const status = statusStore.session_status[live().id]
    // Codex 侧边栏同样按消息/part 语义判断运行态；raw status 只作为辅助输入。
    return sessionHasRunningTurn({
      messages: statusStore.message[live().id],
      partsByMessage: statusStore.part,
      // 稀疏 status map 在 ready 后缺失即 idle；首次快照前仍保留未知，兼容深链进入的真实长回合。
      statusBusy: resolvedSessionStatusBusy({
        status,
        snapshotReady: statusStore.session_status_ready,
        sessionKnown: statusStore.session_status_known[live().id],
      }),
      // 自动重试属于同一条仍在运行的任务，侧边栏不能因上一 attempt 已结束而停止转圈。
      statusRetry: status?.type === "retry",
      now: props.now(),
    })
  }
  const isRunning = () => autoStatus() === "running" || isSessionRunning()
  const [hovering, setHovering] = createSignal(false)
  const [actionFocused, setActionFocused] = createSignal(false)
  const [previewOpen, setPreviewOpen] = createSignal(false)
  let pointerDown = false
  const showActions = () => hovering() || actionFocused()

  const title = () => {
    const t = sessionTitle(live().title)
    if (t === "New session") return language.t("sidebar.thread.placeholder.new")
    if (t === "Child session") return language.t("sidebar.thread.placeholder.child")
    return t ?? ""
  }
  const time = createMemo(() => {
    const when = sessionSidebarTimestamp(live(), layout.tree.filter().sortBy)
    const r = relativeTimeUnit(when, props.now())
    if (r.unit === "now") return language.t("sidebar.relative.now")
    if (r.unit === "min") return language.t("sidebar.relative.min", { n: r.value })
    if (r.unit === "hour") return language.t("sidebar.relative.hour", { n: r.value })
    if (r.unit === "day") return language.t("sidebar.relative.day", { n: r.value })
    if (r.unit === "week") return language.t("sidebar.relative.week", { n: r.value })
    if (r.unit === "month") return language.t("sidebar.relative.month", { n: r.value })
    return language.t("sidebar.relative.year", { n: r.value })
  })

  const project = createMemo(() => {
    const directory = pathKey(props.directory)
    return globalSync.data.project.find((item) => {
      if (pathKey(item.worktree) === directory) return true
      return (item.sandboxes ?? []).some((sandbox) => pathKey(sandbox) === directory)
    })
  })
  const projectName = () => {
    if (props.flat) return language.t("sidebar.section.chats")
    const item = project()
    return item?.name || getFilename(item?.worktree ?? props.directory)
  }
  // hover/按下即预取消息（顺带预热服务端目录实例）并预读该会话草稿，点击时基本零等待。
  // mouseenter 加 hover-intent 延迟，快速扫过列表不会给沿途每个目录触发 bootstrap
  const warm = () => {
    const session = live()
    requestSessionPrefetch(session.directory ? session : { ...session, directory: props.directory }, "high")
    prewarmPromptDraft(props.slug, props.session.id)
  }
  let warmTimer: number | undefined
  let previewTimer: number | undefined
  const warmSoon = () => {
    warmTimer = window.setTimeout(warm, 120)
  }
  const cancelWarm = () => {
    if (warmTimer === undefined) return
    window.clearTimeout(warmTimer)
    warmTimer = undefined
  }
  const showPreviewSoon = () => {
    previewTimer = window.setTimeout(() => setPreviewOpen(true), 250)
  }
  const cancelPreview = () => {
    if (previewTimer !== undefined) {
      window.clearTimeout(previewTimer)
      previewTimer = undefined
    }
    setPreviewOpen(false)
  }
  onCleanup(() => {
    cancelWarm()
    cancelPreview()
  })

  const copyToClipboard = (text: string) => {
    void navigator.clipboard.writeText(text).then(() => showToast({ title: language.t("sidebar.thread.menu.copied") }))
  }

  const menuActions: ThreadMenuActions = {
    isPinned: props.pinned,
    onTogglePin: () => layout.tree.toggleThreadPin(props.session.id),
    onRename: () => {
      const current = sessionTitle(props.session.title) || ""
      dialog.show(() => (
        <RenameThreadDialog sessionID={props.session.id} directory={props.directory} initial={current} />
      ))
    },
    onArchive: () => props.onArchive(props.session),
    onRevealInFinder: () => {
      void platform.openPath?.(props.directory)
    },
    onCopyDirectory: () => copyToClipboard(props.directory),
    onCopyId: () => copyToClipboard(props.session.id),
    onCopyLink: () => {
      const url = `wanlaicode://open-session?directory=${encodeURIComponent(props.directory)}&id=${encodeURIComponent(props.session.id)}`
      copyToClipboard(url)
    },
  }

  const row = (
    <ContextMenu>
      <ContextMenu.Trigger
        as={A}
        href={`/${props.slug}/session/${props.session.id}`}
        class="codex-sidebar-thread-row group/thread relative flex w-full items-center h-8 pr-2 rounded-md transition-colors no-underline gap-2"
        classList={{
          "pl-3": !!props.flat,
          "pl-11": !props.flat,
          "codex-sidebar-thread-active": props.active(),
          "codex-sidebar-thread-idle": !props.active(),
        }}
        onMouseEnter={() => {
          setHovering(true)
          warmSoon()
          showPreviewSoon()
        }}
        onMouseLeave={() => {
          setHovering(false)
          cancelWarm()
          cancelPreview()
        }}
        onFocusIn={(event: FocusEvent) => {
          if (!shouldKeepActionFocus(pointerDown, event.target === event.currentTarget)) return
          setActionFocused(true)
        }}
        onFocusOut={() => setActionFocused(false)}
        onPointerDown={() => {
          pointerDown = true
          cancelWarm()
          warm()
        }}
        onPointerUp={() => {
          pointerDown = false
        }}
        onPointerLeave={() => {
          pointerDown = false
        }}
        onPointerCancel={() => {
          pointerDown = false
        }}
        data-action="thread-open"
        data-session={props.session.id}
      >
        {/* 侧栏标题跟随主题 token，避免写死颜色导致 Codex 玻璃背景下文字偏灰 */}
        <span
          class="codex-sidebar-thread-title flex-1 min-w-0 text-14-regular text-text-base group-hover/thread:text-text-strong"
          classList={{ "pr-14": showActions() && !isRunning() }}
        >
          <SidebarHoverScrollText text={title()} hoverClass="text-text-strong" />
        </span>
        <Show when={isAutomation() && !showActions()}>
          <Tooltip value={language.t("automation.thread.tooltip")} placement="top">
            <span
              class="shrink-0 inline-flex items-center justify-center text-icon-base"
              aria-label={language.t("automation.thread.tooltip")}
            >
              <CdxIcon name="clock" size={13} />
            </span>
          </Tooltip>
        </Show>
        <Show
          when={isRunning()}
          fallback={
            <Show when={!showActions()}>
              <span class="shrink-0 text-12-regular text-text-weak">{time()}</span>
            </Show>
          }
        >
          {/* 运行 spinner 在 hover/focus 时为操作按钮预留空间但不卸载，避免用户误以为整体回合已经结束。 */}
          <span class="thread-running-spinner shrink-0" classList={{ "mr-14": showActions() }} aria-hidden="true">
            <ProgressCircle percentage={72} size={14} strokeWidth={2} />
          </span>
        </Show>
        <div
          class="absolute right-1 top-1/2 -translate-y-1/2 flex items-center justify-end gap-0.5 rounded-md pl-3 transition-opacity"
          classList={{
            "opacity-100 pointer-events-auto": showActions(),
            "opacity-0 pointer-events-none": !showActions(),
          }}
        >
          <Tooltip
            value={props.pinned() ? language.t("sidebar.thread.menu.unpin") : language.t("sidebar.thread.menu.pin")}
            placement="right"
          >
            <IconButton
              icon="pin"
              variant="ghost"
              size="small"
              class="size-6 shrink-0"
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                props.onTogglePin(props.session)
              }}
              aria-label={
                props.pinned() ? language.t("sidebar.thread.menu.unpin") : language.t("sidebar.thread.menu.pin")
              }
            />
          </Tooltip>
          <Tooltip value={language.t("sidebar.thread.menu.archive")} placement="right">
            <IconButton
              icon="archive"
              variant="ghost"
              size="small"
              class="size-6 shrink-0"
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                props.onArchive(props.session)
              }}
              aria-label={language.t("sidebar.thread.menu.archive")}
            />
          </Tooltip>
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ThreadContextMenuContent {...menuActions} />
      </ContextMenu.Portal>
    </ContextMenu>
  )

  return (
    <HoverCard
      trigger={row}
      open={previewOpen()}
      placement="right-start"
      gutter={8}
      openDelay={0}
      closeDelay={0}
      class="codex-sidebar-thread-preview w-80"
    >
      <div class="flex flex-col gap-3">
        <div class="flex items-start gap-3">
          <div class="min-w-0 flex-1 truncate text-15-medium text-text-strong">{title()}</div>
          <div class="shrink-0 text-14-regular text-text-weak">{time()}</div>
        </div>
        <div class="flex flex-col gap-2">
          <div class="flex items-center gap-3 min-w-0 text-14-regular text-text-base">
            <Icon name="folder" size="small" class="shrink-0 text-icon-base" />
            <span class="truncate">{projectName()}</span>
          </div>
        </div>
      </div>
    </HoverCard>
  )
}
