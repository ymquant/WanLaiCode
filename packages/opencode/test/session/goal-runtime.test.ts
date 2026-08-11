import { describe, expect, test } from "bun:test"
import path from "path"
import { Effect, Layer } from "effect"
import { Session as SessionNs } from "@/session/session"
import { GoalRuntime } from "../../src/session/goal-runtime"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionRunState } from "../../src/session/run-state"
import { SessionStatus } from "../../src/session/status"
import { Bus } from "../../src/bus"
import * as Log from "@opencode-ai/core/util/log"
import { WithInstance } from "../../src/project/with-instance"
import { AppRuntime } from "../../src/effect/app-runtime"
import { ModelID, ProviderID } from "../../src/provider/schema"

const projectRoot = path.join(__dirname, "../..")
void Log.init({ print: false })

function run(fn: (svc: SessionNs.Interface) => any): Promise<any> {
  return AppRuntime.runPromise(SessionNs.Service.use(fn))
}

// 目标流程不会主动发送 steer；用失败效果标记误调用，同时满足服务接口的结构约束。
const mockSteerPrompt = {
  promptAsync: () => Effect.die(new Error("not implemented")),
  steer: () => Effect.die(new Error("not implemented")),
}

describe("GoalRuntime.renderContinuation", () => {
  test("替换 {{objective}} 占位", () => {
    const text = GoalRuntime.renderContinuation("ship feature X")
    expect(text).toContain("ship feature X")
    expect(text).not.toContain("{{objective}}")
  })
})

describe("GoalRuntime.suppressGoalContinuation", () => {
  test("抑制后 consume 一次为 true 且只生效一次", () => {
    const sid = "ses_suppress_test" as any
    expect(GoalRuntime.consumeGoalSuppression(sid)).toBe(false)
    GoalRuntime.suppressGoalContinuation(sid)
    expect(GoalRuntime.consumeGoalSuppression(sid)).toBe(true)
    expect(GoalRuntime.consumeGoalSuppression(sid)).toBe(false)
  })

  test("过期的抑制不生效", () => {
    const sid = "ses_suppress_expired" as any
    GoalRuntime.suppressGoalContinuation(sid, -1)
    expect(GoalRuntime.consumeGoalSuppression(sid)).toBe(false)
  })
})

describe("GoalRuntime.shouldContinue", () => {
  test("active 目标 → 应续跑", async () => {
    await WithInstance.provide({
      directory: projectRoot,
      fn: async () => {
        const created = await run((svc) => svc.create({}))
        await run((svc) => svc.setGoal({ sessionID: created.id, objective: "do X" }))
        const ok = await AppRuntime.runPromise(GoalRuntime.shouldContinue(created.id))
        expect(ok).toBe(true)
        await run((svc) => svc.remove(created.id))
      },
    })
  })

  test("无目标 → 不续跑", async () => {
    await WithInstance.provide({
      directory: projectRoot,
      fn: async () => {
        const created = await run((svc) => svc.create({}))
        const ok = await AppRuntime.runPromise(GoalRuntime.shouldContinue(created.id))
        expect(ok).toBe(false)
        await run((svc) => svc.remove(created.id))
      },
    })
  })

  test("complete 目标 → 不续跑", async () => {
    await WithInstance.provide({
      directory: projectRoot,
      fn: async () => {
        const created = await run((svc) => svc.create({}))
        await run((svc) => svc.setGoal({ sessionID: created.id, objective: "do X" }))
        await run((svc) => svc.setGoalStatus({ sessionID: created.id, status: "complete" }))
        const ok = await AppRuntime.runPromise(GoalRuntime.shouldContinue(created.id))
        expect(ok).toBe(false)
        await run((svc) => svc.remove(created.id))
      },
    })
  })
})

