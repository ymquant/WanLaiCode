import { describe, expect, test } from "bun:test"
import {
  normalize,
  text,
  mergeDiffsWithOverlay,
  hasRenderableDiffBody,
  gitPatchHasNonContextLines,
  diffRowCanExpand,
  isSessionReviewFileRemoved,
  toolDiffsFromParts,
  type MergeableDiff,
} from "./session-diff"

describe("session diff", () => {
  test("keeps unified patch content", () => {
    const diff = {
      file: "a.ts",
      patch:
        "Index: a.ts\n===================================================================\n--- a.ts\t\n+++ a.ts\t\n@@ -1,2 +1,2 @@\n one\n-two\n+three\n",
      additions: 1,
      deletions: 1,
      status: "modified" as const,
    }
    const view = normalize(diff)

    expect(view.patch).toBe(diff.patch)
    expect(view.fileDiff.name).toBe("a.ts")
    expect(text(view, "deletions")).toBe("one\ntwo\n")
    expect(text(view, "additions")).toBe("one\nthree\n")
  })

  test("keeps missing final newlines from unified patches", () => {
    const diff = {
      file: "a.ts",
      patch:
        "Index: a.ts\n===================================================================\n--- a.ts\t\n+++ a.ts\t\n@@ -1,2 +1,2 @@\n one\n-two\n\\ No newline at end of file\n+three\n\\ No newline at end of file\n",
      additions: 1,
      deletions: 1,
      status: "modified" as const,
    }
    const view = normalize(diff)

    expect(text(view, "deletions")).toBe("one\ntwo")
    expect(text(view, "additions")).toBe("one\nthree")
  })

  test("converts legacy content into a patch", () => {
    const diff = {
      file: "a.ts",
      before: "one\n",
      after: "two\n",
      additions: 1,
      deletions: 1,
      status: "modified" as const,
    }
    const view = normalize(diff)

    expect(view.patch).toContain("@@ -1,1 +1,1 @@")
    expect(text(view, "deletions")).toBe("one\n")
    expect(text(view, "additions")).toBe("two\n")
  })

  test("ignores malformed persisted patches", () => {
    const diff = {
      file: "a.ts",
      patch:
        "diff --git a/a.ts b/a.ts\nindex ff4ceb2..65a1de0 100644\n--- a/a.ts\n+++ b/a.ts\n@@ -1,3 +1,3 @@\n keep\n+add\n same\r",
      additions: 1,
      deletions: 1,
      status: "modified" as const,
    }
    const view = normalize(diff)

    expect(view.patch).toBe(diff.patch)
    expect(text(view, "deletions")).toBe("")
    expect(text(view, "additions")).toBe("")
  })
})

describe("diffRowCanExpand", () => {
  test("allows expand when numstat is zero but patch has hunks", () => {
    const patch =
      "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n"
    expect(gitPatchHasNonContextLines(patch)).toBe(true)
    expect(diffRowCanExpand({ patch, additions: 0, deletions: 0 })).toBe(true)
  })
})

describe("mergeDiffsWithOverlay", () => {
  test("fills patch from overlay when base only has counts", () => {
    const base: MergeableDiff[] = [
      {
        file: "extensions/foo",
        additions: 1,
        deletions: 1,
      },
    ]
    const overlay: MergeableDiff[] = [
      {
        file: "extensions/foo",
        patch: "Subproject commit aaa\n+Subproject commit bbb\n",
        additions: 1,
        deletions: 1,
      },
    ]
    const merged = mergeDiffsWithOverlay(base, overlay)
    expect(hasRenderableDiffBody(merged[0]!)).toBe(true)
    expect(merged[0]?.patch).toContain("Subproject commit")
  })

  test("does not replace row that already has patch", () => {
    const base: MergeableDiff[] = [{ file: "a.ts", patch: "keep-me", additions: 1, deletions: 0 }]
    const overlay: MergeableDiff[] = [{ file: "a.ts", patch: "other", additions: 9, deletions: 9 }]
    const merged = mergeDiffsWithOverlay(base, overlay)
    expect(merged[0]?.patch).toBe("keep-me")
  })

  test("uses overlay when base is empty", () => {
    const overlay: MergeableDiff[] = [
      { file: "a.ts", patch: "@@ ok\n-old\n+new\n", additions: 1, deletions: 1 },
    ]
    const merged = mergeDiffsWithOverlay([], overlay)
    expect(merged).toHaveLength(1)
    expect(merged[0]?.file).toBe("a.ts")
    expect(hasRenderableDiffBody(merged[0]!)).toBe(true)
  })

  test("matches overlay path with different slash normalization", () => {
    const base: MergeableDiff[] = [{ file: "pkg//sub/file.ts", additions: 1, deletions: 0 }]
    const overlay: MergeableDiff[] = [
      { file: "pkg/sub/file.ts", patch: "@@ ok\n", additions: 1, deletions: 0 },
    ]
    const merged = mergeDiffsWithOverlay(base, overlay)
    expect(hasRenderableDiffBody(merged[0]!)).toBe(true)
  })

  test("matches when base path has trailing slash (file row from summary)", () => {
    const base: MergeableDiff[] = [
      { file: "extensions/wanlai-continue/core/llm/llms/Anthropic.ts/", additions: 19, deletions: 7 },
    ]
    const overlay: MergeableDiff[] = [
      {
        file: "extensions/wanlai-continue/core/llm/llms/Anthropic.ts",
        patch: "diff --git a/extensions/.../Anthropic.ts b/...\n",
        additions: 19,
        deletions: 7,
      },
    ]
    const merged = mergeDiffsWithOverlay(base, overlay)
    expect(hasRenderableDiffBody(merged[0]!)).toBe(true)
    expect(merged[0]?.patch).toContain("diff --git")
  })

  test("matches overlay when base path is absolute under workspace root", () => {
    const root = "/Users/developer/wanlaicode"
    const base: MergeableDiff[] = [
      {
        file: "/Users/developer/wanlaicode/extensions/wanlai-continue/core/llm/Anthropic.ts",
        additions: 19,
        deletions: 7,
      },
    ]
    const overlay: MergeableDiff[] = [
      {
        file: "extensions/wanlai-continue/core/llm/Anthropic.ts",
        patch:
          "diff --git a/extensions/wanlai-continue/core/llm/Anthropic.ts b/extensions/wanlai-continue/core/llm/Anthropic.ts\n",
        additions: 19,
        deletions: 7,
      },
    ]
    const merged = mergeDiffsWithOverlay(base, overlay, { workspaceRoot: root })
    expect(hasRenderableDiffBody(merged[0]!)).toBe(true)
    expect(merged[0]?.patch).toContain("diff --git")
  })
})

