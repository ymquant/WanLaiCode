import { describe, expect, test } from "bun:test"
import { createTextFragment, getCursorPosition, getNodeLength, getTextLength, setCursorPosition } from "./editor-dom"

describe("prompt-input editor dom", () => {
  test("createTextFragment preserves newlines with consecutive br nodes", () => {
    const fragment = createTextFragment("foo\n\nbar")
    const container = document.createElement("div")
    container.appendChild(fragment)

    expect(container.childNodes.length).toBe(4)
    expect(container.childNodes[0]?.textContent).toBe("foo")
    expect((container.childNodes[1] as HTMLElement).tagName).toBe("BR")
    expect((container.childNodes[2] as HTMLElement).tagName).toBe("BR")
    expect(container.childNodes[3]?.textContent).toBe("bar")
  })

  test("createTextFragment keeps trailing newline as terminal break", () => {
    const fragment = createTextFragment("foo\n")
    const container = document.createElement("div")
    container.appendChild(fragment)

    expect(container.childNodes.length).toBe(2)
    expect(container.childNodes[0]?.textContent).toBe("foo")
    expect((container.childNodes[1] as HTMLElement).tagName).toBe("BR")
  })

  test("createTextFragment avoids break-node explosion for large multiline content", () => {
    const content = Array.from({ length: 220 }, () => "line").join("\n")
    const fragment = createTextFragment(content)
    const container = document.createElement("div")
    container.appendChild(fragment)

    expect(container.childNodes.length).toBe(1)
    expect(container.childNodes[0]?.nodeType).toBe(Node.TEXT_NODE)
    expect(container.textContent).toBe(content)
  })

  test("createTextFragment keeps terminal break in large multiline fallback", () => {
    const content = `${Array.from({ length: 220 }, () => "line").join("\n")}\n`
    const fragment = createTextFragment(content)
    const container = document.createElement("div")
    container.appendChild(fragment)

    expect(container.childNodes.length).toBe(2)
    expect(container.childNodes[0]?.textContent).toBe(content.slice(0, -1))
    expect((container.childNodes[1] as HTMLElement).tagName).toBe("BR")
  })

  test("length helpers treat breaks as one char and ignore zero-width chars", () => {
    const container = document.createElement("div")
    container.appendChild(document.createTextNode("ab\u200B"))
    container.appendChild(document.createElement("br"))
    container.appendChild(document.createTextNode("cd"))

    expect(getNodeLength(container.childNodes[0]!)).toBe(2)
    expect(getNodeLength(container.childNodes[1]!)).toBe(1)
    expect(getTextLength(container)).toBe(5)
  })

  test("setCursorPosition and getCursorPosition round-trip with pills and breaks", () => {
    const container = document.createElement("div")
    const pill = document.createElement("span")
    pill.dataset.type = "file"
    pill.textContent = "@file"
    container.appendChild(document.createTextNode("ab"))
    container.appendChild(pill)
    container.appendChild(document.createElement("br"))
    container.appendChild(document.createTextNode("cd"))
    document.body.appendChild(container)

    setCursorPosition(container, 2)
    expect(getCursorPosition(container)).toBe(2)

    setCursorPosition(container, 7)
    expect(getCursorPosition(container)).toBe(7)

    setCursorPosition(container, 8)
    expect(getCursorPosition(container)).toBe(8)

    container.remove()
  })

  test("skill pills use wire content length for cursor math", () => {
    const container = document.createElement("div")
    const pill = document.createElement("span")
    pill.dataset.type = "skill"
    pill.dataset.content = "/skill-creator "
    pill.textContent = "Skill Creator"
    container.appendChild(pill)
    container.appendChild(document.createTextNode("next"))
    document.body.appendChild(container)

    expect(getNodeLength(pill)).toBe(15)
    expect(getTextLength(container)).toBe(19)

    setCursorPosition(container, 15)
    expect(getCursorPosition(container)).toBe(15)

    container.remove()
  })

  test("skill chip followed by trailing space: cursor at total length lands after space (prefill scenario)", () => {
    // Simulates the prefill case: [Plugin Creator chip] + " " text node.
    // chip data-content = "/plugin-creator " (16 chars), text " " (1 char) → total 17.
    // setCursorPosition(17) must place cursor after the trailing space, not at the start.
    const container = document.createElement("div")
    const pill = document.createElement("span")
    pill.dataset.type = "skill"
    pill.dataset.content = "/plugin-creator "
    pill.textContent = "Plugin Creator"
    container.appendChild(pill)
    container.appendChild(document.createTextNode(" "))
    document.body.appendChild(container)

    expect(getNodeLength(pill)).toBe(16)
    expect(getTextLength(container)).toBe(17)

    // cursor at 16 → just after the chip (start of trailing space)
    setCursorPosition(container, 16)
    expect(getCursorPosition(container)).toBe(16)

    // cursor at 17 → after the trailing space (end of input, where prefill should land)
    setCursorPosition(container, 17)
    expect(getCursorPosition(container)).toBe(17)

    container.remove()
  })

  test("setCursorPosition and getCursorPosition round-trip across blank lines", () => {
    const container = document.createElement("div")
    container.appendChild(document.createTextNode("a"))
    container.appendChild(document.createElement("br"))
    container.appendChild(document.createElement("br"))
    container.appendChild(document.createTextNode("b"))
    document.body.appendChild(container)

    setCursorPosition(container, 2)
    expect(getCursorPosition(container)).toBe(2)

    setCursorPosition(container, 3)
    expect(getCursorPosition(container)).toBe(3)

    container.remove()
  })
})