describe("GoalRuntime.runObjectiveUpdated", () => {
  test("目标已 complete 时不注入消息", async () => {
    await WithInstance.provide({
      directory: projectRoot,
      fn: async () => {
        const created = await run((svc) => svc.create({}))
        await run((svc) => svc.setGoal({ sessionID: created.id, objective: "first" }))
        await run((svc) => svc.setGoalStatus({ sessionID: created.id, status: "complete" }))

        const captured: SessionPrompt.PromptInput[] = []

        const mockRunState = SessionRunState.Service.of({
          assertNotBusy: () => Effect.void,
          cancel: () => Effect.void,
          ensureRunning: (_id, _onInterrupt, work) => work,
          startShell: (_id, _onInterrupt, work) => work,
        })

        const mockPrompt = SessionPrompt.Service.of({
          ...mockSteerPrompt,
          cancel: () => Effect.void,
          prompt: (input) =>
            Effect.sync(() => {
              captured.push(input)
              return { info: {} as any, parts: [] }
            }),
          loop: () => Effect.die(new Error("not implemented")),
          shell: () => Effect.die(new Error("not implemented")),
          command: () => Effect.die(new Error("not implemented")),
          resolvePromptParts: () => Effect.die(new Error("not implemented")),
        })

        await AppRuntime.runPromise(
          GoalRuntime.runObjectiveUpdated(created.id, "updated objective").pipe(
            Effect.provide(Layer.succeed(SessionRunState.Service, mockRunState)),
            Effect.provide(Layer.succeed(SessionPrompt.Service, mockPrompt)),
          ),
        )

        expect(captured).toHaveLength(0)

        await run((svc) => svc.remove(created.id))
      },
    })
  })

  test("active 目标时 runObjectiveUpdated 注入消息（调用者负责去重）", async () => {
    await WithInstance.provide({
      directory: projectRoot,
      fn: async () => {
        const created = await run((svc) => svc.create({}))
        await run((svc) => svc.setGoal({ sessionID: created.id, objective: "same objective" }))

        const captured: SessionPrompt.PromptInput[] = []

        const mockRunState = SessionRunState.Service.of({
          assertNotBusy: () => Effect.void,
          cancel: () => Effect.void,
          ensureRunning: (_id, _onInterrupt, work) => work,
          startShell: (_id, _onInterrupt, work) => work,
        })

        const mockPrompt = SessionPrompt.Service.of({
          ...mockSteerPrompt,
          cancel: () => Effect.void,
          prompt: (input) =>
            Effect.sync(() => {
              captured.push(input)
              return { info: {} as any, parts: [] }
            }),
          loop: () => Effect.die(new Error("not implemented")),
          shell: () => Effect.die(new Error("not implemented")),
          command: () => Effect.die(new Error("not implemented")),
          resolvePromptParts: () => Effect.die(new Error("not implemented")),
        })

        await AppRuntime.runPromise(
          GoalRuntime.runObjectiveUpdated(created.id, "same objective").pipe(
            Effect.provide(Layer.succeed(SessionRunState.Service, mockRunState)),
            Effect.provide(Layer.succeed(SessionPrompt.Service, mockPrompt)),
          ),
        )

        expect(captured).toHaveLength(1)

        await run((svc) => svc.remove(created.id))
      },
    })
  })

  test("设/改目标时把 objective 作为可见用户消息注入：空闲直接起一轮（非 noReply、非 synthetic、干净文本）", async () => {
    await WithInstance.provide({
      directory: projectRoot,
      fn: async () => {
        const created = await run((svc) => svc.create({}))
        await run((svc) => svc.setGoal({ sessionID: created.id, objective: "first" }))

        const captured: SessionPrompt.PromptInput[] = []

        const mockRunState = SessionRunState.Service.of({
          assertNotBusy: () => Effect.void,
          cancel: () => Effect.void,
          ensureRunning: (_id, _onInterrupt, work) => work,
          startShell: (_id, _onInterrupt, work) => work,
        })

        const mockPrompt = SessionPrompt.Service.of({
          ...mockSteerPrompt,
          cancel: () => Effect.void,
          prompt: (input) =>
            Effect.sync(() => {
              captured.push(input)
              return { info: {} as any, parts: [] }
            }),
          loop: () => Effect.die(new Error("not implemented")),
          shell: () => Effect.die(new Error("not implemented")),
          command: () => Effect.die(new Error("not implemented")),
          resolvePromptParts: () => Effect.die(new Error("not implemented")),
        })

        await AppRuntime.runPromise(
          GoalRuntime.runObjectiveUpdated(created.id, "updated objective").pipe(
            Effect.provide(Layer.succeed(SessionRunState.Service, mockRunState)),
            Effect.provide(Layer.succeed(SessionPrompt.Service, mockPrompt)),
          ),
        )

        expect(captured).toHaveLength(1)
        expect(captured[0].sessionID).toBe(created.id)
        // mock runState 不忙 → 这条可见消息直接发起一轮（不带 noReply）
        expect(captured[0].noReply).toBeFalsy()
        const part = captured[0].parts[0]
        expect(part.type).toBe("text")
        if (part.type === "text") {
          expect(part.text).toBe("updated objective")
          expect(part.synthetic).toBeFalsy()
        }
        // 第二个 part 是隐藏的目标框架（completion audit），让模型首轮完成即调 update_goal
        const framework = captured[0].parts[1]
        expect(framework.type).toBe("text")
        if (framework.type === "text") {
          expect(framework.synthetic).toBe(true)
          expect(framework.text).toContain("updated objective")
        }

        await run((svc) => svc.remove(created.id))
      },
    })
  })

  test("会话 busy（assertNotBusy 抛 defect）时 objective 仍以 noReply 写入历史", async () => {
    await WithInstance.provide({
      directory: projectRoot,
      fn: async () => {
        const created = await run((svc) => svc.create({}))
        await run((svc) => svc.setGoal({ sessionID: created.id, objective: "first" }))

        const captured: SessionPrompt.PromptInput[] = []

        const mockRunState = SessionRunState.Service.of({
          // 模拟真实 SessionRunState.assertNotBusy 的 busy 行为：throw（defect 通道，而非 typed fail）
          assertNotBusy: () =>
            Effect.sync(() => {
              throw new Error("busy")
            }),
          cancel: () => Effect.void,
          ensureRunning: (_id, _onInterrupt, work) => work,
          startShell: (_id, _onInterrupt, work) => work,
        })

        const mockPrompt = SessionPrompt.Service.of({
          ...mockSteerPrompt,
          cancel: () => Effect.void,
          prompt: (input) =>
            Effect.sync(() => {
              captured.push(input)
              return { info: {} as any, parts: [] }
            }),
          loop: () => Effect.die(new Error("not implemented")),
          shell: () => Effect.die(new Error("not implemented")),
          command: () => Effect.die(new Error("not implemented")),
          resolvePromptParts: () => Effect.die(new Error("not implemented")),
        })

        await AppRuntime.runPromise(
          GoalRuntime.runObjectiveUpdated(created.id, "busy objective").pipe(
            Effect.provide(Layer.succeed(SessionRunState.Service, mockRunState)),
            Effect.provide(Layer.succeed(SessionPrompt.Service, mockPrompt)),
          ),
        )

        expect(captured).toHaveLength(1)
        expect(captured[0].noReply).toBe(true)

        await run((svc) => svc.remove(created.id))
      },
    })
  })
})

