import { describe, expect, test } from "bun:test"
import type { UserMessage } from "@opencode-ai/sdk/v2"
import type { AssistantMessage, Part } from "@opencode-ai/sdk/v2/client"
import {
  clipTimelineTurns,
  dedupeUserTurns,
  dedupeUserTurnsWithAliases,
  displayUserPartsByMessage,
  orderTimelineMessages,
  sameUserTurnView,
  timelineTurnAnchorMessageID,
  timelineTurnUserMessages,
} from "./user-turns"

const user = (id: string, created: number) =>
  ({
    id,
    sessionID: "session-1",
    role: "user",
    time: { created },
    agent: "build",
    model: { providerID: "wanlaicode", modelID: "gpt-image-2" },
  }) as UserMessage

const userWithModel = (id: string, created: number, modelID: string) =>
  ({
    ...user(id, created),
    model: { providerID: "wanlaicode", modelID },
  }) as UserMessage

const text = (messageID: string, value: string) =>
  ({
    id: `text-${messageID}`,
    sessionID: "session-1",
    messageID,
    type: "text",
    text: value,
  }) as Part

const image = (messageID: string, value: string) =>
  ({
    id: `image-${messageID}`,
    sessionID: "session-1",
    messageID,
    type: "file",
    mime: "image/png",
    filename: "image.png",
    url: value,
  }) as Part

const assistantText = (messageID: string, value: string, start: number) =>
  ({
    id: `assistant-text-${messageID}`,
    sessionID: "session-1",
    messageID,
    type: "text",
    text: value,
    time: { start },
  }) as Part

const imageGenerationTool = (messageID: string, url: string) =>
  ({
    id: `tool-${messageID}`,
    sessionID: "session-1",
    messageID,
    type: "tool",
    callID: `call-${messageID}`,
    tool: "image_generation",
    state: {
      status: "completed",
      input: {},
      output: "Generated 1 image.",
      title: "Generated 1 image",
      metadata: {},
      time: { start: 1, end: 2 },
      attachments: [
        {
          id: `tool-image-${messageID}`,
          sessionID: "session-1",
          messageID,
          type: "file",
          mime: "image/png",
          filename: "generated.png",
          url,
        },
      ],
    },
  }) as Part

const compaction = (messageID: string, auto = true) =>
  ({
    id: `compaction-${messageID}`,
    sessionID: "session-1",
    messageID,
    type: "compaction",
    auto,
  }) as Part

const syntheticContinue = (messageID: string) =>
  ({
    id: `continue-${messageID}`,
    sessionID: "session-1",
    messageID,
    type: "text",
    synthetic: true,
    metadata: { compaction_continue: true },
    text: "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.",
  }) as Part

const manualSteerMarker = (messageID: string, targetTurnID = "turn-1") =>
  ({
    id: `steer-${messageID}`,
    sessionID: "session-1",
    messageID,
    type: "text",
    text: "manual steer",
    synthetic: true,
    // 后端 steer 接口写入的 marker 必须在 assistant 开始后继续驱动 steer 成员归组。
    metadata: { manual_steer_context: true, manual_steer_target_turn_id: targetTurnID },
  }) as Part

