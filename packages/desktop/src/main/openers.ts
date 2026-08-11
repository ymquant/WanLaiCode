import { execFile } from "node:child_process"
import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { promisify } from "node:util"
import { app as electronApp } from "electron"
import { getAppIconDataUrl, resolveAppPath } from "./apps"

const execFileAsync = promisify(execFile)

export type OpenerKind = "editor" | "terminal"

export type InstalledOpener = {
  /** 稳定 id：macOS 用 bundle id，其他平台用 app 名（小写化） */
  id: string
  /** 传给 platform.openPath 的 app 名（macOS: CFBundleName；Win/Linux: 可执行名） */
  app: string
  /** OS 报告的应用展示名 */
  name: string
  /** macOS bundle id；其它平台为空 */
  bundleId?: string
  /** 图标 data URL（仅当 sprite 内无现成 id 时由 renderer 使用） */
  iconDataUrl?: string
  kind: OpenerKind
}

// ============ macOS 检测 ============

// 声明任一 UTI 即视为终端
const MAC_TERMINAL_UTIS = new Set([
  "com.apple.terminal.shell-script",
  "com.apple.terminal.session",
  "com.apple.terminal.settings",
])

// 编辑器通常会声明能打开文件夹/纯文本/源码
const MAC_EDITOR_FOLDER_UTIS = new Set(["public.folder", "public.directory"])
const MAC_EDITOR_TEXT_UTIS = new Set([
  "public.source-code",
  "public.text",
  "public.plain-text",
  "public.script",
  "public.shell-script",
])

// 没声明 developer-tools 类别但又确实是编辑器/终端的兜底白名单
const MAC_EDITOR_BUNDLE_IDS = new Set([
  "dev.zed.Zed",
  "dev.zed.Zed-Preview",
  "dev.zed.Zed-Dev",
])
const MAC_TERMINAL_BUNDLE_IDS = new Set([
  "com.googlecode.iterm2",
  "com.mitchellh.ghostty",
  "org.tabby",
  "com.tabby.app",
  "com.termius-dmg.mac",
  "com.termius.mac",
  "io.alacritty",
  "org.alacritty",
  "net.kovidgoyal.kitty",
  "co.zeit.hyper",
])

// developer-tools 类目下但不属于「编辑器」的常见应用，显式排除
const MAC_BLOCKLIST_BUNDLE_IDS = new Set([
  // 非编辑器的开发者工具
  "com.docker.docker",
  "dev.kdrag0n.MacVirt", // OrbStack
  "com.postmanlabs.mac",
  "io.insomnia.Insomnia",
  "com.github.GitHubClient",
  "com.fournova.Tower3",
  "com.atlassian.sourcetree",
  "com.apple.Console",
  "com.apple.dt.Instruments",
  "com.figma.Desktop",
  // 同类竞品（不展示在自家下拉里）
  "com.anthropic.claudefordesktop", // Claude
  "com.openai.codex", // Codex
])

function macAppScanDirs(): string[] {
  const home = process.env.HOME
  return [
    "/Applications",
    "/Applications/Utilities",
    "/System/Applications",
    "/System/Applications/Utilities",
    ...(home ? [`${home}/Applications`] : []),
  ]
}

function listMacAppPaths(): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const dir of macAppScanDirs()) {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.endsWith(".app")) continue
      const full = join(dir, entry)
      if (seen.has(entry)) continue
      seen.add(entry)
      out.push(full)
    }
  }
  return out
}

function isPlistObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

async function readPlistJson(plistPath: string): Promise<Record<string, unknown> | null> {
  try {
    const { stdout } = await execFileAsync("plutil", ["-convert", "json", "-o", "-", plistPath], {
      maxBuffer: 1024 * 1024,
    })
    const parsed: unknown = JSON.parse(stdout)
    return isPlistObject(parsed) ? parsed : null
  } catch {
    return null
  }
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((v): v is string => typeof v === "string")
}

function asRecordArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return []
  return value.filter(
    (v): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v),
  )
}

