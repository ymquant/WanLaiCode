import { describe, expect, test } from "bun:test"
import type { VcsFileDiff } from "@opencode-ai/sdk/v2"
import { commitDiffFiles, commitHasChanges, diffStats, mergeDiffFiles } from "./git-commit-diff"

const file = (path: string, additions: number, deletions = 0): VcsFileDiff => ({
  file: path,
  additions,
  deletions,
  patch: "",
})

describe("git-commit-diff", () => {
  test("mergeDiffFiles combines stats for the same path", () => {
    const merged = mergeDiffFiles(
      [file("a.ts", 5)],
      [file("a.ts", 1)],
    )
    expect(merged).toHaveLength(1)
    expect(merged[0]?.file).toBe("a.ts")
    expect(merged[0]?.additions).toBe(6)
  })

  test("commitDiffFiles sums staged and unstaged stats for stageAll", () => {
    const unstaged = [file("shared.ts", 1)]
    const staged = [file("shared.ts", 5), file("s.ts", 2)]
    expect(commitDiffFiles({ stageAll: true, unstaged, staged }).find((f) => f.file === "shared.ts")?.additions).toBe(6)
  })

  test("commitDiffFiles matches stageAll rules", () => {
    const unstaged = [file("u.ts", 1)]
    const staged = [file("s.ts", 2)]
    expect(commitDiffFiles({ stageAll: true, unstaged, staged }).map((f) => f.file).sort()).toEqual(["s.ts", "u.ts"])
    expect(commitDiffFiles({ stageAll: false, unstaged, staged }).map((f) => f.file)).toEqual(["s.ts"])
  })

  test("commitHasChanges respects staged-only mode", () => {
    const unstaged = [file("u.ts", 1)]
    expect(commitHasChanges({ stageAll: false, unstaged, staged: [] })).toBe(false)
    expect(commitHasChanges({ stageAll: true, unstaged, staged: [] })).toBe(true)
  })

  test("diffStats sums additions and deletions", () => {
    expect(
      diffStats([
        file("a.ts", 2, 1),
        file("b.ts", 3, 4),
      ]),
    ).toEqual({ files: 2, additions: 5, deletions: 5 })
  })
})
