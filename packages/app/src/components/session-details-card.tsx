import {
  Component,
  For,
  Match,
  ParentProps,
  Show,
  Switch,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  on,
  onCleanup,
} from "solid-js"
import { Portal } from "solid-js/web"
import { DiffChanges } from "@opencode-ai/ui/diff-changes"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Icon } from "@opencode-ai/ui/icon"
import type { IconName } from "@opencode-ai/ui/icon"
import { Button } from "@opencode-ai/ui/button"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { GitCommitIcon } from "@/components/git-commit-icon"
import type { Todo } from "@opencode-ai/sdk/v2"
import { useLanguage } from "@/context/language"
import { BranchPickerControl, ExecutionModeControl } from "@/components/session-environment-controls"
import {
  envRowEndIconClass,
  gitOpsCommitMenuItemDisabled,
  gitOpsPrimaryAction,
  gitOpsPrimaryEnabled,
  gitOpsPushMenuItemDisabled,
} from "@/components/session-details-card-git-ops"
import { prRowState, type ExistingPullRequest, type PrRowState } from "@/components/session-details-card-pr"
import {
  formatOutputArtifactDisplayPath,
  isOutputArtifactImagePath,
  loadOutputArtifactImagePreview,
} from "@/components/session-details-card-sources"
import { FileIcon } from "@opencode-ai/ui/file-icon"
import { usePlatform } from "@/context/platform"
import { useSDK } from "@/context/sdk"
import { openHttpUrl } from "@/utils/open-http-url"

export { prRowState, type ExistingPullRequest, type PrRowState } from "@/components/session-details-card-pr"

export type HeaderAction = {
  id: string
  name: string
  command: string
  icon?: IconName
}

/**
 * 统计 todo 列表的「完成 / 总数」。
 * `completed` 与 `cancelled` 都计入 done；纯函数便于单测。
 */
export function progressCounts(todos: readonly Todo[]): { done: number; total: number } {
  let done = 0
  for (const todo of todos) {
    if (todo.status === "completed" || todo.status === "cancelled") done++
  }
  return { done, total: todos.length }
}

/**
 * 会话侧栏分段卡片：
 *  - 自身只负责 chrome（边框 / 阴影 / 圆角）和相邻 section 之间的自动分隔
 *  - 内容通过 children 组合，section 组件互相独立、可任意增加
 *
 * 约束：每个直接子节点必须是 `<section data-section="...">`。容器靠
 * `[&>section+section]:border-t` 在相邻 section 之间生成分隔；section
 * **内部不要再嵌套 `<section>`**，否则会被同一选择器误命中产生额外分隔线。
 * 如果需要内部分组，请用 `<div>` 或 `<header>` / `<footer>` 等。
 */
export const SessionDetailsCard: Component<ParentProps> = (props) => {
  return (
    <div
      data-component="session-details-card"
      class="flex h-full w-full flex-col overflow-hidden rounded-[12px] bg-background-base shadow-[0_2px_8px_rgba(0,0,0,0.05),0_1px_3px_rgba(0,0,0,0.04)] border border-border-weaker-base [&>section+section]:border-t [&>section+section]:border-border-weaker-base"
    >
      {props.children}
    </div>
  )
}

export interface ProgressSectionProps {
  /** Accessor 返回当前会话的 todos（来自 globalSync.session_todo[sessionID]）。 */
  todos: () => Todo[]
  /** 会话是否正在工作；仅工作时 in_progress 图标才旋转，空闲时显示静态环。 */
  working?: () => boolean
}

/**
 * 渲染 todo 状态图标：
 *  - completed / cancelled：灰色填充圆 + 白色对勾（cancelled 整体降透明度）
 *  - in_progress：旋转 loading 环
 *  - pending：细线空心圆
 */
const TodoStatusIcon: Component<{ status: Todo["status"]; working?: boolean }> = (props) => {
  return (
    <Switch
      fallback={
        // pending 兜底
        <span
          class="shrink-0 mt-1 size-3 rounded-full border border-border-weak-base"
          aria-label={props.status}
        />
      }
    >
      <Match when={props.status === "completed" || props.status === "cancelled"}>
        <svg
          classList={{
            "shrink-0 mt-0.5 size-3.5 text-icon-base": true,
            "opacity-40": props.status === "cancelled",
          }}
          viewBox="0 0 20 20"
          aria-label={props.status}
        >
          <circle cx="10" cy="10" r="8" fill="currentColor" />
          <path
            d="M6.25 10.25L8.75 12.5L13.5 7.5"
            stroke="white"
            stroke-width="1.6"
            stroke-linecap="round"
            stroke-linejoin="round"
            fill="none"
          />
        </svg>
      </Match>
      <Match when={props.status === "in_progress"}>
        {/* origin-center 必须显式声明：SVG 默认 transform-origin 是 (0,0)，
            animate-spin 的 rotate 会绕左上角转，看起来不动。
            仅在会话实际工作时旋转；会话空闲（如用户中止）时显示静态环，避免「一直转圈」。 */}
        <svg
          classList={{
            "shrink-0 mt-0.5 size-3.5 origin-center text-icon-base": true,
            "animate-spin": !!props.working,
          }}
          viewBox="0 0 24 24"
          fill="none"
          aria-label={props.status}
        >
          <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-opacity="0.25" stroke-width="3" />
          <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" stroke-width="3" stroke-linecap="round" />
        </svg>
      </Match>
    </Switch>
  )
}

