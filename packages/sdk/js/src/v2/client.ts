export * from "./gen/types.gen.js"

import { createClient } from "./gen/client/client.gen.js"
import { type Config } from "./gen/client/types.gen.js"
import { OpencodeClient } from "./gen/sdk.gen.js"
export { type Config as OpencodeClientConfig, OpencodeClient }

function pick(value: string | null, fallback?: string, encode?: (value: string) => string) {
  if (!value) return
  if (!fallback) return value
  if (value === fallback) return fallback
  if (encode && value === encode(fallback)) return fallback
  return value
}

function rewrite(request: Request, values: { directory?: string; workspace?: string }) {
  if (request.method !== "GET" && request.method !== "HEAD") return request

  const url = new URL(request.url)
  let changed = false

  for (const [name, key] of [
    ["x-opencode-directory", "directory"],
    ["x-opencode-workspace", "workspace"],
  ] as const) {
    const value = pick(
      request.headers.get(name),
      key === "directory" ? values.directory : values.workspace,
      key === "directory" ? encodeURIComponent : undefined,
    )
    if (!value) continue
    if (!url.searchParams.has(key)) {
      url.searchParams.set(key, value)
    }
    changed = true
  }

  if (!changed) return request

  const next = new Request(url, request)
  next.headers.delete("x-opencode-directory")
  next.headers.delete("x-opencode-workspace")
  return next
}

export function createOpencodeClient(config?: Config & { directory?: string; experimental_workspaceID?: string }) {
  if (!config?.fetch) {
    const customFetch: any = (req: any) => {
      // @ts-ignore
      req.timeout = false
      return fetch(req)
    }
    config = {
      ...config,
      fetch: customFetch,
    }
  }

  if (config?.directory) {
    config.headers = {
      ...config.headers,
      "x-opencode-directory": encodeURIComponent(config.directory),
    }
  }

  if (config?.experimental_workspaceID) {
    config.headers = {
      ...config.headers,
      "x-opencode-workspace": config.experimental_workspaceID,
    }
  }

  const client = createClient(config)
  client.interceptors.request.use((request) =>
    rewrite(request, {
      directory: config?.directory,
      workspace: config?.experimental_workspaceID,
    }),
  )
  // The generated client strips an all-empty `params.body` and then drops the
  // Content-Type header, emitting a bodyless POST/PUT/PATCH. The effect-httpapi
  // backend rejects such a request with a 400 (empty response body) because it
  // can't decode an absent JSON payload — even when every field is optional
  // (e.g. `session.fork` with no messageID when forking the last message).
  // Backfill an empty JSON object so the payload decodes to {} on every backend.
  client.interceptors.request.use((request) => {
    if (request.method === "GET" || request.method === "HEAD") return request
    if (request.body !== null) return request
    const headers = new Headers(request.headers)
    headers.set("content-type", "application/json")
    return new Request(request, { body: "{}", headers })
  })
  client.interceptors.response.use((response) => {
    const contentType = response.headers.get("content-type")
    if (contentType === "text/html")
      throw new Error("Request is not supported by this version of the server (responded with text/html)")

    return response
  })
  // The generated client falls back to throwing a literal `{}` when the server
  // responds with an empty / unparseable error body, which surfaces as a bare
  // `{}` in TUI / CLI error output. Wrap ONLY that case in a real Error so
  // downstream formatters get a useful message — but pass through any parsed
  // JSON error body unchanged so existing consumers can still inspect fields.
  client.interceptors.error.use((error, response, request) => {
    const isEmpty =
      error === undefined ||
      error === null ||
      error === "" ||
      (typeof error === "object" && !(error instanceof Error) && Object.keys(error).length === 0)
    if (!isEmpty) return error
    const method = request?.method ?? "?"
    const url = request?.url ?? "?"
    if (!response) return new Error(`server ${method} ${url}: network error (no response)`)
    const status = response.status
    const statusText = response.statusText ? " " + response.statusText : ""
    return new Error(`server ${method} ${url} → ${status}${statusText}: (empty response body)`)
  })
  return new OpencodeClient({ client })
}
