import { describe, expect, test } from "bun:test"
import type { Session } from "@opencode-ai/sdk/v2/client"
import { filterScratchSessions } from "./chats-filter"

const SCRATCH = "/u/jiun/scratch-sessions"
const OTHER = "/u/jiun/workspace/real-project"

// 构造最小 Session：只填本测试关心的字段，其它用 unknown 转换跳过类型噪声。
const session = (
  id: string,
  overrides: Partial<{
    directory: string
    parentID: string
    archived: number
    updated: number
    created: number
  }> = {},
): Session => {
  const created = overrides.created ?? 1
  const updated = overrides.updated ?? created
  return {
    id,
    slug: id,
    projectID: "p",
    directory: overrides.directory ?? SCRATCH,
    title: id,
    version: "1",
    time: {
      created,
      updated,
      ...(overrides.archived !== undefined ? { archived: overrides.archived } : {}),
    },
    ...(overrides.parentID ? { parentID: overrides.parentID } : {}),
  } as unknown as Session
}

describe("filterScratchSessions", () => {
  test("过滤掉 directory 不等于 scratch 目录的 session（核心 bug 防回归）", () => {
    const list = [
      session("a", { directory: SCRATCH }),
      session("b", { directory: OTHER }),
      session("c", { directory: SCRATCH }),
    ]
    const result = filterScratchSessions(list, SCRATCH, new Set())
    expect(result.map((s) => s.id)).toEqual(["a", "c"])
  })

  test("目录归一化兼容尾斜杠 / 等价路径", () => {
    const list = [
      session("a", { directory: `${SCRATCH}/` }),
      session("b", { directory: SCRATCH }),
    ]
    const result = filterScratchSessions(list, `${SCRATCH}/`, new Set())
    expect(result.map((s) => s.id)).toEqual(["a", "b"])
  })

  test("过滤掉 parentID（fork 出来的子 session）", () => {
    const list = [
      session("root"),
      session("child", { parentID: "root" }),
    ]
    const result = filterScratchSessions(list, SCRATCH, new Set())
    expect(result.map((s) => s.id)).toEqual(["root"])
  })

  test("过滤掉已归档", () => {
    const list = [
      session("live"),
      session("archived", { archived: 12345 }),
    ]
    const result = filterScratchSessions(list, SCRATCH, new Set())
    expect(result.map((s) => s.id)).toEqual(["live"])
  })

  test("过滤掉已置顶（pinnedIds）", () => {
    const list = [session("a"), session("pinned"), session("b")]
    const result = filterScratchSessions(list, SCRATCH, new Set(["pinned"]))
    expect(result.map((s) => s.id)).toEqual(["a", "b"])
  })

  test("按 time.updated 降序排（无 updated 时回退 created）", () => {
    const list = [
      session("oldest", { created: 1, updated: 1 }),
      session("newest", { created: 5, updated: 100 }),
      session("middle", { created: 50 }),
    ]
    const result = filterScratchSessions(list, SCRATCH, new Set())
    expect(result.map((s) => s.id)).toEqual(["newest", "middle", "oldest"])
  })

  test("sortBy created 按创建时间排序", () => {
    const list = [
      session("old-updated", { created: 1, updated: 100 }),
      session("new-created", { created: 50, updated: 2 }),
    ]
    const result = filterScratchSessions(list, SCRATCH, new Set(), "created")
    expect(result.map((s) => s.id)).toEqual(["new-created", "old-updated"])
  })

  test("空列表 / 空 pinned 不报错", () => {
    expect(filterScratchSessions([], SCRATCH, new Set())).toEqual([])
  })
})
