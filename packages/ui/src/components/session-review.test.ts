import { describe, expect, test } from "bun:test"
import {
  sessionReviewHasPatch,
  sessionReviewPatchClipboardText,
  visibleSessionReviewDiffs,
} from "./session-review-performance"

describe("SessionReview", () => {
  test("keeps unchanged diff rows stable across refreshes", async () => {
    const source = await Bun.file(new URL("./session-review.tsx", import.meta.url)).text()

    expect(source).toContain("function signature(diff: ReviewDiff)")
    expect(source).toContain("const items = createMemo(")
    expect(source).toContain("(previous: Item[]) =>")
    expect(source).toContain("const previousByFile = new Map(previous.map((item) => [item.file, item]))")
    expect(source).toContain("if (previous?.signature === next && previous.preloaded === diff.preloaded) return previous")
  })

  test("renders expanded diffs directly without a placeholder flash", async () => {
    const source = await Bun.file(new URL("./session-review.tsx", import.meta.url)).text()

    expect(source).not.toContain("session-review-diff-placeholder")
    expect(source).not.toContain("REVIEW_MOUNT_MARGIN")
    expect(source).toContain("<Show when={expanded()}>")
    expect(source).toContain("<Match when={tooLarge()}>")
    expect(source).toContain('<For each={[`${file}:${diff.signature}`]}>')
    expect(source).toContain("MAX_INLINE_DIFF_RENDER_LINES")
    expect(source).toContain("MAX_INLINE_DIFF_RENDER_CHARS")
    expect(source).toContain("const diffNeedsLocalVirtual = createMemo(")
    expect(source).toContain('virtual={diffNeedsLocalVirtual() ? "local" : false}')
    expect(source).toContain("<Dynamic")
  })

  test("renders only the focused file when a review contains more than 120 files", () => {
    const diffs = Array.from({ length: 121 }, (_, index) => ({ file: `src/file-${index}.ts` }))

    // 超大评审初次进入只渲染首个文件，文件树聚焦后再替换为用户选择的文件。
    expect(visibleSessionReviewDiffs(diffs)).toEqual([diffs[0]])
    expect(visibleSessionReviewDiffs(diffs, "src/file-87.ts")).toEqual([diffs[87]])
    expect(visibleSessionReviewDiffs(diffs, "missing.ts")).toEqual([diffs[0]])
  })

  test("keeps small reviews fully visible", () => {
    const diffs = Array.from({ length: 120 }, (_, index) => ({ file: `src/file-${index}.ts` }))

    // 常规评审维持原有完整文件列表，性能保护不能改变日常审核流程。
    expect(visibleSessionReviewDiffs(diffs, "src/file-87.ts")).toBe(diffs)
  })

  test("builds the complete git apply payload only for the copy action", () => {
    const diffs = [{ patch: " first " }, { patch: "" }, { patch: "second" }]

    // 菜单可用性只扫描 patch，真正复制时仍包含全部文件且保持原命令头。
    expect(sessionReviewHasPatch(diffs)).toBe(true)
    expect(sessionReviewHasPatch([{ patch: "" }, {}])).toBe(false)
    expect(sessionReviewPatchClipboardText(diffs)).toBe(
      "# Save as patch.diff, then run: git apply --whitespace=nowarn patch.diff\n\nfirst\n\nsecond",
    )
  })
})
