import { describe, expect, test } from "bun:test"
import type { AssistantMessage, Message, Part, TextPart, UserMessage } from "@opencode-ai/sdk/v2/client"
import {
  assistantEndedWithResponse,
  assistantTextPartInActivity,
  assistantTextPhase,
  assistantTurnTerminal,
  compactionFinished,
  reconcileSessionTurnActivityMembers,
  selectFinalAssistantTextPart,
  sessionTurnPresentation,
} from "./session-turn-members"

const user = (id: string) =>
  ({ id, sessionID: "session-1", role: "user", time: { created: 1 }, agent: "build", model: {} }) as UserMessage

const assistant = (id: string, parentID: string, summary = false, error?: { name: string }) =>
  ({
    id,
    sessionID: "session-1",
    role: "assistant",
    parentID,
    time: { created: 1 },
    summary,
    ...(error ? { error } : {}),
  }) as AssistantMessage

const text = (phase?: TextPart["phase"], id = "p1", messageID = "a1") =>
  ({ id, sessionID: "session-1", messageID, type: "text", text: "内容", phase }) as TextPart

const tool = () =>
  ({
    id: "tool1",
    sessionID: "session-1",
    messageID: "a1",
    type: "tool",
    tool: "read",
    callID: "call1",
    state: { status: "pending", input: {}, raw: "" },
  }) as Part

const reasoning = (completed: boolean, value = "推理摘要") =>
  ({
    id: completed ? "reasoning-done" : "reasoning-running",
    sessionID: "session-1",
    messageID: "a1",
    type: "reasoning",
    text: value,
    time: { start: 1, ...(completed ? { end: 2 } : {}) },
  }) as Part

describe("assistant text phase", () => {
  test("uses explicit provider phase before legacy inference", () => {
    // 显式 phase 是官方真值，即使 assistant 的 finish 看起来属于另一类，也不能被客户端回退覆盖。
    expect(assistantTextPhase({ part: text("final_answer"), message: { finish: "tool-calls" }, parts: [] })).toBe(
      "final_answer",
    )
    expect(assistantTextPhase({ part: text("commentary"), message: { finish: "stop" }, parts: [] })).toBe("commentary")
  })

  test("recovers provider phase from historical metadata", () => {
    const part = { ...text(), metadata: { openai: { itemId: "msg_1", phase: "commentary" } } }

    // 旧 Responses 会话没有顶层 phase，不能因升级后只读新字段就把原 commentary 挪到底部。
    expect(assistantTextPhase({ part, message: { finish: "stop" }, parts: [] })).toBe("commentary")
  })

  test("keeps legacy tool-step text in activity and stop text in the final answer", () => {
    expect(assistantTextPhase({ part: text(), message: { finish: "tool-calls" }, parts: [] })).toBe("commentary")
    expect(assistantTextPhase({ part: text(), message: { finish: "stop" }, parts: [] })).toBe("final_answer")
  })

  test("moves an unfinished legacy text into activity as soon as its tool appears", () => {
    expect(assistantTextPhase({ part: text(), message: { finish: undefined }, parts: [text(), tool()] })).toBe(
      "commentary",
    )
    expect(assistantTextPhase({ part: text(), message: { finish: undefined }, parts: [text()] })).toBe("final_answer")
  })

  test("keeps unfinished legacy text after its tools as the final answer", () => {
    const answer = text(undefined, "answer")

    // 历史消息可能只有 completed 而没有 finish；工具后的尾部正文不能因此被折叠进活动流而看似消失。
    expect(assistantTextPhase({ part: answer, message: { finish: undefined }, parts: [tool(), answer] })).toBe(
      "final_answer",
    )
  })

  test("keeps prior commentary addressable after a new empty assistant arrives", () => {
    const progress = { ...assistant("a1", "u1"), finish: "tool-calls" }
    const empty = assistant("a2", "u1")
    const result = sessionTurnPresentation({
      messages: [user("u1"), progress, empty],
      rootMessageID: "u1",
      memberMessageIDs: ["u1", "a1", "a2"],
    })

    // 最新空 assistant 只承接运行状态；旧工具步骤仍留在 activity，phase 回退继续把其文字识别为 commentary。
    expect(result.finalAssistant?.id).toBe("a2")
    expect(result.activity.map((member) => member.message.id)).toEqual(["a1", "a2"])
    expect(assistantTextPhase({ part: text(), message: progress, parts: [] })).toBe("commentary")
  })
})

