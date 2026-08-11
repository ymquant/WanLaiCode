import { type JSX, For, Show, createSignal, onCleanup, onMount } from "solid-js"
import { Portal } from "solid-js/web"
import { Icon } from "@opencode-ai/ui/icon"
import { useLanguage } from "@/context/language"
import type { ArchivedSort, ArchivedTypeFilter } from "./helpers"

type Section<K extends "type" | "sort"> = {
  key: K
  title: string
  options: Array<{ value: string; label: string }>
}

export const ArchivedSessionsFilterMenu = (props: {
  open: () => boolean
  onClose: () => void
  anchor: () => HTMLElement | undefined
  type: () => ArchivedTypeFilter
  sort: () => ArchivedSort
  onType: (value: ArchivedTypeFilter) => void
  onSort: (value: ArchivedSort) => void
}): JSX.Element => {
  const language = useLanguage()
  const [pos, setPos] = createSignal<{ top: number; left: number } | undefined>()
  let menuEl: HTMLDivElement | undefined

  const updatePosition = () => {
    const el = props.anchor()
    if (!el) return
    const rect = el.getBoundingClientRect()
    const menuWidth = menuEl?.offsetWidth ?? 220
    const menuHeight = menuEl?.offsetHeight ?? 280
    const margin = 8
    const gap = 4
    const left = Math.min(Math.max(margin, rect.left), window.innerWidth - menuWidth - margin)
    const spaceBelow = window.innerHeight - rect.bottom - margin
    const top =
      spaceBelow >= menuHeight + gap
        ? rect.bottom + gap
        : Math.max(margin, rect.top - menuHeight - gap)
    setPos({ top, left })
  }

  onMount(() => {
    updatePosition()
    requestAnimationFrame(updatePosition)
    const onResize = () => updatePosition()
    window.addEventListener("resize", onResize)
    onCleanup(() => window.removeEventListener("resize", onResize))
  })

  onMount(() => {
    const onDocClick = (event: MouseEvent) => {
      const anchor = props.anchor()
      const target = event.target as Node
      if (anchor?.contains(target)) return
      if (menuEl?.contains(target)) return
      props.onClose()
    }
    document.addEventListener("mousedown", onDocClick)
    onCleanup(() => document.removeEventListener("mousedown", onDocClick))
  })

  const sections: [Section<"type">, Section<"sort">] = [
    {
      key: "type",
      title: language.t("settings.archivedSessions.filter.type.section"),
      options: [
        { value: "all", label: language.t("settings.archivedSessions.filter.type.all") },
        { value: "local", label: language.t("settings.archivedSessions.filter.type.local") },
        { value: "cloud", label: language.t("settings.archivedSessions.filter.type.cloud") },
      ],
    },
    {
      key: "sort",
      title: language.t("settings.archivedSessions.filter.sort.section"),
      options: [
        { value: "updated", label: language.t("settings.archivedSessions.filter.sort.updated") },
        { value: "created", label: language.t("settings.archivedSessions.filter.sort.created") },
        { value: "alpha", label: language.t("settings.archivedSessions.filter.sort.alpha") },
      ],
    },
  ]

  return (
    <Show when={props.open() && pos()}>
      <Portal>
        <div
          ref={(el) => (menuEl = el)}
          class="fixed z-[80] w-[220px] rounded-[12px] border border-border-weaker-base bg-background-base py-1.5 shadow-lg"
          style={{ top: `${pos()!.top}px`, left: `${pos()!.left}px` }}
          onClick={(event) => event.stopPropagation()}
        >
          <For each={sections}>
            {(section, index) => (
              <>
                <Show when={index() > 0}>
                  <div class="my-1.5 mx-2.5 h-px bg-border-weaker-base" />
                </Show>
                <div class="px-2.5 pt-1.5 pb-1 text-12-medium text-text-weak">{section.title}</div>
                <For each={section.options}>
                  {(option) => {
                    const selected = () =>
                      section.key === "type"
                        ? props.type() === option.value
                        : props.sort() === option.value
                    return (
                      <button
                        type="button"
                        class="mx-1 flex h-8 w-[calc(100%-8px)] items-center gap-2 rounded-md px-2.5 text-left text-13-regular text-text-strong hover:bg-surface-base-hover"
                        onClick={() => {
                          if (section.key === "type") props.onType(option.value as ArchivedTypeFilter)
                          if (section.key === "sort") props.onSort(option.value as ArchivedSort)
                        }}
                      >
                        <span class="flex-1">{option.label}</span>
                        <Show when={selected()}>
                          <Icon name="check" size="small" class="shrink-0 text-icon-base" />
                        </Show>
                      </button>
                    )
                  }}
                </For>
              </>
            )}
          </For>
        </div>
      </Portal>
    </Show>
  )
}
