import { describe, expect, test } from "bun:test"

describe("session VCS review refresh", () => {
  test("does not poll review VCS diffs every 2 seconds", async () => {
    const source = await Bun.file(new URL("./session.tsx", import.meta.url)).text()

    expect(source).not.toContain("reviewVcsLive")
    expect(source).not.toContain("branchDiffLive")
    expect(source).not.toContain("refetchInterval: reviewVcsLive() ? 2_000 : false")
    expect(source).not.toContain("refetchInterval: branchDiffLive() ? 2_000 : false")
    expect(source).toContain('void queryClient.invalidateQueries({ queryKey: vcsKey(), refetchType: "none" })')
    expect(source).toContain('void queryClient.refetchQueries({ queryKey: vcsKey(), type: "active" })')
  })

  test("resolves clicked review tree paths back to diff row files before opening", async () => {
    const source = await Bun.file(new URL("./session.tsx", import.meta.url)).text()

    expect(source).toContain('const reviewPathKey = (path: string) => path.replace(/\\\\/g, "/")')
    expect(source).toContain("const reviewDiffForPath = (path: string, rows = reviewDiffs())")
    expect(source).toContain("const file = reviewDiffForPath(path)?.file ?? path")
    expect(source).toContain("view().review.openPath(file)")
    expect(source).toContain("setTree({ activeDiff: file, pendingDiff: file })")
  })

  test("refreshes review VCS for git index changes without accepting every git metadata event", async () => {
    const source = await Bun.file(new URL("./session.tsx", import.meta.url)).text()

    expect(source).toContain("const isGitIndexChangePath = (path: string) =>")
    expect(source).toContain('path === ".git/index"')
    expect(source).toContain('path === ".git/index.lock"')
    expect(source).toContain('path.endsWith("/.git/index")')
    expect(source).toContain('path.endsWith("/.git/index.lock")')
    expect(source).toContain("const isGitMetadataPath = (path: string) =>")
    expect(source).toContain("if (isGitIndexChangePath(normalized))")
    expect(source).toContain("if (isGitMetadataPath(normalized)) return")
  })
})
