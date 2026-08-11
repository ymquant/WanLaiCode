import { expect, test } from "bun:test"
import type { QueryClient } from "@tanstack/solid-query"
import { invalidateMcpQueries } from "./mcp-query"

test("使所有 MCP 状态查询失效且保留无关查询", async () => {
  const directoryKey = ["/project", "mcp"] as const
  const globalKey = ["mcp", "status", "global"] as const
  const unrelatedKey = ["session", "list"] as const
  const invalidated: unknown[][] = []
  const client = {
    invalidateQueries: async (filters: { predicate: (query: { queryKey: readonly unknown[] }) => boolean }) => {
      for (const queryKey of [directoryKey, globalKey, unrelatedKey]) {
        if (filters.predicate({ queryKey })) invalidated.push([...queryKey])
      }
    },
  } as unknown as QueryClient

  await invalidateMcpQueries(client)

  expect(invalidated).toEqual([
    ["/project", "mcp"],
    ["mcp", "status", "global"],
  ])
})
