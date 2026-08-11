import { type Accessor, For, Show, createMemo, createSignal, type JSX } from "solid-js"
import { base64Encode } from "@opencode-ai/core/util/encode"
import type { Session } from "@opencode-ai/sdk/v2/client"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Tooltip, TooltipKeybind } from "@opencode-ai/ui/tooltip"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useGlobalSync } from "@/context/global-sync"
import { useCommand } from "@/context/command"
import { ThreadRow } from "./thread-row"
import { FilterMenu } from "./filter-menu"
import { filterScratchSessions } from "./chats-filter"
import { SectionChevron } from "./section-chevron"

// Region 3："对话" 散对话（不绑定 project 的 chat），从 userData/scratch-sessions 读取
export const SidebarChats = (props: {
  scratchChatDir?: () => string | undefined
  activeThreadId: Accessor<string | undefined>
  sortNow: Accessor<number>
  onArchiveSession: (sessionID: string, directory: string) => Promise<void>
  onNewChat: () => void
}): JSX.Element => {
  const language = useLanguage()
  const layout = useLayout()
  const globalSync = useGlobalSync()
  const command = useCommand()

  const sectionExpanded = layout.tree.expanded("section:chats", { isActiveProject: true })
  const toggleSection = () => layout.tree.toggle("section:chats", { isActiveProject: true })

  const [filterOpen, setFilterOpen] = createSignal(false)
  let filterAnchor: HTMLButtonElement | undefined

  // 散对话 sessions：来自 scratch-sessions 目录
  const scratchSessions = createMemo<Session[]>(() => {
    const dir = props.scratchChatDir?.()
    if (!dir) return []
    const [store] = globalSync.child(dir, { bootstrap: false })
    const pinnedSet = new Set(layout.tree.pinnedThreadList())
    return filterScratchSessions(store.session ?? [], dir, pinnedSet, layout.tree.filter().sortBy)
  })

  return (
    <div class="px-2 mt-2">
      <div class="group/section flex items-center justify-between pl-4 pr-1">
        <button
          type="button"
          onClick={toggleSection}
          aria-expanded={sectionExpanded()}
          class="flex flex-1 items-center gap-1 py-1.5 text-12-regular text-text-weak text-left rounded hover:text-text-base"
        >
          {language.t("sidebar.section.chats")}
          <SectionChevron expanded={sectionExpanded} />
        </button>
        <div
          class="flex items-center gap-0.5 opacity-0 pointer-events-none transition-opacity duration-120 group-hover/section:opacity-100 group-hover/section:pointer-events-auto group-focus-within/section:opacity-100 group-focus-within/section:pointer-events-auto"
          classList={{
            "opacity-100 pointer-events-auto": filterOpen(),
          }}
        >
          <Tooltip value={language.t("sidebar.filter.tooltip")} placement="top">
            <IconButton
              ref={(el) => (filterAnchor = el as HTMLButtonElement)}
              icon="sliders"
              variant="ghost"
              size="small"
              class="size-6"
              onClick={() => setFilterOpen((v) => !v)}
              aria-label={language.t("sidebar.filter.tooltip")}
            />
          </Tooltip>
          <TooltipKeybind
            placement="top"
            title={language.t("sidebar.section.chats.new")}
            keybind={command.keybind("session.new") ?? ""}
          >
            <IconButton
              icon="pencil-line"
              variant="ghost"
              size="small"
              class="size-6"
              onClick={props.onNewChat}
              aria-label={language.t("sidebar.section.chats.new")}
            />
          </TooltipKeybind>
        </div>
        <FilterMenu open={filterOpen} onClose={() => setFilterOpen(false)} anchor={() => filterAnchor} />
      </div>

      <Show when={sectionExpanded()}>
        <Show
          when={scratchSessions().length > 0}
          fallback={
            <div class="px-3 py-1.5 pl-4 text-13-regular text-text-weak">
              {language.t("sidebar.section.chats.empty")}
            </div>
          }
        >
          <div class="flex flex-col gap-0.5 mt-1">
            <For each={scratchSessions()}>
              {(session) => {
                const dir = () => props.scratchChatDir?.() ?? ""
                return (
                  <ThreadRow
                    session={session}
                    directory={dir()}
                    slug={base64Encode(dir())}
                    active={() => props.activeThreadId() === session.id}
                    pinned={() => false}
                    now={props.sortNow}
                    flat
                    onArchive={(s) => void props.onArchiveSession(s.id, s.directory)}
                    onTogglePin={(s) => layout.tree.toggleThreadPin(s.id)}
                  />
                )
              }}
            </For>
          </div>
        </Show>
      </Show>
    </div>
  )
}
