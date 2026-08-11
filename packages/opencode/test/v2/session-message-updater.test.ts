import { expect, test } from "bun:test"
import * as DateTime from "effect/DateTime"
import { SessionID } from "../../src/session/schema"
import { EventV2 } from "../../src/v2/event"
import { Modelv2 } from "../../src/v2/model"
import { SessionEvent } from "../../src/v2/session-event"
import { SessionMessageUpdater } from "../../src/v2/session-message-updater"

test("step snapshots carry over to assistant messages", () => {
  const state: SessionMessageUpdater.MemoryState = { messages: [] }
  const sessionID = SessionID.make("session")

  SessionMessageUpdater.update(SessionMessageUpdater.memory(state), {
    id: EventV2.ID.create(),
    type: "session.next.step.started",
    data: {
      sessionID,
      timestamp: DateTime.makeUnsafe(1),
      agent: "build",
      model: {
        id: Modelv2.ID.make("model"),
        providerID: Modelv2.ProviderID.make("provider"),
        variant: Modelv2.VariantID.make("default"),
      },
      snapshot: "before",
    },
  } satisfies SessionEvent.Event)

  SessionMessageUpdater.update(SessionMessageUpdater.memory(state), {
    id: EventV2.ID.create(),
    type: "session.next.step.ended",
    data: {
      sessionID,
      timestamp: DateTime.makeUnsafe(2),
      finish: "stop",
      cost: 0,
      tokens: {
        input: 1,
        output: 2,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      snapshot: "after",
    },
  } satisfies SessionEvent.Event)

  expect(state.messages[0]?.type).toBe("assistant")
  if (state.messages[0]?.type !== "assistant") return
  expect(state.messages[0].snapshot).toEqual({ start: "before", end: "after" })
  expect(state.messages[0].finish).toBe("stop")
})

test("text events preserve and correct assistant text phase", () => {
  const state: SessionMessageUpdater.MemoryState = { messages: [] }
  const sessionID = SessionID.make("session")

  SessionMessageUpdater.update(SessionMessageUpdater.memory(state), {
    id: EventV2.ID.create(),
    type: "session.next.step.started",
    data: {
      sessionID,
      timestamp: DateTime.makeUnsafe(1),
      agent: "build",
      model: {
        id: Modelv2.ID.make("model"),
        providerID: Modelv2.ProviderID.make("provider"),
        variant: Modelv2.VariantID.make("default"),
      },
    },
  } satisfies SessionEvent.Event)

  SessionMessageUpdater.update(SessionMessageUpdater.memory(state), {
    id: EventV2.ID.create(),
    type: "session.next.text.started",
    data: {
      sessionID,
      timestamp: DateTime.makeUnsafe(2),
      phase: "commentary",
    },
  } satisfies SessionEvent.Event)

  SessionMessageUpdater.update(SessionMessageUpdater.memory(state), {
    id: EventV2.ID.create(),
    type: "session.next.text.ended",
    data: {
      sessionID,
      timestamp: DateTime.makeUnsafe(3),
      text: "hello assistant",
    },
  } satisfies SessionEvent.Event)

  expect(state.messages[0]?.type).toBe("assistant")
  if (state.messages[0]?.type !== "assistant") return
  // Ended 省略 phase 时不能擦掉 Started 已记录的 commentary。
  expect(state.messages[0].content).toEqual([{ type: "text", text: "hello assistant", phase: "commentary" }])

  SessionMessageUpdater.update(SessionMessageUpdater.memory(state), {
    id: EventV2.ID.create(),
    type: "session.next.text.ended",
    data: {
      sessionID,
      timestamp: DateTime.makeUnsafe(4),
      text: "hello assistant",
      phase: "final_answer",
    },
  } satisfies SessionEvent.Event)

  expect(state.messages[0]?.type).toBe("assistant")
  if (state.messages[0]?.type !== "assistant") return
  // Ended 的官方显式值拥有最高优先级，可以纠正 Started 阶段。
  expect(state.messages[0].content).toEqual([{ type: "text", text: "hello assistant", phase: "final_answer" }])

  SessionMessageUpdater.update(SessionMessageUpdater.memory(state), {
    id: EventV2.ID.create(),
    type: "session.next.step.ended",
    data: {
      sessionID,
      timestamp: DateTime.makeUnsafe(5),
      finish: "tool-calls",
      cost: 0,
      tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    },
  } satisfies SessionEvent.Event)

  expect(state.messages[0]?.type).toBe("assistant")
  if (state.messages[0]?.type !== "assistant") return
  // finish 只为缺失值兜底，不能反向覆盖 Responses 已经确认的官方 phase。
  expect(state.messages[0].content).toEqual([{ type: "text", text: "hello assistant", phase: "final_answer" }])
})

test("step finish infers missing text phase for compatible chat providers", () => {
  const project = (finish: "tool-calls" | "stop") => {
    const state: SessionMessageUpdater.MemoryState = { messages: [] }
    const sessionID = SessionID.make(`session-${finish}`)

    // 兼容 Chat 流不会在 text 事件提供 phase，投影必须等 finish-step 后再确定正文归属。
    SessionMessageUpdater.update(SessionMessageUpdater.memory(state), {
      id: EventV2.ID.create(),
      type: "session.next.step.started",
      data: {
        sessionID,
        timestamp: DateTime.makeUnsafe(1),
        agent: "build",
        model: {
          id: Modelv2.ID.make("model"),
          providerID: Modelv2.ProviderID.make("provider"),
          variant: Modelv2.VariantID.make("default"),
        },
      },
    } satisfies SessionEvent.Event)
    SessionMessageUpdater.update(SessionMessageUpdater.memory(state), {
      id: EventV2.ID.create(),
      type: "session.next.text.started",
      data: { sessionID, timestamp: DateTime.makeUnsafe(2) },
    } satisfies SessionEvent.Event)
    SessionMessageUpdater.update(SessionMessageUpdater.memory(state), {
      id: EventV2.ID.create(),
      type: "session.next.text.ended",
      data: { sessionID, timestamp: DateTime.makeUnsafe(3), text: "hello assistant" },
    } satisfies SessionEvent.Event)
    SessionMessageUpdater.update(SessionMessageUpdater.memory(state), {
      id: EventV2.ID.create(),
      type: "session.next.step.ended",
      data: {
        sessionID,
        timestamp: DateTime.makeUnsafe(4),
        finish,
        cost: 0,
        tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    } satisfies SessionEvent.Event)

    return state.messages[0]?.type === "assistant" ? state.messages[0].content[0] : undefined
  }

  // 工具步骤文字留在活动流，正常 stop 的文字进入最终回复区。
  expect(project("tool-calls")).toMatchObject({ type: "text", phase: "commentary" })
  expect(project("stop")).toMatchObject({ type: "text", phase: "final_answer" })
})

test("tool completion stores completed timestamp", () => {
  const state: SessionMessageUpdater.MemoryState = { messages: [] }
  const sessionID = SessionID.make("session")
  const callID = "call"

  SessionMessageUpdater.update(SessionMessageUpdater.memory(state), {
    id: EventV2.ID.create(),
    type: "session.next.step.started",
    data: {
      sessionID,
      timestamp: DateTime.makeUnsafe(1),
      agent: "build",
      model: {
        id: Modelv2.ID.make("model"),
        providerID: Modelv2.ProviderID.make("provider"),
        variant: Modelv2.VariantID.make("default"),
      },
    },
  } satisfies SessionEvent.Event)

  SessionMessageUpdater.update(SessionMessageUpdater.memory(state), {
    id: EventV2.ID.create(),
    type: "session.next.tool.input.started",
    data: {
      sessionID,
      timestamp: DateTime.makeUnsafe(2),
      callID,
      name: "bash",
    },
  } satisfies SessionEvent.Event)

  SessionMessageUpdater.update(SessionMessageUpdater.memory(state), {
    id: EventV2.ID.create(),
    type: "session.next.tool.called",
    data: {
      sessionID,
      timestamp: DateTime.makeUnsafe(3),
      callID,
      tool: "bash",
      input: { command: "pwd" },
      provider: { executed: true, metadata: { source: "provider" } },
    },
  } satisfies SessionEvent.Event)

  SessionMessageUpdater.update(SessionMessageUpdater.memory(state), {
    id: EventV2.ID.create(),
    type: "session.next.tool.success",
    data: {
      sessionID,
      timestamp: DateTime.makeUnsafe(4),
      callID,
      structured: {},
      content: [{ type: "text", text: "/tmp" }],
      provider: { executed: true, metadata: { status: "done" } },
    },
  } satisfies SessionEvent.Event)

  expect(state.messages[0]?.type).toBe("assistant")
  if (state.messages[0]?.type !== "assistant") return
  expect(state.messages[0].content[0]?.type).toBe("tool")
  if (state.messages[0].content[0]?.type !== "tool") return
  expect(state.messages[0].content[0].time.completed).toEqual(DateTime.makeUnsafe(4))
  expect(state.messages[0].content[0].provider).toEqual({ executed: true, metadata: { status: "done" } })
})

test("compaction events reduce to compaction message", () => {
  const state: SessionMessageUpdater.MemoryState = { messages: [] }
  const sessionID = SessionID.make("session")
  const id = EventV2.ID.create()

  SessionMessageUpdater.update(SessionMessageUpdater.memory(state), {
    id,
    type: "session.next.compaction.started",
    data: {
      sessionID,
      timestamp: DateTime.makeUnsafe(1),
      reason: "auto",
    },
  } satisfies SessionEvent.Event)

  SessionMessageUpdater.update(SessionMessageUpdater.memory(state), {
    id: EventV2.ID.create(),
    type: "session.next.compaction.delta",
    data: {
      sessionID,
      timestamp: DateTime.makeUnsafe(2),
      text: "hello ",
    },
  } satisfies SessionEvent.Event)

  SessionMessageUpdater.update(SessionMessageUpdater.memory(state), {
    id: EventV2.ID.create(),
    type: "session.next.compaction.delta",
    data: {
      sessionID,
      timestamp: DateTime.makeUnsafe(3),
      text: "summary",
    },
  } satisfies SessionEvent.Event)

  SessionMessageUpdater.update(SessionMessageUpdater.memory(state), {
    id: EventV2.ID.create(),
    type: "session.next.compaction.ended",
    data: {
      sessionID,
      timestamp: DateTime.makeUnsafe(4),
      text: "final summary",
      include: "recent context",
    },
  } satisfies SessionEvent.Event)

  expect(state.messages).toHaveLength(1)
  expect(state.messages[0]).toMatchObject({
    id,
    type: "compaction",
    reason: "auto",
    summary: "final summary",
    include: "recent context",
    time: { created: DateTime.makeUnsafe(1) },
  })
})
