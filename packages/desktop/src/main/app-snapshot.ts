import { execFile, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { app, desktopCapturer, globalShortcut, screen, shell, systemPreferences, type BrowserWindow } from "electron"
import type {
  AppSnapshotCapture,
  AppSnapshotConfig,
  AppSnapshotEvent,
  AppSnapshotPermission,
  AppSnapshotPermissionState,
} from "../preload/types"
import { appSnapshotThumbnailSize, matchAppSnapshotSource } from "./app-snapshot-utils"

type InspectSuccess = {
  ok: true
  appName: string
  bundleIdentifier: string | null
  processIdentifier: number
  windowID: number
  windowTitle: string
  windowX: number
  windowY: number
  windowWidth: number
  windowHeight: number
  accessibilityText: string
  accessibilityTrusted: boolean
  textTruncated: boolean
}

type InspectFailure = {
  ok: false
  code: string
  message: string
}

type HelperEvent = { type: "ready" } | { type: "shortcut" } | { type: "error"; code?: string }
type AccessibilityResult = { ok: true; trusted: boolean }
type InspectResult = InspectSuccess | InspectFailure
type AppSnapshotErrorCode = Extract<AppSnapshotEvent, { type: "error" }>["code"]
type MonitorProcess = ReturnType<typeof spawn>

const fallbackAccelerator = "CommandOrControl+Shift+2"
const manualCaptureDelay = 250

function helperPath() {
  if (process.env.WANLAICODE_APP_SNAPSHOT_HELPER) return process.env.WANLAICODE_APP_SNAPSHOT_HELPER
  if (app.isPackaged) return join(process.resourcesPath, "native/swift-build/app-snapshot-helper")
  return join(dirname(fileURLToPath(import.meta.url)), "../../native/swift-build/app-snapshot-helper")
}

function parseLine<T>(input: string) {
  const line = input
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean)
    .at(-1)
  if (!line) return
  try {
    return JSON.parse(line) as T
  } catch {
    return
  }
}

function runHelper<T>(args: string[], timeout = 5_000) {
  return new Promise<{ result?: T; error?: Error }>((resolve) => {
    execFile(helperPath(), args, { timeout, maxBuffer: 2 * 1024 * 1024 }, (error, stdout) => {
      const result = parseLine<T>(stdout)
      if (result) {
        resolve({ result })
        return
      }
      resolve({ error: error ?? new Error("The app snapshot helper returned no result") })
    })
  })
}

async function inspect() {
  const response = await runHelper<InspectResult>(["inspect"])
  if (response.result) return response.result
  return {
    ok: false,
    code: response.error && "killed" in response.error && response.error.killed ? "inspect_timeout" : "inspect_failed",
    message: response.error?.message ?? "The app snapshot helper returned no result",
  } satisfies InspectFailure
}

async function helperAccessibility(prompt = false) {
  if (!existsSync(helperPath())) return false
  const response = await runHelper<AccessibilityResult>(["accessibility", ...(prompt ? ["prompt"] : [])], 2_000)
  return response.result?.ok === true && response.result.trusted
}

function permissionState(
  monitor: MonitorProcess | undefined,
  config: AppSnapshotConfig,
  accessibilityTrusted: boolean,
): AppSnapshotPermissionState {
  if (process.platform !== "darwin") {
    return { supported: false, accessibility: "unavailable", screen: "unavailable", shortcut: "unavailable" }
  }
  const accessibility = accessibilityTrusted ? "granted" : "denied"
  const screen = systemPreferences.getMediaAccessStatus("screen")
  const shortcut =
    config.shortcut === "disabled"
      ? "disabled"
      : monitor && !monitor.killed
        ? "active"
        : accessibility === "granted"
          ? "inactive"
          : "permission-required"
  return { supported: true, accessibility, screen, shortcut }
}