export const ProgressSection: Component<ProgressSectionProps> = (props) => {
  const language = useLanguage()
  const counts = createMemo(() => progressCounts(props.todos()))
  const allDone = createMemo(() => {
    const c = counts()
    return c.total > 0 && c.done === c.total
  })

  // open 跟随 allDone（done 时折叠、未 done 时展开），一旦用户手动点过就「锁住」
  // 当前状态，不再被自动逻辑覆盖。包括历史会话首次挂载（allDone 已 true）也按
  // 此规则自动收起。
  const [open, setOpen] = createSignal(true)
  const [userToggled, setUserToggled] = createSignal(false)
  createEffect(
    on(
      allDone,
      (done) => {
        if (userToggled()) return
        setOpen(!done)
      },
      { defer: false },
    ),
  )

  return (
    // 没有 todos 时整段不渲染（隐藏 header / 计数 / 列表）。
    // 容器的 [&>section+section]:border-t 也会自然不为其画分隔。
    <Show when={counts().total > 0}>
      <section data-section="progress">
        <button
          type="button"
          class="w-full flex items-center px-3 py-2.5 select-none hover:bg-[rgba(0,0,0,0.03)] transition-colors"
          aria-expanded={open()}
          onClick={() => {
            setUserToggled(true)
            setOpen((v) => !v)
          }}
        >
          <span class="flex items-center gap-1 min-w-0">
            <Icon
              name="chevron-down"
              size="small"
              classList={{
                "shrink-0 text-icon-weak transition-transform": true,
                "-rotate-90": !open(),
              }}
            />
            <span class="text-13-medium text-text-strong">
              {language.t("branch.details.card.progress")}
            </span>
          </span>
        </button>
        <Show when={open()}>
          <div class="px-1 pb-2">
            <ul class="flex flex-col">
              <For each={props.todos()}>
                {(todo) => (
                  <li class="flex items-start gap-2 mx-1 px-2 py-1.5 text-13-regular leading-tight">
                    <TodoStatusIcon status={todo.status} working={props.working?.()} />
                    <span class="text-text-base">{todo.content}</span>
                  </li>
                )}
              </For>
            </ul>
          </div>
        </Show>
      </section>
    </Show>
  )
}

const Spinner = () => (
  <svg
    class="size-3.5 animate-spin text-icon-weak shrink-0"
    viewBox="0 0 24 24"
    fill="none"
    aria-hidden="true"
  >
    <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-opacity="0.25" stroke-width="3" />
    <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" stroke-width="3" stroke-linecap="round" />
  </svg>
)

export interface GitSectionProps {
  changesTotals: () => { additions: number; deletions: number }
  /** 推送是否正在执行，用来切换 spinner 并禁用推送按钮 */
  busy?: () => boolean
  showEnvironmentControls?: boolean
  onNewSessionWorktreeCreate?: () => void
  onOpenReview: () => void
  onCommit?: () => void
  onPush?: () => void
  /** 未提交 + 未暂存文件数，用于切换提交/推送主操作 */
  uncommittedCount?: () => number
  /** 分支未在远端或存在未推送提交 */
  needsPush?: () => boolean
  onCreateBranch?: () => void
  /** 项目操作按钮相关 */
  headerActionItems?: HeaderAction[]
  headerActionRunning?: string | undefined
  headerActionLabel?: string
  projectName?: string
  onHeaderActionRun?: (action: HeaderAction) => void
  onHeaderActionOpenRunDialog?: () => void
  onHeaderActionPin?: (id: string) => void
  onHeaderActionAdd?: () => void
  onHeaderActionContextMenu?: (event: MouseEvent, action: HeaderAction) => void
  onHeaderActionContextMenuClose?: () => void
  headerActionContextMenuOpen?: boolean
  headerActionContextMenuAction?: HeaderAction | undefined
  headerActionContextMenuPosition?: { x: number; y: number }
  onHeaderActionEdit?: (action: HeaderAction) => void
  onHeaderActionDelete?: (action: HeaderAction) => void
  activeHeaderAction?: HeaderAction | undefined
  /** 环境相关 */
  environments?: { name: string; filename: string }[]
  currentEnvironment?: string | undefined
  onEnvironmentChange?: (filename: string | null) => void
  onEnvironmentSettings?: () => void
  onLoadEnvironments?: () => void
  gitAvailable?: () => boolean
  ghCli?: () => boolean | undefined
  ghAuthenticated?: () => boolean | undefined
  existingPullRequest?: () => ExistingPullRequest | undefined
  /** PR readiness 请求进行中（避免误判为不可用） */
  prReadinessPending?: () => boolean
  /** PR readiness 请求失败且无缓存 */
  prReadinessFailed?: () => boolean
  /** PR 状态轻量刷新进行中 */
  prRefreshPending?: () => boolean
  onCreatePullRequest?: () => void
  onOpenPullRequest?: (url: string) => void
  /** 刷新当前分支的 PR 状态（轻量检测） */
  onRefreshPullRequest?: () => void
  /** 将文本填入会话输入栏（不提交） */
  onPastePromptText?: (text: string) => void
}

