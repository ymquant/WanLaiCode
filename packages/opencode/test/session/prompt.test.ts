import { NodeFileSystem } from "@effect/platform-node"
import { FetchHttpClient } from "effect/unstable/http"
import { expect } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Option } from "effect"
import path from "path"
import { fileURLToPath } from "url"
import { NamedError } from "@opencode-ai/core/util/error"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { Bus } from "../../src/bus"
import { Command } from "../../src/command"
import { Config } from "@/config/config"
import { LSP } from "@/lsp/lsp"
import { MCP } from "../../src/mcp"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider as ProviderSvc } from "@/provider/provider"
import { WanlaiCodeImageGeneration, type ImageGenerateInput } from "@/provider/wanlaicode-image-generation"
import { ImageGenerationPlanAccessError } from "@/provider/wanlaicode-image-generation-plan"
import { MemoryStore } from "@/memory"
import { Env } from "../../src/env"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Question } from "../../src/question"
import { Todo } from "../../src/session/todo"
import { disposeInstance, drainInstance } from "@/effect/instance-registry"
import { Session } from "@/session/session"
import { MAX_OUTPUT_TOKENS } from "@/session/suggestion"
import { SessionMessageTable } from "../../src/session/session.sql"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { SessionCompaction } from "../../src/session/compaction"
import { SessionSummary } from "../../src/session/summary"
import { Instruction } from "../../src/session/instruction"
import { SessionProcessor } from "../../src/session/processor"
import { GoalRuntime } from "../../src/session/goal-runtime"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionRevert } from "../../src/session/revert"
import { SessionRunState } from "../../src/session/run-state"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { SessionV2 } from "../../src/v2/session"
import { Skill } from "../../src/skill"
import { SystemPrompt } from "../../src/session/system"
import { Shell } from "../../src/shell/shell"
import { Snapshot } from "../../src/snapshot"
import { ToolRegistry } from "@/tool/registry"
import { ShellBackground } from "@/tool/shell/background"
import { Truncate } from "@/tool/truncate"
import * as Log from "@opencode-ai/core/util/log"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import * as Database from "../../src/storage/db"
import { Ripgrep } from "../../src/file/ripgrep"
import { Format } from "../../src/format"
import { provideTmpdirInstance, provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { reply, TestLLMServer } from "../lib/llm-server"

void Log.init({ print: false })

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

const wanlaiRef = {
  providerID: ProviderID.make("wanlaicode"),
  modelID: ModelID.make("gpt-5.5"),
}

const wanlaiImageRef = {
  providerID: ProviderID.make("wanlaicode"),
  modelID: ModelID.make("gpt-image-2"),
}

const imageGenerationCalls: ImageGenerateInput[] = []

// 使用完整的真实接口字段形状验证会话层只负责透传，不在错误链路里重写套餐名称、价格或购买入口。
const imageGenerationUpgradePlans = [
  { id: "max-5x-monthly", name: "Max-5x", price: 199, validityDays: 30, validityUnit: "month" },
  { id: "max-20x-monthly", name: "Max-20x", price: 499, validityDays: 30, validityUnit: "month" },
]
const imageGenerationPurchaseUrl = "https://purchase.example.com/pay"

function defer<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function withSh<A, E, R>(fx: () => Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const prev = process.env.SHELL
      process.env.SHELL = "/bin/sh"
      Shell.preferred.reset()
      return prev
    }),
    () => fx(),
    (prev) =>
      Effect.sync(() => {
        if (prev === undefined) delete process.env.SHELL
        else process.env.SHELL = prev
        Shell.preferred.reset()
      }),
  )
}

function toolPart(parts: MessageV2.Part[]) {
  return parts.find((part): part is MessageV2.ToolPart => part.type === "tool")
}

type CompletedToolPart = MessageV2.ToolPart & { state: MessageV2.ToolStateCompleted }
type ErrorToolPart = MessageV2.ToolPart & { state: MessageV2.ToolStateError }

function completedTool(parts: MessageV2.Part[]) {
  const part = toolPart(parts)
  expect(part?.state.status).toBe("completed")
  return part?.state.status === "completed" ? (part as CompletedToolPart) : undefined
}

function errorTool(parts: MessageV2.Part[]) {
  const part = toolPart(parts)
  expect(part?.state.status).toBe("error")
  return part?.state.status === "error" ? (part as ErrorToolPart) : undefined
}

function listenForToolPart(sessionID: SessionID, predicate: (part: MessageV2.ToolPart) => boolean) {
  return Effect.gen(function* () {
    const ready = yield* Deferred.make<MessageV2.ToolPart>()
    const unsubscribe = Bus.subscribe(MessageV2.Event.PartUpdated, (event) => {
      const part = event.properties.part as MessageV2.Part
      if (event.properties.sessionID !== sessionID || part.type !== "tool" || !predicate(part)) return
      Deferred.doneUnsafe(ready, Effect.succeed(part))
    })
    yield* Effect.addFinalizer(() => Effect.sync(unsubscribe))
    return ready
  })
}

function assistantErrorMessage(error: MessageV2.Assistant["error"] | undefined) {
  const data = error?.data
  return data && "message" in data && typeof data.message === "string" ? data.message : undefined
}

const mcp = Layer.succeed(
  MCP.Service,
  MCP.Service.of({
    status: () => Effect.succeed({}),
    clients: () => Effect.succeed({}),
    tools: () => Effect.succeed({}),
    prompts: () => Effect.succeed({}),
    resources: () => Effect.succeed({}),
    add: () => Effect.succeed({ status: { status: "disabled" as const } }),
    connect: () => Effect.void,
    disconnect: () => Effect.void,
    reconcile: () => Effect.void,
    getPrompt: () => Effect.succeed(undefined),
    readResource: () => Effect.succeed(undefined),
    startAuth: () => Effect.die("unexpected MCP auth in prompt-effect tests"),
    authenticate: () => Effect.die("unexpected MCP auth in prompt-effect tests"),
    finishAuth: () => Effect.die("unexpected MCP auth in prompt-effect tests"),
    removeAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.succeed("not_authenticated" as const),
  }),
)

const lsp = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(false),
    touchFile: () => Effect.void,
    diagnostics: () => Effect.succeed({}),
    hover: () => Effect.succeed(undefined),
    definition: () => Effect.succeed([]),
    references: () => Effect.succeed([]),
    implementation: () => Effect.succeed([]),
    documentSymbol: () => Effect.succeed([]),
    workspaceSymbol: () => Effect.succeed([]),
    prepareCallHierarchy: () => Effect.succeed([]),
    incomingCalls: () => Effect.succeed([]),
    outgoingCalls: () => Effect.succeed([]),
  }),
)

const status = SessionStatus.layer.pipe(Layer.provideMerge(Bus.layer))
const run = SessionRunState.layer.pipe(Layer.provide(status))
const infra = Layer.mergeAll(NodeFileSystem.layer, CrossSpawnSpawner.defaultLayer)
let testPermissionMode: "ask" | "auto_review" | "full_access" = "full_access"
const testConfig = Layer.effect(
  Config.Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    return Config.Service.of({
      ...config,
      getGlobal: () =>
        config.getGlobal().pipe(Effect.map((value) => ({ ...value, permission_mode: testPermissionMode }))),
    })
  }),
).pipe(Layer.provide(Config.defaultLayer))
function makeHttp() {
  const imageGenerationLayer = Layer.succeed(
    WanlaiCodeImageGeneration.Service,
    WanlaiCodeImageGeneration.Service.of({
      generate: (payload) => {
        // 套餐门控必须发生在真正图片调用之前；测试计数器只记录已经越过门控的生图请求。
        if (payload.prompt === "生成未开通分组图片") {
          return Effect.fail(
            new ImageGenerationPlanAccessError({
              upgradePlans: imageGenerationUpgradePlans,
              purchaseUrl: imageGenerationPurchaseUrl,
              purchaseEnabled: true,
            }),
          )
        }
        if (payload.prompt === "测试失败前缀") return Effect.fail(new Error("upstream failed"))
        return Effect.sync(() => {
          imageGenerationCalls.push(payload)
          return {
            images: Array.from({ length: Math.min(8, Math.max(1, Math.floor(payload.count ?? 1))) }).map(
              (_, index) => ({
                url: `data:image/png;base64,${Buffer.from(`image-${index + 1}`).toString("base64")}`,
                mime: "image/png",
                filename: `test-image-${index + 1}.png`,
              }),
            ),
          }
        })
      },
      generateIntoSession: () => Effect.die("unexpected generateIntoSession in prompt tests"),
    }),
  )
  const deps = Layer.mergeAll(
    Session.defaultLayer,
    Snapshot.defaultLayer,
    LLM.defaultLayer,
    Env.defaultLayer,
    AgentSvc.defaultLayer,
    Command.defaultLayer,
    Permission.defaultLayer,
    Plugin.defaultLayer,
    testConfig,
    ProviderSvc.defaultLayer,
    lsp,
    mcp,
    AppFileSystem.defaultLayer,
    status,
  ).pipe(Layer.provideMerge(infra))
  const question = Question.layer.pipe(Layer.provideMerge(deps))
  const todo = Todo.layer.pipe(Layer.provideMerge(deps))
  const registry = ToolRegistry.layer.pipe(
    Layer.provide(Skill.defaultLayer),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(CrossSpawnSpawner.defaultLayer),
    Layer.provide(Ripgrep.defaultLayer),
    Layer.provide(Format.defaultLayer),
    Layer.provide(imageGenerationLayer),
    Layer.provide(ShellBackground.defaultLayer),
    Layer.provideMerge(todo),
    Layer.provideMerge(question),
    Layer.provideMerge(deps),
  )
  const trunc = Truncate.layer.pipe(Layer.provideMerge(deps))
  const proc = SessionProcessor.layer.pipe(Layer.provide(summary), Layer.provideMerge(deps))
  const compact = SessionCompaction.layer.pipe(Layer.provideMerge(proc), Layer.provideMerge(deps))
  return Layer.mergeAll(
    TestLLMServer.layer,
    SessionPrompt.layer.pipe(
      Layer.provide(SessionRevert.defaultLayer),
      Layer.provide(summary),
      Layer.provideMerge(run),
      Layer.provideMerge(compact),
      Layer.provideMerge(proc),
      Layer.provideMerge(registry),
      Layer.provideMerge(trunc),
      Layer.provide(Instruction.defaultLayer),
      Layer.provide(SystemPrompt.defaultLayer),
      Layer.provide(MemoryStore.defaultLayer),
      Layer.provideMerge(deps),
    ),
  ).pipe(Layer.provide(summary))
}

const it = testEffect(makeHttp())
const unix = process.platform !== "win32" ? it.live : it.live.skip
const byteOutputCommand = (bytes: number[]) =>
  `${JSON.stringify(process.execPath)} -e 'process.stdout.write(Buffer.from([${bytes.join(",")}]))'`

// Config that registers a custom "test" provider with a "test-model" model
// so provider model lookup succeeds inside the loop.
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
    wanlaicode: {
      name: "WanlaiCode",
      id: "wanlaicode",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "gpt-5.5": {
          id: "gpt-5.5",
          name: "GPT 5.5",
          attachment: true,
          reasoning: true,
          temperature: false,
          tool_call: true,
          release_date: "2026-01-01",
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
        "gpt-image-2": {
          id: "gpt-image-2",
          name: "GPT Image 2",
          attachment: true,
          reasoning: false,
          temperature: false,
          tool_call: false,
          release_date: "2026-01-01",
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
          capabilities: {
            input: { text: true, image: true },
            output: { image: true },
          },
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
      wanlaicode: {
        ...cfg.provider.wanlaicode,
        options: {
          ...cfg.provider.wanlaicode.options,
          baseURL: url,
        },
      },
    },
  }
}

const wanlaiUser = Effect.fn("test.wanlaiUser")(function* (
  sessionID: SessionID,
  text: string,
  options?: { language?: string },
) {
  const session = yield* Session.Service
  const msg = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "build",
    model: wanlaiRef,
    language: options?.language,
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

const wanlaiImageUser = Effect.fn("test.wanlaiImageUser")(function* (
  sessionID: SessionID,
  text: string,
  imageGeneration?: MessageV2.User["imageGeneration"],
) {
  const session = yield* Session.Service
  const msg = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "build",
    model: wanlaiImageRef,
    imageGeneration,
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

const wanlaiSkillUser = Effect.fn("test.wanlaiSkillUser")(function* (
  sessionID: SessionID,
  skill: string,
  text: string,
) {
  const session = yield* Session.Service
  const msg = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "build",
    model: wanlaiRef,
    time: { created: Date.now() },
  })
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID,
    type: "text",
    text: `/${skill} ${text}`,
    metadata: {
      skill: {
        name: skill,
        arguments: text,
      },
    },
  })
  return msg
})

const user = Effect.fn("test.user")(function* (sessionID: SessionID, text: string) {
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

const seed = Effect.fn("test.seed")(function* (sessionID: SessionID, opts?: { finish?: string }) {
  const session = yield* Session.Service
  const msg = yield* user(sessionID, "hello")
  const assistant: MessageV2.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: msg.id,
    sessionID,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    time: { created: Date.now() },
    ...(opts?.finish ? { finish: opts.finish } : {}),
  }
  yield* session.updateMessage(assistant)
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: assistant.id,
    sessionID,
    type: "text",
    text: "hi there",
  })
  return { user: msg, assistant }
})

const addSubtask = (sessionID: SessionID, messageID: MessageID, model = ref, command?: string) =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    return yield* session.updatePart({
      id: PartID.ascending(),
      messageID,
      sessionID,
      type: "subtask",
      prompt: "look into the cache key path",
      description: "inspect bug",
      agent: "general",
      model,
      command,
    })
  })

const addCompaction = (sessionID: SessionID, messageID: MessageID) =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    yield* session.updatePart({
      id: PartID.ascending(),
      messageID,
      sessionID,
      type: "compaction",
      auto: false,
    })
  })

const completedAssistant = (input: {
  sessionID: SessionID
  parentID: MessageID
  created: number
}): MessageV2.Assistant => ({
  id: MessageID.ascending(),
  role: "assistant",
  parentID: input.parentID,
  sessionID: input.sessionID,
  mode: "build",
  agent: "build",
  cost: 0,
  path: { cwd: "/tmp", root: "/tmp" },
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  modelID: ref.modelID,
  providerID: ref.providerID,
  finish: "stop",
  time: { created: input.created, completed: input.created + 1 },
})

// 模拟升级前未写 responseComplete 的图片回复，覆盖真实旧数据库的恢复兼容，而不是复用新代码生成 marker。
const addLegacyImageAssistant = (input: {
  sessionID: SessionID
  parentID: MessageID
  finish: MessageV2.Assistant["finish"]
  text?: string
}) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const now = Date.now()
    const assistant = {
      ...completedAssistant({ sessionID: input.sessionID, parentID: input.parentID, created: now }),
      finish: input.finish,
    } satisfies MessageV2.Assistant
    yield* sessions.updateMessage(assistant)
    yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: assistant.id,
      sessionID: input.sessionID,
      type: "tool",
      callID: `image_generation-${assistant.id}`,
      tool: "image_generation",
      state: {
        status: "completed",
        input: { prompt: "生成旧版图片" },
        output: "Generated 1 image.",
        title: "Generated 1 image",
        // 这里故意不写 responseComplete，确保测试命中旧版持久化形态。
        metadata: { imageCount: 1 },
        time: { start: now, end: now + 1 },
        attachments: [
          {
            id: PartID.ascending(),
            messageID: assistant.id,
            sessionID: input.sessionID,
            type: "file",
            mime: "image/png",
            filename: "legacy-image.png",
            url: "data:image/png;base64,bGVnYWN5",
          },
        ],
      },
    } satisfies MessageV2.ToolPart)
    if (input.text) {
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: assistant.id,
        sessionID: input.sessionID,
        type: "text",
        text: input.text,
        time: { start: now + 1, end: now + 1 },
      } satisfies MessageV2.TextPart)
    }
    return assistant
  })

const addCompletedTaskAssistant = (input: {
  sessionID: SessionID
  parentID: MessageID
  task: MessageV2.SubtaskPart
  created: number
  completed?: number
  output: string
  internalPartID?: PartID
  legacyInternal?: boolean
}) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const assistant = {
      ...completedAssistant({ sessionID: input.sessionID, parentID: input.parentID, created: input.created }),
      mode: input.internalPartID || input.legacyInternal ? input.task.agent : "build",
      agent: input.internalPartID || input.legacyInternal ? input.task.agent : "build",
      finish: "tool-calls",
      time: { created: input.created, completed: input.completed ?? input.created + 1 },
    } satisfies MessageV2.Assistant
    yield* sessions.updateMessage(assistant)
    yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: assistant.id,
      sessionID: input.sessionID,
      type: "tool",
      callID: `task-${assistant.id}`,
      tool: "task",
      state: {
        status: "completed",
        input: {
          prompt: input.task.prompt,
          description: input.task.description,
          subagent_type: input.task.agent,
          command: input.task.command,
        },
        output: input.output,
        title: input.task.description,
        // internalPartID 仅用于模拟 handleSubtask 的精确来源标记；省略时代表父模型自行调用 task。
        metadata: input.internalPartID ? { internalSubtaskPartID: input.internalPartID } : {},
        time: { start: input.created, end: input.completed ?? input.created + 1 },
      },
    } satisfies MessageV2.ToolPart)
    return assistant
  })

const boot = Effect.fn("test.boot")(function* (input?: { title?: string }) {
  const config = yield* Config.Service
  const prompt = yield* SessionPrompt.Service
  const run = yield* SessionRunState.Service
  const sessions = yield* Session.Service
  yield* config.get()
  const chat = yield* sessions.create(input ?? { title: "Pinned" })
  return { prompt, run, sessions, chat }
})

// Loop semantics

it.live("loop exits immediately when last assistant has stop finish", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* seed(chat.id, { finish: "stop" })

      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")
      if (result.info.role === "assistant") expect(result.info.finish).toBe("stop")
      expect(yield* llm.calls).toBe(0)
    }),
    { config: providerCfg },
  ),
)

it.live("fork 会重写 instructionThrough 并保持已回答消息为终态", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const { prompt, sessions, chat } = yield* boot({ title: "Fork instruction high-water" })
      const owner = yield* user(chat.id, "fork 前已经回答的普通消息")
      const sourceAssistant = {
        ...completedAssistant({ sessionID: chat.id, parentID: owner.id, created: Date.now() + 10 }),
        instructionThrough: owner.id,
      } satisfies MessageV2.Assistant
      yield* sessions.updateMessage(sourceAssistant)
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: sourceAssistant.id,
        sessionID: chat.id,
        type: "text",
        text: "源会话已经完成回复",
      })

      const forked = yield* sessions.fork({ sessionID: chat.id })
      const forkedMessages = yield* sessions.messages({ sessionID: forked.id })
      const forkedUser = forkedMessages.find((message) => message.info.role === "user")
      const forkedAssistant = forkedMessages.find((message) => message.info.role === "assistant")
      yield* llm.text("不应该在 fork 后重复回复")

      const resumed = yield* prompt.loop({ sessionID: forked.id })

      // 新 assistant 的高水位必须指向新 user；若仍是源 ID，首次 loop 会把整条消息重新回答一次。
      expect(forkedUser?.info.role).toBe("user")
      expect(forkedAssistant?.info.role).toBe("assistant")
      if (forkedUser?.info.role === "user" && forkedAssistant?.info.role === "assistant") {
        expect(forkedAssistant.info.instructionThrough).toBe(forkedUser.info.id)
        expect(forkedAssistant.info.instructionThrough).not.toBe(owner.id)
        expect(resumed.info.id).toBe(forkedAssistant.info.id)
      }
      expect(yield* llm.calls).toBe(0)
      expect(yield* llm.pending).toBe(1)
    }),
    { config: providerCfg },
  ),
)

it.live("fork 会重写已完成内部 subtask 的来源 PartID", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const { prompt, sessions, chat } = yield* boot({ title: "Fork completed subtask" })
      const owner = yield* user(chat.id, "fork 前已经完成的内部任务")
      const task = yield* addSubtask(chat.id, owner.id)
      yield* addCompletedTaskAssistant({
        sessionID: chat.id,
        parentID: owner.id,
        task,
        created: Date.now() + 10,
        output: "源会话子任务结果",
        internalPartID: task.id,
      })
      const final = completedAssistant({ sessionID: chat.id, parentID: owner.id, created: Date.now() + 20 })
      yield* sessions.updateMessage(final)
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: final.id,
        sessionID: chat.id,
        type: "text",
        text: "源会话子任务已经完整结束",
      })

      const forked = yield* sessions.fork({ sessionID: chat.id })
      const forkedMessages = yield* sessions.messages({ sessionID: forked.id })
      const forkedTask = forkedMessages.flatMap((message) => message.parts).find((part) => part.type === "subtask")
      const forkedMarker = forkedMessages
        .flatMap((message) => message.parts)
        .find(
          (part) =>
            part.type === "tool" &&
            "metadata" in part.state &&
            typeof part.state.metadata?.internalSubtaskPartID === "string",
        )
      yield* llm.text("不应该重新执行的 fork 子任务")
      yield* llm.text("不应该出现的 fork 父回灌")

      yield* prompt.loop({ sessionID: forked.id })

      // 完成 marker 必须和 fork 后的新 SubtaskPart 一一对应，否则内部任务会被当作 pending 再执行。
      expect(forkedTask?.type).toBe("subtask")
      expect(forkedMarker?.type).toBe("tool")
      if (forkedTask?.type === "subtask" && forkedMarker?.type === "tool" && "metadata" in forkedMarker.state) {
        expect(forkedMarker.state.metadata?.internalSubtaskPartID).toBe(forkedTask.id)
        expect(forkedMarker.state.metadata?.internalSubtaskPartID).not.toBe(task.id)
      }
      expect(yield* llm.calls).toBe(0)
      expect(yield* llm.pending).toBe(2)
    }),
    { config: providerCfg },
  ),
)

it.live("loop 不会重新执行已经完成的旧版远控消息", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Legacy remote message" })
      const created = Date.now() - 2_000
      const legacyUserID = MessageID.make(`msg_remote_${"a".repeat(64)}`)

      // 复刻旧桌面端已经落库的非时间有序消息 ID，验证终态 parentID 才是完成关系的权威依据。
      yield* sessions.updateMessage({
        id: legacyUserID,
        role: "user",
        sessionID: chat.id,
        agent: "build",
        model: ref,
        time: { created },
      })
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: legacyUserID,
        sessionID: chat.id,
        type: "text",
        text: "legacy remote input",
      })
      const completed: MessageV2.Assistant = {
        id: MessageID.ascending(),
        role: "assistant",
        parentID: legacyUserID,
        sessionID: chat.id,
        mode: "build",
        agent: "build",
        cost: 0,
        path: { cwd: "/tmp", root: "/tmp" },
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ref.modelID,
        providerID: ref.providerID,
        finish: "stop",
        time: { created: created + 1_000, completed: created + 1_500 },
      }
      yield* sessions.updateMessage(completed)
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: completed.id,
        sessionID: chat.id,
        type: "text",
        text: "legacy response",
      })

      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.id).toBe(completed.id)
      expect(yield* llm.calls).toBe(0)
    }),
    { config: providerCfg },
  ),
)

it.live("旧版远控高水位不会隐藏之后到达的普通消息", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Legacy remote high-water" })
      const created = Date.now() - 3_000
      const legacyUserID = MessageID.make(`msg_remote_${"b".repeat(64)}`)

      // 旧哈希 ID 的字典序虽然更大，但更晚创建的普通消息仍必须被识别为待回答并在恢复时自动执行。
      yield* sessions.updateMessage({
        id: legacyUserID,
        role: "user",
        sessionID: chat.id,
        agent: "build",
        model: ref,
        time: { created },
      })
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: legacyUserID,
        sessionID: chat.id,
        type: "text",
        text: "legacy remote input",
      })
      const completed: MessageV2.Assistant = {
        id: MessageID.ascending(),
        role: "assistant",
        parentID: legacyUserID,
        sessionID: chat.id,
        mode: "build",
        agent: "build",
        cost: 0,
        path: { cwd: "/tmp", root: "/tmp" },
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ref.modelID,
        providerID: ref.providerID,
        finish: "stop",
        time: { created: created + 1_000, completed: created + 1_500 },
      }
      yield* sessions.updateMessage(completed)
      const pending = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        sessionID: chat.id,
        agent: "build",
        model: ref,
        time: { created: created + 2_000 },
      })
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: pending.id,
        sessionID: chat.id,
        type: "text",
        text: "new input",
      })
      yield* llm.text("new response")

      yield* prompt.cancel(chat.id)
      yield* llm.wait(1)
      // cancel 会在当前 scope 中后台恢复排队任务；等待终态正文落库，避免只看到刚创建的空 assistant。
      let response: MessageV2.WithParts | undefined
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const messages = yield* sessions.messages({ sessionID: chat.id })
        response = messages.find((message) => message.info.role === "assistant" && message.info.parentID === pending.id)
        if (response?.parts.some((part) => part.type === "text" && part.text === "new response")) break
        yield* Effect.sleep(10)
      }
      expect(response?.parts.some((part) => part.type === "text" && part.text === "new response")).toBe(true)
      expect(yield* llm.calls).toBe(1)
    }),
    { config: providerCfg },
  ),
)

it.live("loop calls LLM and returns assistant message", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "hello" }],
      })
      yield* llm.text("world")

      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")
      const parts = result.parts.filter((p) => p.type === "text")
      expect(parts.some((p) => p.type === "text" && p.text === "world")).toBe(true)
      expect(yield* llm.hits).toHaveLength(1)
    }),
    { config: providerCfg },
  ),
)

it.live("历史巨型摘要不会阻断同一会话的新回复", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const status = yield* SessionStatus.Service
      const chat = yield* sessions.create({ title: "Oversized legacy summary" })
      const history = yield* seed(chat.id, { finish: "stop" })
      // 模拟现场旧版本写入 message.data 的超大 patch；读取保护必须兼容它，而不是修改或删除这条历史消息。
      yield* sessions.updateMessage({
        ...history.user,
        summary: {
          diffs: [
            {
              file: "out/generated.js",
              patch: "x".repeat(2 * 1024 * 1024 + 1),
              additions: 1,
              deletions: 0,
              status: "modified",
            },
          ],
        },
      })
      // 分页与单条读取都必须在 SQLite 查询阶段降级；否则消息详情接口仍能重新触发同一 OOM。
      const bounded = MessageV2.get({ sessionID: chat.id, messageID: history.user.id })
      expect(bounded.info.role === "user" && bounded.info.summary?.diffs).toHaveLength(0)
      yield* llm.text("会话已恢复")

      const result = yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        parts: [{ type: "text", text: "继续回复" }],
      })

      expect(result.parts.some((part) => part.type === "text" && part.text === "会话已恢复")).toBe(true)
      expect((yield* status.get(chat.id)).type).toBe("idle")
    }),
    { config: providerCfg },
  ),
)

it.live("prompt emits v2 prompted and synthetic events", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })

      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [
          { type: "text", text: "hello v2" },
          {
            type: "file",
            mime: "text/plain",
            filename: "note.txt",
            url: "data:text/plain;base64,bm90ZSBjb250ZW50",
          },
        ],
      })

      const messages = yield* SessionV2.Service.use((session) => session.messages({ sessionID: chat.id })).pipe(
        Effect.provide(SessionV2.layer),
      )
      const row = Database.use((db) =>
        db.select().from(SessionMessageTable).where(Database.eq(SessionMessageTable.session_id, chat.id)).get(),
      )
      expect(messages.find((message) => message.type === "user")).toMatchObject({ type: "user", text: "hello v2" })
      expect(typeof row?.data.time.created).toBe("number")
      expect(messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "synthetic", text: expect.stringContaining("Called the Read tool") }),
          expect.objectContaining({ type: "synthetic", text: "note content" }),
        ]),
      )
    }),
    { config: providerCfg },
  ),
)

it.live("static loop returns assistant text through local provider", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "Prompt provider",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })

      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "hello" }],
      })

      yield* llm.text("world")

      const result = yield* prompt.loop({ sessionID: session.id })
      expect(result.info.role).toBe("assistant")
      expect(result.parts.some((part) => part.type === "text" && part.text === "world")).toBe(true)
      expect(yield* llm.hits).toHaveLength(1)
      expect(yield* llm.pending).toBe(0)
    }),
    { config: providerCfg },
  ),
)

it.live("static loop consumes queued replies across turns", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "Prompt provider turns",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })

      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "hello one" }],
      })

      yield* llm.text("world one")

      const first = yield* prompt.loop({ sessionID: session.id })
      expect(first.info.role).toBe("assistant")
      expect(first.parts.some((part) => part.type === "text" && part.text === "world one")).toBe(true)

      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "hello two" }],
      })

      yield* llm.text("world two")

      const second = yield* prompt.loop({ sessionID: session.id })
      expect(second.info.role).toBe("assistant")
      expect(second.parts.some((part) => part.type === "text" && part.text === "world two")).toBe(true)

      expect(yield* llm.hits).toHaveLength(2)
      expect(yield* llm.pending).toBe(0)
    }),
    { config: providerCfg },
  ),
)

it.live("loop continues when finish is tool-calls", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "hello" }],
      })
      yield* llm.tool("first", { value: "first" })
      yield* llm.text("second")

      const result = yield* prompt.loop({ sessionID: session.id })
      expect(yield* llm.calls).toBe(2)
      expect(result.info.role).toBe("assistant")
      if (result.info.role === "assistant") {
        expect(result.parts.some((part) => part.type === "text" && part.text === "second")).toBe(true)
        expect(result.info.finish).toBe("stop")
      }
    }),
    { config: providerCfg },
  ),
)

it.live("非图片工具的 responseComplete metadata 不会跳过结果回灌", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const { prompt, sessions, chat } = yield* boot({ title: "Third-party metadata collision" })
      const owner = yield* user(chat.id, "执行第三方工具")
      const assistant = completedAssistant({ sessionID: chat.id, parentID: owner.id, created: Date.now() + 10 })
      yield* sessions.updateMessage(assistant)
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: assistant.id,
        sessionID: chat.id,
        type: "tool",
        callID: "third-party-response-complete",
        tool: "read",
        state: {
          status: "completed",
          input: { filePath: "/tmp/example.txt" },
          output: "third-party tool output",
          title: "Read example",
          // 插件 metadata 是开放字段；同名键不能获得图片工具专属的最终交付语义。
          metadata: { responseComplete: true },
          time: { start: Date.now(), end: Date.now() + 1 },
        },
      } satisfies MessageV2.ToolPart)
      yield* llm.text("第三方工具结果已完成回灌")

      const resumed = yield* prompt.loop({ sessionID: chat.id })

      expect(yield* llm.calls).toBe(1)
      expect(resumed.info.id).not.toBe(assistant.id)
      expect(resumed.parts.some((part) => part.type === "text" && part.text === "第三方工具结果已完成回灌")).toBe(true)
    }),
    { config: providerCfg },
  ),
)

it.live("loop stops after image_generation returns images instead of self-checking and retrying", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      imageGenerationCalls.length = 0
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "Image stop",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* user(session.id, "生成图片")
      yield* llm.push(reply().tool("image_generation", { prompt: "生成图片" }).text("不对，我再试一次。").stop())
      yield* llm.tool("image_generation", { prompt: "第二次生成" })

      const result = yield* prompt.loop({ sessionID: session.id })
      const callsAfterCompletion = yield* llm.calls
      const resumed = yield* prompt.loop({ sessionID: session.id })

      expect(yield* llm.calls).toBe(1)
      expect(imageGenerationCalls).toHaveLength(1)
      expect(result.info.role).toBe("assistant")
      if (result.info.role !== "assistant") return
      expect(result.info.finish).toBe("stop")
      expect(result.parts.some((part) => part.type === "text" && part.text.includes("不对"))).toBe(false)
      const tool = completedTool(result.parts)
      expect(tool?.tool).toBe("image_generation")
      expect(tool?.state.attachments).toHaveLength(1)
      const text = result.parts.findLast((part) => part.type === "text")
      expect(text?.text).toBe("已按你的要求生成图片。")
      // 图片和确定性正文已经完成整轮交付；恢复同一会话不得消费下一条模拟响应或生成额外气泡。
      expect(resumed.info.id).toBe(result.info.id)
      expect(yield* llm.calls).toBe(callsAfterCompletion)
    }),
    { config: providerCfg },
  ),
)

