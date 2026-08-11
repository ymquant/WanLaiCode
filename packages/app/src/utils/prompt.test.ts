import { describe, expect, test } from "bun:test"
import type { Part } from "@opencode-ai/sdk/v2"
import { ADD_TO_CHAT_BODY_SEPARATOR, composeAddToChatUserMessage } from "@opencode-ai/core/util/add-to-chat-composed-message"
import { extractPromptFromParts, restoreEditorFromUserParts } from "./prompt"

describe("extractPromptFromParts", () => {
  test("restores root-relative Markdown as a web link instead of a file reference", () => {
    const parts = [
      {
        id: "text_root_link",
        type: "text",
        text: "[Docs](/docs)",
        sessionID: "ses_1",
        messageID: "msg_1",
      },
    ] satisfies Part[]

    // 历史恢复与编辑器粘贴共用 findPromptLinkMatches，必须维持相同的网页链接身份。
    expect(extractPromptFromParts(parts)).toEqual([
      { type: "link", href: "/docs", content: "Docs", start: 0, end: 4 },
    ])
  })

  test("restores multiple uploaded attachments", () => {
    const parts = [
      {
        id: "text_1",
        type: "text",
        text: "check these",
        sessionID: "ses_1",
        messageID: "msg_1",
      },
      {
        id: "file_1",
        type: "file",
        mime: "image/png",
        url: "data:image/png;base64,AAA",
        filename: "a.png",
        sessionID: "ses_1",
        messageID: "msg_1",
      },
      {
        id: "file_2",
        type: "file",
        mime: "application/pdf",
        url: "data:application/pdf;base64,BBB",
        filename: "b.pdf",
        sessionID: "ses_1",
        messageID: "msg_1",
      },
    ] satisfies Part[]

    const result = extractPromptFromParts(parts)

    expect(result).toHaveLength(3)
    expect(result[0]).toMatchObject({ type: "text", content: "check these" })
    expect(result.slice(1)).toMatchObject([
      { type: "image", filename: "a.png", mime: "image/png", dataUrl: "data:image/png;base64,AAA" },
      { type: "image", filename: "b.pdf", mime: "application/pdf", dataUrl: "data:application/pdf;base64,BBB" },
    ])
  })

  test("restores file attachments with zero-width source text as detached attachments", () => {
    const parts = [
      {
        id: "text_1",
        type: "text",
        text: "看 ",
        sessionID: "ses_1",
        messageID: "msg_1",
      },
      {
        id: "file_1",
        type: "file",
        mime: "text/plain",
        url: "file:///E:/github/wanlaicodex/github/package.json",
        filename: "package.json",
        source: {
          type: "file",
          path: "E:/github/wanlaicodex/github/package.json",
          text: {
            value: "@package.json",
            start: 0,
            end: 0,
          },
        },
        sessionID: "ses_1",
        messageID: "msg_1",
      },
    ] satisfies Part[]

    const result = extractPromptFromParts(parts)

    expect(result).toMatchObject([
      { type: "text", content: "看 ", start: 0, end: 2 },
      {
        type: "file",
        path: "E:/github/wanlaicodex/github/package.json",
        content: "@package.json",
        start: 2,
        end: 15,
      },
    ])
  })

  test("restores file attachments when sent text no longer contains the source token", () => {
    const parts = [
      {
        id: "text_1",
        type: "text",
        text: "看 ",
        sessionID: "ses_1",
        messageID: "msg_1",
      },
      {
        id: "file_1",
        type: "file",
        mime: "text/plain",
        url: "file:///E:/github/wanlaicodex/github/package.json",
        filename: "package.json",
        source: {
          type: "file",
          path: "E:/github/wanlaicodex/github/package.json",
          text: {
            value: "@package.json",
            start: 0,
            end: 0,
          },
        },
        sessionID: "ses_1",
        messageID: "msg_1",
      },
    ] satisfies Part[]

    const result = extractPromptFromParts(parts)

    expect(result).toMatchObject([
      { type: "text", content: "看 ", start: 0, end: 2 },
      {
        type: "file",
        path: "E:/github/wanlaicodex/github/package.json",
        content: "@package.json",
        start: 2,
        end: 15,
      },
    ])
  })

  test("restores dropped PDFs as file references instead of image attachments", () => {
    const parts = [
      {
        id: "text_1",
        type: "text",
        text: "please read @guide.pdf",
        sessionID: "ses_1",
        messageID: "msg_1",
      },
      {
        id: "file_1",
        type: "file",
        mime: "text/plain",
        url: "file:///D:/docs/guide.pdf",
        filename: "guide.pdf",
        source: {
          type: "file",
          path: "D:/docs/guide.pdf",
          text: {
            value: "@guide.pdf",
            start: 12,
            end: 22,
          },
        },
        sessionID: "ses_1",
        messageID: "msg_1",
      },
    ] satisfies Part[]

    const result = extractPromptFromParts(parts)

    expect(result).toMatchObject([
      { type: "text", content: "please read ", start: 0, end: 12 },
      { type: "file", path: "D:/docs/guide.pdf", content: "@guide.pdf", start: 12, end: 22 },
    ])
  })

  test("preserves short display text for restored file references", () => {
    const parts = [
      {
        id: "text_1",
        type: "text",
        text: "please check @foo.txt",
        sessionID: "ses_1",
        messageID: "msg_1",
      },
      {
        id: "file_1",
        type: "file",
        mime: "text/plain",
        url: "file:///D:/work/foo.txt",
        filename: "foo.txt",
        source: {
          type: "file",
          path: "D:/work/foo.txt",
          text: {
            value: "@foo.txt",
            start: 13,
            end: 21,
          },
        },
        sessionID: "ses_1",
        messageID: "msg_1",
      },
    ] satisfies Part[]

    const result = extractPromptFromParts(parts)

    expect(result).toMatchObject([
      { type: "text", content: "please check ", start: 0, end: 13 },
      { type: "file", path: "D:/work/foo.txt", content: "@foo.txt", start: 13, end: 21 },
    ])
  })

  test("falls back to basename when persisted file display text is corrupted", () => {
    const parts = [
      {
        id: "text_1",
        type: "text",
        text: "please check 1749705472000",
        sessionID: "ses_1",
        messageID: "msg_1",
      },
      {
        id: "file_1",
        type: "file",
        mime: "text/plain",
        url: "file:///D:/docs/report.pdf",
        filename: "report.pdf",
        source: {
          type: "file",
          path: "D:/docs/report.pdf",
          text: {
            value: "1749705472000",
            start: 13,
            end: 26,
          },
        },
        sessionID: "ses_1",
        messageID: "msg_1",
      },
    ] satisfies Part[]

    const result = extractPromptFromParts(parts)

    expect(result).toMatchObject([
      { type: "text", content: "please check ", start: 0, end: 13 },
      { type: "file", path: "D:/docs/report.pdf", content: "@report.pdf", start: 13, end: 24 },
    ])
  })

  test("preserves legitimate basename file references that start with digits", () => {
    const parts = [
      {
        id: "text_1",
        type: "text",
        text: "please check @2024-06-12.txt",
        sessionID: "ses_1",
        messageID: "msg_1",
      },
      {
        id: "file_1",
        type: "file",
        mime: "text/plain",
        url: "file:///D:/docs/2024-06-12.txt",
        filename: "2024-06-12.txt",
        source: {
          type: "file",
          path: "D:/docs/2024-06-12.txt",
          text: {
            value: "@2024-06-12.txt",
            start: 13,
            end: 28,
          },
        },
        sessionID: "ses_1",
        messageID: "msg_1",
      },
    ] satisfies Part[]

    const result = extractPromptFromParts(parts)

    expect(result).toMatchObject([
      { type: "text", content: "please check ", start: 0, end: 13 },
      { type: "file", path: "D:/docs/2024-06-12.txt", content: "@2024-06-12.txt", start: 13, end: 28 },
    ])
  })

  test("falls back to corrected display text when source text uses numeric @placeholder variant", () => {
    const parts = [
      {
        id: "text_1",
        type: "text",
        text: "please check @report.pdf",
        sessionID: "ses_1",
        messageID: "msg_1",
      },
      {
        id: "file_1",
        type: "file",
        mime: "text/plain",
        url: "file:///D:/docs/report.pdf",
        filename: "report.pdf",
        source: {
          type: "file",
          path: "D:/docs/report.pdf",
          text: {
            value: "@1749705472000",
            start: 13,
            end: 27,
          },
        },
        sessionID: "ses_1",
        messageID: "msg_1",
      },
    ] satisfies Part[]

    const result = extractPromptFromParts(parts)

    expect(result).toMatchObject([
      { type: "text", content: "please check ", start: 0, end: 13 },
      { type: "file", path: "D:/docs/report.pdf", content: "@report.pdf", start: 13, end: 24 },
    ])
  })
})


