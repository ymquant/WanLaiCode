import windowState from "electron-window-state"
import { app, BrowserWindow, net, nativeImage, nativeTheme, protocol, screen } from "electron"
import { release } from "node:os"
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { brandNameCn } from "@opencode-ai/brand"
import type { TitlebarTheme, WindowsBackdrop } from "../preload/types"
import { CHANNEL } from "./constants"
import { iconPath, iconsDir } from "./icons"
import { isWindowTrayHidden, wireCloseToTray } from "./tray"
import { resolveTitlebarWindowBackground, useGlassTitlebar } from "./titlebar-glass"

const TRANSPARENT_BG = "#00000000"

// 标题在每次窗口创建时按当前 brand 现算。CHANNEL 后缀（Dev / Beta）保留以区分本地多版本同装。
const WINDOW_TITLE: Record<typeof CHANNEL, string> = {
  dev: `${brandNameCn()} Dev`,
  beta: `${brandNameCn()} Beta`,
  prod: brandNameCn(),
  canary: brandNameCn(),
}

const root = dirname(fileURLToPath(import.meta.url))
const rendererRoot = join(root, "../renderer")
const rendererProtocol = "oc"
const rendererHost = "renderer"

protocol.registerSchemesAsPrivileged([
  {
    scheme: rendererProtocol,
    privileges: {
      secure: true,
      standard: true,
      supportFetchAPI: true,
    },
  },
])

let backgroundColor: string | undefined
const titlebarThemes = new WeakMap<BrowserWindow, Partial<TitlebarTheme>>()
// 与渲染端 WindowsTitlebar 的 h-9 对齐
const titlebarHeight = 36
const devtoolsEnabled = !app.isPackaged || process.env.WANLAICODE_ENABLE_DEVTOOLS === "1"
const openDevtoolsOnLoad = devtoolsEnabled && process.env.WANLAICODE_OPEN_DEVTOOLS === "1"

export function setBackgroundColor(color: string) {
  backgroundColor = color
  if (process.platform !== "win32") return
  // Windows 的 Mica 需要运行期实色兜底；macOS 主窗口依赖透明 vibrancy，
  // 不能把渲染端主题色灌回 BrowserWindow，否则侧栏毛玻璃会被实色盖住。
  for (const win of BrowserWindow.getAllWindows()) {
    win.setBackgroundColor(color)
  }
}

export function getBackgroundColor(): string | undefined {
  return backgroundColor
}

/** 与 Codex 一致：有系统 backdrop 时用 Mica；Win10 / RDP / 不支持时回退实色。 */
export function windowsBackdrop(): WindowsBackdrop {
  if (process.platform !== "win32") return "none"
  const check = (
    BrowserWindow as typeof BrowserWindow & { isSystemBackdropSupported?: () => boolean }
  ).isSystemBackdropSupported
  if (typeof check === "function") return check.call(BrowserWindow) ? "mica" : "none"
  const build = Number(release().split(".")[2] ?? 0)
  return Number.isFinite(build) && build >= 22000 ? "mica" : "none"
}

function tone() {
  return nativeTheme.shouldUseDarkColors ? "dark" : "light"
}

function windowsSolidFallback(mode: "dark" | "light") {
  // 与 Codex 默认 chrome surface-under 对齐（深 #141414 / 浅主题色兜底）。
  return backgroundColor ?? (mode === "dark" ? "#141414" : "#F8F7F7")
}

function titlebarUsesGlass(theme: Partial<TitlebarTheme> = {}) {
  return useGlassTitlebar(theme, windowsBackdrop())
}

function wireDevShortcuts(win: BrowserWindow) {
  if (!devtoolsEnabled) return
  win.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return
    if (
      input.key === "F12" ||
      ((input.control || input.meta) && input.shift && input.key.toLowerCase() === "i") ||
      (process.platform === "darwin" && input.meta && input.alt && input.key.toLowerCase() === "i")
    ) {
      event.preventDefault()
      win.webContents.toggleDevTools()
      return
    }
    if (input.key !== "F5") return
    event.preventDefault()
    win.webContents.reload()
  })
  if (!openDevtoolsOnLoad) return
  win.webContents.once("did-finish-load", () => win.webContents.openDevTools({ mode: "detach" }))
}

