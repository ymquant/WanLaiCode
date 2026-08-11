import { parseDiffFromFile, type FileDiffMetadata } from "@pierre/diffs"
import { formatPatch, parsePatch, structuredPatch } from "diff"
import type { SnapshotFileDiff, VcsFileDiff } from "@opencode-ai/sdk/v2"
import { patchFiles } from "./apply-patch-file"

type LegacyDiff = {
  file: string
  patch?: string
  before?: string
  after?: string
  additions: number
  deletions: number
  status?: "added" | "deleted" | "modified"
}

type ReviewDiff = SnapshotFileDiff | VcsFileDiff | LegacyDiff

export type ViewDiff = {
  file: string
  patch: string
  additions: number
  deletions: number
  status?: "added" | "deleted" | "modified"
  fileDiff: FileDiffMetadata
}

const cache = new Map<string, FileDiffMetadata>()

function patch(diff: ReviewDiff) {
  if (typeof diff.patch === "string") {
    try {
      const [patch] = parsePatch(diff.patch)
      const beforeLines: Array<{ text: string; newline: boolean }> = []
      const afterLines: Array<{ text: string; newline: boolean }> = []
      let previous: "-" | "+" | " " | undefined

      for (const hunk of patch.hunks) {
        for (const line of hunk.lines) {
          if (line.startsWith("\\")) {
            if (previous === "-" || previous === " ") {
              const before = beforeLines.at(-1)
              if (before) before.newline = false
            }
            if (previous === "+" || previous === " ") {
              const after = afterLines.at(-1)
              if (after) after.newline = false
            }
            continue
          }

          if (line.startsWith("-")) {
            beforeLines.push({ text: line.slice(1), newline: true })
            previous = "-"
          } else if (line.startsWith("+")) {
            afterLines.push({ text: line.slice(1), newline: true })
            previous = "+"
          } else {
            // context line (starts with ' ')
            beforeLines.push({ text: line.slice(1), newline: true })
            afterLines.push({ text: line.slice(1), newline: true })
            previous = " "
          }
        }
      }

      return {
        before: beforeLines.map((line) => line.text + (line.newline ? "\n" : "")).join(""),
        after: afterLines.map((line) => line.text + (line.newline ? "\n" : "")).join(""),
        patch: diff.patch,
      }
    } catch {
      return { before: "", after: "", patch: diff.patch }
    }
  }
  return {
    before: "before" in diff && typeof diff.before === "string" ? diff.before : "",
    after: "after" in diff && typeof diff.after === "string" ? diff.after : "",
    patch: formatPatch(
      structuredPatch(
        diff.file,
        diff.file,
        "before" in diff && typeof diff.before === "string" ? diff.before : "",
        "after" in diff && typeof diff.after === "string" ? diff.after : "",
        "",
        "",
        { context: Number.MAX_SAFE_INTEGER },
      ),
    ),
  }
}

function file(file: string, patch: string, before: string, after: string) {
  const hit = cache.get(patch)
  if (hit) return hit

  const value = parseDiffFromFile({ name: file, contents: before }, { name: file, contents: after })
  cache.set(patch, value)
  return value
}

export function normalize(diff: ReviewDiff): ViewDiff {
  const next = patch(diff)
  return {
    file: diff.file,
    patch: next.patch,
    additions: diff.additions,
    deletions: diff.deletions,
    status: diff.status,
    fileDiff: file(diff.file, next.patch, next.before, next.after),
  }
}

export function text(diff: ViewDiff, side: "deletions" | "additions") {
  if (side === "deletions") return diff.fileDiff.deletionLines.join("")
  return diff.fileDiff.additionLines.join("")
}

/** Normalize path for comparing turn-summary diffs with VCS diff rows */
export function diffPathKey(file: string): string {
  let k = file.replace(/\\/g, "/").replace(/\/+/g, "/")
  // Summary/tool paths sometimes end with `/` while `vcs.diff` uses the file path without it.
  while (k.length > 1 && k.endsWith("/")) k = k.slice(0, -1)
  return k
}

/** Strip workspace root so absolute summary paths align with repo-relative `vcs.diff` rows. */
export function stripWorkspaceRoot(file: string, workspaceRoot?: string): string {
  if (!workspaceRoot) return file
  const f = file.replace(/\\/g, "/")
  const r = workspaceRoot.replace(/\\/g, "/").replace(/\/+$/, "")
  if (!r) return file
  const prefix = `${r}/`
  if (f === r) return ""
  if (f.startsWith(prefix)) return f.slice(prefix.length)
  return file
}

/** Key used when merging turn summary rows with `vcs.diff` overlay. */
export function mergeDiffFileKey(file: string, workspaceRoot?: string): string {
  return diffPathKey(stripWorkspaceRoot(file, workspaceRoot))
}

/** True when inline diff can be built from patch / before / after (matches SessionTurn guard + normalize input). */
export function hasRenderableDiffBody(diff: {
  patch?: string
  before?: string
  after?: string
}): boolean {
  if (typeof diff.patch === "string" && diff.patch.trim().length > 0) return true
  if ("before" in diff && typeof diff.before === "string" && diff.before.length > 0) return true
  if ("after" in diff && typeof diff.after === "string" && diff.after.length > 0) return true
  return false
}

