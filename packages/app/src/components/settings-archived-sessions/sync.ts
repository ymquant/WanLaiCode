import type { GlobalSession, Session } from "@opencode-ai/sdk/v2/client"
import type { OpencodeClient } from "@opencode-ai/sdk/v2/client"
import type { QueryClient } from "@tanstack/solid-query"
import { produce } from "solid-js/store"
import { dropSessionCaches, settleRemovalLocally } from "@/context/global-sync/session-cache"
import type { FetchArchivedSessionsResult } from "./fetch"

export const ARCHIVED_SESSIONS_QUERY_KEY = ["archived-sessions"] as const
export const ARCHIVED_SESSIONS_LIST_QUERY_KEY = [...ARCHIVED_SESSIONS_QUERY_KEY, "list"] as const
export const ARCHIVED_SESSIONS_AUTOMATION_IDS_QUERY_KEY = ["archived-sessions-automation-ids"] as const

export type ArchivedSessionRemoval = { dir: string; session: Session; index: number }

type ProjectRef = { id?: string; worktree: string; sandboxes?: string[] }

const sessionMutationInflight = new Map<string, Promise<unknown>>()

export function sessionAfterUnarchive<T extends Pick<GlobalSession, "time">>(session: T): T {
  return {
    ...session,
    time: {
      ...session.time,
      archived: undefined,
      updated: Date.now(),
    },
  }
}

export function requireArchivedSession(data: Session | undefined | null) {
  if (!data || data.time.archived === undefined) throw new Error("archive failed")
  return data
}

type SessionStoreGlobalSync = {
  data: { project: ReadonlyArray<ProjectRef> }
  hasChild: (directory: string) => boolean
  child: (directory: string, input?: { bootstrap?: boolean }) => readonly [unknown, unknown]
  childDirectories: () => string[]
}

export function sessionDirectoryCandidates(
  globalSync: Pick<SessionStoreGlobalSync, "data" | "childDirectories">,
  hintDirectory?: string,
  extraDirectories?: readonly string[],
) {
  const dirs = new Set<string>()
  if (hintDirectory) dirs.add(hintDirectory)
  for (const directory of extraDirectories ?? []) {
    if (directory) dirs.add(directory)
  }
  for (const project of globalSync.data.project) {
    dirs.add(project.worktree)
    for (const sandbox of project.sandboxes ?? []) dirs.add(sandbox)
  }
  for (const directory of globalSync.childDirectories()) dirs.add(directory)
  return [...dirs]
}

export function findSessionInStores(
  globalSync: SessionStoreGlobalSync,
  sessionID: string,
  hintDirectory?: string,
) {
  const tryDir = (directory: string) => {
    if (!globalSync.hasChild(directory)) return undefined
    const [store] = globalSync.child(directory, { bootstrap: false })
    return (store as { session?: Session[] }).session?.find(
      (item) => item.id === sessionID && item.time.archived === undefined,
    )
  }

  if (hintDirectory) {
    const hit = tryDir(hintDirectory)
    if (hit) return hit
  }

  for (const project of globalSync.data.project) {
    for (const directory of [project.worktree, ...(project.sandboxes ?? [])]) {
      const hit = tryDir(directory)
      if (hit) return hit
    }
  }

  for (const directory of globalSync.childDirectories()) {
    const hit = tryDir(directory)
    if (hit) return hit
  }

  return undefined
}

export type SessionAcrossDirectoriesResult =
  | { ok: true; session: Session }
  | { ok: false; reason: "missing" | "unavailable" }

export function isSessionNotFoundError(error: unknown) {
  if (typeof error !== "object" || !error) return false
  const record = error as Record<string, unknown>
  // SDK throwOnError 的 404 抛普通对象 { name: "NotFoundError", data: {...} }（非 Error 实例、无 response.status）
  if (record.name === "NotFoundError" || record.name === "StorageNotFoundError" || record.name === "SessionNotFoundError")
    return true
  const response = record.response as { status?: number } | undefined
  if (response?.status === 404) return true
  if (error instanceof Error && /not\s*found/i.test(error.message)) return true
  return false
}

