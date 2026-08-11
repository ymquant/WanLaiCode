import { describe, expect } from "bun:test"
import { Effect, Fiber, Layer } from "effect"
import { QuestionTool } from "../../src/tool/question"
import { Question } from "../../src/question"
import { SessionID, MessageID, PartID } from "../../src/session/schema"
import { Agent } from "../../src/agent/agent"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Truncate } from "@/tool/truncate"
import { testEffect } from "../lib/effect"

const ctx = {
  sessionID: SessionID.make("ses_test-session"),
  messageID: MessageID.make("test-message"),
  callID: "test-call",
  agent: "test-agent",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const it = testEffect(
  Layer.mergeAll(Question.defaultLayer, CrossSpawnSpawner.defaultLayer, Truncate.defaultLayer, Agent.defaultLayer),
)

const pending = Effect.fn("QuestionToolTest.pending")(function* (question: Question.Interface) {
  for (;;) {
    const items = yield* question.list()
    const item = items[0]
    if (item) return item
    yield* Effect.sleep("10 millis")
  }
})

describe("tool.question", () => {
  it.instance("should successfully execute with valid question parameters", () =>
    Effect.gen(function* () {
      const question = yield* Question.Service
      const toolInfo = yield* QuestionTool
      const tool = yield* toolInfo.init()
      const questions = [
        {
          question: "What is your favorite color?",
          header: "Color",
          options: [
            { label: "Red", description: "The color of passion" },
            { label: "Blue", description: "The color of sky" },
          ],
          multiple: false,
        },
      ]

      const fiber = yield* tool.execute({ questions }, ctx).pipe(Effect.forkScoped)
      const item = yield* pending(question)
      yield* question.reply({ requestID: item.id, answers: [["Red"]] })

      const result = yield* Fiber.join(fiber)
      expect(result.title).toBe("Asked 1 question")
    }),
  )

  it.instance("should now pass with a header longer than 12 but less than 30 chars", () =>
    Effect.gen(function* () {
      const question = yield* Question.Service
      const toolInfo = yield* QuestionTool
      const tool = yield* toolInfo.init()
      const questions = [
        {
          question: "What is your favorite animal?",
          header: "This Header is Over 12",
          options: [{ label: "Dog", description: "Man's best friend" }],
        },
      ]

      const fiber = yield* tool.execute({ questions }, ctx).pipe(Effect.forkScoped)
      const item = yield* pending(question)
      yield* question.reply({ requestID: item.id, answers: [["Dog"]] })

      const result = yield* Fiber.join(fiber)
      expect(result.output).toContain(`"What is your favorite animal?"="Dog"`)
    }),
  )

  it.instance("does not wait for answers in automation context", () =>
    Effect.gen(function* () {
      const question = yield* Question.Service
      const toolInfo = yield* QuestionTool
      const tool = yield* toolInfo.init()
      const questions = [
        {
          question: "Should the automation continue?",
          header: "Continue",
          options: [{ label: "Yes", description: "Continue running" }],
        },
      ]

      const result = yield* tool.execute({ questions }, { ...ctx, extra: { automationID: "atm_test" } })
      const pending = yield* question.list()

      expect(result.title).toBe("Skipped user questions")
      expect(result.metadata.answers).toEqual([[]])
      expect(pending).toHaveLength(0)
    }),
  )

  it.instance("does not inherit automation context from older messages", () =>
    Effect.gen(function* () {
      const question = yield* Question.Service
      const toolInfo = yield* QuestionTool
      const tool = yield* toolInfo.init()
      const questions = [
        {
          question: "Should this normal turn ask?",
          header: "Ask",
          options: [{ label: "Yes", description: "Ask normally" }],
        },
      ]
      const history = [
        {
          info: {
            id: MessageID.make("msg_automation"),
            role: "user",
            sessionID: ctx.sessionID,
            time: { created: 1 },
            agent: "test-agent",
            model: { providerID: "test", modelID: "test" },
            automationID: "atm_old",
          },
          parts: [
            {
              id: PartID.make("prt_automation"),
              sessionID: ctx.sessionID,
              messageID: MessageID.make("msg_automation"),
              type: "text",
              text: "old automation turn",
            },
          ],
        },
      ] as any

      const fiber = yield* tool.execute({ questions }, { ...ctx, messages: history }).pipe(Effect.forkScoped)
      const item = yield* pending(question)
      yield* question.reply({ requestID: item.id, answers: [["Yes"]] })

      const result = yield* Fiber.join(fiber)
      expect(result.title).toBe("Asked 1 question")
      expect(result.metadata.answers).toEqual([["Yes"]])
    }),
  )

  // intentionally removed the zod validation due to tool call errors, hoping prompting is gonna be good enough
  //   test("should throw an Error for header exceeding 30 characters", async () => {
  //     const tool = await QuestionTool.init()
  //     const questions = [
  //       {
  //         question: "What is your favorite animal?",
  //         header: "This Header is Definitely More Than Thirty Characters Long",
  //         options: [{ label: "Dog", description: "Man's best friend" }],
  //       },
  //     ]
  //     try {
  //       await tool.execute({ questions }, ctx)
  //       // If it reaches here, the test should fail
  //       expect(true).toBe(false)
  //     } catch (e: any) {
  //       expect(e).toBeInstanceOf(Error)
  //       expect(e.cause).toBeInstanceOf(z.ZodError)
  //     }
  //   })

  //   test("should throw an Error for label exceeding 30 characters", async () => {
  //     const tool = await QuestionTool.init()
  //     const questions = [
  //       {
  //         question: "A question with a very long label",
  //         header: "Long Label",
  //         options: [
  //           { label: "This is a very, very, very long label that will exceed the limit", description: "A description" },
  //         ],
  //       },
  //     ]
  //     try {
  //       await tool.execute({ questions }, ctx)
  //       // If it reaches here, the test should fail
  //       expect(true).toBe(false)
  //     } catch (e: any) {
  //       expect(e).toBeInstanceOf(Error)
  //       expect(e.cause).toBeInstanceOf(z.ZodError)
  //     }
  //   })
})
