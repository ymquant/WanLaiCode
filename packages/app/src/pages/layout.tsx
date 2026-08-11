import {
  batch,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  on,
  onCleanup,
  onMount,
  ParentProps,
  Show,
  untrack,
  type Accessor,
} from "solid-js"
import { makeEventListener } from "@solid-primitives/event-listener"
import { useLocation, useNavigate, useParams } from "@solidjs/router"
import { useLayout, LocalProject } from "@/context/layout"
import { useGlobalSync } from "@/context/global-sync"
import { mergeMessages } from "@/context/message-order"
import { Persist, persisted } from "@/utils/persist"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { decode64 } from "@/utils/base64"
import { ResizeHandle } from "@opencode-ai/ui/resize-handle"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Tooltip, TooltipKeybind } from "@opencode-ai/ui/tooltip"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Dialog } from "@opencode-ai/ui/dialog"
import { getFilename } from "@opencode-ai/core/util/path"
import { Session, type AddonAvailable, type Message, type RegistryPluginDetail } from "@opencode-ai/sdk/v2/client"
import { usePlatform } from "@/context/platform"
import { useSettings } from "@/context/settings"
import { createStore, produce, reconcile } from "solid-js/store"
import { DragDropProvider, DragDropSensors, DragOverlay, SortableProvider, closestCenter } from "@thisbeyond/solid-dnd"
import type { DragEvent } from "@thisbeyond/solid-dnd"
import { useProviders } from "@/hooks/use-providers"
import { showToast, toaster } from "@opencode-ai/ui/toast"
import { useGlobalSDK } from "@/context/global-sdk"
import { clearWorkspaceTerminals, getTerminalServerScope } from "@/context/terminal"
import {
  invalidateArchivedSessionsList,
  mergeArchivedSessionIntoListCache,
  removeSessionFromSidebar,
  runArchiveInflight,
  requireArchivedSession,
  getSessionAcrossDirectories,
  settleSessionRemovals,
} from "@/components/settings-archived-sessions/sync"
import { showArchiveSessionToast } from "@/components/settings-archived-sessions/archive-toast"
import { unarchiveSession, restoreArchivedSessionsToSidebar } from "@/components/settings-archived-sessions/unarchive"
import { useQueryClient } from "@tanstack/solid-query"
import { dropSessionCaches, pickSessionCacheEvictions } from "@/context/global-sync/session-cache"
import {
  clearSessionPrefetchInflight,
  clearSessionPrefetch,
  getSessionPrefetch,
  isSessionPrefetchCurrent,
  registerSessionPrefetch,
  runSessionPrefetch,
  setSessionPrefetch,
  shouldSkipSessionPrefetch,
} from "@/context/global-sync/session-prefetch"
import { useNotification } from "@/context/notification"
import { formatServerError } from "@/utils/server-errors"
import { resolveError } from "@opencode-ai/core/error/resolve"
import { Binary } from "@opencode-ai/core/util/binary"
import { retry } from "@opencode-ai/core/util/retry"
import { playSoundById } from "@/utils/sound"
import { createAim } from "@/utils/aim"
import { setNavigate } from "@/utils/notification-click"
import { Worktree as WorktreeState } from "@/utils/worktree"
import { setSessionHandoff } from "@/pages/session/handoff"

import { useDialog } from "@opencode-ai/ui/context/dialog"
import { DialogInstallAddon } from "@/components/dialog-install-addon"
import { useTheme, type ColorScheme } from "@opencode-ai/ui/theme/context"
import { useCommand, type CommandOption } from "@/context/command"
import { useIssueReport } from "@/context/issue-report"
import { ConstrainDragXAxis, getDraggableId } from "@/utils/solid-dnd"
import { DebugBar } from "@/components/debug-bar"
import { QuickChatDock } from "@/components/quick-chat-dock"
import { WindowsTitlebar } from "@/components/windows-titlebar"
import { useServer } from "@/context/server"
import { useLanguage, type Locale } from "@/context/language"
import { resetPromptDraft } from "@/context/prompt"
import { pathKey } from "@/utils/path-key"
import { normalizeProjectName, PROJECT_NAME_MAX_LENGTH } from "@/utils/project-name"
import { isScratchSessionPath } from "@/utils/scratch"
import { openNewSession } from "@/utils/new-session"
import { resolveVisibleSessionDirs } from "@/pages/layout/session-dirs"
import {
  applyPath,
  canGoBack as navHistoryCanGoBack,
  canGoForward as navHistoryCanGoForward,
  initialNavHistory,
  normalizePath,
} from "@/utils/nav-history"
import {
  displayName,
  effectiveWorkspaceOrder,
  errorMessage,
  latestRootSession,
  sortedRootSessions,
} from "./layout/helpers"
import {
  collectNewSessionDeepLinks,
  collectOpenProjectDeepLinks,
  collectPluginInstallDeepLinks,
  deepLinkEvent,
  drainPendingDeepLinks,
  type PluginInstallDeepLink,
} from "./layout/deep-links"
import { createInlineEditorController } from "./layout/inline-editor"
import {
  LocalWorkspace,
  SortableWorkspace,
  WorkspaceDragOverlay,
  type WorkspaceSidebarContext,
} from "./layout/sidebar-workspace"
import { ProjectDragOverlay, SortableProject, type ProjectSidebarContext } from "./layout/sidebar-project"
import { SidebarContent } from "./layout/sidebar-shell"
import { CodexSidebar } from "./layout/codex-sidebar/codex-sidebar"
import { SearchDialog } from "./layout/codex-sidebar/search-dialog"
import { DialogRenameProject } from "./layout/codex-sidebar/rename-project-dialog"
import { DialogCreateBlankProject } from "./layout/codex-sidebar/create-blank-project-dialog"
import { BLANK_PROJECT_DEFAULT_BASE, blankProjectCreateErrorKey } from "./layout/codex-sidebar/blank-project"
import type { SettingsTab } from "@/components/dialog-settings"
import SettingsPage from "@/pages/settings"
import { setSessionRouteActive } from "@/context/session-active"
import { setOpenSettingsFn } from "@/context/open-settings"
import { setOpenUserCenterFn } from "@/context/open-user-center"
import type { TabID } from "@/pages/users/types"
import UsersPage from "@/pages/users"
import { openQuickChat } from "@/utils/quick-chat"
import { createBrowserViewsHidden } from "@/components/session/browser-tab"
// TODO(automations): 「自动化」入口暂时下线，对应 handler / JSX props 已注释；功能恢复时一并放开。

function registryPluginAsAddon(info: RegistryPluginDetail): AddonAvailable {
  const manifest = info.manifest
  return {
    key: `${info.slug}@wanlaicode/${info.namespace}`,
    name: info.slug,
    display_name: info.display_name,
    description: info.short_description ?? undefined,
    long_description: info.long_description ?? undefined,
    marketplace_name: "wanlaicode",
    registry_namespace: info.namespace,
    category: info.category ?? manifest?.category ?? undefined,
    installation: "AVAILABLE",
    installed: false,
    logo: info.logo_url ?? undefined,
    brand_color: manifest?.brand_color ?? undefined,
    developer_name: manifest?.developer_name ?? undefined,
    capabilities: manifest?.capabilities,
    website_url: manifest?.website_url ?? undefined,
    privacy_policy_url: manifest?.privacy_policy_url ?? undefined,
    terms_of_service_url: manifest?.terms_of_service_url ?? undefined,
    default_prompt: manifest?.default_prompts,
    screenshots: manifest?.screenshots,
    manifest_skills: manifest?.skills,
  }
}

