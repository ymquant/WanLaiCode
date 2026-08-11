// @refresh reload

import {
  ACCEPTED_FILE_EXTENSIONS,
  ACCEPTED_FILE_TYPES,
  AppBaseProviders,
  AppInterface,
  handleNotificationClick,
  loadLocaleDict,
  normalizeLocale,
  useLanguage,
  type Locale,
  type Platform,
  PlatformProvider,
  ServerConnection,
  useCommand,
} from "@opencode-ai/app"
import * as Sentry from "@sentry/solid"
import type { AsyncStorage } from "@solid-primitives/storage"
import { createMemoryHistory, MemoryRouter, useNavigate, type BaseRouterProps } from "@solidjs/router"
import { createEffect, createResource, createSignal, onCleanup, onMount, Show } from "solid-js"
import { render } from "solid-js/web"
import pkg from "../../package.json"
import { desktopAddressForRoute, desktopRouteFromLocation } from "./desktop-route"
import { initI18n, t } from "./i18n"
import { webviewZoom } from "./webview-zoom"
import "./styles.css"
import { useTheme } from "@opencode-ai/ui/theme"

const root = document.getElementById("root")
if (import.meta.env.DEV && !(root instanceof HTMLElement)) {
  throw new Error(t("error.dev.rootNotFound"))
}

const clearStartupCover = () => {
  const cover = document.getElementById("desktop-startup-cover")
  if (!cover) return
  let done = false
  let fallback: ReturnType<typeof setTimeout> | undefined
  const leave = () => {
    if (done) return
    done = true
    if (fallback) clearTimeout(fallback)
    cover.dataset.state = "leaving"
    setTimeout(() => cover.remove(), 180)
  }
  if (document.visibilityState !== "visible") {
    leave()
    return
  }
  // 主应用挂载后的两帧再移除遮罩，确保 Windows 首帧已绘制，不露出原生空白底。
  requestAnimationFrame(() => {
    requestAnimationFrame(leave)
  })
  fallback = setTimeout(leave, 250)
}

if (import.meta.env.VITE_SENTRY_DSN) {
  Sentry.init({
    dsn: import.meta.env.VITE_SENTRY_DSN,
    environment: import.meta.env.VITE_SENTRY_ENVIRONMENT ?? import.meta.env.MODE,
    release: import.meta.env.VITE_SENTRY_RELEASE ?? `desktop@${pkg.version}`,
    initialScope: {
      tags: {
        platform: "desktop",
      },
    },
    integrations: (integrations) => {
      return integrations.filter(
        (i) =>
          i.name !== "Breadcrumbs" &&
          !(
            (import.meta.env.VITE_WANLAICODE_CHANNEL ?? import.meta.env.VITE_OPENCODE_CHANNEL) === "prod" &&
            (i.name === "GlobalHandlers" || i.name === "BrowserApiErrors")
          ),
      )
    },
  })
}

void initI18n()

const deepLinkEvent = "wanlaicode:deep-link"

const emitDeepLinks = (urls: string[]) => {
  if (urls.length === 0) return
  window.__WANLAICODE__ ??= {}
  const pending = window.__WANLAICODE__.deepLinks ?? window.__OPENCODE__?.deepLinks ?? []
  window.__WANLAICODE__.deepLinks = [...pending, ...urls]
  window.dispatchEvent(new CustomEvent(deepLinkEvent, { detail: { urls } }))
}

const listenForDeepLinks = () => {
  void window.api.consumeInitialDeepLinks().then((urls) => emitDeepLinks(urls))
  return window.api.onDeepLink((urls) => emitDeepLinks(urls))
}

const detectDesktopOs = () => {
  const ua = navigator.userAgent
  if (ua.includes("Mac")) return "macos"
  if (ua.includes("Windows")) return "windows"
  if (ua.includes("Linux")) return "linux"
  return undefined
}

// 把带透明度的窗口截图合成到不透明主题基色上（去掉 vibrancy/backdrop-filter 造成的毛玻璃观感）。
// 任一步骤失败返回 null，调用方回退原始截图。
const flattenScreenshotOverBackground = async (blob: Blob): Promise<Blob | null> => {
  const style = getComputedStyle(document.documentElement)
  const background = style.getPropertyValue("--background-base").trim()
  if (!background || background.startsWith("var(")) return null
  const bitmap = await createImageBitmap(blob)
  try {
    const canvas = document.createElement("canvas")
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const ctx = canvas.getContext("2d")
    if (!ctx) return null
    ctx.fillStyle = background
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(bitmap, 0, 0)
    return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"))
  } finally {
    bitmap.close()
  }
}

