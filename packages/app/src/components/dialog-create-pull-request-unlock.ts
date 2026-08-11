import type { VcsPullRequestReadiness } from "@opencode-ai/sdk/v2"

export type PrMode = "create" | "push-and-create" | "commit-push-and-create"

export type PrUnlockReason =
  | "no-git"
  | "gh-cli"
  | "gh-auth"
  | "remote"
  | "branch"
  | "no-changes"
  | "no-commits"
  | "nothing-to-push"
  | "branch-not-on-remote"
  | "branch-not-pushed"
  | "push-for-web"
  | "uncommitted-changes"
  | "existing-pull-request"

const baseFailure = (readiness: VcsPullRequestReadiness): PrUnlockReason | undefined => {
  if (!readiness.git_repo) return "no-git"
  if (!readiness.gh_cli) return "gh-cli"
  if (!readiness.gh_authenticated) return "gh-auth"
  if (!readiness.remote) return "remote"
  if (!readiness.branch) return "branch"
  return undefined
}

const needsPush = (readiness: VcsPullRequestReadiness) => readiness.unpushed_commits

const dirty = (readiness: VcsPullRequestReadiness) =>
  readiness.worktree_changes || readiness.staged_changes

const modePreconditionFailure = (
  readiness: VcsPullRequestReadiness,
  mode: PrMode,
): PrUnlockReason | undefined => {
  if (!readiness.branch_on_remote) return "branch-not-on-remote"
  if (readiness.existing_pull_request?.url) return "existing-pull-request"

  if (mode === "commit-push-and-create") {
    if (!readiness.worktree_changes && !readiness.staged_changes) return "no-changes"
    return undefined
  }

  if (mode === "push-and-create") {
    if (!readiness.has_commits) return "no-commits"
    if (!needsPush(readiness)) return "nothing-to-push"
    return undefined
  }

  if (readiness.unpushed_commits) return "branch-not-pushed"
  if (!readiness.has_commits) return "no-commits"
  return undefined
}

/** 当前应执行的唯一步骤：先提交 → 再推送 → 最后创建 PR */
export function preferredPrMode(readiness: VcsPullRequestReadiness): PrMode | undefined {
  if (readiness.existing_pull_request?.url) return undefined
  if (baseFailure(readiness)) return undefined
  if (!readiness.branch_on_remote) return undefined
  if (readiness.worktree_changes || readiness.staged_changes) return "commit-push-and-create"
  if (!readiness.has_commits) return undefined
  if (needsPush(readiness)) return "push-and-create"
  return "create"
}

export function prModeUnlock(
  readiness: VcsPullRequestReadiness,
  mode: PrMode,
): { enabled: boolean; reason?: PrUnlockReason } {
  const base = baseFailure(readiness)
  if (base) return { enabled: false, reason: base }

  const preferred = preferredPrMode(readiness)
  if (preferred === mode) return { enabled: true }

  const reason = modePreconditionFailure(readiness, mode)
  return { enabled: false, reason }
}

export function defaultPrMode(readiness: VcsPullRequestReadiness): PrMode {
  return preferredPrMode(readiness) ?? "commit-push-and-create"
}

export function openPageBlockReason(
  readiness: VcsPullRequestReadiness,
  mode: PrMode,
): PrUnlockReason | undefined {
  if (!readiness.branch_on_remote) return "push-for-web"
  const unlock = prModeUnlock(readiness, mode)
  if (unlock.enabled) return undefined
  return unlock.reason
}

/** 步骤悬停提示：在解锁原因之外，补充「非当前步骤」等场景文案 */
export function prModeStepHint(
  readiness: VcsPullRequestReadiness,
  mode: PrMode,
): PrUnlockReason | undefined {
  const unlock = prModeUnlock(readiness, mode)
  if (unlock.enabled) return undefined

  const preferred = preferredPrMode(readiness)
  if (preferred === "commit-push-and-create" && dirty(readiness)) {
    if (mode === "create" && readiness.unpushed_commits) return "branch-not-pushed"
    if (mode === "create" || mode === "push-and-create") return "uncommitted-changes"
  }

  if (unlock.reason) return unlock.reason
  return undefined
}
