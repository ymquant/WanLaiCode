import { describe, expect, test } from "bun:test"
import type { AssistantMessage, Message, Part } from "@opencode-ai/sdk/v2/client"
import {
  ASSISTANT_TEXT_STREAMING_GRACE_MS,
  AWAITING_USER_RUNNING_GRACE_MS,
  STALE_ASSISTANT_RUNNING_MS,
  assistantTurnActive,
  activeTimelineTurnGroupID,
  assistantTurnTerminal,
  compactionInFlight,
  confirmFollowupMessagePersisted,
  createFollowupSendClaimRegistry,
  downgradeFollowupSteerToQueue,
  followupCanAutoSend,
  followupActualSteerTarget,
  followupDraftAlreadySent,
  followupFailureIsRetryableBusy,
  followupFailureIsStaleSteerTarget,
  followupAwaitingResult,
  followupMessageID,
  followupPausedQueueAllowsSend,
  followupDockMode,
  followupsAfterSendAck,
  followupPostAckCanTrack,
  followupPromptMessageMatches,
  followupRestoreShouldDowngradeSteer,
  followupSendGateOpen,
  followupSendGateWorking,
  followupShouldQueueInput,
  followupShouldStoreManualSteer,
  followupShouldBlockSend,
  followupShouldPauseForManualSteer,
  followupShouldUseSteer,
  followupTurnState,
  hasAwaitingUserMessages,
  isQueuedUserMessage,
  latestAwaitingUserMessageID,
  manualSteerHydrationState,
  manualSteerHasAssistant,
  manualSteerMessageMatchesTarget,
  manualSteerPendingState,
  manualSteerSendBlocker,
  manualSteerStepInFlight,
  manualSteerTargetWaitInactiveObserved,
  manualSteerTargetWaitState,
  nextFollowupToSend,
  pauseManualSteerState,
  promoteFollowupDraftToSteer,
  recoverStaleSteerToPausedQueue,
  resolvedSessionStatusBusy,
  selectManualSteerTargetTurnID,
  sessionActiveTurnID,
  sessionActiveTurnStartedAt,
  sessionHasRunningTurn,
  sessionHasStaleRunState,
  trailingManualSteerMessageID,
  unsentFollowupDrafts,
} from "./followup-queue"

const user = (id: string, created = 1) =>
  ({
    id,
    role: "user",
    time: { created },
  }) as Message

const assistant = (input: {
  id: string
  parentID: string
  created?: number
  completed?: boolean
  error?: boolean
  finish?: string
}) =>
  ({
    id: input.id,
    role: "assistant",
    parentID: input.parentID,
    time: input.completed ? { created: input.created ?? 1, completed: 2 } : { created: input.created ?? 1 },
    error: input.error ? { name: "APIError", data: { message: "rate limited" } } : undefined,
    finish: input.finish,
  }) as AssistantMessage

const textPart = (input: {
  id: string
  messageID: string
  text?: string
  ignored?: boolean
  synthetic?: boolean
  skillArguments?: string
}) =>
  ({
    id: input.id,
    sessionID: "ses_1",
    messageID: input.messageID,
    type: "text",
    text: input.text ?? "hello",
    ignored: input.ignored,
    synthetic: input.synthetic,
    metadata: input.skillArguments
      ? {
          skill: {
            name: "skill-creator",
            location: "/Users/developer/.codex/skills/skill-creator/SKILL.md",
            arguments: input.skillArguments,
          },
        }
      : undefined,
  }) as const

const manualSteerMarker = (messageID: string, targetTurnID: string) =>
  ({
    id: `marker-${messageID}`,
    sessionID: "ses_1",
    messageID,
    type: "text",
    text: "manual steer",
    synthetic: true,
    // marker 同时携带协议标记与绑定目标，刷新/断网恢复不能只凭 user message ID 猜测。
    metadata: {
      manual_steer_context: true,
      manual_steer_target_turn_id: targetTurnID,
    },
  }) as Part

const assistantTextPart = (input: { id: string; messageID: string; text?: string; start?: number; end?: number }) =>
  ({
    id: input.id,
    sessionID: "ses_1",
    messageID: input.messageID,
    type: "text",
    text: input.text ?? "done",
    time:
      input.start === undefined
        ? undefined
        : {
            start: input.start,
            ...(input.end === undefined ? {} : { end: input.end }),
          },
  }) as const

const stepFinishPart = (input: { id: string; messageID: string }) =>
  ({
    id: input.id,
    sessionID: "ses_1",
    messageID: input.messageID,
    type: "step-finish",
    reason: "stop",
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
  }) as const

const toolPart = (input: { id: string; messageID: string; status: "pending" | "running" | "completed" | "error" }) =>
  ({
    id: input.id,
    sessionID: "ses_1",
    messageID: input.messageID,
    type: "tool",
    callID: input.id,
    tool: "bash",
    state:
      input.status === "pending"
        ? { status: input.status, input: {}, raw: "" }
        : input.status === "running"
          ? { status: input.status, input: {}, time: { start: 1 } }
          : input.status === "completed"
            ? { status: input.status, input: {}, output: "ok", title: "done", metadata: {}, time: { start: 1, end: 2 } }
            : { status: input.status, input: {}, error: "failed", time: { start: 1, end: 2 } },
  }) as const

const imageGenerationToolPart = (input: {
  id: string
  messageID: string
  status: "running" | "completed" | "error"
}): Part =>
  ({
    id: input.id,
    sessionID: "ses_1",
    messageID: input.messageID,
    type: "tool",
    callID: input.id,
    tool: "image_generation",
    state:
      input.status === "running"
        ? { status: "running", input: {}, time: { start: 1 } }
        : input.status === "completed"
          ? {
              status: "completed",
              input: {},
              output: "Generated 1 image.",
              title: "Generated 1 image",
              metadata: {},
              time: { start: 1, end: 2 },
              attachments: [
                imagePart({ id: `${input.id}-img`, messageID: input.messageID, filename: "generated.png" }),
              ],
            }
          : { status: "error", input: {}, error: "Request failed", time: { start: 1, end: 2 } },
  }) as Part

const imagePart = (input: { id: string; messageID: string; filename: string; mime?: string }) =>
  ({
    id: input.id,
    sessionID: "ses_1",
    messageID: input.messageID,
    type: "file",
    mime: input.mime ?? "image/png",
    filename: input.filename,
    url: "data:image/png;base64,abc",
  }) as const

