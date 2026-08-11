import { describe, expect, test } from "bun:test"
import path from "path"
import { Session as SessionNs } from "@/session/session"
import * as Log from "@opencode-ai/core/util/log"
import { WithInstance } from "../../src/project/with-instance"
import { AppRuntime } from "../../src/effect/app-runtime"

const projectRoot = path.join(__dirname, "../..")
void Log.init({ print: false })

function run(fn: (svc: SessionNs.Interface) => any): Promise<any> {
  return AppRuntime.runPromise(SessionNs.Service.use(fn))
}

describe("session.addGoalUsage 挂点", () => {
  test("addGoalUsage 累加 tokensUsed", async () => {
    await WithInstance.provide({
      directory: projectRoot,
      fn: async () => {
        const created = await run((svc) => svc.create({}))
        await run((svc) => svc.setGoal({ sessionID: created.id, objective: "x" }))
        await run((svc) => svc.addGoalUsage({ sessionID: created.id, tokens: 1234, seconds: 0 }))
        const goal = await run((svc) => svc.getGoal(created.id))
        expect(goal?.tokensUsed).toBe(1234)
        await run((svc) => svc.remove(created.id))
      },
    })
  })

  test("无 goal 时 addGoalUsage 为 no-op", async () => {
    await WithInstance.provide({
      directory: projectRoot,
      fn: async () => {
        const created = await run((svc) => svc.create({}))
        await run((svc) => svc.addGoalUsage({ sessionID: created.id, tokens: 999, seconds: 0 }))
        const goal = await run((svc) => svc.getGoal(created.id))
        expect(goal).toBeNull()
        await run((svc) => svc.remove(created.id))
      },
    })
  })

  test("并发 addGoalUsage 不丢更新（锁串行化读改写）", async () => {
    await WithInstance.provide({
      directory: projectRoot,
      fn: async () => {
        const created = await run((svc) => svc.create({}))
        await run((svc) => svc.setGoal({ sessionID: created.id, objective: "concurrent" }))
        const N = 50
        await Promise.all(
          Array.from({ length: N }, () =>
            run((svc) => svc.addGoalUsage({ sessionID: created.id, tokens: 1, seconds: 1 })),
          ),
        )
        const goal = await run((svc) => svc.getGoal(created.id))
        expect(goal?.tokensUsed).toBe(N)
        expect(goal?.timeUsedSeconds).toBe(N)
        await run((svc) => svc.remove(created.id))
      },
    })
  })
})
