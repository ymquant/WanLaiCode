import { type Accessor, For, Show, createEffect, createMemo, type JSX } from "solid-js"
import { base64Encode } from "@opencode-ai/core/util/encode"
import type { Session } from "@opencode-ai/sdk/v2/client"
import { useAutomationSessions } from "@/context/automation-sessions"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { ThreadRow } from "./thread-row"
import { SectionChevron } from "./section-chevron"
import { filterAutomationSessions, orphanAutomationDirectories, projectDirectories } from "./automations-filter"
import { sessionSidebarTimestamp } from "../helpers"

// Region 4："自动化" —— 不关联项目的自动化(scope=global)跑出来的会话。
// 它们落在 <data>/automation/global 这个隐藏目录下,不属于任何项目,
// 没有这一区就只能进自动化详情页翻「历史运行」才看得到。
export const SidebarAutomations = (props: {
  activeThreadId: Accessor<string | undefined>
  sortNow: Accessor<number>
  onArchiveSession: (sessionID: string, directory: string) => Promise<void>
}): JSX.Element => {
  const language = useLanguage()
  const layout = useLayout()
  const globalSync = useGlobalSync()
  const automationSessions = useAutomationSessions()
  const globalSDK = useGlobalSDK()

  // 全部标记已读(对照 Codex 侧栏 Scheduled 的 Mark all as read)
  async function markAllRead() {
    try {
      await globalSDK.client.automation.readAll({})
    } finally {
      automationSessions?.refetch()
    }
  }

  const sectionExpanded = layout.tree.expanded("section:automations", { isActiveProject: true })
  const toggleSection = () => layout.tree.toggle("section:automations", { isActiveProject: true })

  // 轮询每次都会拿到全新的数组引用,不按内容比较的话下游 effect 会跟着空转重复 loadSessions
  const directories = createMemo(
    () =>
      orphanAutomationDirectories(automationSessions?.directories() ?? [], projectDirectories(layout.projects.list())),
    [],
    { equals: (prev, next) => prev.length === next.length && prev.every((dir, i) => dir === next[i]) },
  )

  // 这些目录不是普通 project,layout 不会替它们拉会话,这里显式加载(loadSessions 自带并发去重)
  createEffect(() => {
    for (const directory of directories()) void globalSync.project.loadSessions(directory)
  })

  const rows = createMemo<Array<{ session: Session; directory: string }>>(() => {
    const runSessionIDs = automationSessions?.sessionIDs() ?? new Set<string>()
    const pinnedIDs = new Set(layout.tree.pinnedThreadList())
    return directories()
      .flatMap((directory) => {
        const [store] = globalSync.child(directory, { bootstrap: false })
        return filterAutomationSessions(store.session ?? [], directory, runSessionIDs, pinnedIDs).map((session) => ({
          session,
          directory,
        }))
      })
      .sort((a, b) => sessionSidebarTimestamp(b.session) - sessionSidebarTimestamp(a.session))
  })

  return (
    <Show when={rows().length > 0}>
      <div class="px-2 mt-2">
        <div class="group/section flex items-center justify-between pl-3 pr-1">
          <button
            type="button"
            onClick={toggleSection}
            aria-expanded={sectionExpanded()}
            class="flex-1 py-1.5 text-12-regular text-text-weak text-left rounded hover:text-text-base flex items-center gap-1.5"
          >
            <span>{language.t("sidebar.section.automations")}</span>
            {/* 未读指示器(对照 Codex 侧栏 Scheduled 尾部的小圆点):只表示「有跑完还没看的运行」,
                不显示数字 —— Codex 也只有一个点。 */}
            <Show when={(automationSessions?.unreadTotal() ?? 0) > 0}>
              <span
                class="size-1.5 rounded-full shrink-0"
                // 用内联 style + 主题变量,不用 Tailwind 颜色类:本项目是自定义 token 调色板,
                // bg-blue-500 / bg-accent-base 这类类名都不存在,写上去元素照样渲染但背景透明 —— 静默失效
                style={{ "background-color": "var(--icon-interactive-base, #0a7cff)" }}
                title={language.t("automation.inbox.unreadTooltip")}
              />
            </Show>
            <SectionChevron expanded={sectionExpanded} />
          </button>
          <Show when={(automationSessions?.unreadTotal() ?? 0) > 0}>
            <button
              type="button"
              class="px-1.5 py-1 text-11-regular text-text-weak rounded hover:text-text-base"
              title={language.t("automation.inbox.markAllRead")}
              onClick={() => void markAllRead()}
            >
              {language.t("automation.inbox.markAllRead")}
            </button>
          </Show>
        </div>

        <Show when={sectionExpanded()}>
          <div class="flex flex-col gap-0.5 mt-1">
            <For each={rows()}>
              {(row) => (
                <ThreadRow
                  session={row.session}
                  directory={row.directory}
                  slug={base64Encode(row.directory)}
                  active={() => props.activeThreadId() === row.session.id}
                  pinned={() => false}
                  now={props.sortNow}
                  flat
                  onArchive={(s) => void props.onArchiveSession(s.id, s.directory)}
                  onTogglePin={(s) => layout.tree.toggleThreadPin(s.id)}
                />
              )}
            </For>
          </div>
        </Show>
      </div>
    </Show>
  )
}
