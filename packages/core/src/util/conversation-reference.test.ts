import { describe, expect, test } from "bun:test"
import { buildConversationReference, parseConversationReferences } from "./conversation-reference"

describe("conversation references", () => {
  test("builds and parses a conversation link", () => {
    const link = buildConversationReference({ id: "chat/你好", title: "你好聊什么" })

    expect(link).toBe("[你好聊什么](chatgpt-conversation://chat%2F%E4%BD%A0%E5%A5%BD)")
    expect(parseConversationReferences(`查看 ${link} 继续`)).toEqual([
      {
        start: 3,
        end: 3 + link.length,
        raw: link,
        title: "你好聊什么",
        id: "chat/你好",
      },
    ])
  })

  test("escapes closing brackets in titles", () => {
    const link = buildConversationReference({ id: "ses_1", title: "A]B" })

    expect(link).toBe("[A\\]B](chatgpt-conversation://ses_1)")
    expect(parseConversationReferences(link)[0]).toMatchObject({ title: "A]B", id: "ses_1" })
  })
})
