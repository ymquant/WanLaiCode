import { batch, onCleanup, onMount, splitProps, type ComponentProps, Show, mergeProps } from "solid-js"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import { createStore } from "solid-js/store"
import { useI18n } from "../context/i18n"
import type { AutoScrollDirection } from "../hooks/create-auto-scroll"

export interface ScrollViewProps extends ComponentProps<"div"> {
  viewportRef?: (el: HTMLDivElement) => void
  orientation?: "vertical" | "horizontal" // currently only vertical is fully implemented for thumb
  // 拖动滚动条 / 键盘滚动这两条路径不会产生 wheel/touch 事件，外部的手势判定收不到信号，
  // 会把它们当成程序滚动而继续自动跟随底部。这里显式上报，让外部能识别为用户滚动。
  onUserScrollGesture?: (viewport: HTMLDivElement, direction?: AutoScrollDirection) => void
}

export const scrollKey = (event: Pick<KeyboardEvent, "key" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey">) => {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return

  switch (event.key) {
    case "PageDown":
      return "page-down"
    case "PageUp":
      return "page-up"
    case "Home":
      return "home"
    case "End":
      return "end"
    case "ArrowUp":
      return "up"
    case "ArrowDown":
      return "down"
  }
}

const SCROLLBAR_TRACK_PADDING = 8
const SCROLLBAR_MIN_THUMB_HEIGHT = 32

export function scrollThumbMetrics(scrollHeight: number, clientHeight: number, scrollTop: number) {
  // 绘制与拖拽必须共用同一段轨道数学；否则长列表里滑块位置和实际滚动比例会逐渐偏离。
  if (scrollHeight <= clientHeight || scrollHeight <= 0 || clientHeight <= 0) return

  const track = Math.max(0, clientHeight - SCROLLBAR_TRACK_PADDING * 2)
  if (track <= 0) return
  const height = Math.min(track, Math.max((clientHeight / scrollHeight) * track, SCROLLBAR_MIN_THUMB_HEIGHT))
  const maxScrollTop = scrollHeight - clientHeight
  const maxThumbTop = Math.max(0, track - height)
  const ratio = Math.max(0, Math.min(1, scrollTop / maxScrollTop))

  return {
    height,
    top: SCROLLBAR_TRACK_PADDING + ratio * maxThumbTop,
    maxScrollTop,
    maxThumbTop,
  }
}