describe("restoreEditorFromUserParts", () => {
  test("restores conversation references with their hidden transcript", () => {
    const parts = [
      {
        id: "t1",
        type: "text",
        text: "[你好聊什么](chatgpt-conversation://chat_1)",
        sessionID: "s",
        messageID: "m",
      },
      {
        id: "t2",
        type: "text",
        text: "Conversation reference: 你好聊什么\n\nUser: 你好\n\nAssistant: 你好！",
        synthetic: true,
        metadata: { conversation_reference: { id: "chat_1", title: "你好聊什么" } },
        sessionID: "s",
        messageID: "m",
      },
    ] satisfies Part[]

    const { prompt } = restoreEditorFromUserParts(parts)
    expect(prompt).toEqual([
      {
        type: "conversation",
        id: "chat_1",
        title: "你好聊什么",
        transcript: "User: 你好\n\nAssistant: 你好！",
        content: "你好聊什么",
        start: 0,
        end: 5,
      },
    ])
  })

  test("splits add-to-chat wire text into body prompt and excerpt snippets", () => {
    const parts = [
      {
        id: "t1",
        type: "text",
        text: composeAddToChatUserMessage(["hello", "world"], "my question"),
        sessionID: "s",
        messageID: "m",
      },
    ] satisfies Part[]

    const { prompt, addToChatSnippets } = restoreEditorFromUserParts(parts)
    expect(addToChatSnippets).toEqual(["hello", "world"])
    expect(prompt[0]).toMatchObject({ type: "text", content: "my question" })
  })

  test("still splits legacy 摘录-N wire text", () => {
    const parts = [
      {
        id: "t1",
        type: "text",
        text: `摘录 1\nhello${ADD_TO_CHAT_BODY_SEPARATOR}q`,
        sessionID: "s",
        messageID: "m",
      },
    ] satisfies Part[]

    const { prompt, addToChatSnippets } = restoreEditorFromUserParts(parts)
    expect(addToChatSnippets).toEqual(["hello"])
    expect(prompt[0]).toMatchObject({ type: "text", content: "q" })
  })
})
