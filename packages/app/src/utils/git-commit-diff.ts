import type { VcsFileDiff } from "@opencode-ai/sdk/v2"

export type DiffStats = { files: number; additions: number; deletions: number }

export function diffStats(files: VcsFileDiff[]): DiffStats {
  let additions = 0
  let deletions = 0
  for (const file of files) {
    additions += file.additions ?? 0
    deletions += file.deletions ?? 0
  }
  return { files: files.length, additions, deletions }
}

export function mergeDiffFiles(...groups: VcsFileDiff[][]): VcsFileDiff[] {
  const merged = new Map<string, VcsFileDiff>()
  for (const group of groups) {
    for (const file of group) {
      if (!file.file) continue
      const existing = merged.get(file.file)
      if (!existing) {
        merged.set(file.file, file)
        continue
      }
      merged.set(file.file, {
        ...existing,
        additions: (existing.additions ?? 0) + (file.additions ?? 0),
        deletions: (existing.deletions ?? 0) + (file.deletions ?? 0),
        patch: file.patch ?? existing.patch,
      })
    }
  }
  return [...merged.values()]
}

/** Same selection rules as backend `VcsGenerate.commitDiff`. */
export function commitDiffFiles(input: {
  stageAll: boolean
  unstaged: VcsFileDiff[]
  staged: VcsFileDiff[]
  files?: string[]
}) {
  if (input.stageAll) return mergeDiffFiles(input.staged, input.unstaged)
  if (input.files?.length) {
    const paths = new Set(input.files)
    return mergeDiffFiles(input.staged, input.unstaged).filter((file) => paths.has(file.file))
  }
  return input.staged
}

export function commitHasChanges(input: {
  stageAll: boolean
  unstaged: VcsFileDiff[]
  staged: VcsFileDiff[]
  files?: string[]
}) {
  return commitDiffFiles(input).length > 0
}

export function commitNoChangesMessage(stageAll: boolean, translate: (key: string) => string) {
  if (stageAll) return translate("dialog.commit.noChanges.all")
  return translate("dialog.commit.noChanges.stagedOnly")
}
