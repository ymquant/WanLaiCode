import type { Session } from "@opencode-ai/sdk/v2/client"
import { pathKey } from "@/utils/path-key"
import { sessionSidebarTimestamp } from "../helpers"

/**
 * 一个项目"占有"的全部目录:主 worktree + sandboxes(含 git worktree fork 出的子目录)。
 * 与 helpers.ts 的 rootsForProject、pinned.tsx 的收集口径保持一致 —— 项目区已经把
 * sandbox 下的会话归到该项目名下,判断"孤儿"时漏掉 sandbox 会让同一会话显示两次。
 */
export function projectDirectories(
  projects: ReadonlyArray<{ worktree: string; sandboxes?: string[] | undefined }>,
): string[] {
  return projects.flatMap((project) => [project.worktree, ...(project.sandboxes ?? [])])
}

/**
 * 不属于任何已注册项目的自动化目录。
 *
 * 「不关联项目」的自动化(automation_create 的 scope=global)会把运行目录指向
 * `<data>/automation/global`,该目录不在侧栏「项目」区里,跑出来的会话因此在
 * 界面上完全无处可见。把这些目录挑出来,单独在侧栏「自动化」区展示。
 */
export function orphanAutomationDirectories(
  automations: ReadonlyArray<{ directory?: string | null }>,
  knownProjectDirs: Iterable<string>,
): string[] {
  const known = new Set([...knownProjectDirs].map((dir) => pathKey(dir)))
  const seen = new Set<string>()
  const out: string[] = []
  for (const automation of automations) {
    const dir = automation.directory
    if (!dir) continue
    const key = pathKey(dir)
    if (known.has(key) || seen.has(key)) continue
    seen.add(key)
    out.push(dir)
  }
  return out
}

/**
 * 某个自动化目录下、确由自动化运行产生的会话(按更新时间降序)。
 *
 * 与 chats-filter 同理:child store 里可能混入 directory 指向别处的条目,
 * 所以按目录自筛;再用运行记录里的 sessionID 集合把用户手动开的会话排除掉;
 * 已置顶的交给「置顶」区展示,这里必须让位,否则同一会话在侧栏出现两次。
 */
export function filterAutomationSessions(
  sessions: readonly Session[],
  directory: string,
  runSessionIDs: ReadonlySet<string>,
  pinnedIDs: ReadonlySet<string>,
): Session[] {
  const dirKey = pathKey(directory)
  return sessions
    .filter(
      (s) =>
        !s.parentID &&
        !s.time?.archived &&
        !pinnedIDs.has(s.id) &&
        runSessionIDs.has(s.id) &&
        pathKey(s.directory) === dirKey,
    )
    .sort((a, b) => sessionSidebarTimestamp(b) - sessionSidebarTimestamp(a))
}
