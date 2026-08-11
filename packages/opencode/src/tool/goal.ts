import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { Session } from "@/session/session"

const UPDATE_GOAL_DESCRIPTION = `Update the existing goal.
Use this tool only to mark the goal achieved or genuinely blocked.
Set status to \`complete\` only when the objective has actually been achieved and no required work remains.
Set status to \`blocked\` only when the same blocking condition has repeated for at least three consecutive goal turns, counting the original/user-triggered turn and any automatic continuations, and the agent cannot make meaningful progress without user input or an external-state change.
If the user resumes a goal that was previously marked \`blocked\`, treat the resumed run as a fresh blocked audit. If the same blocking condition then repeats for at least three consecutive resumed goal turns, set status to \`blocked\` again.
Once the blocked threshold is satisfied, do not keep reporting that you are still blocked while leaving the goal active; set status to \`blocked\`.
Do not use \`blocked\` merely because the work is hard, slow, uncertain, incomplete, or would benefit from clarification.
Do not mark a goal complete merely because you are stopping work.
You cannot use this tool to pause, resume, budget-limit, or usage-limit a goal; those status changes are controlled by the user or system.`

const GET_GOAL_DESCRIPTION =
  "Get the current goal for this thread, including its objective, status, and token/elapsed-time usage."

export const UpdateGoalParameters = Schema.Struct({
  status: Schema.Literals(["complete", "blocked"]).annotate({
    description:
      "Set to `complete` only when the objective is achieved and no required work remains. Set to `blocked` only after the same blocking condition has recurred for at least three consecutive goal turns and the agent is at an impasse.",
  }),
})

export const GetGoalParameters = Schema.Struct({})

export const UpdateGoalTool = Tool.define<typeof UpdateGoalParameters, {}, Session.Service>(
  "update_goal",
  Effect.gen(function* () {
    const session = yield* Session.Service

    return {
      description: UPDATE_GOAL_DESCRIPTION,
      parameters: UpdateGoalParameters,
      execute: (params: Schema.Schema.Type<typeof UpdateGoalParameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const goal = yield* session
            .setGoalStatus({ sessionID: ctx.sessionID, status: params.status })
            .pipe(Effect.orDie)
          return {
            title: `goal ${goal.status}`,
            output: `Goal marked as ${goal.status}.`,
            metadata: {},
          }
        }),
    } satisfies Tool.DefWithoutID<typeof UpdateGoalParameters, {}>
  }),
)

export const GetGoalTool = Tool.define<typeof GetGoalParameters, {}, Session.Service>(
  "get_goal",
  Effect.gen(function* () {
    const session = yield* Session.Service

    return {
      description: GET_GOAL_DESCRIPTION,
      parameters: GetGoalParameters,
      execute: (_params: {}, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const goal = yield* session.getGoal(ctx.sessionID)
          if (!goal) {
            return { title: "no goal", output: "No goal is currently defined for this thread.", metadata: {} }
          }
          const lines = [
            `Objective: ${goal.objective}`,
            `Status: ${goal.status}`,
            `Tokens used: ${goal.tokensUsed}`,
            `Time used (seconds): ${goal.timeUsedSeconds}`,
          ]
          return { title: `goal ${goal.status}`, output: lines.join("\n"), metadata: {} }
        }),
    } satisfies Tool.DefWithoutID<typeof GetGoalParameters, {}>
  }),
)
