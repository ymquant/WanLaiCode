import { describe, expect, test } from "bun:test"
import { resolveVisibleSessionDirs } from "./session-dirs"

type Project = {
  worktree: string
  sandboxes?: string[]
}

const resolve = (input: Partial<Parameters<typeof resolveVisibleSessionDirs<Project>>[0]>) =>
  resolveVisibleSessionDirs<Project>({
    activeDir: undefined,
    scratchDir: undefined,
    project: undefined,
    workspaceEnabled: false,
    workspaceExpanded: {},
    projectWorktree: (project) => project.worktree,
    workspaceIds: (project) => [project.worktree, ...(project.sandboxes ?? [])],
    ...input,
  })

describe("resolveVisibleSessionDirs", () => {
  test("keeps scratch route visible even when no current project exists", () => {
    expect(resolve({ activeDir: "/tmp/scratch-sessions", scratchDir: "/tmp/scratch-sessions" })).toEqual([
      "/tmp/scratch-sessions",
    ])
  })

  test("returns no dirs when a non-scratch route has no current project", () => {
    expect(resolve({ activeDir: "/tmp/regular" })).toEqual([])
  })

  test("returns project worktree when workspaces are disabled", () => {
    expect(resolve({ project: { worktree: "/tmp/project" } })).toEqual(["/tmp/project"])
  })

  test("includes expanded workspaces and the active workspace when workspaces are enabled", () => {
    expect(
      resolve({
        activeDir: "/tmp/project/w2",
        project: { worktree: "/tmp/project", sandboxes: ["/tmp/project/w1", "/tmp/project/w2"] },
        workspaceEnabled: true,
        workspaceExpanded: { "/tmp/project/w1": true },
      }),
    ).toEqual(["/tmp/project", "/tmp/project/w1", "/tmp/project/w2"])
  })
})