export function ScrollView(props: ScrollViewProps) {
  const i18n = useI18n()
  const merged = mergeProps({ orientation: "vertical" }, props)
  const [local, events, rest] = splitProps(
    merged,
    ["class", "children", "viewportRef", "orientation", "style"],
    [
      "onUserScrollGesture",
      "onScroll",
      "onWheel",
      "onTouchStart",
      "onTouchMove",
      "onTouchEnd",
      "onTouchCancel",
      "onPointerDown",
      "onClick",
      "onKeyDown",
    ],
  )

  let rootRef!: HTMLDivElement
  let viewportRef!: HTMLDivElement
  let thumbRef!: HTMLDivElement

  const [state, setState] = createStore({
    isHovered: false,
    isDragging: false,
    thumbHeight: 0,
    thumbTop: 0,
    showThumb: false,
    scrollFlash: false,
  })
  const isHovered = () => state.isHovered
  const isDragging = () => state.isDragging
  const thumbHeight = () => state.thumbHeight
  const thumbTop = () => state.thumbTop
  const showThumb = () => state.showThumb

  let scrollFlashTimer: ReturnType<typeof setTimeout> | undefined

  const flashScrollThumb = () => {
    setState("scrollFlash", true)
    if (scrollFlashTimer !== undefined) clearTimeout(scrollFlashTimer)
    scrollFlashTimer = setTimeout(() => {
      scrollFlashTimer = undefined
      setState("scrollFlash", false)
    }, 900)
  }

  const thumbVisible = () => state.isHovered || state.isDragging || state.scrollFlash

  const updateThumb = () => {
    if (!viewportRef) return
    const metrics = scrollThumbMetrics(viewportRef.scrollHeight, viewportRef.clientHeight, viewportRef.scrollTop)

    if (!metrics) {
      setState("showThumb", false)
      return
    }

    // 一次批量提交三个视觉状态，避免滚动事件里连续触发三轮响应式更新。
    batch(() => {
      setState("showThumb", true)
      setState("thumbHeight", metrics.height)
      setState("thumbTop", metrics.top)
    })
  }

  onMount(() => {
    if (local.viewportRef) {
      local.viewportRef(viewportRef)
    }

    createResizeObserver([viewportRef, viewportRef.firstElementChild], updateThumb)

    updateThumb()
  })

  onCleanup(() => {
    if (scrollFlashTimer !== undefined) clearTimeout(scrollFlashTimer)
  })

  let drag:
    | { pointerID: number; startY: number; startScrollTop: number; maxScrollTop: number; maxThumbTop: number }
    | undefined
  let dragPointerCleanup: (() => void) | undefined

  const markUserScrollGesture = (direction?: AutoScrollDirection) => {
    events.onUserScrollGesture?.(viewportRef, direction)
  }

  const onThumbPointerDown = (e: PointerEvent) => {
    const metrics = scrollThumbMetrics(viewportRef.scrollHeight, viewportRef.clientHeight, viewportRef.scrollTop)
    if (!metrics) return

    e.preventDefault()
    e.stopPropagation()
    dragPointerCleanup?.()
    setState("isDragging", true)
    drag = {
      pointerID: e.pointerId,
      startY: e.clientY,
      startScrollTop: viewportRef.scrollTop,
      maxScrollTop: metrics.maxScrollTop,
      maxThumbTop: metrics.maxThumbTop,
    }
    markUserScrollGesture()

    thumbRef.setPointerCapture(e.pointerId)

    const onPointerMove = (event: PointerEvent) => {
      const current = drag
      if (!current || event.pointerId !== current.pointerID || current.maxThumbTop <= 0) return
      const scrollDelta = (event.clientY - current.startY) * (current.maxScrollTop / current.maxThumbTop)
      const next = Math.max(0, Math.min(current.startScrollTop + scrollDelta, current.maxScrollTop))
      // 滑块移动方向决定滚动权：向上拖立即暂停，向下抵达底部则允许时间线恢复跟随。
      markUserScrollGesture(next < viewportRef.scrollTop ? "away" : "toward")
      viewportRef.scrollTop = next
    }

    const stopDragging = (event: PointerEvent) => {
      if (event.pointerId !== drag?.pointerID) return
      dragPointerCleanup?.()
    }

    // pointercancel / lostpointercapture 也必须收尾，否则滑块会永久停在 dragging 状态。
    dragPointerCleanup = () => {
      const pointerID = drag?.pointerID
      drag = undefined
      dragPointerCleanup = undefined
      setState("isDragging", false)
      thumbRef.removeEventListener("pointermove", onPointerMove)
      thumbRef.removeEventListener("pointerup", stopDragging)
      thumbRef.removeEventListener("pointercancel", stopDragging)
      thumbRef.removeEventListener("lostpointercapture", stopDragging)
      if (pointerID !== undefined && thumbRef.hasPointerCapture(pointerID)) thumbRef.releasePointerCapture(pointerID)
    }

    thumbRef.addEventListener("pointermove", onPointerMove)
    thumbRef.addEventListener("pointerup", stopDragging)
    thumbRef.addEventListener("pointercancel", stopDragging)
    thumbRef.addEventListener("lostpointercapture", stopDragging)
  }

  onCleanup(() => dragPointerCleanup?.())

  // Keybinds implementation
  // We ensure the viewport has a tabindex so it can receive focus
  // We can also explicitly catch PageUp/Down if we want smooth scroll or specific behavior,
  // but native usually handles this perfectly. Let's explicitly ensure it behaves well.
  const onKeyDown = (e: KeyboardEvent) => {
    // If user is focused on an input inside the scroll view, don't hijack keys
    const focused = document.activeElement
    if (focused && ["INPUT", "TEXTAREA", "SELECT"].includes(focused.tagName)) return
    // contenteditable 同样是输入场景，方向键属于光标移动而非滚动
    if (focused instanceof HTMLElement && focused.isContentEditable) return

    const next = scrollKey(e)
    if (!next) return

    // 所有滚动键都上报，向下的也要：消费方判断「是否离开跟随底部」时，
    // 「滚到底部附近就恢复跟随」那条分支同样挂在这个手势信号后面 ——
    // 不上报就等于按 End 回到底部也恢复不了自动跟随。方向由消费方按实际位置判定。
    // 键盘方向必须在默认滚动前上报，End/向下键抵达底部后才能立即恢复流式跟随。
    markUserScrollGesture(["page-up", "home", "up"].includes(next) ? "away" : "toward")

    const scrollAmount = viewportRef.clientHeight * 0.8
    const lineAmount = 40

    switch (next) {
      case "page-down":
        e.preventDefault()
        viewportRef.scrollBy({ top: scrollAmount, behavior: "smooth" })
        break
      case "page-up":
        e.preventDefault()
        viewportRef.scrollBy({ top: -scrollAmount, behavior: "smooth" })
        break
      case "home":
        e.preventDefault()
        viewportRef.scrollTo({ top: 0, behavior: "smooth" })
        break
      case "end":
        e.preventDefault()
        viewportRef.scrollTo({ top: viewportRef.scrollHeight, behavior: "smooth" })
        break
      case "up":
        e.preventDefault()
        viewportRef.scrollBy({ top: -lineAmount, behavior: "smooth" })
        break
      case "down":
        e.preventDefault()
        viewportRef.scrollBy({ top: lineAmount, behavior: "smooth" })
        break
    }
  }

  return (
    <div
      ref={rootRef}
      class={`scroll-view ${local.class || ""}`}
      style={local.style}
      onPointerEnter={() => setState("isHovered", true)}
      onPointerLeave={() => setState("isHovered", false)}
      {...rest}
    >
      {/* Viewport */}
      <div
        ref={viewportRef}
        class="scroll-view__viewport"
        onScroll={(e) => {
          updateThumb()
          flashScrollThumb()
          if (typeof events.onScroll === "function") events.onScroll(e as any)
        }}
        onWheel={events.onWheel as any}
        onTouchStart={events.onTouchStart as any}
        onTouchMove={events.onTouchMove as any}
        onTouchEnd={events.onTouchEnd as any}
        onTouchCancel={events.onTouchCancel as any}
        onPointerDown={events.onPointerDown as any}
        onClick={events.onClick as any}
        tabIndex={0}
        role="region"
        aria-label={i18n.t("ui.scrollView.ariaLabel")}
        onKeyDown={(e) => {
          onKeyDown(e)
          if (typeof events.onKeyDown === "function") events.onKeyDown(e as any)
        }}
      >
        {local.children}
      </div>

      {/* Thumb Overlay */}
      <Show when={showThumb()}>
        <div
          ref={thumbRef}
          onPointerDown={onThumbPointerDown}
          class="scroll-view__thumb"
          data-visible={thumbVisible() ? "true" : "false"}
          data-dragging={isDragging()}
          style={{
            height: `${thumbHeight()}px`,
            transform: `translateY(${thumbTop()}px)`,
            "z-index": 100, // ensure it displays over content
          }}
        />
      </Show>
    </div>
  )
}