it.live("恢复升级前已最终交付的图片不会再次调用普通模型", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const { prompt, sessions, chat } = yield* boot({ title: "Legacy completed image" })
      const owner = yield* user(chat.id, "生成一张旧版图片")
      const legacy = yield* addLegacyImageAssistant({
        sessionID: chat.id,
        parentID: owner.id,
        finish: "stop",
        text: "已按你的要求生成图片。",
      })
      yield* llm.text("不应该出现的重复回复")

      const resumed = yield* prompt.loop({ sessionID: chat.id })

      // 完整旧记录已包含图片和最终正文，恢复只能返回原 assistant，不能消费模拟模型响应。
      expect(resumed.info.id).toBe(legacy.id)
      expect(yield* llm.calls).toBe(0)
      expect(yield* llm.pending).toBe(1)
      const messages = yield* sessions.messages({ sessionID: chat.id })
      expect(messages.filter((message) => message.info.role === "assistant")).toHaveLength(1)
    }),
    { config: providerCfg },
  ),
)

it.live("旧图片记录仍处于 tool-calls 时恢复会继续完成回复", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const { prompt, chat } = yield* boot({ title: "Legacy image tool continuation" })
      const owner = yield* user(chat.id, "继续旧版图片工具回合")
      const legacy = yield* addLegacyImageAssistant({
        sessionID: chat.id,
        parentID: owner.id,
        finish: "tool-calls",
        text: "图片工具仍需回灌。",
      })
      yield* llm.text("图片工具回灌完成")

      const resumed = yield* prompt.loop({ sessionID: chat.id })

      // tool-calls 不是最终交付，即使已有图片和文字也不能套用旧版完成兼容。
      expect(yield* llm.calls).toBe(1)
      expect(resumed.info.id).not.toBe(legacy.id)
      expect(resumed.parts.some((part) => part.type === "text" && part.text === "图片工具回灌完成")).toBe(true)
    }),
    { config: providerCfg },
  ),
)

it.live("旧图片记录缺少最终正文时恢复会继续完成回复", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const { prompt, chat } = yield* boot({ title: "Legacy image missing text" })
      const owner = yield* user(chat.id, "恢复正文尚未落库的旧版图片")
      const legacy = yield* addLegacyImageAssistant({
        sessionID: chat.id,
        parentID: owner.id,
        finish: "stop",
      })
      yield* llm.text("补齐旧图片最终正文")

      const resumed = yield* prompt.loop({ sessionID: chat.id })

      // 图片附件单独存在可能是崩溃半成品；没有最终正文时必须继续模型回灌。
      expect(yield* llm.calls).toBe(1)
      expect(resumed.info.id).not.toBe(legacy.id)
      expect(resumed.parts.some((part) => part.type === "text" && part.text === "补齐旧图片最终正文")).toBe(true)
    }),
    { config: providerCfg },
  ),
)

it.live("wanlaicode model can call image_generation for a count-only request", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      imageGenerationCalls.length = 0
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "Count only image request",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* wanlaiUser(session.id, "再帮我生成2张鱼会飞")
      yield* llm.tool("image_generation", { prompt: "两张不同构图的飞鱼图片", count: 2 })

      const result = yield* prompt.loop({ sessionID: session.id })

      expect(yield* llm.calls).toBe(1)
      expect(imageGenerationCalls).toHaveLength(1)
      expect(imageGenerationCalls[0].count).toBe(2)
      expect(imageGenerationCalls[0].prompt).toBe("两张不同构图的飞鱼图片")
      expect(result.info.role).toBe("assistant")
      if (result.info.role !== "assistant") return
      const tool = completedTool(result.parts)
      expect(tool?.tool).toBe("image_generation")
      expect(tool?.state.attachments).toHaveLength(2)
      const text = result.parts.findLast((part) => part.type === "text")
      expect(text?.text).toBe("已按你的要求生成2张独立图片。")
    }),
    { config: providerCfg },
  ),
)

it.live("wanlaicode image request explains when count is clamped to max 8", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      imageGenerationCalls.length = 0
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "Clamped image count",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* wanlaiUser(session.id, "生成10张鱼会飞的图片")
      yield* llm.tool("image_generation", {
        prompt: "八张不同构图的飞鱼图片",
        count: 10,
      })

      const result = yield* prompt.loop({ sessionID: session.id })

      expect(yield* llm.calls).toBe(1)
      expect(imageGenerationCalls).toHaveLength(1)
      expect(imageGenerationCalls[0].count).toBe(8)
      expect(result.info.role).toBe("assistant")
      if (result.info.role !== "assistant") return
      const tool = completedTool(result.parts)
      expect(tool?.tool).toBe("image_generation")
      expect(tool?.state.attachments).toHaveLength(8)
      expect(tool?.state.metadata.imageCount).toBe(8)
      expect(tool?.state.metadata.requestedImageCount).toBe(10)
      expect(tool?.state.metadata.maxImageCount).toBe(8)
      const text = result.parts.findLast((part) => part.type === "text")
      expect(text?.text).toBe("当前最多一次生成8张图片，所以已先生成8张独立图片。")
    }),
    { config: providerCfg },
  ),
)

it.live("wanlaicode generated game request stays in normal chat instead of image_generation", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      imageGenerationCalls.length = 0
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "Sokoban game request",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* wanlaiUser(session.id, "帮我生成一个推箱子游戏")
      yield* llm.text("我会实现一个推箱子游戏。")

      const result = yield* prompt.loop({ sessionID: session.id })

      expect(yield* llm.calls).toBe(1)
      expect(imageGenerationCalls).toHaveLength(0)
      expect(result.info.role).toBe("assistant")
      if (result.info.role !== "assistant") return
      expect(result.parts.some((part) => part.type === "tool" && part.tool === "image_generation")).toBe(false)
      expect(result.parts.some((part) => part.type === "text" && part.text.includes("推箱子游戏"))).toBe(true)
    }),
    { config: providerCfg },
  ),
)

it.live("wanlaicode image generation question stays in normal chat instead of image_generation", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      imageGenerationCalls.length = 0
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "Image generation question",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* wanlaiUser(session.id, "你觉得图片该怎么生成")
      yield* llm.text("可以先确定图片的用途、主题、构图和风格，再整理成生成提示词。")

      const result = yield* prompt.loop({ sessionID: session.id })

      expect(yield* llm.calls).toBe(1)
      expect(imageGenerationCalls).toHaveLength(0)
      expect(result.info.role).toBe("assistant")
      if (result.info.role !== "assistant") return
      expect(result.parts.some((part) => part.type === "tool" && part.tool === "image_generation")).toBe(false)
      expect(result.parts.some((part) => part.type === "text" && part.text.includes("图片的用途"))).toBe(true)
    }),
    { config: providerCfg },
  ),
)

it.live("wanlaicode image download button fix stays in normal chat instead of image_generation", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      imageGenerationCalls.length = 0
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "Image download button fix",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* wanlaiUser(
        session.id,
        "做个按钮下载图片的按钮他做的不对是个跳转按钮，让他修复的时候他一直说不支持生成图片，修复",
      )
      yield* llm.text("我会修复下载按钮，让它下载现有图片而不是跳转页面。")

      const result = yield* prompt.loop({ sessionID: session.id })

      expect(yield* llm.calls).toBe(1)
      expect(imageGenerationCalls).toHaveLength(0)
      expect(result.info.role).toBe("assistant")
      if (result.info.role !== "assistant") return
      expect(result.parts.some((part) => part.type === "tool" && part.tool === "image_generation")).toBe(false)
      expect(result.parts.some((part) => part.type === "text" && part.text.includes("下载按钮"))).toBe(true)
    }),
    { config: providerCfg },
  ),
)

it.live("wanlaicode text follow-up after generated image stays in chat with previous context", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      imageGenerationCalls.length = 0
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "Text follow-up after image",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })

      const first = yield* wanlaiUser(session.id, "生成几道关于鱼会飞的选择题")
      const firstAssistant: MessageV2.Assistant = {
        id: MessageID.ascending(),
        role: "assistant",
        parentID: first.id,
        sessionID: session.id,
        mode: "build",
        agent: "build",
        cost: 0,
        path: { cwd: "/tmp", root: "/tmp" },
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: wanlaiRef.modelID,
        providerID: wanlaiRef.providerID,
        time: { created: Date.now(), completed: Date.now() },
        finish: "stop",
      }
      yield* sessions.updateMessage(firstAssistant)
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: firstAssistant.id,
        sessionID: session.id,
        type: "text",
        text: "下面是几道关于“鱼会飞”主题的选择题：\n1. 哪种鱼最接近会飞的鱼？A. 金鱼 B. 飞鱼 C. 鲤鱼 D. 鲨鱼\n答案：B",
      })

      const imageUser = yield* wanlaiUser(session.id, "以图片的形式给我")
      const imageAssistant: MessageV2.Assistant = {
        id: MessageID.ascending(),
        role: "assistant",
        parentID: imageUser.id,
        sessionID: session.id,
        mode: "build",
        agent: "build",
        cost: 0,
        path: { cwd: "/tmp", root: "/tmp" },
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: wanlaiRef.modelID,
        providerID: wanlaiRef.providerID,
        time: { created: Date.now(), completed: Date.now() },
        finish: "stop",
      }
      yield* sessions.updateMessage(imageAssistant)
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: imageAssistant.id,
        sessionID: session.id,
        type: "tool",
        callID: "image_generation_card",
        tool: "image_generation",
        state: {
          status: "completed",
          input: { prompt: "把鱼会飞主题选择题做成图片", context_text: "使用上一条选择题内容" },
          output: "Generated 1 image.",
          title: "Generated 1 image",
          metadata: { imageCount: 1 },
          time: { start: Date.now(), end: Date.now() },
          attachments: [
            {
              id: PartID.ascending(),
              messageID: imageAssistant.id,
              sessionID: session.id,
              type: "file",
              mime: "image/png",
              filename: "fish-question-card.png",
              url: "data:image/png;base64,Y2FyZA==",
            },
          ],
        },
      })
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: imageAssistant.id,
        sessionID: session.id,
        type: "text",
        text: "已把上下文里的选择题内容生成图片，每张单独成图，包含题干、选项、答案和解析。",
      })

      const latest = yield* wanlaiUser(session.id, "再生成5道关于鱼会飞的选择题")
      yield* llm.text("下面继续生成5道关于鱼会飞的选择题。")

      const result = yield* prompt.loop({ sessionID: session.id })

      expect(yield* llm.calls).toBe(1)
      expect(imageGenerationCalls).toHaveLength(0)
      expect(result.info.role).toBe("assistant")
      if (result.info.role !== "assistant") return
      expect(result.info.parentID).toBe(latest.id)
      expect(result.parts.some((part) => part.type === "tool" && part.tool === "image_generation")).toBe(false)
      const hit = (yield* llm.hits).at(-1)
      const messages = JSON.stringify(hit?.body.messages)
      expect(messages).toContain("以图片的形式给我")
      expect(messages).toContain("哪种鱼最接近会飞的鱼")
      expect(messages).toContain("再生成5道关于鱼会飞的选择题")
    }),
    { config: providerCfg },
  ),
)

it.live("completed tool-call assistant does not swallow the next user turn", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "Completed tool turn",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      const first = yield* user(session.id, "生成一张图")
      const assistant: MessageV2.Assistant = {
        id: MessageID.ascending(),
        role: "assistant",
        parentID: first.id,
        sessionID: session.id,
        mode: "build",
        agent: "build",
        cost: 0,
        path: { cwd: "/tmp", root: "/tmp" },
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ref.modelID,
        providerID: ref.providerID,
        time: { created: Date.now(), completed: Date.now() },
        finish: "tool-calls",
      }
      yield* sessions.updateMessage(assistant)
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: assistant.id,
        sessionID: session.id,
        type: "tool",
        callID: "image_generation_1",
        tool: "image_generation",
        state: {
          status: "completed",
          input: { prompt: "生成一张图" },
          output: "Generated 1 image.",
          title: "Generated 1 image",
          metadata: {},
          time: { start: Date.now(), end: Date.now() },
        },
      })
      const second = yield* user(session.id, "生成三张不一样的给我")
      yield* llm.text("收到，我会生成三张。")

      const result = yield* prompt.loop({ sessionID: session.id })

      expect(yield* llm.calls).toBe(1)
      expect(result.info.role).toBe("assistant")
      if (result.info.role !== "assistant") return
      expect(result.info.parentID).toBe(second.id)
      expect(result.info.id).not.toBe(assistant.id)
      expect(result.parts.some((part) => part.type === "text" && part.text === "收到，我会生成三张。")).toBe(true)
    }),
    { config: providerCfg },
  ),
)

// 被动中断只会写 completed 而没有 finish/error；它不是成功终态，恢复后必须先重试原用户，再处理后续队列。
it.live("completed assistant without finish preserves the interrupted user and later queue", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "Passive interruption recovery" })
      const interrupted = yield* user(session.id, "retry interrupted root")
      const staleAssistantID = MessageID.ascending()
      yield* sessions.updateMessage({
        id: staleAssistantID,
        role: "assistant",
        parentID: interrupted.id,
        sessionID: session.id,
        mode: "build",
        agent: "build",
        cost: 0,
        path: { cwd: "/tmp", root: "/tmp" },
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ref.modelID,
        providerID: ref.providerID,
        completedUserMessageIDs: [],
        time: { created: Date.now(), completed: Date.now() },
      })
      const queued = yield* user(session.id, "process queued after retry")
      yield* llm.text("retried interrupted response")
      yield* llm.text("processed queued response")

      yield* prompt.loop({ sessionID: session.id })

      expect(yield* llm.calls).toBe(2)
      const assistants = (yield* sessions.messages({ sessionID: session.id })).filter(
        (message) => message.info.role === "assistant" && message.info.id !== staleAssistantID,
      )
      expect(assistants).toHaveLength(2)
      expect(assistants[0]?.info.role === "assistant" ? assistants[0].info.parentID : undefined).toBe(interrupted.id)
      expect(assistants[1]?.info.role === "assistant" ? assistants[1].info.parentID : undefined).toBe(queued.id)
    }),
    { config: providerCfg },
  ),
)

it.live("wanlaicode model can call image_generation with prior conversation context", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      imageGenerationCalls.length = 0
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "Direct image",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })

      const first = yield* wanlaiUser(session.id, "生成几道选择题")
      const assistant: MessageV2.Assistant = {
        id: MessageID.ascending(),
        role: "assistant",
        parentID: first.id,
        sessionID: session.id,
        mode: "build",
        agent: "build",
        cost: 0,
        path: { cwd: "/tmp", root: "/tmp" },
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: wanlaiRef.modelID,
        providerID: wanlaiRef.providerID,
        time: { created: Date.now(), completed: Date.now() },
        finish: "stop",
      }
      yield* sessions.updateMessage(assistant)
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: assistant.id,
        sessionID: session.id,
        type: "text",
        text: "1. 下面哪个是质数？A. 4 B. 6 C. 7 D. 9\n答案：C\n2. 水的化学式是什么？A. CO2 B. H2O C. O2 D. N2\n答案：B",
      })
      yield* wanlaiUser(session.id, "生成3张图片")
      yield* llm.tool("image_generation", { prompt: "把前面的选择题做成三张独立图片", count: 3 })

      const result = yield* prompt.loop({ sessionID: session.id })

      expect(yield* llm.calls).toBe(1)
      expect(imageGenerationCalls).toHaveLength(1)
      expect(imageGenerationCalls[0].count).toBe(3)
      expect(imageGenerationCalls[0].prompt).toBe("把前面的选择题做成三张独立图片")
      expect(imageGenerationCalls[0].context_text).toContain("下面哪个是质数")
      expect(imageGenerationCalls[0].context_text).toContain("水的化学式")
      expect(result.info.role).toBe("assistant")
      if (result.info.role !== "assistant") return
      expect(result.info.providerID).toBe(wanlaiRef.providerID)
      expect(result.info.finish).toBe("stop")
      expect(result.info.time.completed).toBeDefined()
      const tool = completedTool(result.parts)
      expect(tool?.tool).toBe("image_generation")
      expect(tool?.state.attachments).toHaveLength(3)
      expect(tool?.state.metadata.imageCount).toBe(3)
      expect(tool?.state.output).toContain("Generated 3 images.")
      const text = result.parts.findLast((part) => part.type === "text")
      expect(text?.text).toBe("已按你的要求生成3张独立图片。")
      expect(text?.text).not.toContain("不对")
      expect(text?.text).not.toContain("如果")
    }),
    { config: providerCfg },
  ),
)

it.live("wanlaicode selected image model uses the direct image_generation tool path", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      imageGenerationCalls.length = 0
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "Selected image model",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* wanlaiImageUser(session.id, "生成一个鱼会飞", {
        count: 2,
        size: "1024x1024",
        output_format: "jpeg",
        loading_text: "正在生成鱼图",
        failure_prefix: "鱼图生成失败：",
      })

      const result = yield* prompt.loop({ sessionID: session.id })

      expect(yield* llm.calls).toBe(0)
      expect(imageGenerationCalls).toHaveLength(1)
      expect(imageGenerationCalls[0]).toMatchObject({
        prompt: "生成一个鱼会飞",
        provider_id: "wanlaicode",
        model: "gpt-image-2",
        count: 2,
        size: "1024x1024",
        output_format: "jpeg",
        loading_text: "正在生成鱼图",
        failure_prefix: "鱼图生成失败：",
      })
      expect(result.info.role).toBe("assistant")
      if (result.info.role !== "assistant") return
      const tool = completedTool(result.parts)
      expect(tool?.tool).toBe("image_generation")
      expect(tool?.state.attachments).toHaveLength(2)
      // 客户端配置只随用户消息持久化，不进入模型可见的工具参数。
      expect(tool?.state.input).not.toHaveProperty("output_format")
      expect(tool?.state.input).not.toHaveProperty("loading_text")
      expect(tool?.state.input).not.toHaveProperty("failure_prefix")
      expect(tool?.state.input).not.toHaveProperty("configured_count")
    }),
    { config: providerCfg },
  ),
)

it.live("wanlaicode image failure keeps the client prefix and the upstream reason", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      imageGenerationCalls.length = 0
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "Image failure prefix",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* wanlaiImageUser(session.id, "测试失败前缀", { count: 1, failure_prefix: "鱼图生成失败：" })

      yield* prompt.loop({ sessionID: session.id })

      expect(yield* llm.calls).toBe(0)
      const messages = yield* sessions.messages({ sessionID: session.id })
      const tool = errorTool(messages.flatMap((message) => message.parts))
      expect(tool?.tool).toBe("image_generation")
      // 失败前缀必须和真实上游原因一起出现，否则用户拿不到任何可诊断信息。
      expect(tool?.state.error).toBe("鱼图生成失败：upstream failed")
    }),
    { config: providerCfg },
  ),
)

it.live("wanlaicode client image count wins over counts mentioned in the text", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* () {
      imageGenerationCalls.length = 0
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "Configured image count",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* wanlaiImageUser(session.id, "参考之前生成10张的方案，这次生成2张鱼图", { count: 2 })

      const result = yield* prompt.loop({ sessionID: session.id })

      expect(imageGenerationCalls).toHaveLength(1)
      expect(imageGenerationCalls[0].count).toBe(2)
      expect(result.info.role).toBe("assistant")
      if (result.info.role !== "assistant") return
      const tool = completedTool(result.parts)
      expect(tool?.state.attachments).toHaveLength(2)
      expect(tool?.state.metadata.requestedImageCount).toBeUndefined()
    }),
    { config: providerCfg },
  ),
)

it.live("wanlaicode model image tool call cannot bypass the visual-intent guard with a count", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      imageGenerationCalls.length = 0
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "Image tool guard",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* wanlaiUser(session.id, "下载按钮点了会跳转页面，修复一下这个按钮")
      yield* llm.tool("image_generation", { prompt: "下载按钮", count: 1, configured_count: 1 })
      yield* llm.text("我会修复下载按钮，让它直接下载文件。")

      const result = yield* prompt.loop({ sessionID: session.id })

      // 模型自填数量不能当成生图意图：套餐校验前就要在工具边界拦下来。
      expect(imageGenerationCalls).toHaveLength(0)
      expect(result.info.role).toBe("assistant")
      if (result.info.role !== "assistant") return
      const messages = yield* sessions.messages({ sessionID: session.id })
      const tool = errorTool(messages.flatMap((message) => message.parts))
      expect(tool?.state.error).toContain("does not explicitly request image or visual output")
      expect(result.parts.some((part) => part.type === "text" && part.text.includes("下载按钮"))).toBe(true)
    }),
    { config: providerCfg },
  ),
)

it.live("wanlaicode avatar request passes the visual-intent guard", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      imageGenerationCalls.length = 0
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "Avatar request",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* wanlaiUser(session.id, "帮我做一个赛博朋克风格的头像")
      yield* llm.tool("image_generation", { prompt: "赛博朋克风格头像，霓虹灯光" })
      yield* llm.text("头像已生成。")
      const running = yield* listenForToolPart(
        session.id,
        (part) =>
          part.tool === "image_generation" &&
          part.state.status === "running" &&
          typeof part.state.metadata?.model === "string",
      )

      const result = yield* prompt.loop({ sessionID: session.id })

      // 工具描述声明支持头像/封面/壁纸，执行期校验必须放行同类请求。
      expect(imageGenerationCalls).toHaveLength(1)
      expect(result.info.role).toBe("assistant")
      if (result.info.role !== "assistant") return
      const tool = completedTool(result.parts)
      expect(tool?.tool).toBe("image_generation")
      // 没有客户端加载文案时，工具卡片加载标题仍要带上真实图片模型名。
      const loading = yield* Deferred.await(running).pipe(Effect.timeout("20 seconds"))
      expect(loading.state.status === "running" && loading.state.title).toContain("GPT Image 2")
    }),
    { config: providerCfg },
  ),
)

it.live("wanlaicode natural-language image generation rejects unsupported plans before image calls", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      imageGenerationCalls.length = 0
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const status = yield* SessionStatus.Service
      const session = yield* sessions.create({
        title: "Natural-language image plan denied",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      const requested = yield* wanlaiUser(session.id, "生成未开通分组图片", { language: "zh-Hans" })
      yield* llm.tool("image_generation", { prompt: "生成未开通分组图片" })
      yield* llm.text("当前套餐不支持生图")

      const result = yield* prompt.loop({ sessionID: session.id })

      expect(yield* llm.calls).toBe(2)
      expect(imageGenerationCalls).toHaveLength(0)
      expect(result.info.role).toBe("assistant")
      if (result.info.role !== "assistant") return
      expect(result.info.finish).toBe("stop")
      expect(result.info.time.completed).toBeDefined()
      // 模型工具调用失败仍须完成当前逻辑回合，禁止把 error tool 当作待回灌步骤反复执行。
      expect(result.info.completedUserMessageIDs).toEqual([requested.id])
      expect(assistantErrorMessage(result.info.error)).toBeUndefined()
      const messages = yield* sessions.messages({ sessionID: session.id })
      const tool = errorTool(messages.flatMap((message) => message.parts))
      expect(tool?.tool).toBe("image_generation")
      // 普通自然语言没有客户端图片配置，套餐提示仍须按会话语言本地化，不能回落成网关英文原文。
      expect(tool?.state.error).toBe("当前套餐不支持生图")
      expect(tool?.state.metadata).toMatchObject({
        imageGenerationPlanDenied: true,
        // 会话持久化必须同时保存支持列表和目录状态，前端才能区分“不可升级”与“加载失败”。
        supportedPlans: imageGenerationUpgradePlans,
        upgradePlans: imageGenerationUpgradePlans,
        purchaseUrl: imageGenerationPurchaseUrl,
        purchaseEnabled: true,
        planCatalogAvailable: true,
      })
      expect(tool?.state.time.end).toBeGreaterThanOrEqual(tool?.state.time.start ?? 0)
      expect((yield* status.get(session.id)).type).toBe("idle")
    }),
    { config: providerCfg },
  ),
)

it.live("wanlaicode selected image model rejects unsupported plans before image calls", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      imageGenerationCalls.length = 0
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const status = yield* SessionStatus.Service
      const session = yield* sessions.create({
        title: "Selected image model plan denied",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* wanlaiImageUser(session.id, "生成未开通分组图片", {
        error_messages: {
          group_disabled: "当前套餐不支持生图",
        },
      })

      const result = yield* prompt.loop({ sessionID: session.id })

      expect(yield* llm.calls).toBe(0)
      expect(imageGenerationCalls).toHaveLength(0)
      expect(result.info.role).toBe("assistant")
      if (result.info.role !== "assistant") return
      expect(result.info.finish).toBe("stop")
      expect(result.info.time.completed).toBeDefined()
      expect(assistantErrorMessage(result.info.error)).toBe("当前套餐不支持生图")
      const tool = errorTool(result.parts)
      expect(tool?.tool).toBe("image_generation")
      expect(tool?.state.error).toBe("当前套餐不支持生图")
      expect(tool?.state.metadata).toMatchObject({
        imageGenerationPlanDenied: true,
        // 选中图片模型的直达路径也必须保留同一份套餐说明 metadata。
        supportedPlans: imageGenerationUpgradePlans,
        upgradePlans: imageGenerationUpgradePlans,
        purchaseUrl: imageGenerationPurchaseUrl,
        purchaseEnabled: true,
        planCatalogAvailable: true,
      })
      expect(tool?.state.time.end).toBeGreaterThanOrEqual(tool?.state.time.start ?? 0)
      expect((yield* status.get(session.id)).type).toBe("idle")
    }),
    { config: providerCfg },
  ),
)

it.live("wanlaicode imagegen skill request uses stored skill arguments as the image prompt", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      imageGenerationCalls.length = 0
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "Imagegen skill arguments",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })

      yield* wanlaiSkillUser(session.id, "imagegen", "马斯克在跳舞")

      const result = yield* prompt.loop({ sessionID: session.id })

      expect(yield* llm.calls).toBe(0)
      expect(imageGenerationCalls).toHaveLength(1)
      expect(imageGenerationCalls[0].prompt).toBe("马斯克在跳舞")
      expect(imageGenerationCalls[0].context_text).toContain("latest_user_request:")
      expect(imageGenerationCalls[0].context_text).toContain("马斯克在跳舞")
      expect(imageGenerationCalls[0].context_text).not.toContain("/imagegen")
      expect(result.info.role).toBe("assistant")
    }),
    { config: providerCfg },
  ),
)

it.live("terse image request uses the immediate previous assistant answer instead of older image context", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      imageGenerationCalls.length = 0
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "Previous answer image",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })

      const oldUser = yield* wanlaiUser(session.id, "把图中发言的人改成宣传大王")
      const oldAssistant: MessageV2.Assistant = {
        id: MessageID.ascending(),
        role: "assistant",
        parentID: oldUser.id,
        sessionID: session.id,
        mode: "build",
        agent: "build",
        cost: 0,
        path: { cwd: "/tmp", root: "/tmp" },
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: wanlaiRef.modelID,
        providerID: wanlaiRef.providerID,
        time: { created: Date.now(), completed: Date.now() },
        finish: "stop",
      }
      yield* sessions.updateMessage(oldAssistant)
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: oldAssistant.id,
        sessionID: session.id,
        type: "tool",
        callID: "image_generation_old",
        tool: "image_generation",
        state: {
          status: "completed",
          input: { prompt: "把图中发言的人改成宣传大王", action: "edit", use_recent_images: true },
          output: "Generated 1 image.\nImage 1 revised prompt: 编辑用户提供的截图，把发言人改成宣传大王。",
          title: "Generated 1 image",
          metadata: { imageCount: 1 },
          time: { start: Date.now(), end: Date.now() },
          attachments: [
            {
              id: PartID.ascending(),
              sessionID: session.id,
              messageID: oldAssistant.id,
              type: "file",
              mime: "image/png",
              filename: "old-generated.png",
              url: "data:image/png;base64,b2xk",
            },
          ],
        },
      })

      const questionUser = yield* wanlaiUser(session.id, "再给我几道选择题")
      const questionAssistant: MessageV2.Assistant = {
        id: MessageID.ascending(),
        role: "assistant",
        parentID: questionUser.id,
        sessionID: session.id,
        mode: "build",
        agent: "build",
        cost: 0,
        path: { cwd: "/tmp", root: "/tmp" },
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: wanlaiRef.modelID,
        providerID: wanlaiRef.providerID,
        time: { created: Date.now(), completed: Date.now() },
        finish: "stop",
      }
      yield* sessions.updateMessage(questionAssistant)
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: questionAssistant.id,
        sessionID: session.id,
        type: "text",
        text: "1. 下列词语中，没有错别字的一项是：A. 再接再厉 B. 一愁莫展 C. 迫不急待 D. 穿流不息\n答案：A\n2. “宣传大王”这个称呼最可能表达的是：A. 很擅长宣传的人 B. 不会说话的人 C. 专门修电脑的人 D. 负责记账的人\n答案：A",
      })

      yield* wanlaiUser(session.id, "生成图片")
      yield* llm.tool("image_generation", {
        prompt: "把上一条回答整理成一张选择题信息卡",
        context_text: "下列词语中没有错别字的选择题，以及宣传大王称呼题；逐字保留题干、选项、答案和解析。",
      })

      const result = yield* prompt.loop({ sessionID: session.id })

      expect(yield* llm.calls).toBe(1)
      expect(imageGenerationCalls).toHaveLength(1)
      expect(imageGenerationCalls[0].prompt).toContain("选择题信息卡")
      expect(imageGenerationCalls[0].context_text).toContain("逐字保留题干")
      expect(imageGenerationCalls[0].context_text).toContain("下列词语中")
      expect(imageGenerationCalls[0].context_text).toContain("宣传大王称呼题")
      expect(imageGenerationCalls[0].context_text).not.toContain("编辑用户提供的截图")
      expect(imageGenerationCalls[0].input_images).toBeUndefined()
      expect(result.info.role).toBe("assistant")
      if (result.info.role !== "assistant") return
      const tool = completedTool(result.parts)
      expect(tool?.tool).toBe("image_generation")
      expect(tool?.state.attachments).toHaveLength(1)
      const text = result.parts.findLast((part) => part.type === "text")
      expect(text?.text).toBe("已按你的要求生成图片。")
    }),
    { config: providerCfg },
  ),
)

it.live("terse image request uses immediate previous assistant answer for generic text cards", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      imageGenerationCalls.length = 0
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "Generic previous answer card",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })

      const oldUser = yield* wanlaiUser(session.id, "生成一条会飞的鱼")
      const oldAssistant: MessageV2.Assistant = {
        id: MessageID.ascending(),
        role: "assistant",
        parentID: oldUser.id,
        sessionID: session.id,
        mode: "build",
        agent: "build",
        cost: 0,
        path: { cwd: "/tmp", root: "/tmp" },
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: wanlaiRef.modelID,
        providerID: wanlaiRef.providerID,
        time: { created: Date.now(), completed: Date.now() },
        finish: "stop",
      }
      yield* sessions.updateMessage(oldAssistant)
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: oldAssistant.id,
        sessionID: session.id,
        type: "tool",
        callID: "image_generation_old_fish",
        tool: "image_generation",
        state: {
          status: "completed",
          input: { prompt: "生成一条会飞的鱼" },
          output: "Generated 1 image.\nImage 1 revised prompt: A blue-purple flying fish in the sky.",
          title: "Generated 1 image",
          metadata: { imageCount: 1 },
          time: { start: Date.now(), end: Date.now() },
          attachments: [
            {
              id: PartID.ascending(),
              sessionID: session.id,
              messageID: oldAssistant.id,
              type: "file",
              mime: "image/png",
              filename: "flying-fish.png",
              url: "data:image/png;base64,ZmlzaA==",
            },
          ],
        },
      })

      const textUser = yield* wanlaiUser(session.id, "总结一下明天交付风险")
      const textAssistant: MessageV2.Assistant = {
        id: MessageID.ascending(),
        role: "assistant",
        parentID: textUser.id,
        sessionID: session.id,
        mode: "build",
        agent: "build",
        cost: 0,
        path: { cwd: "/tmp", root: "/tmp" },
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: wanlaiRef.modelID,
        providerID: wanlaiRef.providerID,
        time: { created: Date.now(), completed: Date.now() },
        finish: "stop",
      }
      yield* sessions.updateMessage(textAssistant)
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: textAssistant.id,
        sessionID: session.id,
        type: "text",
        text: "交付风险清单：\n1. 上下文短追问容易串到旧图片。\n2. 图片工具需要明确内容来源。\n3. 发布前必须跑回归测试。",
      })

      yield* wanlaiUser(session.id, "给我图片")
      yield* llm.tool("image_generation", {
        prompt: "把上一条交付风险清单整理成中文信息卡",
        context_text: "交付风险清单：上下文短追问、图片工具内容来源、发布前回归测试。",
      })

      const result = yield* prompt.loop({ sessionID: session.id })

      expect(yield* llm.calls).toBe(1)
      expect(imageGenerationCalls).toHaveLength(1)
      expect(imageGenerationCalls[0].prompt).toContain("中文信息卡")
      expect(imageGenerationCalls[0].context_text).toContain("交付风险清单")
      expect(imageGenerationCalls[0].context_text).toContain("交付风险清单")
      expect(imageGenerationCalls[0].context_text).toContain("发布前回归测试")
      expect(imageGenerationCalls[0].context_text).not.toContain("A blue-purple flying fish")
      expect(imageGenerationCalls[0].input_images).toBeUndefined()
      expect(result.info.role).toBe("assistant")
    }),
    { config: providerCfg },
  ),
)

