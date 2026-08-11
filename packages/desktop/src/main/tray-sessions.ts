import { basename } from "node:path"

import type { ServerReadyData } from "../preload/types"

const PLACEHOLDER_TITLE = /^(New session|Child session) - \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const RECENT_SESSIONS_TIMEOUT_MS = 800

export type TrayRecentSession = {
  sessionID: string
  directory: string
  title: string
  projectName: string
}

type GlobalSession = {
  id: string
  title: string
  directory: string
  project?: { name?: string } | null
}

export function directorySlug(directory: string) {
  return Buffer.from(directory, "utf8").toString("base64url")
}

export function formatTraySessionTitle(title: string) {
  const match = title.match(PLACEHOLDER_TITLE)
  return match?.[1] ?? title
}

function projectName(session: GlobalSession) {
  return session.project?.name?.trim() || basename(session.directory)
}

export async function listTrayRecentSessions(
  sidecar: ServerReadyData,
  limit = 7,
): Promise<TrayRecentSession[]> {
  if (!sidecar.username || !sidecar.password) return []
  const credentials = Buffer.from(`${sidecar.username}:${sidecar.password}`).toString("base64")
  const res = await fetch(`${sidecar.url}/experimental/session?limit=${limit}`, {
    headers: { Authorization: `Basic ${credentials}` },
    signal: AbortSignal.timeout(RECENT_SESSIONS_TIMEOUT_MS),
  })
  if (!res.ok) return []
  const sessions = (await res.json()) as GlobalSession[]
  return sessions.map((session) => ({
    sessionID: session.id,
    directory: session.directory,
    title: formatTraySessionTitle(session.title),
    projectName: projectName(session),
  }))
}
