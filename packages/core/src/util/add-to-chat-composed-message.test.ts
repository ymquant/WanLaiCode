import { describe, expect, test } from "bun:test"
import {
  ADD_TO_CHAT_BODY_SEPARATOR,
  ADD_TO_CHAT_EXCERPT_END_SENTINEL,
  ADD_TO_CHAT_EXCERPT_SENTINEL,
  composeAddToChatUserMessage,
  parseAddToChatUserMessageDisplay,
} from "./add-to-chat-composed-message"

describe("parseAddToChatUserMessageDisplay", () => {
  test("returns null when separator missing", () => {
    expect(parseAddToChatUserMessageDisplay("hello")).toBeNull()
  })

  test("parses one excerpt and body (sentinel heading + end line)", () => {
    const full = `${ADD_TO_CHAT_EXCERPT_SENTINEL}\nline a\nline b\n${ADD_TO_CHAT_EXCERPT_END_SENTINEL}${ADD_TO_CHAT_BODY_SEPARATOR}my question`
    expect(parseAddToChatUserMessageDisplay(full)).toEqual({
      excerpts: ["line a\nline b"],
      body: "my question",
    })
  })

  test("parses two excerpts (legacy sentinel blocks without end line)", () => {
    const full = `${ADD_TO_CHAT_EXCERPT_SENTINEL}\none\n\n${ADD_TO_CHAT_EXCERPT_SENTINEL}\ntwo${ADD_TO_CHAT_BODY_SEPARATOR}body`
    expect(parseAddToChatUserMessageDisplay(full)).toEqual({
      excerpts: ["one", "two"],
      body: "body",
    })
  })

  test("parses legacy locale heading (前面提到)", () => {
    const full = `前面提到\nline a\nline b${ADD_TO_CHAT_BODY_SEPARATOR}my question`
    expect(parseAddToChatUserMessageDisplay(full)).toEqual({
      excerpts: ["line a\nline b"],
      body: "my question",
    })
  })

  test("parses legacy numbered excerpt headings", () => {
    const full = `摘录 1\nlegacy${ADD_TO_CHAT_BODY_SEPARATOR}body`
    expect(parseAddToChatUserMessageDisplay(full)).toEqual({
      excerpts: ["legacy"],
      body: "body",
    })
  })

  test("compose round-trips with parse", () => {
    const wire = composeAddToChatUserMessage(["a\nb", "c"], "hello")
    expect(parseAddToChatUserMessageDisplay(wire)).toEqual({
      excerpts: ["a\nb", "c"],
      body: "hello",
    })
  })

  test("compose round-trips when excerpt contains blank lines", () => {
    const wire = composeAddToChatUserMessage(["a\n\nb"], "hello")
    expect(parseAddToChatUserMessageDisplay(wire)).toEqual({
      excerpts: ["a\n\nb"],
      body: "hello",
    })
  })
})
