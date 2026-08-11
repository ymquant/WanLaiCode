import { describe, expect, test } from "bun:test"
import { goalStatusLabelKey } from "./session-goal-dock"

describe("goalStatusLabelKey", () => {
  test("maps every goal status to its i18n key", () => {
    expect(goalStatusLabelKey("active")).toBe("session.goal.status.active")
    expect(goalStatusLabelKey("paused")).toBe("session.goal.status.paused")
    expect(goalStatusLabelKey("blocked")).toBe("session.goal.status.blocked")
    expect(goalStatusLabelKey("usageLimited")).toBe("session.goal.status.usageLimited")
    expect(goalStatusLabelKey("budgetLimited")).toBe("session.goal.status.budgetLimited")
    expect(goalStatusLabelKey("complete")).toBe("session.goal.status.complete")
  })
})
