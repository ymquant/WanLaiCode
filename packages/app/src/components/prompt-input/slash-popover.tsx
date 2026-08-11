import { Component, For, Match, Show, Switch } from "solid-js"
import { FileIcon } from "@opencode-ai/ui/file-icon"
import { Icon } from "@opencode-ai/ui/icon"
import { getDirectory, getFilename } from "@opencode-ai/core/util/path"

export type AtOption =
  | { type: "agent"; name: string; display: string }
  | { type: "file"; path: string; display: string; recent?: boolean }
  | {
    type: "plugin"
    addonKey: string
    name: string
    display: string
    description?: string
    logo?: string
    brandColor?: string
  }

export interface SlashCommand {
  id: string
  commandID?: string
  trigger: string
  title: string
  description?: string
  keybind?: string
  type: "builtin" | "custom"
  source?: "command" | "mcp" | "skill"
  location?: string
}

export type AtGroup = { category: string; items: AtOption[] }

type PromptPopoverProps = {
  popover: "at" | "slash" | null
  setSlashPopoverRef: (el: HTMLDivElement) => void
  atFlat: AtOption[]
  atGrouped: AtGroup[]
  atActive?: string
  atKey: (item: AtOption) => string
  setAtActive: (id: string) => void
  onAtSelect: (item: AtOption) => void
  slashFlat: SlashCommand[]
  slashActive?: string
  setSlashActive: (id: string) => void
  onSlashSelect: (item: SlashCommand) => void
  commandKeybind: (id: string) => string | undefined
  t: (key: string) => string
}

const GROUP_LABEL_KEY: Record<string, string> = {
  agent: "prompt.popover.group.agents",
  plugin: "prompt.popover.group.plugins",
  recent: "prompt.popover.group.recent",
  file: "prompt.popover.group.files",
}

// 跨组累计 cap 条目数,保持原有 atFlat.slice(0,10) 的整体上限语义。
function limitGroups(groups: AtGroup[], cap: number): AtGroup[] {
  const out: AtGroup[] = []
  let remaining = cap
  for (const g of groups) {
    if (remaining <= 0) break
    const take = g.items.slice(0, remaining)
    if (take.length === 0) continue
    out.push({ category: g.category, items: take })
    remaining -= take.length
  }
  return out
}

