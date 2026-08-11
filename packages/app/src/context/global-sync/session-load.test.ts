import { describe, expect, test } from "bun:test"
import type { Session } from "@opencode-ai/sdk/v2/client"
import { loadRootSessionsWithFallback } from "./session-load"
import type { RootLoadArgs } from "./types"

const session = (id: string, projectID: string, directory: string, title: string) =>
  ({
    id,
    projectID,
    directory,
    title,
    slug: id,
    version: "test",
    time: { created: 1, updated: 1 },
  }) as Session

describe("loadRootSessionsWithFallback", () => {
  test("keeps project scope for regular projects", async () => {
    const queries: Parameters<RootLoadArgs["list"]>[0][] = []
    const data = [session("ses_project", "project_1", "/repo", "历史项目会话")]

    const result = await loadRootSessionsWithFallback({
      directory: "/repo",
      limit: 55,
      list: async (query) => {
        queries.push(query)
        return { data }
      },
    })

    expect(result.data).toEqual(data)
    expect(queries).toEqual([{ directory: "/repo", roots: true, limit: 55, scope: "project" }])
  })

  test("reloads global project sessions by directory", async () => {
    const queries: Parameters<RootLoadArgs["list"]>[0][] = []
    const unrelated = session("ses_automation", "global", "/automation/global", "自动化会话")
    const history = session("ses_history", "global", "/documents/demo", "恢复后的真实标题")

    const result = await loadRootSessionsWithFallback({
      directory: "/documents/demo",
      limit: 55,
      list: async (query) => {
        queries.push(query)
        return { data: query.scope === "project" ? [unrelated] : [history] }
      },
    })

    expect(result.data).toEqual([history])
    expect(queries).toEqual([
      { directory: "/documents/demo", roots: true, limit: 55, scope: "project" },
      { directory: "/documents/demo", roots: true, limit: 55, scope: undefined },
    ])
  })

  test("preserves the unlimited compatibility fallback for global directories", async () => {
    const queries: Parameters<RootLoadArgs["list"]>[0][] = []
    const history = session("ses_history", "global", "/documents/demo", "历史标题")

    const result = await loadRootSessionsWithFallback({
      directory: "/documents/demo",
      limit: 55,
      list: async (query) => {
        queries.push(query)
        if (query.limit !== undefined) throw new Error("limit unsupported")
        return { data: query.scope === "project" ? [session("ses_other", "global", "/other", "其它")] : [history] }
      },
    })

    expect(result.data).toEqual([history])
    expect(result.limited).toBe(false)
    expect(queries).toEqual([
      { directory: "/documents/demo", roots: true, limit: 55, scope: "project" },
      { directory: "/documents/demo", roots: true, scope: "project" },
      { directory: "/documents/demo", roots: true, limit: 55, scope: undefined },
      { directory: "/documents/demo", roots: true, scope: undefined },
    ])
  })
})
