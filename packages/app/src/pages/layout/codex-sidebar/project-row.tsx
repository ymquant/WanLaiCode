import { type Accessor, createMemo, createSignal, For, onCleanup, Show, type JSX } from "solid-js"
import { ContextMenu } from "@opencode-ai/ui/context-menu"
import { HoverCard } from "@opencode-ai/ui/hover-card"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { createSortable } from "@thisbeyond/solid-dnd"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { getFilename } from "@opencode-ai/core/util/path"
import type { LocalProject } from "@/context/layout"
import { useLayout } from "@/context/layout"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useNotification } from "@/context/notification"
import { recordIssueAction, stableHash } from "@/utils/issue-report-snapshot"
import { displayName, sortedRootSessionsForProject, sessionSidebarTimestamp } from "../helpers"
import { ThreadRow } from "./thread-row"
import { ProjectRowTitle } from "./project-row-title"
import { ProjectContextMenuContent, type ProjectMenuActions } from "./project-context-menu"
import { relativeTimeUnit } from "./relative-time"


// L1 项目行：图标 + 单名 + hover 显 ✎；右键弹 6 项菜单；下方平铺 thread 列表
export const ProjectRow = (props: {
  project: LocalProject
  activeThreadId: Accessor<string | undefined>
  sortNow: Accessor<number>
  // 「置顶」区的项目行渲染在 projects.tsx 的 DragDropProvider 之外，createSortable 会直接
  // 解构 useDragDropContext() / useSortableContext() 的返回值，拿不到 context 时抛错，
  // 所以那里必须传 false 跳过。缺省即启用，「项目」区无需改动。
  sortable?: boolean
  onArchiveSession: (sessionID: string, directory: string) => Promise<void>
  onCreateWorktree: (project: LocalProject) => void
  onRename: (project: LocalProject) => void
  onRemove: (project: LocalProject) => void
  onNewChatInProject: (project: LocalProject) => void
}): JSX.Element => {
  const layout = useLayout()
  const language = useLanguage()
  const platform = usePlatform()
  const globalSync = useGlobalSync()
  const notification = useNotification()
  const [projectPreviewOpen, setProjectPreviewOpen] = createSignal(false)
  let projectPreviewCloseTimer: number | undefined

  const cancelProjectPreviewClose = () => {
    if (projectPreviewCloseTimer === undefined) return
    window.clearTimeout(projectPreviewCloseTimer)
    projectPreviewCloseTimer = undefined
  }
  const closeProjectPreviewSoon = () => {
    cancelProjectPreviewClose()
    projectPreviewCloseTimer = window.setTimeout(() => {
      setProjectPreviewOpen(false)
      projectPreviewCloseTimer = undefined
    }, 120)
  }
  onCleanup(cancelProjectPreviewClose)
  // 只在 setup 时读一次：Solid 里 primitive 不能条件性创建/销毁，调用方按 section 固定传值。
  const sortable = props.sortable === false ? undefined : createSortable(props.project.worktree)

  const sortBy = () => layout.tree.filter().sortBy
  const allSessions = createMemo(() => {
    const [store] = globalSync.child(props.project.worktree, { bootstrap: false })
    return sortedRootSessionsForProject(store, props.project, props.sortNow(), sortBy())
  })
  const pinnedThreadSet = createMemo(() => new Set(layout.tree.pinnedThreadList()))

  // 点击项目名行 → 切换该 project 下 thread 列表的折叠/展开（默认展开）
  const expandKey = () => `project:${props.project.worktree}`
  const expanded = layout.tree.expanded(expandKey(), { isActiveProject: true })
  const toggleExpanded = () => layout.tree.toggle(expandKey(), { isActiveProject: true })
  // 已置顶的 thread 显示在顶部"置顶" section（pinned.tsx），这里要排除。
  // 占位标题 "New session - <ISO>" 仍保留显示——sessionTitle() 会渲染成 "New session"。
  const sessions = createMemo(() => allSessions().filter((s) => !pinnedThreadSet().has(s.id)))
  const isPinned = layout.tree.isPinned(props.project.worktree)
  const directories = createMemo(() => [
    props.project.worktree,
    ...(props.project.sandboxes ?? []),
  ])
  const hasError = createMemo(() => directories().some((d) => notification.project.unseenHasError(d)))
  const errorTime = createMemo(() => {
    const newest = sessions()[0]
    if (!newest) return ""
    const r = relativeTimeUnit(sessionSidebarTimestamp(newest, sortBy()), props.sortNow())
    if (r.unit === "now") return language.t("sidebar.relative.now")
    if (r.unit === "min") return language.t("sidebar.relative.min", { n: r.value })
    if (r.unit === "hour") return language.t("sidebar.relative.hour", { n: r.value })
    if (r.unit === "day") return language.t("sidebar.relative.day", { n: r.value })
    if (r.unit === "week") return language.t("sidebar.relative.week", { n: r.value })
    if (r.unit === "month") return language.t("sidebar.relative.month", { n: r.value })
    return language.t("sidebar.relative.year", { n: r.value })
  })

  const baseName = () => getFilename(props.project.worktree)
  const customName = () => {
    if (!props.project.name || props.project.name === baseName()) return undefined
    return props.project.name
  }
  const previewName = () => displayName(props.project)
  const taskCountLabel = () =>
    language.locale().startsWith("zh")
      ? `${sessions().length} 个任务`
      : `${sessions().length} ${sessions().length === 1 ? "task" : "tasks"}`
  const projectIssueData = () => ({
    project_hash: stableHash(props.project.worktree),
    custom_name_hash: customName() ? stableHash(customName() ?? "") : undefined,
    session_count: sessions().length,
    expanded: expanded(),
    pinned: isPinned(),
    active_thread_hash: props.activeThreadId() ? stableHash(props.activeThreadId() ?? "") : undefined,
  })
  const recordProjectPointer = (name: string, event: PointerEvent | MouseEvent) => {
    recordIssueAction(name, {
      ...projectIssueData(),
      button: event.button,
      ctrl_key: event.ctrlKey,
      meta_key: event.metaKey,
      shift_key: event.shiftKey,
      target_tag: event.target instanceof HTMLElement ? event.target.tagName : undefined,
      active_tag: document.activeElement instanceof HTMLElement ? document.activeElement.tagName : undefined,
    })
  }

  const menuActions: ProjectMenuActions = {
    isPinned,
    hasActiveThread: createMemo(() => sessions().length > 0),
    onTogglePin: () => {
      recordIssueAction("project.menu.togglePin", projectIssueData())
      layout.tree.togglePin(props.project.worktree)
    },
    onRevealInFinder: () => {
      recordIssueAction("project.menu.revealInFinder", projectIssueData())
      void platform.openPath?.(props.project.worktree)
    },
    onCreateWorktree: () => {
      recordIssueAction("project.menu.createWorktree", projectIssueData())
      props.onCreateWorktree(props.project)
    },
    onRename: () => {
      recordIssueAction("project.menu.rename", projectIssueData())
      props.onRename(props.project)
    },
    onArchiveActive: async () => {
      const newest = sessions()[0]
      recordIssueAction("project.menu.archiveActive", {
        ...projectIssueData(),
        session_hash: newest ? stableHash(newest.id) : undefined,
      })
      if (newest) await props.onArchiveSession(newest.id, newest.directory)
    },
    onRemove: () => {
      recordIssueAction("project.menu.remove", projectIssueData())
      props.onRemove(props.project)
    },
  }

  return (
    // 等价于 use:sortable —— Sortable 的类型就是 (el: HTMLElement) => void，solid 把指令
    // 编译成同一时机的 ref 调用；写成 ref 才能允许 sortable 缺省（顺带去掉 @ts-ignore）。
    <div ref={(el) => sortable?.(el)} classList={{ "opacity-30": sortable?.isActiveDraggable }}>
      <HoverCard
        trigger={
          <ContextMenu>
            <ContextMenu.Trigger
              as="button"
              type="button"
              onPointerDown={(event) => recordProjectPointer("project.pointerDown", event)}
              onContextMenu={(event) => recordProjectPointer("project.contextMenu.trigger", event)}
              onFocus={() =>
                recordIssueAction("project.focus", {
                  ...projectIssueData(),
                  active_tag: document.activeElement instanceof HTMLElement ? document.activeElement.tagName : undefined,
                })
              }
              onClick={() => {
                recordIssueAction("project.toggleExpanded", projectIssueData())
                toggleExpanded()
              }}
              onMouseEnter={() => {
                cancelProjectPreviewClose()
                setProjectPreviewOpen(true)
              }}
              onMouseLeave={closeProjectPreviewSoon}
              class="group/project relative flex items-center h-8 pl-4 pr-3 rounded-md text-left w-full hover:bg-[rgba(0,0,0,0.04)] dark:hover:bg-[rgba(255,255,255,0.04)]"
              data-project={base64Encode(props.project.worktree)}
            >
              <Icon name="folder" size="small" class="text-icon-base shrink-0" />
              <span class="ml-3 min-w-0 flex-1">
                <ProjectRowTitle project={props.project} />
              </span>
              <div class="ml-2 shrink-0 flex items-center gap-1 opacity-0 group-hover/project:opacity-100 transition-opacity">
                <Tooltip value={language.t("sidebar.global.newChat")} placement="top">
                  <IconButton
                    icon="pencil-line"
                    variant="ghost"
                    size="small"
                    class="size-6"
                    onClick={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      props.onNewChatInProject(props.project)
                    }}
                    aria-label={language.t("sidebar.global.newChat")}
                  />
                </Tooltip>
              </div>
            </ContextMenu.Trigger>
            <ContextMenu.Portal>
              <ProjectContextMenuContent {...menuActions} />
            </ContextMenu.Portal>
          </ContextMenu>
        }
        open={projectPreviewOpen()}
        placement="right-start"
        openDelay={0}
        closeDelay={0}
        gutter={8}
        class="codex-sidebar-thread-preview w-[400px] max-w-none overflow-hidden [&_[data-slot=hover-card-body]]:!p-0"
      >
        <div
          class="flex flex-col text-14-regular text-text-base"
          onMouseEnter={() => {
            cancelProjectPreviewClose()
            setProjectPreviewOpen(true)
          }}
          onMouseLeave={closeProjectPreviewSoon}
        >
          <div class="flex h-10 items-center gap-3 px-3">
            <Icon name="folder" size="small" class="shrink-0 text-icon-base" />
            <span class="min-w-0 flex-1 truncate text-14-medium text-text-strong">{previewName()}</span>
            <Show when={isPinned()}>
              <Icon name="pin" size="small" class="shrink-0 text-icon-base" />
            </Show>
          </div>
          <div class="flex h-10 items-center gap-3 border-b border-border-weak-base px-3">
            <Icon name="bubble-5" size="small" class="shrink-0 text-icon-base" />
            <span class="min-w-0 flex-1 truncate">{taskCountLabel()}</span>
          </div>
          <div class="flex h-10 items-center gap-3 border-b border-border-weak-base px-3">
            <Icon name="folder" size="small" class="shrink-0 text-icon-base" />
            <span class="min-w-0 flex-1 truncate">{props.project.worktree}</span>
          </div>
          <button
            type="button"
            class="flex h-10 w-full items-center gap-3 px-3 text-left text-text-base hover:bg-surface-base-hover focus-visible:outline-none"
            onClick={(event) => {
              event.preventDefault()
              event.stopPropagation()
              props.onRename(props.project)
            }}
          >
            <Icon name="settings-gear" size="small" class="shrink-0 text-icon-base" />
            <span class="min-w-0 flex-1 truncate">{language.t("common.edit")}</span>
          </button>
        </div>
      </HoverCard>

      <Show when={expanded()}>
        <Show when={hasError() && sessions().length === 0}>
          <div class="flex items-center h-7 pl-8 pr-3 gap-2">
            <Icon name="warning" size="small" class="text-icon-critical-base shrink-0" />
            <span class="flex-1 min-w-0 truncate text-14-regular text-text-base">
              {language.t("sidebar.project.error.worktreeFailed")}
            </span>
            <span class="shrink-0 text-12-regular text-text-weak">{errorTime()}</span>
          </div>
        </Show>

        <Show
          when={sessions().length > 0}
          fallback={
            <div class="px-3 py-1.5 pl-8 text-13-regular text-text-weak">
              {language.t("sidebar.project.noThreads")}
            </div>
          }
        >
          <div class="flex flex-col gap-0.5">
            <For each={sessions()}>
              {(session) => (
                <ThreadRow
                  session={session}
                  directory={session.directory}
                  storeDirectory={props.project.worktree}
                  slug={base64Encode(session.directory)}
                  active={() => props.activeThreadId() === session.id}
                  pinned={() => pinnedThreadSet().has(session.id)}
                  now={props.sortNow}
                  onArchive={(s) => void props.onArchiveSession(s.id, s.directory)}
                  onTogglePin={(s) => layout.tree.toggleThreadPin(s.id)}
                />
              )}
            </For>
          </div>
        </Show>
      </Show>
    </div>
  )
}
