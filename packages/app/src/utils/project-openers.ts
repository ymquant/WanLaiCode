import type { AppIconProps } from "@opencode-ai/ui/app-icon"

/**
 * 已知应用的本地化 label key 与 sprite 图标映射。
 * key 优先匹配 bundle id（macOS），未命中再按小写 app 名匹配。
 * 未在表内的应用走 OS 报告的 name + 主进程提取的 iconDataUrl。
 */
type KnownOpener = {
  labelKey?: string
  iconId?: AppIconProps["id"]
}

const BUNDLE_ID_OVERRIDES: Record<string, KnownOpener> = {
  // 编辑器
  "com.microsoft.VSCode": { labelKey: "session.header.open.app.vscode", iconId: "vscode" },
  "com.microsoft.VSCodeInsiders": { labelKey: "session.header.open.app.vscode", iconId: "vscode" },
  "com.todesktop.230313mzl4w4u92": { labelKey: "session.header.open.app.cursor", iconId: "cursor" },
  "dev.zed.Zed": { labelKey: "session.header.open.app.zed", iconId: "zed" },
  "dev.zed.Zed-Preview": { labelKey: "session.header.open.app.zed", iconId: "zed" },
  "com.apple.dt.Xcode": { labelKey: "session.header.open.app.xcode", iconId: "xcode" },
  "com.google.android.studio": { labelKey: "session.header.open.app.androidStudio", iconId: "android-studio" },
  "com.sublimetext.4": { labelKey: "session.header.open.app.sublimeText", iconId: "sublime-text" },
  "com.sublimetext.3": { labelKey: "session.header.open.app.sublimeText", iconId: "sublime-text" },
  "com.macromates.TextMate": { labelKey: "session.header.open.app.textmate", iconId: "textmate" },
  "com.google.Antigravity": { labelKey: "session.header.open.app.antigravity", iconId: "antigravity" },
  // 终端
  "com.apple.Terminal": { labelKey: "session.header.open.app.terminal", iconId: "terminal" },
  "com.googlecode.iterm2": { labelKey: "session.header.open.app.iterm2", iconId: "iterm2" },
  "com.mitchellh.ghostty": { labelKey: "session.header.open.app.ghostty", iconId: "ghostty" },
  "dev.warp.Warp-Stable": { labelKey: "session.header.open.app.warp", iconId: "warp" },
  "dev.warp.Warp": { labelKey: "session.header.open.app.warp", iconId: "warp" },
}

const APP_NAME_OVERRIDES: Record<string, KnownOpener> = {
  // 非 macOS 平台或主进程缺 bundle id 时按 name 兜底（exact 小写匹配，version 后缀走前缀规则）
  "visual studio code": { labelKey: "session.header.open.app.vscode", iconId: "vscode" },
  "visual studio code insiders": { labelKey: "session.header.open.app.vscode", iconId: "vscode" },
  cursor: { labelKey: "session.header.open.app.cursor", iconId: "cursor" },
  zed: { labelKey: "session.header.open.app.zed", iconId: "zed" },
  warp: { labelKey: "session.header.open.app.warp", iconId: "warp" },
  terminal: { labelKey: "session.header.open.app.terminal", iconId: "terminal" },
  iterm: { labelKey: "session.header.open.app.iterm2", iconId: "iterm2" },
  iterm2: { labelKey: "session.header.open.app.iterm2", iconId: "iterm2" },
  ghostty: { labelKey: "session.header.open.app.ghostty", iconId: "ghostty" },
  xcode: { labelKey: "session.header.open.app.xcode", iconId: "xcode" },
  "android studio": { labelKey: "session.header.open.app.androidStudio", iconId: "android-studio" },
  "sublime text": { labelKey: "session.header.open.app.sublimeText", iconId: "sublime-text" },
  textmate: { labelKey: "session.header.open.app.textmate", iconId: "textmate" },
  antigravity: { labelKey: "session.header.open.app.antigravity", iconId: "antigravity" },
  // Windows
  powershell: { labelKey: "session.header.open.app.powershell", iconId: "powershell" },
  "powershell.exe": { labelKey: "session.header.open.app.powershell", iconId: "powershell" },
  "windows powershell": { labelKey: "session.header.open.app.powershell", iconId: "powershell" },
}

// 把 name 规范化：小写 + 剥尾部 " <版本号>"（如 "Sublime Text 4" → "sublime text"）
function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+\d+(?:\.\d+)*[a-z]*\s*$/i, "")
    .trim()
}

export function knownOpenerOverride(opts: { bundleId?: string; app: string; name?: string }): KnownOpener {
  if (opts.bundleId && BUNDLE_ID_OVERRIDES[opts.bundleId]) return BUNDLE_ID_OVERRIDES[opts.bundleId]
  const candidates = [opts.name, opts.app].filter((v): v is string => Boolean(v))
  for (const c of candidates) {
    const lc = c.toLowerCase()
    if (APP_NAME_OVERRIDES[lc]) return APP_NAME_OVERRIDES[lc]
    const norm = normalizeName(c)
    if (norm !== lc && APP_NAME_OVERRIDES[norm]) return APP_NAME_OVERRIDES[norm]
  }
  return {}
}
