import { makeEventListener } from "@solid-primitives/event-listener"
import { createEffect, createSignal, on, onCleanup, onMount, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { useI18n } from "../context/i18n"
import { Icon } from "./icon"

const ZOOM_MIN = 25
const ZOOM_MAX = 400
const ZOOM_STEP = 25
const MIN_WIDTH = 360
const MIN_HEIGHT = 320
const FRAME_MARGIN = 16

type Frame = { x: number; y: number; width: number; height: number }

export interface ImagePreviewProps {
  mode?: "floating" | "window"
  src: string
  alt?: string
  images?: Array<{ src: string; alt?: string }>
  initialIndex?: number
  onClose?: () => void
  onLoad?: JSX.EventHandlerUnion<HTMLImageElement, Event>
  onError?: JSX.EventHandlerUnion<HTMLImageElement, Event>
}

const defaultFrame = (): Frame => {
  if (typeof window === "undefined") return { x: 80, y: 80, width: 960, height: 720 }
  const width = window.innerWidth - FRAME_MARGIN * 2
  const height = window.innerHeight - FRAME_MARGIN * 2
  return {
    x: Math.max(FRAME_MARGIN, (window.innerWidth - width) / 2),
    y: Math.max(FRAME_MARGIN, (window.innerHeight - height) / 2),
    width,
    height,
  }
}

const clampFrame = (frame: Frame): Frame => {
  if (typeof window === "undefined") return frame
  const width = Math.min(Math.max(MIN_WIDTH, frame.width), window.innerWidth - FRAME_MARGIN * 2)
  const height = Math.min(Math.max(MIN_HEIGHT, frame.height), window.innerHeight - FRAME_MARGIN * 2)
  const x = Math.min(Math.max(FRAME_MARGIN, frame.x), window.innerWidth - width - FRAME_MARGIN)
  const y = Math.min(Math.max(FRAME_MARGIN, frame.y), window.innerHeight - height - FRAME_MARGIN)
  return { x, y, width, height }
}

export function ImagePreview(props: ImagePreviewProps) {
  const i18n = useI18n()
  const isWindow = () => props.mode === "window"
  let body: HTMLDivElement | undefined
  let image: HTMLImageElement | undefined
  const drag = { x: 0, y: 0, scrollLeft: 0, scrollTop: 0 }
  const [frame, setFrame] = createStore<Frame>({ x: 0, y: 0, width: MIN_WIDTH, height: MIN_HEIGHT })
  const [index, setIndex] = createSignal(props.initialIndex ?? 0)
  const [zooms, setZooms] = createStore<Record<string, number>>({})
  const zoomKey = () => current().src
  const zoom = () => zooms[zoomKey()] ?? 100
  const [zoomText, setZoomText] = createSignal("100")
  const [fit, setFit] = createSignal<{ width: number; height: number } | undefined>()
  const [dragging, setDragging] = createSignal(false)
  const images = () => props.images?.length ? props.images : [{ src: props.src, alt: props.alt }]
  const current = () => images()[Math.min(Math.max(index(), 0), images().length - 1)] ?? { src: props.src, alt: props.alt }
  const hasMultiple = () => images().length > 1
  const canGoPrevious = () => hasMultiple() && index() > 0
  const canGoNext = () => hasMultiple() && index() < images().length - 1
  const previousImage = () => {
    setIndex((value) => Math.max(0, value - 1))
  }
  const nextImage = () => {
    setIndex((value) => Math.min(images().length - 1, value + 1))
  }

  onMount(() => {
    if (isWindow()) {
      setFrame({ x: 0, y: 0, width: window.innerWidth, height: window.innerHeight })
    } else {
      setFrame(clampFrame(defaultFrame()))
    }

    const onResize = () => {
      if (isWindow()) {
        setFrame({ x: 0, y: 0, width: window.innerWidth, height: window.innerHeight })
        return
      }
      setFrame(clampFrame(defaultFrame()))
    }
    makeEventListener(window, "resize", onResize)

    const onKeyDown = (event: KeyboardEvent) => {
      if (canGoPrevious() && event.key === "ArrowLeft") {
        previousImage()
        event.preventDefault()
        event.stopPropagation()
        return
      }
      if (canGoNext() && event.key === "ArrowRight") {
        nextImage()
        event.preventDefault()
        event.stopPropagation()
        return
      }
      if (event.key !== "Escape") return
      props.onClose?.()
      event.preventDefault()
      event.stopPropagation()
    }
    makeEventListener(window, "keydown", onKeyDown, { capture: true })
  })

  const isPannable = () => {
    const fitted = fit()
    if (!fitted || !body) return false
    const scroll = body.querySelector('[data-slot="image-preview-scroll"]')
    if (!scroll) return false
    const style = getComputedStyle(scroll)
    const scale = zoom() / 100
    const width = fitted.width * scale + parseFloat(style.paddingLeft) + parseFloat(style.paddingRight)
    const height = fitted.height * scale + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom)
    return width > body.clientWidth + 1 || height > body.clientHeight + 1
  }

  const applyZoom = (value: number) => {
    const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value))
    setZooms(zoomKey(), next)
    setZoomText(String(next))
  }

  const zoomOut = () => applyZoom(zoom() - ZOOM_STEP)
  const zoomIn = () => applyZoom(zoom() + ZOOM_STEP)

  const commitZoomText = () => {
    const parsed = Number.parseInt(zoomText().trim(), 10)
    if (Number.isNaN(parsed)) {
      setZoomText(String(zoom()))
      return
    }
    applyZoom(parsed)
  }

  const updateFit = (img: HTMLImageElement, bodyEl: HTMLDivElement) => {
    const scroll = img.parentElement
    if (!scroll) return
    const style = getComputedStyle(scroll)
    const maxWidth = Math.max(
      bodyEl.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
      1,
    )
    const maxHeight = Math.max(
      bodyEl.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom),
      1,
    )
    const ratio = Math.min(maxWidth / img.naturalWidth, maxHeight / img.naturalHeight, 1)
    setFit({
      width: img.naturalWidth * ratio,
      height: img.naturalHeight * ratio,
    })
  }

  onCleanup(() => {
    document.body.style.userSelect = ""
    document.body.style.cursor = ""
  })

  createEffect(
    on(index, () => {
      setDragging(false)
      setZoomText(String(zoom()))
      setFit(undefined)
      if (!body) return
      body.scrollLeft = 0
      body.scrollTop = 0
    }),
  )

  createEffect(() => {
    frame.width
    frame.height
    if (!image?.complete || !body) return
    updateFit(image, body)
  })

  const imageStyle = () => {
    const fitted = fit()
    if (!fitted) return undefined
    const scale = zoom() / 100
    return {
      width: `${fitted.width * scale}px`,
      height: `${fitted.height * scale}px`,
      "max-width": "none",
      "max-height": "none",
    }
  }

  const lockDocument = () => {
    document.body.style.userSelect = "none"
  }

  const unlockDocument = () => {
    document.body.style.userSelect = ""
    document.body.style.cursor = ""
  }

  const endPan = (event: PointerEvent) => {
    if (!dragging() || !body) return
    setDragging(false)
    unlockDocument()
    if (body.hasPointerCapture(event.pointerId)) body.releasePointerCapture(event.pointerId)
  }

  const handlePanDown = (event: PointerEvent) => {
    if (!body || event.button !== 0 || !isPannable()) return
    setDragging(true)
    drag.x = event.clientX
    drag.y = event.clientY
    drag.scrollLeft = body.scrollLeft
    drag.scrollTop = body.scrollTop
    lockDocument()
    body.setPointerCapture(event.pointerId)
    event.preventDefault()
  }

  const handlePanMove = (event: PointerEvent) => {
    if (!dragging() || !body) return
    body.scrollLeft = drag.scrollLeft - (event.clientX - drag.x)
    body.scrollTop = drag.scrollTop - (event.clientY - drag.y)
    event.preventDefault()
  }

  const downloadImage = () => {
    const link = document.createElement("a")
    link.href = current().src
    link.download = current().alt?.trim() || "image.png"
    link.rel = "noopener"
    document.body.appendChild(link)
    link.click()
    link.remove()
  }

  return (
    <>
      {!isWindow() && <div data-slot="image-preview-backdrop" onClick={props.onClose} />}
      <div
        data-component="image-preview"
        data-mode={isWindow() ? "window" : "floating"}
        style={
          isWindow()
            ? undefined
            : {
                left: `${frame.x}px`,
                top: `${frame.y}px`,
                width: `${frame.width}px`,
                height: `${frame.height}px`,
              }
        }
      >
        <div data-slot="image-preview-content">
          <div data-slot="image-preview-header">
            <div data-slot="image-preview-actions">
              <button
                type="button"
                data-slot="image-preview-action-button"
                aria-label={i18n.t("ui.imagePreview.download")}
                title={i18n.t("ui.imagePreview.download")}
                onClick={downloadImage}
              >
                <Icon name="download" size="small" />
              </button>
              <button
                type="button"
                data-slot="image-preview-action-button"
                aria-label={i18n.t("ui.imagePreview.close")}
                title={i18n.t("ui.imagePreview.close")}
                onClick={props.onClose}
              >
                <Icon name="close" size="small" />
              </button>
            </div>
          </div>
          <div
            data-slot="image-preview-body"
            ref={(el) => (body = el)}
            data-pannable={isPannable() ? "true" : undefined}
            data-dragging={dragging() ? "true" : undefined}
            onPointerDown={handlePanDown}
            onPointerMove={handlePanMove}
            onPointerUp={endPan}
            onPointerCancel={endPan}
          >
            <div data-slot="image-preview-scroll">
              <img
                ref={(el) => (image = el)}
                src={current().src}
                alt={current().alt ?? i18n.t("ui.imagePreview.alt")}
                data-slot="image-preview-image"
                draggable={false}
                style={imageStyle()}
                onLoad={(event) => {
                  if (body) updateFit(event.currentTarget, body)
                  const handler = props.onLoad
                  if (typeof handler === "function") handler(event)
                }}
                onError={props.onError}
              />
            </div>
          </div>
          {hasMultiple() && (
            <>
              {canGoPrevious() && (
                <button
                  type="button"
                  data-slot="image-preview-nav-button"
                  data-direction="previous"
                  aria-label={i18n.t("ui.imagePreview.previous")}
                  title={i18n.t("ui.imagePreview.previous")}
                  onClick={previousImage}
                >
                  <Icon name="arrow-left" size="small" />
                </button>
              )}
              {canGoNext() && (
                <button
                  type="button"
                  data-slot="image-preview-nav-button"
                  data-direction="next"
                  aria-label={i18n.t("ui.imagePreview.next")}
                  title={i18n.t("ui.imagePreview.next")}
                  onClick={nextImage}
                >
                  <Icon name="arrow-right" size="small" />
                </button>
              )}
            </>
          )}
          <div data-slot="image-preview-footer">
            <div data-slot="image-preview-zoom" role="group" aria-label={i18n.t("ui.imagePreview.zoom")}>
              <button
                type="button"
                data-slot="image-preview-zoom-button"
                aria-label={i18n.t("ui.imagePreview.zoomOut")}
                disabled={zoom() <= ZOOM_MIN}
                onClick={zoomOut}
              >
                <Icon name="dash" size="small" />
              </button>
              <label data-slot="image-preview-zoom-input-wrap">
                <input
                  type="text"
                  inputmode="numeric"
                  pattern="[0-9]*"
                  data-slot="image-preview-zoom-input"
                  value={zoomText()}
                  aria-label={i18n.t("ui.imagePreview.zoomLevel")}
                  onInput={(event) => setZoomText(event.currentTarget.value.replace(/[^\d]/g, ""))}
                  onBlur={commitZoomText}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter") return
                    commitZoomText()
                    event.currentTarget.blur()
                  }}
                />
                <span data-slot="image-preview-zoom-suffix">%</span>
              </label>
              <button
                type="button"
                data-slot="image-preview-zoom-button"
                aria-label={i18n.t("ui.imagePreview.zoomIn")}
                disabled={zoom() >= ZOOM_MAX}
                onClick={zoomIn}
              >
                <Icon name="plus-small" size="small" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}

