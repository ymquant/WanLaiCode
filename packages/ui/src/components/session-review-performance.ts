const MAX_REVIEW_FILES_RENDERED_TOGETHER = 120

export function visibleSessionReviewDiffs<T extends { file: string }>(diffs: readonly T[], focusedFile?: string) {
  // 超大评审只标准化当前文件；其余文件继续保留在文件树中，避免进入页面就解析上千份完整 patch。
  if (diffs.length <= MAX_REVIEW_FILES_RENDERED_TOGETHER) return diffs
  if (focusedFile) {
    const focused = diffs.find((item) => item.file === focusedFile)
    if (focused) return [focused]
  }
  return diffs.slice(0, 1)
}

export function isLargeSessionReview(diffs: readonly unknown[]) {
  // 阈值和可见文件选择共用同一来源，避免提示状态与实际渲染数量不一致。
  return diffs.length > MAX_REVIEW_FILES_RENDERED_TOGETHER
}

export function sessionReviewHasPatch(diffs: readonly { patch?: string }[]) {
  // 工具栏只做常量级可用性判断，不能为了展示菜单提前拼接可能达到数百 MB 的补丁文本。
  return diffs.some((item) => typeof item.patch === "string" && item.patch.length > 0)
}

export function sessionReviewPatchClipboardText(diffs: readonly { patch?: string }[]) {
  // 只有用户真正执行复制时才合并完整 patch，保持复制全部变更的原有能力。
  const patch = diffs
    .map((item) => item.patch?.trim() ?? "")
    .filter((item) => item.length > 0)
    .join("\n\n")
  if (!patch) return ""
  return `# Save as patch.diff, then run: git apply --whitespace=nowarn patch.diff\n\n${patch}`
}

export function sessionReviewDiffNeedsFullLoad(
  diff: { patch?: string; before?: string; after?: string; additions: number; deletions: number },
  totalFiles: number,
) {
  // compact 摘要只会用于超大文件集；小评审和真正无内容的文件仍维持原有行内展开行为。
  if (totalFiles <= MAX_REVIEW_FILES_RENDERED_TOGETHER) return false
  if (diff.patch?.trim() || diff.before || diff.after) return false
  return diff.additions > 0 || diff.deletions > 0
}