type ClassifiedMacApp = {
  kind: OpenerKind
  bundleId: string
  name: string
  appName: string
}

function classifyFromPlist(
  info: Record<string, unknown> | null,
  appPath: string,
): ClassifiedMacApp | null {
  if (!info) return null

  const bundleId = typeof info.CFBundleIdentifier === "string" ? info.CFBundleIdentifier : ""
  if (!bundleId || MAC_BLOCKLIST_BUNDLE_IDS.has(bundleId)) return null

  const name =
    (typeof info.CFBundleDisplayName === "string" && info.CFBundleDisplayName) ||
    (typeof info.CFBundleName === "string" && info.CFBundleName) ||
    appPath.split("/").pop()!.replace(/\.app$/, "")
  const appName = appPath.split("/").pop()!.replace(/\.app$/, "")

  const declared = new Set<string>()
  for (const dt of asRecordArray(info.CFBundleDocumentTypes)) {
    for (const t of asStringArray(dt.LSItemContentTypes)) declared.add(t)
  }

  // 1. 显式终端 UTI
  for (const uti of MAC_TERMINAL_UTIS) {
    if (declared.has(uti)) return { kind: "terminal", bundleId, name, appName }
  }

  // 2. bundle id 白名单
  if (MAC_TERMINAL_BUNDLE_IDS.has(bundleId)) return { kind: "terminal", bundleId, name, appName }
  if (MAC_EDITOR_BUNDLE_IDS.has(bundleId)) return { kind: "editor", bundleId, name, appName }

  // 3. developer-tools 类别 + 能打开 folder/text/source
  const category = typeof info.LSApplicationCategoryType === "string" ? info.LSApplicationCategoryType : ""
  const hasFolderOrTextOrSource = [...declared].some(
    (u) => MAC_EDITOR_FOLDER_UTIS.has(u) || MAC_EDITOR_TEXT_UTIS.has(u),
  )
  if (category === "public.app-category.developer-tools" && hasFolderOrTextOrSource) {
    return { kind: "editor", bundleId, name, appName }
  }

  // 4. 显式声明 source-code 的纯文本/源码编辑器
  if (declared.has("public.source-code")) return { kind: "editor", bundleId, name, appName }

  return null
}

async function scanMacOpeners(): Promise<InstalledOpener[]> {
  const paths = listMacAppPaths()
  const classified = await Promise.all(
    paths.map(async (p) => {
      const info = await readPlistJson(join(p, "Contents", "Info.plist"))
      return { path: p, classified: classifyFromPlist(info, p) }
    }),
  )

  const items = classified
    .map((c) => c.classified)
    .filter((c): c is ClassifiedMacApp => c !== null)

  // 图标提取也走并行（sips 已改为异步，多个 sips 子进程会并发跑）
  const withIcons = await Promise.all(
    items.map(async (c): Promise<InstalledOpener> => {
      const iconDataUrl = (await getAppIconDataUrl(c.appName)) ?? undefined
      return {
        id: c.bundleId,
        app: c.appName,
        name: c.name,
        bundleId: c.bundleId,
        iconDataUrl,
        kind: c.kind,
      }
    }),
  )

  // 排序：先编辑器后终端，组内按 name 升序
  withIcons.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "editor" ? -1 : 1
    return a.name.localeCompare(b.name)
  })

  return withIcons
}

// ============ Windows 全动态扫描 ============

type WinAppEntry = {
  displayName: string
  publisher?: string
  installLocation?: string
  displayIcon?: string
}

