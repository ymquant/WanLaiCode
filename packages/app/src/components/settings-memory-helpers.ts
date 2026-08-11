type MemoryScope = "global" | "project"

type MemoryContext = {
  directory?: string
  sessionID?: string
}

type RequestQuery = MemoryContext & {
  scope?: MemoryScope
  search?: string
  limit?: number
}

export function buildMemoryRequestURL(baseURL: string, path: string, query: RequestQuery = {}) {
  const url = new URL(path, baseURL)
  if (query.directory) url.searchParams.set("directory", query.directory)
  if (query.sessionID) url.searchParams.set("session", query.sessionID)
  if (query.scope) url.searchParams.set("scope", query.scope)
  if (query.search) url.searchParams.set("search", query.search)
  if (query.limit) url.searchParams.set("limit", String(query.limit))
  return url.toString()
}

export function memoryScopePayload(scope: MemoryScope) {
  return { scope }
}
