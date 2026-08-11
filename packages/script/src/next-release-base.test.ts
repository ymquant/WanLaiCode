import { describe, expect, test } from "bun:test"

import { nextReleaseBase } from "./next-release-base"

describe("nextReleaseBase", () => {
  test("patch bump from multiple tags picks max then increments", () => {
    expect(nextReleaseBase(["v0.0.23", "v0.0.24"], "patch")).toBe("0.0.25")
  })

  test("default bump (undefined) is patch", () => {
    expect(nextReleaseBase(["v0.0.24"])).toBe("0.0.25")
  })

  test("out-of-order tags still pick the max before incrementing", () => {
    expect(nextReleaseBase(["v0.0.23", "v0.0.24", "v0.0.20"])).toBe("0.0.25")
  })

  test("minor bump", () => {
    expect(nextReleaseBase(["v0.0.24"], "minor")).toBe("0.1.0")
  })

  test("major bump", () => {
    expect(nextReleaseBase(["v0.0.24"], "major")).toBe("1.0.0")
  })

  test("filters out invalid tags", () => {
    expect(nextReleaseBase(["0.0.24", "garbage", "v0.0.25"])).toBe("0.0.26")
  })

  test("pre-release participates in comparison; inc lands on its release version", () => {
    expect(nextReleaseBase(["v0.0.24", "v0.0.25-canary.202606"])).toBe("0.0.25")
  })

  test("empty set falls back to 0.0.0 then patch increments to 0.0.1", () => {
    expect(nextReleaseBase([], "patch")).toBe("0.0.1")
  })
})