// DisplayName 命中即视为编辑器
const WIN_EDITOR_PATTERNS: RegExp[] = [
  /^Visual Studio Code$/i,
  /^Visual Studio Code Insiders$/i,
  /^Cursor$/i,
  /^Zed$/i,
  /^Sublime Text/i,
  /^Notepad\+\+/i,
  /^(?:WebStorm|IntelliJ IDEA|PyCharm|GoLand|Rider|RubyMine|PhpStorm|CLion|DataGrip|AppCode|RustRover|Fleet)/i,
  /^Android Studio/i,
  /^Microsoft Visual Studio/i,
  /^Atom$/i,
  /^Brackets$/i,
  /^Helix$/i,
  /^Lapce$/i,
  /^Trae$/i,
  /^Kiro$/i,
  /^Antigravity$/i,
  /^PearAI$/i,
  /^GVim$/i,
  /^Neovim/i,
  /^Emacs/i,
]

// DisplayName 命中即视为终端
const WIN_TERMINAL_PATTERNS: RegExp[] = [
  /^Windows Terminal/i,
  /^PowerShell/i,
  /^Tabby$/i,
  /^Termius/i,
  /^Alacritty/i,
  /^Kitty/i,
  /^Hyper$/i,
  /^Wezterm$/i,
  /^WezTerm$/i,
  /^ConEmu/i,
  /^Cmder/i,
  /^MobaXterm/i,
  /^PuTTY/i,
  /^Warp$/i,
]

// 屏蔽列表（同类竞品）
const WIN_BLOCKLIST_PATTERNS: RegExp[] = [
  /^Claude(?:\s|$)/i,
  /^Codex$/i,
]

// 当 DisplayName 正则没命中时，按 Publisher 兜底（只允许信号极强、几乎只发行编辑器的厂商）
const WIN_EDITOR_PUBLISHER_PATTERNS: RegExp[] = [
  /^JetBrains/i,
  /^Sublime HQ/i,
  /^Anysphere/i, // Cursor
  /^Zed Industries/i,
  /^Don Ho$/i, // Notepad++
]

// Windows 内置 shell（不会出现在 Uninstall 注册表里），按系统路径直检
const WIN_SYSTEM_SHELLS: Array<{ exe: string; name: string; kind: OpenerKind }> = [
  { exe: "wt.exe", name: "Windows Terminal", kind: "terminal" },
  { exe: "pwsh.exe", name: "PowerShell", kind: "terminal" },
  { exe: "powershell.exe", name: "Windows PowerShell", kind: "terminal" },
  { exe: "cmd.exe", name: "Command Prompt", kind: "terminal" },
]

async function queryWindowsUninstall(): Promise<WinAppEntry[]> {
  const script = `
    $entries = Get-ItemProperty -Path @(
      'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
      'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
      'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
    ) -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -ne $null -and $_.SystemComponent -ne 1 } |
    ForEach-Object {
      [PSCustomObject]@{
        DisplayName = $_.DisplayName
        Publisher = $_.Publisher
        InstallLocation = $_.InstallLocation
        DisplayIcon = $_.DisplayIcon
      }
    }
    if ($entries) { ConvertTo-Json -InputObject @($entries) -Compress } else { '[]' }
  `
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { maxBuffer: 16 * 1024 * 1024, windowsHide: true },
    )
    const parsed: unknown = JSON.parse(stdout || "[]")
    const arr = Array.isArray(parsed) ? parsed : [parsed]
    return arr.filter(isPlistObject).map((e) => ({
      displayName: typeof e.DisplayName === "string" ? e.DisplayName : "",
      publisher: typeof e.Publisher === "string" ? e.Publisher : undefined,
      installLocation: typeof e.InstallLocation === "string" ? e.InstallLocation : undefined,
      displayIcon: typeof e.DisplayIcon === "string" ? e.DisplayIcon : undefined,
    }))
  } catch {
    return []
  }
}