it.live("wanlaicode direct image edit preserves prior generated-image state on first follow-up", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      imageGenerationCalls.length = 0
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "Direct image edit",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })

      const first = yield* wanlaiUser(session.id, "把图中发言的人改成宣传大王")
      const assistant: MessageV2.Assistant = {
        id: MessageID.ascending(),
        role: "assistant",
        parentID: first.id,
        sessionID: session.id,
        mode: "build",
        agent: "build",
        cost: 0,
        path: { cwd: "/tmp", root: "/tmp" },
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: wanlaiRef.modelID,
        providerID: wanlaiRef.providerID,
        time: { created: Date.now(), completed: Date.now() },
        finish: "stop",
      }
      yield* sessions.updateMessage(assistant)
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: assistant.id,
        sessionID: session.id,
        type: "tool",
        callID: "image_generation_prior",
        tool: "image_generation",
        state: {
          status: "completed",
          input: { prompt: "把图中发言的人改成宣传大王", action: "edit", use_recent_images: true },
          output: "Generated 1 image.\nImage 1 revised prompt: 保持聊天截图布局，把发言人昵称改为宣传大王。",
          title: "Generated 1 image",
          metadata: {
            imageCount: 1,
            revisedPrompts: ["保持聊天截图布局，把发言人昵称改为宣传大王。"],
          },
          time: { start: Date.now(), end: Date.now() },
          attachments: [
            {
              id: PartID.ascending(),
              sessionID: session.id,
              messageID: assistant.id,
              type: "file",
              mime: "image/png",
              filename: "prior-generated.png",
              url: "data:image/png;base64,cHJpb3I=",
            },
          ],
        },
      })
      yield* wanlaiUser(session.id, "再把头像改成匿名头像")
      yield* llm.tool("image_generation", {
        prompt: "保持上一张聊天截图的布局和宣传大王昵称，只把头像改成匿名头像",
        context_text: "继续编辑上一张已生成图片，保留宣传大王和原有布局。",
        action: "edit",
        use_recent_images: true,
      })

      const result = yield* prompt.loop({ sessionID: session.id })

      expect(yield* llm.calls).toBe(1)
      expect(imageGenerationCalls).toHaveLength(1)
      expect(imageGenerationCalls[0].prompt).toContain("上一张聊天截图")
      expect(imageGenerationCalls[0].prompt).toContain("匿名头像")
      expect(imageGenerationCalls[0].context_text).toContain("Use the latest generated image as the edit source")
      expect(imageGenerationCalls[0].context_text).toContain("Preserve all previously achieved text")
      expect(imageGenerationCalls[0].context_text).toContain("宣传大王")
      expect(imageGenerationCalls[0].input_images).toEqual([
        { data_url: "data:image/png;base64,cHJpb3I=", mime: "image/png", filename: "prior-generated.png" },
      ])
      expect(result.info.role).toBe("assistant")
      if (result.info.role !== "assistant") return
      const tool = completedTool(result.parts)
      expect(tool?.tool).toBe("image_generation")
      const text = result.parts.findLast((part) => part.type === "text")
      expect(text?.text).toBe("已按你的要求完成图片编辑。")
    }),
    { config: providerCfg },
  ),
)

it.live("image follow-up uses the same turn image_generation tool with prior context", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "Image context",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })

      const first = yield* user(session.id, "生成几道选择题")
      const assistant: MessageV2.Assistant = {
        id: MessageID.ascending(),
        role: "assistant",
        parentID: first.id,
        sessionID: session.id,
        mode: "build",
        agent: "build",
        cost: 0,
        path: { cwd: "/tmp", root: "/tmp" },
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ref.modelID,
        providerID: ref.providerID,
        time: { created: Date.now(), completed: Date.now() },
        finish: "stop",
      }
      yield* sessions.updateMessage(assistant)
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: assistant.id,
        sessionID: session.id,
        type: "text",
        text: "1. 下面哪个是质数？A. 4 B. 6 C. 7 D. 9\n答案：C\n2. 水的化学式是什么？A. CO2 B. H2O C. O2 D. N2\n答案：B",
      })
      yield* user(session.id, "生成图片")
      yield* llm.text("ok")

      yield* prompt.loop({ sessionID: session.id })

      const hit = (yield* llm.hits).findLast((item) => JSON.stringify(item.body).includes("生成图片"))
      expect(hit).toBeDefined()
      expect(hit?.body.tool_choice).toBe("auto")
      expect(JSON.stringify(hit?.body.tools)).toContain('"name":"image_generation"')
      const messages = JSON.stringify(hit?.body.messages)
      expect(messages).toContain("下面哪个是质数")
      expect(messages).toContain("水的化学式")
      expect(messages).not.toContain("You must call the image_generation tool in this same turn")
    }),
    { config: providerCfg },
  ),
)

it.live(
  "glob tool keeps instance context during prompt runs",
  () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          const prompt = yield* SessionPrompt.Service
          const sessions = yield* Session.Service
          const session = yield* sessions.create({
            title: "Glob context",
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          })
          const file = path.join(dir, "probe.txt")
          yield* Effect.promise(() => Bun.write(file, "probe"))

          yield* prompt.prompt({
            sessionID: session.id,
            agent: "build",
            noReply: true,
            parts: [{ type: "text", text: "find text files" }],
          })
          yield* llm.tool("glob", { pattern: "**/*.txt" })
          yield* llm.text("done")

          const result = yield* prompt.loop({ sessionID: session.id })
          expect(result.info.role).toBe("assistant")

          const msgs = yield* MessageV2.filterCompactedEffect(session.id)
          const tool = msgs
            .flatMap((msg) => msg.parts)
            .find(
              (part): part is CompletedToolPart =>
                part.type === "tool" && part.tool === "glob" && part.state.status === "completed",
            )
          if (!tool) return

          expect(tool.state.output).toContain(file)
          expect(tool.state.output).not.toContain("No context found for instance")
          expect(result.parts.some((part) => part.type === "text" && part.text === "done")).toBe(true)
        }),
      // Needs a real git project: the glob tool resolves files via project/instance context.
      { git: true, config: providerCfg },
    ),
  // Snapshot tracking over a real git repo is slow under load; give this one headroom.
  60_000,
)

it.live("loop continues when finish is stop but assistant has tool parts", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "hello" }],
      })
      yield* llm.push(reply().tool("first", { value: "first" }).stop())
      yield* llm.text("second")

      const result = yield* prompt.loop({ sessionID: session.id })
      expect(yield* llm.calls).toBe(2)
      expect(result.info.role).toBe("assistant")
      if (result.info.role === "assistant") {
        expect(result.parts.some((part) => part.type === "text" && part.text === "second")).toBe(true)
        expect(result.info.finish).toBe("stop")
      }
    }),
    { config: providerCfg },
  ),
)

it.live("slash-command 子任务完成后再次 loop 不会重复回复", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Subtask resume" })
      const msg = yield* user(chat.id, "review this change")
      yield* addSubtask(chat.id, msg.id, ref, "review")
      yield* llm.text("child review complete")
      yield* llm.text("review summary")

      const completed = yield* prompt.loop({ sessionID: chat.id })
      const callsAfterCompletion = yield* llm.calls
      const resumed = yield* prompt.loop({ sessionID: chat.id })

      // synthetic summary 已被终态回复消费；恢复同一会话只能返回原结果，不能再触发模型。
      expect(resumed.info.id).toBe(completed.info.id)
      expect(yield* llm.calls).toBe(callsAfterCompletion)
    }),
    { config: providerCfg },
  ),
)

it.live("parent 不匹配的终态 assistant 不会吞掉并发插入的 subtask", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pending subtask" })
      const original = yield* user(chat.id, "original turn")
      const pending = yield* user(chat.id, "queued subtask")
      yield* addSubtask(chat.id, pending.id)
      const later = yield* user(chat.id, "later ordinary input")
      yield* sessions.updateMessage(
        completedAssistant({ sessionID: chat.id, parentID: original.id, created: Date.now() + 10 }),
      )
      yield* llm.text("child task complete")
      yield* llm.text("parent task complete")
      yield* llm.text("later user complete")

      const result = yield* prompt.loop({ sessionID: chat.id })

      // 更晚的普通 user 不能遮住前面的 pending subtask；必须先完成任务，再回答后续输入。
      expect(yield* llm.calls).toBe(3)
      const messages = yield* sessions.messages({ sessionID: chat.id })
      const taskResponse = messages.find(
        (message) => message.info.role === "assistant" && message.info.parentID === pending.id,
      )
      expect(taskResponse).toBeDefined()
      expect(result.info.role).toBe("assistant")
      if (result.info.role === "assistant") expect(result.info.parentID).toBe(later.id)
    }),
    { config: providerCfg },
  ),
)

it.live("parent 不匹配的终态 assistant 不会吞掉并发插入的 compaction", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pending compaction" })
      const original = yield* user(chat.id, "original turn")
      const pending = yield* user(chat.id, "queued compaction")
      yield* addCompaction(chat.id, pending.id)
      yield* sessions.updateMessage(
        completedAssistant({ sessionID: chat.id, parentID: original.id, created: Date.now() + 10 }),
      )
      yield* llm.text("compact summary")

      const result = yield* prompt.loop({ sessionID: chat.id })

      // compaction 必须实际调用摘要模型，不能因旧回合 assistant 的创建时间更晚而直接退出。
      expect(yield* llm.calls).toBe(1)
      expect(result.info.role).toBe("assistant")
      if (result.info.role === "assistant") {
        expect(result.info.parentID).toBe(pending.id)
        expect(result.info.summary).toBe(true)
      }
    }),
    { config: providerCfg },
  ),
)

it.live("模型生图工具调用完成后继续处理同一快照中的后续 subtask", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      imageGenerationCalls.length = 0
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Image before queued subtask" })
      const imageUser = yield* wanlaiUser(chat.id, "生成一张鱼会飞的图片")
      const taskOwner = yield* user(chat.id, "run queued task after image")
      yield* addSubtask(chat.id, taskOwner.id)
      yield* llm.tool("image_generation", { prompt: "一张会飞的鱼" })
      yield* llm.text("child task complete")
      yield* llm.text("parent task complete")

      const result = yield* prompt.loop({ sessionID: chat.id })

      // 生图本轮结束后必须回到调度顶端，后续 task 仍需完整执行 child 与父回灌。
      expect(imageGenerationCalls).toHaveLength(1)
      expect(yield* llm.calls).toBe(3)
      expect(yield* llm.pending).toBe(0)
      const messages = yield* sessions.messages({ sessionID: chat.id })
      expect(
        messages.some(
          (message) =>
            message.info.role === "assistant" &&
            message.info.parentID === imageUser.id &&
            message.parts.some((part) => part.type === "tool" && part.tool === "image_generation"),
        ),
      ).toBe(true)
      expect(result.info.role).toBe("assistant")
      if (result.info.role === "assistant") expect(result.info.parentID).toBe(taskOwner.id)
    }),
    { config: providerCfg },
  ),
)

it.live("恢复时内部 task 终态不会越过更早的普通 pending", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Completed task after ordinary pending" })
      yield* seed(chat.id, { finish: "stop" })
      const ordinary = yield* user(chat.id, "older ordinary pending")
      const taskOwner = yield* user(chat.id, "newer completed task")
      const task = yield* addSubtask(chat.id, taskOwner.id)
      yield* addCompletedTaskAssistant({
        sessionID: chat.id,
        parentID: taskOwner.id,
        task,
        created: Date.now() + 10,
        output: "persisted child result",
        internalPartID: task.id,
      })
      yield* llm.text("task parent complete")
      yield* llm.text("ordinary complete")

      yield* prompt.loop({ sessionID: chat.id })

      // 内部工具回灌与普通输入各自独立完成，U2 的内部终态不能把 high-water 提前推进到 U1 之后。
      expect(yield* llm.calls).toBe(2)
      expect(yield* llm.pending).toBe(0)
      const messages = yield* sessions.messages({ sessionID: chat.id })
      expect(
        messages.some(
          (message) =>
            message.info.role === "assistant" &&
            message.info.parentID === taskOwner.id &&
            message.parts.some((part) => part.type === "text" && part.text === "task parent complete"),
        ),
      ).toBe(true)
      expect(
        messages.some(
          (message) =>
            message.info.role === "assistant" &&
            message.info.parentID === ordinary.id &&
            message.parts.some((part) => part.type === "text" && part.text === "ordinary complete"),
        ),
      ).toBe(true)
      const inputs = yield* llm.inputs
      expect(JSON.stringify(inputs[0]?.messages)).not.toContain("older ordinary pending")
    }),
    { config: providerCfg },
  ),
)

it.live("slash-command summary 回灌不会吞掉中途插入的普通消息", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Slash summary race" })
      const owner = yield* user(chat.id, "run slash task")
      const task = yield* addSubtask(chat.id, owner.id, ref, "review")
      // 使用已过去的固定相对时间复刻竞态，避免新生成 assistant 被未来时间戳压在历史顺序之前。
      const base = Date.now() - 2_000
      yield* addCompletedTaskAssistant({
        sessionID: chat.id,
        parentID: owner.id,
        task,
        created: base,
        // 普通消息位于 tool completed 与 synthetic summary 之间，summary 仍必须优先完成回灌。
        completed: base + 400,
        output: "persisted slash child",
        internalPartID: task.id,
      })
      const ordinary = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        sessionID: chat.id,
        agent: "build",
        model: ref,
        time: { created: base + 500 },
      })
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: ordinary.id,
        sessionID: chat.id,
        type: "text",
        text: "phone message during slash task",
      })
      const summaryUser = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        sessionID: chat.id,
        agent: "build",
        model: ref,
        time: { created: base + 1_100 },
      })
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: summaryUser.id,
        sessionID: chat.id,
        type: "text",
        text: "Summarize the task tool output above and continue with your task.",
        synthetic: true,
        metadata: { subtask_summary: true },
      })
      yield* llm.text("slash summary complete")
      yield* llm.text("phone message complete")

      yield* prompt.loop({ sessionID: chat.id })

      // synthetic summary 只回灌 task 结果；夹在两者之间的手机消息必须留到下一轮单独回答。
      expect(yield* llm.calls).toBe(2)
      expect(yield* llm.pending).toBe(0)
      const messages = yield* sessions.messages({ sessionID: chat.id })
      expect(
        messages.some(
          (message) =>
            message.info.role === "assistant" &&
            message.info.parentID === ordinary.id &&
            message.parts.some((part) => part.type === "text" && part.text === "phone message complete"),
        ),
      ).toBe(true)
      const inputs = yield* llm.inputs
      expect(JSON.stringify(inputs[0]?.messages)).not.toContain("phone message during slash task")
    }),
    { config: providerCfg },
  ),
)

it.live("父回合自行调用 task 不会误消费同一 user 的后续 subtask", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Parent task tool and internal subtasks" })
      const owner = yield* user(chat.id, "run both internal tasks")
      const first = yield* addSubtask(chat.id, owner.id)
      const second = yield* addSubtask(chat.id, owner.id)
      const base = Date.now() + 10
      yield* addCompletedTaskAssistant({
        sessionID: chat.id,
        parentID: owner.id,
        task: first,
        created: base,
        output: "first internal child",
        internalPartID: first.id,
      })
      yield* addCompletedTaskAssistant({
        sessionID: chat.id,
        parentID: owner.id,
        task: first,
        created: base + 10,
        output: "parent dynamic child",
      })
      yield* llm.text("dynamic task parent complete")
      yield* llm.text("second internal child")
      yield* llm.text("second internal parent complete")

      yield* prompt.loop({ sessionID: chat.id })

      // 有精确内部标记后，无标记的父模型 task 不能参与 SubtaskPart 完成计数；第二个内部任务仍执行两次调用。
      expect(yield* llm.calls).toBe(3)
      expect(yield* llm.pending).toBe(0)
      const messages = yield* sessions.messages({ sessionID: chat.id })
      const internalIDs = messages
        .flatMap((message) => message.parts)
        .flatMap((part) =>
          part.type === "tool" &&
          "metadata" in part.state &&
          typeof part.state.metadata?.internalSubtaskPartID === "string"
            ? [part.state.metadata.internalSubtaskPartID]
            : [],
        )
      expect(internalIDs).toEqual(expect.arrayContaining([first.id, second.id]))
    }),
    { config: providerCfg },
  ),
)

it.live("同一 user 的旧版与新版 subtask 完成记录可以混合恢复", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Mixed legacy and exact subtask history" })
      const owner = yield* user(chat.id, "resume mixed subtask history")
      const first = yield* addSubtask(chat.id, owner.id)
      const second = yield* addSubtask(chat.id, owner.id)
      const base = Date.now() - 100
      yield* addCompletedTaskAssistant({
        sessionID: chat.id,
        parentID: owner.id,
        task: first,
        created: base,
        output: "legacy internal child",
        legacyInternal: true,
      })
      yield* addCompletedTaskAssistant({
        sessionID: chat.id,
        parentID: owner.id,
        task: second,
        created: base + 10,
        output: "exact internal child",
        internalPartID: second.id,
      })
      const final = completedAssistant({ sessionID: chat.id, parentID: owner.id, created: base + 20 })
      yield* sessions.updateMessage(final)
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: final.id,
        sessionID: chat.id,
        type: "text",
        text: "both tasks already complete",
      })
      yield* llm.text("unexpected duplicate child")
      yield* llm.text("unexpected duplicate parent")

      const result = yield* prompt.loop({ sessionID: chat.id })

      // 新版精确标记出现后，旧版 standalone 内部 task 仍应按签名认领，不能在升级后的下一轮重复执行。
      expect(result.info.id).toBe(final.id)
      expect(yield* llm.calls).toBe(0)
      expect(yield* llm.pending).toBe(2)
    }),
    { config: providerCfg },
  ),
)

it.live("preflight 自动 compaction 优先于触发压缩的普通消息", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Preflight auto compaction" })
      const seeded = yield* seed(chat.id, { finish: "stop" })
      // 用上一轮同模型的高 token 用量稳定触发 preflight 压缩，避免依赖超大测试字符串和估算误差。
      seeded.assistant.tokens.input = 95_000
      yield* sessions.updateMessage(seeded.assistant)
      yield* user(chat.id, "answer after compaction")
      yield* llm.text("compact summary")
      yield* llm.text("final response")

      const result = yield* prompt.loop({ sessionID: chat.id })

      // 自动 compaction 只执行一次并回放原请求；若普通消息抢先，会不断创建 compaction 且无法消费模型队列。
      expect(yield* llm.calls).toBe(2)
      expect(yield* llm.pending).toBe(0)
      const messages = yield* sessions.messages({ sessionID: chat.id })
      expect(
        messages.filter(
          (message) =>
            message.info.role === "user" &&
            message.parts.some((part) => part.type === "compaction" && part.auto && part.overflow === true),
        ),
      ).toHaveLength(1)
      expect(
        messages.some(
          (message) =>
            message.info.role === "assistant" &&
            message.info.summary === true &&
            message.parts.some((part) => part.type === "text" && part.text === "compact summary"),
        ),
      ).toBe(true)
      expect(result.parts.some((part) => part.type === "text" && part.text === "final response")).toBe(true)
    }),
    { config: providerCfg },
  ),
)

it.live("已完成的后续普通消息不会遮住更早的 pending subtask", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Older pending subtask" })
      const pending = yield* user(chat.id, "older queued subtask")
      yield* addSubtask(chat.id, pending.id)
      const completedUser = yield* user(chat.id, "already completed later input")
      yield* sessions.updateMessage(
        completedAssistant({ sessionID: chat.id, parentID: completedUser.id, created: Date.now() + 10 }),
      )
      yield* llm.text("child task complete")
      yield* llm.text("parent task complete")

      const result = yield* prompt.loop({ sessionID: chat.id })

      // 恢复时必须执行较早任务，但后面的普通消息已有直属终态回复，不能再消费一次模型响应。
      expect(yield* llm.calls).toBe(2)
      expect(result.info.role).toBe("assistant")
      if (result.info.role === "assistant") expect(result.info.parentID).toBe(pending.id)
    }),
    { config: providerCfg },
  ),
)

it.live("更早的普通 pending 必须先于后续 subtask 处理", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Ordinary input before subtask" })
      yield* seed(chat.id, { finish: "stop" })
      const ordinary = yield* user(chat.id, "older ordinary input")
      const taskOwner = yield* user(chat.id, "newer queued subtask")
      yield* addSubtask(chat.id, taskOwner.id)
      yield* llm.text("ordinary complete")
      yield* llm.text("child task complete")
      yield* llm.text("parent task complete")

      const result = yield* prompt.loop({ sessionID: chat.id })

      // 普通输入先完成后才能推进后续内部任务；精确核对 parent 和正文，防止调用次数相同但顺序颠倒。
      expect(yield* llm.calls).toBe(3)
      expect(yield* llm.pending).toBe(0)
      const messages = yield* sessions.messages({ sessionID: chat.id })
      const ordinaryResponse = messages.find(
        (message) =>
          message.info.role === "assistant" &&
          message.info.parentID === ordinary.id &&
          message.parts.some((part) => part.type === "text" && part.text === "ordinary complete"),
      )
      const taskResponse = messages.find(
        (message) =>
          message.info.role === "assistant" &&
          message.info.parentID === taskOwner.id &&
          message.parts.some((part) => part.type === "text" && part.text === "parent task complete"),
      )
      expect(ordinaryResponse).toBeDefined()
      expect(taskResponse).toBeDefined()
      expect(result.info.role).toBe("assistant")
      if (result.info.role === "assistant") expect(result.info.parentID).toBe(taskOwner.id)
    }),
    { config: providerCfg },
  ),
)

it.live("同一 user 的多个 subtask 均按序执行并各自完成回灌", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Multiple subtasks on one user" })
      const taskOwner = yield* user(chat.id, "run both queued subtasks")
      yield* addSubtask(chat.id, taskOwner.id)
      yield* addSubtask(chat.id, taskOwner.id)
      yield* llm.text("child one")
      yield* llm.text("parent one")
      yield* llm.text("child two")
      yield* llm.text("parent two")

      yield* prompt.loop({ sessionID: chat.id })

      // 每个 subtask 都应留下独立的 task 工具结果，并在执行下一个任务前完成对应父回合回灌。
      expect(yield* llm.calls).toBe(4)
      expect(yield* llm.pending).toBe(0)
      const messages = yield* sessions.messages({ sessionID: chat.id })
      const taskTools = messages
        .filter((message) => message.info.role === "assistant" && message.info.parentID === taskOwner.id)
        .flatMap((message) => message.parts)
        .filter(
          (part): part is CompletedToolPart =>
            part.type === "tool" && part.tool === "task" && part.state.status === "completed",
        )
      expect(taskTools).toHaveLength(2)
      expect(taskTools[0]?.state.output).toContain("child one")
      expect(taskTools[1]?.state.output).toContain("child two")
      const parentTexts = messages
        .filter((message) => message.info.role === "assistant" && message.info.parentID === taskOwner.id)
        .flatMap((message) => message.parts)
        .filter((part): part is MessageV2.TextPart => part.type === "text")
        .map((part) => part.text)
      expect(parentTexts).toContain("parent one")
      expect(parentTexts).toContain("parent two")
    }),
    { config: providerCfg },
  ),
)

it.live("failed subtask preserves metadata on error tool state", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* llm.tool("task", {
        description: "inspect bug",
        prompt: "look into the cache key path",
        subagent_type: "general",
      })
      yield* llm.text("done")
      const msg = yield* user(chat.id, "hello")
      yield* addSubtask(chat.id, msg.id)

      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")
      expect(yield* llm.calls).toBe(2)

      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      const taskMsg = msgs.find((item) => item.info.role === "assistant" && item.info.agent === "general")
      expect(taskMsg?.info.role).toBe("assistant")
      if (!taskMsg || taskMsg.info.role !== "assistant") return

      const tool = errorTool(taskMsg.parts)
      if (!tool) return

      expect(tool.state.error).toContain("Tool execution failed")
      expect(tool.state.metadata).toBeDefined()
      expect(tool.state.metadata?.sessionId).toBeDefined()
      expect(tool.state.metadata?.model).toEqual({
        providerID: ProviderID.make("test"),
        modelID: ModelID.make("missing-model"),
      })
    }),
    {
      config: (url) => ({
        ...providerCfg(url),
        agent: {
          general: {
            model: "test/missing-model",
          },
        },
      }),
    },
  ),
)

it.live(
  "running subtask preserves metadata after tool-call transition",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Pinned" })
        const gate = Promise.withResolvers<void>()
        yield* llm.hold("done", gate.promise)
        const msg = yield* user(chat.id, "hello")
        const taskPart = yield* addSubtask(chat.id, msg.id)

        const running = yield* listenForToolPart(
          chat.id,
          (part) =>
            part.tool === "task" &&
            part.state.status === "running" &&
            typeof part.state.metadata?.sessionId === "string",
        )

        const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)

        const tool = yield* Deferred.await(running).pipe(Effect.timeout("20 seconds"))

        if (tool.state.status !== "running") return
        expect(typeof tool.state.metadata?.sessionId).toBe("string")
        expect(tool.state.title).toBeDefined()
        expect(tool.state.metadata?.model).toBeDefined()
        // TaskTool 的 metadata 回调不能覆盖内部调度来源，否则完成或取消后无法精确关联原 SubtaskPart。
        expect(tool.state.metadata?.internalSubtaskPartID).toBe(taskPart.id)

        gate.resolve()
        yield* Fiber.await(fiber).pipe(Effect.timeout("20 seconds"))
      }),
      { config: providerCfg },
    ),
  45_000,
)

it.live(
  "running task tool preserves metadata after tool-call transition",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({
          title: "Pinned",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        yield* llm.tool("task", {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
        })
        yield* llm.hang
        yield* user(chat.id, "hello")

        const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)

        const tool = yield* Effect.promise(async () => {
          const end = Date.now() + 30_000
          while (Date.now() < end) {
            const msgs = await Effect.runPromise(MessageV2.filterCompactedEffect(chat.id))
            const assistant = msgs.findLast((item) => item.info.role === "assistant" && item.info.agent === "build")
            const tool = assistant?.parts.find(
              (part): part is MessageV2.ToolPart => part.type === "tool" && part.tool === "task",
            )
            if (tool?.state.status === "running" && tool.state.metadata?.sessionId) return tool
            await new Promise((done) => setTimeout(done, 20))
          }
          throw new Error("timed out waiting for running task metadata")
        })

        if (tool.state.status !== "running") return
        expect(typeof tool.state.metadata?.sessionId).toBe("string")
        expect(tool.state.title).toBe("inspect bug")
        expect(tool.state.metadata?.model).toBeDefined()

        yield* prompt.cancel(chat.id)
        yield* Fiber.await(fiber)
      }),
      { config: providerCfg },
    ),
  30_000,
)

it.live(
  "loop sets status to busy then idle",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const status = yield* SessionStatus.Service

        yield* llm.hang

        const chat = yield* sessions.create({})
        yield* user(chat.id, "hi")

        const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* llm.wait(1)
        expect((yield* status.get(chat.id)).type).toBe("busy")
        yield* prompt.cancel(chat.id)
        yield* Fiber.await(fiber)
        expect((yield* status.get(chat.id)).type).toBe("idle")
      }),
      { config: providerCfg },
    ),
  // 同文件其它 loop/cancel 类用例普遍 10s；Windows runner 这条 3s flake 过两次。
  10_000,
)

// Cancel semantics

unix(
  "cancel interrupts loop and resolves with an assistant message",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Pinned" })
        yield* seed(chat.id)

        yield* llm.hang

        yield* user(chat.id, "more")

        const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* llm.wait(1)
        yield* prompt.cancel(chat.id)
        const exit = yield* Fiber.await(fiber)
        expect(Exit.isSuccess(exit)).toBe(true)
        if (Exit.isSuccess(exit)) {
          expect(exit.value.info.role).toBe("assistant")
        }
      }),
      { config: providerCfg },
    ),
  5_000,
)

unix(
  "cancel records MessageAbortedError on interrupted process",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Pinned" })
        yield* llm.hang
        yield* user(chat.id, "hello")

        const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* llm.wait(1)
        yield* prompt.cancel(chat.id)
        const exit = yield* Fiber.await(fiber)
        expect(Exit.isSuccess(exit)).toBe(true)
        if (Exit.isSuccess(exit)) {
          const info = exit.value.info
          expect(info.role).toBe("assistant")
          if (info.role !== "assistant") return
          expect(info.error?.name).toBe("MessageAbortedError")
        }
      }),
      { config: providerCfg },
    ),
  10_000,
)

it.live(
  "instance teardown drains an active run instead of interrupting it",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ dir, llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({})
        yield* llm.hang
        yield* user(chat.id, "hello")

        const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* llm.wait(1)

        // 实例 dispose 前的排空钩子：本目录有活跃回合时，drainInstance 必须阻塞等它跑完，
        // 而不是立刻返回（否则随后的 teardown 会把正在生成的回合砍断）。
        const drain = yield* drainInstance(dir, "test").pipe(Effect.forkChild)
        const early = yield* Fiber.await(drain).pipe(Effect.timeout("200 millis"), Effect.exit)
        expect(Exit.isFailure(early)).toBe(true)

        // 排空期间回合没有被中断：消息未落 MessageAbortedError
        const history = yield* sessions.messages({ sessionID: chat.id })
        const assistant = history.findLast((m) => m.info.role === "assistant")
        if (assistant && assistant.info.role === "assistant") {
          expect(assistant.info.error).toBeUndefined()
        }

        // 收尾：取消让 loop 与 drain 结束
        yield* prompt.cancel(chat.id)
        yield* Fiber.await(drain).pipe(Effect.timeout("2 seconds"))
        yield* Fiber.await(fiber)
      }),
      { config: providerCfg },
    ),
  10_000,
)

unix(
  "passive teardown still finalizes the assistant message",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ dir, llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({})
        yield* llm.hang
        yield* user(chat.id, "hello")

        const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* llm.wait(1)

        // 实例被拆掉（驱逐 / churn / 关闭），非用户主动停止：回合被被动中断。
        // 被动中断可以不落「已中断」错误，但消息必须有终态——否则前端永远显示「正在思考」。
        yield* Effect.promise(() => disposeInstance(dir))
        yield* Fiber.await(fiber).pipe(Effect.timeout("5 seconds"), Effect.ignore)

        const history = yield* sessions.messages({ sessionID: chat.id })
        const assistant = history.findLast((m) => m.info.role === "assistant")
        expect(assistant).toBeDefined()
        if (assistant?.info.role !== "assistant") return
        const info = assistant.info
        const finalized = info.time.completed !== undefined || info.error !== undefined
        expect(finalized).toBe(true)
      }),
      { config: providerCfg },
    ),
  15_000,
)

