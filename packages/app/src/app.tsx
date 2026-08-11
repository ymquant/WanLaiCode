import "@/index.css"
import * as Sentry from "@sentry/solid"
import { I18nProvider, SkillFileProvider } from "@opencode-ai/ui/context"
import { DIALOG_ACTIVE_EVENT, DialogProvider } from "@opencode-ai/ui/context/dialog"
import { ImagePreviewProvider } from "@opencode-ai/ui/context/image-preview"
import { FileComponentProvider } from "@opencode-ai/ui/context/file"
import { MarkedProvider } from "@opencode-ai/ui/context/marked"
import { File } from "@opencode-ai/ui/file"
import { Font } from "@opencode-ai/ui/font"
import { Splash } from "@opencode-ai/ui/logo"
import { ThemeProvider, type ColorScheme } from "@opencode-ai/ui/theme/context"
import { Toast, showToast } from "@opencode-ai/ui/toast"
import { MetaProvider } from "@solidjs/meta"
import { type BaseRouterProps, Navigate, Route, Router, useLocation } from "@solidjs/router"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { Effect } from "effect"
import {
  type Component,
  createMemo,
  createResource,
  createSignal,
  ErrorBoundary,
  For,
  type JSX,
  lazy,
  onCleanup,
  onMount,
  type ParentProps,
  Show,
} from "solid-js"
import { Dynamic } from "solid-js/web"
// 副作用导入:注册 automation_create 工具的对话内联卡片渲染器(registerTool)
import "@/pages/automation/tool-card"
import { AutomationSessionsProvider } from "@/context/automation-sessions"
import { CommandProvider } from "@/context/command"
import { CommentsProvider } from "@/context/comments"
import { FileProvider } from "@/context/file"
import { useFile } from "@/context/file"
import { GlobalSDKProvider } from "@/context/global-sdk"
import { GlobalSyncProvider, useGlobalSync } from "@/context/global-sync"
import { HighlightsProvider } from "@/context/highlights"
import { IssueReportProvider } from "@/context/issue-report"
import { LanguageProvider, type Locale, useLanguage } from "@/context/language"
import { LayoutProvider } from "@/context/layout"
import { useLayout } from "@/context/layout"
import { usePlatform } from "@/context/platform"
import { createSessionDesktopLayout } from "@/pages/session/helpers"
import { ModelsProvider } from "@/context/models"
import { NotificationProvider } from "@/context/notification"
import { PermissionProvider } from "@/context/permission"
import { PromptProvider } from "@/context/prompt"
import { ServerConnection, ServerProvider, serverName, useServer } from "@/context/server"
import { SettingsProvider } from "@/context/settings"
import { TerminalProvider } from "@/context/terminal"
import DirectoryLayout from "@/pages/directory-layout"
import Layout from "@/pages/layout"
import { useSessionKey } from "@/pages/session/session-layout"
import { ErrorPage } from "./pages/error"
import { OPEN_SKILL_FILE_EVENT, type OpenSkillFileEventDetail } from "@/utils/open-skill-file"
import { registerSkillPreview, resolveSkillPreviewPath } from "@/utils/skill-preview"
import type { OpenSkillFileInput } from "@opencode-ai/ui/context/skill-file"
import { PROJECT_FILES_TAB_ID } from "@/components/session/project-files-tab"
import { AppSnapshotController, AppSnapshotPromptBridge } from "@/components/app-snapshot-controller"
import { useCheckServerHealth } from "./utils/server-health"
import { OPEN_LOCAL_FILE_EVENT, type OpenLocalFileEventDetail } from "@/utils/open-local-file"
import { resolveDialogTitlebarChrome } from "@/utils/dialog-titlebar"
import { createBrowserViewsHidden } from "@/components/session/browser-tab"

const HomeRoute = lazy(() => import("@/pages/home"))
const loadSession = () => import("@/pages/session")
const Session = lazy(loadSession)
const Users = lazy(() => import("@/pages/users"))
const Automations = lazy(() => import("@/pages/automation"))
const AutomationDetail = lazy(() => import("@/pages/automation/detail"))
const Plugins = lazy(() => import("@/pages/plugins"))
const PluginsManage = lazy(() => import("@/pages/plugins-manage"))
const McpEditor = lazy(() => import("@/pages/mcp-editor"))
const PluginDetail = lazy(() => import("@/pages/plugin-detail"))
const ProjectEdit = lazy(() => import("@/pages/project-edit"))

if (typeof location === "object" && /\/session(?:\/|$)/.test(location.pathname)) {
  void loadSession()
}

