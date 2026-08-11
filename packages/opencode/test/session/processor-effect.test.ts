import { NodeFileSystem } from "@effect/platform-node"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { describe, expect, test } from "bun:test"
import { Cause, Effect, Exit, Fiber, Layer } from "effect"
import * as Stream from "effect/Stream"
import path from "path"
import type { Agent } from "../../src/agent/agent"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { Bus } from "../../src/bus"
import { Config } from "@/config/config"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider } from "@/provider/provider"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Session } from "@/session/session"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import {
  providerImageGenerationOutput,
  SessionProcessor,
  textPartPhaseForFinish,
  textPartPhaseFromProviderMetadata,
} from "../../src/session/processor"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { SessionSummary } from "../../src/session/summary"
import { Snapshot } from "../../src/snapshot"
import { SessionV2 } from "../../src/v2/session"
import * as Log from "@opencode-ai/core/util/log"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { raw, reply, TestLLMServer } from "../lib/llm-server"

void Log.init({ print: false })

describe("session.processor text phase", () => {
  test("reads an explicit phase from any provider metadata namespace", () => {
    // provider 名由 SDK 决定，processor 只认官方 phase 值，不应硬编码 openai。
    expect(textPartPhaseFromProviderMetadata({ openai: { itemId: "msg_1", phase: "commentary" } })).toBe("commentary")
    expect(textPartPhaseFromProviderMetadata({ copilot: { phase: "final_answer" } })).toBe("final_answer")
    expect(textPartPhaseFromProviderMetadata({ openai: { phase: "analysis" } })).toBeUndefined()
  })

  test("falls back from finish reason using the official activity split", () => {
    // Chat Completions 没有 phase：工具步骤文字归活动流，真正结束的文字归底部回复。
    expect(textPartPhaseForFinish("tool-calls")).toBe("commentary")
    expect(textPartPhaseForFinish("unknown")).toBe("commentary")
    expect(textPartPhaseForFinish("stop")).toBe("final_answer")
    expect(textPartPhaseForFinish("length")).toBe("final_answer")
  })
})

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const ref = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}

function testModel(url: string): Provider.Model {
  return {
    id: ref.modelID,
    providerID: ref.providerID,
    api: {
      id: ref.modelID,
      url,
      npm: "@ai-sdk/openai-compatible",
    },
    name: "Test Model",
    capabilities: {
      toolcall: true,
      attachment: false,
      reasoning: false,
      temperature: false,
      interleaved: false,
      input: { text: true, image: false, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 100000, output: 10000 },
    status: "active",
    options: {},
    headers: {},
    release_date: "2025-01-01",
  }
}

const cfg = {
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: {
        apiKey: "test-key",
        baseURL: "http://localhost:1/v1",
      },
    },
  },
}

function providerCfg(url: string) {
  return {
    ...cfg,
    provider: {
      ...cfg.provider,
      test: {
        ...cfg.provider.test,
        options: {
          ...cfg.provider.test.options,
          baseURL: url,
        },
      },
    },
  }
}

function stallCfg(url: string) {
  const base = providerCfg(url)
  return {
    ...base,
    provider: {
      ...base.provider,
      test: {
        ...base.provider.test,
        options: { ...base.provider.test.options, chunkTimeout: 100 },
      },
    },
  }
}

// @ai-sdk/openai 走 Responses API：output_item.added(message) 会无条件发 text-start，
// output_item.done 无条件发 text-end，中间一个非空 delta 都没有也照样成立
// （ai 层只丢弃空的 text-delta，text-start/text-end 原样透传）。
// openai-compatible 那条链路则要求 content 非空才开 text part，构造不出这个形态。
function responsesStallCfg(url: string) {
  const base = stallCfg(url)
  return {
    ...base,
    provider: {
      ...base.provider,
      test: { ...base.provider.test, npm: "@ai-sdk/openai" },
    },
  }
}

function agent(): Agent.Info {
  return {
    name: "build",
    mode: "primary",
    options: {},
    permission: [{ permission: "*", pattern: "*", action: "allow" }],
  }
}

function defer<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

type PartDeltaReplayEvent = { partID: MessageV2.Part["id"]; field: string; delta: string }

const user = Effect.fn("TestSession.user")(function* (sessionID: SessionID, text: string) {
  const session = yield* Session.Service
  const msg = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID,
    type: "text",
    text,
  })
  return msg
})

const assistant = Effect.fn("TestSession.assistant")(function* (
  sessionID: SessionID,
  parentID: MessageID,
  root: string,
) {
  const session = yield* Session.Service
  const msg: MessageV2.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    sessionID,
    mode: "build",
    agent: "build",
    path: { cwd: root, root },
    cost: 0,
    tokens: {
      total: 0,
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    modelID: ref.modelID,
    providerID: ref.providerID,
    parentID,
    time: { created: Date.now() },
    finish: "end_turn",
  }
  yield* session.updateMessage(msg)
  return msg
})

const status = SessionStatus.layer.pipe(Layer.provideMerge(Bus.layer))
const infra = Layer.mergeAll(NodeFileSystem.layer, CrossSpawnSpawner.defaultLayer)
const deps = Layer.mergeAll(
  Session.defaultLayer,
  Snapshot.defaultLayer,
  AgentSvc.defaultLayer,
  Permission.defaultLayer,
  Plugin.defaultLayer,
  Config.defaultLayer,
  LLM.defaultLayer,
  Provider.defaultLayer,
  status,
).pipe(Layer.provideMerge(infra))
const env = Layer.mergeAll(
  TestLLMServer.layer,
  SessionProcessor.layer.pipe(Layer.provide(summary), Layer.provideMerge(deps)),
)