/** True when a unified patch contains real +/- lines (not only headers/context). */
export function gitPatchHasNonContextLines(patch: string) {
  for (const line of patch.split("\n")) {
    const row = line.endsWith("\r") ? line.slice(0, -1) : line
    if (row.startsWith("+++") || row.startsWith("---") || row.startsWith("@@")) continue
    if (row.startsWith("\\")) continue
    if (row.startsWith("+")) return true
    if (row.startsWith("-")) return true
  }
  return false
}

/** Whether the review accordion should allow expanding this row. */
export function diffRowCanExpand(diff: {
  patch?: string
  before?: string
  after?: string
  additions: number
  deletions: number
}) {
  if (diff.additions > 0 || diff.deletions > 0) return true
  if (typeof diff.patch === "string" && gitPatchHasNonContextLines(diff.patch)) return true
  return hasRenderableDiffBody(diff)
}

export type MergeableDiff = {
  file: string
  patch?: string
  before?: string
  after?: string
  additions: number
  deletions: number
  status?: "added" | "deleted" | "modified"
}

/**
 * For each base row without renderable body, substitute patch/counts from overlay when paths match.
 * Does not replace rows that already have a renderable body (turn snapshot wins).
 */
/** Aligns with session-review「已移除」label and `isDeleted()` (after empty, before non-empty). */
export function isSessionReviewFileRemoved(diff: ReviewDiff | ViewDiff): boolean {
  if (diff.status === "deleted") return true
  if (diff.additions > 0) return false
  const view: ViewDiff = "fileDiff" in diff ? diff : normalize(diff as ReviewDiff)
  const after = text(view, "additions")
  const before = text(view, "deletions")
  return after.length === 0 && before.length > 0
}

export function filterDiffRowsWithMaterialChange<T extends ReviewDiff>(rows: readonly T[]): T[] {
  return rows.filter((d) => !isSessionReviewFileRemoved(d))
}

type ToolPartLike = {
  type: string
  tool?: string
  state?: {
    status?: string
    input?: Record<string, unknown>
    metadata?: Record<string, unknown>
  }
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)

/** Collect per-file diffs from completed edit/write/apply_patch tool parts (matches SessionTurn). */
export function toolDiffsFromParts(parts: readonly ToolPartLike[]): MergeableDiff[] {
  const out: MergeableDiff[] = []

  for (const part of parts) {
    if (!part || part.type !== "tool") continue
    if (part.state?.status === "pending" || part.state?.status === "error") continue
    const metadata = record(part.state?.metadata) ? part.state.metadata : {}
    const input = record(part.state?.input) ? part.state.input : {}
    const tool = part.tool ?? ""

    if (tool === "edit" || tool === "write") {
      const filediff = record(metadata.filediff) ? metadata.filediff : undefined
      if (part.state?.status !== "completed" && !filediff) continue
      const filePath = (
        typeof filediff?.file === "string"
          ? filediff.file
          : typeof input.filePath === "string"
            ? input.filePath
            : typeof metadata.filepath === "string"
              ? metadata.filepath
              : ""
      ).toString()
      if (!filePath) continue
      const before =
        typeof filediff?.before === "string"
          ? filediff.before
          : typeof input.oldString === "string"
            ? input.oldString
            : undefined
      const after =
        typeof filediff?.after === "string"
          ? filediff.after
          : typeof input.newString === "string"
            ? input.newString
            : typeof input.content === "string"
              ? input.content
              : undefined
      out.push({
        file: filePath,
        patch: typeof filediff?.patch === "string" ? filediff.patch : "",
        before,
        after,
        additions: typeof filediff?.additions === "number" ? filediff.additions : 0,
        deletions: typeof filediff?.deletions === "number" ? filediff.deletions : 0,
        status:
          filediff?.status === "added" || filediff?.status === "deleted" || filediff?.status === "modified"
            ? filediff.status
            : metadata.exists === false
              ? "added"
              : undefined,
      })
      continue
    }

    if (tool === "apply_patch" || tool === "patch") {
      for (const file of patchFiles(metadata.files)) {
        out.push({
          file: file.relativePath,
          patch: file.view.patch,
          additions: file.additions,
          deletions: file.deletions,
          status: file.view.status,
        })
      }
    }
  }

  const seen = new Set<string>()
  const uniq: MergeableDiff[] = []
  for (let i = out.length - 1; i >= 0; i--) {
    const item = out[i]
    const key = diffPathKey(item.file)
    if (seen.has(key)) continue
    seen.add(key)
    uniq.push(item)
  }
  uniq.reverse()
  return uniq
}

export function mergeDiffsWithOverlay<T extends MergeableDiff>(
  base: readonly T[],
  overlay: readonly T[],
  opts?: { workspaceRoot?: string },
): T[] {
  const root = opts?.workspaceRoot

  if (overlay.length === 0) return [...base]
  if (base.length === 0) return [...overlay]

  const byPath = new Map<string, T>()
  for (const row of overlay) {
    const k = mergeDiffFileKey(row.file, root)
    if (!byPath.has(k)) byPath.set(k, row)
  }

  return base.map((d) => {
    if (hasRenderableDiffBody(d)) return d
    const o = byPath.get(mergeDiffFileKey(d.file, root))
    if (!o || !hasRenderableDiffBody(o)) return d
    return {
      ...d,
      patch: o.patch,
      additions: o.additions,
      deletions: o.deletions,
      status: o.status ?? d.status,
    } as T
  })
}