export const GitSection: Component<GitSectionProps> = (props) => {
  const language = useLanguage()
  const hasUncommitted = createMemo(() => (props.uncommittedCount?.() ?? 0) > 0)
  const needsPush = createMemo(() => props.needsPush?.() ?? false)
  const primaryAction = createMemo(() => gitOpsPrimaryAction(hasUncommitted(), needsPush()))
  const primaryEnabled = createMemo(() =>
    gitOpsPrimaryEnabled(hasUncommitted(), needsPush(), primaryAction()),
  )
  const commitMenuItemDisabled = createMemo(() => gitOpsCommitMenuItemDisabled(hasUncommitted()))
  const pushMenuItemDisabled = createMemo(() => gitOpsPushMenuItemDisabled(needsPush()))
  const primaryDisabledReason = createMemo(() => {
    if (primaryAction() === "push") return language.t("branch.details.card.nothingToPush")
    return language.t("branch.details.card.nothingToCommit")
  })
  let contextMenuRef: HTMLDivElement | undefined
  const [envExpanded, setEnvExpanded] = createSignal(false)
  const isNoEnv = () => props.currentEnvironment === undefined
  const headerActionIcon = (action?: HeaderAction) => action?.icon ?? "run"
  const showQuickHeaderAction = () => !isNoEnv() && !!props.activeHeaderAction && (props.headerActionItems?.length ?? 0) > 0

  const closeContextMenu = () => {
    props.onHeaderActionContextMenuClose?.()
  }

  const handleDocumentPointerDown = (event: PointerEvent) => {
    if (!props.headerActionContextMenuOpen) return
    if (contextMenuRef?.contains(event.target as Node)) return
    closeContextMenu()
  }

  createEffect(() => {
    if (!props.headerActionContextMenuOpen) return
    document.addEventListener("pointerdown", handleDocumentPointerDown, true)
  })

  onCleanup(() => {
    document.removeEventListener("pointerdown", handleDocumentPointerDown, true)
  })

  const prState = createMemo(() =>
    prRowState(
      !!props.gitAvailable?.(),
      props.ghCli?.(),
      props.ghAuthenticated?.(),
      props.existingPullRequest?.(),
      props.prReadinessPending?.(),
      props.prReadinessFailed?.(),
    ),
  )
  const existingPrTitle = createMemo(() => {
    const pr = props.existingPullRequest?.()
    if (!pr?.url) return ""
    return pr.title?.trim() || pr.url
  })
  const prLabel = createMemo(() => {
    const state = prState()
    if (state === "create") return language.t("branch.details.card.createPullRequest")
    if (state === "loading") return language.t("branch.details.card.prLoading")
    if (state === "error") return language.t("branch.details.card.prRefreshFailed")
    if (state === "gh-cli") return language.t("dialog.createPullRequest.unlock.gh-cli")
    if (state === "gh-auth") return language.t("dialog.createPullRequest.unlock.gh-auth")
    return language.t("branch.details.card.prUnavailable")
  })
  const [expanded, setExpanded] = createSignal(true)
  return (
    <section data-section="git">
      <div class="flex items-center justify-between px-3 py-2.5">
        <div class="group/env-header flex items-center text-12-medium min-w-0">
          <span class="text-text-strong truncate">
            {language.t("branch.details.card.title")}
          </span>
          <button
            type="button"
            class="ml-1 inline-flex shrink-0 items-center justify-center self-center p-0 border-0 bg-transparent opacity-0 transition-opacity group-hover/env-header:opacity-100 group-focus-within/env-header:opacity-100 text-icon-weak hover:text-icon-base"
            aria-expanded={expanded()}
            aria-label={expanded() ? language.t("session.todo.collapse") : language.t("session.todo.expand")}
            onClick={() => setExpanded((open) => !open)}
          >
            <Icon
              name="chevron-right"
              class={envRowEndIconClass}
              classList={{ "rotate-90": expanded() }}
            />
          </button>
        </div>
        <div class="flex items-center gap-0.5 shrink-0">
          <Show when={showQuickHeaderAction() && props.activeHeaderAction}>
            {(action) => (
              <Tooltip value={action().name} placement="top" openDelay={200}>
                <Button
                  variant="ghost"
                  class="size-6 p-0 box-border rounded-md"
                  aria-label={action().name}
                  disabled={props.headerActionRunning !== undefined}
                  onClick={() => props.onHeaderActionRun?.(action())}
                >
                  <Icon
                      size="small"
                      name={headerActionIcon(action())}
                      class="text-icon-base"
                      stroke-width="1.3"
                      style={{ transform: "scale(1.06)" }}
                    />
                </Button>
              </Tooltip>
            )}
          </Show>
          <Tooltip value={isNoEnv() ? language.t("branch.details.card.selectEnvironment") : language.t("branch.details.card.projectOperations")} placement="top" openDelay={200}>
            <DropdownMenu placement="bottom-end" gutter={4} onOpenChange={(open) => open && props.onLoadEnvironments?.()}>
              <DropdownMenu.Trigger
                as={Button}
                variant="ghost"
                class="size-6 p-0 box-border rounded-md"
                aria-label={isNoEnv() ? language.t("branch.details.card.selectEnvironment") : language.t("branch.details.card.projectOperations")}
              >
                <Switch>
                  <Match when={isNoEnv()}>
                    <Icon size="small" name="settings-gear" class="text-icon-base" />
                  </Match>
                  <Match when={!isNoEnv()}>
                    <Icon size="small" name="ellipsis-horizontal" class="text-icon-base" />
                  </Match>
                </Switch>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  // 必须给上界：dropdown-menu-content 只有 min-width 没有 max-width，
                  // 长环境名/操作名会把菜单一路撑宽，子项的 truncate 永远不会触发。
                  class="codex-chat-menu min-w-[220px] max-w-[320px]"
                  onCloseAutoFocus={(event) => event.preventDefault()}
                >
                  <Switch>
                    <Match when={isNoEnv()}>
                      <DropdownMenu.Item
                        onSelect={() => props.onEnvironmentChange?.(null)}
                        classList={{ "bg-surface-raised-base-hover": isNoEnv() }}
                      >
                        <DropdownMenu.ItemLabel>{language.t("branch.details.card.noEnvironment")}</DropdownMenu.ItemLabel>
                        <Icon name="check" size="small" class="ml-auto text-icon-weak" />
                      </DropdownMenu.Item>
                      <For each={props.environments ?? []}>
                        {(env) => (
                          <DropdownMenu.Item
                            onSelect={() => props.onEnvironmentChange?.(env.filename)}
                            classList={{ "bg-surface-raised-base-hover": props.currentEnvironment === env.filename }}
                          >
                            <Show when={env.filename === "environment.toml"}>
                              <Icon name="star-outline" size="small" class="text-icon-weak" />
                            </Show>
                            {/* min-w-0 是冗余保险：truncate 自带 overflow:hidden，按 Flexbox §4.5
                                min-width:auto 此时已自动解析为 0。真正让省略号生效的是菜单容器的 max-w。 */}
                            <DropdownMenu.ItemLabel class="min-w-0 truncate">{env.name}</DropdownMenu.ItemLabel>
                            <Show when={props.currentEnvironment === env.filename}>
                              <Icon name="check" size="small" class="ml-auto text-icon-weak" />
                            </Show>
                          </DropdownMenu.Item>
                        )}
                      </For>
                      <DropdownMenu.Separator />
                      <DropdownMenu.Item onSelect={() => props.onEnvironmentSettings?.()}>
                        <Icon name="settings-gear" size="small" class="text-icon-weak" />
                        <DropdownMenu.ItemLabel>{language.t("branch.details.card.environmentSettings")}</DropdownMenu.ItemLabel>
                      </DropdownMenu.Item>
                    </Match>
                    <Match when={!isNoEnv()}>
                      <DropdownMenu.Group>
                        <DropdownMenu.GroupLabel class="!px-1 !py-1 truncate">{props.projectName ?? ""} {language.t("branch.details.card.projectOperations")}</DropdownMenu.GroupLabel>
                        <For each={props.headerActionItems ?? []}>
                          {(action, index) => (
                            <DropdownMenu.Item
                              onContextMenu={(event: MouseEvent) => props.onHeaderActionContextMenu?.(event, action)}
                              onSelect={() => {
                                props.onHeaderActionPin?.(action.id)
                                props.onHeaderActionRun?.(action)
                              }}
                            >
                              <Icon
                                name={headerActionIcon(action)}
                                size="small"
                                class="text-icon-strong-base"
                                stroke-width="1.3"
                                style={{ transform: "scale(1.06)" }}
                              />
                              <DropdownMenu.ItemLabel class="min-w-0 truncate">{action.name}</DropdownMenu.ItemLabel>
                              <Show when={props.activeHeaderAction?.id === action.id}>
                                <Icon name="check" size="small" class="ml-auto text-icon-weak" />
                              </Show>
                            </DropdownMenu.Item>
                          )}
                        </For>
                      </DropdownMenu.Group>
                      <DropdownMenu.Item onSelect={() => props.onHeaderActionAdd?.()}>
                        <Icon name="plus-small" size="small" class="text-icon-weak" />
                        <DropdownMenu.ItemLabel>{language.t("branch.details.card.addOperation")}</DropdownMenu.ItemLabel>
                      </DropdownMenu.Item>
                      <DropdownMenu.Separator />
                      <DropdownMenu.Item
                        closeOnSelect={false}
                        onSelect={() => {
                          setEnvExpanded(!envExpanded())
                          props.onLoadEnvironments?.()
                        }}
                      >
                        <Icon name="settings-gear" size="small" class="text-icon-weak" />
                        <DropdownMenu.ItemLabel>{language.t("branch.details.card.changeEnvironment")}</DropdownMenu.ItemLabel>
                        <Icon name="chevron-right" size="small" class="ml-auto text-icon-weak" classList={{ "rotate-90": envExpanded() }} />
                      </DropdownMenu.Item>
                      <div
                        class="overflow-hidden transition-all duration-200 ease-out"
                        style={{ "max-height": envExpanded() ? "200px" : "0px", opacity: envExpanded() ? 1 : 0 }}
                      >
                        <DropdownMenu.Separator />
                        <DropdownMenu.Item onSelect={() => props.onEnvironmentChange?.(null)}
                          classList={{ "bg-surface-raised-base-hover": props.currentEnvironment === undefined }}
                        >
                          <DropdownMenu.ItemLabel>{language.t("branch.details.card.noEnvironment")}</DropdownMenu.ItemLabel>
                          <Show when={props.currentEnvironment === undefined}>
                            <Icon name="check" size="small" class="ml-auto text-icon-weak" />
                          </Show>
                        </DropdownMenu.Item>
                        <For each={props.environments ?? []}>
                          {(env) => (
                            <DropdownMenu.Item
                              onSelect={() => props.onEnvironmentChange?.(env.filename)}
                              classList={{ "bg-surface-raised-base-hover": props.currentEnvironment === env.filename }}
                            >
                              <Show when={env.filename === "environment.toml"}>
                                <Icon name="star-outline" size="small" class="text-icon-weak" />
                              </Show>
                              <DropdownMenu.ItemLabel class="min-w-0 truncate">{env.name}</DropdownMenu.ItemLabel>
                              <Show when={props.currentEnvironment === env.filename}>
                                <Icon name="check" size="small" class="ml-auto text-icon-weak" />
                              </Show>
                            </DropdownMenu.Item>
                          )}
                        </For>
                        <DropdownMenu.Separator />
                        <DropdownMenu.Item onSelect={() => props.onEnvironmentSettings?.()}>
                          <Icon name="settings-gear" size="small" class="text-icon-weak" />
                          <DropdownMenu.ItemLabel>{language.t("branch.details.card.environmentSettings")}</DropdownMenu.ItemLabel>
                        </DropdownMenu.Item>
                      </div>
                    </Match>
                  </Switch>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu>
          </Tooltip>
          <Portal>
            <Show when={props.headerActionContextMenuOpen && props.headerActionContextMenuAction}>
              {(action) => (
                <div
                  ref={contextMenuRef}
                  data-component="dropdown-menu-content"
                  class="codex-chat-menu fixed z-[200] min-w-[140px]"
                  style={{
                    left: `${(props.headerActionContextMenuPosition ?? { x: 0, y: 0 }).x}px`,
                    top: `${(props.headerActionContextMenuPosition ?? { x: 0, y: 0 }).y}px`,
                    "-webkit-app-region": "no-drag",
                    "pointer-events": "auto",
                  }}
                  role="menu"
                  onPointerDown={(event) => event.stopPropagation()}
                >
                  <button
                    type="button"
                    data-slot="dropdown-menu-item"
                    class="w-full hover:bg-surface-raised-base-hover"
                    role="menuitem"
                    onClick={() => props.onHeaderActionEdit?.(action())}
                  >
                    <Icon name="edit" size="small" class="text-icon-weak" />
                    <span data-slot="dropdown-menu-item-label">{language.t("branch.details.card.edit")}</span>
                  </button>
                  <button
                    type="button"
                    data-slot="dropdown-menu-item"
                    class="w-full hover:bg-surface-raised-base-hover"
                    role="menuitem"
                    onClick={() => props.onHeaderActionDelete?.(action())}
                  >
                    <Icon name="trash" size="small" class="text-icon-weak" />
                    <span data-slot="dropdown-menu-item-label">{language.t("branch.details.card.delete")}</span>
                  </button>
                </div>
              )}
            </Show>
          </Portal>
        </div>
      </div>
      <Show when={expanded()}>
      <div class="flex flex-col px-1 pb-2">
        <button
          type="button"
          class="flex items-center gap-2 mx-1 px-2 py-1.5 rounded-md text-13-regular text-text-strong hover:bg-surface-raised-base-hover transition-colors text-left"
          onClick={() => {
            props.onOpenReview()
          }}
        >
          <Icon name="review" size="small" class="text-icon-weak shrink-0" />
          <span class="flex-1 truncate">{language.t("branch.details.card.changes")}</span>
          <DiffChanges
            class="shrink-0 [&_[data-slot=diff-changes-additions]]:text-12-regular [&_[data-slot=diff-changes-deletions]]:text-12-regular"
            changes={props.changesTotals()}
          />
        </button>
        <Show when={props.showEnvironmentControls}>
          <ExecutionModeControl variant="menu" />
          <BranchPickerControl
            variant="menu"
            onNewSessionWorktreeCreate={props.onNewSessionWorktreeCreate}
          />
        </Show>
        <div class="group/gitops flex items-center gap-0.5 mx-1 min-w-0">
          <Tooltip
            class="flex flex-1 min-w-0"
            value={primaryDisabledReason()}
            inactive={primaryEnabled() || !!props.busy?.()}
          >
            <button
              type="button"
              classList={{
                "flex w-full flex-1 items-center gap-2 min-w-0 px-2 py-1.5 rounded-md text-13-regular text-left transition-colors": true,
                "text-text-strong hover:bg-[rgba(0,0,0,0.04)]": primaryEnabled() && !props.busy?.(),
                "text-text-weak cursor-default opacity-70": !primaryEnabled() || !!props.busy?.(),
              }}
              disabled={!primaryEnabled() || !!props.busy?.()}
              aria-busy={!!props.busy?.()}
              onClick={() => {
                if (!primaryEnabled() || props.busy?.()) return
                if (primaryAction() === "commit") props.onCommit?.()
                else props.onPush?.()
              }}
            >
            <Show
              when={props.busy?.()}
              fallback={
                <Show when={primaryAction() === "push"} fallback={<GitCommitIcon />}>
                  <Icon name="cloud-upload" size="small" class="text-icon-weak shrink-0" />
                </Show>
              }
            >
              <Spinner />
            </Show>
            <span class="flex-1 truncate">
              {primaryAction() === "push"
                ? language.t("branch.details.card.push")
                : language.t("branch.details.card.commit")}
            </span>
          </button>
          </Tooltip>
          <div
            class="shrink-0 opacity-0 transition-opacity group-hover/gitops:opacity-100 group-focus-within/gitops:opacity-100"
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
          >
            <Tooltip value={language.t("branch.details.card.gitOps")}>
              <DropdownMenu placement="right-start" gutter={4}>
                <DropdownMenu.Trigger
                  as="button"
                  type="button"
                  class="flex items-center justify-center size-7 rounded-md text-icon-weak hover:text-icon-base hover:bg-[rgba(0,0,0,0.04)] transition-colors"
                  aria-label={language.t("branch.details.card.gitOps")}
                  disabled={!!props.busy?.()}
                >
                  <Icon name="ellipsis-horizontal" size="small" />
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content class="codex-chat-menu min-w-[168px]">
                    <DropdownMenu.Item
                      disabled={commitMenuItemDisabled()}
                      onSelect={() => {
                        if (commitMenuItemDisabled()) return
                        props.onCommit?.()
                      }}
                    >
                      <GitCommitIcon />
                      <DropdownMenu.ItemLabel>{language.t("branch.details.card.commit")}</DropdownMenu.ItemLabel>
                    </DropdownMenu.Item>
                    <DropdownMenu.Item
                      disabled={pushMenuItemDisabled()}
                      onSelect={() => {
                        if (pushMenuItemDisabled()) return
                        props.onPush?.()
                      }}
                    >
                      <Icon name="cloud-upload" size="small" class="text-icon-weak" />
                      <DropdownMenu.ItemLabel>{language.t("branch.details.card.push")}</DropdownMenu.ItemLabel>
                    </DropdownMenu.Item>
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu>
            </Tooltip>
          </div>
        </div>
        <Switch>
          <Match when={prState() === "exists"}>
            <div class="flex items-center gap-2 mx-1 px-2 py-1.5 text-13-regular text-text-strong min-w-0">
              <Icon name="git-pull-request" size="small" class="text-icon-weak shrink-0" />
              <span class="flex-1 min-w-0 truncate">{existingPrTitle()}</span>
              <button
                type="button"
                class="shrink-0 flex items-center justify-center rounded-md p-0.5 text-icon-weak hover:text-icon-base hover:bg-[rgba(0,0,0,0.04)] transition-colors disabled:opacity-50"
                aria-label={language.t("branch.details.card.refreshPullRequest")}
                disabled={props.prRefreshPending?.()}
                onClick={() => props.onRefreshPullRequest?.()}
              >
                <Show when={props.prRefreshPending?.()} fallback={<Icon name="refresh-cw" class={envRowEndIconClass} />}>
                  <Spinner />
                </Show>
              </button>
              <button
                type="button"
                class="shrink-0 flex items-center justify-center rounded-md p-0.5 text-icon-weak hover:text-icon-base hover:bg-[rgba(0,0,0,0.04)] transition-colors"
                aria-label={language.t("branch.details.card.openPullRequest")}
                onClick={() => {
                  const url = props.existingPullRequest?.()?.url
                  if (url) props.onOpenPullRequest?.(url)
                }}
              >
                <Icon name="square-arrow-top-right" class={envRowEndIconClass} />
              </button>
            </div>
          </Match>
          <Match when={prState() === "loading"}>
            <div class="flex items-center gap-2 mx-1 px-2 py-1.5 text-13-regular text-text-weak">
              <Spinner />
              <span class="flex-1 truncate">{prLabel()}</span>
            </div>
          </Match>
          <Match when={prState() === "create"}>
            <button
              type="button"
              classList={{
                "flex items-center gap-2 mx-1 px-2 py-1.5 rounded-md text-13-regular text-left w-full transition-colors": true,
                "text-text-strong hover:bg-[rgba(0,0,0,0.04)]": !props.busy?.(),
                "text-text-weak pointer-events-none opacity-70": !!props.busy?.(),
              }}
              disabled={!!props.busy?.()}
              aria-busy={!!props.busy?.()}
              onClick={() => {
                props.onCreatePullRequest?.()
              }}
            >
              <Show when={props.busy?.()} fallback={<Icon name="github" size="small" class="text-icon-weak shrink-0" />}>
                <Spinner />
              </Show>
              <span class="flex-1 truncate">{prLabel()}</span>
            </button>
          </Match>
          <Match when={prState() === "gh-cli"}>
            <Tooltip
              placement="top"
              class="flex w-full min-w-0"
              value={language.t("branch.details.card.installGhCliClickHint")}
            >
              <button
                type="button"
                class="flex w-full items-center gap-2 mx-1 px-2 py-1.5 rounded-md text-13-regular text-left transition-colors text-text-weak hover:text-text-strong hover:bg-[rgba(0,0,0,0.04)]"
                onClick={() =>
                  props.onPastePromptText?.(language.t("branch.details.card.installGhCliPrompt"))
                }
              >
                <Icon name="github" size="small" class="text-icon-weak shrink-0" />
                <span class="flex-1 truncate">{prLabel()}</span>
              </button>
            </Tooltip>
          </Match>
          <Match when={prState() === "gh-auth"}>
            <Tooltip
              placement="top"
              class="flex w-full min-w-0"
              value={language.t("branch.details.card.authGhCliPrompt")}
            >
              <button
                type="button"
                class="flex w-full items-center gap-2 mx-1 px-2 py-1.5 rounded-md text-13-regular text-left transition-colors text-text-weak hover:text-text-strong hover:bg-[rgba(0,0,0,0.04)]"
                onClick={() =>
                  props.onPastePromptText?.(language.t("branch.details.card.authGhCliPrompt"))
                }
              >
                <Icon name="github" size="small" class="text-icon-weak shrink-0" />
                <span class="flex-1 truncate">{prLabel()}</span>
              </button>
            </Tooltip>
          </Match>
          <Match when={prState() === "error"}>
            <button
              type="button"
              class="flex items-center gap-2 mx-1 px-2 py-1.5 rounded-md text-13-regular text-left w-full transition-colors text-text-weak hover:text-text-strong hover:bg-[rgba(0,0,0,0.04)] disabled:opacity-70"
              disabled={props.prRefreshPending?.()}
              onClick={() => props.onRefreshPullRequest?.()}
            >
              <Show when={props.prRefreshPending?.()} fallback={<Icon name="github" size="small" class="text-icon-weak shrink-0" />}>
                <Spinner />
              </Show>
              <span class="flex-1 truncate">{prLabel()}</span>
            </button>
          </Match>
          <Match when={true}>
            <div class="flex items-center gap-2 mx-1 px-2 py-1.5 text-13-regular text-text-weak">
              <Icon name="github" size="small" class="text-icon-weak shrink-0" />
              <span class="flex-1 truncate">{prLabel()}</span>
            </div>
          </Match>
        </Switch>
      </div>
      </Show>
    </section>
  )
}

