import { randomUUID } from "node:crypto"
import { EventEmitter } from "node:events"
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs"
import * as http from "node:http"
import { createServer } from "node:net"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { getCACertificates, setDefaultCACertificates } from "node:tls"
import { fileURLToPath } from "node:url"
import type { Event, WebContents } from "electron"
import { app, BrowserWindow, dialog, powerMonitor, session } from "electron"
import { brandNameCn, getBrand } from "@opencode-ai/brand"
import pkg from "electron-updater"

import contextMenu from "electron-context-menu"
import { saveContextMenuImageAs } from "./context-menu-download"
import { contextMenuLabels, refreshContextMenuLabels } from "./context-menu-i18n"
const devtoolsEnabled = !app.isPackaged || process.env.WANLAICODE_ENABLE_DEVTOOLS === "1"
const contextMenuState = globalThis as typeof globalThis & { __wanlaicodeContextMenuDispose?: () => void }
contextMenuState.__wanlaicodeContextMenuDispose?.()
if (!app.isPackaged) {
  // 开发态主进程热更新会保留已有窗口，旧右键菜单监听器可能继续走 electron-dl 的崩溃路径。
  BrowserWindow.getAllWindows().forEach((win) => win.webContents.removeAllListeners("context-menu"))
}
contextMenuState.__wanlaicodeContextMenuDispose = contextMenu({
  labels: contextMenuLabels,
  showSaveImageAs: false,
  showLookUpSelection: false,
  showSearchWithGoogle: false,
  showInspectElement: devtoolsEnabled,
  prepend: (_defaultActions, properties, browserWindow) => [
    {
      id: "saveImageAs",
      label: contextMenuLabels.saveImageAs,
      visible: properties.mediaType === "image",
      click: () => {
        void saveContextMenuImageAs(browserWindow, properties).catch((err) => {
          recordMainProcessIssue("context-menu.save-image-as.failed", err)
          logger.error("[issue-report] context-menu save image as failed", err)
        })
      },
    },
  ],
})

// on macOS apps run in `/` which can cause issues with ripgrep
try {
  process.chdir(homedir())
} catch {}

process.env.WANLAICODE_DISABLE_EMBEDDED_WEB_UI = "true"

// app.setName() 决定 macOS Dock 名 / Windows 任务栏名 / 默认 userData 路径名。
// 这里用 brandNameCn() 按 brand 现算；CHANNEL 后缀保留以便多版本同装时区分。
// canary 与 prod 是同一个 App，沿用 prod 的名称与 bundleId。
const APP_NAMES: Record<Channel, string> = {
  dev: `${brandNameCn()} Dev`,
  beta: `${brandNameCn()} Beta`,
  prod: brandNameCn(),
  canary: brandNameCn(),
}
const APP_IDS: Record<Channel, string> = {
  dev: "ai.wanlaicode.desktop.dev",
  beta: "ai.wanlaicode.desktop.beta",
  prod: "ai.wanlaicode.desktop",
  canary: "ai.wanlaicode.desktop",
}
const TEST_ONBOARDING = process.env.WANLAICODE_TEST_ONBOARDING === "1"
const LOADING_ONLY = process.env.WANLAICODE_LOADING_ONLY === "1"
// 正常启动 sidecar 约 3s 就绪；8s 仍不通说明大概率被拦截或卡死，先给用户可见线索
const SIDECAR_SLOW_NOTICE_MS = 8_000
const SIDECAR_HEALTH_TIMEOUT_MS = 30_000
const appId = app.isPackaged ? APP_IDS[CHANNEL] : APP_IDS.dev
const onboardingTestRoot = setupOnboardingTestEnv()
app.setName(APP_NAMES[CHANNEL])
app.setAppUserModelId(appId)
app.setPath("userData", onboardingTestRoot ? join(onboardingTestRoot, "desktop") : join(app.getPath("appData"), appId))
if (onboardingTestRoot) app.setPath("sessionData", join(onboardingTestRoot, "session"))
refreshContextMenuLabels()

// 必须在任何 @opencode-ai/core 模块被 import 前设置：core/global.ts 在 import 阶段就读 xdg-basedir，
// xdg-basedir 顶层 const 会立即冻结当时的 process.env，之后再改 XDG_* 已经无效
{
  const userData = app.getPath("userData")
  process.env.XDG_DATA_HOME ??= userData
  process.env.XDG_STATE_HOME ??= userData
  process.env.XDG_CACHE_HOME ??= userData
  // XDG_CONFIG_HOME 不覆盖 —— 保留用户全局 ~/.config/opencode/opencode.jsonc
}

// 内置 skill 目录指针 —— packages/opencode/src/skill/index.ts 的 discoverSkills 读
// WANLAICODE_BUILTIN_SKILLS_DIR 扫描随包分发的官方 skill:
// dev = 源码 resources 目录;prod = Contents/Resources/builtin-skills(extraResources 落点)。
{
  const root = dirname(fileURLToPath(import.meta.url))
  const builtinSkills = app.isPackaged
    ? join(process.resourcesPath, "builtin-skills")
    : join(root, "../../resources/builtin-skills")
  if (existsSync(builtinSkills)) {
    process.env.WANLAICODE_BUILTIN_SKILLS_DIR = builtinSkills
  }
}
const logger = initLogging()

// 不迁移 ~/.local/share/opencode：该路径与独立安装的官方 opencode 数据目录撞名，
// 无法区分「老版 wanlaicode sidecar 数据」与「用户的官方 opencode 数据」，搬走它会破坏
// 用户的 opencode 安装。wanlaicode 一律使用自有命名空间（core 的 resolveAppDir → userData/wanlaicode）。
const { autoUpdater, CancellationToken } = pkg
type CancellationTokenInstance = InstanceType<typeof CancellationToken>

import type {
  InitStep,
  ServerReadyData,
  SqliteMigrationProgress,
  UpdateProgress,
  WslConfig,
} from "../preload/types"
import { checkAppExists, getAppIconDataUrl, resolveAppPath, wslPath } from "./apps"
import { CHANNEL, DEBUG_UPDATER, UPDATER_ENABLED, type Channel } from "./constants"
import { listInstalledOpeners } from "./openers"
import {
  recordMainProcessIssue,
  registerIpcHandlers,
  sendDeepLinks,
  sendMenuCommand,
  sendSqliteMigrationProgress,
  sendTrayNavigate,
  sendUpdateProgress,
} from "./ipc"
import { listTrayRecentSessions, directorySlug } from "./tray-sessions"
import { setTrayLocale } from "./i18n"
import { initLogging } from "./logging"
import { parseMarkdown } from "./markdown"
import { createMenu } from "./menu"
import {
  isWindowTrayHidden,
  markAppQuitting,
  isAppQuitting,
  clearAppQuitting,
  revealWindowFromTray,
  setupTray,
  destroyTray,
  refreshTrayLocale,
} from "./tray"
import { getDefaultServerUrl, getWslConfig, setDefaultServerUrl, setWslConfig, spawnLocalServer } from "./server"
import { awaitSidecarHealth } from "./sidecar-health"
import { getStore } from "./store"
import {
  createMainWindow,
  createUninstallFeedbackWindow,
  createUpdateProgressWindow,
  loadWindow,
  registerRendererProtocol,
  setBackgroundColor,
  setDockIcon,
  windowsBackdrop,
} from "./windows"
import { isUninstallFeedbackMode, EXIT_SUBMITTED, EXIT_CANCELLED } from "../uninstall-feedback/shared"
import { submitUninstallFeedback } from "../uninstall-feedback/submit"
import { drizzle } from "drizzle-orm/node-sqlite/driver"
import { migrate } from "./migrate"
import { resolveUpdateDecision } from "./update-decision"
import { loadVirtualOpencodeServer, type VirtualOpencodeServerModule } from "./virtual-opencode-server"
import { createAppSnapshotService } from "./app-snapshot"

