import { describe, expect, test } from "bun:test"
import path from "path"
import { Session as SessionNs } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { Bus } from "../../src/bus"
import * as Log from "@opencode-ai/core/util/log"
import { WithInstance } from "../../src/project/with-instance"
import { AppRuntime } from "../../src/effect/app-runtime"

const projectRoot = path.join(__dirname, "../..")
void Log.init({ print: false })

function run(fn: (svc: SessionNs.Interface) => any): Promise<any> {
  return AppRuntime.runPromise(SessionNs.Service.use(fn))
}

describe("Session goal service", () => {
  test("setGoal creates active goal and publishes GoalUpdated", async () => {
    await WithInstance.provide({
      directory: projectRoot,
      fn: async () => {
        const info = await run((svc) => svc.create({}))
        let published: any
        const unsub = Bus.subscribe(SessionStatus.Event.GoalUpdated, (e) => {
          published = e.properties.goal
        })
        const goal = await run((svc) => svc.setGoal({ sessionID: info.id, objective: "  ship it  " }))
        await new Promise((r) => setTimeout(r, 50))
        unsub()
        expect(goal.objective).toBe("ship it")
        expect(goal.status).toBe("active")
        expect(goal.tokensUsed).toBe(0)
        expect(goal.timeUsedSeconds).toBe(0)
        expect(goal.tokenBudget).toBeNull()
        expect(published?.objective).toBe("ship it")
        await run((svc) => svc.remove(info.id))
      },
    })
  })

  test("setGoal replacing objective keeps createdAt and resets status to active", async () => {
    await WithInstance.provide({
      directory: projectRoot,
      fn: async () => {
        const info = await run((svc) => svc.create({}))
        const first = await run((svc) => svc.setGoal({ sessionID: info.id, objective: "first" }))
        await run((svc) => svc.setGoalStatus({ sessionID: info.id, status: "blocked" }))
        const second = await run((svc) => svc.setGoal({ sessionID: info.id, objective: "second" }))
        expect(second.objective).toBe("second")
        expect(second.status).toBe("active")
        expect(second.createdAt).toBe(first.createdAt)
        await run((svc) => svc.remove(info.id))
      },
    })
  })

  test("setGoal rejects empty and overlong objectives", async () => {
    await WithInstance.provide({
      directory: projectRoot,
      fn: async () => {
        const info = await run((svc) => svc.create({}))
        await expect(run((svc) => svc.setGoal({ sessionID: info.id, objective: "   " }))).rejects.toBeDefined()
        await expect(
          run((svc) => svc.setGoal({ sessionID: info.id, objective: "x".repeat(4001) })),
        ).rejects.toBeDefined()
        await run((svc) => svc.remove(info.id))
      },
    })
  })

  test("setGoalStatus updates status; getGoal reads it", async () => {
    await WithInstance.provide({
      directory: projectRoot,
      fn: async () => {
        const info = await run((svc) => svc.create({}))
        await run((svc) => svc.setGoal({ sessionID: info.id, objective: "obj" }))
        const updated = await run((svc) => svc.setGoalStatus({ sessionID: info.id, status: "complete" }))
        expect(updated.status).toBe("complete")
        const read = await run((svc) => svc.getGoal(info.id))
        expect(read?.status).toBe("complete")
        await run((svc) => svc.remove(info.id))
      },
    })
  })

  test("setGoalStatus with no existing goal rejects", async () => {
    await WithInstance.provide({
      directory: projectRoot,
      fn: async () => {
        const info = await run((svc) => svc.create({}))
        await expect(run((svc) => svc.setGoalStatus({ sessionID: info.id, status: "complete" }))).rejects.toBeDefined()
        expect(await run((svc) => svc.getGoal(info.id))).toBeNull()
        await run((svc) => svc.remove(info.id))
      },
    })
  })

  test("getGoal returns null when no goal", async () => {
    await WithInstance.provide({
      directory: projectRoot,
      fn: async () => {
        const info = await run((svc) => svc.create({}))
        expect(await run((svc) => svc.getGoal(info.id))).toBeNull()
        await run((svc) => svc.remove(info.id))
      },
    })
  })

  test("clearGoal clears and publishes GoalCleared; returns true/false", async () => {
    await WithInstance.provide({
      directory: projectRoot,
      fn: async () => {
        const info = await run((svc) => svc.create({}))
        await run((svc) => svc.setGoal({ sessionID: info.id, objective: "obj" }))
        let cleared = false
        const unsub = Bus.subscribe(SessionStatus.Event.GoalCleared, () => {
          cleared = true
        })
        const first = await run((svc) => svc.clearGoal(info.id))
        await new Promise((r) => setTimeout(r, 50))
        unsub()
        expect(first).toBe(true)
        expect(cleared).toBe(true)
        expect(await run((svc) => svc.getGoal(info.id))).toBeNull()
        const second = await run((svc) => svc.clearGoal(info.id))
        expect(second).toBe(false)
        await run((svc) => svc.remove(info.id))
      },
    })
  })

  test("addGoalUsage accumulates tokens/seconds; no-op without goal", async () => {
    await WithInstance.provide({
      directory: projectRoot,
      fn: async () => {
        const info = await run((svc) => svc.create({}))
        await run((svc) => svc.addGoalUsage({ sessionID: info.id, tokens: 10, seconds: 5 }))
        expect(await run((svc) => svc.getGoal(info.id))).toBeNull()
        await run((svc) => svc.setGoal({ sessionID: info.id, objective: "obj" }))
        await run((svc) => svc.addGoalUsage({ sessionID: info.id, tokens: 10, seconds: 5 }))
        await run((svc) => svc.addGoalUsage({ sessionID: info.id, tokens: 7, seconds: 3 }))
        const goal = await run((svc) => svc.getGoal(info.id))
        expect(goal?.tokensUsed).toBe(17)
        expect(goal?.timeUsedSeconds).toBe(8)
        await run((svc) => svc.remove(info.id))
      },
    })
  })
})
