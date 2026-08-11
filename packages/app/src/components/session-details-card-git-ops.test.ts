import { describe, expect, test } from "bun:test"
import {
  gitOpsCommitMenuItemDisabled,
  gitOpsPrimaryAction,
  gitOpsPrimaryEnabled,
  gitOpsPushMenuItemDisabled,
} from "./session-details-card-git-ops"

describe("session-details-card-git-ops", () => {
  test("prefers commit when there are uncommitted changes", () => {
    expect(gitOpsPrimaryAction(true, true)).toBe("commit")
    expect(gitOpsPrimaryEnabled(true, true, "commit")).toBe(true)
    expect(gitOpsPrimaryEnabled(true, true, "push")).toBe(true)
  })

  test("shows push when clean but needs push", () => {
    expect(gitOpsPrimaryAction(false, true)).toBe("push")
    expect(gitOpsPrimaryEnabled(false, true, "push")).toBe(true)
    expect(gitOpsPrimaryEnabled(false, true, "commit")).toBe(false)
  })

  test("shows disabled commit when there is nothing to commit or push", () => {
    expect(gitOpsPrimaryAction(false, false)).toBe("commit")
    expect(gitOpsPrimaryEnabled(false, false, "commit")).toBe(false)
    expect(gitOpsPrimaryEnabled(false, false, "push")).toBe(false)
  })

  test("grays commit menu item when there is nothing to commit", () => {
    expect(gitOpsCommitMenuItemDisabled(false)).toBe(true)
    expect(gitOpsCommitMenuItemDisabled(true)).toBe(false)
  })

  test("grays push menu item when there is nothing to push", () => {
    expect(gitOpsPushMenuItemDisabled(false)).toBe(true)
    expect(gitOpsPushMenuItemDisabled(true)).toBe(false)
  })
})