type ServerListener = Awaited<ReturnType<VirtualOpencodeServerModule["Server"]["listen"]>>

const initEmitter = new EventEmitter()
let initStep: InitStep = { phase: "server_waiting" }

let mainWindow: BrowserWindow | null = null
let loginWindow: BrowserWindow | null = null
let mainWindowHtml: MainWindowHtml | null = null
let startupLoadingWindow: BrowserWindow | null = null
let server: ServerListener | null = null
const loadingComplete = defer<void>()

const pendingDeepLinks: string[] = []

const serverReady = defer<ServerReadyData>()

type MainWindowHtml = "index.html" | "loading.html" | "login.html"

useSystemCertificates()

function setupOnboardingTestEnv() {
  if (!TEST_ONBOARDING) return

  const root = join(tmpdir(), `wanlaicode-onboarding-${randomUUID()}`)
  rmSync(root, { recursive: true, force: true })
  ;["data", "config", "cache", "state", "desktop", "session"].forEach((dir) =>
    mkdirSync(join(root, dir), { recursive: true }),
  )
  process.env.WANLAICODE_DB = ":memory:"
  process.env.XDG_DATA_HOME = join(root, "data")
  process.env.XDG_CONFIG_HOME = join(root, "config")
  process.env.XDG_CACHE_HOME = join(root, "cache")
  process.env.XDG_STATE_HOME = join(root, "state")
  return root
}

logger.log("app starting", {
  version: app.getVersion(),
  packaged: app.isPackaged,
  onboardingTest: Boolean(onboardingTestRoot),
})

process.on("uncaughtException", (err) => {
  recordMainProcessIssue("main.uncaughtException", err)
  logger.error("[issue-report] main uncaughtException", err)
})

process.on("unhandledRejection", (reason) => {
  recordMainProcessIssue("main.unhandledRejection", reason)
  logger.error("[issue-report] main unhandledRejection", reason)
})

if (isUninstallFeedbackMode(process.argv)) {
  void runUninstallFeedbackMode()
} else {
  setupApp()
}

async function runUninstallFeedbackMode() {
  // 注意：本功能的 IPC handler 故意放在这里而非约定的 ipc.ts。--uninstall-feedback 模式
  // 完全绕过 setupApp()(及其单实例锁/sidecar/ipc.ts 注册)，是一条独立最小启动路径，
  // 因此其 handler 就近定义在此。后续 refactor 勿迁移到 ipc.ts。
  const { ipcMain } = await import("electron")
  // 一旦反馈被记录(上报成功 或 已写本地兜底)，关窗即视为「已提交」继续卸载，不再阻塞用户。
  let recorded = false

  // 反馈上报走 Node 全局 fetch，本路径绕过了 setupApp，需自行从环境变量加载代理，
  // 否则代理网络下上报必失败、只能落本地兜底，反馈拿不到。
  useEnvProxy()

  await app.whenReady()
  // 关键：反馈窗用 oc://renderer 加载页面，而 oc 协议的 handler 只在 setupApp 里注册。
  // 这条最小启动路径绕过了 setupApp，必须自行注册；否则 oc:// 无人处理，会被 Windows
  // 当成未知外部协议，弹出「无法打开此 oc 链接」并使反馈窗白屏。
  registerRendererProtocol()
  const win = createUninstallFeedbackWindow()

  // UI 故障(页面加载失败 / 渲染进程崩溃)绝不能卡住卸载：直接按「已提交」放行，
  // 否则坏掉的反馈窗会被用户关闭并判成「取消」，从而中止卸载、把用户锁死。
  const proceedOnFailure = (why: string, detail?: unknown) => {
    logger.error(`[uninstall-feedback] ${why}, proceeding with uninstall`, detail)
    app.exit(EXIT_SUBMITTED)
  }
  win.webContents.on("did-fail-load", (_e, errorCode, _desc, _url, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return // -3 = ERR_ABORTED，正常导航的瞬时态，忽略
    proceedOnFailure("feedback window failed to load", { errorCode })
  })
  win.webContents.on("render-process-gone", (_e, details) => {
    proceedOnFailure("feedback renderer gone", details)
  })

  // 窗口被关闭：已有记录 → 继续卸载；否则视为用户取消。
  win.on("closed", () => {
    app.exit(recorded ? EXIT_SUBMITTED : EXIT_CANCELLED)
  })

  ipcMain.handle("uninstall-feedback:submit", async (_e, data: {
    content: string
    contact?: string
    images: { name: string; type: string; bytes: Uint8Array }[]
  }) => {
    const apiBase = getBrand().backend.apiBase
    const stamp = new Date().toISOString().replace(/[:.]/g, "-")
    try {
      const result = await submitUninstallFeedback(
        {
          content: data.content,
          contact: data.contact,
          images: data.images,
          meta: { client: getBrand().id, clientVersion: app.getVersion(), os: process.platform, arch: process.arch },
        },
        { fetch, apiBase, fallbackDir: app.getPath("userData"), stamp },
      )
      // 成功 或 已写兜底，都算「已记录」：关窗/继续都会走继续卸载。
      recorded = true
      // 仅在上报成功时自动退出继续卸载；失败保留窗口让渲染层提示重试/继续。
      if (result.ok) setTimeout(() => app.exit(EXIT_SUBMITTED), 150)
      return { ok: result.ok, fellBack: result.fellBack }
    } catch (e) {
      // submit 已是 total 函数，正常不会到这；万一(如 IPC 序列化)抛错，宁可放行也绝不卡住卸载。
      logger.error("[uninstall-feedback] submit handler threw, proceeding with uninstall", e)
      setTimeout(() => app.exit(EXIT_SUBMITTED), 150)
      return { ok: true, fellBack: false }
    }
  })

  // 上报反复失败后，用户选择「继续卸载」：兜底已写在本地，直接放行。
  ipcMain.on("uninstall-feedback:continue", () => {
    recorded = true
    app.exit(EXIT_SUBMITTED)
  })

  // 用户取消 → 中止卸载。app.exit 立即终止进程，closed 若再触发也仍是 CANCELLED，语义一致。
  ipcMain.on("uninstall-feedback:cancel", () => {
    app.exit(EXIT_CANCELLED)
  })
}

