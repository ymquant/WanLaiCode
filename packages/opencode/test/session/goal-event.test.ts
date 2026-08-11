import { describe, expect, test } from "bun:test"
import { SessionStatus } from "@/session/status"

describe("Goal bus events", () => {
  test("GoalUpdated has correct type", () => {
    expect(SessionStatus.Event.GoalUpdated.type).toBe("session.goal.updated")
  })
  test("GoalCleared has correct type", () => {
    expect(SessionStatus.Event.GoalCleared.type).toBe("session.goal.cleared")
  })
})