describe("followup queue", () => {
  test("stays pending until the queued turn has a terminal assistant", () => {
    expect(followupTurnState([user("u1")], "u1")).toBe("pending")
    expect(followupTurnState([user("u1"), assistant({ id: "a1", parentID: "u1" })], "u1")).toBe("pending")
  })

  test("reports completed only for successful terminal assistants in the same turn", () => {
    expect(followupTurnState([user("u1"), assistant({ id: "a1", parentID: "u1", completed: true })], "u1")).toBe(
      "completed",
    )
  })

  test("reports error for terminal assistant errors so auto queueing can pause", () => {
    expect(followupTurnState([user("u1"), assistant({ id: "a1", parentID: "u1", error: true })], "u1")).toBe("error")
  })

  test("treats error and final finish assistants as terminal without completed time", () => {
    expect(assistantTurnTerminal(assistant({ id: "a1", parentID: "u1", error: true }))).toBe(true)
    expect(assistantTurnTerminal(assistant({ id: "a1", parentID: "u1", finish: "stop" }))).toBe(true)
    expect(assistantTurnTerminal(assistant({ id: "a1", parentID: "u1", finish: "tool-calls" }))).toBe(false)
    expect(assistantTurnTerminal(assistant({ id: "a1", parentID: "u1" }))).toBe(false)
  })

  test("treats completed assistants as terminal even when finish is non-final", () => {
    const created = Date.now()
    const assistantMessage = assistant({ id: "a1", parentID: "u1", created, completed: true, finish: "unknown" })
    const messages = [user("u1"), assistantMessage]

    expect(assistantTurnTerminal(assistantMessage)).toBe(true)
    expect(
      sessionHasRunningTurn({
        messages,
        partsByMessage: {
          u1: [textPart({ id: "p1", messageID: "u1" })],
        },
        statusBusy: true,
        now: created + 1_000,
      }),
    ).toBe(false)
  })

  test("keeps a completed tool step in the manual steer window while busy", () => {
    const message = assistant({ id: "a1", parentID: "u1", completed: true, finish: "tool-calls" })
    expect(manualSteerStepInFlight(message, true)).toBe(true)
    expect(manualSteerStepInFlight(message, false)).toBe(false)
  })

  test("does not keep stopped tool-call turns in follow-up mode after completion", () => {
    const created = Date.now()

    expect(
      sessionHasRunningTurn({
        messages: [user("u1"), assistant({ id: "a1", parentID: "u1", created, completed: true, finish: "tool-calls" })],
        partsByMessage: {
          u1: [textPart({ id: "p1", messageID: "u1" })],
        },
        statusBusy: true,
        now: created + 1_000,
      }),
    ).toBe(false)
  })

  test("does not treat answered error turns as awaiting new work", () => {
    expect(
      hasAwaitingUserMessages([user("u1"), assistant({ id: "a1", parentID: "u1", error: true })], {
        u1: [textPart({ id: "p1", messageID: "u1" })],
      }),
    ).toBe(false)
  })

  test("does not keep tool-failed assistant turns awaiting while message completion is delayed", () => {
    const created = Date.now()
    const messages = [user("u1"), assistant({ id: "a1", parentID: "u1", created })]
    const partsByMessage = {
      u1: [textPart({ id: "p1", messageID: "u1" })],
      a1: [toolPart({ id: "tool1", messageID: "a1", status: "error" })],
    }

    expect(hasAwaitingUserMessages(messages, partsByMessage, { now: created + 1_000 })).toBe(false)
    expect(
      sessionHasRunningTurn({
        messages,
        partsByMessage,
        statusBusy: true,
        now: created + 1_000,
      }),
    ).toBe(false)
  })

  test("keeps newly inserted user messages awaiting until an assistant answers", () => {
    expect(
      hasAwaitingUserMessages([user("u1")], {
        u1: [textPart({ id: "p1", messageID: "u1" })],
      }),
    ).toBe(true)
  })

  test("returns the latest awaiting user message id for the first assistant event gap", () => {
    expect(
      latestAwaitingUserMessageID([user("u1"), assistant({ id: "a1", parentID: "u1", completed: true }), user("u2")], {
        u1: [textPart({ id: "p1", messageID: "u1" })],
        u2: [textPart({ id: "p2", messageID: "u2" })],
      }),
    ).toBe("u2")
  })

  test("does not return an awaiting user message after the assistant answers", () => {
    expect(
      latestAwaitingUserMessageID([user("u1"), assistant({ id: "a1", parentID: "u1", completed: true })], {
        u1: [textPart({ id: "p1", messageID: "u1" })],
      }),
    ).toBeUndefined()
  })

  test("uses timeline position when a newer message id sorts before an answered remote id", () => {
    // 手机远端消息使用内容哈希 ID；新消息的 ID 字典序可能更小，但创建时间仍然更晚。
    const remoteID = "msg_remote_ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
    const newerID = "msg_f645ca787001MekQG2E4456W4P"
    expect(
      latestAwaitingUserMessageID(
        [
          user(remoteID, 1),
          assistant({ id: "msg_f644872ca001mxjrcJeyE5IFgS", parentID: remoteID, created: 2, completed: true }),
          user(newerID, 3),
        ],
        {
          [remoteID]: [textPart({ id: "p-remote", messageID: remoteID, text: "上一条" })],
          [newerID]: [textPart({ id: "p-newer", messageID: newerID, text: "最新一条" })],
        },
      ),
    ).toBe(newerID)
  })

  test("does not treat old unanswered user messages as a running turn", () => {
    expect(
      sessionHasRunningTurn({
        messages: [user("u1")],
        partsByMessage: {
          u1: [textPart({ id: "p1", messageID: "u1" })],
        },
        statusBusy: true,
        now: Date.now() + 60_000,
      }),
    ).toBe(false)
  })

  test("keeps fresh optimistic user messages running while waiting for assistant events", () => {
    const created = Date.now()
    expect(
      sessionHasRunningTurn({
        messages: [{ ...user("u1"), time: { created } }],
        partsByMessage: {
          u1: [textPart({ id: "p1", messageID: "u1" })],
        },
        statusBusy: true,
        now: created + 1_000,
      }),
    ).toBe(true)
  })

  test("treats an in-flight assistant as running even without status", () => {
    const created = Date.now()
    expect(
      sessionHasRunningTurn({
        messages: [user("u1"), assistant({ id: "a1", parentID: "u1", created })],
        partsByMessage: {
          u1: [textPart({ id: "p1", messageID: "u1" })],
        },
        statusBusy: false,
        now: created + 1_000,
      }),
    ).toBe(true)
  })

  test("does not keep a visible completed assistant in follow-up mode just because completed time is missing", () => {
    const created = Date.now()

    expect(
      sessionHasRunningTurn({
        messages: [user("u1"), assistant({ id: "a1", parentID: "u1", created })],
        partsByMessage: {
          u1: [textPart({ id: "p1", messageID: "u1" })],
          a1: [
            assistantTextPart({
              id: "p2",
              messageID: "a1",
              text: "我是 wanlaicode/gpt-5.5。",
              start: created,
              end: created + 1,
            }),
          ],
        },
        statusBusy: true,
        now: created + 1_000,
      }),
    ).toBe(false)
  })

  test("does not keep a finished tool-calls step running after the session goes idle", () => {
    const created = Date.now()
    // 工具调用轮:中间步骤消息 finish="tool-calls"(非 terminal),后跟最终 stop 消息。
    // 会话已 idle(statusBusy=false)、仍在 45s 时间宽限内 —— 不应再判为运行,否则输入框卡停止态(■)。
    expect(
      sessionHasRunningTurn({
        messages: [
          user("u1"),
          assistant({ id: "a1", parentID: "u1", created, finish: "tool-calls" }),
          assistant({ id: "a2", parentID: "u1", created, finish: "stop" }),
        ],
        partsByMessage: { u1: [textPart({ id: "p1", messageID: "u1" })] },
        statusBusy: false,
        now: created + 1_000,
      }),
    ).toBe(false)
  })

  test("keeps fresh visible assistant text without an end timestamp running", () => {
    const created = Date.now()

    expect(
      sessionHasRunningTurn({
        messages: [user("u1"), assistant({ id: "a1", parentID: "u1", created })],
        partsByMessage: {
          u1: [textPart({ id: "p1", messageID: "u1" })],
          a1: [
            assistantTextPart({
              id: "p2",
              messageID: "a1",
              text: "明白。后续我会始终使用简体中文回复。",
              start: created,
            }),
          ],
        },
        statusBusy: true,
        now: created + 1_000,
      }),
    ).toBe(true)
  })

  test("step-finish releases fresh text without an end timestamp", () => {
    const created = Date.now()
    const messages = [user("u1"), assistant({ id: "a1", parentID: "u1", created })]
    const partsByMessage = {
      u1: [textPart({ id: "p1", messageID: "u1" })],
      a1: [
        assistantTextPart({ id: "p2", messageID: "a1", text: "我会继续改。", start: created }),
        stepFinishPart({ id: "p3", messageID: "a1" }),
      ],
    }

    expect(
      sessionHasRunningTurn({
        messages,
        partsByMessage,
        statusBusy: true,
        now: created + 1_000,
      }),
    ).toBe(false)

    expect(followupAwaitingResult(messages, "u1", { now: created + 1_000, partsByMessage })).toEqual({
      state: "completed",
      clearAwaiting: true,
      pauseQueue: false,
      blockAutoSend: false,
    })
  })

  test("keeps a retrying assistant running after the failed attempt writes step-finish", () => {
    const created = Date.now()
    const messages = [user("u1"), assistant({ id: "a1", parentID: "u1", created })]

    expect(
      sessionHasRunningTurn({
        messages,
        partsByMessage: {
          u1: [textPart({ id: "p1", messageID: "u1" })],
          a1: [stepFinishPart({ id: "p2", messageID: "a1" })],
        },
        statusBusy: true,
        // retry 是整个 runner 的活动状态，step-finish 只属于已经失败的单次传输。
        statusRetry: true,
        now: created + STALE_ASSISTANT_RUNNING_MS + 1,
      }),
    ).toBe(true)
  })

  test("treats stale visible assistant text without an end timestamp as completed output", () => {
    const created = Date.now()

    expect(
      sessionHasRunningTurn({
        messages: [user("u1"), assistant({ id: "a1", parentID: "u1", created })],
        partsByMessage: {
          u1: [textPart({ id: "p1", messageID: "u1" })],
          a1: [
            assistantTextPart({
              id: "p2",
              messageID: "a1",
              text: "明白。后续我会始终使用简体中文回复。",
              start: created,
            }),
          ],
        },
        statusBusy: true,
        now: created + ASSISTANT_TEXT_STREAMING_GRACE_MS + 1,
      }),
    ).toBe(false)

    expect(
      followupAwaitingResult([user("u1"), assistant({ id: "a1", parentID: "u1", created })], "u1", {
        now: created + ASSISTANT_TEXT_STREAMING_GRACE_MS + 1,
        partsByMessage: {
          a1: [
            assistantTextPart({
              id: "p2",
              messageID: "a1",
              text: "明白。后续我会始终使用简体中文回复。",
              start: created,
            }),
          ],
        },
      }),
    ).toEqual({
      state: "completed",
      clearAwaiting: true,
      pauseQueue: false,
      blockAutoSend: false,
    })
  })

  test("keeps an assistant running while tool or image loading evidence is present", () => {
    const created = Date.now()

    expect(
      sessionHasRunningTurn({
        messages: [user("u1"), assistant({ id: "a1", parentID: "u1", created })],
        partsByMessage: {
          u1: [textPart({ id: "p1", messageID: "u1" })],
          a1: [toolPart({ id: "tool1", messageID: "a1", status: "running" })],
        },
        statusBusy: false,
        now: created + 60_000,
      }),
    ).toBe(true)
    expect(
      sessionHasRunningTurn({
        messages: [user("u1"), assistant({ id: "a1", parentID: "u1", created })],
        partsByMessage: {
          u1: [textPart({ id: "p1", messageID: "u1" })],
          a1: [
            imagePart({ id: "img1", messageID: "a1", filename: "wanlai-image-loading-1.svg", mime: "image/svg+xml" }),
          ],
        },
        statusBusy: false,
        now: created + 60_000,
      }),
    ).toBe(true)
  })

  test("keeps a tool-calls step running while the session is still busy", () => {
    const created = Date.now()
    expect(
      sessionHasRunningTurn({
        messages: [user("u1"), assistant({ id: "a1", parentID: "u1", created, finish: "tool-calls" })],
        partsByMessage: { u1: [textPart({ id: "p1", messageID: "u1" })] },
        statusBusy: true,
        now: created + 1_000,
      }),
    ).toBe(true)
  })

  test("keeps a busy tool-calls step running across the inter-step gap (completed tool + step-finish)", () => {
    const created = Date.now()
    const message = {
      ...assistant({ id: "a1", parentID: "u1", created, completed: true, finish: "tool-calls" }),
      time: { created, completed: created + 1 },
    } as AssistantMessage
    // 多步工具回合的步间空档:上一步已写 completed 且 finish="tool-calls",其 tool 已完成并落了 step-finish,
    // 但会话仍 busy(后端在生成下一步)。此时不能因 step-finish/完成证据提前判结束,否则消息下方会
    // 提前出现时间戳、输入框停止按钮回退成发送。
    expect(
      sessionHasRunningTurn({
        messages: [user("u1"), message],
        partsByMessage: {
          u1: [textPart({ id: "p1", messageID: "u1" })],
          a1: [
            toolPart({ id: "tool1", messageID: "a1", status: "completed" }),
            stepFinishPart({ id: "sf1", messageID: "a1" }),
          ],
        },
        statusBusy: true,
        now: created + 1_000,
      }),
    ).toBe(true)
  })

  test("starts the inter-step grace period when a long-running tool step completes", () => {
    const created = Date.now()
    const completed = created + AWAITING_USER_RUNNING_GRACE_MS + 10_000
    const message = {
      ...assistant({ id: "a1", parentID: "u1", created, completed: true, finish: "tool-calls" }),
      time: { created, completed },
    } as AssistantMessage
    const partsByMessage = {
      u1: [textPart({ id: "p1", messageID: "u1" })],
      a1: [
        toolPart({ id: "tool1", messageID: "a1", status: "completed" }),
        stepFinishPart({ id: "sf1", messageID: "a1" }),
      ],
    }

    // 工具本身已运行超过旧的 45 秒窗口，但它刚完成且 runner 仍 busy，侧边栏必须连续保持 loading。
    expect(
      sessionHasRunningTurn({
        messages: [user("u1"), message],
        partsByMessage,
        statusBusy: true,
        now: completed + 1_000,
      }),
    ).toBe(true)
    // 若后端 busy 长期残留且没有下一步消息，宽限到期后仍要释放，不能重新引入永久转圈。
    expect(
      sessionHasRunningTurn({
        messages: [user("u1"), message],
        partsByMessage,
        statusBusy: true,
        now: completed + AWAITING_USER_RUNNING_GRACE_MS + 1,
      }),
    ).toBe(false)
  })

  test("releases a tool-calls step that ended on tool output once the session is idle", () => {
    const created = Date.now()
    // 对照:同样的 finish="tool-calls" + 完成工具 + step-finish,但会话已 idle(回合真的以工具步收尾)。
    // 此时应释放输入框,避免停止按钮卡住(原 stuck bug)。
    expect(
      sessionHasRunningTurn({
        messages: [user("u1"), assistant({ id: "a1", parentID: "u1", created, finish: "tool-calls" })],
        partsByMessage: {
          u1: [textPart({ id: "p1", messageID: "u1" })],
          a1: [
            toolPart({ id: "tool1", messageID: "a1", status: "completed" }),
            stepFinishPart({ id: "sf1", messageID: "a1" }),
          ],
        },
        statusBusy: false,
        now: created + 1_000,
      }),
    ).toBe(false)
  })

  test("does not keep an assistant running after tool or image output completed", () => {
    const created = Date.now()

    expect(
      sessionHasRunningTurn({
        messages: [user("u1"), assistant({ id: "a1", parentID: "u1", created })],
        partsByMessage: {
          u1: [textPart({ id: "p1", messageID: "u1" })],
          a1: [toolPart({ id: "tool1", messageID: "a1", status: "completed" })],
        },
        statusBusy: true,
        now: created + 1_000,
      }),
    ).toBe(false)
    expect(
      sessionHasRunningTurn({
        messages: [user("u1"), assistant({ id: "a1", parentID: "u1", created })],
        partsByMessage: {
          u1: [textPart({ id: "p1", messageID: "u1" })],
          a1: [imagePart({ id: "img1", messageID: "a1", filename: "generated.png" })],
        },
        statusBusy: true,
        now: created + 1_000,
      }),
    ).toBe(false)
  })

  test("ignores stale image loading placeholders after image_generation completed", () => {
    const created = Date.now()
    const messages = [user("u1"), assistant({ id: "a1", parentID: "u1", created })]
    const partsByMessage = {
      a1: [
        imageGenerationToolPart({ id: "tool1", messageID: "a1", status: "completed" }),
        imagePart({ id: "loading1", messageID: "a1", filename: "wanlai-image-loading-1.svg", mime: "image/svg+xml" }),
      ],
    }

    expect(
      sessionHasRunningTurn({
        messages,
        partsByMessage,
        statusBusy: true,
        now: created + 1_000,
      }),
    ).toBe(false)
    expect(followupTurnState(messages, "u1", { partsByMessage })).toBe("completed")
  })

  test("keeps image generation running after visible text until tool attachments settle", () => {
    const created = Date.now()
    const messages = [user("u1"), assistant({ id: "a1", parentID: "u1", created })]
    const partsByMessage = {
      a1: [
        imageGenerationToolPart({ id: "tool1", messageID: "a1", status: "running" }),
        imagePart({ id: "loading1", messageID: "a1", filename: "wanlai-image-loading-1.svg", mime: "image/svg+xml" }),
        assistantTextPart({
          id: "text1",
          messageID: "a1",
          text: "已按你的要求生成图片。",
          start: created + 500,
          end: created + 700,
        }),
      ],
    }

    expect(
      sessionHasRunningTurn({
        messages,
        partsByMessage,
        statusBusy: true,
        now: created + AWAITING_USER_RUNNING_GRACE_MS + 1_000,
      }),
    ).toBe(true)
    expect(followupTurnState(messages, "u1", { partsByMessage })).toBe("pending")
  })

  test("keeps image generation running even when a step-finish part arrives first", () => {
    const created = Date.now()
    const messages = [user("u1"), assistant({ id: "a1", parentID: "u1", created })]
    const partsByMessage = {
      a1: [
        stepFinishPart({ id: "step1", messageID: "a1" }),
        imageGenerationToolPart({ id: "tool1", messageID: "a1", status: "running" }),
        imagePart({ id: "loading1", messageID: "a1", filename: "wanlai-image-loading-1.svg", mime: "image/svg+xml" }),
      ],
    }

    expect(
      sessionHasRunningTurn({
        messages,
        partsByMessage,
        statusBusy: true,
        now: created + 20_000,
      }),
    ).toBe(true)
    expect(followupTurnState(messages, "u1", { partsByMessage })).toBe("pending")
  })

  test("keeps auto queue blocked while awaited assistant text is still streaming", () => {
    const created = Date.now()

    expect(
      followupAwaitingResult([user("u1"), assistant({ id: "a1", parentID: "u1", created })], "u1", {
        now: created + 1_000,
        partsByMessage: {
          a1: [assistantTextPart({ id: "p1", messageID: "a1", text: "正在整理第一段输出", start: created })],
        },
      }),
    ).toEqual({
      state: "pending",
      clearAwaiting: false,
      pauseQueue: false,
      blockAutoSend: true,
    })
  })

  test("ignores stale image loading placeholders after image_generation fails", () => {
    const created = Date.now()
    const messages = [user("u1"), assistant({ id: "a1", parentID: "u1", created })]
    const partsByMessage = {
      a1: [
        imageGenerationToolPart({ id: "tool1", messageID: "a1", status: "error" }),
        imagePart({ id: "loading1", messageID: "a1", filename: "wanlai-image-loading-1.svg", mime: "image/svg+xml" }),
      ],
    }

    expect(
      sessionHasRunningTurn({
        messages,
        partsByMessage,
        statusBusy: true,
        now: created + 1_000,
      }),
    ).toBe(false)
    expect(hasAwaitingUserMessages(messages, partsByMessage, { now: created + 1_000 })).toBe(false)
    expect(followupTurnState(messages, "u1", { partsByMessage })).toBe("completed")
  })

  test("keeps a fresh visible image failure response running while text is still streaming", () => {
    const created = Date.now()
    const messages = [user("u1"), assistant({ id: "a1", parentID: "u1", created })]
    const partsByMessage = {
      a1: [
        imagePart({ id: "loading1", messageID: "a1", filename: "wanlai-image-loading-1.svg", mime: "image/svg+xml" }),
        assistantTextPart({
          id: "text1",
          messageID: "a1",
          text: "这次又失败了，图片生成工具返回 Request failed，没有产出图片。",
          start: created + 500,
        }),
      ],
    }

    expect(
      sessionHasRunningTurn({
        messages,
        partsByMessage,
        statusBusy: true,
        now: created + 1_000,
      }),
    ).toBe(true)
    expect(hasAwaitingUserMessages(messages, partsByMessage, { now: created + 1_000 })).toBe(false)
  })

  test("does not keep a stale visible image failure response running because a loading placeholder remains", () => {
    const created = Date.now()
    const messages = [user("u1"), assistant({ id: "a1", parentID: "u1", created })]
    const partsByMessage = {
      a1: [
        imagePart({ id: "loading1", messageID: "a1", filename: "wanlai-image-loading-1.svg", mime: "image/svg+xml" }),
        assistantTextPart({
          id: "text1",
          messageID: "a1",
          text: "这次又失败了，图片生成工具返回 Request failed，没有产出图片。",
          start: created + 500,
        }),
      ],
    }

    expect(
      sessionHasRunningTurn({
        messages,
        partsByMessage,
        statusBusy: true,
        now: created + AWAITING_USER_RUNNING_GRACE_MS + 1_000,
      }),
    ).toBe(false)
    expect(
      hasAwaitingUserMessages(messages, partsByMessage, { now: created + AWAITING_USER_RUNNING_GRACE_MS + 1_000 }),
    ).toBe(false)
  })

  test("keeps a fresh in-flight tool-calls step running before status loads (reload/deep-link)", () => {
    const created = Date.now()
    // 真正在途的 tool-calls 轮:最新 assistant 是 finish="tool-calls",而 session_status 还没异步加载完
    // (statusBusy=false)。此时仍应判为运行,否则刷新/深链进会话会让用户无法中止、后续消息插队。
    expect(
      sessionHasRunningTurn({
        messages: [user("u1"), assistant({ id: "a1", parentID: "u1", created, finish: "tool-calls" })],
        partsByMessage: { u1: [textPart({ id: "p1", messageID: "u1" })] },
        statusBusy: false,
        now: created + 1_000,
      }),
    ).toBe(true)
  })

  test("does not keep stale unfinished assistants running forever", () => {
    const created = Date.now()
    expect(
      sessionHasRunningTurn({
        messages: [user("u1"), assistant({ id: "a1", parentID: "u1", created })],
        partsByMessage: {
          u1: [textPart({ id: "p1", messageID: "u1" })],
        },
        statusBusy: true,
        now: created + 31 * 60_000,
      }),
    ).toBe(false)
    expect(
      sessionHasStaleRunState({
        messages: [user("u1"), assistant({ id: "a1", parentID: "u1", created })],
        partsByMessage: {
          u1: [textPart({ id: "p1", messageID: "u1" })],
        },
        statusBusy: true,
        now: created + 31 * 60_000,
      }),
    ).toBe(true)
  })

  test("does not treat a superseded tool-calls step in an old idle turn as stale", () => {
    // 完成的工具轮:tool-calls 步后跟 stop 步,均属 u1,>30min 且会话已 idle。最新消息是 stop(terminal),
    // 不应因历史 tool-calls 步被判为 stale(否则 onBeforeSubmitExistingSession 每次发送前多发一次 abort+resync)。
    const created = Date.now()
    expect(
      sessionHasStaleRunState({
        messages: [
          user("u1"),
          assistant({ id: "a1", parentID: "u1", created, finish: "tool-calls" }),
          assistant({ id: "a2", parentID: "u1", created, finish: "stop" }),
        ],
        partsByMessage: { u1: [textPart({ id: "p1", messageID: "u1" })] },
        statusBusy: false,
        now: created + 31 * 60_000,
      }),
    ).toBe(false)
  })

  test("treats a dead old non-terminal latest tool-calls step as stale", () => {
    const created = Date.now()
    expect(
      sessionHasStaleRunState({
        messages: [user("u1"), assistant({ id: "a1", parentID: "u1", created, finish: "tool-calls" })],
        partsByMessage: { u1: [textPart({ id: "p1", messageID: "u1" })] },
        statusBusy: true,
        now: created + 31 * 60_000,
      }),
    ).toBe(true)
  })

  test("does not clear busy state before messages have loaded", () => {
    expect(
      sessionHasStaleRunState({
        messages: undefined,
        partsByMessage: {},
        statusBusy: true,
      }),
    ).toBe(false)
  })

  test("keeps long but not stale busy assistants running", () => {
    const created = Date.now()
    expect(
      sessionHasRunningTurn({
        messages: [user("u1"), assistant({ id: "a1", parentID: "u1", created })],
        partsByMessage: {
          u1: [textPart({ id: "p1", messageID: "u1" })],
        },
        statusBusy: true,
        now: created + 10 * 60_000,
      }),
    ).toBe(true)
    expect(
      sessionHasStaleRunState({
        messages: [user("u1"), assistant({ id: "a1", parentID: "u1", created })],
        partsByMessage: {
          u1: [textPart({ id: "p1", messageID: "u1" })],
        },
        statusBusy: true,
        now: created + 10 * 60_000,
      }),
    ).toBe(false)
  })

  test("ignores legacy steered user messages when deciding whether the session is busy", () => {
    expect(
      hasAwaitingUserMessages(
        [user("u1"), assistant({ id: "a1", parentID: "u1", completed: true }), user("u2")],
        {
          u1: [textPart({ id: "p1", messageID: "u1" })],
          u2: [textPart({ id: "p2", messageID: "u2" })],
        },
        { ignoredUserMessageIDs: new Set(["u2"]) },
      ),
    ).toBe(false)
  })

  test("does not inspect later turns", () => {
    expect(
      followupTurnState([user("u1"), user("u2"), assistant({ id: "a2", parentID: "u2", completed: true })], "u1"),
    ).toBe("pending")
  })

  test("blocks the current auto-send tick when an awaited turn errors with queued items", () => {
    const queuedItem = { id: "queued-next" }
    const result = followupAwaitingResult([user("u1"), assistant({ id: "a1", parentID: "u1", error: true })], "u1")
    const sendCalls: string[] = []

    if (!result.blockAutoSend) sendCalls.push(queuedItem.id)

    expect(result).toEqual({
      state: "error",
      clearAwaiting: true,
      pauseQueue: true,
      blockAutoSend: true,
    })
    expect(sendCalls).toEqual([])
  })

  test("unblocks auto-send only after a successful awaited turn completes", () => {
    expect(followupAwaitingResult([user("u1"), assistant({ id: "a1", parentID: "u1" })], "u1")).toEqual({
      state: "pending",
      clearAwaiting: false,
      pauseQueue: false,
      blockAutoSend: true,
    })
    expect(
      followupAwaitingResult([user("u1"), assistant({ id: "a1", parentID: "u1", completed: true })], "u1"),
    ).toEqual({
      state: "completed",
      clearAwaiting: true,
      pauseQueue: false,
      blockAutoSend: false,
    })
  })

  test("keeps queued awaiting locked after visible completion evidence until the session is idle", () => {
    const messages = [user("u1"), assistant({ id: "a1", parentID: "u1" })]
    const partsByMessage = {
      a1: [assistantTextPart({ id: "p1", messageID: "a1", text: "done" })],
    }

    expect(followupAwaitingResult(messages, "u1", { partsByMessage, sessionIdle: false })).toEqual({
      state: "pending",
      clearAwaiting: false,
      pauseQueue: false,
      blockAutoSend: true,
    })
    expect(followupAwaitingResult(messages, "u1", { partsByMessage, sessionIdle: true })).toEqual({
      state: "completed",
      clearAwaiting: true,
      pauseQueue: false,
      blockAutoSend: false,
    })
  })

  test("unblocks auto-send when an awaited assistant has completed output but no completed timestamp", () => {
    const created = Date.now()

    expect(
      followupAwaitingResult([user("u1"), assistant({ id: "a1", parentID: "u1", created })], "u1", {
        partsByMessage: {
          a1: [assistantTextPart({ id: "p1", messageID: "a1", text: "done" })],
        },
      }),
    ).toEqual({
      state: "completed",
      clearAwaiting: true,
      pauseQueue: false,
      blockAutoSend: false,
    })
  })

  test("keeps blocking auto queue while the just-sent message is not observed yet", () => {
    const startedAt = Date.now()

    expect(followupAwaitingResult([], "u1", { startedAt, now: startedAt + 1_000 })).toEqual({
      state: "missing",
      clearAwaiting: false,
      pauseQueue: false,
      blockAutoSend: true,
    })
  })

  test("pauses auto queue instead of draining more items when the awaited message never appears", () => {
    const startedAt = Date.now()

    expect(followupAwaitingResult([], "u1", { startedAt, now: startedAt + 6 * 60_000 })).toEqual({
      state: "missing",
      clearAwaiting: true,
      pauseQueue: true,
      blockAutoSend: true,
    })
  })

  test("releases a missing awaited message when the session is already idle", () => {
    const startedAt = Date.now()

    expect(followupAwaitingResult([], "u1", { startedAt, now: startedAt + 6 * 60_000, sessionIdle: true })).toEqual({
      state: "missing",
      clearAwaiting: true,
      pauseQueue: false,
      blockAutoSend: false,
    })
  })

  test("does not let auto queue awaiting state swallow manual steer clicks", () => {
    expect(followupShouldBlockSend({ manual: false, awaitingBlocked: true })).toBe(true)
    expect(followupShouldBlockSend({ manual: true, awaitingBlocked: true })).toBe(false)
  })

  test("auto-sends queued follow-ups only after both run-state signals are idle", () => {
    expect(followupCanAutoSend({ inferredBusy: true, statusBusy: false })).toBe(false)
    expect(followupCanAutoSend({ inferredBusy: false, statusBusy: true })).toBe(false)
    expect(followupCanAutoSend({ inferredBusy: false, statusBusy: false })).toBe(true)
  })

  test("queues new input while backend status remains busy", () => {
    // 前端推导态可能因流式文本超时先变 idle；后端 busy 仍表示当前回合尚未结束。
    expect(
      followupShouldQueueInput({
        queueingEnabled: true,
        inferredBusy: false,
        statusBusy: true,
        manualSteerWaiting: false,
      }),
    ).toBe(true)
  })

  test("pauses auto queue while a manual steer is pending", () => {
    expect(followupShouldPauseForManualSteer({ pending: true })).toBe(true)
    expect(followupShouldPauseForManualSteer({ pending: false })).toBe(false)
  })

  // 终态 assistant 才能解锁；后端合并 m1/m2 时，parent=m2 的回复也覆盖更早的 m1。
  test("releases manual steers through the terminal assistant high-water", () => {
    expect(manualSteerHasAssistant([user("m1"), assistant({ id: "a1", parentID: "m1", completed: true })], "m1")).toBe(
      true,
    )
    expect(manualSteerHasAssistant([user("m1"), assistant({ id: "a1", parentID: "m1" })], "m1")).toBe(false)
    expect(
      manualSteerHasAssistant([user("m1"), user("m2"), assistant({ id: "a2", parentID: "m2", completed: true })], "m1"),
    ).toBe(true)
    expect(
      manualSteerHasAssistant([assistant({ id: "a2", parentID: "m2", completed: true }), user("m1"), user("m2")], "m1"),
    ).toBe(true)
    expect(
      manualSteerHasAssistant([user("m1"), assistant({ id: "a1", parentID: "other", completed: true })], "m1"),
    ).toBe(false)
    expect(manualSteerHasAssistant([], "m1")).toBe(false)
  })

  test("recovers a missing manual steer only after the session is idle and the grace expires", () => {
    const startedAt = 100
    const base = {
      messages: [user("m1")],
      messageID: "m1",
      startedAt,
      inferredBusy: false,
      statusBusy: false,
    }
    expect(manualSteerPendingState({ ...base, now: startedAt + 1 })).toBe("pending")
    // 没有 assistant 证据时，超过宽限期必须回收，即使旧 status 仍残留 busy。
    expect(manualSteerPendingState({ ...base, now: startedAt + 60_000 })).toBe("missing")
    expect(manualSteerPendingState({ ...base, now: startedAt + 60_000, statusBusy: true })).toBe("missing")
    expect(
      manualSteerPendingState({
        ...base,
        now: startedAt + 60_000,
        inferredBusy: true,
        statusBusy: true,
      }),
    ).toBe("pending")
    // status 已经 idle 但推导态被残留工具 part 卡成 busy 时，也必须能在宽限后解锁。
    expect(
      manualSteerPendingState({
        ...base,
        now: startedAt + 60_000,
        inferredBusy: true,
        statusBusy: false,
      }),
    ).toBe("missing")
    expect(
      manualSteerPendingState({
        ...base,
        now: startedAt + 60_000,
        messages: [user("m1"), assistant({ id: "a1", parentID: "m1", completed: true })],
      }),
    ).toBe("completed")
    // 工具中间步可能先写 completed；只要后端仍 busy，引导顺序锁必须等真正终态再释放。
    expect(
      manualSteerPendingState({
        ...base,
        now: startedAt + 60_000,
        statusBusy: true,
        messages: [user("m1"), assistant({ id: "a1", parentID: "m1", completed: true, finish: "tool-calls" })],
      }),
    ).toBe("pending")
  })

  test("hydrates a recovered steer only after its exact durable target marker appears", () => {
    const base = {
      messages: [user("m1")],
      messageID: "m1",
      targetTurnID: "turn-1",
      startedAt: 100,
      now: 60_100,
      inferredBusy: false,
      statusBusy: false,
      acknowledged: false,
      recovery: true,
    }

    // 普通 user、缺 marker 和错误目标都不能确认；否则旧引导会被误认为已经附到后来回合。
    expect(manualSteerHydrationState({ ...base, partsByMessage: {} })).toBe("missing")
    expect(
      manualSteerHydrationState({
        ...base,
        partsByMessage: { m1: [manualSteerMarker("m1", "turn-2")] },
      }),
    ).toBe("missing")
    expect(
      manualSteerHydrationState({
        ...base,
        partsByMessage: { m1: [manualSteerMarker("m1", "turn-1")] },
      }),
    ).toBe("acknowledged")
    // 刷新时 marker 可能晚于 message.updated 到达；持久化目标本身命中时也必须立即保留顺序锁。
    expect(
      manualSteerHydrationState({
        ...base,
        messages: [{ ...user("m1"), steerTargetTurnID: "turn-1" } as Message],
        partsByMessage: {},
      }),
    ).toBe("acknowledged")

    // 官方 accepted steer 不会因 turn/status 事件暂时缺失而超时恢复；durable marker 出现后必须一直等终态回复。
    expect(
      manualSteerHydrationState({
        ...base,
        acknowledged: true,
        partsByMessage: { m1: [manualSteerMarker("m1", "turn-1")] },
      }),
    ).toBe("pending")

    // RPC ACK 不能伪造 durable marker；marker 永未出现时仍必须进入 missing，以便恢复草稿并撤销 optimistic 气泡。
    expect(manualSteerHydrationState({ ...base, acknowledged: true, partsByMessage: {} })).toBe("missing")
  })

  // 手动引导只建立顺序锁，实际请求仍由正常 prompt/loop 执行，避免 noReply 双提交。
  test("tracks every explicit manual steer across status races", () => {
    expect(followupShouldStoreManualSteer({ manual: true, inferredBusy: true, statusBusy: false })).toBe(true)
    expect(followupShouldStoreManualSteer({ manual: true, inferredBusy: false, statusBusy: true })).toBe(true)
    expect(followupShouldStoreManualSteer({ manual: true, inferredBusy: false, statusBusy: false })).toBe(true)
    expect(followupShouldStoreManualSteer({ manual: false, inferredBusy: true, statusBusy: true })).toBe(false)
  })

  test("preserves the snapshotted steer target across status races", () => {
    const idle = {
      manual: true,
      inferredBusy: false,
      statusBusy: false,
      pendingManualSteer: false,
    }
    expect(
      followupShouldUseSteer({
        ...idle,
        source: "automatic",
        manualSteerDraft: true,
        targetTurnID: "turn-1",
      }),
    ).toBe(true)
    // 发送阶段只认草稿快照；最新 status 无论 busy/idle 都不能替缺目标草稿重新选 turn。
    expect(followupShouldUseSteer({ ...idle, source: "dock", manualSteerDraft: true })).toBe(false)
    expect(followupShouldUseSteer({ ...idle, source: "dock", statusBusy: true })).toBe(false)
    expect(
      followupShouldUseSteer({
        ...idle,
        manual: false,
        source: "automatic",
        manualSteerDraft: true,
        targetTurnID: "turn-1",
      }),
    ).toBe(false)
  })

  test("reads steer targets only from busy or retry status and keeps a pending target", () => {
    expect(sessionActiveTurnID({ type: "busy", turnID: "turn-busy" })).toBe("turn-busy")
    expect(sessionActiveTurnID({ type: "retry", turnID: "turn-retry", attempt: 1, message: "retry", next: 1 })).toBe(
      "turn-retry",
    )
    expect(sessionActiveTurnStartedAt({ type: "busy", startedAt: 123 })).toBe(123)
    expect(sessionActiveTurnStartedAt({ type: "retry", startedAt: 456, attempt: 1, message: "retry", next: 1 })).toBe(
      456,
    )
    expect(sessionActiveTurnID({ type: "idle" })).toBeUndefined()
    expect(sessionActiveTurnStartedAt({ type: "idle" })).toBeUndefined()
    expect(sessionActiveTurnID({ type: "busy" })).toBeUndefined()

    // 当前 status 即使已经进入 turn-2，连续引导仍必须绑定最初 pending 的 turn-1。
    expect(
      selectManualSteerTargetTurnID({
        pendingTargetTurnID: "turn-1",
        status: { type: "busy", turnID: "turn-2" },
      }),
    ).toBe("turn-1")
  })

  test("anchors a busy turn to only the trailing confirmed steer during the assistant gap", () => {
    const root = user("turn-root", 100)
    const steer = user("steer-latest", 200)

    // steer 是数组末项时表示它已经进入当前 inProgress turn，下一条 assistant 首包到达前仍应显示工作态。
    expect(trailingManualSteerMessageID([root, steer], { [steer.id]: 1 })).toBe(steer.id)
    // 普通排队消息一旦出现在后面就拥有自己的 awaiting 语义，不能继续把 busy 锚回历史 steer。
    expect(trailingManualSteerMessageID([root, steer, user("queued", 300)], { [steer.id]: 1 })).toBeUndefined()
    // 未被 steer 归属表确认的普通 user 也不能仅凭处于末尾就并入当前回合。
    expect(trailingManualSteerMessageID([root, steer], {})).toBeUndefined()
  })

  test("keeps targetless steer grouped with the active turn when a normal queue is later", () => {
    const active = {
      ...assistant({ id: "assistant-active", parentID: "turn-root", completed: true, finish: "tool-calls" }),
      turnID: "turn-root",
    } as AssistantMessage & { turnID: string }
    const messages = [user("turn-root"), active, user("turn-queued")]

    // 官方读取的是 inProgress turn，而不是 turns.at(-1)：工具步后的普通排队消息不能抢走 optimistic steer 的归组。
    expect(
      activeTimelineTurnGroupID({
        status: { type: "busy" },
        messages,
        partsByMessage: {},
        turnIDByMessageID: {
          "turn-root": "turn-root",
          "assistant-active": "turn-root",
          "turn-queued": "turn-queued",
        },
        now: 2,
      }),
    ).toBe("turn-root")
  })

  test("does not guess the last queued turn while the active turn has no timeline evidence", () => {
    // 官方 rfe 会继续等待 inProgress turnId；busy 首包空窗不能把最后一个普通 queued user 当成 steer 目标。
    expect(
      activeTimelineTurnGroupID({
        status: { type: "busy" },
        messages: [user("turn-root"), user("turn-queued")],
        partsByMessage: {},
        turnIDByMessageID: { "turn-root": "turn-root", "turn-queued": "turn-queued" },
        now: 2,
      }),
    ).toBeUndefined()
  })

  test("waits for a target only inside the runtime and active run that created the steer", () => {
    const waiting = {
      runtimeOwned: true,
      originInProgressObserved: true,
      expectedStartedAt: 100,
      activeStartedAt: 100,
      expectedTurnGroupID: "turn-root",
      activeTurnGroupID: "turn-root",
      inactiveObserved: false,
      statusKnown: true,
      inferredBusy: true,
      statusBusy: true,
    }
    // busy 先到、turnID 后到时继续等待；同代次发布目标后才允许发送 steer。
    expect(manualSteerTargetWaitState(waiting)).toEqual({ type: "waiting" })
    expect(manualSteerTargetWaitState({ ...waiting, targetTurnID: "turn-1" })).toEqual({
      type: "ready",
      targetTurnID: "turn-1",
    })
    // 原回合先结束或页面刷新丢失 callback 所有权时，旧意图都不能绑定到后来回合。
    expect(manualSteerTargetWaitState({ ...waiting, activeStartedAt: 101, targetTurnID: "turn-2" })).toEqual({
      type: "inactive",
    })
    // 明确 idle 和已经观察到的 inactive 都必须盖过旧 target，本地残留 busy 不能复活 callback。
    expect(manualSteerTargetWaitState({ ...waiting, statusBusy: false, targetTurnID: "turn-later" })).toEqual({
      type: "inactive",
    })
    expect(manualSteerTargetWaitState({ ...waiting, inactiveObserved: true, targetTurnID: "turn-later" })).toEqual({
      type: "inactive",
    })
    expect(
      manualSteerTargetWaitState({
        ...waiting,
        expectedStartedAt: undefined,
        activeStartedAt: 101,
        activeTurnGroupID: "turn-later",
        targetTurnID: "turn-2",
      }),
    ).toEqual({ type: "inactive" })
    // 当前 status 暂时缺失时沿用创建时已确认的 run 身份等待，不能把同步空窗误判成 turn 结束。
    expect(
      manualSteerTargetWaitState({
        ...waiting,
        statusKnown: false,
        statusBusy: false,
        inferredBusy: false,
      }),
    ).toEqual({ type: "waiting" })
    expect(manualSteerTargetWaitState({ ...waiting, inferredBusy: false, statusBusy: false })).toEqual({
      type: "inactive",
    })
    expect(manualSteerTargetWaitState({ ...waiting, runtimeOwned: false, targetTurnID: "turn-2" })).toEqual({
      type: "stale",
    })
    // 提交时没有任何回合身份、之后又只看到一个新 target 时，不能把后来启动的回合借给旧引导。
    expect(
      manualSteerTargetWaitState({
        ...waiting,
        expectedStartedAt: undefined,
        expectedTurnGroupID: undefined,
        activeStartedAt: undefined,
        activeTurnGroupID: undefined,
        targetTurnID: "turn-later",
      }),
    ).toEqual({ type: "inactive" })
  })

  test("serializes follow-up durable ACK requests per session across page lifecycles", () => {
    const registry = createFollowupSendClaimRegistry()
    const notifications: string[] = []
    const unsubscribe = registry.subscribe(() => notifications.push("changed"))

    // 同会话第二条必须等第一条 ACK 释放；其它会话不共享这把锁，仍可独立提交。
    expect(registry.claim("session-1", "message-1")).toBe(true)
    expect(registry.claim("session-1", "message-2")).toBe(false)
    expect(registry.messageID("session-1")).toBe("message-1")
    expect(registry.claim("session-2", "message-3")).toBe(true)
    expect(registry.release("session-1", "message-other")).toBe(false)
    expect(registry.release("session-1", "message-1")).toBe(true)
    expect(registry.claim("session-1", "message-2")).toBe(true)
    expect(registry.busy("session-1")).toBe(true)
    expect(notifications).toHaveLength(4)
    unsubscribe()
  })

  test("distinguishes an initially missing status from idle removing an observed run status", () => {
    const initial = {
      inactiveObserved: false,
      originInProgressObserved: false,
      statusKnown: false,
      statusBusy: false,
      inferredBusy: false,
    }
    // 首次同步尚未拿到 status 时不能宣告原 turn 结束；见过 busy 后再消失且无运行证据才对应官方 inactive callback。
    expect(manualSteerTargetWaitInactiveObserved({ ...initial, statusObserved: false })).toBe(false)
    expect(manualSteerTargetWaitInactiveObserved({ ...initial, statusObserved: true, inferredBusy: true })).toBe(false)
    expect(manualSteerTargetWaitInactiveObserved({ ...initial, statusObserved: true })).toBe(true)
    // status 事件完全缺席时，创建 steer 时观察到的运行态也足以在消息态转空后结束等待。
    expect(
      manualSteerTargetWaitInactiveObserved({
        ...initial,
        originInProgressObserved: true,
        statusObserved: false,
      }),
    ).toBe(true)
    expect(
      manualSteerTargetWaitInactiveObserved({
        ...initial,
        statusObserved: true,
        statusKnown: true,
        statusBusy: true,
      }),
    ).toBe(false)
  })

  test("stores the dock target snapshot on the promoted draft", () => {
    const drafts = [
      {
        id: "draft-1",
        messageID: "message-1",
        agent: "agent",
        model: { providerID: "provider", modelID: "model" },
      },
    ]
    const promoted = promoteFollowupDraftToSteer({ items: drafts, id: "draft-1", targetTurnID: "turn-1" })

    expect(promoted[0]).toMatchObject({
      id: "draft-1",
      messageID: "message-1",
      manualSteer: true,
      targetTurnID: "turn-1",
    })
  })

  test("downgrades a stale steer without changing its stable message id", () => {
    expect(
      downgradeFollowupSteerToQueue({
        id: "draft-1",
        messageID: "message-1",
        manualSteer: true,
        targetTurnID: "turn-1",
        text: "继续处理",
      }),
    ).toEqual({ id: "draft-1", messageID: "message-1", text: "继续处理" })
    expect(followupFailureIsStaleSteerTarget({ response: { status: 409 } })).toBe(false)
    expect(followupFailureIsStaleSteerTarget({ status: 409, statusCode: 409 })).toBe(false)
    expect(followupFailureIsStaleSteerTarget({ name: "SteerTurnInactiveError", data: {} })).toBe(true)
    expect(followupFailureIsStaleSteerTarget({ error: { name: "SteerTurnInactiveError", data: {} } })).toBe(true)
    // 官方只在 local host 兼容旧 NoActiveTurn 文本；远程响应不能借此静默开启新回合。
    expect(followupFailureIsStaleSteerTarget("RPC failed: NoActiveTurn(session-1)")).toBe(false)
    expect(followupFailureIsStaleSteerTarget("RPC failed: NoActiveTurn(session-1)", { localHost: true })).toBe(true)
    expect(followupFailureIsStaleSteerTarget(new Error("network failed"))).toBe(false)
  })

  test("extracts the authoritative active turn from wrapped steer mismatch errors", () => {
    expect(
      followupActualSteerTarget({
        error: {
          name: "SteerTurnInactiveError",
          data: { expectedTurnID: "turn-old", actualTurnID: "turn-active" },
        },
      }),
    ).toBe("turn-active")
    expect(
      followupActualSteerTarget({
        response: { name: "SteerTurnInactiveError", data: { actualTurnID: "turn-response" } },
      }),
    ).toBe("turn-response")
    expect(
      followupActualSteerTarget("request failed: expected active turn id `turn-old` but found `turn-from-message`"),
    ).toBe("turn-from-message")
    // 普通冲突即使带有相似字段，也不能让客户端把引导改绑到未验证的回合。
    expect(followupActualSteerTarget({ status: 409, data: { actualTurnID: "turn-untrusted" } })).toBeUndefined()
    expect(followupActualSteerTarget({ name: "SteerTurnInactiveError", data: {} })).toBeUndefined()
  })

  test("confirms a fallback only from the same durable ordinary user message", () => {
    expect(followupPromptMessageMatches({ message: user("message-1"), messageID: "message-1" })).toBe(true)
    expect(followupPromptMessageMatches({ message: user("message-other"), messageID: "message-1" })).toBe(false)
    expect(
      followupPromptMessageMatches({
        message: { ...user("message-1"), steerTargetTurnID: "turn-old" },
        messageID: "message-1",
      }),
    ).toBe(false)
    expect(
      followupPromptMessageMatches({
        message: assistant({ id: "message-1", parentID: "user-1", completed: true }),
        messageID: "message-1",
      }),
    ).toBe(false)
  })

  test("pauses an unaccepted steer after interruption or loss of ACK ownership", () => {
    const recovered = recoverStaleSteerToPausedQueue({
      id: "draft-1",
      messageID: "message-1",
      manualSteer: true,
      targetTurnID: "turn-1",
      text: "继续处理",
    })

    // 中断恢复项保留稳定 ID 和正文，但暂停态必须拦住自动队列；用户显式操作解除暂停后才可发送。
    expect(recovered).toEqual({
      item: { id: "draft-1", messageID: "message-1", text: "继续处理" },
      paused: true,
    })
    expect(nextFollowupToSend([recovered.item], { paused: recovered.paused })).toBeUndefined()
    expect(nextFollowupToSend([recovered.item], { paused: false })).toBe(recovered.item)
  })

  test("resumes only stop-restored steer IDs while ordinary queue stays paused", () => {
    const restored = { id: "restored-steer", text: "停止后继续" }
    const ordinary = { id: "ordinary-queue", text: "保持暂停" }

    // 停止后的自动接力只消费恢复名单，不能因为解除一条引导而意外启动普通排队消息。
    expect(
      nextFollowupToSend([ordinary, restored], {
        paused: true,
        resumeIDs: new Set([restored.id]),
      }),
    ).toBe(restored)
    // 压缩会重写消息历史，优先级高于停止恢复；恢复项必须留在 Dock，待压缩结束后再沿原名单接续。
    expect(
      nextFollowupToSend([ordinary, restored], {
        paused: true,
        resumeIDs: new Set([restored.id]),
        compacting: true,
      }),
    ).toBeUndefined()
    expect(nextFollowupToSend([ordinary, restored], { paused: true, resumeIDs: new Set() })).toBeUndefined()
    expect(followupPausedQueueAllowsSend({ paused: true, resumeAfterAbort: true })).toBe(true)
    expect(followupPausedQueueAllowsSend({ paused: true, resumeAfterAbort: false })).toBe(false)
  })

  test("automatically continues a non-interrupted inactive steer as an ordinary turn", () => {
    const recovered = downgradeFollowupSteerToQueue({
      id: "draft-1",
      messageID: "message-1",
      manualSteer: true,
      targetTurnID: "turn-1",
      targetTurnStartedAt: 100,
      optimisticTurnID: "turn-visible",
      text: "继续处理",
    })

    // 官方只会暂停 interrupted；普通完成要复用原消息 ID 自动接力，同时彻底移除旧 turn 的 steer 归属。
    expect(recovered).toEqual({ id: "draft-1", messageID: "message-1", text: "继续处理" })
    expect(nextFollowupToSend([recovered], { paused: false })).toBe(recovered)
  })

  test("requires the complete steer marker to match the snapshotted target", () => {
    expect(
      manualSteerMessageMatchesTarget({
        message: user("m1"),
        parts: [manualSteerMarker("m1", "turn-1")],
        messageID: "m1",
        targetTurnID: "turn-1",
      }),
    ).toBe(true)
    expect(
      manualSteerMessageMatchesTarget({
        message: user("m1"),
        parts: [manualSteerMarker("m1", "turn-2")],
        messageID: "m1",
        targetTurnID: "turn-1",
      }),
    ).toBe(false)
  })

  test("accepts a persisted steer target when the synthetic marker is not hydrated yet", () => {
    expect(
      manualSteerMessageMatchesTarget({
        message: { ...user("m1"), steerTargetTurnID: "turn-1" },
        parts: [],
        messageID: "m1",
        targetTurnID: "turn-1",
      }),
    ).toBe(true)
    expect(
      manualSteerMessageMatchesTarget({
        message: { ...user("m1"), steerTargetTurnID: "turn-2" },
        parts: [],
        messageID: "m1",
        targetTurnID: "turn-1",
      }),
    ).toBe(false)
    // 没有 steer 目标的普通 user 即使 ID 相同，也不能冒充已接受的引导。
    expect(
      manualSteerMessageMatchesTarget({
        message: user("m1"),
        parts: [],
        messageID: "m1",
        targetTurnID: "turn-1",
      }),
    ).toBe(false)
  })

  test("reuses the persisted message id when a steer is retried", () => {
    expect(followupMessageID({ id: "local-1", messageID: "message-1" })).toBe("message-1")
    // 首次真正发送使用当下生成的 ID；一旦已持久化，后续重试仍优先复用原 messageID。
    expect(followupMessageID({ id: "queued-before-assistant" }, "message-after-assistant")).toBe(
      "message-after-assistant",
    )
    // 历史 followup.v1 草稿没有 messageID，继续复用原本就按 message 规则生成的本地 ID。
    expect(followupMessageID({ id: "legacy-message-1" })).toBe("legacy-message-1")
  })

  test("sends an older recovered steer before a newly requested steer", () => {
    const recovered = { id: "steer-old", manualSteer: true, text: "先处理这条恢复引导" }
    const newer = { id: "steer-new", manualSteer: true, text: "再处理新引导" }
    // 普通队列不能抢占引导，同类引导之间则严格保持恢复后的原始到达顺序。
    expect(nextFollowupToSend([{ id: "queue-1", text: "普通队列" }, recovered, newer])).toBe(recovered)
  })

  test("restores an unacknowledged steer immediately when the user stops", () => {
    const pending = {
      messageID: "message-1",
      recovery: { item: { id: "draft-1", text: "继续" }, index: 0 },
    }
    expect(pauseManualSteerState({ items: [{ id: "draft-2", text: "普通队列" }], pending })).toEqual({
      items: [pending.recovery.item, { id: "draft-2", text: "普通队列" }],
      optimisticMessageID: "message-1",
    })
    expect(
      pauseManualSteerState({
        items: [{ id: "draft-2", text: "普通队列" }],
        pending: { ...pending, acknowledged: true },
      }),
    ).toEqual({
      items: [{ id: "draft-2", text: "普通队列" }],
      optimisticMessageID: "message-1",
    })
    expect(pauseManualSteerState({ items: [{ id: "draft-2" }] })).toEqual({
      items: [{ id: "draft-2" }],
      optimisticMessageID: undefined,
    })
  })

  test("does not let a late steer ack rebuild state after abort", () => {
    expect(
      followupPostAckCanTrack({
        paused: true,
        draftGeneration: 1,
        currentGeneration: 2,
      }),
    ).toBe(false)
    expect(
      followupPostAckCanTrack({
        paused: false,
        draftGeneration: 1,
        currentGeneration: 2,
      }),
    ).toBe(false)
    expect(
      followupPostAckCanTrack({
        paused: false,
        draftGeneration: 2,
        currentGeneration: 2,
      }),
    ).toBe(true)
  })

  test("rechecks the real follow-up lifecycle before crossing the network boundary", () => {
    const idle = {
      inferredBusy: false,
      statusBusy: false,
      followupReady: true,
      sendingMessageID: "message-current",
      allowActiveTurn: false,
    }
    // 普通队列在权限预检期间出现新任务时必须停下；direct steer 则允许把当前消息注入这个活动回合。
    expect(followupSendGateWorking({ ...idle, inferredBusy: true })).toBe(true)
    expect(followupSendGateWorking({ ...idle, statusBusy: true, allowActiveTurn: true })).toBe(false)
    // 当前 steer 自己刚建立的顺序锁可以通过，其它消息的锁和未完成 hydration 必须继续拦截。
    expect(followupSendGateWorking({ ...idle, pendingMessageID: "message-current", allowActiveTurn: true })).toBe(false)
    expect(followupSendGateWorking({ ...idle, pendingMessageID: "message-older", allowActiveTurn: true })).toBe(true)
    expect(followupSendGateWorking({ ...idle, followupReady: false, allowActiveTurn: true })).toBe(true)

    const open = {
      lifecycleOwned: true,
      paused: false,
      draftGeneration: 3,
      currentGeneration: 3,
      working: false,
    }
    expect(followupSendGateOpen(open)).toBe(true)
    expect(followupSendGateOpen({ ...open, lifecycleOwned: false })).toBe(false)
    expect(followupSendGateOpen({ ...open, paused: true })).toBe(false)
    // 停止完成后的未 ACK 恢复项是暂停态唯一的自动发送例外。
    expect(followupSendGateOpen({ ...open, paused: true, resumeAfterAbort: true })).toBe(true)
    expect(followupSendGateOpen({ ...open, currentGeneration: 4 })).toBe(false)
    expect(followupSendGateOpen({ ...open, working: true })).toBe(false)
  })

  test("lets consecutive steers cross the network boundary after each durable ACK", () => {
    const registry = createFollowupSendClaimRegistry()
    const pending = [{ messageID: "message-first", acknowledged: true }]

    // 第一条 ACK 后会话 claim 立即交给第二条；第一条仍在等 assistant 终态，但已不再占用发送顺序锁。
    expect(registry.claim("session-1", "draft-first")).toBe(true)
    expect(registry.release("session-1", "draft-first")).toBe(true)
    expect(registry.claim("session-1", "draft-second")).toBe(true)
    expect(manualSteerSendBlocker(pending, "message-second")).toBeUndefined()
    expect(
      followupSendGateWorking({
        inferredBusy: true,
        statusBusy: true,
        followupReady: true,
        pendingMessageID: manualSteerSendBlocker(pending, "message-second"),
        sendingMessageID: "message-second",
        allowActiveTurn: true,
      }),
    ).toBe(false)

    // ACK 前的旧请求仍然是硬阻塞，第二条不能越过真正尚未落库的第一条。
    expect(manualSteerSendBlocker([{ messageID: "message-first" }], "message-second")).toBe("message-first")
  })

  test("removes a stop-restored steer as soon as its durable ACK arrives", () => {
    const restored = {
      id: "draft-steer",
      manualSteer: true,
      messageID: "message-steer",
      prompt: "继续" as const,
    }
    const queued = { id: "draft-next", prompt: "下一条" as const }

    // 停止回调可能先把已发送草稿恢复到暂停队列；官方 jB 收到 ACK 后仍必须先删除它，再推进后续边界。
    expect(followupsAfterSendAck([restored, queued], restored.id, restored.messageID, 123)).toEqual([
      { ...queued, afterMessageID: restored.messageID, afterMessageCreated: 123 },
    ])
  })

  test("polls durable ACK with one confirmation signal until the message appears", async () => {
    const signals: AbortSignal[] = []
    let attempts = 0

    const confirmed = await confirmFollowupMessagePersisted({
      read: async (signal) => {
        signals.push(signal)
        attempts += 1
        return attempts === 3
      },
      timeoutMs: 500,
      intervalMs: 1,
    })

    // 整个确认窗口复用一个取消信号；普通延迟 ACK 仍保持原有轮询并在第三次读取成功。
    expect(confirmed).toBe(true)
    expect(attempts).toBe(3)
    expect(signals.every((signal) => signal === signals[0])).toBe(true)
    expect(signals[0]?.aborted).toBe(false)
  })

  test("hard-times out a durable ACK read that never settles", async () => {
    let readSignal: AbortSignal | undefined
    let guardTimeoutID: ReturnType<typeof globalThis.setTimeout> | undefined
    const confirmation = confirmFollowupMessagePersisted({
      read: (signal) => {
        readSignal = signal
        return new Promise<boolean>(() => undefined)
      },
      timeoutMs: 20,
      intervalMs: 1,
    })

    // read 即使永久 pending，官方请求式硬 deadline 也必须先 abort，再让确认路径继续返回 false。
    const result = await Promise.race([
      confirmation,
      new Promise<"guard">((resolve) => {
        guardTimeoutID = globalThis.setTimeout(() => resolve("guard"), 500)
      }),
    ])
    if (guardTimeoutID !== undefined) globalThis.clearTimeout(guardTimeoutID)
    expect(result).toBe(false)
    expect(readSignal?.aborted).toBe(true)
    expect(readSignal?.reason).toBeInstanceOf(DOMException)
  })

  test("treats transient session busy errors as retryable follow-up send failures", () => {
    expect(followupFailureIsRetryableBusy(new Error("Session ses_1 is busy"))).toBe(true)
    expect(followupFailureIsRetryableBusy(new Error("Runner is busy"))).toBe(true)
    expect(followupFailureIsRetryableBusy(new Error("rate limited"))).toBe(false)
  })

  test("labels dock items as queued only while the session is busy", () => {
    expect(followupDockMode({ busy: true })).toBe("queued")
    expect(followupDockMode({ busy: false })).toBe("ready")
    expect(followupDockMode({ busy: false, paused: true })).toBe("paused")
    expect(followupDockMode({ busy: false, failed: true })).toBe("failed")
  })

  test("marks only later unanswered user messages as queued behind an in-flight assistant", () => {
    expect(isQueuedUserMessage([user("u1"), assistant({ id: "a1", parentID: "u1" }), user("u2")], "u2")).toBe(true)
    expect(isQueuedUserMessage([user("u1"), assistant({ id: "a1", parentID: "u1" })], "u1")).toBe(false)
  })

  test("does not expose delete for sent steered messages after their assistant turn appears", () => {
    expect(
      isQueuedUserMessage(
        [
          user("u1"),
          assistant({ id: "a1", parentID: "u1" }),
          user("u2"),
          assistant({ id: "a2", parentID: "u2", completed: true }),
        ],
        "u2",
      ),
    ).toBe(false)
  })

  test("does not expose delete for legacy steered messages without direct assistant parent", () => {
    expect(
      isQueuedUserMessage([user("u1"), assistant({ id: "a1", parentID: "u1" }), user("u2")], "u2", {
        steered: true,
      }),
    ).toBe(false)
  })

  test("does not mark a message sent after a completed tool-calls turn as queued", () => {
    // 完成的工具轮:中间 tool-calls 步(非 terminal)后跟最终 stop 步(terminal),都属 u1。之后用户发 u2:
    // 此时 u2 才是正在处理的新回合,不应被当作排在 u1 后面的可撤销队列项,否则点删除会丢失刚发的 u2。
    expect(
      isQueuedUserMessage(
        [
          user("u1"),
          assistant({ id: "a1", parentID: "u1", finish: "tool-calls" }),
          assistant({ id: "a2", parentID: "u1", finish: "stop" }),
          user("u2"),
        ],
        "u2",
      ),
    ).toBe(false)
  })

  test("still marks a message queued behind a genuinely in-flight tool-calls step", () => {
    // 真正在途:最新 assistant 是 tool-calls 步(非 terminal),u2 排在其后 → 应判为可撤销排队项。
    expect(
      isQueuedUserMessage(
        [user("u1"), assistant({ id: "a1", parentID: "u1", finish: "tool-calls" }), user("u2")],
        "u2",
      ),
    ).toBe(true)
  })

  test("marks a later message queued even when its id sorts before the in-flight remote parent", () => {
    // 排队关系取决于时间线位置，不能由 msg_remote_<hash> 与本地递增 ID 的字典序决定。
    const remoteID = "msg_remote_ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
    const newerID = "msg_f645ca787001MekQG2E4456W4P"
    expect(
      isQueuedUserMessage(
        [
          user(remoteID, 1),
          assistant({ id: "msg_f644872ca001mxjrcJeyE5IFgS", parentID: remoteID, created: 2 }),
          user(newerID, 3),
        ],
        newerID,
      ),
    ).toBe(true)
  })

  test("detects follow-up drafts already sent in existing user messages", () => {
    expect(
      followupDraftAlreadySent({
        draftText: "测试",
        messages: [user("u1"), user("u2")],
        partsByMessage: {
          u1: [textPart({ id: "p1", messageID: "u1", text: "别的消息" })],
          u2: [textPart({ id: "p2", messageID: "u2", text: "测试" })],
        },
      }),
    ).toBe(true)
  })

  test("does not let an optimistic steer deduplicate its own queued request before send", () => {
    const messages = [user("root"), user("steer-current")]
    const partsByMessage = {
      root: [textPart({ id: "p-root", messageID: "root", text: "原始请求" })],
      "steer-current": [textPart({ id: "p-steer", messageID: "steer-current", text: "同回合引导" })],
    }

    // optimistic user 只是官方式即时展示；忽略自身稳定 ID 后，队列项必须继续走到 POST /steer。
    expect(
      followupDraftAlreadySent({
        draftText: "同回合引导",
        afterMessageID: "root",
        messages,
        partsByMessage,
        ignoredMessageIDs: new Set(["steer-current"]),
      }),
    ).toBe(false)

    // 只豁免当前 steer；后续若真有另一条同文 user，普通队列去重仍必须生效。
    expect(
      followupDraftAlreadySent({
        draftText: "同回合引导",
        afterMessageID: "root",
        messages: [...messages, user("persisted-duplicate")],
        partsByMessage: {
          ...partsByMessage,
          "persisted-duplicate": [
            textPart({ id: "p-duplicate", messageID: "persisted-duplicate", text: "同回合引导" }),
          ],
        },
        ignoredMessageIDs: new Set(["steer-current"]),
      }),
    ).toBe(true)
  })

  test("does not swallow a repeated queue draft behind an optimistic user", () => {
    const messages = [user("root"), user("queued-1")]
    const partsByMessage = {
      root: [textPart({ id: "p-root", messageID: "root", text: "原始请求" })],
      "queued-1": [textPart({ id: "p-queued", messageID: "queued-1", text: "重复引导" })],
    }

    // 普通队列发送也会先写 optimistic user；认领集合中的消息不代表第二条同文案已经发送。
    expect(
      followupDraftAlreadySent({
        draftText: "重复引导",
        afterMessageID: "root",
        messages,
        partsByMessage,
        ignoredMessageIDs: new Set(["queued-1"]),
      }),
    ).toBe(false)
  })

  test("does not treat earlier same-text messages as a sent queued draft", () => {
    expect(
      followupDraftAlreadySent({
        draftText: "测试",
        afterMessageID: "u2",
        messages: [user("u1", 1), user("u2", 2)],
        partsByMessage: {
          u1: [textPart({ id: "p1", messageID: "u1", text: "测试" })],
          u2: [textPart({ id: "p2", messageID: "u2", text: "其他" })],
        },
      }),
    ).toBe(false)
  })

  test("detects a sent draft after a remote boundary when the newer id sorts first", () => {
    // afterMessageID 只定位边界，匹配范围按消息数组中的真实先后截取。
    const remoteID = "msg_remote_ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
    const newerID = "msg_f645ca787001MekQG2E4456W4P"
    expect(
      followupDraftAlreadySent({
        draftText: "测试",
        afterMessageID: remoteID,
        messages: [user(remoteID, 1), user(newerID, 2)],
        partsByMessage: {
          [remoteID]: [textPart({ id: "p-remote", messageID: remoteID, text: "其他" })],
          [newerID]: [textPart({ id: "p-newer", messageID: newerID, text: "测试" })],
        },
      }),
    ).toBe(true)
  })

  test("uses the persisted creation boundary after a remote id slides out of the history window", () => {
    // 最新后缀不再包含 msg_remote_* 边界时，创建时间仍能排除边界前历史并识别边界后的手机消息。
    const remoteID = "msg_remote_ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
    const newerID = "msg_f645ca787001MekQG2E4456W4P"
    const partsByMessage = {
      old: [textPart({ id: "p-old", messageID: "old", text: "测试" })],
      [newerID]: [textPart({ id: "p-newer", messageID: newerID, text: "测试" })],
    }

    expect(
      followupDraftAlreadySent({
        draftText: "测试",
        afterMessageID: remoteID,
        afterMessageCreated: 100,
        messages: [user("old", 50)],
        partsByMessage,
      }),
    ).toBe(false)
    expect(
      followupDraftAlreadySent({
        draftText: "测试",
        afterMessageID: remoteID,
        afterMessageCreated: 100,
        messages: [user("old", 50), user(newerID, 200)],
        partsByMessage,
      }),
    ).toBe(true)
  })

  test("uses message id only as a same-millisecond boundary tie-breaker", () => {
    // 创建时间相同时遵循统一的 (created,id) 游标，边界前同文案不能误删仍未发送的队列项。
    const boundaryID = "msg_000000000002Boundary"
    const earlierID = "msg_000000000001Earlier"
    const laterID = "msg_000000000003Later"
    const partsByMessage = {
      [earlierID]: [textPart({ id: "p-earlier", messageID: earlierID, text: "测试" })],
      [laterID]: [textPart({ id: "p-later", messageID: laterID, text: "测试" })],
    }

    expect(
      followupDraftAlreadySent({
        draftText: "测试",
        afterMessageID: boundaryID,
        afterMessageCreated: 100,
        messages: [user(earlierID, 100)],
        partsByMessage,
      }),
    ).toBe(false)
    expect(
      followupDraftAlreadySent({
        draftText: "测试",
        afterMessageID: boundaryID,
        afterMessageCreated: 100,
        messages: [user(laterID, 100)],
        partsByMessage,
      }),
    ).toBe(true)
  })

  test("treats matching suffix messages as sent for legacy drafts without boundary time", () => {
    // followup.v1 旧草稿既没有 afterMessageID 也没有创建时间，只能优先防止当前后缀里的请求被重复执行。
    expect(
      followupDraftAlreadySent({
        draftText: "测试",
        messages: [user("new-user", 200)],
        partsByMessage: {
          "new-user": [textPart({ id: "p-new", messageID: "new-user", text: "测试" })],
        },
      }),
    ).toBe(true)
  })

  test("does not let history loaded before an empty-session queue boundary swallow a new draft", () => {
    // 入队时没有可用消息 ID 时，afterMessageCreated 代表队列创建时刻，只匹配此后出现的用户消息。
    expect(
      followupDraftAlreadySent({
        draftText: "测试",
        afterMessageCreated: 100,
        messages: [user("old-user", 50)],
        partsByMessage: {
          "old-user": [textPart({ id: "p-old", messageID: "old-user", text: "测试" })],
        },
      }),
    ).toBe(false)
  })

  test("keeps a queued draft when a paged-out remote boundary has no creation timestamp", () => {
    expect(
      unsentFollowupDrafts({
        drafts: [{ id: "q-remote", afterMessageID: "remote-boundary", text: "测试" }],
        draftText: (draft) => draft.text,
        afterMessageID: (draft) => draft.afterMessageID,
        messages: [
          {
            ...user("remote-message-after"),
            time: { created: 20 },
          },
        ],
        partsByMessage: {
          "remote-message-after": [textPart({ id: "p-remote", messageID: "remote-message-after", text: "测试" })],
        },
      }),
    ).toEqual([{ id: "q-remote", afterMessageID: "remote-boundary", text: "测试" }])
  })

  test("uses the persisted creation timestamp when a paged-out boundary has a non-sortable ID", () => {
    expect(
      unsentFollowupDrafts({
        drafts: [{ id: "q-remote", afterMessageID: "z-boundary", afterMessageCreated: 100, text: "测试" }],
        draftText: (draft) => draft.text,
        afterMessageID: (draft) => draft.afterMessageID,
        afterMessageCreated: (draft) => draft.afterMessageCreated,
        messages: [
          {
            ...user("a-message-after"),
            time: { created: 101 },
          },
        ],
        partsByMessage: {
          "a-message-after": [textPart({ id: "p-remote", messageID: "a-message-after", text: "测试" })],
        },
      }),
    ).toEqual([])
  })

  test("keeps a paged-out boundary draft when candidate messages share its timestamp", () => {
    expect(
      unsentFollowupDrafts({
        drafts: [{ id: "q-remote", afterMessageID: "z-boundary", afterMessageCreated: 100, text: "测试" }],
        draftText: (draft) => draft.text,
        afterMessageID: (draft) => draft.afterMessageID,
        afterMessageCreated: (draft) => draft.afterMessageCreated,
        messages: [
          {
            ...user("a-message-after"),
            time: { created: 100 },
          },
        ],
        partsByMessage: {
          "a-message-after": [textPart({ id: "p-remote", messageID: "a-message-after", text: "测试" })],
        },
      }),
    ).toEqual([{ id: "q-remote", afterMessageID: "z-boundary", afterMessageCreated: 100, text: "测试" }])
  })

  test("detects sent skill follow-ups by stored skill arguments", () => {
    expect(
      followupDraftAlreadySent({
        draftText: "测试",
        messages: [user("u1")],
        partsByMessage: {
          u1: [textPart({ id: "p1", messageID: "u1", text: "/skill-creator 测试", skillArguments: "测试" })],
        },
      }),
    ).toBe(true)
  })

  test("matches identical sent follow-up text one message at a time", () => {
    expect(
      unsentFollowupDrafts({
        drafts: [
          { id: "q1", text: "5" },
          { id: "q2", text: "5" },
        ],
        draftText: (draft) => draft.text,
        messages: [user("q1"), user("u1")],
        partsByMessage: {
          u1: [textPart({ id: "p1", messageID: "u1", text: "5" })],
        },
      }),
    ).toEqual([{ id: "q2", text: "5" }])
  })

  test("keeps a repeated queued draft when the same text only exists before its queue boundary", () => {
    expect(
      unsentFollowupDrafts({
        drafts: [{ id: "q1", afterMessageID: "u2", text: "测试" }],
        draftText: (draft) => draft.text,
        afterMessageID: (draft) => draft.afterMessageID,
        messages: [user("u1"), user("u2")],
        partsByMessage: {
          u1: [textPart({ id: "p1", messageID: "u1", text: "测试" })],
          u2: [textPart({ id: "p2", messageID: "u2", text: "其他" })],
        },
      }),
    ).toEqual([{ id: "q1", afterMessageID: "u2", text: "测试" }])
  })

  test("removes a repeated queued draft once the same text appears after its queue boundary", () => {
    expect(
      unsentFollowupDrafts({
        drafts: [{ id: "q1", afterMessageID: "u2", text: "测试" }],
        draftText: (draft) => draft.text,
        afterMessageID: (draft) => draft.afterMessageID,
        messages: [user("u1"), user("u2"), user("u3")],
        partsByMessage: {
          u1: [textPart({ id: "p1", messageID: "u1", text: "测试" })],
          u2: [textPart({ id: "p2", messageID: "u2", text: "其他" })],
          u3: [textPart({ id: "p3", messageID: "u3", text: "测试" })],
        },
      }),
    ).toEqual([])
  })

  test("removes a queued draft after a remote boundary even when the newer id sorts first", () => {
    // 持久化队列恢复时同样按边界位置去重，避免把已经发送的手机消息再次自动发送。
    const remoteID = "msg_remote_ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
    const newerID = "msg_f645ca787001MekQG2E4456W4P"
    expect(
      unsentFollowupDrafts({
        drafts: [{ id: "q1", afterMessageID: remoteID, text: "测试" }],
        draftText: (draft) => draft.text,
        afterMessageID: (draft) => draft.afterMessageID,
        messages: [user(remoteID, 1), user(newerID, 2)],
        partsByMessage: {
          [remoteID]: [textPart({ id: "p-remote", messageID: remoteID, text: "其他" })],
          [newerID]: [textPart({ id: "p-newer", messageID: newerID, text: "测试" })],
        },
      }),
    ).toEqual([])
  })

  test("removes a sent draft when its persisted boundary slid out of the latest suffix", () => {
    // 边界 ID 已不在窗口内时按 afterMessageCreated 过滤，不能退回远端 ID 的字典序判断。
    const remoteID = "msg_remote_ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
    const newerID = "msg_f645ca787001MekQG2E4456W4P"
    expect(
      unsentFollowupDrafts({
        drafts: [{ id: "q1", afterMessageID: remoteID, afterMessageCreated: 100, text: "测试" }],
        draftText: (draft) => draft.text,
        afterMessageID: (draft) => draft.afterMessageID,
        afterMessageCreated: (draft) => draft.afterMessageCreated,
        messages: [user("old", 50), user(newerID, 200)],
        partsByMessage: {
          old: [textPart({ id: "p-old", messageID: "old", text: "测试" })],
          [newerID]: [textPart({ id: "p-newer", messageID: newerID, text: "测试" })],
        },
      }),
    ).toEqual([])
  })

  test("removes legacy persisted drafts after the same text appears in the loaded suffix", () => {
    // 旧 followup.v1 的 draft.id 从未作为真实消息落库；找不到边界时仍要消除已经出现的同文案 user。
    expect(
      unsentFollowupDrafts({
        drafts: [{ id: "q-legacy", text: "继续" }],
        draftText: (draft) => draft.text,
        messages: [user("new-user", 200)],
        partsByMessage: {
          "new-user": [textPart({ id: "p-new", messageID: "new-user", text: "继续" })],
        },
      }),
    ).toEqual([])
  })

  test("uses the safe suffix fallback when a legacy explicit boundary is no longer loaded", () => {
    // 旧持久化项可能有 afterMessageID 却没有 afterMessageCreated；后缀命中时优先避免自动重发。
    expect(
      unsentFollowupDrafts({
        drafts: [{ id: "q-legacy", afterMessageID: "missing-boundary", text: "继续" }],
        draftText: (draft) => draft.text,
        afterMessageID: (draft) => draft.afterMessageID,
        messages: [user("new-user", 200)],
        partsByMessage: {
          "new-user": [textPart({ id: "p-new", messageID: "new-user", text: "继续" })],
        },
      }),
    ).toEqual([])
  })

  test("keeps later identical queued drafts after the previous queued draft is sent", () => {
    expect(
      unsentFollowupDrafts({
        drafts: [{ id: "q2", afterMessageID: "u1", text: "测试" }],
        draftText: (draft) => draft.text,
        afterMessageID: (draft) => draft.afterMessageID,
        messages: [user("u1")],
        partsByMessage: {
          u1: [textPart({ id: "p1", messageID: "u1", text: "测试" })],
        },
      }),
    ).toEqual([{ id: "q2", afterMessageID: "u1", text: "测试" }])
  })

  test("does not let the currently awaited follow-up remove the next identical queued item", () => {
    expect(
      unsentFollowupDrafts({
        drafts: [{ id: "q2", text: "5" }],
        draftText: (draft) => draft.text,
        messages: [user("u1")],
        partsByMessage: {
          u1: [textPart({ id: "p1", messageID: "u1", text: "5" })],
        },
        ignoredMessageIDs: new Set(["u1"]),
      }),
    ).toEqual([{ id: "q2", text: "5" }])
  })

  test("removes queued drafts once the same user message is observed in history", () => {
    expect(
      unsentFollowupDrafts({
        drafts: [{ id: "q1", text: "继续" }],
        draftText: (draft) => draft.text,
        messages: [user("q1"), user("u1")],
        partsByMessage: {
          u1: [textPart({ id: "p1", messageID: "u1", text: "继续" })],
        },
      }),
    ).toEqual([])
  })
})

