import { createHash } from "node:crypto"
import { existsSync, renameSync } from "node:fs"
import { extname, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

export function environmentsRoot(userData: string) {
  return resolve(join(userData, "environments"))
}

function assertEnvironmentSegment(segment: string, label: string) {
  if (!segment || segment === "." || segment === "..") throw new Error(`Invalid environment ${label}`)
  if (/[\u0000-\u001F\u007F]/.test(segment)) throw new Error(`Invalid environment ${label}`)
  if (segment.includes("..") || segment.includes("/") || segment.includes("\\")) {
    throw new Error(`Invalid environment ${label}`)
  }
  return segment
}

function assertUnderRoot(root: string, target: string) {
  const rel = relative(root, target)
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("Invalid environment path")
}

export function resolveEnvironmentProjectDir(root: string, projectName: string) {
  const name = assertEnvironmentSegment(projectName, "project")
  const dir = resolve(root, name)
  assertUnderRoot(root, dir)
  return dir
}

export function resolveEnvironmentFilePath(root: string, projectName: string, filename: string) {
  const file = assertEnvironmentSegment(filename, "file")
  if (!file.endsWith(".toml")) throw new Error("Invalid environment file")
  const dir = resolveEnvironmentProjectDir(root, projectName)
  const filePath = resolve(dir, file)
  assertUnderRoot(dir, filePath)
  return filePath
}

export function assertLocalPath(path: string) {
  const trimmed = path.trim()
  if (!trimmed || /[\u0000-\u001F\u007F]/.test(trimmed)) throw new Error("Invalid path")
  return trimmed
}

export function assertUserDirectoryPath(dirPath: string) {
  return assertLocalPath(dirPath)
}

export function normalizeWorktreePath(worktree: string) {
  return assertLocalPath(worktree).replace(/\\/g, "/").replace(/\/+$/, "")
}

/** Hash input — keep paths distinct when normalize would collapse them (e.g. `/` vs `//`). */
function worktreeKeyMaterial(worktree: string) {
  const slash = assertLocalPath(worktree).replace(/\\/g, "/")
  const normalized = slash.replace(/\/+$/, "")
  return normalized || slash
}

const LEGACY_EMPTY_NORMALIZE_KEY = createHash("sha256").update("").digest("hex").slice(0, 16)

export function environmentProjectKey(worktree: string) {
  return createHash("sha256").update(worktreeKeyMaterial(worktree)).digest("hex").slice(0, 16)
}

function safeLegacyEnvironmentBasename(worktree: string) {
  let normalized: string
  try {
    normalized = normalizeWorktreePath(worktree)
  } catch {
    return undefined
  }
  if (!normalized) return undefined

  const parts = normalized.split("/").filter((part) => part.length > 0)
  const base = parts[parts.length - 1]
  if (!base || base === "." || base === "..") return undefined
  // `resolve(root, "C:")` on Windows jumps to the drive cwd — never use as a folder name.
  if (/^[A-Za-z]:$/.test(base)) return undefined

  try {
    return assertEnvironmentSegment(base, "project")
  } catch {
    return undefined
  }
}

function usedLegacyEmptyNormalizeKey(worktree: string) {
  try {
    // Old hash used normalizeWorktreePath, which maps both `/` and `//` to "".
    // Only the canonical global worktree `/` (project.ts) may claim that legacy dir.
    return worktreeKeyMaterial(worktree) === "/"
  } catch {
    return false
  }
}

export function resolveEnvironmentProjectDirFromWorktree(root: string, worktree: string) {
  const key = environmentProjectKey(worktree)
  const keyDir = resolveEnvironmentProjectDir(root, key)
  if (existsSync(keyDir)) return keyDir

  if (usedLegacyEmptyNormalizeKey(worktree)) {
    const legacyEmptyDir = resolveEnvironmentProjectDir(root, LEGACY_EMPTY_NORMALIZE_KEY)
    if (existsSync(legacyEmptyDir)) {
      renameSync(legacyEmptyDir, keyDir)
      return keyDir
    }
  }

  const legacy = safeLegacyEnvironmentBasename(worktree)
  if (legacy) {
    try {
      const legacyDir = resolveEnvironmentProjectDir(root, legacy)
      if (existsSync(legacyDir)) {
        renameSync(legacyDir, keyDir)
        return keyDir
      }
    } catch {
      // legacy name unsafe or resolves outside environments root — skip migration
    }
  }

  return keyDir
}

export function tryResolveEnvironmentProjectDirFromWorktree(root: string, worktree: string) {
  try {
    return resolveEnvironmentProjectDirFromWorktree(root, worktree)
  } catch {
    return undefined
  }
}

export function resolveEnvironmentFilePathFromWorktree(root: string, worktree: string, filename: string) {
  const file = assertEnvironmentSegment(filename, "file")
  if (!file.endsWith(".toml")) throw new Error("Invalid environment file")
  const dir = resolveEnvironmentProjectDirFromWorktree(root, worktree)
  const filePath = resolve(dir, file)
  assertUnderRoot(dir, filePath)
  return filePath
}

export function tryResolveEnvironmentFilePathFromWorktree(root: string, worktree: string, filename: string) {
  try {
    return resolveEnvironmentFilePathFromWorktree(root, worktree, filename)
  } catch {
    return undefined
  }
}

export function assertHttpExternalUrl(url: string) {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error("Invalid URL")
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Only http(s) URLs can be opened")
  }
  return parsed.toString()
}

export function assertSystemBrowserUrl(url: string) {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error("Invalid URL")
  }
  if (parsed.protocol === "https:" || parsed.protocol === "http:") return parsed.toString()
  if (parsed.protocol !== "file:") throw new Error("Only http(s) or local HTML file URLs can be opened")
  // 拒绝任何带 host 的 file URL（如 `file://server/share/report.html`）。
  if (parsed.host) throw new Error("Only http(s) or local HTML file URLs can be opened")
  // 四斜杠 UNC 形式 `file:////server/share/report.html` 的 host 为空，能绕过上面的 host 检查；
  // 此时 pathname 以 `//` 开头（网络路径标志）。不同运行时（bun vs Electron 的 Node）对它的
  // fileURLToPath 行为不一致（抛错 / 返回单反斜杠 / 返回双反斜杠），所以统一在 pathname 层拦截，
  // 再对解码后的本地路径做反斜杠网络路径兜底。
  if (parsed.pathname.startsWith("//")) throw new Error("Only http(s) or local HTML file URLs can be opened")
  let localPath: string
  try {
    localPath = fileURLToPath(parsed)
  } catch {
    throw new Error("Only http(s) or local HTML file URLs can be opened")
  }
  if (localPath.startsWith("\\\\") || localPath.startsWith("//")) {
    throw new Error("Only http(s) or local HTML file URLs can be opened")
  }
  const ext = extname(localPath).toLowerCase()
  if (ext !== ".html" && ext !== ".htm") throw new Error("Only http(s) or local HTML file URLs can be opened")
  return parsed.toString()
}
