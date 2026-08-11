import { describe, expect, test } from "bun:test"
import {
  defaultPrMode,
  openPageBlockReason,
  prModeStepHint,
  prModeUnlock,
  preferredPrMode,
} from "./dialog-create-pull-request-unlock"

const ready = {
  git_repo: true,
  gh_cli: true,
  gh_authenticated: true,
  remote: true,
  branch: "feature/x",
  has_commits: true,
  worktree_changes: false,
  staged_changes: false,
  unpushed_commits: false,
  branch_on_remote: true,
}

describe("dialog-create-pull-request-unlock", () => {
  test("create requires branch on remote without unpushed commits", () => {
    expect(prModeUnlock(ready, "create").enabled).toBe(true)
    expect(prModeUnlock({ ...ready, unpushed_commits: true }, "create").reason).toBe("branch-not-pushed")
    expect(prModeUnlock({ ...ready, branch_on_remote: false }, "create").reason).toBe("branch-not-on-remote")
    expect(prModeUnlock({ ...ready, has_commits: false }, "create").reason).toBe("no-commits")
  })

  test("push-and-create when there are unpushed commits", () => {
    expect(prModeUnlock({ ...ready, unpushed_commits: true }, "push-and-create").enabled).toBe(true)
    expect(prModeUnlock(ready, "push-and-create").reason).toBe("nothing-to-push")
    expect(prModeUnlock({ ...ready, branch_on_remote: false }, "push-and-create").reason).toBe(
      "branch-not-on-remote",
    )
    expect(prModeUnlock({ ...ready, branch_on_remote: false, has_commits: false }, "push-and-create").reason).toBe(
      "branch-not-on-remote",
    )
  })

  test("commit-push-and-create requires branch on remote and worktree or staged changes", () => {
    expect(prModeUnlock({ ...ready, worktree_changes: true }, "commit-push-and-create").enabled).toBe(true)
    expect(prModeUnlock({ ...ready, staged_changes: true }, "commit-push-and-create").enabled).toBe(true)
    expect(prModeUnlock(ready, "commit-push-and-create").reason).toBe("no-changes")
    expect(prModeUnlock({ ...ready, branch_on_remote: false }, "commit-push-and-create").reason).toBe(
      "branch-not-on-remote",
    )
    expect(
      prModeUnlock({ ...ready, branch_on_remote: false, worktree_changes: true }, "commit-push-and-create").reason,
    ).toBe("branch-not-on-remote")
  })

  test("only one step is enabled at a time", () => {
    const unpushed = { ...ready, unpushed_commits: true }
    expect(preferredPrMode(unpushed)).toBe("push-and-create")
    expect(prModeUnlock(unpushed, "create").enabled).toBe(false)
    expect(prModeUnlock(unpushed, "push-and-create").enabled).toBe(true)
    expect(prModeUnlock(unpushed, "commit-push-and-create").enabled).toBe(false)

    const notOnRemote = { ...ready, branch_on_remote: false }
    expect(preferredPrMode(notOnRemote)).toBe(undefined)
    expect(prModeUnlock(notOnRemote, "create").reason).toBe("branch-not-on-remote")
    expect(prModeUnlock(notOnRemote, "push-and-create").reason).toBe("branch-not-on-remote")
    expect(prModeUnlock(notOnRemote, "commit-push-and-create").reason).toBe("branch-not-on-remote")

    const dirtyNotOnRemote = { ...ready, branch_on_remote: false, worktree_changes: true }
    expect(preferredPrMode(dirtyNotOnRemote)).toBe(undefined)
    expect(prModeUnlock(dirtyNotOnRemote, "commit-push-and-create").enabled).toBe(false)

    const dirty = { ...ready, worktree_changes: true, unpushed_commits: true }
    expect(preferredPrMode(dirty)).toBe("commit-push-and-create")
    expect(prModeUnlock(dirty, "create").enabled).toBe(false)
    expect(prModeUnlock(dirty, "push-and-create").enabled).toBe(false)
    expect(prModeUnlock(dirty, "commit-push-and-create").enabled).toBe(true)
    expect(prModeStepHint(dirty, "create")).toBe("branch-not-pushed")
    expect(prModeStepHint(dirty, "push-and-create")).toBe("uncommitted-changes")
  })

  test("step hints cover non-preferred steps without precondition failures", () => {
    const dirty = { ...ready, worktree_changes: true }
    expect(prModeStepHint(dirty, "create")).toBe("uncommitted-changes")
    expect(prModeStepHint(dirty, "push-and-create")).toBe("uncommitted-changes")
    expect(prModeStepHint(dirty, "commit-push-and-create")).toBeUndefined()
  })

  test("existing open pull request disables all steps with a reason", () => {
    const existing = {
      ...ready,
      existing_pull_request: { title: "My PR", url: "https://github.com/o/r/pull/1" },
    }
    expect(preferredPrMode(existing)).toBe(undefined)
    expect(prModeUnlock(existing, "create").reason).toBe("existing-pull-request")
    expect(prModeUnlock(existing, "push-and-create").reason).toBe("existing-pull-request")
    expect(prModeUnlock(existing, "commit-push-and-create").reason).toBe("existing-pull-request")
  })

  test("defaultPrMode prefers the single enabled step, otherwise commit-push-and-create", () => {
    expect(defaultPrMode({ ...ready, worktree_changes: true })).toBe("commit-push-and-create")
    expect(defaultPrMode({ ...ready, unpushed_commits: true })).toBe("push-and-create")
    expect(defaultPrMode(ready)).toBe("create")
    expect(defaultPrMode({ ...ready, branch_on_remote: false })).toBe("commit-push-and-create")
    expect(defaultPrMode({ ...ready, branch_on_remote: false, worktree_changes: true })).toBe(
      "commit-push-and-create",
    )
  })

  test("openPageBlockReason asks to push when branch is not on remote", () => {
    const notOnRemote = { ...ready, branch_on_remote: false }
    expect(openPageBlockReason(notOnRemote, "create")).toBe("push-for-web")
    expect(openPageBlockReason(ready, "create")).toBeUndefined()
    expect(
      openPageBlockReason({ ...ready, branch_on_remote: false, worktree_changes: true }, "commit-push-and-create"),
    ).toBe("push-for-web")
  })
})
