import { describe, expect, test } from "bun:test"
import type { Event } from "@opencode-ai/sdk/v2/client"
import {
  coalescedEventKey,
  deltaKey,
  filterStaleDeltas,
  mergeCoalescedPayload,
  type QueuedEvent,
} from "./global-sdk-event-queue"

const directory = "/tmp/project"
const sessionID = "ses_1"
const messageID = "msg_1"
const partID = "prt_1"

const partUpdated = (text: string) =>
  ({
    type: "message.part.updated",
    properties: {
      part: {
        id: partID,
        sessionID,
        messageID,
        type: "text",
        text,
      },
    },
  }) as Event

const partDelta = (delta: string) =>
  ({
    type: "message.part.delta",
    properties: {
      sessionID,
      messageID,
      partID,
      field: "text",
      delta,
    },
  }) as Event

const queued = (payload: Event): QueuedEvent => ({ directory, payload })

describe("global sdk event queue", () => {
  test("coalesces message part updates by part", () => {
    expect(coalescedEventKey(directory, partUpdated("0"))).toBe(`message.part.updated:${directory}:${messageID}:${partID}`)
    expect(coalescedEventKey(directory, partDelta("1"))).toBeUndefined()
  })

  test("coalesces file watcher updates by file path", () => {
    const evt = (file: string, event: string) =>
      ({ type: "file.watcher.updated", properties: { file, event } }) as Event
    // 同一文件的多次变更共享同一 key（合并保留最后一次）
    expect(coalescedEventKey(directory, evt("src/a.ts", "change"))).toBe(
      `file.watcher.updated:${directory}:src/a.ts`,
    )
    expect(coalescedEventKey(directory, evt("src/a.ts", "add"))).toBe(`file.watcher.updated:${directory}:src/a.ts`)
    // 不同文件不共享 key
    expect(coalescedEventKey(directory, evt("src/b.ts", "change"))).toBe(
      `file.watcher.updated:${directory}:src/b.ts`,
    )
  })

  test("mergeCoalescedPayload：file.watcher 按状态转换合并 kind（[P1]）", () => {
    const evt = (file: string, event: string) =>
      ({ type: "file.watcher.updated", properties: { file, event } }) as Event
    // 新文件 add→change 合并后保留 add（否则客户端不刷父目录，新文件不出现在树里）
    expect((mergeCoalescedPayload(evt("a.ts", "add"), evt("a.ts", "change")).properties as any).event).toBe("add")
    // 结构性删除决定最终态
    expect((mergeCoalescedPayload(evt("a.ts", "add"), evt("a.ts", "unlink")).properties as any).event).toBe("unlink")
    // 纯内容变更保持 change
    expect((mergeCoalescedPayload(evt("a.ts", "change"), evt("a.ts", "change")).properties as any).event).toBe(
      "change",
    )
  })

  test("mergeCoalescedPayload：非 file.watcher 事件直接用新事件（保留最后一次语义）", () => {
    const next = partUpdated("1")
    expect(mergeCoalescedPayload(partUpdated("0"), next)).toBe(next)
  })

  test("filters only deltas queued before the latest coalesced part snapshot", () => {
    const events = [
      queued(partUpdated("0\n1\n2\n")),
      queued(partDelta("1\n")),
      queued(partDelta("2\n")),
      queued(partDelta("3\n")),
    ]

    const filtered = filterStaleDeltas(events, new Map([[deltaKey(directory, messageID, partID), 3]]))

    expect(filtered.map((event) => event.payload)).toEqual([partUpdated("0\n1\n2\n"), partDelta("3\n")])
  })
})
