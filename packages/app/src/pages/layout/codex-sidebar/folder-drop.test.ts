import { describe, expect, test } from "bun:test"
import { hasDroppedDirectory, resolveDroppedDirectoryPath } from "./folder-drop"

const file = (name: string) => new File([""], name)
const dirItem = () => ({ webkitGetAsEntry: () => ({ isDirectory: true }) })
const fileItem = () => ({ webkitGetAsEntry: () => ({ isDirectory: false }) })

const pathMap = (entries: [File, string][]): Map<File, string> => {
  const m = new Map<File, string>()
  for (const [f, p] of entries) m.set(f, p)
  return m
}

describe("folder-drop", () => {
  test("returns the dropped directory path for a single folder", () => {
    const f = file("project")
    expect(
      resolveDroppedDirectoryPath({
        items: [dirItem()],
        files: [f],
        getPathForFile: (fl) => pathMap([[f, "/work/project"]]).get(fl),
      }),
    ).toBe("/work/project")
  })

  test("ignores virtual browser paths when no native absolute path is available", () => {
    expect(
      resolveDroppedDirectoryPath({
        items: [dirItem()],
      }),
    ).toBeUndefined()
  })

  test("returns undefined when getPathForFile throws", () => {
    const f = file("project")
    expect(
      resolveDroppedDirectoryPath({
        items: [dirItem()],
        files: [f],
        getPathForFile: () => {
          throw new Error("boom")
        },
      }),
    ).toBeUndefined()
  })

  test("ignores mixed drag: directory + file returns only the directory path", () => {
    const d = file("project-dir")
    const t = file("note.txt")
    expect(
      resolveDroppedDirectoryPath({
        items: [dirItem(), fileItem()],
        files: [d, t],
        getPathForFile: (fl) => pathMap([[d, "/work/project"], [t, "/work/note.txt"]]).get(fl),
      }),
    ).toBe("/work/project")
  })

  test("rejects multiple directories to avoid opening an unexpected parent", () => {
    const a = file("a")
    const b = file("b")
    expect(
      resolveDroppedDirectoryPath({
        items: [dirItem(), dirItem()],
        files: [a, b],
        getPathForFile: (fl) => pathMap([[a, "/work/a"], [b, "/work/b"]]).get(fl),
      }),
    ).toBeUndefined()
  })

  test("detects directory drags", () => {
    expect(hasDroppedDirectory([dirItem()])).toBe(true)
    expect(hasDroppedDirectory([fileItem()])).toBe(false)
  })
})