const testProviderInfo: Provider.Info = {
  id: ref.providerID,
  name: "Test",
  source: "config",
  env: [],
  options: {},
  models: {},
}
const testProviderLayer = Layer.succeed(
  Provider.Service,
  Provider.Service.of({
    list: Effect.fn("TestProvider.list")(() => Effect.succeed({ [ref.providerID]: testProviderInfo })),
    getProvider: Effect.fn("TestProvider.getProvider")((providerID) => {
      if (providerID === ref.providerID) return Effect.succeed(testProviderInfo)
      return Effect.die(new Error(`Unknown test provider: ${providerID}`))
    }),
    getModel: Effect.fn("TestProvider.getModel")((providerID, modelID) => {
      if (providerID === ref.providerID && modelID === ref.modelID)
        return Effect.succeed(testModel("http://localhost:1/v1"))
      return Effect.die(new Error(`Unknown test model: ${providerID}/${modelID}`))
    }),
    getLanguage: Effect.fn("TestProvider.getLanguage")((model) =>
      Effect.sync(() =>
        createOpenAICompatible({
          name: model.providerID,
          apiKey: "test-key",
          baseURL: model.api.url,
        }).languageModel(model.api.id),
      ),
    ),
    closest: Effect.fn("TestProvider.closest")((providerID) =>
      Effect.succeed(providerID === ref.providerID ? { providerID: ref.providerID, modelID: ref.modelID } : undefined),
    ),
    getSmallModel: Effect.fn("TestProvider.getSmallModel")((providerID) =>
      Effect.succeed(providerID === ref.providerID ? testModel("http://localhost:1/v1") : undefined),
    ),
    defaultModel: Effect.fn("TestProvider.defaultModel")(() =>
      Effect.succeed({ providerID: ref.providerID, modelID: ref.modelID }),
    ),
    refresh: Effect.fn("TestProvider.refresh")(() => Effect.void),
  }),
)
const depsWithTestProvider = Layer.mergeAll(
  Session.defaultLayer,
  Snapshot.defaultLayer,
  AgentSvc.defaultLayer,
  Permission.defaultLayer,
  Plugin.defaultLayer,
  Config.defaultLayer,
  LLM.defaultLayer,
  testProviderLayer,
  status,
).pipe(Layer.provideMerge(infra))
const envWithTestProvider = Layer.mergeAll(
  TestLLMServer.layer,
  SessionProcessor.layer.pipe(Layer.provide(summary), Layer.provideMerge(depsWithTestProvider)),
)

// experimental.text.complete 会重写最终落库的正文，「这一步有没有给出回答」必须按重写后的结果算。
// 这个可切换的 hook 用来覆盖 hook 把正文清空 / 从空白补出正文两种方向。
let rewriteFinalText: ((text: string) => string) | undefined
const textHookPluginLayer = Layer.mock(Plugin.Service)({
  trigger: <Name extends string, Input, Output>(name: Name, _input: Input, output: Output) => {
    if (name !== "experimental.text.complete" || !rewriteFinalText) return Effect.succeed(output)
    const current = output as Output & { text: string }
    return Effect.succeed({ ...current, text: rewriteFinalText(current.text) })
  },
  list: () => Effect.succeed([]),
  init: () => Effect.void,
})
const depsWithTextHook = Layer.mergeAll(
  Session.defaultLayer,
  Snapshot.defaultLayer,
  AgentSvc.defaultLayer,
  Permission.defaultLayer,
  textHookPluginLayer,
  Config.defaultLayer,
  LLM.defaultLayer,
  Provider.defaultLayer,
  status,
).pipe(Layer.provideMerge(infra))
const envWithTextHook = Layer.mergeAll(
  TestLLMServer.layer,
  SessionProcessor.layer.pipe(Layer.provide(summary), Layer.provideMerge(depsWithTextHook)),
)

const it = testEffect(env)
const itProvider = testEffect(envWithTestProvider)
const itTextHook = testEffect(envWithTextHook)

