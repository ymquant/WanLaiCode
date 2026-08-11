import { createSimpleContext } from "@opencode-ai/ui/context"
import type { FileContent } from "@opencode-ai/sdk/v2"
import type { AsyncStorage, SyncStorage } from "@solid-primitives/storage"
import type { Accessor } from "solid-js"
import { ServerConnection } from "./server"

type PickerPaths = string | string[] | null
type OpenDirectoryPickerOptions = { title?: string; multiple?: boolean; defaultPath?: string }
type OpenFilePickerOptions = { title?: string; multiple?: boolean; accept?: string[]; extensions?: string[] }
type SaveFilePickerOptions = { title?: string; defaultPath?: string }
type SaveTextFileOptions = SaveFilePickerOptions & { content: string }
type UpdateInfo = { updateAvailable: boolean; version?: string }

export type InstalledOpener = {
  id: string
  app: string
  name: string
  bundleId?: string
  iconDataUrl?: string
  kind: "editor" | "terminal"
}

export type AppSnapshotShortcut = "command" | "option" | "control" | "disabled"
export type AppSnapshotPermission = "accessibility" | "screen"

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
  image: { buffer: ArrayBuffer; width: number; height: number }
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

export type Platform = {
  /** Platform discriminator */
  platform: "web" | "desktop"

  /** Desktop OS (Tauri only) */
  os?: "macos" | "windows" | "linux"

  /** App version */
  version?: string

  /** Open a URL in the default browser */
  openLink(url: string): void

  openSystemBrowserLink?(url: string): void

  /** Open a URL in an app-owned external window (desktop only) */
  openExternalWindow?(url: string, opts?: { title?: string }): Promise<void>

  /** Open image preview in a separate OS window (desktop and web) */
  openImagePreviewWindow?(input: { src: string; alt?: string }): Promise<void>

  /** Open a local path in a local app (desktop only) */
  openPath?(path: string, app?: string): Promise<void>

  /** Show a file in the system file manager (desktop only) */
  showItemInFolder?(path: string): Promise<void>

  /** Restart the app  */
  restart(): Promise<void>

  /** Navigate back in history */
  back(): void

  /** Navigate forward in history */
  forward(): void

  /** Send a system notification (optional deep link) */
  notify(title: string, description?: string, href?: string): Promise<void>

  /** Open directory picker dialog (native on Tauri, server-backed on web) */
  openDirectoryPickerDialog?(opts?: OpenDirectoryPickerOptions): Promise<PickerPaths>

  /** Open native file picker dialog (Tauri only) */
  openFilePickerDialog?(opts?: OpenFilePickerOptions): Promise<PickerPaths>

  /** Save file picker dialog (Tauri only) */
  saveFilePickerDialog?(opts?: SaveFilePickerOptions): Promise<string | null>

  /** Save text content through a native file dialog (desktop only) */
  saveTextFileDialog?(opts: SaveTextFileOptions): Promise<string | null>

  /** Storage mechanism, defaults to localStorage */
  storage?: (name?: string) => SyncStorage | AsyncStorage

  /** Check for a downloadable desktop update */
  checkUpdate?(): Promise<UpdateInfo>

  /** 获取当前更新通道（stable / canary，desktop only） */
  getUpdateChannel?(): Promise<string>

  /** 设置更新通道（desktop only） */
  setUpdateChannel?(channel: string): Promise<string>

  /** Install the downloaded update using the platform restart flow */
  updateAndRestart?(): Promise<void>

  /** Fetch override */
  fetch?: typeof fetch

  /** Send lightweight renderer heartbeat to the desktop main process for hang diagnostics */
  issueReportHeartbeat?(snapshot: Record<string, unknown>): Promise<Record<string, unknown>>

  /** Read desktop-only diagnostics captured by the main process */
  issueReportDiagnostics?(): Promise<Record<string, unknown>>

  /** Capture the current app window after explicit user confirmation */
  captureWindowScreenshot?(): Promise<File | null>

  /** Configure the macOS foreground-window snapshot shortcut */
  configureAppSnapshots?(config: { shortcut: AppSnapshotShortcut; playSound: boolean }): Promise<AppSnapshotPermissionState>

  /** Read macOS Accessibility, Screen Recording, and shortcut monitor state */
  getAppSnapshotPermissions?(): Promise<AppSnapshotPermissionState>

  /** Ask macOS for a permission required by app snapshots */
  requestAppSnapshotPermission?(permission: AppSnapshotPermission): Promise<AppSnapshotPermissionState>

  /** Capture the foreground application window immediately */
  captureAppSnapshot?(): Promise<boolean>

  /** Subscribe to app snapshot capture results */
  onAppSnapshot?(cb: (event: AppSnapshotEvent) => void): () => void

  /** Get the configured default server URL (platform-specific) */
  getDefaultServer?(): Promise<ServerConnection.Key | null>

  /** Set the default server URL to use on app startup (platform-specific) */
  setDefaultServer?(url: ServerConnection.Key | null): Promise<void> | void

  /** Get the configured WSL integration (desktop only) */
  getWslEnabled?(): Promise<boolean>

  /** Set the configured WSL integration (desktop only) */
  setWslEnabled?(config: boolean): Promise<void> | void

  /** Parse markdown to HTML using native parser (desktop only, returns unprocessed code blocks) */
  parseMarkdown?(markdown: string): Promise<string>

  /** Webview zoom level (desktop only) */
  webviewZoom?: Accessor<number>

  /** Check if an editor app exists (desktop only) */
  checkAppExists?(appName: string): Promise<boolean>

  /** Get the icon for a registered app as a data URL (desktop/macOS only) */
  getAppIcon?(appName: string): Promise<string | null>

  /** 扫描已安装的编辑器/终端（desktop only）。macOS 走 Info.plist 自动检测；Windows 走注册表；Linux 走候选清单兜底 */
  listInstalledOpeners?(): Promise<InstalledOpener[]>

  /** 通过 opener 在指定路径打开（desktop only）。主进程会按 kind + exe 智能拼参数（终端 cwd 等） */
  invokeOpener?(opener: InstalledOpener, path: string): Promise<void>

  /** Read image from clipboard (desktop only) */
  readClipboardImage?(): Promise<File | null>

  /** Get absolute path for a File object (desktop only, uses webUtils.getPathForFile in Electron) */
  getPathForFile?(file: File): string

  /** Read a local file as data URL (desktop only, used for tree-dragged images) */
  readFileAsDataURL?(path: string, mime: string): Promise<string>

  /** 读取应用内查看器使用的本机文件内容（仅桌面端，用于用户主动打开的工作区外文件） */
  readLocalFile?(path: string): Promise<FileContent>

  /** Ensure a directory exists (recursive mkdir; desktop only) */
  ensureDirectory?(dirPath: string): Promise<string>

  /** Write content to a file (creates parent dirs; desktop only). By default refuses to overwrite. */
  writeFile?(filePath: string, content: string, opts?: { overwrite?: boolean }): Promise<void>

  /** Rename a file or directory (desktop only, uses FS rename) */
  renameFile?(oldPath: string, newPath: string): Promise<void>

  /** Move a file or directory to the system trash (desktop only) */
  trashFile?(filePath: string): Promise<void>

  /** Default parent directory and incremented folder name for a new blank project (desktop only) */
  getBlankProjectDefaults?(opts?: { parent?: string; baseName?: string }): Promise<{ parent: string; name: string }>

  /** Whether parent/name would create an existing directory (desktop only) */
  isBlankProjectPathTaken?(opts: { parent: string; name: string }): Promise<boolean>

  /** Create a new blank project directory under parent (default ~/Documents); name with numeric suffix on collision, or exact parent+name (desktop only) */
  createBlankProject?(opts?: { parent?: string; baseName?: string; name?: string }): Promise<string>

  /** Ensure the default scratch chat directory exists; returns its path (desktop only) */
  ensureScratchChatDir?(): Promise<string>

  /** Ensure the isolated quick-chat directory exists; returns its path (desktop only) */
  ensureQuickChatDir?(): Promise<string>

  /** Environment file management (desktop only) */
  ensureEnvironmentsDir?(): Promise<string>
  listEnvironments?(worktree: string): Promise<string[]>
  readEnvironment?(worktree: string, filename: string): Promise<string>
  writeEnvironment?(worktree: string, filename: string, content: string): Promise<void>
  deleteEnvironment?(worktree: string, filename: string): Promise<void>

  /** Open the main window from the login window (desktop only) */
  openMainWindow?(): Promise<void>

  /** Open the login window from the main window after sign-out (desktop only) */
  openLoginWindow?(): Promise<void>

  windowAction?(
    action:
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
      | "new-window",
  ): Promise<void>
  moveWindowForDrag?(input: { x: number; y: number; width?: number; height?: number }): Promise<void>
}

export const { use: usePlatform, provider: PlatformProvider } = createSimpleContext({
  name: "Platform",
  init: (props: { value: Platform }) => {
    return props.value
  },
})
