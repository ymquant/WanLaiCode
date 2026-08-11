import { describe, expect, test } from "bun:test"
import { splitRecommended } from "./question-option"

const source = () => Bun.file(new URL("./question-option.tsx", import.meta.url)).text()
const css = () => Bun.file(new URL("../../../../../ui/src/components/message-part.css", import.meta.url)).text()

const section = (text: string, from: string, to: string) => text.slice(text.indexOf(from), text.indexOf(to))

describe("recommended suffix", () => {
  test("splits the english suffix off the label", () => {
    expect(splitRecommended("Use ripgrep (Recommended)")).toEqual({ label: "Use ripgrep", recommended: true })
  })

  test("splits the full width chinese suffix off the label", () => {
    expect(splitRecommended("使用 ripgrep（推荐）")).toEqual({ label: "使用 ripgrep", recommended: true })
  })

  test("splits the half width chinese suffix off the label", () => {
    expect(splitRecommended("使用 ripgrep(推荐)")).toEqual({ label: "使用 ripgrep", recommended: true })
  })

  test("leaves a plain label untouched", () => {
    expect(splitRecommended("Use ripgrep")).toEqual({ label: "Use ripgrep", recommended: false })
  })

  test("ignores the marker when it is not the suffix", () => {
    expect(splitRecommended("(Recommended) use ripgrep")).toEqual({
      label: "(Recommended) use ripgrep",
      recommended: false,
    })
    expect(splitRecommended("（推荐）使用 ripgrep")).toEqual({ label: "（推荐）使用 ripgrep", recommended: false })
  })

  test("splits the english suffix without a leading space", () => {
    expect(splitRecommended("Use ripgrep(Recommended)")).toEqual({ label: "Use ripgrep", recommended: true })
  })

  test("splits the english suffix whatever its case", () => {
    expect(splitRecommended("Use ripgrep (recommended)")).toEqual({ label: "Use ripgrep", recommended: true })
    expect(splitRecommended("Use ripgrep (RECOMMENDED)")).toEqual({ label: "Use ripgrep", recommended: true })
  })

  test("eats any run of whitespace before the suffix", () => {
    expect(splitRecommended("Use ripgrep   （推荐）")).toEqual({ label: "Use ripgrep", recommended: true })
  })

  test("keeps a label that is nothing but the marker", () => {
    expect(splitRecommended("(Recommended)")).toEqual({ label: "(Recommended)", recommended: false })
    expect(splitRecommended("（推荐）")).toEqual({ label: "（推荐）", recommended: false })
  })
})

