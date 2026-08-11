import "../../../app/happydom"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { scrollKey, scrollThumbMetrics } from "./scroll-view"

describe("scrollKey", () => {
  test("maps plain navigation keys", () => {
    expect(scrollKey({ key: "PageDown", altKey: false, ctrlKey: false, metaKey: false, shiftKey: false })).toBe(
      "page-down",
    )
    expect(scrollKey({ key: "ArrowUp", altKey: false, ctrlKey: false, metaKey: false, shiftKey: false })).toBe("up")
  })

  test("ignores modified keybinds", () => {
    expect(
      scrollKey({ key: "ArrowDown", altKey: false, ctrlKey: false, metaKey: true, shiftKey: false }),
    ).toBeUndefined()
    expect(scrollKey({ key: "PageUp", altKey: false, ctrlKey: true, metaKey: false, shiftKey: false })).toBeUndefined()
    expect(scrollKey({ key: "End", altKey: false, ctrlKey: false, metaKey: false, shiftKey: true })).toBeUndefined()
  })
})

describe("ScrollView user scroll gesture", () => {
  test("reports gestures from thumb drag and keyboard scrolling", async () => {
    const source = await Bun.file(new URL("./scroll-view.tsx", import.meta.url)).text()

    expect(source).toContain("onUserScrollGesture?: (viewport: HTMLDivElement, direction?: AutoScrollDirection) => void")
    expect(source).toContain("const markUserScrollGesture = (direction?: AutoScrollDirection)")
    expect(source).toContain("events.onUserScrollGesture?.(viewportRef, direction)")
    expect(source).toContain('"onUserScrollGesture",')
    expect(source).toContain('"onScroll",')

    const drag = source.slice(source.indexOf("const onThumbPointerDown"), source.indexOf("const onKeyDown"))
    expect(drag).toContain("startScrollTop: viewportRef.scrollTop")
    expect(drag).toContain('markUserScrollGesture(next < viewportRef.scrollTop ? "away" : "toward")')
    expect(drag).toContain("viewportRef.scrollTop = next")
    expect(drag).toContain('thumbRef.addEventListener("pointercancel", stopDragging)')
    expect(drag).toContain('thumbRef.addEventListener("lostpointercapture", stopDragging)')

    const gesture = source.slice(source.indexOf("const next = scrollKey(e)"), source.indexOf("const scrollAmount"))
    expect(gesture).toContain('markUserScrollGesture(["page-up", "home", "up"].includes(next) ? "away" : "toward")')
  })

  test("does not hijack keys while an editor has focus", async () => {
    const source = await Bun.file(new URL("./scroll-view.tsx", import.meta.url)).text()

    expect(source).toContain("if (focused instanceof HTMLElement && focused.isContentEditable) return")
  })
})

describe("scrollThumbMetrics", () => {
  test("uses the padded visual track for both position and drag travel", () => {
    expect(scrollThumbMetrics(10_000, 1_000, 0)).toEqual({
      height: 98.4,
      top: 8,
      maxScrollTop: 9_000,
      maxThumbTop: 885.6,
    })
    expect(scrollThumbMetrics(10_000, 1_000, 9_000)?.top).toBe(893.6)
  })

  test("hides the thumb when content does not overflow", () => {
    expect(scrollThumbMetrics(1_000, 1_000, 0)).toBeUndefined()
  })
})

const collapse = (s: string) => s.replace(/\s+/g, " ").trim()

// Lightweight CSS rule extractor: parses top-level selector { decls } blocks.
// scroll-view.css has no at-rules or nested blocks, so brace matching is flat.
function extractCssRules(css: string) {
  const rules: { selector: string; decls: Record<string, string> }[] = []
  let pos = 0
  while (pos < css.length) {
    const open = css.indexOf("{", pos)
    if (open === -1) break
    const selector = collapse(css.slice(pos, open))
    if (selector.startsWith("@")) {
      const close = css.indexOf("}", open)
      pos = close + 1
      continue
    }
    const close = css.indexOf("}", open)
    if (close === -1) break
    const block = css.slice(open + 1, close)
    const decls: Record<string, string> = {}
    for (const part of block.split(";")) {
      const colon = part.indexOf(":")
      if (colon === -1) continue
      const prop = collapse(part.slice(0, colon))
      const val = collapse(part.slice(colon + 1))
      if (prop) decls[prop] = val
    }
    rules.push({ selector, decls })
    pos = close + 1
  }
  return rules
}