function overlay(theme: Partial<TitlebarTheme> = {}, zoom = 1) {
  const mode = theme.mode ?? tone()
  const glass = titlebarUsesGlass(theme)
  return {
    // Codex：玻璃态 titleBarOverlay.color 必须是透明，否则 Mica 被实色盖住。
    color: glass ? TRANSPARENT_BG : (theme.backgroundColor ?? TRANSPARENT_BG),
    symbolColor: theme.symbolColor ?? (mode === "dark" ? "white" : "black"),
    height: Math.max(titlebarHeight, Math.round(titlebarHeight * zoom)),
  }
}

export function setTitlebar(win: BrowserWindow, theme: Partial<TitlebarTheme> = {}) {
  if (theme.source !== undefined) {
    nativeTheme.themeSource = theme.source
  }
  titlebarThemes.set(win, theme)
  updateTitlebar(win)
  // 仅 glass=true + Mica 时保持透明底；渲染端已保证 wanlai glass 不随 dialog 翻转，故侧栏不会因底色突变闪烁。
  const nextBg = resolveTitlebarWindowBackground(theme, windowsBackdrop(), TRANSPARENT_BG)
  if (nextBg !== undefined) setBackgroundColor(nextBg)
}

export function updateTitlebar(win: BrowserWindow) {
  if (process.platform !== "win32") return
  win.setTitleBarOverlay(overlay(titlebarThemes.get(win), win.webContents.getZoomFactor()))
}

export function setDockIcon() {
  if (process.platform !== "darwin") return
  const icon = nativeImage.createFromPath(join(iconsDir(), "dock.png"))
  if (!icon.isEmpty()) app.dock?.setIcon(icon)
}