export function createAppSnapshotService(input: {
  getMainWindow: () => BrowserWindow | null
  showMainWindow: () => void
  onError: (name: string, error: unknown, data?: Record<string, unknown>) => void
}) {
  let config: AppSnapshotConfig = { shortcut: "disabled", playSound: true }
  let monitor: MonitorProcess | undefined
  let restartTimer: ReturnType<typeof setTimeout> | undefined
  let stopping = false
  let capturing = false
  let accessibilityTrusted = false

  const send = (event: AppSnapshotEvent) => {
    const win = input.getMainWindow()
    if (!win || win.isDestroyed()) return
    win.webContents.send("app-snapshot-event", event)
  }

  const stopMonitor = () => {
    if (restartTimer) clearTimeout(restartTimer)
    restartTimer = undefined
    const current = monitor
    monitor = undefined
    if (current && !current.killed) current.kill()
  }

  const fail = (code: AppSnapshotErrorCode, message?: string) => {
    send({ type: "error", code, message, permissions: permissionState(monitor, config, accessibilityTrusted) })
    if (process.platform === "darwin") app.show()
    input.showMainWindow()
  }

  const capture = async (origin: "shortcut" | "manual" = "manual") => {
    if (capturing) return false
    if (process.platform !== "darwin") {
      fail("unsupported")
      return false
    }

    capturing = true
    send({ type: "capturing", origin })
    try {
      if (origin === "manual" && input.getMainWindow()?.isFocused()) {
        app.hide()
        await new Promise((resolve) => setTimeout(resolve, manualCaptureDelay))
      }
      const target = await inspect()
      if (!target.ok) {
        fail(target.code === "inspect_timeout" ? "timeout" : "no-window", target.message)
        return false
      }

      const display = screen.getDisplayMatching({
        x: target.windowX,
        y: target.windowY,
        width: target.windowWidth,
        height: target.windowHeight,
      })
      const sources = await desktopCapturer.getSources({
        types: ["screen"],
        thumbnailSize: appSnapshotThumbnailSize(display),
        fetchWindowIcons: false,
      })
      const source = matchAppSnapshotSource(display.id, sources)
      if (!source || source.thumbnail.isEmpty()) {
        fail(systemPreferences.getMediaAccessStatus("screen") === "granted" ? "no-window" : "screen-permission")
        return false
      }

      const png = source.thumbnail.toPNG()
      const bytes = new Uint8Array(png.byteLength)
      bytes.set(png)
      const size = source.thumbnail.getSize()
      const snapshot: AppSnapshotCapture = {
        id: randomUUID(),
        appName: target.appName,
        bundleIdentifier: target.bundleIdentifier ?? undefined,
        windowTitle: target.windowTitle,
        displayID: String(display.id),
        accessibilityText: target.accessibilityText,
        accessibilityTrusted: target.accessibilityTrusted,
        textTruncated: target.textTruncated,
        capturedAt: Date.now(),
        image: {
          buffer: bytes.buffer,
          width: size.width,
          height: size.height,
        },
      }
      send({ type: "captured", origin, snapshot })
      if (config.playSound) shell.beep()
      app.show()
      input.showMainWindow()
      return true
    } catch (error) {
      input.onError("app-snapshot.capture.failed", error)
      fail(systemPreferences.getMediaAccessStatus("screen") === "granted" ? "capture-failed" : "screen-permission")
      return false
    } finally {
      capturing = false
    }
  }

  const startMonitor = () => {
    stopMonitor()
    globalShortcut.unregister(fallbackAccelerator)
    if (stopping || process.platform !== "darwin" || config.shortcut === "disabled") return

    globalShortcut.register(fallbackAccelerator, () => void capture("shortcut"))
    if (!accessibilityTrusted || !existsSync(helperPath())) return

    const child = spawn(helperPath(), ["listen", config.shortcut], { stdio: ["ignore", "pipe", "pipe"] })
    monitor = child
    let stdout = ""
    child.stdout?.setEncoding("utf8")
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk
      const lines = stdout.split("\n")
      stdout = lines.pop() ?? ""
      for (const line of lines) {
        const event = parseLine<HelperEvent>(line)
        if (event?.type === "shortcut") void capture("shortcut")
        if (event?.type === "error") {
          accessibilityTrusted = false
          fail("accessibility-permission")
        }
      }
    })
    child.on("error", (error) => input.onError("app-snapshot.monitor.failed", error))
    child.on("exit", (code) => {
      if (monitor !== child) return
      monitor = undefined
      if (stopping || config.shortcut === "disabled" || code === 2) return
      restartTimer = setTimeout(startMonitor, 1_000)
    })
  }

  return {
    async configure(next: AppSnapshotConfig) {
      config = next
      accessibilityTrusted = await helperAccessibility()
      startMonitor()
      return permissionState(monitor, config, accessibilityTrusted)
    },
    async permissions() {
      const trusted = await helperAccessibility()
      if (trusted !== accessibilityTrusted) {
        accessibilityTrusted = trusted
        startMonitor()
      }
      return permissionState(monitor, config, accessibilityTrusted)
    },
    async requestPermission(permission: AppSnapshotPermission) {
      if (process.platform !== "darwin") return permissionState(monitor, config, accessibilityTrusted)
      if (permission === "accessibility") {
        accessibilityTrusted = await helperAccessibility(true)
      } else {
        await desktopCapturer
          .getSources({ types: ["screen"], thumbnailSize: { width: 1, height: 1 } })
          .catch(() => undefined)
        if (systemPreferences.getMediaAccessStatus("screen") === "denied") {
          await shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
        }
      }
      startMonitor()
      return permissionState(monitor, config, accessibilityTrusted)
    },
    capture,
    stop() {
      stopping = true
      stopMonitor()
      globalShortcut.unregister(fallbackAccelerator)
    },
  }
}
