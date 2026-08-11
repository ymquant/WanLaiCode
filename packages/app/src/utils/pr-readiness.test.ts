import { describe, expect, test } from "bun:test"
import { emptyPrReadiness, mergePullRequestStatus } from "./pr-readiness"

describe("pr-readiness", () => {
  test("mergePullRequestStatus preserves readiness fields while updating status", () => {
    const merged = mergePullRequestStatus(
      {
        ...emptyPrReadiness(),
        git_repo: true,
        remote: true,
        unpushed_commits: true,
        branch: "old",
      },
      {
        git_repo: true,
        gh_cli: true,
        gh_authenticated: true,
        branch: "feature",
        existing_pull_request: { title: "My PR", url: "https://github.com/o/r/pull/1" },
      },
    )
    expect(merged.gh_cli).toBe(true)
    expect(merged.gh_authenticated).toBe(true)
    expect(merged.existing_pull_request?.url).toBe("https://github.com/o/r/pull/1")
    expect(merged.unpushed_commits).toBe(true)
    expect(merged.branch).toBe("feature")
  })

  test("mergePullRequestStatus clears existing PR when status omits it", () => {
    const merged = mergePullRequestStatus(
      {
        ...emptyPrReadiness(),
        git_repo: true,
        existing_pull_request: { title: "Closed", url: "https://github.com/o/r/pull/2" },
      },
      {
        git_repo: true,
        gh_cli: true,
        gh_authenticated: true,
        branch: "feature",
      },
    )
    expect(merged.existing_pull_request).toBeUndefined()
  })
})