function setupApp() {
  ensureLoopbackNoProxy()
  useEnvProxy()
  app.commandLine.appendSwitch("proxy-bypass-list", "<-loopback>")
  if (!app.isPackaged) app.commandLine.appendSwitch("remote-debugging-port", "9222")

  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }

  app.on("second-instance", (_event: Event, argv: string[]) => {
    const urls = argv.filter((arg: string) => arg.startsWith("wanlaicode://") || arg.startsWith("opencode://"))
    if (urls.length) {
      logger.log("deep link received via second-instance", { urls })
      emitDeepLinks(urls)
    }
    focusMainWindow()
  })

  app.on("open-url", (event: Event, url: string) => {
    event.preventDefault()
    logger.log("deep link received via open-url", { url })
    emitDeepLinks([url])
  })

  app.on("before-quit", () => shutdownBeforeQuit())

  app.on("window-all-closed", () => {})
  app.on("render-process-gone", (_event, webContents, details) => {
    recordMainProcessIssue("electron.render-process-gone", new Error(details.reason), {
      reason: details.reason,
      exit_code: details.exitCode,
      url: webContents.getURL(),
    })
    maybeRecoverRenderer(webContents, details.reason)
  })
  app.on("child-process-gone", (_event, details) => {
    recordMainProcessIssue("electron.child-process-gone", new Error(details.reason), {
      type: details.type,
      reason: details.reason,
      exit_code: details.exitCode,
      name: details.name,
    })
  })

  const quitSignals = ["SIGINT", "SIGTERM", ...(process.platform === "win32" ? (["SIGBREAK"] as const) : [])] as const
  for (const signal of quitSignals) {
    process.on(signal, () => quitApp())
  }

  void app.whenReady().then(async () => {
    if (!TEST_ONBOARDING) migrate()
    app.setAsDefaultProtocolClient("wanlaicode")
    allowWanlaiPurchaseEmbedding()
    registerRendererProtocol()
    setDockIcon()
    ensureTray()
    setupAutoUpdater()
    powerMonitor.on("resume", () => void refreshOAuthOnResume())
    if (DEBUG_UPDATER) {
      const { ipcMain } = await import("electron")
      ipcMain.handle("debug-simulate-update-check-flow", (_event, scenario: SimulationScenario) => {
        return simulateUpdateCheckFlow(scenario)
      })
    }
    await initialize()
  })
}

function allowWanlaiPurchaseEmbedding() {
  session.defaultSession.webRequest.onHeadersReceived(
    {
      urls: [
        "https://pay.wanlai.ai/*",
        "http://127.0.0.1:3000/*",
        "http://localhost:3000/*",
      ],
    },
    (details, callback) => {
      callback({
        responseHeaders: Object.fromEntries(
          Object.entries(details.responseHeaders ?? {}).filter(
            (entry) => !["content-security-policy", "x-frame-options"].includes(entry[0].toLowerCase()),
          ),
        ),
      })
    },
  )
}

function useSystemCertificates() {
  try {
    setDefaultCACertificates([...new Set([...getCACertificates("default"), ...getCACertificates("system")])])
  } catch (error) {
    logger.warn("failed to load system certificates", error)
  }
}

function useEnvProxy() {
  try {
    // Electron 41.2 runs Node 24.14.1; latest @types/node@24 is 24.12.2.
    ;(http as any).setGlobalProxyFromEnv()
  } catch (error) {
    logger.warn("failed to load proxy environment", error)
  }
}

function emitDeepLinks(urls: string[]) {
  if (urls.length === 0) return
  pendingDeepLinks.push(...urls)
  if (mainWindow) sendDeepLinks(mainWindow, urls)
}

function ensureMainWindow(html: MainWindowHtml) {
  if (mainWindow?.isDestroyed()) {
    mainWindow = null
    mainWindowHtml = null
  }
  if (!mainWindow) {
    mainWindow = createMainWindow(html)
    mainWindowHtml = html
    const win = mainWindow
    win.on("closed", () => {
      if (mainWindow !== win) return
      mainWindow = null
      mainWindowHtml = null
    })
    return { win: mainWindow, created: true }
  }

  if (mainWindowHtml !== html) {
    mainWindowHtml = html
    void loadWindow(mainWindow, html)
  }
  return { win: mainWindow, created: false }
}

function waitForReadyToShow(win: BrowserWindow) {
  if (!win.isVisible()) return new Promise<void>((resolve) => win.once("ready-to-show", () => resolve()))
  return Promise.resolve()
}

function showMainWindow(html: MainWindowHtml) {
  const result = ensureMainWindow(html)
  if (result.created) {
    result.win.once("ready-to-show", () => {
      if (!isWindowTrayHidden(result.win)) result.win.focus()
    })
    return result.win
  }

  if (!isWindowTrayHidden(result.win)) {
    result.win.show()
    result.win.focus()
  }
  return result.win
}

async function showPreloadedMainWindow(html: "index.html" | "login.html") {
  // 启动阶段保持 loading 窗口可见，主页面先在隐藏窗口里完成首帧渲染。
  // ready-to-show 后再销毁 loading 窗口，避免同窗口 loadURL 时露出原生灰色底。
  const previousLoadingWindow = startupLoadingWindow?.isDestroyed() ? null : startupLoadingWindow
  const win = createMainWindow(html, { showOnReady: false })
  mainWindow = win
  mainWindowHtml = html
  win.on("closed", () => {
    if (mainWindow !== win) return
    mainWindow = null
    mainWindowHtml = null
  })
  await Promise.race([waitForReadyToShow(win), delay(5_000)])
  if (!isWindowTrayHidden(win)) {
    win.show()
    win.focus()
  }
  previousLoadingWindow?.destroy()
  if (startupLoadingWindow === previousLoadingWindow) startupLoadingWindow = null
  return win
}

async function openMainWindow() {
  if (startupLoadingWindow && !startupLoadingWindow.isDestroyed() && mainWindowHtml === "loading.html") {
    const win = await showPreloadedMainWindow("index.html")
    loginWindow?.close()
    loginWindow = null
    wireMenu()
    return win
  }
  const win = showMainWindow("index.html")
  loginWindow?.close()
  loginWindow = null
  wireMenu()
  return win
}

async function openLoginWindow() {
  if (loginWindow?.isDestroyed()) loginWindow = null
  loginWindow?.close()
  loginWindow = null
  if (startupLoadingWindow && !startupLoadingWindow.isDestroyed() && mainWindowHtml === "loading.html") {
    await showPreloadedMainWindow("login.html")
    return
  }
  showMainWindow("login.html")
}

// 渲染进程崩溃自动恢复：仅对主窗、且崩溃原因为 crashed/oom 时重载，避免与其它窗口
// （如卸载反馈窗）自有的 render-process-gone 处理冲突。带崩溃循环护栏：窗口期内超过
// 上限就放弃重载，防止「崩溃→重载→再崩溃」死循环。
const rendererCrashTimestamps: number[] = []
const RENDERER_CRASH_WINDOW_MS = 60_000
const RENDERER_CRASH_MAX_RELOADS = 3

function maybeRecoverRenderer(webContents: WebContents, reason: string) {
  if (isAppQuitting()) return
  if (reason !== "crashed" && reason !== "oom") return
  if (!mainWindow || mainWindow.isDestroyed() || webContents !== mainWindow.webContents) return
  const now = Date.now()
  while (rendererCrashTimestamps.length > 0 && now - rendererCrashTimestamps[0]! > RENDERER_CRASH_WINDOW_MS)
    rendererCrashTimestamps.shift()
  rendererCrashTimestamps.push(now)
  if (rendererCrashTimestamps.length > RENDERER_CRASH_MAX_RELOADS) {
    logger.error("[crash-recovery] renderer crashed repeatedly, not reloading", {
      reason,
      count: rendererCrashTimestamps.length,
    })
    return
  }
  logger.log("[crash-recovery] reloading crashed renderer", { reason, attempt: rendererCrashTimestamps.length })
  try {
    webContents.reload()
  } catch (error) {
    logger.error("[crash-recovery] reload failed", error)
  }
}

function shutdownBeforeQuit() {
  markAppQuitting()
  destroyTray()
  appSnapshots.stop()
  killSidecar()
}

