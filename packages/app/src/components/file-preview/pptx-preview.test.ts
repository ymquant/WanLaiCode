import { describe, expect, test } from "bun:test"

describe("PptxPreview renderer", () => {
  test("uses pptxviewjs PPTXViewer with canvas rendering", async () => {
    const source = await Bun.file(new URL("./pptx-preview.tsx", import.meta.url)).text()

    expect(source).toContain('import { PPTXViewer } from "pptxviewjs"')
    expect(source).toContain("new PPTXViewer(")
    expect(source).toContain("await viewer.loadFile")
    expect(source).toContain("await viewer.render")
    expect(source).toContain('data-component="pptx-viewer-canvas"')
    expect(source).toContain("viewer.previousSlide")
    expect(source).toContain("viewer.nextSlide")
    expect(source).not.toContain('import { init } from "pptx-preview"')
    expect(source).not.toContain("ppt/slides/slide")
  })

  test("matches the editor presentation layout and sizes canvases explicitly", async () => {
    const source = await Bun.file(new URL("./pptx-preview.tsx", import.meta.url)).text()

    expect(source).toContain('data-component="pptx-thumbnail-sidebar"')
    expect(source).toContain('data-component="pptx-thumbnail-canvas"')
    expect(source).toContain("renderSlide(index, canvas")
    expect(source).toContain("viewer.goToSlide")
    expect(source).toContain("createResizeObserver")
    expect(source).toContain("canvas.style.width")
    expect(source).toContain("canvas.width")
  })

  test("serializes resize renders and refreshes delayed chart thumbnails", async () => {
    const source = await Bun.file(new URL("./pptx-preview.tsx", import.meta.url)).text()

    expect(source).toContain("renderQueue = renderQueue.then")
    expect(source).toContain("clearTimeout(resizeTimer)")
    expect(source).toContain("chartRefreshTimer = window.setTimeout")
    expect(source).toContain("await renderThumbnails()")
    expect(source).not.toContain("void renderCurrent()")
  })

  test("uses theme tokens for thumbnail chrome and page badges", async () => {
    const source = await Bun.file(new URL("./pptx-preview.tsx", import.meta.url)).text()

    expect(source).toContain("bg-background-base")
    expect(source).toContain("bg-surface-base")
    expect(source).toContain("border-border-base")
    expect(source).not.toContain('bg-[#5f6368]')
    expect(source).not.toContain('border-[#1677ff]')
    expect(source).not.toContain('hover:border-[#b9c0c8]')
  })

  test("uses the full main stage without inset padding", async () => {
    const source = await Bun.file(new URL("./pptx-preview.tsx", import.meta.url)).text()

    expect(source).toContain("stageRef.clientWidth)")
    expect(source).toContain("stageRef.clientHeight)")
    expect(source).not.toContain("stageRef.clientWidth - 48")
    expect(source).not.toContain("stageRef.clientHeight - 48")
    expect(source).not.toContain('justify-center overflow-hidden bg-white p-6')
  })
})