const [windowsBackdrop, setWindowsBackdrop] = createSignal<"mica" | "none" | undefined>()

const createPlatform = (): Platform => {
  const os = detectDesktopOs()
  if (os) document.documentElement.dataset.desktopOs = os
  void window.api
    .getWindowConfig()
    .then((config) => {
      // 仅 Windows 写入 backdrop；macOS / Linux 不挂 data-windows-backdrop，避免误命中玻璃样式
      if (os !== "windows" || !config.windowsBackdrop) return
      document.documentElement.dataset.windowsBackdrop = config.windowsBackdrop
      setWindowsBackdrop(config.windowsBackdrop)
    })
    .catch(() => undefined)

  const isWslEnabled = async () => {
    if (os !== "windows") return false
    return window.api
      .getWslConfig()
      .then((config) => config.enabled)
      .catch(() => false)
  }

  const wslHome = async () => {
    if (!(await isWslEnabled())) return undefined
    return window.api.wslPath("~", "windows").catch(() => undefined)
  }

  const handleWslPicker = async <T extends string | string[]>(result: T | null): Promise<T | null> => {
    if (!result || !(await isWslEnabled())) return result
    if (Array.isArray(result)) {
      return Promise.all(result.map((path) => window.api.wslPath(path, "linux").catch(() => path))) as any
    }
    return window.api.wslPath(result, "linux").catch(() => result) as any
  }

  const storage = (() => {
    const cache = new Map<string, AsyncStorage>()

    const createStorage = (name: string) => {
      const api: AsyncStorage = {
        getItem: (key: string) => window.api.storeGet(name, key),
        setItem: (key: string, value: string) => window.api.storeSet(name, key, value),
        removeItem: (key: string) => window.api.storeDelete(name, key),
        clear: () => window.api.storeClear(name),
        key: async (index: number) => (await window.api.storeKeys(name))[index],
        getLength: () => window.api.storeLength(name),
        get length() {
          return api.getLength()
        },
      }
      return api
    }

    return (name = "default.dat") => {
      const cached = cache.get(name)
      if (cached) return cached
      const api = createStorage(name)
      cache.set(name, api)
      return api
    }
  })()

  return {
    platform: "desktop",
    os,
    version: pkg.version,

    async openDirectoryPickerDialog(opts) {
      const toWindowsPath = async (path?: string) => {
        if (!path || os !== "windows" || !(await isWslEnabled())) return path
        return window.api.wslPath(path, "windows").catch(() => path)
      }
      const defaultPath = opts?.defaultPath ? await toWindowsPath(opts.defaultPath) : await wslHome()
      const result = await window.api.openDirectoryPicker({
        multiple: opts?.multiple ?? false,
        title: opts?.title ?? t("desktop.dialog.chooseFolder"),
        defaultPath,
      })
      return await handleWslPicker(result)
    },

    async openFilePickerDialog(opts) {
      const result = await window.api.openFilePicker({
        multiple: opts?.multiple ?? false,
        title: opts?.title ?? t("desktop.dialog.chooseFile"),
        accept: opts?.accept ?? ACCEPTED_FILE_TYPES,
        extensions: opts?.extensions ?? ACCEPTED_FILE_EXTENSIONS,
      })
      return handleWslPicker(result)
    },

    async saveFilePickerDialog(opts) {
      const result = await window.api.saveFilePicker({
        title: opts?.title ?? t("desktop.dialog.saveFile"),
        defaultPath: opts?.defaultPath,
      })
      return handleWslPicker(result)
    },

    saveTextFileDialog(opts) {
      return window.api.saveTextFile({
        title: opts.title ?? t("desktop.dialog.saveFile"),
        defaultPath: opts.defaultPath,
        content: opts.content,
      })
    },

    openLink(url: string) {
      window.api.openLink(url)
    },
    openSystemBrowserLink(url: string) {
      window.api.openSystemBrowserLink(url)
    },
    openExternalWindow(url: string, opts?: { title?: string }) {
      return window.api.openExternalWindow(url, opts?.title).then(() => undefined)
    },
    openImagePreviewWindow(input) {
      return window.api.openImagePreviewWindow(input).then(() => undefined)
    },
    openLoginWindow: () => window.api.openLoginWindow(),
    async openPath(path: string, app?: string) {
      if (os === "windows") {
        const resolvedApp = app ? await window.api.resolveAppPath(app).catch(() => null) : null
        const resolvedPath = await (async () => {
          if (await isWslEnabled()) {
            const converted = await window.api.wslPath(path, "windows").catch(() => null)
            if (converted) return converted
          }
          return path
        })()
        return window.api.openPath(resolvedPath, resolvedApp ?? undefined)
      }
      return window.api.openPath(path, app)
    },

    async showItemInFolder(path: string) {
      if (os === "windows") {
        const resolvedPath = await (async () => {
          if (await isWslEnabled()) {
            const converted = await window.api.wslPath(path, "windows").catch(() => null)
            if (converted) return converted
          }
          return path
        })()
        return window.api.showItemInFolder(resolvedPath)
      }
      return window.api.showItemInFolder(path)
    },

    ensureDirectory: (dirPath: string) => window.api.ensureDirectory(dirPath),
    readLocalFile: (filePath: string) => window.api.readLocalFile(filePath),
    writeFile: (filePath: string, content: string, opts?: { overwrite?: boolean }) =>
      window.api.writeFile(filePath, content, opts),
    renameFile: (oldPath: string, newPath: string) => window.api.renameFile(oldPath, newPath),
    trashFile: (filePath: string) => window.api.trashFile(filePath),
    getBlankProjectDefaults: (opts) => window.api.getBlankProjectDefaults(opts),
    isBlankProjectPathTaken: async (opts) => {
      const convert = async (path?: string) => {
        if (!path || os !== "windows" || !(await isWslEnabled())) return path
        return window.api.wslPath(path, "windows").catch(() => path)
      }
      return window.api.checkBlankProjectExists({
        parent: await convert(opts.parent),
        name: opts.name,
      })
    },
    createBlankProject: async (opts) => {
      const convert = async (path?: string) => {
        if (!path || os !== "windows" || !(await isWslEnabled())) return path
        return window.api.wslPath(path, "windows").catch(() => path)
      }
      return window.api.createBlankProject({
        ...opts,
        parent: opts?.parent ? await convert(opts.parent) : opts?.parent,
      })
    },
    ensureScratchChatDir: () => window.api.ensureScratchChatDir(),
    ensureQuickChatDir: () => window.api.ensureQuickChatDir(),
    windowAction: (action) => window.api.windowAction(action),
    moveWindowForDrag: (input) => window.api.moveWindowForDrag(input),

    // Environment file management
    ensureEnvironmentsDir: () => window.api.ensureEnvironmentsDir(),
    listEnvironments: (worktree: string) => window.api.listEnvironments(worktree),
    readEnvironment: (worktree: string, filename: string) => window.api.readEnvironment(worktree, filename),
    writeEnvironment: (worktree: string, filename: string, content: string) =>
      window.api.writeEnvironment(worktree, filename, content),
    deleteEnvironment: (worktree: string, filename: string) =>
      window.api.deleteEnvironment(worktree, filename),

    back() {
      window.history.back()
    },

    forward() {
      window.history.forward()
    },

    storage,

    checkUpdate: async () => {
      const config = await window.api.getWindowConfig().catch(() => ({ updaterEnabled: false }))
      if (!config.updaterEnabled) return { updateAvailable: false }
      return window.api.checkUpdate()
    },

    getUpdateChannel: () => window.api.getUpdateChannel(),

    setUpdateChannel: (channel: string) => window.api.setUpdateChannel(channel),

    updateAndRestart: async () => {
      const config = await window.api.getWindowConfig().catch(() => ({ updaterEnabled: false }))
      if (!config.updaterEnabled) return
      await window.api.installUpdate()
    },

    restart: async () => {
      await window.api.killSidecar().catch(() => undefined)
      window.api.relaunch()
    },

    notify: async (title, description, href) => {
      const focused = await window.api.getWindowFocused().catch(() => document.hasFocus())
      if (focused) return
      window.api.showNotification(title, description, href)
    },

    fetch: (input, init) => {
      if (input instanceof Request) return fetch(input)
      return fetch(input, init)
    },

    issueReportHeartbeat: (snapshot) => window.api.issueReportHeartbeat(snapshot),
    issueReportDiagnostics: () => window.api.issueReportDiagnostics(),

    async captureWindowScreenshot() {
      const image = await window.api.captureWindowScreenshot().catch(() => null)
      if (!image) return null
      const blob = new Blob([image.buffer], { type: "image/png" })
      // 主窗口是透明 vibrancy + 侧栏 backdrop-filter，capturePage 抓不到 OS 背景，
      // 直接存会呈现「毛玻璃叠空」的灰蒙效果。合成到不透明主题基色去掉透明度。
      const flattened = await flattenScreenshotOverBackground(blob).catch(() => null)
      return new File([flattened ?? blob], `wanlaicode-window-${Date.now()}.png`, {
        type: "image/png",
      })
    },

    configureAppSnapshots: (config) => window.api.configureAppSnapshots(config),
    getAppSnapshotPermissions: () => window.api.getAppSnapshotPermissions(),
    requestAppSnapshotPermission: (permission) => window.api.requestAppSnapshotPermission(permission),
    captureAppSnapshot: () => window.api.captureAppSnapshot(),
    onAppSnapshot: (cb) => window.api.onAppSnapshot(cb),

    getWslEnabled: () => isWslEnabled(),

    setWslEnabled: async (enabled) => {
      await window.api.setWslConfig({ enabled })
    },

    getDefaultServer: async () => {
      const url = await window.api.getDefaultServerUrl().catch(() => null)
      if (!url) return null
      return ServerConnection.Key.make(url)
    },

    setDefaultServer: async (url: string | null) => {
      await window.api.setDefaultServerUrl(url)
    },

    parseMarkdown: (markdown: string) => window.api.parseMarkdownCommand(markdown),

    webviewZoom,

    checkAppExists: async (appName: string) => {
      return window.api.checkAppExists(appName)
    },

    getAppIcon: async (appName: string) => {
      return window.api.getAppIcon(appName)
    },

    listInstalledOpeners: () => window.api.listInstalledOpeners(),

    invokeOpener: (opener, path) => window.api.invokeOpener(opener, path),

    async readClipboardImage() {
      const image = await window.api.readClipboardImage().catch(() => null)
      if (!image) return null
      const blob = new Blob([image.buffer], { type: "image/png" })
      return new File([blob], `pasted-image-${Date.now()}.png`, {
        type: "image/png",
      })
    },

    getPathForFile: (file: File) => window.api.getPathForFile(file),
    readFileAsDataURL: (path: string, mime: string) => window.api.readFileAsDataURL(path, mime),
  }
}

