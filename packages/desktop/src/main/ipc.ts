import { execFile } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import { dirname, extname, join, normalize } from "node:path"
import { fileURLToPath } from "node:url"
import os from "node:os"
import { BrowserWindow, Notification, WebContentsView, app, clipboard, dialog, ipcMain, nativeTheme, shell } from "electron"
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron"
import { brandNameEn } from "@opencode-ai/brand"

import {
  blankProjectParent,
  blankProjectPathExists,
  BLANK_PROJECT_DEFAULT_BASE,
  nextBlankProjectFolderName,
  resolveBlankProjectTarget,
} from "./blank-project"
import {
  assertHttpExternalUrl,
  assertSystemBrowserUrl,
  assertLocalPath,
  assertUserDirectoryPath,
  environmentsRoot,
  tryResolveEnvironmentFilePathFromWorktree,
  tryResolveEnvironmentProjectDirFromWorktree,
} from "./environment-files"

import type {
  IssueReportDesktopDiagnostics,
  AppSnapshotConfig,
  AppSnapshotPermission,
  AppSnapshotPermissionState,
  InitStep,
  ServerReadyData,
  SqliteMigrationProgress,
  IssueReportScreenshot,
  TitlebarTheme,
  UpdateProgress,
  WindowDragMoveInput,
  WindowConfig,
  WslConfig,
} from "../preload/types"
import { buildOpenCommand, isKnownOpenerApp, resolveOpenPathApp, type InstalledOpener } from "./openers"
import { getStore } from "./store"
import { consumeImagePreviewPayload, stashImagePreviewPayload } from "./image-preview-payload"
import { createImagePreviewWindow, setTitlebar, updateTitlebar } from "./windows"
import { tail as tailBackendLog } from "./logging"

const pickerFilters = (ext?: string[]) => {
  if (!ext || ext.length === 0) return undefined
  return [{ name: "Files", extensions: ext }]
}

type Deps = {
  killSidecar: () => void
  awaitInitialization: (sendStep: (step: InitStep) => void) => Promise<ServerReadyData>
  getWindowConfig: () => Promise<WindowConfig> | WindowConfig
  consumeInitialDeepLinks: () => Promise<string[]> | string[]
  getDefaultServerUrl: () => Promise<string | null> | string | null
  setDefaultServerUrl: (url: string | null) => Promise<void> | void
  getWslConfig: () => Promise<WslConfig>
  setWslConfig: (config: WslConfig) => Promise<void> | void
  parseMarkdown: (markdown: string) => Promise<string> | string
  checkAppExists: (appName: string) => Promise<boolean> | boolean
  getAppIcon: (appName: string) => Promise<string | null>
  listInstalledOpeners: () => Promise<InstalledOpener[]>
  wslPath: (path: string, mode: "windows" | "linux" | null) => Promise<string>
  resolveAppPath: (appName: string) => Promise<string | null>
  loadingWindowComplete: () => void
  runUpdater: (alertOnFail: boolean) => Promise<void> | void
  checkUpdate: () => Promise<{ updateAvailable: boolean; version?: string }>
  installUpdate: () => Promise<void> | void
  confirmInstall: () => Promise<void> | void
  cancelUpdate: () => Promise<void> | void
  closeUpdateWindow: () => void
  getUpdateChannel: () => "prod" | "canary"
  setUpdateChannel: (channel: "prod" | "canary") => void
  setBackgroundColor: (color: string) => void
  openMainWindow: () => void
  openLoginWindow: () => void
  newWindow: () => void
  getMainWindow: () => BrowserWindow | null
  setTrayLocale: (locale: string) => void
  relaunch: () => void
  configureAppSnapshots: (config: AppSnapshotConfig) => Promise<AppSnapshotPermissionState>
  getAppSnapshotPermissions: () => Promise<AppSnapshotPermissionState>
  requestAppSnapshotPermission: (permission: AppSnapshotPermission) => Promise<AppSnapshotPermissionState>
  captureAppSnapshot: () => Promise<boolean>
}

type WebContentsViewEntry = {
  favicon: string
  view: WebContentsView
  owner: Electron.WebContents
}

type BrowserViewState = {
  canGoBack: boolean
  canGoForward: boolean
  favicon: string
  isLoading: boolean
  title: string
  url: string
}

const browserViews = new Map<string, WebContentsViewEntry>()
const mainProcessIssues: Array<Record<string, unknown>> = []
let lastIssueReportHeartbeat: Record<string, unknown> | undefined
const issueReportStateFile = "issue-report-diagnostics.json"
const maxLocalFilePreviewBytes = 20 * 1024 * 1024
let nativeThemeModeBridgeRegistered = false

