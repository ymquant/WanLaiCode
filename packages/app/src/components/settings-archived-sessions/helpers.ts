import { getFilename } from "@opencode-ai/core/util/path"
import type { GlobalSession } from "@opencode-ai/sdk/v2/client"
import { pathKey } from "@/utils/path-key"
import { isScratchSessionPath } from "@/utils/scratch"
import { sessionTitle } from "@/utils/session-title"

export type ArchivedTypeFilter = "all" | "local" | "cloud"
export type ArchivedSort = "updated" | "created" | "alpha"
export type ArchivedProjectFilter = "all" | "chats" | "automations" | { worktree: string }

export type ProjectCatalogEntry = {
  id?: string
  worktree: string
  name: string
  sandboxes?: string[]
}

export type ResolvedArchivedProject = {
  worktree: string
  name: string
  isScratch: boolean
}

export type ArchivedSessionGroup = {
  key: string
  worktree: string
  name: string
  sessions: GlobalSession[]
}

export type ArchivedProjectOption = {
  worktree: string
  name: string
}

export function isArchivedSession(session: GlobalSession) {
  return session.time.archived !== undefined
}

export function isCloudArchivedSession(session: GlobalSession) {
  return !!session.workspaceID
}

export function buildProjectDirectoryIndex(projects: readonly ProjectCatalogEntry[]) {
  const index = new Map<string, ProjectCatalogEntry>()
  for (const project of projects) {
    const entry = {
      ...project,
      name: project.name.trim() || getFilename(project.worktree),
    }
    index.set(pathKey(project.worktree), entry)
    for (const sandbox of project.sandboxes ?? []) {
      index.set(pathKey(sandbox), entry)
    }
  }
  return index
}

export function resolveArchivedSessionProject(
  session: GlobalSession,
  index: Map<string, ProjectCatalogEntry>,
  options?: { scratchDir?: string; scratchLabel?: string },
): ResolvedArchivedProject {
  if (isScratchSessionPath(session.directory, options?.scratchDir)) {
    const worktree = options?.scratchDir ?? session.directory
    return {
      worktree,
      name: options?.scratchLabel ?? getFilename(worktree),
      isScratch: true,
    }
  }

  if (session.project?.worktree) {
    const entry =
      index.get(pathKey(session.directory)) ??
      index.get(pathKey(session.project.worktree)) ?? {
        worktree: session.project.worktree,
        name: session.project.name?.trim() || getFilename(session.project.worktree),
      }
    return { worktree: entry.worktree, name: entry.name, isScratch: false }
  }

  const byDirectory = index.get(pathKey(session.directory))
  if (byDirectory) {
    return { worktree: byDirectory.worktree, name: byDirectory.name, isScratch: false }
  }

  if (session.projectID) {
    for (const entry of index.values()) {
      if (entry.id === session.projectID) {
        return { worktree: entry.worktree, name: entry.name, isScratch: false }
      }
    }
  }

  return {
    worktree: session.directory,
    name: getFilename(session.directory),
    isScratch: false,
  }
}

export function projectWorktree(
  session: GlobalSession,
  index: Map<string, ProjectCatalogEntry>,
  scratchDir?: string,
  scratchLabel?: string,
) {
  return resolveArchivedSessionProject(session, index, { scratchDir, scratchLabel }).worktree
}

export function projectName(
  session: GlobalSession,
  index: Map<string, ProjectCatalogEntry>,
  scratchDir?: string,
  scratchLabel?: string,
) {
  return resolveArchivedSessionProject(session, index, { scratchDir, scratchLabel }).name
}

export function buildArchivedProjectOptions(input: {
  sessions: readonly GlobalSession[]
  index: Map<string, ProjectCatalogEntry>
  scratchDir?: string
  scratchLabel?: string
  type: ArchivedTypeFilter
}) {
  const seen = new Map<string, ArchivedProjectOption>()
  for (const session of input.sessions) {
    if (!isArchivedSession(session)) continue

    const cloud = isCloudArchivedSession(session)
    if (input.type === "local" && cloud) continue
    if (input.type === "cloud" && !cloud) continue

    const resolved = resolveArchivedSessionProject(session, input.index, {
      scratchDir: input.scratchDir,
      scratchLabel: input.scratchLabel,
    })
    if (resolved.isScratch) continue

    const key = pathKey(resolved.worktree)
    if (seen.has(key)) continue
    seen.set(key, { worktree: resolved.worktree, name: resolved.name })
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))
}

export function filterArchivedSessions(input: {
  sessions: readonly GlobalSession[]
  index: Map<string, ProjectCatalogEntry>
  scratchDir?: string
  scratchLabel?: string
  automationIds: ReadonlySet<string>
  type: ArchivedTypeFilter
  project: ArchivedProjectFilter
  search: string
}) {
  const query = input.search.trim().toLowerCase()

  return input.sessions.filter((session) => {
    if (!isArchivedSession(session)) return false

    const cloud = isCloudArchivedSession(session)
    if (input.type === "local" && cloud) return false
    if (input.type === "cloud" && !cloud) return false

    const isAutomation = input.automationIds.has(session.id)
    if (input.project === "chats" && isAutomation) return false
    if (input.project === "automations" && !isAutomation) return false

    const needsResolved = typeof input.project === "object" || !!query
    if (!needsResolved) return true

    const resolved = resolveArchivedSessionProject(session, input.index, {
      scratchDir: input.scratchDir,
      scratchLabel: input.scratchLabel,
    })

    if (typeof input.project === "object" && pathKey(resolved.worktree) !== pathKey(input.project.worktree))
      return false

    if (!query) return true

    const title = sessionTitle(session.title)?.toLowerCase() ?? ""
    const name = resolved.name.toLowerCase()
    const directory = session.directory.toLowerCase()
    const worktree = resolved.worktree.toLowerCase()
    return (
      title.includes(query) ||
      name.includes(query) ||
      directory.includes(query) ||
      worktree.includes(query)
    )
  })
}

export function sortArchivedSessions(sessions: GlobalSession[], sort: ArchivedSort) {
  const copy = sessions.slice()
  if (sort === "alpha") {
    return copy.sort((a, b) =>
      (sessionTitle(a.title) ?? "").localeCompare(sessionTitle(b.title) ?? "", undefined, { sensitivity: "base" }),
    )
  }
  if (sort === "created") return copy.sort((a, b) => b.time.created - a.time.created)
  return copy.sort((a, b) => {
    const ta = a.time.archived ?? a.time.updated ?? a.time.created
    const tb = b.time.archived ?? b.time.updated ?? b.time.created
    return tb - ta
  })
}

export function groupArchivedSessions(
  sessions: readonly GlobalSession[],
  input: {
    index: Map<string, ProjectCatalogEntry>
    sort: ArchivedSort
    scratchDir?: string
    scratchLabel?: string
  },
) {
  const map = new Map<string, ArchivedSessionGroup>()
  for (const session of sessions) {
    const resolved = resolveArchivedSessionProject(session, input.index, {
      scratchDir: input.scratchDir,
      scratchLabel: input.scratchLabel,
    })
    const key = pathKey(resolved.worktree)
    const existing = map.get(key)
    if (existing) {
      existing.sessions.push(session)
      continue
    }
    map.set(key, {
      key,
      worktree: resolved.worktree,
      name: resolved.name,
      sessions: [session],
    })
  }

  const groups = [...map.values()]
  for (const group of groups) {
    group.sessions = sortArchivedSessions(group.sessions, input.sort)
  }
  return groups.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))
}

export function formatArchivedSessionTime(value: number, locale: string) {
  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value))
}
