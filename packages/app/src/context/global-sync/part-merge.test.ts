import { describe, expect, test } from "bun:test"
import type { Part, TextPart } from "@opencode-ai/sdk/v2/client"
import { mergeLivePartSnapshots } from "./part-merge"

const textPart = (text: string, time?: { start: number; end?: number }, phase?: TextPart["phase"]) =>
  ({
    id: "prt_1",
    sessionID: "ses_1",
    messageID: "msg_1",
    type: "text",
    text,
    time,
    phase,
  }) as Part

const reasoningPart = (input: { text: string; originalText?: string; time: { start: number; end?: number } }) =>
  ({
    id: "prt_reasoning",
    sessionID: "ses_1",
    messageID: "msg_1",
    type: "reasoning",
    text: input.text,
    originalText: input.originalText,
    time: input.time,
  }) as Part

describe("mergeLivePartSnapshots", () => {
  test("keeps locally streamed text when a fetched live snapshot is shorter", () => {
    const [part] = mergeLivePartSnapshots([textPart("0\n1\n2\n3\n4\n5\n")], [textPart("", { start: 1 })])

    expect(part?.type).toBe("text")
    if (part?.type === "text") expect(part.text).toBe("0\n1\n2\n3\n4\n5\n")
  })

  test("accepts final completed snapshots even when content changes", () => {
    const [part] = mergeLivePartSnapshots([textPart("draft text")], [textPart("final", { start: 1, end: 2 })])

    expect(part?.type).toBe("text")
    if (part?.type === "text") expect(part.text).toBe("final")
  })

  test("keeps a known text phase when an older snapshot omits it", () => {
    const current = textPart("已收到正文", { start: 1 }, "commentary")
    const incoming = textPart("已收到正文", { start: 1, end: 2 })
    const [part] = mergeLivePartSnapshots([current], [incoming])

    // 完成快照与本地 phase 事件存在竞态；服务端缺字段时沿用已知值，避免正文从活动区突然消失。
    expect(part?.type).toBe("text")
    if (part?.type === "text") expect(part.phase).toBe("commentary")
  })

  test("accepts an explicit phase correction from the incoming snapshot", () => {
    const current = textPart("最终回复", { start: 1 }, "commentary")
    const incoming = textPart("最终回复", { start: 1, end: 2 }, "final_answer")
    const [part] = mergeLivePartSnapshots([current], [incoming])

    // provider 的新显式值优先于本地旧值，允许 text-end 把兼容回退纠正为官方阶段。
    expect(part?.type).toBe("text")
    if (part?.type === "text") expect(part.phase).toBe("final_answer")
  })

  test("keeps accumulated reasoning when a completed snapshot is entirely empty", () => {
    const current = reasoningPart({ text: "累计摘要", originalText: "accumulated summary", time: { start: 1 } })
    const incoming = reasoningPart({ text: "", time: { start: 1, end: 2 } })
    const [part] = mergeLivePartSnapshots([current], [incoming])

    // 完成事件只负责收尾时，不能用空 text/originalText 擦掉此前逐段收到的 reasoning delta。
    expect(part?.type).toBe("reasoning")
    if (part?.type === "reasoning") {
      expect(part.text).toBe("累计摘要")
      expect(part.originalText).toBe("accumulated summary")
      expect(part.time.end).toBe(2)
    }
  })

  test("accepts a non-empty completed reasoning rewrite", () => {
    const current = reasoningPart({ text: "草稿译文", originalText: "draft", time: { start: 1 } })
    const incoming = reasoningPart({ text: "最终摘要", time: { start: 1, end: 2 } })
    const [part] = mergeLivePartSnapshots([current], [incoming])

    // 翻译/完成 hook 可以用非空快照合法替换内容，并明确移除不再需要的 originalText。
    expect(part?.type).toBe("reasoning")
    if (part?.type === "reasoning") {
      expect(part.text).toBe("最终摘要")
      expect(part.originalText).toBeUndefined()
    }
  })
})
