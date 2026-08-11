import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Goal, GoalStatus, MAX_GOAL_OBJECTIVE_CHARS, validateObjective } from "@/session/goal"

describe("Goal schema", () => {
  test("GoalStatus enumerates all states", () => {
    const decode = Schema.decodeUnknownSync(GoalStatus as any)
    for (const s of ["active", "paused", "blocked", "usageLimited", "budgetLimited", "complete"]) {
      expect(decode(s)).toBe(s)
    }
    expect(() => decode("bogus")).toThrow()
  })

  test("Goal decodes a full object", () => {
    const value = {
      sessionID: "ses_test" as const,
      objective: "ship goal mode",
      status: "active" as const,
      tokenBudget: null,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: 1,
      updatedAt: 1,
    }
    expect(Schema.decodeUnknownSync(Goal as any)(value)).toEqual(value)
  })

  test("MAX_GOAL_OBJECTIVE_CHARS is 4000", () => {
    expect(MAX_GOAL_OBJECTIVE_CHARS).toBe(4000)
  })

  test("validateObjective trims and enforces non-empty + max length", () => {
    expect(validateObjective("  hello  ")).toBe("hello")
    expect(() => validateObjective("")).toThrow()
    expect(() => validateObjective("   ")).toThrow()
    expect(() => validateObjective("x".repeat(4001))).toThrow()
    expect(validateObjective("x".repeat(4000))).toBe("x".repeat(4000))
  })
})
