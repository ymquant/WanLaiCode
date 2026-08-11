import type { MarkdownPathResolution } from "../context/data"
import { normalizePromptHref, stripFileLocationSuffix, type PromptLinkKind } from "@opencode-ai/core/util/prompt-link"

export type UserPromptLinkTarget =
  | { type: "external"; value: string }
  | { type: "local"; value: string; kind: "file" | "directory" }

function decodePromptFilePath(value: string) {
  // 文件 URL 中的空格和中文必须在打开前恢复；异常转义保留原值，避免单条历史消息阻断整个气泡渲染。
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

export function resolveUserPromptLinkTarget(input: {
  kind: PromptLinkKind
  href: string
  directory: string
  resolved?: Pick<MarkdownPathResolution, "absolutePath" | "kind">
}): UserPromptLinkTarget {
  // 网页链接沿用输入框的规范化规则，确保 www 和协议相对地址发送后仍能直接打开。
  if (input.kind === "link") return { type: "external", value: normalizePromptHref(input.href) ?? input.href.trim() }
  if (input.resolved) return { type: "local", value: input.resolved.absolutePath, kind: input.resolved.kind }

  const raw = stripFileLocationSuffix(input.href.trim())
  const fileUrlPath = /^file:\/\//i.test(raw) && URL.canParse(raw) ? decodePromptFilePath(new URL(raw).pathname) : raw
  const normalized = /^\/[A-Za-z]:[\\/]/.test(fileUrlPath) ? fileUrlPath.slice(1) : fileUrlPath
  if (/^(?:\/[A-Za-z]:[\\/]|[A-Za-z]:[\\/]|\\\\|\/)/.test(normalized)) {
    return { type: "local", value: normalized, kind: "file" }
  }

  // 相对引用以当前工作区为根解析，与编辑器恢复历史 Prompt 时的路径语义保持一致。
  const separator = input.directory.includes("\\") ? "\\" : "/"
  const relative = normalized.replace(/^(?:\.\/[\\/])/, "")
  return {
    type: "local",
    value: `${input.directory.replace(/[\\/]$/, "")}${separator}${relative}`,
    kind: "file",
  }
}
