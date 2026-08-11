import type {
  Message,
  Part,
  PermissionRequest,
  QuestionRequest,
  SessionStatus,
  SnapshotFileDiff,
  Todo,
} from "@opencode-ai/sdk/v2/client"
import type { PermissionReviewState } from "./types"

export const SESSION_CACHE_LIMIT = 40

type SessionCache = {
  session_status: Record<string, SessionStatus | undefined>
  session_status_known?: Record<string, true | undefined>
  session_diff: Record<string, SnapshotFileDiff[] | undefined>
  session_suggestion: Record<string, string | undefined>
  todo: Record<string, Todo[] | undefined>
  message: Record<string, Message[] | undefined>
  part: Record<string, Part[] | undefined>
  permission: Record<string, PermissionRequest[] | undefined>
  permission_review?: Record<string, PermissionReviewState[] | undefined>
  question: Record<string, QuestionRequest[] | undefined>
}

export function dropSessionCaches(store: SessionCache, sessionIDs: Iterable<string>) {
  const stale = new Set(Array.from(sessionIDs).filter(Boolean))
  if (stale.size === 0) return

  for (const key of Object.keys(store.part)) {
    const parts = store.part[key]
    if (!parts?.some((part) => stale.has(part?.sessionID ?? ""))) continue
    delete store.part[key]
  }

  for (const sessionID of stale) {
    delete store.message[sessionID]
    delete store.todo[sessionID]
    delete store.session_diff[sessionID]
    delete store.session_suggestion[sessionID]
    delete store.session_status[sessionID]
    delete store.session_status_known?.[sessionID]
    delete store.permission[sessionID]
    delete store.permission_review?.[sessionID]
    delete store.question[sessionID]
  }
}

export function pickSessionCacheEvictions(input: {
  seen: Set<string>
  keep: string
  limit: number
  preserve?: Iterable<string>
}) {
  const stale: string[] = []
  const keep = new Set([input.keep, ...Array.from(input.preserve ?? [])])
  if (input.seen.has(input.keep)) input.seen.delete(input.keep)
  input.seen.add(input.keep)
  for (const id of input.seen) {
    if (input.seen.size - stale.length <= input.limit) break
    if (keep.has(id)) continue
    stale.push(id)
  }
  for (const id of stale) {
    input.seen.delete(id)
  }
  return stale
}

// 会话移除的「双向结算器」：本地终态结算（sessionAccess 兜底 / 归档成功 settle）与
// SSE 事件（deleted / archived）竞争同一次 sessionTotal 递减——先到者递减并给对方
// 留下可消费的标记，后到者消费标记后跳过，两种到达顺序都不会双递减。
// 标记消费即失效；会话重新可访问（created / unarchive）时调用 clear 使残留标记作废，
// 保证「归档→恢复→再归档」的新一轮合法事件不会误中旧标记。
import { pathKey } from "@/utils/path-key"
const settledByLocal = new Set<string>()
const settledByEvent = new Set<string>()
const settlementKey = (directory: string, sessionID: string) => `${pathKey(directory)}\n${sessionID}`

/** 本地终态结算调用：返回 true 表示应执行递减（SSE 未处理过）。 */
export function settleRemovalLocally(directory: string, sessionID: string) {
  const key = settlementKey(directory, sessionID)
  if (settledByEvent.delete(key)) return false
  settledByLocal.add(key)
  return true
}

/** SSE 事件（deleted/archived）调用：返回 true 表示应执行递减（本地未结算过）。 */
export function settleRemovalByEvent(directory: string, sessionID: string) {
  const key = settlementKey(directory, sessionID)
  if (settledByLocal.delete(key)) return false
  settledByEvent.add(key)
  return true
}

/** 会话重新可访问（created / 未归档 updated 插入）时清除两侧残留标记。 */
export function clearRemovalSettlement(directory: string, sessionID: string) {
  const key = settlementKey(directory, sessionID)
  settledByLocal.delete(key)
  settledByEvent.delete(key)
}