// Splits a comma-separated selector list into individual selectors.
const splitSelectors = (selector: string) => selector.split(",").map((s) => collapse(s))

describe("scroll-view scrollbar theme contract", () => {
  // Only clean up nodes this describe block created; never touch other
  // tests' fixtures that may share the .scroll-view class.
  const createdNodes: HTMLElement[] = []
  let originalColorScheme: string | null

  beforeEach(() => {
    originalColorScheme = document.documentElement.getAttribute("data-color-scheme")
  })

  afterEach(() => {
    for (const node of createdNodes) node.remove()
    createdNodes.length = 0

    if (originalColorScheme === null) {
      document.documentElement.removeAttribute("data-color-scheme")
    } else {
      document.documentElement.setAttribute("data-color-scheme", originalColorScheme)
    }
  })

  test("thumb ::after binds to the resolved color variable, not to raw theme tokens", async () => {
    const css = await Bun.file(new URL("./scroll-view.css", import.meta.url)).text()
    const rules = extractCssRules(css)

    const afterRule = rules.find((r) => r.selector === ".scroll-view__thumb::after")
    expect(afterRule).toBeDefined()
    expect(afterRule!.decls["background-color"]).toBe("var(--scroll-view-thumb-resolved-color)")

    // The hover/dragging states share one declaration block with two
    // comma-separated selectors. Assert each selector individually so that
    // removing either one would fail the test.
    const activeRule = rules.find((r) =>
      splitSelectors(r.selector).includes(".scroll-view__thumb:hover::after"),
    )
    expect(activeRule).toBeDefined()
    expect(activeRule!.decls["background-color"]).toBe("var(--scroll-view-thumb-resolved-active-color)")

    const draggingRule = rules.find((r) =>
      splitSelectors(r.selector).includes('.scroll-view__thumb[data-dragging="true"]::after'),
    )
    expect(draggingRule).toBeDefined()
    expect(draggingRule!.decls["background-color"]).toBe("var(--scroll-view-thumb-resolved-active-color)")
  })

  test("dark override targets the real data-color-scheme attribute and re-binds the resolved variable", async () => {
    const css = await Bun.file(new URL("./scroll-view.css", import.meta.url)).text()
    const rules = extractCssRules(css)

    const darkRule = rules.find((r) => r.selector === ':root[data-color-scheme="dark"] .scroll-view__thumb')
    expect(darkRule).toBeDefined()
    expect(darkRule!.decls["--scroll-view-thumb-resolved-color"]).toContain("--scroll-view-thumb-dark-color")
    expect(darkRule!.decls["--scroll-view-thumb-resolved-active-color"]).toContain(
      "--scroll-view-thumb-active-dark-color",
    )

    // The obsolete selectors must not exist anywhere in the file.
    expect(rules.find((r) => r.selector.includes(".dark .scroll-view__thumb"))).toBeUndefined()
    expect(rules.find((r) => r.selector.includes('[data-theme="dark"] .scroll-view__thumb'))).toBeUndefined()
  })

  test("computed style resolves the dark override through data-color-scheme on the root element", async () => {
    const css = await Bun.file(new URL("./scroll-view.css", import.meta.url)).text()

    document.documentElement.setAttribute("data-color-scheme", "dark")
    const style = document.createElement("style")
    style.textContent = css
    document.head.appendChild(style)
    createdNodes.push(style)

    const root = document.createElement("div")
    root.className = "scroll-view"
    const thumb = document.createElement("div")
    thumb.className = "scroll-view__thumb"
    root.appendChild(thumb)
    document.body.appendChild(root)
    createdNodes.push(root)

    // happy-dom resolves custom properties on real elements (but not ::after),
    // so we read the resolved CSS variable the ::after rule consumes.
    expect(getComputedStyle(thumb).getPropertyValue("--scroll-view-thumb-resolved-color").trim()).toContain(
      "--scroll-view-thumb-dark-color",
    )
  })
})
