import { Tooltip as KobalteTooltip } from "@kobalte/core/tooltip"
import { createEffect, onCleanup, Show, splitProps, type JSX } from "solid-js"
import type { ComponentProps } from "solid-js"
import { createStore } from "solid-js/store"

export interface TooltipProps extends ComponentProps<typeof KobalteTooltip> {
  value: JSX.Element
  class?: string
  contentClass?: string
  contentStyle?: JSX.CSSProperties
  inactive?: boolean
  forceOpen?: boolean
  closeOnPress?: boolean
  interactive?: boolean
}

export interface TooltipKeybindProps extends Omit<TooltipProps, "value"> {
  title: string
  keybind: string
}

export function TooltipKeybind(props: TooltipKeybindProps) {
  const [local, others] = splitProps(props, ["title", "keybind"])
  return (
    <Tooltip
      {...others}
      value={
        <div data-slot="tooltip-keybind">
          <span>{local.title}</span>
          <span data-slot="tooltip-keybind-key">{local.keybind}</span>
        </div>
      }
    />
  )
}

export function Tooltip(props: TooltipProps) {
  let ref: HTMLDivElement | undefined
  let contentRef: HTMLDivElement | undefined
  const [state, setState] = createStore({
    open: false,
    block: false,
    expand: false,
  })
  const [local, others] = splitProps(props, [
    "children",
    "class",
    "contentClass",
    "contentStyle",
    "inactive",
    "forceOpen",
    "closeOnPress",
    "interactive",
    "ignoreSafeArea",
    "value",
  ])

  const close = () => setState("open", false)

  const inside = () => {
    const active = document.activeElement
    if (!ref || !active) return false
    return ref.contains(active)
  }

  const drop = (expand = state.expand) => {
    if (expand) return
    if (ref?.matches(":hover")) return
    if (local.interactive && contentRef?.matches(":hover")) return
    if (inside()) return
    setState("block", false)
  }

  const sync = () => {
    const expand = !!ref?.querySelector('[aria-expanded="true"], [data-expanded]')
    setState("expand", expand)
    if (expand) {
      setState("block", true)
      close()
      return
    }
    drop(expand)
  }

  const arm = () => {
    setState("block", true)
    close()
  }

  const leave = () => {
    if (!local.interactive) {
      if (!inside()) close()
      drop()
      return
    }

    requestAnimationFrame(() => {
      if (ref?.matches(":hover")) return
      if (contentRef?.matches(":hover")) return
      if (!inside()) close()
      drop()
    })
  }

  createEffect(() => {
    if (!ref) return
    sync()
    const obs = new MutationObserver(sync)
    obs.observe(ref, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["aria-expanded", "data-expanded"],
    })
    onCleanup(() => obs.disconnect())
  })

  let justClickedTrigger = false

  const active = () => !local.inactive

  createEffect(() => {
    if (local.inactive) close()
  })

  return (
    <KobalteTooltip
      gutter={4}
      {...others}
      closeDelay={0}
      ignoreSafeArea={local.ignoreSafeArea ?? true}
      open={active() && (local.forceOpen || state.open)}
      onOpenChange={(open) => {
        if (!active()) return
        if (local.forceOpen) return
        if (state.block && open) return
        if (justClickedTrigger) {
          justClickedTrigger = false
          return
        }
        setState("open", open)
      }}
    >
      <KobalteTooltip.Trigger
        ref={ref}
        as={"div"}
        data-component="tooltip-trigger"
        data-inactive={local.inactive ? "true" : undefined}
        class={local.class}
        onPointerDownCapture={() => {
          if (!active()) return
          if (local.closeOnPress === false) return
          arm()
        }}
        onKeyDownCapture={(event: KeyboardEvent) => {
          if (!active()) return
          if (local.closeOnPress === false) return
          if (event.key !== "Enter" && event.key !== " ") return
          arm()
        }}
        onPointerLeave={leave}
        onFocusOut={() => requestAnimationFrame(() => drop())}
      >
        {local.children}
      </KobalteTooltip.Trigger>
      <Show when={active()}>
        <KobalteTooltip.Portal>
          <KobalteTooltip.Content
            ref={contentRef}
            data-component="tooltip"
            data-placement={props.placement}
            data-force-open={local.forceOpen}
            data-interactive={local.interactive ? "true" : "false"}
            class={local.contentClass}
            style={local.contentStyle}
            onPointerEnter={() => {
              if (!local.interactive) return
              setState("open", true)
            }}
            onPointerLeave={() => {
              if (!local.interactive) return
              if (!ref?.matches(":hover")) close()
              drop()
            }}
            onPointerDownOutside={(e) => {
              if (ref === e.target || (e.target instanceof Node && ref?.contains(e.target))) {
                justClickedTrigger = true
              }
              e.preventDefault()
            }}
          >
            {local.value}
            {/* <KobalteTooltip.Arrow data-slot="tooltip-arrow" /> */}
          </KobalteTooltip.Content>
        </KobalteTooltip.Portal>
      </Show>
    </KobalteTooltip>
  )
}