function resolveWinExe(entry: WinAppEntry): string | null {
  // 1) DisplayIcon 通常形如 "C:\Path\App.exe,0"
  if (entry.displayIcon) {
    const raw = entry.displayIcon.split(",")[0].trim().replace(/^"|"$/g, "")
    if (raw.toLowerCase().endsWith(".exe") && safeExists(raw)) return raw
  }
  // 2) 扫 InstallLocation 下的 *.exe；优先匹配 displayName 关键字
  if (entry.installLocation && safeExists(entry.installLocation)) {
    try {
      const dirEntries = readdirSync(entry.installLocation)
      const exes = dirEntries.filter((f) => f.toLowerCase().endsWith(".exe"))
      const keyword = entry.displayName.replace(/[^A-Za-z0-9]/g, "").toLowerCase()
      const matched = exes.find((e) => {
        const stem = e.replace(/\.exe$/i, "").replace(/[^A-Za-z0-9]/g, "").toLowerCase()
        return keyword.includes(stem) || stem.includes(keyword)
      })
      const picked = matched ?? exes.find((e) => !/uninst/i.test(e)) ?? null
      if (picked) return join(entry.installLocation, picked)
    } catch {
      // ignore
    }
  }
  return null
}

function safeExists(path: string): boolean {
  try {
    return existsSync(path)
  } catch {
    return false
  }
}

function classifyWinApp(entry: WinAppEntry): OpenerKind | null {
  const name = entry.displayName
  if (!name) return null
  for (const p of WIN_BLOCKLIST_PATTERNS) if (p.test(name)) return null
  for (const p of WIN_TERMINAL_PATTERNS) if (p.test(name)) return "terminal"
  for (const p of WIN_EDITOR_PATTERNS) if (p.test(name)) return "editor"
  // Publisher 兜底（处理 DisplayName 含版本/Edition 后缀的边缘场景，如 "IntelliJ IDEA Community Edition 2024.1"）
  const pub = entry.publisher ?? ""
  if (pub) {
    for (const p of WIN_EDITOR_PUBLISHER_PATTERNS) if (p.test(pub)) return "editor"
  }
  return null
}

async function getWinIconDataUrl(exePath: string): Promise<string | null> {
  try {
    const img = await electronApp.getFileIcon(exePath, { size: "large" })
    if (img.isEmpty()) return null
    return img.toDataURL()
  } catch {
    return null
  }
}

async function scanWindowsOpeners(): Promise<InstalledOpener[]> {
  const entries = await queryWindowsUninstall()
  const seen = new Set<string>()
  const collected: Array<{ entry: WinAppEntry; exe: string; kind: OpenerKind }> = []

  for (const entry of entries) {
    const kind = classifyWinApp(entry)
    if (!kind) continue
    const exe = resolveWinExe(entry)
    if (!exe) continue
    const id = entry.displayName.toLowerCase().replace(/\s+/g, "-")
    if (seen.has(id)) continue
    seen.add(id)
    collected.push({ entry, exe, kind })
  }

  const withIcons = await Promise.all(
    collected.map(async ({ entry, exe, kind }) => {
      const iconDataUrl = (await getWinIconDataUrl(exe)) ?? undefined
      const opener: InstalledOpener = {
        id: entry.displayName.toLowerCase().replace(/\s+/g, "-"),
        app: exe,
        name: entry.displayName,
        iconDataUrl,
        kind,
      }
      return opener
    }),
  )

  // 内置系统 shell 不会出现在 Uninstall 注册表里，单独探测
  const systemShells = await collectWindowsSystemShells(seen)
  withIcons.push(...systemShells)

  // 没扫到任何条目时回退到基础候选（注册表权限受限等极端场景）
  if (withIcons.length === 0) return scanWindowsFallback()

  withIcons.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "editor" ? -1 : 1
    return a.name.localeCompare(b.name)
  })

  return withIcons
}

async function collectWindowsSystemShells(seen: Set<string>): Promise<InstalledOpener[]> {
  const items: InstalledOpener[] = []
  for (const shell of WIN_SYSTEM_SHELLS) {
    const id = shell.name.toLowerCase().replace(/\s+/g, "-")
    if (seen.has(id)) continue
    const exe = resolveAppPath(shell.exe)
    if (!exe) continue
    seen.add(id)
    const iconDataUrl = (await getWinIconDataUrl(exe)) ?? undefined
    items.push({ id, app: exe, name: shell.name, iconDataUrl, kind: shell.kind })
  }
  return items
}

