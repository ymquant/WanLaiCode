import { describe, expect, test } from "bun:test"
import { Effect, Layer, Stream } from "effect"

import { Agent } from "../../src/agent/agent"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { LLM } from "../../src/session/llm"
import { Session } from "../../src/session/session"
import { Provider } from "../../src/provider/provider"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { MemoryProcessor } from "../../src/memory"

const sessionID = SessionID.descending()

function message(role: "user" | "assistant", text: string, synthetic = false, variant?: string): MessageV2.WithParts {
  const id = MessageID.ascending()
  const info =
    role === "user"
      ? {
          id,
          sessionID,
          role,
          time: { created: 0 },
          agent: "build",
          model: { providerID: ProviderID.make("test"), modelID: ModelID.make("memory-model"), variant },
        }
      : {
          id,
          sessionID,
          role,
          time: { created: 0, completed: 0 },
          parentID: MessageID.ascending(),
          modelID: ModelID.make("memory-model"),
          providerID: ProviderID.make("test"),
          mode: "build",
          agent: "build",
          path: { cwd: "/repo", root: "/repo" },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        }
  return {
    info,
    parts: [
      {
        id: PartID.ascending(),
        sessionID,
        messageID: id,
        type: "text",
        text,
        synthetic,
      },
    ],
  } as MessageV2.WithParts
}

describe("MemoryProcessor", () => {
  test("builds context from the latest six visible user and assistant messages", () => {
    const messages = [
      message("user", "oldest"),
      message("assistant", "second"),
      message("user", "third"),
      message("assistant", "fourth"),
      message("user", "fifth"),
      message("assistant", "sixth"),
      message("user", "seventh"),
      message("assistant", "synthetic output", true),
    ]
    const context = MemoryProcessor.buildContext(messages)

    expect(context).not.toContain("oldest")
    expect(context).not.toContain("synthetic output")
    expect(context).toContain("second")
    expect(context).toContain("seventh")
  })

  test("uses the latest user message model", () => {
    const messages = [message("user", "first"), message("assistant", "reply"), message("user", "latest", false, "high")]

    expect(MemoryProcessor.latestModel(messages)).toEqual({
      providerID: ProviderID.make("test"),
      modelID: ModelID.make("memory-model"),
      variant: "high",
    })
  })

  test("processes memory through the current session LLM chain", async () => {
    const messages = [message("user", "remember package-local tests", false, "high")]
    const model = { id: ModelID.make("memory-model"), providerID: ProviderID.make("test") } as Provider.Model
    const agent = {
      name: "build",
      mode: "primary",
      permission: [],
      options: {},
      prompt: "Original agent prompt",
    } satisfies Agent.Info
    let request: LLM.StreamInput | undefined
    const dependencies = Layer.mergeAll(
      Layer.mock(Session.Service)({ messages: () => Effect.succeed(messages) }),
      Layer.mock(Provider.Service)({
        getModel: () => Effect.succeed(model),
        getLanguage: () => Effect.die("MemoryProcessor bypassed LLM.Service"),
      }),
      Layer.mock(Agent.Service)({ get: () => Effect.succeed(agent) }),
      Layer.mock(LLM.Service)({
        stream: (input) => {
          request = input
          return Stream.fromIterable([
            {
              type: "text-delta",
              id: "memory",
              text: '{"name":"package-tests","title":"Package tests","summary":"Run package tests locally","detail":"Run tests from the owning package."}',
            } as LLM.Event,
          ])
        },
      }),
    )
    const layer = MemoryProcessor.layer.pipe(Layer.provide(dependencies))

    const result = await Effect.runPromise(
      MemoryProcessor.Service.use((processor) =>
        processor.process({ content: "以后从 package 目录跑测试", sessionID }),
      ).pipe(Effect.provide(layer)),
    )

    expect(result.name).toBe("package-tests")
    expect(request).toBeDefined()
    expect(request!.model).toBe(model)
    expect(request!.user.model.variant).toBe("high")
    expect(request!.agent.prompt).toContain("durable WanlaiCode memory")
    expect(request!.messages).toEqual([
      {
        role: "user",
        content: expect.stringContaining('"memoryRequest":"以后从 package 目录跑测试"'),
      },
    ])
  })

  test("parses a fenced model draft", () => {
    expect(
      MemoryProcessor.parseDraft(
        '```json\n{"name":"python-uses-uv","title":"Python uses uv","summary":"Use uv","detail":"Run scripts with uv run."}\n```',
      ),
    ).toEqual({
      name: "python-uses-uv",
      title: "Python uses uv",
      summary: "Use uv",
      detail: "Run scripts with uv run.",
    })
  })

  test("rejects unsafe or incomplete model drafts", () => {
    expect(() =>
      MemoryProcessor.parseDraft(
        '{"name":"../secret","title":"Secret","summary":"Unsafe","detail":"Read outside memory."}',
      ),
    ).toThrow("Invalid memory detail")
    expect(() => MemoryProcessor.parseDraft('{"name":"missing-fields"}')).toThrow("Invalid memory processor output")
  })
})