export {
  formatOutputArtifactDisplayPath,
  sessionHasWebSearch,
  sessionWebSourceUrls,
  sessionsWebSourceUrls,
  uniquePreserveOrder,
} from "@/components/session-details-card-sources"

export interface OutputSectionProps {
  files: () => readonly string[]
  workspaceRoot?: () => string | undefined
  previewUrls?: () => ReadonlyMap<string, string>
  previewKey?: (path: string) => string
  onOpenFile?: (path: string) => void
  onExpandedChange?: (expanded: boolean) => void
}

const OUTPUT_VISIBLE_LIMIT = 6

const SectionToggleHeader: Component<{
  variant: "output" | "sources"
  title: string
  count?: () => number
  open: boolean
  onToggle: () => void
  dataSlot: string
  sticky?: boolean
}> = (props) => {
  const language = useLanguage()
  const groupClass = props.variant === "output" ? "group/output-header" : "group/sources-header"
  const groupHoverClass =
    props.variant === "output"
      ? "group-hover/output-header:opacity-100 group-focus-within/output-header:opacity-100"
      : "group-hover/sources-header:opacity-100 group-focus-within/sources-header:opacity-100"
  return (
    <div
      data-slot={props.dataSlot}
      classList={{
        [groupClass]: true,
        "flex items-center shrink-0 px-3 py-2.5 text-12-regular text-text-weak min-w-0 bg-background-base": true,
        "sticky top-0 z-[1]": props.sticky !== false,
      }}
    >
      <span class="truncate">{props.title}</span>
      <Show when={props.count !== undefined && props.count() > 0}>
        <span class="shrink-0 tabular-nums ml-1">{props.count!()}</span>
      </Show>
      <button
        type="button"
        class={`ml-1 inline-flex shrink-0 items-center justify-center self-center p-0 border-0 bg-transparent opacity-0 transition-opacity text-icon-weak hover:text-icon-base ${groupHoverClass}`}
        aria-expanded={props.open}
        aria-label={props.open ? language.t("session.todo.collapse") : language.t("session.todo.expand")}
        onClick={() => props.onToggle()}
      >
        <Icon
          name="chevron-right"
          class={envRowEndIconClass}
          classList={{ "rotate-90": props.open }}
        />
      </button>
    </div>
  )
}

