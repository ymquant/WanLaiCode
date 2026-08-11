import { execFile, execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, extname, join } from "node:path"
import { promisify } from "node:util"
import { app } from "electron"
import { CHANNEL } from "./constants"
import { wslPath } from "./wsl-path"

export { wslPath }

const execFileAsync = promisify(execFile)

function macosAppCandidates(appName: string): string[] {
  const home = process.env.HOME
  const dirs = [
    "/Applications",
    "/Applications/Utilities",
    "/System/Applications",
    "/System/Applications/Utilities",
    ...(home ? [`${home}/Applications`] : []),
  ]
  return dirs.map((dir) => `${dir}/${appName}.app`)
}

function findMacosAppPath(appName: string): string | null {
  for (const candidate of macosAppCandidates(appName)) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

export function iconsDir() {
  return join(app.getAppPath(), "icons", CHANNEL)
}

export function iconPath() {
  return join(iconsDir(), process.platform === "win32" ? "icon.ico" : process.platform === "darwin" ? "icon.icns" : "icon.png")
}

export function checkAppExists(appName: string): boolean {
  if (process.platform === "win32") return true
  if (process.platform === "linux") return true
  return checkMacosApp(appName)
}

export function resolveAppPath(appName: string): string | null {
  if (process.platform !== "win32") return appName
  return resolveWindowsAppPath(appName)
}

function checkMacosApp(appName: string) {
  if (findMacosAppPath(appName)) return true

  try {
    execFileSync("which", [appName])
    return true
  } catch {
    return false
  }
}

async function findIcnsPath(appPath: string): Promise<string | null> {
  const resourcesDir = join(appPath, "Contents", "Resources")
  // 1) Info.plist 里 CFBundleIconFile（少数 app 用 CFBundleIcons → CFBundlePrimaryIcon）
  try {
    const plistPath = join(appPath, "Contents", "Info.plist")
    const { stdout } = await execFileAsync("plutil", [
      "-extract",
      "CFBundleIconFile",
      "raw",
      "-o",
      "-",
      plistPath,
    ])
    const raw = stdout.trim()
    if (raw && raw !== "null") {
      const name = raw.toLowerCase().endsWith(".icns") ? raw : `${raw}.icns`
      const full = join(resourcesDir, name)
      if (existsSync(full)) return full
    }
  } catch {
    // 没有这个 key 或 plutil 失败，继续走下面的扫描
  }
  // 2) 扫 Resources/ 下任意 .icns（多数 app 只有 1 个）
  try {
    const icns = readdirSync(resourcesDir).find((entry) => entry.toLowerCase().endsWith(".icns"))
    if (icns) return join(resourcesDir, icns)
  } catch {
    // ignore
  }
  return null
}

// 缓存：避免对每个会话/每次菜单打开都重新跑 sips
const iconCache = new Map<string, string | null>()

async function renderIcnsViaSips(icnsPath: string): Promise<string | null> {
  // 用 macOS 自带 sips 把 .icns 渲成单图 PNG —— 比 nativeImage.createFromPath 解多分辨率 icns 稳得多
  // （后者在 Electron 41 + ARM macOS 上调用 resize/toDataURL 会触发 DCHECK SIGTRAP）
  // 必须用 execFile 异步：sips 单次 ~50ms，串行 N 个会冻结主进程数百毫秒
  let dir: string | null = null
  try {
    dir = mkdtempSync(join(tmpdir(), "wlc-icon-"))
    const out = join(dir, "icon.png")
    await execFileAsync("sips", ["-s", "format", "png", "-Z", "64", icnsPath, "--out", out], {
      // 默认 maxBuffer 够；图标 PNG < 100KB
    })
    const buf = readFileSync(out)
    return `data:image/png;base64,${buf.toString("base64")}`
  } catch {
    return null
  } finally {
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // ignore
      }
    }
  }
}

export async function getAppIconDataUrl(appName: string): Promise<string | null> {
  if (process.platform !== "darwin") return null
  const cached = iconCache.get(appName)
  if (cached !== undefined) return cached

  const appPath = findMacosAppPath(appName)
  if (!appPath) {
    iconCache.set(appName, null)
    return null
  }

  const icnsPath = await findIcnsPath(appPath)
  if (icnsPath) {
    const dataUrl = await renderIcnsViaSips(icnsPath)
    if (dataUrl) {
      iconCache.set(appName, dataUrl)
      return dataUrl
    }
  }

  // 回退：极个别 app 没 .icns（例如基于 Electron 的，用 PNG/ICO）—— 让 Electron 走 NSWorkspace 兜底
  try {
    const image = await app.getFileIcon(appPath, { size: "large" })
    if (image.isEmpty()) {
      iconCache.set(appName, null)
      return null
    }
    const dataUrl = image.toDataURL()
    iconCache.set(appName, dataUrl)
    return dataUrl
  } catch {
    iconCache.set(appName, null)
    return null
  }
}

// macOS: keep behavior backward-compatible — callers pass the bundle name to `open -a`;
// 这里返回 .app 完整路径只是给图标提取等用途。
export { findMacosAppPath as resolveMacosAppPath }

function resolveWindowsAppPath(appName: string): string | null {
  let output: string
  try {
    output = execFileSync("where", [appName]).toString()
  } catch {
    return null
  }

  const paths = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)

  const hasExt = (path: string, ext: string) => extname(path).toLowerCase() === `.${ext}`

  const exe = paths.find((path) => hasExt(path, "exe"))
  if (exe) return exe

  const resolveCmd = (path: string) => {
    const content = readFileSync(path, "utf8")
    for (const token of content.split('"').map((value: string) => value.trim())) {
      const lower = token.toLowerCase()
      if (!lower.includes(".exe")) continue

      const index = lower.indexOf("%~dp0")
      if (index >= 0) {
        const base = dirname(path)
        const suffix = token.slice(index + 5)
        const resolved = suffix
          .replace(/\//g, "\\")
          .split("\\")
          .filter((part: string) => part && part !== ".")
          .reduce((current: string, part: string) => {
            if (part === "..") return dirname(current)
            return join(current, part)
          }, base)

        if (existsSync(resolved)) return resolved
      }

      if (existsSync(token)) return token
    }

    return null
  }

  for (const path of paths) {
    if (hasExt(path, "cmd") || hasExt(path, "bat")) {
      const resolved = resolveCmd(path)
      if (resolved) return resolved
    }

    if (!extname(path)) {
      const cmd = `${path}.cmd`
      if (existsSync(cmd)) {
        const resolved = resolveCmd(cmd)
        if (resolved) return resolved
      }

      const bat = `${path}.bat`
      if (existsSync(bat)) {
        const resolved = resolveCmd(bat)
        if (resolved) return resolved
      }
    }
  }

  const key = appName
    .split("")
    .filter((value: string) => /[a-z0-9]/i.test(value))
    .map((value: string) => value.toLowerCase())
    .join("")

  if (key) {
    for (const path of paths) {
      const dirs = [dirname(path), dirname(dirname(path)), dirname(dirname(dirname(path)))]
      for (const dir of dirs) {
        try {
          for (const entry of readdirSync(dir)) {
            const candidate = join(dir, entry)
            if (!hasExt(candidate, "exe")) continue
            const stem = entry.replace(/\.exe$/i, "")
            const name = stem
              .split("")
              .filter((value: string) => /[a-z0-9]/i.test(value))
              .map((value: string) => value.toLowerCase())
              .join("")
            if (name.includes(key) || key.includes(name)) return candidate
          }
        } catch {
          continue
        }
      }
    }
  }

  return paths[0] ?? null
}
