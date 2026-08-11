import { describe, expect, test } from "bun:test"

import {
  blankProjectCreateErrorKey,
  isAutoIncrementDefaultName,
  isValidProjectFolderName,
  joinParentAndName,
  nextAvailableProjectFolderName,
  sanitizeProjectFolderName,
} from "./blank-project"

describe("blank project", () => {
  test("increments folder names like create-blank-project", () => {
    const taken = new Set(["New project", "New project 2"])
    expect(nextAvailableProjectFolderName("New project", (name) => taken.has(name))).toBe("New project 3")
    expect(nextAvailableProjectFolderName("New project", (name) => !taken.has(name))).toBe("New project")
  })

  test("sanitizes invalid folder characters", () => {
    expect(sanitizeProjectFolderName("bad<>name")).toBe("badname")
  })

  test("joins parent directory and folder name", () => {
    expect(joinParentAndName("C:\\Users\\me\\Documents", "Demo")).toBe("C:\\Users\\me\\Documents\\Demo")
    expect(joinParentAndName("/home/developer/Documents", "Demo")).toBe("/home/developer/Documents/Demo")
  })

  test("rejects path traversal and reserved names", () => {
    expect(isValidProjectFolderName("..")).toBe(false)
    expect(isValidProjectFolderName(".")).toBe(false)
    expect(isValidProjectFolderName("CON")).toBe(false)
    expect(isValidProjectFolderName("My Project")).toBe(true)
  })

  test("detects auto-increment default names", () => {
    expect(isAutoIncrementDefaultName("New project")).toBe(true)
    expect(isAutoIncrementDefaultName("New project 3")).toBe(true)
    expect(isAutoIncrementDefaultName("My App")).toBe(false)
  })

  test("maps create errors to i18n keys", () => {
    expect(blankProjectCreateErrorKey(new Error("Directory already exists: /tmp/x"))).toBe(
      "sidebar.blankProject.error.exists",
    )
    expect(blankProjectCreateErrorKey(new Error("Invalid project name"))).toBe(
      "sidebar.blankProject.createDisabled.nameInvalid",
    )
  })
})
