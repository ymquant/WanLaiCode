import { spawnSync } from "child_process"
import whichPkg from "which"
import path from "path"
import { Global } from "@opencode-ai/core/global"

let windowsRegistryPathCache: string | undefined
let windowsPathEnsured = false

function readRegistryPath(key: string) {
  const out = spawnSync("reg", ["query", key, "/v", "Path"], {
    encoding: "utf8",
    windowsHide: true,
  })
  if (out.status !== 0 || !out.stdout) return ""
  const line = out.stdout.split(/\r?\n/).find((row) => /^\s*Path\s+REG/i.test(row))
  if (!line) return ""
  const match = line.match(/REG(?:_EXPAND_SZ|_SZ)\s+(.+)$/i)
  return match?.[1]?.trim() ?? ""
}

export function expandWindowsEnv(value: string, vars: NodeJS.ProcessEnv) {
  return value.replace(/%([^%]+)%/g, (_, name: string) => vars[name] ?? `%${name}%`)
}

function windowsRegistryPath() {
  if (windowsRegistryPathCache !== undefined) return windowsRegistryPathCache
  const vars = process.env
  const machine = expandWindowsEnv(
    readRegistryPath("HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment"),
    vars,
  )
  const user = expandWindowsEnv(readRegistryPath("HKCU\\Environment"), vars)
  windowsRegistryPathCache = [machine, user].filter(Boolean).join(path.delimiter)
  return windowsRegistryPathCache
}

export function mergePathSegments(...segments: string[]) {
  const seen = new Set<string>()
  const out: string[] = []
  for (const segment of segments.join(path.delimiter).split(path.delimiter)) {
    if (!segment) continue
    const key = process.platform === "win32" ? segment.toLowerCase() : segment
    if (seen.has(key)) continue
    seen.add(key)
    out.push(segment)
  }
  return out.join(path.delimiter)
}

/** Electron and other GUI launchers often inherit a stale/minimal PATH on Windows. */
export function ensureWindowsPath() {
  if (process.platform !== "win32" || windowsPathEnsured) return
  windowsPathEnsured = true
  const current = process.env.PATH ?? process.env.Path ?? ""
  const merged = mergePathSegments(current, windowsRegistryPath())
  if (merged === current) return
  process.env.PATH = merged
  if (process.env.Path) process.env.Path = merged
}

export function which(cmd: string, env?: NodeJS.ProcessEnv) {
  if (!env) ensureWindowsPath()
  const base = env?.PATH ?? env?.Path ?? process.env.PATH ?? process.env.Path ?? ""
  const full = base ? base + path.delimiter + Global.Path.bin : Global.Path.bin
  const result = whichPkg.sync(cmd, {
    nothrow: true,
    path: full,
    pathExt: env?.PATHEXT ?? env?.PathExt ?? process.env.PATHEXT ?? process.env.PathExt,
  })
  return typeof result === "string" ? result : null
}