const boot = Effect.fn("test.boot")(function* () {
  const processors = yield* SessionProcessor.Service
  const session = yield* Session.Service
  const provider = yield* Provider.Service
  return { processors, session, provider }
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

it.live("session.processor effect tests capture llm input cleanly", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.text("hello")

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "hi")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
          user: parent,
        })

        const input = {
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "hi" }],
          tools: {},
        } satisfies LLM.StreamInput

        const value = yield* handle.process(input)
        const parts = MessageV2.parts(msg.id)
        const calls = yield* llm.calls
        const projected = yield* SessionV2.Service.use((service) => service.messages({ sessionID: chat.id })).pipe(
          Effect.provide(SessionV2.layer),
        )

        expect(value).toBe("continue")
        expect(calls).toBe(1)
        expect(
          parts.some((part) => part.type === "text" && part.text === "hello" && part.phase === "final_answer"),
        ).toBe(true)
        // 兼容 provider 的 phase 在 finish-step 才能确定；session.next 持久化投影也必须拿到同一个最终阶段。
        expect(
          projected.some(
            (message) =>
              message.type === "assistant" &&
              message.content.some(
                (part) => part.type === "text" && part.text === "hello" && part.phase === "final_answer",
              ),
          ),
        ).toBe(true)
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests coalesces dense text deltas", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const bus = yield* Bus.Service
        const expected = "abcdefghijklmnopqrst"

        yield* llm.push(
          Array.from(expected)
            .reduce((res, text) => res.text(text), reply())
            .stop(),
        )

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "hi")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
          user: parent,
        })
        const deltas: string[] = []
        const deltaFiber = yield* bus.subscribe(MessageV2.Event.PartDelta).pipe(
          Stream.runForEach((event) =>
            Effect.sync(() => {
              if (event.properties.sessionID === chat.id && event.properties.messageID === msg.id)
                deltas.push(event.properties.delta)
            }),
          ),
          Effect.forkScoped,
        )
        yield* Effect.sleep("10 millis")

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "hi" }],
          tools: {},
        })
        yield* Fiber.interrupt(deltaFiber).pipe(Effect.ignore)

        const parts = MessageV2.parts(msg.id)

        expect(value).toBe("continue")
        expect(deltas.join("")).toBe(expected)
        expect(deltas.length).toBeLessThan(expected.length)
        expect(parts.some((part) => part.type === "text" && part.text === expected)).toBe(true)
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests preserve text start time", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const gate = defer<void>()
        const { processors, session, provider } = yield* boot()

        yield* llm.push(
          raw({
            head: [
              {
                id: "chatcmpl-test",
                object: "chat.completion.chunk",
                choices: [{ delta: { role: "assistant" } }],
              },
              {
                id: "chatcmpl-test",
                object: "chat.completion.chunk",
                choices: [{ delta: { content: "hello" } }],
              },
            ],
            wait: gate.promise,
            tail: [
              {
                id: "chatcmpl-test",
                object: "chat.completion.chunk",
                choices: [{ delta: {}, finish_reason: "stop" }],
              },
            ],
          }),
        )

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "hi")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
          user: parent,
        })

        const run = yield* handle
          .process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies MessageV2.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "hi" }],
            tools: {},
          })
          .pipe(Effect.forkChild)

        yield* Effect.promise(async () => {
          const stop = Date.now() + 500
          while (Date.now() < stop) {
            const text = MessageV2.parts(msg.id).find((part): part is MessageV2.TextPart => part.type === "text")
            if (text?.time?.start) return
            await Bun.sleep(10)
          }
          throw new Error("timed out waiting for text part")
        })
        yield* Effect.sleep("20 millis")
        gate.resolve()

        const exit = yield* Fiber.await(run)
        const text = MessageV2.parts(msg.id).find((part): part is MessageV2.TextPart => part.type === "text")

        expect(Exit.isSuccess(exit)).toBe(true)
        expect(text?.text).toBe("hello")
        expect(text?.time?.start).toBeDefined()
        expect(text?.time?.end).toBeDefined()
        if (!text?.time?.start || !text.time.end) return
        expect(text.time.start).toBeLessThan(text.time.end)
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests stop after token overflow requests compaction", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.text("after", { usage: { input: 100, output: 0 } })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "compact")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const base = yield* provider.getModel(ref.providerID, ref.modelID)
        const mdl = { ...base, limit: { context: 20, output: 10 } }
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
          user: parent,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "compact" }],
          tools: {},
        })

        const parts = MessageV2.parts(msg.id)

        expect(value).toBe("compact")
        expect(parts.some((part) => part.type === "text" && part.text === "after")).toBe(true)
        expect(parts.some((part) => part.type === "step-finish")).toBe(true)
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests capture reasoning from http mock", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.push(reply().reason("think").text("done").stop())

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "reason")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
          user: parent,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "reason" }],
          tools: {},
        })

        const parts = MessageV2.parts(msg.id)
        const reasoning = parts.find((part): part is MessageV2.ReasoningPart => part.type === "reasoning")
        const text = parts.find((part): part is MessageV2.TextPart => part.type === "text")

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(1)
        expect(reasoning?.text).toBe("think")
        expect(text?.text).toBe("done")
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests preserve legitimate repeated reasoning deltas", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const bus = yield* Bus.Service
        const reasoning = "逐项检查上下文、工具结果和剩余任务。\n".repeat(300)
        const deltas: PartDeltaReplayEvent[] = []

        // 两个内容相同的 reasoning delta 没有 replay 标记，必须按 provider 事件顺序视为合法的 H+H 正文。
        yield* llm.push(reply().reason(reasoning).reason(reasoning).text("done").stop())

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "reason replay")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
          user: parent,
        })
        const deltaFiber = yield* bus.subscribe(MessageV2.Event.PartDelta).pipe(
          Stream.runForEach((event) =>
            Effect.sync(() => {
              if (
                event.properties.sessionID === chat.id &&
                event.properties.messageID === msg.id &&
                event.properties.field === "text"
              )
                deltas.push({
                  partID: event.properties.partID,
                  field: event.properties.field,
                  delta: event.properties.delta,
                })
            }),
          ),
          Effect.forkScoped,
        )
        yield* Effect.sleep("10 millis")

        const value = yield* handle.process({
          user: parent,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "reason replay" }],
          tools: {},
        })
        yield* Fiber.interrupt(deltaFiber).pipe(Effect.ignore)

        const part = MessageV2.parts(msg.id).find((item): item is MessageV2.ReasoningPart => item.type === "reasoning")
        // 实时事件和最终持久化必须都保留两份，确保流式视图、刷新历史与模型回放完全一致。
        expect(value).toBe("continue")
        expect(
          deltas
            .filter((event) => event.partID === part?.id)
            .map((event) => event.delta)
            .join(""),
        ).toBe(reasoning + reasoning)
        expect(part?.text).toBe(reasoning + reasoning)
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

