import { describe, expect, test } from "bun:test"

const source = () => Bun.file(new URL("./question-marker.tsx", import.meta.url)).text()
const css = () => Bun.file(new URL("../../../../../ui/src/components/message-part.css", import.meta.url)).text()

const section = (text: string, from: string, to: string) => text.slice(text.indexOf(from), text.indexOf(to))

describe("question marker badge", () => {
  test("renders the badge slot with variant and picked attributes", async () => {
    const text = await source()

    expect(text).toContain('data-slot="question-marker"')
    expect(text).toContain("data-variant={props.variant}")
    expect(text).toContain("data-picked={props.selected}")
  })

  test("pencil variant renders the pencil-line icon", async () => {
    const text = await source()

    expect(text).toContain('props.variant === "pencil"')
    expect(text).toContain('name="pencil-line"')
  })

  test("picked badges show a dot for single select and a check for multi select", async () => {
    const text = await source()

    expect(text).toContain('props.selected && props.indicator === "dot"')
    expect(text).toContain('data-slot="question-marker-dot"')
    expect(text).toContain('props.selected && props.indicator === "check"')
    expect(text).toContain('name="check-small"')
    expect(text).toContain("props.index")
    expect(text).not.toContain("props.dot")
  })

  test("the inner glyph keeps the badge colour and a fixed size", async () => {
    const rule = section(
      await css(),
      '[data-slot="question-marker"] [data-component="icon"] {',
      '[data-slot="question-option-main"]',
    )

    expect(rule).toContain("color: currentColor")
    expect(rule).toContain("width: 16px")
    expect(rule).toContain("height: 16px")
  })

  test("picked badge uses --text-strong background and --text-invert-base text", async () => {
    const rule = section(await css(), '[data-slot="question-marker"] {', '[data-slot="question-marker-dot"]')

    expect(rule).toContain('&[data-picked="true"]')
    expect(rule).toContain("background-color: var(--text-strong)")
    expect(rule).toContain("color: var(--text-invert-base)")
  })

  test("the resting badge fill is a translucent overlay so the circle survives on any shell", async () => {
    const rule = section(await css(), '[data-slot="question-marker"] {', '[data-slot="question-marker-dot"]')

    expect(rule).toContain("background-color: var(--surface-base-hover)")
    expect(rule).not.toContain("background-color: var(--background-base)")
  })
})