function quitApp() {
  shutdownBeforeQuit()
  app.quit()
}

function ensureTray() {
  setupTray({
    showMainWindow: focusMainWindow,
    triggerCommand: (id) => {
      if (mainWindowHtml !== "index.html") return
      if (mainWindow) sendMenuCommand(mainWindow, id)
    },
    openSession: (target) => {
      if (mainWindowHtml !== "index.html") return
      focusMainWindow()
      if (mainWindow) sendTrayNavigate(mainWindow, { sessionID: target.sessionID, slug: directorySlug(target.directory) })
    },
    listRecentSessions: async () => listTrayRecentSessions(await serverReady.promise),
    canUseAppCommands: () => mainWindowHtml === "index.html",
  })
}

function updateTrayLocale(locale: string) {
  setTrayLocale(locale)
  refreshContextMenuLabels(locale)
  refreshTrayLocale()
}

function focusMainWindow() {
  if (!mainWindow) return
  revealWindowFromTray(mainWindow)
}

function setInitStep(step: InitStep) {
  initStep = step
  logger.log("init step", { step })
  initEmitter.emit("step", step)
}

async function initialize() {
  const needsMigration = !sqliteFileExists()
  const sqliteDone = needsMigration ? defer<void>() : undefined
  startupLoadingWindow = showMainWindow("loading.html")

  const port = await getSidecarPort()
  const hostname = "127.0.0.1"
  const url = `http://${hostname}:${port}`
  const password = randomUUID()

  const loadingTask = (async () => {
    logger.log("sidecar connection started", { url })

    initEmitter.on("sqlite", (progress: SqliteMigrationProgress) => {
      setInitStep({ phase: "sqlite_waiting" })
      if (mainWindow) sendSqliteMigrationProgress(mainWindow, progress)
      if (progress.type === "Done") sqliteDone?.resolve()
    })

    if (needsMigration) {
      const { Database, JsonMigration } = await loadVirtualOpencodeServer()
      const migrationDb = drizzle(Database.Client().$client as never)
      await JsonMigration.run(migrationDb, {
        progress: (event: { current: number; total: number }) => {
          const percent = Math.floor((event.current / event.total) * 100)
          initEmitter.emit("sqlite", { type: "InProgress", value: percent })
        },
      })
      initEmitter.emit("sqlite", { type: "Done" })

      sqliteDone?.resolve()
    }

    if (needsMigration) {
      await sqliteDone?.promise
    }

    // sidecar 是打进主进程 bundle 的后端；认证或远控源码变更后必须重启 Electron 主进程才能加载新实现。
    logger.log("spawning sidecar", { url })
    const { listener, health } = await spawnLocalServer(hostname, port, password, () => {
      ensureLoopbackNoProxy()
      useEnvProxy()
    })
    server = listener
    serverReady.resolve({
      url,
      username: "wanlaicode",
      password,
    })

    const outcome = await awaitSidecarHealth({
      wait: health.wait,
      slowMs: SIDECAR_SLOW_NOTICE_MS,
      timeoutMs: SIDECAR_HEALTH_TIMEOUT_MS,
      onSlow: () => {
        logger.warn("sidecar health check slow, surfacing startup notice")
        setInitStep({ phase: "server_unreachable" })
      },
    })
    if (!outcome.healthy) logger.error("sidecar health check failed", { timeoutMs: SIDECAR_HEALTH_TIMEOUT_MS })

    logger.log("loading task finished", { healthy: outcome.healthy })
  })()

  await loadingTask
  setInitStep({ phase: "done" })

  if (LOADING_ONLY) {
    logger.log("loading-only test mode enabled, staying on loading window")
    return
  }

  await Promise.race([loadingComplete.promise, delay(2_000)])

  const hasWanlaicodeAuth = await checkWanlaicodeAuth(url, password)
  if (hasWanlaicodeAuth) {
    await openMainWindow()
    return
  }

  await openLoginWindow()
}

async function checkWanlaicodeAuth(sidecarUrl: string, password: string): Promise<boolean> {
  try {
    const credentials = Buffer.from(`wanlaicode:${password}`).toString("base64")
    // 路径必须与 SDK 一致（无 /v1 前缀）；带 /v1 会落到 SPA 兜底返回 HTML，
    // JSON 解析失败被误判为未登录，导致启动时先弹登录窗再切回主窗
    // status 已即时返回（远端补全在 sidecar 侧后台异步处理），此处加超时仅作最后防线
    const res = await fetch(`${sidecarUrl}/wanlaicode/user-center/status`, {
      headers: { Authorization: `Basic ${credentials}` },
      signal: AbortSignal.timeout(8_000),
    })
    if (!res.ok) return false
    const body = (await res.json()) as { authenticated?: boolean }
    return body.authenticated === true
  } catch {
    return false
  }
}

function wireMenu() {
  if (!mainWindow) return
  createMenu({
    trigger: (id) => mainWindow && sendMenuCommand(mainWindow, id),
    checkForUpdates: () => {
      void checkForUpdates(true)
    },
    reload: () => mainWindow?.reload(),
    relaunch: () => {
      shutdownBeforeQuit()
      app.relaunch()
      app.quit()
    },
    simulateUpdateCheckFlow: DEBUG_UPDATER
      ? (scenario) => {
          void simulateUpdateCheckFlow(scenario)
        }
      : undefined,
  })
}

const appSnapshots = createAppSnapshotService({
  getMainWindow: () => mainWindow,
  showMainWindow: focusMainWindow,
  onError: recordMainProcessIssue,
})

registerIpcHandlers({
  killSidecar: () => killSidecar(),
  awaitInitialization: async (sendStep) => {
    sendStep(initStep)
    const listener = (step: InitStep) => sendStep(step)
    initEmitter.on("step", listener)
    try {
      logger.log("awaiting server ready")
      const res = await serverReady.promise
      logger.log("server ready", { url: res.url })
      // serverReady 在 sidecar listen 后就 resolve，但 phase=done 要等 loadingTask 全部结束才发；
      // 必须把 listener 保留到 done，否则 loading window 收不到 done，会卡在 overlay
      if (initStep.phase !== "done") {
        await new Promise<void>((resolve) => {
          const wait = (step: InitStep) => {
            if (step.phase !== "done") return
            initEmitter.off("step", wait)
            resolve()
          }
          initEmitter.on("step", wait)
        })
      }
      return res
    } finally {
      initEmitter.off("step", listener)
    }
  },
  getWindowConfig: () => ({ updaterEnabled: UPDATER_ENABLED, windowsBackdrop: windowsBackdrop() }),
  consumeInitialDeepLinks: () => pendingDeepLinks.splice(0),
  getDefaultServerUrl: () => getDefaultServerUrl(),
  setDefaultServerUrl: (url) => setDefaultServerUrl(url),
  getWslConfig: () => Promise.resolve(getWslConfig()),
  setWslConfig: (config: WslConfig) => setWslConfig(config),
  parseMarkdown: async (markdown) => parseMarkdown(markdown),
  checkAppExists: async (appName) => checkAppExists(appName),
  getAppIcon: async (appName) => getAppIconDataUrl(appName),
  listInstalledOpeners: () => listInstalledOpeners(),
  wslPath: async (path, mode) => wslPath(path, mode),
  resolveAppPath: async (appName) => resolveAppPath(appName),
  loadingWindowComplete: () => loadingComplete.resolve(),
  runUpdater: async (alertOnFail) => checkForUpdates(alertOnFail),
  checkUpdate: async () => checkUpdate(),
  installUpdate: async () => installUpdate(),
  confirmInstall: async () => confirmInstall(),
  cancelUpdate: () => cancelDownload(),
  closeUpdateWindow: () => closeUpdateProgressWindow(),
  getUpdateChannel: () => getCachedUpdateChannel(),
  setUpdateChannel: (channel) => {
    const prev = getCachedUpdateChannel()
    setCachedUpdateChannel(channel)
    // 用户主动退出内测（canary→prod）时记一次 opt-out，下次 checkUpdate 放行降级。
    // 持久化以防 toggle 后未检查更新就退出导致重启丢失。
    if (prev === "canary" && channel === "prod") setOptOutPending(true)
    // 与 setupAutoUpdater 保持一致：未启用 updater 时不调用 applyUpdateChannel
    if (UPDATER_ENABLED) applyUpdateChannel(channel)
  },
  setBackgroundColor: (color) => setBackgroundColor(color),
  openMainWindow: () => openMainWindow(),
  openLoginWindow: () => openLoginWindow(),
  newWindow: () => createMainWindow(),
  getMainWindow: () => mainWindow,
  setTrayLocale: updateTrayLocale,
  configureAppSnapshots: (config) => appSnapshots.configure(config),
  getAppSnapshotPermissions: () => appSnapshots.permissions(),
  requestAppSnapshotPermission: (permission) => appSnapshots.requestPermission(permission),
  captureAppSnapshot: () => appSnapshots.capture(),
  relaunch: () => {
    shutdownBeforeQuit()
    app.relaunch()
    app.quit()
  },
})