describe("question option row", () => {
  test("drops the radio dot and checkbox mark slots", async () => {
    const text = await source()

    expect(text).not.toContain("question-option-box")
    expect(text).not.toContain("question-option-radio-dot")
  })

  test("carries no styling attribute that no rule reads", async () => {
    const text = await source()
    const rules = await css()

    expect(text).not.toContain("data-multi")
    expect(rules).not.toContain("data-multi")
  })

  test("renders the shared circular marker instead of the plain index", async () => {
    const text = await source()
    const rules = await css()

    expect(text).toContain("<QuestionMarker")
    expect(text).toContain('variant="number"')
    expect(text).toContain("index={props.index + 1}")
    expect(text).not.toContain("question-option-index")
    expect(rules).not.toContain("question-option-index")
  })

  test("asks the marker for a dot in single mode and a check in multi mode", async () => {
    const text = await source()

    expect(text).toContain('indicator={props.multi ? "check" : "dot"}')
    expect(text).not.toContain("dot={")
  })

  test("carries no trailing arrow in either mode", async () => {
    const text = await source()
    const rules = await css()

    expect(text).not.toContain("question-option-keyhint")
    expect(rules).not.toContain("question-option-keyhint")
    expect(text).not.toContain("question-option-arrow")
    expect(rules).not.toContain("question-option-arrow")
    expect(text).not.toContain("arrow-right")
    expect(text).not.toContain("props.arrow")
  })

  test("renders the recommended suffix as its own badge", async () => {
    const text = await source()

    expect(text).toContain('data-slot="question-option-recommend"')
    expect(text).toContain("parsed().recommended")
    expect(text).toContain("parsed().label")
  })

  test("offers the full description through a native tooltip", async () => {
    const text = await source()

    expect(text).toContain("title={props.description}")
  })

  test("option rows are pills with a centered single line layout", async () => {
    const rule = section(await css(), '[data-slot="question-option"] {', '[data-slot="question-marker"]')

    expect(rule).toContain("border-radius: 999px")
    expect(rule).toContain("align-items: center")
    expect(rule).toContain("min-height: 32px")
    expect(rule).toContain("padding: 6px 8px")
  })

  test("the pill radius survives the squircle bump", async () => {
    const text = await css()
    const from = text.indexOf("@supports (corner-shape: superellipse(1.5))")
    const block = text.slice(from, text.indexOf(':root[data-color-scheme="dark"] [data-component="dock-prompt"]', from))

    expect(block).toContain('[data-dock-surface="shell"]')
    expect(block).not.toContain('[data-slot="question-option"]')
  })

  test("hover picked and focus all share one translucent overlay with no ring", async () => {
    const rule = section(await css(), '[data-slot="question-option"] {', '[data-slot="question-marker"]')

    expect(rule.match(/background-color: var\(--surface-base-hover\)/g)).toHaveLength(3)
    // --background-base 是不透明的页面底色，亮色主题下与面板底色同值，三态会一起消失
    expect(rule).not.toContain("var(--background-base)")
    expect(rule).not.toContain("var(--surface-interactive-weak)")
    expect(rule).not.toContain("var(--border-interactive-base)")
    expect(rule).not.toContain("box-shadow: 0 0 0 1px")
    expect(rule).not.toContain("inset 0 0 0 1px")
  })

  test("dark rows drop the hardcoded hex and ride the same translucent overlay", async () => {
    const text = await css()
    const dark = section(
      text,
      ':root[data-color-scheme="dark"] [data-component="dock-prompt"][data-kind="question"] {',
      '[data-component="question-answers"] {',
    )

    expect(dark).not.toContain("#1f1f1f")
  })

  test("label and description share one line and both truncate", async () => {
    const text = await css()
    const head = section(text, '[data-slot="question-option-head"] {', '[data-slot="option-label"]')
    const label = section(text, '[data-slot="option-label"] {', '[data-slot="option-description"]')
    const description = section(text, '[data-slot="option-description"] {', '[data-slot="question-option-recommend"]')
    const main = section(text, '[data-slot="question-option-main"] {', '[data-slot="question-option-head"]')

    expect(main).toContain("flex-direction: row")
    expect(main).toContain("align-items: baseline")
    expect(head).toContain("max-width: 50%")
    expect(head).toContain("&:only-child")
    expect(label).toContain("text-overflow: ellipsis")
    expect(description).toContain("text-overflow: ellipsis")
    expect(description).toContain("flex: 1")
    expect(text).not.toContain('[data-picked="true"] [data-slot="option-description"]')
  })

  test("the recommend chip is filled like the revisit chip instead of a hairline outline", async () => {
    const text = await css()
    const recommend = section(text, '[data-slot="question-option-recommend"] {', '[data-slot="question-option-badge"]')
    const badge = section(text, '[data-slot="question-option-badge"] {', '[data-slot="question-custom"]')

    expect(recommend).toContain("background-color: var(--surface-interactive-weak)")
    expect(badge).toContain("background-color: var(--surface-interactive-weak)")
    // 只剩一根发丝框的 chip 在明暗两色下都读不出是个 chip，底色接手后描边就是多余的
    expect(recommend).not.toContain("var(--background-base)")
    expect(recommend).not.toContain("border:")
  })

  test("the revisit badge closes the row without an arrow after it", async () => {
    const rule = section(await css(), '[data-slot="question-option-badge"] {', '[data-slot="question-custom"]')

    expect(rule).toContain("flex-shrink: 0")
    expect(rule).toContain("align-self: center")
  })
})