describe("GoalRuntime 使用会话选定的模型", () => {
  const picked = { id: ModelID.make("picked-model"), providerID: ProviderID.make("picked-provider"), variant: "high" }

  const mocks = (capture: (input: SessionPrompt.PromptInput) => void) => ({
    runState: SessionRunState.Service.of({
      assertNotBusy: () => Effect.void,
      cancel: () => Effect.void,
      ensureRunning: (_id, _onInterrupt, work) => work,
      startShell: (_id, _onInterrupt, work) => work,
    }),
    prompt: SessionPrompt.Service.of({
      // 目标模式只调用 prompt；复用统一失败桩补齐引导与异步发送接口，误调用时立即暴露。
      ...mockSteerPrompt,
      cancel: () => Effect.void,
      prompt: (input) =>
        Effect.sync(() => {
          capture(input)
          return { info: {} as any, parts: [] }
        }),
      loop: () => Effect.die(new Error("not implemented")),
      shell: () => Effect.die(new Error("not implemented")),
      command: () => Effect.die(new Error("not implemented")),
      resolvePromptParts: () => Effect.die(new Error("not implemented")),
    }),
  })

  // 不传 model 时 prompt 会回退到 lastModel：历史用户消息 → provider 全局默认。
  // 新会话没有历史消息，于是拿到的是用户根本没选的那个默认模型。
  test("runObjectiveUpdated 带上会话模型", async () => {
    await WithInstance.provide({
      directory: projectRoot,
      fn: async () => {
        const created = await run((svc) => svc.create({ model: picked }))
        await run((svc) => svc.setGoal({ sessionID: created.id, objective: "ship it" }))
        let captured: SessionPrompt.PromptInput | undefined
        const m = mocks((input) => (captured = input))

        await AppRuntime.runPromise(
          GoalRuntime.runObjectiveUpdated(created.id, "ship it").pipe(
            Effect.provide(Layer.succeed(SessionRunState.Service, m.runState)),
            Effect.provide(Layer.succeed(SessionPrompt.Service, m.prompt)),
          ),
        )

        expect(captured?.model).toEqual({ providerID: picked.providerID, modelID: picked.id })
        // variant（思考强度）也要透传，否则目标模式会悄悄退回默认强度
        expect(captured?.variant).toBe("high")

        await run((svc) => svc.remove(created.id))
      },
    })
  })

  test("runContinuation 带上会话模型", async () => {
    await WithInstance.provide({
      directory: projectRoot,
      fn: async () => {
        const created = await run((svc) => svc.create({ model: picked }))
        await run((svc) => svc.setGoal({ sessionID: created.id, objective: "keep going" }))
        let captured: SessionPrompt.PromptInput | undefined
        const m = mocks((input) => (captured = input))

        await AppRuntime.runPromise(
          GoalRuntime.runContinuation(created.id).pipe(
            Effect.provide(Layer.succeed(SessionRunState.Service, m.runState)),
            Effect.provide(Layer.succeed(SessionPrompt.Service, m.prompt)),
          ),
        )

        expect(captured?.model).toEqual({ providerID: picked.providerID, modelID: picked.id })
        // variant（思考强度）也要透传，否则目标模式会悄悄退回默认强度
        expect(captured?.variant).toBe("high")

        await run((svc) => svc.remove(created.id))
      },
    })
  })
})