itProvider.live("session.processor effect tests flushes translated reasoning deltas before final update", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session } = yield* boot()
        const bus = yield* Bus.Service
        const english = "I should inspect this first."
        const translated = "我应该先检查这个。"
        const deltas: PartDeltaReplayEvent[] = []

        // 带一句正文：只吐思考的 stop 属于空回复会被自动重试，这里要测的是翻译 flush 而不是重试。
        yield* llm.push(reply().reason(english).text("done").stop(), reply().text(translated).stop())

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "reason")
        const translatedUser = {
          ...parent,
          language: "zh-CN",
          translateContent: true,
        } satisfies MessageV2.User
        yield* session.updateMessage(translatedUser)
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = testModel(llm.url)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
          user: translatedUser,
        })
        const deltaFiber = yield* bus.subscribe(MessageV2.Event.PartDelta).pipe(
          Stream.runForEach((event) =>
            Effect.sync(() => {
              if (event.properties.sessionID === chat.id && event.properties.messageID === msg.id) {
                deltas.push({
                  partID: event.properties.partID,
                  field: event.properties.field,
                  delta: event.properties.delta,
                })
              }
            }),
          ),
          Effect.forkScoped,
        )
        yield* Effect.sleep("10 millis")

        const value = yield* handle.process({
          user: translatedUser,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "reason" }],
          tools: {},
        })
        const finalUpdateBoundary = deltas.length
        yield* Effect.sleep("80 millis")
        yield* Fiber.interrupt(deltaFiber).pipe(Effect.ignore)

        const finalReasoning = MessageV2.parts(msg.id).find(
          (part): part is MessageV2.ReasoningPart => part.type === "reasoning",
        )
        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(2)
        expect(finalReasoning?.text).toBe(translated)
        expect(finalReasoning?.originalText).toBe(english)

        const trailingTextDeltas = deltas
          .slice(finalUpdateBoundary)
          .filter((event) => event.partID === finalReasoning?.id && event.field === "text")
        const replayedText = trailingTextDeltas.reduce((text, event) => text + event.delta, finalReasoning?.text ?? "")

        expect(trailingTextDeltas).toEqual([])
        expect(replayedText).toBe(translated)
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests reset reasoning state across retries", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        // 第二轮带正文：否则它本身又是一次空回复，会继续重试而不是收尾。
        yield* llm.push(reply().reason("one").reset(), reply().reason("two").text("ok").stop())

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "reason")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
          user: parent,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "reason" }],
          tools: {},
        })

        const parts = MessageV2.parts(msg.id)
        const reasoning = parts.filter((part): part is MessageV2.ReasoningPart => part.type === "reasoning")

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(2)
        expect(reasoning.some((part) => part.text === "two")).toBe(true)
        expect(reasoning.some((part) => part.text === "onetwo")).toBe(false)
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests do not retry unknown json errors", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.error(400, { error: { message: "no_kv_space" } })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "json")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
          user: parent,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "json" }],
          tools: {},
        })

        expect(value).toBe("stop")
        expect(yield* llm.calls).toBe(1)
        expect(handle.message.error?.name).toBe("APIError")
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor converts native image_generation result into image attachment", () =>
  Effect.gen(function* () {
    const output = providerImageGenerationOutput({ result: "aW1hZ2U=" })

    expect(output?.output).toBe("Generated 1 image.")
    expect(output?.attachments?.[0]?.mime).toBe("image/png")
    expect(output?.attachments?.[0]?.url).toBe("data:image/png;base64,aW1hZ2U=")
  }),
)

it.live("session.processor effect tests retry recognized structured json errors", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.error(429, { type: "error", error: { type: "too_many_requests" } })
        yield* llm.text("after")

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "retry json")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
          user: parent,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "retry json" }],
          tools: {},
        })

        const parts = MessageV2.parts(msg.id)

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(2)
        expect(parts.some((part) => part.type === "text" && part.text === "after")).toBe(true)
        expect(handle.message.error).toBeUndefined()
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests retry an empty stop before showing content", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.push(reply().stop(), reply().text("recovered").stop())

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "empty stop")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
          user: parent,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "empty stop" }],
          tools: {},
        })

        const parts = MessageV2.parts(msg.id)

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(2)
        expect(parts.some((part) => part.type === "text" && part.text === "recovered")).toBe(true)
        expect(handle.message.error).toBeUndefined()
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live(
  "session.processor effect tests retry repeated empty stops until content arrives",
  () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          const { processors, session, provider } = yield* boot()

          // Processor integration covers consecutive retries here. The no-attempt-cap
          // policy is exercised separately with TestClock in session/retry.test.ts.
          yield* llm.push(
            ...Array.from({ length: 3 }, () => reply().stop()),
            reply().text("eventually recovered").stop(),
          )

          const chat = yield* session.create({})
          const parent = yield* user(chat.id, "empty stop")
          const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
          const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
          const handle = yield* processors.create({
            assistantMessage: msg,
            sessionID: chat.id,
            model: mdl,
            user: parent,
          })

          const value = yield* handle.process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies MessageV2.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "empty stop" }],
            tools: {},
          })

          const parts = MessageV2.parts(msg.id)

          expect(value).toBe("continue")
          expect(yield* llm.calls).toBe(4)
          expect(parts.some((part) => part.type === "text" && part.text === "eventually recovered")).toBe(true)
          expect(handle.message.error).toBeUndefined()
        }),
      { config: (url) => providerCfg(url) },
    ),
  20_000,
)

