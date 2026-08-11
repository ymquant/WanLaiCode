import { expect, test } from "bun:test"
import { shouldKeepActionFocus } from "./thread-row-focus"

test("keeps action controls focused after pointer-clicking a child action", () => {
  expect(shouldKeepActionFocus(true, false)).toBe(true)
  expect(shouldKeepActionFocus(true, true)).toBe(false)
  expect(shouldKeepActionFocus(false, true)).toBe(true)
})
