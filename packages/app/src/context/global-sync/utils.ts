import type { Agent, Project, ProviderListResponse } from "@opencode-ai/sdk/v2/client"
export { pathKey as directoryKey, type PathKey as DirectoryKey } from "@/utils/path-key"
import { pathKey, type PathKey } from "@/utils/path-key"

// agents query 由各调用方以「原始目录串」为 key 创建（bootstrap 的 input.directory、
// composer 的 sdk.directory），child store 订阅回写时按归一化目录匹配，
// 兼容 Windows 反斜杠与尾斜杠等形态差异
export function agentsQueryKeyMatches(queryKey: readonly unknown[], directory: PathKey) {
  if (queryKey.length !== 2 || queryKey[1] !== "agents") return false
  const dir = queryKey[0]
  if (typeof dir !== "string") return false
  return pathKey(dir) === directory
}

export const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

function isAgent(input: unknown): input is Agent {
  if (!input || typeof input !== "object") return false
  const item = input as { name?: unknown; mode?: unknown }
  if (typeof item.name !== "string") return false
  return item.mode === "subagent" || item.mode === "primary" || item.mode === "all"
}

export function normalizeAgentList(input: unknown): Agent[] {
  if (Array.isArray(input)) return input.filter(isAgent)
  if (isAgent(input)) return [input]
  if (!input || typeof input !== "object") return []
  return Object.values(input).filter(isAgent)
}

export function normalizeProviderList(input: ProviderListResponse): ProviderListResponse {
  const connected = new Set(input.connected)
  // 旧后端/旧缓存可能只在 all 里带 WanlaiCode 模型，却没有把 wanlaicode 写进 connected。
  // WanlaiCode 是软件内置登录 provider；只要下发了可用模型，客户端应视为可选，否则模型弹窗会空。
  if ((input.all ?? []).some((provider) => provider.id === "wanlaicode" && Object.keys(provider.models ?? {}).length > 0)) {
    connected.add("wanlaicode")
  }
  return {
    ...input,
    connected: [...connected],
    all: input.all.map((provider) => ({
      ...provider,
      models: Object.fromEntries(Object.entries(provider.models).filter(([, info]) => info.status !== "deprecated")),
    })),
  }
}

function errorText(error: unknown) {
  if (error instanceof Error) return `${error.name} ${error.message}`
  if (typeof error === "string") return error
  if (!error || typeof error !== "object") return ""
  const obj = error as Record<string, unknown>
  return [obj.name, obj.message, obj.status, obj.statusCode, obj.statusText]
    .filter((value): value is string | number => typeof value === "string" || typeof value === "number")
    .join(" ")
}

function providerListHasModels(input: ProviderListResponse | undefined) {
  return (input?.all ?? []).some((provider) => Object.keys(provider.models ?? {}).length > 0)
}

export function providerListWithFallback(input: {
  current: ProviderListResponse | undefined
  previous?: ProviderListResponse | undefined
  global?: ProviderListResponse | undefined
}) {
  if (providerListHasModels(input.current)) return input.current
  if (providerListHasModels(input.previous)) return input.previous
  if (providerListHasModels(input.global)) return input.global
  return input.current
}

export function isIgnorableReloadError(error: unknown) {
  if (error instanceof DOMException && error.name === "AbortError") return true
  if (error instanceof Error && error.name === "AbortError") return true
  if (!error || typeof error !== "object") return false
  const obj = error as Record<string, unknown>
  if (obj.status === 499 || obj.statusCode === 499) return true
  const text = errorText(error).toLowerCase()
  return text.includes("aborterror") || text.includes("request aborted") || /\b499\b/.test(text)
}

export function sanitizeProject(project: Project) {
  if (!project.icon?.url && !project.icon?.override) return project
  return {
    ...project,
    icon: {
      ...project.icon,
      url: undefined,
      override: undefined,
    },
  }
}
