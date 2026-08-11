import { type JSX, For, Show, createMemo, createSignal, onMount } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { Keybind } from "@opencode-ai/ui/keybind"
import { base64Encode } from "@opencode-ai/core/util/encode"
import type { Session } from "@opencode-ai/sdk/v2/client"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useLanguage } from "@/context/language"
import { useGlobalSync } from "@/context/global-sync"
import { useLayout } from "@/context/layout"
import { sessionTitle } from "@/utils/session-title"
import { isScratchSessionPath } from "@/utils/scratch"
import { collectSidebarSearchHits, findProjectForSessionDirectory } from "./sidebar-search-sessions"

type Hit = {
  session: Session
  directory: string
  projectName: string
}

export const SearchDialog = (props: { scratchChatDir?: string }): JSX.Element => {
  const language = useLanguage()
  const layout = useLayout()
  const globalSync = useGlobalSync()
  const navigate = useNavigate()
  const dialog = useDialog()
  const [query, setQuery] = createSignal("")
  let inputEl: HTMLInputElement | undefined

  const allHits = createMemo<Hit[]>(() =>
    collectSidebarSearchHits({
      projects: layout.projects.list(),
      scratchChatDir: props.scratchChatDir,
      scratchLabel: language.t("sidebar.section.chats"),
      getProjectStore: (worktree) => globalSync.child(worktree, { bootstrap: false })[0],
      getScratchStore: () => {
        const dir = props.scratchChatDir
        if (!dir) return undefined
        return globalSync.child(dir, { bootstrap: false })[0]
      },
      sortBy: layout.tree.filter().sortBy,
    }),
  )

  const filtered = createMemo(() => {
    const q = query().toLowerCase().trim()
    if (!q) return allHits()
    return allHits().filter((h) => (sessionTitle(h.session.title) ?? "").toLowerCase().includes(q))
  })

  const open = (hit: Hit) => {
    const owningProject = findProjectForSessionDirectory(
      layout.projects.list(),
      hit.directory,
      props.scratchChatDir,
    )
    if (owningProject) {
      // 同时展开项目所在 section + 该 project 节点。
      // 已置顶的项目渲染在「置顶」区而不是「项目」区，展开错的 section 会让命中的会话无处可见。
      layout.tree.set(
        layout.tree.isPinned(owningProject.worktree)() ? "section:pinned" : "section:projects",
        true,
      )
      layout.tree.set(`project:${owningProject.worktree}`, true)
    } else {
      // 散对话或孤立目录，展开对话 section
      layout.tree.set("section:chats", true)
    }
    navigate(`/${base64Encode(hit.directory)}/session/${hit.session.id}`)
    dialog.close()
  }

  onMount(() => {
    inputEl?.focus()
    const scratch = props.scratchChatDir
    const dirs = [
      ...(scratch ? [scratch] : []),
      ...layout.projects
        .list()
        .map((project) => project.worktree)
        .filter((worktree) => !isScratchSessionPath(worktree, scratch)),
    ]
    void Promise.all(dirs.map((directory) => globalSync.project.loadSessions(directory)))
  })

  const onKeyDown = (e: KeyboardEvent) => {
    if (!(e.metaKey || e.ctrlKey)) return
    const n = Number(e.key)
    if (!Number.isFinite(n) || n < 1 || n > 9) return
    const hit = filtered()[n - 1]
    if (!hit) return
    e.preventDefault()
    open(hit)
  }

  return (
    <Dialog fit transition class="codex-dialog sidebar-search-dialog">
      <div
        class="flex flex-col gap-1 p-2 w-full h-full min-h-0 outline-none"
        onKeyDown={onKeyDown}
        tabIndex={-1}
      >
        <input
          ref={inputEl}
          type="text"
          class="w-full px-3 py-2 text-14-regular bg-transparent outline-none placeholder:text-text-weak"
          placeholder={language.t("sidebar.search.placeholder")}
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              const first = filtered()[0]
              if (first) open(first)
            }
          }}
        />
        <div class="px-3 py-1 text-12-regular text-text-weak">
          {language.t("sidebar.search.section.recent")}
        </div>
        <Show
          when={filtered().length > 0}
          fallback={
            <div class="px-3 py-4 text-13-regular text-text-weak">
              {language.t("sidebar.search.empty")}
            </div>
          }
        >
          <ul class="flex flex-col flex-1 min-h-0 overflow-y-auto">
            <For each={filtered().slice(0, 50)}>
              {(hit, i) => (
                <li>
                  <button
                    type="button"
                    class="w-full flex items-center gap-2 h-9 px-3 rounded-md text-left hover:bg-[rgba(0,0,0,0.04)] dark:hover:bg-[rgba(255,255,255,0.04)]"
                    onClick={() => open(hit)}
                  >
                    <Icon name="terminal" size="small" class="text-icon-base shrink-0" />
                    <span class="flex-1 min-w-0 truncate text-14-regular text-text-base">
                      {sessionTitle(hit.session.title)}
                    </span>
                    <span class="shrink-0 text-14-regular text-text-weak">{hit.projectName}</span>
                    <Show when={i() < 9}>
                      <Keybind>⌘{i() + 1}</Keybind>
                    </Show>
                  </button>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </div>
    </Dialog>
  )
}