export default function Layout(props: ParentProps) {
  const [store, setStore, , ready] = persisted(
    Persist.global("layout.page", ["layout.page.v1"]),
    createStore({
      lastProjectSession: {} as { [directory: string]: { directory: string; id: string; at: number } },
      activeProject: undefined as string | undefined,
      activeWorkspace: undefined as string | undefined,
      workspaceOrder: {} as Record<string, string[]>,
      workspaceName: {} as Record<string, string>,
      workspaceBranchName: {} as Record<string, Record<string, string>>,
      workspaceExpanded: {} as Record<string, boolean>,
      gettingStartedDismissed: false,
    }),
  )

  const pageReady = createMemo(() => ready())

  let scrollContainerRef: HTMLDivElement | undefined
  let dialogRun = 0
  let dialogDead = false

  const params = useParams()
  const globalSDK = useGlobalSDK()
  const globalSync = useGlobalSync()
  const queryClient = useQueryClient()
  const layout = useLayout()
  const layoutReady = createMemo(() => layout.ready())
  const platform = usePlatform()
  const settings = useSettings()
  const issueReport = useIssueReport()
  const server = useServer()
  const notification = useNotification()
  const navigate = useNavigate()
  setNavigate(navigate)
  const providers = useProviders()
  const dialog = useDialog()
  const command = useCommand()
  const theme = useTheme()
  const language = useLanguage()
  const initialDirectory = decode64(params.dir)
  const location = useLocation()

  // 1:1 复刻 Codex：back/forward 历史追踪。reducer 抽到 @/utils/nav-history.ts 便于单测覆盖。
  // 注意：只追踪 pathname，忽略 search/hash 变化，避免 query string / hash tab 切换污染 stack。
  const [navHistory, setNavHistory] = createSignal(initialNavHistory())
  createEffect(() => {
    const next = normalizePath(location.pathname)
    setNavHistory((prev) => applyPath(prev, next))
  })
  const canGoBack = createMemo(() => navHistoryCanGoBack(navHistory()))
  const canGoForward = createMemo(() => navHistoryCanGoForward(navHistory()))
  const currentPath = createMemo(() => normalizePath(location.pathname))
  // overlay 路由判断直接看当前 pathname，避免根 /users 场景被目录路由残留 params 干扰而继续显示会话页。
  const isUserCenterRoute = createMemo(() => currentPath() === "/users" || currentPath().endsWith("/users"))
  const settingsPath = createMemo(() => normalizePath(params.dir ? `/${params.dir}/settings` : "/settings"))
  const isSettingsRoute = createMemo(() => currentPath() === "/settings" || currentPath().endsWith("/settings"))
  const isOverlayRoute = createMemo(() => isUserCenterRoute() || isSettingsRoute())
  // 设置面板 overlay 信号：进入 settings 不再路由跳转，改为覆盖层信号，会话永不卸载。
  const [settingsOverlay, setSettingsOverlay] = createSignal<{ tab?: SettingsTab } | null>(null)
  // 个人中心 overlay 信号：进入 users 不再路由跳转，改为覆盖层信号，会话永不卸载。
  const [userCenterOverlay, setUserCenterOverlay] = createSignal<{ tab?: TabID } | null>(null)
  const browserOverlayHidden = createMemo(() => !!settingsOverlay() || !!userCenterOverlay())
  // 同步 sessionRouteActive：overlay 激活时暂停 session 命令注册与全局 keydown 响应。
  createEffect(() => setSessionRouteActive(!settingsOverlay() && !userCenterOverlay()))
  createBrowserViewsHidden(browserOverlayHidden, "overlay")
  // 注册全局 openSettings API，所有入口（session.tsx/message-timeline.tsx 等）统一走此路径。
  setOpenSettingsFn((tab) => setSettingsOverlay({ tab }))
  onCleanup(() => setOpenSettingsFn(() => {}))
  // 注册全局 openUserCenter API，所有入口统一走 overlay 路径。
  setOpenUserCenterFn((tab) => setUserCenterOverlay(tab ? { tab } : {}))
  onCleanup(() => setOpenUserCenterFn(() => {}))

  const route = createMemo(() => {
    const slug = params.dir
    if (!slug) return { slug, dir: "" }
    const dir = decode64(slug)
    if (!dir) return { slug, dir: "" }
    const store = globalSync.peek(dir, { bootstrap: false })
    return {
      slug,
      store,
      dir: store[0].path.directory || dir,
    }
  })
  const availableThemeEntries = createMemo(() => theme.ids().map((id) => [id, theme.themes()[id]] as const))
  const colorSchemeOrder: ColorScheme[] = ["system", "light", "dark"]
  const colorSchemeKey: Record<ColorScheme, "theme.scheme.system" | "theme.scheme.light" | "theme.scheme.dark"> = {
    system: "theme.scheme.system",
    light: "theme.scheme.light",
    dark: "theme.scheme.dark",
  }
  const colorSchemeLabel = (scheme: ColorScheme) => language.t(colorSchemeKey[scheme])
  const currentDir = createMemo(() => route().dir)

  const [state, setState] = createStore({
    autoselect: !initialDirectory,
    busyWorkspaces: {} as Record<string, boolean>,
    hoverProject: undefined as string | undefined,
    scrollSessionKey: undefined as string | undefined,
    nav: undefined as HTMLElement | undefined,
    sortNow: Date.now(),
    sizing: false,
    peek: undefined as string | undefined,
    peeked: false,
    sidebarPeek: false,
    sidebarPopoverOpen: false,
  })

  const editor = createInlineEditorController()
  const setBusy = (directory: string, value: boolean) => {
    const key = pathKey(directory)
    if (value) {
      setState("busyWorkspaces", key, true)
      return
    }
    setState(
      "busyWorkspaces",
      produce((draft) => {
        delete draft[key]
      }),
    )
  }
  const isBusy = (directory: string) => !!state.busyWorkspaces[pathKey(directory)]
  const navLeave = { current: undefined as number | undefined }
  const sortNow = () => state.sortNow
  let sizet: number | undefined
  let sortNowInterval: ReturnType<typeof setInterval> | undefined
  const sortNowTimeout = setTimeout(
    () => {
      setState("sortNow", Date.now())
      sortNowInterval = setInterval(() => setState("sortNow", Date.now()), 60_000)
    },
    60_000 - (Date.now() % 60_000),
  )

  const aim = createAim({
    enabled: () => !layout.sidebar.opened(),
    active: () => state.hoverProject,
    el: () => state.nav?.querySelector<HTMLElement>("[data-component='sidebar-rail']") ?? state.nav,
    onActivate: (directory) => {
      globalSync.child(directory)
      setState("hoverProject", directory)
    },
  })

  onCleanup(() => {
    dialogDead = true
    dialogRun += 1
    if (navLeave.current !== undefined) clearTimeout(navLeave.current)
    clearTimeout(sortNowTimeout)
    if (sortNowInterval) clearInterval(sortNowInterval)
    if (sizet !== undefined) clearTimeout(sizet)
    if (peekt !== undefined) clearTimeout(peekt)
    aim.reset()
  })

  onMount(() => {
    const stop = () => setState("sizing", false)
    const blur = () => reset()
    const hide = () => {
      if (document.visibilityState !== "hidden") return
      reset()
    }
    makeEventListener(window, "pointerup", stop)
    makeEventListener(window, "pointercancel", stop)
    makeEventListener(window, "blur", stop)
    makeEventListener(window, "blur", blur)
    makeEventListener(document, "visibilitychange", hide)

    // dialog-settings 已通过静态 import 内联；剩余体积较大的 model/provider 选择器在 mount 时预热
    void import("@/components/dialog-select-model")
    void import("@/components/dialog-select-provider")
  })

  // 散对话目录：userData/scratch-sessions —— 启动时确保存在，但不注册为普通 project
  const [scratchChatDir, setScratchChatDir] = createSignal<string | undefined>()
  onMount(async () => {
    if (!platform.ensureScratchChatDir) return
    try {
      const dir = await platform.ensureScratchChatDir()
      setScratchChatDir(dir)
      void globalSync.project.loadSessions(dir)
      // 清理旧版本散对话目录在 store 里的残留条目（~/.wanlaicodex/chat_wanlai 与品牌改名后的
      // ~/.wanlaicode/chat_wanlai），否则会在 sidebar "项目" 区错误地多显示一条 chat_wanlai
      // 同时清理曾经误持久化的 scratch-sessions；磁盘上的旧数据不动。
      for (const project of layout.projects.list()) {
        if (
          isScratchSessionPath(project.worktree, dir) ||
          /[/\\]\.wanlaicodex?[/\\]chat_wanlai$/.test(project.worktree)
        ) {
          layout.projects.close(project.worktree)
        }
      }
    } catch {
      // 创建失败不阻塞 sidebar 渲染
    }
  })

  const sidebarHovering = createMemo(() => !layout.sidebar.opened() && state.hoverProject !== undefined)
  const sidebarExpanded = createMemo(() => layout.sidebar.opened() || sidebarHovering())
  const sidebarVisible = createMemo(() => layout.sidebar.opened() || state.sidebarPeek || state.sidebarPopoverOpen)
  const setHoverProject = (value: string | undefined) => {
    setState("hoverProject", value)
    if (value !== undefined) return
    aim.reset()
  }
  const clearHoverProjectSoon = () => queueMicrotask(() => setHoverProject(undefined))

  const disarm = () => {
    if (navLeave.current === undefined) return
    clearTimeout(navLeave.current)
    navLeave.current = undefined
  }

  const reset = () => {
    disarm()
    setHoverProject(undefined)
  }

  const arm = () => {
    if (layout.sidebar.opened()) return
    if (state.hoverProject === undefined) return
    disarm()
    navLeave.current = window.setTimeout(() => {
      navLeave.current = undefined
      setHoverProject(undefined)
    }, 300)
  }

  let peekt: number | undefined

  const hoverProjectData = createMemo(() => {
    const id = state.hoverProject
    if (!id) return
    return layout.projects.list().find((project) => project.worktree === id)
  })

  const peekProject = createMemo(() => {
    const id = state.peek
    if (!id) return
    return layout.projects.list().find((project) => project.worktree === id)
  })

  createEffect(() => {
    const p = hoverProjectData()
    if (p) {
      if (peekt !== undefined) {
        clearTimeout(peekt)
        peekt = undefined
      }
      setState("peek", p.worktree)
      setState("peeked", true)
      return
    }

    setState("peeked", false)
    if (state.peek === undefined) return
    if (peekt !== undefined) clearTimeout(peekt)
    peekt = window.setTimeout(() => {
      peekt = undefined
      setState("peek", undefined)
    }, 180)
  })

  createEffect(() => {
    if (!layout.sidebar.opened()) return
    setHoverProject(undefined)
    setState("sidebarPeek", false)
    setState("sidebarPopoverOpen", false)
  })

  createEffect(() => {
    if (!state.autoselect) return
    const dir = params.dir
    if (!dir) return
    const directory = decode64(dir)
    if (!directory) return
    setState("autoselect", false)
  })

  const editorOpen = editor.editorOpen
  const openEditor = editor.openEditor
  const closeEditor = editor.closeEditor
  const setEditor = editor.setEditor
  const InlineEditor = editor.InlineEditor

  const clearSidebarHoverState = () => {
    if (layout.sidebar.opened()) return
    reset()
    setState("sidebarPeek", false)
    setState("sidebarPopoverOpen", false)
  }

  const navigateWithSidebarReset = (href: string) => {
    clearSidebarHoverState()
    navigate(href)
    layout.mobileSidebar.hide()
  }

  function cycleTheme(direction = 1) {
    const ids = availableThemeEntries().map(([id]) => id)
    if (ids.length === 0) return
    const currentIndex = ids.indexOf(theme.themeId())
    const nextIndex = currentIndex === -1 ? 0 : (currentIndex + direction + ids.length) % ids.length
    const nextThemeId = ids[nextIndex]
    theme.setTheme(nextThemeId)
    showToast({
      title: language.t("toast.theme.title"),
      description: theme.name(nextThemeId),
    })
  }

  function cycleColorScheme(direction = 1) {
    const current = theme.colorScheme()
    const currentIndex = colorSchemeOrder.indexOf(current)
    const nextIndex =
      currentIndex === -1 ? 0 : (currentIndex + direction + colorSchemeOrder.length) % colorSchemeOrder.length
    const next = colorSchemeOrder[nextIndex]
    theme.setColorScheme(next)
    showToast({
      title: language.t("toast.scheme.title"),
      description: colorSchemeLabel(next),
    })
  }

  function setLocale(next: Locale) {
    if (next === language.locale()) return
    language.setLocale(next)
    showToast({
      title: language.t("toast.language.title"),
      description: language.t("toast.language.description", { language: language.label(next) }),
    })
  }

  function cycleLanguage(direction = 1) {
    const locales = language.locales
    const currentIndex = locales.indexOf(language.locale())
    const nextIndex = currentIndex === -1 ? 0 : (currentIndex + direction + locales.length) % locales.length
    const next = locales[nextIndex]
    if (!next) return
    setLocale(next)
  }

  const useUpdatePolling = () =>
    onMount(() => {
      if (!platform.checkUpdate || !platform.updateAndRestart) return

      let toastId: number | undefined
      let toastVersion: string | undefined
      let interval: ReturnType<typeof setInterval> | undefined

      const pollUpdate = () =>
        platform.checkUpdate!().then(({ updateAvailable, version }) => {
          if (!updateAvailable) return
          // 同一版本已弹过就不重复打扰；若检测到更新的版本顶替，则替换掉旧 toast，
          // 否则用户会一直看到那个过时的中间版本号。
          if (toastId !== undefined && toastVersion === version) return
          if (toastId !== undefined) toaster.dismiss(toastId)
          toastVersion = version
          toastId = showToast({
            persistent: true,
            icon: "download",
            title: language.t("toast.update.title"),
            description: language.t("toast.update.description", { version: version ?? "" }),
            actions: [
              {
                label: language.t("toast.update.action.installRestart"),
                onClick: async () => {
                  await platform.updateAndRestart!()
                },
              },
              {
                label: language.t("toast.update.action.notYet"),
                onClick: "dismiss",
              },
            ],
          })
        })

      createEffect(() => {
        if (!settings.ready()) return

        if (!settings.updates.startup()) {
          if (interval === undefined) return
          clearInterval(interval)
          interval = undefined
          return
        }

        if (interval !== undefined) return
        void pollUpdate()
        interval = setInterval(pollUpdate, 10 * 60 * 1000)
      })

      onCleanup(() => {
        if (interval === undefined) return
        clearInterval(interval)
      })
    })

  const useSDKNotificationToasts = () =>
    onMount(() => {
      const toastBySession = new Map<string, number>()
      const alertedAtBySession = new Map<string, number>()
      const cooldownMs = 5000

      const dismissSessionAlert = (sessionKey: string) => {
        const toastId = toastBySession.get(sessionKey)
        if (toastId === undefined) return
        toaster.dismiss(toastId)
        toastBySession.delete(sessionKey)
        alertedAtBySession.delete(sessionKey)
      }

      const unsub = globalSDK.event.listen((e) => {
        if (e.details?.type === "worktree.ready") {
          setBusy(e.name, false)
          WorktreeState.ready(e.name)
          return
        }

        if (e.details?.type === "worktree.failed") {
          setBusy(e.name, false)
          WorktreeState.failed(e.name, e.details.properties?.message ?? language.t("common.requestFailed"))
          return
        }

        if (
          e.details?.type === "question.replied" ||
          e.details?.type === "question.rejected" ||
          e.details?.type === "permission.replied"
        ) {
          const props = e.details.properties as { sessionID: string }
          const sessionKey = `${e.name}:${props.sessionID}`
          dismissSessionAlert(sessionKey)
          return
        }

        if (e.details?.type !== "permission.asked" && e.details?.type !== "question.asked") return
        const title =
          e.details.type === "permission.asked"
            ? language.t("notification.permission.title")
            : language.t("notification.question.title")
        const icon = e.details.type === "permission.asked" ? ("checklist" as const) : ("bubble-5" as const)
        const directory = e.name
        const props = e.details.properties
        const [store] = globalSync.child(directory, { bootstrap: false })
        const session = store.session.find((s) => s.id === props.sessionID)
        const sessionKey = `${directory}:${props.sessionID}`

        const sessionTitle = session?.title ?? language.t("command.session.new")
        const projectName = getFilename(directory)
        const description =
          e.details.type === "permission.asked"
            ? language.t("notification.permission.description", { sessionTitle, projectName })
            : language.t("notification.question.description", { sessionTitle, projectName })
        const href = `/${base64Encode(directory)}/session/${props.sessionID}`

        const now = Date.now()
        const lastAlerted = alertedAtBySession.get(sessionKey) ?? 0
        if (now - lastAlerted < cooldownMs) return
        alertedAtBySession.set(sessionKey, now)

        if (e.details.type === "permission.asked") {
          if (settings.sounds.permissionsEnabled()) {
            void playSoundById(settings.sounds.permissions())
          }
          if (settings.notifications.permissions()) {
            void platform.notify(title, description, href)
          }
        }

        if (e.details.type === "question.asked") {
          if (settings.notifications.agent()) {
            void platform.notify(title, description, href)
          }
        }

        const currentSession = params.id
        if (pathKey(directory) === pathKey(currentDir()) && props.sessionID === currentSession) return
        if (pathKey(directory) === pathKey(currentDir()) && session?.parentID === currentSession) return

        dismissSessionAlert(sessionKey)

        const toastId = showToast({
          persistent: true,
          icon,
          title,
          description,
          actions: [
            {
              label: language.t("notification.action.goToSession"),
              onClick: () => navigate(href),
            },
            {
              label: language.t("common.dismiss"),
              onClick: "dismiss",
            },
          ],
        })
        toastBySession.set(sessionKey, toastId)
      })
      onCleanup(unsub)

      createEffect(() => {
        const currentSession = params.id
        if (!currentDir() || !currentSession) return
        const sessionKey = `${currentDir()}:${currentSession}`
        dismissSessionAlert(sessionKey)
        const [store] = globalSync.child(currentDir(), { bootstrap: false })
        const childSessions = store.session.filter((s) => s.parentID === currentSession)
        for (const child of childSessions) {
          dismissSessionAlert(`${currentDir()}:${child.id}`)
        }
      })
    })

  useUpdatePolling()
  useSDKNotificationToasts()

  function scrollToSession(sessionId: string, sessionKey: string) {
    if (!scrollContainerRef) return
    if (state.scrollSessionKey === sessionKey) return
    const element = scrollContainerRef.querySelector(`[data-session-id="${sessionId}"]`)
    if (!element) return
    const containerRect = scrollContainerRef.getBoundingClientRect()
    const elementRect = element.getBoundingClientRect()
    if (elementRect.top >= containerRect.top && elementRect.bottom <= containerRect.bottom) {
      setState("scrollSessionKey", sessionKey)
      return
    }
    setState("scrollSessionKey", sessionKey)
    element.scrollIntoView({ block: "nearest", behavior: "smooth" })
  }

  const currentProject = createMemo(() => {
    // URL 是用户意图的权威来源，route().dir 会被服务端 path API 覆盖到 git 根，
    // 多 worktree 项目下会把当前项目错误地映射到根项目，所以这里直接走 URL 解码
    const urlDirectory = decode64(params.dir)
    const directory = urlDirectory || currentDir()
    if (!directory) return
    const key = pathKey(directory)

    const projects = layout.projects.list()

    // 当前 dir 直接匹中某个项目的 worktree → 就是该项目本身（不要被 sandbox 配置抢走）
    const direct = projects.find((p) => pathKey(p.worktree) === key)
    if (direct) return direct

    // 否则当前 dir 可能只是另一个项目的 sandbox 子目录
    const sandbox = projects.find((p) => p.sandboxes?.some((item) => pathKey(item) === key))
    if (sandbox) return sandbox

    const [child] = globalSync.child(directory, { bootstrap: false })
    const id = child.project
    if (!id) return

    const meta = globalSync.data.project.find((p) => p.id === id)
    const root = meta?.worktree
    if (!root) return

    return projects.find((p) => p.worktree === root)
  })

  const [autoselecting] = createResource(async () => {
    await ready.promise
    await layout.ready.promise
    if (!untrack(() => state.autoselect)) return

    // 散对话隐藏目录不算真正的"上一次项目"，避免 cmd+r 后被自动打开导致回到无项目状态
    const scratch = scratchChatDir()
    const list = layout.projects.list().filter((project) => !isScratchSessionPath(project.worktree, scratch))
    const lastRaw = server.projects.last()
    const last = isScratchSessionPath(lastRaw, scratch) ? undefined : lastRaw

    if (list.length === 0) {
      if (!last) return
      await openProject(last, true)
    } else {
      const next = list.find((project) => project.worktree === last) ?? list[0]
      if (!next) return
      await openProject(next.worktree, true)
    }
  })

  const workspaceName = (directory: string, projectId?: string, branch?: string) => {
    const key = pathKey(directory)
    const direct = store.workspaceName[key] ?? store.workspaceName[directory]
    if (direct) return direct
    if (!projectId) return
    if (!branch) return
    return store.workspaceBranchName[projectId]?.[branch]
  }

  const setWorkspaceName = (directory: string, next: string, projectId?: string, branch?: string) => {
    const key = pathKey(directory)
    setStore("workspaceName", key, next)
    if (!projectId) return
    if (!branch) return
    if (!store.workspaceBranchName[projectId]) {
      setStore("workspaceBranchName", projectId, {})
    }
    setStore("workspaceBranchName", projectId, branch, next)
  }

  const workspaceLabel = (directory: string, branch?: string, projectId?: string) =>
    workspaceName(directory, projectId, branch) ?? branch ?? getFilename(directory)

  const workspaceSetting = createMemo(() => {
    const project = currentProject()
    if (!project) return false
    if (project.vcs !== "git") return false
    return layout.sidebar.workspaces(project.worktree)()
  })

  const visibleSessionDirs = createMemo(() => {
    return resolveVisibleSessionDirs({
      activeDir: currentDir(),
      scratchDir: scratchChatDir(),
      project: currentProject(),
      workspaceEnabled: workspaceSetting(),
      workspaceExpanded: store.workspaceExpanded,
      projectWorktree: (project) => project.worktree,
      workspaceIds,
    })
  })

  createEffect(() => {
    if (!pageReady()) return
    if (!layoutReady()) return
    const projects = layout.projects.list()
    for (const [directory, expanded] of Object.entries(store.workspaceExpanded)) {
      if (!expanded) continue
      const key = pathKey(directory)
      const project = projects.find(
        (item) => pathKey(item.worktree) === key || item.sandboxes?.some((sandbox) => pathKey(sandbox) === key),
      )
      if (!project) continue
      if (project.vcs === "git" && layout.sidebar.workspaces(project.worktree)()) continue
      setStore("workspaceExpanded", directory, false)
    }
  })

  const currentSessions = createMemo(() => {
    const now = Date.now()
    const dirs = visibleSessionDirs()
    if (dirs.length === 0) return [] as Session[]

    const result: Session[] = []
    for (const dir of dirs) {
      const [dirStore] = globalSync.child(dir, { bootstrap: true })
      const dirSessions = sortedRootSessions(dirStore, now)
      result.push(...dirSessions)
    }
    return result
  })

  type PrefetchQueue = {
    inflight: Set<string>
    pending: string[]
    pendingSet: Set<string>
    running: number
  }

  const prefetchChunk = 200
  const prefetchConcurrency = 2
  const prefetchPendingLimit = 10
  const span = 4
  const prefetchToken = { value: 0 }
  const prefetchQueues = new Map<string, PrefetchQueue>()

  const PREFETCH_MAX_SESSIONS_PER_DIR = 10
  const prefetchedByDir = new Map<string, Set<string>>()

  const lruFor = (directory: string) => {
    const existing = prefetchedByDir.get(directory)
    if (existing) return existing
    const created = new Set<string>()
    prefetchedByDir.set(directory, created)
    return created
  }

  const markPrefetched = (directory: string, sessionID: string) => {
    const lru = lruFor(directory)
    return pickSessionCacheEvictions({
      seen: lru,
      keep: sessionID,
      limit: PREFETCH_MAX_SESSIONS_PER_DIR,
      preserve: params.id && pathKey(directory) === pathKey(currentDir()) ? [params.id] : undefined,
    })
  }

  createEffect(() => {
    const active = new Set(visibleSessionDirs())
    for (const directory of prefetchedByDir.keys()) {
      if (active.has(directory)) continue
      prefetchedByDir.delete(directory)
    }
  })

  createEffect(() => {
    route()
    globalSDK.url

    prefetchToken.value += 1
    clearSessionPrefetchInflight()
    prefetchQueues.clear()
  })

  createEffect(() => {
    const visible = new Set(visibleSessionDirs())
    for (const [directory, q] of prefetchQueues) {
      if (visible.has(directory)) continue
      q.pending.length = 0
      q.pendingSet.clear()
      if (q.running === 0) prefetchQueues.delete(directory)
    }
  })

  const queueFor = (directory: string) => {
    const existing = prefetchQueues.get(directory)
    if (existing) return existing

    const created: PrefetchQueue = {
      inflight: new Set(),
      pending: [],
      pendingSet: new Set(),
      running: 0,
    }
    prefetchQueues.set(directory, created)
    return created
  }

  // part 等仍以 ID 作为权威顺序；消息时间线改用专用的 mergeMessages，不能共用此函数。
  const mergeByID = <T extends { id: string }>(current: T[], incoming: T[]) => {
    if (current.length === 0) {
      return incoming.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    }

    const map = new Map<string, T>()
    for (const item of current) {
      map.set(item.id, item)
    }
    for (const item of incoming) {
      map.set(item.id, item)
    }
    return [...map.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  }

  async function prefetchMessages(directory: string, sessionID: string, token: number) {
    const [store, setStore] = globalSync.child(directory, { bootstrap: false })

    return runSessionPrefetch({
      directory,
      sessionID,
      task: (rev) =>
        retry(() =>
          globalSDK.client.session.messages({
            directory,
            sessionID,
            limit: prefetchChunk,
            // 侧栏预取不能把超大 patch 提前塞进共享 store，否则用户尚未点进会话页面就会卡顿。
            summaryDiffs: "compact",
          }),
        )
          .then((messages) => {
            if (prefetchToken.value !== token) return
            if (!isSessionPrefetchCurrent(directory, sessionID, rev)) return

            const items = (messages.data ?? []).filter((x) => !!x?.info?.id)
            const next = items.map((x) => x.info).filter((m): m is Message => !!m?.id)
            // 侧栏预取会直接播种会话缓存，必须与正常历史加载使用相同的 created + id 顺序。
            const sorted = mergeMessages([], next)
            const stale = markPrefetched(directory, sessionID)
            const cursor = messages.response.headers.get("x-next-cursor") ?? undefined
            const meta = {
              limit: sorted.length,
              cursor,
              complete: !cursor,
              at: Date.now(),
            }

            if (stale.length > 0) {
              clearSessionPrefetch(directory, stale)
              for (const id of stale) {
                globalSync.todo.set(id, undefined)
              }
            }

            const current = store.message[sessionID] ?? []
            const merged = mergeMessages(
              current.filter((item): item is Message => !!item?.id),
              sorted,
            )

            if (!isSessionPrefetchCurrent(directory, sessionID, rev)) return

            batch(() => {
              if (stale.length > 0) {
                setStore(
                  produce((draft) => {
                    dropSessionCaches(draft, stale)
                  }),
                )
              }

              setStore("message", sessionID, reconcile(merged, { key: "id" }))
              setSessionPrefetch({ directory, sessionID, ...meta })

              for (const message of items) {
                const currentParts = store.part[message.info.id] ?? []
                const mergedParts = mergeByID(
                  currentParts.filter((item): item is (typeof currentParts)[number] & { id: string } => !!item?.id),
                  message.parts.filter((item): item is (typeof message.parts)[number] & { id: string } => !!item?.id),
                )

                setStore("part", message.info.id, reconcile(mergedParts, { key: "id" }))
              }
            })

            return meta
          })
          .catch(() => undefined),
    })
  }

  const pumpPrefetch = (directory: string) => {
    const q = queueFor(directory)
    if (q.running >= prefetchConcurrency) return

    const sessionID = q.pending.shift()
    if (!sessionID) return

    q.pendingSet.delete(sessionID)
    q.inflight.add(sessionID)
    q.running += 1

    const token = prefetchToken.value

    void prefetchMessages(directory, sessionID, token).finally(() => {
      q.running -= 1
      q.inflight.delete(sessionID)
      pumpPrefetch(directory)
    })
  }

  const prefetchSession = (session: Session, priority: "high" | "low" = "low") => {
    const directory = session.directory
    if (!directory) return

    // 高优（hover/按下）说明用户即将打开：顺带引导该目录 child store，
    // 让 agent/providers/vcs 等请求也在点击前完成，切换后不再有第二波渲染
    const [store] = globalSync.child(directory, { bootstrap: priority === "high" })
    const cached = untrack(() => {
      const info = getSessionPrefetch(directory, session.id)
      return shouldSkipSessionPrefetch({
        message: store.message[session.id] !== undefined,
        info,
        chunk: prefetchChunk,
      })
    })
    if (cached) return

    const q = queueFor(directory)
    if (q.inflight.has(session.id)) return
    if (q.pendingSet.has(session.id)) {
      if (priority !== "high") return
      const index = q.pending.indexOf(session.id)
      if (index > 0) {
        q.pending.splice(index, 1)
        q.pending.unshift(session.id)
      }
      return
    }

    const lru = lruFor(directory)
    const known = lru.has(session.id)
    if (!known && lru.size >= PREFETCH_MAX_SESSIONS_PER_DIR && priority !== "high") return

    if (priority === "high") q.pending.unshift(session.id)
    if (priority !== "high") q.pending.push(session.id)
    q.pendingSet.add(session.id)

    while (q.pending.length > prefetchPendingLimit) {
      const dropped = q.pending.pop()
      if (!dropped) continue
      q.pendingSet.delete(dropped)
    }

    pumpPrefetch(directory)
  }

  registerSessionPrefetch(prefetchSession)
  onCleanup(() => registerSessionPrefetch(undefined))

  const warm = (sessions: Session[], index: number) => {
    for (let offset = 1; offset <= span; offset++) {
      const next = sessions[index + offset]
      if (next) prefetchSession(next, offset === 1 ? "high" : "low")

      const prev = sessions[index - offset]
      if (prev) prefetchSession(prev, offset === 1 ? "high" : "low")
    }
  }

  createEffect(() => {
    const sessions = currentSessions()
    if (sessions.length === 0) return

    const index = params.id ? sessions.findIndex((s) => s.id === params.id) : 0
    if (index === -1) return

    if (!params.id) {
      const first = sessions[index]
      if (first) prefetchSession(first, "high")
    }

    warm(sessions, index)
  })

  function navigateSessionByOffset(offset: number) {
    const sessions = currentSessions()
    if (sessions.length === 0) return

    const sessionIndex = params.id ? sessions.findIndex((s) => s.id === params.id) : -1

    let targetIndex: number
    if (sessionIndex === -1) {
      targetIndex = offset > 0 ? 0 : sessions.length - 1
    } else {
      targetIndex = (sessionIndex + offset + sessions.length) % sessions.length
    }

    const session = sessions[targetIndex]
    if (!session) return

    prefetchSession(session, "high")
    warm(sessions, targetIndex)

    navigateToSession(session)
  }

  function navigateProjectByOffset(offset: number) {
    const projects = layout.projects.list()
    if (projects.length === 0) return

    const current = currentProject()?.worktree
    const fallback = currentDir() ? projectRoot(currentDir()) : undefined
    const active = current ?? fallback
    const index = active ? projects.findIndex((project) => project.worktree === active) : -1

    const target =
      index === -1
        ? offset > 0
          ? projects[0]
          : projects[projects.length - 1]
        : projects[(index + offset + projects.length) % projects.length]
    if (!target) return

    // warm up child store to prevent flicker
    globalSync.child(target.worktree)
    void openProject(target.worktree)
  }

  function navigateSessionByUnseen(offset: number) {
    const sessions = currentSessions()
    if (sessions.length === 0) return

    const hasUnseen = sessions.some((session) => notification.session.unseenCount(session.id) > 0)
    if (!hasUnseen) return

    const activeIndex = params.id ? sessions.findIndex((s) => s.id === params.id) : -1
    const start = activeIndex === -1 ? (offset > 0 ? -1 : 0) : activeIndex

    for (let i = 1; i <= sessions.length; i++) {
      const index = offset > 0 ? (start + i) % sessions.length : (start - i + sessions.length) % sessions.length
      const session = sessions[index]
      if (!session) continue
      if (notification.session.unseenCount(session.id) === 0) continue

      prefetchSession(session, "high")
      warm(sessions, index)

      navigateToSession(session)
      return
    }
  }

  function archiveSession(session: Session) {
    return runArchiveInflight(session.id, async () => {
      // 选下一条要跳转的会话（用于当前页就是被归档的那条时）
      const [primaryStore] = globalSync.child(session.directory, { bootstrap: false })
      const primarySessions = primaryStore.session ?? []
      const primaryIdx = primarySessions.findIndex((s) => s.id === session.id)
      const nextSession = primarySessions[primaryIdx + 1] ?? primarySessions[primaryIdx - 1]

      // 1) 乐观地立刻从所有受影响 store 移除 —— 视觉上 sidebar 立即没了这条会话
      const removed = removeSessionFromSidebar(globalSync, session)

      // 2) 发 API；失败回滚到原位置
      try {
        const response = await globalSDK.client.session.update({
          directory: session.directory,
          sessionID: session.id,
          time: { archived: Date.now() },
        })
        const archived = requireArchivedSession(response.data)
        // 3) 成功后基于首次 removed 快照做终态结算（覆盖 SSE 只更新事件目录 / SSE 丢失两种情况；
        //    双向结算器保证与 SSE 先到/后到都不会双递减）
        settleSessionRemovals(globalSync, removed, session.id)
        mergeArchivedSessionIntoListCache(queryClient, archived)
        invalidateArchivedSessionsList(queryClient)

        const archivedSnapshot = archived
        const wasViewing = session.id === params.id
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
              if (wasViewing) navigate(`/${params.dir}/session/${session.id}`)
            } catch (undoErr) {
              if (archivedSnapshot) mergeArchivedSessionIntoListCache(queryClient, archivedSnapshot)
              showToast({
                variant: "error",
                title: language.t("settings.archivedSessions.unarchive.failed"),
                description: formatServerError(undoErr, language.t, language.t("common.requestFailed")),
              })
            }
          },
          onOpenArchivedSettings: openArchivedSettings,
        })
      } catch (err) {
        for (const item of removed) {
          const [, setStoreRef] = globalSync.child(item.dir, { bootstrap: false })
          setStoreRef(
            produce((draft) => {
              if (draft.session.some((s) => s.id === item.session.id)) return
              // 注意：store.session 的排序规则不是按 id 而是按 time.updated（sortSessions），
              // 二分插回会插错位置。直接用归档前记录的 index 把对象塞回原位置。
              const insertAt = Math.min(item.index, draft.session.length)
              draft.session.splice(insertAt, 0, item.session)
            }),
          )
        }
        console.error("archiveSession failed", { sessionID: session.id, directory: session.directory, err })
        const archiveResolved = resolveError(err)
        showToast({
          variant: "error",
          title: language.t("sidebar.thread.menu.archive"),
          description:
            archiveResolved.category !== "unknown"
              ? language.t(archiveResolved.messageKey as any)
              : formatServerError(err, language.t),
        })
        throw err
      }

      if (session.id === params.id) {
        if (nextSession) {
          navigate(`/${params.dir}/session/${nextSession.id}`)
        } else {
          navigate(`/${params.dir}/session`)
        }
      }
    })
  }

  command.register("layout", () => {
    const commands: CommandOption[] = [
      {
        id: "sidebar.toggle",
        title: language.t("command.sidebar.toggle"),
        category: language.t("command.category.view"),
        keybind: "mod+b",
        onSelect: () => layout.sidebar.toggle(),
      },
      // 1:1 复刻 Codex：保留浏览器风格的 mod+[ / mod+] 前进后退快捷键，无历史时静默忽略
      {
        id: "common.goBack",
        title: language.t("common.goBack"),
        category: language.t("command.category.view"),
        keybind: "mod+[",
        onSelect: () => canGoBack() && navigate(-1),
      },
      {
        id: "common.goForward",
        title: language.t("common.goForward"),
        category: language.t("command.category.view"),
        keybind: "mod+]",
        onSelect: () => canGoForward() && navigate(1),
      },
      {
        id: "project.open",
        title: language.t("command.project.open"),
        category: language.t("command.category.project"),
        keybind: "mod+o",
        onSelect: () => chooseProject(),
      },
      {
        id: "project.previous",
        title: language.t("command.project.previous"),
        category: language.t("command.category.project"),
        keybind: "mod+alt+arrowup",
        onSelect: () => navigateProjectByOffset(-1),
      },
      {
        id: "project.next",
        title: language.t("command.project.next"),
        category: language.t("command.category.project"),
        keybind: "mod+alt+arrowdown",
        onSelect: () => navigateProjectByOffset(1),
      },
      {
        id: "provider.connect",
        title: language.t("command.provider.connect"),
        category: language.t("command.category.provider"),
        slash: "connect",
        onSelect: () => connectProvider(),
      },
      {
        id: "server.switch",
        title: language.t("command.server.switch"),
        category: language.t("command.category.server"),
        onSelect: () => openServer(),
      },
      {
        id: "settings.open",
        title: language.t("command.settings.open"),
        category: language.t("command.category.settings"),
        keybind: "mod+comma",
        slash: "settings",
        onSelect: () => openSettings(),
      },
      {
        id: "system.status",
        title: language.t("command.system.status"),
        description: language.t("command.system.status.description"),
        category: language.t("command.category.server"),
        slash: "status",
        onSelect: () => openStatus(),
      },
      {
        id: "system.help",
        title: language.t("command.system.help"),
        description: language.t("command.system.help.description"),
        category: language.t("command.category.view"),
        slash: "help",
        onSelect: () => openSlashHelp(),
      },
      {
        id: "system.reportIssue",
        title: language.t("command.system.reportIssue"),
        description: language.t("command.system.reportIssue.description"),
        category: language.t("command.category.view"),
        slash: "bug",
        onSelect: () => openIssueReport(),
      },
      {
        id: "system.exit",
        title: language.t("command.system.exit"),
        description: language.t("command.system.exit.description"),
        category: language.t("command.category.view"),
        slash: "exit",
        slashAliases: ["quit", "q"],
        onSelect: () => exitApp(),
      },
      {
        id: "session.list",
        title: language.t("command.session.list"),
        description: language.t("command.session.list.description"),
        category: language.t("command.category.session"),
        slash: "sessions",
        slashAliases: ["resume", "continue", "catalog", "catlog"],
        onSelect: () => openSessions(),
      },
      {
        id: "session.previous",
        title: language.t("command.session.previous"),
        category: language.t("command.category.session"),
        keybind: "alt+arrowup",
        onSelect: () => navigateSessionByOffset(-1),
      },
      {
        id: "session.next",
        title: language.t("command.session.next"),
        category: language.t("command.category.session"),
        keybind: "alt+arrowdown",
        onSelect: () => navigateSessionByOffset(1),
      },
      {
        id: "session.previous.unseen",
        title: language.t("command.session.previous.unseen"),
        category: language.t("command.category.session"),
        keybind: "shift+alt+arrowup",
        onSelect: () => navigateSessionByUnseen(-1),
      },
      {
        id: "session.next.unseen",
        title: language.t("command.session.next.unseen"),
        category: language.t("command.category.session"),
        keybind: "shift+alt+arrowdown",
        onSelect: () => navigateSessionByUnseen(1),
      },
      {
        id: "session.archive",
        title: language.t("command.session.archive"),
        category: language.t("command.category.session"),
        keybind: "mod+shift+backspace",
        disabled: !params.dir || !params.id,
        onSelect: () => {
          const session = currentSessions().find((s) => s.id === params.id)
          if (session) void archiveSession(session)
        },
      },
      {
        id: "workspace.new",
        title: language.t("workspace.new"),
        category: language.t("command.category.workspace"),
        keybind: "mod+shift+w",
        disabled: !workspaceSetting(),
        onSelect: () => {
          const project = currentProject()
          if (!project) return
          return createWorkspace(project)
        },
      },
      {
        id: "workspace.toggle",
        title: language.t("command.workspace.toggle"),
        description: language.t("command.workspace.toggle.description"),
        category: language.t("command.category.workspace"),
        slash: "workspace",
        slashAliases: ["warp"],
        disabled: !currentProject() || currentProject()?.vcs !== "git",
        onSelect: () => {
          const project = currentProject()
          if (!project) return
          if (project.vcs !== "git") return
          const wasEnabled = layout.sidebar.workspaces(project.worktree)()
          layout.sidebar.toggleWorkspaces(project.worktree)
          showToast({
            title: wasEnabled
              ? language.t("toast.workspace.disabled.title")
              : language.t("toast.workspace.enabled.title"),
            description: wasEnabled
              ? language.t("toast.workspace.disabled.description")
              : language.t("toast.workspace.enabled.description"),
          })
        },
      },
      {
        id: "theme.cycle",
        title: language.t("command.theme.cycle"),
        category: language.t("command.category.theme"),
        keybind: "mod+shift+t",
        slash: "themes",
        slashAliases: ["theme"],
        onSelect: () => cycleTheme(1),
      },
    ]

    for (const [id] of availableThemeEntries()) {
      commands.push({
        id: `theme.set.${id}`,
        title: language.t("command.theme.set", { theme: theme.name(id) }),
        category: language.t("command.category.theme"),
        onSelect: () => theme.commitPreview(),
        onHighlight: () => {
          theme.previewTheme(id)
          return () => theme.cancelPreview()
        },
      })
    }

    commands.push({
      id: "theme.scheme.cycle",
      title: language.t("command.theme.scheme.cycle"),
      category: language.t("command.category.theme"),
      keybind: "mod+shift+s",
      onSelect: () => cycleColorScheme(1),
    })

    for (const scheme of colorSchemeOrder) {
      commands.push({
        id: `theme.scheme.${scheme}`,
        title: language.t("command.theme.scheme.set", { scheme: colorSchemeLabel(scheme) }),
        category: language.t("command.category.theme"),
        onSelect: () => theme.commitPreview(),
        onHighlight: () => {
          theme.previewColorScheme(scheme)
          return () => theme.cancelPreview()
        },
      })
    }

    commands.push({
      id: "language.cycle",
      title: language.t("command.language.cycle"),
      category: language.t("command.category.language"),
      onSelect: () => cycleLanguage(1),
    })

    for (const locale of language.locales) {
      commands.push({
        id: `language.set.${locale}`,
        title: language.t("command.language.set", { language: language.label(locale) }),
        category: language.t("command.category.language"),
        onSelect: () => setLocale(locale),
      })
    }

    return commands
  })

  function connectProvider() {
    const run = ++dialogRun
    void import("@/components/dialog-select-provider").then((x) => {
      if (dialogDead || dialogRun !== run) return
      dialog.show(() => <x.DialogSelectProvider />)
    })
  }

  function openServer() {
    const run = ++dialogRun
    void import("@/components/dialog-select-server").then((x) => {
      if (dialogDead || dialogRun !== run) return
      dialog.show(() => <x.DialogSelectServer />)
    })
  }

  function openSessions() {
    const run = ++dialogRun
    void import("@/components/dialog-select-file").then((x) => {
      if (dialogDead || dialogRun !== run) return
      dialog.show(() => <x.DialogSelectFile mode="sessions" />)
    })
  }

  function openStatus() {
    const run = ++dialogRun
    void import("@/components/dialog-status").then((x) => {
      if (dialogDead || dialogRun !== run) return
      dialog.show(() => <x.DialogStatus directory={currentDir() || globalSync.data.path.directory} />)
    })
  }

  function openSlashHelp() {
    const run = ++dialogRun
    void import("@/components/dialog-slash-help").then((x) => {
      if (dialogDead || dialogRun !== run) return
      dialog.show(() => <x.DialogSlashHelp />)
    })
  }

  function openIssueReport() {
    const directory = currentDir() || decode64(params.dir) || globalSync.data.path.directory
    const child = directory ? globalSync.child(directory, { bootstrap: false })[0] : undefined
    const project = currentProject()
    const session = params.id
      ? (child?.session.find((item) => item.id === params.id) ??
        currentSessions().find((item) => item.id === params.id))
      : undefined
    issueReport.open({
      context: {
        route: {
          path: currentPath(),
          directory_slug: route().slug,
          session_id: params.id,
        },
        session: params.id
          ? {
              id: params.id,
              created_at: session?.time.created,
              updated_at: session?.time.updated,
            }
          : undefined,
        project: project
          ? {
              id: project.id,
              name: project.name,
              worktree: project.worktree,
              vcs: project.vcs,
            }
          : undefined,
        workspace: directory
          ? {
              directory,
              branch: child?.vcs?.branch,
              default_branch: child?.vcs?.default_branch,
              local_git: child?.vcs?.local_git,
              git_installed: child?.vcs?.git_installed,
            }
          : undefined,
      },
    })
  }

  function exitApp() {
    if (platform.windowAction) {
      void platform.windowAction("close")
      return
    }
    showToast({
      title: language.t("command.system.exit"),
      description: language.t("command.system.exit.webUnsupported"),
    })
  }

  function openSettings() {
    setSettingsOverlay({})
  }

  function openArchivedSettings() {
    setSettingsOverlay({ tab: "archivedSessions" })
  }

  function openUserCenter(tab?: string) {
    setUserCenterOverlay(tab ? { tab: tab as TabID } : {})
  }

  function projectRoot(directory: string) {
    const key = pathKey(directory)
    const project = layout.projects
      .list()
      .find((item) => pathKey(item.worktree) === key || item.sandboxes?.some((sandbox) => pathKey(sandbox) === key))
    if (project) return project.worktree

    const known = Object.entries(store.workspaceOrder).find(
      ([root, dirs]) => pathKey(root) === key || dirs.some((item) => pathKey(item) === key),
    )
    if (known) return known[0]

    const [child] = globalSync.child(directory, { bootstrap: false })
    const id = child.project
    if (!id) return directory

    const meta = globalSync.data.project.find((item) => item.id === id)
    return meta?.worktree ?? directory
  }

  function activeProjectRoot(directory: string) {
    return currentProject()?.worktree ?? projectRoot(directory)
  }

  function rememberSessionRoute(directory: string, id: string, root = activeProjectRoot(directory)) {
    setStore("lastProjectSession", root, { directory, id, at: Date.now() })
    return root
  }

  function clearLastProjectSession(root: string) {
    if (!store.lastProjectSession[root]) return
    setStore(
      "lastProjectSession",
      produce((draft) => {
        delete draft[root]
      }),
    )
  }

  function syncSessionRoute(directory: string, id: string, root = activeProjectRoot(directory)) {
    rememberSessionRoute(directory, id, root)
    notification.session.markViewed(id)
    const expanded = untrack(() => store.workspaceExpanded[directory])
    if (expanded === false) {
      setStore("workspaceExpanded", directory, true)
    }
    requestAnimationFrame(() => scrollToSession(id, `${directory}:${id}`))
    return root
  }

  async function navigateToProject(directory: string | undefined) {
    if (!directory) return
    const root = projectRoot(directory)
    server.projects.touch(root)
    const project = layout.projects.list().find((item) => item.worktree === root)
    let dirs = project
      ? effectiveWorkspaceOrder(root, [root, ...(project.sandboxes ?? [])], store.workspaceOrder[root])
      : [root]
    const canOpen = (value: string | undefined) => {
      if (!value) return false
      return dirs.some((item) => pathKey(item) === pathKey(value))
    }
    const refreshDirs = async (target?: string) => {
      if (!target || target === root || canOpen(target)) return canOpen(target)
      const listed = await globalSDK.client.worktree
        .list({ directory: root })
        .then((x) => x.data ?? [])
        .catch(() => [] as string[])
      dirs = effectiveWorkspaceOrder(root, [root, ...listed], store.workspaceOrder[root])
      return canOpen(target)
    }
    const openSession = async (target: { directory: string; id: string }) => {
      if (!canOpen(target.directory)) return false
      const [data] = globalSync.child(target.directory, { bootstrap: false })
      if (data.session.some((item) => item.id === target.id)) {
        setStore("lastProjectSession", root, { directory: target.directory, id: target.id, at: Date.now() })
        navigateWithSidebarReset(`/${base64Encode(target.directory)}/session/${target.id}`)
        return true
      }
      const resolved = await globalSDK.client.session
        .get({ sessionID: target.id })
        .then((x) => x.data)
        .catch(() => undefined)
      if (!resolved?.directory) return false
      if (!canOpen(resolved.directory)) return false
      setStore("lastProjectSession", root, { directory: resolved.directory, id: resolved.id, at: Date.now() })
      navigateWithSidebarReset(`/${base64Encode(resolved.directory)}/session/${resolved.id}`)
      return true
    }

    const projectSession = store.lastProjectSession[root]
    if (projectSession?.id) {
      await refreshDirs(projectSession.directory)
      const opened = await openSession(projectSession)
      if (opened) return
      clearLastProjectSession(root)
    }

    const latest = latestRootSession(
      dirs.map((item) => globalSync.child(item, { bootstrap: false })[0]),
      Date.now(),
    )
    if (latest && (await openSession(latest))) {
      return
    }

    const fetched = latestRootSession(
      await Promise.all(
        dirs.map(async (item) => ({
          path: { directory: item },
          session: await globalSDK.client.session
            .list({ directory: item })
            .then((x) => x.data ?? [])
            .catch(() => []),
        })),
      ),
      Date.now(),
    )
    if (fetched && (await openSession(fetched))) {
      return
    }

    navigateWithSidebarReset(`/${base64Encode(root)}/session`)
  }

  function navigateToSession(session: Session | undefined) {
    if (!session) return
    navigateWithSidebarReset(`/${base64Encode(session.directory)}/session/${session.id}`)
  }

  function openProject(directory: string, navigate = true) {
    layout.projects.open(directory)
    if (navigate) return navigateToProject(directory)
  }

  const openRegistryPluginInstall = async (link: PluginInstallDeepLink) => {
    const result = await globalSDK.client.registry
      .getPlugin({
        namespace: link.namespace,
        slug: link.slug,
        locale: language.locale(),
      })
      .catch((error) => ({ data: undefined, error }))
    if (result.error || !result.data) {
      showToast({
        variant: "error",
        title: language.t("plugins.install.failed"),
        description: formatServerError(result.error, language.t, language.t("common.requestFailed")),
      })
      return
    }

    const version = link.version ?? result.data.latest_version ?? undefined
    if (!version || (link.version && !result.data.versions.some((item) => item.version === link.version))) {
      showToast({
        variant: "error",
        title: language.t("plugins.install.failed"),
        description: language.t("plugins.install.unavailable"),
      })
      return
    }

    const addon = registryPluginAsAddon(result.data)
    dialog.show(() => (
      <DialogInstallAddon
        addon={addon}
        version={version}
        onInstall={async () => {
          const install = await globalSDK.client.registry.install({
            registryInstallRequest: {
              namespace: link.namespace,
              slug: link.slug,
              version,
            },
          })
          if (install.error) throw install.error
        }}
      />
    ))
  }

  const handleDeepLinks = (urls: string[]) => {
    if (!server.isLocal()) return

    for (const directory of collectOpenProjectDeepLinks(urls)) {
      void openProject(directory)
    }

    for (const link of collectNewSessionDeepLinks(urls)) {
      void openProject(link.directory, false)
      const slug = base64Encode(link.directory)
      if (link.prompt) {
        setSessionHandoff(slug, { prompt: link.prompt })
      }
      openNewSession({ slug, prompt: link.prompt, reset: resetPromptDraft, navigate: navigateWithSidebarReset })
    }

    for (const link of collectPluginInstallDeepLinks(urls)) {
      void openRegistryPluginInstall(link)
    }
  }

  onMount(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ urls: string[] }>).detail
      const urls = detail?.urls ?? []
      if (urls.length === 0) return
      handleDeepLinks(urls)
    }

    handleDeepLinks(drainPendingDeepLinks(window))
    makeEventListener(window, deepLinkEvent, handler as EventListener)
  })

  async function renameProject(project: LocalProject, next: string) {
    const current = displayName(project)
    if (next === current) return
    const name = normalizeProjectName(next, getFilename(project.worktree))

    if (project.id && project.id !== "global") {
      await globalSDK.client.project.update({ projectID: project.id, directory: project.worktree, name })
    }

    // 始终同步写入本地 projectMeta：作为 cmd+r 刷新后的兜底，避免后端 name 缺失或 SDK 调用未持久化时回退到 worktree basename
    globalSync.project.meta(project.worktree, { name })
  }

  const renameWorkspace = (directory: string, next: string, projectId?: string, branch?: string) => {
    const current = workspaceName(directory, projectId, branch) ?? branch ?? getFilename(directory)
    if (current === next) return
    setWorkspaceName(directory, next, projectId, branch)
  }

  // 项目被移除时一并清掉 layout 持久化里跟它绑定的状态，避免 localStorage 留 dangling 条目；
  // workspaceBranchName 按 projectID 索引（后端 id 稳定），跨移除/重开仍可复用，故不清。
  function cleanupRemovedProjectState(directory: string) {
    const project = layout.projects.list().find((p) => pathKey(p.worktree) === pathKey(directory))
    const sandboxes = project?.sandboxes ?? []
    const dirs = [directory, ...sandboxes]

    setStore(
      produce((draft) => {
        delete draft.lastProjectSession[directory]
        delete draft.workspaceOrder[directory]
        for (const d of dirs) {
          delete draft.workspaceExpanded[d]
          delete draft.workspaceName[pathKey(d)]
          delete draft.workspaceName[d]
        }
      }),
    )
  }

  function closeProject(directory: string) {
    const list = layout.projects.list()
    const key = pathKey(directory)
    const index = list.findIndex((x) => pathKey(x.worktree) === key)
    const active = pathKey(currentProject()?.worktree ?? "") === key
    if (index === -1) return
    const next = list[index + 1]

    cleanupRemovedProjectState(directory)
    layout.projects.cleanup(directory)

    if (!active) {
      layout.projects.close(directory)
      return
    }

    if (!next) {
      layout.projects.close(directory)
      navigate("/")
      return
    }

    navigateWithSidebarReset(`/${base64Encode(next.worktree)}/session`)
    layout.projects.close(directory)
    queueMicrotask(() => {
      void navigateToProject(next.worktree)
    })
  }

  function toggleProjectWorkspaces(project: LocalProject) {
    const enabled = layout.sidebar.workspaces(project.worktree)()
    if (enabled) {
      layout.sidebar.toggleWorkspaces(project.worktree)
      return
    }
    if (project.vcs !== "git") return
    layout.sidebar.toggleWorkspaces(project.worktree)
  }

  const showEditProjectDialog = (project: LocalProject) => {
    const dir = base64Encode(project.worktree)
    navigate(`/${dir}/project-edit`)
  }

  const showRenameProjectDialog = (project: LocalProject) => {
    dialog.show(() => <DialogRenameProject project={project} onRename={(name) => renameProject(project, name)} />)
  }

  async function chooseProject() {
    function resolve(result: string | string[] | null) {
      if (Array.isArray(result)) {
        for (const directory of result) {
          void openProject(directory, false)
        }
        void navigateToProject(result[0])
      } else if (result) {
        void openProject(result)
      }
    }

    if (platform.openDirectoryPickerDialog && server.isLocal()) {
      const result = await platform.openDirectoryPickerDialog?.({
        title: language.t("command.project.open"),
        multiple: true,
      })
      resolve(result)
    } else {
      const run = ++dialogRun
      void import("@/components/dialog-select-directory").then((x) => {
        if (dialogDead || dialogRun !== run) return
        dialog.show(
          () => <x.DialogSelectDirectory multiple={true} onSelect={resolve} />,
          () => resolve(null),
        )
      })
    }
  }

  async function handleFolderDrop(directory: string) {
    if (!directory) return
    const root = projectRoot(directory)
    const existing = layout.projects.list().find((p) => p.worktree === root)
    if (existing) {
      await navigateToProject(root)
      return
    }
    void openProject(directory)
  }

  const deleteWorkspace = async (root: string, directory: string, leaveDeletedWorkspace = false) => {
    if (directory === root) return

    const current = currentDir()
    const currentKey = pathKey(current)
    const deletedKey = pathKey(directory)
    const shouldLeave = leaveDeletedWorkspace || (!!params.dir && currentKey === deletedKey)
    if (!leaveDeletedWorkspace && shouldLeave) {
      navigateWithSidebarReset(`/${base64Encode(root)}/session`)
    }

    setBusy(directory, true)

    const result = await globalSDK.client.worktree
      .remove({ directory: root, worktreeRemoveInput: { directory } })
      .then((x) => x.data)
      .catch((err) => {
        showToast({
          title: language.t("workspace.delete.failed.title"),
          description: errorMessage(err, language.t("common.requestFailed")),
        })
        return false
      })

    setBusy(directory, false)

    if (!result) return

    if (pathKey(store.lastProjectSession[root]?.directory ?? "") === pathKey(directory)) {
      clearLastProjectSession(root)
    }

    globalSync.set(
      "project",
      produce((draft) => {
        const project = draft.find((item) => item.worktree === root)
        if (!project) return
        project.sandboxes = (project.sandboxes ?? []).filter((sandbox) => sandbox !== directory)
      }),
    )
    setStore("workspaceOrder", root, (order) => (order ?? []).filter((workspace) => workspace !== directory))

    layout.projects.close(directory)
    layout.projects.open(root)

    if (shouldLeave) return

    const nextCurrent = currentDir()
    const nextKey = pathKey(nextCurrent)
    const project = layout.projects.list().find((item) => item.worktree === root)
    const dirs = project
      ? effectiveWorkspaceOrder(root, [root, ...(project.sandboxes ?? [])], store.workspaceOrder[root])
      : [root]
    const valid = dirs.some((item) => pathKey(item) === nextKey)

    if (params.dir && projectRoot(nextCurrent) === root && !valid) {
      navigateWithSidebarReset(`/${base64Encode(root)}/session`)
    }
  }

  const resetWorkspace = async (root: string, directory: string) => {
    if (directory === root) return
    setBusy(directory, true)

    const progress = showToast({
      persistent: true,
      title: language.t("workspace.resetting.title"),
      description: language.t("workspace.resetting.description"),
    })
    const dismiss = () => toaster.dismiss(progress)

    const sessions: Session[] = await globalSDK.client.session
      .list({ directory })
      .then((x) => x.data ?? [])
      .catch(() => [])

    clearWorkspaceTerminals(
      directory,
      sessions.map((s) => s.id),
      platform,
      getTerminalServerScope(server.current, server.key),
    )

    const toArchive = sessions.filter((session) => session.time.archived === undefined)
    const archivedAt = Date.now()
    let archiveFailures = 0
    if (toArchive.length > 0) {
      await Promise.all(
        toArchive.map(async (session) => {
          try {
            const response = await globalSDK.client.session.update({
              sessionID: session.id,
              directory: session.directory,
              time: { archived: archivedAt },
            })
            const archived = requireArchivedSession(response.data)
            removeSessionFromSidebar(globalSync, session)
            mergeArchivedSessionIntoListCache(queryClient, archived)
          } catch {
            archiveFailures++
          }
        }),
      )
      invalidateArchivedSessionsList(queryClient)
    }

    if (archiveFailures > 0) {
      showToast({
        variant: "error",
        title: language.t("sidebar.thread.menu.archive"),
        description: language.t("common.requestFailed"),
      })
    }

    await globalSDK.client.instance.dispose({ directory }).catch(() => undefined)

    const result = await globalSDK.client.worktree
      .reset({ directory: root, worktreeResetInput: { directory } })
      .then((x) => x.data)
      .catch((err) => {
        showToast({
          title: language.t("workspace.reset.failed.title"),
          description: errorMessage(err, language.t("common.requestFailed")),
        })
        return false
      })

    if (!result) {
      setBusy(directory, false)
      dismiss()
      return
    }

    setBusy(directory, false)
    dismiss()

    showToast({
      title: language.t("workspace.reset.success.title"),
      description: language.t("workspace.reset.success.description"),
      actions: [
        {
          label: language.t("command.session.new"),
          onClick: () => {
            const href = `/${base64Encode(directory)}/session`
            navigate(href)
            layout.mobileSidebar.hide()
          },
        },
        {
          label: language.t("common.dismiss"),
          onClick: "dismiss",
        },
      ],
    })
  }

  function DialogDeleteWorkspace(props: { root: string; directory: string }) {
    const name = createMemo(() => getFilename(props.directory))
    const [data, setData] = createStore({
      status: "loading" as "loading" | "ready" | "error",
      dirty: false,
    })

    onMount(() => {
      globalSDK.client.file
        .status({ directory: props.directory })
        .then((x) => {
          const files = x.data ?? []
          const dirty = files.length > 0
          setData({ status: "ready", dirty })
        })
        .catch(() => {
          setData({ status: "error", dirty: false })
        })
    })

    const handleDelete = () => {
      const leaveDeletedWorkspace = !!params.dir && pathKey(currentDir()) === pathKey(props.directory)
      if (leaveDeletedWorkspace) {
        navigateWithSidebarReset(`/${base64Encode(props.root)}/session`)
      }
      dialog.close()
      void deleteWorkspace(props.root, props.directory, leaveDeletedWorkspace)
    }

    const description = () => {
      if (data.status === "loading") return language.t("workspace.status.checking")
      if (data.status === "error") return language.t("workspace.status.error")
      if (!data.dirty) return language.t("workspace.status.clean")
      return language.t("workspace.status.dirty")
    }

    return (
      <Dialog title={language.t("workspace.delete.title")} fit>
        <div class="flex flex-col gap-4 pl-6 pr-2.5 pb-3">
          <div class="flex flex-col gap-1">
            <span class="text-14-regular text-text-strong">
              {language.t("workspace.delete.confirm", { name: name() })}
            </span>
            <span class="text-12-regular text-text-weak">{description()}</span>
          </div>
          <div class="flex justify-end gap-2">
            <Button variant="ghost" size="large" onClick={() => dialog.close()}>
              {language.t("common.cancel")}
            </Button>
            <Button variant="primary" size="large" disabled={data.status === "loading"} onClick={handleDelete}>
              {language.t("workspace.delete.button")}
            </Button>
          </div>
        </div>
      </Dialog>
    )
  }

  function DialogResetWorkspace(props: { root: string; directory: string }) {
    const name = createMemo(() => getFilename(props.directory))
    const [state, setState] = createStore({
      status: "loading" as "loading" | "ready" | "error",
      dirty: false,
      sessions: [] as Session[],
    })

    const refresh = async () => {
      const sessions = await globalSDK.client.session
        .list({ directory: props.directory })
        .then((x) => x.data ?? [])
        .catch(() => [])
      const active = sessions.filter((session) => session.time.archived === undefined)
      setState({ sessions: active })
    }

    onMount(() => {
      globalSDK.client.file
        .status({ directory: props.directory })
        .then((x) => {
          const files = x.data ?? []
          const dirty = files.length > 0
          setState({ status: "ready", dirty })
          void refresh()
        })
        .catch(() => {
          setState({ status: "error", dirty: false })
        })
    })

    const handleReset = () => {
      dialog.close()
      void resetWorkspace(props.root, props.directory)
    }

    const archivedCount = () => state.sessions.length

    const description = () => {
      if (state.status === "loading") return language.t("workspace.status.checking")
      if (state.status === "error") return language.t("workspace.status.error")
      if (!state.dirty) return language.t("workspace.status.clean")
      return language.t("workspace.status.dirty")
    }

    const archivedLabel = () => {
      const count = archivedCount()
      if (count === 0) return language.t("workspace.reset.archived.none")
      if (count === 1) return language.t("workspace.reset.archived.one")
      return language.t("workspace.reset.archived.many", { count })
    }

    return (
      <Dialog title={language.t("workspace.reset.title")} fit>
        <div class="flex flex-col gap-4 pl-6 pr-2.5 pb-3">
          <div class="flex flex-col gap-1">
            <span class="text-14-regular text-text-strong">
              {language.t("workspace.reset.confirm", { name: name() })}
            </span>
            <span class="text-12-regular text-text-weak">
              {description()} {archivedLabel()} {language.t("workspace.reset.note")}
            </span>
          </div>
          <div class="flex justify-end gap-2">
            <Button variant="ghost" size="large" onClick={() => dialog.close()}>
              {language.t("common.cancel")}
            </Button>
            <Button variant="primary" size="large" disabled={state.status === "loading"} onClick={handleReset}>
              {language.t("workspace.reset.button")}
            </Button>
          </div>
        </div>
      </Dialog>
    )
  }

  const activeRoute = {
    session: "",
    sessionProject: "",
    directory: "",
  }

  createEffect(
    on(
      () => {
        return [pageReady(), route().slug, params.id, currentProject()?.worktree, currentDir()] as const
      },
      ([ready, slug, id, root, dir]) => {
        if (!ready || !slug || !dir) {
          activeRoute.session = ""
          activeRoute.sessionProject = ""
          activeRoute.directory = ""
          return
        }

        if (!id) {
          activeRoute.session = ""
          activeRoute.sessionProject = ""
          activeRoute.directory = ""
          return
        }

        const session = `${slug}/${id}`

        if (!root) {
          activeRoute.session = session
          activeRoute.directory = dir
          activeRoute.sessionProject = ""
          return
        }

        if (server.projects.last() !== root) server.projects.touch(root)

        const changed = session !== activeRoute.session || dir !== activeRoute.directory
        if (changed) {
          activeRoute.session = session
          activeRoute.directory = dir
          activeRoute.sessionProject = syncSessionRoute(dir, id, root)
          return
        }

        if (root === activeRoute.sessionProject) return
        activeRoute.directory = dir
        activeRoute.sessionProject = rememberSessionRoute(dir, id, root)
      },
    ),
  )

  const side = createMemo(() => Math.max(layout.sidebar.width(), 244))
  const panel = createMemo(() => Math.max(side() - 64, 0))

  const loadedSessionDirs = new Set<string>()

  createEffect(
    on(
      visibleSessionDirs,
      (dirs) => {
        if (dirs.length === 0) {
          loadedSessionDirs.clear()
          return
        }

        const next = new Set(dirs)
        for (const directory of next) {
          if (loadedSessionDirs.has(directory)) continue
          void globalSync.project.loadSessions(directory)
        }

        loadedSessionDirs.clear()
        for (const directory of next) {
          loadedSessionDirs.add(directory)
        }
      },
      { defer: true },
    ),
  )

  function handleDragStart(event: unknown) {
    const id = getDraggableId(event)
    if (!id) return
    setHoverProject(undefined)
    setStore("activeProject", id)
  }

  function handleDragOver(event: DragEvent) {
    const { draggable, droppable } = event
    if (draggable && droppable) {
      const projects = layout.projects.list()
      const fromIndex = projects.findIndex((p) => p.worktree === draggable.id.toString())
      const toIndex = projects.findIndex((p) => p.worktree === droppable.id.toString())
      if (fromIndex !== toIndex && toIndex !== -1) {
        layout.projects.move(draggable.id.toString(), toIndex)
      }
    }
  }

  function handleDragEnd() {
    setStore("activeProject", undefined)
  }

  function workspaceIds(project: LocalProject | undefined) {
    if (!project) return []
    const local = project.worktree
    const dirs = [local, ...(project.sandboxes ?? [])]
    const active = currentProject()
    const directory = pathKey(active?.worktree ?? "") === pathKey(project.worktree) ? currentDir() : undefined
    const extra =
      directory && pathKey(directory) !== pathKey(local) && !dirs.some((item) => pathKey(item) === pathKey(directory))
        ? directory
        : undefined
    const pending = extra ? WorktreeState.get(extra)?.status === "pending" : false

    const ordered = effectiveWorkspaceOrder(local, dirs, store.workspaceOrder[project.worktree])
    if (pending && extra) return [local, extra, ...ordered.filter((item) => item !== local)]
    if (!extra) return ordered
    if (pending) return ordered
    return [...ordered, extra]
  }

  const sidebarProject = createMemo(() => {
    if (layout.sidebar.opened()) return currentProject()
    const hovered = hoverProjectData()
    if (hovered) return hovered
    return currentProject()
  })

  function handleWorkspaceDragStart(event: unknown) {
    const id = getDraggableId(event)
    if (!id) return
    setStore("activeWorkspace", id)
  }

  function handleWorkspaceDragOver(event: DragEvent) {
    const { draggable, droppable } = event
    if (!draggable || !droppable) return

    const project = sidebarProject()
    if (!project) return

    const ids = workspaceIds(project)
    const fromIndex = ids.findIndex((dir) => dir === draggable.id.toString())
    const toIndex = ids.findIndex((dir) => dir === droppable.id.toString())
    if (fromIndex === -1 || toIndex === -1) return
    if (fromIndex === toIndex) return

    const result = ids.slice()
    const [item] = result.splice(fromIndex, 1)
    if (!item) return
    result.splice(toIndex, 0, item)
    setStore(
      "workspaceOrder",
      project.worktree,
      result.filter((directory) => pathKey(directory) !== pathKey(project.worktree)),
    )
  }

  function handleWorkspaceDragEnd() {
    setStore("activeWorkspace", undefined)
  }

  const createWorkspace = async (project: LocalProject) => {
    clearSidebarHoverState()
    const created = await globalSDK.client.worktree
      .create({
        directory: project.worktree,
        worktreeCreateInput: {
          name: project.name || getFilename(project.worktree),
          branchPrefix: settings.git.branchPrefix(),
        },
      })
      .then((x) => x.data)
      .catch((err) => {
        showToast({
          title: language.t("workspace.create.failed.title"),
          description: errorMessage(err, language.t("common.requestFailed")),
        })
        return undefined
      })

    if (!created?.directory) return

    setWorkspaceName(created.directory, created.branch, project.id, created.branch)

    const local = project.worktree
    const key = pathKey(created.directory)
    const root = pathKey(local)

    setBusy(created.directory, true)
    WorktreeState.pending(created.directory)
    setStore("workspaceExpanded", key, true)
    if (key !== created.directory) {
      setStore("workspaceExpanded", created.directory, true)
    }
    setStore("workspaceOrder", project.worktree, (prev) => {
      const existing = prev ?? []
      const next = existing.filter((item) => {
        const id = pathKey(item)
        return id !== root && id !== key
      })
      return [created.directory, ...next]
    })

    globalSync.child(created.directory)
    navigateWithSidebarReset(`/${base64Encode(created.directory)}/session`)
  }

  const workspaceSidebarCtx: WorkspaceSidebarContext = {
    currentDir,
    navList: currentSessions,
    sidebarExpanded,
    sidebarHovering,
    clearHoverProjectSoon,
    prefetchSession,
    archiveSession,
    workspaceName,
    renameWorkspace,
    editorOpen,
    openEditor,
    closeEditor,
    setEditor,
    InlineEditor,
    isBusy,
    workspaceExpanded: (directory, local) => store.workspaceExpanded[directory] ?? local,
    setWorkspaceExpanded: (directory, value) => setStore("workspaceExpanded", directory, value),
    showResetWorkspaceDialog: (root, directory) =>
      dialog.show(() => <DialogResetWorkspace root={root} directory={directory} />),
    showDeleteWorkspaceDialog: (root, directory) =>
      dialog.show(() => <DialogDeleteWorkspace root={root} directory={directory} />),
    setScrollContainerRef: (el, mobile) => {
      if (!mobile) scrollContainerRef = el
    },
  }

  const projectSidebarCtx: ProjectSidebarContext = {
    currentDir,
    currentProject,
    sidebarOpened: () => layout.sidebar.opened(),
    sidebarHovering,
    hoverProject: () => state.hoverProject,
    onProjectMouseEnter: (worktree, event) => aim.enter(worktree, event),
    onProjectMouseLeave: (worktree) => aim.leave(worktree),
    onProjectFocus: (worktree) => aim.activate(worktree),
    onHoverOpenChanged: (worktree, hoverOpen) => {
      if (!hoverOpen && state.hoverProject && state.hoverProject !== worktree) return
      setState("hoverProject", hoverOpen ? worktree : undefined)
    },
    navigateToProject,
    openSidebar: () => layout.sidebar.open(),
    closeProject,
    showEditProjectDialog,
    toggleProjectWorkspaces,
    workspacesEnabled: (project) => project.vcs === "git" && layout.sidebar.workspaces(project.worktree)(),
    workspaceIds,
    workspaceLabel,
    sessionProps: {
      navList: currentSessions,
      sidebarExpanded,
      clearHoverProjectSoon,
      prefetchSession,
      archiveSession,
    },
  }

  const SidebarPanel = (panelProps: {
    project: Accessor<LocalProject | undefined>
    mobile?: boolean
    merged?: boolean
  }) => {
    const project = panelProps.project
    const merged = createMemo(() => panelProps.mobile || (panelProps.merged ?? layout.sidebar.opened()))
    const hover = createMemo(() => !panelProps.mobile && panelProps.merged === false && !layout.sidebar.opened())
    const empty = createMemo(() => !params.dir && layout.projects.list().length === 0)
    const projectName = createMemo(() => {
      const item = project()
      if (!item) return ""
      return item.name || getFilename(item.worktree)
    })
    const projectId = createMemo(() => project()?.id ?? "")
    const worktree = createMemo(() => project()?.worktree ?? "")
    const slug = createMemo(() => {
      const dir = worktree()
      if (!dir) return ""
      return base64Encode(dir)
    })
    const workspaces = createMemo(() => {
      const item = project()
      if (!item) return [] as string[]
      return workspaceIds(item)
    })
    const unseenCount = createMemo(() =>
      workspaces().reduce((total, directory) => total + notification.project.unseenCount(directory), 0),
    )
    const clearNotifications = () =>
      workspaces()
        .filter((directory) => notification.project.unseenCount(directory) > 0)
        .forEach((directory) => notification.project.markViewed(directory))
    const workspacesEnabled = createMemo(() => {
      const item = project()
      if (!item) return false
      if (item.vcs !== "git") return false
      return layout.sidebar.workspaces(item.worktree)()
    })
    const canToggle = createMemo(() => {
      const item = project()
      if (!item) return false
      return item.vcs === "git" || layout.sidebar.workspaces(item.worktree)()
    })
    const homedir = createMemo(() => globalSync.data.path.home)

    return (
      <div
        classList={{
          "flex flex-col min-h-0 min-w-0 box-border rounded-tl-[12px] px-3": true,
          "border border-b-0 border-border-weak-base": !merged(),
          "border-l border-t border-border-weaker-base": merged(),
          "bg-background-base": merged() || hover(),
          "bg-background-stronger": !merged() && !hover(),
          "flex-1 min-w-0": panelProps.mobile,
          "max-w-full overflow-hidden": panelProps.mobile,
        }}
        style={{
          width: panelProps.mobile ? undefined : `${panel()}px`,
        }}
      >
        <Show
          when={project()}
          fallback={
            <Show when={empty()}>
              <div class="flex-1 min-h-0 -mt-4 flex items-center justify-center px-6 pb-64 text-center">
                <div class="mt-8 flex max-w-60 flex-col items-center gap-6 text-center">
                  <div class="flex flex-col gap-3">
                    <div class="text-14-medium text-text-strong">{language.t("sidebar.empty.title")}</div>
                    <div class="text-14-regular text-text-base" style={{ "line-height": "var(--line-height-normal)" }}>
                      {language.t("sidebar.empty.description")}
                    </div>
                  </div>
                  <Button size="large" icon="folder-add-left" onClick={chooseProject}>
                    {language.t("command.project.open")}
                  </Button>
                </div>
              </div>
            </Show>
          }
        >
          {(project) => (
            <>
              <div class="shrink-0 pl-1 py-1">
                <div class="group/project flex items-start justify-between gap-2 py-2 pl-2 pr-0">
                  <div class="flex flex-col min-w-0">
                    <InlineEditor
                      id={`project:${projectId()}`}
                      value={projectName}
                      maxLength={PROJECT_NAME_MAX_LENGTH}
                      onSave={(next) => {
                        const item = project()
                        if (!item) return
                        void renameProject(item, next)
                      }}
                      class="text-14-medium text-text-strong truncate"
                      displayClass="text-14-medium text-text-strong truncate"
                      stopPropagation
                    />

                    <Tooltip
                      placement="bottom"
                      gutter={2}
                      value={worktree()}
                      class="shrink-0"
                      contentStyle={{
                        "max-width": "640px",
                        transform: "translate3d(52px, 0, 0)",
                      }}
                    >
                      <span class="text-12-regular text-text-base truncate select-text">
                        {worktree().replace(homedir(), "~")}
                      </span>
                    </Tooltip>
                  </div>

                  <DropdownMenu modal={!sidebarHovering()}>
                    <DropdownMenu.Trigger
                      as={IconButton}
                      icon="dot-grid"
                      variant="ghost"
                      data-action="project-menu"
                      data-project={slug()}
                      class="shrink-0 size-6 rounded-md transition-opacity data-[expanded]:bg-surface-base-active"
                      classList={{
                        "opacity-100": panelProps.mobile || merged(),
                        "opacity-0 group-hover/project:opacity-100 group-focus-within/project:opacity-100 data-[expanded]:opacity-100":
                          !panelProps.mobile && !merged(),
                      }}
                      aria-label={language.t("common.moreOptions")}
                    />
                    <DropdownMenu.Portal>
                      <DropdownMenu.Content class="mt-1">
                        <DropdownMenu.Item
                          onSelect={() => {
                            const item = project()
                            if (!item) return
                            showEditProjectDialog(item)
                          }}
                        >
                          <DropdownMenu.ItemLabel>{language.t("common.edit")}</DropdownMenu.ItemLabel>
                        </DropdownMenu.Item>
                        <DropdownMenu.Item
                          data-action="project-workspaces-toggle"
                          data-project={slug()}
                          disabled={!canToggle()}
                          onSelect={() => {
                            const item = project()
                            if (!item) return
                            toggleProjectWorkspaces(item)
                          }}
                        >
                          <DropdownMenu.ItemLabel>
                            {workspacesEnabled()
                              ? language.t("sidebar.workspaces.disable")
                              : language.t("sidebar.workspaces.enable")}
                          </DropdownMenu.ItemLabel>
                        </DropdownMenu.Item>
                        <DropdownMenu.Item
                          data-action="project-clear-notifications"
                          data-project={slug()}
                          disabled={unseenCount() === 0}
                          onSelect={clearNotifications}
                        >
                          <DropdownMenu.ItemLabel>
                            {language.t("sidebar.project.clearNotifications")}
                          </DropdownMenu.ItemLabel>
                        </DropdownMenu.Item>
                        <DropdownMenu.Separator />
                        <DropdownMenu.Item
                          data-action="project-close-menu"
                          data-project={slug()}
                          onSelect={() => {
                            const dir = worktree()
                            if (!dir) return
                            closeProject(dir)
                          }}
                        >
                          <DropdownMenu.ItemLabel>{language.t("common.close")}</DropdownMenu.ItemLabel>
                        </DropdownMenu.Item>
                      </DropdownMenu.Content>
                    </DropdownMenu.Portal>
                  </DropdownMenu>
                </div>
              </div>

              <div class="flex-1 min-h-0 flex flex-col">
                <Show
                  when={workspacesEnabled()}
                  fallback={
                    <>
                      <div class="shrink-0 py-4">
                        <Button
                          size="large"
                          icon="new-session"
                          class="w-full"
                          onClick={() => {
                            const dir = worktree()
                            if (!dir) return
                            openNewSession({
                              slug: base64Encode(dir),
                              reset: resetPromptDraft,
                              navigate: navigateWithSidebarReset,
                            })
                          }}
                        >
                          {language.t("command.session.new")}
                        </Button>
                      </div>
                      <div class="flex-1 min-h-0">
                        <LocalWorkspace
                          ctx={workspaceSidebarCtx}
                          project={project()}
                          sortNow={sortNow}
                          mobile={panelProps.mobile}
                        />
                      </div>
                    </>
                  }
                >
                  <>
                    <div class="shrink-0 py-4">
                      <Button
                        size="large"
                        icon="plus-small"
                        class="w-full"
                        onClick={() => {
                          const item = project()
                          if (!item) return
                          void createWorkspace(item)
                        }}
                      >
                        {language.t("workspace.new")}
                      </Button>
                    </div>
                    <div class="relative flex-1 min-h-0">
                      <DragDropProvider
                        onDragStart={handleWorkspaceDragStart}
                        onDragEnd={handleWorkspaceDragEnd}
                        onDragOver={handleWorkspaceDragOver}
                        collisionDetector={closestCenter}
                      >
                        <DragDropSensors />
                        <ConstrainDragXAxis />
                        <div
                          ref={(el) => {
                            if (!panelProps.mobile) scrollContainerRef = el
                          }}
                          class="size-full flex flex-col py-2 gap-4 overflow-y-auto no-scrollbar [overflow-anchor:none]"
                        >
                          <SortableProvider ids={workspaces()}>
                            <For each={workspaces()}>
                              {(directory) => (
                                <SortableWorkspace
                                  ctx={workspaceSidebarCtx}
                                  directory={directory}
                                  project={project()}
                                  sortNow={sortNow}
                                  mobile={panelProps.mobile}
                                />
                              )}
                            </For>
                          </SortableProvider>
                        </div>
                        <DragOverlay>
                          <WorkspaceDragOverlay
                            sidebarProject={sidebarProject}
                            activeWorkspace={() => store.activeWorkspace}
                            workspaceLabel={workspaceLabel}
                          />
                        </DragOverlay>
                      </DragDropProvider>
                    </div>
                  </>
                </Show>
              </div>
            </>
          )}
        </Show>

        <div
          class="shrink-0 px-3 py-3"
          classList={{
            hidden: store.gettingStartedDismissed || !(providers.all().length > 0 && providers.paid().length === 0),
          }}
        >
          <div class="rounded-xl bg-background-base shadow-xs-border-base" data-component="getting-started">
            <div class="p-3 flex flex-col gap-6">
              <div class="flex flex-col gap-2">
                <div class="text-14-medium text-text-strong">{language.t("sidebar.gettingStarted.title")}</div>
                <div class="text-14-regular text-text-base" style={{ "line-height": "var(--line-height-normal)" }}>
                  {language.t("sidebar.gettingStarted.line1")}
                </div>
                <div class="text-14-regular text-text-base" style={{ "line-height": "var(--line-height-normal)" }}>
                  {language.t("sidebar.gettingStarted.line2")}
                </div>
              </div>
              <div data-component="getting-started-actions">
                <Button size="large" icon="plus-small" onClick={connectProvider}>
                  {language.t("command.provider.connect")}
                </Button>
                <Button size="large" variant="ghost" onClick={() => setStore("gettingStartedDismissed", true)}>
                  {language.t("toast.update.action.notYet")}
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>
    )
  }

  const projects = () => layout.projects.list()
  const projectOverlay = () => <ProjectDragOverlay projects={projects} activeProject={() => store.activeProject} />

  const onSearchClick = () => dialog.show(() => <SearchDialog scratchChatDir={scratchChatDir()} />)
  const onPluginsClick = () => navigate("/plugins")
  const onAutomationsClick = () => navigateWithSidebarReset("/automations")

  // 1. 优先按传入的 directory 在对应 child store 找；store 没初始化或没这条会话时（worktree fork 后用户没 navigate 过去的情形）
  // 2. 退而求其次：只在已 bootstrap 的 child store 里搜（hasChild 兜底，避免 ensureChild 强制创建空 store + pin 引用造成长期累积）
  // 3. 都找不到再放弃
  const archiveSessionByID = async (sessionID: string, directory: string) => {
    // 优先按调用方 hint 找
    if (globalSync.hasChild(directory)) {
      const [s] = globalSync.child(directory, { bootstrap: false })
      const hit = (s.session ?? []).find((x) => x.id === sessionID)
      if (hit) {
        await archiveSession(hit)
        return
      }
    }
    // 按 project worktree / sandbox 找
    for (const project of globalSync.data.project) {
      for (const dir of [project.worktree, ...(project.sandboxes ?? [])]) {
        if (!globalSync.hasChild(dir)) continue
        const [s] = globalSync.child(dir, { bootstrap: false })
        const hit = (s.session ?? []).find((x) => x.id === sessionID)
        if (hit) {
          await archiveSession(hit)
          return
        }
      }
    }
    // 兜底：扫所有已 bootstrap 的 child store（含 scratch chat / 跨目录混入的 session）
    for (const dir of globalSync.childDirectories()) {
      const [s] = globalSync.child(dir, { bootstrap: false })
      const hit = (s.session ?? []).find((x) => x.id === sessionID)
      if (hit) {
        await archiveSession(hit)
        return
      }
    }
    const projectDirectories = layout.projects
      .list()
      .flatMap((project) => [project.worktree, ...(project.sandboxes ?? [])])
    const result = await getSessionAcrossDirectories(globalSDK.client, globalSync, sessionID, directory, {
      extraDirectories: projectDirectories,
    })
    if (result.ok && result.session.time.archived === undefined) {
      await archiveSession(result.session)
      return
    }
    console.error("archiveSessionByID: session not found in any child store", { sessionID, directory })
    showToast({
      variant: "error",
      title: language.t("sidebar.thread.menu.archive"),
      description: language.t("common.requestFailed"),
    })
  }

  const onNewChatGlobal = () => {
    // 当前已经在某个项目下时（URL 里有真实 project worktree），新对话默认落到该项目；
    // 完全无项目状态（首次进入 / 已经在 scratch）才退到 scratch 散对话目录。
    const project = currentProject()
    if (project) {
      openNewSession({
        slug: base64Encode(project.worktree),
        reset: resetPromptDraft,
        navigate: navigateWithSidebarReset,
      })
      return
    }
    void onNewChatScratch()
  }
  const onNewChatScratch = async () => {
    // 优先用 onMount 缓存的 signal；signal 还没 ready 时直接调 platform 拿一次，避免按钮时序失效
    let scratch = scratchChatDir()
    if (!scratch && platform.ensureScratchChatDir) {
      try {
        scratch = await platform.ensureScratchChatDir()
        if (scratch) {
          setScratchChatDir(scratch)
          void globalSync.project.loadSessions(scratch)
        }
      } catch {
        return
      }
    }
    if (!scratch) return
    openNewSession({ slug: base64Encode(scratch), reset: resetPromptDraft, navigate: navigateWithSidebarReset })
  }
  const onNewChatInProject = (project: LocalProject) => {
    openNewSession({
      slug: base64Encode(project.worktree),
      reset: resetPromptDraft,
      navigate: navigateWithSidebarReset,
    })
  }

  async function browseParentForBlankProject(current: string) {
    try {
      if (platform.openDirectoryPickerDialog && server.isLocal()) {
        const result = await platform.openDirectoryPickerDialog({
          title: language.t("sidebar.blankProject.pathLabel"),
          defaultPath: current || undefined,
        })
        if (Array.isArray(result)) return result[0] ?? null
        return result
      }
      return await new Promise<string | null>((resolve) => {
        const run = ++dialogRun
        void import("@/components/dialog-select-directory").then((x) => {
          if (dialogDead || dialogRun !== run) return
          dialog.show(
            () => (
              <x.DialogSelectDirectory
                multiple={false}
                onSelect={(result) => {
                  if (Array.isArray(result)) resolve(result[0] ?? null)
                  else resolve(result)
                }}
              />
            ),
            () => resolve(null),
          )
        })
      })
    } catch (err) {
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: err instanceof Error ? err.message : String(err),
      })
      return null
    }
  }

  const showCreateBlankProjectDialog = async () => {
    if (!platform.createBlankProject || !platform.getBlankProjectDefaults) {
      void chooseProject()
      return
    }
    try {
      const defaults = await platform.getBlankProjectDefaults({ baseName: BLANK_PROJECT_DEFAULT_BASE })
      dialog.show(() => (
        <DialogCreateBlankProject
          defaultName={defaults.name}
          defaultParent={defaults.parent}
          onBrowseParent={browseParentForBlankProject}
          checkNameTaken={(parent, name) =>
            platform.isBlankProjectPathTaken?.({ parent, name }) ?? Promise.resolve(false)
          }
          onCreate={async ({ name, parent }) => {
            try {
              const dir = await platform.createBlankProject!({ parent, name })
              layout.projects.open(dir)
              server.projects.touch(dir)
              navigateWithSidebarReset(`/${base64Encode(dir)}/session`)
            } catch (err) {
              const key = blankProjectCreateErrorKey(err)
              showToast({
                variant: "error",
                title: language.t("common.requestFailed"),
                description: key ? language.t(key) : err instanceof Error ? err.message : String(err),
              })
              throw err
            }
          }}
        />
      ))
    } catch (err) {
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const onAddBlankProject = () => {
    void showCreateBlankProjectDialog()
  }

  const sidebarContent = (mobile?: boolean) => (
    <SidebarContent
      mobile={mobile}
      opened={() => !!mobile || sidebarVisible()}
      renderSidebar={() => (
        <CodexSidebar
          projects={projects}
          pinned={() => layout.tree.pinnedList()}
          activeThreadId={() => params.id}
          sortNow={sortNow}
          handleDragStart={handleDragStart}
          handleDragEnd={handleDragEnd}
          handleDragOver={handleDragOver}
          renderProjectOverlay={projectOverlay}
          onNewChat={onNewChatGlobal}
          onNewChatInProject={onNewChatInProject}
          onSearch={onSearchClick}
          onPlugins={onPluginsClick}
          onAutomations={onAutomationsClick}
          onQuickChat={() => openQuickChat()}
          onArchiveSession={archiveSessionByID}
          onCreateWorktree={(project) => createWorkspace(project)}
          onRename={(project) => showRenameProjectDialog(project)}
          onRemove={(project) => closeProject(project.worktree)}
          onOpenSettings={openSettings}
          onAccountPopoverOpenChange={(open) => {
            if (layout.sidebar.opened()) return
            setState("sidebarPopoverOpen", open)
            if (open) setState("sidebarPeek", true)
            else setState("sidebarPeek", false)
          }}
          onAddProject={chooseProject}
          onAddBlankProject={onAddBlankProject}
          scratchChatDir={scratchChatDir}
          onNewChatScratch={onNewChatScratch}
          onFolderDrop={handleFolderDrop}
        />
      )}
    />
  )

  const isWin = () => platform.platform === "desktop" && platform.os === "windows"

  const renderChromeButtons = () => (
    <>
      <TooltipKeybind
        placement="bottom"
        title={language.t("command.sidebar.toggle")}
        keybind={command.keybind("sidebar.toggle") || ""}
      >
        <Button
          variant="ghost"
          class="titlebar-icon size-7 p-0 box-border"
          style={{ "-webkit-app-region": "no-drag" } as Record<string, string>}
          onClick={layout.sidebar.toggle}
          aria-label={language.t("command.sidebar.toggle")}
        >
          <Icon size="small" name={layout.sidebar.opened() ? "sidebar-active" : "sidebar"} />
        </Button>
      </TooltipKeybind>
      <TooltipKeybind
        placement="bottom"
        title={language.t("common.goBack")}
        keybind={command.keybind("common.goBack") || ""}
      >
        <Button
          variant="ghost"
          icon="chevron-left"
          class="titlebar-icon size-7 p-0 box-border"
          style={{ "-webkit-app-region": "no-drag" } as Record<string, string>}
          onClick={() => canGoBack() && navigate(-1)}
          disabled={!canGoBack()}
          aria-label={language.t("common.goBack")}
        />
      </TooltipKeybind>
      <TooltipKeybind
        placement="bottom"
        title={language.t("common.goForward")}
        keybind={command.keybind("common.goForward") || ""}
      >
        <Button
          variant="ghost"
          icon="chevron-right"
          class="titlebar-icon size-7 p-0 box-border"
          style={{ "-webkit-app-region": "no-drag" } as Record<string, string>}
          onClick={() => canGoForward() && navigate(1)}
          disabled={!canGoForward()}
          aria-label={language.t("common.goForward")}
        />
      </TooltipKeybind>
      <TooltipKeybind
        placement="bottom"
        title={language.t("command.session.new")}
        keybind={command.keybind("session.new") || ""}
      >
        <Button
          variant="ghost"
          icon="new-session"
          class="titlebar-icon size-7 p-0 box-border"
          style={{ "-webkit-app-region": "no-drag" } as Record<string, string>}
          onClick={onNewChatGlobal}
          aria-label={language.t("command.session.new")}
        />
      </TooltipKeybind>
      <Tooltip placement="bottom" value={language.t("sidebar.account.userCenter")}>
        <Button
          variant="ghost"
          icon="user"
          class="titlebar-icon size-7 p-0 box-border"
          style={{ "-webkit-app-region": "no-drag" } as Record<string, string>}
          onClick={() => openUserCenter()}
          aria-current={isUserCenterRoute() ? "page" : undefined}
          aria-label={language.t("sidebar.account.userCenter")}
        />
      </Tooltip>
    </>
  )

  return (
    // 1:1 复刻 Codex：取消独立 titlebar bar，所有按钮（sidebar toggle / 终端 / 右栏）合并到 chat header 行内
    <div
      data-component="app-layout-root"
      class="relative flex-1 min-h-0 min-w-0 flex flex-col select-none [&_input]:select-text [&_textarea]:select-text [&_[contenteditable]]:select-text"
      style={{
        "background-color":
          platform.platform === "desktop" && (platform.os === "macos" || platform.os === "windows")
            ? "transparent"
            : "light-dark(rgb(233,234,232), var(--background-base))",
      }}
    >
      <WindowsTitlebar leading={isWin() || !isOverlayRoute() ? renderChromeButtons : undefined} />
      {autoselecting() ?? ""}
      <Show when={isUserCenterRoute()}>
        <Show when={!autoselecting.loading} fallback={<div class="size-full" />}>
          {props.children}
        </Show>
      </Show>
      <Show when={!isUserCenterRoute()}>
        <Show when={!isWin()}>
          {/* macOS 全局顶部窗口拖拽条：z-[50] 在 chat header 之上、浮动按钮组（z-[100]）之下；
            pointer-events-none 让所有 click 穿透到 chat header / 浮动按钮（app-region 不受 pointer-events 影响）；
            放在 DOM 顺序最前，让后续兄弟元素的 no-drag rect 能正确从拖拽区被减掉。
            不能带 lg: 断点 —— 窗口收窄到 < 1024px 时正是 chat header 中段 spacer 被压成 0、最需要拖拽条的场景。 */}
          <div
            class="block fixed top-0 left-0 right-0 h-10 z-[50] pointer-events-none"
            style={{ "-webkit-app-region": "drag" } as Record<string, string>}
            aria-hidden
          />
          <div
            class="hidden lg:flex fixed top-[3px] left-0 z-[100] items-center gap-1.5 pl-[80px] pr-2 h-9"
            style={
              {
                "-webkit-app-region": "no-drag",
                "--icon-base": "light-dark(rgb(60, 60, 60), rgb(190, 190, 190))",
                "--icon-disabled": "light-dark(rgb(170, 173, 176), rgb(95, 95, 95))",
              } as Record<string, string>
            }
          >
            {renderChromeButtons()}
          </div>
        </Show>
        <div class="flex-1 min-h-0 min-w-0 flex">
          <div class="flex-1 min-h-0 relative">
            <div class="size-full relative overflow-x-hidden">
              <nav
                aria-label={language.t("sidebar.nav.projectsAndSessions")}
                data-component="sidebar-nav-desktop"
                classList={{
                  "hidden lg:block": true,
                  "absolute inset-y-0 left-0": true,
                  "z-10": !state.sidebarPeek,
                  "z-40": state.sidebarPeek,
                  "pointer-events-none": !sidebarVisible(),
                  // 收起/展开加宽度过渡，与 main-bg-fill 的 left 过渡同时长同曲线，裁剪边缘与 main 左缘逐帧对齐
                  "overflow-hidden": true,
                  "transition-transform duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] will-change-transform motion-reduce:transition-none":
                    !state.sizing,
                }}
                style={{
                  width: `${side()}px`,
                  transform: sidebarVisible() ? "translateX(0)" : `translateX(-${side()}px)`,
                }}
                ref={(el) => {
                  setState("nav", el)
                }}
                onMouseEnter={() => {
                  disarm()
                  if (!layout.sidebar.opened()) setState("sidebarPeek", true)
                }}
                onMouseLeave={() => {
                  if (!layout.sidebar.opened() && !state.sidebarPopoverOpen) setState("sidebarPeek", false)
                  aim.reset()
                  if (!sidebarHovering()) return

                  arm()
                }}
              >
                {/* 内容固定 side() 宽：收起时只被裁剪、不重排；原先 w-full 随 nav 归零，整棵侧栏树一帧内全量 reflow 造成卡顿 */}
                <div class="@container h-full contain-strict" style={{ width: `${side()}px` }}>
                  {sidebarContent()}
                </div>
              </nav>

              <Show when={!layout.sidebar.opened() && !state.sidebarPeek}>
                <div
                  class="hidden lg:block absolute inset-y-0 left-0 z-30 w-3"
                  onMouseEnter={() => setState("sidebarPeek", true)}
                  aria-hidden
                />
              </Show>

              <Show when={layout.sidebar.opened()}>
                <div
                  class="hidden lg:block absolute inset-y-0 z-30 w-0 overflow-visible"
                  style={{ left: `${side()}px` }}
                >
                  <ResizeHandle
                    direction="horizontal"
                    size={layout.sidebar.width()}
                    min={244}
                    collapseThreshold={244}
                    max={typeof window === "undefined" ? 1000 : window.innerWidth * 0.3 + 64}
                    onResizeStart={() => setState("sizing", true)}
                    onResize={(w) => {
                      setState("sizing", true)
                      if (sizet !== undefined) clearTimeout(sizet)
                      sizet = window.setTimeout(() => setState("sizing", false), 120)
                      layout.sidebar.resize(w)
                    }}
                    onCollapse={() => {
                      if (sizet !== undefined) clearTimeout(sizet)
                      setState("sizing", false)
                      setState("sidebarPeek", false)
                      setState("sidebarPopoverOpen", false)
                      layout.sidebar.close()
                    }}
                  />
                </div>
              </Show>

              {/* 1:1 复刻 Codex：移除 titlebar 下方的分割横线，让 sidebar/main 顶到底连续 */}

              <div class="lg:hidden">
                <div
                  classList={{
                    "fixed inset-x-0 top-10 bottom-0 z-40 transition-opacity duration-200": true,
                    "opacity-100 pointer-events-auto": layout.mobileSidebar.opened(),
                    "opacity-0 pointer-events-none": !layout.mobileSidebar.opened(),
                  }}
                  onClick={(e) => {
                    if (e.target === e.currentTarget) layout.mobileSidebar.hide()
                  }}
                />
                <nav
                  aria-label={language.t("sidebar.nav.projectsAndSessions")}
                  data-component="sidebar-nav-mobile"
                  classList={{
                    "@container fixed top-10 bottom-0 left-0 z-50 w-full max-w-[400px] overflow-hidden border-r border-border-weaker-base bg-background-base transition-transform duration-200 ease-out": true,
                    "translate-x-0": layout.mobileSidebar.opened(),
                    "-translate-x-full": !layout.mobileSidebar.opened(),
                  }}
                  onClick={(e) => e.stopPropagation()}
                >
                  {sidebarContent(true)}
                </nav>
              </div>

              <div
                data-slot="main-bg-fill"
                classList={{
                  "absolute inset-0": true,
                  "lg:inset-y-0 lg:right-0 lg:left-[var(--main-left)]": true,
                  "z-20": true,
                  "transition-[left] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[left] motion-reduce:transition-none":
                    !state.sizing,
                }}
                style={{
                  "--main-left": layout.sidebar.opened() ? `${side()}px` : "0px",
                }}
              >
                {/* 1:1 复刻 Codex：浮动按钮组改用 fixed 顶层定位，避开 main 的 contain-strict / sibling 元素的 stacking 干扰 */}
                <main
                  classList={{
                    // 不用 contain：contain: layout 会创建 stacking context + 改变 fixed 子级的 containing block，
                    // 导致内部 fixed z-[100] 浮动按钮被外层困死
                    "relative size-full overflow-x-hidden flex flex-col items-start bg-background-stronger lg:rounded-[12px]": true,
                    "lg:shadow-[-2px_0_10px_rgba(0,0,0,0.04),0_-1px_4px_rgba(0,0,0,0.02)]": !isWin(),
                    // Windows titlebar 已提供顶部分界，再叠顶部阴影会在 titlebar 下沿描一道暗灰
                    "lg:shadow-[-2px_0_10px_rgba(0,0,0,0.04)]": isWin(),
                  }}
                  style={{ border: "1px solid light-dark(rgba(0,0,0,0.10), rgba(255,255,255,0.12))" }}
                >
                  <Show when={!autoselecting.loading} fallback={<div class="size-full" />}>
                    {props.children}
                  </Show>
                </main>
              </div>

              <div
                classList={{
                  "hidden lg:flex absolute inset-y-0 left-16 z-30": true,
                  "opacity-100 translate-x-0 pointer-events-auto": state.peeked && !layout.sidebar.opened(),
                  "opacity-0 -translate-x-2 pointer-events-none": !state.peeked || layout.sidebar.opened(),
                  "transition-[opacity,transform] motion-reduce:transition-none": true,
                  "duration-180 ease-out": state.peeked && !layout.sidebar.opened(),
                  "duration-120 ease-in": !state.peeked || layout.sidebar.opened(),
                }}
                onMouseMove={disarm}
                onMouseEnter={() => {
                  disarm()
                  aim.reset()
                }}
                onPointerDown={disarm}
                onMouseLeave={() => {
                  arm()
                }}
              >
                <Show when={peekProject()}>
                  <SidebarPanel project={peekProject} merged={false} />
                </Show>
              </div>

              <div
                classList={{
                  "hidden lg:block pointer-events-none absolute inset-y-0 right-0 z-25 overflow-hidden": true,
                  "opacity-100 translate-x-0": state.peeked && !layout.sidebar.opened(),
                  "opacity-0 -translate-x-2": !state.peeked || layout.sidebar.opened(),
                  "transition-[opacity,transform] motion-reduce:transition-none": true,
                  "duration-180 ease-out": state.peeked && !layout.sidebar.opened(),
                  "duration-120 ease-in": !state.peeked || layout.sidebar.opened(),
                }}
                style={{ left: `calc(4rem + ${panel()}px)` }}
              >
                <div class="h-full w-px" style={{ "box-shadow": "var(--shadow-sidebar-overlay)" }} />
              </div>
            </div>
          </div>
          {import.meta.env.DEV && <DebugBar />}
        </div>
      </Show>
      <QuickChatDock />
      {/* 设置覆盖层：不路由跳转，会话永不卸载，避免返回时重建卡顿。
          :has(settings-route-root) CSS 隐藏会话 → macOS vibrancy 透视桌面（非会话）。 */}
      <Show when={settingsOverlay()}>
        {(overlay) => <SettingsPage initialTab={overlay().tab} onClose={() => setSettingsOverlay(null)} />}
      </Show>
      {/* 个人中心覆盖层：不路由跳转，会话永不卸载。 */}
      <Show when={userCenterOverlay()}>
        {(overlay) => <UsersPage initialTab={overlay().tab} onClose={() => setUserCenterOverlay(null)} />}
      </Show>
    </div>
  )
}
