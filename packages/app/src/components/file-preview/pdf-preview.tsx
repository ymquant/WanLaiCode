import { For, Show, createEffect, createSignal, onCleanup, onMount } from "solid-js"
import type { FileContent } from "@opencode-ai/sdk/v2"
import { useLanguage } from "@/context/language"
import type { PDFDocumentLoadingTask, PDFPageProxy } from "pdfjs-dist"
import { decodePdfBase64 } from "./pdf-bytes"
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url"
import { PDF_ZOOM_OPTIONS, clampPdfPage, nextPdfMatch, nextPdfScale, pdfAutomaticScale, pdfToolbarVisibility, type PdfZoomOption } from "./pdf-controls"

let pdfjsPromise: Promise<typeof import("pdfjs-dist")> | undefined

function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import("pdfjs-dist").then((pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl
      return pdfjs
    })
  }
  return pdfjsPromise
}

interface TextItem {
  str: string
  dir: string
  transform: number[]
  width: number
  height: number
  fontName: string
}
interface TextContent {
  items: TextItem[]
  styles: Record<string, unknown>
}

interface PageEntry {
  page: PDFPageProxy
  text: TextContent | undefined
}

interface SearchMatch {
  pageIdx: number
  itemIdx: number
  text: string
}

export function PdfPreview(props: { content: FileContent }) {
  const i18n = useLanguage()
  const [pages, setPages] = createSignal<PageEntry[]>([])
  const [error, setError] = createSignal<string>()
  const [scale, setScale] = createSignal(1)
  const [totalPages, setTotalPages] = createSignal(0)
  const [currentPage, setCurrentPage] = createSignal(1)
  const [searchQuery, setSearchQuery] = createSignal("")
  const [searchVisible, setSearchVisible] = createSignal(false)
  const [searchMatches, setSearchMatches] = createSignal<SearchMatch[]>([])
  const [activeMatchIdx, setActiveMatchIdx] = createSignal(-1)
  const [pageInput, setPageInput] = createSignal("1")
  const [zoomOption, setZoomOption] = createSignal<PdfZoomOption | string>("auto")
  const [toolbarVisibility, setToolbarVisibility] = createSignal({ page: true, search: true })
  const showSearch = () => toolbarVisibility().search
  const showPageNavigation = () => toolbarVisibility().page

  let loadingTask: PDFDocumentLoadingTask | undefined
  let scrollRef!: HTMLDivElement
  let pageRefs: Map<number, HTMLDivElement> = new Map()
  let disposed = false
  let searchInputRef!: HTMLInputElement
  let previewRef!: HTMLDivElement
  let pageMeasureRef!: HTMLDivElement
  let zoomRef!: HTMLDivElement
  let searchMeasureRef!: HTMLDivElement
  let searchRun = 0
  let pendingPageJump: number | undefined
  let pageControlWidth = 0
  let zoomControlWidth = 0
  let searchControlWidth = 0

  function measureToolbar(containerWidth = previewRef?.clientWidth ?? 0) {
    if (!previewRef) return
    if (pageMeasureRef) pageControlWidth = pageMeasureRef.scrollWidth
    if (zoomRef) zoomControlWidth = zoomRef.scrollWidth
    if (searchMeasureRef) searchControlWidth = searchMeasureRef.scrollWidth
    setToolbarVisibility(pdfToolbarVisibility(
      containerWidth,
      pageControlWidth,
      zoomControlWidth,
      searchControlWidth,
      8,
      24,
    ))
  }

  onMount(() => {
    void renderPdf()
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "f") {
        e.preventDefault()
        setSearchVisible(true)
        searchInputRef?.focus()
      }
      if (e.key === "Escape" && searchVisible()) {
        closeSearch()
      }
    }
    window.addEventListener("keydown", handler)
    const toolbarObserver = new ResizeObserver(([entry]) => {
      measureToolbar(entry.contentRect.width)
      refreshZoomMode()
    })
    if (previewRef) toolbarObserver.observe(previewRef)
    requestAnimationFrame(measureToolbar)
    onCleanup(() => {
      window.removeEventListener("keydown", handler)
      toolbarObserver.disconnect()
    })
  })

  onCleanup(() => {
    disposed = true
    loadingTask?.destroy()
  })

  async function renderPdf() {
    try {
      const b64 = props.content.content
      if (!b64) return
      const bytes = decodePdfBase64(b64)
      const pdfjs = await loadPdfjs()
      if (disposed) return
      loadingTask = pdfjs.getDocument({ data: bytes })
      const doc = await loadingTask.promise
      if (disposed) { loadingTask.destroy(); return }
      setTotalPages(doc.numPages)
      requestAnimationFrame(measureToolbar)
      const list: PageEntry[] = []
      for (let i = 1; i <= doc.numPages; i++) {
        if (disposed) { loadingTask.destroy(); return }
        const page = await doc.getPage(i)
        list.push({ page, text: undefined })
        setPages([...list])
        if (i === 1) requestAnimationFrame(refreshZoomMode)
      }
    } catch (e) {
      if (!disposed) setError(e instanceof Error ? e.message : i18n.t("session.files.preview.pdf.loadFailed"))
    }
  }

  createEffect(() => {
    const q = searchQuery().trim().toLowerCase()
    const loadedPageCount = pages().length
    void loadedPageCount
    if (!q) { setSearchMatches([]); setActiveMatchIdx(-1); return }
    void runSearch(q)
  })

  async function runSearch(q: string) {
    const run = ++searchRun
    await loadPdfjs()
    const current = pages()
    const matches: SearchMatch[] = []
    for (let pi = 0; pi < current.length; pi++) {
      const entry = current[pi]
      if (!entry.text) {
        entry.text = await entry.page.getTextContent() as unknown as TextContent
      }
      const text = entry.text!
      for (let ii = 0; ii < text.items.length; ii++) {
        const item = text.items[ii]
        if (!item.str) continue
        if (item.str.toLowerCase().includes(q)) {
          matches.push({ pageIdx: pi, itemIdx: ii, text: item.str })
        }
      }
    }
    if (disposed || run !== searchRun || searchQuery().trim().toLowerCase() !== q) return
    setSearchMatches(matches)
    setActiveMatchIdx(matches.length > 0 ? 0 : -1)
    if (matches.length > 0) {
      scrollToMatch(0)
    }
  }

  function scrollToMatch(idx: number) {
    const m = searchMatches()[idx]
    if (!m) return
    setActiveMatchIdx(idx)
    const el = pageRefs.get(m.pageIdx)
    el?.scrollIntoView({ behavior: "smooth", block: "center" })
  }

  function navigateMatch(delta: number) {
    const matches = searchMatches()
    const next = nextPdfMatch(activeMatchIdx(), matches.length, delta < 0 ? -1 : 1)
    if (next < 0) return
    scrollToMatch(next)
  }

  function closeSearch() {
    searchRun++
    setSearchVisible(false)
    setSearchQuery("")
    setSearchMatches([])
    setActiveMatchIdx(-1)
  }

  function goToPage(value: string) {
    const page = clampPdfPage(value, totalPages(), currentPage())
    pendingPageJump = page
    setCurrentPage(page)
    setPageInput(String(page))
    pageRefs.get(page - 1)?.scrollIntoView({ behavior: "auto", block: "start" })
    requestAnimationFrame(() => {
      pendingPageJump = undefined
      refreshZoomMode()
    })
  }

  function applyScale(next: number, option = String(next)) {
    const value = Math.min(Math.max(next, 0.25), 4)
    setScale(value)
    setZoomOption(option)
  }

  function scaleForMode(mode: PdfZoomOption | string) {
    const page = pages()[currentPage() - 1]?.page
    if (!page || !scrollRef) return scale()
    const viewport = page.getViewport({ scale: 1 })
    const width = scrollRef.clientWidth - 32
    const height = scrollRef.clientHeight - 32
    if (mode === "auto") return pdfAutomaticScale(viewport.width, viewport.height, width, height)
    if (mode === "actual") return 1
    if (mode === "page-fit") return Math.min(width / viewport.width, height / viewport.height)
    if (mode === "page-width") return width / viewport.width
    return Number.parseFloat(mode)
  }

  function applyZoomOption(mode: PdfZoomOption | string) {
    applyScale(scaleForMode(mode), mode)
  }

  function refreshZoomMode() {
    const mode = zoomOption()
    if (mode === "auto" || mode === "page-fit" || mode === "page-width") applyZoomOption(mode)
  }

  function onScroll() {
    if (!scrollRef) return
    if (pendingPageJump !== undefined) {
      setCurrentPage(pendingPageJump)
      setPageInput(String(pendingPageJump))
      return
    }
    const center = scrollRef.clientHeight / 2
    let detected: number | undefined
    for (const [idx, el] of pageRefs) {
      const rect = el.getBoundingClientRect()
      const containerRect = scrollRef.getBoundingClientRect()
      const top = rect.top - containerRect.top
      const bottom = rect.bottom - containerRect.top
      if (top <= center && bottom >= center) {
        detected = idx + 1
        break
      }
    }
    if (detected === undefined) return
    if (detected === currentPage()) return
    setCurrentPage(detected)
    setPageInput(String(detected))
    refreshZoomMode()
  }

  return (
    <Show
      when={!error()}
      fallback={
        <div class="flex h-full items-center justify-center text-text-weak p-4 text-center">{error()}</div>
      }
    >
      <div ref={previewRef!} class="h-full flex flex-col overflow-hidden">
        <Show when={totalPages() > 0}>
          <div class="grid h-10 shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 border-b border-border-weaker-base bg-background-base px-3 shadow-xs">
            <Show when={showPageNavigation()} fallback={<div />}>
            <div ref={pageMeasureRef!} data-pdf-toolbar="page" class="flex min-w-0 items-center gap-1 overflow-hidden">
              <button
                type="button"
                class="flex size-7 items-center justify-center rounded-md text-text-weak transition-colors hover:bg-surface-raised-base hover:text-text-strong disabled:opacity-30"
                onClick={() => goToPage(String(currentPage() - 1))}
                disabled={currentPage() <= 1}
                aria-label={i18n.t("session.files.preview.pdf.previousPage")}
              >
                ‹
              </button>
              <input
                aria-label={i18n.t("session.files.preview.pdf.pageNumber")}
                inputmode="numeric"
                class="h-7 w-10 rounded-md border border-border-weaker-base bg-surface-base px-1 text-center text-12-medium tabular-nums text-text-strong outline-none focus:border-border-strong-base"
                value={pageInput()}
                onInput={(e) => setPageInput(e.currentTarget.value)}
                onFocus={(e) => e.currentTarget.select()}
                onBlur={(e) => goToPage(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key !== "Enter") return
                  goToPage(e.currentTarget.value)
                  e.currentTarget.blur()
                }}
              />
              <span class="min-w-7 text-11-medium tabular-nums text-text-weaker">/ {totalPages()}</span>
              <button
                type="button"
                class="h-7 shrink-0 rounded-md px-2 text-11-medium text-text-weak transition-colors hover:bg-surface-raised-base hover:text-text-strong"
                onClick={() => goToPage(pageInput())}
                aria-label={i18n.t("session.files.preview.pdf.goToPage")}
              >
                {i18n.t("session.files.preview.pdf.goToPage")}
              </button>
              <button
                type="button"
                class="flex size-7 items-center justify-center rounded-md text-text-weak transition-colors hover:bg-surface-raised-base hover:text-text-strong disabled:opacity-30"
                onClick={() => goToPage(String(currentPage() + 1))}
                disabled={currentPage() >= totalPages()}
                aria-label={i18n.t("session.files.preview.pdf.nextPage")}
              >
                ›
              </button>
            </div>
            </Show>

            <div ref={zoomRef!} data-pdf-toolbar="zoom" class="flex min-w-0 items-center gap-1">
              <div data-pdf-toolbar="zoom-step" class="flex shrink-0 items-center">
              <button
                type="button"
                class="flex size-7 items-center justify-center text-text-weak transition-colors hover:text-text-strong"
                onClick={() => applyScale(nextPdfScale(scale(), -1))}
                aria-label={i18n.t("session.files.preview.pdf.zoomOut")}
              >
                −
              </button>
              <div class="h-4 border-l border-border-strong-base" />
              <button
                type="button"
                class="flex size-7 items-center justify-center text-text-weak transition-colors hover:text-text-strong"
                onClick={() => applyScale(nextPdfScale(scale(), 1))}
                aria-label={i18n.t("session.files.preview.pdf.zoomIn")}
              >
                +
              </button>
              </div>
              <select
                aria-label={i18n.t("session.files.preview.pdf.zoomOptions")}
                data-pdf-toolbar="zoom-options"
                class="h-7 w-24 cursor-pointer rounded-md bg-transparent px-1 text-11-medium text-text-strong outline-none hover:bg-surface-raised-base focus:bg-surface-raised-base"
                value={zoomOption()}
                onChange={(e) => applyZoomOption(e.currentTarget.value)}
              >
                <Show when={!PDF_ZOOM_OPTIONS.some(([value]) => value === zoomOption())}>
                  <option value={zoomOption()}>{Math.round(scale() * 100)}%</option>
                </Show>
                <For each={PDF_ZOOM_OPTIONS}>{([value, label]) => <option value={value}>{label.endsWith("%") ? label : i18n.t(label)}</option>}</For>
              </select>
            </div>

            <Show when={showSearch()} fallback={<div />}>
            <div ref={searchMeasureRef!} data-pdf-toolbar="search" class="flex min-w-0 justify-end">
              <button
                type="button"
                class="flex size-7 items-center justify-center rounded-md text-text-weak transition-colors hover:bg-surface-raised-base hover:text-text-strong"
                onClick={() => {
                  if (searchVisible()) return closeSearch()
                  setSearchVisible(true)
                  queueMicrotask(() => searchInputRef?.focus())
                }}
                aria-label={i18n.t("session.files.preview.pdf.search")}
                title={i18n.t("session.files.preview.pdf.searchShortcut")}
              >
                ⌕
              </button>
            </div>
            </Show>
          </div>
        </Show>

        <Show when={searchVisible()}>
          <div class="absolute right-3 top-12 z-30 flex h-10 w-[min(420px,calc(100%-24px))] items-center gap-1 rounded-lg border border-border-base bg-surface-raised-base px-2 shadow-lg">
            <input
              ref={searchInputRef!}
              type="text"
              class="min-w-0 flex-1 bg-transparent px-1 text-12-regular text-text-strong outline-none placeholder:text-text-weak"
              placeholder={i18n.t("session.files.preview.pdf.findPlaceholder")}
              value={searchQuery()}
              onInput={(e) => setSearchQuery(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return
                e.preventDefault()
                navigateMatch(e.shiftKey ? -1 : 1)
              }}
            />
            <span class="text-11-medium text-text-weaker tabular-nums">
              {searchMatches().length > 0 ? `${activeMatchIdx() + 1}/${searchMatches().length}` : "0/0"}
            </span>
            <button
              type="button"
              class="flex size-7 items-center justify-center rounded-md text-text-weak hover:bg-surface-base hover:text-text-strong disabled:opacity-30"
              onClick={() => navigateMatch(-1)}
              disabled={searchMatches().length === 0}
              aria-label={i18n.t("session.files.preview.pdf.previousMatch")}
            >
              ‹
            </button>
            <button
              type="button"
              class="flex size-7 items-center justify-center rounded-md text-text-weak hover:bg-surface-base hover:text-text-strong disabled:opacity-30"
              onClick={() => navigateMatch(1)}
              disabled={searchMatches().length === 0}
              aria-label={i18n.t("session.files.preview.pdf.nextMatch")}
            >
              ›
            </button>
            <button
              type="button"
              class="flex size-7 items-center justify-center rounded-md text-text-weak hover:bg-surface-base hover:text-text-strong"
              onClick={closeSearch}
              aria-label={i18n.t("session.files.preview.pdf.closeSearch")}
            >
              ✕
            </button>
          </div>
        </Show>

        <div
          ref={scrollRef!}
          class="flex-1 min-h-0 overflow-auto bg-[#525659] flex flex-col items-center gap-3 p-3"
          onScroll={onScroll}
        >
          <For each={pages()}>
            {(entry, idx) => (
              <PdfPageView
                entry={entry}
                scale={scale()}
                pageNumber={idx() + 1}
                searchMatches={searchMatches()}
                activeMatchIdx={activeMatchIdx()}
                ref={(el) => { if (el) pageRefs.set(idx(), el) }}
              />
            )}
          </For>
          <Show when={pages().length === 0 && !error()}>
            <div class="flex h-full items-center justify-center text-white/60">{i18n.t("session.files.preview.loading")}</div>
          </Show>
        </div>
      </div>
    </Show>
  )
}