function nativeThemeMode() {
  return nativeTheme.shouldUseDarkColors ? "dark" : "light"
}

function registerNativeThemeModeBridge() {
  if (nativeThemeModeBridgeRegistered) return
  nativeThemeModeBridgeRegistered = true
  // renderer 的 prefers-color-scheme 在 Electron nativeTheme 切回 system 时可能不同步；
  // 主进程以 nativeTheme 为准广播，保证“系统”配色能跟随 macOS 深浅变化。
  nativeTheme.on("updated", () => {
    const mode = nativeThemeMode()
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send("native-theme-mode", mode)
    }
  })
}

function issueReportStatePath() {
  try {
    return join(app.getPath("userData"), issueReportStateFile)
  } catch {
    return undefined
  }
}

function writeIssueReportState() {
  const file = issueReportStatePath()
  if (!file) return
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(
      file,
      JSON.stringify(
        {
          schema_version: 1,
          updated_at: new Date().toISOString(),
          last_heartbeat: lastIssueReportHeartbeat,
          main_process_issues: mainProcessIssues,
        },
        null,
        2,
      ),
    )
  } catch {
    // Diagnostics persistence must never interfere with the app itself.
  }
}

export function recordMainProcessIssue(name: string, error: unknown, data?: Record<string, unknown>) {
  const issue = {
    at: Date.now(),
    name,
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
    data,
  }
  mainProcessIssues.push(issue)
  if (mainProcessIssues.length > 40) mainProcessIssues.splice(0, mainProcessIssues.length - 40)
  writeIssueReportState()
}

function issueReportDiagnostics(event: IpcMainInvokeEvent): IssueReportDesktopDiagnostics {
  const win = BrowserWindow.fromWebContents(event.sender)
  return {
    app: {
      version: app.getVersion(),
      packaged: app.isPackaged,
      platform: process.platform,
      arch: process.arch,
      pid: process.pid,
    },
    window: win
      ? {
          focused: win.isFocused(),
          visible: win.isVisible(),
          title: win.getTitle(),
          bounds: win.getBounds(),
        }
      : undefined,
    renderer: {
      process_id: typeof event.sender.getOSProcessId === "function" ? event.sender.getOSProcessId() : undefined,
      url: event.sender.getURL(),
      title: event.sender.getTitle(),
      zoom_factor: event.sender.getZoomFactor(),
    },
    process_metrics: app.getAppMetrics().map((metric) => ({
      pid: metric.pid,
      type: metric.type,
      cpu: metric.cpu,
      memory: metric.memory,
    })),
    backend_log_tail: tailBackendLog() || undefined,
    last_heartbeat: lastIssueReportHeartbeat,
    main_process_issues: [...mainProcessIssues],
  }
}

function cleanupBrowserView(tabId: string) {
  const entry = browserViews.get(tabId)
  if (!entry) return
  entry.view.setVisible(false)
  const win = BrowserWindow.fromWebContents(entry.owner)
  if (win) {
    try { win.contentView.removeChildView(entry.view) } catch { }
  }
  try { entry.view.webContents.close() } catch { }
  browserViews.delete(tabId)
}

function isAllowedBrowserViewUrl(input: string) {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    return false
  }
  if (url.protocol === "https:" || url.protocol === "http:") return true
  if (url.protocol !== "file:") return false
  const ext = extname(fileURLToPath(url)).toLowerCase()
  return ext === ".html" || ext === ".htm"
}

function browserViewCanGoBack(webContents: Electron.WebContents) {
  return webContents.navigationHistory?.canGoBack() ?? webContents.canGoBack()
}

function browserViewCanGoForward(webContents: Electron.WebContents) {
  return webContents.navigationHistory?.canGoForward() ?? webContents.canGoForward()
}