export async function getSessionAcrossDirectories(
  client: OpencodeClient,
  globalSync: SessionStoreGlobalSync,
  sessionID: string,
  hintDirectory?: string,
  options?: { extraDirectories?: readonly string[] },
): Promise<SessionAcrossDirectoriesResult> {
  const directories = sessionDirectoryCandidates(globalSync, hintDirectory, options?.extraDirectories)
  if (directories.length === 0) {
    const cached = findSessionInStores(globalSync, sessionID, hintDirectory)
    if (cached) return { ok: true, session: cached }
    return { ok: false, reason: "missing" }
  }

  const attempts = await Promise.all(
    directories.map(async (directory) => {
      try {
        const response = await client.session.get({ sessionID, directory })
        return { session: response.data, error: undefined as unknown }
      } catch (error) {
        return { session: undefined, error }
      }
    }),
  )

  const found = attempts.find((item) => item.session)?.session
  if (found) return { ok: true, session: found }

  const errors = attempts.map((item) => item.error).filter((error) => error !== undefined)
  if (errors.length > 0 && !errors.every(isSessionNotFoundError)) {
    return { ok: false, reason: "unavailable" }
  }

  const cached = findSessionInStores(globalSync, sessionID, hintDirectory)
  if (cached) return { ok: true, session: cached }

  return { ok: false, reason: "missing" }
}

export function runSessionMutationInflight<T>(sessionID: string, task: () => Promise<T>) {
  const pending = sessionMutationInflight.get(sessionID)
  if (pending) return pending as Promise<T>

  const promise = task().finally(() => {
    sessionMutationInflight.delete(sessionID)
  })
  sessionMutationInflight.set(sessionID, promise)
  return promise
}

export function runArchiveInflight(sessionID: string, task: () => Promise<void>) {
  return runSessionMutationInflight(sessionID, task)
}

export function invalidateArchivedSessionsList(queryClient: QueryClient) {
  void queryClient.invalidateQueries({ queryKey: ARCHIVED_SESSIONS_LIST_QUERY_KEY })
}

export function mergeArchivedSessionIntoListCache(queryClient: QueryClient, session: Session) {
  if (session.time.archived === undefined) return
  const archived: GlobalSession = { ...session, project: null }
  queryClient.setQueryData<FetchArchivedSessionsResult>(
    [...ARCHIVED_SESSIONS_LIST_QUERY_KEY, ""] as const,
    (old) => {
      if (!Array.isArray(old?.sessions)) return old
      const sessions = old.sessions.filter((item) => item.id !== session.id)
      return {
        sessions: [archived, ...sessions],
        truncated: old.truncated ?? false,
      }
    },
  )
}

export function removeArchivedSessionFromListCache(queryClient: QueryClient, sessionID: string) {
  queryClient.setQueriesData<FetchArchivedSessionsResult>({ queryKey: ARCHIVED_SESSIONS_LIST_QUERY_KEY }, (old) => {
    if (!Array.isArray(old?.sessions)) return old
    const sessions = old.sessions.filter((item) => item.id !== sessionID)
    if (sessions.length === old.sessions.length) return old
    return { ...old, sessions }
  })
}

export function affectedArchiveDirectories(
  session: Pick<GlobalSession, "directory" | "projectID">,
  projects: ReadonlyArray<ProjectRef>,
) {
  const dirs = new Set<string>()
  dirs.add(session.directory)
  const project = projects.find((item) => item.id === session.projectID)
  if (!project) return [...dirs]

  dirs.add(project.worktree)
  for (const sandbox of project.sandboxes ?? []) dirs.add(sandbox)
  return [...dirs]
}

