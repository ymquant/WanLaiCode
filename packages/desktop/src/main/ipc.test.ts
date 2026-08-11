import { beforeEach, describe, expect, mock, test } from "bun:test"
import { fileURLToPath } from "node:url"

const handlers = new Map<string, (...args: any[]) => unknown>()
const listeners = new Map<string, (...args: any[]) => unknown>()
const windowSends = [mock(), mock()]
const openExternal = mock(() => Promise.resolve())
let nativeThemeUpdated: (() => void) | undefined
let saveDialogResult: { canceled: boolean; filePath?: string } = { canceled: true }
const showSaveDialog = mock(async () => saveDialogResult)
type MockWindow = {
  isDestroyed: () => boolean
  isMinimized: () => boolean
  restore: () => void
  show: () => void
  focus: () => void
  webContents: {
    isDestroyed: () => boolean
    send: (channel: string, href?: string) => void
  }
}
let browserWindowFromWebContents: MockWindow | undefined

class MockNotification {
  readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  readonly show = mock(() => {})
  readonly close = mock(() => {})

  constructor(readonly options: { title: string; body?: string }) {
    notificationInstances.push(this)
  }

  on(event: string, listener: (...args: unknown[]) => void) {
    const current = this.listeners.get(event) ?? []
    current.push(listener)
    this.listeners.set(event, current)
    return this
  }

  emit(event: string, ...args: unknown[]) {
    this.listeners.get(event)?.forEach((listener) => listener(...args))
  }
}

const notificationInstances: MockNotification[] = []

mock.module("electron", () => ({
  default: {},
  app: {
    isPackaged: false,
    getAppPath: () => "/mock/app/path",
    getVersion: () => "0.0.0-test",
    getAppMetrics: () => [],
    getPath: () => "/tmp/wanlaicode-test",
  },
  BrowserWindow: class {
    static getAllWindows() {
      return windowSends.map((send) => ({
        webContents: { send },
      }))
    }
    static fromWebContents() {
      return browserWindowFromWebContents
    }
    webContents = {
      send: () => undefined,
      setWindowOpenHandler: () => undefined,
      isDestroyed: () => false,
    }
    isDestroyed() {
      return false
    }
    isFocused() {
      return false
    }
    isMinimized() {
      return false
    }
    focus() {}
    show() {}
    restore() {}
    setMenuBarVisibility() {}
    once() {}
    loadURL() {
      return Promise.resolve()
    }
  },
  Menu: {
    buildFromTemplate: () => ({}),
    setApplicationMenu: () => undefined,
  },
  Tray: class {
    destroy() {}
    isDestroyed() {
      return false
    }
    on() {}
    popUpContextMenu() {}
    setToolTip() {}
  },
  WebContentsView: class {
    webContents = {
      setWindowOpenHandler: () => undefined,
      on: () => undefined,
      canGoBack: () => false,
      canGoForward: () => false,
      isLoading: () => false,
      getTitle: () => "",
      getURL: () => "",
      loadURL: () => Promise.resolve(),
    }
    setBackgroundColor() {}
  },
  Notification: MockNotification,
  clipboard: {
    readImage: () => ({
      isEmpty: () => true,
    }),
  },
  ipcMain: {
    handle: mock((channel: string, fn: (...args: any[]) => unknown) => {
      handlers.set(channel, fn)
    }),
    on: mock((channel: string, fn: (...args: any[]) => unknown) => {
      listeners.set(channel, fn)
    }),
  },
  dialog: {
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    showSaveDialog,
  },
  net: {},
  nativeImage: {
    createEmpty: () => ({ isEmpty: () => true }),
    createFromPath: () => ({ isEmpty: () => true }),
  },
  nativeTheme: {
    shouldUseDarkColors: false,
    on: mock((event: string, cb: () => void) => {
      if (event === "updated") nativeThemeUpdated = cb
    }),
  },
  protocol: {
    registerSchemesAsPrivileged: () => undefined,
    isProtocolHandled: () => false,
    handle: () => undefined,
  },
  screen: {
    getPrimaryDisplay: () => ({
      workArea: {
        width: 1920,
        height: 1080,
      },
    }),
    getDisplayMatching: () => ({
      workArea: {
        width: 1920,
        height: 1080,
      },
    }),
  },
  shell: {
    openExternal,
    openPath: () => Promise.resolve(""),
  },
}))

mock.module("./logging", () => ({
  tail: () => "backend log tail token=private-token",
}))

const electron = await import("electron")
const { registerIpcHandlers } = await import("./ipc")

