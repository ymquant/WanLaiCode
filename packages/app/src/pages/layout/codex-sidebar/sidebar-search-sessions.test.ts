import { describe, expect, test } from "bun:test"
import type { Session } from "@opencode-ai/sdk/v2/client"
import type { LocalProject } from "@/context/layout"
import { collectSidebarSearchHits, findProjectForSessionDirectory } from "./sidebar-search-sessions"

const WORKTREE = "/repo/main"
const SANDBOX = "/repo/sandbox"
const SCRATCH = "/u/me/scratch-sessions"

const session = (
  id: string,
  overrides: Partial<{
    directory: string
    parentID: string
    archived: number
    updated: number
    created: number
  }> = {},
): Session =>
  ({
    id,
    slug: id,
    projectID: "p",
    directory: overrides.directory ?? WORKTREE,
    title: id,
    version: "1",
    time: {
      created: overrides.created ?? 1,
      updated: overrides.updated ?? overrides.created ?? 1,
      ...(overrides.archived !== undefined ? { archived: overrides.archived } : {}),
    },
    ...(overrides.parentID ? { parentID: overrides.parentID } : {}),
  }) as unknown as Session

const project = (worktree: string, sandboxes?: string[]): LocalProject =>
  ({
    worktree,
    sandboxes,
  }) as LocalProject

describe("collectSidebarSearchHits", () => {
  test("项目会话只从 worktree store 收集，不因遍历 sandbox store 重复", () => {
    const shared = session("dup", { directory: SANDBOX, updated: 100 })
    const hits = collectSidebarSearchHits({
      projects: [project(WORKTREE, [SANDBOX])],
      scratchLabel: "对话",
      getProjectStore: (dir) => ({
        session: dir === WORKTREE ? [shared] : [shared, session("ghost", { directory: SANDBOX })],
      }),
      sortBy: "updated",
    })

    expect(hits.map((hit) => hit.session.id)).toEqual(["dup"])
  })

  test("排除归档与子 session", () => {
    const hits = collectSidebarSearchHits({
      projects: [project(WORKTREE)],
      scratchLabel: "对话",
      getProjectStore: () => ({
        session: [
          session("live"),
          session("archived", { archived: 10 }),
          session("child", { parentID: "live" }),
        ],
      }),
      sortBy: "updated",
    })

    expect(hits.map((hit) => hit.session.id)).toEqual(["live"])
  })

  test("包含 scratch 散对话且过滤掉 directory 不属于 scratch 的条目", () => {
    const hits = collectSidebarSearchHits({
      projects: [],
      scratchChatDir: SCRATCH,
      scratchLabel: "对话",
      getProjectStore: () => ({ session: [] }),
      getScratchStore: () => ({
        session: [session("scratch", { directory: SCRATCH, updated: 20 }), session("other", { directory: WORKTREE })],
      }),
      sortBy: "updated",
    })

    expect(hits).toEqual([
      {
        session: expect.objectContaining({ id: "scratch" }),
        directory: SCRATCH,
        projectName: "对话",
      },
    ])
  })

  test("隐藏 scratch 伪项目，只保留真实项目名", () => {
    const hits = collectSidebarSearchHits({
      projects: [project(SCRATCH), project(WORKTREE)],
      scratchChatDir: SCRATCH,
      scratchLabel: "对话",
      getProjectStore: (dir) => ({
        session: dir === WORKTREE ? [session("proj", { directory: WORKTREE })] : [session("hidden", { directory: SCRATCH })],
      }),
      getScratchStore: () => ({ session: [session("scratch", { directory: SCRATCH })] }),
      sortBy: "updated",
    })

    expect(hits.map((hit) => [hit.session.id, hit.projectName])).toEqual([
      ["proj", "main"],
      ["scratch", "对话"],
    ])
  })
})

describe("findProjectForSessionDirectory", () => {
  test("pathKey 归一化匹配 worktree 与 sandbox", () => {
    const projects = [project(WORKTREE, [SANDBOX])]
    expect(findProjectForSessionDirectory(projects, `${WORKTREE}/`)).toBe(projects[0])
    expect(findProjectForSessionDirectory(projects, SANDBOX)).toBe(projects[0])
  })

  test("scratch 目录不匹配任何项目", () => {
    const projects = [project(WORKTREE)]
    expect(findProjectForSessionDirectory(projects, SCRATCH, SCRATCH)).toBeUndefined()
  })

  test("忽略 scratch 伪项目条目", () => {
    const scratchProject = project(SCRATCH)
    const realProject = project(WORKTREE)
    expect(findProjectForSessionDirectory([scratchProject, realProject], WORKTREE, SCRATCH)).toBe(realProject)
  })
})
