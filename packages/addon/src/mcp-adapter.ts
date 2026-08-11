import { existsSync } from "fs"
import { readFile } from "fs/promises"
import path from "path"

export interface AddonMcpLocalConfig {
  type: "local"
  command: string[]
  environment?: Record<string, string>
  cwd?: string
  enabled?: boolean
  timeout?: number
  default_tools_approval_mode?: "auto" | "prompt" | "approve"
  enabled_tools?: string[]
  disabled_tools?: string[]
  tools?: Record<string, { approval?: "auto" | "prompt" | "approve" }>
}

export interface AddonMcpRemoteConfig {
  type: "remote"
  url: string
  enabled?: boolean
  headers?: Record<string, string>
  timeout?: number
  default_tools_approval_mode?: "auto" | "prompt" | "approve"
  enabled_tools?: string[]
  disabled_tools?: string[]
  tools?: Record<string, { approval?: "auto" | "prompt" | "approve" }>
}

export type AddonMcpConfigInfo = AddonMcpLocalConfig | AddonMcpRemoteConfig

export interface CodexMcpServerConfig {
  enabled?: boolean
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  url?: string
  http_headers?: Record<string, string>
  env_http_headers?: Record<string, string>
  bearer_token_env_var?: string
  tool_timeout_sec?: number
  default_tools_approval_mode?: "auto" | "prompt" | "approve"
  enabled_tools?: string[]
  disabled_tools?: string[]
  tools?: Record<string, { approval?: "auto" | "prompt" | "approve" }>
}

export type CodexMcpConfig = Record<string, CodexMcpServerConfig>

function compact<T extends Record<string, unknown>>(input: T) {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as {
    [K in keyof T]: Exclude<T[K], undefined>
  }
}

function normalizeApproval(value: CodexMcpServerConfig["default_tools_approval_mode"]) {
  return value?.toLowerCase() as "auto" | "prompt" | "approve" | undefined
}

function headers(config: CodexMcpServerConfig) {
  const result = { ...(config.http_headers ?? {}) }
  for (const [header, envName] of Object.entries(config.env_http_headers ?? {})) {
    const value = process.env[envName]
    if (value !== undefined) result[header] = value
  }
  if (config.bearer_token_env_var) {
    const token = process.env[config.bearer_token_env_var]
    if (token !== undefined) result.Authorization = `Bearer ${token}`
  }
  return Object.keys(result).length ? result : undefined
}

function resolveCwd(addonRoot: string | undefined, cwd: string | undefined) {
  if (!cwd) return undefined
  if (path.isAbsolute(cwd)) return cwd
  return addonRoot ? path.resolve(addonRoot, cwd) : cwd
}

function convertServer(config: CodexMcpServerConfig, addonRoot?: string): AddonMcpConfigInfo | undefined {
  const shared = {
    enabled: config.enabled === false ? false : undefined,
    timeout: config.tool_timeout_sec === undefined ? undefined : config.tool_timeout_sec * 1000,
    default_tools_approval_mode: normalizeApproval(config.default_tools_approval_mode),
    enabled_tools: config.enabled_tools,
    disabled_tools: config.disabled_tools,
    tools: config.tools,
  }

  if (config.command) {
    return compact({
      type: "local" as const,
      command: [config.command, ...(config.args ?? [])],
      environment: config.env,
      cwd: resolveCwd(addonRoot, config.cwd),
      ...shared,
    })
  }

  if (config.url) {
    return compact({
      type: "remote" as const,
      url: config.url,
      headers: headers(config),
      ...shared,
    })
  }
}

export function convertMcpConfig(codexConfig: CodexMcpConfig, addonRoot?: string) {
  return Object.fromEntries(
    Object.entries(codexConfig)
      .map(([name, config]) => [name, convertServer(config, addonRoot)] as const)
      .filter((entry): entry is readonly [string, AddonMcpConfigInfo] => entry[1] !== undefined),
  )
}

function unwrapMcpServers(input: unknown): CodexMcpConfig {
  if (!input || typeof input !== "object") return {}
  if ("mcpServers" in input && input.mcpServers && typeof input.mcpServers === "object") {
    return input.mcpServers as CodexMcpConfig
  }
  return input as CodexMcpConfig
}

export async function loadMcpConfigDeclaration(addonRoot: string, relativePath: string) {
  const fullPath = path.resolve(addonRoot, relativePath)
  if (!existsSync(fullPath)) return undefined
  return unwrapMcpServers(JSON.parse(await readFile(fullPath, "utf-8")))
}

export async function loadAndConvertMcpConfig(addonRoot: string, relativePath: string) {
  const declaration = await loadMcpConfigDeclaration(addonRoot, relativePath)
  return declaration ? convertMcpConfig(declaration, addonRoot) : undefined
}
