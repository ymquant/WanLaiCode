import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { UpdateGoalTool, GetGoalTool } from "../../src/tool/goal"
import { Session } from "../../src/session/session"
import { Truncate } from "@/tool/truncate"
import { Tool } from "@/tool/tool"
import { Agent } from "../../src/agent/agent"
import { SessionID, MessageID } from "../../src/session/schema"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const ctx: Tool.Context = {
  sessionID: SessionID.make("ses_test-goal-tool"),
  messageID: MessageID.make(""),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

afterEach(async () => {
  await disposeAllInstances()
})

const it = testEffect(Layer.mergeAll(Truncate.defaultLayer, Agent.defaultLayer, Session.defaultLayer))

const initUpdate = Effect.fn("GoalToolTest.initUpdate")(function* () {
  const info = yield* UpdateGoalTool
  return yield* info.init()
})

const initGet = Effect.fn("GoalToolTest.initGet")(function* () {
  const info = yield* GetGoalTool
  return yield* info.init()
})

describe("tool.update_goal", () => {
  it.instance("complete → 改 status 为 complete", () =>
    Effect.gen(function* () {
      yield* TestInstance
      const session = yield* Session.Service
      const created = yield* session.create({})
      yield* session.setGoal({ sessionID: created.id, objective: "ship the feature" })
      const tool = yield* initUpdate()
      const result = yield* tool.execute({ status: "complete" }, { ...ctx, sessionID: created.id })
      const goal = yield* session.getGoal(created.id)
      expect(goal?.status).toBe("complete")
      expect(result.output).toContain("complete")
    }),
  )

  it.instance("blocked → 改 status 为 blocked", () =>
    Effect.gen(function* () {
      yield* TestInstance
      const session = yield* Session.Service
      const created = yield* session.create({})
      yield* session.setGoal({ sessionID: created.id, objective: "do the thing" })
      const tool = yield* initUpdate()
      yield* tool.execute({ status: "blocked" }, { ...ctx, sessionID: created.id })
      const goal = yield* session.getGoal(created.id)
      expect(goal?.status).toBe("blocked")
    }),
  )
})

describe("tool.get_goal", () => {
  it.instance("返回当前 objective 文本", () =>
    Effect.gen(function* () {
      yield* TestInstance
      const session = yield* Session.Service
      const created = yield* session.create({})
      yield* session.setGoal({ sessionID: created.id, objective: "refactor the parser" })
      const tool = yield* initGet()
      const result = yield* tool.execute({}, { ...ctx, sessionID: created.id })
      expect(result.output).toContain("refactor the parser")
      expect(result.output).toContain("active")
    }),
  )

  it.instance("无 goal 时提示无目标", () =>
    Effect.gen(function* () {
      yield* TestInstance
      const session = yield* Session.Service
      const created = yield* session.create({})
      const tool = yield* initGet()
      const result = yield* tool.execute({}, { ...ctx, sessionID: created.id })
      expect(result.output).toContain("No goal")
    }),
  )
})
