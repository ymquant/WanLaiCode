import { getFilename } from "@opencode-ai/core/util/path"
import { type Session } from "@opencode-ai/sdk/v2/client"
import { pathKey } from "@/utils/path-key"

type SessionStore = {
  session?: Session[]
  path: { directory: string }
}

export type SidebarSessionSortBy = "created" | "updated"

export function sessionSidebarTimestamp(session: Session, sortBy: SidebarSessionSortBy = "updated") {
  if (sortBy === "created") return session.time.created
  return session.time.updated ?? session.time.created
}

function sortSessions(now: number, sortBy: SidebarSessionSortBy = "updated") {
  const oneMinuteAgo = now - 60 * 1000
  return (a: Session, b: Session) => {
    const aUpdated = a.time.updated ?? a.time.created
    const bUpdated = b.time.updated ?? b.time.created
    const aRecent = aUpdated > oneMinuteAgo
    const bRecent = bUpdated > oneMinuteAgo
    if (aRecent && bRecent) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    if (aRecent && !bRecent) return -1
    if (!aRecent && bRecent) return 1
    const aKey = sessionSidebarTimestamp(a, sortBy)
    const bKey = sessionSidebarTimestamp(b, sortBy)
    return bKey - aKey
  }
}

const isRootVisibleSession = (session: Session, directory: string) =>
  pathKey(session.directory) === pathKey(directory) && !session.parentID && !session.time?.archived

export const roots = (store: SessionStore) =>
  (store.session ?? []).filter((session) => isRootVisibleSession(session, store.path.directory))

export const sortedRootSessions = (
  store: SessionStore,
  now: number,
  sortBy: SidebarSessionSortBy = "updated",
) => roots(store).sort(sortSessions(now, sortBy))

// 项目级别的根会话：同时接受 project.worktree 主目录 + sandboxes（含 git worktree fork 创建的子目录）下的会话。
// 用于 sidebar 的 project-row：让派生到新工作树的会话也能出现在源项目分组下。
export const rootsForProject = (
  store: SessionStore,
  project: { worktree: string; sandboxes?: string[] | undefined },
) => {
  const accepted = new Set<string>([pathKey(project.worktree)])
  for (const dir of project.sandboxes ?? []) accepted.add(pathKey(dir))
  return (store.session ?? []).filter(
    (session) => accepted.has(pathKey(session.directory)) && !session.parentID && !session.time?.archived,
  )
}

export const sortedRootSessionsForProject = (
  store: SessionStore,
  project: { worktree: string; sandboxes?: string[] | undefined },
  now: number,
  sortBy: SidebarSessionSortBy = "updated",
) => rootsForProject(store, project).sort(sortSessions(now, sortBy))

export const latestRootSession = (stores: SessionStore[], now: number, sortBy: SidebarSessionSortBy = "updated") =>
  stores.flatMap(roots).sort(sortSessions(now, sortBy))[0]

export function hasProjectPermissions<T>(
  request: Record<string, T[] | undefined> | undefined,
  include: (item: T) => boolean = () => true,
) {
  return Object.values(request ?? {}).some((list) => list?.some(include))
}

export const childSessionOnPath = (sessions: Session[] | undefined, rootID: string, activeID?: string) => {
  if (!activeID || activeID === rootID) return
  const map = new Map((sessions ?? []).map((session) => [session.id, session]))
  let id = activeID

  while (id) {
    const session = map.get(id)
    if (!session?.parentID) return
    if (session.parentID === rootID) return session
    id = session.parentID
  }
}

export const displayName = (project: { name?: string; worktree: string }) =>
  project.name || getFilename(project.worktree)

export const errorMessage = (err: unknown, fallback: string) => {
  if (err && typeof err === "object" && "data" in err) {
    const data = (err as { data?: { message?: string } }).data
    if (data?.message) return data.message
  }
  if (err instanceof Error) return err.message
  return fallback
}

export const effectiveWorkspaceOrder = (local: string, dirs: string[], persisted?: string[]) => {
  const root = pathKey(local)
  const live = new Map<string, string>()

  for (const dir of dirs) {
    const key = pathKey(dir)
    if (key === root) continue
    if (!live.has(key)) live.set(key, dir)
  }

  if (!persisted?.length) return [local, ...live.values()]

  const result = [local]
  for (const dir of persisted) {
    const key = pathKey(dir)
    if (key === root) continue
    const match = live.get(key)
    if (!match) continue
    result.push(match)
    live.delete(key)
  }

  return [...result, ...live.values()]
}