// ============ 调用方式：按 opener 智能拼参数 ============

/** PowerShell 单引号转义：单引号内 '' 表示一个单引号 */
function psQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`
}

/**
 * cmd.exe 双引号转义：去掉路径里已存在的 " 字符（Windows 文件名禁用 "，可 strip）
 * 必须先剥结尾反斜杠：cmd 在双引号字符串里把 \" 视为转义引号，"C:\foo\" 会导致引号
 * 不闭合（盘根 "C:\" 和文件夹选择器返回的路径都常以 \ 结尾）
 */
function cmdQuote(s: string): string {
  const trimmed = s.replace(/\\+$/, "")
  return `"${trimmed.replace(/"/g, "")}"`
}

/**
 * 根据 opener 类型和 exe basename 拼调用命令。
 * - 编辑器：直接 execFile(exe, [path])（macOS 用 open -a）
 * - 终端：注入「设置工作目录」的命令行参数，否则 cwd 不会跟到项目目录
 */
export function buildOpenCommand(
  opener: InstalledOpener,
  path: string,
): { cmd: string; args: string[] } {
  // macOS：open -a 本身就会用 path 作为 cwd
  if (process.platform === "darwin") {
    return { cmd: "open", args: ["-a", opener.app, path] }
  }

  // Windows：按 exe basename 选择终端语法
  if (process.platform === "win32" && opener.kind === "terminal") {
    const lower = opener.app.toLowerCase()
    const base = lower.split(/[\\/]/).pop() ?? lower
    switch (base) {
      case "wt.exe":
      case "windowsterminal.exe":
        return { cmd: opener.app, args: ["-d", path] }
      case "pwsh.exe":
        return { cmd: opener.app, args: ["-NoExit", "-WorkingDirectory", path] }
      case "powershell.exe":
        return {
          cmd: opener.app,
          args: ["-NoExit", "-Command", `Set-Location -LiteralPath ${psQuote(path)}`],
        }
      case "cmd.exe":
        // cmd /k 把整个第二参数当 shell 命令解析，必须为 path 加双引号
        // 防止空格 / & / | 等被 cmd tokenize 成多条命令
        return { cmd: opener.app, args: ["/k", `cd /d ${cmdQuote(path)}`] }
      case "alacritty.exe":
        return { cmd: opener.app, args: ["--working-directory", path] }
      case "wezterm.exe":
      case "wezterm-gui.exe":
        return { cmd: opener.app, args: ["start", "--cwd", path] }
      case "kitty.exe":
        return { cmd: opener.app, args: ["--directory", path] }
      case "hyper.exe":
        // Hyper 不接受 cwd 参数；传 path 会被当作文件，干脆不传，让用户手动 cd
        return { cmd: opener.app, args: [] }
      default:
        return { cmd: opener.app, args: [path] }
    }
  }

  // Linux & 其他：直接传 path
  return { cmd: opener.app, args: [path] }
}

// ============ Linux / Windows 候选清单兜底 ============

type FallbackCandidate = {
  id: string
  app: string
  name: string
  kind: OpenerKind
}

const WINDOWS_FALLBACK_CANDIDATES: FallbackCandidate[] = [
  { id: "vscode", app: "code", name: "VS Code", kind: "editor" },
  { id: "cursor", app: "cursor", name: "Cursor", kind: "editor" },
  { id: "zed", app: "zed", name: "Zed", kind: "editor" },
  { id: "powershell", app: "powershell.exe", name: "PowerShell", kind: "terminal" },
]

const LINUX_CANDIDATES: FallbackCandidate[] = [
  { id: "vscode", app: "code", name: "VS Code", kind: "editor" },
  { id: "cursor", app: "cursor", name: "Cursor", kind: "editor" },
  { id: "zed", app: "zed", name: "Zed", kind: "editor" },
]

function scanWindowsFallback(): InstalledOpener[] {
  return WINDOWS_FALLBACK_CANDIDATES.filter((c) => Boolean(resolveAppPath(c.app))).map((c) => ({
    id: c.id,
    app: c.app,
    name: c.name,
    kind: c.kind,
  }))
}

