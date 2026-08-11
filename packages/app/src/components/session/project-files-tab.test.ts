import { describe, expect, test } from "bun:test"
import { isMarkdownProjectFilePath } from "./project-files-path"

describe("isMarkdownProjectFilePath", () => {
  test("does not throw on malformed uri percent escapes", () => {
    expect(() => isMarkdownProjectFilePath("notes%bad.md")).not.toThrow()
    expect(isMarkdownProjectFilePath("notes%bad.md")).toBe(true)
  })

  test("detects encoded markdown extensions", () => {
    expect(isMarkdownProjectFilePath("notes%2Emd")).toBe(true)
    expect(isMarkdownProjectFilePath("notes.txt")).toBe(false)
  })
})
