import { describe, expect, test } from "bun:test"

describe("file preview lifecycle", () => {
  test("app file previews read app translations from the language context", async () => {
    const files = [
      "binary-placeholder.tsx",
      "docx-preview.tsx",
      "font-preview.tsx",
      "pdf-preview.tsx",
      "pptx-preview.tsx",
      "spreadsheet-preview.tsx",
    ]
    for (const file of files) {
      const source = await Bun.file(new URL(file, import.meta.url)).text()
      expect(source).toContain('from "@/context/language"')
      expect(source).not.toContain('from "@opencode-ai/ui/context/i18n"')
    }
  })

  test("uses pdf.js with text layer for selection and search", async () => {
    const source = await Bun.file(new URL("./pdf-preview.tsx", import.meta.url)).text()

    expect(source).toContain('import("pdfjs-dist")')
    expect(source).toContain("pdfjs.getDocument({ data: bytes })")
    expect(source).toContain("getTextContent")
    expect(source).toContain("textDivRef")
    expect(source).toContain("searchMatches")
    expect(source).toContain("session.files.preview.pdf.searchShortcut")
    expect(source).not.toContain("<iframe")
  })

  test("provides page navigation and selectable zoom controls with keyboard search navigation", async () => {
    const source = await Bun.file(new URL("./pdf-preview.tsx", import.meta.url)).text()

    expect(source).toContain('aria-label={i18n.t("session.files.preview.pdf.pageNumber")}')
    expect(source).toContain('aria-label={i18n.t("session.files.preview.pdf.zoomOptions")}')
    expect(source).toContain('e.key !== "Enter"')
    expect(source).toContain("shiftKey")
    expect(source).toContain("PDF_ZOOM_OPTIONS")
    expect(source).not.toContain("rerenderAllText")
    expect(source).toContain("const center = scrollRef.clientHeight / 2")
    expect(source).not.toContain("containerTop + containerHeight / 2")
    expect(source).toContain('aria-label={i18n.t("session.files.preview.pdf.goToPage")}')
    expect(source).toContain("onClick={() => goToPage(pageInput())}")
  })

  test("does not let scroll tracking overwrite a typed page jump", async () => {
    const source = await Bun.file(new URL("./pdf-preview.tsx", import.meta.url)).text()

    expect(source).toContain("let pendingPageJump: number | undefined")
    expect(source).toContain("pendingPageJump = page")
    expect(source).toContain('scrollIntoView({ behavior: "auto", block: "start" })')
    expect(source).toContain("if (pendingPageJump !== undefined)")
  })

  test("remeasures toolbar groups after they mount and ignores stale text renders", async () => {
    const source = await Bun.file(new URL("./pdf-preview.tsx", import.meta.url)).text()

    expect(source).toContain("function measureToolbar(containerWidth = previewRef?.clientWidth ?? 0)")
    expect(source).toContain("requestAnimationFrame(measureToolbar)")
    expect(source).toContain("let latestTextVersion = 0")
    expect(source).toContain("textVersion !== latestTextVersion")
    expect(source).toContain("if (pageMeasureRef) pageControlWidth = pageMeasureRef.scrollWidth")
    expect(source).toContain("if (searchMeasureRef) searchControlWidth = searchMeasureRef.scrollWidth")
  })

  test("refreshes an active search as later PDF pages finish loading", async () => {
    const source = await Bun.file(new URL("./pdf-preview.tsx", import.meta.url)).text()

    expect(source).toContain("const loadedPageCount = pages().length")
    expect(source).toContain("void loadedPageCount")
  })

  test("keeps toolbar controls from overlapping in narrow windows", async () => {
    const source = await Bun.file(new URL("./pdf-preview.tsx", import.meta.url)).text()

    expect(source).toContain("grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]")
    expect(source).not.toContain('class="absolute left-3 flex items-center gap-1"')
    expect(source).not.toContain('class="absolute right-3 flex items-center gap-1"')
    expect(source).toContain("new ResizeObserver")
    expect(source).toContain('<select')
    expect(source).not.toContain('data-pdf-action="fit-width"')
    expect(source).not.toContain('data-pdf-action="fit-page"')
  })

  test("hides search before page navigation while keeping zoom controls", async () => {
    const source = await Bun.file(new URL("./pdf-preview.tsx", import.meta.url)).text()

    expect(source).toContain('data-pdf-toolbar="search"')
    expect(source).toContain('data-pdf-toolbar="page"')
    expect(source).toContain('data-pdf-toolbar="zoom"')
    expect(source).toContain("pdfToolbarVisibility(")
    expect(source).toContain("pageControlWidth")
    expect(source).toContain("zoomControlWidth")
    expect(source).toContain("searchControlWidth")
    expect(source).toContain('data-pdf-toolbar="zoom" class="flex min-w-0 items-center')
  })

  test("uses the PDF panel width instead of the Electron window width", async () => {
    const source = await Bun.file(new URL("./pdf-preview.tsx", import.meta.url)).text()

    expect(source).toContain("new ResizeObserver")
    expect(source).toContain("entry.contentRect.width")
    expect(source).toContain("showSearch()")
    expect(source).toContain("showPageNavigation()")
    expect(source).not.toContain("max-[760px]:hidden")
    expect(source).not.toContain("max-[560px]:hidden")
  })

  test("observes an element that exists when the component mounts", async () => {
    const source = await Bun.file(new URL("./pdf-preview.tsx", import.meta.url)).text()

    expect(source).toContain('ref={previewRef!} class="h-full flex flex-col overflow-hidden"')
    expect(source).toContain("if (previewRef) toolbarObserver.observe(previewRef)")
    expect(source).not.toContain("toolbarObserver.observe(toolbarRef)")
  })

  test("applies the default automatic mode after the first page loads", async () => {
    const source = await Bun.file(new URL("./pdf-preview.tsx", import.meta.url)).text()

    expect(source).toContain('createSignal<PdfZoomOption | string>("auto")')
    expect(source).toContain("requestAnimationFrame(refreshZoomMode)")
    expect(source).not.toContain('createSignal(1.5)')
    expect(source).not.toContain('createSignal("150%")')
  })

  test("defaults to automatic zoom and keeps the zoom menu separate from minus and plus", async () => {
    const source = await Bun.file(new URL("./pdf-preview.tsx", import.meta.url)).text()

    expect(source).toContain('createSignal<PdfZoomOption | string>("auto")')
    expect(source).toContain('data-pdf-toolbar="zoom-step"')
    expect(source).toContain('data-pdf-toolbar="zoom-options"')
    expect(source).toContain('border-l border-border-strong-base')
  })

  test("keeps searchable text transparent while painting highlights behind it", async () => {
    const source = await Bun.file(new URL("./pdf-preview.tsx", import.meta.url)).text()

    expect(source).not.toContain('span.style.color = ""')
    expect(source).toContain('span.style.backgroundColor = mi === activeIdx')
  })

  test("serializes canvas rendering when initial fit-width changes the first page scale", async () => {
    const source = await Bun.file(new URL("./pdf-preview.tsx", import.meta.url)).text()

    expect(source).toContain("let renderQueue = Promise.resolve()")
    expect(source).toContain("const renderVersion = ++latestRenderVersion")
    expect(source).toContain("if (renderVersion !== latestRenderVersion || disposed) return")
    expect(source).toContain("renderQueue = renderQueue.catch(() => undefined).then")
  })

  test("uses the optimized PDF decoder", async () => {
    const source = await Bun.file(new URL("./pdf-preview.tsx", import.meta.url)).text()

    expect(source).toContain("decodePdfBase64")
    expect(source).not.toContain("binary.charCodeAt")
  })

  test("does not register a font after its preview is disposed", async () => {
    const source = await Bun.file(new URL("./font-preview.tsx", import.meta.url)).text()

    expect(source).toContain("if (disposed) return")
    expect(source).toContain("disposed = true")
  })

  test("uses localized strings across document previews", async () => {
    const sources = await Promise.all([
      "pdf-preview.tsx",
      "docx-preview.tsx",
      "spreadsheet-preview.tsx",
      "pptx-preview.tsx",
      "font-preview.tsx",
    ].map((file) => Bun.file(new URL(`./${file}`, import.meta.url)).text()))

    for (const source of sources) expect(source).toContain("i18n.t(")
    expect(sources.join("\n")).not.toContain(">Loading...<")
    expect(sources.join("\n")).not.toContain(">Empty worksheet<")
    expect(sources.join("\n")).not.toContain(">跳转<")
  })
})