const assistant = (id: string, parentID: string, time: { created?: number; completed?: number } = {}) =>
  ({
    id,
    sessionID: "session-1",
    role: "assistant",
    parentID,
    time: { created: time.created ?? 2_500, ...(time.completed === undefined ? {} : { completed: time.completed }) },
    modelID: "gpt-image-2",
    providerID: "wanlaicode",
    mode: "build",
    agent: "build",
    path: { cwd: "/repo", root: "/repo" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }) as AssistantMessage

const assistantInTurn = (
  id: string,
  parentID: string,
  turnID: string,
  time: { created?: number; completed?: number } = {},
) =>
  // 新协议直接持久化 assistant 的逻辑回合；交叉 parent 场景用它验证 turnID 的权威优先级。
  ({ ...assistant(id, parentID, time), turnID }) as AssistantMessage & { turnID: string }

describe("dedupeUserTurns", () => {
  test("orders legacy remote turns by creation time before display and dedupe", () => {
    const remote = user("msg_remote_z_old", 1_000)
    const latest = user("msg_a_latest", 2_000)
    const response = assistant("msg_remote_z_response", remote.id, { created: 1_100, completed: 1_500 })
    const messages = [latest, remote]
    const allMessages = [latest, remote, response]
    const parts = {
      [remote.id]: [text(remote.id, "生成一个头像")],
      [response.id]: [image(response.id, "https://cdn.example.com/generated.png")],
      [latest.id]: [image(latest.id, "https://cdn.example.com/generated.png"), text(latest.id, "把头像改成匿名")],
    }

    // 旧远控 ID 在字典序上位于新消息之后，但展示和回合顺序必须以创建时间为准。
    expect(displayUserPartsByMessage(messages, parts, allMessages)[latest.id]?.map((part) => part.type)).toEqual([
      "text",
    ])
    expect(dedupeUserTurns(messages, parts, allMessages).map((message) => message.id)).toEqual([
      remote.id,
      latest.id,
    ])
  })

  test("keeps steer detection chronological with inverse legacy remote IDs", () => {
    const remote = user("msg_remote_z_parent", 1_000)
    const latest = user("msg_a_latest", 2_000)
    const running = assistant("msg_remote_z_running", remote.id, { created: 1_100, completed: 3_000 })

    const result = dedupeUserTurnsWithAliases(
      [latest, remote],
      {
        [remote.id]: [text(remote.id, "先处理旧消息")],
        [latest.id]: [text(latest.id, "这是运行中追加的新消息")],
      },
      [latest, remote, running],
    )

    // 新消息虽然 ID 更小，仍应位于旧远控回合之后，并识别为运行窗口内的 steer。
    expect(result.messages.map((message) => message.id)).toEqual([remote.id, latest.id])
    expect(result.steeredByMessageID).toEqual({ [latest.id]: 1 })
  })

  test("hides automatically carried previous assistant images from visible user parts", () => {
    const messages = [
      user("msg_1", 1_000),
      assistant("msg_2", "msg_1", { created: 1_100, completed: 1_900 }),
      user("msg_3", 2_000),
    ]

    const result = displayUserPartsByMessage(
      [messages[0], messages[2]] as UserMessage[],
      {
        msg_1: [text("msg_1", "生成一个头像")],
        msg_2: [image("msg_2", "https://cdn.example.com/generated.png")],
        msg_3: [image("msg_3", "https://cdn.example.com/generated.png"), text("msg_3", "把头像改成匿名")],
      },
      messages,
    )

    expect(result.msg_3?.map((part) => part.type)).toEqual(["text"])
    expect(result.msg_3?.[0]).toMatchObject({ type: "text", text: "把头像改成匿名" })
  })

  test("hides automatically carried images from previous image_generation tool results", () => {
    const messages = [
      user("msg_1", 1_000),
      assistant("msg_2", "msg_1", { created: 1_100, completed: 1_900 }),
      user("msg_3", 2_000),
    ]

    const result = displayUserPartsByMessage(
      [messages[0], messages[2]] as UserMessage[],
      {
        msg_1: [text("msg_1", "生成一个头像")],
        msg_2: [imageGenerationTool("msg_2", "https://cdn.example.com/generated-from-tool.png")],
        msg_3: [image("msg_3", "https://cdn.example.com/generated-from-tool.png"), text("msg_3", "把头像改成匿名")],
      },
      messages,
    )

    expect(result.msg_3?.map((part) => part.type)).toEqual(["text"])
  })

  test("keeps user-uploaded images that are not previous assistant results", () => {
    const messages = [user("msg_1", 1_000), assistant("msg_2", "msg_1"), user("msg_3", 2_000)]

    const result = displayUserPartsByMessage(
      [messages[0], messages[2]] as UserMessage[],
      {
        msg_1: [text("msg_1", "生成一个头像")],
        msg_2: [image("msg_2", "https://cdn.example.com/generated.png")],
        msg_3: [image("msg_3", "data:image/png;base64,user-upload"), text("msg_3", "把这张图改成匿名")],
      },
      messages,
    )

    expect(result.msg_3?.map((part) => part.type)).toEqual(["file", "text"])
  })

  test("hides duplicate adjacent image user turns", () => {
    const messages = [user("msg_1", 1_000), user("msg_2", 2_000)]

    expect(
      dedupeUserTurns(messages, {
        msg_1: [image("msg_1", "data:image/png;base64,current"), text("msg_1", "把图中发言的人改成宣传大王")],
        msg_2: [image("msg_2", "data:image/png;base64,current"), text("msg_2", "把图中发言的人改成宣传大王")],
      }).map((item) => item.id),
    ).toEqual(["msg_1"])
  })

  test("keeps distinct adjacent user turns", () => {
    const messages = [user("msg_1", 1_000), user("msg_2", 2_000)]

    expect(
      dedupeUserTurns(messages, {
        msg_1: [image("msg_1", "data:image/png;base64,current"), text("msg_1", "把图中发言的人改成宣传大王")],
        msg_2: [image("msg_2", "data:image/png;base64,current"), text("msg_2", "头像改成匿名头像")],
      }).map((item) => item.id),
    ).toEqual(["msg_1", "msg_2"])
  })

  test("hides optimistic and server echoes with different image URLs and models", () => {
    const messages = [userWithModel("msg_1", 1_000, "gpt-5.5"), userWithModel("msg_2", 2_000, "gpt-image-2")]

    expect(
      dedupeUserTurns(messages, {
        msg_1: [image("msg_1", "data:image/png;base64,current"), text("msg_1", "把图中发言的人改成宣传大王")],
        msg_2: [image("msg_2", "https://cdn.example.com/uploaded.png"), text("msg_2", "把图中发言的人改成宣传大王")],
      }).map((item) => item.id),
    ).toEqual(["msg_1"])
  })

  test("hides same text echo when image URLs differ but image count matches", () => {
    const messages = [user("msg_1", 1_000), user("msg_2", 2_000)]

    expect(
      dedupeUserTurns(messages, {
        msg_1: [image("msg_1", "data:image/png;base64,client"), text("msg_1", "把图中发言的人改成宣传大王")],
        msg_2: [image("msg_2", "https://cdn.example.com/server.png"), text("msg_2", "把图中发言的人改成宣传大王")],
      }).map((item) => item.id),
    ).toEqual(["msg_1"])
  })

  test("aliases duplicate turns that own assistant progress back to the visible user turn", () => {
    const messages = [userWithModel("msg_1", 1_000, "gpt-5.5"), userWithModel("msg_2", 2_000, "gpt-image-2")]

    const result = dedupeUserTurnsWithAliases(
      messages,
      {
        msg_1: [text("msg_1", "把头像改成匿名")],
        msg_2: [image("msg_2", "https://cdn.example.com/uploaded.png"), text("msg_2", "把头像改成匿名")],
      },
      [...messages, assistant("msg_3", "msg_2")],
    )

    expect(result.messages.map((item) => item.id)).toEqual(["msg_1"])
    expect(result.parentAliases).toEqual({ msg_2: "msg_1" })
  })

  test("aliases delayed executed image turns back to the earlier empty user turn", () => {
    const messages = [userWithModel("msg_1", 1_000, "gpt-5.5"), userWithModel("msg_2", 61_000, "gpt-image-2")]

    const result = dedupeUserTurnsWithAliases(
      messages,
      {
        msg_1: [text("msg_1", "再来一版，鱼还是不够真实")],
        msg_2: [text("msg_2", "再来一版，鱼还是不够真实")],
      },
      [...messages, assistant("msg_3", "msg_2", { created: 62_000, completed: 70_000 })],
    )

    expect(result.messages.map((item) => item.id)).toEqual(["msg_1"])
    expect(result.parentAliases).toEqual({ msg_2: "msg_1" })
  })

  test("aliases automatic compaction continuation turns back to the previous visible user turn", () => {
    const messages = [user("msg_1", 1_000), user("msg_3", 2_100), user("msg_5", 3_000)]
    const allMessages = [
      messages[0],
      { ...assistant("msg_2", "msg_1", { created: 1_100, completed: 2_000 }), finish: "tool-calls" },
      messages[1],
      { ...assistant("msg_4", "msg_3", { created: 2_200, completed: 2_900 }), summary: true, mode: "compaction" },
      messages[2],
      assistant("msg_6", "msg_5", { created: 3_100, completed: 4_000 }),
    ]

    const result = dedupeUserTurnsWithAliases(
      messages,
      {
        msg_1: [text("msg_1", "生成三张不一样的科幻飞鱼图")],
        msg_3: [compaction("msg_3")],
        msg_5: [syntheticContinue("msg_5")],
      },
      allMessages,
    )

    expect(result.messages.map((item) => item.id)).toEqual(["msg_1"])
    expect(result.parentAliases).toEqual({ msg_3: "msg_1", msg_5: "msg_1" })
    expect(
      allMessages
        .filter((message) => message.role === "assistant")
        .map((message) => result.parentAliases[message.parentID] ?? message.parentID),
    ).toEqual(["msg_1", "msg_1", "msg_1"])
  })

  test("keeps manual /compact turns as their own visible turn instead of folding into the previous turn", () => {
    // 手动 /compact 是用户显式动作：必须独立成回合，带自己的完成分割线与计时；
    // 若被并回上一条真实用户消息，压缩的处理态会记到上一轮头上，计时从上一轮起点算，且完成分割线永不出现。
    const messages = [user("msg_1", 1_000), user("msg_3", 2_100)]
    const allMessages = [
      messages[0],
      assistant("msg_2", "msg_1", { created: 1_100, completed: 2_000 }),
      messages[1],
      { ...assistant("msg_4", "msg_3", { created: 2_200, completed: 2_900 }), summary: true, mode: "compaction" },
    ]

    const result = dedupeUserTurnsWithAliases(
      messages,
      {
        msg_1: [text("msg_1", "你好")],
        msg_3: [compaction("msg_3", false)],
      },
      allMessages,
    )

    expect(result.messages.map((item) => item.id)).toEqual(["msg_1", "msg_3"])
    expect(result.parentAliases).toEqual({})
  })

  test("keeps answered follow-up user messages visible without marking their own turn as steered", () => {
    const messages = [user("msg_1", 1_000), user("msg_3", 2_000)]

    const result = dedupeUserTurnsWithAliases(
      messages,
      {
        msg_1: [text("msg_1", "你是什么模型？")],
        msg_3: [text("msg_3", "ad")],
      },
      [
        messages[0],
        assistant("msg_2", "msg_1", { created: 1_100, completed: 4_000 }),
        messages[1],
        assistant("msg_4", "msg_3", { created: 4_100, completed: 5_000 }),
      ],
    )

    expect(result.messages.map((item) => item.id)).toEqual(["msg_1", "msg_3"])
    expect(result.parentAliases).toEqual({})
    expect(result.steeredByMessageID).toEqual({})
  })

  test("keeps an explicit steer marked after its assistant starts", () => {
    const messages = [user("msg_1", 1_000), user("msg_3", 2_000)]

    const result = dedupeUserTurnsWithAliases(
      messages,
      {
        msg_1: [text("msg_1", "先完成原任务")],
        msg_3: [text("msg_3", "改成简短回复"), manualSteerMarker("msg_3")],
      },
      [
        messages[0],
        assistant("msg_2", "msg_1", { created: 1_100, completed: 3_000 }),
        messages[1],
        assistant("msg_4", "msg_3", { created: 3_100, completed: 4_000 }),
      ],
    )

    expect(result.messages.map((item) => item.id)).toEqual(["msg_1", "msg_3"])
    expect(result.parentAliases).toEqual({})
    expect(result.steeredByMessageID).toEqual({ msg_3: 1 })
  })

  test("keeps an optimistic steer in the active turn without relying on event timing", () => {
    const base = user("msg_1", 1_000)
    const steer = { ...user("msg_3", 2_000), steerTargetTurnID: "turn-active" }
    const result = dedupeUserTurnsWithAliases(
      [base, steer],
      {
        msg_1: [text("msg_1", "先完成原任务")],
        msg_3: [text("msg_3", "补充排行榜")],
      },
      // 即使原 assistant 的完成事件先到，optimistic target 快照仍是当前 turn 归组的权威依据。
      [base, assistant("msg_2", "msg_1", { created: 1_100, completed: 1_900 }), steer],
    )

    expect(result.messages.map((item) => item.id)).toEqual(["msg_1", "msg_3"])
    expect(result.parentAliases).toEqual({})
    expect(result.steeredByMessageID).toEqual({ msg_3: 1 })
  })

  test("keeps same-text steer and normal turns when both own assistant replies", () => {
    const messages = [user("msg_3", 2_000), user("msg_5", 3_000)]

    const result = dedupeUserTurnsWithAliases(
      messages,
      {
        msg_3: [text("msg_3", "继续优化"), manualSteerMarker("msg_3")],
        msg_5: [text("msg_5", "继续优化")],
      },
      [
        messages[0],
        assistant("msg_4", "msg_3", { created: 2_100, completed: 2_500 }),
        messages[1],
        assistant("msg_6", "msg_5", { created: 3_100, completed: 3_500 }),
      ],
    )

    // 两条消息各自拥有回复，说明它们是两个真实回合；同文案不能再触发展示层归并。
    expect(result.messages.map((item) => item.id)).toEqual(["msg_3", "msg_5"])
    expect(result.parentAliases).toEqual({})
    expect(result.steeredByMessageID).toEqual({ msg_3: 1 })
  })

  test("keeps same-text consecutive steers in one active turn", () => {
    const messages = [user("msg_1", 1_000), user("msg_3", 2_000), user("msg_5", 3_000)]

    const result = dedupeUserTurnsWithAliases(
      messages,
      {
        msg_1: [text("msg_1", "先完成原任务")],
        msg_3: [text("msg_3", "继续优化"), manualSteerMarker("msg_3", "msg_1")],
        msg_5: [text("msg_5", "继续优化"), manualSteerMarker("msg_5", "msg_1")],
      },
      [messages[0], assistant("msg_2", "msg_1", { created: 1_100 }), messages[1], messages[2]],
    )

    // 同文案的连续引导也必须各自显示，避免第二条用户问题变成有问无答。
    expect(result.messages.map((item) => item.id)).toEqual(["msg_1", "msg_3", "msg_5"])
    expect(result.parentAliases).toEqual({})
    expect(result.steeredByMessageID).toEqual({ msg_3: 1, msg_5: 1 })
  })

  test("keeps same-text steers when the later steer owns the assistant reply", () => {
    const messages = [user("msg_1", 1_000), user("msg_3", 2_000), user("msg_5", 3_000)]

    const result = dedupeUserTurnsWithAliases(
      messages,
      {
        msg_1: [text("msg_1", "先完成原任务")],
        msg_3: [text("msg_3", "继续优化"), manualSteerMarker("msg_3", "msg_1")],
        msg_5: [text("msg_5", "继续优化"), manualSteerMarker("msg_5", "msg_1")],
      },
      [
        messages[0],
        assistant("msg_2", "msg_1", { created: 1_100 }),
        messages[1],
        messages[2],
        assistant("msg_6", "msg_5", { created: 3_100 }),
      ],
    )

    // 后一条 steer 已经产生回复时，前一条同文案 steer 仍必须保留为独立可追踪输入。
    expect(result.messages.map((item) => item.id)).toEqual(["msg_1", "msg_3", "msg_5"])
    expect(result.parentAliases).toEqual({})
    expect(result.steeredByMessageID).toEqual({ msg_3: 1, msg_5: 1 })
  })

  test("hides steered duplicate when the same prompt later owns image generation", () => {
    const messages = [userWithModel("msg_3", 2_000, "gpt-5.5"), userWithModel("msg_5", 3_000, "gpt-image-2")]

    const result = dedupeUserTurnsWithAliases(
      messages,
      {
        msg_1: [text("msg_1", "先帮我总结这段内容")],
        msg_3: [text("msg_3", "生成10张鱼会飞的图片")],
        msg_5: [text("msg_5", "生成10张鱼会飞的图片")],
      },
      [
        user("msg_1", 1_000),
        assistant("msg_2", "msg_1", { created: 1_100, completed: 4_000 }),
        messages[0],
        messages[1],
        assistant("msg_6", "msg_5", { created: 4_100 }),
      ],
    )

    expect(result.messages.map((item) => item.id)).toEqual(["msg_5"])
    expect(result.parentAliases).toEqual({ msg_3: "msg_5" })
    expect(result.steeredByMessageID).toEqual({})
    expect(result.turns.flatMap((turn) => turn.members.map((member) => member.messageID))).not.toContain("msg_3")
  })

  test("marks follow-up user messages as steered only before their own assistant starts", () => {
    const messages = [user("msg_1", 1_000), user("msg_3", 2_000)]

    const result = dedupeUserTurnsWithAliases(
      messages,
      {
        msg_1: [text("msg_1", "你是什么模型？")],
        msg_3: [text("msg_3", "ad")],
      },
      [messages[0], assistant("msg_2", "msg_1", { created: 1_100, completed: 4_000 }), messages[1]],
    )

    expect(result.messages.map((item) => item.id)).toEqual(["msg_1", "msg_3"])
    expect(result.parentAliases).toEqual({})
    expect(result.steeredByMessageID).toEqual({ msg_3: 1 })
  })

  test("tracks all consecutive steered messages for running-state checks", () => {
    const messages = [user("msg_1", 1_000), user("msg_3", 2_000), user("msg_4", 3_000), user("msg_5", 4_000)]

    const result = dedupeUserTurnsWithAliases(
      messages,
      {
        msg_1: [text("msg_1", "生成一张图")],
        msg_3: [text("msg_3", "测试1")],
        msg_4: [text("msg_4", "测试2")],
        msg_5: [text("msg_5", "测试3")],
      },
      [
        messages[0],
        assistant("msg_2", "msg_1", { created: 1_100, completed: 5_000 }),
        messages[1],
        messages[2],
        messages[3],
      ],
    )

    expect(result.messages.map((item) => item.id)).toEqual(["msg_1", "msg_3", "msg_4", "msg_5"])
    expect(result.parentAliases).toEqual({})
    expect(result.steeredByMessageID).toEqual({ msg_3: 1, msg_4: 1, msg_5: 1 })
  })

  test("keeps adjacent user messages as separate turns when no response was running", () => {
    const messages = [user("msg_1", 1_000), user("msg_3", 4_500)]

    const result = dedupeUserTurnsWithAliases(
      messages,
      {
        msg_1: [text("msg_1", "你是什么模型？")],
        msg_3: [text("msg_3", "ad")],
      },
      [messages[0], assistant("msg_2", "msg_1", { created: 1_100, completed: 4_000 }), messages[1]],
    )

    expect(result.messages.map((item) => item.id)).toEqual(["msg_1", "msg_3"])
    expect(result.parentAliases).toEqual({})
    expect(result.steeredByMessageID).toEqual({})
  })

  test("does not mark users after a completed tool-call assistant as steered", () => {
    const messages = [user("msg_1", 1_000), user("msg_3", 2_000)]

    const result = dedupeUserTurnsWithAliases(
      messages,
      {
        msg_1: [text("msg_1", "生成一张图")],
        msg_3: [text("msg_3", "生成三张不一样的给我")],
      },
      [messages[0], assistant("msg_2", "msg_1", { created: 1_100, completed: 1_900 }), messages[1]].map((message) =>
        message.id === "msg_2" && message.role === "assistant" ? { ...message, finish: "tool-calls" } : message,
      ),
    )

    expect(result.messages.map((item) => item.id)).toEqual(["msg_1", "msg_3"])
    expect(result.parentAliases).toEqual({})
    expect(result.steeredByMessageID).toEqual({})
  })

  test("marks users after a completed tool-call step when the session is still busy", () => {
    const messages = [user("msg_1", 1_000), user("msg_3", 2_000)]

    const result = dedupeUserTurnsWithAliases(
      messages,
      {
        msg_1: [text("msg_1", "生成一张图")],
        msg_3: [text("msg_3", "继续调整")],
      },
      [
        messages[0],
        { ...assistant("msg_2", "msg_1", { created: 1_100, completed: 1_900 }), finish: "tool-calls" },
        messages[1],
      ],
      { statusBusy: true, now: 2_000 },
    )

    expect(result.steeredByMessageID).toEqual({ msg_3: 1 })
  })

  test("marks users after fresh streaming assistant text as steered", () => {
    const messages = [user("msg_1", 1_000), user("msg_3", 2_000)]
    const allMessages = [messages[0], assistant("msg_2", "msg_1", { created: 1_100 }), messages[1]]

    const result = dedupeUserTurnsWithAliases(
      messages,
      {
        msg_1: [text("msg_1", "你以后都用中文回答")],
        msg_2: [assistantText("msg_2", "明白。后续我会始终使用简体中文回复。", 1_200)],
        msg_3: [text("msg_3", "现在再给我生成几道选择题")],
      },
      allMessages,
      { statusBusy: true, now: 2_000 },
    )

    expect(result.messages.map((item) => item.id)).toEqual(["msg_1", "msg_3"])
    expect(result.parentAliases).toEqual({})
    expect(result.steeredByMessageID).toEqual({ msg_3: 1 })
  })

  test("does not mark users after stale visible assistant text with a missing end timestamp as steered", () => {
    const messages = [user("msg_1", 1_000), user("msg_3", 60_000)]
    const allMessages = [messages[0], assistant("msg_2", "msg_1", { created: 1_100 }), messages[1]]

    const result = dedupeUserTurnsWithAliases(
      messages,
      {
        msg_1: [text("msg_1", "你以后都用中文回答")],
        msg_2: [assistantText("msg_2", "明白。后续我会始终使用简体中文回复。", 1_200)],
        msg_3: [text("msg_3", "现在再给我生成几道选择题")],
      },
      allMessages,
      { statusBusy: true, now: 60_000 },
    )

    expect(result.messages.map((item) => item.id)).toEqual(["msg_1", "msg_3"])
    expect(result.parentAliases).toEqual({})
    expect(result.steeredByMessageID).toEqual({})
  })

  test("keeps multiple answered follow-ups visible without marking them as steered", () => {
    const messages = [user("msg_1", 1_000), user("msg_3", 2_000), user("msg_4", 3_000)]

    const result = dedupeUserTurnsWithAliases(
      messages,
      {
        msg_1: [text("msg_1", "你是什么模型？")],
        msg_3: [text("msg_3", "12")],
        msg_4: [text("msg_4", "ef")],
      },
      [
        messages[0],
        assistant("msg_2", "msg_1", { created: 1_100, completed: 4_000 }),
        messages[1],
        messages[2],
        assistant("msg_5", "msg_3", { created: 4_100, completed: 5_000 }),
        assistant("msg_6", "msg_4", { created: 5_100, completed: 6_000 }),
      ],
    )

    expect(result.messages.map((item) => item.id)).toEqual(["msg_1", "msg_3", "msg_4"])
    expect(result.parentAliases).toEqual({})
    expect(result.steeredByMessageID).toEqual({})
  })

  test("does not mark users after stale unfinished assistants as steered", () => {
    const start = Date.now()
    const messages = [user("msg_1", start), user("msg_3", start + 31 * 60_000)]

    const result = dedupeUserTurnsWithAliases(
      messages,
      {
        msg_1: [text("msg_1", "你是什么模型？")],
        msg_3: [text("msg_3", "新问题")],
      },
      [messages[0], assistant("msg_2", "msg_1", { created: start + 1_000 }), messages[1]],
      { statusBusy: true, now: start + 31 * 60_000 },
    )

    expect(result.messages.map((item) => item.id)).toEqual(["msg_1", "msg_3"])
    expect(result.parentAliases).toEqual({})
    expect(result.steeredByMessageID).toEqual({})
  })
})

describe("logical timeline turns", () => {
  test("orders timeline messages by creation time when store arrival order is mixed", () => {
    const answered = user("answered-z", 1_000)
    const answeredReply = assistant("answered-reply-y", answered.id, { created: 1_500, completed: 1_900 })
    const running = user("running-a", 3_000)
    const runningReply = assistant("running-reply-b", running.id, { created: 3_100 })

    // 历史分页和实时消息合并后可能先出现正在回答的新回合；展示仍必须按创建时间恢复真实时序。
    expect(orderTimelineMessages([running, runningReply, answeredReply, answered]).map((message) => message.id)).toEqual([
      answered.id,
      answeredReply.id,
      running.id,
      runningReply.id,
    ])
  })

  test("returns one navigation anchor for each logical turn", () => {
    const root = user("msg_1", 1_000)
    const steer = user("msg_3", 2_000)
    const followup = user("msg_5", 3_000)
    const turns = [
      {
        id: root.id,
        rootMessageID: root.id,
        orphan: false,
        members: [
          { type: "user" as const, messageID: root.id },
          { type: "assistant" as const, messageID: "msg_2" },
          { type: "user" as const, messageID: steer.id, steering: true },
        ],
        userMessageIDs: [root.id, steer.id],
        assistantMessageIDs: ["msg_2"],
      },
      {
        id: followup.id,
        rootMessageID: followup.id,
        orphan: false,
        members: [{ type: "user" as const, messageID: followup.id }],
        userMessageIDs: [followup.id],
        assistantMessageIDs: [],
      },
    ]

    // steer 只属于根 turn 的内部成员；普通 follow-up 仍以自己的根消息形成第二个导航条目。
    expect(timelineTurnUserMessages(turns, [root, steer, followup]).map((message) => message.id)).toEqual([
      root.id,
      followup.id,
    ])
  })

  test("uses the first loaded user when paginated history is missing the root", () => {
    const steer = user("msg_3", 2_000)
    const turns = [
      {
        id: "msg_missing_root",
        rootMessageID: "msg_missing_root",
        orphan: false,
        members: [{ type: "user" as const, messageID: steer.id, steering: true }],
        userMessageIDs: ["msg_missing_root", steer.id],
        assistantMessageIDs: [],
      },
    ]

    // 游标元数据可能已知根 ID、但根消息正文尚未回填；导航仍需暂用已加载 steer，回填后再自然切回 root。
    expect(timelineTurnAnchorMessageID(turns[0]!, new Set([steer.id]))).toBe(steer.id)
    expect(timelineTurnUserMessages(turns, [steer])).toEqual([steer])
  })

  test("keeps answered turns above newer running turns when all messages arrive out of order", () => {
    const answered = user("answered-z", 1_000)
    const answeredReply = assistant("answered-reply-y", answered.id, { created: 1_500, completed: 1_900 })
    const running = user("running-a", 3_000)
    const runningReply = assistant("running-reply-b", running.id, { created: 3_100 })

    const result = dedupeUserTurnsWithAliases(
      [running, answered],
      {
        [answered.id]: [text(answered.id, "已经回答过的问题")],
        [running.id]: [text(running.id, "正在回答的问题")],
      },
      [running, runningReply, answeredReply, answered],
      { statusBusy: true, now: 3_200 },
    )

    expect(result.turns.map((turn) => turn.rootMessageID)).toEqual([answered.id, running.id])
    expect(result.turns.map((turn) => turn.assistantMessageIDs)).toEqual([[answeredReply.id], [runningReply.id]])
  })

  test("clips a logical turn when revert points at a steering member", () => {
    const turns = [
      {
        id: "msg_1",
        rootMessageID: "msg_1",
        orphan: false,
        members: [
          { type: "user" as const, messageID: "msg_1" },
          { type: "assistant" as const, messageID: "msg_2" },
          { type: "user" as const, messageID: "msg_3", steering: true },
          { type: "assistant" as const, messageID: "msg_4" },
        ],
        userMessageIDs: ["msg_1", "msg_3"],
        assistantMessageIDs: ["msg_2", "msg_4"],
      },
    ]

    // 回退到 steer 的水位时保留其前序活动，但 steer 本身和后续回复都必须从成员列表消失。
    expect(clipTimelineTurns(turns, "msg_3")).toEqual([
      {
        id: "msg_1",
        rootMessageID: "msg_1",
        orphan: false,
        members: [
          { type: "user", messageID: "msg_1" },
          { type: "assistant", messageID: "msg_2" },
        ],
        userMessageIDs: ["msg_1"],
        assistantMessageIDs: ["msg_2"],
      },
    ])
  })

  test("clips by source order when custom message ids are not lexically sortable", () => {
    const turns = [
      {
        id: "turn-a",
        rootMessageID: "root-z",
        orphan: false,
        members: [
          { type: "user" as const, messageID: "root-z" },
          { type: "assistant" as const, messageID: "assistant-y" },
          { type: "user" as const, messageID: "steer-a", steering: true },
          { type: "assistant" as const, messageID: "assistant-b" },
        ],
        userMessageIDs: ["root-z", "steer-a"],
        assistantMessageIDs: ["assistant-y", "assistant-b"],
      },
    ]

    // 远程或调用方自定义 ID 可能逆序；回退水位只能使用服务端数组中的真实位置。
    expect(
      clipTimelineTurns(turns, "steer-a", ["root-z", "assistant-y", "steer-a", "assistant-b"])[0]?.members,
    ).toEqual([
      { type: "user", messageID: "root-z" },
      { type: "assistant", messageID: "assistant-y" },
    ])
  })

  test("keeps root, assistant, steer, and its reply inside one ordered turn", () => {
    const root = user("msg_1", 1_000)
    const steer = { ...user("msg_3", 2_000), steerTargetTurnID: root.id }
    const allMessages = [
      root,
      assistant("msg_2", root.id, { created: 1_100, completed: 1_900 }),
      steer,
      assistant("msg_4", steer.id, { created: 2_100, completed: 3_000 }),
    ]

    const result = dedupeUserTurnsWithAliases(
      [root, steer],
      {
        msg_1: [text("msg_1", "先整理项目")],
        msg_3: [text("msg_3", "再补充风险")],
      },
      allMessages,
    )

    // 对齐 ChatGPT 的 turn.items：成功引导是原 turn 的普通成员，不会产生第二个顶层 turn。
    expect(result.turns).toEqual([
      {
        id: "msg_1",
        rootMessageID: "msg_1",
        orphan: false,
        members: [
          { type: "user", messageID: "msg_1" },
          { type: "assistant", messageID: "msg_2" },
          { type: "user", messageID: "msg_3", steering: true },
          { type: "assistant", messageID: "msg_4" },
        ],
        userMessageIDs: ["msg_1", "msg_3"],
        assistantMessageIDs: ["msg_2", "msg_4"],
      },
    ])
    expect(result.turnIDByMessageID).toEqual({ msg_1: "msg_1", msg_2: "msg_1", msg_3: "msg_1", msg_4: "msg_1" })
  })

  test("prefers an assistant durable turnID over its parentID", () => {
    const root = user("msg_1", 1_000)
    const reply = assistantInTurn("msg_2", "msg_missing_parent", root.id, {
      created: 1_100,
      completed: 2_000,
    })

    const result = dedupeUserTurnsWithAliases([root], { msg_1: [text("msg_1", "执行任务")] }, [root, reply])

    // parentID 只描述直接触发者；新协议的 turnID 才是跨 steer/continuation 的稳定容器身份。
    expect(result.turnIDByMessageID).toEqual({ msg_1: "msg_1", msg_2: "msg_1" })
    expect(result.turns[0]?.assistantMessageIDs).toEqual(["msg_2"])
  })

  test("keeps an optimistic steer in its target after the previous assistant completes", () => {
    const root = user("msg_1", 1_000)
    const steer = { ...user("msg_3", 2_000), steerTargetTurnID: root.id }

    const result = dedupeUserTurnsWithAliases(
      [root, steer],
      {
        msg_1: [text("msg_1", "先给出结论")],
        msg_3: [text("msg_3", "补充数据来源")],
      },
      [root, assistant("msg_2", root.id, { created: 1_100, completed: 1_900 }), steer],
    )

    // steerTargetTurnID 是发网前快照，不能因 completed/status 事件先到而瞬间退化成新回合。
    expect(result.turns).toHaveLength(1)
    expect(result.turns[0]?.userMessageIDs).toEqual(["msg_1", "msg_3"])
    expect(result.turns[0]?.members.at(-1)).toEqual({ type: "user", messageID: "msg_3", steering: true })
  })

  test("restores a durable steer marker into its target while idle", () => {
    const root = user("msg_1", 1_000)
    const steer = user("msg_3", 2_000)
    const allMessages = [
      root,
      assistant("msg_2", root.id, { created: 1_100, completed: 1_900 }),
      steer,
      assistant("msg_4", steer.id, { created: 2_100, completed: 3_000 }),
    ]

    const result = dedupeUserTurnsWithAliases(
      [root, steer],
      {
        msg_1: [text("msg_1", "先完成原任务")],
        msg_3: [text("msg_3", "把回复缩短"), manualSteerMarker("msg_3", root.id)],
      },
      allMessages,
      { statusBusy: false, now: 4_000 },
    )

    // 刷新后不再依赖瞬时 busy 窗口，marker 中的目标仍能还原同一个逻辑 turn。
    expect(result.turns).toHaveLength(1)
    expect(result.turns[0]?.members.map((member) => member.messageID)).toEqual(["msg_1", "msg_2", "msg_3", "msg_4"])
    expect(result.turnIDByMessageID.msg_3).toBe("msg_1")
  })

  test("keeps a normal queued user request as a separate turn", () => {
    const first = user("msg_1", 1_000)
    const queued = user("msg_3", 3_000)
    const allMessages = [
      first,
      assistant("msg_2", first.id, { created: 1_100, completed: 2_000 }),
      queued,
      assistant("msg_4", queued.id, { created: 3_100, completed: 4_000 }),
    ]

    const result = dedupeUserTurnsWithAliases(
      [first, queued],
      {
        msg_1: [text("msg_1", "第一个任务")],
        msg_3: [text("msg_3", "排队的第二个任务")],
      },
      allMessages,
    )

    // 普通 queue 没有目标回合身份，完成上一轮后必须以自己的 user ID 开启下一 turn。
    expect(result.turns.map((turn) => turn.id)).toEqual(["msg_1", "msg_3"])
    expect(result.turns.map((turn) => turn.members.map((member) => member.messageID))).toEqual([
      ["msg_1", "msg_2"],
      ["msg_3", "msg_4"],
    ])
  })

  test("keeps compaction continuation members in the original turn", () => {
    const root = user("msg_1", 1_000)
    const continuation = { ...user("msg_3", 2_000), continuationTurnID: root.id }
    const allMessages = [
      root,
      assistant("msg_2", root.id, { created: 1_100, completed: 1_900 }),
      continuation,
      assistantInTurn("msg_4", continuation.id, root.id, { created: 2_100, completed: 3_000 }),
    ]

    const result = dedupeUserTurnsWithAliases(
      [root, continuation],
      {
        msg_1: [text("msg_1", "长任务")],
        msg_3: [compaction("msg_3")],
      },
      allMessages,
    )

    // 内部 continuation 仍保留在成员序列供状态计算使用，但旧 messages 视图继续只展示真实根用户。
    expect(result.messages.map((message) => message.id)).toEqual(["msg_1"])
    expect(result.parentAliases).toEqual({ msg_3: "msg_1" })
    expect(result.turns[0]?.members.map((member) => member.messageID)).toEqual(["msg_1", "msg_2", "msg_3", "msg_4"])
    expect(result.turnIDByMessageID.msg_4).toBe("msg_1")
  })

  test("preserves source order across consecutive steers", () => {
    const root = user("msg_1", 1_000)
    const firstSteer = { ...user("msg_3", 2_000), steerTargetTurnID: root.id }
    const secondSteer = { ...user("msg_5", 3_000), steerTargetTurnID: root.id }
    const allMessages = [
      root,
      assistant("msg_2", root.id, { created: 1_100, completed: 1_900 }),
      firstSteer,
      assistant("msg_4", firstSteer.id, { created: 2_100, completed: 2_900 }),
      secondSteer,
      assistant("msg_6", secondSteer.id, { created: 3_100, completed: 4_000 }),
    ]

    const result = dedupeUserTurnsWithAliases(
      [root, firstSteer, secondSteer],
      {
        msg_1: [text("msg_1", "开始")],
        msg_3: [text("msg_3", "第一次引导")],
        msg_5: [text("msg_5", "第二次引导")],
      },
      allMessages,
    )

    // 连续 steer 逐条留在原 turn 中，不能合并、搬到末尾或按 user/assistant 类型重新排序。
    expect(result.turns).toHaveLength(1)
    expect(result.turns[0]?.members).toEqual([
      { type: "user", messageID: "msg_1" },
      { type: "assistant", messageID: "msg_2" },
      { type: "user", messageID: "msg_3", steering: true },
      { type: "assistant", messageID: "msg_4" },
      { type: "user", messageID: "msg_5", steering: true },
      { type: "assistant", messageID: "msg_6" },
    ])
  })

  test("creates an orphan turn when the target root is outside the loaded page", () => {
    const steer = { ...user("msg_3", 2_000), steerTargetTurnID: "msg_missing_root" }
    const reply = assistantInTurn("msg_4", steer.id, "msg_missing_root", { created: 2_100, completed: 3_000 })

    const result = dedupeUserTurnsWithAliases([steer], { msg_3: [text("msg_3", "分页里仍可见的引导")] }, [steer, reply])

    // 分页没有加载根消息时也不能丢掉已加载成员；用目标 turnID 建立 orphan，回填历史后即可自然补根。
    expect(result.turns).toEqual([
      {
        id: "msg_missing_root",
        rootMessageID: undefined,
        orphan: true,
        members: [
          { type: "user", messageID: "msg_3", steering: true },
          { type: "assistant", messageID: "msg_4" },
        ],
        userMessageIDs: ["msg_3"],
        assistantMessageIDs: ["msg_4"],
      },
    ])

    const root = {
      ...user("msg_missing_root", 1_000),
      turnID: "msg_missing_root",
    } as UserMessage & { turnID: string }
    const hydrated = dedupeUserTurnsWithAliases(
      [root, steer],
      {
        msg_missing_root: [text("msg_missing_root", "分页后补回的根消息")],
        msg_3: [text("msg_3", "分页里仍可见的引导")],
      },
      [root, steer, reply],
    )

    // 根消息回填只补全同一个物理 turn；稳定 id 让顶层行继续复用，不会因锚点变化而重建。
    expect(hydrated.turns[0]?.id).toBe(result.turns[0]?.id)
    expect(hydrated.turns[0]?.rootMessageID).toBe(root.id)
    expect(hydrated.turns[0]?.orphan).toBe(false)
  })

  test("uses the assistant activity window only for legacy users without turn fields", () => {
    const root = user("msg_1", 1_000)
    const legacySteer = user("msg_3", 2_000)

    const result = dedupeUserTurnsWithAliases(
      [root, legacySteer],
      {
        msg_1: [text("msg_1", "旧历史任务")],
        msg_3: [text("msg_3", "旧版运行中追加")],
      },
      [root, assistant("msg_2", root.id, { created: 1_100, completed: 4_000 }), legacySteer],
    )

    // 只有缺少 turnID/steer marker 的旧记录才使用创建时间窗口；这条兼容路径不会覆盖新协议字段。
    expect(result.steeredByMessageID).toEqual({ msg_3: 1 })
    expect(result.turns).toHaveLength(1)
    expect(result.turnIDByMessageID.msg_3).toBe("msg_1")
  })

  test("resolves duplicate parent aliases before grouping assistant replies", () => {
    const optimistic = user("msg_1", 1_000)
    const durable = user("msg_2", 2_000)

    const result = dedupeUserTurnsWithAliases(
      [optimistic, durable],
      {
        msg_1: [text("msg_1", "生成一张图")],
        msg_2: [text("msg_2", "生成一张图")],
      },
      [optimistic, durable, assistant("msg_3", durable.id, { created: 2_100, completed: 3_000 })],
    )

    // assistant 的 parent 指向被去重 user 时，先解析 alias 再归组，避免留下一个只有回复的伪 turn。
    expect(result.parentAliases).toEqual({ msg_2: "msg_1" })
    expect(result.turns).toHaveLength(1)
    expect(result.turns[0]?.rootMessageID).toBe("msg_1")
    expect(result.turns[0]?.members.map((member) => member.messageID)).toEqual(["msg_1", "msg_2", "msg_3"])
  })

  test("lets a durable new turnID override a stale optimistic steer target", () => {
    const root = { ...user("msg_1", 1_000), turnID: "msg_1" } as UserMessage & { turnID: string }
    const fallback = {
      ...user("msg_3", 3_000),
      turnID: "msg_3",
      steerTargetTurnID: root.id,
    } as UserMessage & { turnID: string }

    const result = dedupeUserTurnsWithAliases(
      [root, fallback],
      {
        msg_1: [text("msg_1", "继续处理")],
        msg_3: [text("msg_3", "继续处理")],
      },
      [root, assistant("msg_2", root.id, { created: 1_100, completed: 2_000 }), fallback],
    )

    // inactive fallback 可复用同一 messageID；服务端 durable 身份冲突时必须脱离旧 turn，并恢复成普通根用户。
    expect(result.messages.map((message) => message.id)).toEqual(["msg_1", "msg_3"])
    expect(
      result.turns.map((turn) => ({ id: turn.id, rootMessageID: turn.rootMessageID, orphan: turn.orphan })),
    ).toEqual([
      { id: "msg_1", rootMessageID: "msg_1", orphan: false },
      { id: "msg_3", rootMessageID: "msg_3", orphan: false },
    ])
    expect(result.steeredByMessageID).toEqual({})
    expect(result.turnIDByMessageID.msg_3).toBe("msg_3")
  })

  test("keeps the timeline view stable across assistant-only streaming part updates", () => {
    const root = user("msg_1", 1_000)
    const reply = assistant("msg_2", root.id, { created: 1_100 })
    const first = dedupeUserTurnsWithAliases(
      [root],
      { msg_1: [text("msg_1", "执行长任务")], msg_2: [assistantText("msg_2", "第一段", 1_100)] },
      [root, reply],
      { statusBusy: true },
    )
    const streamed = dedupeUserTurnsWithAliases(
      [root],
      { msg_1: [text("msg_1", "执行长任务")], msg_2: [assistantText("msg_2", "第一段继续增长", 1_100)] },
      [root, reply],
      { statusBusy: true },
    )

    // token 只改变 assistant part 文本，不得让时间线消费者重建历史工具和推理组件。
    expect(sameUserTurnView(first, streamed)).toBe(true)
  })

  test("publishes a new timeline view when a steering member is appended", () => {
    const root = user("msg_1", 1_000)
    const reply = assistant("msg_2", root.id, { created: 1_100 })
    const first = dedupeUserTurnsWithAliases(
      [root],
      { msg_1: [text("msg_1", "执行长任务")] },
      [root, reply],
      { statusBusy: true },
    )
    const steer = { ...user("msg_3", 2_000), steerTargetTurnID: root.id }
    const steered = dedupeUserTurnsWithAliases(
      [root, steer],
      { msg_1: [text("msg_1", "执行长任务")], msg_3: [text("msg_3", "补充要求")] },
      [root, reply, steer],
      { statusBusy: true },
    )

    // 新引导是时间线结构变化，必须继续通知 UI，并保持服务端成员顺序。
    expect(sameUserTurnView(first, steered)).toBe(false)
    expect(steered.turns[0]?.members.map((member) => member.messageID)).toEqual(["msg_1", "msg_2", "msg_3"])
  })
})
