import { createResizeObserver } from "@solid-primitives/resize-observer"
import { For, Show, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import type { FileContent } from "@opencode-ai/sdk/v2"
import { PPTXViewer } from "pptxviewjs"
import { useLanguage } from "@/context/language"
import { validateOfficeZip } from "./office-zip"

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

export function PptxPreview(props: { content: FileContent; filename?: string }) {
  const i18n = useLanguage()
  const [store, setStore] = createStore({
    error: "",
    ready: false,
    slideIndex: 0,
    slideCount: 0,
  })
  const thumbnailRefs: HTMLCanvasElement[] = []
  let stageRef: HTMLDivElement | undefined
  let canvasRef: HTMLCanvasElement | undefined
  let viewer: PPTXViewer | undefined
  let resizeTimer: number | undefined
  let chartRefreshTimer: number | undefined
  let disposed = false
  let renderQueue = Promise.resolve()

  const sizeCanvas = (canvas: HTMLCanvasElement, width: number, height: number) => {
    const ratio = window.devicePixelRatio || 1
    canvas.style.width = `${width}px`
    canvas.style.height = `${height}px`
    canvas.width = Math.round(width * ratio)
    canvas.height = Math.round(height * ratio)
  }

  const renderCurrent = async () => {
    if (!viewer || !canvasRef) return
    try {
      await viewer.render(canvasRef, { quality: "high" })
      setStore("slideIndex", viewer.getCurrentSlideIndex())
    } catch (e) {
      setStore("error", e instanceof Error ? e.message : i18n.t("session.files.preview.presentation.renderSlideFailed"))
    }
  }

  const enqueueRender = (operation: () => Promise<void>) => {
    renderQueue = renderQueue.then(operation).catch((error) => {
      setStore("error", error instanceof Error ? error.message : i18n.t("session.files.preview.presentation.renderFailed"))
    })
    return renderQueue
  }

  const resizeMainCanvas = () => {
    if (!stageRef || !canvasRef) return
    window.clearTimeout(resizeTimer)
    resizeTimer = window.setTimeout(() => {
      if (!stageRef || !canvasRef) return
      const width = Math.max(1, stageRef.clientWidth)
      const height = Math.max(1, stageRef.clientHeight)
      void enqueueRender(async () => {
        if (!canvasRef) return
        sizeCanvas(canvasRef, width, height)
        if (store.ready) await renderCurrent()
      })
    }, 80)
  }

  const renderThumbnails = async () => {
    if (!viewer) return
    const active = store.slideIndex
    await thumbnailRefs.reduce(
      (previous, canvas, index) =>
        previous.then(async () => {
          sizeCanvas(canvas, 192, 108)
          await viewer?.renderSlide(index, canvas, { quality: "medium" })
        }),
      Promise.resolve(),
    )
    await viewer.goToSlide(active, canvasRef ?? undefined)
    setStore("slideIndex", active)
  }

  onMount(async () => {
    const b64 = props.content.content
    if (!b64 || !canvasRef) return
    if (stageRef) createResizeObserver(stageRef, resizeMainCanvas)
    if (stageRef) {
      sizeCanvas(canvasRef, Math.max(1, stageRef.clientWidth), Math.max(1, stageRef.clientHeight))
    }
    try {
      const validated = await validateOfficeZip(base64ToUint8Array(b64))
      if (disposed) return
      viewer = new PPTXViewer({
        canvas: canvasRef,
        backgroundColor: "#ffffff",
        slideSizeMode: "fit",
        autoChartRerenderDelayMs: 0,
      })
      await viewer.loadFile(validated)
      if (disposed) {
        viewer.destroy()
        viewer = undefined
        return
      }
      setStore("slideCount", viewer.getSlideCount())
      await enqueueRender(renderCurrent)
      if (disposed) return
      setStore("ready", true)
      await Promise.resolve()
      await enqueueRender(async () => {
        if (disposed) return
        await renderThumbnails()
      })
      if (disposed) return
      chartRefreshTimer = window.setTimeout(() => {
        if (disposed) return
        void enqueueRender(async () => {
          await renderThumbnails()
        })
      }, 300)
    } catch (e) {
      if (disposed) return
      setStore("error", e instanceof Error ? e.message : i18n.t("session.files.preview.presentation.loadFailed"))
      setStore("ready", true)
    }
  })

  onCleanup(() => {
    disposed = true
    window.clearTimeout(resizeTimer)
    window.clearTimeout(chartRefreshTimer)
    viewer?.destroy()
    viewer = undefined
  })

  const goPrev = async () => {
    if (!viewer) return
    await enqueueRender(async () => {
      if (!viewer) return
      await viewer.previousSlide(canvasRef ?? undefined)
      setStore("slideIndex", viewer.getCurrentSlideIndex())
    })
  }

  const goNext = async () => {
    if (!viewer) return
    await enqueueRender(async () => {
      if (!viewer) return
      await viewer.nextSlide(canvasRef ?? undefined)
      setStore("slideIndex", viewer.getCurrentSlideIndex())
    })
  }

  const goToSlide = async (index: number) => {
    if (!viewer) return
    await enqueueRender(async () => {
      if (!viewer) return
      await viewer.goToSlide(index, canvasRef ?? undefined)
      setStore("slideIndex", viewer.getCurrentSlideIndex())
    })
  }

  return (
    <div class="relative flex h-full min-h-0 flex-col bg-background-base">
      <div class="flex min-h-0 flex-1">
        <Show when={store.ready && !store.error && store.slideCount > 0}>
          <aside
            data-component="pptx-thumbnail-sidebar"
            class="w-[220px] shrink-0 overflow-y-auto border-r border-border-base bg-surface-base"
          >
            <div class="border-b border-border-base px-3 py-2 text-12-regular text-text-weak">
              {i18n.t("session.files.preview.presentation.slides", { count: store.slideCount })}
            </div>
            <div class="flex flex-col gap-2 p-2">
              <For each={Array.from({ length: store.slideCount }, (_, index) => index)}>
                {(index) => (
                  <button
                    type="button"
                    class="relative overflow-hidden rounded border-2 bg-background-base p-1 text-left"
                    classList={{
                      "border-icon-interactive-base": store.slideIndex === index,
                      "border-transparent hover:border-border-strong-base": store.slideIndex !== index,
                    }}
                    onClick={() => goToSlide(index)}
                  >
                    <canvas
                      ref={(element) => (thumbnailRefs[index] = element)}
                      data-component="pptx-thumbnail-canvas"
                      class="block h-auto w-full"
                    />
                    <span class="absolute bottom-1 left-1 border border-border-base bg-background-base px-1.5 py-0.5 text-11-medium text-text-strong">
                      {index + 1}
                    </span>
                  </button>
                )}
              </For>
            </div>
          </aside>
        </Show>

        <div ref={stageRef} class="flex min-w-0 flex-1 items-center justify-center overflow-hidden bg-white">
          <Show when={store.error}>
            <div class="p-6 text-text-weak">{store.error}</div>
          </Show>
          <canvas
            ref={canvasRef}
            data-component="pptx-viewer-canvas"
            class="block max-h-full max-w-full bg-white"
          />
        </div>
      </div>

      <Show when={store.ready && !store.error && store.slideCount > 0}>
        <div class="flex shrink-0 items-center justify-between border-t border-border-base bg-background-base px-4 py-2">
          <div class="min-w-0 text-13-regular text-text-weak">
            {props.filename || i18n.t("session.files.preview.presentation.name")}
          </div>
          <div class="flex items-center gap-2">
            <button
              type="button"
              class="rounded px-3 py-1 text-13-medium text-text-weak transition-colors hover:bg-surface-base disabled:opacity-40"
              disabled={store.slideIndex <= 0}
              onClick={goPrev}
            >
              ←
            </button>
            <span class="min-w-[48px] text-center text-12-medium tabular-nums text-text-weak">
              {store.slideIndex + 1} / {store.slideCount}
            </span>
            <button
              type="button"
              class="rounded px-3 py-1 text-13-medium text-text-weak transition-colors hover:bg-surface-base disabled:opacity-40"
              disabled={store.slideIndex >= store.slideCount - 1}
              onClick={goNext}
            >
              →
            </button>
          </div>
        </div>
      </Show>

      <Show when={!store.ready}>
        <div class="absolute inset-0 flex items-center justify-center bg-background-base text-text-weak">
          {i18n.t("session.files.preview.loading")}
        </div>
      </Show>
    </div>
  )
}