it.live(
  "cancel finalizes subtask tool state",
  () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const ready = defer<void>()
          const aborted = defer<void>()
          const registry = yield* ToolRegistry.Service
          const { task } = yield* registry.named()
          const original = task.execute
          task.execute = (_args, ctx) =>
            Effect.callback<never>((_resume) => {
              ready.resolve()
              ctx.abort.addEventListener("abort", () => aborted.resolve(), { once: true })
              return Effect.sync(() => aborted.resolve())
            })
          yield* Effect.addFinalizer(() => Effect.sync(() => void (task.execute = original)))

          const { prompt, chat } = yield* boot()
          const msg = yield* user(chat.id, "hello")
          yield* addSubtask(chat.id, msg.id)

          const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
          yield* Effect.promise(() => ready.promise)
          yield* prompt.cancel(chat.id)
          yield* Effect.promise(() => aborted.promise)

          const exit = yield* Fiber.await(fiber)
          expect(Exit.isSuccess(exit)).toBe(true)

          const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
          const taskMsg = msgs.find((item) => item.info.role === "assistant" && item.info.agent === "general")
          expect(taskMsg?.info.role).toBe("assistant")
          if (!taskMsg || taskMsg.info.role !== "assistant") return

          const tool = toolPart(taskMsg.parts)
          expect(tool?.type).toBe("tool")
          if (!tool) return

          expect(tool.state.status).not.toBe("running")
          expect(taskMsg.info.time.completed).toBeDefined()
          expect(taskMsg.info.finish).toBeDefined()
        }),
      { config: cfg },
    ),
  30_000,
)

it.live(
  "cancel propagates from slash command subtask to child session",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const status = yield* SessionStatus.Service
        const chat = yield* sessions.create({ title: "Pinned" })
        yield* llm.hang
        const msg = yield* user(chat.id, "hello")
        const taskPart = yield* addSubtask(chat.id, msg.id)

        const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* llm.wait(1)

        const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
        const taskMsg = msgs.find((item) => item.info.role === "assistant" && item.info.agent === "general")
        const tool = taskMsg ? toolPart(taskMsg.parts) : undefined
        const sessionID = tool?.state.status === "running" ? tool.state.metadata?.sessionId : undefined
        expect(typeof sessionID).toBe("string")
        if (typeof sessionID !== "string") throw new Error("missing child session id")
        const childID = SessionID.make(sessionID)
        expect((yield* status.get(childID)).type).toBe("busy")

        yield* prompt.cancel(chat.id)
        const exit = yield* Fiber.await(fiber)
        expect(Exit.isSuccess(exit)).toBe(true)

        expect((yield* status.get(chat.id)).type).toBe("idle")
        expect((yield* status.get(childID)).type).toBe("idle")
        const finalMessages = yield* MessageV2.filterCompactedEffect(chat.id)
        const finalTask = finalMessages.find((item) => item.info.role === "assistant" && item.info.agent === "general")
        const finalTool = finalTask ? toolPart(finalTask.parts) : undefined
        // 真实 TaskTool 已回写 sessionId/model 后再取消，错误终态仍必须保留精确来源 marker。
        expect(finalTool?.state.status).toBe("error")
        if (finalTool?.state.status === "error") {
          expect(finalTool.state.metadata?.internalSubtaskPartID).toBe(taskPart.id)
        }
      }),
      { config: providerCfg },
    ),
  10_000,
)

it.live(
  "cancel first subtask resumes the next queued subtask for the same user",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const status = yield* SessionStatus.Service
        const chat = yield* sessions.create({ title: "Cancel first of two subtasks" })
        const owner = yield* user(chat.id, "依次执行两个内部任务")
        const first = yield* addSubtask(chat.id, owner.id)
        const second = yield* addSubtask(chat.id, owner.id)
        yield* llm.hang
        yield* llm.text("cancelled first parent complete")
        yield* llm.text("second child complete")
        yield* llm.text("second parent complete")

        const active = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* llm.wait(1)
        yield* prompt.cancel(chat.id)
        yield* Fiber.await(active)
        yield* llm.wait(4)

        // cancel 后的续跑在 scope 中后台执行；等待第二个 task 的父回灌落库后再核对完整顺序。
        let messages: MessageV2.WithParts[] = []
        for (let attempt = 0; attempt < 100; attempt += 1) {
          messages = yield* sessions.messages({ sessionID: chat.id })
          if (
            messages.some((message) =>
              message.parts.some((part) => part.type === "text" && part.text === "second parent complete"),
            )
          )
            break
          yield* Effect.sleep(10)
        }

        const taskTools = messages
          .flatMap((message) => message.parts)
          .filter((part): part is MessageV2.ToolPart => part.type === "tool" && part.tool === "task")
        const firstTool = taskTools.find(
          (part) => "metadata" in part.state && part.state.metadata?.internalSubtaskPartID === first.id,
        )
        const secondTool = taskTools.find(
          (part) => "metadata" in part.state && part.state.metadata?.internalSubtaskPartID === second.id,
        )
        // 第一个只终结为取消，第二个自动完成；不能把相同输入签名的两个任务混为一次。
        expect(firstTool?.state.status).toBe("error")
        expect(secondTool?.state.status).toBe("completed")
        if (secondTool?.state.status === "completed") expect(secondTool.state.output).toContain("<task_result>")
        const parentTexts = messages
          .flatMap((message) => message.parts)
          .filter((part): part is MessageV2.TextPart => part.type === "text")
          .map((part) => part.text)
        expect(parentTexts).toContain("second parent complete")
        expect(yield* llm.calls).toBe(4)
        expect(yield* llm.pending).toBe(0)
        expect((yield* status.get(chat.id)).type).toBe("idle")
      }),
      { config: providerCfg },
    ),
  30_000,
)

it.live(
  "cancel settles an async scheduled turn and never revives its root",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const entered = defer<void>()
        const release = defer<void>()
        const finished = defer<void>()
        const prompt = yield* SessionPrompt.Service
        const run = yield* SessionRunState.Service
        const sessions = yield* Session.Service
        const status = yield* SessionStatus.Service
        const original = run.ensureRunning
        const blocked: typeof original = (sessionID, onInterrupt, work) =>
          Effect.gen(function* () {
            // 精确卡在 replyPrepared 的早期 epoch 检查之后、Runner 真正登记活动任务之前。
            entered.resolve()
            yield* Effect.promise(() => release.promise)
            return yield* original(sessionID, onInterrupt, work)
          }).pipe(Effect.ensuring(Effect.sync(() => finished.resolve())))
        Object.assign(run, { ensureRunning: blocked })
        yield* Effect.addFinalizer(() => Effect.sync(() => Object.assign(run, { ensureRunning: original })))

        const chat = yield* sessions.create({ title: "Cancel before runner registration" })
        const rootID = MessageID.ascending()
        yield* llm.text("must not run")
        yield* prompt.promptAsync({
          sessionID: chat.id,
          messageID: rootID,
          agent: "build",
          model: ref,
          parts: [{ type: "text", text: "scheduled before cancel" }],
        })
        yield* Effect.promise(() => entered.promise)

        // stop 必须把 durable scheduled root 写成持久终态，而不只是废止内存调度身份。
        yield* prompt.cancel(chat.id, { resumeQueued: false, turnID: rootID })
        release.resolve()
        yield* Effect.promise(() => finished.promise)

        expect(yield* llm.calls).toBe(0)
        expect((yield* status.get(chat.id)).type).toBe("idle")
        const stopped = yield* sessions.messages({ sessionID: chat.id })
        const tombstone = stopped.find(
          (message) => message.info.role === "assistant" && message.info.turnID === rootID,
        )
        if (!tombstone || tombstone.info.role !== "assistant") throw new Error("缺少 scheduled turn 停止终态")
        expect(tombstone.info.error?.name).toBe("MessageAbortedError")
        expect(tombstone.info.completedUserMessageIDs).toEqual([rootID])
        // stop 返回并且同步调用方退出后，四类可执行身份必须全部释放，不能污染同进程后续回合。
        expect(SessionPrompt.sessionPromptLifecycleState(chat.id)).toEqual({
          activeTurn: false,
          scheduledTurn: false,
          activeStep: false,
          replyGeneration: false,
        })

        const nextID = MessageID.ascending()
        const next = yield* prompt.prompt({
          sessionID: chat.id,
          messageID: nextID,
          agent: "build",
          model: ref,
          parts: [{ type: "text", text: "run only the new turn" }],
        })
        expect(yield* llm.calls).toBe(1)
        expect(next.info.role).toBe("assistant")
        if (next.info.role === "assistant") {
          expect(next.info.parentID).toBe(nextID)
          expect(next.info.completedUserMessageIDs).toContain(nextID)
          expect(next.info.completedUserMessageIDs).not.toContain(rootID)
        }
        // 新模型输入保留官方中断边界；旧 root 只作为历史出现，永远不再成为待执行回合。
        expect(JSON.stringify((yield* llm.inputs)[0]?.messages)).toContain("<turn_aborted>")
      }),
      { config: providerCfg },
    ),
  5_000,
)

it.live(
  "cancel settles a synchronous prompt before runner registration",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const entered = defer<void>()
        const release = defer<void>()
        const prompt = yield* SessionPrompt.Service
        const run = yield* SessionRunState.Service
        const sessions = yield* Session.Service
        const original = run.ensureRunning
        const blocked: typeof original = (sessionID, onInterrupt, work) =>
          Effect.gen(function* () {
            // 同步 prompt 也精确卡在 durable user 与 active runner 登记之间，验证 pending 身份覆盖相同窗口。
            entered.resolve()
            yield* Effect.promise(() => release.promise)
            return yield* original(sessionID, onInterrupt, work)
          })
        Object.assign(run, { ensureRunning: blocked })
        yield* Effect.addFinalizer(() => Effect.sync(() => Object.assign(run, { ensureRunning: original })))

        const chat = yield* sessions.create({ title: "Cancel synchronous pending turn" })
        const rootID = MessageID.ascending()
        yield* llm.text("must not run")
        const caller = yield* prompt
          .prompt({
            sessionID: chat.id,
            messageID: rootID,
            agent: "build",
            model: ref,
            parts: [{ type: "text", text: "synchronous before cancel" }],
          })
          .pipe(Effect.forkChild)
        yield* Effect.promise(() => entered.promise)
        yield* prompt.cancel(chat.id, { resumeQueued: false, turnID: rootID })
        release.resolve()
        expect(Exit.isSuccess(yield* Fiber.await(caller))).toBe(true)

        expect(yield* llm.calls).toBe(0)
        const messages = yield* sessions.messages({ sessionID: chat.id })
        const tombstone = messages.find(
          (message) => message.info.role === "assistant" && message.info.turnID === rootID,
        )
        if (!tombstone || tombstone.info.role !== "assistant") throw new Error("缺少同步 pending turn 停止终态")
        expect(tombstone.info.error?.name).toBe("MessageAbortedError")
        expect(tombstone.info.completedUserMessageIDs).toEqual([rootID])
        // 同步 pending stop 与异步入口遵守相同清理契约，不能把 waiter 或 generation 留给后续用例。
        expect(SessionPrompt.sessionPromptLifecycleState(chat.id)).toEqual({
          activeTurn: false,
          scheduledTurn: false,
          activeStep: false,
          replyGeneration: false,
        })
      }),
      { config: providerCfg },
    ),
  5_000,
)

it.live(
  "interrupt after durable user waits for reply lifecycle handoff",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* () {
        const persisted = defer<void>()
        const release = defer<void>()
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const original = sessions.touch
        let blockFirst = true
        const blocked: typeof original = (sessionID) =>
          Effect.gen(function* () {
            if (blockFirst) {
              blockFirst = false
              // createUserMessage 已完整落库；卡住后续 touch，稳定复现 durable user 与 generation 登记之间的旧中断窗口。
              persisted.resolve()
              yield* Effect.promise(() => release.promise)
            }
            return yield* original(sessionID)
          })
        Object.assign(sessions, { touch: blocked })
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            release.resolve()
            Object.assign(sessions, { touch: original })
          }),
        )

        const chat = yield* sessions.create({ title: "Interrupt durable prompt handoff" })
        const rootID = MessageID.ascending()
        const caller = yield* prompt
          .prompt({
            sessionID: chat.id,
            messageID: rootID,
            agent: "build",
            model: ref,
            parts: [{ type: "text", text: "durable before caller interrupt" }],
          })
          .pipe(Effect.forkChild)
        yield* Effect.promise(() => persisted.promise)

        // 外部中断先挂起，只有 acquisition 返回并把 waiter 交给 release 后才允许调用方退出。
        const interrupting = yield* Fiber.interrupt(caller).pipe(Effect.forkChild)
        yield* Effect.yieldNow
        release.resolve()
        yield* Fiber.await(interrupting)
        yield* Fiber.await(caller)

        const messages = yield* sessions.messages({ sessionID: chat.id })
        expect(messages.some((message) => message.info.id === rootID && message.info.role === "user")).toBe(true)
        // 请求 scope 退出后，持久消息可以恢复，但本进程不得残留任何无所有者的执行身份。
        expect(SessionPrompt.sessionPromptLifecycleState(chat.id)).toEqual({
          activeTurn: false,
          scheduledTurn: false,
          activeStep: false,
          replyGeneration: false,
        })
      }),
      { config: providerCfg },
    ),
  5_000,
)

it.live(
  "default cancel interrupts a synchronous pending waiter before resuming the queue",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const firstWaiter = defer<void>()
        const resumeWaiter = defer<void>()
        const releaseFirst = defer<void>()
        const releaseResume = defer<void>()
        const workClaimed = defer<void>()
        const releaseClaimedWork = defer<void>()
        const prompt = yield* SessionPrompt.Service
        const run = yield* SessionRunState.Service
        const sessions = yield* Session.Service
        const originalEnsureRunning = run.ensureRunning
        let waiterCount = 0
        const blockedEnsureRunning: typeof originalEnsureRunning = (sessionID, onInterrupt, work) => {
          waiterCount += 1
          if (waiterCount === 1) {
            firstWaiter.resolve()
            return Effect.promise(() => releaseFirst.promise).pipe(
              Effect.andThen(originalEnsureRunning(sessionID, onInterrupt, work)),
            )
          }
          if (waiterCount === 2) {
            resumeWaiter.resolve()
            return Effect.promise(() => releaseResume.promise).pipe(
              Effect.andThen(originalEnsureRunning(sessionID, onInterrupt, work)),
            )
          }
          return originalEnsureRunning(sessionID, onInterrupt, work)
        }
        Object.assign(run, { ensureRunning: blockedEnsureRunning })

        const originalHighWater = sessions.messageHighWater
        let holdFirstWork = true
        const blockedHighWater: typeof originalHighWater = (sessionID) => {
          if (!holdFirstWork) return originalHighWater(sessionID)
          holdFirstWork = false
          workClaimed.resolve()
          // 若旧 A 未被 stop 中断，它会先认领 Runner 并停在水位登记处，随后恢复 waiter 只能错误共享 A 的旧结果。
          return Effect.promise(() => releaseClaimedWork.promise).pipe(Effect.andThen(originalHighWater(sessionID)))
        }
        Object.assign(sessions, { messageHighWater: blockedHighWater })
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            releaseFirst.resolve()
            releaseResume.resolve()
            releaseClaimedWork.resolve()
            Object.assign(run, { ensureRunning: originalEnsureRunning })
            Object.assign(sessions, { messageHighWater: originalHighWater })
          }),
        )

        const chat = yield* sessions.create({ title: "Cancel synchronous waiter before queue resume" })
        const rootID = MessageID.ascending()
        const queuedID = MessageID.ascending()
        yield* llm.text("queued turn completed")
        const root = yield* prompt
          .prompt({
            sessionID: chat.id,
            messageID: rootID,
            agent: "build",
            model: ref,
            parts: [{ type: "text", text: "pending synchronous root" }],
          })
          .pipe(Effect.forkChild)
        yield* Effect.promise(() => firstWaiter.promise)
        // noReply 只持久化普通 B 队列，不创建第二个 waiter，确保恢复工作的所有权完全由 cancel() 决定。
        yield* prompt.promptAsync({
          sessionID: chat.id,
          messageID: queuedID,
          agent: "build",
          model: ref,
          noReply: true,
          parts: [{ type: "text", text: "queued turn must resume" }],
        })

        const stopping = yield* prompt.cancel(chat.id, { turnID: rootID }).pipe(Effect.forkChild)
        yield* Effect.promise(() => resumeWaiter.promise)
        // 先放 A、仍扣住恢复 waiter：旧实现会让 A 先认领 Runner；修复后 A fiber 已被 stop 中断，无法越过此门。
        releaseFirst.resolve()
        yield* Effect.promise(() => Promise.race([workClaimed.promise, Bun.sleep(50)]))
        releaseResume.resolve()
        yield* Effect.sleep(10)
        releaseClaimedWork.resolve()

        expect(Exit.isSuccess(yield* Fiber.await(stopping))).toBe(true)
        expect(Exit.isSuccess(yield* Fiber.await(root))).toBe(true)
        yield* llm.wait(1).pipe(Effect.timeout("3 seconds"))
        expect(yield* llm.calls).toBe(1)
        const messages = yield* sessions.messages({ sessionID: chat.id })
        expect(
          messages.some((message) => message.info.role === "assistant" && message.info.parentID === queuedID),
        ).toBe(true)
      }),
      { config: providerCfg },
    ),
  5_000,
)

it.live(
  "default cancel resumes only the queue after an async scheduled root",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const entered = defer<void>()
        const release = defer<void>()
        const prompt = yield* SessionPrompt.Service
        const run = yield* SessionRunState.Service
        const sessions = yield* Session.Service
        const original = run.ensureRunning
        const blocked: typeof original = (sessionID, onInterrupt, work) =>
          Effect.gen(function* () {
            // root 的旧 waiter 与 cancel 创建的续跑 waiter 一起卡住，稳定覆盖 pending→stop→resume 的交界。
            entered.resolve()
            yield* Effect.promise(() => release.promise)
            return yield* original(sessionID, onInterrupt, work)
          })
        Object.assign(run, { ensureRunning: blocked })
        yield* Effect.addFinalizer(() => Effect.sync(() => Object.assign(run, { ensureRunning: original })))

        const chat = yield* sessions.create({ title: "Resume queue after scheduled stop" })
        const rootID = MessageID.ascending()
        const queuedID = MessageID.ascending()
        yield* llm.text("queued turn completed")
        yield* prompt.promptAsync({
          sessionID: chat.id,
          messageID: rootID,
          agent: "build",
          model: ref,
          parts: [{ type: "text", text: "scheduled root must stay stopped" }],
        })
        yield* Effect.promise(() => entered.promise)
        yield* prompt.promptAsync({
          sessionID: chat.id,
          messageID: queuedID,
          agent: "build",
          model: ref,
          parts: [{ type: "text", text: "queued turn should resume" }],
        })

        yield* prompt.cancel(chat.id, { turnID: rootID })
        release.resolve()
        yield* llm.wait(1).pipe(Effect.timeout("3 seconds"))
        yield* Effect.sleep(50)

        expect(yield* llm.calls).toBe(1)
        const messages = yield* sessions.messages({ sessionID: chat.id })
        const rootAssistants = messages.filter(
          (message): message is MessageV2.WithParts & { info: MessageV2.Assistant } =>
            message.info.role === "assistant" && message.info.turnID === rootID,
        )
        const queuedAssistant = messages.find(
          (message) => message.info.role === "assistant" && message.info.parentID === queuedID,
        )
        // root 只能留下一个中断 tombstone；即使普通队列已有自己的旧 waiter，默认恢复也只能执行队列一次。
        expect(rootAssistants).toHaveLength(1)
        expect(rootAssistants[0]?.info.error?.name).toBe("MessageAbortedError")
        expect(queuedAssistant?.info.role).toBe("assistant")
        if (queuedAssistant?.info.role === "assistant") {
          expect(queuedAssistant.info.completedUserMessageIDs).toContain(queuedID)
          expect(queuedAssistant.info.completedUserMessageIDs).not.toContain(rootID)
        }
        // 默认续跑完成后旧 root、异步 waiter 和恢复 runner 都必须退出生命周期表。
        expect(SessionPrompt.sessionPromptLifecycleState(chat.id)).toEqual({
          activeTurn: false,
          scheduledTurn: false,
          activeStep: false,
          replyGeneration: false,
        })
      }),
      { config: providerCfg },
    ),
  5_000,
)

for (const mode of ["prompt", "promptAsync"] as const) {
  it.live(
    `${mode} queued after cancel samples the new epoch inside the submit lock`,
    () =>
      provideTmpdirServer(
        Effect.fnUntraced(function* ({ llm }) {
          const entered = defer<void>()
          const release = defer<void>()
          const prompt = yield* SessionPrompt.Service
          const sessions = yield* Session.Service
          const chat = yield* sessions.create({ title: `${mode} cancel epoch linearization` })
          const original = sessions.touch
          let blockFirst = true
          const blocked: typeof original = (sessionID) =>
            Effect.gen(function* () {
              if (blockFirst) {
                blockFirst = false
                // 第一条 noReply 占住 promptLock；随后按 cancel→目标 prompt 的顺序排队，复现锁外采样旧 epoch。
                entered.resolve()
                yield* Effect.promise(() => release.promise)
              }
              return yield* original(sessionID)
            })
          Object.assign(sessions, { touch: blocked })
          yield* Effect.addFinalizer(() => Effect.sync(() => Object.assign(sessions, { touch: original })))

          const holder = yield* prompt
            .promptAsync({
              sessionID: chat.id,
              messageID: MessageID.ascending(),
              agent: "build",
              model: ref,
              noReply: true,
              // 纯 synthetic holder 不进入待回答队列，只负责构造确定的提交锁排队顺序。
              parts: [{ type: "text", text: "lock holder", synthetic: true, ignored: true }],
            })
            .pipe(Effect.forkChild)
          yield* Effect.promise(() => entered.promise)
          const stopping = yield* prompt.cancel(chat.id, { resumeQueued: false }).pipe(Effect.forkChild)
          yield* Effect.yieldNow

          const targetID = MessageID.ascending()
          yield* llm.text("new epoch prompt completed")
          const targetEffect = prompt[mode]({
            sessionID: chat.id,
            messageID: targetID,
            agent: "build",
            model: ref,
            parts: [{ type: "text", text: "must run after cancel" }],
          })
          const target = yield* targetEffect.pipe(Effect.forkChild)
          yield* Effect.yieldNow
          release.resolve()

          expect(Exit.isSuccess(yield* Fiber.await(holder))).toBe(true)
          expect(Exit.isSuccess(yield* Fiber.await(stopping))).toBe(true)
          expect(Exit.isSuccess(yield* Fiber.await(target))).toBe(true)
          if (mode === "promptAsync") {
            yield* llm.wait(1).pipe(Effect.timeout("3 seconds"))
            yield* Effect.sleep(50)
          }

          expect(yield* llm.calls).toBe(1)
          const messages = yield* sessions.messages({ sessionID: chat.id })
          expect(
            messages.some((message) => message.info.role === "assistant" && message.info.parentID === targetID),
          ).toBe(true)
        }),
        { config: providerCfg },
      ),
    5_000,
  )
}

it.live(
  "loop queued after cancel samples the new epoch inside the submit lock",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const entered = defer<void>()
        const release = defer<void>()
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Loop cancel epoch linearization" })
        yield* user(chat.id, "loop must run after cancel")
        const original = sessions.touch
        const blocked: typeof original = (sessionID) =>
          Effect.gen(function* () {
            entered.resolve()
            yield* Effect.promise(() => release.promise)
            return yield* original(sessionID)
          })
        Object.assign(sessions, { touch: blocked })
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            release.resolve()
            Object.assign(sessions, { touch: original })
          }),
        )

        const holder = yield* prompt
          .promptAsync({
            sessionID: chat.id,
            messageID: MessageID.ascending(),
            agent: "build",
            model: ref,
            noReply: true,
            parts: [{ type: "text", text: "lock holder", synthetic: true, ignored: true }],
          })
          .pipe(Effect.forkChild)
        yield* Effect.promise(() => entered.promise)
        const stopping = yield* prompt.cancel(chat.id, { resumeQueued: false }).pipe(Effect.forkChild)
        yield* Effect.yieldNow
        yield* llm.text("loop completed on the new epoch")
        const target = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* Effect.yieldNow
        release.resolve()

        expect(Exit.isSuccess(yield* Fiber.await(holder))).toBe(true)
        expect(Exit.isSuccess(yield* Fiber.await(stopping))).toBe(true)
        expect(Exit.isSuccess(yield* Fiber.await(target))).toBe(true)
        expect(yield* llm.calls).toBe(1)
      }),
      { config: providerCfg },
    ),
  5_000,
)

it.live(
  "the actual runner settles an async root when a later synchronous waiter advances generation",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* () {
        const entered = defer<void>()
        const release = defer<void>()
        const joined = defer<void>()
        const errorPublished = defer<void>()
        const prompt = yield* SessionPrompt.Service
        const run = yield* SessionRunState.Service
        const sessions = yield* Session.Service
        const status = yield* SessionStatus.Service
        const bus = yield* Bus.Service
        const originalHighWater = sessions.messageHighWater
        let failFirstRun = true
        const failingHighWater: typeof originalHighWater = (sessionID) => {
          if (!failFirstRun) return originalHighWater(sessionID)
          failFirstRun = false
          entered.resolve()
          // 失败发生在真实 runner work 内；B 只共享该 runner，不能靠自己的 generation 抢走或吞掉 A 的结算责任。
          return Effect.promise(() => release.promise).pipe(
            Effect.andThen(Effect.die(new Error("shared runner failed"))),
          )
        }
        Object.assign(sessions, { messageHighWater: failingHighWater })
        const originalEnsureRunning = run.ensureRunning
        let waiters = 0
        const trackedEnsureRunning: typeof originalEnsureRunning = (sessionID, onInterrupt, work) => {
          waiters += 1
          if (waiters === 2) joined.resolve()
          return originalEnsureRunning(sessionID, onInterrupt, work)
        }
        Object.assign(run, { ensureRunning: trackedEnsureRunning })
        const errors: string[] = []
        const off = yield* bus.subscribeCallback(Session.Event.Error, (event) => {
          if (event.properties.sessionID !== inputSessionID) return
          const error = event.properties.error
          if (!error) return
          errors.push(error.name)
          errorPublished.resolve()
        })
        let inputSessionID: SessionID
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            release.resolve()
            off()
            Object.assign(sessions, { messageHighWater: originalHighWater })
            Object.assign(run, { ensureRunning: originalEnsureRunning })
          }),
        )

        const chat = yield* sessions.create({ title: "Shared runner failure ownership" })
        inputSessionID = chat.id
        const asyncID = MessageID.ascending()
        const syncID = MessageID.ascending()
        yield* prompt.promptAsync({
          sessionID: chat.id,
          messageID: asyncID,
          agent: "build",
          model: ref,
          parts: [{ type: "text", text: "durable async root" }],
        })
        yield* Effect.promise(() => entered.promise)
        const synchronous = yield* prompt
          .prompt({
            sessionID: chat.id,
            messageID: syncID,
            agent: "build",
            model: ref,
            parts: [{ type: "text", text: "later synchronous waiter" }],
          })
          .pipe(Effect.exit, Effect.forkChild)
        yield* Effect.promise(() => joined.promise)
        release.resolve()

        expect(Exit.isSuccess(yield* Fiber.await(synchronous))).toBe(true)
        yield* Effect.promise(() => errorPublished.promise)
        yield* Effect.sleep(25)
        const messages = yield* sessions.messages({ sessionID: chat.id })
        const failed = messages.filter(
          (message) => message.info.role === "assistant" && message.info.parentID === asyncID,
        )
        expect(failed).toHaveLength(1)
        expect(failed[0]?.info.role).toBe("assistant")
        if (failed[0]?.info.role === "assistant") {
          expect(failed[0].info.error?.name).toBeDefined()
          expect(failed[0].info.completedUserMessageIDs).toContain(asyncID)
        }
        expect(errors).toHaveLength(1)
        expect((yield* status.get(chat.id)).type).toBe("idle")
      }),
      { config: providerCfg },
    ),
  5_000,
)

it.live(
  "settles a failed runner against its own turn when an older user is still awaiting",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* () {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Failure turn ownership" })
        const older = yield* user(chat.id, "故意保留的更早待回复消息")
        const currentID = MessageID.ascending()
        const originalUpdateMessage = sessions.updateMessage
        let injected = false
        const failingUpdateMessage: typeof originalUpdateMessage = (message) => {
          const persist = originalUpdateMessage(message)
          if (
            injected ||
            message.role !== "assistant" ||
            message.parentID !== currentID ||
            message.error !== undefined
          )
            return persist
          injected = true
          // 精确模拟现场：assistant 空壳先 durable，随后当前 runner 在任何 part 落库前异常。
          return persist.pipe(Effect.andThen(Effect.die(new Error("current runner failed after assistant creation"))))
        }
        Object.assign(sessions, { updateMessage: failingUpdateMessage })
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => Object.assign(sessions, { updateMessage: originalUpdateMessage })),
        )

        yield* prompt
          .prompt({
            sessionID: chat.id,
            messageID: currentID,
            agent: "build",
            model: ref,
            parts: [{ type: "text", text: "当前失败回合" }],
          })
          .pipe(Effect.exit)

        const messages = yield* sessions.messages({ sessionID: chat.id })
        const current = messages.findLast(
          (message) => message.info.role === "assistant" && message.info.parentID === currentID,
        )
        if (!current || current.info.role !== "assistant") throw new Error("缺少当前失败回合 assistant")
        expect(current.info.error?.name).toBeDefined()
        expect(current.info.time.completed).toBeDefined()
        expect(current.info.completedUserMessageIDs).toContain(currentID)
        // 更早的待回复 user 仍保持原语义，不能被后来 runner 的错误错误结算。
        expect(
          messages.some(
            (message) =>
              message.info.role === "assistant" &&
              message.info.parentID === older.id &&
              message.info.error !== undefined,
          ),
        ).toBe(false)
      }),
      { config: providerCfg },
    ),
  5_000,
)

unix(
  "cancel with queued callers resolves all cleanly",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Pinned" })
        yield* llm.hang
        yield* user(chat.id, "hello")

        const a = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* llm.wait(1)
        const b = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* Effect.sleep(50)

        yield* prompt.cancel(chat.id)
        const [exitA, exitB] = yield* Effect.all([Fiber.await(a), Fiber.await(b)])
        expect(Exit.isSuccess(exitA)).toBe(true)
        expect(Exit.isSuccess(exitB)).toBe(true)
        if (Exit.isSuccess(exitA) && Exit.isSuccess(exitB)) {
          expect(exitA.value.info.id).toBe(exitB.value.info.id)
        }
      }),
      { config: providerCfg },
    ),
  5_000,
)

unix(
  "pausing an active goal interrupts the in-flight run",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Pinned" })
        yield* sessions.setGoal({ sessionID: chat.id, objective: "写一个大鱼吃小鱼游戏" })
        yield* llm.hang
        yield* user(chat.id, "start")

        const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* llm.wait(1)
        // 面板点「暂停」：状态转 paused 之外，在途回合必须被打断，否则会一直跑到自然结束
        yield* GoalRuntime.pauseActiveGoal(chat.id)

        const exit = yield* Fiber.await(fiber)
        expect(Exit.isSuccess(exit)).toBe(true)
        expect((yield* sessions.getGoal(chat.id))?.status).toBe("paused")
      }),
      { config: providerCfg },
    ),
  // 与同文件其它 loop/cancel 类用例对齐：这批在慢 runner 上并行跑时 5s 会 flake
  10_000,
)

unix(
  "pausing interrupts the in-flight run even when the goal write fails",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Pinned" })
        yield* llm.hang
        yield* user(chat.id, "start")

        const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* llm.wait(1)
        // 目标在「读到 active」之后被并发清除：写 paused 会失败，但停下在途回合是暂停的本职，不能被挡住
        yield* GoalRuntime.pauseActiveGoal(chat.id)

        const exit = yield* Fiber.await(fiber)
        expect(Exit.isSuccess(exit)).toBe(true)
      }),
      { config: providerCfg },
    ),
  10_000,
)

// Queue semantics

