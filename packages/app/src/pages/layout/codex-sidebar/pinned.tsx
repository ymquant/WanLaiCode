import { type Accessor, For, Show, type JSX, createMemo } from "solid-js"
import { base64Encode } from "@opencode-ai/core/util/encode"
import type { Session } from "@opencode-ai/sdk/v2/client"
import type { LocalProject } from "@/context/layout"
import { useLayout } from "@/context/layout"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { ThreadRow } from "./thread-row"
import { ProjectRow } from "./project-row"
import { SectionChevron } from "./section-chevron"
import { partitionPinnedProjects } from "./pin"
import { isScratchSessionPath } from "@/utils/scratch"
import { useAutomationSessions } from "@/context/automation-sessions"
import { orphanAutomationDirectories, projectDirectories } from "./automations-filter"

// Region 1.5："置顶" section（聚合已 pin 的 project，以及跨 project 的已 pin thread）
export const SidebarPinned = (props: {
  projects: Accessor<LocalProject[]>
  pinned: Accessor<string[]>
  activeThreadId: Accessor<string | undefined>
  sortNow: Accessor<number>
  onArchiveSession: (sessionID: string, directory: string) => Promise<void>
  onCreateWorktree: (project: LocalProject) => void
  onRename: (project: LocalProject) => void
  onRemove: (project: LocalProject) => void
  onNewChatInProject: (project: LocalProject) => void
  scratchChatDir?: () => string | undefined
}): JSX.Element => {
  const language = useLanguage()
  const layout = useLayout()
  const globalSync = useGlobalSync()
  const automationSessions = useAutomationSessions()

  const pinnedIds = layout.tree.pinnedThreadList

  // 已置顶项目。与 projects.tsx 的「项目」区共用同一次切分，保证每个项目恰好渲染一次。
  const pinnedProjects = createMemo(
    () =>
      partitionPinnedProjects({
        projects: props.projects(),
        pinned: props.pinned(),
        scratchDir: props.scratchChatDir?.(),
      }).pinned,
  )

  // 跨 project 收集已 pin 的 session
  const pinnedSessions = createMemo<Array<{ session: Session; directory: string }>>(() => {
    const ids = new Set(pinnedIds())
    if (ids.size === 0) return []

    const out: Array<{ session: Session; directory: string }> = []
    const seen = new Set<string>()
    const scratch = props.scratchChatDir?.()

    const projectDirs = projectDirectories(props.projects())
    const dirs = Array.from(
      new Set([
        ...(scratch ? [scratch] : []),
        ...projectDirs,
        // 不关联项目的自动化跑在隐藏目录里,不带上就没法把它的会话置顶到这一区
        ...orphanAutomationDirectories(automationSessions?.directories() ?? [], projectDirs),
      ]),
    ).filter((dir) => !isScratchSessionPath(dir) || dir === scratch)

    for (const dir of dirs) {
      const [store] = globalSync.child(dir, { bootstrap: false })

      for (const session of store.session ?? []) {
        if (!ids.has(session.id)) continue
        if (session.parentID || session.time?.archived) continue
        if (seen.has(session.id)) continue

        seen.add(session.id)
        out.push({ session, directory: dir })
      }
    }

    // 按 pinnedIds 数组顺序排序（用户先 pin 的在前）
    const order = new Map(pinnedIds().map((id, i) => [id, i]))
    return out.sort((a, b) => (order.get(a.session.id) ?? 0) - (order.get(b.session.id) ?? 0))
  })

  // section "置顶" 默认展开，点击 header 折叠
  const sectionExpanded = layout.tree.expanded("section:pinned", { isActiveProject: true })
  const toggleSection = () => layout.tree.toggle("section:pinned", { isActiveProject: true })

  return (
    <Show when={pinnedProjects().length > 0 || pinnedSessions().length > 0}>
      <div class="flex flex-col gap-1 px-2 pt-2 pb-1">
        <div class="group/section flex items-center justify-between pl-4 pr-1">
          <button
            type="button"
            onClick={toggleSection}
            aria-expanded={sectionExpanded()}
            class="flex flex-1 items-center gap-1 py-1.5 text-12-regular text-text-weak text-left rounded hover:text-text-base"
          >
            {language.t("sidebar.section.pinned")}
            <SectionChevron expanded={sectionExpanded} />
          </button>
        </div>
        <Show when={sectionExpanded()}>
          <For each={pinnedProjects()}>
            {(project) => (
              <ProjectRow
                project={project}
                activeThreadId={props.activeThreadId}
                sortNow={props.sortNow}
                sortable={false}
                onArchiveSession={props.onArchiveSession}
                onCreateWorktree={props.onCreateWorktree}
                onRename={props.onRename}
                onRemove={props.onRemove}
                onNewChatInProject={props.onNewChatInProject}
              />
            )}
          </For>
          <For each={pinnedSessions()}>
            {(item) => (
              <ThreadRow
                session={item.session}
                directory={item.directory}
                slug={base64Encode(item.directory)}
                active={() => props.activeThreadId() === item.session.id}
                pinned={() => true}
                now={props.sortNow}
                flat
                onArchive={(s) => void props.onArchiveSession(s.id, item.directory)}
                onTogglePin={(s) => layout.tree.toggleThreadPin(s.id)}
              />
            )}
          </For>
        </Show>
      </div>
    </Show>
  )
}
