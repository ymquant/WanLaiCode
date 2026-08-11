import { getFilename } from "@opencode-ai/core/util/path"
import type { Session } from "@opencode-ai/sdk/v2/client"
import type { LocalProject } from "@/context/layout"
import { pathKey } from "@/utils/path-key"
import { isScratchSessionPath } from "@/utils/scratch"
import { rootsForProject, sessionSidebarTimestamp, type SidebarSessionSortBy } from "../helpers"
import { filterScratchSessions } from "./chats-filter"

export type SidebarSearchHit = {
  session: Session
  directory: string
  projectName: string
}

type SessionStore = {
  session?: Session[]
}

/** 按 pathKey 归一化匹配 session 所在项目（排除 scratch 伪项目）。 */
export function findProjectForSessionDirectory(
  projects: readonly LocalProject[],
  directory: string,
  scratchChatDir?: string,
): LocalProject | undefined {
  if (isScratchSessionPath(directory, scratchChatDir)) return undefined

  const key = pathKey(directory)
  return projects.find((project) => {
    if (isScratchSessionPath(project.worktree, scratchChatDir)) return false
    if (pathKey(project.worktree) === key) return true
    return (project.sandboxes ?? []).some((sandbox) => pathKey(sandbox) === key)
  })
}

/**
 * 收集与左侧栏可见会话一致的搜索条目。
 *
 * 与 `ProjectRow` / `SidebarChats` 对齐：
 *  - 项目会话只从 worktree store 读取，再按 `session.directory` 归属到项目（含 sandbox）
 *  - 散对话只从 scratch 目录读取，并严格按 `session.directory` 自筛
 *  - 排除归档、子 session；按 session.id 去重
 */
export function collectSidebarSearchHits(input: {
  projects: readonly LocalProject[]
  scratchChatDir?: string
  scratchLabel: string
  getProjectStore: (worktree: string) => SessionStore
  getScratchStore?: () => SessionStore | undefined
  sortBy: SidebarSessionSortBy
}): SidebarSearchHit[] {
  const seen = new Set<string>()
  const hits: SidebarSearchHit[] = []
  const scratch = input.scratchChatDir

  for (const project of input.projects) {
    if (isScratchSessionPath(project.worktree, scratch)) continue

    const projectName = project.name || getFilename(project.worktree)
    const store = input.getProjectStore(project.worktree)
    for (const session of rootsForProject({ session: store.session, path: { directory: project.worktree } }, project)) {
      if (seen.has(session.id)) continue
      seen.add(session.id)
      hits.push({ session, directory: session.directory, projectName })
    }
  }

  if (scratch) {
    const store = input.getScratchStore?.()
    if (store) {
      // 搜索应覆盖侧栏全部可见散对话（含已置顶）；不过滤 pinnedIds。
      for (const session of filterScratchSessions(store.session ?? [], scratch, new Set(), input.sortBy)) {
        if (seen.has(session.id)) continue
        seen.add(session.id)
        hits.push({ session, directory: scratch, projectName: input.scratchLabel })
      }
    }
  }

  return hits.sort(
    (a, b) => sessionSidebarTimestamp(b.session, input.sortBy) - sessionSidebarTimestamp(a.session, input.sortBy),
  )
}