it.live("session.processor effect tests retry a reasoning-only stop", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        // 思考不是可显示回复：只吐 reasoning 就 stop 的一轮在前端等同空回复，必须自动重试，
        // 不能落成终态让用户自己点重试。
        yield* llm.push(reply().reason("先想一下").stop(), reply().text("recovered").stop())

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "reasoning only")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
          user: parent,
        })
        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "reasoning only" }],
          tools: {},
        })

        const parts = MessageV2.parts(msg.id)

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(2)
        expect(parts.some((part) => part.type === "text" && part.text === "recovered")).toBe(true)
        // 官方 item 一旦展示就保留原位；补最终回答时不能撤回用户刚看到的 reasoning。
        expect(parts.filter((part) => part.type === "reasoning")).toHaveLength(1)
        expect(handle.message.error).toBeUndefined()
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests complete preserved reasoning when reasoning-end is missing", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        // 第一轮 response 已完成但漏掉 reasoning item done；续跑前必须把已展示推理补成终态。
        yield* llm.push(reply().reasonWithoutEnd("先检查上下文").stop(), reply().text("recovered").stop())

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "reasoning without end")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
          user: parent,
        })
        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "reasoning without end" }],
          tools: {},
        })

        const parts = MessageV2.parts(msg.id)
        const reasoning = parts.find(
          (part): part is MessageV2.ReasoningPart => part.type === "reasoning" && part.text === "先检查上下文",
        )

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(2)
        expect(reasoning?.time.end).toBeNumber()
        expect(parts.some((part) => part.type === "text" && part.text === "recovered")).toBe(true)
        expect(handle.message.error).toBeUndefined()
      }),
    { git: true, config: (url) => responsesStallCfg(url) },
  ),
)

it.live("session.processor effect tests preserve a commentary-only stop", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        // Responses 的 commentary 是完整可见 item；turn 收尾后仍应原位保留，不能按空回复删掉再请求一次。
        yield* llm.push(reply().commentary("正在检查").stop())

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "commentary only")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
          user: parent,
        })
        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "commentary only" }],
          tools: {},
        })

        const parts = MessageV2.parts(msg.id)

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(1)
        expect(
          parts.some((part) => part.type === "text" && part.text === "正在检查" && part.phase === "commentary"),
        ).toBe(true)
        expect(handle.message.error).toBeUndefined()
      }),
    { git: true, config: (url) => responsesStallCfg(url) },
  ),
)

it.live("session.processor effect tests clear finish while retrying an empty response", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const gate = Promise.withResolvers<void>()

        yield* llm.push(reply().stop(), reply().wait(gate.promise).text("recovered").stop())

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "empty then retry")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
          user: parent,
        })

        const running = yield* handle
          .process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies MessageV2.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "empty then retry" }],
            tools: {},
          })
          .pipe(Effect.forkChild)

        // 第二次请求已经发出 = 正在重试。此刻消息不能带着上一轮的 finish：
        // 前端 assistantTurnTerminal 会据此判成终态，于是重试期间不显示「正在重试」，
        // 反而弹出「请求已结束，但没有收到可显示的回复」。
        yield* llm.wait(2)
        const midway = MessageV2.get({ sessionID: chat.id, messageID: msg.id }).info
        expect(midway.role).toBe("assistant")
        if (midway.role !== "assistant") throw new Error("expected assistant message")
        expect(midway.finish).toBeUndefined()
        expect(midway.time.completed).toBeUndefined()

        gate.resolve()
        const exit = yield* Fiber.await(running)

        expect(Exit.isSuccess(exit)).toBe(true)
        expect(Exit.isSuccess(exit) && exit.value).toBe("continue")
        expect(handle.message.finish).toBe("stop")
        expect(MessageV2.parts(msg.id).some((part) => part.type === "text" && part.text === "recovered")).toBe(true)
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests retry a whitespace-only answer", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        // 只有空格/换行的正文在前端 trim 之后什么都看不到，等同空回复，必须重试。
        yield* llm.push(reply().text("   \n  ").stop(), reply().text("recovered").stop())

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "whitespace only")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
          user: parent,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "whitespace only" }],
          tools: {},
        })

        const texts = MessageV2.parts(msg.id).filter((part): part is MessageV2.TextPart => part.type === "text")

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(2)
        expect(texts.map((part) => part.text)).toEqual(["recovered"])
        expect(handle.message.error).toBeUndefined()
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

itTextHook.live("session.processor effect tests retry when the completion hook blanks the answer", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        // 模型给了正文，但 experimental.text.complete 把最终落库的正文改成空——
        // 用户什么都看不到，所以要按空回复重试，而不是收工。
        let hits = 0
        rewriteFinalText = (text) => (++hits === 1 ? "   " : text)
        yield* llm.push(reply().text("会被 hook 清空").stop(), reply().text("recovered").stop())

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "hook blanks")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
          user: parent,
        })

        const value = yield* handle
          .process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies MessageV2.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "hook blanks" }],
            tools: {},
          })
          .pipe(Effect.ensuring(Effect.sync(() => (rewriteFinalText = undefined))))

        const texts = MessageV2.parts(msg.id).filter((part): part is MessageV2.TextPart => part.type === "text")

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(2)
        expect(texts.map((part) => part.text)).toEqual(["recovered"])
        expect(handle.message.error).toBeUndefined()
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

itTextHook.live("session.processor effect tests keep an answer the completion hook fills in", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        // 反过来：模型只吐了空白，但 hook 补出了可见正文。这是一次有效回答，
        // 不能因为原始 delta 是空的就当空回复重试——那会重复内容。
        rewriteFinalText = (text) => (text.trim() ? text : "由插件补出的正文")
        yield* llm.push(reply().text("   ").stop(), reply().text("不该被请求").stop())

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "hook fills")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
          user: parent,
        })

        const value = yield* handle
          .process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies MessageV2.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "hook fills" }],
            tools: {},
          })
          .pipe(Effect.ensuring(Effect.sync(() => (rewriteFinalText = undefined))))

        const texts = MessageV2.parts(msg.id).filter((part): part is MessageV2.TextPart => part.type === "text")

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(1)
        expect(texts.map((part) => part.text)).toEqual(["由插件补出的正文"])
        expect(handle.message.error).toBeUndefined()
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

