export type InitStep =
  | { phase: "server_waiting" }
  | { phase: "sqlite_waiting" }
  | { phase: "server_unreachable" }
  | { phase: "done" }

export type ServerReadyData = {
  url: string
  username: string | null
  password: string | null
}

export type SqliteMigrationProgress = { type: "InProgress"; value: number } | { type: "Done" }

export type UpdateProgress =
  | { phase: "preparing"; version?: string }
  | {
      phase: "downloading"
      version?: string
      percent: number
      bytesPerSecond: number
      transferred: number
      total: number
    }
  | { phase: "installing"; version?: string }
  // 下载完之后、装之前发现还有 busy session，把决定权交给用户。busyCount 用于显示具体数量。
  | { phase: "confirm-install"; version?: string; busyCount: number }
  | { phase: "error"; message: string }
  | { phase: "cancelled" }

export type WslConfig = { enabled: boolean }

export type TitlebarTheme = {
  mode: "light" | "dark"
  source?: "system" | "light" | "dark"
  backgroundColor?: string
  symbolColor?: string
  /** wanlai-theme + Win11 Mica：透明窗体/标题栏 overlay，让系统材质露出来 */
  glass?: boolean
}
export type NativeThemeMode = "light" | "dark"

export type WindowsBackdrop = "mica" | "none"

export type WindowConfig = {
  updaterEnabled: boolean
  windowsBackdrop?: WindowsBackdrop
}

export type WindowDragMoveInput = {
  x: number
  y: number
  width?: number
  height?: number
}

export type IssueReportDesktopDiagnostics = {
  app: {
    version: string
    packaged: boolean
    platform: NodeJS.Platform
    arch: string
    pid: number
  }
  window?: {
    focused: boolean
    visible: boolean
    title: string
    bounds: Electron.Rectangle
  }
  renderer?: {
    process_id?: number
    url: string
    title: string
    zoom_factor: number
  }
  process_metrics: Array<Record<string, unknown>>
  backend_log_tail?: string
  last_heartbeat?: Record<string, unknown>
  main_process_issues: Array<Record<string, unknown>>
}

export type IssueReportScreenshot = {
  buffer: ArrayBuffer
  width: number
  height: number
}

export type AppSnapshotShortcut = "command" | "option" | "control" | "disabled"
export type AppSnapshotPermission = "accessibility" | "screen"

export type AppSnapshotConfig = {
  shortcut: AppSnapshotShortcut
  playSound: boolean
}

export type AppSnapshotPermissionState = {
  supported: boolean
  accessibility: "granted" | "denied" | "unavailable"
  screen: "not-determined" | "granted" | "denied" | "restricted" | "unknown" | "unavailable"
  shortcut: "active" | "inactive" | "permission-required" | "disabled" | "unavailable"
}

export type AppSnapshotCapture = {
  id: string
  appName: string
  bundleIdentifier?: string
  windowTitle: string
  displayID: string
  accessibilityText: string
  accessibilityTrusted: boolean
  textTruncated: boolean
  capturedAt: number
  image: IssueReportScreenshot
}

export type AppSnapshotEvent =
  | { type: "capturing"; origin: "shortcut" | "manual" }
  | { type: "captured"; origin: "shortcut" | "manual"; snapshot: AppSnapshotCapture }
  | {
      type: "error"
      code:
        | "unsupported"
        | "accessibility-permission"
        | "screen-permission"
        | "no-window"
        | "timeout"
        | "capture-failed"
      message?: string
      permissions: AppSnapshotPermissionState
    }

export type InstalledOpener = {
  id: string
  app: string
  name: string
  bundleId?: string
  iconDataUrl?: string
  kind: "editor" | "terminal"
}

export type TrayNavigateTarget = {
  sessionID: string
  slug: string
}

export type ImagePreviewWindowInput = {
  src: string
  alt?: string
}

export type ImagePreviewWindowPayload = ImagePreviewWindowInput

export type LocalFileContent = {
  type: "text" | "binary" | "previewable"
  content: string
  encoding?: "base64"
  mimeType?: string
}