export function mainWindowOptions(
  mode: "dark" | "light" = tone(),
  state: { x?: number; y?: number; width?: number; height?: number; minWidth?: number; minHeight?: number } = {},
) {
  return {
    x: state.x,
    y: state.y,
    width: state.width ?? 1280,
    height: state.height ?? 800,
    minWidth: state.minWidth,
    minHeight: state.minHeight,
    show: false,
    title: WINDOW_TITLE[CHANNEL],
    icon: iconPath(),
    backgroundColor,
    ...(process.platform === "darwin"
      ? {
        // 1:1 复刻 Codex：hiddenInset + 默认 traffic light 位置 (12, 14)
        backgroundColor: "#00000000",
        titleBarStyle: "hiddenInset" as const,
        trafficLightPosition: { x: 12, y: 14 },
        vibrancy: "menu" as const,
      }
      : {}),
    ...(process.platform === "win32"
      ? (() => {
        const backdrop = windowsBackdrop()
        return {
          // 与 Codex 一致：有系统 backdrop 时用透明底 + Mica；不支持时退化为主题实色。
          backgroundColor: backdrop === "mica" ? TRANSPARENT_BG : windowsSolidFallback(mode),
          frame: false,
          roundedCorners: true,
          titleBarStyle: "hidden" as const,
          titleBarOverlay: overlay({ mode }),
          ...(backdrop === "mica" ? { backgroundMaterial: "mica" as const } : {}),
        }
      })()
      : {}),
    webPreferences: {
      preload: join(root, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  } satisfies Electron.BrowserWindowConstructorOptions
}

export function createMainWindow(html = "index.html", opts: { showOnReady?: boolean } = {}) {
  const state = windowState({
    defaultWidth: 1280,
    defaultHeight: 800,
  })

  // 钳制最小尺寸到当前可用工作区，避免小屏/低分辨率下窗口无法缩到屏内
  const targetDisplay =
    state.x !== undefined && state.y !== undefined
      ? screen.getDisplayMatching({ x: state.x, y: state.y, width: state.width, height: state.height })
      : screen.getPrimaryDisplay()

  const win = new BrowserWindow(mainWindowOptions(tone(), {
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    minWidth: Math.min(480, targetDisplay.workArea.width),
    minHeight: Math.min(600, targetDisplay.workArea.height),
  }))

  state.manage(win)
  loadWindow(win, html)
  wireZoom(win)
  wireMinimumSize(win)
  wireWindowMaximized(win)
  wireDevShortcuts(win)

  wireCloseToTray(win)

  if (opts.showOnReady !== false) {
    win.once("ready-to-show", () => {
      if (!isWindowTrayHidden(win)) win.show()
    })
  }

  return win
}

function wireWindowMaximized(win: BrowserWindow) {
  if (process.platform !== "win32") return
  const send = () => win.webContents.send("window-maximized", win.isMaximized())
  win.on("maximize", send)
  win.on("unmaximize", send)
  win.webContents.on("did-finish-load", send)
}

// 窗口跨屏后，按所在屏 workArea 重新钳制最小尺寸
function wireMinimumSize(win: BrowserWindow) {
  const apply = () => {
    const [x, y] = win.getPosition()
    const [w, h] = win.getSize()
    const display = screen.getDisplayMatching({ x, y, width: w, height: h })
    win.setMinimumSize(
      Math.min(480, display.workArea.width),
      Math.min(600, display.workArea.height),
    )
  }
  win.on("moved", apply)
  screen.on("display-metrics-changed", apply)
  win.on("closed", () => screen.off("display-metrics-changed", apply))
}

export const LOGIN_WINDOW_REFERENCE_SIZE = {
  width: 1024,
  height: 680,
} as const

export const LOGIN_WINDOW_ASPECT_RATIO = LOGIN_WINDOW_REFERENCE_SIZE.width / LOGIN_WINDOW_REFERENCE_SIZE.height

export function loginWindowOptions(mode: "dark" | "light" = tone(), opts?: { resizable?: boolean; lockAspectRatio?: boolean }) {
  const resizable = opts?.resizable ?? false
  const minWidth = 758
  const minHeight = resizable && opts?.lockAspectRatio ? 503 : 558
  return {
    width: LOGIN_WINDOW_REFERENCE_SIZE.width,
    height: LOGIN_WINDOW_REFERENCE_SIZE.height,
    minWidth,
    minHeight,
    resizable,
    maximizable: false,
    minimizable: true,
    fullscreenable: false,
    center: true,
    show: false,
    title: WINDOW_TITLE[CHANNEL],
    icon: iconPath(),
    backgroundColor: "#FFFFFF",
    ...(opts?.lockAspectRatio ? { useContentSize: true } : {}),
    ...(process.platform === "darwin"
      ? {
        titleBarStyle: "hiddenInset" as const,
        trafficLightPosition: { x: 12, y: 14 },
      }
      : {}),
    ...(process.platform === "win32"
      ? {
        frame: false,
        titleBarStyle: "hidden" as const,
        titleBarOverlay: overlay({ mode }),
      }
      : {}),
    webPreferences: {
      preload: join(root, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  } satisfies Electron.BrowserWindowConstructorOptions
}

export function loginWindowHtml() {
  return "login.html"
}

export function createLoginWindow() {
  const win = new BrowserWindow(loginWindowOptions())
  loadWindow(win, loginWindowHtml())
  wireZoom(win)
  wireDevShortcuts(win)

  if (process.platform !== "darwin") {
    win.setMenuBarVisibility(false)
  }
  if (typeof win.setAspectRatio === "function") {
    win.setAspectRatio(LOGIN_WINDOW_ASPECT_RATIO)
  }

  win.once("ready-to-show", () => {
    win.show()
  })

  return win
}

export function createUpdateProgressWindow(parent?: BrowserWindow | null) {
  const win = new BrowserWindow({
    width: 480,
    height: 200,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    center: true,
    show: false,
    title: WINDOW_TITLE[CHANNEL],
    icon: iconPath(),
    backgroundColor,
    parent: parent ?? undefined,
    // 进度窗本身不需要原生 chrome：macOS 屏蔽 traffic lights，Windows / Linux 也整体 frameless。
    // 用户用 Cancel / Close 按钮关窗，安装成功路径自动关闭。
    frame: false,
    webPreferences: {
      preload: join(root, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  if (process.platform !== "darwin") {
    win.setMenuBarVisibility(false)
  }

  loadWindow(win, "update-progress.html")
  wireDevShortcuts(win)

  win.once("ready-to-show", () => {
    win.show()
    win.focus()
  })

  return win
}

export function createUninstallFeedbackWindow() {
  const win = new BrowserWindow({
    width: 520,
    height: 560,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    center: true,
    show: false,
    title: WINDOW_TITLE[CHANNEL],
    icon: iconPath(),
    backgroundColor,
    frame: false,
    webPreferences: {
      preload: join(root, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  if (process.platform !== "darwin") {
    win.setMenuBarVisibility(false)
  }

  loadWindow(win, "uninstall-feedback.html")
  wireDevShortcuts(win)

  win.once("ready-to-show", () => {
    win.show()
    win.focus()
  })

  return win
}

export function createImagePreviewWindow(id: string, title?: string) {
  const win = new BrowserWindow({
    width: 1000,
    height: 720,
    minWidth: 360,
    minHeight: 320,
    center: true,
    show: false,
    title: title ?? WINDOW_TITLE[CHANNEL],
    icon: iconPath(),
    backgroundColor,
    webPreferences: {
      preload: join(root, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  if (process.platform !== "darwin") {
    win.setMenuBarVisibility(false)
  }

  loadWindow(win, `image-preview.html?id=${encodeURIComponent(id)}`)
  wireDevShortcuts(win)

  win.once("ready-to-show", () => {
    win.show()
    win.focus()
  })

  return win
}

export function createLoadingWindow() {
  const mode = tone()
  const win = new BrowserWindow({
    width: 640,
    height: 480,
    resizable: false,
    center: true,
    show: true,
    icon: iconPath(),
    backgroundColor: process.platform === "win32" ? backgroundColor ?? (mode === "dark" ? "#181818" : "#ffffff") : backgroundColor,
    ...(process.platform === "darwin" ? { titleBarStyle: "hiddenInset" as const } : {}),
    ...(process.platform === "win32"
      ? {
        frame: false,
        titleBarStyle: "hidden" as const,
        titleBarOverlay: overlay({ mode }),
      }
      : {}),
    webPreferences: {
      preload: join(root, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  loadWindow(win, "loading.html")
  wireDevShortcuts(win)

  return win
}

let rendererProtocolRegistered = false

/**
 * 将 oc 协议请求映射到 renderer 文件；无扩展名的路径属于 MemoryRouter 深链，统一回退入口页。
 */
export function rendererPathForRequest(pathname: string, root: string) {
  let decodedPathname: string
  try {
    decodedPathname = decodeURIComponent(pathname)
  } catch {
    return undefined
  }
  if (decodedPathname === "/") decodedPathname = "/index.html"

  const filePath = resolve(root, `.${decodedPathname}`)
  const relativePath = relative(root, filePath)
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) return undefined
  if (decodedPathname !== "/index.html" && !extname(decodedPathname)) return join(root, "index.html")
  return filePath
}

export function registerRendererProtocol() {
  // 幂等:oc 协议的 handler 进程内只需注册一次。正常启动经 setupApp 注册,
  // 卸载反馈这条最小路径也会自行注册(见 index.ts runUninstallFeedbackMode),
  // 守卫确保任一/多条启动路径调用都安全,不会触发「协议已注册」抛错。
  if (rendererProtocolRegistered) return
  rendererProtocolRegistered = true
  protocol.handle(rendererProtocol, async request => {
    const url = new URL(request.url)
    const host = url.hostname
    if (host !== rendererHost) {
      return new Response("Not found", { status: 404 })
    }

    const filePath = rendererPathForRequest(url.pathname, rendererRoot)
    if (!filePath) {
      return new Response("Not found", { status: 404 })
    }

    return net.fetch(pathToFileURL(filePath).toString())
  })
}

export function loadWindow(win: BrowserWindow, html = "index.html") {
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    return win.loadURL(new URL(html, devUrl).toString())
  }

  return win.loadURL(`${rendererProtocol}://${rendererHost}/${html}`)
}

function wireZoom(win: BrowserWindow) {
  const apply = () => {
    updateTitlebar(win)
  }

  const reset = () => {
    win.webContents.setZoomFactor(1)
    apply()
  }

  app.once("browser-window-created", (_, createdWindow) => {
    if (createdWindow === win) reset()
  })

  win.webContents.on("zoom-changed", (_event, direction) => {
    const current = win.webContents.getZoomFactor()
    const next = direction === "in" ? current + 0.1 : current - 0.1
    win.webContents.setZoomFactor(Math.max(0.25, Math.min(next, 3)))
    apply()
  })

  win.webContents.on("did-finish-load", reset)
}
