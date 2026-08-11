export type GitOpsPrimaryAction = "commit" | "push"

export const envRowEndIconClass = "env-row-end-icon shrink-0 transition-transform origin-center"

export const envBranchIconProps = {
  name: "git-branch-filled" as const,
  size: "small" as const,
  class: "shrink-0 text-icon-weak",
  viewBox: "0 0 1024 1024",
}

export function gitOpsPrimaryAction(hasUncommitted: boolean, needsPush: boolean): GitOpsPrimaryAction {
  if (hasUncommitted) return "commit"
  if (needsPush) return "push"
  return "commit"
}

export function gitOpsPrimaryEnabled(
  hasUncommitted: boolean,
  needsPush: boolean,
  action: GitOpsPrimaryAction,
): boolean {
  if (action === "commit") return hasUncommitted
  return needsPush
}

export function gitOpsCommitMenuItemDisabled(hasUncommitted: boolean): boolean {
  return !hasUncommitted
}

export function gitOpsPushMenuItemDisabled(needsPush: boolean): boolean {
  return !needsPush
}