describe("final assistant text selection", () => {
  test("keeps an earlier final answer from the same assistant in activity", () => {
    const message = { ...assistant("a1", "u1"), finish: "stop" }
    const parts = [text("final_answer", "p1", "a1"), text("final_answer", "p2", "a1")]
    const selected = selectFinalAssistantTextPart([{ message, parts }])

    // 同一 assistant 内只能把最后一个具体 item 抽到底部；更早的 final_answer 仍按原顺序留在活动区。
    expect(selected?.part.id).toBe("p2")
    expect(parts.filter((part) => assistantTextPartInActivity(part, selected?.part.id)).map((part) => part.id)).toEqual(
      ["p1"],
    )
  })

  test("keeps an earlier final answer from another assistant in activity", () => {
    const items = [
      {
        message: { ...assistant("a1", "u1"), finish: "stop" },
        parts: [text("final_answer", "p1", "a1")],
      },
      {
        message: { ...assistant("a2", "u1"), finish: "stop" },
        parts: [text("final_answer", "p2", "a2")],
      },
    ]
    const selected = selectFinalAssistantTextPart(items)

    // 选择范围覆盖整个当前响应段，而不是只看最后一条 assistant；活动过滤仍只排除最终的一个 part。
    expect(selected?.message.id).toBe("a2")
    expect(selected?.part.id).toBe("p2")
    expect(
      items.flatMap((item) =>
        item.parts.filter((part) => assistantTextPartInActivity(part, selected?.part.id)).map((part) => part.id),
      ),
    ).toEqual(["p1"])
  })

  test("does not extract a final answer while a later tool is active", () => {
    const message = { ...assistant("a1", "u1"), finish: "stop" }
    const parts = [text("final_answer", "p1", "a1"), tool()]

    // 工具位于最终文字之后时，官方仍把整段留在活动区，不能提前跳到底部造成闪动。
    expect(selectFinalAssistantTextPart([{ message, parts }])).toBeUndefined()
  })

  test("extracts a final answer after an earlier tool", () => {
    const message = { ...assistant("a1", "u1"), finish: "stop" }
    const parts = [tool(), text("final_answer", "p1", "a1")]

    // 工具已经位于最终文字之前时，尾部 item 就是官方可单独渲染的最终回复。
    expect(selectFinalAssistantTextPart([{ message, parts }])?.part.id).toBe("p1")
  })

  test("extracts a legacy final answer after a tool when finish is missing", () => {
    const message = assistant("a1", "u1")
    const answer = text(undefined, "answer", "a1")
    const parts = [tool(), answer]

    // 旧会话若只持久化 completed，仍应按 item 原顺序识别工具后的最后一段正文。
    expect(selectFinalAssistantTextPart([{ message, parts }])?.part.id).toBe("answer")
  })

  test("does not extract a final answer while trailing reasoning is running", () => {
    const message = { ...assistant("a1", "u1"), finish: "stop" }
    const parts = [text("final_answer", "p1", "a1"), reasoning(false)]

    // 未完成 reasoning 仍会继续增长；此时移动前面的正文会破坏 item 原位顺序。
    expect(selectFinalAssistantTextPart([{ message, parts }])).toBeUndefined()
  })

  test("does not extract a final answer before the first reasoning delta", () => {
    const message = { ...assistant("a1", "u1"), finish: "stop" }
    const parts = [text("final_answer", "p1", "a1"), reasoning(false, "")]

    // reasoning-start 先落空 item；它必须立刻阻挡提取，否则首个 delta 到达时最终正文会从底部突然跳回活动区。
    expect(selectFinalAssistantTextPart([{ message, parts }])).toBeUndefined()
  })

  test("does not extract a final answer before the first commentary text delta", () => {
    const message = { ...assistant("a1", "u1"), finish: "stop" }
    const pending = { ...text("commentary", "p2", "a1"), text: "", time: { start: 2 } }
    const parts = [text("final_answer", "p1", "a1"), pending]

    // text-start 创建的空 item 已经进入官方 item 序列；首个 delta 前后都应阻挡旧 final 被抽到底部，避免正文跳位。
    expect(selectFinalAssistantTextPart([{ message, parts }])).toBeUndefined()
    pending.text = "进度"
    expect(selectFinalAssistantTextPart([{ message, parts }])).toBeUndefined()
  })

  test("extracts a final answer before trailing completed reasoning", () => {
    const message = { ...assistant("a1", "u1"), finish: "stop" }
    const parts = [text("final_answer", "p1", "a1"), reasoning(true)]

    // 官方允许完成快照晚于最终回复到达；已完成 reasoning 不阻挡唯一底部回复的提取。
    expect(selectFinalAssistantTextPart([{ message, parts }])?.part.id).toBe("p1")
  })
})

