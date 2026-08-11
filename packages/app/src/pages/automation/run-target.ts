import { base64Encode } from "@opencode-ai/core/util/encode"

// 手动运行返回的运行记录 → 该次运行会话的路由。
// global 自动化的会话落在隐藏目录下,列表页除此之外没有任何入口,所以运行后直接带用户过去。
export function runSessionPath(
  run: { sessionID?: string | null; directory?: string | null } | null | undefined,
): string | undefined {
  if (!run?.sessionID || !run.directory) return undefined
  return `/${base64Encode(run.directory)}/session/${run.sessionID}`
}
