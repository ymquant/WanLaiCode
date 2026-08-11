import { describe, expect, test } from "bun:test"
import {
  existingPullRequestFromGhList,
  existingPullRequestFromGhOutput,
  existingPullRequestFromGhView,
  pullRequestCreateArgs,
} from "../../src/project/vcs"

describe("vcs pull request parsing", () => {
  test("existingPullRequestFromGhView accepts open PRs only", () => {
    const open = JSON.stringify({
      title: "Update docs",
      url: "https://github.com/o/r/pull/1",
      state: "OPEN",
    })
    expect(existingPullRequestFromGhView(open)).toEqual({
      title: "Update docs",
      url: "https://github.com/o/r/pull/1",
    })
    expect(
      existingPullRequestFromGhView(
        JSON.stringify({ title: "Old", url: "https://github.com/o/r/pull/2", state: "CLOSED" }),
      ),
    ).toBeUndefined()
    expect(
      existingPullRequestFromGhView(
        JSON.stringify({ title: "Merged", url: "https://github.com/o/r/pull/3", state: "MERGED" }),
      ),
    ).toBeUndefined()
  })

  test("existingPullRequestFromGhView treats missing state as open for backwards compatibility", () => {
    expect(
      existingPullRequestFromGhView(
        JSON.stringify({ title: "Legacy", url: "https://github.com/o/r/pull/9" }),
      ),
    ).toEqual({ title: "Legacy", url: "https://github.com/o/r/pull/9" })
  })

  test("existingPullRequestFromGhList parses open PR list output", () => {
    expect(
      existingPullRequestFromGhList(
        JSON.stringify([{ title: "Feature", url: "https://github.com/o/r/pull/5" }]),
      ),
    ).toEqual({ title: "Feature", url: "https://github.com/o/r/pull/5" })
    expect(existingPullRequestFromGhList("[]")).toBeUndefined()
  })

  test("existingPullRequestFromGhOutput parses already-exists errors", () => {
    const output =
      'a pull request for branch "codex/x" into branch "main" already exists: https://github.com/o/r/pull/4'
    expect(existingPullRequestFromGhOutput(output)).toEqual({
      title: "https://github.com/o/r/pull/4",
      url: "https://github.com/o/r/pull/4",
    })
  })
})

describe("pullRequestCreateArgs", () => {
  test("includes empty body when title is set without body", () => {
    expect(pullRequestCreateArgs({ title: "My PR", draft: true })).toEqual([
      "pr",
      "create",
      "--draft",
      "--title",
      "My PR",
      "--body",
      "",
    ])
  })

  test("passes title and body when both are set", () => {
    expect(pullRequestCreateArgs({ title: "My PR", body: "Details" })).toEqual([
      "pr",
      "create",
      "--title",
      "My PR",
      "--body",
      "Details",
    ])
  })

  test("uses fill when title and body are omitted", () => {
    expect(pullRequestCreateArgs({})).toEqual(["pr", "create", "--fill"])
    expect(pullRequestCreateArgs({ fill: false })).toEqual(["pr", "create"])
  })

  test("uses fill with body when only body is set", () => {
    expect(pullRequestCreateArgs({ body: "Details" })).toEqual([
      "pr",
      "create",
      "--fill",
      "--body",
      "Details",
    ])
  })

  test("uses web mode without title or body flags", () => {
    expect(pullRequestCreateArgs({ web: true, title: "Ignored", body: "Ignored" })).toEqual([
      "pr",
      "create",
      "--web",
    ])
  })
})
