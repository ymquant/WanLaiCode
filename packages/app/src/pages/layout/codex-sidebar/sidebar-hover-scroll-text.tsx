import { createEffect, createSignal, onCleanup, onMount, type JSX } from "solid-js"

export function SidebarHoverScrollText(props: {
  text: string
  class?: string
  hoverClass?: string
}): JSX.Element {
  let rootRef: HTMLSpanElement | undefined
  let trackRef: HTMLSpanElement | undefined
  let observer: ResizeObserver | undefined
  const [hovered, setHovered] = createSignal(false)
  const [overflow, setOverflow] = createSignal(0)

  const measure = () => {
    if (!rootRef || !trackRef) return
    setOverflow(Math.max(0, Math.ceil(trackRef.scrollWidth - rootRef.clientWidth)))
  }
  const duration = () => `${Math.min(4200, Math.max(1100, overflow() * 30))}ms`

  createEffect(() => {
    props.text
    queueMicrotask(measure)
  })

  onMount(() => {
    measure()
    if (typeof ResizeObserver !== "function") return
    observer = new ResizeObserver(measure)
    if (rootRef) observer.observe(rootRef)
    if (trackRef) observer.observe(trackRef)
  })

  onCleanup(() => observer?.disconnect())

  return (
    <span
      ref={rootRef}
      class={`relative block min-w-0 overflow-hidden whitespace-nowrap ${props.class ?? ""}`}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      data-overflowing={overflow() > 0 ? "true" : "false"}
    >
      <span
        class="block min-w-0 overflow-hidden text-ellipsis whitespace-nowrap"
        classList={{ "opacity-0": hovered() && overflow() > 0 }}
      >
        {props.text}
      </span>
      <span
        ref={trackRef}
        aria-hidden="true"
        class={`absolute left-0 top-0 block max-w-none whitespace-nowrap opacity-0 transition-transform ${props.hoverClass ?? ""}`}
        classList={{ "opacity-100": hovered() && overflow() > 0 }}
        style={{
          transform: hovered() && overflow() > 0 ? `translateX(-${overflow()}px)` : "translateX(0)",
          "transition-duration": hovered() && overflow() > 0 ? duration() : "160ms",
          "transition-timing-function": hovered() && overflow() > 0 ? "cubic-bezier(0.22, 1, 0.36, 1)" : "ease-out",
        }}
      >
        {props.text}
      </span>
    </span>
  )
}