function PdfPageView(props: {
  entry: PageEntry
  scale: number
  pageNumber: number
  searchMatches: SearchMatch[]
  activeMatchIdx: number
  ref: (el: HTMLDivElement) => void
}) {
  const [, setRenderTick] = createSignal(0)
  let canvasRef!: HTMLCanvasElement
  let textDivRef!: HTMLDivElement
  let disposed = false
  let renderQueue = Promise.resolve()
  let latestRenderVersion = 0
  let latestTextVersion = 0

  onCleanup(() => {
    disposed = true
    props.entry.page.cleanup()
  })

  createEffect(() => {
    const page = props.entry.page
    const s = props.scale
    void props.scale
    const renderVersion = ++latestRenderVersion

    renderQueue = renderQueue.catch(() => undefined).then(async () => {
        const viewport = page.getViewport({ scale: s })
        const canvas = canvasRef
        if (!canvas || renderVersion !== latestRenderVersion || disposed) return
        canvas.width = Math.floor(viewport.width * (window.devicePixelRatio || 1))
        canvas.height = Math.floor(viewport.height * (window.devicePixelRatio || 1))
        canvas.style.width = `${Math.floor(viewport.width)}px`
        canvas.style.height = `${Math.floor(viewport.height)}px`
        const ctx = canvas.getContext("2d")
        if (!ctx) return
        ctx.setTransform(window.devicePixelRatio || 1, 0, 0, window.devicePixelRatio || 1, 0, 0)
        await page.render({ canvasContext: ctx, viewport, canvas }).promise
        if (renderVersion !== latestRenderVersion || disposed) return
        setRenderTick((t) => t + 1)
    })
  })

  createEffect(() => {
    const page = props.entry.page
    const s = props.scale
    void props.scale
    const tick = (() => { try { return (props.scale, props.searchMatches.length, props.activeMatchIdx) } catch { return 0 } })()
    void tick
    const textVersion = ++latestTextVersion

    void (async () => {
      try {
        const viewport = page.getViewport({ scale: s })
        const textDiv = textDivRef
        if (!textDiv || disposed) return

        let textContent = props.entry.text
        if (!textContent) {
          textContent = await page.getTextContent() as unknown as TextContent
          if (disposed || textVersion !== latestTextVersion) return
          props.entry.text = textContent
        }

        if (disposed || textVersion !== latestTextVersion) return

        const matches = props.searchMatches
        const activeIdx = props.activeMatchIdx

        textDiv.style.width = `${Math.floor(viewport.width)}px`
        textDiv.style.height = `${Math.floor(viewport.height)}px`
        textDiv.innerHTML = ""

        for (let i = 0; i < textContent.items.length; i++) {
          const item = textContent.items[i]
          if (!item.str) continue

          const tx = item.transform
          const span = document.createElement("span")
          span.textContent = item.str
          span.style.position = "absolute"
          span.style.left = `${tx[4] * s}px`
          span.style.top = `${(viewport.height - tx[5] * s) - (item.height * s)}px`
          span.style.fontSize = `${Math.abs(tx[0]) * s}px`
          span.style.fontFamily = "sans-serif"
          span.style.color = "transparent"
          span.style.whiteSpace = "pre"
          span.style.pointerEvents = "auto"
          span.dataset.itemIdx = String(i)

          for (let mi = 0; mi < matches.length; mi++) {
            const m = matches[mi]
            if (m.pageIdx === props.pageNumber - 1 && m.itemIdx === i) {
              span.style.backgroundColor = mi === activeIdx ? "rgba(255, 180, 0, 0.6)" : "rgba(255, 255, 0, 0.4)"
              span.style.borderRadius = "2px"
              break
            }
          }

          textDiv.appendChild(span)
        }
      } catch {}
    })()
  })

  return (
    <div
      ref={props.ref}
      class="relative bg-white shadow-md"
      style={{ width: `${Math.floor(props.entry.page.getViewport({ scale: props.scale }).width)}px` }}
    >
      <div
        ref={textDivRef!}
        class="absolute inset-0 z-10 select-text"
        style={{ cursor: "text" }}
      />
      <canvas ref={canvasRef!} class="block" />
    </div>
  )
}