/** Linux 上 checkAppExists 永远返回 true（见 apps.ts），不能用作真实检测，必须 spawn which */
async function whichExists(cmd: string): Promise<boolean> {
  try {
    await execFileAsync("which", [cmd])
    return true
  } catch {
    return false
  }
}

async function scanLinuxOpeners(): Promise<InstalledOpener[]> {
  const checked = await Promise.all(
    LINUX_CANDIDATES.map(async (c) => ((await whichExists(c.app)) ? c : null)),
  )
  return checked
    .filter((c): c is FallbackCandidate => c !== null)
    .map((c) => ({ id: c.id, app: c.app, name: c.name, kind: c.kind }))
}


// ============ 入口 + 缓存 + IPC 入参校验 ============

let cache: { ts: number; data: InstalledOpener[] } | null = null
const CACHE_TTL_MS = 60_000

// invoke-opener IPC 的 server-side allowlist：只允许调用最近一次扫描中真实出现过的 app
const knownOpenerApps = new Set<string>()

export async function listInstalledOpeners(): Promise<InstalledOpener[]> {
  if (cache && Date.now() - cache.ts < CACHE_TTL_MS) return cache.data

  let data: InstalledOpener[]
  if (process.platform === "darwin") {
    data = await scanMacOpeners()
  } else if (process.platform === "win32") {
    data = await scanWindowsOpeners()
  } else {
    data = await scanLinuxOpeners()
  }

  cache = { ts: Date.now(), data }
  knownOpenerApps.clear()
  for (const item of data) knownOpenerApps.add(item.app)
  return data
}

export function invalidateOpenersCache(): void {
  cache = null
}

/** 校验 renderer 传来的 opener.app 是否真出自 listInstalledOpeners 的结果 —— 防 XSS/恶意 renderer 借 invoke-opener 执行任意命令 */
export function isKnownOpenerApp(app: string): boolean {
  return knownOpenerApps.has(app)
}

const OPEN_PATH_SHORT_NAMES = new Set([
  "code",
  "cursor",
  "zed",
  "terminal",
  "iterm",
  "ghostty",
  "hyper",
  "kitty",
  "wezterm",
  "alacritty",
  "wt.exe",
  "windowsterminal.exe",
  "git-bash.exe",
  "powershell.exe",
  "pwsh.exe",
  "cmd.exe",
])

function isAllowedShortOpenPathApp(name: string) {
  const base = name.split(/[\\/]/).pop() ?? name
  return OPEN_PATH_SHORT_NAMES.has(base.toLowerCase())
}

/** open-path IPC：只允许已知 opener 或内置短名应用，禁止任意 exe 路径 */
export async function resolveOpenPathApp(app: string) {
  const trimmed = app.trim()
  if (!trimmed || /[\u0000-\u001F\u007F]/.test(trimmed)) throw new Error("Invalid app")

  if (/^[a-zA-Z]:[\\/]|^\\\\/.test(trimmed)) {
    if (knownOpenerApps.size === 0) await listInstalledOpeners()
    if (!isKnownOpenerApp(trimmed)) throw new Error("open-path: unknown app")
    return trimmed
  }

  if (knownOpenerApps.size === 0) await listInstalledOpeners()

  if (isKnownOpenerApp(trimmed)) {
    return process.platform === "win32" ? (resolveAppPath(trimmed) ?? trimmed) : trimmed
  }

  if (process.platform === "win32") {
    const resolved = resolveAppPath(trimmed)
    if (resolved && isKnownOpenerApp(resolved)) return resolved
    if (resolved && isAllowedShortOpenPathApp(trimmed) && safeExists(resolved)) return resolved
  }

  if ((process.platform === "darwin" || process.platform === "linux") && isAllowedShortOpenPathApp(trimmed)) {
    return trimmed
  }

  throw new Error(`open-path: unknown app ${trimmed}`)
}
