import type { LocalProject } from "@/context/layout"
import { isScratchSessionPath } from "@/utils/scratch"

/**
 * 把项目列表切成「置顶区」和「项目区」两半。
 *
 * 侧栏的硬不变量：每个项目**恰好**渲染一次。已置顶的项目渲染在顶部「置顶」区
 * （pinned.tsx），未置顶的渲染在「项目」区（projects.tsx）。两处若各写一遍
 * 过滤条件，任一处漂移都会让项目重复出现或整个消失，而这两种症状在 UI 上都
 * 很难第一时间归因。所以这里一次性算出互补的两半，两个 section 各取其一。
 *
 * - `pinned`：按 `pinned` 数组顺序（用户先 pin 的在前），不是按项目列表顺序。
 * - `rest`：保持项目列表原顺序，drag 排序依赖这个顺序与后端 canonical 列表一致。
 * - 两处都排除散对话隐藏项目（scratch-sessions）。
 * - `pinned` 里指向已不存在项目的残留 worktree 直接丢弃（项目被移除但 pin 记录仍在）。
 * - `pinned` 去重，避免历史持久化数据里的重复项把同一项目渲染两次。
 */
export function partitionPinnedProjects(input: {
  projects: readonly LocalProject[]
  pinned: readonly string[]
  scratchDir?: string | undefined
}): { pinned: LocalProject[]; rest: LocalProject[] } {
  const visible = input.projects.filter((p) => !isScratchSessionPath(p.worktree, input.scratchDir))
  const byWorktree = new Map(visible.map((p) => [p.worktree, p]))

  const taken = new Set<string>()
  const pinned = input.pinned.flatMap((worktree) => {
    if (taken.has(worktree)) return []
    const project = byWorktree.get(worktree)
    if (!project) return []
    taken.add(worktree)
    return [project]
  })

  return { pinned, rest: visible.filter((p) => !taken.has(p.worktree)) }
}
