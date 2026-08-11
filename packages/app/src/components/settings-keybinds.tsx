import { Component, For, Show, createMemo, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { makeEventListener } from "@solid-primitives/event-listener"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { TextField } from "@opencode-ai/ui/text-field"
import { showToast } from "@opencode-ai/ui/toast"
import fuzzysort from "fuzzysort"
import { formatKeybind, useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { useSettings } from "@/context/settings"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { keybindSignatures as signatures, matchesKeybindSearch } from "./settings-keybinds-search"
import { SettingsList } from "./settings-list"

const IS_MAC = typeof navigator === "object" && /(Mac|iPod|iPhone|iPad)/.test(navigator.platform)
const PALETTE_ID = "command.palette"
const DEFAULT_PALETTE_KEYBIND = "mod+shift+p"

type KeybindGroup = "General" | "Session" | "Navigation" | "Model and agent" | "Terminal" | "Prompt"

type KeybindMeta = {
  title: string
  group: KeybindGroup
}

type KeybindMap = Record<string, string | undefined>
type CommandContext = ReturnType<typeof useCommand>

const GROUPS: KeybindGroup[] = ["General", "Session", "Navigation", "Model and agent", "Terminal", "Prompt"]

type GroupKey =
  | "settings.shortcuts.group.general"
  | "settings.shortcuts.group.session"
  | "settings.shortcuts.group.navigation"
  | "settings.shortcuts.group.modelAndAgent"
  | "settings.shortcuts.group.terminal"
  | "settings.shortcuts.group.prompt"

const groupKey: Record<KeybindGroup, GroupKey> = {
  General: "settings.shortcuts.group.general",
  Session: "settings.shortcuts.group.session",
  Navigation: "settings.shortcuts.group.navigation",
  "Model and agent": "settings.shortcuts.group.modelAndAgent",
  Terminal: "settings.shortcuts.group.terminal",
  Prompt: "settings.shortcuts.group.prompt",
}

function groupFor(id: string): KeybindGroup {
  if (id === PALETTE_ID) return "General"
  if (id.startsWith("terminal.")) return "Terminal"
  if (id.startsWith("model.") || id.startsWith("agent.") || id.startsWith("mcp.")) return "Model and agent"
  if (id.startsWith("file.") || id.startsWith("fileTree.")) return "Navigation"
  if (id.startsWith("prompt.")) return "Prompt"
  if (
    id.startsWith("session.") ||
    id.startsWith("message.") ||
    id.startsWith("permissions.") ||
    id.startsWith("steps.") ||
    id.startsWith("review.")
  )
    return "Session"

  return "General"
}

function isModifier(key: string) {
  return key === "Shift" || key === "Control" || key === "Alt" || key === "Meta"
}

function normalizeKey(key: string) {
  if (key === ",") return "comma"
  if (key === "+") return "plus"
  if (key === " ") return "space"
  return key.toLowerCase()
}

function recordKeybind(event: KeyboardEvent) {
  if (isModifier(event.key)) return

  const parts: string[] = []

  const mod = IS_MAC ? event.metaKey : event.ctrlKey
  if (mod) parts.push("mod")

  if (IS_MAC && event.ctrlKey) parts.push("ctrl")
  if (!IS_MAC && event.metaKey) parts.push("meta")
  if (event.altKey) parts.push("alt")
  if (event.shiftKey) parts.push("shift")

  const key = normalizeKey(event.key)
  if (!key) return
  parts.push(key)

  return parts.join("+")
}

function keybinds(value: unknown): KeybindMap {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return value as KeybindMap
}

function listFor(command: CommandContext, map: KeybindMap, palette: string) {
  const out = new Map<string, KeybindMeta>()
  out.set(PALETTE_ID, { title: palette, group: "General" })

  for (const opt of command.catalog) {
    if (opt.id.startsWith("suggested.")) continue
    out.set(opt.id, { title: opt.title, group: groupFor(opt.id) })
  }

  for (const opt of command.options) {
    if (opt.id.startsWith("suggested.")) continue
    out.set(opt.id, { title: opt.title, group: groupFor(opt.id) })
  }

  for (const [id, value] of Object.entries(map)) {
    if (typeof value !== "string") continue
    if (out.has(id)) continue
    out.set(id, { title: id, group: groupFor(id) })
  }

  return out
}

function groupedFor(list: Map<string, KeybindMeta>) {
  const out = new Map<KeybindGroup, string[]>()
  for (const group of GROUPS) out.set(group, [])

  for (const [id, item] of list) {
    const ids = out.get(item.group)
    if (!ids) continue
    ids.push(id)
  }

  for (const group of GROUPS) {
    const ids = out.get(group)
    if (!ids) continue
    ids.sort((a, b) => (list.get(a)?.title ?? "").localeCompare(list.get(b)?.title ?? ""))
  }

  return out
}

function filteredFor(
  query: string,
  list: Map<string, KeybindMeta>,
  grouped: Map<KeybindGroup, string[]>,
  keybind: (id: string) => string,
  keybindConfig: (id: string) => string | undefined,
  keybindSearch = false,
  searchKeybind?: string,
) {
  const value = query.toLowerCase().trim()
  if (!value) return grouped

  const out = new Map<KeybindGroup, string[]>()
  for (const group of GROUPS) out.set(group, [])

  const items = Array.from(list.entries()).map(([id, meta]) => ({
    id,
    title: meta.title,
    group: meta.group,
    keybind: keybind(id),
  }))

  const results = keybindSearch
    ? items.filter((item) => matchesKeybindSearch(keybindConfig(item.id), searchKeybind)).map((obj) => ({ obj }))
    : fuzzysort.go(value, items, {
        keys: ["title", "keybind"],
        threshold: -10000,
      })

  for (const result of results) {
    const ids = out.get(result.obj.group)
    if (!ids) continue
    ids.push(result.obj.id)
  }

  return out
}

function useKeyCapture(input: {
  active: () => string | null
  stop: () => void
  set: (id: string, keybind: string) => void
  used: () => Map<string, { id: string; title: string }[]>
  language: ReturnType<typeof useLanguage>
}) {
  onMount(() => {
    const handle = (event: KeyboardEvent) => {
      const id = input.active()
      if (!id) return

      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()

      if (event.key === "Escape") {
        input.stop()
        return
      }

      const clear =
        (event.key === "Backspace" || event.key === "Delete") &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !event.shiftKey
      if (clear) {
        input.set(id, "none")
        input.stop()
        return
      }

      const next = recordKeybind(event)
      if (!next) return

      const conflicts = new Map<string, string>()
      for (const sig of signatures(next)) {
        for (const item of input.used().get(sig) ?? []) {
          if (item.id === id) continue
          conflicts.set(item.id, item.title)
        }
      }

      if (conflicts.size > 0) {
        showToast({
          title: input.language.t("settings.shortcuts.conflict.title"),
          description: input.language.t("settings.shortcuts.conflict.description", {
            keybind: formatKeybind(next, input.language.t),
            titles: [...conflicts.values()].join(", "),
          }),
        })
        return
      }

      input.set(id, next)
      input.stop()
    }

    makeEventListener(document, "keydown", handle, { capture: true })
  })
}

export const SettingsKeybinds: Component = () => {
  const command = useCommand()
  const language = useLanguage()
  const settings = useSettings()

  const [store, setStore] = createStore({
    active: null as string | null,
    filter: "",
    searchByKeybind: false,
    searchKeybind: undefined as string | undefined,
  })

  const stop = () => {
    if (!store.active) return
    setStore("active", null)
    command.keybinds(true)
  }

  const start = (id: string) => {
    if (store.active === id) {
      stop()
      return
    }

    if (store.active) stop()

    setStore("active", id)
    command.keybinds(false)
  }

  const map = createMemo(() => keybinds(settings.current.keybinds))

  const hasOverrides = createMemo(() => Object.values(map()).some((x) => typeof x === "string"))

  const resetAll = () => {
    stop()
    settings.keybinds.resetAll()
    showToast({
      title: language.t("settings.shortcuts.reset.toast.title"),
      description: language.t("settings.shortcuts.reset.toast.description"),
    })
  }

  const list = createMemo(() => {
    language.locale()
    return listFor(command, map(), language.t("command.palette"))
  })

  const title = (id: string) => list().get(id)?.title ?? ""

  const grouped = createMemo(() => groupedFor(list()))

  const valueFor = (id: string) => {
    if (id === PALETTE_ID) return settings.keybinds.get(PALETTE_ID) ?? DEFAULT_PALETTE_KEYBIND

    const custom = settings.keybinds.get(id)
    if (typeof custom === "string") return custom

    const live = command.options.find((x) => x.id === id)
    if (live?.keybind) return live.keybind

    const meta = command.catalog.find((x) => x.id === id)
    return meta?.keybind
  }

  const filtered = createMemo(() => {
    return filteredFor(
      store.filter,
      list(),
      grouped(),
      (id) => command.keybind(id) || "",
      valueFor,
      store.searchByKeybind,
      store.searchKeybind,
    )
  })

  const handleSearchKeyDown = (event: KeyboardEvent) => {
    if (!store.searchByKeybind || store.active) return

    event.preventDefault()
    event.stopPropagation()

    if (event.key === "Escape" || event.key === "Backspace" || event.key === "Delete") {
      setStore("filter", "")
      return
    }

    const next = recordKeybind(event)
    if (!next) return
    setStore({ filter: formatKeybind(next, language.t), searchKeybind: next })
  }

  const toggleSearchMode = () => {
    setStore({ searchByKeybind: !store.searchByKeybind, filter: "", searchKeybind: undefined })
  }

  onMount(() => {
    makeEventListener(document, "keydown", handleSearchKeyDown, { capture: true })
  })

  const hasResults = createMemo(() => {
    for (const group of GROUPS) {
      const ids = filtered().get(group) ?? []
      if (ids.length > 0) return true
    }
    return false
  })

  const used = createMemo(() => {
    const map = new Map<string, { id: string; title: string }[]>()

    const add = (key: string, value: { id: string; title: string }) => {
      const list = map.get(key)
      if (!list) {
        map.set(key, [value])
        return
      }
      list.push(value)
    }

    const palette = settings.keybinds.get(PALETTE_ID) ?? DEFAULT_PALETTE_KEYBIND
    for (const sig of signatures(palette)) {
      add(sig, { id: PALETTE_ID, title: title(PALETTE_ID) })
    }

    for (const id of list().keys()) {
      if (id === PALETTE_ID) continue
      for (const sig of signatures(valueFor(id))) {
        add(sig, { id, title: title(id) })
      }
    }

    return map
  })

  const setKeybind = (id: string, keybind: string) => settings.keybinds.set(id, keybind)

  useKeyCapture({
    active: () => store.active,
    stop,
    set: setKeybind,
    used,
    language,
  })

  onCleanup(() => {
    if (store.active) command.keybinds(true)
  })

  return (
    <>
      <style>{`
        .settings-scrollbar {
          scrollbar-width: thin;
          scrollbar-color: var(--border-weak-base) transparent;
        }

        .settings-scrollbar::-webkit-scrollbar {
          width: 10px;
        }

        .settings-scrollbar::-webkit-scrollbar-track {
          background: transparent;
        }

        .settings-scrollbar::-webkit-scrollbar-thumb {
          background: var(--border-weak-base);
          border-radius: 999px;
          border: 2px solid transparent;
          background-clip: padding-box;
        }

        .settings-scrollbar::-webkit-scrollbar-thumb:hover {
          background: var(--border-weak-hover);
          border: 2px solid transparent;
          background-clip: padding-box;
        }
      `}</style>
      <div class="settings-scrollbar flex h-full flex-col overflow-y-auto bg-background-base px-4 pb-10 sm:px-10 sm:pb-10">
      <div
        class="sticky top-0 z-10"
        style={{
          background: "linear-gradient(to bottom, var(--background-base) calc(100% - 24px), transparent)",
        }}
      >
        <div class="flex flex-col gap-4 pt-6 pb-6 max-w-[720px]">
          <div class="flex items-center justify-between gap-4">
            <h2 class="text-16-medium text-text-strong">{language.t("settings.shortcuts.title")}</h2>
            <Button size="small" variant="secondary" onClick={resetAll} disabled={!hasOverrides()}>
              {language.t("settings.shortcuts.reset.button")}
            </Button>
          </div>

          <div
            data-settings-drag-block
            class="flex h-9 items-center gap-2 rounded-[14px] border border-border-weaker-base bg-surface-raised-stronger-non-alpha px-3"
          >
            <Icon name="magnifying-glass" class="text-icon-weak-base flex-shrink-0" />
            <TextField
              variant="ghost"
              type="text"
              value={store.filter}
              onChange={(v) => setStore("filter", v)}
              readOnly={store.searchByKeybind}
              placeholder={
                store.searchByKeybind
                  ? language.t("settings.shortcuts.search.keybind.placeholder")
                  : language.t("settings.shortcuts.search.placeholder")
              }
              spellcheck={false}
              autocorrect="off"
              autocomplete="off"
              autocapitalize="off"
              class="flex-1"
            />
            <Show when={store.filter}>
              <IconButton icon="circle-x" variant="ghost" onClick={() => setStore("filter", "")} />
            </Show>
            <Tooltip value={language.t("settings.shortcuts.search.keybind.toggle")} placement="top">
              <button
                type="button"
                class="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-[9px] text-icon-weak-base shadow-none transition-colors"
                classList={{
                  "bg-surface-raised-base-active text-icon-base": store.searchByKeybind,
                  "hover:bg-surface-raised-base hover:text-icon-base": !store.searchByKeybind,
                }}
                aria-label={language.t("settings.shortcuts.search.keybind.toggle")}
                aria-pressed={store.searchByKeybind}
                onClick={toggleSearchMode}
              >
                <Icon name="shortcut-search-icon" size="small" />
              </button>
            </Tooltip>
          </div>
        </div>
      </div>

      <div class="flex flex-col gap-8 max-w-[720px]">
        <For each={GROUPS}>
          {(group) => (
            <Show when={(filtered().get(group) ?? []).length > 0}>
              <div class="flex flex-col gap-1">
                <h3 class="text-14-medium font-semibold text-text-strong pb-2">
                  {language.t(groupKey[group])}
                </h3>
                <div class="[&>div]:rounded-[18px] [&>div]:border [&>div]:border-border-weaker-base [&>div]:bg-surface-raised-stronger-non-alpha [&>div]:px-0 [&>div]:shadow-none">
                  <SettingsList>
                    <For each={filtered().get(group) ?? []}>
                      {(id) => (
                        <div class="flex items-center justify-between gap-4 border-b border-border-weaker-base px-4 py-4 last:border-none sm:px-[14px]">
                          <span class="text-14-regular text-text-strong">{title(id)}</span>
                          <button
                            type="button"
                            data-keybind-id={id}
                            classList={{
                              "h-8 rounded-[12px] px-3 text-12-regular": true,
                              "border border-border-weak-base bg-surface-raised-stronger-non-alpha text-text-base":
                                store.active !== id,
                              "border border-border-strong-base bg-surface-strong text-text-on-brand-base font-medium":
                                store.active === id,
                            }}
                            onClick={() => start(id)}
                          >
                            <Show
                              when={store.active === id}
                              fallback={command.keybind(id) || language.t("settings.shortcuts.unassigned")}
                            >
                              {language.t("settings.shortcuts.pressKeys")}
                            </Show>
                          </button>
                        </div>
                      )}
                    </For>
                  </SettingsList>
                </div>
              </div>
            </Show>
          )}
        </For>

        <Show when={store.filter && !hasResults()}>
          <div class="flex flex-col items-center justify-center py-12 text-center">
            <span class="text-14-regular text-text-weak">{language.t("settings.shortcuts.search.empty")}</span>
            <Show when={store.filter}>
              <span class="text-14-regular text-text-strong mt-1">"{store.filter}"</span>
            </Show>
          </div>
        </Show>
      </div>
      </div>
    </>
  )
}
