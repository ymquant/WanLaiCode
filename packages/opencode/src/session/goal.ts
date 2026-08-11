import { zod } from "@/util/effect-zod"
import { NonNegativeInt, withStatics } from "@/util/schema"
import { Schema } from "effect"
import { SessionID } from "./schema"

export const MAX_GOAL_OBJECTIVE_CHARS = 4000

export const GoalStatus = Schema.Literals([
  "active",
  "paused",
  "blocked",
  "usageLimited",
  "budgetLimited",
  "complete",
]).annotate({ identifier: "GoalStatus" })
export type GoalStatus = Schema.Schema.Type<typeof GoalStatus>

export const Goal = Schema.Struct({
  sessionID: SessionID,
  objective: Schema.String,
  status: GoalStatus,
  tokenBudget: Schema.NullOr(NonNegativeInt),
  tokensUsed: NonNegativeInt,
  timeUsedSeconds: NonNegativeInt,
  createdAt: NonNegativeInt,
  updatedAt: NonNegativeInt,
})
  .annotate({ identifier: "Goal" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type Goal = Schema.Schema.Type<typeof Goal>

export class GoalValidationError extends Error {
  readonly _tag = "GoalValidationError"
}

export function validateObjective(input: string): string {
  const trimmed = input.trim()
  if (trimmed.length === 0) throw new GoalValidationError("Goal objective must not be empty")
  if (trimmed.length > MAX_GOAL_OBJECTIVE_CHARS)
    throw new GoalValidationError(`Goal objective must be at most ${MAX_GOAL_OBJECTIVE_CHARS} characters`)
  return trimmed
}

export * as GoalNs from "./goal"