const OutputFileRow: Component<{
  path: string
  label: string
  inlinePreview?: string
  workspaceRoot?: string
  onOpen?: () => void
}> = (props) => {
  const platform = usePlatform()
  const sdk = useSDK()
  const isImage = () => isOutputArtifactImagePath(props.path)
  const [preview] = createResource(
    () => (isImage() && !props.inlinePreview ? props.path : undefined),
    (path) =>
      loadOutputArtifactImagePreview(path, {
        inlineUrl: props.inlinePreview,
        workspaceRoot: props.workspaceRoot,
        readFileAsDataURL: platform.readFileAsDataURL,
        readFile: (filePath) => sdk.client.file.read({ path: filePath }).then((x) => x.data),
      }),
  )
  const previewUrl = () => props.inlinePreview ?? preview()

  return (
    <button
      type="button"
      data-slot="output-row"
      class="mx-1 flex h-[30px] min-h-[30px] items-center gap-2 rounded-md px-2 text-13-regular text-text-strong hover:bg-surface-raised-base-hover transition-colors text-left min-w-0 box-border"
      onClick={() => props.onOpen?.()}
      title={props.label}
    >
      <Show
        when={isImage() && previewUrl()}
        fallback={<FileIcon node={{ path: props.path, type: "file" }} class="size-4 shrink-0" />}
      >
        {(url) => (
          <img
            src={url()}
            alt=""
            class="size-5 shrink-0 rounded object-cover bg-surface-raised-base"
          />
        )}
      </Show>
      <span class="flex-1 truncate">{props.path.split(/[/\\]/).pop() ?? props.path}</span>
    </button>
  )
}