itTextHook.live("session.processor effect tests do not retry a stall after the hook persisted an answer", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        // 原始 delta 一个非空字符都没有，正文完全由 hook 补出并落库。它不会被回滚
        //（回滚只发生在空回复分支），所以随后的流停滞不能再重试，否则下一次 attempt 的
        // 正文会叠在这份 hook 正文上。Responses 链路的 output_item.added/done 正好产出
        // 「有 text part、无 truthy delta」这个形态。
        rewriteFinalText = (text) => (text.trim() ? text : "由插件补出的正文")
        yield* llm.push(reply().text("").hang())
        yield* llm.text("不该被请求")

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "hook fills then stall")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
          user: parent,
        })

        yield* handle
          .process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies MessageV2.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "hook fills then stall" }],
            tools: {},
          })
          .pipe(Effect.ensuring(Effect.sync(() => (rewriteFinalText = undefined))))

        const texts = MessageV2.parts(msg.id).filter((part): part is MessageV2.TextPart => part.type === "text")

        expect(yield* llm.calls).toBe(1)
        expect(texts.map((part) => part.text)).toEqual(["由插件补出的正文"])
        expect(handle.message.error?.name).toBe("APIError")
      }),
    { git: true, config: (url) => responsesStallCfg(url) },
  ),
)

it.live(
  "session.processor effect tests still retry a stall after preserving reasoning",
  () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          const { processors, session, provider } = yield* boot()

          // 第一轮只吐思考并原位保留；第二轮在自己的首 token 前停滞，仍可无损重试并拿到最终回答。
          yield* llm.push(reply().reason("先想一下").stop())
          yield* llm.push(reply().hang())
          yield* llm.text("recovered")

          const chat = yield* session.create({})
          const parent = yield* user(chat.id, "rollback then stall")
          const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
          const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
          const handle = yield* processors.create({
            assistantMessage: msg,
            sessionID: chat.id,
            model: mdl,
            user: parent,
          })

          const value = yield* handle.process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies MessageV2.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "rollback then stall" }],
            tools: {},
          })

          expect(value).toBe("continue")
          expect(yield* llm.calls).toBe(3)
          expect(MessageV2.parts(msg.id).some((part) => part.type === "reasoning" && part.text === "先想一下")).toBe(
            true,
          )
          expect(MessageV2.parts(msg.id).some((part) => part.type === "text" && part.text === "recovered")).toBe(true)
          expect(handle.message.error).toBeUndefined()
        }),
      { git: true, config: (url) => stallCfg(url) },
    ),
  20_000,
)

it.live("session.processor effect tests leave a truncated reasoning-only step to length continuation", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        // 思考吃光输出预算（finish=length）不是空流：重发同一请求只会再截断，
        // 必须留给主循环的 length 续跑，所以这里一次都不重试。
        yield* llm.push(reply().reason("想了很久").truncated())

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "truncated reasoning")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
          user: parent,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "truncated reasoning" }],
          tools: {},
        })

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(1)
        expect(handle.message.finish).toBe("length")
        expect(handle.message.error).toBeUndefined()
        expect(MessageV2.parts(msg.id).some((part) => part.type === "reasoning")).toBe(true)
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live(
  "session.processor effect tests stop retrying empty responses at the cap",
  () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          const { processors, session, provider } = yield* boot()

          // 模型持续只吐思考时不能一直空转：到上限后落错误卡片，让用户换模型。
          yield* llm.push(...Array.from({ length: 6 }, () => reply().reason("空转").stop()))

          const chat = yield* session.create({})
          const parent = yield* user(chat.id, "always empty")
          const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
          const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
          const handle = yield* processors.create({
            assistantMessage: msg,
            sessionID: chat.id,
            model: mdl,
            user: parent,
          })

          const value = yield* handle.process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies MessageV2.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "always empty" }],
            tools: {},
          })

          expect(value).toBe("stop")
          expect(yield* llm.calls).toBe(SessionProcessor.EMPTY_RESPONSE_MAX_RETRIES + 1)
          const failure = handle.message.error
          expect(failure?.name).toBe("APIError")
          // 终态错误不再自称「正在重试」。
          const failureMessage = failure && "message" in failure.data ? failure.data.message : undefined
          expect(failureMessage).toContain("请重试或切换模型")
          expect(failureMessage).not.toContain("正在重试")
          // 最后一轮的思考保留下来，用户至少能看到模型想了什么。
          expect(MessageV2.parts(msg.id).some((part) => part.type === "reasoning")).toBe(true)
        }),
      { git: true, config: (url) => providerCfg(url) },
    ),
  20_000,
)

it.live(
  "session.processor effect tests retry a 5xx that follows empty stops",
  () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          const { processors, session, provider } = yield* boot()

          // 空流的 stop 会把 responseCompleted 置真；该标志属于单次 attempt，
          // 不能泄漏到下一次 attempt 把本应无限重试的 5xx 判成终态。
          yield* llm.push(...Array.from({ length: 2 }, () => reply().stop()))
          yield* llm.error(503, { error: { code: "SERVICE_UNAVAILABLE", message: "Request failed" } })
          yield* llm.text("recovered")

          const chat = yield* session.create({})
          const parent = yield* user(chat.id, "empty stop then 503")
          const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
          const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
          const handle = yield* processors.create({
            assistantMessage: msg,
            sessionID: chat.id,
            model: mdl,
            user: parent,
          })

          const value = yield* handle.process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies MessageV2.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "empty stop then 503" }],
            tools: {},
          })

          const parts = MessageV2.parts(msg.id)

          expect(value).toBe("continue")
          expect(yield* llm.calls).toBe(4)
          expect(parts.some((part) => part.type === "text" && part.text === "recovered")).toBe(true)
          expect(handle.message.error).toBeUndefined()
        }),
      { config: (url) => providerCfg(url) },
    ),
  30_000,
)