it.live("concurrent loop callers get same result", () =>
  provideTmpdirInstance(
    (_dir) =>
      Effect.gen(function* () {
        const { prompt, run, chat } = yield* boot()
        yield* seed(chat.id, { finish: "stop" })

        const [a, b] = yield* Effect.all([prompt.loop({ sessionID: chat.id }), prompt.loop({ sessionID: chat.id })], {
          concurrency: "unbounded",
        })

        expect(a.info.id).toBe(b.info.id)
        expect(a.info.role).toBe("assistant")
        yield* run.assertNotBusy(chat.id)
      }),
    {},
  ),
)

unix(
  "concurrent loop callers all receive same error result",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Pinned" })

        yield* llm.fail("boom")
        yield* user(chat.id, "hello")

        const [a, b] = yield* Effect.all([prompt.loop({ sessionID: chat.id }), prompt.loop({ sessionID: chat.id })], {
          concurrency: "unbounded",
        })
        expect(a.info.id).toBe(b.info.id)
        expect(a.info.role).toBe("assistant")
      }),
      { config: providerCfg },
    ),
  30_000,
)

unix(
  "prompt submitted during an active run is included in the next LLM input",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const gate = defer<void>()
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Pinned" })

        yield* llm.hold("first", gate.promise)
        yield* llm.text("second")

        const a = yield* prompt
          .prompt({
            sessionID: chat.id,
            agent: "build",
            model: ref,
            parts: [{ type: "text", text: "first" }],
          })
          .pipe(Effect.forkChild)

        yield* llm.wait(1)

        const id = MessageID.ascending()
        const b = yield* prompt
          .prompt({
            sessionID: chat.id,
            messageID: id,
            agent: "build",
            model: ref,
            parts: [{ type: "text", text: "second" }],
          })
          .pipe(Effect.forkChild)

        yield* Effect.promise(async () => {
          const end = Date.now() + 5000
          while (Date.now() < end) {
            const msgs = await Effect.runPromise(sessions.messages({ sessionID: chat.id }))
            if (msgs.some((msg) => msg.info.role === "user" && msg.info.id === id)) return
            await new Promise((done) => setTimeout(done, 20))
          }
          throw new Error("timed out waiting for second prompt to save")
        })

        gate.resolve()

        const [ea, eb] = yield* Effect.all([Fiber.await(a), Fiber.await(b)])
        expect(Exit.isSuccess(ea)).toBe(true)
        expect(Exit.isSuccess(eb)).toBe(true)
        expect(yield* llm.calls).toBe(2)

        const msgs = yield* sessions.messages({ sessionID: chat.id })
        const assistants = msgs.filter((msg) => msg.info.role === "assistant")
        expect(assistants).toHaveLength(2)
        const last = assistants.at(-1)
        if (!last || last.info.role !== "assistant") throw new Error("expected second assistant")
        expect(last.info.parentID).toBe(id)
        expect(last.parts.some((part) => part.type === "text" && part.text === "second")).toBe(true)

        const inputs = yield* llm.inputs
        expect(inputs).toHaveLength(2)
        expect(JSON.stringify(inputs.at(-1)?.messages)).toContain("second")
      }),
      { config: providerCfg },
    ),
  5_000,
)

// durable steer 必须切断旧采样但复用当前 runner：旧 assistant 立即冻结，新 assistant 挂到引导用户消息下面。
unix(
  "steer interrupts the old sample and continues under the steering user message",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const gate = defer<void>()
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Steer parent" })

        yield* llm.hold("first", gate.promise)
        yield* llm.text("steered response")

        const firstUserID = MessageID.ascending()
        const first = yield* prompt
          .prompt({
            sessionID: chat.id,
            messageID: firstUserID,
            agent: "build",
            model: ref,
            parts: [{ type: "text", text: "first" }],
          })
          .pipe(Effect.forkChild)

        yield* llm.wait(1)
        const steerID = MessageID.ascending()
        const ack = yield* prompt.steer({
          sessionID: chat.id,
          messageID: steerID,
          targetTurnID: firstUserID,
          agent: "build",
          model: ref,
          parts: [{ type: "text", text: "请改为简短回复" }],
        })
        expect(ack.messageID).toBe(steerID)

        const exit = yield* Fiber.await(first)
        expect(Exit.isSuccess(exit)).toBe(true)
        expect(yield* llm.calls).toBe(2)

        const messages = yield* sessions.messages({ sessionID: chat.id })
        const users = messages.filter((message) => message.info.role === "user")
        const assistants = messages.filter((message) => message.info.role === "assistant")
        expect(users.map((message) => message.info.id)).toEqual([firstUserID, steerID])
        expect(assistants).toHaveLength(2)
        // 原请求、引导及引导前后的 assistant 都属于同一个稳定逻辑回合。
        expect(users.map((message) => message.info.turnID)).toEqual([firstUserID, firstUserID])
        expect(assistants.map((message) => message.info.turnID)).toEqual([firstUserID, firstUserID])
        const interrupted = assistants[0]
        if (!interrupted || interrupted.info.role !== "assistant") throw new Error("expected interrupted assistant")
        // steer 是正常的显示分界：旧采样没有机会越过引导继续写入，也不能伪装成用户点击停止的错误。
        expect(interrupted.info.time.completed).toBeNumber()
        expect(interrupted.info.error).toBeUndefined()
        expect(interrupted.parts.some((part) => part.type === "text" && part.text === "first")).toBe(false)
        const latest = assistants.at(-1)
        if (!latest || latest.info.role !== "assistant") throw new Error("expected steer assistant")
        expect(latest.info.parentID).toBe(steerID)
        expect(latest.parts.some((part) => part.type === "text" && part.text === "steered response")).toBe(true)

        const inputs = yield* llm.inputs
        expect(JSON.stringify(inputs.at(-1)?.messages)).toContain("请改为简短回复")
        // 与官方 turn/steer 一致，provider 只能看到原始引导文本，不能收到本地 durable marker 的附加指令。
        expect(JSON.stringify(inputs.at(-1)?.messages)).not.toContain(
          "The latest visible user message was sent as steering",
        )
      }),
      { config: providerCfg },
    ),
  5_000,
)

// steer 的 message info 会先于真实 parts 与 marker 落库；runner 读到半条消息时不能提前把它计入首轮完成集合。
unix(
  "keeps a steer candidate pending while its marker is still being persisted",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const gate = defer<void>()
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Partial steer persistence race" })
        const root = yield* user(chat.id, "先处理当前请求")
        const steerID = MessageID.ascending()
        const steerText = "首轮结束后按这条引导继续"

        // 精确模拟 createUserMessage 已写 info、但 updatePart 尚未完成的持久化窗口。
        yield* sessions.updateMessage({
          id: steerID,
          role: "user",
          turnID: root.id,
          steerTargetTurnID: root.id,
          sessionID: chat.id,
          agent: "build",
          model: ref,
          time: { created: Date.now() },
        })

        yield* llm.hold("首轮完成", gate.promise)
        yield* llm.text("已处理引导")
        const active = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* llm.wait(1)

        // 首轮已经开始采样后才补齐真实输入和 durable marker，覆盖用户现场发生的竞态顺序。
        yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID: steerID,
          sessionID: chat.id,
          type: "text",
          text: steerText,
        })
        yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID: steerID,
          sessionID: chat.id,
          type: "text",
          text: "",
          synthetic: true,
          ignored: true,
          metadata: {
            manual_steer_context: true,
            manual_steer_target_turn_id: root.id,
          },
        })
        gate.resolve()

        expect(Exit.isSuccess(yield* Fiber.await(active))).toBe(true)
        expect(yield* llm.calls).toBe(2)
        const inputs = yield* llm.inputs
        expect(JSON.stringify(inputs[0]?.messages)).not.toContain(steerText)
        expect(JSON.stringify(inputs[1]?.messages)).toContain(steerText)

        const messages = yield* sessions.messages({ sessionID: chat.id })
        const first = messages.find(
          (message) =>
            message.info.role === "assistant" &&
            message.parts.some((part) => part.type === "text" && part.text === "首轮完成"),
        )
        const steered = messages.find(
          (message) =>
            message.info.role === "assistant" &&
            message.parts.some((part) => part.type === "text" && part.text === "已处理引导"),
        )
        expect(first?.info.role === "assistant" ? first.info.completedUserMessageIDs : undefined).toEqual([root.id])
        if (!steered || steered.info.role !== "assistant") throw new Error("expected steer assistant")
        expect(steered.info.parentID).toBe(steerID)
        expect(new Set(steered.info.completedUserMessageIDs)).toEqual(new Set([root.id, steerID]))
      }),
      { config: providerCfg },
    ),
  5_000,
)

// 客户端在 durable ACK 丢失后会用同一个 messageID 重试；服务端必须复用原消息，不能重复 parts 或模型回复。
unix(
  "reuses the persisted steer when the durable ACK is retried",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const gate = defer<void>()
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Steer retry" })

        yield* llm.hold("first", gate.promise)
        yield* llm.text("steered once")

        const firstUserID = MessageID.ascending()
        const first = yield* prompt
          .prompt({
            sessionID: chat.id,
            messageID: firstUserID,
            agent: "build",
            model: ref,
            parts: [{ type: "text", text: "first" }],
          })
          .pipe(Effect.forkChild)

        yield* llm.wait(1)
        const steerID = MessageID.ascending()
        const input = {
          sessionID: chat.id,
          messageID: steerID,
          targetTurnID: firstUserID,
          agent: "build",
          model: ref,
          parts: [{ type: "text" as const, text: "只执行一次" }],
        }
        expect((yield* prompt.steer(input)).messageID).toBe(steerID)
        expect((yield* prompt.steer(input)).messageID).toBe(steerID)

        gate.resolve()
        expect(Exit.isSuccess(yield* Fiber.await(first))).toBe(true)
        expect(yield* llm.calls).toBe(2)

        const messages = yield* sessions.messages({ sessionID: chat.id })
        const steerUsers = messages.filter((message) => message.info.role === "user" && message.info.id === steerID)
        expect(steerUsers).toHaveLength(1)
        expect(steerUsers[0]?.parts.filter((part) => part.type === "text" && !part.synthetic)).toHaveLength(1)
        expect(
          messages.filter((message) => message.info.role === "assistant" && message.info.parentID === steerID),
        ).toHaveLength(1)
      }),
      { config: providerCfg },
    ),
  5_000,
)

// durable ACK 已经代表引导写入同一活动回合；停止只中断执行，历史中的引导不能被清理掉。
it.live(
  "keeps an accepted steer when the active turn is stopped",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Accepted steer stop" })
        const firstUserID = MessageID.ascending()
        const steerID = MessageID.ascending()

        yield* llm.hang
        const active = yield* prompt
          .prompt({
            sessionID: chat.id,
            messageID: firstUserID,
            agent: "build",
            model: ref,
            parts: [{ type: "text", text: "先开始一个会话" }],
          })
          .pipe(Effect.forkChild)
        yield* llm.wait(1)

        const ack = yield* prompt.steer({
          sessionID: chat.id,
          messageID: steerID,
          targetTurnID: firstUserID,
          // 发送方附带的配置不影响后端历史保留；这里仍使用合法配置保持测试聚焦停止语义。
          agent: "build",
          model: ref,
          parts: [{ type: "text", text: "停止前保留这条引导" }],
        })
        expect(ack).toEqual({ messageID: steerID, targetTurnID: firstUserID })

        // 默认停止会尝试恢复未完成队列；若 ACK 的 steer 没有被标记消费，这里会错误触发第二次模型调用。
        yield* llm.text("停止后新问题正常回复")
        yield* prompt.cancel(chat.id)
        expect(Exit.isSuccess(yield* Fiber.await(active))).toBe(true)
        yield* Effect.sleep("100 millis")

        const messages = yield* sessions.messages({ sessionID: chat.id })
        const steer = messages.find((message) => message.info.role === "user" && message.info.id === steerID)
        expect(steer?.info.role).toBe("user")
        expect(steer?.info.role === "user" ? steer.info.turnID : undefined).toBe(firstUserID)
        expect(
          steer?.parts.some((part) => part.type === "text" && !part.synthetic && part.text === "停止前保留这条引导"),
        ).toBe(true)
        const interrupted = messages.findLast(
          (message) => message.info.role === "assistant" && message.info.turnID === firstUserID,
        )
        expect(interrupted?.info.role === "assistant" ? interrupted.info.completedUserMessageIDs : undefined).toContain(
          steerID,
        )
        expect(yield* llm.calls).toBe(1)

        const next = yield* prompt.prompt({
          sessionID: chat.id,
          messageID: MessageID.ascending(),
          agent: "build",
          model: ref,
          parts: [{ type: "text", text: "停止以后这是一个全新的问题" }],
        })
        expect(next.parts.some((part) => part.type === "text" && part.text === "停止后新问题正常回复")).toBe(true)
        const resumedInput = (yield* llm.inputs).findLast((input) =>
          JSON.stringify(input).includes("停止以后这是一个全新的问题"),
        )
        // 官方 Codex 会在中断后写入 <turn_aborted>；该边界阻止旧 steer 与下一问被合并成同一条待执行指令。
        expect(JSON.stringify(resumedInput)).toContain("<turn_aborted>")
        expect(yield* llm.calls).toBe(2)
      }),
      { config: providerCfg },
    ),
  5_000,
)

// active turn 已登记但 assistant 尚未落库时也要生成终态 tombstone，停止不能让 root/steer 在下一次请求重放。
it.live(
  "settles an accepted steer when stop races assistant creation",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const entered = defer<void>()
        const release = defer<void>()
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Steer stop race" })
        const rootID = MessageID.ascending()
        const steerID = MessageID.ascending()
        const originalUpdateMessage = sessions.updateMessage
        const blockedUpdateMessage: typeof originalUpdateMessage = (message) => {
          if (
            message.role === "assistant" &&
            message.parentID === rootID &&
            message.turnID === rootID &&
            message.error === undefined
          ) {
            entered.resolve()
            return Effect.promise(() => release.promise).pipe(
              Effect.flatMap(() => originalUpdateMessage(message)),
            )
          }
          return originalUpdateMessage(message)
        }
        Object.assign(sessions, { updateMessage: blockedUpdateMessage })
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => Object.assign(sessions, { updateMessage: originalUpdateMessage })),
        )

        // 让测试停在 activeTurns 已登记、首次 assistant 持久化之前，精准覆盖 ACK/cancel 交错窗口。
        const active = yield* prompt
          .prompt({
            sessionID: chat.id,
            messageID: rootID,
            agent: "build",
            model: ref,
            parts: [{ type: "text", text: "开始一个会话" }],
          })
          .pipe(Effect.forkChild)
        yield* Effect.promise(() => entered.promise)

        const ack = yield* prompt.steer({
          sessionID: chat.id,
          messageID: steerID,
          targetTurnID: rootID,
          agent: "build",
          model: ref,
          parts: [{ type: "text", text: "停止前的引导" }],
        })
        expect(ack).toEqual({ messageID: steerID, targetTurnID: rootID })
        // 默认停止仍会检查队列；tombstone 必须让 root/steer 都不再触发第二次模型调用。
        yield* prompt.cancel(chat.id)
        release.resolve()
        yield* Fiber.await(active).pipe(Effect.exit)

        const messages = yield* sessions.messages({ sessionID: chat.id })
        const steer = messages.find((message) => message.info.role === "user" && message.info.id === steerID)
        expect(steer?.info.role).toBe("user")
        expect(
          steer?.parts.some((part) => part.type === "text" && !part.synthetic && part.text === "停止前的引导"),
        ).toBe(true)
        const terminal = messages.findLast(
          (message) => message.info.role === "assistant" && message.info.turnID === rootID,
        )
        expect(terminal?.info.role).toBe("assistant")
        // 停止竞态只能留下一个活动回合终态，不能让被阻塞的首个 assistant 解除后再写出重复消息。
        expect(
          messages.filter((message) => message.info.role === "assistant" && message.info.turnID === rootID),
        ).toHaveLength(1)
        if (terminal?.info.role === "assistant") {
          expect(terminal.info.error?.name).toBe("MessageAbortedError")
          expect(new Set(terminal.info.completedUserMessageIDs)).toEqual(new Set([rootID, steerID]))
        }
        expect(yield* llm.calls).toBe(0)
      }),
      { config: providerCfg },
    ),
  5_000,
)

// 首轮 assistant 已经终态落库、但 runner 尚未读取下一批 pending steer 时，停止也必须只结算引导，不能复用旧回复。
it.live(
  "settles a steer acknowledged after a terminal assistant before stop",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const terminalPersisted = defer<void>()
        const releaseRunner = defer<void>()
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Terminal steer stop race" })
        const rootID = MessageID.ascending()
        const steerID = MessageID.ascending()
        const originalUpdateMessage = sessions.updateMessage
        let blocked = false
        const blockedUpdateMessage: typeof originalUpdateMessage = (message) => {
          if (
            !blocked &&
            message.role === "assistant" &&
            message.parentID === rootID &&
            message.turnID === rootID &&
            message.error === undefined &&
            typeof message.time.completed === "number"
          ) {
            blocked = true
            return originalUpdateMessage(message).pipe(
              // 先确保终态已经写入数据库，再暂停 runner，精确制造 ACK 与 stop 的竞态窗口。
              Effect.flatMap(() => Effect.sync(() => terminalPersisted.resolve())),
              Effect.flatMap(() => Effect.promise(() => releaseRunner.promise)),
              Effect.as(message),
            )
          }
          return originalUpdateMessage(message)
        }
        Object.assign(sessions, { updateMessage: blockedUpdateMessage })
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => Object.assign(sessions, { updateMessage: originalUpdateMessage })),
        )

        yield* llm.text("首轮已经完成")
        const active = yield* prompt
          .prompt({
            sessionID: chat.id,
            messageID: rootID,
            agent: "build",
            model: ref,
            parts: [{ type: "text", text: "先完成这一轮" }],
          })
          .pipe(Effect.forkChild)
        yield* Effect.promise(() => terminalPersisted.promise)

        // 旧 assistant 已经 terminal，但 activeTurns 仍属于原 runner；steer 应得到同一 turn 的 ACK。
        yield* prompt.steer({
          sessionID: chat.id,
          messageID: steerID,
          targetTurnID: rootID,
          agent: "build",
          model: ref,
          parts: [{ type: "text", text: "终态之后的引导" }],
        })
        const cancelling = yield* prompt.cancel(chat.id).pipe(Effect.forkChild)
        yield* Effect.yieldNow
        releaseRunner.resolve()
        yield* Fiber.join(cancelling)
        yield* Fiber.await(active).pipe(Effect.exit)
        yield* Effect.sleep("100 millis")

        const messages = yield* sessions.messages({ sessionID: chat.id })
        const assistants = messages.filter(
          (message) => message.info.role === "assistant" && message.info.turnID === rootID,
        )
        // 旧终态保留；停止只为尚未回答的 steer 增加一个中断终态，不能再启动第三次模型调用。
        expect(assistants).toHaveLength(2)
        expect(yield* llm.calls).toBe(1)
        const terminal = assistants.at(-1)
        if (!terminal || terminal.info.role !== "assistant") throw new Error("expected steer stop tombstone")
        expect(terminal.info.parentID).toBe(steerID)
        expect(terminal.info.error?.name).toBe("MessageAbortedError")
        expect(new Set(terminal.info.completedUserMessageIDs)).toEqual(new Set([rootID, steerID]))
      }),
      { config: providerCfg },
    ),
  10_000,
)

// 没有 steer 的普通 root 也必须在 assistant 首次落库竞态中结算，否则取消后的自动恢复会重复执行整条请求。
it.live(
  "settles a root when stop races assistant creation",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const entered = defer<void>()
        const release = defer<void>()
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Root stop race" })
        const rootID = MessageID.ascending()
        const originalUpdateMessage = sessions.updateMessage
        const blockedUpdateMessage: typeof originalUpdateMessage = (message) => {
          if (
            message.role === "assistant" &&
            message.parentID === rootID &&
            message.turnID === rootID &&
            message.error === undefined
          ) {
            entered.resolve()
            return Effect.promise(() => release.promise).pipe(
              Effect.flatMap(() => originalUpdateMessage(message)),
            )
          }
          return originalUpdateMessage(message)
        }
        Object.assign(sessions, { updateMessage: blockedUpdateMessage })
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => Object.assign(sessions, { updateMessage: originalUpdateMessage })),
        )

        const active = yield* prompt
          .prompt({
            sessionID: chat.id,
            messageID: rootID,
            agent: "build",
            model: ref,
            parts: [{ type: "text", text: "只执行一次" }],
          })
          .pipe(Effect.forkChild)
        yield* Effect.promise(() => entered.promise)

        // 停止发生在 assistant 尚未 durable 的窗口；释放阻塞后只能看到一个 aborted assistant。
        yield* prompt.cancel(chat.id)
        release.resolve()
        yield* Fiber.await(active).pipe(Effect.exit)

        const messages = yield* sessions.messages({ sessionID: chat.id })
        const assistants = messages.filter(
          (message) => message.info.role === "assistant" && message.info.turnID === rootID,
        )
        expect(assistants).toHaveLength(1)
        const terminal = assistants[0]
        if (!terminal || terminal.info.role !== "assistant") throw new Error("expected root tombstone")
        expect(terminal.info.error?.name).toBe("MessageAbortedError")
        expect(terminal.info.completedUserMessageIDs).toContain(rootID)
        expect(yield* llm.calls).toBe(0)
      }),
      { config: providerCfg },
    ),
  5_000,
)

// 异常可能在 assistant 已写入、runner 生命周期身份已经清理后留下空壳；停止必须修复持久化终态并允许下一轮继续。
it.live(
  "settles an orphaned assistant after runner identity is gone",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const status = yield* SessionStatus.Service
        const chat = yield* sessions.create({ title: "Orphaned assistant recovery" })
        const root = yield* user(chat.id, "这轮在异常窗口留下空 assistant")
        const orphanID = MessageID.ascending()
        yield* sessions.updateMessage({
          id: orphanID,
          role: "assistant",
          parentID: root.id,
          turnID: root.id,
          sessionID: chat.id,
          mode: "build",
          agent: "build",
          cost: 0,
          path: { cwd: "/tmp", root: "/tmp" },
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: ref.modelID,
          providerID: ref.providerID,
          time: { created: Date.now() },
        })

        expect((yield* status.get(chat.id)).type).toBe("idle")
        // 内部 cancel 返回 void，HTTP handler 才映射为 true；这里只验证持久化终态与可继续发送的真实契约。
        yield* prompt.cancel(chat.id, { resumeQueued: false })

        const stopped = yield* sessions.messages({ sessionID: chat.id })
        const terminal = stopped.find((message) => message.info.role === "assistant" && message.info.id === orphanID)
        if (!terminal || terminal.info.role !== "assistant") throw new Error("缺少孤立 assistant 的停止终态")
        expect(terminal.info.error?.name).toBe("MessageAbortedError")
        expect(terminal.info.time.completed).toBeDefined()
        expect(terminal.info.completedUserMessageIDs).toContain(root.id)

        // 修复旧空壳后，同一会话必须能立即开始普通新回合，不能继续停留在 busy/queue 模式。
        yield* llm.text("错误后下一轮正常完成")
        const next = yield* prompt.prompt({
          sessionID: chat.id,
          messageID: MessageID.ascending(),
          agent: "build",
          model: ref,
          parts: [{ type: "text", text: "继续这个会话" }],
        })
        expect(next.parts.some((part) => part.type === "text" && part.text === "错误后下一轮正常完成")).toBe(true)
        expect((yield* status.get(chat.id)).type).toBe("idle")
      }),
      { config: providerCfg },
    ),
  5_000,
)

// 内存身份丢失时，持久化恢复必须停止最早正在等待的根回合，不能越过它去消费后来的普通排队消息。
it.live(
  "recovers the earliest pending turn without consuming a later queue",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* () {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Durable pending turn order" })
        const active = yield* user(chat.id, "当前应该被停止的回合")
        const queued = yield* user(chat.id, "后来的普通排队消息")

        yield* prompt.cancel(chat.id, { resumeQueued: false })

        const messages = yield* sessions.messages({ sessionID: chat.id })
        const stopped = messages.find(
          (message) => message.info.role === "assistant" && message.info.parentID === active.id,
        )
        if (!stopped || stopped.info.role !== "assistant") throw new Error("缺少当前回合的停止终态")
        expect(stopped.info.error?.name).toBe("MessageAbortedError")
        expect(stopped.info.completedUserMessageIDs).toContain(active.id)
        // 后续普通队列仍保持未回复，恢复发送时才能按原顺序继续执行。
        expect(
          messages.some((message) => message.info.role === "assistant" && message.info.parentID === queued.id),
        ).toBe(false)
      }),
      { config: providerCfg },
    ),
  5_000,
)

// tool-calls 只是同一 turn 的中间步骤；引导在步间 ACK 后停止时，必须在它后面补中断终态。
it.live(
  "settles an accepted steer when stop lands between tool steps",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ dir, llm }) {
        const entered = defer<void>()
        const release = defer<void>()
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({
          title: "Steer stop between tool steps",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        const rootID = MessageID.ascending()
        const steerID = MessageID.ascending()
        const originalUpdateMessage = sessions.updateMessage
        let firstAssistantID: MessageID | undefined
        const blockedUpdateMessage: typeof originalUpdateMessage = (message) => {
          if (message.role !== "assistant" || message.error !== undefined) return originalUpdateMessage(message)
          if (!firstAssistantID) {
            firstAssistantID = message.id
            return originalUpdateMessage(message)
          }
          if (message.id === firstAssistantID) return originalUpdateMessage(message)

          // 精确停在已完成 tool-calls 与下一条 assistant 首次持久化之间。
          entered.resolve()
          return Effect.promise(() => release.promise).pipe(
            Effect.flatMap(() => originalUpdateMessage(message)),
          )
        }
        Object.assign(sessions, { updateMessage: blockedUpdateMessage })
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => Object.assign(sessions, { updateMessage: originalUpdateMessage })),
        )

        yield* llm.tool("bash", {
          command: "pwd",
          description: "完成一个中间工具步骤",
          timeout: 5_000,
          workdir: path.resolve(dir),
        })
        yield* llm.text("停止后不应执行")
        const active = yield* prompt
          .prompt({
            sessionID: chat.id,
            messageID: rootID,
            agent: "build",
            model: ref,
            parts: [{ type: "text", text: "先执行工具" }],
          })
          .pipe(Effect.forkChild)
        yield* Effect.promise(() => entered.promise)

        expect(
          yield* prompt.steer({
            sessionID: chat.id,
            messageID: steerID,
            targetTurnID: rootID,
            agent: "build",
            model: ref,
            parts: [{ type: "text", text: "工具结束后按这条引导继续" }],
          }),
        ).toEqual({ messageID: steerID, targetTurnID: rootID })
        yield* prompt.cancel(chat.id)
        release.resolve()
        yield* Fiber.await(active).pipe(Effect.exit)
        yield* Effect.sleep("100 millis")

        const messages = yield* sessions.messages({ sessionID: chat.id })
        const assistants = messages.filter(
          (message) => message.info.role === "assistant" && message.info.turnID === rootID,
        )
        expect(assistants).toHaveLength(2)
        expect(assistants[0]?.info.role === "assistant" ? assistants[0].info.finish : undefined).toBe("tool-calls")
        const terminal = assistants.at(-1)
        if (!terminal || terminal.info.role !== "assistant") throw new Error("expected stop tombstone")
        expect(terminal.info.parentID).toBe(steerID)
        expect(terminal.info.error?.name).toBe("MessageAbortedError")
        expect(new Set(terminal.info.completedUserMessageIDs)).toEqual(new Set([rootID, steerID]))
        expect(yield* llm.calls).toBe(1)
      }),
      { config: providerCfg },
    ),
  10_000,
)

// 多步回合中旧 assistant 可能已经终态；停止必须处理最新刚落库的 assistant，不能误用旧终态提前返回。
it.live(
  "settles the latest assistant when stop races a later step",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const firstGate = defer<void>()
        const entered = defer<void>()
        const release = defer<void>()
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Later step stop race" })
        const rootID = MessageID.ascending()
        const steerID = MessageID.ascending()
        const originalUpdateMessage = sessions.updateMessage
        const blockedUpdateMessage: typeof originalUpdateMessage = (message) => {
          if (
            message.role === "assistant" &&
            message.parentID === steerID &&
            message.turnID === rootID &&
            message.error === undefined
          ) {
            // 先写入非终态 assistant，再阻塞模型调用，模拟旧终态与新步骤同时存在的窗口。
            return originalUpdateMessage(message).pipe(
              Effect.flatMap((saved) =>
                Effect.promise(() => {
                  entered.resolve()
                  return release.promise
                }).pipe(Effect.as(saved)),
              ),
            )
          }
          return originalUpdateMessage(message)
        }
        Object.assign(sessions, { updateMessage: blockedUpdateMessage })
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => Object.assign(sessions, { updateMessage: originalUpdateMessage })),
        )

        yield* llm.hold("first", firstGate.promise)
        yield* llm.text("second step must be aborted")
        const active = yield* prompt
          .prompt({
            sessionID: chat.id,
            messageID: rootID,
            agent: "build",
            model: ref,
            parts: [{ type: "text", text: "开始多步回合" }],
          })
          .pipe(Effect.forkChild)
        yield* llm.wait(1)
        expect(
          yield* prompt.steer({
            sessionID: chat.id,
            messageID: steerID,
            targetTurnID: rootID,
            agent: "build",
            model: ref,
            parts: [{ type: "text", text: "继续但随后停止" }],
          }),
        ).toEqual({ messageID: steerID, targetTurnID: rootID })

        firstGate.resolve()
        yield* Effect.promise(() => entered.promise)
        yield* prompt.cancel(chat.id)
        release.resolve()
        yield* Fiber.await(active).pipe(Effect.exit)

        const messages = yield* sessions.messages({ sessionID: chat.id })
        const assistants = messages.filter(
          (message) => message.info.role === "assistant" && message.info.turnID === rootID,
        )
        expect(assistants).toHaveLength(2)
        const latest = assistants.at(-1)
        if (!latest || latest.info.role !== "assistant") throw new Error("expected latest assistant")
        expect(latest.info.error?.name).toBe("MessageAbortedError")
        expect(new Set(latest.info.completedUserMessageIDs)).toEqual(new Set([rootID, steerID]))
        expect(yield* llm.calls).toBe(1)
      }),
      { config: providerCfg },
    ),
  5_000,
)

// 同一活动 turn 的 steer 只能改变 parent/content；即使客户端带来另一套配置，后续模型仍使用 root 配置。
unix(
  "keeps the active turn configuration across steer",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const gate = defer<void>()
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Steer configuration" })
        const firstUserID = MessageID.ascending()
        const steerID = MessageID.ascending()
        const unexpectedModel = {
          providerID: ProviderID.make("steer-only-provider"),
          modelID: ModelID.make("steer-only-model"),
        }

        const rootTools = { read: true, write: false }
        const rootFormat = { type: "text" as const }
        const rootImageGeneration = { count: 2, size: "1024x1024", output_format: "png" as const }
        const rootPermission = [{ permission: "read", pattern: "*", action: "allow" as const }]

        yield* llm.hold("first", gate.promise)
        yield* llm.text("response after steer")
        const active = yield* prompt
          .prompt({
            sessionID: chat.id,
            messageID: firstUserID,
            agent: "build",
            model: ref,
            variant: "root-variant",
            tools: rootTools,
            format: rootFormat,
            system: "root system",
            language: "zh-CN",
            translateContent: true,
            imageGeneration: rootImageGeneration,
            parts: [{ type: "text", text: "固定 root 配置" }],
          })
          .pipe(Effect.forkChild)
        yield* llm.wait(1)
        // 先建立活动回合外部权限快照；steer 携带的兼容 tools 不得覆盖这份会话权限。
        yield* sessions.setPermission({ sessionID: chat.id, permission: rootPermission })

        yield* prompt.steer({
          sessionID: chat.id,
          messageID: steerID,
          targetTurnID: firstUserID,
          agent: "general",
          model: unexpectedModel,
          variant: "steer-variant",
          tools: { steer_only: false },
          format: { type: "json_schema", schema: { type: "object" } },
          system: "steer system",
          language: "en-US",
          translateContent: false,
          imageGeneration: { count: 8, size: "512x512", output_format: "jpeg" },
          parts: [{ type: "text", text: "引导不应切换配置" }],
        })
        gate.resolve()
        expect(Exit.isSuccess(yield* Fiber.await(active))).toBe(true)

        const messages = yield* sessions.messages({ sessionID: chat.id })
        const steer = MessageV2.get({ sessionID: chat.id, messageID: steerID })
        const visibleSteer = messages.find((message) => message.info.id === steerID)
        const latest = messages.findLast((message) => message.info.role === "assistant")
        expect(latest?.info.role).toBe("assistant")
        if (latest?.info.role !== "assistant") return
        expect(latest.info.agent).toBe("build")
        expect(latest.info.providerID).toBe(ref.providerID)
        expect(latest.info.modelID).toBe(ref.modelID)
        expect(latest.info.parentID).toBe(steerID)
        expect(steer.info.role).toBe("user")
        if (steer.info.role !== "user") return
        expect(steer.info.agent).toBe("build")
        expect(steer.info.model).toMatchObject({
          providerID: ref.providerID,
          modelID: ref.modelID,
          variant: "root-variant",
        })
        expect(steer.info.tools).toEqual(rootTools)
        expect(steer.info.format).toEqual(rootFormat)
        // 结构化输出配置经过 SQLite 刷新后仍须保留引导气泡，不能被 sanitizeMessages 丢掉。
        expect(visibleSteer?.info.role === "user" ? visibleSteer.info.format : undefined).toEqual(rootFormat)
        expect(steer.info.system).toBe("root system")
        expect(steer.info.language).toBe("zh-CN")
        expect(steer.info.translateContent).toBe(true)
        expect(steer.info.imageGeneration).toEqual(rootImageGeneration)
        expect((yield* sessions.get(chat.id)).permission).toEqual(rootPermission)
      }),
      { config: providerCfg },
    ),
  5_000,
)

