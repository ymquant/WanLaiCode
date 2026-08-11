import { encodeFilePath } from "@/context/file/path"
import type { MarkdownPathResolution } from "@opencode-ai/ui/context"

const LINE_SUFFIX = /\s*\(\s*line\s+\d+\s*\)\s*$/i

export function stripMarkdownLineSuffix(raw: string): string {
  return raw.replace(LINE_SUFFIX, "").trim()
}

export function markdownPathTooltipTitle(absolutePath: string, rawDisplay: string): string {
  const lineMatch = rawDisplay.match(LINE_SUFFIX)
  return lineMatch ? `${absolutePath}${lineMatch[0]}` : absolutePath
}

export function localPathFromFileUrl(raw: string): string {
  if (!raw.toLowerCase().startsWith("file://")) return raw
  try {
    const decoded = decodeURIComponent(new URL(raw).pathname)
    if (/^\/[A-Za-z]:[\/]/.test(decoded)) return decoded.slice(1)
    return decoded
  } catch {
    const decoded = raw.replace(/^file:\/\//i, "")
    if (/^\/[A-Za-z]:[\/]/.test(decoded)) return decoded.slice(1)
    return decoded
  }
}

function markdownWorkspacePathTooltipTitle(absolutePath: string, rawDisplay: string, relativePath: string): string {
  if (isAbsolutePath(stripMarkdownLineSuffix(rawDisplay.trim()))) return markdownPathTooltipTitle(absolutePath, rawDisplay)
  const lineMatch = rawDisplay.match(LINE_SUFFIX)
  return lineMatch ? `${relativePath}${lineMatch[0]}` : relativePath
}

export function looksLikeMarkdownPathCandidate(raw: string): boolean {
  const s = stripMarkdownLineSuffix(raw.trim())
  if (!s || s.length > 512) return false
  if (/[\n\r]/.test(s)) return false
  if (/^https?:\/\//i.test(s)) return false
  if (/\s/.test(s) && !isAbsolutePath(s)) return false
  if (s.includes("/") || s.includes("\\")) return true
  if (s.endsWith("/")) return true
  if (/\.[a-zA-Z0-9]{1,12}$/.test(s)) return true
  return false
}

function normalizeSlashes(s: string): string {
  return s.replace(/\\/g, "/")
}

function normalizeLocalPathDisplay(s: string): string {
  const normalized = normalizeSlashes(s)
  if (/^\/[A-Za-z]:\//.test(normalized)) return normalized.slice(1)
  return normalized
}

function pathUnderWorkspace(workspace: string, absolute: string): boolean {
  const w = normalizeLocalPathDisplay(workspace).replace(/\/+$/, "").toLowerCase()
  const a = normalizeLocalPathDisplay(absolute).replace(/\/+$/, "").toLowerCase()
  return a === w || a.startsWith(w + "/")
}

function relativeFromWorkspace(workspace: string, absolute: string): string {
  const w = normalizeLocalPathDisplay(workspace).replace(/\/+$/, "")
  const a = normalizeLocalPathDisplay(absolute)
  if (a === w) return "."
  if (!a.startsWith(w + "/")) return ""
  return a.slice(w.length + 1)
}

function resolveRelativeAgainstWorkspace(workspace: string, relInput: string): string | undefined {
  const root = normalizeLocalPathDisplay(workspace).replace(/\/+$/, "")
  const segments = normalizeSlashes(relInput.trim())
    .replace(/^(\.\/)+/, "")
    .split("/")
    .filter(Boolean)
  const stack: string[] = []
  for (const seg of segments) {
    if (seg === ".") continue
    if (seg === "..") {
      if (stack.length === 0) return undefined
      stack.pop()
    } else {
      stack.push(seg)
    }
  }
  return `${root}/${stack.join("/")}`
}

function isAbsolutePath(p: string): boolean {
  const n = normalizeSlashes(p)
  return n.startsWith("/") || /^[a-zA-Z]:\//.test(n)
}

function absoluteLocalPathFallback(workspace: string, raw: string): MarkdownPathResolution | undefined {
  const pathOnly = stripMarkdownLineSuffix(raw.trim())
  if (!isAbsolutePath(pathOnly)) return undefined

  const absolutePath = normalizeSlashes(pathOnly).replace(/\/+$/, "")
  if (!absolutePath || pathUnderWorkspace(workspace, absolutePath)) return undefined

  const basename = pathBasename(absolutePath)
  return {
    absolutePath,
    href: `file://${encodeFilePath(absolutePath)}`,
    kind: /\.[a-zA-Z0-9]{1,12}$/.test(basename) ? "file" : "directory",
    title: markdownPathTooltipTitle(absolutePath, raw),
  }
}

/** Relative path for `file.exists` query (posix, under workspace). */
export function pathQueryForExists(workspace: string, rawFromCode: string): string | undefined {
  const pathOnly = stripMarkdownLineSuffix(rawFromCode.trim())
  if (!pathOnly) return undefined

  const normalizedInput = normalizeSlashes(pathOnly)

  let absolute: string | undefined
  if (isAbsolutePath(normalizedInput)) {
    const abs = normalizeSlashes(normalizedInput).replace(/\/+$/, "")
    if (!pathUnderWorkspace(workspace, abs)) return undefined
    absolute = abs
  } else {
    absolute = resolveRelativeAgainstWorkspace(workspace, normalizedInput)
    if (!absolute || !pathUnderWorkspace(workspace, absolute)) return undefined
  }

  const rel = relativeFromWorkspace(workspace, absolute)
  if (!rel) return undefined
  return rel === "." ? "." : rel.split("/").join("/")
}

function absoluteFromQuery(workspace: string, queryPath: string): string {
  const w = normalizeLocalPathDisplay(workspace).replace(/\/+$/, "")
  if (queryPath === "." || queryPath === "") return w
  return `${w}/${normalizeSlashes(queryPath).replace(/^\/+/, "")}`
}

function pathBasename(filepath: string): string {
  const n = filepath.replace(/\\/g, "/")
  const i = n.lastIndexOf("/")
  return i === -1 ? n : n.slice(i + 1)
}

/** Workspace-relative paths returned by `/find/file` (POSIX separators). */
function relativePathEndsWithSuffix(rel: string, suffix: string): boolean {
  const n = normalizeSlashes(rel).replace(/^\/+/, "").replace(/\/+$/, "")
  const s = normalizeSlashes(suffix).replace(/^\/+/, "").replace(/\/+$/, "")
  if (!s || !n) return false
  return n === s || n.endsWith("/" + s)
}

/**
 * When the model omits a top-level folder (e.g. `core/a.ts` vs `extensions/foo/core/a.ts`),
 * pick the unique workspace-relative path whose tail matches `suffix`.
 */
export function pickUniqueRelativePathSuffix(
  suffix: string,
  candidates: readonly string[],
): string | undefined {
  const s = normalizeSlashes(suffix.trim()).replace(/^(\.\/)+/, "")
  if (!s || !s.includes("/")) return undefined

  const hits = candidates.filter((p) => relativePathEndsWithSuffix(p, s))
  if (hits.length !== 1) return undefined
  return hits[0]
}

export function createMarkdownWorkspacePathResolver(options: {
  workspace: string
  exists: (path: string) => Promise<{ exists: boolean; kind?: "file" | "directory" }>
  /**
   * Fuzzy file search (`/find/file`). Used with the model's path trail first, then the basename,
   * until `pickUniqueRelativePathSuffix` finds a single workspace-relative match.
   */
  findFilePaths?: (query: string, limit: number) => Promise<string[]>
}): (raw: string) => Promise<MarkdownPathResolution | undefined> {
  const cache = new Map<string, Promise<MarkdownPathResolution | undefined>>()

  return (raw: string) => {
    if (!looksLikeMarkdownPathCandidate(raw)) return Promise.resolve(undefined)
    const cached = cache.get(raw)
    if (cached) return cached

    const pending = (async (): Promise<MarkdownPathResolution | undefined> => {
      const withoutFilePrefix = localPathFromFileUrl(raw.trim())
      const pathOnly = stripMarkdownLineSuffix(withoutFilePrefix)
      const normalizedInput = normalizeSlashes(pathOnly)

      const tryResolve = async (
        rel: string | undefined,
      ): Promise<MarkdownPathResolution | undefined> => {
        if (!rel) return undefined
        const res = await options.exists(rel)
        if (!res.exists) return undefined
        const absolutePath = absoluteFromQuery(options.workspace, rel)
        const href = `file://${encodeFilePath(normalizeSlashes(absolutePath))}`
        return {
          absolutePath,
          href,
          kind: res.kind ?? "file",
          title: markdownWorkspacePathTooltipTitle(absolutePath, raw, rel),
        }
      }

      const direct = pathQueryForExists(options.workspace, withoutFilePrefix)
      const fromDirect = await tryResolve(direct)
      if (fromDirect) return fromDirect

      const fromAbsolute = absoluteLocalPathFallback(options.workspace, withoutFilePrefix)
      if (fromAbsolute) return fromAbsolute

      const findPaths = options.findFilePaths
      if (findPaths && normalizedInput && !isAbsolutePath(normalizedInput) && normalizedInput.includes("/")) {
        const suffix = normalizedInput.replace(/^(\.\/)+/, "")
        const base = pathBasename(suffix)
        if (base && base !== suffix) {
          let candidates = await findPaths(suffix, 120)
          let rel = pickUniqueRelativePathSuffix(suffix, candidates)
          if (!rel) {
            candidates = await findPaths(base, 200)
            rel = pickUniqueRelativePathSuffix(suffix, candidates)
          }
          const fromSuffix = await tryResolve(rel)
          if (fromSuffix) return fromSuffix
        }
      }

      return undefined
    })()

    cache.set(raw, pending)
    return pending
  }
}
