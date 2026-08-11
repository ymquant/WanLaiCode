import { describe, expect, test } from "bun:test"
import path from "node:path"

import { MemoryPaths } from "../../src/memory"

describe("MemoryPaths", () => {
  test("derives project keys from canonical paths instead of project IDs", () => {
    const first = MemoryPaths.projectKey("/Users/developer/workspace/demo")
    const second = MemoryPaths.projectKey("/Users/developer/workspace/demo")

    expect(first).toBe(second)
    expect(first).toMatch(/^demo-[a-f0-9]{12}$/)
    expect(first).not.toContain("project-id")
  })

  test("uses the main project root for linked worktrees", () => {
    const main = "/Users/developer/workspace/demo"

    expect(
      MemoryPaths.rootCandidate({
        directory: "/Users/developer/.codex/worktrees/one/demo",
        project: { worktree: main },
      }),
    ).toBe(main)
    expect(
      MemoryPaths.rootCandidate({
        directory: "/Users/developer/.codex/worktrees/two/demo",
        project: { worktree: main },
      }),
    ).toBe(main)
  })

  test("uses the current directory for non-git projects", () => {
    expect(
      MemoryPaths.rootCandidate({
        directory: "/Users/developer/workspace/plain",
        project: { worktree: "/" },
      }),
    ).toBe("/Users/developer/workspace/plain")
  })

  test("keeps memory below the application data directory", () => {
    const data = "/Users/developer/.local/share/wanlaicode"
    const key = MemoryPaths.projectKey("/Users/developer/workspace/demo")

    expect(MemoryPaths.globalDirectory(data)).toBe(path.join(data, "memory", "global"))
    expect(MemoryPaths.projectDirectory(data, key)).toBe(path.join(data, "memory", "projects", key))
  })
})
