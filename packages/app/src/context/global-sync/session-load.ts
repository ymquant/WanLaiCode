import type { RootLoadArgs } from "./types"

async function loadRootSessions(input: RootLoadArgs, scope?: "project") {
  try {
    const result = await input.list({
      directory: input.directory,
      roots: true,
      limit: input.limit,
      scope,
    })
    return {
      data: result.data,
      limit: input.limit,
      limited: true,
    } as const
  } catch {
    const result = await input.list({ directory: input.directory, roots: true, scope })
    return {
      data: result.data,
      limit: input.limit,
      limited: false,
    } as const
  }
}

export async function loadRootSessionsWithFallback(input: RootLoadArgs) {
  // Git 项目按 project 取数，让 worktree / sandbox 的会话聚合到同一个项目下。
  const project = await loadRootSessions(input, "project")

  // 非 Git 目录共享后端 global project。若继续使用 project scope，自动化等其它目录的
  // 最近会话会占满 limit，重新登录后的空缓存便拿不到当前目录的历史会话和真实标题。
  if (!(project.data ?? []).some((session) => session.projectID === "global")) return project
  return loadRootSessions(input)
}

export function estimateRootSessionTotal(input: { count: number; limit: number; limited: boolean }) {
  if (!input.limited) return input.count
  if (input.count < input.limit) return input.count
  return input.count + 1
}