it.live("session.processor effect tests treat large empty stops as context overflow", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        // 长上下文空 stop 多半是模型窗口耗尽，不能按普通空响应重试同一个请求。
        const prompt = "上下文过长压测".repeat(60_000)

        yield* llm.push(...Array.from({ length: 7 }, () => reply().stop()))

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, prompt)
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
          user: parent,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: prompt }],
          tools: {},
        })

        expect(value).toBe("compact")
        expect(yield* llm.calls).toBe(1)
        expect(handle.message.error).toBeUndefined()
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests treat huge single-message empty stops as context overflow", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        // 视觉复现里单条中文消息约 68 万字符，上游会空 stop；这里必须直接转压缩，不能重试 6 次。
        const prompt = "上下文过长视觉复现：请只回复收到。".repeat(40_000)

        yield* llm.push(...Array.from({ length: 7 }, () => reply().stop()))

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, prompt)
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
          user: parent,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: prompt }],
          tools: {},
        })

        expect(value).toBe("compact")
        expect(yield* llm.calls).toBe(1)
        expect(handle.message.error).toBeUndefined()
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests publish retry status updates", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const bus = yield* Bus.Service

        yield* llm.error(503, { error: "boom" })
        yield* llm.text("after")

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "retry")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        // 真实 prompt 创建 assistant 时会固定所属 turn；这里补齐该身份以验证 retry 事件不会丢失时间线锚点。
        msg.turnID = parent.id
        yield* session.updateMessage(msg)
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const states: number[] = []
        const turnIDs: (string | undefined)[] = []
        const off = yield* bus.subscribeCallback(SessionStatus.Event.Status, (evt) => {
          if (evt.properties.sessionID !== chat.id) return
          if (evt.properties.status.type !== "retry") return
          states.push(evt.properties.status.attempt)
          turnIDs.push(evt.properties.status.turnID)
        })
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
          user: parent,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "retry" }],
          tools: {},
        })

        off()

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(2)
        expect(states).toStrictEqual([1])
        expect(turnIDs).toStrictEqual([parent.id])
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests compact on structured context overflow", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.error(400, { type: "error", error: { code: "context_length_exceeded" } })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "compact json")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
          user: parent,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "compact json" }],
          tools: {},
        })

        expect(value).toBe("compact")
        expect(yield* llm.calls).toBe(1)
        expect(handle.message.error).toBeUndefined()
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests mark pending tools as aborted on cleanup", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        // 兼容接口先发工具前说明、再开始一个未完成工具；即使没有 finish-step，说明也必须立即落为 commentary。
        yield* llm.push(reply().text("先检查目录").pendingTool("bash", { cmd: "pwd" }).hang())

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "tool abort")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
          user: parent,
        })

        const run = yield* handle
          .process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies MessageV2.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "tool abort" }],
            tools: {},
          })
          .pipe(Effect.forkChild)

        yield* llm.wait(1)
        yield* Effect.promise(async () => {
          const end = Date.now() + 500
          while (Date.now() < end) {
            const parts = await MessageV2.parts(msg.id)
            if (parts.some((part) => part.type === "tool")) return
            await Bun.sleep(10)
          }
        })
        yield* Fiber.interrupt(run)

        const exit = yield* Fiber.await(run)
        const parts = MessageV2.parts(msg.id)
        const call = parts.find((part): part is MessageV2.ToolPart => part.type === "tool")
        const progress = parts.find((part): part is MessageV2.TextPart => part.type === "text")

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        }
        expect(yield* llm.calls).toBe(1)
        expect(progress?.phase).toBe("commentary")
        expect(call?.state.status).toBe("error")
        if (call?.state.status === "error") {
          expect(call.state.error).toBe("Tool execution aborted")
          expect(call.state.metadata?.interrupted).toBe(true)
          expect(call.state.time.end).toBeDefined()
        }
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests record aborted errors without ending runner state", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const seen = defer<void>()
        const { processors, session, provider } = yield* boot()
        const bus = yield* Bus.Service
        const sts = yield* SessionStatus.Service

        yield* llm.hang

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "abort")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const errs: string[] = []
        const off = yield* bus.subscribeCallback(Session.Event.Error, (evt) => {
          if (evt.properties.sessionID !== chat.id) return
          if (!evt.properties.error) return
          errs.push(evt.properties.error.name)
          seen.resolve()
        })
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
          user: parent,
        })

        const run = yield* handle
          .process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies MessageV2.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "abort" }],
            tools: {},
          })
          .pipe(Effect.forkChild)

        yield* llm.wait(1)
        // 模拟用户点击停止：SessionRunState.cancel 会打上用户主动取消标记，
        // processor 据此把中断落成 MessageAbortedError。
        yield* sts.markUserAbort(chat.id)
        yield* Fiber.interrupt(run)

        const exit = yield* Fiber.await(run)
        yield* Effect.promise(() => seen.promise)
        const stored = MessageV2.get({ sessionID: chat.id, messageID: msg.id })
        const state = yield* sts.get(chat.id)
        off()

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        }
        expect(handle.message.error?.name).toBe("MessageAbortedError")
        expect(stored.info.role).toBe("assistant")
        if (stored.info.role === "assistant") {
          expect(stored.info.error?.name).toBe("MessageAbortedError")
        }
        // 此测试直接运行 processor，绕过了负责发布 idle 的 SessionRunState；
        // processor 只能记录当前步骤的中断，不能提前结束仍由 runner 管理的整轮状态。
        expect(state).toMatchObject({ type: "busy" })
        expect(errs).toContain("MessageAbortedError")
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor create does not clear a pending user-abort mark", () =>
  provideTmpdirServer(
    ({ dir }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const sts = yield* SessionStatus.Service

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "hi")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)

        // 用户在多步回合中途点了停止：SessionRunState.cancel 已 markUserAbort，
        // 紧接着 runLoop 进入下一步会调用 processor.create。create 绝不能清掉这个标记，
        // 否则随后投递的中断会被 onInterrupt 误判为被动而吞掉「已中断」。
        yield* sts.markUserAbort(chat.id)
        yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
          user: parent,
        })

        expect(yield* sts.takeUserAbort(chat.id)).toBe(true)
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests do not mark aborted on passive interruption", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.hang

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "interrupt")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
          user: parent,
        })

        const run = yield* handle
          .process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies MessageV2.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "interrupt" }],
            tools: {},
          })
          .pipe(Effect.forkChild)

        yield* llm.wait(1)
        // 被动中断：直接打断处理 fiber，不经过 SessionRunState.cancel（即实例 scope 关闭 / 重启场景），
        // 没有用户主动取消标记，因此不应落成 MessageAbortedError，而是静默恢复。
        yield* Fiber.interrupt(run)

        const exit = yield* Fiber.await(run)
        const stored = MessageV2.get({ sessionID: chat.id, messageID: msg.id })

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        }
        expect(handle.message.error).toBeUndefined()
        expect(stored.info.role).toBe("assistant")
        if (stored.info.role === "assistant") {
          expect(stored.info.error).toBeUndefined()
        }
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests do not retry a stall after content has streamed", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        // 先吐出可见文本，再永久挂起 → 字节级看门狗在 100ms 后触发 STREAM_STALL
        yield* llm.push(reply().text("partial").hang())

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "stall after content")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
          user: parent,
        })

        yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "stall after content" }],
          tools: {},
        })

        // 已产出内容后停滞：不重试(避免重复已显示的 part)，直接标红错误
        expect(yield* llm.calls).toBe(1)
        expect(handle.message.error?.name).toBe("APIError")
        expect((handle.message.error as MessageV2.APIError | undefined)?.data.metadata?.code).toBe("STREAM_STALL")
      }),
    { git: true, config: (url) => stallCfg(url) },
  ),
)

