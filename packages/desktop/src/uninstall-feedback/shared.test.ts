import { describe, expect, test } from "bun:test"
import {
  UNINSTALL_FEEDBACK_FLAG,
  EXIT_SUBMITTED,
  EXIT_CANCELLED,
  isUninstallFeedbackMode,
  countFeedbackChars,
  isValidFeedbackText,
} from "./shared"

describe("uninstall-feedback shared", () => {
  test("exit code constants", () => {
    expect(EXIT_SUBMITTED).toBe(0)
    expect(EXIT_CANCELLED).toBe(2)
  })

  test("isUninstallFeedbackMode detects flag", () => {
    expect(isUninstallFeedbackMode(["electron", "app", UNINSTALL_FEEDBACK_FLAG])).toBe(true)
    expect(isUninstallFeedbackMode(["electron", "app"])).toBe(false)
  })

  test("countFeedbackChars counts code points after trim", () => {
    expect(countFeedbackChars("  hello  ")).toBe(5)
    expect(countFeedbackChars("😀😀")).toBe(2) // 2 code points, not 4 UTF-16 units
    expect(countFeedbackChars("中文反馈")).toBe(4)
  })

  test("isValidFeedbackText enforces 10..2000", () => {
    expect(isValidFeedbackText("123456789")).toBe(false) // 9
    expect(isValidFeedbackText("1234567890")).toBe(true) // 10
    expect(isValidFeedbackText("   1234567890   ")).toBe(true)
    expect(isValidFeedbackText("a".repeat(2000))).toBe(true)
    expect(isValidFeedbackText("a".repeat(2001))).toBe(false)
  })
})
