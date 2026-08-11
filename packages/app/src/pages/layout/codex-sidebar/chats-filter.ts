import type { Session } from "@opencode-ai/sdk/v2/client"
import { pathKey } from "@/utils/path-key"
import { sessionSidebarTimestamp, type SidebarSessionSortBy } from "../helpers"

/**
 * 「对话」散对话区的可见 session 过滤 + 排序。
 *
 * 拆成纯函数便于单测：`globalSync.child(scratchDir).session` 有时会被
 * 同步层放入 `directory` 指向其它真实项目的条目（服务端把散对话目录创建
 * 的会话解析回最近的真实项目，参考 `prompt-input/submit.ts` 的注释），
 * 不严格按目录自筛就会导致同一个 session 同时出现在「项目」和「对话」两处。
 *
 * 过滤规则：
 *  - 排除 `parentID`（fork 出来的子 session）
 *  - 排除 `time.archived`
 *  - 排除 `pinnedIds` 中的（已置顶单独区）
 *  - 必须 `pathKey(s.directory) === pathKey(scratchDir)`
 *
 * 排序：按 `time.updated ?? time.created` 降序。
 */
export function filterScratchSessions(
  sessions: readonly Session[],
  scratchDir: string,
  pinnedIds: ReadonlySet<string>,
  sortBy: SidebarSessionSortBy = "updated",
): Session[] {
  const dirKey = pathKey(scratchDir)
  return sessions
    .filter(
      (s) =>
        !s.parentID &&
        !s.time?.archived &&
        !pinnedIds.has(s.id) &&
        pathKey(s.directory) === dirKey,
    )
    .sort((a, b) => sessionSidebarTimestamp(b, sortBy) - sessionSidebarTimestamp(a, sortBy))
}
