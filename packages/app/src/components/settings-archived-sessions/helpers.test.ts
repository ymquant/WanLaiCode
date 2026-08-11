import { describe, expect, test } from "bun:test"
import type { GlobalSession } from "@opencode-ai/sdk/v2/client"
import {
  buildArchivedProjectOptions,
  buildProjectDirectoryIndex,
  filterArchivedSessions,
  groupArchivedSessions,
  isArchivedSession,
  isCloudArchivedSession,
  resolveArchivedSessionProject,
  sortArchivedSessions,
  type ProjectCatalogEntry,
} from "./helpers"

const session = (input: {
  id: string
  title: string
  directory: string
  worktree?: string
  name?: string
  archived?: number
  created?: number
  updated?: number
  parentID?: string
  projectID?: string
  workspaceID?: string
}): GlobalSession =>
  ({
    id: input.id,
    slug: input.id,
    projectID: input.projectID ?? "proj",
    directory: input.directory,
    title: input.title,
    version: "1",
    time: {
      created: input.created ?? 1,
      updated: input.updated ?? 1,
      archived: input.archived,
    },
    parentID: input.parentID,
    workspaceID: input.workspaceID,
    project: input.worktree
      ? {
          id: input.projectID ?? "proj",
          worktree: input.worktree,
          name: input.name,
        }
      : null,
  }) as GlobalSession

const catalog = (entries: ProjectCatalogEntry[]) => buildProjectDirectoryIndex(entries)

