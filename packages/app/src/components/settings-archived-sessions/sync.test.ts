import { describe, expect, test } from "bun:test"
import { QueryClient } from "@tanstack/solid-query"
import { createStore } from "solid-js/store"
import { settleRemovalByEvent } from "@/context/global-sync/session-cache"
import type { Session } from "@opencode-ai/sdk/v2/client"
import {
  affectedArchiveDirectories,
  ARCHIVED_SESSIONS_AUTOMATION_IDS_QUERY_KEY,
  ARCHIVED_SESSIONS_LIST_QUERY_KEY,
  ensureUnarchivedSessionInSidebar,
  findSessionInStores,
  getSessionAcrossDirectories,
  isSessionNotFoundError,
  purgeSessionFromSidebar,
  removeSessionFromSidebar,
  mergeArchivedSessionIntoListCache,
  removeArchivedSessionFromListCache,
  requireArchivedSession,
  runArchiveInflight,
  sessionAfterUnarchive,
} from "./sync"

const session = (input: Partial<Session> & Pick<Session, "id" | "directory">): Session =>
  ({
    projectID: "proj_1",
    title: "Test",
    ...input,
    time: input.time ?? { created: 1, updated: 2 },
  }) as Session

describe("settings archived sessions sync", () => {
  test("affectedArchiveDirectories includes worktree and sandboxes", () => {
    const dirs = affectedArchiveDirectories(
      { directory: "/repo/sandbox", projectID: "proj_1" },
      [{ id: "proj_1", worktree: "/repo/main", sandboxes: ["/repo/sandbox", "/repo/sandbox-2"] }],
    )

    expect(dirs.sort()).toEqual(["/repo/main", "/repo/sandbox", "/repo/sandbox-2"].sort())
  })

  test("sessionAfterUnarchive clears archived and bumps updated", () => {
    const before = Date.now()
    const next = sessionAfterUnarchive(
      session({
        id: "ses_1",
        directory: "/repo",
        time: { created: 10, updated: 20, archived: 30 },
      }),
    )

    expect(next.time.archived).toBeUndefined()
    expect(next.time.updated).toBeGreaterThanOrEqual(before)
    expect(next.time.updated).toBeLessThanOrEqual(Date.now())
  })

  test("requireArchivedSession rejects missing archived time", () => {
    expect(() => requireArchivedSession(undefined)).toThrow("archive failed")
    expect(() => requireArchivedSession(session({ id: "ses_1", directory: "/repo" }))).toThrow("archive failed")
    expect(requireArchivedSession(session({ id: "ses_1", directory: "/repo", time: { created: 1, updated: 2, archived: 3 } })).time.archived).toBe(3)
  })

  test("findSessionInStores resolves sandbox session from project worktree hint", () => {
    const stores = new Map<string, { session: Session[] }>()
    const globalSync = {
      data: {
        project: [{ id: "proj_1", worktree: "/repo/main", sandboxes: ["/repo/sandbox"] }],
      },
      hasChild: (directory: string) => stores.has(directory),
      child: (directory: string) => {
        const store = stores.get(directory) ?? { session: [] }
        stores.set(directory, store)
        return [store, () => {}] as const
      },
      childDirectories: () => [...stores.keys()],
    }
    stores.set("/repo/sandbox", {
      session: [session({ id: "ses_sb", directory: "/repo/sandbox", time: { created: 1, updated: 2 } })],
    })

    expect(findSessionInStores(globalSync, "ses_sb", "/repo/main")?.directory).toBe("/repo/sandbox")
  })

  test("findSessionInStores ignores archived sessions", () => {
    const stores = new Map<string, { session: Session[] }>()
    const globalSync = {
      data: { project: [{ id: "proj_1", worktree: "/repo/main", sandboxes: [] }] },
      hasChild: (directory: string) => stores.has(directory),
      child: (directory: string) => {
        const store = stores.get(directory) ?? { session: [] }
        stores.set(directory, store)
        return [store, () => {}] as const
      },
      childDirectories: () => [...stores.keys()],
    }
    stores.set("/repo/main", {
      session: [session({ id: "ses_1", directory: "/repo/main", time: { created: 1, updated: 2, archived: 9 } })],
    })

    expect(findSessionInStores(globalSync, "ses_1", "/repo/main")).toBeUndefined()
  })

  test("getSessionAcrossDirectories prefers API over stale non-archived store copy", async () => {
    const stores = new Map<string, { session: Session[] }>()
    const globalSync = {
      data: { project: [{ id: "proj_1", worktree: "/repo/main", sandboxes: [] }] },
      hasChild: (directory: string) => stores.has(directory),
      child: (directory: string) => {
        const store = stores.get(directory) ?? { session: [] }
        stores.set(directory, store)
        return [store, () => {}] as const
      },
      childDirectories: () => [...stores.keys()],
    }
    stores.set("/repo/main", {
      session: [session({ id: "ses_1", directory: "/repo/main", time: { created: 1, updated: 2 } })],
    })

    const client = {
      session: {
        get: () =>
          Promise.resolve({
            data: session({
              id: "ses_1",
              directory: "/repo/main",
              time: { created: 1, updated: 2, archived: 99 },
            }),
          }),
      },
    } as unknown as import("@opencode-ai/sdk/v2/client").OpencodeClient

    const result = await getSessionAcrossDirectories(client, globalSync, "ses_1", "/repo/main")
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.session.time.archived).toBe(99)
  })

  test("getSessionAcrossDirectories falls back to local store after API miss", async () => {
    const stores = new Map<string, { session: Session[] }>()
    const globalSync = {
      data: { project: [{ id: "proj_1", worktree: "/repo/main", sandboxes: [] }] },
      hasChild: (directory: string) => stores.has(directory),
      child: (directory: string) => {
        const store = stores.get(directory) ?? { session: [] }
        stores.set(directory, store)
        return [store, () => {}] as const
      },
      childDirectories: () => [...stores.keys()],
    }
    const local = session({ id: "ses_new", directory: "/repo/main", time: { created: 1, updated: 2 } })
    stores.set("/repo/main", { session: [local] })

    const client = {
      session: {
        get: () => Promise.reject(new Error("not found")),
      },
    } as unknown as import("@opencode-ai/sdk/v2/client").OpencodeClient

    const result = await getSessionAcrossDirectories(client, globalSync, "ses_new", "/repo/main")
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.session.id).toBe("ses_new")
  })

  test("getSessionAcrossDirectories tries candidate directories after store miss", async () => {
    const calls: string[] = []
    const client = {
      session: {
        get: ({ directory }: { sessionID: string; directory: string }) => {
          calls.push(directory)
          if (directory === "/repo/sandbox") {
            return Promise.resolve({
              data: session({ id: "ses_sb", directory: "/repo/sandbox", time: { created: 1, updated: 2, archived: 9 } }),
            })
          }
          return Promise.reject(new Error("not found"))
        },
      },
    } as unknown as import("@opencode-ai/sdk/v2/client").OpencodeClient

    const globalSync = {
      data: { project: [{ id: "proj_1", worktree: "/repo/main", sandboxes: ["/repo/sandbox"] }] },
      hasChild: () => false,
      child: () => [{ session: [] }, () => {}] as const,
      childDirectories: () => [] as string[],
    }

    const result = await getSessionAcrossDirectories(client, globalSync, "ses_sb", "/repo/main")
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.session.directory).toBe("/repo/sandbox")
    expect(calls.sort()).toEqual(["/repo/main", "/repo/sandbox"].sort())
  })

  test("getSessionAcrossDirectories includes extraDirectories for unbootstrapped projects", async () => {
    const calls: string[] = []
    const client = {
      session: {
        get: ({ directory }: { sessionID: string; directory: string }) => {
          calls.push(directory)
          if (directory === "/repo/unbootstrapped") {
            return Promise.resolve({
              data: session({
                id: "ses_remote",
                directory: "/repo/unbootstrapped",
                time: { created: 1, updated: 2, archived: 9 },
              }),
            })
          }
          return Promise.reject(new Error("not found"))
        },
      },
    } as unknown as import("@opencode-ai/sdk/v2/client").OpencodeClient

    const globalSync = {
      data: { project: [] as { id?: string; worktree: string; sandboxes?: string[] }[] },
      hasChild: () => false,
      child: () => [{ session: [] }, () => {}] as const,
      childDirectories: () => [] as string[],
    }

    const result = await getSessionAcrossDirectories(client, globalSync, "ses_remote", "/repo/main", {
      extraDirectories: ["/repo/unbootstrapped"],
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.session.directory).toBe("/repo/unbootstrapped")
    expect(calls).toContain("/repo/unbootstrapped")
  })

  test("getSessionAcrossDirectories reports unavailable on non-not-found errors", async () => {
    const client = {
      session: {
        get: () => Promise.reject(new Error("network down")),
      },
    } as unknown as import("@opencode-ai/sdk/v2/client").OpencodeClient

    const globalSync = {
      data: { project: [{ id: "proj_1", worktree: "/repo/main", sandboxes: [] }] },
      hasChild: () => false,
      child: () => [{ session: [] }, () => {}] as const,
      childDirectories: () => [] as string[],
    }

    const result = await getSessionAcrossDirectories(client, globalSync, "ses_1", "/repo/main")
    expect(result).toEqual({ ok: false, reason: "unavailable" })
  })

  test("ensureUnarchivedSessionInSidebar inserts when refresh trimmed session out", () => {
    const stores = new Map<string, { session: Session[] }>()
    const globalSync = {
      data: {
        project: [{ id: "proj_1", worktree: "/repo/main", sandboxes: ["/repo/sandbox"] }],
      },
      child: (directory: string) => {
        const store = stores.get(directory) ?? { session: [] }
        stores.set(directory, store)
        const setStore = (recipe: (draft: { session: Session[] }) => void) => {
          recipe(store)
        }
        return [store, setStore] as const
      },
    }

    const archived = session({
      id: "ses_old",
      directory: "/repo/sandbox",
      time: { created: 1, updated: 1, archived: 99 },
    })

    ensureUnarchivedSessionInSidebar(globalSync, archived)

    expect(stores.get("/repo/sandbox")?.session.map((item) => item.id)).toEqual(["ses_old"])
    expect(stores.get("/repo/main")?.session.map((item) => item.id)).toEqual(["ses_old"])
    expect(stores.get("/repo/sandbox")?.session[0]?.time.archived).toBeUndefined()
    expect(stores.get("/repo/sandbox")?.session[0]?.time.updated).toBeGreaterThanOrEqual(1)
  })

  test("runArchiveInflight deduplicates concurrent archive calls", async () => {
    let runs = 0
    const first = runArchiveInflight("ses_1", async () => {
      runs++
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
    const second = runArchiveInflight("ses_1", async () => {
      runs++
    })

    await Promise.all([first, second])
    expect(runs).toBe(1)
  })

  test("mergeArchivedSessionIntoListCache prepends archived session", () => {
    const queryClient = new QueryClient()
    const existing = session({ id: "ses_old", directory: "/repo", time: { created: 1, updated: 2, archived: 10 } })
    queryClient.setQueryData([...ARCHIVED_SESSIONS_LIST_QUERY_KEY, ""], { sessions: [existing], truncated: false })

    const archived = session({ id: "ses_new", directory: "/repo", time: { created: 3, updated: 4, archived: 99 } })
    mergeArchivedSessionIntoListCache(queryClient, archived)

    const data = queryClient.getQueryData<{ sessions: Session[] }>([...ARCHIVED_SESSIONS_LIST_QUERY_KEY, ""])
    expect(data?.sessions.map((item) => item.id)).toEqual(["ses_new", "ses_old"])
  })

  test("mergeArchivedSessionIntoListCache does not touch searched list cache", () => {
    const queryClient = new QueryClient()
    const searched = session({ id: "ses_old", directory: "/repo", time: { created: 1, updated: 2, archived: 10 } })
    queryClient.setQueryData([...ARCHIVED_SESSIONS_LIST_QUERY_KEY, "alpha"], { sessions: [searched], truncated: false })

    const archived = session({ id: "ses_new", directory: "/repo", time: { created: 3, updated: 4, archived: 99 } })
    mergeArchivedSessionIntoListCache(queryClient, archived)

    const data = queryClient.getQueryData<{ sessions: Session[] }>([...ARCHIVED_SESSIONS_LIST_QUERY_KEY, "alpha"])
    expect(data?.sessions.map((item) => item.id)).toEqual(["ses_old"])
  })

  test("ensureUnarchivedSessionInSidebar inserts by session id order", () => {
    const stores = new Map<string, { session: Session[] }>()
    const globalSync = {
      data: { project: [] as { id?: string; worktree: string; sandboxes?: string[] }[] },
      child: (directory: string) => {
        const store = stores.get(directory) ?? { session: [{ id: "ses_b", directory, time: { created: 1, updated: 2 } } as Session] }
        stores.set(directory, store)
        const setStore = (recipe: (draft: { session: Session[] }) => void) => {
          recipe(store)
        }
        return [store, setStore] as const
      },
    }

    ensureUnarchivedSessionInSidebar(
      globalSync,
      session({
        id: "ses_a",
        directory: "/repo",
        time: { created: 1, updated: 1, archived: 99 },
      }),
    )

    expect(stores.get("/repo")?.session.map((item) => item.id)).toEqual(["ses_a", "ses_b"])
  })

  test("removeArchivedSessionFromListCache drops session from cache", () => {
    const queryClient = new QueryClient()
    const first = session({ id: "ses_1", directory: "/repo", time: { created: 1, updated: 2, archived: 10 } })
    const second = session({ id: "ses_2", directory: "/repo", time: { created: 3, updated: 4, archived: 11 } })
    queryClient.setQueryData([...ARCHIVED_SESSIONS_LIST_QUERY_KEY, ""], { sessions: [first, second], truncated: false })

    removeArchivedSessionFromListCache(queryClient, "ses_1")

    const data = queryClient.getQueryData<{ sessions: Session[] }>([...ARCHIVED_SESSIONS_LIST_QUERY_KEY, ""])
    expect(data?.sessions.map((item) => item.id)).toEqual(["ses_2"])
  })

  test("mergeArchivedSessionIntoListCache does not touch automation-ids query", () => {
    const queryClient = new QueryClient()
    const automation = new Set(["ses_auto"])
    queryClient.setQueryData(ARCHIVED_SESSIONS_AUTOMATION_IDS_QUERY_KEY, automation)

    const archived = session({ id: "ses_new", directory: "/repo", time: { created: 3, updated: 4, archived: 99 } })
    mergeArchivedSessionIntoListCache(queryClient, archived)

    expect(queryClient.getQueryData<Set<string>>(ARCHIVED_SESSIONS_AUTOMATION_IDS_QUERY_KEY)).toBe(automation)
  })

  test("removeArchivedSessionFromListCache does not touch automation-ids query", () => {
    const queryClient = new QueryClient()
    const automation = new Set(["ses_auto"])
    queryClient.setQueryData(ARCHIVED_SESSIONS_AUTOMATION_IDS_QUERY_KEY, automation)

    removeArchivedSessionFromListCache(queryClient, "ses_missing")

    expect(queryClient.getQueryData<Set<string>>(ARCHIVED_SESSIONS_AUTOMATION_IDS_QUERY_KEY)).toBe(automation)
  })

  test("invalidateArchivedSessionsList only invalidates list queries", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const automation = new Set(["ses_auto"])
    queryClient.setQueryData(ARCHIVED_SESSIONS_AUTOMATION_IDS_QUERY_KEY, automation)
    queryClient.setQueryData(ARCHIVED_SESSIONS_LIST_QUERY_KEY, { sessions: [], truncated: false })

    const { invalidateArchivedSessionsList } = await import("./sync")
    invalidateArchivedSessionsList(queryClient)

    expect(queryClient.getQueryData<Set<string>>(ARCHIVED_SESSIONS_AUTOMATION_IDS_QUERY_KEY)).toBe(automation)
  })
})