const SessionRoute = () => (
  <SessionProviders>
    <Session />
  </SessionProviders>
)

type RendererTitlebarTheme = {
  mode: "light" | "dark"
  source?: "system" | "light" | "dark"
  backgroundColor?: string
  symbolColor?: string
  glass?: boolean
}
type NativeThemeMode = "light" | "dark"

let colorProbe: HTMLDivElement | undefined

function cssVar(name: string) {
  if (typeof document !== "object") return undefined
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  if (!value || value.startsWith("var(")) return undefined
  return value
}

function resolveCssColor(color: string) {
  if (typeof document !== "object") return color
  colorProbe ??= document.createElement("div")
  if (!colorProbe.isConnected) {
    colorProbe.style.position = "fixed"
    colorProbe.style.left = "-9999px"
    colorProbe.style.top = "-9999px"
    colorProbe.style.width = "1px"
    colorProbe.style.height = "1px"
    document.body.append(colorProbe)
  }
  colorProbe.style.color = ""
  colorProbe.style.backgroundColor = color
  return getComputedStyle(colorProbe).backgroundColor || color
}

function titlebarTheme(mode: "light" | "dark", source: "system" | "light" | "dark"): RendererTitlebarTheme {
  return {
    mode,
    source,
    backgroundColor: cssVar("--windows-statusbar-bg") ?? cssVar("--background-base"),
    symbolColor: cssVar("--windows-statusbar-symbol") ?? cssVar("--text-strong"),
  }
}

const SessionIndexRoute = () => <Navigate href="session" />

function UiI18nBridge(props: ParentProps) {
  const language = useLanguage()
  return <I18nProvider value={{ locale: language.intl, t: language.t }}>{props.children}</I18nProvider>
}

function ImagePreviewBridge(props: ParentProps) {
  return (
    <ImagePreviewProvider>
      {props.children}
    </ImagePreviewProvider>
  )
}

declare global {
  interface Window {
    __WANLAICODE__?: {
      updaterEnabled?: boolean
      deepLinks?: string[]
      wsl?: boolean
    }
    /** @deprecated Use __WANLAICODE__ */
    __OPENCODE__?: {
      updaterEnabled?: boolean
      deepLinks?: string[]
      wsl?: boolean
    }
    api?: {
      openMainWindow?: () => Promise<void>
      setTitlebar?: (theme: RendererTitlebarTheme) => Promise<void>
      getNativeThemeMode?: () => Promise<NativeThemeMode>
      onNativeThemeMode?: (cb: (mode: NativeThemeMode) => void) => () => void
      // 系统通知(preload 早就暴露了,此前一直没人用):自动化跑完时提醒用户
      showNotification?: (title: string, body?: string) => void
    }
  }
}

function QueryProvider(props: ParentProps) {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        refetchOnReconnect: false,
        refetchOnMount: false,
        refetchOnWindowFocus: false,
      },
    },
  })
  return <QueryClientProvider client={client}>{props.children}</QueryClientProvider>
}

function AppShellProviders(props: ParentProps) {
  return (
    <SettingsProvider>
      <PermissionProvider>
        <LayoutProvider>
          <NotificationProvider>
            <ModelsProvider>
              <CommandProvider>
                <IssueReportProvider>
                  <HighlightsProvider>
                    <AppSnapshotController />
                    <Layout>{props.children}</Layout>
                  </HighlightsProvider>
                </IssueReportProvider>
              </CommandProvider>
            </ModelsProvider>
          </NotificationProvider>
        </LayoutProvider>
      </PermissionProvider>
    </SettingsProvider>
  )
}

function SessionProviders(props: ParentProps) {
  return (
    <TerminalProvider>
      <FileProvider>
        <SessionSkillFileProvider>
          <PromptProvider>
            <AppSnapshotPromptBridge />
            <CommentsProvider>{props.children}</CommentsProvider>
          </PromptProvider>
        </SessionSkillFileProvider>
      </FileProvider>
    </TerminalProvider>
  )
}

