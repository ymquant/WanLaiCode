import { describe, expect, test } from "bun:test"
import { isScratchSessionPath } from "./scratch"

describe("isScratchSessionPath", () => {
  test("matches scratch by leaf name before the platform path is ready", () => {
    expect(isScratchSessionPath("/Users/developer/AppData/scratch-sessions")).toBe(true)
    expect(isScratchSessionPath("C:\\Users\\me\\AppData\\scratch-sessions\\")).toBe(true)
  })

  test("matches an explicit scratch directory", () => {
    expect(isScratchSessionPath("/tmp/current", "/tmp/current")).toBe(true)
  })

  test("does not match regular projects", () => {
    expect(isScratchSessionPath("/Users/developer/project")).toBe(false)
    expect(isScratchSessionPath(undefined)).toBe(false)
  })
})
