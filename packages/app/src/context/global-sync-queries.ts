// 放在 .ts（而非 .tsx）以绕开 bun runtime Windows 上的 named export 解析 bug。
import type { OpencodeClient } from "@opencode-ai/sdk/v2/client"
import { queryOptions } from "@tanstack/solid-query"

export const loadSessionsQueryKey = (directory: string) => [directory, "loadSessions"] as const

export const mcpQueryKey = (directory: string) => [directory, "mcp"] as const

export const loadMcpQuery = (directory: string, sdk: OpencodeClient) =>
  queryOptions({
    queryKey: mcpQueryKey(directory),
    queryFn: () => sdk.mcp.status().then((r) => r.data ?? {}),
  })

export const lspQueryKey = (directory: string) => [directory, "lsp"] as const

export const loadLspQuery = (directory: string, sdk: OpencodeClient) =>
  queryOptions({
    queryKey: lspQueryKey(directory),
    queryFn: () => sdk.lsp.status().then((r) => r.data ?? []),
  })