describe("isSessionNotFoundError", () => {
  test("recognizes SDK throwOnError 404 shape (plain object, not Error)", () => {
    expect(isSessionNotFoundError({ name: "NotFoundError", data: { message: "Session not found" } })).toBe(true)
  })

  test("keeps recognizing legacy shapes", () => {
    expect(isSessionNotFoundError({ name: "SessionNotFoundError" })).toBe(true)
    expect(isSessionNotFoundError({ name: "StorageNotFoundError" })).toBe(true)
    expect(isSessionNotFoundError({ response: { status: 404 } })).toBe(true)
    expect(isSessionNotFoundError(new Error("session not found"))).toBe(true)
  })

  test("rejects non-404 errors", () => {
    expect(isSessionNotFoundError(new Error("network down"))).toBe(false)
    expect(isSessionNotFoundError({ name: "ForbiddenError" })).toBe(false)
    expect(isSessionNotFoundError(undefined)).toBe(false)
  })
})

describe("purgeSessionFromSidebar vs removeSessionFromSidebar", () => {
  const makeStore = () =>
    createStore({
      session: [session({ id: "ses_1", directory: "/repo/main", projectID: "proj_1", time: { created: 1, updated: 2 } })],
      sessionTotal: 2,
      message: { ses_1: [] as unknown[] },
      part: {},
      todo: { ses_1: [] as unknown[] },
      session_diff: { ses_1: [] as unknown[] },
      session_suggestion: {},
      session_status: {},
      permission: {},
      question: {},
    })
  const makeGlobalSync = (pair: readonly [unknown, unknown]) => ({
    data: { project: [{ id: "proj_1", worktree: "/repo/main", sandboxes: [] }] },
    child: () => pair,
  })

  test("remove keeps optimistic semantics: splice only, total and caches untouched", () => {
    const [store, setStore] = makeStore()
    removeSessionFromSidebar(makeGlobalSync([store, setStore]), {
      id: "ses_1",
      directory: "/repo/main",
      projectID: "proj_1",
    })
    expect(store.session.length).toBe(0)
    expect(store.sessionTotal).toBe(2)
    expect(store.message.ses_1).toBeDefined()
  })

  test("purge decrements root total, drops derived caches and tombstones for SSE dedupe", () => {
    const [store, setStore] = makeStore()
    const removed = purgeSessionFromSidebar(makeGlobalSync([store, setStore]), {
      id: "ses_1",
      directory: "/repo/main",
      projectID: "proj_1",
    })
    expect(removed.length).toBe(1)
    expect(store.session.length).toBe(0)
    expect(store.sessionTotal).toBe(1)
    expect(store.message.ses_1).toBeUndefined()
    expect(store.todo.ses_1).toBeUndefined()
    expect(store.session_diff.ses_1).toBeUndefined()
    // 本地结算标记已按 removed dir 打上：后到的 SSE 应跳过递减（消费一次即失效）
    expect(settleRemovalByEvent(removed[0]!.dir, "ses_1")).toBe(false)
    // 标记已被消费：再来一个事件（异常重放）恢复正常递减语义
    expect(settleRemovalByEvent(removed[0]!.dir, "ses_1")).toBe(true)
  })
})