// 空闲会话没有可绑定的逻辑回合；拒绝必须发生在任何用户消息或 part 落库之前。
it.live("rejects steer for an idle target without persisting the message", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Idle steer target" })
      const messageID = MessageID.ascending()
      const targetTurnID = MessageID.ascending()

      const exit = yield* prompt
        .steer({
          sessionID: chat.id,
          messageID,
          targetTurnID,
          agent: "build",
          model: ref,
          parts: [{ type: "text", text: "不能写入空闲会话" }],
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const error = Cause.squash(exit.cause)
        expect(error).toBeInstanceOf(SessionPrompt.SteerTurnInactiveError)
        if (error instanceof SessionPrompt.SteerTurnInactiveError) {
          expect(error.expectedTurnID).toBe(targetTurnID)
          expect(error.actualTurnID).toBeUndefined()
        }
      }
      expect((yield* sessions.messages({ sessionID: chat.id })).some((message) => message.info.id === messageID)).toBe(
        false,
      )
    }),
    { config: providerCfg },
  ),
)

// 空 steer 必须在活动/expected-turn 校验之后失败：错误目标仍返回 409，正确目标才返回 400，且两者都不能落库。
unix(
  "rejects empty steer input after active turn validation",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const gate = defer<void>()
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Empty steer input" })
        const activeTurnID = MessageID.ascending()
        const wrongTargetTurnID = MessageID.ascending()
        const wrongSteerID = MessageID.ascending()
        const emptySteerID = MessageID.ascending()

        yield* llm.hold("active response", gate.promise)
        const active = yield* prompt
          .prompt({
            sessionID: chat.id,
            messageID: activeTurnID,
            agent: "build",
            model: ref,
            parts: [{ type: "text", text: "保持活动回合" }],
          })
          .pipe(Effect.forkChild)
        yield* llm.wait(1)

        const wrong = yield* prompt
          .steer({
            sessionID: chat.id,
            messageID: wrongSteerID,
            targetTurnID: wrongTargetTurnID,
            agent: "build",
            model: ref,
            parts: [],
          })
          .pipe(Effect.exit)
        expect(Exit.isFailure(wrong)).toBe(true)
        expect(Exit.isFailure(wrong) ? Cause.squash(wrong.cause) : undefined).toBeInstanceOf(
          SessionPrompt.SteerTurnInactiveError,
        )

        const empty = yield* prompt
          .steer({
            sessionID: chat.id,
            messageID: emptySteerID,
            targetTurnID: activeTurnID,
            agent: "build",
            model: ref,
            parts: [],
          })
          .pipe(Effect.exit)
        expect(Exit.isFailure(empty)).toBe(true)
        expect(Exit.isFailure(empty) ? Cause.squash(empty.cause) : undefined).toBeInstanceOf(
          SessionPrompt.SteerEmptyInputError,
        )
        const messages = yield* sessions.messages({ sessionID: chat.id })
        expect(messages.some((message) => message.info.id === wrongSteerID || message.info.id === emptySteerID)).toBe(
          false,
        )

        gate.resolve()
        expect(Exit.isSuccess(yield* Fiber.await(active))).toBe(true)
      }),
      { config: providerCfg },
    ),
  5_000,
)

// 会话忙碌不代表任意 target 都能接入；409 必须回报权威活动 turnID，且不得持久化错误目标的消息。
unix(
  "rejects steer for the wrong active target and reports the actual turn",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const gate = defer<void>()
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Wrong active steer target" })
        const activeTurnID = MessageID.ascending()
        const wrongTargetTurnID = MessageID.ascending()
        const steerID = MessageID.ascending()

        yield* llm.hold("active response", gate.promise)
        const active = yield* prompt
          .prompt({
            sessionID: chat.id,
            messageID: activeTurnID,
            agent: "build",
            model: ref,
            parts: [{ type: "text", text: "保持当前回合" }],
          })
          .pipe(Effect.forkChild)
        yield* llm.wait(1)

        const exit = yield* prompt
          .steer({
            sessionID: chat.id,
            messageID: steerID,
            targetTurnID: wrongTargetTurnID,
            agent: "build",
            model: ref,
            parts: [{ type: "text", text: "错误目标不能接入" }],
          })
          .pipe(Effect.exit)

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          const error = Cause.squash(exit.cause)
          expect(error).toBeInstanceOf(SessionPrompt.SteerTurnInactiveError)
          if (error instanceof SessionPrompt.SteerTurnInactiveError) {
            expect(error.expectedTurnID).toBe(wrongTargetTurnID)
            expect(error.actualTurnID).toBe(activeTurnID)
            // transport 丢失结构化 data 时，客户端仍按官方精确文本提取权威 turnID 并只重试一次。
            expect(error.message).toBe(
              `expected active turn id \`${wrongTargetTurnID}\` but found \`${activeTurnID}\``,
            )
          }
        }
        expect((yield* sessions.messages({ sessionID: chat.id })).some((message) => message.info.id === steerID)).toBe(
          false,
        )

        gate.resolve()
        expect(Exit.isSuccess(yield* Fiber.await(active))).toBe(true)
      }),
      { config: providerCfg },
    ),
  5_000,
)

// 第一次接收若只写了旧 target 而未完成 marker，客户端按 mismatch 改绑后应复用同一 messageID 完成唯一重试。
unix(
  "retargets an incomplete persisted steer from the authoritative active turn",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const gate = defer<void>()
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Incomplete steer retarget" })
        const activeTurnID = MessageID.ascending()
        const staleTargetTurnID = MessageID.ascending()
        const steerID = MessageID.ascending()

        yield* llm.hold("active response", gate.promise)
        yield* llm.text("retargeted steer response")
        const active = yield* prompt
          .prompt({
            sessionID: chat.id,
            messageID: activeTurnID,
            agent: "build",
            model: ref,
            parts: [{ type: "text", text: "当前权威回合" }],
          })
          .pipe(Effect.forkChild)
        yield* llm.wait(1)

        yield* sessions.updateMessage({
          id: steerID,
          role: "user",
          turnID: staleTargetTurnID,
          steerTargetTurnID: staleTargetTurnID,
          sessionID: chat.id,
          agent: "build",
          model: ref,
          time: { created: Date.now() },
        })
        yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID: steerID,
          sessionID: chat.id,
          type: "text",
          text: "未完成的旧目标引导",
        })

        const ack = yield* prompt.steer({
          sessionID: chat.id,
          messageID: steerID,
          targetTurnID: activeTurnID,
          agent: "build",
          model: ref,
          parts: [{ type: "text", text: "按权威目标重试" }],
        })
        expect(ack).toEqual({ messageID: steerID, targetTurnID: activeTurnID })

        const persisted = (yield* sessions.messages({ sessionID: chat.id })).find(
          (message) => message.info.id === steerID,
        )
        expect(persisted?.info.turnID).toBe(activeTurnID)
        expect(persisted?.info.role === "user" ? persisted.info.steerTargetTurnID : undefined).toBe(activeTurnID)
        expect(
          persisted?.parts
            .filter((part) => part.type === "text" && !part.synthetic)
            .map((part) => (part.type === "text" ? part.text : "")),
        ).toEqual(["按权威目标重试"])
        const marker = persisted?.parts.find(
          (part) => part.type === "text" && part.synthetic && part.metadata?.manual_steer_context === true,
        )
        // durable marker 不能给模型追加官方 turn/steer 不存在的隐藏指令。
        expect(marker).toMatchObject({ type: "text", text: "", synthetic: true, ignored: true })

        gate.resolve()
        expect(Exit.isSuccess(yield* Fiber.await(active))).toBe(true)
        expect(yield* llm.calls).toBe(2)
      }),
      { config: providerCfg },
    ),
  5_000,
)

// messageID 是 durable ACK 的幂等键，已经接受后不能用同一 ID 把引导偷换到另一个逻辑回合。
unix(
  "rejects a persisted steer retry when the target turn changes",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const gate = defer<void>()
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Steer target idempotency" })
        const activeTurnID = MessageID.ascending()
        const changedTargetTurnID = MessageID.ascending()
        const steerID = MessageID.ascending()

        yield* llm.hold("active response", gate.promise)
        yield* llm.text("accepted steer response")
        const active = yield* prompt
          .prompt({
            sessionID: chat.id,
            messageID: activeTurnID,
            agent: "build",
            model: ref,
            parts: [{ type: "text", text: "当前回合" }],
          })
          .pipe(Effect.forkChild)
        yield* llm.wait(1)

        yield* prompt.steer({
          sessionID: chat.id,
          messageID: steerID,
          targetTurnID: activeTurnID,
          agent: "build",
          model: ref,
          parts: [{ type: "text", text: "已经接受的引导" }],
        })
        const exit = yield* prompt
          .steer({
            sessionID: chat.id,
            messageID: steerID,
            targetTurnID: changedTargetTurnID,
            agent: "build",
            model: ref,
            parts: [{ type: "text", text: "不得覆盖原引导" }],
          })
          .pipe(Effect.exit)

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          const error = Cause.squash(exit.cause)
          expect(error).toBeInstanceOf(SessionPrompt.SteerTurnInactiveError)
          if (error instanceof SessionPrompt.SteerTurnInactiveError) {
            expect(error.expectedTurnID).toBe(changedTargetTurnID)
            expect(error.actualTurnID).toBe(activeTurnID)
          }
        }
        const persisted = (yield* sessions.messages({ sessionID: chat.id })).find(
          (message) => message.info.id === steerID,
        )
        expect(
          persisted?.parts
            .filter((part) => part.type === "text" && !part.synthetic)
            .map((part) => (part.type === "text" ? part.text : "")),
        ).toEqual(["已经接受的引导"])

        gate.resolve()
        expect(Exit.isSuccess(yield* Fiber.await(active))).toBe(true)
        expect(yield* llm.calls).toBe(2)
      }),
      { config: providerCfg },
    ),
  5_000,
)

// 进程或连接可能中断在 marker 落库之前；目标失效时必须清掉半消息，让同 ID 能干净降级为普通队列。
it.live("cleans an incomplete steer before recovering it as a normal queued message", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Incomplete steer recovery" })
      const messageID = MessageID.ascending()
      const targetTurnID = MessageID.ascending()

      yield* sessions.updateMessage({
        id: messageID,
        role: "user",
        sessionID: chat.id,
        agent: "build",
        model: ref,
        steerTargetTurnID: targetTurnID,
        time: { created: Date.now() },
      })
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID,
        sessionID: chat.id,
        type: "text",
        text: "半条引导残留",
      })

      const exit = yield* prompt
        .steer({
          sessionID: chat.id,
          messageID,
          targetTurnID,
          agent: "build",
          model: ref,
          parts: [{ type: "text", text: "重试中的引导" }],
        })
        .pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.squash(exit.cause)).toBeInstanceOf(SessionPrompt.SteerTurnInactiveError)
      }
      expect((yield* sessions.messages({ sessionID: chat.id })).some((message) => message.info.id === messageID)).toBe(
        false,
      )

      const recoveredText = "恢复后的普通队列"
      yield* prompt.prompt({
        sessionID: chat.id,
        messageID,
        agent: "build",
        model: ref,
        noReply: true,
        parts: [{ type: "text", text: recoveredText }],
      })
      const recovered = (yield* sessions.messages({ sessionID: chat.id })).find(
        (message) => message.info.id === messageID,
      )
      expect(recovered?.info.role === "user" ? recovered.info.steerTargetTurnID : undefined).toBeUndefined()
      // 同一 clientUserMessageId 从失败 steer 降级为普通发送时，应以该 ID 干净建立新逻辑回合。
      expect(recovered?.info.turnID).toBe(messageID)
      expect(
        recovered?.parts
          .filter((part) => part.type === "text" && !part.synthetic)
          .map((part) => (part.type === "text" ? part.text : "")),
      ).toEqual([recoveredText])
      expect(
        recovered?.parts.some(
          (part) => part.type === "text" && part.synthetic && part.metadata?.manual_steer_context === true,
        ),
      ).toBe(false)

      yield* llm.text("normal queued response")
      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role === "assistant" ? result.info.parentID : undefined).toBe(messageID)
      expect(result.info.turnID).toBe(messageID)
      const matchingInputs = (yield* llm.inputs).filter((input) => JSON.stringify(input).includes(recoveredText))
      expect(matchingInputs).toHaveLength(1)
      expect(JSON.stringify(matchingInputs[0])).not.toContain("半条引导残留")
    }),
    { config: providerCfg },
  ),
)

// 进程若停在 info/正文已写而 durable marker 未写的窗口，恢复 runner 也不能把这半条 steer 送进模型。
it.live("does not sample an incomplete persisted steer before durable acceptance", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Incomplete steer is not accepted" })
      const completed = yield* seed(chat.id, { finish: "stop" })
      const steerID = MessageID.ascending()

      yield* sessions.updateMessage({
        id: steerID,
        role: "user",
        turnID: completed.user.id,
        steerTargetTurnID: completed.user.id,
        sessionID: chat.id,
        agent: "build",
        model: ref,
        time: { created: Date.now() },
      })
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: steerID,
        sessionID: chat.id,
        type: "text",
        text: "尚未 durable accepted 的半条引导",
      })

      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.id).toBe(completed.assistant.id)
      expect(yield* llm.calls).toBe(0)
      expect(
        (yield* sessions.messages({ sessionID: chat.id })).some(
          (message) => message.info.role === "assistant" && message.info.parentID === steerID,
        ),
      ).toBe(false)
    }),
    { config: providerCfg },
  ),
)

// 已经完成的 steer 可能因客户端晚到的 ACK 超时而重试；它不能借此重新拉起 runner、消费无关普通队列。
it.live(
  "only acknowledges a terminal steer retry without draining the normal queue",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const run = yield* SessionRunState.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Terminal steer retry" })
        const targetTurnID = MessageID.ascending()
        const steerID = MessageID.ascending()
        const steerText = "已经完成的引导"

        yield* prompt.prompt({
          sessionID: chat.id,
          messageID: steerID,
          agent: "build",
          model: ref,
          noReply: true,
          parts: [
            { type: "text", text: steerText },
            {
              type: "text",
              text: "manual steer",
              synthetic: true,
              metadata: {
                manual_steer_context: true,
                manual_steer_target_turn_id: targetTurnID,
              },
            },
          ],
        })
        yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "assistant",
          parentID: steerID,
          completedUserMessageIDs: [steerID],
          sessionID: chat.id,
          mode: "build",
          agent: "build",
          cost: 0,
          path: { cwd: "/tmp", root: "/tmp" },
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: ref.modelID,
          providerID: ref.providerID,
          time: { created: Date.now(), completed: Date.now() },
          finish: "stop",
        })
        const queued = yield* user(chat.id, "保持在普通队列")

        const ack = yield* prompt.steer({
          sessionID: chat.id,
          messageID: steerID,
          targetTurnID,
          agent: "build",
          model: ref,
          parts: [{ type: "text", text: steerText }],
        })
        expect(ack.messageID).toBe(steerID)
        expect(yield* llm.wait(1).pipe(Effect.timeoutOption("150 millis"))).toEqual(Option.none())
        yield* run.assertNotBusy(chat.id)

        const messages = yield* sessions.messages({ sessionID: chat.id })
        expect(
          messages.some((message) => message.info.role === "assistant" && message.info.parentID === queued.id),
        ).toBe(false)
      }),
      { config: providerCfg },
    ),
  5_000,
)

// 应用恢复时 subtask 与后来落库的 steer 可能同时存在；任务仍归原 user，且执行上下文不能提前看到 steer。
it.live(
  "keeps a pending subtask bound to its owner before applying persisted steer",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const registry = yield* ToolRegistry.Service
        const { task } = yield* registry.named()
        const original = task.execute
        let taskContext: MessageV2.WithParts[] | undefined
        task.execute = (args, ctx) => {
          taskContext = ctx.messages
          return original(args, ctx)
        }
        yield* Effect.addFinalizer(() => Effect.sync(() => void (task.execute = original)))

        const chat = yield* sessions.create({ title: "Pending subtask steer" })
        const owner = yield* user(chat.id, "执行原来的子任务")
        yield* addSubtask(chat.id, owner.id)
        const steerID = MessageID.ascending()
        yield* prompt.prompt({
          sessionID: chat.id,
          messageID: steerID,
          agent: "build",
          model: ref,
          noReply: true,
          parts: [
            { type: "text", text: "子任务完成后按这条引导继续" },
            {
              type: "text",
              text: "manual steer",
              synthetic: true,
              metadata: { manual_steer_context: true },
            },
          ],
        })
        yield* llm.text("child result")
        yield* llm.text("steered result")

        const result = yield* prompt.loop({ sessionID: chat.id })
        expect(yield* llm.calls).toBe(2)
        expect(taskContext?.map((message) => message.info.id)).toEqual([owner.id])

        const messages = yield* sessions.messages({ sessionID: chat.id })
        const taskAssistant = messages.find(
          (message) => message.info.role === "assistant" && message.info.agent === "general",
        )
        expect(taskAssistant?.info.role === "assistant" ? taskAssistant.info.parentID : undefined).toBe(owner.id)
        // 子任务工具步骤与后续引导回复始终保留原 owner 的逻辑回合身份。
        expect(taskAssistant?.info.turnID).toBe(owner.id)
        expect(result.info.role).toBe("assistant")
        if (result.info.role !== "assistant") return
        expect(result.info.parentID).toBe(steerID)
        expect(result.info.turnID).toBe(owner.id)
        expect(new Set(result.info.completedUserMessageIDs)).toEqual(new Set([owner.id, steerID]))
      }),
      { config: providerCfg },
    ),
  10_000,
)

// pending compaction 必须只压缩到自身 owner；后来的 steer 要等摘要步骤完成后再进入同一 active turn。
it.live(
  "keeps persisted steer out of a pending compaction snapshot",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Pending compaction steer" })
        yield* seed(chat.id, { finish: "stop" })
        const owner = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: chat.id,
          agent: "build",
          model: ref,
          time: { created: Date.now() },
        })
        yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID: owner.id,
          sessionID: chat.id,
          type: "compaction",
          auto: false,
        })
        const steerID = MessageID.ascending()
        const steerText = "摘要完成后再应用这条引导"
        yield* prompt.prompt({
          sessionID: chat.id,
          messageID: steerID,
          agent: "build",
          model: ref,
          noReply: true,
          parts: [
            { type: "text", text: steerText },
            {
              type: "text",
              text: "manual steer",
              synthetic: true,
              metadata: { manual_steer_context: true },
            },
          ],
        })
        yield* llm.text("summary result")
        yield* llm.text("steered after summary")

        const result = yield* prompt.loop({ sessionID: chat.id })
        expect(yield* llm.calls).toBe(2)
        const inputs = yield* llm.inputs
        expect(JSON.stringify(inputs[0]?.messages)).not.toContain(steerText)

        const messages = yield* sessions.messages({ sessionID: chat.id })
        const summaryMessage = messages.find(
          (message) => message.info.role === "assistant" && message.info.summary === true,
        )
        expect(summaryMessage?.info.role === "assistant" ? summaryMessage.info.parentID : undefined).toBe(owner.id)
        // 压缩摘要只是回合内部步骤，摘要与压缩后的引导回复不能形成新的显示回合。
        expect(summaryMessage?.info.turnID).toBe(owner.id)
        expect(result.info.role).toBe("assistant")
        if (result.info.role !== "assistant") return
        expect(result.info.parentID).toBe(steerID)
        expect(result.info.turnID).toBe(owner.id)
        expect(new Set(result.info.completedUserMessageIDs)).toEqual(new Set([owner.id, steerID]))
      }),
      { config: providerCfg },
    ),
  10_000,
)

// 旧采样在 steer ACK 前尚未返回 token usage 时不能凭未发生的结果触发压缩，应直接从引导继续。
it.live(
  "does not compact from token usage discarded by steer",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const firstGate = defer<void>()
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Compact before pending steer" })
        const rootID = MessageID.ascending()
        const steerID = MessageID.ascending()
        const steerText = "压缩完成后再回答这条引导"

        yield* llm.push(
          reply().wait(firstGate.promise).text("root response").usage({ input: 95_000, output: 1 }).stop(),
        )
        yield* llm.pushMatch(
          (hit) => JSON.stringify(hit.body).includes("Create a new anchored summary"),
          reply().text("summary before steer").stop(),
        )
        yield* llm.text("steer response after compact")

        const active = yield* prompt
          .prompt({
            sessionID: chat.id,
            messageID: rootID,
            agent: "build",
            model: ref,
            parts: [{ type: "text", text: "先完成当前回答" }],
          })
          .pipe(Effect.forkChild)
        yield* llm.wait(1)
        expect(
          yield* prompt.steer({
            sessionID: chat.id,
            messageID: steerID,
            targetTurnID: rootID,
            agent: "build",
            model: ref,
            parts: [{ type: "text", text: steerText }],
          }),
        ).toEqual({ messageID: steerID, targetTurnID: rootID })

        expect(Exit.isSuccess(yield* Fiber.await(active))).toBe(true)
        expect(yield* llm.calls).toBe(2)

        const inputs = yield* llm.inputs
        const summaryInput = inputs.find((input) => JSON.stringify(input).includes("Create a new anchored summary"))
        const steerInput = inputs.find(
          (input) => JSON.stringify(input).includes(steerText) && input !== summaryInput,
        )
        // 旧响应的 usage 位于尚未到达的 tail；采样被切断后不能再用它制造一次多余摘要。
        expect(summaryInput).toBeUndefined()
        expect(steerInput).toBeDefined()

        const messages = yield* sessions.messages({ sessionID: chat.id })
        const replyToSteer = messages.find(
          (message) =>
            message.info.role === "assistant" &&
            message.parts.some((part) => part.type === "text" && part.text === "steer response after compact"),
        )
        if (!replyToSteer || replyToSteer.info.role !== "assistant") throw new Error("expected steer reply")
        expect(replyToSteer.info.parentID).toBe(steerID)
        expect(replyToSteer.info.completedUserMessageIDs).toContain(steerID)
        expect((yield* MessageV2.filterCompactedEffect(chat.id)).some((message) => message.info.id === steerID)).toBe(
          true,
        )
      }),
      { config: providerCfg },
    ),
  10_000,
)

unix(
  "uses the permission mode selected before a steer executes",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ dir, llm }) {
        const gate = defer<void>()
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const permission = yield* Permission.Service
        const chat = yield* sessions.create({
          title: "Refresh permission mode before steer",
          permission: [{ permission: "bash", pattern: "*", action: "ask" }],
        })

        testPermissionMode = "ask"
        try {
          yield* llm.hold("initial response", gate.promise)
          yield* llm.tool("bash", {
            command: "printf 'permission-refreshed'",
            description: "Verify the refreshed permission mode",
            timeout: 5_000,
            workdir: path.resolve(dir),
          })
          yield* llm.text("steer completed")

          const rootID = MessageID.ascending()
          const active = yield* prompt
            .prompt({
              sessionID: chat.id,
              messageID: rootID,
              agent: "build",
              model: ref,
              parts: [{ type: "text", text: "start the active turn" }],
            })
            .pipe(Effect.forkChild)

          yield* llm.wait(1)
          testPermissionMode = "full_access"
          yield* prompt.steer({
            sessionID: chat.id,
            messageID: MessageID.ascending(),
            targetTurnID: rootID,
            agent: "build",
            model: ref,
            parts: [{ type: "text", text: "run the tool with full access" }],
          })
          gate.resolve()

          let completed = false
          let pending: ReadonlyArray<Permission.Request> = []
          for (let i = 0; i < 200; i++) {
            pending = yield* permission.list()
            if (pending.length > 0) break
            if ((yield* llm.calls) >= 3) {
              completed = true
              break
            }
            yield* Effect.sleep("10 millis")
          }
          for (const request of pending) {
            yield* permission.reply({ requestID: request.id, reply: "once" })
          }

          expect(Exit.isSuccess(yield* Fiber.await(active))).toBe(true)
          expect(pending).toHaveLength(0)
          expect(completed).toBe(true)
        } finally {
          testPermissionMode = "full_access"
          gate.resolve()
        }
      }),
      { config: providerCfg },
    ),
  10_000,
)

// 旧采样里尚未发出的工具调用不算已执行；steer ACK 后应丢弃该计划并直接按新引导继续。
it.live(
  "discards a tool call that was not emitted before steer",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ dir, llm }) {
        const toolGate = defer<void>()
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({
          title: "Tool continuation before steer",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        const rootID = MessageID.ascending()
        const steerID = MessageID.ascending()
        const steerText = "旧工具续跑后再处理这条引导"

        yield* llm.push(
          reply()
            .wait(toolGate.promise)
            .tool("bash", {
              command: "printf 'tool-output'",
              description: "Produce output before compaction",
              timeout: 5_000,
              workdir: path.resolve(dir),
            })
            .usage({ input: 95_000, output: 1 }),
        )
        yield* llm.text("steer after canceled tool plan")

        const active = yield* prompt
          .prompt({
            sessionID: chat.id,
            messageID: rootID,
            agent: "build",
            model: ref,
            parts: [{ type: "text", text: "执行旧工具步骤" }],
          })
          .pipe(Effect.forkChild)
        yield* llm.wait(1)
        yield* prompt.steer({
          sessionID: chat.id,
          messageID: steerID,
          targetTurnID: rootID,
          agent: "build",
          model: ref,
          parts: [{ type: "text", text: steerText }],
        })
        toolGate.resolve()
        expect(Exit.isSuccess(yield* Fiber.await(active))).toBe(true)
        expect(yield* llm.calls).toBe(2)

        const inputs = yield* llm.inputs
        const summaryIndex = inputs.findIndex((input) => JSON.stringify(input).includes("Create a new anchored summary"))
        const continuationIndex = inputs.findIndex((input) =>
          JSON.stringify(input).includes("Continue if you have next steps"),
        )
        const steerIndex = inputs.findIndex((input) => JSON.stringify(input).includes(steerText))
        expect(summaryIndex).toBe(-1)
        expect(continuationIndex).toBe(-1)
        expect(steerIndex).toBeGreaterThan(-1)

        const messages = yield* sessions.messages({ sessionID: chat.id })
        const steerReply = messages.find(
          (message) =>
            message.info.role === "assistant" &&
            message.parts.some((part) => part.type === "text" && part.text === "steer after canceled tool plan"),
        )
        expect(steerReply?.info.role === "assistant" ? steerReply.info.parentID : undefined).toBe(steerID)
        expect(
          steerReply?.info.role === "assistant" ? (steerReply.info.completedUserMessageIDs ?? []) : [],
        ).toContain(steerID)
      }),
      { config: providerCfg },
    ),
  10_000,
)

// 工具已经进入 running 后可能产生真实外部副作用；steer 只能等待它收尾，不能把它当模型采样直接取消。
it.live(
  "keeps an already running tool alive when steer is accepted",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ dir, llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({
          title: "Running tool steer boundary",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        const rootID = MessageID.ascending()
        const steerID = MessageID.ascending()

        yield* llm.tool("bash", {
          command: "sleep 0.5; printf 'tool-finished'",
          description: "Keep the tool running across steer ACK",
          timeout: 5_000,
          workdir: path.resolve(dir),
        })
        yield* llm.text("steered after running tool")

        const active = yield* prompt
          .prompt({
            sessionID: chat.id,
            messageID: rootID,
            agent: "build",
            model: ref,
            parts: [{ type: "text", text: "先运行工具" }],
          })
          .pipe(Effect.forkChild)
        yield* llm.wait(1)

        let running = false
        for (let index = 0; index < 200; index++) {
          const messages = yield* sessions.messages({ sessionID: chat.id })
          running = messages.some((message) =>
            message.parts.some((part) => part.type === "tool" && part.state.status === "running"),
          )
          if (running) break
          yield* Effect.sleep("5 millis")
        }
        expect(running).toBe(true)

        expect(
          yield* prompt.steer({
            sessionID: chat.id,
            messageID: steerID,
            targetTurnID: rootID,
            agent: "build",
            model: ref,
            parts: [{ type: "text", text: "工具完成后按引导继续" }],
          }),
        ).toEqual({ messageID: steerID, targetTurnID: rootID })
        expect(Exit.isSuccess(yield* Fiber.await(active))).toBe(true)

        const messages = yield* sessions.messages({ sessionID: chat.id })
        const tool = messages.flatMap((message) => message.parts).find((part) => part.type === "tool")
        if (!tool || tool.type !== "tool") throw new Error("expected completed tool")
        expect(tool.state.status).toBe("completed")
        const steerReply = messages.find(
          (message) =>
            message.info.role === "assistant" &&
            message.parts.some((part) => part.type === "text" && part.text === "steered after running tool"),
        )
        expect(steerReply?.info.role === "assistant" ? steerReply.info.parentID : undefined).toBe(steerID)
        expect(yield* llm.calls).toBe(2)
      }),
      { config: providerCfg },
    ),
  10_000,
)

// 工具中间步虽然已有 completed 时间，但仍属于同一 active turn；只有最终 assistant 才能消费引导队列。
unix(
  "keeps steer completion metadata off intermediate tool steps",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ dir, llm }) {
        const gate = defer<void>()
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({
          title: "Steer tool completion",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })

        yield* llm.hold("first", gate.promise)
        yield* llm.tool("bash", {
          command: "sleep 1",
          description: "Wait before the final steer response",
          timeout: 5_000,
          workdir: path.resolve(dir),
        })
        yield* llm.text("final steer response")

        const firstUserID = MessageID.ascending()
        const first = yield* prompt
          .prompt({
            sessionID: chat.id,
            messageID: firstUserID,
            agent: "build",
            model: ref,
            parts: [{ type: "text", text: "first" }],
          })
          .pipe(Effect.forkChild)

        yield* llm.wait(1)
        const steerID = MessageID.ascending()
        yield* prompt.steer({
          sessionID: chat.id,
          messageID: steerID,
          targetTurnID: firstUserID,
          agent: "build",
          model: ref,
          parts: [{ type: "text", text: "继续并等待工具完成" }],
        })

        gate.resolve()
        yield* llm.wait(2)

        const duringTool = yield* sessions.messages({ sessionID: chat.id })
        const intermediate = duringTool.find(
          (message) => message.info.role === "assistant" && message.info.parentID === steerID,
        )
        if (!intermediate || intermediate.info.role !== "assistant") throw new Error("expected steer tool assistant")
        expect(intermediate.info.completedUserMessageIDs).toEqual([])

        const exit = yield* Fiber.await(first)
        expect(Exit.isSuccess(exit)).toBe(true)
        const messages = yield* sessions.messages({ sessionID: chat.id })
        const latest = messages.findLast((message) => message.info.role === "assistant")
        if (!latest || latest.info.role !== "assistant") throw new Error("expected final steer assistant")
        expect(latest.info.finish).toBe("stop")
        expect(latest.info.completedUserMessageIDs).toContain(steerID)
      }),
      { config: providerCfg },
    ),
  10_000,
)