describe("GoalRuntime.runContinuation", () => {
  test("active 目标触发 prompt.prompt 并注入渲染后的续跑文本", async () => {
    await WithInstance.provide({
      directory: projectRoot,
      fn: async () => {
        const created = await run((svc) => svc.create({}))
        await run((svc) => svc.setGoal({ sessionID: created.id, objective: "ship feature Y" }))

        let captured: SessionPrompt.PromptInput | undefined

        const mockRunState = SessionRunState.Service.of({
          assertNotBusy: () => Effect.void,
          cancel: () => Effect.void,
          ensureRunning: (_id, _onInterrupt, work) => work,
          startShell: (_id, _onInterrupt, work) => work,
        })

        const mockPrompt = SessionPrompt.Service.of({
          ...mockSteerPrompt,
          cancel: () => Effect.void,
          prompt: (input) =>
            Effect.sync(() => {
              captured = input
              return { info: {} as any, parts: [] }
            }),
          loop: () => Effect.die(new Error("not implemented")),
          shell: () => Effect.die(new Error("not implemented")),
          command: () => Effect.die(new Error("not implemented")),
          resolvePromptParts: () => Effect.die(new Error("not implemented")),
        })

        await AppRuntime.runPromise(
          GoalRuntime.runContinuation(created.id).pipe(
            Effect.provide(Layer.succeed(SessionRunState.Service, mockRunState)),
            Effect.provide(Layer.succeed(SessionPrompt.Service, mockPrompt)),
          ),
        )

        expect(captured).toBeDefined()
        expect(captured!.sessionID).toBe(created.id)
        const text = captured!.parts[0]
        expect(text.type).toBe("text")
        if (text.type === "text") {
          expect(text.text).toContain("ship feature Y")
        }

        await run((svc) => svc.remove(created.id))
      },
    })
  })

  test("会话 busy 时 assertNotBusy 抛错 → 不触发 prompt.prompt", async () => {
    await WithInstance.provide({
      directory: projectRoot,
      fn: async () => {
        const created = await run((svc) => svc.create({}))
        await run((svc) => svc.setGoal({ sessionID: created.id, objective: "ship feature Z" }))

        let promptCalled = false

        const mockRunState = SessionRunState.Service.of({
          assertNotBusy: () => Effect.fail(new Error("session is busy")) as unknown as Effect.Effect<void>,
          cancel: () => Effect.void,
          ensureRunning: (_id, _onInterrupt, work) => work,
          startShell: (_id, _onInterrupt, work) => work,
        })

        const mockPrompt = SessionPrompt.Service.of({
          ...mockSteerPrompt,
          cancel: () => Effect.void,
          prompt: (_input) =>
            Effect.sync(() => {
              promptCalled = true
              return { info: {} as any, parts: [] }
            }),
          loop: () => Effect.die(new Error("not implemented")),
          shell: () => Effect.die(new Error("not implemented")),
          command: () => Effect.die(new Error("not implemented")),
          resolvePromptParts: () => Effect.die(new Error("not implemented")),
        })

        await AppRuntime.runPromise(
          GoalRuntime.runContinuation(created.id).pipe(
            Effect.provide(Layer.succeed(SessionRunState.Service, mockRunState)),
            Effect.provide(Layer.succeed(SessionPrompt.Service, mockPrompt)),
          ),
        )

        expect(promptCalled).toBe(false)

        await run((svc) => svc.remove(created.id))
      },
    })
  })
})

