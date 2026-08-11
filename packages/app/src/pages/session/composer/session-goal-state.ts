import type { Goal } from "@opencode-ai/sdk/v2"

export const todoState = (input: { count: number; done: boolean; live: boolean }): "hide" | "open" | "close" => {
  if (input.count === 0) return "hide"
  if (!input.done) return "open"
  return "close"
}

export const goalModeActive = (input: { goal: Goal | undefined; pendingObjective: string | undefined }): boolean => {
  if (input.pendingObjective !== undefined) return true
  return input.goal !== undefined && input.goal.status !== "complete"
}