function SessionSkillFileProvider(props: ParentProps) {
  const file = useFile()
  const layout = useLayout()
  const globalSync = useGlobalSync()
  const platform = usePlatform()
  const language = useLanguage()
  const { sessionKey } = useSessionKey()
  const tabs = createMemo(() => layout.tabs(sessionKey))
  const view = createMemo(() => layout.view(sessionKey))
  const isDesktop = createSessionDesktopLayout(platform)
  const openSkillFile = (input: string | OpenSkillFileInput) => {
    const rawPath = typeof input === "string" ? input : input.path
    const name = typeof input === "string" ? undefined : input.name
    const absolutePath = resolveSkillPreviewPath({ path: rawPath, name, home: globalSync.data.path.home })
    const tab = file.tab(absolutePath)
    const tabPath = file.pathFromTab(tab)
    if (typeof input === "string") {
      registerSkillPreview({ path: absolutePath, aliases: [rawPath, ...(tabPath ? [tabPath] : [])] })
    } else {
      registerSkillPreview({
        path: absolutePath,
        name: input.name,
        displayName: input.displayName,
        aliases: [rawPath, ...(tabPath ? [tabPath] : [])],
      })
    }
    // 扁平化后直接打开外层文件标签（复用浏览项目文件内容），不再先进 default 再嵌套打开。
    void tabs().open(tab, { preview: true })
    tabs().setActive(tab)
    if (!view().reviewPanel.opened()) view().reviewPanel.open()
    void file.load(absolutePath)
  }

  onMount(() => {
    const skillHandler = (event: Event) => {
      const detail = (event as CustomEvent<OpenSkillFileEventDetail>).detail
      if (!detail?.absolutePath) return
      openSkillFile({ path: detail.absolutePath, name: detail.name, displayName: detail.displayName })
    }
    const localFileHandler = (event: Event) => {
      const detail = (event as CustomEvent<OpenLocalFileEventDetail>).detail
      if (!detail?.absolutePath) return
      if (platform.platform === "desktop" && !isDesktop()) {
        showToast({
          variant: "error",
          title: language.t("toast.review.narrowWindow.title"),
          description: language.t("toast.review.narrowWindow.description"),
        })
        return
      }
      const tab = file.tab(detail.absolutePath)
      void tabs().open(tab, { preview: false })
      tabs().setActive(tab)
      if (!view().reviewPanel.opened()) view().reviewPanel.open()
      void file.load(detail.absolutePath)
    }
    window.addEventListener(OPEN_SKILL_FILE_EVENT, skillHandler)
    window.addEventListener(OPEN_LOCAL_FILE_EVENT, localFileHandler)
    onCleanup(() => {
      window.removeEventListener(OPEN_SKILL_FILE_EVENT, skillHandler)
      window.removeEventListener(OPEN_LOCAL_FILE_EVENT, localFileHandler)
    })
  })

  return (
    <SkillFileProvider openSkillFile={openSkillFile}>{props.children}</SkillFileProvider>
  )
}

function RouterRoot(props: ParentProps<{ appChildren?: JSX.Element }>) {
  return (
    <AppShellProviders>
      {props.appChildren}
      {props.children}
    </AppShellProviders>
  )
}

export function AppBaseProviders(props: ParentProps<{ locale?: Locale; colorScheme?: ColorScheme }>) {
  const [dialogActive, setDialogActive] = createSignal(false)
  const [baseTitlebar, setBaseTitlebar] = createSignal<RendererTitlebarTheme | undefined>(undefined)

  const applyTitlebar = (theme: RendererTitlebarTheme | undefined, active: boolean, opts?: { syncSource?: boolean }) => {
    if (!window.api?.setTitlebar) return
    const backgroundColor = theme?.backgroundColor
    const symbolColor = theme?.symbolColor
    if (!backgroundColor) return
    const root = document.documentElement
    const mode = root.dataset.colorScheme === "dark" ? "dark" : "light"
    const chrome = resolveDialogTitlebarChrome({
      active,
      themeId: root.dataset.theme,
      desktopOs: root.dataset.desktopOs,
      windowsBackdrop: root.dataset.windowsBackdrop,
      backgroundColor,
      colorScheme: mode,
      resolveColor: resolveCssColor,
    })
    return window.api.setTitlebar({
      mode,
      ...(opts?.syncSource && theme?.source ? { source: theme.source } : {}),
      backgroundColor: chrome.backgroundColor,
      symbolColor,
      glass: chrome.glass,
    })
  }

  onMount(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ active: boolean }>).detail
      setDialogActive(!!detail?.active)
      // 对话框变暗不应该影响全局 nativeTheme 的 themeSource。
      void applyTitlebar(baseTitlebar(), !!detail?.active, { syncSource: false })
    }
    window.addEventListener(DIALOG_ACTIVE_EVENT, handler as EventListener)
    onCleanup(() => window.removeEventListener(DIALOG_ACTIVE_EVENT, handler as EventListener))
  })

  createBrowserViewsHidden(dialogActive, "dialog")

  return (
    <MetaProvider>
      <Font />
      <ThemeProvider
        colorScheme={props.colorScheme}
        getSystemMode={window.api?.getNativeThemeMode}
        onSystemModeChange={window.api?.onNativeThemeMode}
        onThemeApplied={(_, mode, source) => {
          const next = titlebarTheme(mode, source)
          setBaseTitlebar(next)
          return applyTitlebar(next, dialogActive(), { syncSource: true })
        }}
      >
        <LanguageProvider locale={props.locale}>
          <UiI18nBridge>
            <ErrorBoundary
              fallback={(error) => {
                Sentry.captureException(error)
                // 错误页本身需要弹窗能力；正常树崩溃时外层 provider 已被 ErrorBoundary 替换，
                // 因此 fallback 必须重新提供 DialogProvider，避免二次崩溃成白屏。
                return (
                  <DialogProvider>
                    <ErrorPage error={error} />
                  </DialogProvider>
                )
              }}
            >
              <QueryProvider>
                <DialogProvider>
                  <ImagePreviewBridge>
                    <MarkedProvider>
                      <FileComponentProvider component={File}>{props.children}</FileComponentProvider>
                    </MarkedProvider>
                    <Toast.Region />
                  </ImagePreviewBridge>
                </DialogProvider>
              </QueryProvider>
            </ErrorBoundary>
          </UiI18nBridge>
        </LanguageProvider>
      </ThemeProvider>
    </MetaProvider>
  )
}

