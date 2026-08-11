import type { OpencodeClient } from "@opencode-ai/sdk/v2/client"
import type { GlobalSession } from "@opencode-ai/sdk/v2/client"

const PAGE_LIMIT = 100
const MAX_PAGES = 200

export type FetchArchivedSessionsResult = {
  sessions: GlobalSession[]
  truncated: boolean
}

type ArchivedSessionListParams = {
  archived: true
  limit: number
  cursor?: string
  search?: string
}

function listArchivedSessions(client: OpencodeClient, params: ArchivedSessionListParams) {
  // Generated SDK types cursor as number; archived list pagination uses "time:id" strings.
  return client.experimental.session.list(
    params as unknown as NonNullable<Parameters<OpencodeClient["experimental"]["session"]["list"]>[0]>,
  )
}

export async function fetchArchivedSessions(client: OpencodeClient, search?: string): Promise<FetchArchivedSessionsResult> {
  const all: GlobalSession[] = []
  const seen = new Set<string>()
  let cursor: string | undefined
  let truncated = false

  for (let page = 0; page < MAX_PAGES; page++) {
    const response = await listArchivedSessions(client, {
      archived: true,
      limit: PAGE_LIMIT,
      cursor,
      search: search?.trim() || undefined,
    })
    const batch = response.data ?? []
    for (const session of batch) {
      if (session.time.archived === undefined || seen.has(session.id)) continue
      seen.add(session.id)
      all.push(session)
    }

    const nextCursor = response.response.headers.get("x-next-cursor") ?? undefined
    const hasMore = nextCursor !== undefined && batch.length >= PAGE_LIMIT
    if (!hasMore) break
    if (page === MAX_PAGES - 1) {
      truncated = true
      break
    }
    cursor = nextCursor
  }

  return { sessions: all, truncated }
}
