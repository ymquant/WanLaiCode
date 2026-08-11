import { describe, expect, test } from "bun:test"
import type {
  Goal,
  Message,
  Part,
  PermissionRequest,
  Project,
  QuestionRequest,
  Session,
} from "@opencode-ai/sdk/v2/client"
import { createStore } from "solid-js/store"
import type { State } from "./types"
import { applyDirectoryEvent, applyGlobalEvent, cleanupDroppedSessionCaches } from "./event-reducer"
import { createPermissionReviewLifecycle } from "./permission-review-lifecycle"
import { settleRemovalLocally } from "./session-cache"

const rootSession = (input: { id: string; parentID?: string; archived?: number }) =>
  ({
    id: input.id,
    parentID: input.parentID,
    time: {
      created: 1,
      updated: 1,
      archived: input.archived,
    },
  }) as Session

const userMessage = (id: string, sessionID: string, created = 1) =>
  ({
    id,
    sessionID,
    role: "user",
    time: { created },
    agent: "assistant",
    model: { providerID: "openai", modelID: "gpt" },
  }) as Message

const textPart = (id: string, sessionID: string, messageID: string) =>
  ({
    id,
    sessionID,
    messageID,
    type: "text",
    text: id,
  }) as Part

const stepFinishPart = (id: string, sessionID: string, messageID: string) =>
  ({
    id,
    sessionID,
    messageID,
    type: "step-finish",
    reason: "stop",
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
  }) as Part

const permissionRequest = (id: string, sessionID: string, title = id) =>
  ({
    id,
    sessionID,
    permission: title,
    patterns: ["*"],
    metadata: {},
    always: [],
  }) as PermissionRequest

const questionRequest = (id: string, sessionID: string, title = id) =>
  ({
    id,
    sessionID,
    questions: [
      {
        question: title,
        header: title,
        options: [{ label: title, description: title }],
      },
    ],
  }) as QuestionRequest

const permissionReviewStarted = (id: string, sessionID: string) => ({
  reviewID: id,
  permissionID: `per_${id}`,
  sessionID,
  summary: `Review ${id}`,
  startedAt: 100,
})

const permissionReviewCompleted = (
  id: string,
  sessionID: string,
  status: "approved" | "denied" | "escalated" | "failed",
) => ({
  reviewID: id,
  permissionID: `per_${id}`,
  sessionID,
  summary: `Review ${id}`,
  ...(status === "failed" ? {} : { decision: status === "approved" ? "allow" : "deny", risk: "high" }),
  reason: `${status} reason`,
  completedAt: 200,
})

const baseState = (input: Partial<State> = {}) =>
  ({
    status: "complete",
    agent: [],
    command: [],
    project: "",
    projectMeta: undefined,
    icon: undefined,
    provider: {} as State["provider"],
    config: {} as State["config"],
    path: { directory: "/tmp" } as State["path"],
    session: [],
    sessionTotal: 0,
    session_status: {},
    // 测试默认从完整快照开始；需要覆盖首次事件的用例会显式改为 false。
    session_status_ready: true,
    session_status_known: {},
    session_diff: {},
    session_suggestion: {},
    todo: {},
    permission: {},
    question: {},
    mcp: {},
    lsp: [],
    vcs: undefined,
    limit: 10,
    message: {},
    part: {},
    ...input,
  }) as State

describe("applyGlobalEvent", () => {
  test("upserts project.updated in sorted position", () => {
    const project = [{ id: "a" }, { id: "c" }] as Project[]
    let refreshCount = 0
    applyGlobalEvent({
      event: { type: "project.updated", properties: { id: "b" } },
      project,
      refresh: () => {
        refreshCount += 1
      },
      setGlobalProject(next) {
        if (typeof next === "function") next(project)
      },
      setConfigMode() {},
    })

    expect(project.map((x) => x.id)).toEqual(["a", "b", "c"])
    expect(refreshCount).toBe(0)
  })

  test("handles global.disposed by triggering refresh", () => {
    let refreshCount = 0
    applyGlobalEvent({
      event: { type: "global.disposed" },
      project: [],
      refresh: () => {
        refreshCount += 1
      },
      setGlobalProject() {},
      setConfigMode() {},
    })

    expect(refreshCount).toBe(1)
  })

  test("handles server.connected by triggering refresh", () => {
    let refreshCount = 0
    applyGlobalEvent({
      event: { type: "server.connected" },
      project: [],
      refresh: () => {
        refreshCount += 1
      },
      setGlobalProject() {},
      setConfigMode() {},
    })

    expect(refreshCount).toBe(1)
  })

  test("handles global.config.updated by refreshing config", () => {
    let configRefreshCount = 0
    applyGlobalEvent({
      event: { type: "global.config.updated" },
      project: [],
      refresh() {},
      refreshConfig: () => {
        configRefreshCount += 1
      },
      setGlobalProject() {},
      setConfigMode() {},
    })

    expect(configRefreshCount).toBe(1)
  })

  test("handles permission.mode.updated without triggering refresh", () => {
    let refreshCount = 0
    let mode = "ask"
    applyGlobalEvent({
      event: { type: "permission.mode.updated", properties: { mode: "full_access" } },
      project: [],
      refresh: () => {
        refreshCount += 1
      },
      setGlobalProject() {},
      setConfigMode(next) {
        mode = next
      },
    })

    expect(mode).toBe("full_access")
    expect(refreshCount).toBe(0)
  })
})