function ConnectionGate(props: ParentProps<{ disableHealthCheck?: boolean; skipStartupHealthGate?: boolean }>) {
  const server = useServer()
  const checkServerHealth = useCheckServerHealth()

  const [checkMode, setCheckMode] = createSignal<"blocking" | "background">("blocking")

  // performs repeated health check with a grace period for
  // non-http connections, otherwise fails instantly
  // 桌面端加载窗口已经等过 sidecar 初始化；这里只跳过首次阻塞 Splash，保留后续后台健康检查。
  const [startupHealthCheck, healthCheckActions] = createResource(() =>
    props.disableHealthCheck || props.skipStartupHealthGate
      ? true
      : Effect.gen(function* () {
          if (!server.current) return true
          const { http, type } = server.current

          while (true) {
            const res = yield* Effect.promise(() => checkServerHealth(http))
            if (res.healthy) return true
            if (checkMode() === "background" || type === "http") return false
          }
        }).pipe(
          Effect.timeoutOrElse({ duration: "10 seconds", orElse: () => Effect.succeed(false) }),
          Effect.ensuring(Effect.sync(() => setCheckMode("background"))),
          Effect.runPromise,
        ),
  )

  // 注意：这里用 Show + .loading / .state 判断，**而非** Suspense。
  // Suspense 会把 children 中任何 pending createResource 冒泡上来触发 fallback，
  // 导致诸如"首次打开 AccountPopover 时拉 userCenterStatus / balanceEntitlements"这类
  // 子树异步加载，会让整窗闪一下 Splash，视觉上像 reload。
  // Show + .loading 只跟 startupHealthCheck 自己耦合，不会被 children 的 resource 状态污染。
  return (
    <Show
      when={checkMode() === "blocking" ? !startupHealthCheck.loading : startupHealthCheck.state !== "pending"}
      fallback={
        <div class="h-dvh w-screen flex flex-col items-center justify-center bg-background-base">
          <Splash class="w-16 h-20 opacity-50 animate-pulse" />
        </div>
      }
    >
      <Show
        when={checkMode() === "blocking" ? startupHealthCheck() : startupHealthCheck.latest}
        fallback={
          <ConnectionError
            onRetry={() => {
              if (checkMode() === "background") void healthCheckActions.refetch()
            }}
            onServerSelected={(key) => {
              setCheckMode("blocking")
              server.setActive(key)
              void healthCheckActions.refetch()
            }}
          />
        }
      >
        {props.children}
      </Show>
    </Show>
  )
}

