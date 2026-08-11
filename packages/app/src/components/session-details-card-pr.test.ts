import { describe, expect, test } from "bun:test"
import { prRowState } from "./session-details-card-pr"

describe("session-details-card-pr", () => {
  test("prefers existing PR over create", () => {
    expect(prRowState(true, true, true, { title: "My PR", url: "https://github.com/o/r/pull/1" })).toBe("exists")
    expect(prRowState(true, true, true)).toBe("create")
    expect(prRowState(true, true, false)).toBe("gh-auth")
    expect(prRowState(true, false, undefined)).toBe("gh-cli")
    expect(prRowState(true, true, undefined, undefined, true)).toBe("loading")
    expect(prRowState(true, true, undefined, undefined, false, true)).toBe("error")
    expect(prRowState(true, true, undefined)).toBe("loading")
    expect(prRowState(false, true, true)).toBe("unavailable")
  })
})