describe("GoalRuntime setGoal bus wiring", () => {
  test("setGoal 覆盖为不同 objective 时 GoalUpdated 事件 objectiveChanged 为 true", async () => {
    await WithInstance.provide({
      directory: projectRoot,
      fn: async () => {
        const created = await run((svc) => svc.create({}))
        await run((svc) => svc.setGoal({ sessionID: created.id, objective: "first" }))

        let captured: { objectiveChanged?: boolean; newObjective?: string } = {}
        const unsub = Bus.subscribe(SessionStatus.Event.GoalUpdated, (e) => {
          captured = {
            objectiveChanged: e.properties.objectiveChanged,
            newObjective: e.properties.goal.objective,
          }
        })

        await run((svc) => svc.setGoal({ sessionID: created.id, objective: "updated" }))
        await new Promise((r) => setTimeout(r, 50))
        unsub()

        expect(captured.objectiveChanged).toBe(true)
        expect(captured.newObjective).toBe("updated")

        await run((svc) => svc.remove(created.id))
      },
    })
  })

  test("setGoal 每次设定（含重设相同 objective）objectiveChanged 恒为 true", async () => {
    await WithInstance.provide({
      directory: projectRoot,
      fn: async () => {
        const created = await run((svc) => svc.create({}))

        const captured: (boolean | undefined)[] = []
        const unsub = Bus.subscribe(SessionStatus.Event.GoalUpdated, (e) => {
          captured.push(e.properties.objectiveChanged)
        })

        await run((svc) => svc.setGoal({ sessionID: created.id, objective: "first goal" }))
        await run((svc) => svc.setGoal({ sessionID: created.id, objective: "first goal" }))
        await new Promise((r) => setTimeout(r, 50))
        unsub()

        expect(captured).toEqual([true, true])

        await run((svc) => svc.remove(created.id))
      },
    })
  })
})

describe("GoalRuntime 自治续跑护栏", () => {
  test("达到最大连续续跑轮数后停止注入续跑", async () => {
    process.env["WANLAICODE_GOAL_MAX_CONTINUATIONS"] = "2"
    try {
      await WithInstance.provide({
        directory: projectRoot,
        fn: async () => {
          const created = await run((svc) => svc.create({}))
          await run((svc) => svc.setGoal({ sessionID: created.id, objective: "cap test" }))
          GoalRuntime.resetGoalContinuation(created.id)

          let promptCount = 0
          const mockRunState = SessionRunState.Service.of({
            assertNotBusy: () => Effect.void,
            cancel: () => Effect.void,
            ensureRunning: (_id, _onInterrupt, work) => work,
            startShell: (_id, _onInterrupt, work) => work,
          })
          const mockPrompt = SessionPrompt.Service.of({
            ...mockSteerPrompt,
            cancel: () => Effect.void,
            prompt: () =>
              Effect.sync(() => {
                promptCount++
                return { info: {} as any, parts: [] }
              }),
            loop: () => Effect.die(new Error("not implemented")),
            shell: () => Effect.die(new Error("not implemented")),
            command: () => Effect.die(new Error("not implemented")),
            resolvePromptParts: () => Effect.die(new Error("not implemented")),
          })

          for (let i = 0; i < 4; i++) {
            await AppRuntime.runPromise(
              GoalRuntime.runContinuation(created.id).pipe(
                Effect.provide(Layer.succeed(SessionRunState.Service, mockRunState)),
                Effect.provide(Layer.succeed(SessionPrompt.Service, mockPrompt)),
              ),
            )
          }

          expect(promptCount).toBe(2)

          await run((svc) => svc.remove(created.id))
        },
      })
    } finally {
      delete process.env["WANLAICODE_GOAL_MAX_CONTINUATIONS"]
    }
  })
})