describe("settings archived sessions helpers", () => {
  test("isCloudArchivedSession requires a non-empty workspace id", () => {
    expect(isCloudArchivedSession(session({ id: "local", title: "Local", directory: "/a", archived: 1 }))).toBe(false)
    expect(
      isCloudArchivedSession(
        session({ id: "cloud", title: "Cloud", directory: "/a", archived: 1, workspaceID: "wrk_1" }),
      ),
    ).toBe(true)
    expect(
      isCloudArchivedSession(
        session({ id: "empty", title: "Empty", directory: "/a", archived: 1, workspaceID: "" }),
      ),
    ).toBe(false)
  })

  test("isArchivedSession includes root and child archived sessions", () => {
    expect(isArchivedSession(session({ id: "a", title: "A", directory: "/a", archived: 10 }))).toBe(true)
    expect(isArchivedSession(session({ id: "b", title: "B", directory: "/b" }))).toBe(false)
    expect(isArchivedSession(session({ id: "c", title: "C", directory: "/c", archived: 10, parentID: "a" }))).toBe(
      true,
    )
  })

  test("filterArchivedSessions includes archived child sessions", () => {
    const index = catalog([{ worktree: "/repo/a", name: "Repo" }])
    const sessions = [
      session({ id: "root", title: "Root", directory: "/repo/a", worktree: "/repo/a", archived: 1 }),
      session({
        id: "child",
        title: "Child session",
        directory: "/repo/a",
        worktree: "/repo/a",
        archived: 2,
        parentID: "root",
      }),
    ]

    expect(
      filterArchivedSessions({
        sessions,
        index,
        automationIds: new Set(),
        type: "all",
        project: "all",
        search: "",
      }).map((s) => s.id),
    ).toEqual(["root", "child"])
  })

  test("resolveArchivedSessionProject maps sandbox directories to root project", () => {
    const index = catalog([
      { worktree: "/repo/wanlaicodex", name: "wanlaicodex", sandboxes: ["/repo/wanlaicodex-sandbox"] },
    ])

    expect(
      resolveArchivedSessionProject(
        session({
          id: "1",
          title: "Forked",
          directory: "/repo/wanlaicodex-sandbox",
          archived: 1,
        }),
        index,
      ),
    ).toEqual({
      worktree: "/repo/wanlaicodex",
      name: "wanlaicodex",
      isScratch: false,
    })
  })

  test("buildArchivedProjectOptions scopes projects by archived session type", () => {
    const scratch = "/u/scratch-sessions"
    const index = catalog([
      { worktree: "/repo/local-only", name: "LocalOnly" },
      { worktree: "/repo/mixed", name: "Mixed" },
    ])
    const sessions = [
      session({
        id: "local-project",
        title: "Local project chat",
        directory: "/repo/local-only",
        worktree: "/repo/local-only",
        name: "LocalOnly",
        archived: 1,
      }),
      session({
        id: "cloud-project",
        title: "Cloud project chat",
        directory: "/repo/mixed",
        worktree: "/repo/mixed",
        name: "Mixed",
        archived: 2,
        workspaceID: "wrk_cloud",
      }),
      session({
        id: "local-mixed",
        title: "Local mixed chat",
        directory: "/repo/mixed",
        worktree: "/repo/mixed",
        name: "Mixed",
        archived: 3,
      }),
    ]

    expect(
      buildArchivedProjectOptions({
        sessions,
        index,
        scratchDir: scratch,
        type: "cloud",
      }).map((item) => item.worktree),
    ).toEqual(["/repo/mixed"])

    expect(
      buildArchivedProjectOptions({
        sessions,
        index,
        scratchDir: scratch,
        type: "local",
      }).map((item) => item.worktree),
    ).toEqual(["/repo/local-only", "/repo/mixed"])
  })

  test("filterArchivedSessions applies type, project, and search filters", () => {
    const scratch = "/u/scratch-sessions"
    const index = catalog([{ worktree: "/repo/a", name: "Repo" }])
    const sessions = [
      session({ id: "1", title: "Local chat", directory: scratch, archived: 1 }),
      session({
        id: "2",
        title: "Project chat",
        directory: "/repo/a",
        worktree: "/repo/a",
        name: "Repo",
        archived: 2,
      }),
      session({
        id: "4",
        title: "Cloud chat",
        directory: "/repo/a",
        worktree: "/repo/a",
        name: "Repo",
        archived: 4,
        workspaceID: "wrk_cloud",
      }),
      session({ id: "3", title: "Auto", directory: "/repo/a", worktree: "/repo/a", archived: 3, workspaceID: "wrk_cloud" }),
    ]

    expect(
      filterArchivedSessions({
        sessions,
        index,
        scratchDir: scratch,
        automationIds: new Set(["3"]),
        type: "local",
        project: "all",
        search: "",
      }).map((s) => s.id),
    ).toEqual(["1", "2"])

    expect(
      filterArchivedSessions({
        sessions,
        index,
        scratchDir: scratch,
        automationIds: new Set(["3"]),
        type: "cloud",
        project: "automations",
        search: "",
      }).map((s) => s.id),
    ).toEqual(["3"])

    expect(
      filterArchivedSessions({
        sessions,
        index,
        scratchDir: scratch,
        automationIds: new Set(["3"]),
        type: "cloud",
        project: "all",
        search: "",
      }).map((s) => s.id),
    ).toEqual(["4", "3"])

    expect(
      filterArchivedSessions({
        sessions,
        index,
        scratchDir: scratch,
        automationIds: new Set(["3"]),
        type: "all",
        project: { worktree: "/repo/a" },
        search: "project",
      }).map((s) => s.id),
    ).toEqual(["2"])
  })

  test("filterArchivedSessions matches title even when project name does not", () => {
    const index = catalog([{ worktree: "/repo/a", name: "test222" }])
    const sessions = [
      session({
        id: "title-hit",
        title: "始终使用简体中文",
        directory: "/repo/a",
        worktree: "/repo/a",
        archived: 1,
      }),
    ]

    expect(
      filterArchivedSessions({
        sessions,
        index,
        automationIds: new Set(),
        type: "all",
        project: "all",
        search: "简体中文",
      }).map((s) => s.id),
    ).toEqual(["title-hit"])
  })

  test("filterArchivedSessions matches project name when title does not", () => {
    const index = catalog([
      { worktree: "/repo/a", name: "AlphaProject" },
      { worktree: "/repo/b", name: "BetaProject" },
    ])
    const sessions = [
      session({ id: "title-only", title: "beta chat", directory: "/repo/b", worktree: "/repo/b", archived: 1 }),
      session({ id: "project-hit", title: "other", directory: "/repo/a", worktree: "/repo/a", archived: 2 }),
    ]

    expect(
      filterArchivedSessions({
        sessions,
        index,
        automationIds: new Set(),
        type: "all",
        project: "all",
        search: "alpha",
      }).map((s) => s.id),
    ).toEqual(["project-hit"])
  })

  test("filterArchivedSessions matches directory and worktree paths", () => {
    const index = catalog([{ worktree: "/repo/wanlaicodex", name: "wanlaicodex", sandboxes: ["/repo/wanlaicodex-sandbox"] }])
    const sessions = [
      session({
        id: "sandbox-hit",
        title: "chat",
        directory: "/repo/wanlaicodex-sandbox",
        archived: 1,
      }),
    ]

    expect(
      filterArchivedSessions({
        sessions,
        index,
        automationIds: new Set(),
        type: "all",
        project: "all",
        search: "wanlaicodex-sandbox",
      }).map((s) => s.id),
    ).toEqual(["sandbox-hit"])
  })

  test("sortArchivedSessions supports updated, created, and alpha", () => {
    const sessions = [
      session({ id: "a", title: "Beta", directory: "/a", archived: 30, created: 10, updated: 20 }),
      session({ id: "b", title: "Alpha", directory: "/b", archived: 10, created: 30, updated: 40 }),
      session({ id: "c", title: "Gamma", directory: "/c", archived: 20, created: 20, updated: 30 }),
    ]

    expect(sortArchivedSessions(sessions, "updated").map((s) => s.id)).toEqual(["a", "c", "b"])
    expect(sortArchivedSessions(sessions, "created").map((s) => s.id)).toEqual(["b", "c", "a"])
    expect(sortArchivedSessions(sessions, "alpha").map((s) => s.id)).toEqual(["b", "a", "c"])
  })

  test("groupArchivedSessions groups by resolved project and sorts sessions inside group", () => {
    const index = catalog([{ worktree: "/repo/a", name: "wanlaicodex", sandboxes: ["/repo/a-sb"] }])
    const groups = groupArchivedSessions(
      [
        session({ id: "1", title: "One", directory: "/repo/a", archived: 10 }),
        session({ id: "2", title: "Two", directory: "/repo/a-sb", archived: 30 }),
        session({ id: "3", title: "Three", directory: "/repo/b", archived: 3 }),
      ],
      { index, sort: "updated" },
    )

    expect(groups).toHaveLength(2)
    expect(groups[0]?.name).toBe("b")
    expect(groups[1]?.name).toBe("wanlaicodex")
    expect(groups[1]?.sessions.map((s) => s.id)).toEqual(["2", "1"])
    expect(groups[1]?.sessions).toHaveLength(2)
  })
})
