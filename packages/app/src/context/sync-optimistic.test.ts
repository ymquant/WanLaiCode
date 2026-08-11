import { describe, expect, test } from "bun:test"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import {
  applyOptimisticAdd,
  applyOptimisticRemove,
  mergeConcurrentMessageSnapshot,
  mergeOptimisticPage,
  prependMessagePage,
} from "./sync"

type Text = Extract<Part, { type: "text" }>

const userMessage = (id: string, sessionID: string): Message => ({
  id,
  sessionID,
  role: "user",
  time: { created: 1 },
  agent: "assistant",
  model: { providerID: "openai", modelID: "gpt" },
})

const textPart = (id: string, sessionID: string, messageID: string): Text => ({
  id,
  sessionID,
  messageID,
  type: "text",
  text: id,
})

describe("sync optimistic reducers", () => {
  test("applyOptimisticAdd appends a new message in turn item order and stores parts", () => {
    const sessionID = "ses_1"
    const draft = {
      message: { [sessionID]: [userMessage("msg_2", sessionID)] },
      part: {} as Record<string, Part[] | undefined>,
      session_suggestion: {} as Record<string, string | undefined>,
    }

    applyOptimisticAdd(draft, {
      sessionID,
      message: userMessage("msg_1", sessionID),
      parts: [textPart("prt_2", sessionID, "msg_1"), textPart("prt_1", sessionID, "msg_1")],
    })

    // 入队时生成的旧 ID 不能把稍后才提交的 steer 插回已有活动之前。
    expect(draft.message[sessionID]?.map((x) => x.id)).toEqual(["msg_2", "msg_1"])
    expect(draft.part.msg_1?.map((x) => x.id)).toEqual(["prt_1", "prt_2"])
  })

  test("applyOptimisticAdd clears the session suggestion for an optimistic user message", () => {
    const sessionID = "ses_1"
    // 乐观插入与服务端事件同 ID，message.updated 到达时会命中 found 分支而不清除，
    // 因此必须在乐观插入时就清掉旧建议
    const draft = {
      message: {} as Record<string, Message[] | undefined>,
      part: {} as Record<string, Part[] | undefined>,
      session_suggestion: { [sessionID]: "stale suggestion", other_ses: "keep me" } as Record<
        string,
        string | undefined
      >,
    }

    applyOptimisticAdd(draft, {
      sessionID,
      message: userMessage("msg_1", sessionID),
      parts: [textPart("prt_1", sessionID, "msg_1")],
    })

    expect(draft.session_suggestion[sessionID]).toBeUndefined()
    expect(draft.session_suggestion.other_ses).toBe("keep me")
  })

  test("applyOptimisticAdd replaces existing message with the same id", () => {
    const sessionID = "ses_1"
    const draft = {
      message: { [sessionID]: [userMessage("msg_1", sessionID)] },
      part: { msg_1: [textPart("prt_old", sessionID, "msg_1")] } as Record<string, Part[] | undefined>,
      session_suggestion: {} as Record<string, string | undefined>,
    }

    applyOptimisticAdd(draft, {
      sessionID,
      message: { ...userMessage("msg_1", sessionID), time: { created: 2 } },
      parts: [textPart("prt_new", sessionID, "msg_1")],
    })

    expect(draft.message[sessionID]?.map((x) => x.id)).toEqual(["msg_1"])
    expect(draft.message[sessionID]?.[0]?.time.created).toBe(2)
    expect(draft.part.msg_1?.map((x) => x.id)).toEqual(["prt_new"])
  })

  test("applyOptimisticRemove removes message and part entries", () => {
    const sessionID = "ses_1"
    const draft = {
      message: { [sessionID]: [userMessage("msg_1", sessionID), userMessage("msg_2", sessionID)] },
      part: {
        msg_1: [textPart("prt_1", sessionID, "msg_1")],
        msg_2: [textPart("prt_2", sessionID, "msg_2")],
      } as Record<string, Part[] | undefined>,
      session_suggestion: {} as Record<string, string | undefined>,
    }

    applyOptimisticRemove(draft, { sessionID, messageID: "msg_1" })

    expect(draft.message[sessionID]?.map((x) => x.id)).toEqual(["msg_2"])
    expect(draft.part.msg_1).toBeUndefined()
    expect(draft.part.msg_2).toHaveLength(1)
  })

  test("mergeOptimisticPage keeps pending messages in fetched timelines", () => {
    const sessionID = "ses_1"
    const page = mergeOptimisticPage(
      {
        session: [userMessage("msg_1", sessionID)],
        part: [{ id: "msg_1", part: [textPart("prt_1", sessionID, "msg_1")] }],
        complete: true,
      },
      [{ message: userMessage("msg_2", sessionID), parts: [textPart("prt_2", sessionID, "msg_2")] }],
    )

    expect(page.session.map((x) => x.id)).toEqual(["msg_1", "msg_2"])
    expect(page.part.find((x) => x.id === "msg_2")?.part.map((x) => x.id)).toEqual(["prt_2"])
    expect(page.confirmed).toEqual([])
    expect(page.complete).toBe(true)
  })

  test("mergeOptimisticPage appends an old-id steer after fetched assistant activity", () => {
    const sessionID = "ses_1"
    const page = mergeOptimisticPage(
      {
        session: [userMessage("msg_9", sessionID)],
        part: [{ id: "msg_9", part: [textPart("prt_9", sessionID, "msg_9")] }],
        complete: true,
      },
      [{ message: userMessage("msg_1", sessionID), parts: [textPart("prt_1", sessionID, "msg_1")] }],
    )

    // 官方在点击引导时 push steeringUserMessage；其旧 ID 不参与位置计算。
    expect(page.session.map((message) => message.id)).toEqual(["msg_9", "msg_1"])
  })

  test("prependMessagePage keeps server page order and puts older history first", () => {
    const sessionID = "ses_1"
    const result = prependMessagePage(
      [userMessage("msg_8", sessionID), userMessage("msg_1", sessionID)],
      [userMessage("msg_7", sessionID), userMessage("msg_6", sessionID), userMessage("msg_8", sessionID)],
    )

    // 分页边界只按 ID 去重；页内顺序和当前 turn 顺序都必须原样保留。
    expect(result.map((message) => message.id)).toEqual(["msg_7", "msg_6", "msg_8", "msg_1"])
  })

  test("replace snapshot keeps steer and assistant events received during fetch", () => {
    const sessionID = "ses_1"
    const root = userMessage("msg_9", sessionID)
    const snapshotAssistant = userMessage("msg_8", sessionID)
    const liveSteer = userMessage("msg_1", sessionID)
    const liveAssistant = userMessage("msg_2", sessionID)
  const result = mergeConcurrentMessageSnapshot(
      [root, snapshotAssistant],
      [root, liveSteer, liveAssistant],
      new Map([[root.id, JSON.stringify(root)]]),
    )

    // 官方 item push 语义要求请求期间到达的 steer/A2 保留在快照末尾，不能被较旧 HTTP 响应整体覆盖。
    expect(result.map((message) => message.id)).toEqual(["msg_9", "msg_8", "msg_1", "msg_2"])
  })

  test("replace snapshot still removes stale messages that predate fetch", () => {
    const sessionID = "ses_1"
    const root = userMessage("msg_9", sessionID)
    const stale = userMessage("msg_8", sessionID)
    const result = mergeConcurrentMessageSnapshot(
      [root],
      [root, stale],
      new Map([
        [root.id, JSON.stringify(root)],
        [stale.id, JSON.stringify(stale)],
      ]),
    )

    // 请求前已有但服务端快照已删除的缓存不能因竞态保护而复活。
    expect(result.map((message) => message.id)).toEqual(["msg_9"])
  })

  test("replace snapshot keeps a same-id completion event received during fetch", () => {
    const sessionID = "ses_1"
    const before = userMessage("msg_9", sessionID)
    const completed = { ...before, time: { created: 1, completed: 2 } } as Message
    const result = mergeConcurrentMessageSnapshot(
      [before],
      [completed],
      new Map([[before.id, JSON.stringify(before)]]),
    )

    // 同 ID 的完成事件已经后到，旧 HTTP 快照不能把完成字段倒退掉。
    expect(result[0]?.time).toEqual({ created: 1, completed: 2 })
  })

  test("mergeOptimisticPage keeps missing optimistic parts until the server has them", () => {
    const sessionID = "ses_1"
    const page = mergeOptimisticPage(
      {
        session: [userMessage("msg_2", sessionID)],
        part: [{ id: "msg_2", part: [textPart("prt_2", sessionID, "msg_2")] }],
        complete: true,
      },
      [
        {
          message: userMessage("msg_2", sessionID),
          parts: [textPart("prt_1", sessionID, "msg_2"), textPart("prt_2", sessionID, "msg_2")],
        },
      ],
    )

    expect(page.part.find((x) => x.id === "msg_2")?.part.map((x) => x.id)).toEqual(["prt_1", "prt_2"])
    expect(page.confirmed).toEqual([])
  })

  test("mergeOptimisticPage keeps generic user text parts until their exact server part arrives", () => {
    const sessionID = "ses_1"
    const page = mergeOptimisticPage(
      {
        session: [userMessage("msg_2", sessionID)],
        part: [{ id: "msg_2", part: [textPart("prt_server", sessionID, "msg_2")] }],
        complete: true,
      },
      [
        {
          message: userMessage("msg_2", sessionID),
          parts: [textPart("prt_optimistic", sessionID, "msg_2")],
        },
      ],
    )

    expect(page.confirmed).toEqual([])
    expect(page.part.find((x) => x.id === "msg_2")?.part.map((x) => x.id)).toEqual([
      "prt_optimistic",
      "prt_server",
    ])
  })

  test("mergeOptimisticPage replaces duplicated optimistic skill parts", () => {
    const sessionID = "ses_1"
    const skill = { name: "skill-creator", location: "/Users/developer/.codex/skills/skill-creator/SKILL.md" }
    const page = mergeOptimisticPage(
      {
        session: [userMessage("msg_2", sessionID)],
        part: [
          {
            id: "msg_2",
            part: [{ ...textPart("prt_server", sessionID, "msg_2"), metadata: { skill } }],
          },
        ],
        complete: true,
      },
      [
        {
          message: userMessage("msg_2", sessionID),
          parts: [{ ...textPart("prt_optimistic", sessionID, "msg_2"), metadata: { skill } }],
        },
      ],
    )

    expect(page.confirmed).toEqual(["msg_2"])
    expect(page.part.find((x) => x.id === "msg_2")?.part.map((x) => x.id)).toEqual(["prt_server"])
  })

  test("mergeOptimisticPage confirms echoed messages once all parts arrive", () => {
    const sessionID = "ses_1"
    const page = mergeOptimisticPage(
      {
        session: [userMessage("msg_2", sessionID)],
        part: [
          {
            id: "msg_2",
            part: [{ ...textPart("prt_1", sessionID, "msg_2"), text: "server" }, textPart("prt_2", sessionID, "msg_2")],
          },
        ],
        complete: true,
      },
      [
        {
          message: userMessage("msg_2", sessionID),
          parts: [textPart("prt_1", sessionID, "msg_2"), textPart("prt_2", sessionID, "msg_2")],
        },
      ],
    )

    expect(page.confirmed).toEqual(["msg_2"])
    expect(page.part.find((x) => x.id === "msg_2")?.part).toMatchObject([
      { id: "prt_1", type: "text", text: "server" },
      { id: "prt_2", type: "text", text: "prt_2" },
    ])
  })

  test("mergeOptimisticPage keeps steer identity after an old server confirms the same message", () => {
    const sessionID = "ses_1"
    const durable = userMessage("msg_steer", sessionID)
    const optimistic = { ...durable, steerTargetTurnID: "turn_active" } as Message
    const page = mergeOptimisticPage(
      {
        session: [durable],
        part: [{ id: durable.id, part: [textPart("prt_1", sessionID, durable.id)] }],
        complete: true,
      },
      [{ message: optimistic, parts: [textPart("prt_1", sessionID, durable.id)] }],
    )

    // parts 已确认后 optimistic 缓存会清理，但归属必须先写入合并结果，避免当前 turn 的 UI 在 ACK 后跳位。
    expect(page.confirmed).toEqual([durable.id])
    expect(page.session[0]).toMatchObject({ id: durable.id, steerTargetTurnID: "turn_active" })
  })

  test("mergeConcurrentMessageSnapshot keeps a known steer target across later old snapshots", () => {
    const sessionID = "ses_1"
    const current = { ...userMessage("msg_steer", sessionID), steerTargetTurnID: "turn_active" } as Message
    const snapshot = userMessage(current.id, sessionID)

    const merged = mergeConcurrentMessageSnapshot(
      [snapshot],
      [current],
      new Map([[current.id, JSON.stringify(current)]]),
    )

    // optimistic 缓存清理后的强制同步仍不能让旧快照擦除本会话内已经确认的 steer 身份。
    expect(merged[0]).toMatchObject({ id: current.id, steerTargetTurnID: "turn_active" })
  })
})
