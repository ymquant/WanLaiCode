import { describe, expect, test } from "bun:test"
import type { LocalProject } from "@/context/layout"
import { partitionPinnedProjects } from "./pin"

const project = (worktree: string): LocalProject => ({ worktree, expanded: false }) as LocalProject

const run = (worktrees: string[], pinned: string[], scratchDir?: string) =>
  partitionPinnedProjects({ projects: worktrees.map(project), pinned, scratchDir })

const names = (projects: LocalProject[]) => projects.map((p) => p.worktree)

describe("partitionPinnedProjects", () => {
  test("置顶项目进 pinned，其余留 rest", () => {
    const result = run(["/a", "/b", "/c"], ["/c"])
    expect(names(result.pinned)).toEqual(["/c"])
    expect(names(result.rest)).toEqual(["/a", "/b"])
  })

  test("无 pinned 时 rest 保持原顺序", () => {
    const result = run(["/a", "/b"], [])
    expect(names(result.pinned)).toEqual([])
    expect(names(result.rest)).toEqual(["/a", "/b"])
  })

  test("多个 pinned 按 pinned 数组顺序，而非项目列表顺序", () => {
    const result = run(["/a", "/b", "/c"], ["/c", "/a"])
    expect(names(result.pinned)).toEqual(["/c", "/a"])
    expect(names(result.rest)).toEqual(["/b"])
  })

  test("pinned 里已不存在的项目被丢弃，不产生空洞", () => {
    const result = run(["/a", "/b"], ["/x", "/a"])
    expect(names(result.pinned)).toEqual(["/a"])
    expect(names(result.rest)).toEqual(["/b"])
  })

  test("pinned 重复项只渲染一次", () => {
    const result = run(["/a", "/b"], ["/a", "/a"])
    expect(names(result.pinned)).toEqual(["/a"])
    expect(names(result.rest)).toEqual(["/b"])
  })

  test("散对话隐藏项目两侧都不出现", () => {
    const result = run(["/a", "/tmp/scratch-sessions", "/b"], ["/tmp/scratch-sessions", "/b"])
    expect(names(result.pinned)).toEqual(["/b"])
    expect(names(result.rest)).toEqual(["/a"])
  })

  test("显式 scratchDir 指向的项目两侧都不出现", () => {
    const result = run(["/a", "/scratch", "/b"], ["/scratch"], "/scratch")
    expect(names(result.pinned)).toEqual([])
    expect(names(result.rest)).toEqual(["/a", "/b"])
  })

  test("不变量：每个可见项目恰好出现一次", () => {
    const worktrees = ["/a", "/b", "/c", "/d"]
    const result = run(worktrees, ["/d", "/b"])
    expect([...names(result.pinned), ...names(result.rest)].sort()).toEqual([...worktrees].sort())
  })

  test("全部置顶时 rest 为空", () => {
    const result = run(["/a", "/b"], ["/b", "/a"])
    expect(names(result.pinned)).toEqual(["/b", "/a"])
    expect(names(result.rest)).toEqual([])
  })

  test("rest 顺序与输入项目列表一致（drag 排序依赖）", () => {
    const result = run(["/a", "/b", "/c", "/d", "/e"], ["/b", "/d"])
    expect(names(result.rest)).toEqual(["/a", "/c", "/e"])
  })
})