let menuTrigger = null as null | ((id: string) => void)
let trayNavigate = null as null | ((target: { sessionID: string; slug: string }) => void)
window.api.onMenuCommand((id) => {
  menuTrigger?.(id)
})
window.api.onTrayNavigate((target) => {
  trayNavigate?.(target)
})
window.api.onNotificationClick((href) => handleNotificationClick(href))
listenForDeepLinks()

const desktopInitialRoute = () => desktopRouteFromLocation(location.pathname, location.search, location.hash)

function DesktopRouter(props: BaseRouterProps) {
  const history = createMemoryHistory()
  const initial = desktopInitialRoute()
  // 桌面端使用 MemoryRouter；初始化时从真实地址恢复深链，避免刷新会话后回到项目列表。
  if (initial !== "/") history.set({ value: initial, replace: true, scroll: false })
  // MemoryRouter 默认只保存内存状态；同步每次导航到真实地址，确保 Electron 刷新后能恢复当前会话。
  const syncAddress = (route: string) => {
    const target = desktopAddressForRoute(route, location.pathname)
    const current = `${location.pathname}${location.search}${location.hash}`
    if (current === target) return
    window.history.replaceState(null, "", target)
  }
  syncAddress(history.get())
  history.listen(syncAddress)
  return <MemoryRouter {...props} history={history} />
}