function ConnectionError(props: { onRetry?: () => void; onServerSelected?: (key: ServerConnection.Key) => void }) {
  const language = useLanguage()
  const server = useServer()
  const others = () => server.list.filter((s) => ServerConnection.key(s) !== server.key)
  const name = createMemo(() => server.name || server.key)
  const serverToken = "\u0000server\u0000"
  const unreachable = createMemo(() => language.t("app.server.unreachable", { server: serverToken }).split(serverToken))

  const timer = setInterval(() => props.onRetry?.(), 1000)
  onCleanup(() => clearInterval(timer))

  return (
    <div class="h-dvh w-screen flex flex-col items-center justify-center bg-background-base gap-6 p-6">
      <div class="flex flex-col items-center max-w-md text-center">
        <Splash class="w-12 h-15 mb-4" />
        <p class="text-14-regular text-text-base">
          {unreachable()[0]}
          <span class="text-text-strong font-medium">{name()}</span>
          {unreachable()[1]}
        </p>
        <p class="mt-1 text-12-regular text-text-weak">{language.t("app.server.retrying")}</p>
      </div>
      <Show when={others().length > 0}>
        <div class="flex flex-col gap-2 w-full max-w-sm">
          <span class="text-12-regular text-text-base text-center">{language.t("app.server.otherServers")}</span>
          <div class="flex flex-col gap-1 bg-surface-base rounded-lg p-2">
            <For each={others()}>
              {(conn) => {
                const key = ServerConnection.key(conn)
                return (
                  <button
                    type="button"
                    class="flex items-center gap-3 w-full px-3 py-2 rounded-md hover:bg-surface-raised-base-hover transition-colors text-left"
                    onClick={() => props.onServerSelected?.(key)}
                  >
                    <span class="text-14-regular text-text-strong truncate">{serverName(conn)}</span>
                  </button>
                )
              }}
            </For>
          </div>
        </div>
      </Show>
    </div>
  )
}

function ServerKey(props: ParentProps) {
  const server = useServer()
  return (
    <Show when={server.key} keyed>
      {props.children}
    </Show>
  )
}

// /:dir/users 和 /:dir/session/:id? 路由的实际渲染由父级 DirectoryLayoutWrapper
// 根据 pathname 选择性控制，此处仅占位避免路由匹配报错。
const Noop = () => null

function DirectoryLayoutWrapper(props: ParentProps) {
  const location = useLocation()
  const showUsers = () => location.pathname.split("/").pop() === "users"

  return (
    <>
      {/* 会话主视图常驻：进入设置不卸载，避免返回时重建 ghostty 终端/消息列表造成卡顿。
          设置现在通过 layout.tsx 的 settingsOverlay 信号渲染，路由不再跳转。
          用户中心(showUsers)保持原逻辑：仍卸载会话。 */}
      <Show when={!showUsers()}>
        <DirectoryLayout>
          <SessionRoute />
          {props.children}
        </DirectoryLayout>
      </Show>
      <Show when={showUsers()}>
        <Users />
      </Show>
    </>
  )
}

export function AppInterface(props: {
  children?: JSX.Element
  defaultServer: ServerConnection.Key
  servers?: Array<ServerConnection.Any>
  router?: Component<BaseRouterProps>
  root?: Component<ParentProps<{ appChildren?: JSX.Element }>>
  disableHealthCheck?: boolean
  skipStartupHealthGate?: boolean
}) {
  return (
    <ServerProvider
      defaultServer={props.defaultServer}
      disableHealthCheck={props.disableHealthCheck}
      servers={props.servers}
    >
      <ConnectionGate disableHealthCheck={props.disableHealthCheck} skipStartupHealthGate={props.skipStartupHealthGate}>
        <ServerKey>
          <QueryProvider>
            <GlobalSDKProvider>
              <GlobalSyncProvider>
                <AutomationSessionsProvider>
                  <Dynamic
                    component={props.router ?? Router}
                    root={(routerProps) => {
                      const Root = props.root ?? RouterRoot
                      return <Root appChildren={props.children}>{routerProps.children}</Root>
                    }}
                  >
                    <Route path="/" component={HomeRoute} />
                    <Route path="/users" component={Users as any} />
                    <Route path="/automations" component={Automations} />
                    <Route path="/automations/:id" component={AutomationDetail} />
                    <Route path="/plugins" component={Plugins} />
                    <Route path="/plugins/manage" component={PluginsManage} />
                    <Route path="/plugins/manage/mcp/new" component={McpEditor} />
                    <Route path="/plugins/manage/mcp/detail/:name" component={McpEditor} />
                    <Route path="/plugins/:key" component={PluginDetail} />
                    <Route path="/:dir" component={DirectoryLayoutWrapper}>
                      <Route path="/" component={SessionIndexRoute} />
                      <Route path="/users" component={Noop} />
                      <Route path="/session/:id?" component={Noop} />
                      <Route path="/project-edit" component={ProjectEdit} />
                    </Route>
                  </Dynamic>
                </AutomationSessionsProvider>
              </GlobalSyncProvider>
            </GlobalSDKProvider>
          </QueryProvider>
        </ServerKey>
      </ConnectionGate>
    </ServerProvider>
  )
}
