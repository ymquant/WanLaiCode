import { contextBridge, ipcRenderer, webUtils } from "electron"
import type { ElectronAPI, InitStep, SqliteMigrationProgress, TrayNavigateTarget, UpdateProgress } from "./types"

const api: ElectronAPI = {
  killSidecar: () => ipcRenderer.invoke("kill-sidecar"),
  installCli: () => ipcRenderer.invoke("install-cli"),
  awaitInitialization: (onStep) => {
    const handler = (_: unknown, step: InitStep) => onStep(step)
    ipcRenderer.on("init-step", handler)
    return ipcRenderer.invoke("await-initialization").finally(() => {
      ipcRenderer.removeListener("init-step", handler)
    })
  },
  getWindowConfig: () => ipcRenderer.invoke("get-window-config"),
  consumeInitialDeepLinks: () => ipcRenderer.invoke("consume-initial-deep-links"),
  getDefaultServerUrl: () => ipcRenderer.invoke("get-default-server-url"),
  setDefaultServerUrl: (url) => ipcRenderer.invoke("set-default-server-url", url),
  getWslConfig: () => ipcRenderer.invoke("get-wsl-config"),
  setWslConfig: (config) => ipcRenderer.invoke("set-wsl-config", config),
  parseMarkdownCommand: (markdown) => ipcRenderer.invoke("parse-markdown", markdown),
  checkAppExists: (appName) => ipcRenderer.invoke("check-app-exists", appName),
  getAppIcon: (appName) => ipcRenderer.invoke("get-app-icon", appName),
  listInstalledOpeners: () => ipcRenderer.invoke("list-installed-openers"),
  invokeOpener: (opener, path) => ipcRenderer.invoke("invoke-opener", opener, path),
  wslPath: (path, mode) => ipcRenderer.invoke("wsl-path", path, mode),
  resolveAppPath: (appName) => ipcRenderer.invoke("resolve-app-path", appName),
  storeGet: (name, key) => ipcRenderer.invoke("store-get", name, key),
  storeSet: (name, key, value) => ipcRenderer.invoke("store-set", name, key, value),
  storeDelete: (name, key) => ipcRenderer.invoke("store-delete", name, key),
  storeClear: (name) => ipcRenderer.invoke("store-clear", name),
  storeKeys: (name) => ipcRenderer.invoke("store-keys", name),
  storeLength: (name) => ipcRenderer.invoke("store-length", name),
  setTrayLocale: (locale) => ipcRenderer.invoke("set-tray-locale", locale),
  issueReportHeartbeat: (snapshot) => ipcRenderer.invoke("issue-report-heartbeat", snapshot),
  issueReportDiagnostics: () => ipcRenderer.invoke("issue-report-diagnostics"),
  captureWindowScreenshot: () => ipcRenderer.invoke("capture-window-screenshot"),
  configureAppSnapshots: (config) => ipcRenderer.invoke("configure-app-snapshots", config),
  getAppSnapshotPermissions: () => ipcRenderer.invoke("get-app-snapshot-permissions"),
  requestAppSnapshotPermission: (permission) => ipcRenderer.invoke("request-app-snapshot-permission", permission),
  captureAppSnapshot: () => ipcRenderer.invoke("capture-app-snapshot"),
  onAppSnapshot: (cb) => {
    const handler = (_: unknown, event: import("./types").AppSnapshotEvent) => cb(event)
    ipcRenderer.on("app-snapshot-event", handler)
    return () => ipcRenderer.removeListener("app-snapshot-event", handler)
  },

  // Get absolute path for File object (Electron 32+)
  getPathForFile: (file: File) => webUtils.getPathForFile(file),

  getWindowCount: () => ipcRenderer.invoke("get-window-count"),
  onSqliteMigrationProgress: (cb) => {
    const handler = (_: unknown, progress: SqliteMigrationProgress) => cb(progress)
    ipcRenderer.on("sqlite-migration-progress", handler)
    return () => ipcRenderer.removeListener("sqlite-migration-progress", handler)
  },
  onMenuCommand: (cb) => {
    const handler = (_: unknown, id: string) => cb(id)
    ipcRenderer.on("menu-command", handler)
    return () => ipcRenderer.removeListener("menu-command", handler)
  },
  onTrayNavigate: (cb) => {
    const handler = (_: unknown, target: TrayNavigateTarget) => cb(target)
    ipcRenderer.on("tray-navigate", handler)
    return () => ipcRenderer.removeListener("tray-navigate", handler)
  },
  onDeepLink: (cb) => {
    const handler = (_: unknown, urls: string[]) => cb(urls)
    ipcRenderer.on("deep-link", handler)
    return () => ipcRenderer.removeListener("deep-link", handler)
  },
  onNotificationClick: (cb) => {
    const handler = (_: unknown, href?: string) => cb(href)
    ipcRenderer.on("notification-click", handler)
    return () => ipcRenderer.removeListener("notification-click", handler)
  },

  openDirectoryPicker: (opts) => ipcRenderer.invoke("open-directory-picker", opts),
  openFilePicker: (opts) => ipcRenderer.invoke("open-file-picker", opts),
  saveFilePicker: (opts) => ipcRenderer.invoke("save-file-picker", opts),
  saveTextFile: (opts) => ipcRenderer.invoke("save-text-file", opts),
  openLink: (url) => ipcRenderer.send("open-link", url),
  openSystemBrowserLink: (url) => ipcRenderer.send("open-system-browser-link", url),
  openExternalWindow: (url, title) => ipcRenderer.invoke("open-external-window", { url, title }),
  openImagePreviewWindow: (input) => ipcRenderer.invoke("open-image-preview-window", input),
  consumeImagePreviewPayload: (id) => ipcRenderer.invoke("consume-image-preview-payload", id),
  openPath: (path, app) => ipcRenderer.invoke("open-path", path, app),
  showItemInFolder: (path) => ipcRenderer.invoke("show-item-in-folder", path),
  readFileAsDataURL: (path, mime) => ipcRenderer.invoke("read-file-as-data-url", path, mime),
  readLocalFile: (path) => ipcRenderer.invoke("read-local-file", path),
  readClipboardImage: () => ipcRenderer.invoke("read-clipboard-image"),
  showNotification: (title, body, href) => ipcRenderer.send("show-notification", title, body, href),
  getWindowFocused: () => ipcRenderer.invoke("get-window-focused"),
  getWindowMaximized: () => ipcRenderer.invoke("get-window-maximized"),
  onWindowMaximized: (cb) => {
    const handler = (_: unknown, maximized: boolean) => cb(maximized)
    ipcRenderer.on("window-maximized", handler)
    return () => ipcRenderer.removeListener("window-maximized", handler)
  },
  setWindowFocus: () => ipcRenderer.invoke("set-window-focus"),
  showWindow: () => ipcRenderer.invoke("show-window"),
  relaunch: () => ipcRenderer.send("relaunch"),
  getZoomFactor: () => ipcRenderer.invoke("get-zoom-factor"),
  setZoomFactor: (factor) => ipcRenderer.invoke("set-zoom-factor", factor),
  setTitlebar: (theme) => ipcRenderer.invoke("set-titlebar", theme),
  getNativeThemeMode: () => ipcRenderer.invoke("get-native-theme-mode"),
  onNativeThemeMode: (cb) => {
    const handler = (_: unknown, mode: "light" | "dark") => cb(mode)
    ipcRenderer.on("native-theme-mode", handler)
    return () => ipcRenderer.removeListener("native-theme-mode", handler)
  },
  loadingWindowComplete: () => ipcRenderer.send("loading-window-complete"),
  runUpdater: (alertOnFail) => ipcRenderer.invoke("run-updater", alertOnFail),
  checkUpdate: () => ipcRenderer.invoke("check-update"),
  getUpdateChannel: () => ipcRenderer.invoke("get-update-channel"),
  setUpdateChannel: (channel: string) => ipcRenderer.invoke("set-update-channel", channel),
  installUpdate: () => ipcRenderer.invoke("install-update"),
  confirmInstall: () => ipcRenderer.invoke("confirm-install"),
  cancelUpdate: () => ipcRenderer.invoke("cancel-update"),
  closeUpdateWindow: () => ipcRenderer.invoke("close-update-window"),
  onUpdateProgress: (cb) => {
    const handler = (_: unknown, progress: UpdateProgress) => cb(progress)
    ipcRenderer.on("update-progress", handler)
    return () => ipcRenderer.removeListener("update-progress", handler)
  },
  debugSimulateUpdateCheckFlow: (scenario) => ipcRenderer.invoke("debug-simulate-update-check-flow", scenario),
  setBackgroundColor: (color: string) => ipcRenderer.invoke("set-background-color", color),
  openMainWindow: () => ipcRenderer.invoke("open-main-window"),
  openLoginWindow: () => ipcRenderer.invoke("open-login-window"),
  ensureDirectory: (dirPath: string) => ipcRenderer.invoke("ensure-directory", dirPath),
  getBlankProjectDefaults: (opts?: { parent?: string; baseName?: string }) =>
    ipcRenderer.invoke("get-blank-project-defaults", opts ?? {}),
  checkBlankProjectExists: (opts: { parent?: string; name: string }) =>
    ipcRenderer.invoke("check-blank-project-exists", opts),
  createBlankProject: (opts?: { parent?: string; baseName?: string; name?: string }) =>
    ipcRenderer.invoke("create-blank-project", opts ?? {}),
  ensureScratchChatDir: () => ipcRenderer.invoke("ensure-scratch-chat-dir"),
  ensureQuickChatDir: () => ipcRenderer.invoke("ensure-quick-chat-dir"),
  windowAction: (action) => ipcRenderer.invoke("window-action", action),
  moveWindowForDrag: (input) => ipcRenderer.invoke("move-window-for-drag", input),

  // Environment file management
  ensureEnvironmentsDir: () => ipcRenderer.invoke("ensure-environments-dir"),
  listEnvironments: (worktree: string) => ipcRenderer.invoke("list-environments", worktree),
  readEnvironment: (worktree: string, filename: string) => ipcRenderer.invoke("read-environment", worktree, filename),
  writeEnvironment: (worktree: string, filename: string, content: string) =>
    ipcRenderer.invoke("write-environment", worktree, filename, content),
  deleteEnvironment: (worktree: string, filename: string) =>
    ipcRenderer.invoke("delete-environment", worktree, filename),
  writeFile: (filePath: string, content: string, opts?: { overwrite?: boolean }) =>
    ipcRenderer.invoke("write-file", filePath, content, opts),
  renameFile: (oldPath: string, newPath: string) =>
    ipcRenderer.invoke("rename-file", oldPath, newPath),
  trashFile: (filePath: string) =>
    ipcRenderer.invoke("trash-file", filePath),

  // BrowserView management
  browserViewCreate: (tabId: string) => ipcRenderer.invoke("browser-view-create", tabId),
  browserViewDestroy: (tabId: string) => ipcRenderer.invoke("browser-view-destroy", tabId),
  browserViewClose: (tabId: string) => ipcRenderer.sendSync("browser-view-close", tabId),
  browserViewHideSync: (tabId: string) => ipcRenderer.sendSync("browser-view-hide-sync", tabId),
  browserViewNavigate: (tabId: string, url: string) => ipcRenderer.invoke("browser-view-navigate", tabId, url),
  browserViewSetBounds: (tabId: string, bounds: { x: number; y: number; width: number; height: number }) =>
    ipcRenderer.invoke("browser-view-set-bounds", tabId, bounds),
  browserViewShow: (tabId: string) => ipcRenderer.send("browser-view-show", tabId),
  browserViewHide: (tabId: string) => ipcRenderer.send("browser-view-hide", tabId),
  browserViewFocus: (tabId: string) => ipcRenderer.invoke("browser-view-focus", tabId),
  browserViewGoBack: (tabId: string) => ipcRenderer.invoke("browser-view-go-back", tabId),
  browserViewGoForward: (tabId: string) => ipcRenderer.invoke("browser-view-go-forward", tabId),
  browserViewReload: (tabId: string) => ipcRenderer.invoke("browser-view-reload", tabId),
  browserViewStop: (tabId: string) => ipcRenderer.invoke("browser-view-stop", tabId),
  onBrowserViewState: (cb: (tabId: string, state: import("./types").BrowserViewState) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, tabId: string, state: import("./types").BrowserViewState) => cb(tabId, state)
    ipcRenderer.on("browser-view-state", handler)
    return () => ipcRenderer.removeListener("browser-view-state", handler)
  },

  uninstallFeedbackSubmit: (data) => ipcRenderer.invoke("uninstall-feedback:submit", data),
  uninstallFeedbackCancel: () => ipcRenderer.send("uninstall-feedback:cancel"),
  uninstallFeedbackContinue: () => ipcRenderer.send("uninstall-feedback:continue"),
}

contextBridge.exposeInMainWorld("api", api)