describe("desktop ipc handlers", () => {
  beforeEach(() => {
    handlers.clear()
    listeners.clear()
    openExternal.mockClear()
    windowSends.forEach((send) => send.mockClear())
    saveDialogResult = { canceled: true }
    showSaveDialog.mockClear()
    browserWindowFromWebContents = undefined
    notificationInstances.length = 0
  })

  const createDeps = (overrides: Partial<Parameters<typeof registerIpcHandlers>[0]> = {}) => ({
    killSidecar: () => {},
    awaitInitialization: async () => ({ url: "http://127.0.0.1:1", username: null, password: null }),
    getWindowConfig: () => ({ updaterEnabled: false, windowsBackdrop: "none" as const }),
    consumeInitialDeepLinks: () => [],
    getDefaultServerUrl: () => null,
    setDefaultServerUrl: () => {},
    getWslConfig: async () => ({ enabled: false }),
    setWslConfig: () => {},
    parseMarkdown: (markdown: string) => markdown,
    checkAppExists: () => true,
    getAppIcon: async () => null,
    listInstalledOpeners: async () => [],
    wslPath: async (value: string) => value,
    resolveAppPath: async () => null,
    loadingWindowComplete: () => {},
    runUpdater: () => {},
    checkUpdate: async () => ({ updateAvailable: false }),
    installUpdate: () => {},
    confirmInstall: () => {},
    cancelUpdate: () => {},
    closeUpdateWindow: () => {},
    setBackgroundColor: () => {},
    openMainWindow: () => {},
    openLoginWindow: () => {},
    newWindow: () => {},
    getMainWindow: () => null,
    setTrayLocale: () => {},
    relaunch: () => {},
    configureAppSnapshots: async () => ({ supported: false, accessibility: "unavailable" as const, screen: "unavailable" as const, shortcut: "unavailable" as const }),
    getAppSnapshotPermissions: async () => ({ supported: false, accessibility: "unavailable" as const, screen: "unavailable" as const, shortcut: "unavailable" as const }),
    requestAppSnapshotPermission: async () => ({ supported: false, accessibility: "unavailable" as const, screen: "unavailable" as const, shortcut: "unavailable" as const }),
    captureAppSnapshot: async () => false,
    ...overrides,
  })

  test("open-main-window returns a cloneable primitive", () => {
    registerIpcHandlers(createDeps())

    const mainHandler = handlers.get("open-main-window")
    const loginHandler = handlers.get("open-login-window")

    expect(mainHandler).toBeDefined()
    expect(loginHandler).toBeDefined()
    expect(mainHandler?.()).toBe(true)
    expect(loginHandler?.()).toBe(true)
  })

  test("read-local-file returns text content for the built-in file viewer", () => {
    registerIpcHandlers(createDeps())

    const result = handlers.get("read-local-file")?.({}, fileURLToPath(import.meta.url))

    // 覆盖工作区外文件所使用的 Electron 主进程只读通道，避免再次退回系统编辑器。
    expect(result).toMatchObject({ type: "text" })
    expect((result as { content: string }).content).toContain('describe("desktop ipc handlers"')
  })

  test("get-window-config forwards windowsBackdrop so renderer can set data-windows-backdrop", () => {
    registerIpcHandlers(
      createDeps({
        getWindowConfig: () => ({ updaterEnabled: true, windowsBackdrop: "mica" }),
      }),
    )

    const handler = handlers.get("get-window-config")
    expect(handler).toBeDefined()
    expect(handler?.()).toEqual({ updaterEnabled: true, windowsBackdrop: "mica" })
  })

  test("relaunch delegates to injected dependency", () => {
    const relaunch = mock(() => {})
    registerIpcHandlers(createDeps({ relaunch }))

    const relaunchHandler = listeners.get("relaunch")

    expect(relaunchHandler).toBeDefined()
    relaunchHandler?.()
    expect(relaunch).toHaveBeenCalledTimes(1)
  })

  test("native notification click restores the window and forwards its session href", () => {
    const restore = mock(() => {})
    const show = mock(() => {})
    const focus = mock(() => {})
    const send = mock(() => {})
    browserWindowFromWebContents = {
      isDestroyed: () => false,
      isMinimized: () => true,
      restore,
      show,
      focus,
      webContents: {
        isDestroyed: () => false,
        send,
      },
    }
    registerIpcHandlers(createDeps())

    listeners.get("show-notification")?.(
      { sender: { isDestroyed: () => false, send: mock(() => {}) } },
      "回复已就绪",
      "打招呼",
      "/workspace/session/ses_123",
    )

    expect(notificationInstances).toHaveLength(1)
    expect(notificationInstances[0]?.options).toEqual({ title: "回复已就绪", body: "打招呼" })
    expect(notificationInstances[0]?.show).toHaveBeenCalledTimes(1)

    notificationInstances[0]?.emit("click", {})

    expect(restore).toHaveBeenCalledTimes(1)
    expect(show).toHaveBeenCalledTimes(1)
    expect(focus).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith("notification-click", "/workspace/session/ses_123")
  })

  test("keeps open-link limited to http URLs and routes local html through the dedicated system-browser channel", () => {
    registerIpcHandlers(createDeps())

    const openLink = listeners.get("open-link")
    const openSystemBrowserLink = listeners.get("open-system-browser-link")

    expect(openLink).toBeDefined()
    expect(openSystemBrowserLink).toBeDefined()

    openLink?.({}, "https://example.com/path")
    openLink?.({}, "file:///C:/workspace/report.html")
    openSystemBrowserLink?.({}, "file:///C:/workspace/report.html")
    openSystemBrowserLink?.({}, "file:///C:/workspace/readme.ts")

    expect(openExternal).toHaveBeenCalledTimes(2)
    expect(openExternal).toHaveBeenNthCalledWith(1, "https://example.com/path")
    expect(openExternal).toHaveBeenNthCalledWith(2, "file:///C:/workspace/report.html")
  })

  test("get-native-theme-mode returns the Electron native theme mode", () => {
    registerIpcHandlers(createDeps())

    const handler = handlers.get("get-native-theme-mode")

    expect(handler?.()).toBe("light")
    ;(electron.nativeTheme as { shouldUseDarkColors: boolean }).shouldUseDarkColors = true
    expect(handler?.()).toBe("dark")
  })

  test("native theme update broadcasts the resolved mode to every window", () => {
    registerIpcHandlers(createDeps())

    ;(electron.nativeTheme as { shouldUseDarkColors: boolean }).shouldUseDarkColors = true
    nativeThemeUpdated?.()

    expect(windowSends[0]).toHaveBeenCalledWith("native-theme-mode", "dark")
    expect(windowSends[1]).toHaveBeenCalledWith("native-theme-mode", "dark")
  })

  test("issue-report-diagnostics omits persisted historical state", () => {
    registerIpcHandlers(createDeps())

    const handler = handlers.get("issue-report-diagnostics")
    const result = handler?.({
      sender: {
        getOSProcessId: () => 123,
        getURL: () => "http://localhost:5173/private/session/ses_secret?token=secret",
        getTitle: () => "dev@example.com",
        getZoomFactor: () => 1,
      },
    })

    expect(typeof result).toBe("object")
    expect(result).not.toBeNull()
    expect(Object.prototype.hasOwnProperty.call(result as Record<string, unknown>, "persisted_state")).toBe(false)
    expect((result as Record<string, unknown>).backend_log_tail).toBe("backend log tail token=private-token")
  })

  test("app snapshot handlers delegate configuration, permissions, and capture", async () => {
    const permissions = {
      supported: true,
      accessibility: "granted" as const,
      screen: "granted" as const,
      shortcut: "active" as const,
    }
    const configureAppSnapshots = mock(async () => permissions)
    const getAppSnapshotPermissions = mock(async () => permissions)
    const requestAppSnapshotPermission = mock(async () => permissions)
    const captureAppSnapshot = mock(async () => true)
    registerIpcHandlers(
      createDeps({
        configureAppSnapshots,
        getAppSnapshotPermissions,
        requestAppSnapshotPermission,
        captureAppSnapshot,
      }),
    )

    await handlers.get("configure-app-snapshots")?.({}, { shortcut: "command", playSound: true })
    await handlers.get("get-app-snapshot-permissions")?.()
    await handlers.get("request-app-snapshot-permission")?.({}, "accessibility")
    expect(await handlers.get("capture-app-snapshot")?.()).toBe(true)

    expect(configureAppSnapshots).toHaveBeenCalledWith({ shortcut: "command", playSound: true })
    expect(getAppSnapshotPermissions).toHaveBeenCalledTimes(1)
    expect(requestAppSnapshotPermission).toHaveBeenCalledWith("accessibility")
    expect(captureAppSnapshot).toHaveBeenCalledTimes(1)
  })

  test("save-text-file returns null without writing when the save dialog is cancelled", async () => {
    registerIpcHandlers(createDeps())

    const result = await handlers.get("save-text-file")?.({}, { defaultPath: "session.md", content: "content" })

    expect(result).toBeNull()
    expect(showSaveDialog).toHaveBeenCalledWith({ title: "Save file", defaultPath: "session.md" })
  })

  test("save-text-file writes the transcript after a destination is selected", async () => {
    const filePath = `/tmp/wanlaicode-export-${crypto.randomUUID()}.md`
    saveDialogResult = { canceled: false, filePath }
    registerIpcHandlers(createDeps())

    try {
      const result = await handlers.get("save-text-file")?.({}, { defaultPath: "session.md", content: "content" })

      expect(result).toBe(filePath)
      expect(await Bun.file(filePath).text()).toBe("content")
    } finally {
      await Bun.file(filePath).delete()
    }
  })
})