// Q 虽然更早落库，但不属于 A 的活动回合；A 的工具中间步和随后接入的 S 都不能吞掉或提前看到 Q。
unix(
  "keeps an earlier normal queue isolated across an active tool step and steer",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ dir, llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({
          title: "Tool steer queue isolation",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        const queuedText = "queued-before-tool-active"
        const activeText = "active-root-with-tool"
        const steerText = "steer-during-active-tool"

        yield* llm.tool("bash", {
          command: "sleep 1",
          description: "Keep the active tool step open for steering",
          timeout: 5_000,
          workdir: path.resolve(dir),
        })
        yield* llm.text("steered tool response")
        yield* llm.text("queued response after steer")

        const queuedID = MessageID.ascending()
        yield* prompt.prompt({
          sessionID: chat.id,
          messageID: queuedID,
          agent: "build",
          model: ref,
          noReply: true,
          parts: [{ type: "text", text: queuedText }],
        })

        const runningTool = yield* listenForToolPart(
          chat.id,
          (part) => part.tool === "bash" && part.state.status === "running",
        )
        const activeID = MessageID.ascending()
        const active = yield* prompt
          .prompt({
            sessionID: chat.id,
            messageID: activeID,
            agent: "build",
            model: ref,
            parts: [{ type: "text", text: activeText }],
          })
          .pipe(Effect.forkChild)

        yield* Deferred.await(runningTool).pipe(Effect.timeout("5 seconds"))
        const steerID = MessageID.ascending()
        const ack = yield* prompt.steer({
          sessionID: chat.id,
          messageID: steerID,
          targetTurnID: activeID,
          agent: "build",
          model: ref,
          parts: [{ type: "text", text: steerText }],
        })
        expect(ack).toEqual({ messageID: steerID, targetTurnID: activeID })

        expect(Exit.isSuccess(yield* Fiber.await(active))).toBe(true)
        expect(yield* llm.calls).toBe(3)

        const inputs = (yield* llm.inputs).filter((input) =>
          [queuedText, activeText, steerText].some((text) => JSON.stringify(input.messages).includes(text)),
        )
        expect(inputs).toHaveLength(3)
        const activeInput = JSON.stringify(inputs[0]?.messages)
        const steerInput = JSON.stringify(inputs[1]?.messages)
        const queuedInput = JSON.stringify(inputs[2]?.messages)
        expect(activeInput).toContain(activeText)
        expect(activeInput).not.toContain(queuedText)
        expect(activeInput).not.toContain(steerText)
        expect(steerInput).toContain(activeText)
        expect(steerInput).toContain(steerText)
        expect(steerInput).not.toContain(queuedText)
        expect(queuedInput).toContain(queuedText)

        const messages = yield* sessions.messages({ sessionID: chat.id })
        const intermediate = messages.find(
          (message) =>
            message.info.role === "assistant" &&
            message.parts.some((part) => part.type === "tool" && part.tool === "bash"),
        )
        expect(intermediate?.info.role === "assistant" ? intermediate.info.completedUserMessageIDs : undefined).toEqual(
          [],
        )
        const steered = messages.find(
          (message) =>
            message.info.role === "assistant" &&
            message.parts.some((part) => part.type === "text" && part.text === "steered tool response"),
        )
        const queued = messages.find(
          (message) =>
            message.info.role === "assistant" &&
            message.parts.some((part) => part.type === "text" && part.text === "queued response after steer"),
        )
        if (!steered || steered.info.role !== "assistant") throw new Error("expected steered tool response")
        if (!queued || queued.info.role !== "assistant") throw new Error("expected queued response")
        expect(steered.info.parentID).toBe(steerID)
        // steer 留在活动回合，普通队列在其完成后以自身消息 ID 开启独立回合。
        expect(steered.info.turnID).toBe(activeID)
        expect(new Set(steered.info.completedUserMessageIDs)).toEqual(new Set([activeID, steerID]))
        expect(steered.info.completedUserMessageIDs).not.toContain(queuedID)
        expect(queued.info.parentID).toBe(queuedID)
        expect(queued.info.turnID).toBe(queuedID)
        expect(messages.indexOf(queued)).toBeGreaterThan(messages.indexOf(steered))
      }),
      { config: providerCfg },
    ),
  15_000,
)

// 重启/事件交错后，已写 completed 的工具步骤仍不能越过其 steer parent；后面的普通队列必须继续等待。
it.live(
  "resumes a steer before the normal queue after an intermediate tool step",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({
          title: "Steer high-water",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })

        const steer = yield* prompt.prompt({
          sessionID: chat.id,
          agent: "build",
          model: ref,
          noReply: true,
          parts: [
            { type: "text", text: "先处理这条引导" },
            {
              type: "text",
              text: "manual steer",
              synthetic: true,
              metadata: { manual_steer_context: true },
            },
          ],
        })
        const intermediate = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "assistant",
          parentID: steer.info.id,
          sessionID: chat.id,
          mode: "build",
          agent: "build",
          cost: 0,
          path: { cwd: "/tmp", root: "/tmp" },
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: ref.modelID,
          providerID: ref.providerID,
          time: { created: Date.now(), completed: Date.now() },
          finish: "tool-calls",
        })
        yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID: intermediate.id,
          sessionID: chat.id,
          type: "tool",
          callID: "intermediate_tool_1",
          tool: "first",
          state: {
            status: "completed",
            input: { value: "first" },
            output: "done",
            title: "done",
            metadata: {},
            time: { start: Date.now(), end: Date.now() },
          },
        })
        const queued = yield* user(chat.id, "再处理普通队列")

        yield* llm.text("steer response")
        yield* llm.text("queued response")
        yield* prompt.loop({ sessionID: chat.id })

        expect(yield* llm.calls).toBe(2)
        const messages = yield* sessions.messages({ sessionID: chat.id })
        const generated = messages.filter(
          (message) => message.info.role === "assistant" && message.info.id !== intermediate.id,
        )
        expect(generated).toHaveLength(2)
        expect(generated[0]?.info.role === "assistant" ? generated[0].info.parentID : undefined).toBe(steer.info.id)
        expect(generated[1]?.info.role === "assistant" ? generated[1].info.parentID : undefined).toBe(queued.id)
      }),
      { config: providerCfg },
    ),
  5_000,
)

// promptAsync 发布权威 turnID 后，S 才能接入已经采样的 A；更早的普通队列 Q 必须等 A/S 完整结束。
unix(
  "keeps the scheduled active root after publishing its authoritative turn ID",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const gate = defer<void>()
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const status = yield* SessionStatus.Service
        const chat = yield* sessions.create({ title: "Initial steer root" })

        yield* llm.hold("active response", gate.promise)
        yield* llm.text("steered response")
        yield* llm.text("queued response")

        const queuedID = MessageID.ascending()
        yield* prompt.prompt({
          sessionID: chat.id,
          messageID: queuedID,
          agent: "build",
          model: ref,
          noReply: true,
          parts: [{ type: "text", text: "queued-before-active" }],
        })

        const activeID = MessageID.ascending()
        const active = yield* prompt.promptAsync({
          sessionID: chat.id,
          messageID: activeID,
          agent: "build",
          model: ref,
          parts: [{ type: "text", text: "scheduled-active-root" }],
        })
        expect(active.info.id).toBe(activeID)

        // 客户端只在服务端发布权威活动回合后发送 steer，避免把 runner 尚未登记的瞬时窗口当成可引导状态。
        yield* Effect.promise(async () => {
          const deadline = Date.now() + 5_000
          while (Date.now() < deadline) {
            const current = await Effect.runPromise(status.get(chat.id))
            if ((current.type === "busy" || current.type === "retry") && current.turnID === activeID) return
            await new Promise((resolve) => setTimeout(resolve, 20))
          }
          throw new Error("timed out waiting for the scheduled active turn")
        })
        yield* llm.wait(1)

        const steerID = MessageID.ascending()
        const ack = yield* prompt.steer({
          sessionID: chat.id,
          messageID: steerID,
          targetTurnID: activeID,
          agent: "build",
          model: ref,
          parts: [{ type: "text", text: "initial-snapshot-steer" }],
        })
        expect(ack.messageID).toBe(steerID)
        gate.resolve()

        yield* llm.wait(3)
        yield* Effect.promise(async () => {
          const deadline = Date.now() + 5_000
          while (Date.now() < deadline) {
            const messages = await Effect.runPromise(sessions.messages({ sessionID: chat.id }))
            const assistants = messages.filter((message) => message.info.role === "assistant")
            if (
              assistants.length === 3 &&
              assistants.every(
                (message) => "completed" in message.info.time && typeof message.info.time.completed === "number",
              )
            )
              return
            await new Promise((resolve) => setTimeout(resolve, 20))
          }
          throw new Error("timed out waiting for steered and queued assistants")
        })

        const inputs = (yield* llm.inputs).filter((input) =>
          ["queued-before-active", "scheduled-active-root", "initial-snapshot-steer"].some((text) =>
            JSON.stringify(input).includes(text),
          ),
        )
        expect(inputs).toHaveLength(3)
        const firstInput = JSON.stringify(inputs[0]?.messages)
        const steerInput = JSON.stringify(inputs[1]?.messages)
        expect(firstInput).toContain("scheduled-active-root")
        expect(firstInput).not.toContain("initial-snapshot-steer")
        expect(firstInput).not.toContain("queued-before-active")
        expect(steerInput).toContain("scheduled-active-root")
        expect(steerInput).toContain("initial-snapshot-steer")
        expect(steerInput).not.toContain("queued-before-active")

        const messages = yield* sessions.messages({ sessionID: chat.id })
        const assistants = messages.filter((message) => message.info.role === "assistant")
        const steered = assistants.find((message) =>
          message.parts.some((part) => part.type === "text" && part.text === "steered response"),
        )
        const queued = assistants.find((message) =>
          message.parts.some((part) => part.type === "text" && part.text === "queued response"),
        )
        if (!steered || steered.info.role !== "assistant") throw new Error("expected steered assistant")
        if (!queued || queued.info.role !== "assistant") throw new Error("expected queued assistant")
        expect(steered.info.parentID).toBe(steerID)
        expect(new Set(steered.info.completedUserMessageIDs)).toEqual(new Set([activeID, steerID]))
        expect(queued.info.parentID).toBe(queuedID)
      }),
      { config: providerCfg },
    ),
  5_000,
)

// Q 被排除在 A 的 overflow compaction 之外时，压缩边界仍必须保留 Q；S 完成后再独立执行 Q。
it.live(
  "preserves an older queue across active overflow compaction and steer",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const compactionGate = defer<void>()
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Overflow compaction queue isolation" })
        const queuedText = "queued-before-overflow-compaction"
        const activeText = "active-request-that-overflows"
        const steerText = "steer-after-overflow-compaction-starts"

        yield* llm.error(400, { type: "error", error: { code: "context_length_exceeded" } })
        yield* llm.pushMatch(
          (hit) => JSON.stringify(hit.body).includes("Create a new anchored summary"),
          reply().wait(compactionGate.promise).text("summary without deferred queue").stop(),
        )
        yield* llm.text("steered after compaction")
        yield* llm.text("queued independently after steer")

        const queuedID = MessageID.ascending()
        yield* prompt.prompt({
          sessionID: chat.id,
          messageID: queuedID,
          agent: "build",
          model: ref,
          noReply: true,
          parts: [{ type: "text", text: queuedText }],
        })

        const activeID = MessageID.ascending()
        const active = yield* prompt
          .prompt({
            sessionID: chat.id,
            messageID: activeID,
            agent: "build",
            model: ref,
            parts: [{ type: "text", text: activeText }],
          })
          .pipe(Effect.forkChild)

        // 等摘要请求真正开始后再引导，覆盖 Q 已从 compaction snapshot 排除、但边界尚未最终落库的窗口。
        yield* Effect.promise(async () => {
          const deadline = Date.now() + 5_000
          while (Date.now() < deadline) {
            const inputs = await Effect.runPromise(llm.inputs)
            if (inputs.some((input) => JSON.stringify(input).includes("Create a new anchored summary"))) return
            await new Promise((resolve) => setTimeout(resolve, 20))
          }
          throw new Error("timed out waiting for overflow compaction")
        })

        const steerID = MessageID.ascending()
        yield* prompt.steer({
          sessionID: chat.id,
          messageID: steerID,
          targetTurnID: activeID,
          agent: "build",
          model: ref,
          parts: [{ type: "text", text: steerText }],
        })
        compactionGate.resolve()

        const exit = yield* Fiber.await(active)
        expect(Exit.isSuccess(exit)).toBe(true)

        const inputs = yield* llm.inputs
        const summaryInput = inputs.find((input) => JSON.stringify(input).includes("Create a new anchored summary"))
        const steerInput = inputs.find((input) => JSON.stringify(input).includes(steerText))
        const queuedInputs = inputs.filter((input) => JSON.stringify(input).includes(queuedText))
        expect(JSON.stringify(summaryInput)).not.toContain(queuedText)
        expect(JSON.stringify(steerInput)).not.toContain(queuedText)
        expect(queuedInputs).toHaveLength(1)

        const messages = yield* sessions.messages({ sessionID: chat.id })
        const compactionPart = messages
          .flatMap((message) => message.parts)
          .find((part): part is MessageV2.CompactionPart => part.type === "compaction")
        const steered = messages.find(
          (message) =>
            message.info.role === "assistant" &&
            message.parts.some((part) => part.type === "text" && part.text === "steered after compaction"),
        )
        const queued = messages.find(
          (message) =>
            message.info.role === "assistant" &&
            message.parts.some((part) => part.type === "text" && part.text === "queued independently after steer"),
        )
        if (!steered || steered.info.role !== "assistant") throw new Error("expected steered assistant")
        if (!queued || queued.info.role !== "assistant") throw new Error("expected queued assistant")
        expect(compactionPart?.tail_start_id).toBe(queuedID)
        expect(steered.info.parentID).toBe(steerID)
        expect(steered.info.completedUserMessageIDs).not.toContain(queuedID)
        expect(queued.info.parentID).toBe(queuedID)
        expect(messages.indexOf(queued)).toBeGreaterThan(messages.indexOf(steered))

        const filtered = yield* MessageV2.filterCompactedEffect(chat.id)
        expect(filtered.some((message) => message.info.id === queuedID)).toBe(true)
      }),
      { config: providerCfg },
    ),
  10_000,
)

// Q 早于 A 落库且 A 已经开始首轮采样时，后到的 S 只能接入 A；Q 必须留到 A/S 完整结束后独立回答。
unix(
  "keeps an earlier noReply queue outside an already sampled active root and its steer",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const gate = defer<void>()
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Sampled active root isolation" })
        const queuedText = "queued-before-sampled-active"
        const activeText = "already-sampled-active-root"
        const steerText = "steer-the-sampled-active-root"

        yield* llm.hold("active root response", gate.promise)
        yield* llm.text("steered active response")
        yield* llm.text("queued independent response")

        const queuedID = MessageID.ascending()
        yield* prompt.prompt({
          sessionID: chat.id,
          messageID: queuedID,
          agent: "build",
          model: ref,
          noReply: true,
          parts: [{ type: "text", text: queuedText }],
        })

        const activeID = MessageID.ascending()
        const active = yield* prompt
          .prompt({
            sessionID: chat.id,
            messageID: activeID,
            agent: "build",
            model: ref,
            parts: [{ type: "text", text: activeText }],
          })
          .pipe(Effect.forkChild)

        // 必须等 A 的模型请求已经发出后再提交 S，覆盖 initial snapshot 之后的真实竞态窗口。
        yield* llm.wait(1)
        const steerID = MessageID.ascending()
        const ack = yield* prompt.steer({
          sessionID: chat.id,
          messageID: steerID,
          targetTurnID: activeID,
          agent: "build",
          model: ref,
          parts: [{ type: "text", text: steerText }],
        })
        expect(ack).toEqual({ messageID: steerID, targetTurnID: activeID })

        gate.resolve()
        const exit = yield* Fiber.await(active)
        expect(Exit.isSuccess(exit)).toBe(true)

        const inputs = (yield* llm.inputs).filter((input) =>
          [queuedText, activeText, steerText].some((text) => JSON.stringify(input.messages).includes(text)),
        )
        expect(inputs).toHaveLength(3)
        const activeInput = JSON.stringify(inputs[0]?.messages)
        const steerInput = JSON.stringify(inputs[1]?.messages)
        expect(activeInput).toContain(activeText)
        expect(activeInput).not.toContain(queuedText)
        expect(activeInput).not.toContain(steerText)
        expect(steerInput).toContain(activeText)
        expect(steerInput).toContain(steerText)
        expect(steerInput).not.toContain(queuedText)

        const messages = yield* sessions.messages({ sessionID: chat.id })
        const assistants = messages.filter((message) => message.info.role === "assistant")
        const steered = assistants.find((message) =>
          message.parts.some((part) => part.type === "text" && part.text === "steered active response"),
        )
        const queued = assistants.find((message) =>
          message.parts.some((part) => part.type === "text" && part.text === "queued independent response"),
        )
        if (!steered || steered.info.role !== "assistant") throw new Error("expected steered assistant")
        if (!queued || queued.info.role !== "assistant") throw new Error("expected queued assistant")
        expect(steered.info.parentID).toBe(steerID)
        expect(new Set(steered.info.completedUserMessageIDs)).toEqual(new Set([activeID, steerID]))
        expect(steered.info.completedUserMessageIDs).not.toContain(queuedID)
        expect(queued.info.parentID).toBe(queuedID)
        expect(messages.indexOf(queued)).toBeGreaterThan(messages.indexOf(steered))
      }),
      { config: providerCfg },
    ),
  10_000,
)

// Q 自带 subtask 时也必须服从 active root 边界：既不能抢在 A 首次采样前，也不能越过随后接入的 S。
unix(
  "defers an earlier queued subtask until the sampled active root and steer finish",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const gate = defer<void>()
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const registry = yield* ToolRegistry.Service
        const { task } = yield* registry.named()
        const original = task.execute
        let taskContext: MessageV2.WithParts[] | undefined
        task.execute = (_args, ctx) => {
          taskContext = ctx.messages
          return Effect.succeed({
            title: "queued subtask",
            metadata: { sessionId: SessionID.make("queued-subtask"), model: ref },
            output: "queued subtask result",
          })
        }
        yield* Effect.addFinalizer(() => Effect.sync(() => void (task.execute = original)))

        const chat = yield* sessions.create({ title: "Queued subtask active root isolation" })
        const queuedText = "queued-subtask-before-active"
        const activeText = "active-root-before-queued-subtask"
        const steerText = "steer-before-queued-subtask"

        yield* llm.hold("active root response", gate.promise)
        yield* llm.text("steered active response")
        yield* llm.text("queued subtask response")

        const queued = yield* user(chat.id, queuedText)
        yield* addSubtask(chat.id, queued.id)

        const activeID = MessageID.ascending()
        const active = yield* prompt
          .prompt({
            sessionID: chat.id,
            messageID: activeID,
            agent: "build",
            model: ref,
            parts: [{ type: "text", text: activeText }],
          })
          .pipe(Effect.forkChild)

        // 首个 LLM 调用必须属于 A；旧 Q 的 subtask 若先执行，这里捕获到的将是 Q 的工具回灌。
        yield* llm.wait(1)
        const steerID = MessageID.ascending()
        yield* prompt.steer({
          sessionID: chat.id,
          messageID: steerID,
          targetTurnID: activeID,
          agent: "build",
          model: ref,
          parts: [{ type: "text", text: steerText }],
        })

        gate.resolve()
        const exit = yield* Fiber.await(active)
        expect(Exit.isSuccess(exit)).toBe(true)

        const inputs = (yield* llm.inputs).filter((input) =>
          [queuedText, activeText, steerText].some((text) => JSON.stringify(input.messages).includes(text)),
        )
        expect(inputs).toHaveLength(3)
        const activeInput = JSON.stringify(inputs[0]?.messages)
        const steerInput = JSON.stringify(inputs[1]?.messages)
        expect(activeInput).toContain(activeText)
        expect(activeInput).not.toContain(queuedText)
        expect(activeInput).not.toContain("look into the cache key path")
        expect(steerInput).toContain(steerText)
        expect(steerInput).not.toContain(queuedText)
        expect(steerInput).not.toContain("look into the cache key path")
        expect(taskContext?.map((message) => message.info.id)).toEqual([queued.id])

        const messages = yield* sessions.messages({ sessionID: chat.id })
        const steered = messages.find(
          (message) =>
            message.info.role === "assistant" &&
            message.parts.some((part) => part.type === "text" && part.text === "steered active response"),
        )
        const taskAssistant = messages.find(
          (message) => message.info.role === "assistant" && message.info.agent === "general",
        )
        const queuedAssistant = messages.find((message) =>
          message.parts.some((part) => part.type === "text" && part.text === "queued subtask response"),
        )
        if (!steered || steered.info.role !== "assistant") throw new Error("expected steered assistant")
        if (!taskAssistant || taskAssistant.info.role !== "assistant") throw new Error("expected task assistant")
        if (!queuedAssistant || queuedAssistant.info.role !== "assistant") throw new Error("expected queued assistant")
        expect(new Set(steered.info.completedUserMessageIDs)).toEqual(new Set([activeID, steerID]))
        expect(steered.info.completedUserMessageIDs).not.toContain(queued.id)
        expect(taskAssistant.info.parentID).toBe(queued.id)
        expect(queuedAssistant.info.parentID).toBe(queued.id)
        expect(messages.indexOf(taskAssistant)).toBeGreaterThan(messages.indexOf(steered))
        expect(messages.indexOf(queuedAssistant)).toBeGreaterThan(messages.indexOf(taskAssistant))
      }),
      { config: providerCfg },
    ),
  10_000,
)

// 覆盖引导最容易丢失的收尾窗口：noReply user 在第一轮 stop 前落库时，runner 必须自动续跑同一条消息。
it.live(
  "continues a noReply steer inserted before the active runner stops",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const gate = defer<void>()
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Steer ordering" })

        yield* llm.hold("first", gate.promise)
        yield* llm.text("steer response")

        const firstUserID = MessageID.ascending()
        const first = yield* prompt
          .prompt({
            sessionID: chat.id,
            messageID: firstUserID,
            agent: "build",
            model: ref,
            parts: [{ type: "text", text: "first" }],
          })
          .pipe(Effect.forkChild)

        yield* llm.wait(1)
        const steerID = MessageID.ascending()
        yield* prompt.prompt({
          sessionID: chat.id,
          messageID: steerID,
          agent: "build",
          model: ref,
          noReply: true,
          parts: [{ type: "text", text: "继续处理" }],
        })

        gate.resolve()
        const exit = yield* Fiber.await(first)
        expect(Exit.isSuccess(exit)).toBe(true)
        expect(yield* llm.calls).toBe(2)

        const messages = yield* sessions.messages({ sessionID: chat.id })
        const users = messages.filter((message) => message.info.role === "user")
        const assistants = messages.filter((message) => message.info.role === "assistant")
        expect(users.filter((message) => message.info.id === steerID)).toHaveLength(1)
        expect(assistants).toHaveLength(2)
        const last = assistants.at(-1)
        if (!last || last.info.role !== "assistant") throw new Error("expected steer assistant")
        expect(last.info.parentID).toBe(steerID)
      }),
      { config: providerCfg },
    ),
  5_000,
)

// 连续点击“引导”时，所有 user 消息都应各写入一次，收尾由最新 parent 的 high-water 回复覆盖前面的引导。
it.live(
  "merges consecutive steers without creating duplicate user turns",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const gate = defer<void>()
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Consecutive steers" })

        yield* llm.hold("first", gate.promise)
        yield* llm.text("merged steer response")

        const firstUserID = MessageID.ascending()
        const first = yield* prompt
          .prompt({
            sessionID: chat.id,
            messageID: firstUserID,
            agent: "build",
            model: ref,
            parts: [{ type: "text", text: "first" }],
          })
          .pipe(Effect.forkChild)

        yield* llm.wait(1)
        const firstSteerID = MessageID.ascending()
        const secondSteerID = MessageID.ascending()
        const thirdSteerID = MessageID.ascending()
        // 连续引导必须走独立 steer 入口；每条 ACK 依次落库后仍复用同一个 active runner。
        const firstAck = yield* prompt.steer({
          sessionID: chat.id,
          messageID: firstSteerID,
          targetTurnID: firstUserID,
          agent: "build",
          model: ref,
          parts: [{ type: "text", text: "引导一" }],
        })
        const secondAck = yield* prompt.steer({
          sessionID: chat.id,
          messageID: secondSteerID,
          targetTurnID: firstUserID,
          agent: "build",
          model: ref,
          parts: [{ type: "text", text: "引导二" }],
        })
        const thirdAck = yield* prompt.steer({
          sessionID: chat.id,
          messageID: thirdSteerID,
          targetTurnID: firstUserID,
          agent: "build",
          model: ref,
          parts: [{ type: "text", text: "引导三" }],
        })
        expect(firstAck.messageID).toBe(firstSteerID)
        expect(secondAck.messageID).toBe(secondSteerID)
        expect(thirdAck.messageID).toBe(thirdSteerID)

        gate.resolve()
        const exit = yield* Fiber.await(first)
        expect(Exit.isSuccess(exit)).toBe(true)
        expect(yield* llm.calls).toBe(2)

        const inputs = yield* llm.inputs
        const steeredInput = JSON.stringify(inputs[1]?.messages)
        // 一次合并回复可以覆盖多条连续引导，但模型输入必须按用户提交顺序包含每一条，不能只保留最新一条。
        expect(steeredInput.indexOf("引导一")).toBeLessThan(steeredInput.indexOf("引导二"))
        expect(steeredInput.indexOf("引导二")).toBeLessThan(steeredInput.indexOf("引导三"))

        const messages = yield* sessions.messages({ sessionID: chat.id })
        const users = messages.filter((message) => message.info.role === "user")
        const assistants = messages.filter((message) => message.info.role === "assistant")
        expect(users).toHaveLength(4)
        expect(users.map((message) => message.info.id)).toEqual([
          users[0]?.info.id,
          firstSteerID,
          secondSteerID,
          thirdSteerID,
        ])
        expect(assistants).toHaveLength(2)
        const last = assistants.at(-1)
        if (!last || last.info.role !== "assistant") throw new Error("expected merged steer assistant")
        expect(last.info.parentID).toBe(thirdSteerID)
        // 终态水位必须精确覆盖本次真正送入模型的四条用户消息，避免稍后的普通队列被位置关系误判为已回答。
        expect(new Set(last.info.completedUserMessageIDs)).toEqual(
          new Set([firstUserID, firstSteerID, secondSteerID, thirdSteerID]),
        )
      }),
      { config: providerCfg },
    ),
  5_000,
)

it.live(
  "assertNotBusy throws BusyError when loop running",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const run = yield* SessionRunState.Service
        const sessions = yield* Session.Service
        yield* llm.hang

        const chat = yield* sessions.create({})
        yield* user(chat.id, "hi")

        const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* llm.wait(1)

        const exit = yield* run.assertNotBusy(chat.id).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.squash(exit.cause)).toBeInstanceOf(Session.BusyError)
        }

        yield* prompt.cancel(chat.id)
        yield* Fiber.await(fiber)
      }),
      { config: providerCfg },
    ),
  30_000,
)

it.live("assertNotBusy succeeds when idle", () =>
  provideTmpdirInstance(
    (_dir) =>
      Effect.gen(function* () {
        const run = yield* SessionRunState.Service
        const sessions = yield* Session.Service

        const chat = yield* sessions.create({})
        const exit = yield* run.assertNotBusy(chat.id).pipe(Effect.exit)
        expect(Exit.isSuccess(exit)).toBe(true)
      }),
    {},
  ),
)

// Shell semantics

unix(
  "shell rejects with BusyError when loop running",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Pinned" })
        yield* llm.hang
        yield* user(chat.id, "hi")

        const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* llm.wait(1)

        const exit = yield* prompt.shell({ sessionID: chat.id, agent: "build", command: "echo hi" }).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.squash(exit.cause)).toBeInstanceOf(Session.BusyError)
        }

        yield* prompt.cancel(chat.id)
        yield* Fiber.await(fiber)
      }),
      { config: providerCfg },
    ),
  5_000,
)

unix("shell captures stdout and stderr in completed tool output", () =>
  provideTmpdirInstance(
    (_dir) =>
      Effect.gen(function* () {
        const { prompt, run, sessions, chat } = yield* boot()
        const result = yield* prompt.shell({
          sessionID: chat.id,
          agent: "build",
          command: "printf out && printf err >&2",
        })

        expect(result.info.role).toBe("assistant")
        const tool = completedTool(result.parts)
        if (!tool) return

        expect(tool.state.output).toContain("out")
        expect(tool.state.output).toContain("err")
        expect(tool.state.metadata.output).toContain("out")
        expect(tool.state.metadata.output).toContain("err")
        const userMessage = (yield* sessions.messages({ sessionID: chat.id })).find(
          (message) => message.info.role === "user",
        )
        // Shell 用户消息与工具结果共享自身 ID，同时不会借用之前对话的活动回合。
        expect(userMessage?.info.turnID).toBe(userMessage?.info.id)
        expect(result.info.turnID).toBe(userMessage?.info.id)
        yield* run.assertNotBusy(chat.id)
      }),
    { config: cfg },
  ),
)

unix("shell decodes GB18030 byte output", () =>
  provideTmpdirInstance(
    (_dir) =>
      Effect.gen(function* () {
        const { prompt, run, chat } = yield* boot()
        const result = yield* prompt.shell({
          sessionID: chat.id,
          agent: "build",
          command: byteOutputCommand([0x70, 0x61, 0x74, 0x68, 0x3a, 0x20, 0xc2, 0xb7, 0xbe, 0xb6]),
        })

        const tool = completedTool(result.parts)
        if (!tool) return

        expect(tool.state.output).toContain("path: 路径")
        expect(tool.state.metadata.output).toContain("path: 路径")
        yield* run.assertNotBusy(chat.id)
      }),
    { config: cfg },
  ),
)

unix("shell decodes GB18030 filename list output", () =>
  provideTmpdirInstance(
    (_dir) =>
      Effect.gen(function* () {
        const { prompt, run, chat } = yield* boot()
        const result = yield* prompt.shell({
          sessionID: chat.id,
          agent: "build",
          command: byteOutputCommand([
            0x64, 0x61, 0x69, 0x6c, 0x79, 0x2e, 0x6a, 0x73, 0x6f, 0x6e, 0x20, 0xd6, 0xd0, 0xce, 0xc4, 0xce, 0xc4, 0xbc,
            0xfe, 0xc3, 0xfb, 0x20, 0xb2, 0xe2, 0xca, 0xd4, 0x2e, 0x6d, 0x64,
          ]),
        })

        const tool = completedTool(result.parts)
        if (!tool) return

        expect(tool.state.output).toContain("daily.json 中文文件名 测试.md")
        expect(tool.state.metadata.output).toContain("daily.json 中文文件名 测试.md")
        yield* run.assertNotBusy(chat.id)
      }),
    { config: cfg },
  ),
)

unix("shell completes a fast command on the preferred shell", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { prompt, run, chat } = yield* boot()
        const result = yield* prompt.shell({
          sessionID: chat.id,
          agent: "build",
          command: "pwd",
        })

        expect(result.info.role).toBe("assistant")
        const tool = completedTool(result.parts)
        if (!tool) return

        expect(tool.state.input.command).toBe("pwd")
        expect(tool.state.output).toContain(dir)
        expect(tool.state.metadata.output).toContain(dir)
        yield* run.assertNotBusy(chat.id)
      }),
    { config: cfg },
  ),
)

unix(
  "shell uses configured shell over env shell",
  () =>
    withSh(() =>
      provideTmpdirInstance(
        (_dir) =>
          Effect.gen(function* () {
            if (!Bun.which("bash")) return

            const { prompt, chat } = yield* boot()
            const result = yield* prompt.shell({
              sessionID: chat.id,
              agent: "build",
              command: "[[ 1 -eq 1 ]] && printf configured",
            })

            const tool = completedTool(result.parts)
            if (!tool) return
            expect(tool.state.output).toContain("configured")
          }),
        { config: { ...cfg, shell: "bash" } },
      ),
    ),
  30_000,
)

