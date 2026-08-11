import { describe, expect, test } from "bun:test"
import { Effect, Exit, Layer } from "effect"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { SessionRunState } from "@/session/run-state"
import { Permission } from "@/permission"
import { Question } from "@/question"
import type { SessionID } from "@/session/schema"
import { runContinuation } from "./goal-runtime"

// 用最小假层喂满 runContinuation 触及的 5 个服务；只关心 busy 分支的行为契约。
function env(opts: { busy: boolean; onPrompt: () => void }) {
  const session = Layer.succeed(Session.Service, {
    getGoal: () => Effect.succeed({ status: "active", objective: "obj" }),
    messages: () => Effect.succeed([]),
    // selectedModel 会读 session.get 取会话选定模型；假层必须提供，否则抛
    // "session.get is not a function" 被外层 catchCause 吞掉，续跑静默不起轮。
    get: () => Effect.succeed({ model: { id: "m", providerID: "p" } }),
  } as never)
  const runState = Layer.succeed(SessionRunState.Service, {
    // 还原真实语义：busy 时同步 throw（Effect 里走 defect/Die 通道）
    assertNotBusy: () =>
      opts.busy
        ? Effect.sync(() => {
            throw new Error("Session is busy")
          })
        : Effect.void,
  } as never)
  const prompt = Layer.succeed(SessionPrompt.Service, {
    prompt: () =>
      Effect.sync(() => {
        opts.onPrompt()
        return {}
      }),
  } as never)
  const permission = Layer.succeed(Permission.Service, { list: () => Effect.succeed([]) } as never)
  const question = Layer.succeed(Question.Service, { list: () => Effect.succeed([]) } as never)
  return Layer.mergeAll(session, runState, prompt, permission, question)
}

describe("GoalRuntime.runContinuation", () => {
  test("busy 时跳过续跑、不起新轮（不抛 Die）", async () => {
    let called = 0
    const exit = await Effect.runPromiseExit(
      runContinuation("ses_busy" as SessionID).pipe(Effect.provide(env({ busy: true, onPrompt: () => called++ }))),
    )
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(called).toBe(0)
  })

  test("idle（不 busy）时正常发起一轮续跑", async () => {
    let called = 0
    const exit = await Effect.runPromiseExit(
      runContinuation("ses_idle" as SessionID).pipe(Effect.provide(env({ busy: false, onPrompt: () => called++ }))),
    )
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(called).toBe(1)
  })
})