describe("applyDirectoryEvent", () => {
  test("expires a terminal review after permission.asked without relying on the composer", async () => {
    const sessionID = "ses_background_review"
    const [store, setStore] = createStore(baseState())
    const permissionReviewLifecycle = createPermissionReviewLifecycle()

    applyDirectoryEvent({
      event: { type: "permission.review.started", properties: permissionReviewStarted("review_approved", sessionID) },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
      permissionReviewLifecycle,
    })
    applyDirectoryEvent({
      event: {
        type: "permission.review.approved",
        properties: permissionReviewCompleted("review_approved", sessionID, "approved"),
      },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
      permissionReviewLifecycle,
    })
    applyDirectoryEvent({
      event: { type: "permission.asked", properties: permissionRequest("per_approved", sessionID) },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
      permissionReviewLifecycle,
    })

    await Bun.sleep(1_250)
    expect(store.permission_review[sessionID]).toEqual([])
  }, 2_000)

  test("cancels a review expiry when the session cache is dropped", async () => {
    const sessionID = "ses_dropped_review"
    const [store, setStore] = createStore(baseState())
    const permissionReviewLifecycle = createPermissionReviewLifecycle()

    applyDirectoryEvent({
      event: { type: "permission.review.approved", properties: permissionReviewCompleted("review_dropped", sessionID, "approved") },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
      permissionReviewLifecycle,
    })
    applyDirectoryEvent({
      event: { type: "session.deleted", properties: { info: rootSession({ id: sessionID }) } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
      permissionReviewLifecycle,
    })

    await Bun.sleep(1_250)
    expect(store.permission_review[sessionID]).toBeUndefined()
  }, 2_000)

  test("keeps review lifecycle records sorted, upserts terminals, and drops them with the session cache", () => {
    const sessionID = "ses_review"
    const [store, setStore] = createStore(baseState())

    for (const id of ["review_d", "review_b", "review_a", "review_c"]) {
      applyDirectoryEvent({
        event: { type: "permission.review.started", properties: permissionReviewStarted(id, sessionID) },
        store,
        setStore,
        push() {},
        directory: "/tmp",
        loadLsp() {},
      })
    }

    for (const [id, status] of [
      ["review_a", "approved"],
      ["review_b", "denied"],
      ["review_c", "escalated"],
      ["review_d", "failed"],
    ] as const) {
      applyDirectoryEvent({
        event: { type: `permission.review.${status}`, properties: permissionReviewCompleted(id, sessionID, status) },
        store,
        setStore,
        push() {},
        directory: "/tmp",
        loadLsp() {},
      })
    }

    expect(store.permission_review[sessionID]?.map((review) => review.id)).toEqual([
      "review_a",
      "review_b",
      "review_c",
      "review_d",
    ])
    expect(store.permission_review[sessionID]?.map((review) => review.status)).toEqual([
      "approved",
      "denied",
      "escalated",
      "failed",
    ])
    expect(store.permission_review[sessionID]?.[1]).toMatchObject({
      risk: "high",
      reason: "denied reason",
      completedAt: 200,
    })

    applyDirectoryEvent({
      event: { type: "session.deleted", properties: { info: rootSession({ id: sessionID }) } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })

    expect(store.permission_review[sessionID]).toBeUndefined()
  })

  test("re-bootstraps the instance on addon.changed", () => {
    const [store, setStore] = createStore(baseState({}))
    const pushed: string[] = []

    applyDirectoryEvent({
      event: { type: "addon.changed", properties: {} },
      store,
      setStore,
      push: (directory) => pushed.push(directory),
      directory: "/tmp/project",
      loadLsp() {},
    })

    expect(pushed).toEqual(["/tmp/project"])
  })

  test("inserts root sessions in sorted order and updates sessionTotal", () => {
    const [store, setStore] = createStore(
      baseState({
        session: [rootSession({ id: "b" })],
        sessionTotal: 1,
      }),
    )

    applyDirectoryEvent({
      event: { type: "session.created", properties: { info: rootSession({ id: "a" }) } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })

    expect(store.session.map((x) => x.id)).toEqual(["a", "b"])
    expect(store.sessionTotal).toBe(2)

    applyDirectoryEvent({
      event: { type: "session.created", properties: { info: rootSession({ id: "c", parentID: "a" }) } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })

    expect(store.sessionTotal).toBe(2)
  })

  test("cleans session caches when archived", () => {
    const message = userMessage("msg_1", "ses_1")
    const [store, setStore] = createStore(
      baseState({
        session: [rootSession({ id: "ses_1" }), rootSession({ id: "ses_2" })],
        sessionTotal: 2,
        message: { ses_1: [message] },
        part: { [message.id]: [textPart("prt_1", "ses_1", message.id)] },
        session_diff: { ses_1: [] },
        session_suggestion: { ses_1: "suggestion text" },
        todo: { ses_1: [] },
        permission: { ses_1: [] },
        question: { ses_1: [] },
        session_status: { ses_1: { type: "busy" } },
      }),
    )

    applyDirectoryEvent({
      event: { type: "session.updated", properties: { info: rootSession({ id: "ses_1", archived: 10 }) } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })

    expect(store.session.map((x) => x.id)).toEqual(["ses_2"])
    expect(store.sessionTotal).toBe(1)
    expect(store.message.ses_1).toBeUndefined()
    expect(store.part[message.id]).toBeUndefined()
    expect(store.session_diff.ses_1).toBeUndefined()
    expect(store.session_suggestion.ses_1).toBeUndefined()
    expect(store.todo.ses_1).toBeUndefined()
    expect(store.permission.ses_1).toBeUndefined()
    expect(store.question.ses_1).toBeUndefined()
    expect(store.session_status.ses_1).toBeUndefined()
  })

  test("cleans session caches when deleted and decrements only root totals", () => {
    const cases = [
      { info: rootSession({ id: "ses_1" }), expectedTotal: 1 },
      { info: rootSession({ id: "ses_2", parentID: "ses_1" }), expectedTotal: 2 },
    ]

    for (const item of cases) {
      const message = userMessage("msg_1", item.info.id)
      const [store, setStore] = createStore(
        baseState({
          session: [
            rootSession({ id: "ses_1" }),
            rootSession({ id: "ses_2", parentID: "ses_1" }),
            rootSession({ id: "ses_3" }),
          ],
          sessionTotal: 2,
          message: { [item.info.id]: [message] },
          part: { [message.id]: [textPart("prt_1", item.info.id, message.id)] },
          session_diff: { [item.info.id]: [] },
          session_suggestion: { [item.info.id]: "suggestion text" },
          todo: { [item.info.id]: [] },
          permission: { [item.info.id]: [] },
          question: { [item.info.id]: [] },
          session_status: { [item.info.id]: { type: "busy" } },
        }),
      )

      applyDirectoryEvent({
        event: { type: "session.deleted", properties: { info: item.info } },
        store,
        setStore,
        push() {},
        directory: "/tmp",
        loadLsp() {},
      })

      expect(store.session.find((x) => x.id === item.info.id)).toBeUndefined()
      expect(store.sessionTotal).toBe(item.expectedTotal)
      expect(store.message[item.info.id]).toBeUndefined()
      expect(store.part[message.id]).toBeUndefined()
      expect(store.session_diff[item.info.id]).toBeUndefined()
      expect(store.session_suggestion[item.info.id]).toBeUndefined()
      expect(store.todo[item.info.id]).toBeUndefined()
      expect(store.permission[item.info.id]).toBeUndefined()
      expect(store.question[item.info.id]).toBeUndefined()
      expect(store.session_status[item.info.id]).toBeUndefined()
    }
  })

  test("cleans caches for trimmed sessions on session.created", () => {
    const dropped = rootSession({ id: "ses_b" })
    const kept = rootSession({ id: "ses_a" })
    const message = userMessage("msg_1", dropped.id)
    const todos: string[] = []
    const [store, setStore] = createStore(
      baseState({
        limit: 1,
        session: [dropped],
        message: { [dropped.id]: [message] },
        part: { [message.id]: [textPart("prt_1", dropped.id, message.id)] },
        session_diff: { [dropped.id]: [] },
        session_suggestion: { [dropped.id]: "suggestion text" },
        todo: { [dropped.id]: [] },
        permission: { [dropped.id]: [] },
        question: { [dropped.id]: [] },
        session_status: { [dropped.id]: { type: "busy" } },
      }),
    )

    applyDirectoryEvent({
      event: { type: "session.created", properties: { info: kept } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
      setSessionTodo(sessionID, value) {
        if (value !== undefined) return
        todos.push(sessionID)
      },
    })

    expect(store.session.map((x) => x.id)).toEqual([kept.id])
    expect(store.message[dropped.id]).toBeUndefined()
    expect(store.part[message.id]).toBeUndefined()
    expect(store.session_diff[dropped.id]).toBeUndefined()
    expect(store.session_suggestion[dropped.id]).toBeUndefined()
    expect(store.todo[dropped.id]).toBeUndefined()
    expect(store.permission[dropped.id]).toBeUndefined()
    expect(store.question[dropped.id]).toBeUndefined()
    expect(store.session_status[dropped.id]).toBeUndefined()
    expect(todos).toEqual([dropped.id])
  })

  test("cleanupDroppedSessionCaches clears part-only orphan state", () => {
    const [store, setStore] = createStore(
      baseState({
        session: [rootSession({ id: "ses_keep" })],
        part: { msg_1: [textPart("prt_1", "ses_drop", "msg_1")] },
      }),
    )

    cleanupDroppedSessionCaches(store, setStore, store.session)

    expect(store.part.msg_1).toBeUndefined()
  })

  test("removes session status when idle event arrives", () => {
    const [store, setStore] = createStore(
      baseState({
        session_status: { ses_1: { type: "busy" } },
        session_status_ready: false,
      }),
    )

    applyDirectoryEvent({
      event: { type: "session.status", properties: { sessionID: "ses_1", status: { type: "idle" } } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })

    expect(store.session_status.ses_1).toBeUndefined()
    // 单个 idle 事件只确认自己的会话，不能把其它尚未同步的会话一起标成已知。
    expect(store.session_status_known.ses_1).toBe(true)
    expect(store.session_status_ready).toBe(false)
  })

  test("appends, updates, and removes messages while clearing orphaned parts", () => {
    const sessionID = "ses_1"
    const [store, setStore] = createStore(
      baseState({
        message: { [sessionID]: [userMessage("msg_1", sessionID), userMessage("msg_3", sessionID)] },
        part: { msg_2: [textPart("prt_1", sessionID, "msg_2")] },
      }),
    )

    applyDirectoryEvent({
      event: { type: "message.updated", properties: { info: userMessage("msg_2", sessionID) } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })

    // 新事件按抵达顺序追加，旧 ID 不能插到已经显示的活动中间。
    expect(store.message[sessionID]?.map((x) => x.id)).toEqual(["msg_1", "msg_3", "msg_2"])

    applyDirectoryEvent({
      event: {
        type: "message.updated",
        properties: {
          info: {
            ...userMessage("msg_2", sessionID),
            role: "assistant",
          } as Message,
        },
      },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })

    expect(store.message[sessionID]?.find((x) => x.id === "msg_2")?.role).toBe("assistant")

    applyDirectoryEvent({
      event: { type: "message.removed", properties: { sessionID, messageID: "msg_2" } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })

    expect(store.message[sessionID]?.map((x) => x.id)).toEqual(["msg_1", "msg_3"])
    expect(store.part.msg_2).toBeUndefined()
  })

  test("orders realtime remote messages by created time and keeps ID-only identity", () => {
    const sessionID = "ses_1"
    const remote = userMessage("msg_remote_zzzz", sessionID, 100)
    const optimistic = userMessage("msg_same", sessionID, 300)
    const inserted = userMessage("msg_0001", sessionID, 200)
    const [store, setStore] = createStore(
      baseState({
        // 数组已经按时间升序，但 ID 字典序故意相反，用于覆盖旧远控历史的真实形态。
        message: { [sessionID]: [remote, optimistic] },
        part: { [remote.id]: [textPart("prt_remote", sessionID, remote.id)] },
      }),
    )

    applyDirectoryEvent({
      event: { type: "message.updated", properties: { info: inserted } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })

    expect(store.message[sessionID]?.map((message) => message.id)).toEqual([remote.id, inserted.id, optimistic.id])

    // 服务端用同一 ID 修正乐观创建时间时，消息必须移动且不能产生重复项。
    applyDirectoryEvent({
      event: { type: "message.updated", properties: { info: userMessage(optimistic.id, sessionID, 150) } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })

    expect(store.message[sessionID]?.map((message) => message.id)).toEqual([remote.id, optimistic.id, inserted.id])
    expect(store.message[sessionID]?.filter((message) => message.id === optimistic.id)).toHaveLength(1)

    // 删除同样只按 ID 识别，不依赖数组具备 ID 排序。
    applyDirectoryEvent({
      event: { type: "message.removed", properties: { sessionID, messageID: remote.id } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })

    expect(store.message[sessionID]?.map((message) => message.id)).toEqual([optimistic.id, inserted.id])
    expect(store.part[remote.id]).toBeUndefined()
  })

  test("keeps optimistic steer identity when an old message.updated echo omits turn fields", () => {
    const sessionID = "ses_1"
    const optimistic = {
      ...userMessage("msg_steer", sessionID, 100),
      steerTargetTurnID: "turn_active",
    } as Message
    const [store, setStore] = createStore(baseState({ message: { [sessionID]: [optimistic] } }))

    applyDirectoryEvent({
      event: {
        type: "message.updated",
        properties: { info: userMessage(optimistic.id, sessionID, 120) },
      },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })

    // 旧进程回显不带新 schema 字段；同 ID 更新仍要保留 steer 归属，并继续停留在原消息位置。
    expect(store.message[sessionID]).toHaveLength(1)
    expect(store.message[sessionID]?.[0]).toMatchObject({
      id: optimistic.id,
      time: { created: 120 },
      steerTargetTurnID: "turn_active",
    })
  })

  test("upserts and prunes message parts", () => {
    const sessionID = "ses_1"
    const messageID = "msg_1"
    const [store, setStore] = createStore(
      baseState({
        part: { [messageID]: [textPart("prt_1", sessionID, messageID), textPart("prt_3", sessionID, messageID)] },
      }),
    )

    applyDirectoryEvent({
      event: { type: "message.part.updated", properties: { part: textPart("prt_2", sessionID, messageID) } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })
    expect(store.part[messageID]?.map((x) => x.id)).toEqual(["prt_1", "prt_2", "prt_3"])

    applyDirectoryEvent({
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            ...textPart("prt_2", sessionID, messageID),
            text: "changed",
          } as Part,
        },
      },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })
    const updated = store.part[messageID]?.find((x) => x.id === "prt_2")
    expect(updated?.type).toBe("text")
    if (updated?.type === "text") expect(updated.text).toBe("changed")

    applyDirectoryEvent({
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            ...textPart("prt_server_skill", sessionID, messageID),
            metadata: { skill: { name: "skill-creator", location: "/Users/developer/.codex/skills/skill-creator/SKILL.md" } },
          } as Part,
        },
      },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })

    applyDirectoryEvent({
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            ...textPart("prt_fresh_skill", sessionID, messageID),
            metadata: { skill: { name: "skill-creator", location: "/Users/developer/.codex/skills/skill-creator/SKILL.md" } },
          } as Part,
        },
      },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })

    expect(
      store.part[messageID]?.filter((part) => part.type === "text" && !!part.metadata?.skill).map((x) => x.id),
    ).toEqual(["prt_fresh_skill"])

    applyDirectoryEvent({
      event: { type: "message.part.removed", properties: { messageID, partID: "prt_1" } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })
    applyDirectoryEvent({
      event: { type: "message.part.removed", properties: { messageID, partID: "prt_2" } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })
    applyDirectoryEvent({
      event: { type: "message.part.removed", properties: { messageID, partID: "prt_3" } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })
    applyDirectoryEvent({
      event: { type: "message.part.removed", properties: { messageID, partID: "prt_fresh_skill" } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })

    expect(store.part[messageID]).toBeUndefined()
  })

  test("appends coalesced message part deltas", () => {
    const sessionID = "ses_1"
    const messageID = "msg_1"
    const partID = "prt_1"
    const part = textPart(partID, sessionID, messageID)
    if (part.type !== "text") throw new Error("expected text part")
    part.text = "hello"
    const [store, setStore] = createStore(
      baseState({
        part: {
          [messageID]: [part],
        },
      }),
    )

    applyDirectoryEvent({
      event: {
        type: "message.part.delta",
        properties: {
          sessionID,
          messageID,
          partID,
          field: "text",
          delta: " world from one merged delta",
        },
      },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })

    const updated = store.part[messageID]?.[0]
    expect(updated?.type).toBe("text")
    if (updated?.type === "text") expect(updated.text).toBe("hello world from one merged delta")
  })

  test("keeps longer live text when a stale part snapshot arrives", () => {
    const sessionID = "ses_1"
    const messageID = "msg_1"
    const partID = "prt_1"
    const current = textPart(partID, sessionID, messageID)
    if (current.type !== "text") throw new Error("expected text part")
    current.text = "0\n1\n2\n3\n4\n5\n"
    const [store, setStore] = createStore(
      baseState({
        part: {
          [messageID]: [current],
        },
      }),
    )

    applyDirectoryEvent({
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            ...textPart(partID, sessionID, messageID),
            text: "",
          } as Part,
        },
      },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })

    const live = store.part[messageID]?.[0]
    expect(live?.type).toBe("text")
    if (live?.type === "text") expect(live.text).toBe("0\n1\n2\n3\n4\n5\n")

    applyDirectoryEvent({
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            ...textPart(partID, sessionID, messageID),
            text: "final",
            time: { start: 1, end: 2 },
          } as Part,
        },
      },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })

    const done = store.part[messageID]?.[0]
    expect(done?.type).toBe("text")
    if (done?.type === "text") expect(done.text).toBe("final")
  })

  test("keeps step-finish parts as completion signals", () => {
    const sessionID = "ses_1"
    const messageID = "msg_1"
    const [store, setStore] = createStore(baseState())

    applyDirectoryEvent({
      event: { type: "message.part.updated", properties: { part: stepFinishPart("prt_done", sessionID, messageID) } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })

    expect(store.part[messageID]?.map((x) => x.type)).toEqual(["step-finish"])
  })

  test("tracks permission and question request lifecycles", () => {
    const sessionID = "ses_1"
    const [store, setStore] = createStore(
      baseState({
        permission: { [sessionID]: [permissionRequest("perm_1", sessionID), permissionRequest("perm_3", sessionID)] },
        question: { [sessionID]: [questionRequest("q_1", sessionID), questionRequest("q_3", sessionID)] },
      }),
    )

    applyDirectoryEvent({
      event: { type: "permission.asked", properties: permissionRequest("perm_2", sessionID) },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })
    expect(store.permission[sessionID]?.map((x) => x.id)).toEqual(["perm_1", "perm_2", "perm_3"])

    applyDirectoryEvent({
      event: { type: "permission.asked", properties: permissionRequest("perm_2", sessionID, "updated") },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })
    expect(store.permission[sessionID]?.find((x) => x.id === "perm_2")?.permission).toBe("updated")

    applyDirectoryEvent({
      event: { type: "permission.replied", properties: { sessionID, requestID: "perm_2" } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })
    expect(store.permission[sessionID]?.map((x) => x.id)).toEqual(["perm_1", "perm_3"])

    applyDirectoryEvent({
      event: { type: "question.asked", properties: questionRequest("q_2", sessionID) },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })
    expect(store.question[sessionID]?.map((x) => x.id)).toEqual(["q_1", "q_2", "q_3"])

    applyDirectoryEvent({
      event: { type: "question.asked", properties: questionRequest("q_2", sessionID, "updated") },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })
    expect(store.question[sessionID]?.find((x) => x.id === "q_2")?.questions[0]?.header).toBe("updated")

    applyDirectoryEvent({
      event: { type: "question.rejected", properties: { sessionID, requestID: "q_2" } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })
    expect(store.question[sessionID]?.map((x) => x.id)).toEqual(["q_1", "q_3"])
  })

  test("session.suggestion writes text into store", () => {
    const sessionID = "ses_1"
    const [store, setStore] = createStore(baseState())

    applyDirectoryEvent({
      event: { type: "session.suggestion", properties: { sessionID, text: "hello suggestion" } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })

    expect(store.session_suggestion[sessionID]).toBe("hello suggestion")
  })

  test("message.updated with role user clears suggestion for that session", () => {
    const sessionID = "ses_1"
    const [store, setStore] = createStore(
      baseState({
        session_suggestion: { [sessionID]: "stale suggestion", other_ses: "keep me" },
      }),
    )

    applyDirectoryEvent({
      event: { type: "message.updated", properties: { info: userMessage("msg_1", sessionID) } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })

    expect(store.session_suggestion[sessionID]).toBeUndefined()
    expect(store.session_suggestion.other_ses).toBe("keep me")
  })

  test("message.updated with role assistant does NOT clear suggestion for that session", () => {
    const sessionID = "ses_1"
    const [store, setStore] = createStore(
      baseState({
        session_suggestion: { [sessionID]: "keep me", other_ses: "keep me too" },
      }),
    )

    applyDirectoryEvent({
      event: {
        type: "message.updated",
        properties: {
          info: {
            ...userMessage("msg_1", sessionID),
            role: "assistant",
          } as Message,
        },
      },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })

    expect(store.session_suggestion[sessionID]).toBe("keep me")
    expect(store.session_suggestion.other_ses).toBe("keep me too")
  })

  test("re-sending an existing user message (summary update) does NOT clear suggestion", () => {
    const sessionID = "ses_1"
    const msg = userMessage("msg_1", sessionID)
    // Start with the message already in the store so it's treated as an existing message
    const [store, setStore] = createStore(
      baseState({
        message: { [sessionID]: [msg] },
        session_suggestion: { [sessionID]: "fresh suggestion" },
      }),
    )

    // Backend re-sends the same user message (e.g. after SessionSummary.summarize)
    applyDirectoryEvent({
      event: { type: "message.updated", properties: { info: msg } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })

    // The suggestion must NOT be wiped out by a re-send of an already-existing message
    expect(store.session_suggestion[sessionID]).toBe("fresh suggestion")
  })

  test("new user message appended to a session with existing messages clears suggestion", () => {
    const sessionID = "ses_1"
    // 主生产路径：会话已有消息，用户发出后续消息
    const [store, setStore] = createStore(
      baseState({
        message: { [sessionID]: [userMessage("msg_1", sessionID)] },
        session_suggestion: { [sessionID]: "stale suggestion" },
      }),
    )

    applyDirectoryEvent({
      event: { type: "message.updated", properties: { info: userMessage("msg_2", sessionID) } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })

    expect(store.session_suggestion[sessionID]).toBeUndefined()
    expect(store.message[sessionID]?.map((m) => m.id)).toEqual(["msg_1", "msg_2"])
  })

  test("message.removed clears suggestion for that session", () => {
    const sessionID = "ses_1"
    const msg = userMessage("msg_1", sessionID)
    const [store, setStore] = createStore(
      baseState({
        message: { [sessionID]: [msg] },
        session_suggestion: { [sessionID]: "derived from removed turn", other_ses: "keep me" },
      }),
    )

    applyDirectoryEvent({
      event: { type: "message.removed", properties: { sessionID, messageID: msg.id } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })

    expect(store.session_suggestion[sessionID]).toBeUndefined()
    expect(store.session_suggestion.other_ses).toBe("keep me")
  })

  test("clears stale branch when git repo removed", () => {
    const [store, setStore] = createStore(
      baseState({ vcs: { branch: "main", default_branch: "main", local_git: true } }),
    )
    applyDirectoryEvent({
      event: { type: "vcs.branch.updated", properties: { branch: undefined } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })
    expect(store.vcs?.branch).toBeUndefined()
    expect(store.vcs?.default_branch).toBeUndefined()
    expect(store.vcs?.local_git).toBe(true)
  })

  test("updates vcs branch in store and cache", () => {
    const [store, setStore] = createStore(baseState({ vcs: { branch: "main", default_branch: "main" } }))
    const [cacheStore, setCacheStore] = createStore({
      value: { branch: "main", default_branch: "main" } as State["vcs"],
    })

    applyDirectoryEvent({
      event: { type: "vcs.branch.updated", properties: { branch: "feature/test" } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
      vcsCache: {
        store: cacheStore,
        setStore: setCacheStore,
        ready: () => true,
      },
    })

    expect(store.vcs).toEqual({ branch: "feature/test", default_branch: "main" })
    expect(cacheStore.value).toEqual({ branch: "feature/test", default_branch: "main" })
  })

  test("routes disposal and lsp events to side-effect handlers", () => {
    const [store, setStore] = createStore(baseState())
    const pushes: string[] = []
    let lspLoads = 0

    applyDirectoryEvent({
      event: { type: "server.instance.disposed" },
      store,
      setStore,
      push(directory) {
        pushes.push(directory)
      },
      directory: "/tmp",
      loadLsp() {
        lspLoads += 1
      },
    })

    applyDirectoryEvent({
      event: { type: "lsp.updated" },
      store,
      setStore,
      push(directory) {
        pushes.push(directory)
      },
      directory: "/tmp",
      loadLsp() {
        lspLoads += 1
      },
    })

    expect(pushes).toEqual(["/tmp"])
    expect(lspLoads).toBe(1)
  })

  test("writes session goal on session.goal.updated", () => {
    const [store, setStore] = createStore(baseState())
    const goals: Array<{ sessionID: string; goal: Goal | undefined }> = []
    const goal = {
      objective: "ship the feature",
      status: "active",
      tokenBudget: null,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: 1,
      updatedAt: 1,
    } as Goal

    applyDirectoryEvent({
      event: { type: "session.goal.updated", properties: { sessionID: "ses_1", goal } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
      setSessionGoal(sessionID, value) {
        goals.push({ sessionID, goal: value })
      },
    })

    expect(goals).toEqual([{ sessionID: "ses_1", goal }])
  })

  test("clears session goal on session.goal.cleared", () => {
    const [store, setStore] = createStore(baseState())
    const goals: Array<{ sessionID: string; goal: Goal | undefined }> = []

    applyDirectoryEvent({
      event: { type: "session.goal.cleared", properties: { sessionID: "ses_1" } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
      setSessionGoal(sessionID, value) {
        goals.push({ sessionID, goal: value })
      },
    })

    expect(goals).toEqual([{ sessionID: "ses_1", goal: undefined }])
  })
})

describe("session removal tombstone", () => {
  test("deleted decrements total for unloaded root sessions (found=false, no tombstone)", () => {
    const [store, setStore] = createStore(
      baseState({
        // 分页只载入了 a，服务端还有一条未加载的 zz
        session: [rootSession({ id: "a" })],
        sessionTotal: 2,
      }),
    )

    applyDirectoryEvent({
      event: { type: "session.deleted", properties: { info: rootSession({ id: "zz" }) } },
      store,
      setStore,
      push() {},
      directory: "/tmp/project",
      loadLsp() {},
    })

    expect(store.session.map((x) => x.id)).toEqual(["a"])
    expect(store.sessionTotal).toBe(1)
  })

  test("tombstone dedupes exactly one late deleted event, then normal semantics resume", () => {
    const [store, setStore] = createStore(
      baseState({
        session: [rootSession({ id: "a" })],
        sessionTotal: 2,
      }),
    )
    // 模拟本地终态结算先行：已提前递减过（这里只打标记，store 不动）
    expect(settleRemovalLocally("/tmp/project", "gone")).toBe(true)

    applyDirectoryEvent({
      event: { type: "session.deleted", properties: { info: rootSession({ id: "gone" }) } },
      store,
      setStore,
      push() {},
      directory: "/tmp/project",
      loadLsp() {},
    })
    expect(store.sessionTotal).toBe(2)

    // 墓碑只抵消一次：同 id 再次 deleted（异常重放）恢复正常递减
    applyDirectoryEvent({
      event: { type: "session.deleted", properties: { info: rootSession({ id: "gone" }) } },
      store,
      setStore,
      push() {},
      directory: "/tmp/project",
      loadLsp() {},
    })
    expect(store.sessionTotal).toBe(1)
  })

  test("tombstone dedupes late archived (session.updated) decrement", () => {
    const [store, setStore] = createStore(
      baseState({
        session: [rootSession({ id: "a" })],
        sessionTotal: 2,
      }),
    )
    // 独立 id，避免前一用例（事件重放）遗留的 event 侧标记串扰
    expect(settleRemovalLocally("/tmp/project", "gone-archived")).toBe(true)

    applyDirectoryEvent({
      event: {
        type: "session.updated",
        properties: { info: rootSession({ id: "gone-archived", archived: 3 }) },
      },
      store,
      setStore,
      push() {},
      directory: "/tmp/project",
      loadLsp() {},
    })
    expect(store.sessionTotal).toBe(2)
  })
})

describe("removal settlement ordering", () => {
  test("SSE first, local settle second: settle skips the decrement", () => {
    const [store, setStore] = createStore(
      baseState({
        session: [rootSession({ id: "sse-first" })],
        sessionTotal: 1,
      }),
    )

    applyDirectoryEvent({
      event: { type: "session.deleted", properties: { info: rootSession({ id: "sse-first" }) } },
      store,
      setStore,
      push() {},
      directory: "/tmp/project",
      loadLsp() {},
    })
    expect(store.sessionTotal).toBe(0)

    // 归档成功/兜底的本地结算后到：应跳过递减
    expect(settleRemovalLocally("/tmp/project", "sse-first")).toBe(false)
  })

  test("restore invalidates stale local marker: next legit delete decrements normally", () => {
    const [store, setStore] = createStore(
      baseState({
        session: [rootSession({ id: "revived" })],
        sessionTotal: 1,
      }),
    )
    // 本地结算先行（对应旧一轮归档/删除，SSE 丢失）
    expect(settleRemovalLocally("/tmp/project", "revived")).toBe(true)

    // 会话恢复（unarchive/created）：作废残留标记
    applyDirectoryEvent({
      event: { type: "session.created", properties: { info: rootSession({ id: "revived" }) } },
      store,
      setStore,
      push() {},
      directory: "/tmp/project",
      loadLsp() {},
    })

    // 新一轮合法删除：不应误中旧标记，正常递减
    applyDirectoryEvent({
      event: { type: "session.deleted", properties: { info: rootSession({ id: "revived" }) } },
      store,
      setStore,
      push() {},
      directory: "/tmp/project",
      loadLsp() {},
    })
    expect(store.sessionTotal).toBe(0)
  })
})
