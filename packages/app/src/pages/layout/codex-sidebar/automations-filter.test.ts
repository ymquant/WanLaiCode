import { describe, expect, test } from "bun:test"
import type { Session } from "@opencode-ai/sdk/v2/client"
import { filterAutomationSessions, orphanAutomationDirectories, projectDirectories } from "./automations-filter"

const GLOBAL = "/u/jiun/Library/Application Support/ai.wanlaicode.desktop/wanlaicode/automation/global"
const PROJECT = "/u/jiun/workspace/real-project"
const SANDBOX = "/u/jiun/workspace/real-project-worktrees/feature-x"

const session = (
  id: string,
  overrides: Partial<{ directory: string; parentID: string; archived: number; updated: number }> = {},
): Session =>
  ({
    id,
    slug: id,
    projectID: "p",
    directory: overrides.directory ?? GLOBAL,
    title: id,
    version: "1",
    time: {
      created: overrides.updated ?? 1,
      updated: overrides.updated ?? 1,
      ...(overrides.archived !== undefined ? { archived: overrides.archived } : {}),
    },
    ...(overrides.parentID ? { parentID: overrides.parentID } : {}),
  }) as unknown as Session

describe("projectDirectories", () => {
  test("同时收下主 worktree 与 sandboxes", () => {
    expect(projectDirectories([{ worktree: PROJECT, sandboxes: [SANDBOX] }, { worktree: "/u/other" }])).toEqual([
      PROJECT,
      SANDBOX,
      "/u/other",
    ])
  })
})

describe("orphanAutomationDirectories", () => {
  test("只留下不属于任何已注册项目的自动化目录", () => {
    const dirs = orphanAutomationDirectories(
      [{ directory: GLOBAL }, { directory: PROJECT }, { directory: GLOBAL }, { directory: null }],
      [PROJECT],
    )
    expect(dirs).toEqual([GLOBAL])
  })

  test("路径分隔符/末尾斜杠差异不会让已注册项目漏判", () => {
    expect(orphanAutomationDirectories([{ directory: PROJECT + "/" }], [PROJECT])).toEqual([])
  })

  test("没有自动化时返回空数组", () => {
    expect(orphanAutomationDirectories([], [PROJECT])).toEqual([])
  })

  // 绑定在项目 sandbox（git worktree fork 出的子目录）下的自动化，其会话已经由
  // 项目区按 rootsForProject 展示，不能再被当成孤儿目录在「自动化」区重复显示一遍
  test("项目 sandbox 目录不算孤儿目录", () => {
    expect(orphanAutomationDirectories([{ directory: SANDBOX }], [PROJECT, SANDBOX])).toEqual([])
  })
})

describe("filterAutomationSessions", () => {
  test("只保留该目录下、确由自动化运行产生的会话，按更新时间降序", () => {
    const list = [
      session("old", { updated: 10 }),
      session("new", { updated: 30 }),
      session("mid", { updated: 20 }),
      session("manual-chat", { updated: 40 }),
      session("elsewhere", { directory: PROJECT, updated: 50 }),
    ]
    const runIDs = new Set(["old", "new", "mid", "elsewhere"])
    expect(filterAutomationSessions(list, GLOBAL, runIDs, new Set()).map((s) => s.id)).toEqual(["new", "mid", "old"])
  })

  test("排除已归档与 fork 子会话", () => {
    const list = [
      session("archived", { updated: 30, archived: 5 }),
      session("child", { updated: 20, parentID: "root" }),
      session("keep", { updated: 10 }),
    ]
    const runIDs = new Set(["archived", "child", "keep"])
    expect(filterAutomationSessions(list, GLOBAL, runIDs, new Set()).map((s) => s.id)).toEqual(["keep"])
  })

  // 已置顶的会话由「置顶」区单独展示，这里必须让位，否则同一会话在侧栏出现两次
  test("排除已置顶的会话", () => {
    const list = [session("pinned", { updated: 30 }), session("plain", { updated: 20 })]
    const runIDs = new Set(["pinned", "plain"])
    expect(filterAutomationSessions(list, GLOBAL, runIDs, new Set(["pinned"])).map((s) => s.id)).toEqual(["plain"])
  })
})
