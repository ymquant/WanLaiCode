import { describe, expect, test } from "bun:test"

describe("prompt file link", () => {
  test("工作区内外文件都在应用内打开并恢复所有文件目录树", async () => {
    const source = await Bun.file(new URL("../prompt-input.tsx", import.meta.url)).text()
    const branch = source.indexOf('if (resolved?.kind !== "directory")')
    const fallback = source.indexOf("if (data.openLocalPath)", branch)

    // 锁定文件引用的内部工作台流程，确保工作区外 Skill 文件不再被错误交给外部编辑器。
    expect(branch).toBeGreaterThan(-1)
    expect(fallback).toBeGreaterThan(branch)
    expect(source).not.toContain("isPromptFileInWorkspace")
    expect(source.indexOf("layout.fileTree.open()", branch)).toBeLessThan(fallback)
    expect(source.indexOf('layout.fileTree.setTab("all")', branch)).toBeLessThan(fallback)
    expect(source.indexOf("void tabs().open(tab, { preview: false })", branch)).toBeLessThan(fallback)
    expect(source.indexOf("tabs().setActive(tab)", branch)).toBeLessThan(fallback)
    expect(source.indexOf("void files.load(absolutePath)", branch)).toBeLessThan(fallback)
    expect(source.indexOf("return", branch)).toBeLessThan(fallback)
  })
})
