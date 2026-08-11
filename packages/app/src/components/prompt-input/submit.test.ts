import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import type { Prompt } from "@/context/prompt"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import { createStore } from "solid-js/store"

let createPromptSubmit: typeof import("./submit").createPromptSubmit
let resolveFollowupSlashCommand: typeof import("./submit").resolveFollowupSlashCommand
let shouldDivertToGoal: typeof import("./submit").shouldDivertToGoal
let sendFollowupDraft: typeof import("./submit").sendFollowupDraft
let snapshotPromptForSubmit: typeof import("./submit").snapshotPromptForSubmit

const createdClients: string[] = []
const createdSessions: string[] = []
const legacyApprovalCalls: Array<{ sessionID: string; directory: string }> = []
const sentPrompts: Array<{ directory: string; payload: Record<string, unknown> }> = []
// 独立记录 steer 请求，确保引导不会在前端发送链路中退回普通 promptAsync。
const sentSteers: Array<{ directory: string; payload: Record<string, unknown> }> = []
const abortedSessions: string[] = []
const abortedTurnIDs: Array<string | undefined> = []
const abortSequence: string[] = []
const optimistic: Array<{
  directory?: string
  sessionID?: string
  message: {
    id: string
    role: "user" | "assistant"
    agent: string
    model: { providerID: string; modelID: string }
    variant?: string
    steerTargetTurnID?: string
    time?: { created: number; completed?: number }
  }
  parts?: Part[]
}> = []
const optimisticSeeded: boolean[] = []
const storedSessions: Record<string, Array<{ id: string; title?: string; directory?: string }>> = {}
const promoted: Array<{ directory: string; sessionID: string }> = []
const sentShell: string[] = []
const sentCommands: Array<{ directory: string; payload: Record<string, unknown> }> = []
const updatedSessions: Array<{ directory: string; payload: Record<string, unknown> }> = []
const syncedDirectories: string[] = []
const generatedImages: Array<Record<string, unknown>> = []
const classifiedImageIntents: Array<Record<string, unknown>> = []
const toastCalls: Array<{ title?: string; description?: string }> = []
const navigateCalls: string[] = []
let syncCommands: Array<{ name: string }> = []
const promptResetCalls: string[] = []
const promptSetCalls: Prompt[] = []

let params: { id?: string } = {}
let selected = "/repo/worktree-a"
let variant: string | undefined
let promptValue: Prompt = [{ type: "text", content: "ls", start: 0, end: 2 }]
let snippetsValue: string[] = []
let contextItemsValue: Array<{
  type: "file"
  key: string
  path: string
  selection?: { startLine: number; startChar: number; endLine: number; endChar: number }
  comment?: string
  preview?: string
}> = []
let syncMessages: Record<string, Message[]> = {}
let syncParts: Record<string, Part[]> = {}
let shouldFailImageGenerate = false
let commandDelayResolve: (() => void) | undefined
let promptAsyncGate: Promise<void> | undefined
let abortGate: Promise<void> | undefined
let sessionCreateGate: Promise<void> | undefined

type TestModel = {
  id: string
  name?: string
  provider: { id: string; options?: Record<string, unknown> }
  wanlaicode?: { rate_multiplier?: number }
  capabilities?: { output?: { image?: boolean } }
}
const defaultTextModel = {
  id: "model",
  name: "Model",
  provider: { id: "provider" },
  capabilities: { output: { image: false } },
}
const imageModel = {
  id: "gpt-image-2",
  name: "GPT Image 2",
  provider: { id: "wanlaicode" },
  capabilities: { output: { image: true } },
}
let localModelCurrent: () => TestModel = () => defaultTextModel
let localModelList: () => TestModel[] = () => [defaultTextModel, imageModel]
let localModelVisible = () => true

let shouldFailSessionCreate = false
let sessionCreateFailure: Error | undefined
let sessionCreateFailCount = 0
let failSessionCreateTimes = 0
let sessionUpdateError: Error | undefined