describe("悬空 running 工具不该永久锁住处理态", () => {
  // 后端进程被杀/崩溃时，最后一条 assistant 会留下一个永远停在 status=running 的 tool part。
  // 判活谓词此前对 running 工具没有任何时间上限，于是 working() 恒为真：
  // 「处理中」不回落、停止按钮 ■ 不切回发送，用户只能手动点终止。
  // 这也正是「任务输出完还在思考中」那条反馈的形态之一。
  const withRunningTool = (created: number) => ({
    message: assistant({ id: "msg_a", parentID: "msg_u", created, finish: "tool-calls" }),
    parts: [toolPart({ id: "prt_1", messageID: "msg_a", status: "running" })] as Part[],
  })

  test("会话仍 busy 时，长时间运行的工具照旧算活跃（不能误伤真正的长工具）", () => {
    const { message, parts } = withRunningTool(0)
    const now = STALE_ASSISTANT_RUNNING_MS * 10
    expect(assistantTurnActive(message, { statusBusy: true, now, parts })).toBe(true)
  })

  test("会话已 idle 且 running 超过兜底时限时，不再算活跃", () => {
    const { message, parts } = withRunningTool(0)
    const now = STALE_ASSISTANT_RUNNING_MS + 60_000
    expect(assistantTurnActive(message, { statusBusy: false, now, parts })).toBe(false)
  })

  test("会话已 idle 但还在兜底时限内时仍算活跃（后端可能只是没来得及发状态）", () => {
    const { message, parts } = withRunningTool(0)
    const now = STALE_ASSISTANT_RUNNING_MS - 60_000
    expect(assistantTurnActive(message, { statusBusy: false, now, parts })).toBe(true)
  })
})

