import { Flag } from "@opencode-ai/core/flag/flag"
import { InstallationChannel, InstallationVersion } from "@opencode-ai/core/installation/version"

export type Backend = "effect-httpapi" | "hono"

export type Selection = {
  backend: Backend
  reason: "env" | "stable" | "explicit"
}

export type Attributes = ReturnType<typeof attributes>

export function select(): Selection {
  if (Flag.WANLAICODE_EXPERIMENTAL_HTTPAPI) return { backend: "effect-httpapi", reason: "env" }
  // goal mode 已默认常驻，其路由只在 effect-httpapi 后端实现（httpapi/groups/session.ts），
  // legacy hono 后端没有，故服务端默认采用 httpapi——否则 /session/:id/goal 落到 SPA 静态兜底、
  // 返回 index.html，前端把 HTML 字符串当 goal 存进 store → dock 渲染崩溃 / 目标永远设不上。
  // hono 后端保留，仅经显式 force(selection, "hono") 入口使用。
  return { backend: "effect-httpapi", reason: "stable" }
}

export function attributes(selection: Selection): Record<string, string> {
  return {
    "opencode.server.backend": selection.backend,
    "opencode.server.backend.reason": selection.reason,
    "opencode.installation.channel": InstallationChannel,
    "opencode.installation.version": InstallationVersion,
  }
}

export function force(selection: Selection, backend: Backend): Selection {
  return {
    backend,
    reason: selection.backend === backend ? selection.reason : "explicit",
  }
}
