import { mkdirSync, rmSync } from "node:fs"
import { describe, expect, test } from "bun:test"

import { assertBlankProjectFolderName, blankProjectParent, blankProjectPathExists, resolveBlankProjectTarget } from "./blank-project"

describe("desktop blank project", () => {
  test("rejects traversal in project name", () => {
    expect(() => assertBlankProjectFolderName("..")).toThrow("Invalid project name")
    expect(() => assertBlankProjectFolderName("..\\Windows")).toThrow("Invalid project name")
  })

  test("resolves target under parent", () => {
    const parent = "C:\\Users\\me\\Documents"
    expect(resolveBlankProjectTarget(parent, "Demo")).toBe("C:\\Users\\me\\Documents\\Demo")
  })

  test("rejects targets outside parent", () => {
    expect(() => resolveBlankProjectTarget("C:\\Users\\me\\Documents", "..\\Windows")).toThrow("Invalid project name")
  })

  test("rejects invalid parent path", () => {
    expect(() => blankProjectParent("bad\u0000path")).toThrow("Invalid project path")
    expect(() => blankProjectParent("bad\npath")).toThrow("Invalid project path")
  })

  test("detects existing project path", () => {
    const parent = blankProjectParent(undefined)
    const name = `blank-project-test-${Date.now()}`
    const target = resolveBlankProjectTarget(parent, name)
    expect(blankProjectPathExists(parent, name)).toBe(false)
    mkdirSync(target, { recursive: true })
    expect(blankProjectPathExists(parent, name)).toBe(true)
    rmSync(target, { recursive: true, force: true })
  })
})