export type ElectronAPI = {
  killSidecar: () => Promise<void>
  installCli: () => Promise<string>
  awaitInitialization: (onStep: (step: InitStep) => void) => Promise<ServerReadyData>
  getWindowConfig: () => Promise<WindowConfig>
  consumeInitialDeepLinks: () => Promise<string[]>
  getDefaultServerUrl: () => Promise<string | null>
  setDefaultServerUrl: (url: string | null) => Promise<void>
  getWslConfig: () => Promise<WslConfig>
  setWslConfig: (config: WslConfig) => Promise<void>
  parseMarkdownCommand: (markdown: string) => Promise<string>
  checkAppExists: (appName: string) => Promise<boolean>
  getAppIcon: (appName: string) => Promise<string | null>
  listInstalledOpeners: () => Promise<InstalledOpener[]>
  invokeOpener: (opener: InstalledOpener, path: string) => Promise<void>
  wslPath: (path: string, mode: "windows" | "linux" | null) => Promise<string>
  resolveAppPath: (appName: string) => Promise<string | null>
  storeGet: (name: string, key: string) => Promise<string | null>
  storeSet: (name: string, key: string, value: string) => Promise<void>
  storeDelete: (name: string, key: string) => Promise<void>
  storeClear: (name: string) => Promise<void>
  storeKeys: (name: string) => Promise<string[]>
  storeLength: (name: string) => Promise<number>
  setTrayLocale: (locale: string) => Promise<void>
  issueReportHeartbeat: (snapshot: Record<string, unknown>) => Promise<IssueReportDesktopDiagnostics>
  issueReportDiagnostics: () => Promise<IssueReportDesktopDiagnostics>
  captureWindowScreenshot: () => Promise<IssueReportScreenshot | null>
  configureAppSnapshots: (config: AppSnapshotConfig) => Promise<AppSnapshotPermissionState>
  getAppSnapshotPermissions: () => Promise<AppSnapshotPermissionState>
  requestAppSnapshotPermission: (permission: AppSnapshotPermission) => Promise<AppSnapshotPermissionState>
  captureAppSnapshot: () => Promise<boolean>
  onAppSnapshot: (cb: (event: AppSnapshotEvent) => void) => () => void

  // Get absolute path for File object (Electron 32+)
  getPathForFile: (file: File) => string

  getWindowCount: () => Promise<number>
  onSqliteMigrationProgress: (cb: (progress: SqliteMigrationProgress) => void) => () => void
  onMenuCommand: (cb: (id: string) => void) => () => void
  onTrayNavigate: (cb: (target: TrayNavigateTarget) => void) => () => void
  onDeepLink: (cb: (urls: string[]) => void) => () => void
  onNotificationClick: (cb: (href?: string) => void) => () => void

  openDirectoryPicker: (opts?: {
    multiple?: boolean
    title?: string
    defaultPath?: string
  }) => Promise<string | string[] | null>
  openFilePicker: (opts?: {
    multiple?: boolean
    title?: string
    defaultPath?: string
    accept?: string[]
    extensions?: string[]
  }) => Promise<string | string[] | null>
  saveFilePicker: (opts?: { title?: string; defaultPath?: string }) => Promise<string | null>
  saveTextFile: (opts: { title?: string; defaultPath?: string; content: string }) => Promise<string | null>
  openLink: (url: string) => void
  openSystemBrowserLink: (url: string) => void
  openExternalWindow: (url: string, title?: string) => Promise<boolean>
  openImagePreviewWindow: (input: ImagePreviewWindowInput) => Promise<boolean>
  consumeImagePreviewPayload: (id: string) => Promise<ImagePreviewWindowPayload | null>
  openPath: (path: string, app?: string) => Promise<void>
  showItemInFolder: (path: string) => Promise<void>
  readFileAsDataURL: (path: string, mime: string) => Promise<string>
  readLocalFile: (path: string) => Promise<LocalFileContent>
  readClipboardImage: () => Promise<{ buffer: ArrayBuffer; width: number; height: number } | null>
  showNotification: (title: string, body?: string, href?: string) => void
  getWindowFocused: () => Promise<boolean>
  getWindowMaximized: () => Promise<boolean>
  onWindowMaximized: (cb: (maximized: boolean) => void) => () => void
  setWindowFocus: () => Promise<void>
  showWindow: () => Promise<void>
  relaunch: () => void
  getZoomFactor: () => Promise<number>
  setZoomFactor: (factor: number) => Promise<void>
  setTitlebar: (theme: TitlebarTheme) => Promise<void>
  getNativeThemeMode: () => Promise<NativeThemeMode>
  onNativeThemeMode: (cb: (mode: NativeThemeMode) => void) => () => void
  loadingWindowComplete: () => void
  runUpdater: (alertOnFail: boolean) => Promise<void>
  checkUpdate: () => Promise<{ updateAvailable: boolean; version?: string }>
  getUpdateChannel: () => Promise<string>
  setUpdateChannel: (channel: string) => Promise<string>
  installUpdate: () => Promise<void>
  confirmInstall: () => Promise<void>
  cancelUpdate: () => Promise<void>
  closeUpdateWindow: () => Promise<void>
  onUpdateProgress: (cb: (progress: UpdateProgress) => void) => () => void
  debugSimulateUpdateCheckFlow: (scenario: "success" | "cancel" | "error" | "confirm") => Promise<void>
  setBackgroundColor: (color: string) => Promise<void>
  openMainWindow: () => Promise<void>
  openLoginWindow: () => Promise<void>
  ensureDirectory: (dirPath: string) => Promise<string>
  getBlankProjectDefaults: (opts?: { parent?: string; baseName?: string }) => Promise<{ parent: string; name: string }>
  checkBlankProjectExists: (opts: { parent?: string; name: string }) => Promise<boolean>
  createBlankProject: (opts?: { parent?: string; baseName?: string; name?: string }) => Promise<string>
  ensureScratchChatDir: () => Promise<string>
  ensureQuickChatDir: () => Promise<string>
  windowAction: (action: WindowAction) => Promise<void>
  moveWindowForDrag: (input: WindowDragMoveInput) => Promise<void>

  // Environment file management
  ensureEnvironmentsDir: () => Promise<string>
  listEnvironments: (worktree: string) => Promise<string[]>
  readEnvironment: (worktree: string, filename: string) => Promise<string>
  writeEnvironment: (worktree: string, filename: string, content: string) => Promise<void>
  deleteEnvironment: (worktree: string, filename: string) => Promise<void>
  writeFile: (filePath: string, content: string, opts?: { overwrite?: boolean }) => Promise<void>
  renameFile: (oldPath: string, newPath: string) => Promise<void>
  trashFile: (filePath: string) => Promise<void>

  // BrowserView management
  browserViewCreate: (tabId: string) => Promise<boolean>
  browserViewDestroy: (tabId: string) => Promise<void>
  browserViewClose: (tabId: string) => void
  browserViewHideSync: (tabId: string) => void
  browserViewNavigate: (tabId: string, url: string) => Promise<boolean>
  browserViewSetBounds: (tabId: string, bounds: { x: number; y: number; width: number; height: number }) => Promise<void>
  browserViewShow: (tabId: string) => void
  browserViewHide: (tabId: string) => void
  browserViewFocus: (tabId: string) => Promise<void>
  browserViewGoBack: (tabId: string) => Promise<boolean>
  browserViewGoForward: (tabId: string) => Promise<boolean>
  browserViewReload: (tabId: string) => Promise<boolean>
  browserViewStop: (tabId: string) => Promise<boolean>
  onBrowserViewState: (cb: (tabId: string, state: BrowserViewState) => void) => () => void

  uninstallFeedbackSubmit(data: {
    content: string
    contact?: string
    images: { name: string; type: string; bytes: Uint8Array }[]
  }): Promise<{ ok: boolean; fellBack: boolean }>
  uninstallFeedbackCancel(): void
  uninstallFeedbackContinue(): void
}

export type BrowserViewState = {
  canGoBack: boolean
  canGoForward: boolean
  favicon: string
  isLoading: boolean
  title: string
  url: string
}

export type WindowAction =
  | "minimize"
  | "toggle-maximize"
  | "close"
  | "fullscreen-toggle"
  | "reload"
  | "devtools-toggle"
  | "zoom-in"
  | "zoom-out"
  | "zoom-reset"
  | "undo"
  | "redo"
  | "cut"
  | "copy"
  | "paste"
  | "select-all"
  | "new-window"