export function removeSessionFromSidebar(
  globalSync: {
    data: { project: ReadonlyArray<ProjectRef> }
    child: (directory: string, input?: { bootstrap?: boolean }) => readonly [unknown, unknown]
  },
  session: Pick<Session, "id" | "directory" | "projectID">,
) {
  const removed: ArchivedSessionRemoval[] = []
  for (const dir of affectedArchiveDirectories(session, globalSync.data.project)) {
    const [storeRef, setStoreRef] = globalSync.child(dir, { bootstrap: false })
    const list = (storeRef as { session?: Session[] }).session ?? []
    const index = list.findIndex((item) => item.id === session.id)
    if (index < 0) continue
    const snapshot = list[index]
    removed.push({ dir, session: snapshot, index })
    const setStore = setStoreRef as (recipe: (draft: { session: Session[] }) => void) => void
    setStore(
      produce((draft) => {
        if (!draft.session) draft.session = []
        const match = draft.session.findIndex((item) => item.id === session.id)
        if (match >= 0) draft.session.splice(match, 1)
      }),
    )
  }
  return removed
}

/**
 * 「已确认不可访问」的终态结算：对每个受影响目录递减根会话分页总数、
 * 清理 message/part/status/diff 等派生缓存。与 deleted/archived SSE 事件
 * 经双向结算器竞争同一次递减——SSE 先到则此处跳过，此处先到则 SSE 跳过。
 * 仅在服务端已确认删除/归档时调用——不可回滚。
 */
export function settleSessionRemovals(
  globalSync: {
    child: (directory: string, input?: { bootstrap?: boolean }) => readonly [unknown, unknown]
  },
  removals: ArchivedSessionRemoval[],
  sessionID: string,
) {
  for (const item of removals) {
    const [, setStoreRef] = globalSync.child(item.dir, { bootstrap: false })
    const setStore = setStoreRef as (
      recipe: (draft: { sessionTotal: number } & Parameters<typeof dropSessionCaches>[0]) => void,
    ) => void
    const shouldDecrement = !item.session.parentID && settleRemovalLocally(item.dir, sessionID)
    setStore(
      produce((draft) => {
        if (shouldDecrement) draft.sessionTotal = Math.max(0, draft.sessionTotal - 1)
        dropSessionCaches(draft, [sessionID])
      }),
    )
  }
}

/** 乐观移除 + 立即终态结算：供 sessionAccess 兜底（服务端已确认不可访问）使用。 */
export function purgeSessionFromSidebar(
  globalSync: {
    data: { project: ReadonlyArray<ProjectRef> }
    child: (directory: string, input?: { bootstrap?: boolean }) => readonly [unknown, unknown]
  },
  session: Pick<Session, "id" | "directory" | "projectID">,
) {
  const removed = removeSessionFromSidebar(globalSync, session)
  settleSessionRemovals(globalSync, removed, session.id)
  return removed
}

export async function refreshUnarchivedSessionSidebar(
  globalSync: {
    data: { project: ReadonlyArray<ProjectRef> }
    project: { refreshSessions: (directory: string) => Promise<void> }
  },
  session: Pick<GlobalSession, "directory" | "projectID">,
) {
  for (const dir of affectedArchiveDirectories(session, globalSync.data.project)) {
    await globalSync.project.refreshSessions(dir)
  }
}

export function ensureUnarchivedSessionInSidebar(
  globalSync: {
    data: { project: ReadonlyArray<ProjectRef> }
    child: (directory: string, input?: { bootstrap?: boolean }) => readonly [unknown, unknown]
  },
  session: Session,
) {
  const item = sessionAfterUnarchive(session)
  for (const dir of affectedArchiveDirectories(session, globalSync.data.project)) {
    const [storeRef, setStoreRef] = globalSync.child(dir, { bootstrap: false })
    const list = (storeRef as { session?: Session[] }).session ?? []
    if (list.some((entry) => entry.id === session.id)) continue
    const setStore = setStoreRef as (recipe: (draft: { session: Session[] }) => void) => void
    setStore(
      produce((draft) => {
        if (!draft.session) draft.session = []
        const existing = draft.session.findIndex((entry) => entry.id === session.id)
        if (existing >= 0) {
          draft.session[existing] = item
          return
        }
        const insertAt = draft.session.findIndex((entry) => entry.id >= item.id)
        draft.session.splice(insertAt === -1 ? draft.session.length : insertAt, 0, item)
      }),
    )
  }
}