export const OutputSection: Component<OutputSectionProps> = (props) => {
  const language = useLanguage()
  const files = () => props.files()
  const [sectionOpen, setSectionOpen] = createSignal(true)
  const [listExpanded, setListExpanded] = createSignal(false)
  const displayPath = (path: string) => formatOutputArtifactDisplayPath(path, props.workspaceRoot?.())
  const previewKey = (path: string) => props.previewKey?.(path) ?? path
  const inlinePreview = (path: string) => props.previewUrls?.().get(previewKey(path))
  const hiddenCount = () => Math.max(0, files().length - OUTPUT_VISIBLE_LIMIT)
  const visibleFiles = () => (listExpanded() ? files() : files().slice(0, OUTPUT_VISIBLE_LIMIT))

  createEffect(
    on(files, () => setListExpanded(false), { defer: true }),
  )

  createEffect(() => {
    props.onExpandedChange?.(sectionOpen() && listExpanded())
  })

  const toggleSectionOpen = () => {
    setSectionOpen((open) => {
      const next = !open
      if (!next) setListExpanded(false)
      return next
    })
  }

  const outputFooter = () => (
    <div data-slot="output-footer" class="flex h-[35px] shrink-0 items-center">
      <Show when={!listExpanded() && hiddenCount() > 0}>
        <button
          type="button"
          data-slot="output-action"
          class="mx-1 flex h-[30px] items-center rounded-md px-2 text-13-regular text-text-weak text-left box-border"
          onClick={() => setListExpanded(true)}
        >
          {language.t("branch.details.card.output.showMore", { count: hiddenCount() })}
        </button>
      </Show>
      <Show when={listExpanded() && hiddenCount() > 0}>
        <button
          type="button"
          data-slot="output-action"
          class="mx-1 flex h-[30px] items-center rounded-md px-2 text-13-regular text-text-weak text-left box-border"
          onClick={() => setListExpanded(false)}
        >
          {language.t("branch.details.card.output.collapse")}
        </button>
      </Show>
    </div>
  )

  return (
    <section
      data-section="output"
      data-section-open={sectionOpen() ? "true" : "false"}
      data-expanded={listExpanded() ? "true" : "false"}
    >
      <SectionToggleHeader
        variant="output"
        dataSlot="output-header"
        title={language.t("branch.details.card.output")}
        count={() => files().length}
        open={sectionOpen()}
        onToggle={toggleSectionOpen}
      />
      <Show when={sectionOpen()}>
        <div class="flex flex-col px-1">
          <Show
            when={files().length > 0}
            fallback={
              <>
                <div data-slot="output-list" class="flex flex-col">
                  <p data-slot="output-row" class="mx-1 flex items-center px-2 text-13-regular text-text-weak box-border">
                    {language.t("branch.details.card.output.none")}
                  </p>
                </div>
                {outputFooter()}
              </>
            }
          >
            <div data-slot="output-list" class="flex flex-col">
              <For each={visibleFiles()}>
                {(path) => (
                  <OutputFileRow
                    path={path}
                    label={displayPath(path)}
                    inlinePreview={inlinePreview(path)}
                    workspaceRoot={props.workspaceRoot?.()}
                    onOpen={() => props.onOpenFile?.(path)}
                  />
                )}
              </For>
            </div>
            {outputFooter()}
          </Show>
        </div>
      </Show>
    </section>
  )
}

