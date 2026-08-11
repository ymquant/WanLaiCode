import type { QueryClient } from "@tanstack/solid-query"

export const globalMcpQueryKey = ["mcp", "status", "global"] as const

export function invalidateMcpQueries(queryClient: QueryClient) {
  return queryClient.invalidateQueries({
    predicate(query) {
      const key = query.queryKey
      return (
        (key.length === 2 && key[1] === "mcp") ||
        (key.length === 3 && key[0] === "mcp" && key[1] === "status" && key[2] === "global")
      )
    },
  })
}
