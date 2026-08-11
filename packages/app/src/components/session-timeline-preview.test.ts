import { describe, expect, test } from "bun:test"
import type { Part } from "@opencode-ai/sdk/v2"
import { sessionTimelinePreview } from "./session-timeline-preview"

describe("session timeline preview", () => {
  test("uses restored user prompt text", () => {
    const parts = [
      {
        id: "txt",
        type: "text",
        messageID: "msg",
        sessionID: "ses",
        text: "hello\nworld",
        synthetic: false,
        ignored: false,
        time: { start: 0 },
      },
    ] as Part[]

    expect(
      sessionTimelinePreview({
        parts,
        directory: "/repo",
        attachmentName: "attachment",
        addToChatLabel: "1 selection",
      }),
    ).toBe("hello world")
  })

  test("truncates long previews", () => {
    const parts = [
      {
        id: "txt",
        type: "text",
        messageID: "msg",
        sessionID: "ses",
        text: "abcdef",
        synthetic: false,
        ignored: false,
        time: { start: 0 },
      },
    ] as Part[]

    expect(
      sessionTimelinePreview({
        parts,
        directory: "/repo",
        attachmentName: "attachment",
        addToChatLabel: "1 selection",
        maxLength: 3,
      }),
    ).toBe("abc...")
  })
})