describe("session turn presentation", () => {
  test("reuses existing activity members when a new assistant is appended", () => {
    const first = assistant("a1", "u1")
    const second = assistant("a2", "u1")
    const third = assistant("a3", "u1")
    const previous = sessionTurnPresentation({
      messages: [user("u1"), first, second],
      rootMessageID: "u1",
      memberMessageIDs: ["u1", "a1", "a2"],
    }).activity
    const next = sessionTurnPresentation({
      messages: [user("u1"), first, second, third],
      rootMessageID: "u1",
      memberMessageIDs: ["u1", "a1", "a2", "a3"],
    }).activity
    const reconciled = reconcileSessionTurnActivityMembers(previous, next)

    // 新步骤到达时保留更早的历史节点；只有 final 标记改变的上一条和真正新增的 assistant 需要更新。
    expect(reconciled[0]).toBe(previous[0])
    expect(reconciled[1]).toBe(next[1])
    expect(reconciled[1]).not.toBe(previous[1])
    expect(reconciled[2]).toBe(next[2])
  })

  test("preserves assistant and steering source order inside one turn", () => {
    const messages: Message[] = [user("u1"), assistant("a1", "u1"), user("u2"), assistant("a2", "u2")]
    const result = sessionTurnPresentation({
      messages,
      rootMessageID: "u1",
      memberMessageIDs: ["u1", "a1", "u2", "a2"],
      steeringUserMessageIDs: ["u2"],
    })

    // 逻辑成员和展开态 DOM 都按官方 turn.items 保留源顺序；折叠态才单独投影持久 steer 气泡。
    expect(result.activity.map((member) => `${member.type}:${member.message.id}`)).toEqual([
      "assistant:a1",
      "steering:u2",
      "assistant:a2",
    ])
    expect(result.finalAssistant?.id).toBe("a2")
    expect(result.currentAssistants.map((message) => message.id)).toEqual(["a2"])
    // steer 会切开活动段；最新段的内容从 steer 气泡之后开始，旧段不会再共享思考标题。
    expect(
      result.activitySegments.map((segment) => ({
        steering: segment.steering?.id,
        members: segment.members.map((member) => member.message.id),
      })),
    ).toEqual([
      { steering: undefined, members: ["a1"] },
      { steering: "u2", members: ["a2"] },
    ])
  })

  test("keeps earlier assistant text out of the final reply selection", () => {
    const messages: Message[] = [
      user("u1"),
      assistant("a1", "u1"),
      user("u2"),
      assistant("summary", "u2", true),
      assistant("a2", "u2"),
    ]
    const result = sessionTurnPresentation({
      messages,
      rootMessageID: "u1",
      memberMessageIDs: messages.map((message) => message.id),
      steeringUserMessageIDs: ["u2"],
    })

    // 压缩摘要不占最终回复；最后一个真实 assistant 才能出现在 turn 底部。
    // 成功的压缩摘要属内部产物，被排除出成员列表（见下方专项用例）。
    expect(result.finalAssistant?.id).toBe("a2")
    expect(result.assistants.map((message) => message.id)).toEqual(["a1", "a2"])
  })

  test("excludes a successful compaction summary from turn members, assistants and activity", () => {
    // 自动压缩的摘要会被折叠重挂到本轮；作为内部产物不应出现在成员/活动里（否则 reasoning 漏出、时长被污染）。
    const messages: Message[] = [user("u1"), assistant("a1", "u1"), assistant("summary", "u1", true)]
    const result = sessionTurnPresentation({
      messages,
      rootMessageID: "u1",
      memberMessageIDs: ["u1", "a1", "summary"],
    })

    expect(result.assistants.map((message) => message.id)).toEqual(["a1"])
    expect(result.currentAssistants.map((message) => message.id)).toEqual(["a1"])
    expect(result.members.map((message) => message.id)).toEqual(["u1", "a1"])
    expect(result.activity.map((member) => member.message.id)).toEqual(["a1"])
  })

  // overflow 自动压缩与后续续跑共享同一回合；压缩分割线的时态只能看压缩摘要自身是否收尾，
  // 不能绑整回合 working——否则目标模式续跑几小时期间 divider 会一直卡在「正在压缩会话…」。
  test("treats a compaction as finished once its summary assistant completes", () => {
    const done = { ...assistant("summary", "u1", true), time: { created: 1, completed: 2 } }
    expect(compactionFinished([user("u1"), done], "u1")).toBe(true)
  })

  test("treats a compaction as unfinished while its summary assistant is still running", () => {
    expect(compactionFinished([user("u1"), assistant("summary", "u1", true)], "u1")).toBe(false)
    expect(compactionFinished([user("u1")], "u1")).toBe(false)
  })

  test("treats a failed compaction as finished so the divider does not stay in progress forever", () => {
    const failed = assistant("summary", "u1", true, { name: "ContextOverflowError" })
    expect(compactionFinished([user("u1"), failed], "u1")).toBe(true)
  })

  test("ignores summary assistants that belong to another compaction trigger", () => {
    const done = { ...assistant("summary", "u2", true), time: { created: 1, completed: 2 } }
    expect(compactionFinished([user("u1"), user("u2"), done], "u1")).toBe(false)
  })

  test("judges compaction progress by the latest summary attempt on the same trigger", () => {
    // 与 compaction part 的 findLast 策略对齐：同一触发下若出现多条摘要，以最新一条的收尾状态为准。
    const failed = assistant("s1", "u1", true, { name: "ContextOverflowError" })
    const running = assistant("s2", "u1", true)
    expect(compactionFinished([user("u1"), failed, running], "u1")).toBe(false)
  })

  test("keeps a failed compaction summary so its error card can still render", () => {
    // 压缩失败(带 error)的摘要要保留，让错误卡片仍能展示。
    const messages: Message[] = [user("u1"), assistant("summary", "u1", true, { name: "ContextOverflowError" })]
    const result = sessionTurnPresentation({
      messages,
      rootMessageID: "u1",
      memberMessageIDs: ["u1", "summary"],
    })

    expect(result.assistants.map((message) => message.id)).toEqual(["summary"])
    expect(result.members.map((message) => message.id)).toEqual(["u1", "summary"])
  })

  test("does not reuse the previous assistant as final text after a trailing steer", () => {
    const messages: Message[] = [user("u1"), assistant("a1", "u1"), user("u2")]
    const result = sessionTurnPresentation({
      messages,
      rootMessageID: "u1",
      memberMessageIDs: messages.map((message) => message.id),
      steeringUserMessageIDs: ["u2"],
    })

    // 官方此时没有 assistantItem；旧 assistant 只保留活动身份，渲染层不得再显示它的正文。
    expect(result.finalAssistant).toBeUndefined()
    expect(result.activity.map((member) => `${member.type}:${member.message.id}`)).toEqual([
      "assistant:a1",
      "steering:u2",
    ])
    expect(result.activity[0]?.type === "assistant" ? result.activity[0].final : undefined).toBe(false)
    expect(result.currentAssistants).toHaveLength(0)
    expect(result.activitySegments.map((segment) => segment.steering?.id)).toEqual([undefined, "u2"])
  })

  test("keeps consecutive steer segments in source order", () => {
    const messages: Message[] = [
      user("u1"),
      assistant("a1", "u1"),
      user("u2"),
      assistant("a2", "u2"),
      user("u3"),
      assistant("a3", "u3"),
    ]
    const result = sessionTurnPresentation({
      messages,
      rootMessageID: "u1",
      memberMessageIDs: messages.map((message) => message.id),
      steeringUserMessageIDs: ["u2", "u3"],
    })

    // 连续引导每次都产生新的活动段，后续 agent 内容只能出现在对应用户消息之后。
    expect(
      result.activitySegments.map((segment) => ({
        steering: segment.steering?.id,
        members: segment.members.map((member) => member.message.id),
      })),
    ).toEqual([
      { steering: undefined, members: ["a1"] },
      { steering: "u2", members: ["a2"] },
      { steering: "u3", members: ["a3"] },
    ])
  })

  test("retains the legacy parent based fallback", () => {
    const messages: Message[] = [user("u1"), assistant("a1", "u1"), user("u2"), assistant("a2", "u2")]
    const result = sessionTurnPresentation({ messages, rootMessageID: "u1" })

    // 尚未迁移的调用方仍只看到自己的 parent assistant，不会跨普通队列串回合。
    expect(result.members.map((message) => message.id)).toEqual(["u1", "a1"])
    expect(result.finalAssistant?.id).toBe("a1")
    expect(result.currentAssistants.map((message) => message.id)).toEqual(["a1"])
  })

  test("keeps a normal turn in one current activity segment", () => {
    const messages: Message[] = [user("u1"), assistant("a1", "u1")]
    const result = sessionTurnPresentation({
      messages,
      rootMessageID: "u1",
      memberMessageIDs: messages.map((message) => message.id),
    })

    // 没有 steer 时不额外拆分普通回合，原有单一 thinking 组的行为保持不变。
    expect(result.activitySegments).toHaveLength(1)
    expect(result.activitySegments[0]?.steering).toBeUndefined()
    expect(result.activitySegments[0]?.members.map((member) => member.message.id)).toEqual(["a1"])
  })

  test("recognizes a persisted steer when the timeline flag arrives late", () => {
    const messages: Message[] = [
      user("u1"),
      assistant("a1", "u1"),
      { ...user("u2"), steerTargetTurnID: "u1" },
      assistant("a2", "u2"),
    ]
    const result = sessionTurnPresentation({
      messages,
      rootMessageID: "u1",
      memberMessageIDs: messages.map((message) => message.id),
    })

    // 即使 TimelineTurn 的 steering ID 尚未同步，持久化目标也必须把 thinking 放到 steer 后面。
    expect(result.activitySegments.map((segment) => segment.steering?.id)).toEqual([undefined, "u2"])
    expect(result.currentAssistants.map((message) => message.id)).toEqual(["a2"])
  })

  // 空回复提示的收尾判据：只有模型真正以终止原因收尾（finish=stop 等）才算给出了（空）回复。
  test("only treats terminally-finished assistants as an empty response", () => {
    // 真正的空模型回复：模型以 stop 收尾但没有可显示内容——应提示「空回复」。
    expect(assistantEndedWithResponse({ finish: "stop" })).toBe(true)
    expect(assistantEndedWithResponse({ finish: "length" })).toBe(true)

    // 被截断的半成品：用户暂停/停止或被动中断（崩溃重启）常只留下「无 finish」的 assistant，
    // 不能当成空回复提示，否则用户自己暂停目标后会看到「请重试或切换模型」的误导文案。
    expect(assistantEndedWithResponse({ finish: undefined })).toBe(false)
    expect(assistantEndedWithResponse(undefined)).toBe(false)

    // 工具步骤不是最终回复，同样排除。
    expect(assistantEndedWithResponse({ finish: "tool-calls" })).toBe(false)
    expect(assistantEndedWithResponse({ finish: "unknown" })).toBe(false)
  })

  // 「是否已走到终点」直接决定 pending/active/working，进而决定重试期间显示「正在重试」还是误报空回复。
  test("keeps an assistant non-terminal while an empty response is being retried", () => {
    const at = (input: Partial<AssistantMessage>) =>
      assistantTurnTerminal({ error: undefined, finish: undefined, time: { created: 1 }, ...input } as AssistantMessage)

    // 空回复重试期间：后端清掉了上一轮 attempt 的 finish，也还没写 completed —— 必须算「仍在进行」，
    // 否则 working() 变假，界面既不显示「正在重试」，还会弹出「请求已结束，但没有收到可显示的回复」。
    expect(at({ finish: undefined, time: { created: 1 } })).toBe(false)

    // 真正收尾 / 出错 / 崩溃后补 completed：都算终点。
    expect(at({ finish: "stop" })).toBe(true)
    expect(at({ error: { name: "APIError", data: { message: "boom" } } as AssistantMessage["error"] })).toBe(true)
    expect(at({ finish: undefined, time: { created: 1, completed: 2 } })).toBe(true)

    // 工具步骤只是中间态。
    expect(at({ finish: "tool-calls" })).toBe(false)
    expect(at({ finish: "unknown" })).toBe(false)
  })

  test("isolates errors and interruptions to the response segment after the latest steer", () => {
    const messages: Message[] = [
      user("u1"),
      { ...assistant("a1", "u1"), error: { name: "MessageAbortedError", data: { message: "stopped" } } },
      user("u2"),
      assistant("a2", "u2"),
    ]
    const result = sessionTurnPresentation({
      messages,
      rootMessageID: "u1",
      memberMessageIDs: messages.map((message) => message.id),
      steeringUserMessageIDs: ["u2"],
    })

    // steer 前的失败只保留在历史活动中；新响应段的终态只能由 steer 后的 assistant 决定。
    expect(result.assistants.map((message) => message.id)).toEqual(["a1", "a2"])
    expect(result.currentAssistants.map((message) => message.id)).toEqual(["a2"])
    expect(result.finalAssistant?.id).toBe("a2")
  })
})
