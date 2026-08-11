import { describe, expect, test } from "bun:test"
import {
  createMarkdownWorkspacePathResolver,
  localPathFromFileUrl,
  looksLikeMarkdownPathCandidate,
  pickUniqueRelativePathSuffix,
  stripMarkdownLineSuffix,
} from "./markdown-workspace-path"

describe("pickUniqueRelativePathSuffix", () => {
  test("matches nested trail omitted by the model", () => {
    const suffix = "core/llm/llms/Anthropic.ts"
    const candidates = [
      "extensions/wanlai-continue/other.ts",
      "extensions/wanlai-continue/core/llm/llms/Anthropic.ts",
      "extensions/wanlai-continue/core/llm/llms/Gemini.ts",
    ]
    expect(pickUniqueRelativePathSuffix(suffix, candidates)).toBe(
      "extensions/wanlai-continue/core/llm/llms/Anthropic.ts",
    )
  })

  test("returns undefined when ambiguous", () => {
    const suffix = "core/llm/llms/Anthropic.ts"
    const candidates = [
      "a/extensions/foo/core/llm/llms/Anthropic.ts",
      "b/extensions/foo/core/llm/llms/Anthropic.ts",
    ]
    expect(pickUniqueRelativePathSuffix(suffix, candidates)).toBeUndefined()
  })

  test("requires a slash in the suffix", () => {
    expect(pickUniqueRelativePathSuffix("Anthropic.ts", ["pkg/Anthropic.ts"])).toBeUndefined()
  })
})

describe("stripMarkdownLineSuffix", () => {
  test("strips trailing line hint", () => {
    expect(stripMarkdownLineSuffix("foo.ts (line 12)")).toBe("foo.ts")
  })
})

describe("localPathFromFileUrl", () => {
  test("removes the extra leading slash from Windows file URLs", () => {
    expect(localPathFromFileUrl("file:///C:/Users/developer/Documents/print_japan.py")).toBe(
      "C:/Users/developer/Documents/print_japan.py",
    )
  })

  test("keeps the leading slash for Linux and macOS file URLs", () => {
    expect(localPathFromFileUrl("file:///home/developer/docs/report.pdf")).toBe("/home/developer/docs/report.pdf")
    expect(localPathFromFileUrl("file:///Users/developer/Projects/app/main.ts")).toBe(
      "/Users/developer/Projects/app/main.ts",
    )
  })

  test("returns non-file URLs unchanged", () => {
    expect(localPathFromFileUrl("C:/Users/developer/Documents/print_japan.py")).toBe(
      "C:/Users/developer/Documents/print_japan.py",
    )
  })
})

describe("looksLikeMarkdownPathCandidate", () => {
  test("allows absolute local paths with spaces", () => {
    expect(looksLikeMarkdownPathCandidate("C:\\Users\\dev\\Desktop\\release test\\output.zip")).toBe(true)
  })

  test("keeps relative paths with spaces out of path linking", () => {
    expect(looksLikeMarkdownPathCandidate("release test/output.zip")).toBe(false)
  })

  test("allows file URL local paths", () => {
    expect(
      looksLikeMarkdownPathCandidate("file:///C:/Users/developer/Documents/print_japan.py"),
    ).toBe(true)
    expect(
      looksLikeMarkdownPathCandidate("file:///home/developer/docs/report.pdf"),
    ).toBe(true)
  })
})

describe("createMarkdownWorkspacePathResolver", () => {
  test("uses relative title for relative workspace files", async () => {
    const resolve = createMarkdownWorkspacePathResolver({
      workspace: "C:/Users/developer/Documents/打印中国",
      exists: async () => ({ exists: true, kind: "file" }),
    })

    await expect(resolve("print_japan.py")).resolves.toEqual({
      absolutePath: "C:/Users/developer/Documents/打印中国/print_japan.py",
      href: "file:///C:/Users/developer/Documents/%E6%89%93%E5%8D%B0%E4%B8%AD%E5%9B%BD/print_japan.py",
      kind: "file",
      title: "print_japan.py",
    })
  })

  test("links absolute local files outside the workspace", async () => {
    const resolve = createMarkdownWorkspacePathResolver({
      workspace: "C:/Users/developer/project",
      exists: async () => ({ exists: false }),
    })

    await expect(resolve("C:\\Users\\dev\\Desktop\\release-test\\output.zip")).resolves.toEqual({
      absolutePath: "C:/Users/developer/Desktop/release-test/output.zip",
      href: "file:///C:/Users/developer/Desktop/release-test/output.zip",
      kind: "file",
      title: "C:/Users/developer/Desktop/release-test/output.zip",
    })
  })

  test("links absolute local directories outside the workspace", async () => {
    const resolve = createMarkdownWorkspacePathResolver({
      workspace: "C:/Users/developer/project",
      exists: async () => ({ exists: false }),
    })

    await expect(resolve("C:\\Users\\dev\\Desktop\\release-test-backup")).resolves.toEqual({
      absolutePath: "C:/Users/developer/Desktop/release-test-backup",
      href: "file:///C:/Users/developer/Desktop/release-test-backup",
      kind: "directory",
      title: "C:/Users/developer/Desktop/release-test-backup",
    })
  })

  test("does not link missing relative paths", async () => {
    const resolve = createMarkdownWorkspacePathResolver({
      workspace: "C:/Users/developer/project",
      exists: async () => ({ exists: false }),
    })

    await expect(resolve("release-test/output.zip")).resolves.toBeUndefined()
  })

  test("links workspace file reached via file URL prefix", async () => {
    const resolve = createMarkdownWorkspacePathResolver({
      workspace: "C:/Users/developer/Documents/打印中国",
      exists: async () => ({ exists: true, kind: "file" }),
    })

    await expect(
      resolve("file:///C:/Users/developer/Documents/打印中国/print_japan.py"),
    ).resolves.toEqual({
      absolutePath: "C:/Users/developer/Documents/打印中国/print_japan.py",
      href: "file:///C:/Users/developer/Documents/%E6%89%93%E5%8D%B0%E4%B8%AD%E5%9B%BD/print_japan.py",
      kind: "file",
      title: "print_japan.py",
    })
  })

  test("removes browser-style slash before Windows drive in workspace root", async () => {
    const resolve = createMarkdownWorkspacePathResolver({
      workspace: "/C:/Users/developer/Documents/打印中国",
      exists: async () => ({ exists: true, kind: "file" }),
    })

    await expect(resolve("print_japan.py")).resolves.toEqual({
      absolutePath: "C:/Users/developer/Documents/打印中国/print_japan.py",
      href: "file:///C:/Users/developer/Documents/%E6%89%93%E5%8D%B0%E4%B8%AD%E5%9B%BD/print_japan.py",
      kind: "file",
      title: "print_japan.py",
    })
  })
})