export function registerIpcHandlers(deps: Deps) {
  registerNativeThemeModeBridge()
  const notifications = new Set<Notification>()

  ipcMain.handle("kill-sidecar", () => deps.killSidecar())
  ipcMain.handle("await-initialization", (event: IpcMainInvokeEvent) => {
    const send = (step: InitStep) => event.sender.send("init-step", step)
    return deps.awaitInitialization(send)
  })
  ipcMain.handle("get-window-config", () => deps.getWindowConfig())
  ipcMain.handle("consume-initial-deep-links", () => deps.consumeInitialDeepLinks())
  ipcMain.handle("get-default-server-url", () => deps.getDefaultServerUrl())
  ipcMain.handle("set-default-server-url", (_event: IpcMainInvokeEvent, url: string | null) =>
    deps.setDefaultServerUrl(url === null ? null : assertHttpExternalUrl(url)),
  )
  ipcMain.handle("get-wsl-config", () => deps.getWslConfig())
  ipcMain.handle("set-wsl-config", (_event: IpcMainInvokeEvent, config: WslConfig) => deps.setWslConfig(config))
  ipcMain.handle("parse-markdown", (_event: IpcMainInvokeEvent, markdown: string) => deps.parseMarkdown(markdown))
  ipcMain.handle("check-app-exists", (_event: IpcMainInvokeEvent, appName: string) => deps.checkAppExists(appName))
  ipcMain.handle("get-app-icon", (_event: IpcMainInvokeEvent, appName: string) => deps.getAppIcon(appName))
  ipcMain.handle("list-installed-openers", () => deps.listInstalledOpeners())
  ipcMain.handle("wsl-path", (_event: IpcMainInvokeEvent, path: string, mode: "windows" | "linux" | null) =>
    deps.wslPath(path, mode),
  )
  ipcMain.handle("resolve-app-path", (_event: IpcMainInvokeEvent, appName: string) => deps.resolveAppPath(appName))
  ipcMain.on("loading-window-complete", () => deps.loadingWindowComplete())
  ipcMain.handle("run-updater", (_event: IpcMainInvokeEvent, alertOnFail: boolean) => deps.runUpdater(alertOnFail))
  ipcMain.handle("check-update", () => deps.checkUpdate())
  ipcMain.handle("install-update", () => deps.installUpdate())
  ipcMain.handle("confirm-install", () => deps.confirmInstall())
  ipcMain.handle("cancel-update", () => deps.cancelUpdate())
  ipcMain.handle("close-update-window", () => deps.closeUpdateWindow())
  ipcMain.handle("get-update-channel", () => deps.getUpdateChannel())
  ipcMain.handle("set-update-channel", (_event: IpcMainInvokeEvent, channel: string) => {
    const next: "prod" | "canary" = channel === "canary" ? "canary" : "prod"
    deps.setUpdateChannel(next)
    return next
  })
  ipcMain.handle("set-background-color", (_event: IpcMainInvokeEvent, color: string) => deps.setBackgroundColor(color))
  // 不返回 BrowserWindow 对象，否则 invoke 回传时会触发「An object could not be cloned」；显式 return true 让前端能拿到布尔成功状态
  ipcMain.handle("open-main-window", () => {
    deps.openMainWindow()
    return true
  })
  ipcMain.handle("open-login-window", () => {
    deps.openLoginWindow()
    return true
  })
  ipcMain.handle("store-get", (_event: IpcMainInvokeEvent, name: string, key: string) => {
    try {
      const store = getStore(name)
      const value = store.get(key)
      if (value === undefined || value === null) return null
      return typeof value === "string" ? value : JSON.stringify(value)
    } catch {
      return null
    }
  })
  ipcMain.handle("store-set", (_event: IpcMainInvokeEvent, name: string, key: string, value: string) => {
    getStore(name).set(key, value)
  })
  ipcMain.handle("store-delete", (_event: IpcMainInvokeEvent, name: string, key: string) => {
    getStore(name).delete(key)
  })
  ipcMain.handle("store-clear", (_event: IpcMainInvokeEvent, name: string) => {
    getStore(name).clear()
  })
  ipcMain.handle("store-keys", (_event: IpcMainInvokeEvent, name: string) => {
    const store = getStore(name)
    return Object.keys(store.store)
  })
  ipcMain.handle("store-length", (_event: IpcMainInvokeEvent, name: string) => {
    const store = getStore(name)
    return Object.keys(store.store).length
  })

  ipcMain.handle("set-tray-locale", (_event: IpcMainInvokeEvent, locale: string) => {
    deps.setTrayLocale(locale)
  })

  ipcMain.handle("issue-report-heartbeat", (event: IpcMainInvokeEvent, snapshot: Record<string, unknown>) => {
    lastIssueReportHeartbeat = {
      at: Date.now(),
      snapshot,
    }
    writeIssueReportState()
    return issueReportDiagnostics(event)
  })

  ipcMain.handle("issue-report-diagnostics", (event: IpcMainInvokeEvent) => issueReportDiagnostics(event))

  ipcMain.handle("capture-window-screenshot", async (event: IpcMainInvokeEvent): Promise<IssueReportScreenshot | null> => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return null
    const image = await win.capturePage()
    const size = image.getSize()
    const png = image.toPNG()
    const buffer = new Uint8Array(png.byteLength)
    buffer.set(png)
    return {
      buffer: buffer.buffer,
      width: size.width,
      height: size.height,
    }
  })

  ipcMain.handle("configure-app-snapshots", (_event: IpcMainInvokeEvent, config: AppSnapshotConfig) =>
    deps.configureAppSnapshots(config),
  )
  ipcMain.handle("get-app-snapshot-permissions", () => deps.getAppSnapshotPermissions())
  ipcMain.handle("request-app-snapshot-permission", (_event: IpcMainInvokeEvent, permission: AppSnapshotPermission) =>
    deps.requestAppSnapshotPermission(permission),
  )
  ipcMain.handle("capture-app-snapshot", () => deps.captureAppSnapshot())

  ipcMain.handle(
    "open-directory-picker",
    async (_event: IpcMainInvokeEvent, opts?: { multiple?: boolean; title?: string; defaultPath?: string }) => {
      const result = await dialog.showOpenDialog({
        properties: ["openDirectory", ...(opts?.multiple ? ["multiSelections" as const] : []), "createDirectory"],
        title: opts?.title ?? "Choose a folder",
        defaultPath: opts?.defaultPath,
      })
      if (result.canceled) return null
      return opts?.multiple ? result.filePaths : result.filePaths[0]
    },
  )

  ipcMain.handle(
    "open-file-picker",
    async (
      _event: IpcMainInvokeEvent,
      opts?: { multiple?: boolean; title?: string; defaultPath?: string; accept?: string[]; extensions?: string[] },
    ) => {
      const result = await dialog.showOpenDialog({
        properties: ["openFile", ...(opts?.multiple ? ["multiSelections" as const] : [])],
        title: opts?.title ?? "Choose a file",
        defaultPath: opts?.defaultPath,
        filters: pickerFilters(opts?.extensions),
      })
      if (result.canceled) return null
      return opts?.multiple ? result.filePaths : result.filePaths[0]
    },
  )

  ipcMain.handle(
    "save-file-picker",
    async (_event: IpcMainInvokeEvent, opts?: { title?: string; defaultPath?: string }) => {
      const result = await dialog.showSaveDialog({
        title: opts?.title ?? "Save file",
        defaultPath: opts?.defaultPath,
      })
      if (result.canceled) return null
      return result.filePath ?? null
    },
  )

  ipcMain.handle(
    "save-text-file",
    async (_event: IpcMainInvokeEvent, opts: { title?: string; defaultPath?: string; content: string }) => {
      if (typeof opts?.content !== "string") throw new Error("Invalid file content")
      const result = await dialog.showSaveDialog({
        title: opts.title ?? "Save file",
        defaultPath: opts.defaultPath,
      })
      if (result.canceled || !result.filePath) return null
      const filePath = assertLocalPath(result.filePath)
      await writeFile(filePath, opts.content, "utf8")
      return filePath
    },
  )

  ipcMain.on("open-link", (_event: IpcMainEvent, url: string) => {
    try {
      void shell.openExternal(assertHttpExternalUrl(url))
    } catch (err) {
      console.warn("[open-link] blocked:", err instanceof Error ? err.message : url)
    }
  })

  ipcMain.on("open-system-browser-link", (_event: IpcMainEvent, url: string) => {
    try {
      void shell.openExternal(assertSystemBrowserUrl(url))
    } catch (err) {
      console.warn("[open-system-browser-link] blocked:", err instanceof Error ? err.message : url)
    }
  })

  ipcMain.handle("open-image-preview-window", (_event: IpcMainInvokeEvent, input: { src?: string; alt?: string }) => {
    if (!input.src) throw new Error("src is required")
    const id = stashImagePreviewPayload({ src: input.src, alt: input.alt })
    createImagePreviewWindow(id, input.alt)
    return true
  })

  ipcMain.handle("consume-image-preview-payload", (_event: IpcMainInvokeEvent, id: string) => {
    return consumeImagePreviewPayload(id)
  })

  ipcMain.handle("open-external-window", (event: IpcMainInvokeEvent, input: { url?: string; title?: string }) => {
    const url = new URL(input.url ?? "")
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Only http(s) URLs can be opened")

    const parent = BrowserWindow.fromWebContents(event.sender) ?? undefined
    const parentBounds = parent?.getBounds()
    const width = Math.min(1180, Math.max(920, Math.floor((parentBounds?.width ?? 1180) * 0.86)))
    const height = Math.min(900, Math.max(680, Math.floor((parentBounds?.height ?? 860) * 0.86)))
    const win = new BrowserWindow({
      parent,
      modal: true,
      width,
      height,
      minWidth: 820,
      minHeight: 640,
      show: false,
      title: input.title ?? brandNameEn(),
      backgroundColor: "#ffffff",
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })

    win.setMenuBarVisibility(false)
    win.webContents.setWindowOpenHandler((details) => {
      try {
        void shell.openExternal(assertHttpExternalUrl(details.url))
      } catch (err) {
        console.warn("[open-external-window] blocked popup:", err instanceof Error ? err.message : details.url)
      }
      return { action: "deny" }
    })
    win.once("ready-to-show", () => win.show())
    void win.loadURL(url.toString())
    return true
  })

  ipcMain.handle("open-path", async (_event: IpcMainInvokeEvent, path: string, app?: string) => {
    const target = assertLocalPath(path)
    if (!app) return shell.openPath(target)
    const resolvedApp = await resolveOpenPathApp(app)
    await new Promise<void>((resolve, reject) => {
      const [cmd, args] =
        process.platform === "darwin"
          ? (["open", ["-a", resolvedApp, target]] as const)
          : ([resolvedApp, [target]] as const)
      execFile(cmd, args, (err) => (err ? reject(err) : resolve()))
    })
  })

  ipcMain.handle("show-item-in-folder", async (_event: IpcMainInvokeEvent, path: string) => {
    shell.showItemInFolder(assertLocalPath(path))
  })

  ipcMain.handle("read-file-as-data-url", async (_event: IpcMainInvokeEvent, filePath: string, mime: string) => {
    const buf = readFileSync(filePath)
    return `data:${mime};base64,${buf.toString("base64")}`
  })

  ipcMain.handle("read-local-file", (_event: IpcMainInvokeEvent, filePath: string) => {
    const safe = assertLocalPath(filePath)
    const stat = statSync(safe)
    if (!stat.isFile()) throw new Error("Local path is not a file")
    // 与后端文件预览保持相同的 20 MiB 上限；超限或含 NUL 字节时按二进制展示，避免阻塞渲染进程。
    if (stat.size > maxLocalFilePreviewBytes) return { type: "binary" as const, content: "" }
    const content = readFileSync(safe)
    if (content.subarray(0, 8192).includes(0)) return { type: "binary" as const, content: "" }
    return { type: "text" as const, content: content.toString("utf8").trim() }
  })

  ipcMain.handle(
    "invoke-opener",
    async (_event: IpcMainInvokeEvent, opener: InstalledOpener, path: string) => {
      // 校验 opener.app 必须出自最近一次 list-installed-openers 的结果，
      // 否则恶意 renderer 可借此 IPC 通过 execFile 执行任意二进制
      if (!opener || typeof opener.app !== "string" || !isKnownOpenerApp(opener.app)) {
        throw new Error(`invoke-opener: unknown opener app ${opener?.app ?? "<missing>"}`)
      }
      const { cmd, args } = buildOpenCommand(opener, path)
      await new Promise<void>((resolve, reject) => {
        execFile(cmd, args, { windowsHide: false }, (err) => (err ? reject(err) : resolve()))
      })
    },
  )

  ipcMain.handle("read-clipboard-image", () => {
    const image = clipboard.readImage()
    if (image.isEmpty()) return null
    const buffer = image.toPNG().buffer
    const size = image.getSize()
    return { buffer, width: size.width, height: size.height }
  })

  ipcMain.on("show-notification", (event: IpcMainEvent, title: string, body?: string, href?: string) => {
    const sourceWindow = BrowserWindow.fromWebContents(event.sender)
    const sourceWebContents = event.sender
    const notification = new Notification({ title, body })
    const release = () => notifications.delete(notification)

    notification.on("click", () => {
      const targetWindow = sourceWindow && !sourceWindow.isDestroyed() ? sourceWindow : deps.getMainWindow()
      const activeWindow = targetWindow && !targetWindow.isDestroyed() ? targetWindow : undefined

      if (activeWindow) {
        if (activeWindow.isMinimized()) activeWindow.restore()
        activeWindow.show()
        activeWindow.focus()
      }

      const targetWebContents = activeWindow?.webContents ?? sourceWebContents
      if (!targetWebContents.isDestroyed()) targetWebContents.send("notification-click", href)

      release()
    })
    notification.on("failed", release)

    // Windows can keep timed-out notifications in Action Center. Retain their
    // click handlers, with a bound so long-running sessions cannot grow forever.
    notifications.add(notification)
    if (notifications.size > 100) {
      const oldest = notifications.values().next().value
      if (oldest && oldest !== notification) {
        notifications.delete(oldest)
        oldest.close()
      }
    }

    notification.show()
  })

  ipcMain.handle("get-window-count", () => BrowserWindow.getAllWindows().length)

  ipcMain.handle("get-window-focused", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return win?.isFocused() ?? false
  })

  ipcMain.handle("get-window-maximized", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return win?.isMaximized() ?? false
  })

  ipcMain.handle("set-window-focus", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    win?.focus()
  })

  ipcMain.handle("show-window", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    win?.show()
  })

  ipcMain.on("relaunch", () => {
    deps.relaunch()
  })

  ipcMain.handle("get-zoom-factor", (event: IpcMainInvokeEvent) => event.sender.getZoomFactor())
  ipcMain.handle("set-zoom-factor", (event: IpcMainInvokeEvent, factor: number) => {
    event.sender.setZoomFactor(factor)
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    updateTitlebar(win)
  })
  ipcMain.handle("get-native-theme-mode", () => nativeThemeMode())
  ipcMain.handle("set-titlebar", (event: IpcMainInvokeEvent, theme: TitlebarTheme) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    setTitlebar(win, theme)
  })

  // 确保目录存在（递归创建）
  ipcMain.handle("ensure-directory", (_event: IpcMainInvokeEvent, dirPath: string) => {
    const dir = assertUserDirectoryPath(dirPath)
    mkdirSync(dir, { recursive: true })
    return dir
  })

  const initBlankProjectGit = (dir: string) =>
    new Promise<void>((resolve) => {
      execFile("git", ["init"], { cwd: dir }, (err) => {
        if (err) console.warn("[create-blank-project] git init 失败:", err.message)
        resolve()
      })
    })

  ipcMain.handle("get-blank-project-defaults", (_event: IpcMainInvokeEvent, opts: { parent?: string; baseName?: string }) => {
    const parent = blankProjectParent(opts.parent)
    mkdirSync(parent, { recursive: true })
    const base = opts.baseName || BLANK_PROJECT_DEFAULT_BASE
    return { parent, name: nextBlankProjectFolderName(parent, base) }
  })

  ipcMain.handle(
    "check-blank-project-exists",
    (_event: IpcMainInvokeEvent, opts: { parent?: string; name: string }) => blankProjectPathExists(opts.parent, opts.name),
  )

  ipcMain.handle(
    "create-blank-project",
    async (_event: IpcMainInvokeEvent, opts: { parent?: string; baseName?: string; name?: string }) => {
      const candidate =
        opts.name !== undefined
          ? resolveBlankProjectTarget(opts.parent, opts.name)
          : (() => {
              const parent = blankProjectParent(opts.parent)
              mkdirSync(parent, { recursive: true })
              return join(parent, nextBlankProjectFolderName(parent, opts.baseName || BLANK_PROJECT_DEFAULT_BASE))
            })()
      mkdirSync(dirname(candidate), { recursive: true })
      try {
        mkdirSync(candidate)
      } catch (err) {
        if (err && typeof err === "object" && "code" in err && err.code === "EEXIST") {
          throw new Error(`Directory already exists: ${candidate}`)
        }
        throw err
      }
      await initBlankProjectGit(candidate)
      return candidate
    },
  )

  // 散对话默认目录：放在 Electron userData 下（按 channel 隔离，符合各 OS 习惯）
  // Windows: %APPDATA%\ai.wanlaicode.desktop\scratch-sessions
  // macOS:   ~/Library/Application Support/ai.wanlaicode.desktop/scratch-sessions
  // Linux:   ~/.config/ai.wanlaicode.desktop/scratch-sessions
  ipcMain.handle("ensure-scratch-chat-dir", () => {
    const dir = join(app.getPath("userData"), "scratch-sessions")
    mkdirSync(dir, { recursive: true })
    return dir
  })

  ipcMain.handle("ensure-quick-chat-dir", () => {
    const dir = join(app.getPath("userData"), "quick-chat-sessions")
    mkdirSync(dir, { recursive: true })
    return dir
  })

  const environmentFilesRoot = () => environmentsRoot(app.getPath("userData"))

  // 环境文件管理：放在 userData/environments/ 下
  ipcMain.handle("ensure-environments-dir", () => {
    const dir = environmentFilesRoot()
    mkdirSync(dir, { recursive: true })
    return dir
  })

  ipcMain.handle("list-environments", (_event: IpcMainInvokeEvent, worktree: string) => {
    const dir = tryResolveEnvironmentProjectDirFromWorktree(environmentFilesRoot(), worktree)
    if (!dir || !existsSync(dir)) return []
    return readdirSync(dir).filter((f) => f.endsWith(".toml")).sort()
  })

  ipcMain.handle("read-environment", (_event: IpcMainInvokeEvent, worktree: string, filename: string) => {
    const filePath = tryResolveEnvironmentFilePathFromWorktree(environmentFilesRoot(), worktree, filename)
    if (!filePath || !existsSync(filePath)) return ""
    return readFileSync(filePath, "utf-8")
  })

  ipcMain.handle("write-environment", (_event: IpcMainInvokeEvent, worktree: string, filename: string, content: string) => {
    const filePath = tryResolveEnvironmentFilePathFromWorktree(environmentFilesRoot(), worktree, filename)
    if (!filePath) throw new Error("Invalid environment path")
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(filePath, content, "utf-8")
  })

  ipcMain.handle("delete-environment", (_event: IpcMainInvokeEvent, worktree: string, filename: string) => {
    const filePath = tryResolveEnvironmentFilePathFromWorktree(environmentFilesRoot(), worktree, filename)
    if (!filePath || !existsSync(filePath)) return
    rmSync(filePath)
  })

  ipcMain.handle(
    "write-file",
    (_event: IpcMainInvokeEvent, filePath: string, content: string, opts?: { overwrite?: boolean }) => {
      const safe = assertLocalPath(filePath)
      if (!opts?.overwrite && existsSync(safe)) throw new Error("File already exists")
      mkdirSync(dirname(safe), { recursive: true })
      writeFileSync(safe, content, "utf-8")
    },
  )

  ipcMain.handle("rename-file", (_event: IpcMainInvokeEvent, oldPath: string, newPath: string) => {
    const safeOld = assertLocalPath(oldPath)
    const safeNew = assertLocalPath(newPath)
    if (!existsSync(safeOld)) throw new Error("Source file not found")
    if (existsSync(safeNew)) throw new Error("File already exists")
    mkdirSync(dirname(safeNew), { recursive: true })
    renameSync(safeOld, safeNew)
  })

  ipcMain.handle("trash-file", async (_event: IpcMainInvokeEvent, filePath: string) => {
    const safe = normalize(assertLocalPath(filePath))
    if (!existsSync(safe)) throw new Error("Source file not found")
    await shell.trashItem(safe)
  })

  ipcMain.handle("window-action", (event: IpcMainInvokeEvent, action: string) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const wc = event.sender
    switch (action) {
      case "minimize":
        win?.minimize()
        return
      case "toggle-maximize":
        if (!win) return
        if (win.isMaximized()) win.unmaximize()
        else win.maximize()
        return
      case "close":
        win?.close()
        return
      case "fullscreen-toggle":
        win?.setFullScreen(!win.isFullScreen())
        return
      case "reload":
        wc.reload()
        return
      case "devtools-toggle":
        wc.toggleDevTools()
        return
      case "zoom-in":
        wc.setZoomLevel(wc.getZoomLevel() + 0.5)
        return
      case "zoom-out":
        wc.setZoomLevel(wc.getZoomLevel() - 0.5)
        return
      case "zoom-reset":
        wc.setZoomLevel(0)
        return
      case "undo":
        wc.undo()
        return
      case "redo":
        wc.redo()
        return
      case "cut":
        wc.cut()
        return
      case "copy":
        wc.copy()
        return
      case "paste":
        wc.paste()
        return
      case "select-all":
        wc.selectAll()
        return
      case "new-window":
        deps.newWindow()
        return
      default:
        return
    }
  })

  ipcMain.handle("move-window-for-drag", (event: IpcMainInvokeEvent, input: WindowDragMoveInput) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || win.isDestroyed() || win.isFullScreen()) return

    const x = Math.round(Number(input?.x))
    const y = Math.round(Number(input?.y))
    if (!Number.isFinite(x) || !Number.isFinite(y)) return

    if (win.isMaximized()) win.unmaximize()
    const width = Math.round(Number(input?.width))
    const height = Math.round(Number(input?.height))
    if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
      win.setBounds({ x, y, width, height }, false)
      return
    }
    win.setPosition(x, y, false)
  })

  // BrowserView handlers
  ipcMain.handle("browser-view-create", (event: IpcMainInvokeEvent, tabId: string) => {
    if (browserViews.has(tabId)) return true
    const view = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })
    view.setBackgroundColor("#ffffff")
    view.setVisible(false)
    view.webContents.setWindowOpenHandler((details) => {
      try {
        void shell.openExternal(assertHttpExternalUrl(details.url))
      } catch (err) {
        console.warn("[browser-view] blocked popup:", err instanceof Error ? err.message : details.url)
      }
      return { action: "deny" }
    })

    const owner = event.sender
    const entry: WebContentsViewEntry = { favicon: "", view, owner }
    browserViews.set(tabId, entry)
    owner.once("destroyed", () => {
      for (const [id, current] of browserViews) {
        if (current.owner !== owner) continue
        cleanupBrowserView(id)
      }
    })

    const sendState = () => {
      if (owner.isDestroyed()) return
      owner.send("browser-view-state", tabId, {
        canGoBack: browserViewCanGoBack(view.webContents),
        canGoForward: browserViewCanGoForward(view.webContents),
        favicon: entry.favicon,
        isLoading: view.webContents.isLoading(),
        title: view.webContents.getTitle(),
        url: view.webContents.getURL(),
      })
    }

    view.webContents.on("did-start-loading", sendState)
    view.webContents.on("did-stop-loading", sendState)
    view.webContents.on("did-navigate", sendState)
    view.webContents.on("did-navigate-in-page", sendState)
    view.webContents.on("did-start-navigation", (_event, _url, _isInPlace, isMainFrame) => {
      if (!isMainFrame) return
      sendState()
    })
    view.webContents.on("page-favicon-updated", (_event, favicons) => {
      entry.favicon = favicons[0] ?? ""
      sendState()
    })
    view.webContents.on("page-title-updated", sendState)

    return true
  })

  ipcMain.handle("browser-view-destroy", (_event: IpcMainInvokeEvent, tabId: string) => {
    cleanupBrowserView(tabId)
  })

  ipcMain.on("browser-view-close", (event: IpcMainEvent, tabId: string) => {
    cleanupBrowserView(tabId)
    event.returnValue = true
  })

  ipcMain.on("browser-view-hide-sync", (event: IpcMainEvent, tabId: string) => {
    browserViews.get(tabId)?.view.setVisible(false)
    event.returnValue = true
  })

  ipcMain.handle("browser-view-navigate", (_event: IpcMainInvokeEvent, tabId: string, url: string) => {
    const entry = browserViews.get(tabId)
    if (!entry) return false
    if (!isAllowedBrowserViewUrl(url)) return false
    void entry.view.webContents.loadURL(url)
    return true
  })

  ipcMain.handle("browser-view-set-bounds", (_event: IpcMainInvokeEvent, tabId: string, bounds: { x: number; y: number; width: number; height: number }) => {
    const entry = browserViews.get(tabId)
    if (!entry) return
    entry.view.setBounds(bounds)
  })

  ipcMain.on("browser-view-show", (_event: IpcMainEvent, tabId: string) => {
    const entry = browserViews.get(tabId)
    if (!entry) return
    const win = BrowserWindow.fromWebContents(entry.owner)
    if (!win) return
    entry.view.setVisible(true)
    win.contentView.addChildView(entry.view)
  })

  ipcMain.on("browser-view-hide", (_event: IpcMainEvent, tabId: string) => {
    const entry = browserViews.get(tabId)
    if (!entry) return
    entry.view.setVisible(false)
    const win = BrowserWindow.fromWebContents(entry.owner)
    if (win) {
      try { win.contentView.removeChildView(entry.view) } catch { }
    }
  })

  ipcMain.handle("browser-view-focus", (_event: IpcMainInvokeEvent, tabId: string) => {
    const entry = browserViews.get(tabId)
    if (!entry) return
    entry.view.webContents.focus()
  })

  ipcMain.handle("browser-view-go-back", (_event: IpcMainInvokeEvent, tabId: string) => {
    const entry = browserViews.get(tabId)
    if (!entry) return false
    if (browserViewCanGoBack(entry.view.webContents)) {
      entry.view.webContents.goBack()
      return true
    }
    return false
  })

  ipcMain.handle("browser-view-go-forward", (_event: IpcMainInvokeEvent, tabId: string) => {
    const entry = browserViews.get(tabId)
    if (!entry) return false
    if (browserViewCanGoForward(entry.view.webContents)) {
      entry.view.webContents.goForward()
      return true
    }
    return false
  })

  ipcMain.handle("browser-view-reload", (_event: IpcMainInvokeEvent, tabId: string) => {
    const entry = browserViews.get(tabId)
    if (!entry) return false
    entry.view.webContents.reload()
    return true
  })

  ipcMain.handle("browser-view-stop", (_event: IpcMainInvokeEvent, tabId: string) => {
    const entry = browserViews.get(tabId)
    if (!entry) return false
    entry.view.webContents.stop()
    return true
  })
}

export function sendSqliteMigrationProgress(win: BrowserWindow, progress: SqliteMigrationProgress) {
  win.webContents.send("sqlite-migration-progress", progress)
}

export function sendUpdateProgress(win: BrowserWindow, progress: UpdateProgress) {
  if (win.isDestroyed()) return
  win.webContents.send("update-progress", progress)
}

export function sendMenuCommand(win: BrowserWindow, id: string) {
  win.webContents.send("menu-command", id)
}

export function sendTrayNavigate(win: BrowserWindow, target: { sessionID: string; slug: string }) {
  win.webContents.send("tray-navigate", target)
}

export function sendDeepLinks(win: BrowserWindow, urls: string[]) {
  win.webContents.send("deep-link", urls)
}
