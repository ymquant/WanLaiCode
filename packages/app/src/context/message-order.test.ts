import { describe, expect, test } from "bun:test"
import type { Message } from "@opencode-ai/sdk/v2/client"
import {
  compareMessageOrder,
  findMessageIndexByID,
  mergeMessages,
  preserveKnownMessageTurnIdentity,
  sortMessages,
  upsertMessage,
} from "./message-order"

const userMessage = (id: string, created: number): Message => ({
  id,
  sessionID: "ses_1",
  role: "user",
  time: { created },
  agent: "assistant",
  model: { providerID: "openai", modelID: "gpt" },
})

describe("message order", () => {
  test("sorts legacy remote IDs by created time before ID", () => {
    // 旧远控 ID 的字典序晚于普通 ID，但真实创建时间更早，时间线必须仍把它放在前面。
    const remote = userMessage("msg_remote_zzzz", 100)
    const latest = userMessage("msg_0001", 200)

    expect(sortMessages([latest, remote]).map((message) => message.id)).toEqual([remote.id, latest.id])
    expect(compareMessageOrder(remote, latest)).toBeLessThan(0)
  })

  test("uses ID as a stable tie breaker within the same millisecond", () => {
    const laterID = userMessage("msg_b", 100)
    const earlierID = userMessage("msg_a", 100)

    expect(sortMessages([laterID, earlierID]).map((message) => message.id)).toEqual([earlierID.id, laterID.id])
  })

  test("finds identity by ID in a time-sorted array", () => {
    // 时间有序数组不再满足 ID 二分搜索前提，身份查找必须与排序键解耦。
    const messages = sortMessages([
      userMessage("msg_remote_zzzz", 100),
      userMessage("msg_0001", 200),
      userMessage("msg_remote_aaaa", 300),
    ])

    expect(findMessageIndexByID(messages, "msg_0001")).toBe(1)
    expect(findMessageIndexByID(messages, "missing")).toBe(-1)
  })

  test("repositions an optimistic message when the server corrects its created time", () => {
    const optimistic = userMessage("msg_same", 300)
    const middle = userMessage("msg_middle", 200)
    const authoritative = { ...optimistic, time: { created: 100 } }

    const next = upsertMessage(sortMessages([middle, optimistic]), authoritative)

    expect(next.map((message) => message.id)).toEqual([authoritative.id, middle.id])
    expect(next.filter((message) => message.id === authoritative.id)).toHaveLength(1)
  })

  test("merges by ID while preserving authoritative time order", () => {
    const remote = userMessage("msg_remote_zzzz", 100)
    const stale = userMessage("msg_same", 400)
    const authoritative = userMessage("msg_same", 200)
    const latest = userMessage("msg_0001", 300)

    const merged = mergeMessages([latest, stale], [remote, authoritative])

    expect(merged.map((message) => message.id)).toEqual([remote.id, authoritative.id, latest.id])
    expect(merged.find((message) => message.id === authoritative.id)?.time.created).toBe(200)
  })

  test("keeps an optimistic steer target when an old server echo omits turn fields", () => {
    const optimistic = { ...userMessage("msg_steer", 100), steerTargetTurnID: "turn_active" } as Message
    const echoed = userMessage("msg_steer", 120)

    const merged = preserveKnownMessageTurnIdentity(optimistic, echoed)

    // 同 ID 已经证明这是同一次提交；旧协议只缺能力字段，不能因此改变它在当前物理 turn 中的身份。
    expect(merged).toMatchObject({ id: "msg_steer", time: { created: 120 }, steerTargetTurnID: "turn_active" })
  })

  test("lets a durable fallback turn override an optimistic steer target", () => {
    const optimistic = { ...userMessage("msg_followup", 100), steerTargetTurnID: "turn_old" } as Message
    const fallback = { ...userMessage("msg_followup", 120), turnID: "msg_followup" } as Message

    const merged = preserveKnownMessageTurnIdentity(optimistic, fallback)

    // inactive fallback 已被服务端确认为独立 turn；不得重新带回旧目标，否则普通排队消息会被错误合并。
    expect(merged).toMatchObject({ id: "msg_followup", turnID: "msg_followup" })
    expect((merged as Message & { steerTargetTurnID?: string }).steerTargetTurnID).toBeUndefined()
  })

  test("keeps steer identity when sidebar prefetch merges an old snapshot", () => {
    const optimistic = { ...userMessage("msg_steer", 100), steerTargetTurnID: "turn_active" } as Message
    const prefetched = userMessage(optimistic.id, 120)

    const merged = mergeMessages([optimistic], [prefetched])

    // 侧栏预取会和打开的会话共用消息 store；同 ID 旧协议快照只能更新服务端字段，不能改变所属 turn。
    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({
      id: optimistic.id,
      time: { created: 120 },
      steerTargetTurnID: "turn_active",
    })
  })
})