function killSidecar() {
  if (!server) return
  server.stop()
  server = null
}

function ensureLoopbackNoProxy() {
  const loopback = ["127.0.0.1", "localhost", "::1"]
  const upsert = (key: string) => {
    const items = (process.env[key] ?? "")
      .split(",")
      .map((value: string) => value.trim())
      .filter((value: string) => Boolean(value))

    for (const host of loopback) {
      if (items.some((value: string) => value.toLowerCase() === host)) continue
      items.push(host)
    }

    process.env[key] = items.join(",")
  }

  upsert("NO_PROXY")
  upsert("no_proxy")
}

async function getSidecarPort() {
  const fromEnv = (process.env.WANLAICODE_PORT ?? process.env.OPENCODE_PORT)
  if (fromEnv) {
    const parsed = Number.parseInt(fromEnv, 10)
    if (!Number.isNaN(parsed)) return parsed
  }

  return await new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (typeof address !== "object" || !address) {
        server.close()
        reject(new Error("Failed to get port"))
        return
      }
      const port = address.port
      server.close(() => resolve(port))
    })
  })
}

function sqliteFileExists() {
  if (process.env.WANLAICODE_DB === ":memory:") return true

  const xdg = process.env.XDG_DATA_HOME
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".local", "share")
  return existsSync(join(base, "wanlaicode", "wanlaicode.db"))
}

let updateProgressWindow: BrowserWindow | null = null
let downloadedUpdateVersion: string | undefined
let downloadInProgress: Promise<void> | undefined
let downloadFailedError: Error | undefined
let downloadingVersion: string | undefined
let downloadCancellationToken: CancellationTokenInstance | undefined
let lastDownloadCancelled = false

// ── 更新通道管理 ──────────────────────────────────────────────────────────────
// 使用独立 electron-store（wanlaicode.update-channel）持久化用户所选通道。
// "prod" = 稳定版 S3 路径；"canary" = 干净正式版号、走 canary/ S3 路径（allowPrerelease 已非必需）。
const UPDATE_CHANNEL_STORE = "wanlaicode.update-channel"
const UPDATE_CHANNEL_KEY = "channel"

export function getCachedUpdateChannel(): "prod" | "canary" {
  try {
    return getStore(UPDATE_CHANNEL_STORE).get(UPDATE_CHANNEL_KEY) === "canary" ? "canary" : "prod"
  } catch {
    return "prod"
  }
}

export function setCachedUpdateChannel(channel: "prod" | "canary") {
  try {
    getStore(UPDATE_CHANNEL_STORE).set(UPDATE_CHANNEL_KEY, channel)
  } catch {}
}

// ── opt-out 降级标记（持久化）─────────────────────────────────────────────────
// 用户主动退出内测（canary→prod）后必须放行一次降级，否则会卡在内测包上。
// 原内存变量在重启后丢失：toggle 关内测→没检查更新就退出→重开则永久不降级。
// 这里持久化到同一个 update-channel store，跨重启有效，checkUpdate 消费一次即清。
const OPT_OUT_PENDING_KEY = "optOutPending"

function getOptOutPending(): boolean {
  try {
    return getStore(UPDATE_CHANNEL_STORE).get(OPT_OUT_PENDING_KEY) === true
  } catch {
    return false
  }
}

function setOptOutPending(v: boolean) {
  try {
    getStore(UPDATE_CHANNEL_STORE).set(OPT_OUT_PENDING_KEY, v)
  } catch {}
}

/**
 * 从打包内 app-update.yml 读取 S3 provider 配置（endpoint/region/bucket）。
 * 用此作为单一事实源，运行时 setFeedURL 只覆盖 path（通道路径），不重复硬编码 endpoint/bucket。
 * 解析失败返回 null，调用方降级为不调用 setFeedURL。
 */
