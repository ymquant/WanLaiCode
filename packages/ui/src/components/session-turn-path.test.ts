import { describe, expect, test } from "bun:test"
import { isAbsoluteFilePath, resolveWorkspaceFilePath } from "./session-turn-path"

describe("session turn paths", () => {
  test("detects cross-platform absolute file paths", () => {
    expect(isAbsoluteFilePath("/repo/file.ts")).toBe(true)
    expect(isAbsoluteFilePath("C:\\repo\\file.ts")).toBe(true)
    expect(isAbsoluteFilePath("C:/repo/file.ts")).toBe(true)
    expect(isAbsoluteFilePath("\\\\server\\share\\file.ts")).toBe(true)
    expect(isAbsoluteFilePath("//server/share/file.ts")).toBe(true)
    expect(isAbsoluteFilePath("src/file.ts")).toBe(false)
    expect(isAbsoluteFilePath("C:repo\\file.ts")).toBe(false)
  })

  test("keeps absolute paths unchanged", () => {
    expect(resolveWorkspaceFilePath("C:/repo", "C:\\repo\\file.ts")).toBe("C:\\repo\\file.ts")
    expect(resolveWorkspaceFilePath("C:/repo", "C:/repo/file.ts")).toBe("C:/repo/file.ts")
    expect(resolveWorkspaceFilePath("C:/repo", "\\\\server\\share\\file.ts")).toBe("\\\\server\\share\\file.ts")
  })

  test("resolves relative paths under the workspace", () => {
    expect(resolveWorkspaceFilePath("/repo/project", "src/file.ts")).toBe("/repo/project/src/file.ts")
    expect(resolveWorkspaceFilePath("C:\\repo\\project", "src\\file.ts")).toBe("C:/repo/project/src/file.ts")
  })

  test("deduplicates paths that already include a workspace suffix", () => {
    expect(resolveWorkspaceFilePath("/Users/developer/project", "project/src/file.ts")).toBe("/Users/developer/project/src/file.ts")
    expect(resolveWorkspaceFilePath("C:\\Users\\me\\project", "project\\src\\file.ts")).toBe(
      "C:/Users/developer/project/src/file.ts",
    )
  })
})
