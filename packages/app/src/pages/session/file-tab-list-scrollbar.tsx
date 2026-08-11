import { Show, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import {
  tabListScrollLeftFromThumbLeft,
  tabListThumbLeftFromPointer,
  tabListThumbMetrics,
} from "@/pages/session/file-tab-scroll"

export function FileTabListScrollBar(props: { list: () => HTMLDivElement | undefined }) {
  const [scroll, setScroll] = createStore({
    scrollWidth: 0,
    clientWidth: 0,
    scrollLeft: 0,
  })
  const [dragging, setDragging] = createSignal(false)

  createEffect(
    on(
      () => props.list(),
      (el) => {
        if (!el) return

        const update = () => {
          setScroll({
            scrollWidth: el.scrollWidth,
            clientWidth: el.clientWidth,
            scrollLeft: el.scrollLeft,
          })
        }

        update()
        el.addEventListener("scroll", update, { passive: true })
        const observer = new ResizeObserver(update)
        observer.observe(el)
        const mutation = new MutationObserver(update)
        mutation.observe(el, { childList: true, subtree: true })

        onCleanup(() => {
          el.removeEventListener("scroll", update)
          observer.disconnect()
          mutation.disconnect()
        })
      },
    ),
  )

  const metrics = createMemo(() =>
    tabListThumbMetrics(scroll.scrollWidth, scroll.clientWidth, scroll.scrollLeft),
  )
  const visible = () => metrics() !== undefined || dragging()

  const thumbStyle = createMemo(() => {
    const value = metrics()
    if (!value) return undefined
    return {
      width: `${value.thumb}px`,
      left: `${value.left}px`,
    }
  })

  let thumbDrag:
    | {
        startX: number
        startScrollLeft: number
        maxScrollLeft: number
        maxThumbLeft: number
        track: number
      }
    | undefined
  let thumbPointerCleanup: (() => void) | undefined

  const stopThumbDrag = () => {
    thumbPointerCleanup?.()
    thumbPointerCleanup = undefined
    thumbDrag = undefined
    setDragging(false)
  }

  onCleanup(stopThumbDrag)

  const onThumbPointerDown = (event: PointerEvent) => {
    const el = props.list()
    const thumb = event.currentTarget
    const value = metrics()
    if (!el || !el.isConnected || !(thumb instanceof HTMLDivElement) || !value) return

    event.preventDefault()
    event.stopPropagation()
    stopThumbDrag()

    const pointerId = event.pointerId
    thumbDrag = {
      startX: event.clientX,
      startScrollLeft: el.scrollLeft,
      maxScrollLeft: value.overflow,
      maxThumbLeft: value.maxLeft,
      track: value.track,
    }
    setDragging(true)
    thumb.setPointerCapture(pointerId)

    const onPointerMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return
      if (!thumbDrag || !el.isConnected) return
      const travel = thumbDrag.maxThumbLeft > 0 ? thumbDrag.maxThumbLeft : thumbDrag.track
      if (travel <= 0) return
      const deltaX = moveEvent.clientX - thumbDrag.startX
      const scrollDelta = deltaX * (thumbDrag.maxScrollLeft / travel)
      el.scrollLeft = Math.max(0, Math.min(thumbDrag.startScrollLeft + scrollDelta, thumbDrag.maxScrollLeft))
    }

    const onPointerEnd = (endEvent: PointerEvent) => {
      if (endEvent.pointerId !== pointerId) return
      stopThumbDrag()
    }

    const onLostPointerCapture = (lostEvent: PointerEvent) => {
      if (lostEvent.pointerId !== pointerId) return
      stopThumbDrag()
    }

    thumbPointerCleanup = () => {
      thumb.removeEventListener("pointermove", onPointerMove)
      thumb.removeEventListener("pointerup", onPointerEnd)
      thumb.removeEventListener("pointercancel", onPointerEnd)
      thumb.removeEventListener("lostpointercapture", onLostPointerCapture)
      if (thumb.hasPointerCapture(pointerId)) thumb.releasePointerCapture(pointerId)
    }

    thumb.addEventListener("pointermove", onPointerMove)
    thumb.addEventListener("pointerup", onPointerEnd)
    thumb.addEventListener("pointercancel", onPointerEnd)
    thumb.addEventListener("lostpointercapture", onLostPointerCapture)
  }

  const onTrackPointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return

    const track = event.currentTarget
    const el = props.list()
    const value = metrics()
    if (!el || !el.isConnected || !(track instanceof HTMLDivElement) || !value) return

    const rect = track.getBoundingClientRect()
    if (rect.width <= 0) return

    const thumbLeft = tabListThumbLeftFromPointer(event.clientX, rect.left, rect.width, value.thumb)
    el.scrollLeft = tabListScrollLeftFromThumbLeft(thumbLeft, value.maxLeft, value.overflow)
  }

  return (
    <Show when={visible()}>
      <div
        data-slot="file-tab-list-scrollbar"
        style={{ "-webkit-app-region": "no-drag" } as Record<string, string>}
      >
        <div
          data-slot="file-tab-list-scrollbar-track"
          onPointerDown={onTrackPointerDown}
        >
          <div
            data-slot="file-tab-list-scrollbar-thumb"
            data-dragging={dragging() ? "true" : undefined}
            style={thumbStyle()}
            onPointerDown={onThumbPointerDown}
          />
        </div>
      </div>
    </Show>
  )
}