unix("shell commands can change directory after startup", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { prompt, run, chat } = yield* boot()
        const parent = path.dirname(dir)
        const result = yield* prompt.shell({
          sessionID: chat.id,
          agent: "build",
          command: "cd .. && pwd",
        })

        expect(result.info.role).toBe("assistant")
        const tool = completedTool(result.parts)
        if (!tool) return

        expect(tool.state.output).toContain(parent)
        expect(tool.state.metadata.output).toContain(parent)
        yield* run.assertNotBusy(chat.id)
      }),
    { config: cfg },
  ),
)

unix("shell lists files from the project directory", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { prompt, run, chat } = yield* boot()
        yield* Effect.promise(() => Bun.write(path.join(dir, "README.md"), "# e2e\n"))

        const result = yield* prompt.shell({
          sessionID: chat.id,
          agent: "build",
          command: "command ls",
        })

        expect(result.info.role).toBe("assistant")
        const tool = completedTool(result.parts)
        if (!tool) return

        expect(tool.state.input.command).toBe("command ls")
        expect(tool.state.output).toContain("README.md")
        expect(tool.state.metadata.output).toContain("README.md")
        yield* run.assertNotBusy(chat.id)
      }),
    { config: cfg },
  ),
)

unix("shell captures stderr from a failing command", () =>
  provideTmpdirInstance(
    (_dir) =>
      Effect.gen(function* () {
        const { prompt, run, chat } = yield* boot()
        const result = yield* prompt.shell({
          sessionID: chat.id,
          agent: "build",
          command: "command -v __nonexistent_cmd_e2e__ || echo 'not found' >&2; exit 1",
        })

        expect(result.info.role).toBe("assistant")
        const tool = completedTool(result.parts)
        if (!tool) return

        expect(tool.state.output).toContain("not found")
        expect(tool.state.metadata.output).toContain("not found")
        yield* run.assertNotBusy(chat.id)
      }),
    { config: cfg },
  ),
)

unix(
  "shell updates running metadata before process exit",
  () =>
    withSh(() =>
      provideTmpdirInstance(
        (_dir) =>
          Effect.gen(function* () {
            const { prompt, chat } = yield* boot()

            const fiber = yield* prompt
              .shell({ sessionID: chat.id, agent: "build", command: "printf first && sleep 0.2 && printf second" })
              .pipe(Effect.forkChild)

            yield* Effect.promise(async () => {
              const start = Date.now()
              while (Date.now() - start < 5000) {
                const msgs = await MessageV2.filterCompacted(MessageV2.stream(chat.id))
                const taskMsg = msgs.find((item) => item.info.role === "assistant")
                const tool = taskMsg ? toolPart(taskMsg.parts) : undefined
                if (tool?.state.status === "running" && tool.state.metadata?.output.includes("first")) return
                await new Promise((done) => setTimeout(done, 20))
              }
              throw new Error("timed out waiting for running shell metadata")
            })

            const exit = yield* Fiber.await(fiber)
            expect(Exit.isSuccess(exit)).toBe(true)
          }),
        { config: cfg },
      ),
    ),
  30_000,
)

unix(
  "loop waits while shell runs and starts after shell exits",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({
          title: "Pinned",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        yield* llm.text("after-shell")

        const sh = yield* prompt
          .shell({ sessionID: chat.id, agent: "build", command: "sleep 0.2" })
          .pipe(Effect.forkChild)
        yield* Effect.sleep(50)

        const loop = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* Effect.sleep(50)

        expect(yield* llm.calls).toBe(0)

        yield* Fiber.await(sh)
        const exit = yield* Fiber.await(loop)

        expect(Exit.isSuccess(exit)).toBe(true)
        if (Exit.isSuccess(exit)) {
          expect(exit.value.info.role).toBe("assistant")
          expect(exit.value.parts.some((part) => part.type === "text" && part.text === "after-shell")).toBe(true)
        }
        expect(yield* llm.calls).toBe(1)
      }),
      { config: providerCfg },
    ),
  30_000,
)

unix(
  "shell completion resumes queued loop callers",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({
          title: "Pinned",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        yield* llm.text("done")

        const sh = yield* prompt
          .shell({ sessionID: chat.id, agent: "build", command: "sleep 0.2" })
          .pipe(Effect.forkChild)
        yield* Effect.sleep(50)

        const a = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        const b = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* Effect.sleep(50)

        expect(yield* llm.calls).toBe(0)

        yield* Fiber.await(sh)
        const [ea, eb] = yield* Effect.all([Fiber.await(a), Fiber.await(b)])

        expect(Exit.isSuccess(ea)).toBe(true)
        expect(Exit.isSuccess(eb)).toBe(true)
        if (Exit.isSuccess(ea) && Exit.isSuccess(eb)) {
          expect(ea.value.info.id).toBe(eb.value.info.id)
          expect(ea.value.info.role).toBe("assistant")
        }
        expect(yield* llm.calls).toBe(1)
      }),
      { config: providerCfg },
    ),
  30_000,
)

unix(
  "command ! expansion uses configured shell over env shell",
  () =>
    withSh(() =>
      provideTmpdirServer(
        ({ llm }) =>
          Effect.gen(function* () {
            if (!Bun.which("bash")) return

            const { prompt, chat } = yield* boot()
            yield* llm.text("done")

            const result = yield* prompt.command({
              sessionID: chat.id,
              command: "probe",
              arguments: "",
            })

            expect(result.info.role).toBe("assistant")
            const inputs = yield* llm.inputs
            expect(JSON.stringify(inputs.at(-1)?.messages)).toContain("configured")
          }),
        {
          config: (url) => ({
            ...providerCfg(url),
            shell: "bash",
            command: {
              probe: {
                template: "Probe: !`[[ 1 -eq 1 ]] && printf configured`",
              },
            },
          }),
        },
      ),
    ),
  30_000,
)

unix(
  "cancel interrupts shell and resolves cleanly",
  () =>
    withSh(() =>
      provideTmpdirInstance(
        (_dir) =>
          Effect.gen(function* () {
            const { prompt, run, chat } = yield* boot()

            const sh = yield* prompt
              .shell({ sessionID: chat.id, agent: "build", command: "sleep 30" })
              .pipe(Effect.forkChild)
            yield* Effect.sleep(50)

            yield* prompt.cancel(chat.id)

            const status = yield* SessionStatus.Service
            expect((yield* status.get(chat.id)).type).toBe("idle")
            const busy = yield* run.assertNotBusy(chat.id).pipe(Effect.exit)
            expect(Exit.isSuccess(busy)).toBe(true)

            const exit = yield* Fiber.await(sh)
            expect(Exit.isSuccess(exit)).toBe(true)
            if (Exit.isSuccess(exit)) {
              expect(exit.value.info.role).toBe("assistant")
              const tool = completedTool(exit.value.parts)
              if (tool) {
                expect(tool.state.output).toContain("User aborted the command")
              }
            }
          }),
        { config: cfg },
      ),
    ),
  30_000,
)

// 纯判据测试不依赖 runner 调度，稳定覆盖“旧 active 残留遮住新 scheduled”这一生产失效快照。
it.live(
  "prefers the current pending turn over stale active cleanup",
  Effect.sync(() => {
    const firstID = MessageID.ascending()
    const secondID = MessageID.ascending()
    // 精确构造 CI 失败快照：旧 A 仍留在 active，但 stop 后提交的 B 已携带新 cancel epoch。
    expect(
      SessionPrompt.currentTurnIDAtEpoch({
        active: { id: firstID, cancelEpoch: 0 },
        scheduled: { id: secondID, cancelEpoch: 1 },
        cancelEpoch: 1,
      }),
    ).toBe(secondID)
    // 同代次 active 仍拥有优先级，不能让普通 queued follow-up 抢走当前回合的停止身份。
    expect(
      SessionPrompt.currentTurnIDAtEpoch({
        active: { id: firstID, cancelEpoch: 1 },
        scheduled: { id: secondID, cancelEpoch: 1 },
        cancelEpoch: 1,
      }),
    ).toBe(firstID)
  }),
)

// 旧页面的停止请求必须按 turnID 与取消代次幂等丢弃，不能递增新回合的取消代次并吞掉它的回复；
// 两轮各自使用请求内容门闩，后台标题、建议或第一轮重试都不能冒充第二轮已经进入模型。
it.live(
  "ignores a stale turn-aware cancel after a newer turn starts",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const firstGate = defer<void>()
        const secondGate = defer<void>()
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Stale turn cancel" })
        yield* sessions.setGoal({ sessionID: chat.id, objective: "finish the current work" })
        const firstID = MessageID.ascending()
        const firstRequest = (hit: { body: Record<string, unknown> }) => {
          const body = JSON.stringify(hit.body)
          return (
            body.includes("first turn") &&
            !body.includes("second turn") &&
            !body.includes("Predict the user's next prompt")
          )
        }
        const secondRequest = (hit: { body: Record<string, unknown> }) => {
          const body = JSON.stringify(hit.body)
          return body.includes("second turn") && !body.includes("Predict the user's next prompt")
        }

        yield* llm.pushMatch(firstRequest, reply().wait(firstGate.promise).text("first response").stop())
        const first = yield* prompt
          .prompt({
            sessionID: chat.id,
            messageID: firstID,
            agent: "build",
            model: ref,
            parts: [{ type: "text", text: "first turn" }],
          })
          .pipe(Effect.forkChild)
        yield* llm.waitMatch(firstRequest)

        // 第一回合按自己的 turnID 正常停止，随后才能安全启动新的活动回合。
        yield* prompt.cancel(chat.id, { turnID: firstID })
        yield* Fiber.await(first)
        // 取消只中断客户端请求；测试服务端仍在等待旧响应门闩，先释放它才能让第二个 HTTP 请求真正到达。
        firstGate.resolve()

        const secondID = MessageID.ascending()
        yield* llm.pushMatch(secondRequest, reply().wait(secondGate.promise).text("second response").stop())
        const second = yield* prompt
          .prompt({
            sessionID: chat.id,
            messageID: secondID,
            agent: "build",
            model: ref,
            parts: [{ type: "text", text: "second turn" }],
          })
          .pipe(Effect.forkChild)
        yield* llm.waitMatch(secondRequest)

        // 迟到的旧停止只能无操作；关联的 goal 暂停也必须留在同一个接受闸门之后，不能持久误伤新回合。
        yield* prompt.cancel(chat.id, {
          turnID: firstID,
          onAccepted: sessions.setGoalStatus({ sessionID: chat.id, status: "paused" }).pipe(Effect.ignore),
        })
        expect((yield* sessions.getGoal(chat.id))?.status).toBe("active")

        secondGate.resolve()
        const exit = yield* Fiber.await(second).pipe(Effect.exit)
        expect(Exit.isSuccess(exit)).toBe(true)
        const messages = yield* sessions.messages({ sessionID: chat.id })
        const secondAssistant = messages.find(
          (message) =>
            message.info.role === "assistant" &&
            message.info.parentID === secondID &&
            message.parts.some((part) => part.type === "text" && part.text === "second response"),
        )
        expect(secondAssistant).toBeDefined()
        const hits = yield* llm.hits
        // 第一回合被主动取消后 provider 可以重试旧 HTTP 请求；它们都受 firstRequest 隔离，不能冒充第二回合。
        expect(hits.filter(firstRequest).length).toBeGreaterThanOrEqual(1)
        // 第二回合没有取消或重试，必须只消费自己的匹配回复一次。
        expect(hits.filter(secondRequest)).toHaveLength(1)
        // 正常完成的新回合也必须撤销全部执行身份，证明迟到 stop 没有留下隐藏状态。
        expect(SessionPrompt.sessionPromptLifecycleState(chat.id)).toEqual({
          activeTurn: false,
          scheduledTurn: false,
          activeStep: false,
          replyGeneration: false,
        })
      }),
      { config: providerCfg },
    ),
  10_000,
)

unix(
  "cancel persists aborted shell result when shell ignores TERM",
  () =>
    withSh(() =>
      provideTmpdirInstance(
        (_dir) =>
          Effect.gen(function* () {
            const { prompt, chat } = yield* boot()

            const sh = yield* prompt
              .shell({ sessionID: chat.id, agent: "build", command: "trap '' TERM; sleep 30" })
              .pipe(Effect.forkChild)
            yield* Effect.sleep(50)

            yield* prompt.cancel(chat.id)

            const exit = yield* Fiber.await(sh)
            expect(Exit.isSuccess(exit)).toBe(true)
            if (Exit.isSuccess(exit)) {
              expect(exit.value.info.role).toBe("assistant")
              const tool = completedTool(exit.value.parts)
              if (tool) {
                expect(tool.state.output).toContain("User aborted the command")
              }
            }
          }),
        { config: cfg },
      ),
    ),
  30_000,
)

unix(
  "cancel finalizes interrupted bash tool output through normal truncation",
  () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          const prompt = yield* SessionPrompt.Service
          const sessions = yield* Session.Service
          const chat = yield* sessions.create({
            title: "Interrupted bash truncation",
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          })

          yield* prompt.prompt({
            sessionID: chat.id,
            agent: "build",
            noReply: true,
            parts: [{ type: "text", text: "run bash" }],
          })

          const sentinel = "__BASH_TRUNCATION_READY__"
          const running = yield* listenForToolPart(
            chat.id,
            (part) =>
              part.tool === "bash" &&
              part.state.status === "running" &&
              typeof part.state.metadata?.output === "string" &&
              part.state.metadata.output.includes(sentinel),
          )

          yield* llm.tool("bash", {
            command: `i=0; while [ "$i" -lt 4000 ]; do printf "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx %05d\\n" "$i"; i=$((i + 1)); done; printf "${sentinel}\\n"; sleep 30`,
            description: "Print many lines",
            timeout: 30_000,
            workdir: path.resolve(dir),
          })

          const run = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
          yield* llm.wait(1)
          yield* Deferred.await(running).pipe(Effect.timeout("15 seconds"))
          yield* prompt.cancel(chat.id)

          const exit = yield* Fiber.await(run)
          expect(Exit.isSuccess(exit)).toBe(true)
          if (Exit.isFailure(exit)) return

          const tool = completedTool(exit.value.parts)
          if (!tool) return

          expect(tool.state.metadata.truncated).toBe(true)
          expect(typeof tool.state.metadata.outputPath).toBe("string")
          expect(tool.state.output).toContain(sentinel)
          expect(tool.state.output).toMatch(/Full output saved to:\s+\S+/)
          expect(tool.state.output).not.toContain("Tool execution aborted")
        }),
      { config: providerCfg },
    ),
  30_000,
)

unix(
  "cancel interrupts loop queued behind shell",
  () =>
    provideTmpdirInstance(
      (_dir) =>
        Effect.gen(function* () {
          const { prompt, chat } = yield* boot()

          const sh = yield* prompt
            .shell({ sessionID: chat.id, agent: "build", command: "sleep 30" })
            .pipe(Effect.forkChild)
          yield* Effect.sleep(50)

          const loop = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
          yield* Effect.sleep(50)

          yield* prompt.cancel(chat.id)

          const exit = yield* Fiber.await(loop)
          expect(Exit.isSuccess(exit)).toBe(true)
          if (Exit.isSuccess(exit)) {
            const tool = completedTool(exit.value.parts)
            expect(tool?.state.output).toContain("User aborted the command")
          }

          yield* Fiber.await(sh)
        }),
      { config: cfg },
    ),
  30_000,
)

unix(
  "shell rejects when another shell is already running",
  () =>
    withSh(() =>
      provideTmpdirInstance(
        (_dir) =>
          Effect.gen(function* () {
            const { prompt, chat } = yield* boot()

            const a = yield* prompt
              .shell({ sessionID: chat.id, agent: "build", command: "sleep 30" })
              .pipe(Effect.forkChild)
            yield* Effect.sleep(50)

            const exit = yield* prompt
              .shell({ sessionID: chat.id, agent: "build", command: "echo hi" })
              .pipe(Effect.exit)
            expect(Exit.isFailure(exit)).toBe(true)
            if (Exit.isFailure(exit)) {
              expect(Cause.squash(exit.cause)).toBeInstanceOf(Session.BusyError)
            }

            yield* prompt.cancel(chat.id)
            yield* Fiber.await(a)
          }),
        { config: cfg },
      ),
    ),
  30_000,
)

// Abort signal propagation tests for inline tool execution

/** Override a tool's execute to hang until aborted. Returns ready/aborted defers and a finalizer. */
function hangUntilAborted(tool: { execute: (...args: any[]) => any }) {
  const ready = defer<void>()
  const aborted = defer<void>()
  const original = tool.execute
  tool.execute = (_args: any, ctx: any) => {
    ready.resolve()
    ctx.abort.addEventListener("abort", () => aborted.resolve(), { once: true })
    return Effect.callback<never>(() => {})
  }
  const restore = Effect.addFinalizer(() => Effect.sync(() => void (tool.execute = original)))
  return { ready, aborted, restore }
}

it.live(
  "interrupt propagates abort signal to read tool via file part (text/plain)",
  () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const registry = yield* ToolRegistry.Service
          const { read } = yield* registry.named()
          const { ready, aborted, restore } = hangUntilAborted(read)
          yield* restore

          const prompt = yield* SessionPrompt.Service
          const sessions = yield* Session.Service
          const chat = yield* sessions.create({ title: "Abort Test" })

          const testFile = path.join(dir, "test.txt")
          yield* Effect.promise(() => Bun.write(testFile, "hello world"))

          const fiber = yield* prompt
            .prompt({
              sessionID: chat.id,
              agent: "build",
              parts: [
                { type: "text", text: "read this" },
                { type: "file", url: `file://${testFile}`, filename: "test.txt", mime: "text/plain" },
              ],
            })
            .pipe(Effect.forkChild)

          yield* Effect.promise(() => ready.promise)
          yield* Fiber.interrupt(fiber)

          yield* Effect.promise(() =>
            Promise.race([
              aborted.promise,
              new Promise<void>((_, reject) =>
                setTimeout(() => reject(new Error("abort signal not propagated within 2s")), 2_000),
              ),
            ]),
          )
        }),
      { config: cfg },
    ),
  30_000,
)

it.live(
  "interrupt propagates abort signal to read tool via file part (directory)",
  () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const registry = yield* ToolRegistry.Service
          const { read } = yield* registry.named()
          const { ready, aborted, restore } = hangUntilAborted(read)
          yield* restore

          const prompt = yield* SessionPrompt.Service
          const sessions = yield* Session.Service
          const chat = yield* sessions.create({ title: "Abort Test" })

          const fiber = yield* prompt
            .prompt({
              sessionID: chat.id,
              agent: "build",
              parts: [
                { type: "text", text: "read this" },
                { type: "file", url: `file://${dir}`, filename: "dir", mime: "application/x-directory" },
              ],
            })
            .pipe(Effect.forkChild)

          yield* Effect.promise(() => ready.promise)
          yield* Fiber.interrupt(fiber)

          yield* Effect.promise(() =>
            Promise.race([
              aborted.promise,
              new Promise<void>((_, reject) =>
                setTimeout(() => reject(new Error("abort signal not propagated within 2s")), 2_000),
              ),
            ]),
          )
        }),
      { config: cfg },
    ),
  30_000,
)

// Missing file handling

it.live("does not fail the prompt when a file part is missing", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const session = yield* sessions.create({})

        const missing = path.join(dir, "does-not-exist.ts")
        const msg = yield* prompt.prompt({
          sessionID: session.id,
          agent: "build",
          noReply: true,
          parts: [
            { type: "text", text: "please review @does-not-exist.ts" },
            {
              type: "file",
              mime: "text/plain",
              url: `file://${missing}`,
              filename: "does-not-exist.ts",
            },
          ],
        })

        if (msg.info.role !== "user") throw new Error("expected user message")
        const hasFailure = msg.parts.some(
          (part) => part.type === "text" && part.synthetic && part.text.includes("Read tool failed to read"),
        )
        expect(hasFailure).toBe(true)

        yield* sessions.remove(session.id)
      }),
    { config: cfg },
  ),
)

it.live("keeps stored part order stable when file resolution is async", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const session = yield* sessions.create({})

        const missing = path.join(dir, "still-missing.ts")
        const msg = yield* prompt.prompt({
          sessionID: session.id,
          agent: "build",
          noReply: true,
          parts: [
            {
              type: "file",
              mime: "text/plain",
              url: `file://${missing}`,
              filename: "still-missing.ts",
            },
            { type: "text", text: "after-file" },
          ],
        })

        if (msg.info.role !== "user") throw new Error("expected user message")

        const stored = MessageV2.get({
          sessionID: session.id,
          messageID: msg.info.id,
        })
        const text = stored.parts.filter((part) => part.type === "text").map((part) => part.text)

        expect(text[0]?.startsWith("Called the Read tool with the following input:")).toBe(true)
        expect(text[1]?.includes("Read tool failed to read")).toBe(true)
        expect(text[2]).toBe("after-file")

        yield* sessions.remove(session.id)
      }),
    { config: cfg },
  ),
)

// Special characters in filenames

it.live("handles filenames with # character", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => Bun.write(path.join(dir, "file#name.txt"), "special content\n"))

        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const session = yield* sessions.create({})
        const parts = yield* prompt.resolvePromptParts("Read @file#name.txt")
        const fileParts = parts.filter((part) => part.type === "file")

        expect(fileParts.length).toBe(1)
        expect(fileParts[0].filename).toBe("file#name.txt")
        expect(fileParts[0].url).toContain("%23")

        const decodedPath = fileURLToPath(fileParts[0].url)
        expect(decodedPath).toBe(path.join(dir, "file#name.txt"))

        const message = yield* prompt.prompt({
          sessionID: session.id,
          parts,
          noReply: true,
        })
        const stored = MessageV2.get({ sessionID: session.id, messageID: message.info.id })
        const textParts = stored.parts.filter((part) => part.type === "text")
        const hasContent = textParts.some((part) => part.text.includes("special content"))
        expect(hasContent).toBe(true)

        yield* sessions.remove(session.id)
      }),
    // Needs a real git project: @-file resolution walks the project file context.
    { git: true, config: cfg },
  ),
)

// Regression: empty assistant turn loop

it.live("does not loop empty assistant turns for a simple reply", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "Prompt regression" })

      yield* llm.text("packages/opencode/src/session/processor.ts")

      const result = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        parts: [{ type: "text", text: "Where is SessionProcessor?" }],
      })

      expect(result.info.role).toBe("assistant")
      expect(result.parts.some((part) => part.type === "text" && part.text.includes("processor.ts"))).toBe(true)

      const msgs = yield* sessions.messages({ sessionID: session.id })
      expect(msgs.filter((msg) => msg.info.role === "assistant")).toHaveLength(1)
      expect(yield* llm.calls).toBe(1)
    }),
    { config: providerCfg },
  ),
)

unix(
  "records aborted errors when prompt is cancelled mid-stream",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const session = yield* sessions.create({ title: "Prompt cancel regression" })

        yield* llm.hang

        const fiber = yield* prompt
          .prompt({
            sessionID: session.id,
            agent: "build",
            parts: [{ type: "text", text: "Cancel me" }],
          })
          .pipe(Effect.forkChild)

        yield* llm.wait(1)
        yield* prompt.cancel(session.id)

        const exit = yield* Fiber.await(fiber)
        expect(Exit.isSuccess(exit)).toBe(true)
        if (Exit.isSuccess(exit)) {
          expect(exit.value.info.role).toBe("assistant")
          if (exit.value.info.role === "assistant") {
            expect(exit.value.info.error?.name).toBe("MessageAbortedError")
          }
        }

        const msgs = yield* sessions.messages({ sessionID: session.id })
        const last = msgs.findLast((msg) => msg.info.role === "assistant")
        expect(last?.info.role).toBe("assistant")
        if (last?.info.role === "assistant") {
          expect(last.info.error?.name).toBe("MessageAbortedError")
        }
      }),
      { config: providerCfg },
    ),
  5_000,
)

// Agent variant

it.live("applies agent variant only when using agent model", () =>
  provideTmpdirInstance(
    (_dir) =>
      Effect.gen(function* () {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const session = yield* sessions.create({})

        const other = yield* prompt.prompt({
          sessionID: session.id,
          agent: "build",
          model: { providerID: ProviderID.make("wanlaicode"), modelID: ModelID.make("kimi-k2.5-free") },
          noReply: true,
          parts: [{ type: "text", text: "hello" }],
        })
        if (other.info.role !== "user") throw new Error("expected user message")
        expect(other.info.model.variant).toBeUndefined()

        const match = yield* prompt.prompt({
          sessionID: session.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "hello again" }],
        })
        if (match.info.role !== "user") throw new Error("expected user message")
        expect(match.info.model).toEqual({
          providerID: ProviderID.make("test"),
          modelID: ModelID.make("test-model"),
          variant: "xhigh",
        })
        expect(match.info.model.variant).toBe("xhigh")

        const override = yield* prompt.prompt({
          sessionID: session.id,
          agent: "build",
          noReply: true,
          variant: "high",
          parts: [{ type: "text", text: "hello third" }],
        })
        if (override.info.role !== "user") throw new Error("expected user message")
        expect(override.info.model.variant).toBe("high")

        yield* sessions.remove(session.id)
      }),
    {
      config: {
        ...cfg,
        provider: {
          ...cfg.provider,
          test: {
            ...cfg.provider.test,
            models: {
              "test-model": {
                ...cfg.provider.test.models["test-model"],
                variants: { xhigh: {}, high: {} },
              },
            },
          },
        },
        agent: {
          build: {
            model: "test/test-model",
            variant: "xhigh",
          },
        },
      },
    },
  ),
)

// Agent / command resolution errors

it.live(
  "unknown agent throws typed error",
  () =>
    provideTmpdirInstance(
      (_dir) =>
        Effect.gen(function* () {
          const prompt = yield* SessionPrompt.Service
          const sessions = yield* Session.Service
          const session = yield* sessions.create({})
          const exit = yield* prompt
            .prompt({
              sessionID: session.id,
              agent: "nonexistent-agent-xyz",
              noReply: true,
              parts: [{ type: "text", text: "hello" }],
            })
            .pipe(Effect.exit)

          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) {
            const err = Cause.squash(exit.cause)
            expect(err).not.toBeInstanceOf(TypeError)
            expect(NamedError.Unknown.isInstance(err)).toBe(true)
            if (NamedError.Unknown.isInstance(err)) {
              expect(err.data.message).toContain('Agent not found: "nonexistent-agent-xyz"')
            }
          }
        }),
      {},
    ),
  30_000,
)

it.live(
  "unknown agent error includes available agent names",
  () =>
    provideTmpdirInstance(
      (_dir) =>
        Effect.gen(function* () {
          const prompt = yield* SessionPrompt.Service
          const sessions = yield* Session.Service
          const session = yield* sessions.create({})
          const exit = yield* prompt
            .prompt({
              sessionID: session.id,
              agent: "nonexistent-agent-xyz",
              noReply: true,
              parts: [{ type: "text", text: "hello" }],
            })
            .pipe(Effect.exit)

          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) {
            const err = Cause.squash(exit.cause)
            expect(NamedError.Unknown.isInstance(err)).toBe(true)
            if (NamedError.Unknown.isInstance(err)) {
              expect(err.data.message).toContain("build")
            }
          }
        }),
      {},
    ),
  30_000,
)

it.live(
  "unknown command throws typed error with available names",
  () =>
    provideTmpdirInstance(
      (_dir) =>
        Effect.gen(function* () {
          const prompt = yield* SessionPrompt.Service
          const sessions = yield* Session.Service
          const session = yield* sessions.create({})
          const exit = yield* prompt
            .command({
              sessionID: session.id,
              command: "nonexistent-command-xyz",
              arguments: "",
            })
            .pipe(Effect.exit)

          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) {
            const err = Cause.squash(exit.cause)
            expect(err).not.toBeInstanceOf(TypeError)
            expect(NamedError.Unknown.isInstance(err)).toBe(true)
            if (NamedError.Unknown.isInstance(err)) {
              expect(err.data.message).toContain('Command not found: "nonexistent-command-xyz"')
              expect(err.data.message).toContain("init")
            }
          }
        }),
      {},
    ),
  30_000,
)

// Prompt suggestions

const isSuggestionHit = (hit: { body: Record<string, unknown> }) =>
  JSON.stringify(hit.body).includes("Predict the user's next prompt")

// fixture 默认 prompt_suggestions: false，建议相关测试显式开启
const suggestionCfg = (url: string) => ({
  ...providerCfg(url),
  prompt_suggestions: true,
  agent: {
    suggestion: {
      model: "test/test-model",
    },
  },
})

const listenSuggestion = Effect.gen(function* () {
  const bus = yield* Bus.Service
  const deferred = yield* Deferred.make<{ sessionID: string; text: string }>()
  yield* bus.subscribeCallback(Session.Event.Suggestion, (evt) =>
    Deferred.doneUnsafe(deferred, Effect.succeed(evt.properties)),
  )
  return deferred
})

it.live("publishes a cleaned suggestion after the loop exits", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const deferred = yield* listenSuggestion
      const session = yield* sessions.create({
        title: "Suggestion",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "hello" }],
      })
      yield* llm.text("world")
      yield* llm.textMatch(isSuggestionHit, '"run the tests"')

      yield* prompt.loop({ sessionID: session.id })

      const got = yield* Deferred.await(deferred).pipe(Effect.timeout("5 seconds"))
      expect(got).toEqual({ sessionID: session.id, text: "run the tests" })

      const inputs = yield* llm.inputs
      const suggestionInput = inputs.find((input) => JSON.stringify(input).includes("Predict the user's next prompt"))
      expect(suggestionInput?.max_tokens ?? suggestionInput?.max_output_tokens).toBe(MAX_OUTPUT_TOKENS)
    }),
    { config: suggestionCfg },
  ),
)

it.live("discards the suggestion when the stream errors mid-flight", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const deferred = yield* listenSuggestion
      const session = yield* sessions.create({
        title: "Suggestion",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "hello" }],
      })
      yield* llm.text("world")
      yield* llm.pushMatch(isSuggestionHit, reply().text("partial sugg").streamError())

      yield* prompt.loop({ sessionID: session.id })
      yield* llm.wait(2)

      // 流中断后不得把半截文本发布成建议
      expect(yield* Deferred.await(deferred).pipe(Effect.timeoutOption("400 millis"))).toEqual(Option.none())
    }),
    { config: suggestionCfg },
  ),
)

it.live("publishes nothing when the model returns the NONE sentinel", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const deferred = yield* listenSuggestion
      const session = yield* sessions.create({
        title: "Suggestion",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "hello" }],
      })
      yield* llm.text("world")

      yield* prompt.loop({ sessionID: session.id })
      // 第二个请求 = 建议请求，由测试服务器自动应答 NONE
      yield* llm.wait(2)

      expect(yield* Deferred.await(deferred).pipe(Effect.timeoutOption("400 millis"))).toEqual(Option.none())
    }),
    { config: suggestionCfg },
  ),
)

it.live("skips suggestion generation when prompt_suggestions is false", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const deferred = yield* listenSuggestion
      const session = yield* sessions.create({
        title: "Suggestion",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "hello" }],
      })
      yield* llm.text("world")

      yield* prompt.loop({ sessionID: session.id })

      expect(yield* Deferred.await(deferred).pipe(Effect.timeoutOption("400 millis"))).toEqual(Option.none())
      expect(yield* llm.calls).toBe(1)
    }),
    // provideTmpdirServer 默认注入 prompt_suggestions: false
    { config: providerCfg },
  ),
)

it.live("skips suggestion generation for plan agent turns", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const deferred = yield* listenSuggestion
      const session = yield* sessions.create({
        title: "Suggestion",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "plan",
        noReply: true,
        parts: [{ type: "text", text: "hello" }],
      })
      yield* llm.text("world")

      yield* prompt.loop({ sessionID: session.id })

      expect(yield* Deferred.await(deferred).pipe(Effect.timeoutOption("400 millis"))).toEqual(Option.none())
      expect(yield* llm.calls).toBe(1)
    }),
    { config: suggestionCfg },
  ),
)