describe("statusBusy 未知(undefined)不能被当成已确认 idle 去撤销运行证据", () => {
  // bootstrap/深链/刷新窗口里 session_status 还没同步下来，调用方此时必须传 undefined，
  // 不能折叠成 false——30 分钟兜底只有明确读到「已确认 idle」才允许撤销运行证据。
  // 两个维度独立命中同一个回归：上面的 runningEvidenceCredible 本身要求真三态；
  // 这里补的是 30 分钟兜底末尾那条独立判据，此前没有任何调用方/测试走到过 undefined。
  test("状态未知 + 有 running 工具证据时，即使远超 30 分钟仍算活跃", () => {
    const message = assistant({ id: "msg_a", parentID: "msg_u", created: 0, finish: "tool-calls" })
    const parts = [toolPart({ id: "prt_1", messageID: "msg_a", status: "running" })] as Part[]
    const now = STALE_ASSISTANT_RUNNING_MS * 10
    expect(assistantTurnActive(message, { statusBusy: undefined, now, parts })).toBe(true)
  })

  test("状态未知、没有任何 part 证据的普通非终态消息，在 30 分钟兜底内仍算活跃", () => {
    // 变异验证：把 assistantTurnActive 里 `options?.statusBusy === false` 改回
    // `!options?.statusBusy`，这条断言会从 true 变 false。
    const message = assistant({ id: "msg_a", parentID: "msg_u", created: 0 })
    const now = 20 * 60_000
    expect(assistantTurnActive(message, { statusBusy: undefined, now })).toBe(true)
  })

  test("状态未知但超过 30 分钟兜底时限后，不再算活跃", () => {
    const message = assistant({ id: "msg_a", parentID: "msg_u", created: 0 })
    const now = STALE_ASSISTANT_RUNNING_MS + 60_000
    expect(assistantTurnActive(message, { statusBusy: undefined, now })).toBe(false)
  })
})

