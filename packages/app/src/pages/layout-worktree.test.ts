import { describe, expect, test } from "bun:test"

describe("layout project worktree creation", () => {
  test("uses the target project name when creating a persistent worktree", async () => {
    const source = await Bun.file(new URL("./layout.tsx", import.meta.url)).text()

    expect(source).toContain("directory: project.worktree")
    expect(source).toContain("name: project.name || getFilename(project.worktree)")
    expect(source).toContain("branchPrefix: settings.git.branchPrefix()")
  })
})
