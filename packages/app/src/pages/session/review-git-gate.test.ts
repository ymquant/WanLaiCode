import { describe, expect, test } from "bun:test"

import {
  acceptReviewChangeSelection,
  coerceReviewChangeModeWhenBlocked,
  defaultReviewChangeMode,
  gitReviewBlocked,
  isReviewChangeModeDisabled,
  reviewChangeModeOptions,
  vcsGitStatusKnown,
} from "./review-git-gate"

const gitReady = { git_installed: true, local_git: true } as const
const noGit = { git_installed: true, local_git: false } as const
const gitMissing = { git_installed: false, local_git: false } as const
const vcsUnknown = { git_installed: undefined, local_git: undefined } as const

describe("review git gate", () => {
  test("defaults to turn when git review is blocked", () => {
    expect(defaultReviewChangeMode(noGit)).toBe("turn")
    expect(defaultReviewChangeMode(gitMissing)).toBe("turn")
  })

  test("defaults to unstaged when git is ready or vcs is still unknown", () => {
    expect(defaultReviewChangeMode(gitReady)).toBe("unstaged")
    expect(defaultReviewChangeMode(vcsUnknown)).toBe("unstaged")
  })

  test("hides git change modes when git review is blocked", () => {
    for (const vcs of [noGit, gitMissing]) {
      expect(reviewChangeModeOptions(vcs)).toEqual(["turn"])
    }
    expect(reviewChangeModeOptions(gitReady)).toEqual(["unstaged", "staged", "branch", "turn"])
    expect(reviewChangeModeOptions(vcsUnknown)).toEqual(["unstaged", "staged", "branch", "turn"])
  })

  test("disables git change modes but keeps turn selectable when git review is blocked", () => {
    for (const vcs of [noGit, gitMissing]) {
      expect(isReviewChangeModeDisabled("unstaged", vcs)).toBe(true)
      expect(isReviewChangeModeDisabled("staged", vcs)).toBe(true)
      expect(isReviewChangeModeDisabled("branch", vcs)).toBe(true)
      expect(isReviewChangeModeDisabled("turn", vcs)).toBe(false)
    }
  })

  test("does not block while vcs git fields are still loading", () => {
    expect(vcsGitStatusKnown(vcsUnknown)).toBe(false)
    expect(gitReviewBlocked(vcsUnknown)).toBe(false)
    expect(vcsGitStatusKnown({ git_installed: true, local_git: undefined })).toBe(false)
    expect(gitReviewBlocked({ git_installed: true, local_git: undefined })).toBe(false)
    expect(isReviewChangeModeDisabled("unstaged", vcsUnknown)).toBe(false)
  })

  test("allows git modes when git is ready", () => {
    for (const mode of ["unstaged", "staged", "branch", "turn"] as const) {
      expect(isReviewChangeModeDisabled(mode, gitReady)).toBe(false)
      expect(acceptReviewChangeSelection(mode, gitReady)).toBe(mode)
    }
  })

  test("rejects selecting disabled git modes and coerces active mode back to turn", () => {
    expect(acceptReviewChangeSelection(undefined, noGit)).toBeUndefined()
    expect(acceptReviewChangeSelection("unstaged", noGit)).toBeUndefined()
    expect(acceptReviewChangeSelection("staged", noGit)).toBeUndefined()
    expect(acceptReviewChangeSelection("turn", noGit)).toBe("turn")
    expect(coerceReviewChangeModeWhenBlocked("branch", noGit)).toBe("turn")
    expect(coerceReviewChangeModeWhenBlocked("turn", noGit)).toBe("turn")
    expect(coerceReviewChangeModeWhenBlocked("unstaged", gitReady)).toBe("unstaged")
    expect(coerceReviewChangeModeWhenBlocked("turn", vcsUnknown)).toBe("turn")
  })
})
