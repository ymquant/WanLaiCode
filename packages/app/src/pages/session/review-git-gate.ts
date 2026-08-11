export type ReviewChangeMode = "unstaged" | "staged" | "branch" | "turn"

export type ReviewVcsGitState = {
  git_installed?: boolean
  local_git?: boolean
}

export function isGitChangeMode(mode: ReviewChangeMode) {
  return mode === "unstaged" || mode === "staged" || mode === "branch"
}

export function vcsGitStatusKnown(vcs: ReviewVcsGitState | undefined) {
  return vcs?.git_installed !== undefined && vcs?.local_git !== undefined
}

export function gitFeaturesEnabled(vcs: ReviewVcsGitState | undefined) {
  return vcs?.git_installed === true && vcs?.local_git === true
}

export function gitReviewBlocked(vcs: ReviewVcsGitState | undefined) {
  return vcsGitStatusKnown(vcs) && !gitFeaturesEnabled(vcs)
}

export function defaultReviewChangeMode(vcs: ReviewVcsGitState | undefined): ReviewChangeMode {
  return gitReviewBlocked(vcs) ? "turn" : "unstaged"
}

export function reviewChangeModeOptions(vcs: ReviewVcsGitState | undefined): ReviewChangeMode[] {
  if (gitReviewBlocked(vcs)) return ["turn"]
  return ["unstaged", "staged", "branch", "turn"]
}

export function isReviewChangeModeDisabled(mode: ReviewChangeMode, vcs: ReviewVcsGitState | undefined) {
  return isGitChangeMode(mode) && gitReviewBlocked(vcs)
}

export function coerceReviewChangeModeWhenBlocked(
  mode: ReviewChangeMode,
  vcs: ReviewVcsGitState | undefined,
): ReviewChangeMode {
  if (!gitReviewBlocked(vcs)) return mode
  if (!isGitChangeMode(mode)) return mode
  return "turn"
}

export function acceptReviewChangeSelection(
  option: ReviewChangeMode | undefined,
  vcs: ReviewVcsGitState | undefined,
) {
  if (!option) return undefined
  if (isReviewChangeModeDisabled(option, vcs)) return undefined
  return option
}