it.live("session.processor effect tests retry a stall before any content", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        // 首 token 前就挂起 → STREAM_STALL；未产出可见内容应自动重试，第二次成功
        yield* llm.push(reply().hang())
        yield* llm.text("recovered")

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "stall before content")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
          user: parent,
        })

        yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "stall before content" }],
          tools: {},
        })

        const parts = MessageV2.parts(msg.id)
        expect(yield* llm.calls).toBe(2)
        expect(parts.some((part) => part.type === "text" && part.text === "recovered")).toBe(true)
        expect(handle.message.error).toBeUndefined()
      }),
    { git: true, config: (url) => stallCfg(url) },
  ),
)

it.live(
  "session.processor effect tests keep streaming content after a retried image generation attempt",
  () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          const { processors, session, provider } = yield* boot()

          // 第一次尝试已开始生图，随后流内报可重试错误（非 STREAM_STALL / STREAM_FAILED）触发重试；
          // 第二次尝试是一次普通回答，其正文与推理不应被上一轮的生图状态吞掉。
          yield* llm.push(
            raw({
              head: [
                { id: "chatcmpl-test", object: "chat.completion.chunk", choices: [{ delta: { role: "assistant" } }] },
                {
                  id: "chatcmpl-test",
                  object: "chat.completion.chunk",
                  choices: [
                    {
                      delta: {
                        tool_calls: [
                          {
                            index: 0,
                            id: "call_img",
                            type: "function",
                            function: { name: "image_generation", arguments: "" },
                          },
                        ],
                      },
                    },
                  ],
                },
                { error: { message: "rate limit exceeded", type: "rate_limit_error" } },
              ],
            }),
            reply().reason("thinking").text("recovered").stop(),
          )

          const chat = yield* session.create({})
          const parent = yield* user(chat.id, "draw then talk")
          const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
          const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
          const handle = yield* processors.create({
            assistantMessage: msg,
            sessionID: chat.id,
            model: mdl,
            user: parent,
          })

          const value = yield* handle
            .process({
              user: {
                id: parent.id,
                sessionID: chat.id,
                role: "user",
                time: parent.time,
                agent: parent.agent,
                model: { providerID: ref.providerID, modelID: ref.modelID },
              } satisfies MessageV2.User,
              sessionID: chat.id,
              model: mdl,
              agent: agent(),
              system: [],
              messages: [{ role: "user", content: "draw then talk" }],
              tools: {},
            })
            .pipe(Effect.timeout("15 seconds"))

          const parts = MessageV2.parts(msg.id)

          expect(value).toBe("continue")
          expect(yield* llm.calls).toBe(2)
          expect(parts.some((part) => part.type === "text" && part.text === "recovered")).toBe(true)
          expect(parts.some((part) => part.type === "reasoning" && part.text === "thinking")).toBe(true)
          // 第一次 attempt 写入的生图 part 不回滚：由 cleanup 统一落成「已中止」，不会静默消失。
          expect(
            parts.some(
              (part) => part.type === "tool" && part.tool === "image_generation" && part.state.status === "error",
            ),
          ).toBe(true)
          expect(handle.message.error).toBeUndefined()
        }),
      { git: true, config: (url) => providerCfg(url) },
    ),
  30_000,
)