describe("toolDiffsFromParts", () => {
  test("collects completed edit tool filediff", () => {
    const rows = toolDiffsFromParts([
      {
        type: "tool",
        tool: "edit",
        state: {
          status: "completed",
          input: { filePath: "prime_sum_100.py" },
          metadata: {
            filediff: {
              file: "prime_sum_100.py",
              patch: "@@\n-old\n+new\n",
              additions: 3,
              deletions: 4,
            },
          },
        },
      },
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0]?.file).toBe("prime_sum_100.py")
    expect(rows[0]?.additions).toBe(3)
    expect(rows[0]?.deletions).toBe(4)
  })

  test("ignores pending tool parts", () => {
    const rows = toolDiffsFromParts([
      {
        type: "tool",
        tool: "edit",
        state: {
          status: "running",
          input: { filePath: "a.ts" },
          metadata: {},
        },
      },
    ])
    expect(rows).toHaveLength(0)
  })

  test("marks apply_patch delete and content-emptying edit as removed", () => {
    // 输出区靠该判据回收「创建后删除」的残留条目，必须对两种删除形态都成立。
    const deleteRows = toolDiffsFromParts([
      {
        type: "tool",
        tool: "apply_patch",
        state: {
          status: "completed",
          input: {},
          metadata: {
            files: [
              {
                type: "delete",
                filePath: "foo.ts",
                relativePath: "foo.ts",
                patch: "--- a/foo.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-export const a = 1\n",
                additions: 0,
                deletions: 1,
              },
            ],
          },
        },
      },
    ])
    expect(deleteRows).toHaveLength(1)
    expect(deleteRows[0].file).toBe("foo.ts")
    expect(deleteRows[0].status).toBe("deleted")
    expect(isSessionReviewFileRemoved(deleteRows[0])).toBe(true)

    const emptied = toolDiffsFromParts([
      {
        type: "tool",
        tool: "edit",
        state: {
          status: "completed",
          input: { filePath: "bar.ts" },
          metadata: {
            filediff: {
              file: "bar.ts",
              patch: "--- a/bar.ts\n+++ b/bar.ts\n@@ -1 +0,0 @@\n-export const b = 2\n",
              additions: 0,
              deletions: 1,
              status: "modified",
            },
          },
        },
      },
    ])
    expect(emptied).toHaveLength(1)
    expect(isSessionReviewFileRemoved(emptied[0])).toBe(true)

    const added = toolDiffsFromParts([
      {
        type: "tool",
        tool: "write",
        state: {
          status: "completed",
          input: { filePath: "baz.ts", content: "export const c = 3\n" },
          metadata: {
            filediff: {
              file: "baz.ts",
              patch: "--- a/baz.ts\n+++ b/baz.ts\n@@ -0,0 +1 @@\n+export const c = 3\n",
              additions: 1,
              deletions: 0,
              status: "added",
            },
          },
        },
      },
    ])
    expect(added).toHaveLength(1)
    expect(isSessionReviewFileRemoved(added[0])).toBe(false)
  })
})