describe("稀疏 session status 必须区分快照未加载和已确认 idle", () => {
  test("快照未加载时缺失 key 保持未知", () => {
    expect(resolvedSessionStatusBusy({ status: undefined, snapshotReady: false })).toBeUndefined()
  })

  test("空快照加载完成后缺失 key 明确表示 idle", () => {
    expect(resolvedSessionStatusBusy({ status: undefined, snapshotReady: true })).toBe(false)
  })

  test("单会话 idle 事件只确认自己的缺失 key", () => {
    expect(resolvedSessionStatusBusy({ status: undefined, snapshotReady: false, sessionKnown: true })).toBe(false)
    expect(resolvedSessionStatusBusy({ status: undefined, snapshotReady: false, sessionKnown: false })).toBeUndefined()
  })

  test("活动 key 始终覆盖快照 ready 状态", () => {
    expect(resolvedSessionStatusBusy({ status: { type: "busy" }, snapshotReady: true })).toBe(true)
    expect(
      resolvedSessionStatusBusy({
        status: { type: "retry", attempt: 1, message: "retry", next: 0 },
        snapshotReady: false,
      }),
    ).toBe(true)
  })
})

describe("sessionHasRunningTurn/sessionHasStaleRunState 的 statusBusy 必须接受三态", () => {
  // 调用方（session.tsx runStateInput、sidebar-items.tsx、thread-row.tsx）现在会在
  // session_status 尚未加载时传 undefined；这里钉住 sessionHasRunningTurn 对三态的处理，
  // 防止未来有人把类型收窄回 boolean 又在调用处折叠成 false。
  test("statusBusy 为 undefined 且存在陈旧非终态 assistant 时，30 分钟内仍判定为运行中", () => {
    const message = assistant({ id: "msg_a", parentID: "msg_u", created: 0, finish: "tool-calls" })
    const parts = [toolPart({ id: "prt_1", messageID: "msg_a", status: "running" })] as Part[]
    expect(
      sessionHasRunningTurn({
        messages: [user("msg_u"), message],
        partsByMessage: { msg_a: parts },
        statusBusy: undefined,
        now: STALE_ASSISTANT_RUNNING_MS * 10,
      }),
    ).toBe(true)
  })
})

