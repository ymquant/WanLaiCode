import { describe, expect, test } from "bun:test"

describe("DocxPreview", () => {
  test("preserves the document page size and scales it proportionally", async () => {
    const source = await Bun.file(new URL("./docx-preview.tsx", import.meta.url)).text()
    const styles = await Bun.file(new URL("../../index.css", import.meta.url)).text()

    expect(source).toContain("ignoreWidth: false")
    expect(source).toContain("ignoreHeight: false")
    expect(source).toContain("new ResizeObserver(fitPages)")
    expect(source).toContain("resizeObserver?.disconnect()")
    expect(source).toContain("let disposed = false")
    expect(source).toContain("if (disposed) return")
    expect(source).not.toContain("createResizeObserver")
    expect(source).toContain("Math.min(availableWidth / pageWidth, availableHeight / pageHeight)")
    expect(source).toContain('wrapper.querySelectorAll<HTMLElement>("section.docx")')
    expect(source).toContain("currentPage.style.zoom = `${scale}`")
    expect(source).not.toContain("wrapper.style.zoom")
    expect(source).not.toContain("wrapper.style.width = `${100 / scale}%`")
    expect(styles).toContain('[data-component="docx-reader"] .docx-wrapper')
    expect(styles).toContain("background: #f7f7f7 !important")
    expect(styles).toContain("align-items: center !important")
    expect(styles).toContain('[data-component="docx-reader"] section.docx')
    expect(styles).not.toContain('section.docx {\n    width: 100%')
    expect(styles).toContain("box-shadow: 0 1px 4px")
  })
})
