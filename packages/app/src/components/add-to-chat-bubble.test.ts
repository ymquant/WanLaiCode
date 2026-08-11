import { describe, expect, test } from "bun:test"
import { addToChatBubblePosition } from "./add-to-chat-bubble-position"
import { isAssistantConversationContent } from "./add-to-chat-selection"

const element = (component?: string, slot?: string) => {
  const el = document.createElement("div")
  if (component) el.dataset.component = component
  if (slot) el.dataset.slot = slot
  return el
}

describe("isAssistantConversationContent", () => {
  test("allows assistant output content", () => {
    const root = element("session-turn")
    const output = element("bash-output")
    root.append(output)

    expect(isAssistantConversationContent(output)).toBe(true)
  })

  test("blocks prompt input content", () => {
    const input = element("prompt-input")
    const output = element("bash-output")
    input.append(output)

    expect(isAssistantConversationContent(output)).toBe(false)
  })

  test("blocks content when an allowed descendant is inside a blocked ancestor", () => {
    const userMessage = element("user-message")
    const output = element("bash-output")
    userMessage.append(output)

    expect(isAssistantConversationContent(output)).toBe(false)
  })
})

describe("addToChatBubblePosition", () => {
  test("keeps the bubble inside both horizontal viewport edges", () => {
    expect(addToChatBubblePosition(new DOMRect(0, 80, 20, 12), 200).left).toBe(73)
    expect(addToChatBubblePosition(new DOMRect(180, 80, 20, 12), 200).left).toBe(127)
  })

  test("uses a readable gap from selected text", () => {
    expect(addToChatBubblePosition(new DOMRect(80, 100, 40, 12), 240).top).toBe(59)
    expect(addToChatBubblePosition(new DOMRect(80, 30, 40, 12), 240).top).toBe(50)
  })
})