const setWindowFocusState = (focused: boolean) => {
  document.documentElement.dataset.windowFocused = focused ? "true" : "false"
}

const setWindowMaximizedState = (maximized: boolean) => {
  document.documentElement.dataset.windowMaximized = maximized ? "true" : "false"
}

const syncWindowFocusState = () => {
  setWindowFocusState(document.hasFocus())
  void window.api.getWindowFocused().then(setWindowFocusState).catch(() => undefined)
}

const syncWindowMaximizedState = () => {
  if (detectDesktopOs() !== "windows") return
  void window.api.getWindowMaximized().then(setWindowMaximizedState).catch(() => undefined)
}

const wireWindowMaximizedState = () => {
  if (detectDesktopOs() !== "windows") return
  syncWindowMaximizedState()
  return window.api.onWindowMaximized(setWindowMaximizedState)
}

syncWindowFocusState()
window.addEventListener("focus", () => setWindowFocusState(true))
window.addEventListener("blur", () => setWindowFocusState(false))
syncWindowMaximizedState()

render(() => {
  const platform = createPlatform()
  const [windowConfig] = createResource(() => window.api.getWindowConfig().catch(() => ({ updaterEnabled: false })))
  const loadLocale = async () => {
    const current = await platform.storage?.("opencode.global.dat").getItem("language")
    const legacy = current ? undefined : await platform.storage?.().getItem("language.v1")
    const raw = current ?? legacy
    if (!raw) return
    const locale = raw.match(/"locale"\s*:\s*"([^"]+)"/)?.[1]
    if (!locale) return
    const next = normalizeLocale(locale)
    if (next !== "en") await loadLocaleDict(next)
    return next satisfies Locale
  }

  const [windowCount] = createResource(() => window.api.getWindowCount())

  // Fetch sidecar credentials (available immediately, before health check)
  const [sidecar] = createResource(() => window.api.awaitInitialization(() => undefined))

  const [defaultServer] = createResource(() =>
    platform.getDefaultServer?.().then((url) => {
      if (url) return ServerConnection.key({ type: "http", http: { url } })
    }),
  )
  const [locale] = createResource(loadLocale)

  const servers = () => {
    const data = sidecar()
    if (!data) return []
    const server: ServerConnection.Sidecar = {
      displayName: "Local Server",
      type: "sidecar",
      variant: "base",
      http: {
        url: data.url,
        username: data.username ?? undefined,
        password: data.password ?? undefined,
      },
    }
    return [server] as ServerConnection.Any[]
  }

  function handleClick(e: MouseEvent) {
    const link = (e.target as HTMLElement).closest("a.external-link") as HTMLAnchorElement | null
    if (link?.href) {
      e.preventDefault()
      platform.openLink(link.href)
    }
  }

  function Inner() {
    const cmd = useCommand()
    const navigate = useNavigate()
    menuTrigger = (id) => cmd.trigger(id)
    trayNavigate = (target) => {
      navigate(`/${target.slug}/session/${target.sessionID}`)
    }

    const theme = useTheme()
    const language = useLanguage()

    createEffect(() => {
      void window.api.setTrayLocale(language.locale())
    })

    createEffect(() => {
      theme.themeId()
      theme.mode()
      const backdrop = windowsBackdrop()
      const root = document.documentElement
      if (root.dataset.desktopOs === "windows" && backdrop) root.dataset.windowsBackdrop = backdrop
      // wanlai-theme 等 backdrop 探测完成后再写窗口底色，避免先灌实色盖住 Mica。
      if (root.dataset.desktopOs === "windows" && root.dataset.theme === "wanlai-theme") {
        if (backdrop === undefined) return
        if (backdrop === "mica") {
          void window.api.setBackgroundColor("#00000000")
          return
        }
      }
      const names =
        root.dataset.desktopOs === "windows"
          ? ["--windows-statusbar-bg", "--background-base"]
          : ["--background-base"]
      const style = getComputedStyle(root)
      const bg = names
        .map((name) => style.getPropertyValue(name).trim())
        .find((value) => value && !value.startsWith("var("))
      if (bg) void window.api.setBackgroundColor(bg)
    })

    return null
  }

  onMount(() => {
    document.addEventListener("click", handleClick)
    clearStartupCover()
    const offWindowMaximized = wireWindowMaximizedState()
    onCleanup(() => {
      document.removeEventListener("click", handleClick)
      offWindowMaximized?.()
    })
  })

  return (
    <PlatformProvider value={platform}>
      <AppBaseProviders locale={locale.latest}>
        <Show
          when={
            !defaultServer.loading &&
            !sidecar.loading &&
            !windowConfig.loading &&
            !windowCount.loading &&
            !locale.loading
          }
        >
          {(_) => {
            return (
              <AppInterface
                defaultServer={defaultServer.latest ?? ServerConnection.Key.make("sidecar")}
                servers={servers()}
                skipStartupHealthGate
                router={DesktopRouter}
              >
                <Inner />
              </AppInterface>
            )
          }}
        </Show>
      </AppBaseProviders>
    </PlatformProvider>
  )
}, root!)