function readBakedS3Config(): { endpoint?: string; region?: string; bucket: string; path?: string } | null {
  try {
    const ymlPath = join(process.resourcesPath, "app-update.yml")
    const raw = readFileSync(ymlPath, "utf-8")
    // 用简单行解析代替引入 yaml 库（app-update.yml 格式固定、无嵌套），避免新增依赖。
    const parsed: Record<string, string> = {}
    for (const line of raw.split("\n")) {
      const m = line.match(/^(\w+):\s*(.+)$/)
      if (m) parsed[m[1]] = m[2].trim().replace(/^["']|["']$/g, "")
    }
    if (parsed["provider"] !== "s3") return null
    const bucket = parsed["bucket"]
    if (!bucket) return null
    return {
      bucket,
      endpoint: parsed["endpoint"] || undefined,
      region: parsed["region"] || undefined,
      path: parsed["path"] || undefined,
    }
  } catch (e) {
    logger.warn("readBakedS3Config: 解析 app-update.yml 失败，setFeedURL 将被跳过", e)
    return null
  }
}

/**
 * 按 channel 配置 autoUpdater：
 * - allowPrerelease：canary=true（B-pure 后 canary 是干净版号，allowPrerelease 对其更新已冗余但保留无害）、prod=false
 * - setFeedURL：把 S3 path 切换到 "canary" 或 "prod" 子目录（B-pure 核心：不影响 allowPrerelease 语义）
 *
 * 源码确认（electron-updater@6.8.3 AppUpdater.js:382-385）：
 * checkForUpdates 先检查 this.clientPromise，非 null 则直接用，不再读 configOnDisk。
 * setFeedURL（AppUpdater.js:247）将 clientPromise 设为 resolved Promise，完全绕过打包内 app-update.yml。
 * 即：运行时 setFeedURL 覆盖 baked path 在源码层面成立；仍待真实构建 + S3 环境冒烟确认。
 */
export function applyUpdateChannel(channel: "prod" | "canary", opts: { allowDowngrade?: boolean } = {}) {
  autoUpdater.allowPrerelease = channel === "canary"
  // 默认不允许降级，仅在显式 opt-out / 命中撤回名单时由调用方传入 true。
  autoUpdater.allowDowngrade = opts.allowDowngrade ?? false
  const s3 = readBakedS3Config()
  if (s3) {
    // baked path 形如 "prod" 或 "prod-codex"；剥掉前导 channel 段，保留 "-<brand>" 后缀。
    // 这样 codex 品牌切换通道时不会丢 "-codex"（即 prod-codex → canary-codex，而非 canary）。
    const suffix = (s3.path ?? "prod").replace(/^(dev|beta|prod|canary)/, "")
    const targetPath = (channel === "canary" ? "canary" : "prod") + suffix
    autoUpdater.setFeedURL({
      provider: "s3",
      bucket: s3.bucket,
      ...(s3.endpoint ? { endpoint: s3.endpoint } : {}),
      ...(s3.region ? { region: s3.region } : {}),
      path: targetPath,
      channel: "latest",
    })
    logger.log("update channel applied", { channel, targetPath, s3Found: true })
  } else {
    logger.log("update channel applied", { channel, s3Found: false })
  }
}

// 从 sidecar 取后端撤回版本名单（全局名单）；失败/超时返回 []（安全：不降级）。
async function fetchWithdrawnVersions(): Promise<string[]> {
  // 单一 8s 总预算：同时覆盖 serverReady 等待与 fetch 两段，避免串行叠加成最坏 16s。
  // 超时统一 abort 同一个 controller —— serverReady race 与 fetch 都挂在它上面。
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 8_000)
  try {
    // serverReady 可能长时间不 resolve（sidecar 起不来/登录态缺失）；race 一个监听 abort 的 promise，
    // 超时即 resolve(null)，拿不到就返回 []（安全侧：不降级），避免 checkUpdate 被无限阻塞。
    const ready = await Promise.race([
      serverReady.promise,
      new Promise<null>((r) => controller.signal.addEventListener("abort", () => r(null), { once: true })),
    ])
    if (!ready || controller.signal.aborted || !ready.username || !ready.password) return []
    const credentials = Buffer.from(`${ready.username}:${ready.password}`).toString("base64")
    const res = await fetch(`${ready.url}/wanlaicode/user-center/update-channel`, {
      headers: { Authorization: `Basic ${credentials}` },
      signal: controller.signal,
    })
    if (!res.ok) return []
    const body = (await res.json()) as { withdrawn_versions?: Array<{ version?: string }> }
    return (body.withdrawn_versions ?? []).map((v) => v.version).filter((v): v is string => !!v)
  } catch {
    return []
  } finally {
    clearTimeout(timeout)
  }
}

function setupAutoUpdater() {
  if (!UPDATER_ENABLED) return
  autoUpdater.logger = logger
  autoUpdater.channel = "latest"
  autoUpdater.allowPrerelease = false
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on("download-progress", (info) => {
    dispatchUpdateProgress({
      phase: "downloading",
      version: downloadingVersion ?? downloadedUpdateVersion,
      percent: typeof info.percent === "number" ? info.percent : 0,
      bytesPerSecond: typeof info.bytesPerSecond === "number" ? info.bytesPerSecond : 0,
      transferred: typeof info.transferred === "number" ? info.transferred : 0,
      total: typeof info.total === "number" ? info.total : 0,
    })
  })
  autoUpdater.on("update-downloaded", (event) => {
    downloadedUpdateVersion = event.version ?? downloadingVersion
  })
  autoUpdater.on("error", (err) => {
    // CancellationError 走 lastDownloadCancelled 分支显示为「已取消」
    if (lastDownloadCancelled) return
    dispatchUpdateProgress({
      phase: "error",
      message: err instanceof Error ? err.message : String(err),
    })
  })
  logger.log("auto updater configured", {
    channel: autoUpdater.channel,
    allowPrerelease: autoUpdater.allowPrerelease,
    allowDowngrade: autoUpdater.allowDowngrade,
    currentVersion: app.getVersion(),
  })
  // 按用户持久化的通道配置 allowPrerelease 与 S3 path
  applyUpdateChannel(getCachedUpdateChannel())
}

function closeUpdateProgressWindow() {
  if (!updateProgressWindow) return
  const win = updateProgressWindow
  updateProgressWindow = null
  if (!win.isDestroyed()) win.close()
}

// 记最近一次想发的 progress。新建窗口时 did-finish-load.once 发的就是这个，
// 不是闭包里的 initial：避免 open(preparing) → 紧跟着 dispatchUpdateProgress(installing)
// 这种 race 下，installing 在 did-finish-load 前被丢/或被随后的 initial preparing 覆盖。
let lastUpdateProgress: UpdateProgress | null = null

function dispatchUpdateProgress(progress: UpdateProgress) {
  lastUpdateProgress = progress
  if (!updateProgressWindow || updateProgressWindow.isDestroyed()) return
  sendUpdateProgress(updateProgressWindow, progress)
}

function openUpdateProgressWindow(initial: UpdateProgress) {
  lastUpdateProgress = initial
  if (updateProgressWindow && !updateProgressWindow.isDestroyed()) {
    updateProgressWindow.show()
    updateProgressWindow.focus()
    sendUpdateProgress(updateProgressWindow, initial)
    return updateProgressWindow
  }
  const win = createUpdateProgressWindow(mainWindow)
  updateProgressWindow = win
  win.on("closed", () => {
    if (updateProgressWindow === win) updateProgressWindow = null
    // simulate confirm 阶段关窗 = 用户点了「稍后」；不复位会让下一次真正的
    // proceedWithInstall→confirmInstall 误走 simulate 模拟安装路径。
    simulationConfirmActive = false
    lastUpdateProgress = null
  })
  // 等渲染端首帧装好监听后再补一次状态。发 lastUpdateProgress 而非闭包的 initial，
  // 这样新建窗口后立刻 dispatch 的新 phase 不会被 stale initial 覆盖。
  win.webContents.once("did-finish-load", () => {
    if (lastUpdateProgress) sendUpdateProgress(win, lastUpdateProgress)
  })
  return win
}

function startBackgroundDownload(version: string) {
  if (downloadedUpdateVersion === version) return
  if (downloadInProgress) return
  logger.log("starting background update download", { version })
  downloadFailedError = undefined
  lastDownloadCancelled = false
  downloadingVersion = version
  const token = new CancellationToken()
  downloadCancellationToken = token
  // catch swallows the error so a dangling (un-awaited) promise never
  // produces an unhandledRejection; installUpdate inspects downloadFailedError
  // instead of relying on the promise rejection to propagate.
  downloadInProgress = autoUpdater
    .downloadUpdate(token)
    .then(() => {
      logger.log("update download completed", { version })
      downloadedUpdateVersion = version
    })
    .catch((err: unknown) => {
      if (token.cancelled) {
        logger.log("update download cancelled", { version })
        lastDownloadCancelled = true
      } else {
        logger.error("update download failed", err)
        downloadFailedError = err instanceof Error ? err : new Error(String(err))
      }
    })
    .finally(() => {
      downloadInProgress = undefined
      if (downloadCancellationToken === token) downloadCancellationToken = undefined
    })
}

let simulationCancelled = false
// dev simulate 触发 confirm-install 时设 true，让 confirmInstall() 走"模拟安装"而非真 quitAndInstall。
let simulationConfirmActive = false

function cancelDownload() {
  simulationCancelled = true
  const token = downloadCancellationToken
  if (!token || token.cancelled) return
  logger.log("cancel update download requested")
  lastDownloadCancelled = true
  token.cancel()
}

type SimulationScenario = "success" | "cancel" | "error" | "confirm"

async function simulateUpdateCheckFlow(scenario: SimulationScenario) {
  const fakeVersion = "0.0.99-debug"
  logger.log("[debug] simulating full update flow", { scenario })
  const response = await dialog.showMessageBox({
    type: "info",
    message: `Update ${fakeVersion} is available. Download and restart now?`,
    title: "Update Available",
    buttons: ["Restart", "Later"],
    defaultId: 0,
    cancelId: 1,
  })
  if (response.response !== 0) {
    logger.log("[debug] full flow dismissed by user")
    return
  }
  await simulateUpdateProgress(scenario)
}

async function simulateUpdateProgress(scenario: SimulationScenario) {
  logger.log("[debug] simulating update progress", { scenario })
  simulationCancelled = false
  simulationConfirmActive = false
  const fakeVersion = "0.0.99-debug"
  const win = openUpdateProgressWindow({ phase: "preparing", version: fakeVersion })

  const total = 120 * 1024 * 1024
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

  await sleep(400)
  if (win.isDestroyed()) return

  if (scenario === "cancel") {
    // 模拟用户在 ~1.2s 后点击「取消」
    setTimeout(() => {
      simulationCancelled = true
    }, 1200)
  }

  for (let percent = 0; percent <= 100; percent += 5) {
    if (win.isDestroyed()) return
    if (simulationCancelled) {
      sendUpdateProgress(win, { phase: "cancelled" })
      return
    }
    if (scenario === "error" && percent >= 35) {
      sendUpdateProgress(win, {
        phase: "error",
        message: "Simulated download error: connection reset (ECONNRESET)",
      })
      return
    }
    sendUpdateProgress(win, {
      phase: "downloading",
      version: fakeVersion,
      percent,
      bytesPerSecond: 1.2 * 1024 * 1024 + Math.random() * 600 * 1024,
      transferred: Math.floor((total * percent) / 100),
      total,
    })
    await sleep(220)
  }

  if (win.isDestroyed()) return

  if (scenario === "confirm") {
    // 模拟下载完后侦测到有 busy session，停在 confirm-install 等用户点按钮。
    // simulationConfirmActive 让 confirmInstall 走模拟安装而不是真 quitAndInstall；
    // 用户点「稍后」直接走 onClose → closeUpdateProgressWindow，跟真实路径一致。
    simulationConfirmActive = true
    sendUpdateProgress(win, { phase: "confirm-install", version: fakeVersion, busyCount: 3 })
    return
  }

  sendUpdateProgress(win, { phase: "installing", version: fakeVersion })
  await sleep(1500)
  if (!win.isDestroyed()) win.close()
}

async function checkUpdate() {
  if (!UPDATER_ENABLED) return { updateAvailable: false }
  // 取消标记仅对最近一次下载有效，新一轮检查时主动清零，
  // 避免后续 autoUpdater.on("error") 把陈旧 cancel 状态当成 silently-ok 吞掉真实错误。
  lastDownloadCancelled = false
  // 每次检查前重新应用通道设置，确保用户运行时切换后立即生效。
  // 仅当用户主动退出内测 或 当前版本命中后端撤回名单时才允许降级；否则默认不降级。
  // opt-out 标记持久化（跨重启有效），此处仅读取；待下方 checkForUpdates 成功返回后才消费一次。
  // 不在此处提前清标记：若检查失败（catch）会让 opt-out 永久丢失，用户卡在高版本；
  // 不清则下次检查自动重试，直到一次成功消费。
  const optOut = getOptOutPending()
  const withdrawn = await fetchWithdrawnVersions()
  // 撤回名单里的 version 必须与 app.getVersion()（含 -canary.<时间戳>.gSHA 后缀）精确一致，
  // 运维须填写完整构建版本号；此处仅 trim 容错首尾空白，不做 semver 归一/前缀匹配。
  const allowDowngrade = optOut || withdrawn.map((v) => v.trim()).includes(app.getVersion().trim())
  applyUpdateChannel(getCachedUpdateChannel(), { allowDowngrade })
  // 注意：即使本会话已下载过版本（downloadedUpdateVersion 有值）也照常请求远端 ——
  // 长时间挂着的 App 在下过一个中间版本后线上可能又发了更新版本，旧逻辑在这里直接短路
  // 返回已下载版本，导致永远检测不到真正的最新版（详见 update-decision.ts）。
  logger.log("checking for updates", {
    currentVersion: app.getVersion(),
    channel: autoUpdater.channel,
    allowPrerelease: autoUpdater.allowPrerelease,
    allowDowngrade,
    downloaded: downloadedUpdateVersion ?? null,
  })
  try {
    const result = await autoUpdater.checkForUpdates()
    // 检查成功才消费 opt-out 标记：失败走 catch 不清，保留给下次重试，避免标记永久丢失。
    if (optOut) setOptOutPending(false)
    const updateInfo = result?.updateInfo
    logger.log("update metadata fetched", {
      releaseVersion: updateInfo?.version ?? null,
      releaseDate: updateInfo?.releaseDate ?? null,
      releaseName: updateInfo?.releaseName ?? null,
      files: updateInfo?.files?.map((file) => file.url) ?? [],
    })
    const decision = resolveUpdateDecision({
      downloaded: downloadedUpdateVersion,
      remoteVersion: updateInfo?.version,
      remoteAvailable: result?.isUpdateAvailable !== false,
    })
    if (decision.action === "none") {
      logger.log("no update available", {
        reason: "provider returned no newer version",
      })
      return { updateAvailable: false }
    }
    if (decision.action === "use-cached") {
      logger.log("returning cached downloaded update", { version: decision.version })
      return { updateAvailable: true, version: decision.version }
    }
    // decision.action === "download"
    if (decision.supersedes) {
      // 已下载的中间版本被更新的版本顶替：复位缓存，改下新版本。此时下载早已完成
      // （downloadedUpdateVersion 仅在下载完成时置值，故 downloadInProgress 必为空），
      // 无需取消在途下载，startBackgroundDownload 的 guard 也会因复位而放行。
      logger.log("newer release supersedes downloaded update", {
        downloaded: decision.supersedes,
        latest: decision.version,
      })
      downloadedUpdateVersion = undefined
    } else {
      logger.log("update available", { version: decision.version })
    }
    startBackgroundDownload(decision.version)
    return { updateAvailable: true, version: decision.version }
  } catch (error) {
    logger.error("update check failed", error)
    // 远端检查失败但本地已下好某版本：仍提供它，至少能装上比当前新的版本。
    if (downloadedUpdateVersion) {
      return { updateAvailable: true, version: downloadedUpdateVersion }
    }
    return { updateAvailable: false, failed: true }
  }
}

function runQuitAndInstall(version: string) {
  // 同步 throw → catch 直接把窗口切到 error；非同步异常（install 移交挂起、OS 拒退）
  // 由 autoUpdater.on("error") 兜底。两条路径都让用户能用 Close 按钮逃出 frameless 窗口。
  logger.log("installing downloaded update", { version })
  // macOS 上 autoUpdater.quitAndInstall() 会「先关所有窗口、再 app.quit()」，关窗早于
  // before-quit。此时若 quitting 仍为 false，主窗口的 close-to-tray 拦截器会 preventDefault
  // 把窗口藏进托盘 → 窗口永不关闭 → app.quit() 永不触发 → 进程留存、托盘还在、更新装不上。
  // 必须先置 quitting=true 让窗口真正关闭，安装才能落地。
  markAppQuitting()
  killSidecar()
  try {
    // isSilent=true：Windows NSIS 走 /S 跳过安装向导（assisted 模式下 /S 仍然生效，
    // 直接复用首次安装时记下的目录），否则用户每次更新都要点过整个安装器。
    // isForceRunAfter=true：装完自动拉起新版 app；isSilent 路径默认是不重启的。
    // macOS/Linux 端忽略这两个参数，行为不变。
    autoUpdater.quitAndInstall(true, true)
  } catch (err) {
    logger.error("quitAndInstall threw", err)
    // 同步抛错 = 安装没真正开始、app 不会退；恢复 close-to-tray，否则用户随手关窗就直接退出
    clearAppQuitting()
    dispatchUpdateProgress({
      phase: "error",
      message: err instanceof Error ? err.message : String(err),
    })
  }
}

// 机器休眠时定时器停摆，唤醒后 sidecar 里的 OAuth token 可能已过期；触发一次协调器刷新，
// 避免用户唤醒后第一个请求撞上「登录已过期」或卡在刷新上。失败只记日志，不打扰用户
// （sidecar 路由本身也 catch 不抛，这里再兜底一层网络异常）。
async function refreshOAuthOnResume() {
  try {
    const ready = await serverReady.promise
    const headers: HeadersInit =
      ready.username && ready.password
        ? { Authorization: `Basic ${Buffer.from(`${ready.username}:${ready.password}`).toString("base64")}` }
        : {}
    await fetch(new URL("/wanlaicode/oauth/refresh", ready.url), { method: "POST", headers })
  } catch (error) {
    logger.log("resume oauth refresh failed", { error: String(error) })
  }
}

// 询问 sidecar 当前有多少 session 处于 busy/retry。idle session 在 SessionStatus.set 时
// 会从 map 里 delete 掉，所以 /session/status 返回的 record 大小直接 = 还在跑的 session 数。
// 任何异常都视作 0（探测失败比误拦截安装更安全：updater 本来已经走到 ready-to-install，
// 用户主动点了「立即重启」；这里失败回退到原本的直装路径不会比现状差）。
async function countBusySessions(): Promise<number> {
  try {
    const ready = await serverReady.promise
    if (!ready.username || !ready.password) return 0
    const credentials = Buffer.from(`${ready.username}:${ready.password}`).toString("base64")
    const res = await fetch(`${ready.url}/session/status`, {
      headers: { Authorization: `Basic ${credentials}` },
    })
    if (!res.ok) return 0
    const body = (await res.json()) as Record<string, unknown>
    return Object.keys(body).length
  } catch (err) {
    logger.error("countBusySessions failed", err)
    return 0
  }
}

// 下载完之后、装之前的共用收尾：先看有没有 busy session，有就把窗口切到 confirm-install
// 等用户决定；没有则按原路径直装。confirmInstall() 是用户在 confirm-install 阶段点
// 「立即安装」时的入口，跟这里的 else 分支保持一致的 installing→delay→runQuitAndInstall 节奏。
async function proceedWithInstall(version: string) {
  const busy = await countBusySessions()
  if (busy > 0) {
    logger.log("update install gated by busy sessions", { version, busy })
    dispatchUpdateProgress({ phase: "confirm-install", version, busyCount: busy })
    return
  }
  dispatchUpdateProgress({ phase: "installing", version })
  await delay(800)
  runQuitAndInstall(version)
}

async function confirmInstall() {
  if (simulationConfirmActive) {
    // dev simulate 路径：不真退也不真装，模拟 installing 后关窗即可。
    // 必须在 UPDATER_ENABLED guard 之前——dev 包 UPDATER_ENABLED 永远是 false，
    // 但 DEBUG_UPDATER 是 true，simulate 流程能跑到 confirm-install，用户点
    // 「立即重启」却被 guard 挡掉无反应。
    simulationConfirmActive = false
    logger.log("[debug] simulate confirm install accepted")
    const fakeVersion = "0.0.99-debug"
    dispatchUpdateProgress({ phase: "installing", version: fakeVersion })
    await delay(1500)
    closeUpdateProgressWindow()
    return
  }
  if (!UPDATER_ENABLED) return
  const version = downloadedUpdateVersion
  if (!version) {
    logger.log("confirmInstall ignored", { reason: "no downloaded update" })
    return
  }
  logger.log("user confirmed install with busy sessions", { version })
  dispatchUpdateProgress({ phase: "installing", version })
  await delay(800)
  runQuitAndInstall(version)
}

async function installUpdate() {
  if (!UPDATER_ENABLED) return

  const version = downloadedUpdateVersion ?? downloadingVersion

  if (downloadedUpdateVersion) {
    // 先用 preparing 占位，proceedWithInstall 会按 busy 判断切到 confirm-install 或 installing；
    // 直接开 installing 再切 confirm-install 会闪一帧「正在安装」误导用户。
    openUpdateProgressWindow({ phase: "preparing", version: downloadedUpdateVersion })
    await proceedWithInstall(downloadedUpdateVersion)
    return
  }

  openUpdateProgressWindow({ phase: downloadInProgress ? "downloading" : "preparing", version, percent: 0, bytesPerSecond: 0, transferred: 0, total: 0 } as UpdateProgress)

  if (!downloadInProgress) {
    if (version) startBackgroundDownload(version)
  }

  if (downloadInProgress) {
    logger.log("install update waiting for in-progress download")
    await downloadInProgress
  }

  if (downloadedUpdateVersion) {
    await proceedWithInstall(downloadedUpdateVersion)
    return
  }

  if (lastDownloadCancelled) {
    logger.log("install update aborted: download cancelled")
    dispatchUpdateProgress({ phase: "cancelled" })
    return
  }

  if (downloadFailedError) {
    logger.error("install update aborted: download failed", downloadFailedError)
    dispatchUpdateProgress({
      phase: "error",
      message: downloadFailedError.message,
    })
    return
  }

  logger.log("install update skipped", { reason: "no downloaded update ready" })
  dispatchUpdateProgress({
    phase: "error",
    message: "No update is ready to install.",
  })
}

async function checkForUpdates(alertOnFail: boolean) {
  if (!UPDATER_ENABLED) return
  logger.log("checkForUpdates invoked", { alertOnFail })
  const result = await checkUpdate()
  if (!result.updateAvailable) {
    if (result.failed) {
      logger.log("no update decision", { reason: "update check failed" })
      if (!alertOnFail) return
      await dialog.showMessageBox({
        type: "error",
        message: "Update check failed.",
        title: "Update Error",
      })
      return
    }

    logger.log("no update decision", { reason: "already up to date" })
    if (!alertOnFail) return
    await dialog.showMessageBox({
      type: "info",
      message: "You're up to date.",
      title: "No Updates",
    })
    return
  }

  const response = await dialog.showMessageBox({
    type: "info",
    message: `Update ${result.version ?? ""} is available. Download and restart now?`,
    title: "Update Available",
    buttons: ["Restart", "Later"],
    defaultId: 0,
    cancelId: 1,
  })
  logger.log("update prompt response", {
    version: result.version ?? null,
    restartNow: response.response === 0,
  })
  if (response.response === 0) {
    await installUpdate()
  }
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function defer<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}