export interface SourcesSectionProps {
  sources: () => readonly string[]
}

export const SourcesSection: Component<SourcesSectionProps> = (props) => {
  const language = useLanguage()
  const platform = usePlatform()
  const sources = () => props.sources()
  const [sectionOpen, setSectionOpen] = createSignal(true)

  return (
    <section
      data-section="sources"
      data-section-open={sectionOpen() ? "true" : "false"}
      class="box-border shrink-0 overflow-hidden border-t border-border-weaker-base"
    >
      <SectionToggleHeader
        variant="sources"
        dataSlot="sources-header"
        title={language.t("branch.details.card.sources")}
        count={() => sources().length}
        open={sectionOpen()}
        onToggle={() => setSectionOpen((open) => !open)}
        sticky={false}
      />
      <Show when={sectionOpen()}>
        <div class="px-1 pb-2">
          <Show
            when={sources().length > 0}
            fallback={
              <p class="mx-1 px-2 py-1.5 text-13-regular text-text-weak">
                {language.t("branch.details.card.sources.none")}
              </p>
            }
          >
            <div class="mx-1 flex flex-wrap items-center gap-0.5 px-2 py-1.5">
              <For each={sources()}>
                {(url) => (
                  <Tooltip placement="top" openDelay={200} value={url}>
                    <a
                      href={url}
                      target="_blank"
                      rel="noopener noreferrer"
                      class="inline-flex items-center justify-center rounded-md p-1 text-icon-weak hover:text-icon-base hover:bg-surface-raised-base-hover transition-colors"
                      aria-label={url}
                      onClick={(event) => {
                        event.preventDefault()
                        event.stopPropagation()
                        openHttpUrl(url, platform.openLink)
                      }}
                    >
                      <Icon name="globe" size="small" />
                    </a>
                  </Tooltip>
                )}
              </For>
            </div>
          </Show>
        </div>
      </Show>
    </section>
  )
}
