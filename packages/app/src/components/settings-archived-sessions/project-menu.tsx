import { type JSX, For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { Portal } from "solid-js/web"
import { Icon } from "@opencode-ai/ui/icon"
import { useLanguage } from "@/context/language"
import { pathKey } from "@/utils/path-key"
import type { ArchivedProjectFilter, ArchivedProjectOption } from "./helpers"

export type { ArchivedProjectOption }

export const ArchivedSessionsProjectMenu = (props: {
  open: () => boolean
  onClose: () => void
  anchor: () => HTMLElement | undefined
  value: () => ArchivedProjectFilter
  projects: () => ArchivedProjectOption[]
  onSelect: (value: ArchivedProjectFilter) => void
}): JSX.Element => {
  const language = useLanguage()
  const [pos, setPos] = createSignal<{ top: number; left: number } | undefined>()
  let menuEl: HTMLDivElement | undefined

  const updatePosition = () => {
    const el = props.anchor()
    if (!el) return
    const rect = el.getBoundingClientRect()
    const menuWidth = menuEl?.offsetWidth ?? 240
    const menuHeight = menuEl?.offsetHeight ?? 320
    const margin = 8
    const gap = 4
    const left = Math.min(Math.max(margin, rect.right - menuWidth), window.innerWidth - menuWidth - margin)
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

  const selectedWorktree = createMemo(() => {
    const value = props.value()
    return typeof value === "object" ? pathKey(value.worktree) : undefined
  })

  const isSelected = (candidate: ArchivedProjectFilter) => {
    const value = props.value()
    if (candidate === value) return true
    if (typeof candidate === "object" && typeof value === "object") {
      return pathKey(candidate.worktree) === pathKey(value.worktree)
    }
    return false
  }

  return (
    <Show when={props.open() && pos()}>
      <Portal>
        <div
          ref={(el) => (menuEl = el)}
          class="fixed z-[80] max-h-[min(420px,calc(100vh-16px))] w-[min(280px,calc(100vw-16px))] overflow-y-auto rounded-[12px] border border-border-weaker-base bg-background-base py-1.5 shadow-lg"
          style={{ top: `${pos()!.top}px`, left: `${pos()!.left}px` }}
          onClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            class="mx-1 flex h-8 w-[calc(100%-8px)] items-center gap-2 rounded-md px-2.5 text-left text-13-regular text-text-strong hover:bg-surface-base-hover"
            onClick={() => props.onSelect("all")}
          >
            <span class="flex-1">{language.t("settings.archivedSessions.filter.project.all")}</span>
            <Show when={isSelected("all")}>
              <Icon name="check" size="small" class="shrink-0 text-icon-base" />
            </Show>
          </button>

          <For each={props.projects()}>
            {(project) => (
              <button
                type="button"
                class="mx-1 flex h-8 w-[calc(100%-8px)] items-center gap-2 rounded-md px-2.5 text-left text-13-regular text-text-strong hover:bg-surface-base-hover"
                onClick={() => props.onSelect({ worktree: project.worktree })}
              >
                <Icon name="folder" size="small" class="shrink-0 text-icon-weak" />
                <span class="min-w-0 flex-1 truncate">{project.name}</span>
                <Show when={selectedWorktree() === pathKey(project.worktree)}>
                  <Icon name="check" size="small" class="shrink-0 text-icon-base" />
                </Show>
              </button>
            )}
          </For>

          <div class="my-1.5 mx-2.5 h-px bg-border-weaker-base" />

          <button
            type="button"
            class="mx-1 flex h-8 w-[calc(100%-8px)] items-center gap-2 rounded-md px-2.5 text-left text-13-regular text-text-strong hover:bg-surface-base-hover"
            onClick={() => props.onSelect("chats")}
          >
            <Icon name="speech-bubble" size="small" class="shrink-0 text-icon-weak" />
            <span class="flex-1">{language.t("settings.archivedSessions.filter.project.chats")}</span>
            <Show when={isSelected("chats")}>
              <Icon name="check" size="small" class="shrink-0 text-icon-base" />
            </Show>
          </button>
          <button
            type="button"
            class="mx-1 flex h-8 w-[calc(100%-8px)] items-center gap-2 rounded-md px-2.5 text-left text-13-regular text-text-strong hover:bg-surface-base-hover"
            onClick={() => props.onSelect("automations")}
          >
            <Icon name="task" size="small" class="shrink-0 text-icon-weak" />
            <span class="flex-1">{language.t("settings.archivedSessions.filter.project.automations")}</span>
            <Show when={isSelected("automations")}>
              <Icon name="check" size="small" class="shrink-0 text-icon-base" />
            </Show>
          </button>
        </div>
      </Portal>
    </Show>
  )
}
