import { describe, expect, test } from "bun:test"
import { createDefaultOptions } from "../pierre"
import { lineCommentStyles } from "./line-comment-styles"

describe("lineCommentStyles", () => {
  test("keeps long displayed comments scrollable", () => {
    expect(lineCommentStyles).toContain('[data-slot="line-comment-body"]')
    expect(lineCommentStyles).toContain("max-height: min(30dvh, 220px)")
    expect(lineCommentStyles).toContain("overflow-y: auto")
    expect(lineCommentStyles).toContain("scrollbar-width: thin")
    expect(lineCommentStyles).toContain("::-webkit-scrollbar-thumb")
  })

  test("keeps inline comments inside the visible review width", () => {
    const css = createDefaultOptions("unified").unsafeCSS

    expect(css).toContain("left: 75px !important")
    expect(css).toContain("width: calc(var(--diffs-column-content-width, 100%) - 75px) !important")
  })
})