const clientFor = (directory: string) => {
  createdClients.push(directory)
  return {
    session: {
      create: async (payload?: { id?: string }) => {
        // 用真实 Promise 闸复现 session.create 回包前切换会话，避免同步 mock 掩盖迟到 ACK 竞态。
        if (sessionCreateGate) await sessionCreateGate
        if (shouldFailSessionCreate) {
          const limit = failSessionCreateTimes === 0 ? Number.POSITIVE_INFINITY : failSessionCreateTimes
          if (sessionCreateFailCount < limit) {
            sessionCreateFailCount++
            throw sessionCreateFailure ?? new TypeError("Failed to fetch")
          }
        }
        createdSessions.push(directory)
        return {
          data: {
            id: payload?.id ?? `session-${createdSessions.length}`,
            title: `New session ${createdSessions.length}`,
            directory,
          },
        }
      },
      shell: async () => {
        sentShell.push(directory)
        return { data: undefined }
      },
      prompt: async () => ({ data: undefined }),
      promptAsync: async (payload: Record<string, unknown>) => {
        sentPrompts.push({ directory, payload })
        if (promptAsyncGate) await promptAsyncGate
        return { data: undefined }
      },
      steer: async (payload: Record<string, unknown>) => {
        sentSteers.push({ directory, payload })
        return { data: { messageID: String(payload.messageID), targetTurnID: String(payload.targetTurnID) } }
      },
      command: async (payload: Record<string, unknown>) => {
        sentCommands.push({ directory, payload })
        if (commandDelayResolve) await new Promise<void>((resolve) => (commandDelayResolve = () => resolve()))
        return { data: undefined }
      },
      // 测试客户端同时保留 main 的会话更新能力与本分支携带 turnID 的精确停止及竞态门禁。
      update: async (payload: Record<string, unknown>) => {
        updatedSessions.push({ directory, payload })
        if (sessionUpdateError) {
          return { data: undefined, error: sessionUpdateError }
        }
        return {
          data: {
            id: payload.sessionID,
            title: payload.title,
            directory: payload.directory ?? directory,
          },
        }
      },
      abort: async (payload: { sessionID: string; turnID?: string }) => {
        abortedSessions.push(payload.sessionID)
        abortedTurnIDs.push(payload.turnID)
        if (abortGate) await abortGate
        return { data: undefined }
      },
    },
    wanlaicodeUserCenter: {
      images: {
        generate: async (payload: Record<string, unknown>) => {
          generatedImages.push(payload)
          if (shouldFailImageGenerate) throw new Error("image failed")
          return { data: { images: [] } }
        },
        intent: async (payload: Record<string, unknown>) => {
          classifiedImageIntents.push(payload)
          return { data: { action: "none", confidence: 1 } }
        },
      },
    },
    worktree: {
      create: async () => ({ data: { directory: `${directory}/new` } }),
    },
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
const permissionPreflight = () => Promise.resolve()

// shell 提交会把乐观会话同步留在后台；按真实调用次数等待，确保失败重试完全收尾后再进入下一条用例。
const waitForSessionCreateAttempts = async (expected: number) => {
  const deadline = Date.now() + 1_000
  while (sessionCreateFailCount < expected) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${expected} session.create attempts`)
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  // 最后一次 create 抛错后再让出一个任务周期，确保 retry 的 catch/finally 与 shell 失败分支都已执行。
  await flush()
}

const submitInput = (overrides: Partial<Parameters<typeof createPromptSubmit>[0]> = {}) =>
  createPromptSubmit({
    info: () => ({ id: "session-1" }),
    imageAttachments: () => [],
    commentCount: () => 0,
    mode: () => "normal",
    working: () => false,
    editor: () => undefined,
    queueScroll: () => undefined,
    promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
    addToHistory: () => undefined,
    resetHistoryNavigation: () => undefined,
    setMode: () => undefined,
    setPopover: () => undefined,
    onSubmit: () => undefined,
    ...overrides,
  })

const assistantMessage = (id: string): Message => ({
  id,
  sessionID: "session-1",
  role: "assistant",
  time: { created: Date.now() },
  parentID: "msg_user",
  modelID: "gpt-image-2",
  providerID: "wanlaicode",
  mode: "agent",
  agent: "agent",
  path: { cwd: "/repo/main", root: "/repo/main" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
})

const userMessage = (id: string): Message => ({
  id,
  sessionID: "session-1",
  role: "user",
  time: { created: Date.now() },
  agent: "agent",
  model: { providerID: "provider", modelID: "model" },
})

const filePart = (messageID: string, url: string): Part => ({
  id: `part-${messageID}`,
  sessionID: "session-1",
  messageID,
  type: "file",
  mime: "image/png",
  filename: "previous.png",
  url,
})

const textPart = (messageID: string, text: string): Part => ({
  id: `text-${messageID}`,
  sessionID: "session-1",
  messageID,
  type: "text",
  text,
})

const optimisticUsers = () => optimistic.filter((item) => item.message.role === "user")
const optimisticReasoningTexts = () =>
  optimistic.flatMap((item) => (item.parts ?? []).flatMap((part) => (part.type === "reasoning" ? [part.text] : [])))
const expectNoOptimisticReasoning = () => {
  expect(optimisticReasoningTexts().join("\n")).toBe("")
}

const followupSync = () =>
  ({
    data: { command: syncCommands, message: syncMessages, part: syncParts },
    session: {
      optimistic: {
        add: (value: (typeof optimistic)[number]) => {
          const existing = optimistic.findIndex((entry) => entry.message.id === value.message.id)
          if (existing >= 0) optimistic[existing] = value
          else optimistic.push(value)
        },
        remove: (value: { messageID: string }) => {
          const existing = optimistic.findIndex((entry) => entry.message.id === value.messageID)
          if (existing >= 0) optimistic.splice(existing, 1)
        },
      },
    },
    set: () => undefined,
  }) as unknown as Parameters<typeof sendFollowupDraft>[0]["sync"]

const followupGlobalSync = () =>
  ({
    child: () => [{}, () => undefined],
  }) as unknown as Parameters<typeof sendFollowupDraft>[0]["globalSync"]

beforeAll(async () => {
  const rootClient = clientFor("/repo/main")

  mock.module("@solidjs/router", () => ({
    useNavigate: () => (path: string) => {
      navigateCalls.push(path)
    },
    useParams: () => params,
  }))

  mock.module("@opencode-ai/sdk/v2/client", () => ({
    createOpencodeClient: (input: { directory: string }) => {
      createdClients.push(input.directory)
      return clientFor(input.directory)
    },
  }))

  mock.module("@opencode-ai/ui/toast", () => ({
    showToast: (input: { title?: string; description?: string }) => {
      toastCalls.push(input)
      return 0
    },
  }))

  mock.module("@opencode-ai/core/util/encode", () => ({
    base64Encode: (value: string) => value,
    base64Decode: (value: string) => value,
  }))

  mock.module("@/context/local", () => ({
    useLocal: () => ({
      model: {
        current: () => localModelCurrent(),
        list: () => localModelList(),
        visible: () => localModelVisible(),
        variant: { current: () => variant },
      },
      agent: {
        current: () => ({ name: "agent" }),
      },
      session: {
        promote(directory: string, sessionID: string) {
          promoted.push({ directory, sessionID })
        },
      },
    }),
  }))

  mock.module("@/context/permission", () => ({
    usePermission: () => ({
      recordLegacyApproval(sessionID: string, directory: string) {
        legacyApprovalCalls.push({ sessionID, directory })
      },
    }),
  }))

  mock.module("@/context/prompt", () => ({
    usePrompt: () => ({
      current: () => promptValue,
      reset: () => {
        promptResetCalls.push("reset")
      },
      // 记录失败恢复写回，回归测试据此确认预检拦截不会只 return 而遗漏编辑器恢复。
      set: (value: Prompt) => promptSetCalls.push(value),
      addToChat: {
        snippets: () => snippetsValue,
        count: () => 0,
        push: () => undefined,
        clear: () => undefined,
        replace: (values: string[]) => {
          snippetsValue = [...values]
        },
      },
      context: {
        add: () => undefined,
        remove: () => undefined,
        items: () => contextItemsValue,
      },
    }),
  }))

  mock.module("@/context/layout", () => ({
    useLayout: () => ({
      handoff: {
        setTabs: () => undefined,
      },
    }),
  }))

  mock.module("@/context/sdk", () => ({
    useSDK: () => {
      const sdk = {
        directory: "/repo/main",
        client: rootClient,
        url: "http://localhost:4096",
        createClient(opts: any) {
          return clientFor(opts.directory)
        },
      }
      return sdk
    },
  }))

  mock.module("@/context/sync", () => ({
    useSync: () => ({
      data: { command: syncCommands, message: syncMessages, part: syncParts },
      get project() {
        return { id: "project-1" }
      },
      session: {
        optimistic: {
          add: (value: {
            directory?: string
            sessionID?: string
            message: {
              id: string
              role: "user" | "assistant"
              agent: string
              time: { created: number; completed?: number }
              model?: { providerID: string; modelID: string; variant?: string }
              providerID?: string
              modelID?: string
            }
            parts?: Part[]
          }) => {
            const item = {
              ...value,
              message: {
                id: value.message.id,
                role: value.message.role,
                agent: value.message.agent,
                time: value.message.time,
                model: value.message.model ?? {
                  providerID: value.message.providerID ?? "",
                  modelID: value.message.modelID ?? "",
                },
                variant: value.message.model?.variant,
              },
            }
            const existing = optimistic.findIndex((entry) => entry.message.id === item.message.id)
            if (existing >= 0) optimistic[existing] = item
            else optimistic.push(item)
            optimisticSeeded.push(
              !!value.directory &&
                !!value.sessionID &&
                !!storedSessions[value.directory]?.find((item) => item.id === value.sessionID)?.title,
            )
          },
          remove: (value: { messageID: string }) => {
            const existing = optimistic.findIndex((entry) => entry.message.id === value.messageID)
            if (existing >= 0) optimistic.splice(existing, 1)
          },
        },
      },
      set: (...args: unknown[]) => {
        const value = args[2]
        if (
          args[0] === "session_status" &&
          typeof value === "object" &&
          value !== null &&
          "type" in value &&
          value.type === "idle"
        )
          abortSequence.push("idle")
      },
    }),
  }))

  mock.module("@/context/global-sync", () => ({
    useGlobalSync: () => ({
      todo: {
        set: () => undefined,
      },
      child: (directory: string) => {
        syncedDirectories.push(directory)
        storedSessions[directory] ??= []
        return [
          {
            session: storedSessions[directory],
            command: syncCommands,
            message: syncMessages,
            part: syncParts,
            session_status: {},
          },
          (...args: unknown[]) => {
            const value = args[2]
            if (
              args[0] === "session_status" &&
              typeof value === "object" &&
              value !== null &&
              "type" in value &&
              value.type === "idle"
            ) {
              abortSequence.push("idle")
              return
            }
            if (args[0] !== "session") return
            const next = args[1]
            if (typeof next === "function") {
              storedSessions[directory] = next(storedSessions[directory]) as Array<{
                id: string
                title?: string
                directory?: string
              }>
              return
            }
            if (Array.isArray(next)) {
              storedSessions[directory] = next as Array<{ id: string; title?: string; directory?: string }>
            }
          },
        ]
      },
    }),
  }))

  mock.module("@/context/platform", () => ({
    usePlatform: () => ({
      fetch: fetch,
    }),
  }))

  mock.module("@/context/language", () => ({
    useLanguage: () => ({
      t: (key: string) => key,
      intl: () => "en",
    }),
  }))

  mock.module("@/context/settings", () => ({
    useSettings: () => ({
      general: {
        translateContent: () => false,
      },
    }),
  }))

  const mod = await import("./submit")
  createPromptSubmit = mod.createPromptSubmit
  resolveFollowupSlashCommand = mod.resolveFollowupSlashCommand
  shouldDivertToGoal = mod.shouldDivertToGoal
  sendFollowupDraft = mod.sendFollowupDraft
  snapshotPromptForSubmit = mod.snapshotPromptForSubmit
})

beforeEach(() => {
  createdClients.length = 0
  createdSessions.length = 0
  legacyApprovalCalls.length = 0
  sentPrompts.length = 0
  sentSteers.length = 0
  abortedSessions.length = 0
  abortedTurnIDs.length = 0
  abortSequence.length = 0
  optimistic.length = 0
  optimisticSeeded.length = 0
  promoted.length = 0
  params = {}
  sentShell.length = 0
  syncedDirectories.length = 0
  selected = "/repo/worktree-a"
  variant = undefined
  promptValue = [{ type: "text", content: "ls", start: 0, end: 2 }]
  snippetsValue = []
  contextItemsValue = []
  syncMessages = {}
  syncParts = {}
  generatedImages.length = 0
  classifiedImageIntents.length = 0
  toastCalls.length = 0
  navigateCalls.length = 0
  syncCommands = []
  shouldFailImageGenerate = false
  shouldFailSessionCreate = false
  sessionCreateFailure = undefined
  sessionCreateFailCount = 0
  failSessionCreateTimes = 0
  sessionUpdateError = undefined
  sentCommands.length = 0
  updatedSessions.length = 0
  commandDelayResolve = undefined
  promptAsyncGate = undefined
  abortGate = undefined
  sessionCreateGate = undefined
  promptResetCalls.length = 0
  promptSetCalls.length = 0
  localModelCurrent = () => defaultTextModel
  localModelList = () => [defaultTextModel, imageModel]
  localModelVisible = () => true
  for (const key of Object.keys(storedSessions)) delete storedSessions[key]
})

describe("permission mode submit barrier", () => {
  test("waits for a pending stricter mode before sending a prompt", async () => {
    params = { id: "session-1" }
    let release: () => void = () => undefined
    const pendingMode = new Promise<void>((resolve) => {
      release = resolve
    })
    const submit = submitInput({ flushPermissionMode: () => pendingMode })

    const submitted = submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await flush()
    expect(sentPrompts).toHaveLength(0)

    release()
    await submitted
    expect(sentPrompts).toHaveLength(1)
  })

  test("keeps the draft and sends nothing when permission mode persistence fails", async () => {
    params = { id: "session-1" }
    const submit = submitInput({
      flushPermissionMode: () => Promise.reject(new Error("permission mode failed")),
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)

    expect(sentPrompts).toHaveLength(0)
    expect(promptResetCalls).toHaveLength(0)
    expect(promptValue).toEqual([{ type: "text", content: "ls", start: 0, end: 2 }])
    expect(toastCalls).toContainEqual({
      title: "common.requestFailed",
      description: "permission mode failed",
    })
  })

  test("waits before sending shell and custom command turns", async () => {
    params = { id: "session-1" }
    let releaseShell: () => void = () => undefined
    const pendingShellMode = new Promise<void>((resolve) => {
      releaseShell = resolve
    })
    const shell = submitInput({ mode: () => "shell", flushPermissionMode: () => pendingShellMode })

    const shellSubmitted = shell.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await flush()
    expect(sentShell).toHaveLength(0)
    releaseShell()
    await shellSubmitted
    await flush()
    expect(sentShell).toHaveLength(1)

    syncCommands = [{ name: "testcmd" }]
    promptValue = [{ type: "text", content: "/testcmd hello", start: 0, end: 14 }]
    let releaseCommand: () => void = () => undefined
    const pendingCommandMode = new Promise<void>((resolve) => {
      releaseCommand = resolve
    })
    const command = submitInput({ flushPermissionMode: () => pendingCommandMode })

    const commandSubmitted = command.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await flush()
    expect(sentCommands).toHaveLength(0)
    releaseCommand()
    await commandSubmitted
    await flush()
    expect(sentCommands).toHaveLength(1)
  })

  test("does not wait for permission persistence when an empty submit aborts", async () => {
    params = { id: "session-1" }
    promptValue = []
    let flushCalls = 0
    const submit = submitInput({
      working: () => true,
      flushPermissionMode: async () => {
        flushCalls += 1
      },
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await flush()

    expect(flushCalls).toBe(0)
    expect(abortedSessions).toEqual(["session-1"])
  })

  test("does not queue or clear a busy follow-up until the permission mode is persisted", async () => {
    params = { id: "session-1" }
    const queued: unknown[] = []
    let release: () => void = () => undefined
    const pendingMode = new Promise<void>((resolve) => {
      release = resolve
    })
    const submit = submitInput({
      shouldQueue: () => true,
      onQueue: (draft) => queued.push(draft),
      flushPermissionMode: () => pendingMode,
    })

    const submitted = submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await flush()
    expect(queued).toHaveLength(0)
    expect(promptResetCalls).toHaveLength(0)

    release()
    await submitted
    expect(queued).toHaveLength(1)
    expect(promptResetCalls).toHaveLength(1)
  })

  test("keeps a busy follow-up draft out of the queue when permission persistence fails", async () => {
    params = { id: "session-1" }
    const queued: unknown[] = []
    const submit = submitInput({
      shouldQueue: () => true,
      onQueue: (draft) => queued.push(draft),
      flushPermissionMode: () => Promise.reject(new Error("permission mode failed")),
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)

    expect(queued).toHaveLength(0)
    expect(promptResetCalls).toHaveLength(0)
    expect(toastCalls).toContainEqual({
      title: "common.requestFailed",
      description: "permission mode failed",
    })
  })

  test("enforces permission preflight at the shared follow-up API boundary", async () => {
    let release: () => void = () => undefined
    const pendingMode = new Promise<void>((resolve) => {
      release = resolve
    })
    const sending = sendFollowupDraft({
      client: clientFor("/repo/main") as unknown as Parameters<typeof sendFollowupDraft>[0]["client"],
      sync: followupSync(),
      globalSync: followupGlobalSync(),
      preflight: () => pendingMode,
      draft: {
        sessionID: "session-1",
        sessionDirectory: "/repo/main",
        prompt: [{ type: "text", content: "queued turn", start: 0, end: 11 }],
        context: [],
        agent: "agent",
        model: { providerID: "provider", modelID: "model" },
      },
    })

    await flush()
    expect(sentPrompts).toHaveLength(0)
    expect(optimisticUsers()).toHaveLength(0)

    release()
    expect(await sending).toBe(true)
    expect(sentPrompts).toHaveLength(1)
  })

  test("does not touch optimistic state or session APIs when shared preflight fails", async () => {
    await expect(
      sendFollowupDraft({
        client: clientFor("/repo/main") as unknown as Parameters<typeof sendFollowupDraft>[0]["client"],
        sync: followupSync(),
        globalSync: followupGlobalSync(),
        preflight: () => Promise.reject(new Error("permission mode failed")),
        draft: {
          sessionID: "session-1",
          sessionDirectory: "/repo/main",
          prompt: [{ type: "text", content: "/testcmd hello", start: 0, end: 14 }],
          context: [],
          agent: "agent",
          model: { providerID: "provider", modelID: "model" },
        },
      }),
    ).rejects.toThrow("permission mode failed")

    expect(sentPrompts).toHaveLength(0)
    expect(sentCommands).toHaveLength(0)
    expect(optimisticUsers()).toHaveLength(0)
  })

  test("wires permission preflight into every session follow-up sender", async () => {
    const source = await Bun.file(new URL("../../pages/session.tsx", import.meta.url)).text()
    const queueMutation = source.slice(source.indexOf("const followupMutation"), source.indexOf("const sendFollowup ="))

    expect(source).toContain('import { usePermission } from "@/context/permission"')
    expect(source).toContain("const permission = usePermission()")
    const senderCount = source.match(/sendFollowupDraft\(\{/g)?.length ?? 0
    const preflightCount =
      source.match(/sendFollowupDraft\(\{[\s\S]*?preflight: (?:permission\.flush|async \(\) => \{)/g)?.length ?? 0
    // 会话发送入口可以随队列架构收敛，但每一个现存入口都必须经过同一权限落盘屏障。
    expect(senderCount).toBeGreaterThan(0)
    expect(preflightCount).toBe(senderCount)
    // 队列 mutation 的二次预检还必须复核生命周期与运行态，不能只完成权限落盘就直接发网。
    expect(queueMutation).toContain("followupSendGateWorking")
    expect(queueMutation).toContain("followupSendGateOpen")
    expect(queueMutation).toContain("manualSteerSendBlocker")
    // 后台 steer 必须携带原目录进入 mutation，并按该目录取持久化实例与 client。
    expect(source).toContain("const followupForDirectory = (directory: string) => followupScoped.forScope(directory)")
    expect(queueMutation).toContain("directory: string")
    expect(queueMutation).toContain("const directory = input.directory")
    expect(queueMutation).toContain("followupForDirectory(directory)")
    // 失败恢复必须先清理 optimistic user，避免豁免 ID 释放后去重 effect 吞掉草稿只留下幽灵气泡。
    expect(queueMutation).toContain("durable ACK 未确认时必须先撤销同 ID 气泡")
    // dequeue 前的首层权限失败也要撤销预展示，否则失败项会被豁免 ID 隐藏在 Dock 外。
    expect(queueMutation).toContain("页面预检失败发生在 dequeue 前")
    const permissionIndex = queueMutation.indexOf("await permission.flush()")
    const messageIdentityIndex = queueMutation.indexOf("const messageID = followupMessageID")
    const dequeueIndex = queueMutation.indexOf(
      'setFollowupHere("items", input.sessionID, (current) => (current ?? []).filter',
    )
    // 预检前允许恢复已经失效的本地草稿；真正创建网络身份和移出队列仍必须严格晚于权限落盘。
    expect(permissionIndex).toBeGreaterThan(-1)
    expect(permissionIndex).toBeLessThan(messageIdentityIndex)
    expect(permissionIndex).toBeLessThan(dequeueIndex)
  })
})

describe("existing session submit preflight", () => {
  test("restores the submitted input when the page preflight blocks sending", async () => {
    params = { id: "session-1" }
    const original = promptValue
    const submit = submitInput({ onBeforeSubmitExistingSession: () => false })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)

    // 页面层未准备好时不发送，但必须走统一恢复路径，保持输入快照和后续聚焦调度。
    expect(sentPrompts).toHaveLength(0)
    expect(promptSetCalls).toEqual([original])
  })
})

describe("prompt submit worktree selection", () => {
  test("reads the latest worktree accessor value per submit", async () => {
    const submit = createPromptSubmit({
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      mode: () => "shell",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)
    selected = "/repo/worktree-b"
    await submit.handleSubmit(event)

    expect(createdClients).toEqual(["/repo/worktree-a", "/repo/worktree-b"])
    expect(createdSessions).toEqual(["/repo/worktree-a", "/repo/worktree-b"])
    expect(sentShell).toEqual(["/repo/worktree-a", "/repo/worktree-b"])
    expect(syncedDirectories).toEqual(["/repo/worktree-a", "/repo/worktree-a", "/repo/worktree-b", "/repo/worktree-b"])
    expect(promoted).toEqual([
      { directory: "/repo/worktree-a", sessionID: expect.stringMatching(/^ses_/) },
      { directory: "/repo/worktree-b", sessionID: expect.stringMatching(/^ses_/) },
    ])
    expect(syncedDirectories).toEqual(["/repo/worktree-a", "/repo/worktree-a", "/repo/worktree-b", "/repo/worktree-b"])
  })

  test("keeps a late session.create ACK in its origin without stealing the current route or composer", async () => {
    params = { id: "session-stale-parent" }
    let visibleSessionID: string | undefined
    promptValue = [{ type: "text", content: "新会话后台提交", start: 0, end: 7 }]
    const gate = Promise.withResolvers<void>()
    sessionCreateGate = gate.promise
    const submit = submitInput({
      info: () => (visibleSessionID ? { id: visibleSessionID } : undefined),
      // 权威 URL 解析明确返回 undefined 时仍是新建页，不能回退到 useParams 残留的旧 ID。
      sessionID: () => visibleSessionID,
      routeIdentity: () => `/repo/main/${visibleSessionID ?? ""}`,
    })

    const sending = submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await flush()
    // 创建请求在途时用户进入另一个会话并开始输入，旧 ACK 只能完成自己的后台请求。
    visibleSessionID = "session-current"
    promptValue = [{ type: "text", content: "当前会话的新草稿", start: 0, end: 8 }]
    gate.resolve()
    await sending

    expect(createdSessions).toEqual(["/repo/main"])
    expect(navigateCalls).toHaveLength(0)
    expect(promoted).toHaveLength(0)
    expect(promptResetCalls).toHaveLength(0)
    expect(promptValue[0]).toMatchObject({ content: "当前会话的新草稿" })
    expect(sentPrompts).toHaveLength(1)
    expect(sentPrompts[0]?.payload.sessionID).toMatch(/^ses_/)
    expect(sentPrompts[0]?.payload.sessionID).not.toBe("session-current")
  })

  test("creates an optimistic session when session.create hits a transport error", async () => {
    shouldFailSessionCreate = true
    sessionCreateFailure = new TypeError("Failed to fetch")

    const submit = createPromptSubmit({
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onSubmit: () => undefined,
      // 完整耗尽 5 次失败重试，但不让生产 4.5 秒退避挤占 Bun 默认 5 秒用例预算。
      sessionCreateRetryDelayMs: 1,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await flush()

    expect(promoted).toHaveLength(1)
    expect(promoted[0]?.sessionID).toMatch(/^ses_/)
    expect(storedSessions["/repo/main"]?.[0]?.id).toMatch(/^ses_/)
    expect(navigateCalls).toHaveLength(1)
    expect(navigateCalls[0]).toMatch(/^\/\/repo\/main\/session\/ses_/)
    expect(toastCalls.some((toast) => toast.title === "prompt.toast.sessionCreateFailed.title")).toBe(false)
    expect(optimisticUsers()).toHaveLength(1)
  })

  test("does not create an optimistic session for unrelated TypeErrors", async () => {
    shouldFailSessionCreate = true
    sessionCreateFailure = new TypeError("Cannot read properties of undefined")

    const submit = createPromptSubmit({
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onSubmit: () => undefined,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await flush()

    expect(promoted).toHaveLength(0)
    expect(toastCalls.some((toast) => toast.title === "prompt.toast.sessionCreateFailed.title")).toBe(true)
  })

  test("defers navigation for shell sessions until sync succeeds", async () => {
    shouldFailSessionCreate = true
    sessionCreateFailure = new TypeError("Failed to fetch")

    const submit = createPromptSubmit({
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      mode: () => "shell",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onSubmit: () => undefined,
      // 保留完整 5 次后台重试，只缩短测试计时，避免生产 4.5 秒退避跨越用例边界。
      sessionCreateRetryDelayMs: 1,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await flush()

    expect(promoted).toHaveLength(1)
    expect(navigateCalls).toHaveLength(0)
    expect(sentShell).toHaveLength(0)

    // 首次创建失败后，后台必须精确执行 retry 配置中的 5 次尝试并完全退出。
    await waitForSessionCreateAttempts(6)
    expect(sessionCreateFailCount).toBe(6)
    expect(navigateCalls).toHaveLength(0)
    expect(sentShell).toHaveLength(0)
  })

  test("passes optimistic message id to slash commands on new sessions", async () => {
    shouldFailSessionCreate = true
    failSessionCreateTimes = 1
    syncCommands = [{ name: "testcmd" }]
    promptValue = [{ type: "text", content: "/testcmd hello", start: 0, end: 13 }]
    commandDelayResolve = () => undefined

    const submit = createPromptSubmit({
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onSubmit: () => undefined,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await flush()

    expect(navigateCalls).toHaveLength(1)
    expect(optimisticUsers()).toHaveLength(1)
    expect(optimisticUsers()[0]?.parts?.some((part) => part.type === "text" && part.text.includes("/testcmd"))).toBe(
      true,
    )
    expect(sentCommands).toHaveLength(1)
    expect(sentCommands[0]?.payload.messageID).toBe(optimisticUsers()[0]?.message.id)
    commandDelayResolve?.()
    await flush()
    expect(optimisticUsers()).toHaveLength(1)
  })

  test("passes optimistic message id to slash commands for existing sessions", async () => {
    params = { id: "session-1" }
    syncCommands = [{ name: "testcmd" }]
    promptValue = [{ type: "text", content: "/testcmd hello", start: 0, end: 13 }]
    commandDelayResolve = () => undefined

    await submitInput().handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await flush()

    expect(optimisticUsers()).toHaveLength(1)
    expect(optimisticUsers()[0]?.parts?.some((part) => part.type === "text" && part.text.includes("/testcmd"))).toBe(
      true,
    )
    expect(sentCommands).toHaveLength(1)
    expect(sentCommands[0]?.payload.messageID).toBe(optimisticUsers()[0]?.message.id)
    commandDelayResolve?.()
    await flush()
    expect(optimisticUsers()).toHaveLength(1)
  })

  test("direct /rename submit updates the current session title instead of sending a chat message", async () => {
    params = { id: "session-1" }
    storedSessions["/repo/main"] = [{ id: "session-1", title: "旧标题", directory: "/repo/main" }]
    promptValue = [{ type: "text", content: "/rename 测试会话", start: 0, end: 12 }]

    await submitInput().handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await flush()

    expect(updatedSessions).toEqual([
      {
        directory: "/repo/main",
        payload: {
          sessionID: "session-1",
          directory: "/repo/main",
          title: "测试会话",
        },
      },
    ])
    expect(storedSessions["/repo/main"]?.[0]?.title).toBe("测试会话")
    expect(sentPrompts).toHaveLength(0)
    expect(sentCommands).toHaveLength(0)
    expect(optimisticUsers()).toHaveLength(0)
  })

  test("direct /rename submit keeps the current title when the update response has an error", async () => {
    params = { id: "session-1" }
    sessionUpdateError = new Error("rename failed")
    storedSessions["/repo/main"] = [{ id: "session-1", title: "旧标题", directory: "/repo/main" }]
    promptValue = [{ type: "text", content: "/rename 测试会话", start: 0, end: 12 }]

    await submitInput().handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await flush()

    expect(updatedSessions).toHaveLength(1)
    expect(storedSessions["/repo/main"]?.[0]?.title).toBe("旧标题")
    expect(sentPrompts).toHaveLength(0)
    expect(sentCommands).toHaveLength(0)
    expect(toastCalls).toContainEqual({
      title: "prompt.toast.commandSendFailed.title",
      description: "rename failed",
    })
  })

  test("passes optimistic message id to slash commands for queued follow-ups", async () => {
    syncCommands = [{ name: "testcmd" }]
    commandDelayResolve = () => undefined

    const sent = sendFollowupDraft({
      client: clientFor("/repo/main") as unknown as Parameters<typeof sendFollowupDraft>[0]["client"],
      sync: followupSync(),
      globalSync: followupGlobalSync(),
      preflight: permissionPreflight,
      draft: {
        sessionID: "session-1",
        sessionDirectory: "/repo/main",
        prompt: [{ type: "text", content: "/testcmd hello", start: 0, end: 13 }],
        context: [],
        agent: "agent",
        model: { providerID: "provider", modelID: "model" },
      },
    })
    await flush()

    expect(optimisticUsers()).toHaveLength(1)
    expect(optimisticUsers()[0]?.parts?.some((part) => part.type === "text" && part.text.includes("/testcmd"))).toBe(
      true,
    )
    expect(sentCommands).toHaveLength(1)
    expect(sentCommands[0]?.payload.messageID).toBe(optimisticUsers()[0]?.message.id)
    commandDelayResolve?.()
    expect(await sent).toBe(true)
    await flush()
    expect(optimisticUsers()).toHaveLength(1)
  })

  test("does not apply deprecated client approval to newly created sessions", async () => {
    const submit = createPromptSubmit({
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      mode: () => "shell",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)

    expect(legacyApprovalCalls).toEqual([])
  })

  test("includes the selected variant on optimistic prompts", async () => {
    params = { id: "session-1" }
    variant = "high"

    const submit = createPromptSubmit({
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)
    await flush()

    expect(optimisticUsers()).toHaveLength(1)
    expect(optimisticUsers()[0]).toMatchObject({
      message: {
        agent: "agent",
        model: { providerID: "provider", modelID: "model", variant: "high" },
      },
    })
  })

  test("uses the latest selected model per submit", async () => {
    params = { id: "session-1" }

    const current = { modelID: "model-a", providerID: "provider-a" }
    localModelCurrent = () => ({ id: current.modelID, provider: { id: current.providerID } })

    const submit = createPromptSubmit({
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)
    await flush()
    current.modelID = "model-b"
    current.providerID = "provider-b"
    await submit.handleSubmit(event)
    await flush()

    expect(optimisticUsers()).toHaveLength(2)
    expect(optimisticUsers()[0]?.message.model).toMatchObject({ providerID: "provider-a", modelID: "model-a" })
    expect(optimisticUsers()[1]?.message.model).toMatchObject({ providerID: "provider-b", modelID: "model-b" })
  })

  test("blocks paid WanlaiCode models before sending when no entitlement", async () => {
    params = { id: "session-1" }
    localModelCurrent = () => ({
      id: "gpt-5.5",
      name: "GPT 5.5",
      provider: { id: "wanlaicode", options: { apiKey: "__wanlaicode_no_entitlement__" } },
      capabilities: { output: { image: false } },
    })

    await submitInput().handleSubmit({ preventDefault: () => undefined } as unknown as Event)

    expect(optimistic).toHaveLength(0)
    expect(generatedImages).toHaveLength(0)
    expect(toastCalls).toContainEqual({
      title: "prompt.toast.noPlanModelBlocked.title",
      description: "prompt.toast.noPlanModelBlocked.description",
    })
  })

  test("keeps ordinary text model prompts in chat even when image models have no entitlement", async () => {
    params = { id: "session-1" }
    promptValue = [{ type: "text", content: "生成一张猫图", start: 0, end: 5 }]
    localModelCurrent = () => ({
      id: "deepseek-chat",
      name: "DeepSeek",
      provider: { id: "wanlaicode", options: { apiKey: "__wanlaicode_no_entitlement__" } },
      wanlaicode: { rate_multiplier: 0 },
      capabilities: { output: { image: false } },
    })
    localModelList = () => [
      localModelCurrent(),
      {
        id: "gpt-image-2",
        name: "GPT Image 2",
        provider: { id: "wanlaicode", options: { apiKey: "__wanlaicode_no_entitlement__" } },
        capabilities: { output: { image: true } },
      },
    ]

    await submitInput().handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await flush()

    expect(classifiedImageIntents).toHaveLength(0)
    expect(generatedImages).toHaveLength(0)
    expect(sentPrompts).toHaveLength(1)
    expect(toastCalls).toHaveLength(0)
  })

  test("allows free WanlaiCode models when no entitlement", async () => {
    params = { id: "session-1" }
    localModelCurrent = () => ({
      id: "deepseek-chat",
      name: "DeepSeek",
      provider: { id: "wanlaicode", options: { apiKey: "__wanlaicode_no_entitlement__" } },
      wanlaicode: { rate_multiplier: 0 },
      capabilities: { output: { image: false } },
    })

    await submitInput().handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await flush()

    expect(optimisticUsers()).toHaveLength(1)
    expect(toastCalls).toHaveLength(0)
  })

  test("blocks stale DeepSeek fallback without backend free marker when no entitlement", async () => {
    params = { id: "session-1" }
    localModelCurrent = () => ({
      id: "deepseek-v4-flash",
      name: "DeepSeek V4 Flash",
      provider: { id: "wanlaicode", options: { apiKey: "__wanlaicode_no_entitlement__" } },
      capabilities: { output: { image: false } },
    })

    await submitInput().handleSubmit({ preventDefault: () => undefined } as unknown as Event)

    expect(optimistic).toHaveLength(0)
    expect(toastCalls).toContainEqual({
      title: "prompt.toast.noPlanModelBlocked.title",
      description: "prompt.toast.noPlanModelBlocked.description",
    })
  })

  test("uses the model selected after entering edit mode", async () => {
    params = { id: "session-1" }

    const current = { modelID: "model-a", providerID: "provider-a" }
    localModelCurrent = () => ({ id: current.modelID, provider: { id: current.providerID } })

    const submit = createPromptSubmit({
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    current.modelID = "model-b"
    current.providerID = "provider-b"
    await submit.handleSubmit(event)
    await flush()

    expect(optimisticUsers()).toHaveLength(1)
    expect(optimisticUsers()[0]?.message.model).toMatchObject({ providerID: "provider-b", modelID: "model-b" })
  })

  test("keeps the edited message variant after switching to the same model", async () => {
    params = { id: "session-1" }
    variant = "high"

    localModelCurrent = () => ({ id: "model-b", provider: { id: "provider-b" } })

    const submit = createPromptSubmit({
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)
    await flush()

    expect(optimisticUsers()).toHaveLength(1)
    expect(optimisticUsers()[0]?.message.model).toMatchObject({
      providerID: "provider-b",
      modelID: "model-b",
      variant: "high",
    })
  })

  test("seeds new sessions before optimistic prompts are added", async () => {
    const submit = createPromptSubmit({
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)
    await flush()

    expect(storedSessions["/repo/worktree-a"]).toEqual([
      {
        id: expect.stringMatching(/^ses_/),
        title: "New session 1",
        directory: "/repo/worktree-a",
      },
    ])
    // 所有乐观消息都在 session seed 之后添加
    expect(optimisticSeeded.length).toBeGreaterThanOrEqual(1)
    expect(optimisticSeeded.every(Boolean)).toBe(true)
  })
})

describe("prompt submit image generation tool routing", () => {
  test("sends image-like prompts to chat for ordinary models without frontend intent classification", async () => {
    params = { id: "session-1" }
    promptValue = [{ type: "text", content: "生成一张猫图", start: 0, end: 5 }]

    await submitInput().handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await flush()

    expect(classifiedImageIntents).toHaveLength(0)
    expect(generatedImages).toHaveLength(0)
    expect(sentPrompts).toHaveLength(1)
    expect(sentPrompts[0]?.payload).toMatchObject({
      model: { providerID: "provider", modelID: "model" },
    })
    expectNoOptimisticReasoning()
  })

  test("handleSubmit resolves after promptAsync completes", async () => {
    params = { id: "session-1" }
    const gate = Promise.withResolvers<void>()
    promptAsyncGate = gate.promise
    const state = { settled: false }

    const submitting = submitInput()
      .handleSubmit({ preventDefault: () => undefined } as unknown as Event)
      .finally(() => {
        state.settled = true
      })

    await flush()
    expect(sentPrompts).toHaveLength(1)
    const settledBeforeRelease = state.settled
    gate.resolve()
    await submitting

    expect(settledBeforeRelease).toBe(false)
    expect(state.settled).toBe(true)
  })

  test("deduplicates rapid repeated prompt submits", async () => {
    params = { id: "session-1" }
    promptValue = [{ type: "text", content: "生成10张鱼会飞的图片", start: 0, end: 11 }]
    const submit = submitInput()
    const event = { preventDefault: () => undefined } as unknown as Event

    const first = submit.handleSubmit(event)
    const second = submit.handleSubmit(event)
    await Promise.all([first, second])
    await flush()

    expect(sentPrompts).toHaveLength(1)
    expect(optimisticUsers()).toHaveLength(1)
  })

  test("forwards a new steering snapshot while the previous durable ACK is pending", async () => {
    params = { id: "session-1" }
    promptValue = [{ type: "text", content: "第一条引导", start: 0, end: 5 }]
    const gate = Promise.withResolvers<void>()
    const submitted: string[] = []
    const submit = submitInput({
      working: () => true,
      shouldSteer: () => true,
      onSteer: async (draft) => {
        submitted.push(draft.prompt.map((part) => ("content" in part ? part.content : "")).join(""))
        await gate.promise
      },
    })
    const event = { preventDefault: () => undefined } as unknown as Event

    const first = submit.handleSubmit(event)
    await flush()
    promptValue = [{ type: "text", content: "ACK 前的新输入", start: 0, end: 8 }]
    const second = submit.handleSubmit(event)
    await flush()

    // 页面层会立刻给两条不同输入分配稳定 ID 并进入同一会话 FIFO，第二次回车不能无提示丢失。
    expect(submitted).toEqual(["第一条引导", "ACK 前的新输入"])
    gate.resolve()
    await Promise.all([first, second])
  })

  test("keeps direct steering single-flight when repeated submits share a pending permission preflight", async () => {
    params = { id: "session-1" }
    promptValue = [{ type: "text", content: "等待权限后的引导", start: 0, end: 8 }]
    const permissionGate = Promise.withResolvers<void>()
    const steerGate = Promise.withResolvers<void>()
    const submitted: string[] = []
    const submit = submitInput({
      working: () => true,
      shouldSteer: () => true,
      flushPermissionMode: () => permissionGate.promise,
      onSteer: async (draft) => {
        submitted.push(draft.prompt.map((part) => ("content" in part ? part.content : "")).join(""))
        await steerGate.promise
      },
    })
    const event = { preventDefault: () => undefined } as unknown as Event

    const first = submit.handleSubmit(event)
    const second = submit.handleSubmit(event)
    permissionGate.resolve()
    await flush()

    // 两次提交都跨过预检后，只有第一个请求可以取得 durable ACK 锁。
    expect(submitted).toEqual(["等待权限后的引导"])
    steerGate.resolve()
    await Promise.all([first, second])
  })

  test("preserves a newer draft typed while steering waits for permission persistence", async () => {
    params = { id: "session-1" }
    promptValue = [{ type: "text", content: "先提交这条", start: 0, end: 5 }]
    const permissionGate = Promise.withResolvers<void>()
    const submitted: string[] = []
    const submit = submitInput({
      working: () => true,
      shouldSteer: () => true,
      flushPermissionMode: () => permissionGate.promise,
      onSteer: (draft) => {
        submitted.push(draft.prompt.map((part) => ("content" in part ? part.content : "")).join(""))
      },
    })

    const sending = submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await flush()
    promptValue = [{ type: "text", content: "预检期间的新草稿", start: 0, end: 8 }]
    permissionGate.resolve()
    await sending

    // 旧提交仍按原快照进入队列，但它完成预检后不能清空用户随后输入的新草稿。
    expect(submitted).toEqual(["先提交这条"])
    expect(promptValue.map((part) => ("content" in part ? part.content : "")).join("")).toBe("预检期间的新草稿")
    expect(promptResetCalls).toHaveLength(0)
  })

  test("keeps an immutable submit snapshot when the live prompt store mutates in place", async () => {
    params = { id: "session-1" }
    const [livePrompt, setLivePrompt] = createStore({
      value: [{ type: "text", content: "原地修改前的引导", start: 0, end: 8 }] as Prompt,
    })
    promptValue = livePrompt.value
    const permissionGate = Promise.withResolvers<void>()
    const submitted: string[] = []
    const submit = submitInput({
      working: () => true,
      shouldSteer: () => true,
      flushPermissionMode: () => permissionGate.promise,
      onSteer: (draft) => {
        submitted.push(draft.prompt.map((part) => ("content" in part ? part.content : "")).join(""))
      },
    })

    const sending = submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await flush()
    // 真实 Solid store 会原地更新现有 part；测试不能只靠重新赋值数组掩盖活代理污染问题。
    setLivePrompt("value", 0, (part) =>
      part.type === "text" ? { ...part, content: "预检期间原地输入的新草稿" } : part,
    )
    permissionGate.resolve()
    await sending

    expect(submitted).toEqual(["原地修改前的引导"])
    expect(promptValue[0]).toMatchObject({ content: "预检期间原地输入的新草稿" })
  })

  test("deeply snapshots nested prompt metadata at the submit boundary", () => {
    const live: Prompt = [
      {
        type: "file",
        path: "/repo/file.ts",
        content: "file",
        start: 0,
        end: 4,
        selection: { startLine: 1, startChar: 0, endLine: 2, endChar: 3 },
        pastedText: { characterCount: 4 },
      },
      {
        type: "image",
        id: "snapshot-1",
        filename: "snapshot.png",
        mime: "image/png",
        dataUrl: "data:image/png;base64,AAAA",
        appSnapshot: {
          appName: "Terminal",
          windowTitle: "提交时窗口",
          displayID: "display-1",
          imageWidth: 1200,
          imageHeight: 800,
          accessibilityText: "提交时内容",
          accessibilityTrusted: true,
          textTruncated: false,
          capturedAt: 1,
        },
      },
    ]
    const snapshot = snapshotPromptForSubmit(live)

    // 选择范围、粘贴元数据和应用快照都不能共享引用，否则附件队列会在 ACK 前静默变形。
    const liveFile = live[0]
    if (liveFile?.type === "file") {
      liveFile.selection!.startLine = 99
      liveFile.pastedText!.characterCount = 99
    }
    const liveImage = live[1]
    if (liveImage?.type === "image") liveImage.appSnapshot!.windowTitle = "后续捕获窗口"
    expect(snapshot[0]).toMatchObject({
      selection: { startLine: 1 },
      pastedText: { characterCount: 4 },
    })
    expect(snapshot[1]).toMatchObject({ appSnapshot: { windowTitle: "提交时窗口" } })
  })

  test("preserves an identical draft in another session while the previous steering preflight finishes", async () => {
    params = { id: "session-1" }
    promptValue = [{ type: "text", content: "两个会话都要保留", start: 0, end: 8 }]
    const permissionGate = Promise.withResolvers<void>()
    const submitted: string[] = []
    const submit = submitInput({
      info: () => ({ id: params.id! }),
      working: () => true,
      shouldSteer: () => true,
      flushPermissionMode: () => permissionGate.promise,
      onSteer: (draft) => {
        submitted.push(draft.sessionID)
      },
    })

    const sending = submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await flush()
    // 用户切到另一会话并输入相同文本时，旧会话预检完成也不能把当前编辑器当成自己的快照清空。
    params.id = "session-2"
    promptValue = [{ type: "text", content: "两个会话都要保留", start: 0, end: 8 }]
    permissionGate.resolve()
    await sending

    expect(submitted).toEqual(["session-1"])
    expect(promptValue.map((part) => ("content" in part ? part.content : "")).join("")).toBe("两个会话都要保留")
    expect(promptResetCalls).toHaveLength(0)
  })

  test("uses the origin steer decision when permission preflight finishes after a route switch", async () => {
    params = { id: "session-1" }
    promptValue = [{ type: "text", content: "继续原会话", start: 0, end: 6 }]
    const gate = Promise.withResolvers<void>()
    const steered: string[] = []
    const queued: string[] = []
    const submit = submitInput({
      info: () => ({ id: params.id! }),
      sessionID: () => params.id,
      routeIdentity: () => `/repo/main/${params.id ?? ""}`,
      working: () => true,
      shouldSteer: () => params.id === "session-1",
      shouldQueue: () => params.id === "session-2",
      flushPermissionMode: () => gate.promise,
      onSteer: (draft) => {
        steered.push(draft.sessionID)
      },
      onQueue: (draft) => queued.push(draft.sessionID),
    })

    const sending = submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await flush()
    params.id = "session-2"
    promptValue = [{ type: "text", content: "另一个会话草稿", start: 0, end: 7 }]
    gate.resolve()
    await sending

    expect(steered).toEqual(["session-1"])
    expect(queued).toHaveLength(0)
    expect(promptResetCalls).toHaveLength(0)
    expect(promptValue[0]).toMatchObject({ content: "另一个会话草稿" })
  })

  test("keeps slash command classification from the submit snapshot across permission waits", async () => {
    params = { id: "session-1" }
    syncCommands = [{ name: "testcmd" }]
    promptValue = [{ type: "text", content: "/testcmd hello", start: 0, end: 14 }]
    const gate = Promise.withResolvers<void>()
    const submit = submitInput({
      sessionID: () => params.id,
      routeIdentity: () => `/repo/main/${params.id ?? ""}`,
      flushPermissionMode: () => gate.promise,
    })

    const sending = submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await flush()
    // 新目录没有同名命令时，旧输入仍须按点击时的命令表发送 command，而不是变成普通 prompt。
    params.id = "session-2"
    syncCommands = []
    gate.resolve()
    await sending
    await flush()

    expect(sentCommands).toHaveLength(1)
    expect(sentCommands[0]?.payload.sessionID).toBe("session-1")
    expect(sentPrompts).toHaveLength(0)
    expect(promptResetCalls).toHaveLength(0)
  })

  test("isolates identical steering snapshots by session while the first ACK is pending", async () => {
    params = { id: "session-1" }
    promptValue = [{ type: "text", content: "两个会话都要处理", start: 0, end: 8 }]
    const firstGate = Promise.withResolvers<void>()
    const submitted: string[] = []
    const submit = submitInput({
      info: () => ({ id: params.id! }),
      working: () => true,
      shouldSteer: () => true,
      onSteer: async (draft) => {
        submitted.push(draft.sessionID)
        if (draft.sessionID === "session-1") await firstGate.promise
      },
    })
    const event = { preventDefault: () => undefined } as unknown as Event

    const first = submit.handleSubmit(event)
    await flush()
    // 同一项目切到另一会话后，即使文本完全相同，也必须拥有独立的提交身份和 ACK 锁。
    params.id = "session-2"
    await submit.handleSubmit(event)

    expect(submitted).toEqual(["session-1", "session-2"])
    firstGate.resolve()
    await first
  })

  test("aborts instead of submitting text when the session is running", async () => {
    params = { id: "session-1" }
    promptValue = [{ type: "text", content: "", start: 0, end: 0 }]
    const gate = Promise.withResolvers<void>()
    abortGate = gate.promise
    const submit = submitInput({
      working: () => true,
      activeTurnID: (sessionID) => (sessionID === "session-1" ? "turn-current" : undefined),
      onAbort: () => abortSequence.push("pause"),
      onAbortComplete: (sessionID) => abortSequence.push(`complete:${sessionID}`),
    })

    const stopping = submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await flush()
    // 请求在途时切换会话，完成回调仍必须清理原会话，不能误清理新页面的停止状态。
    params.id = "session-2"
    gate.resolve()
    await stopping
    await flush()

    expect(abortedSessions).toEqual(["session-1"])
    expect(abortedTurnIDs).toEqual(["turn-current"])
    // follow-up 队列必须先暂停，再发布 idle 状态，防止停止回合时自动队列抢跑。
    expect(abortSequence).toEqual(["pause", "idle", "complete:session-1"])
    expect(sentPrompts).toHaveLength(0)
    expect(optimisticUsers()).toHaveLength(0)
  })

  test("uses the authoritative session accessor when stale router params still point at another conversation", async () => {
    params = { id: "session-stale" }
    promptValue = [{ type: "text", content: "", start: 0, end: 0 }]
    const submit = submitInput({
      sessionID: () => "session-visible",
      routeIdentity: () => "/repo/main/session-visible",
      working: () => true,
      activeTurnID: (sessionID) => (sessionID === "session-visible" ? "turn-visible" : "turn-stale"),
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await flush()

    expect(abortedSessions).toEqual(["session-visible"])
    expect(abortedTurnIDs).toEqual(["turn-visible"])
    expect(abortSequence).toContain("idle")
  })

  test("does not abort a non-empty follow-up when a stale running state remains", async () => {
    params = { id: "session-1" }
    promptValue = [{ type: "text", content: "失败后继续问一句", start: 0, end: 8 }]
    const submit = submitInput({ working: () => true, shouldQueue: () => false })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await flush()

    expect(abortedSessions).toHaveLength(0)
    expect(sentPrompts).toHaveLength(1)
    expect(optimisticUsers()).toHaveLength(1)
  })

  test("syncs editor content before checking whether submit is empty", async () => {
    params = { id: "session-1" }
    promptValue = [{ type: "text", content: "", start: 0, end: 0 }]
    const submit = submitInput({
      syncEditorBeforeSubmit: () => {
        promptValue = [{ type: "text", content: "DOM 里刚输入的文字", start: 0, end: 11 }]
      },
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await flush()

    expect(sentPrompts).toHaveLength(1)
    expect(sentPrompts[0]?.payload.parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "text",
          text: "DOM 里刚输入的文字",
        }),
      ]),
    )
  })

  test("keeps multimodal text models on the normal chat path", async () => {
    params = { id: "session-1" }
    promptValue = [{ type: "text", content: "测试", start: 0, end: 2 }]
    localModelCurrent = () => ({
      id: "gpt-5.5",
      name: "GPT 5.5",
      provider: { id: "wanlaicode" },
      capabilities: { output: { text: true, image: true } },
    })

    await submitInput().handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await flush()

    expect(generatedImages).toHaveLength(0)
    expect(sentPrompts).toHaveLength(1)
    expect(optimisticUsers()).toHaveLength(1)
    expect(sentPrompts[0]?.payload).toMatchObject({
      model: { providerID: "wanlaicode", modelID: "gpt-5.5" },
    })
  })

  test("sends previous-image edit wording to chat for ordinary models", async () => {
    params = { id: "session-1" }
    promptValue = [{ type: "text", content: "把上一张图改成赛博朋克风", start: 0, end: 12 }]
    syncMessages = { "session-1": [assistantMessage("msg_1")] }
    syncParts = { msg_1: [filePart("msg_1", "data:image/png;base64,previous")] }

    await submitInput().handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await flush()

    expect(classifiedImageIntents).toHaveLength(0)
    expect(generatedImages).toHaveLength(0)
    expect(sentPrompts).toHaveLength(1)
  })

  test("routes the explicit image model path through normal promptAsync", async () => {
    params = { id: "session-1" }
    localModelCurrent = () => imageModel
    promptValue = [{ type: "text", content: "生成一张猫图", start: 0, end: 6 }]
    syncMessages = { "session-1": [assistantMessage("msg_1")] }
    syncParts = { msg_1: [textPart("msg_1", "主题是星空下的猫咪宇航员。")] }

    await submitInput({
      imageGeneration: () => ({ enabled: true, count: 2, size: "1024x1024" }),
    }).handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await flush()

    expect(classifiedImageIntents).toHaveLength(0)
    expect(generatedImages).toHaveLength(0)
    expect(sentPrompts).toHaveLength(1)
    expect(sentPrompts[0]?.payload).toMatchObject({
      model: { providerID: "wanlaicode", modelID: "gpt-image-2" },
      imageGeneration: {
        count: 2,
        size: "1024x1024",
        output_format: "png",
        failure_prefix: "prompt.imageGeneration.message.failed",
        loading_text: "prompt.imageGeneration.message.loading",
        error_messages: {
          group_disabled: "prompt.imageGeneration.error.groupDisabled",
          upgrade_required: "errors.category.upgrade_required",
        },
      },
    })
    expect(sentPrompts[0]?.payload.parts).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "text", text: "生成一张猫图" })]),
    )
  })

  test("passes current image attachments through normal promptAsync for explicit image models", async () => {
    params = { id: "session-1" }
    localModelCurrent = () => imageModel
    promptValue = [{ type: "text", content: "把这张图改成水彩风", start: 0, end: 9 }]

    await submitInput({
      imageAttachments: () => [
        {
          type: "image",
          id: "img",
          filename: "current.png",
          mime: "image/png",
          dataUrl: "data:image/png;base64,current",
        },
      ],
    }).handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await flush()

    expect(classifiedImageIntents).toHaveLength(0)
    expect(generatedImages).toHaveLength(0)
    expect(sentPrompts).toHaveLength(1)
    expect(sentPrompts[0]?.payload.parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "file",
          mime: "image/png",
          filename: "current.png",
          url: "data:image/png;base64,current",
        }),
      ]),
    )
  })

  test("lets the backend image tool collect recent chat images for explicit image models", async () => {
    params = { id: "session-1" }
    localModelCurrent = () => imageModel
    promptValue = [{ type: "text", content: "把上一张图改成赛博朋克风", start: 0, end: 12 }]
    syncMessages = { "session-1": [assistantMessage("msg_1")] }
    syncParts = { msg_1: [filePart("msg_1", "data:image/png;base64,previous")] }

    await submitInput().handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await flush()

    expect(classifiedImageIntents).toHaveLength(0)
    expect(generatedImages).toHaveLength(0)
    expect(sentPrompts).toHaveLength(1)
    expect(sentPrompts[0]?.payload).toMatchObject({
      model: { providerID: "wanlaicode", modelID: "gpt-image-2" },
      imageGeneration: {
        output_format: "png",
        failure_prefix: "prompt.imageGeneration.message.failed",
        loading_text: "prompt.imageGeneration.message.loading",
        error_messages: {
          group_disabled: "prompt.imageGeneration.error.groupDisabled",
          upgrade_required: "errors.category.upgrade_required",
        },
      },
    })
  })

  test("sends queued follow-up drafts to chat without frontend intent routing", async () => {
    syncMessages = { "session-1": [userMessage("msg_1"), assistantMessage("msg_2")] }
    syncParts = {
      msg_1: [filePart("msg_1", "data:image/png;base64,user-upload"), textPart("msg_1", "这个图片里有什么？")],
      msg_2: [textPart("msg_2", "图片是一个 macOS 上的万来 Code 界面截图。")],
    }

    await sendFollowupDraft({
      client: clientFor("/repo/main") as unknown as Parameters<typeof sendFollowupDraft>[0]["client"],
      sync: followupSync(),
      globalSync: followupGlobalSync(),
      preflight: permissionPreflight,
      draft: {
        sessionID: "session-1",
        sessionDirectory: "/repo/main",
        prompt: [{ type: "text", content: "能不能改好看点", start: 0, end: 7 }],
        context: [],
        agent: "agent",
        model: { providerID: "provider", modelID: "model" },
      },
    })
    await flush()

    expect(classifiedImageIntents).toHaveLength(0)
    expect(generatedImages).toHaveLength(0)
    expect(sentPrompts).toHaveLength(1)
    expect(sentPrompts[0]?.payload).toMatchObject({
      model: { providerID: "provider", modelID: "model" },
    })
  })

  test("bounds a queued follow-up ACK so the queue claim cannot hang forever", async () => {
    const client = clientFor("/repo/main")
    client.session.promptAsync = async () => new Promise<never>(() => undefined)

    await expect(
      sendFollowupDraft({
        client: client as unknown as Parameters<typeof sendFollowupDraft>[0]["client"],
        sync: followupSync(),
        globalSync: followupGlobalSync(),
        preflight: permissionPreflight,
        steerAckTimeoutMs: 5,
        draft: {
          sessionID: "session-1",
          sessionDirectory: "/repo/main",
          prompt: [{ type: "text", content: "普通队列不能永久等待", start: 0, end: 10 }],
          context: [],
          agent: "agent",
          model: { providerID: "provider", modelID: "model" },
        },
      }),
    ).rejects.toMatchObject({ name: "TimeoutError" })

    // 超时会撤销乐观用户消息；页面层随后可以释放发送认领并恢复队列草稿。
    expect(optimisticUsers()).toHaveLength(0)
  })

  test("routes manual steering through the dedicated steer endpoint", async () => {
    await sendFollowupDraft({
      client: clientFor("/repo/main") as unknown as Parameters<typeof sendFollowupDraft>[0]["client"],
      sync: followupSync(),
      globalSync: followupGlobalSync(),
      preflight: permissionPreflight,
      steer: true,
      targetTurnID: "turn-active",
      messageID: "msg-steer",
      draft: {
        sessionID: "session-1",
        sessionDirectory: "/repo/main",
        prompt: [{ type: "text", content: "改成排行榜", start: 0, end: 5 }],
        context: [],
        agent: "agent",
        model: { providerID: "provider", modelID: "model" },
      },
    })

    // 引导必须只提交一次独立协议；普通异步入口不能再创建第二个用户回合。
    expect(sentSteers).toHaveLength(1)
    expect(sentSteers[0]?.payload).toMatchObject({
      sessionID: "session-1",
      messageID: "msg-steer",
      targetTurnID: "turn-active",
      model: { providerID: "provider", modelID: "model" },
    })
    // 对齐 ChatGPT：steer 请求等待 ACK 时，消息已经带目标 turn 出现在当前时间线，而不是继续留在 Dock。
    expect(optimisticUsers()).toHaveLength(1)
    expect(optimisticUsers()[0]?.message).toMatchObject({
      id: "msg-steer",
      role: "user",
      steerTargetTurnID: "turn-active",
    })
    expect(sentPrompts).toHaveLength(0)
  })

  test("retargets an optimistic steer and retries once when the server reports the active turn", async () => {
    const client = clientFor("/repo/main")
    const targets: string[] = []
    const retargeted: string[] = []
    client.session.steer = async (payload: Record<string, unknown>) => {
      targets.push(String(payload.targetTurnID))
      if (targets.length === 1) {
        throw {
          name: "SteerTurnInactiveError",
          data: { expectedTurnID: "turn-old", actualTurnID: "turn-active" },
        }
      }
      return { data: { messageID: String(payload.messageID), targetTurnID: String(payload.targetTurnID) } }
    }

    await sendFollowupDraft({
      client: client as unknown as Parameters<typeof sendFollowupDraft>[0]["client"],
      sync: followupSync(),
      globalSync: followupGlobalSync(),
      preflight: permissionPreflight,
      steer: true,
      targetTurnID: "turn-old",
      messageID: "msg-steer-retarget",
      onSteerRetarget: (turnID) => retargeted.push(turnID),
      draft: {
        sessionID: "session-1",
        sessionDirectory: "/repo/main",
        prompt: [{ type: "text", content: "继续当前任务", start: 0, end: 6 }],
        context: [],
        agent: "agent",
        model: { providerID: "provider", modelID: "model" },
      },
    })

    // 对齐官方：expected mismatch 只改绑同一 optimistic item，不创建普通新回合。
    expect(targets).toEqual(["turn-old", "turn-active"])
    expect(retargeted).toEqual(["turn-active"])
    expect(optimisticUsers()).toHaveLength(1)
    expect(optimisticUsers()[0]?.message.steerTargetTurnID).toBe("turn-active")
    expect(sentPrompts).toHaveLength(0)
  })

  test("retries one exact mismatch even when the reported target is unchanged", async () => {
    const client = clientFor("/repo/main")
    const targets: string[] = []
    const retargeted: string[] = []
    client.session.steer = async (payload: Record<string, unknown>) => {
      targets.push(String(payload.targetTurnID))
      if (targets.length === 1) {
        throw "expected active turn id `turn-active` but found `turn-active`"
      }
      return { data: { messageID: String(payload.messageID), targetTurnID: String(payload.targetTurnID) } }
    }

    await sendFollowupDraft({
      client: client as unknown as Parameters<typeof sendFollowupDraft>[0]["client"],
      sync: followupSync(),
      globalSync: followupGlobalSync(),
      preflight: permissionPreflight,
      steer: true,
      targetTurnID: "turn-active",
      messageID: "msg-steer-same-target-retry",
      onSteerRetarget: (turnID) => retargeted.push(turnID),
      draft: {
        sessionID: "session-1",
        sessionDirectory: "/repo/main",
        prompt: [{ type: "text", content: "按服务端结果重试", start: 0, end: 8 }],
        context: [],
        agent: "agent",
        model: { providerID: "provider", modelID: "model" },
      },
    })

    // 官方 l9 只要精确 mismatch 带 actual 就重试；目标未变化时无需重写 optimistic 状态。
    expect(targets).toEqual(["turn-active", "turn-active"])
    expect(retargeted).toHaveLength(0)
    expect(optimisticUsers()).toHaveLength(1)
    expect(sentPrompts).toHaveLength(0)
  })

  test("falls back to a normal turn only when the steer target has no active replacement", async () => {
    const client = clientFor("/repo/main")
    const fallbacks: string[] = []
    const steerPayloads: Record<string, unknown>[] = []
    client.session.steer = async (payload: Record<string, unknown>) => {
      steerPayloads.push(payload)
      throw {
        name: "SteerTurnInactiveError",
        data: { expectedTurnID: "turn-ended" },
      }
    }

    await sendFollowupDraft({
      client: client as unknown as Parameters<typeof sendFollowupDraft>[0]["client"],
      sync: followupSync(),
      globalSync: followupGlobalSync(),
      preflight: permissionPreflight,
      steer: true,
      targetTurnID: "turn-ended",
      messageID: "msg-steer-fallback",
      onSteerFallback: () => fallbacks.push("fallback"),
      draft: {
        sessionID: "session-1",
        sessionDirectory: "/repo/main",
        prompt: [{ type: "text", content: "作为新回合继续", start: 0, end: 7 }],
        context: [],
        agent: "agent",
        model: { providerID: "provider", modelID: "model" },
      },
    })

    // inactive fallback 复用稳定 messageID，并清除 steering 归属后调用普通 prompt/start。
    expect(fallbacks).toEqual(["fallback"])
    expect(sentPrompts).toHaveLength(1)
    expect(sentPrompts[0]?.payload.messageID).toBe("msg-steer-fallback")
    expect(sentPrompts[0]?.payload).toMatchObject({
      messageID: steerPayloads[0]?.messageID,
      parts: steerPayloads[0]?.parts,
      agent: steerPayloads[0]?.agent,
      model: steerPayloads[0]?.model,
    })
    expect(optimisticUsers()[0]?.message.steerTargetTurnID).toBeUndefined()
  })

  test("keeps a successful steer ACK after the sender lifecycle is stopped", async () => {
    const client = clientFor("/repo/main")
    const acknowledged = Promise.withResolvers<void>()
    const started = Promise.withResolvers<void>()
    let current = true
    client.session.steer = async (payload: Record<string, unknown>) => {
      started.resolve()
      await acknowledged.promise
      return { data: { messageID: String(payload.messageID), targetTurnID: String(payload.targetTurnID) } }
    }

    const sending = sendFollowupDraft({
      client: client as unknown as Parameters<typeof sendFollowupDraft>[0]["client"],
      sync: followupSync(),
      globalSync: followupGlobalSync(),
      preflight: permissionPreflight,
      steer: true,
      targetTurnID: "turn-active",
      messageID: "msg-steer-stopped-after-request",
      canContinue: () => current,
      draft: {
        sessionID: "session-1",
        sessionDirectory: "/repo/main",
        prompt: [{ type: "text", content: "停止竞态中的引导", start: 0, end: 8 }],
        context: [],
        agent: "agent",
        model: { providerID: "provider", modelID: "model" },
      },
    })

    await started.promise
    current = false
    acknowledged.resolve()

    // 请求发出后生命周期失效只能阻止后续写入；durable ACK 已成功时仍要让上层删除停止恢复项。
    expect(await sending).toBe(true)
    expect(optimisticUsers()).toHaveLength(1)
  })

  test("cancels a steer ACK wait when stop happens before durable acceptance", async () => {
    const client = clientFor("/repo/main")
    const started = Promise.withResolvers<void>()
    client.session.steer = async (_payload: Record<string, unknown>, options?: { signal?: AbortSignal }) => {
      started.resolve()
      return await new Promise<{ data: { messageID: string; targetTurnID: string } }>((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true })
      })
    }
    const controller = new AbortController()

    const sending = sendFollowupDraft({
      client: client as unknown as Parameters<typeof sendFollowupDraft>[0]["client"],
      sync: followupSync(),
      globalSync: followupGlobalSync(),
      preflight: permissionPreflight,
      steer: true,
      targetTurnID: "turn-active",
      messageID: "msg-steer-stopped-before-ack",
      signal: controller.signal,
      draft: {
        sessionID: "session-1",
        sessionDirectory: "/repo/main",
        prompt: [{ type: "text", content: "停止后自动恢复", start: 0, end: 7 }],
        context: [],
        agent: "agent",
        model: { providerID: "provider", modelID: "model" },
      },
    })

    await started.promise
    controller.abort(Object.assign(new Error("user stopped"), { name: "AbortError" }))

    // ACK 前取消必须立即结束网络等待并撤销 provisional user，上层才能恢复同一草稿而不等待超时。
    await expect(sending).rejects.toMatchObject({ name: "AbortError" })
    expect(optimisticUsers()).toHaveLength(0)
  })

  test("keeps a successful fallback ACK after the sender lifecycle is stopped", async () => {
    const client = clientFor("/repo/main")
    const acknowledged = Promise.withResolvers<void>()
    const started = Promise.withResolvers<void>()
    let current = true
    client.session.steer = async () => {
      throw { name: "SteerTurnInactiveError", data: { expectedTurnID: "turn-ended" } }
    }
    client.session.promptAsync = async () => {
      started.resolve()
      await acknowledged.promise
      return { data: undefined }
    }

    const sending = sendFollowupDraft({
      client: client as unknown as Parameters<typeof sendFollowupDraft>[0]["client"],
      sync: followupSync(),
      globalSync: followupGlobalSync(),
      preflight: permissionPreflight,
      steer: true,
      targetTurnID: "turn-ended",
      messageID: "msg-fallback-stopped-after-request",
      canContinue: () => current,
      draft: {
        sessionID: "session-1",
        sessionDirectory: "/repo/main",
        prompt: [{ type: "text", content: "停止竞态中的新回合", start: 0, end: 9 }],
        context: [],
        agent: "agent",
        model: { providerID: "provider", modelID: "model" },
      },
    })

    await started.promise
    current = false
    acknowledged.resolve()

    // inactive fallback 也复用同一 messageID；ACK 后不得恢复成第二份暂停草稿。
    expect(await sending).toBe(true)
    expect(optimisticUsers()[0]?.message).toMatchObject({
      id: "msg-fallback-stopped-after-request",
      steerTargetTurnID: undefined,
    })
  })

  test("keeps a successful queued prompt ACK after the sender lifecycle is stopped", async () => {
    const client = clientFor("/repo/main")
    const acknowledged = Promise.withResolvers<void>()
    const started = Promise.withResolvers<void>()
    let current = true
    client.session.promptAsync = async () => {
      started.resolve()
      await acknowledged.promise
      return { data: undefined }
    }

    const sending = sendFollowupDraft({
      client: client as unknown as Parameters<typeof sendFollowupDraft>[0]["client"],
      sync: followupSync(),
      globalSync: followupGlobalSync(),
      preflight: permissionPreflight,
      messageID: "msg-queue-stopped-after-request",
      canContinue: () => current,
      draft: {
        sessionID: "session-1",
        sessionDirectory: "/repo/main",
        prompt: [{ type: "text", content: "停止竞态中的普通队列", start: 0, end: 10 }],
        context: [],
        agent: "agent",
        model: { providerID: "provider", modelID: "model" },
      },
    })

    await started.promise
    current = false
    acknowledged.resolve()

    // 普通队列也必须以服务端 ACK 为最终结果，不能恢复出已经持久化的重复消息。
    expect(await sending).toBe(true)
    expect(optimisticUsers()[0]?.message.id).toBe("msg-queue-stopped-after-request")
  })

  test("announces fallback before a normal prompt ACK can be lost", async () => {
    const client = clientFor("/repo/main")
    const sequence: string[] = []
    const statuses: string[] = []
    client.session.steer = async () => {
      throw { name: "SteerTurnInactiveError", data: { expectedTurnID: "turn-ended" } }
    }
    client.session.promptAsync = async () => {
      sequence.push("prompt")
      throw new TypeError("Failed to fetch")
    }

    await expect(
      sendFollowupDraft({
        client: client as unknown as Parameters<typeof sendFollowupDraft>[0]["client"],
        sync: followupSync(),
        globalSync: {
          child: () => [
            {},
            (...args: unknown[]) => {
              const value = args[2]
              if (args[0] !== "session_status" || typeof value !== "object" || value === null || !("type" in value))
                return
              statuses.push(String(value.type))
            },
          ],
        } as unknown as Parameters<typeof sendFollowupDraft>[0]["globalSync"],
        preflight: permissionPreflight,
        steer: true,
        targetTurnID: "turn-ended",
        messageID: "msg-fallback-ack-lost",
        optimisticBusy: true,
        onSteerFallback: () => sequence.push("fallback"),
        draft: {
          sessionID: "session-1",
          sessionDirectory: "/repo/main",
          prompt: [{ type: "text", content: "断网后保持普通回合", start: 0, end: 9 }],
          context: [],
          agent: "agent",
          model: { providerID: "provider", modelID: "model" },
        },
      }),
    ).rejects.toThrow("Failed to fetch")

    // 回调必须早于普通请求 ACK；上层据此用普通 user 规则查询同一 messageID，而不是恢复旧 steer。
    expect(sequence).toEqual(["fallback", "prompt"])
    // fallback 已经变成普通 start-turn；它写入的乐观 busy 在网络失败后必须立即清除，不能让输入框假忙到超时回收。
    expect(statuses).toEqual(["busy", "idle"])
    expect(optimisticUsers()).toHaveLength(0)
  })

  test("times out an inactive fallback whose start-turn transport never acknowledges", async () => {
    const client = clientFor("/repo/main")
    client.session.steer = async () => {
      throw Object.assign(new Error("active turn ended"), { name: "SteerTurnInactiveError" })
    }
    client.session.promptAsync = async () => new Promise<never>(() => undefined)

    await expect(
      sendFollowupDraft({
        client: client as unknown as Parameters<typeof sendFollowupDraft>[0]["client"],
        sync: followupSync(),
        globalSync: followupGlobalSync(),
        preflight: permissionPreflight,
        steer: true,
        targetTurnID: "turn-ended",
        messageID: "msg-fallback-timeout",
        steerAckTimeoutMs: 5,
        draft: {
          sessionID: "session-1",
          sessionDirectory: "/repo/main",
          prompt: [{ type: "text", content: "fallback 不能永久挂起", start: 0, end: 15 }],
          context: [],
          agent: "agent",
          model: { providerID: "provider", modelID: "model" },
        },
      }),
    ).rejects.toMatchObject({ name: "TimeoutError" })

    // 超时会撤销 optimistic user；页面层随后释放会话提交锁并恢复可重试草稿。
    expect(optimisticUsers()).toHaveLength(0)
  })

  test("surfaces a second steer mismatch after the single official retry", async () => {
    const client = clientFor("/repo/main")
    const targets: string[] = []
    const fallbacks: string[] = []
    const failures = [
      {
        name: "SteerTurnInactiveError",
        data: { expectedTurnID: "turn-old", actualTurnID: "turn-active" },
      },
      {
        name: "SteerTurnInactiveError",
        data: { expectedTurnID: "turn-active", actualTurnID: "turn-newer" },
      },
    ]
    client.session.steer = async (payload: Record<string, unknown>) => {
      targets.push(String(payload.targetTurnID))
      throw failures[targets.length - 1]
    }

    await expect(
      sendFollowupDraft({
        client: client as unknown as Parameters<typeof sendFollowupDraft>[0]["client"],
        sync: followupSync(),
        globalSync: followupGlobalSync(),
        preflight: permissionPreflight,
        steer: true,
        targetTurnID: "turn-old",
        messageID: "msg-steer-one-retry",
        onSteerFallback: () => fallbacks.push("fallback"),
        draft: {
          sessionID: "session-1",
          sessionDirectory: "/repo/main",
          prompt: [{ type: "text", content: "只重试一次", start: 0, end: 5 }],
          context: [],
          agent: "agent",
          model: { providerID: "provider", modelID: "model" },
        },
      }),
    ).rejects.toBe(failures[1])

    // 官方 l9 只解析第一次 mismatch；第二次 mismatch 既不能诱发第三次 steer，也不能被外层误判为 inactive fallback。
    expect(targets).toEqual(["turn-old", "turn-active"])
    expect(fallbacks).toHaveLength(0)
    expect(sentPrompts).toHaveLength(0)
    expect(optimisticUsers()).toHaveLength(0)
  })

  test("does not turn an unrelated 409 into a normal follow-up turn", async () => {
    const client = clientFor("/repo/main")
    const conflict = { status: 409, data: { message: "workspace version conflict" } }
    client.session.steer = async () => {
      throw conflict
    }

    await expect(
      sendFollowupDraft({
        client: client as unknown as Parameters<typeof sendFollowupDraft>[0]["client"],
        sync: followupSync(),
        globalSync: followupGlobalSync(),
        preflight: permissionPreflight,
        steer: true,
        targetTurnID: "turn-active",
        messageID: "msg-steer-unrelated-conflict",
        draft: {
          sessionID: "session-1",
          sessionDirectory: "/repo/main",
          prompt: [{ type: "text", content: "不要误开新回合", start: 0, end: 7 }],
          context: [],
          agent: "agent",
          model: { providerID: "provider", modelID: "model" },
        },
      }),
    ).rejects.toBe(conflict)

    // 官方外层只为明确 inactive 错误执行 start fallback；权限、版本等普通 409 必须原样暴露。
    expect(sentPrompts).toHaveLength(0)
    expect(optimisticUsers()).toHaveLength(0)
  })

  test("does not fall back when the steer durable ACK times out", async () => {
    const client = clientFor("/repo/main")
    client.session.steer = async () => new Promise<never>(() => {})

    await expect(
      sendFollowupDraft({
        client: client as unknown as Parameters<typeof sendFollowupDraft>[0]["client"],
        sync: followupSync(),
        globalSync: followupGlobalSync(),
        preflight: permissionPreflight,
        steer: true,
        targetTurnID: "turn-active",
        messageID: "msg-steer-timeout",
        steerAckTimeoutMs: 1,
        draft: {
          sessionID: "session-1",
          sessionDirectory: "/repo/main",
          prompt: [{ type: "text", content: "等待引导确认", start: 0, end: 6 }],
          context: [],
          agent: "agent",
          model: { providerID: "provider", modelID: "model" },
        },
      }),
    ).rejects.toMatchObject({ name: "TimeoutError" })

    // 超时无法证明活动回合已经结束，必须交给队列恢复原草稿，不能私自调用普通 prompt。
    expect(sentPrompts).toHaveLength(0)
    expect(optimisticUsers()).toHaveLength(0)
  })

  test("does not fall back when the single mismatch retry fails with a network error", async () => {
    const client = clientFor("/repo/main")
    const targets: string[] = []
    client.session.steer = async (payload: Record<string, unknown>) => {
      targets.push(String(payload.targetTurnID))
      if (targets.length === 1) {
        throw {
          name: "SteerTurnInactiveError",
          data: { expectedTurnID: "turn-old", actualTurnID: "turn-active" },
        }
      }
      throw new TypeError("Failed to fetch")
    }

    await expect(
      sendFollowupDraft({
        client: client as unknown as Parameters<typeof sendFollowupDraft>[0]["client"],
        sync: followupSync(),
        globalSync: followupGlobalSync(),
        preflight: permissionPreflight,
        steer: true,
        targetTurnID: "turn-old",
        messageID: "msg-steer-retry-network-error",
        draft: {
          sessionID: "session-1",
          sessionDirectory: "/repo/main",
          prompt: [{ type: "text", content: "重试失败不能降级", start: 0, end: 8 }],
          context: [],
          agent: "agent",
          model: { providerID: "provider", modelID: "model" },
        },
      }),
    ).rejects.toThrow("Failed to fetch")

    // mismatch 只允许改绑一次；重试的网络失败不代表 active turn 已结束。
    expect(targets).toEqual(["turn-old", "turn-active"])
    expect(sentPrompts).toHaveLength(0)
    expect(optimisticUsers()).toHaveLength(0)
  })

  test("shows a targetless steer optimistically before the active turn ID becomes available", async () => {
    const target = Promise.withResolvers<string>()
    const retargeted: string[] = []

    const sending = sendFollowupDraft({
      client: clientFor("/repo/main") as unknown as Parameters<typeof sendFollowupDraft>[0]["client"],
      sync: followupSync(),
      globalSync: followupGlobalSync(),
      preflight: permissionPreflight,
      steer: true,
      messageID: "msg-steer-wait-target",
      optimisticTargetTurnID: "turn-visible",
      waitForSteerTarget: () => target.promise,
      onSteerRetarget: (turnID) => retargeted.push(turnID),
      draft: {
        sessionID: "session-1",
        sessionDirectory: "/repo/main",
        prompt: [{ type: "text", content: "等目标后继续", start: 0, end: 6 }],
        context: [],
        agent: "agent",
        model: { providerID: "provider", modelID: "model" },
      },
    })
    // 共享发送边界会先异步落盘权限模式，完成后才允许建立 optimistic steering item。
    await flush()

    // 对齐官方 l9：等待权威 turnID 时消息已经属于当前可见回合，但网络层尚未发送 steer。
    expect(optimisticUsers().map((item) => item.message)).toEqual([
      expect.objectContaining({
        id: "msg-steer-wait-target",
        steerTargetTurnID: "turn-visible",
      }),
    ])
    expect(sentSteers).toHaveLength(0)
    expect(sentPrompts).toHaveLength(0)

    target.resolve("turn-active")
    await sending

    // 权威目标到达后必须原位改绑同一 optimistic user，再只调用一次 steer。
    expect(retargeted).toEqual(["turn-active"])
    expect(optimisticUsers()).toHaveLength(1)
    expect(optimisticUsers()[0]?.message).toMatchObject({
      id: "msg-steer-wait-target",
      steerTargetTurnID: "turn-active",
    })
    expect(sentSteers.map((item) => item.payload)).toEqual([
      expect.objectContaining({ messageID: "msg-steer-wait-target", targetTurnID: "turn-active" }),
    ])
    expect(sentPrompts).toHaveLength(0)
  })

  test("falls back with the same message ID when the turn ends while waiting for its ID", async () => {
    const target = Promise.withResolvers<string>()
    const fallbacks: string[] = []

    const sending = sendFollowupDraft({
      client: clientFor("/repo/main") as unknown as Parameters<typeof sendFollowupDraft>[0]["client"],
      sync: followupSync(),
      globalSync: followupGlobalSync(),
      preflight: permissionPreflight,
      steer: true,
      messageID: "msg-steer-wait-inactive",
      optimisticTargetTurnID: "turn-visible",
      waitForSteerTarget: () => target.promise,
      onSteerFallback: () => fallbacks.push("fallback"),
      draft: {
        sessionID: "session-1",
        sessionDirectory: "/repo/main",
        prompt: [{ type: "text", content: "结束后作为新回合", start: 0, end: 8 }],
        context: [],
        agent: "agent",
        model: { providerID: "provider", modelID: "model" },
      },
    })
    // 权限预检完成后，引导气泡才进入当前物理回合并等待权威 turnID。
    await flush()

    // 等待阶段先保留 steering 气泡；inactive 之前不能抢先创建普通回合。
    expect(optimisticUsers()[0]?.message).toMatchObject({
      id: "msg-steer-wait-inactive",
      steerTargetTurnID: "turn-visible",
    })
    expect(sentPrompts).toHaveLength(0)

    target.reject(Object.assign(new Error("active turn ended"), { name: "SteerTurnInactiveError" }))
    await sending

    // 官方 ro 会移除 steer 归属并复用原 clientUserMessageId；这里不得生成第二个用户消息 ID。
    expect(fallbacks).toEqual(["fallback"])
    expect(sentSteers).toHaveLength(0)
    expect(sentPrompts.map((item) => item.payload)).toEqual([
      expect.objectContaining({ messageID: "msg-steer-wait-inactive" }),
    ])
    expect(optimisticUsers()).toHaveLength(1)
    expect(optimisticUsers()[0]?.message).toMatchObject({ id: "msg-steer-wait-inactive" })
    expect(optimisticUsers()[0]?.message.steerTargetTurnID).toBeUndefined()
  })

  test("does not fall back for target wait timeouts or ordinary failures", async () => {
    const failures = [
      Object.assign(new Error("target wait timed out"), { name: "TimeoutError" }),
      new Error("target status subscription failed"),
    ]

    for (const [index, failure] of failures.entries()) {
      // 每种错误都从独立的 pending optimistic 状态开始，避免前一次断言掩盖残留消息。
      optimistic.length = 0
      sentSteers.length = 0
      sentPrompts.length = 0
      const target = Promise.withResolvers<string>()
      const fallbacks: string[] = []
      const sending = sendFollowupDraft({
        client: clientFor("/repo/main") as unknown as Parameters<typeof sendFollowupDraft>[0]["client"],
        sync: followupSync(),
        globalSync: followupGlobalSync(),
        preflight: permissionPreflight,
        steer: true,
        messageID: `msg-steer-wait-failure-${index}`,
        optimisticTargetTurnID: "turn-visible",
        waitForSteerTarget: () => target.promise,
        onSteerFallback: () => fallbacks.push("fallback"),
        draft: {
          sessionID: "session-1",
          sessionDirectory: "/repo/main",
          prompt: [{ type: "text", content: "等待失败不能降级", start: 0, end: 8 }],
          context: [],
          agent: "agent",
          model: { providerID: "provider", modelID: "model" },
        },
      })

      // 每轮先跨过权限预检微任务，再验证等待目标期间的 provisional 气泡。
      await flush()
      expect(optimisticUsers()).toHaveLength(1)
      target.reject(failure)
      await expect(sending).rejects.toBe(failure)

      // 超时或普通订阅错误无法证明原 turn 已结束，只能撤掉 optimistic 并把错误交回队列层。
      expect(fallbacks).toHaveLength(0)
      expect(sentSteers).toHaveLength(0)
      expect(sentPrompts).toHaveLength(0)
      expect(optimisticUsers()).toHaveLength(0)
    }
  })

  test("keeps separate low-level target waits in submission order before either target resolves", async () => {
    const firstTarget = Promise.withResolvers<string>()
    const secondTarget = Promise.withResolvers<string>()
    const draft = (content: string) => ({
      sessionID: "session-1",
      sessionDirectory: "/repo/main",
      prompt: [{ type: "text" as const, content, start: 0, end: content.length }],
      context: [],
      agent: "agent",
      model: { providerID: "provider", modelID: "model" },
    })

    const first = sendFollowupDraft({
      client: clientFor("/repo/main") as unknown as Parameters<typeof sendFollowupDraft>[0]["client"],
      sync: followupSync(),
      globalSync: followupGlobalSync(),
      preflight: permissionPreflight,
      steer: true,
      messageID: "msg-steer-wait-first",
      optimisticTargetTurnID: "turn-visible",
      waitForSteerTarget: () => firstTarget.promise,
      draft: draft("第一条引导"),
    })
    const second = sendFollowupDraft({
      client: clientFor("/repo/main") as unknown as Parameters<typeof sendFollowupDraft>[0]["client"],
      sync: followupSync(),
      globalSync: followupGlobalSync(),
      preflight: permissionPreflight,
      steer: true,
      messageID: "msg-steer-wait-second",
      optimisticTargetTurnID: "turn-visible",
      waitForSteerTarget: () => secondTarget.promise,
      draft: draft("第二条引导"),
    })
    // 两条底层请求都应在各自预检完成后进入等待队列，且仍保持独立的稳定消息 ID。
    await flush()

    // 官方 composer / SendNow 在调用层单飞到 ACK；l9/rfe 底层仍保持可重入，供不同窗口或入口独立等待同一 turn。
    // 这里仅验证发送 helper 的底层语义，不能据此移除页面的会话级提交锁。
    expect(optimisticUsers().map((item) => item.message.id)).toEqual([
      "msg-steer-wait-first",
      "msg-steer-wait-second",
    ])
    expect(sentSteers).toHaveLength(0)

    firstTarget.resolve("turn-active")
    secondTarget.resolve("turn-active")
    await Promise.all([first, second])

    expect(sentSteers.map((item) => item.payload.messageID)).toEqual([
      "msg-steer-wait-first",
      "msg-steer-wait-second",
    ])
    expect(optimisticUsers().map((item) => item.message.id)).toEqual([
      "msg-steer-wait-first",
      "msg-steer-wait-second",
    ])
    expect(optimisticUsers().map((item) => item.message.steerTargetTurnID)).toEqual([
      "turn-active",
      "turn-active",
    ])
    expect(sentPrompts).toHaveLength(0)
  })

  test("rejects a steer without a snapshotted target before creating optimistic state", async () => {
    await expect(
      sendFollowupDraft({
        client: clientFor("/repo/main") as unknown as Parameters<typeof sendFollowupDraft>[0]["client"],
        sync: followupSync(),
        globalSync: followupGlobalSync(),
        preflight: permissionPreflight,
        steer: true,
        messageID: "msg-steer-missing-target",
        draft: {
          sessionID: "session-1",
          sessionDirectory: "/repo/main",
          prompt: [{ type: "text", content: "继续当前任务", start: 0, end: 6 }],
          context: [],
          agent: "agent",
          model: { providerID: "provider", modelID: "model" },
        },
      }),
    ).rejects.toMatchObject({ name: "MissingSteerTargetError" })

    // 缺目标由队列层降级处理；发送层不能先写 optimistic user，更不能退回普通 promptAsync。
    expect(sentSteers).toHaveLength(0)
    expect(sentPrompts).toHaveLength(0)
    expect(optimisticUsers()).toHaveLength(0)
  })

  test("does not write idle when a manual steer request fails", async () => {
    const client = clientFor("/repo/main")
    client.session.steer = async () => {
      throw new Error("steer failed")
    }
    const statuses: string[] = []

    await expect(
      sendFollowupDraft({
        client: client as unknown as Parameters<typeof sendFollowupDraft>[0]["client"],
        sync: followupSync(),
        globalSync: {
          child: () => [
            {},
            (...args: unknown[]) => {
              const value = args[2]
              if (args[0] !== "session_status" || typeof value !== "object" || value === null || !("type" in value))
                return
              statuses.push(String(value.type))
            },
          ],
        } as unknown as Parameters<typeof sendFollowupDraft>[0]["globalSync"],
        preflight: permissionPreflight,
        steer: true,
        targetTurnID: "turn-active",
        optimisticBusy: true,
        messageID: "msg-steer-failed",
        draft: {
          sessionID: "session-1",
          sessionDirectory: "/repo/main",
          prompt: [{ type: "text", content: "继续当前任务", start: 0, end: 6 }],
          context: [],
          agent: "agent",
          model: { providerID: "provider", modelID: "model" },
        },
      }),
    ).rejects.toThrow("steer failed")

    // steer 复用原有 active turn；前端既不能覆盖带 turnID 的权威 busy，也不能把仍运行的会话伪造为 idle。
    expect(statuses).toEqual([])
    // 未收到 ACK 的引导不能残留在时间线；队列层会用同一稳定 ID 恢复原草稿。
    expect(optimisticUsers()).toHaveLength(0)
  })

  test("passes noReply through for manual steers stored during a busy turn", async () => {
    await sendFollowupDraft({
      client: clientFor("/repo/main") as unknown as Parameters<typeof sendFollowupDraft>[0]["client"],
      sync: followupSync(),
      globalSync: followupGlobalSync(),
      preflight: permissionPreflight,
      noReply: true,
      draft: {
        sessionID: "session-1",
        sessionDirectory: "/repo/main",
        prompt: [{ type: "text", content: "测试引导", start: 0, end: 4 }],
        context: [],
        agent: "agent",
        model: { providerID: "provider", modelID: "model" },
      },
    })
    await flush()

    expect(sentPrompts).toHaveLength(1)
    expect(sentPrompts[0]?.payload.noReply).toBe(true)
  })

  test("identifies registered slash commands so queued items cannot steer", () => {
    const command = resolveFollowupSlashCommand(
      { prompt: [{ type: "text", content: "/compact 保留关键上下文", start: 0, end: 14 }] },
      [{ name: "compact" }],
    )

    // Dock 用该纯函数的反值生成 canSteer；只有已注册命令需要等待会话空闲。
    expect(command).toEqual({ command: "compact", arguments: "保留关键上下文" })
    expect(
      resolveFollowupSlashCommand({ prompt: [{ type: "text", content: "/unknown", start: 0, end: 8 }] }, [
        { name: "compact" },
      ]),
    ).toBeUndefined()
  })

  test("passes hidden manual steer context to the resumed follow-up", async () => {
    await sendFollowupDraft({
      client: clientFor("/repo/main") as unknown as Parameters<typeof sendFollowupDraft>[0]["client"],
      sync: followupSync(),
      globalSync: followupGlobalSync(),
      preflight: permissionPreflight,
      syntheticContext: ["前序引导：测试A、测试B"],
      draft: {
        sessionID: "session-1",
        sessionDirectory: "/repo/main",
        prompt: [{ type: "text", content: "测试C", start: 0, end: 3 }],
        context: [],
        agent: "agent",
        model: { providerID: "provider", modelID: "model" },
      },
    })
    await flush()

    // 恢复上下文只作为隐藏 synthetic part 进入请求，不能改写用户可见正文。
    const parts = sentPrompts[0]?.payload.parts as Array<Record<string, unknown>>
    expect(parts.some((part) => part.synthetic === true && part.text === "前序引导：测试A、测试B")).toBe(true)
  })
})

describe("shouldDivertToGoal", () => {
  test("diverts when goal mode active and text non-empty", () => {
    expect(shouldDivertToGoal({ active: true, text: "build X" })).toBe(true)
  })
  test("does not divert when goal mode inactive", () => {
    expect(shouldDivertToGoal({ active: false, text: "build X" })).toBe(false)
  })
  test("does not divert on empty objective text", () => {
    expect(shouldDivertToGoal({ active: true, text: "   " })).toBe(false)
  })
  test("does not divert in shell mode", () => {
    expect(shouldDivertToGoal({ active: true, text: "ls -la", mode: "shell" })).toBe(false)
  })
  test("does not divert slash commands", () => {
    expect(shouldDivertToGoal({ active: true, text: "/compact", mode: "normal" })).toBe(false)
  })
  test("diverts in normal mode", () => {
    expect(shouldDivertToGoal({ active: true, text: "build X", mode: "normal" })).toBe(true)
  })
})