export const PromptPopover: Component<PromptPopoverProps> = (props) => {
  return (
    <Show when={props.popover}>
      <div
        ref={(el) => {
          if (props.popover === "slash") props.setSlashPopoverRef(el)
        }}
        class="absolute inset-x-0 -top-2 -translate-y-full origin-bottom-left max-h-80 min-h-10
                 overflow-auto no-scrollbar flex flex-col p-2 rounded-[12px]
                 bg-surface-raised-stronger-non-alpha shadow-[var(--shadow-lg-border-base)]"
        onMouseDown={(e) => e.preventDefault()}
      >
        <Switch>
          <Match when={props.popover === "at"}>
            <Show
              when={props.atFlat.length > 0}
              fallback={<div class="text-text-weak px-2 py-1">{props.t("prompt.popover.emptyResults")}</div>}
            >
              <For each={limitGroups(props.atGrouped, 12)}>
                {(group) => (
                  <div class="flex flex-col">
                    <Show when={GROUP_LABEL_KEY[group.category]}>
                      <div class="text-12-regular text-text-weaker px-2 pt-2 pb-1">
                        {props.t(GROUP_LABEL_KEY[group.category]!)}
                      </div>
                    </Show>
                    <For each={group.items}>
                      {(item) => {
                        const key = props.atKey(item)

                        if (item.type === "agent") {
                          return (
                            <button
                              class="w-full flex items-center gap-x-2 rounded-md px-2 py-1"
                              classList={{ "bg-surface-raised-base-hover": props.atActive === key }}
                              onClick={() => props.onAtSelect(item)}
                              onMouseEnter={() => props.setAtActive(key)}
                            >
                              <Icon name="brain" size="small" class="text-icon-info-active shrink-0" />
                              <span class="text-14-regular text-text-strong whitespace-nowrap">@{item.name}</span>
                            </button>
                          )
                        }

                        if (item.type === "plugin") {
                          return (
                            <button
                              class="w-full flex items-center gap-x-2.5 rounded-md px-2 py-1.5 text-left"
                              classList={{ "bg-surface-raised-base-hover": props.atActive === key }}
                              onClick={() => props.onAtSelect(item)}
                              onMouseEnter={() => props.setAtActive(key)}
                            >
                              <Show
                                when={item.logo}
                                fallback={
                                  <div
                                    class="size-5 rounded-md flex items-center justify-center shrink-0 text-11-medium text-white"
                                    style={{ "background-color": item.brandColor || "#71717A" }}
                                  >
                                    {(item.display.charAt(0) || "?").toUpperCase()}
                                  </div>
                                }
                              >
                                <img
                                  src={item.logo}
                                  alt=""
                                  class="size-5 rounded-md shrink-0 object-cover bg-surface-base"
                                />
                              </Show>
                              <span class="text-14-regular text-text-strong whitespace-nowrap shrink-0">
                                {item.display}
                              </span>
                              <Show when={item.description}>
                                <span class="text-13-regular text-text-weak truncate min-w-0">
                                  {item.description}
                                </span>
                              </Show>
                            </button>
                          )
                        }

                        const isDirectory = item.path.endsWith("/")
                        const directory = isDirectory ? item.path : getDirectory(item.path)
                        const filename = isDirectory ? "" : getFilename(item.path)

                        return (
                          <button
                            class="w-full flex items-center gap-x-2 rounded-md px-2 py-0.5"
                            classList={{ "bg-surface-raised-base-hover": props.atActive === key }}
                            onClick={() => props.onAtSelect(item)}
                            onMouseEnter={() => props.setAtActive(key)}
                          >
                            <FileIcon node={{ path: item.path, type: "file" }} class="shrink-0 size-4" />
                            <div class="flex items-center text-14-regular min-w-0">
                              <span class="text-text-weak whitespace-nowrap truncate min-w-0">{directory}</span>
                              <Show when={!isDirectory}>
                                <span class="text-text-strong whitespace-nowrap">{filename}</span>
                              </Show>
                            </div>
                          </button>
                        )
                      }}
                    </For>
                  </div>
                )}
              </For>
            </Show>
          </Match>
          <Match when={props.popover === "slash"}>
            <Show
              when={props.slashFlat.length > 0}
              fallback={<div class="text-text-weak px-2 py-1">{props.t("prompt.popover.emptyCommands")}</div>}
            >
              <For each={props.slashFlat}>
                {(cmd) => (
                  <button
                    data-slash-id={cmd.id}
                    classList={{
                      "w-full flex items-center justify-between gap-4 rounded-md px-2 py-1": true,
                      "bg-surface-raised-base-hover": props.slashActive === cmd.id,
                    }}
                    onClick={() => props.onSlashSelect(cmd)}
                    onMouseEnter={() => props.setSlashActive(cmd.id)}
                  >
                    <div class="flex items-center gap-2 min-w-0">
                      <span class="text-14-regular text-text-strong whitespace-nowrap">/{cmd.trigger}</span>
                      <Show when={cmd.description}>
                        <span class="text-14-regular text-text-weak truncate">{cmd.description}</span>
                      </Show>
                    </div>
                    <div class="flex items-center gap-2 shrink-0">
                      <Show when={cmd.type === "custom" && cmd.source !== "command"}>
                        <span class="text-11-regular text-text-subtle px-1.5 py-0.5 bg-surface-base rounded">
                          {cmd.source === "skill"
                            ? props.t("prompt.slash.badge.skill")
                            : cmd.source === "mcp"
                              ? props.t("prompt.slash.badge.mcp")
                              : props.t("prompt.slash.badge.custom")}
                        </span>
                      </Show>
                      <Show when={props.commandKeybind(cmd.commandID ?? cmd.id)}>
                        <span class="text-12-regular text-text-subtle">
                          {props.commandKeybind(cmd.commandID ?? cmd.id)}
                        </span>
                      </Show>
                    </div>
                  </button>
                )}
              </For>
            </Show>
          </Match>
        </Switch>
      </div>
    </Show>
  )
}
