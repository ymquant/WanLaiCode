import type { VcsPullRequestReadiness, VcsPullRequestStatus } from "@opencode-ai/sdk/v2"

export const PR_READINESS_STALE_MS = 30_000
export const PR_READINESS_POLL_MS = 60_000

export const emptyPrReadiness = (): VcsPullRequestReadiness => ({
  git_repo: false,
  gh_cli: false,
  gh_authenticated: false,
  remote: false,
  has_commits: false,
  worktree_changes: false,
  staged_changes: false,
  unpushed_commits: false,
  branch_on_remote: false,
})

export function prReadinessKey(vcsKey: readonly unknown[]) {
  return [...vcsKey, "pr-readiness"] as const
}

export function prStatusKey(vcsKey: readonly unknown[]) {
  return [...vcsKey, "pr-status"] as const
}

export function mergePullRequestStatus(
  current: VcsPullRequestReadiness | undefined,
  status: VcsPullRequestStatus,
): VcsPullRequestReadiness {
  return {
    ...emptyPrReadiness(),
    ...current,
    git_repo: status.git_repo,
    gh_cli: status.gh_cli,
    gh_authenticated: status.gh_authenticated,
    branch: status.branch ?? current?.branch,
    existing_pull_request: status.existing_pull_request,
  }
}