describe("消息时间线的判活必须接响应式 now", () => {
  // 用括号配平精确切出每处调用自己的实参列表，而不是跨全文的惰性正则通配。
  // 旧的 [\s\S]*? 不受括号边界约束，会跨过自己的调用去匹配文件里另一处的 now:，
  // 变异测试证实：删掉前两处调用自己的 now，正则仍然判过，只有最后一处能真正拦住回归。
  function callArgs(src: string, marker: string) {
    const start = src.indexOf(marker)
    if (start === -1) return undefined
    let depth = 0
    for (const ch of marker) {
      if (ch === "(" || ch === "{") depth++
      else if (ch === ")" || ch === "}") depth--
    }
    for (let i = start + marker.length; i < src.length; i++) {
      const ch = src[i]
      if (ch === "(" || ch === "{") depth++
      else if (ch === ")" || ch === "}") {
        depth--
        if (depth === 0) return src.slice(start, i + 1)
      }
    }
    return undefined
  }

  test("三处 memo 都把 now 传进判活谓词", async () => {
    // 45s / 30min 这些时间宽限只有在 memo 依赖里存在时间信号时才会到期重算；
    // 不传 now 会回落到 followup-queue 内部的 Date.now()，而 memo 不会因时间流逝重算，
    // 于是「处理中」冻结在 true，直到切会话或重载才释放。
    // session.tsx / sidebar-items.tsx 早已按此传参，这三处是漏网。
    const src = await Bun.file(new URL("./message-timeline.tsx", import.meta.url)).text()

    const assistantTurnActiveCall = callArgs(src, "assistantTurnActive(last, {")
    const latestAwaitingCall = callArgs(
      src,
      "latestAwaitingUserMessageID(sessionMessages(), props.parts ?? sync.data.part, {",
    )
    const hasAwaitingCall = callArgs(src, "hasAwaitingUserMessages(sessionMessages(), props.parts ?? sync.data.part, {")

    expect(assistantTurnActiveCall).toBeDefined()
    expect(assistantTurnActiveCall).toContain("now:")
    expect(latestAwaitingCall).toBeDefined()
    expect(latestAwaitingCall).toContain("now:")
    expect(hasAwaitingCall).toBeDefined()
    expect(hasAwaitingCall).toContain("now:")

    // 必须有一个真正会推进的时间信号，否则传了也等于常量。刻意不锁周期值（1_000 还是
    // 具名常量都行，改周期是无害调优），只锁"确实是 setInterval 驱动、回调里确实在读 Date.now()"。
    expect(src).toMatch(/setInterval\(\(\)\s*=>\s*set\w*Now\(Date\.now\(\)\)/)
  })
})

describe("压缩中判据", () => {
  const compactionPart = (input: { id: string; messageID: string; auto?: boolean }): Part =>
    ({
      id: input.id,
      sessionID: "ses_1",
      messageID: input.messageID,
      type: "compaction",
      auto: input.auto ?? true,
      overflow: false,
    }) as unknown as Part

  const summaryAssistant = (input: {
    id: string
    parentID: string
    created?: number
    completed?: boolean
    error?: boolean
    finish?: string
  }) =>
    ({
      ...assistant({
        id: input.id,
        parentID: input.parentID,
        created: input.created,
        completed: input.completed,
        error: input.error,
        finish: input.finish,
      }),
      summary: true,
    }) as AssistantMessage

  test("压缩摘要在途时为真", () => {
    expect(
      compactionInFlight({
        messages: [user("u1"), summaryAssistant({ id: "a1", parentID: "u1" })],
        partsByMessage: { u1: [compactionPart({ id: "p1", messageID: "u1" })] },
        statusBusy: true,
        now: 1,
      }),
    ).toBe(true)
  })

  test("finish=stop 但还没写 time.completed 时仍算在途（跟 compactionFinished 的终态口径对齐）", () => {
    // 与 UI 分割线共用的 compactionFinished 只看 time.completed/error，不看 finish；
    // compactionInFlight 若改用更宽松的 assistantTurnTerminal(把单纯 finish 也算终态)，
    // 这条会在 finish 已写但 completed 还没落的窗口提前把闸门解除，跟分割线仍显示「压缩中」自相矛盾。
    expect(
      compactionInFlight({
        messages: [user("u1"), summaryAssistant({ id: "a1", parentID: "u1", finish: "stop" })],
        partsByMessage: { u1: [compactionPart({ id: "p1", messageID: "u1" })] },
        statusBusy: true,
        now: 1,
      }),
    ).toBe(true)
  })

  test("压缩摘要收尾后为假", () => {
    expect(
      compactionInFlight({
        messages: [user("u1"), summaryAssistant({ id: "a1", parentID: "u1", completed: true })],
        partsByMessage: { u1: [compactionPart({ id: "p1", messageID: "u1" })] },
        statusBusy: true,
      }),
    ).toBe(false)
  })

  test("压缩失败也算收尾，闸门解除", () => {
    expect(
      compactionInFlight({
        messages: [user("u1"), summaryAssistant({ id: "a1", parentID: "u1", error: true })],
        partsByMessage: { u1: [compactionPart({ id: "p1", messageID: "u1" })] },
        statusBusy: true,
      }),
    ).toBe(false)
  })

  test("会话 idle 时为假（回合已中断）", () => {
    expect(
      compactionInFlight({
        messages: [user("u1"), summaryAssistant({ id: "a1", parentID: "u1" })],
        partsByMessage: { u1: [compactionPart({ id: "p1", messageID: "u1" })] },
        statusBusy: false,
      }),
    ).toBe(false)
  })

  test("历史回合的压缩不触发闸门", () => {
    expect(
      compactionInFlight({
        messages: [
          user("u1"),
          summaryAssistant({ id: "a1", parentID: "u1", completed: true }),
          user("u2"),
          assistant({ id: "a2", parentID: "u2" }),
        ],
        partsByMessage: { u1: [compactionPart({ id: "p1", messageID: "u1" })] },
        statusBusy: true,
      }),
    ).toBe(false)
  })

  test("数据缺失时不误锁", () => {
    expect(compactionInFlight({ messages: [], partsByMessage: {}, statusBusy: true })).toBe(false)
    expect(
      compactionInFlight({
        messages: [user("u1"), summaryAssistant({ id: "a1", parentID: "u1" })],
        partsByMessage: {},
        statusBusy: true,
      }),
    ).toBe(false)
  })

  test("手动压缩（auto: false）在途时也返回真", () => {
    expect(
      compactionInFlight({
        messages: [user("u1"), summaryAssistant({ id: "a1", parentID: "u1" })],
        partsByMessage: { u1: [compactionPart({ id: "p1", messageID: "u1", auto: false })] },
        statusBusy: true,
        now: 1,
      }),
    ).toBe(true)
  })

  test("悬空压缩摘要超过兜底时限后不再锁死闸门", () => {
    // 后端进程被杀时摘要永远收不到 completed/error；跟 assistantTurnActive 的
    // STALE_ASSISTANT_RUNNING_MS 兜底同源，超时后宁可漏拦也不能让输入框永久卡住。
    const created = 1
    expect(
      compactionInFlight({
        messages: [user("u1"), summaryAssistant({ id: "a1", parentID: "u1", created })],
        partsByMessage: { u1: [compactionPart({ id: "p1", messageID: "u1" })] },
        statusBusy: true,
        now: created + STALE_ASSISTANT_RUNNING_MS + 1,
      }),
    ).toBe(false)
  })

  test("悬空压缩摘要在兜底时限内仍锁着闸门", () => {
    const created = 1
    expect(
      compactionInFlight({
        messages: [user("u1"), summaryAssistant({ id: "a1", parentID: "u1", created })],
        partsByMessage: { u1: [compactionPart({ id: "p1", messageID: "u1" })] },
        statusBusy: true,
        now: created + STALE_ASSISTANT_RUNNING_MS - 1,
      }),
    ).toBe(true)
  })

  test("摘要 assistant 尚未创建的首窗：只看最后一条 assistant，暂不算压缩中（宁可漏拦，取舍方向钉住）", () => {
    // 后端把 compaction part 挂在触发压缩的新用户消息上，摘要 assistant 稍后才创建；
    // 在它落地之前 messages 里最后一条 assistant 还是上一回合的普通终态消息。
    // 这是设计里认可的"漏拦"窗口——反方向的风险是有人把判据从"最后一条 assistant"
    // 改成 messages.findLast(m => m.summary) 或"只要最新 user 带 compaction part 就算压缩中"，
    // 那样闸门会变成粘性（压缩结束后 summary 仍是历史里最后一条 summary，永不解除）。
    expect(
      compactionInFlight({
        messages: [
          user("u1"),
          assistant({ id: "a1", parentID: "u1", completed: true }),
          user("u2"), // 触发压缩的新用户消息，摘要 assistant 还没创建
        ],
        partsByMessage: { u2: [compactionPart({ id: "p2", messageID: "u2" })] },
        statusBusy: true,
      }),
    ).toBe(false)
  })

  test("陈旧摘要仍是最后一条 assistant、新回合已 busy 但新 assistant 还没落地：当前行为按兜底时限内继续锁着（写死现状，供后续有意识打破）", () => {
    // 场景对应本 PR 修的同一类残留：摘要 assistant 因后端进程被杀，既无 completed 也无 error。
    // 用户重载后看到的闸门是开的（statusBusy=false），随后发新消息、statusBusy 翻 true，
    // 但新 assistant 尚未创建——陈旧摘要仍是 messages 里"最后一条 assistant"（新用户消息
    // 不会挤掉它），于是在兜底时限内闸门会重新锁上，直到新 assistant 落地或超时。
    const created = 1
    const messages = [
      user("u1"),
      summaryAssistant({ id: "a1", parentID: "u1", created }),
      user("u2"),
    ]
    const partsByMessage = { u1: [compactionPart({ id: "p1", messageID: "u1" })] }
    expect(compactionInFlight({ messages, partsByMessage, statusBusy: true, now: created + 1000 })).toBe(true)
  })
})

describe("压缩中的发送路径", () => {
  test("压缩中不走引导", () => {
    expect(
      followupShouldUseSteer({
        manual: true,
        manualSteerDraft: true,
        targetTurnID: "turn_1",
        inferredBusy: true,
        statusBusy: true,
        pendingManualSteer: false,
        compacting: true,
      }),
    ).toBe(false)
  })

  test("非压缩中引导语义不变", () => {
    expect(
      followupShouldUseSteer({
        manual: true,
        manualSteerDraft: true,
        targetTurnID: "turn_1",
        inferredBusy: true,
        statusBusy: true,
        pendingManualSteer: false,
        compacting: false,
      }),
    ).toBe(true)
  })

  test("压缩中一律入队", () => {
    expect(
      followupShouldQueueInput({
        queueingEnabled: false,
        inferredBusy: false,
        statusBusy: false,
        manualSteerWaiting: false,
        compacting: true,
      }),
    ).toBe(true)
  })

  test("非压缩中入队语义不变", () => {
    expect(
      followupShouldQueueInput({
        queueingEnabled: false,
        inferredBusy: false,
        statusBusy: false,
        manualSteerWaiting: false,
        compacting: false,
      }),
    ).toBe(false)
  })

  // 「压缩开始时已在队列里的消息不会被自动发出」这条结论，实际靠的不是压缩闸门本身，
  // 而是既有的 followupCanAutoSend 要求 inferredBusy 和 statusBusy 双 idle——压缩期间
  // statusBusy 恒为 true，所以是"碰巧被另一道闸门挡住"（该依赖已由上面「auto-sends queued
  // follow-ups only after both run-state signals are idle」钉住，此处不再重复断言，
  // 只留意图注记：若那条测试将来被放宽为允许 statusBusy 时自动发送，这里的压缩闸门
  // 拦不住它，需要回头补一条压缩专属的组合测试）。

  // 时序缺口：promoteFollowupToSteer 在 session.tsx 里同步 stage 乐观气泡，随后 sendFollowup
  // 才异步重算 compacting。入口守卫（promote-guard 测试钉的那条）只挡"点击时已在压缩"，
  // 挡不住"点击后、发送前才开始压缩"——这条测试把两次决策点分开调用同一个纯函数，
  // 直接验证：只要 sendFollowup 在真正发送前重新读一次最新的 compacting 状态，
  // 即使 promote 时刻已经把气泡按 steer 乐观展示，发送仍会正确降级为普通 prompt 而不是硬发 steer。
  test("promote 时未压缩、send 时才压缩：同一份引导意图前后两次判定必须得出不同结果", () => {
    const steerInput = {
      manual: true,
      manualSteerDraft: true,
      targetTurnID: "turn_1",
      inferredBusy: true,
      statusBusy: true,
      pendingManualSteer: false,
    }
    // promote 时刻（点击引导按钮那一刻）：还没开始压缩，判定为走 steer，乐观气泡按 steer 上屏。
    expect(followupShouldUseSteer({ ...steerInput, compacting: false })).toBe(true)
    // send 时刻（sendFollowup 真正发出前）：压缩已经开始，必须重新判定为不走 steer，
    // 否则已经上屏的 steer 气泡会被当成普通 prompt 发送，界面和后端语义不一致（鬼气泡）。
    expect(followupShouldUseSteer({ ...steerInput, compacting: true })).toBe(false)
  })
})

describe("压缩中自动续发不丢消息（第四条旁路回归）", () => {
  // 压缩开始前已排队的 manualSteer 项本来就越过 followupCanAutoSend 的忙态判断；
  // nextFollowupToSend 不认压缩状态就会照样选中它交给发送路径，被闸门打回后乐观气泡还留在时间线里，
  // 去重 effect 会把恢复的草稿当成已发送删掉——这条测试钉住“压缩期间必须连下一条都不选”。
  test("压缩中即使队首是 manualSteer 项也不选中，留在 dock 原地等待", () => {
    const steerItem = { id: "steer-1", manualSteer: true, text: "第二条引导" }
    expect(nextFollowupToSend([steerItem], { paused: false, compacting: true })).toBeUndefined()
  })

  test("非压缩中 manualSteer 项仍照旧越过普通队列优先发送", () => {
    const steerItem = { id: "steer-1", manualSteer: true, text: "第二条引导" }
    const queued = { id: "queue-1", text: "普通队列" }
    expect(nextFollowupToSend([queued, steerItem], { paused: false, compacting: false })).toBe(steerItem)
    // 不传 compacting 时保持旧签名调用方的语义不变。
    expect(nextFollowupToSend([queued, steerItem], { paused: false })).toBe(steerItem)
  })

  // followupRestoreShouldDowngradeSteer 守的是失败恢复分支该不该撤回乐观气泡：
  // manualSteerTracked=false 却仍带 manualSteer+messageID，只有压缩把它强制降级又被发送闸挡下这一种成因。
  test("manualSteerTracked=false 但仍带 manualSteer+messageID 时必须降级撤气泡", () => {
    expect(
      followupRestoreShouldDowngradeSteer({
        manualSteerTracked: false,
        manualSteer: true,
        messageID: "message-1",
      }),
    ).toBe(true)
  })

  test("真正在跟踪的 steer 重试不能被误判降级（否则会丢弃合法的引导重试）", () => {
    expect(
      followupRestoreShouldDowngradeSteer({
        manualSteerTracked: true,
        manualSteer: true,
        messageID: "message-1",
      }),
    ).toBe(false)
  })

  test("普通队列项失败恢复不受影响", () => {
    expect(
      followupRestoreShouldDowngradeSteer({
        manualSteerTracked: false,
        manualSteer: false,
        messageID: "message-1",
      }),
    ).toBe(false)
  })

  test("没有 messageID 时不存在乐观气泡，不需要降级", () => {
    expect(
      followupRestoreShouldDowngradeSteer({
        manualSteerTracked: false,
        manualSteer: true,
      }),
    ).toBe(false)
  })
})
