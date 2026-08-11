import type { Hooks } from "@opencode-ai/plugin"
import * as AddonLoader from "@opencode-ai/addon"
import { mergeResults } from "@opencode-ai/addon"
import * as Log from "@opencode-ai/core/util/log"
import { Flock } from "@opencode-ai/core/util/flock"
import { Global } from "@opencode-ai/core/global"
import { Config } from "@/config/config"
import { ConfigMarkdown } from "@/config/markdown"
import { BusEvent } from "@/bus/bus-event"
import { InstanceState } from "@/effect/instance-state"
import { registerAddonCapabilityInvalidator } from "./capability-invalidation"
import { Context, Effect, Layer, Schema } from "effect"
import { createHash } from "crypto"
import { existsSync } from "fs"
import { mkdir, readdir, readFile, rename, rm, stat as statAsync, writeFile } from "fs/promises"
import { dirname, extname, isAbsolute, join, resolve, sep } from "path"
import {
  addonsCacheRoot,
  addonsStagingRoot,
  defaultAddonPaths,
  marketplaceInstallRoot,
  resolveMarketplaceRoot,
} from "./paths"

const log = Log.create({ service: "addon" })
const PERSONAL_SKILLS_ADDON_KEY = "personal-skills@personal"
const PERSONAL_SKILLS_ADDON_ID = { addonName: "personal-skills", marketplaceName: "personal" }
const PERSONAL_SKILL_INSTALL_MARKER = ".wanlaicode-installed"
const LEGACY_DEFAULT_MARKETPLACE_NAME = "openai-plugins"

interface State {
  paths: string[]
  addons: AddonLoader.LoadedAddon[]
  mcpServers: Record<string, AddonLoader.AddonMcpConfigInfo>
  marketplaces: AddonLoader.Marketplace[]
  manifestSummaries: Map<string, PluginManifestSummary>
  addonAssets: AddonAssets
}

export interface AddonSkillWithPlugin {
  addonName: string
  namespacedName: string
  skill: AddonLoader.CodexSkill
}

export class MarketplaceNotConfiguredError extends Error {
  constructor(
    public readonly marketplaceName: string,
    public readonly available: string[] = [],
  ) {
    const hint = available.length ? ` (available: ${available.join(", ")})` : " (no marketplaces configured)"
    super(`marketplace "${marketplaceName}" is not configured${hint}`)
    this.name = "MarketplaceNotConfiguredError"
  }
}

export class NamespacedMarketplaceInstallError extends Error {
  constructor(public readonly addonKey: string) {
    super(`namespaced addon key "${addonKey}" must be installed through the registry install flow`)
    this.name = "NamespacedMarketplaceInstallError"
  }
}

export interface AddonInstallOutcome {
  key: string
  version: string
  installedPath: string
  authPolicy: AddonLoader.MarketplacePluginAuthPolicy
}

export interface AddonUninstallOutcome {
  key: string
}

export interface AddonInstallInput {
  addonName: string
  marketplaceName: string
  registryNamespace?: string
}

export const AddonIdInfo = Schema.Struct({
  addon_name: Schema.String,
  marketplace_name: Schema.String,
  registry_namespace: Schema.optional(Schema.String),
}).annotate({ identifier: "AddonId" })

export const AddonCounts = Schema.Struct({
  mcp_servers: Schema.Number,
  skills: Schema.Number,
  hooks: Schema.Number,
  unsupported_hooks: Schema.Number,
}).annotate({ identifier: "AddonCounts" })

const McpApprovalMode = Schema.Literals(["auto", "prompt", "approve"])
const McpToolApproval = Schema.Struct({
  approval: Schema.optional(McpApprovalMode),
})

const McpServerSharedFields = {
  enabled: Schema.optional(Schema.Boolean),
  timeout: Schema.optional(Schema.Number),
  default_tools_approval_mode: Schema.optional(McpApprovalMode),
  enabled_tools: Schema.optional(Schema.Array(Schema.String)),
  disabled_tools: Schema.optional(Schema.Array(Schema.String)),
  tools: Schema.optional(Schema.Record(Schema.String, McpToolApproval)),
} as const

export const AddonMcpServer = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("local"),
    command: Schema.Array(Schema.String),
    environment: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    cwd: Schema.optional(Schema.String),
    ...McpServerSharedFields,
  }).annotate({ identifier: "AddonMcpLocalServer" }),
  Schema.Struct({
    type: Schema.Literal("remote"),
    url: Schema.String,
    headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    ...McpServerSharedFields,
  }).annotate({ identifier: "AddonMcpRemoteServer" }),
]).annotate({ identifier: "AddonMcpServer" })

export const AddonSkillInfo = Schema.Struct({
  name: Schema.String,
  namespaced_name: Schema.String,
  display_name: Schema.optional(Schema.String),
  description: Schema.String,
  location: Schema.String,
}).annotate({ identifier: "AddonSkill" })

export const Info = Schema.Struct({
  key: Schema.String,
  addon_id: AddonIdInfo,
  name: Schema.String,
  display_name: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  version: Schema.optional(Schema.String),
  marketplace_name: Schema.String,
  disabled: Schema.Boolean,
  error: Schema.optional(Schema.String),
  counts: AddonCounts,
}).annotate({ identifier: "AddonInfo" })
export type Info = Schema.Schema.Type<typeof Info>

export const Detail = Schema.Struct({
  ...Info.fields,
  root: Schema.String,
  manifest_path: Schema.optional(Schema.String),
  mcp_servers: Schema.Record(Schema.String, AddonMcpServer),
  skills: Schema.Array(AddonSkillInfo),
  hooks: Schema.Array(Schema.String),
  unsupported_hook_events: Schema.Array(Schema.String),
}).annotate({ identifier: "AddonDetail" })
export type Detail = Schema.Schema.Type<typeof Detail>

export const InstallRequest = Schema.Struct({
  addon_key: Schema.String,
}).annotate({ identifier: "AddonInstallRequest" })
export type InstallRequest = Schema.Schema.Type<typeof InstallRequest>

export const LocalArchiveInstallRequest = Schema.Struct({
  archive_path: Schema.String,
}).annotate({ identifier: "AddonLocalArchiveInstallRequest" })
export type LocalArchiveInstallRequest = Schema.Schema.Type<typeof LocalArchiveInstallRequest>

export const LocalArchivePreviewRequest = Schema.Struct({
  archive_path: Schema.String,
  locale: Schema.optional(Schema.String),
}).annotate({ identifier: "AddonLocalArchivePreviewRequest" })
export type LocalArchivePreviewRequest = Schema.Schema.Type<typeof LocalArchivePreviewRequest>

export const InstallOutcome = Schema.Struct({
  key: Schema.String,
  version: Schema.String,
  installed_path: Schema.String,
  auth_policy: Schema.Literals(["ON_INSTALL", "ON_USE"]),
}).annotate({ identifier: "AddonInstallOutcome" })
export type InstallOutcome = Schema.Schema.Type<typeof InstallOutcome>

export const UninstallOutcome = Schema.Struct({
  key: Schema.String,
}).annotate({ identifier: "AddonUninstallOutcome" })
export type UninstallOutcome = Schema.Schema.Type<typeof UninstallOutcome>

export const SkillListItem = Schema.Struct({
  namespaced_name: Schema.String,
  name: Schema.String,
  display_name: Schema.optional(Schema.String),
  description: Schema.String,
  location: Schema.String,
  content: Schema.optional(Schema.String),
  installed: Schema.optional(Schema.Boolean),
  enabled: Schema.Boolean,
  addon_key: Schema.String,
  addon_name: Schema.String,
  addon_display_name: Schema.optional(Schema.String),
  marketplace_name: Schema.String,
  category: Schema.optional(Schema.String),
  logo: Schema.optional(Schema.String),
  brand_color: Schema.optional(Schema.String),
}).annotate({ identifier: "AddonSkillListItem" })
export type SkillListItem = Schema.Schema.Type<typeof SkillListItem>

export const SkillContent = Schema.Struct({
  addon_key: Schema.String,
  name: Schema.String,
  content: Schema.String,
}).annotate({ identifier: "AddonSkillContent" })
export type SkillContent = Schema.Schema.Type<typeof SkillContent>

export const SkillToggleRequest = Schema.Struct({
  addon_key: Schema.String,
  name: Schema.String,
  enabled: Schema.Boolean,
}).annotate({ identifier: "AddonSkillToggleRequest" })
export type SkillToggleRequest = Schema.Schema.Type<typeof SkillToggleRequest>

export const SkillInstallRequest = Schema.Struct({
  addon_key: Schema.String,
  name: Schema.String,
  installed: Schema.Boolean,
}).annotate({ identifier: "AddonSkillInstallRequest" })
export type SkillInstallRequest = Schema.Schema.Type<typeof SkillInstallRequest>

export const ToggleRequest = Schema.Struct({
  addon_key: Schema.String,
  enabled: Schema.Boolean,
}).annotate({ identifier: "AddonToggleRequest" })
export type ToggleRequest = Schema.Schema.Type<typeof ToggleRequest>

export const Event = {
  // Emitted whenever an addon's effective capabilities change (enable/disable,
  // install, uninstall, skill toggle). Capability registries (skill/command/
  // plugin caches) and the app listen to this to refresh without a restart.
  Changed: BusEvent.define("addon.changed", Schema.Struct({})),
}

export const SkillCreateRequest = Schema.Struct({
  addon_key: Schema.String,
  name: Schema.String,
  description: Schema.String,
  display_name: Schema.optional(Schema.String),
  content: Schema.optional(Schema.String),
}).annotate({ identifier: "AddonSkillCreateRequest" })
export type SkillCreateRequest = Schema.Schema.Type<typeof SkillCreateRequest>

export const SkillCreateOutcome = Schema.Struct({
  namespaced_name: Schema.String,
  location: Schema.String,
}).annotate({ identifier: "AddonSkillCreateOutcome" })
export type SkillCreateOutcome = Schema.Schema.Type<typeof SkillCreateOutcome>

export class SkillNotFoundError extends Error {
  constructor(public readonly key: string) {
    super(`skill not found: "${key}"`)
    this.name = "SkillNotFoundError"
  }
}

export class AddonNotFoundError extends Error {
  constructor(public readonly key: string) {
    super(`addon not found: "${key}"`)
    this.name = "AddonNotFoundError"
  }
}

export class McpNotFoundError extends Error {
  constructor(public readonly key: string) {
    super(`MCP server not found: ${key}`)
    this.name = "McpNotFoundError"
  }
}

export class SkillAlreadyExistsError extends Error {
  constructor(public readonly key: string) {
    super(`skill already exists: "${key}"`)
    this.name = "SkillAlreadyExistsError"
  }
}

export class InvalidSkillNameError extends Error {
  constructor(public readonly skillName: string) {
    super(`invalid skill name: "${skillName}" (must match ^[a-z0-9][a-z0-9-]{0,63}$)`)
    this.name = "InvalidSkillNameError"
  }
}

export const Available = Schema.Struct({
  key: Schema.String,
  name: Schema.String,
  display_name: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  marketplace_name: Schema.String,
  registry_namespace: Schema.optional(Schema.String),
  category: Schema.optional(Schema.String),
  keywords: Schema.optional(Schema.Array(Schema.String)),
  installation: Schema.Literals(["NOT_AVAILABLE", "AVAILABLE", "INSTALLED_BY_DEFAULT"]),
  installed: Schema.Boolean,
  disabled: Schema.optional(Schema.Boolean),
  error: Schema.optional(Schema.String),
  logo: Schema.optional(Schema.String),
  // 单色 composer / chip 用图标(plugin.json interface.composerIcon),与 logo(品牌全彩)区分
  composer_icon: Schema.optional(Schema.String),
  brand_color: Schema.optional(Schema.String),
  // 详情页用 —— 来自 marketplace plugin.interface 或已加载 addon 的 manifest.interfaceInfo
  long_description: Schema.optional(Schema.String),
  developer_name: Schema.optional(Schema.String),
  capabilities: Schema.optional(Schema.Array(Schema.String)),
  website_url: Schema.optional(Schema.String),
  privacy_policy_url: Schema.optional(Schema.String),
  terms_of_service_url: Schema.optional(Schema.String),
  default_prompt: Schema.optional(Schema.Array(Schema.String)),
  screenshots: Schema.optional(Schema.Array(Schema.String)),
  // 来自 plugin manifest + 资源文件的预读摘要 —— 详情页 Includes 区在未安装时也要列出每个 App / MCP server / Skill。
  // apps 与 mcp_servers 分开:apps 是 .app.json 里的远程 App 引用,mcp_servers 是 .mcp.json 里的本地命令配置。
  manifest_apps: Schema.optional(Schema.Array(Schema.Struct({ name: Schema.String }))),
  manifest_mcp_servers: Schema.optional(Schema.Array(Schema.Struct({ name: Schema.String }))),
  manifest_skills: Schema.optional(
    Schema.Array(
      Schema.Struct({
        name: Schema.String,
        display_name: Schema.optional(Schema.String),
        description: Schema.optional(Schema.String),
      }),
    ),
  ),
  has_hooks: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "AddonAvailable" })
export type Available = Schema.Schema.Type<typeof Available>

export const LocalArchivePreview = Schema.Struct({
  ...Available.fields,
  version: Schema.optional(Schema.String),
}).annotate({ identifier: "AddonLocalArchivePreview" })
export type LocalArchivePreview = Schema.Schema.Type<typeof LocalArchivePreview>

function compactObject<T extends Record<string, unknown>>(input: T): T {
  return Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) as T
}

function personalSkillsRoot() {
  return join(Global.Path.data, "personal", "skills")
}

async function tryReadSkillDisplayName(skillDir: string) {
  const candidates = [
    join(skillDir, "agents", "wanlaicode.yaml"),
    join(skillDir, "wanlaicode.yaml"),
    join(skillDir, "agents", "openai.yaml"),
    join(skillDir, "openai.yaml"),
  ]
  for (const candidate of candidates) {
    try {
      const text = await readFile(candidate, "utf-8")
      for (const line of text.split(/\r?\n/)) {
        const colonIdx = line.indexOf(":")
        if (colonIdx === -1) continue
        if (line.slice(0, colonIdx).trim() !== "display_name") continue
        const value = line
          .slice(colonIdx + 1)
          .trim()
          .replace(/^['"]|['"]$/g, "")
        if (value) return value
      }
    } catch {
      // Try the next metadata file.
    }
  }
  return undefined
}

async function loadPersonalSkillItems(cfg: Config.Info): Promise<SkillListItem[]> {
  let entries: string[]
  try {
    entries = await readdir(personalSkillsRoot())
  } catch {
    return []
  }
  const installedPaths = new Set((cfg.skills?.paths ?? []).map((item) => resolve(item)))
  const disabledPersonalSkills = new Set(cfg.plugins?.[PERSONAL_SKILLS_ADDON_KEY]?.disabled_skills ?? [])
  const result: SkillListItem[] = []
  for (const entry of entries) {
    const skillDir = join(personalSkillsRoot(), entry)
    const skillFile = join(skillDir, "SKILL.md")
    try {
      const stats = await statAsync(skillDir)
      if (!stats.isDirectory()) continue
      const frontmatter = await ConfigMarkdown.parse(skillFile)
      const name = typeof frontmatter.data.name === "string" ? frontmatter.data.name : entry
      const description = typeof frontmatter.data.description === "string" ? frontmatter.data.description : undefined
      if (!description) continue
      const installed =
        installedPaths.has(resolve(skillDir)) || existsSync(join(skillDir, PERSONAL_SKILL_INSTALL_MARKER))
      const enabled = installed && !disabledPersonalSkills.has(name)
      result.push({
        namespaced_name: name,
        name,
        display_name: await tryReadSkillDisplayName(skillDir),
        description,
        location: skillFile,
        installed,
        enabled,
        addon_key: PERSONAL_SKILLS_ADDON_KEY,
        addon_name: "personal-skills",
        addon_display_name: "Personal Skills",
        marketplace_name: "personal",
        category: "Personal",
      })
    } catch {
      // Ignore malformed or partially-written skill directories.
    }
  }
  return result
}

function withPersonalSkillPath(cfg: Config.Info, skillDir: string, enabled: boolean): Config.Info {
  const target = resolve(skillDir)
  const existing = cfg.skills?.paths ?? []
  const paths = enabled
    ? existing.some((item) => resolve(item) === target)
      ? existing
      : [...existing, skillDir]
    : existing.filter((item) => resolve(item) !== target)
  return {
    skills: {
      ...(cfg.skills ?? {}),
      paths,
    },
  } as Config.Info
}

function normalizeDefaultPrompt(value: unknown): string[] | undefined {
  if (typeof value === "string") return value.trim() ? [value.slice(0, 128)] : undefined
  if (!Array.isArray(value)) return undefined
  const prompts = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 3)
    .map((item) => item.slice(0, 128))
  return prompts.length ? prompts : undefined
}

export function toInfo(addon: AddonLoader.LoadedAddon): Info {
  const skills = addon.skills?.length ?? 0
  const mcp_servers = addon.mcpServers ? Object.keys(addon.mcpServers).length : 0
  const hooks = addon.hooks ? Object.keys(addon.hooks).length : 0
  const unsupported_hooks = addon.unsupportedHookEvents?.length ?? 0
  return compactObject({
    key: AddonLoader.addonKey(addon.addonId),
    addon_id: {
      addon_name: addon.addonId.addonName,
      marketplace_name: addon.addonId.marketplaceName,
      registry_namespace: addon.addonId.registryNamespace,
    },
    name: addon.manifest.name,
    display_name: addon.manifest.interfaceInfo?.displayName,
    description: addon.manifest.description,
    version: addon.version,
    marketplace_name: addon.addonId.marketplaceName,
    disabled: addon.disabled === true,
    error: addon.error,
    counts: { mcp_servers, skills, hooks, unsupported_hooks },
  }) as Info
}

function hasMarketplaceManifest(root: string): boolean {
  return (
    existsSync(join(root, ".agents/plugins/marketplace.json")) ||
    existsSync(join(root, ".claude-plugin/marketplace.json"))
  )
}

function hasExplicitOpenaiPluginsMarketplace(cfg: Pick<Config.Info, "marketplaces">): boolean {
  return Object.entries(cfg.marketplaces ?? {}).some(([name, marketplace]) => {
    if (name === LEGACY_DEFAULT_MARKETPLACE_NAME) return true
    const source = marketplace.source ?? ""
    return source.includes("github.com/openai/plugins") || source.includes("openai/plugins.git")
  })
}

export async function cleanupLegacyDefaultMarketplace(cfg: Pick<Config.Info, "marketplaces">): Promise<void> {
  if (hasExplicitOpenaiPluginsMarketplace(cfg)) return
  await rm(marketplaceInstallRoot(LEGACY_DEFAULT_MARKETPLACE_NAME), { recursive: true, force: true })
}

// TODO 后续改成单独的静态资源端点（按需取），避免每次列表都 inline 全部图标
const LOGO_MAX_BYTES = 2 * 1024 * 1024 // 2MB 上限,常见插件 icon 一般 < 500KB,Canva 这种 1024x1024 PNG ~1MB
const LOGO_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
}

async function readLogoAsDataUri(addonRoot: string, logoRel: string): Promise<string | undefined> {
  // logoRel 通常是 "./assets/gmail.png" 这种相对路径；只允许相对路径或绝对路径，杜绝远程 URL inline
  if (/^https?:|^data:/.test(logoRel)) return logoRel
  const abs = isAbsolute(logoRel) ? logoRel : resolve(addonRoot, logoRel)
  // 沙箱校验:abs 必须落在 addonRoot 内。logoRel 来自 marketplace plugin.json 的不可信
  // interface.logo / composerIcon,恶意 marketplace 可经 `../` 或绝对路径越界读 addon 目录外
  // 的图片(扩展名白名单只挡非图片文件,不阻挡越界本身)。
  const root = resolve(addonRoot)
  if (abs !== root && !abs.startsWith(root + sep)) return undefined
  try {
    const info = await statAsync(abs)
    if (!info.isFile() || info.size > LOGO_MAX_BYTES) return undefined
    const mime = LOGO_MIME[extname(abs).toLowerCase()]
    if (!mime) return undefined
    const buf = await readFile(abs)
    return `data:${mime};base64,${buf.toString("base64")}`
  } catch {
    return undefined
  }
}

// 详情页 Includes 区在未安装时也要列每个 App / MCP server / Skill —— 运行时 AddonDetail 拿不到（未安装无 loaded addon），
// 改成在 marketplace 端预读 plugin 资源：
//   .app.json `apps` 字段 → 远程 App（含 id 引用，如 Linear）
//   .mcp.json `mcpServers` 字段 → 本地 MCP server（含命令配置，如 xcodebuildmcp）
//   skills/<name>/agents/openai.yaml → 每个 skill 的 display_name + short_description
export interface PluginManifestSummary {
  apps: Array<{ name: string }>
  mcp_servers: Array<{ name: string }>
  skills: Array<{ name: string; display_name?: string; description?: string }>
  has_hooks: boolean
}

// 极简 yaml 子集解析 —— 真实数据形如:
//   interface:
//     display_name: "iOS App Intents"
//     short_description: "..."
// 只取 interface.display_name 和 interface.short_description，避免引入 yaml 解析依赖。
function parseSkillAgentYaml(text: string): { display_name?: string; short_description?: string } {
  const lines = text.split(/\r?\n/)
  let inInterface = false
  let displayName: string | undefined
  let shortDescription: string | undefined
  const stripQuotes = (s: string) => s.replace(/^['"]|['"]$/g, "").trim()
  for (const raw of lines) {
    if (/^interface:\s*$/.test(raw)) {
      inInterface = true
      continue
    }
    if (!inInterface) continue
    // 一旦遇到非缩进非空行（顶层下一个 key），interface 块结束
    if (raw.trim() && !/^\s/.test(raw)) {
      inInterface = false
      continue
    }
    const m = raw.match(/^\s+([a-z_]+):\s*(.+?)\s*$/)
    if (!m) continue
    const [, key, value] = m
    if (key === "display_name") displayName = stripQuotes(value)
    else if (key === "short_description") shortDescription = stripQuotes(value)
  }
  return { display_name: displayName, short_description: shortDescription }
}

async function readSkillSummaries(
  pluginRoot: string,
  skillsRel: string,
): Promise<Array<{ name: string; display_name?: string; description?: string }>> {
  const skillsDir = isAbsolute(skillsRel) ? skillsRel : resolve(pluginRoot, skillsRel)
  let entries: string[]
  try {
    entries = await readdir(skillsDir)
  } catch {
    return []
  }
  const result: Array<{ name: string; display_name?: string; description?: string }> = []
  for (const name of entries) {
    if (name.startsWith(".")) continue
    const skillRoot = join(skillsDir, name)
    try {
      const info = await statAsync(skillRoot)
      if (!info.isDirectory()) continue
    } catch {
      continue
    }
    let display_name: string | undefined
    let description: string | undefined
    for (const file of ["wanlaicode.yaml", "openai.yaml"]) {
      try {
        const yaml = await readFile(join(skillRoot, "agents", file), "utf-8")
        const parsed = parseSkillAgentYaml(yaml)
        display_name = parsed.display_name
        description = parsed.short_description
        break
      } catch {
        // 该候选不存在则试下一个;都没有也无所谓，只用 name
      }
    }
    result.push({ name, display_name, description })
  }
  result.sort((a, b) => (a.display_name ?? a.name).localeCompare(b.display_name ?? b.name))
  return result
}

async function readMcpServerNames(pluginRoot: string, mcpRel: string): Promise<string[]> {
  const path = isAbsolute(mcpRel) ? mcpRel : resolve(pluginRoot, mcpRel)
  try {
    const raw = JSON.parse(await readFile(path, "utf-8")) as { mcpServers?: Record<string, unknown> }
    return Object.keys(raw.mcpServers ?? {})
  } catch {
    return []
  }
}

// 从单个 plugin 的 .codex-plugin/plugin.json 中读取 interface 信息（包含 logo 路径）+ apps/skills 详细摘要。
// 直接读 JSON 字段而不走 parseManifest —— marketplace 插件可能用 `interface`（不是 schema 期待的 `interfaceInfo`），
// 这里宽容兼容两种命名。
async function loadPluginInterface(pluginRoot: string): Promise<
  | {
      interface?: AddonLoader.AddonInterfaceInfo
      manifestRoot: string
      summary: PluginManifestSummary
    }
  | undefined
> {
  const manifestPath = AddonLoader.findManifestPath(pluginRoot)
  if (!manifestPath) return undefined
  try {
    const raw = JSON.parse(await readFile(manifestPath, "utf-8")) as {
      interface?: AddonLoader.AddonInterfaceInfo
      interfaceInfo?: AddonLoader.AddonInterfaceInfo
      apps?: unknown
      skills?: unknown
      mcpServers?: unknown
      hooks?: unknown
    }
    const manifestRoot = dirname(dirname(manifestPath))
    const skillsRel = typeof raw.skills === "string" ? raw.skills : undefined
    const mcpRel = typeof raw.mcpServers === "string" ? raw.mcpServers : undefined
    const appsRel = typeof raw.apps === "string" ? raw.apps : undefined
    const [mcpServers, apps, skills] = await Promise.all([
      mcpRel
        ? readMcpServerNames(manifestRoot, mcpRel).then((names) => names.map((n) => ({ name: n })))
        : Promise.resolve([]),
      appsRel
        ? AddonLoader.readAppNamesFromAppsFile(manifestRoot, appsRel).then((names) => names.map((n) => ({ name: n })))
        : Promise.resolve([]),
      skillsRel ? readSkillSummaries(manifestRoot, skillsRel) : Promise.resolve([]),
    ])
    const has_hooks =
      !!raw.hooks &&
      (typeof raw.hooks === "string" ? raw.hooks.length > 0 : Array.isArray(raw.hooks) ? raw.hooks.length > 0 : true)
    return {
      interface: normalizeInterfaceInfo(raw.interface ?? raw.interfaceInfo),
      manifestRoot,
      summary: { apps, mcp_servers: mcpServers, skills, has_hooks },
    }
  } catch {
    return undefined
  }
}

// 给 marketplace.plugins 注入 interface 信息（display_name/category/description/logo …）
// marketplace.json 已显式声明的字段优先；未声明的从 plugin.json 补。
// 同时返回 manifest paths 摘要（按 `<name>@<marketplace>` key），供 toAvailableList 透出 has_apps / has_skills / has_hooks。
export async function enrichMarketplaces(marketplaces: AddonLoader.Marketplace[]): Promise<{
  marketplaces: AddonLoader.Marketplace[]
  summaries: Map<string, PluginManifestSummary>
}> {
  const summaries = new Map<string, PluginManifestSummary>()
  const result = await Promise.all(
    marketplaces.map(async (m) => {
      const plugins = await Promise.all(
        m.plugins.map(async (p) => {
          if (p.source.type !== "local") return p
          const loaded = await loadPluginInterface(p.source.path)
          if (!loaded) return p
          summaries.set(`${p.name}@${m.name}`, loaded.summary)
          const merged: AddonLoader.AddonInterfaceInfo = { ...loaded.interface, ...p.interface }
          if (merged.logo) {
            const dataUri = await readLogoAsDataUri(loaded.manifestRoot, merged.logo)
            if (dataUri) merged.logo = dataUri
            else delete merged.logo
          }
          if (merged.composerIcon) {
            const dataUri = await readLogoAsDataUri(loaded.manifestRoot, merged.composerIcon)
            if (dataUri) merged.composerIcon = dataUri
            else delete merged.composerIcon
          }
          return { ...p, interface: merged }
        }),
      )
      return { ...m, plugins }
    }),
  )
  return { marketplaces: result, summaries }
}

export type AddonAssets = Map<string, { logo?: string; composer_icon?: string }>

// 已安装 addon 的 interface.logo / composerIcon 是包内相对路径，前端无法直接 <img src>。
// 读成 data URI（与 marketplace 的 enrichMarketplaces 同机制），按 addon key 缓存，供 toAvailableList 取用。
// 这样经 registry / sideload 安装的插件（不在已配置 marketplace 内）也能在列表/「@」选择器里显示 logo。
//
// marketplace 已为某插件产出 data-URI 的 logo/composerIcon 时，toAvailableList / getSkillList
// 都优先用它（addonAssets 仅作回退），故按字段跳过这些已覆盖项，避免重复读盘+base64。
export async function enrichAddonAssets(
  addons: AddonLoader.LoadedAddon[],
  marketplaces: AddonLoader.Marketplace[] = [],
): Promise<AddonAssets> {
  const covered = new Map<string, { logo: boolean; composerIcon: boolean }>()
  for (const m of marketplaces) {
    for (const p of m.plugins) {
      covered.set(`${p.name}@${m.name}`, { logo: !!p.interface?.logo, composerIcon: !!p.interface?.composerIcon })
    }
  }
  const map: AddonAssets = new Map()
  await Promise.all(
    addons.map(async (a) => {
      const iface = a.manifest.interfaceInfo
      if (!iface) return
      const key = AddonLoader.addonKey(a.addonId)
      const cov = covered.get(key)
      const entry: { logo?: string; composer_icon?: string } = {}
      if (iface.logo && !cov?.logo) entry.logo = await readLogoAsDataUri(a.root, iface.logo)
      if (iface.composerIcon && !cov?.composerIcon)
        entry.composer_icon = await readLogoAsDataUri(a.root, iface.composerIcon)
      if (entry.logo || entry.composer_icon) map.set(key, entry)
    }),
  )
  return map
}

// 应用语言 → 包内 locale key 的容错匹配：精确/别名/同主语言子标签（区分中文简繁）。
function pickLocale(requested: string, keys: string[]): string | undefined {
  const norm = (s: string) => s.toLowerCase().replace(/_/g, "-")
  const req = norm(requested)
  const lower = new Map(keys.map((k) => [norm(k), k]))
  const candidates = [req]
  if (req === "zh" || req === "zh-hans") candidates.push("zh-hans", "zh-cn", "zh-sg")
  else if (req === "zht" || req === "zh-hant") candidates.push("zh-hant", "zh-tw", "zh-hk")
  for (const c of candidates) {
    const hit = lower.get(c)
    if (hit) return hit
  }
  const primary = req.split("-")[0]!
  const wantTrad = req === "zht" || req.includes("hant") || req.includes("tw") || req.includes("hk")
  for (const [k, orig] of lower) {
    if (k.split("-")[0] !== primary) continue
    if (primary === "zh" && (k.includes("hant") || k.includes("tw") || k.includes("hk")) !== wantTrad) continue
    return orig
  }
  return undefined
}

type LocalizedText = {
  displayName?: string
  shortDescription?: string
  longDescription?: string
  defaultPrompt?: unknown
}

function normalizeInterfaceInfo(input: unknown): AddonLoader.AddonInterfaceInfo | undefined {
  if (!input || typeof input !== "object") return undefined
  const raw = input as AddonLoader.AddonInterfaceInfo & {
    websiteURL?: string
    privacyPolicyURL?: string
    termsOfServiceURL?: string
  }
  return {
    ...raw,
    websiteUrl: raw.websiteURL ?? raw.websiteUrl,
    privacyPolicyUrl: raw.privacyPolicyURL ?? raw.privacyPolicyUrl,
    termsOfServiceUrl: raw.termsOfServiceURL ?? raw.termsOfServiceUrl,
  }
}

// 按请求 locale 从 interface.locales 协商译文，缺则回退默认（顶层）字段。
function localizeInterface(
  defaults: LocalizedText,
  locales: Record<string, LocalizedText> | undefined,
  locale: string | undefined,
): LocalizedText {
  if (!locale || !locales) return defaults
  const picked = pickLocale(locale, Object.keys(locales))
  const t = picked ? locales[picked] : undefined
  if (!t) return defaults
  return {
    displayName: t.displayName ?? defaults.displayName,
    shortDescription: t.shortDescription ?? defaults.shortDescription,
    longDescription: t.longDescription ?? defaults.longDescription,
    defaultPrompt: t.defaultPrompt ?? defaults.defaultPrompt,
  }
}

export function toAvailableList(
  addons: AddonLoader.LoadedAddon[],
  marketplaces: AddonLoader.Marketplace[],
  summaries?: Map<string, PluginManifestSummary>,
  addonAssets?: AddonAssets,
  locale?: string,
): Available[] {
  const installedByKey = new Map<string, AddonLoader.LoadedAddon>(
    addons.map((a) => [AddonLoader.addonKey(a.addonId), a]),
  )
  // marketplace 声明的插件（用于「未安装」浏览项 + 给已安装项叠加策展信息：分类/策略/keywords）。
  const marketplacePluginByKey = new Map<
    string,
    { plugin: AddonLoader.MarketplacePlugin; market: AddonLoader.Marketplace }
  >()
  for (const market of marketplaces) {
    for (const plugin of market.plugins) marketplacePluginByKey.set(`${plugin.name}@${market.name}`, { plugin, market })
  }
  const summaryFor = (key: string): PluginManifestSummary | undefined => summaries?.get(key)
  const result: Available[] = []

  // 已安装插件：无论来自哪种来源（marketplace / sideload / registry），都是 cache 里相同结构的文件，
  // 统一由磁盘上的 LoadedAddon 渲染（logo 经 addonAssets 转 data URI）。若它同时被某 marketplace 声明，
  // 则叠加该 marketplace 的策展信息（分类覆盖、安装策略、keywords、manifest 摘要）。
  for (const addon of addons) {
    const key = AddonLoader.addonKey(addon.addonId)
    const mp = marketplacePluginByKey.get(key)
    const iface = mp?.plugin.interface
    const loadedIface = addon.manifest.interfaceInfo
    const summary = summaryFor(key)
    const manifestApps = summary?.apps ?? []
    const manifestMcpServers = summary?.mcp_servers?.length
      ? summary.mcp_servers
      : addon.mcpServers
        ? Object.keys(addon.mcpServers).map((name) => ({ name }))
        : []
    const manifestSkills = summary?.skills?.length
      ? summary.skills
      : (addon.skills ?? []).map((s) => ({ name: s.name, display_name: s.displayName, description: s.description }))
    const hasHooks = summary?.has_hooks || (addon.hooks ? Object.keys(addon.hooks).length > 0 : false)
    const capabilities = iface?.capabilities ?? loadedIface?.capabilities
    const screenshots = iface?.screenshots ?? loadedIface?.screenshots
    const loc = localizeInterface(
      {
        displayName: iface?.displayName ?? loadedIface?.displayName,
        shortDescription: iface?.shortDescription ?? loadedIface?.shortDescription,
        longDescription: iface?.longDescription ?? loadedIface?.longDescription,
        defaultPrompt: iface?.defaultPrompt ?? loadedIface?.defaultPrompt,
      },
      iface?.locales ?? loadedIface?.locales,
      locale,
    )
    result.push(
      compactObject({
        key,
        name: addon.manifest.name,
        display_name: loc.displayName,
        description: loc.shortDescription ?? loc.longDescription ?? addon.manifest.description,
        marketplace_name: addon.addonId.marketplaceName,
        registry_namespace: addon.addonId.registryNamespace,
        category: mp?.plugin.category ?? iface?.category ?? loadedIface?.category,
        keywords: mp?.plugin.keywords ?? addon.manifest.keywords,
        installation: mp?.plugin.policy.installation ?? "AVAILABLE",
        installed: true,
        disabled: addon.disabled === true,
        error: addon.error,
        logo: iface?.logo ?? addonAssets?.get(key)?.logo ?? loadedIface?.logo,
        composer_icon: iface?.composerIcon ?? addonAssets?.get(key)?.composer_icon ?? loadedIface?.composerIcon,
        brand_color: iface?.brandColor ?? loadedIface?.brandColor,
        long_description: loc.longDescription,
        developer_name: iface?.developerName ?? loadedIface?.developerName,
        capabilities: capabilities?.length ? [...capabilities] : undefined,
        website_url: iface?.websiteUrl ?? loadedIface?.websiteUrl,
        privacy_policy_url: iface?.privacyPolicyUrl ?? loadedIface?.privacyPolicyUrl,
        terms_of_service_url: iface?.termsOfServiceUrl ?? loadedIface?.termsOfServiceUrl,
        default_prompt: normalizeDefaultPrompt(loc.defaultPrompt),
        screenshots: screenshots?.length ? [...screenshots] : undefined,
        manifest_apps: manifestApps.length ? manifestApps : undefined,
        manifest_mcp_servers: manifestMcpServers.length ? manifestMcpServers : undefined,
        manifest_skills: manifestSkills.length ? manifestSkills : undefined,
        has_hooks: hasHooks ? true : undefined,
      }) as Available,
    )
  }

  // marketplace 声明但「未安装」的插件 —— 浏览/可安装项，数据来自 marketplace 预读的 interface。
  for (const market of marketplaces) {
    for (const plugin of market.plugins) {
      const key = `${plugin.name}@${market.name}`
      if (installedByKey.has(key)) continue
      const summary = summaryFor(key)
      const iface = plugin.interface
      const manifestApps = summary?.apps ?? []
      const manifestMcpServers = summary?.mcp_servers ?? []
      const manifestSkills = summary?.skills ?? []
      const loc = localizeInterface(
        {
          displayName: iface?.displayName,
          shortDescription: iface?.shortDescription,
          longDescription: iface?.longDescription,
          defaultPrompt: iface?.defaultPrompt,
        },
        iface?.locales,
        locale,
      )
      result.push(
        compactObject({
          key,
          name: plugin.name,
          display_name: loc.displayName,
          description: loc.shortDescription ?? loc.longDescription,
          marketplace_name: market.name,
          category: plugin.category ?? iface?.category,
          keywords: plugin.keywords,
          installation: plugin.policy.installation,
          installed: false,
          logo: iface?.logo,
          composer_icon: iface?.composerIcon,
          brand_color: iface?.brandColor,
          long_description: loc.longDescription,
          developer_name: iface?.developerName,
          capabilities: iface?.capabilities?.length ? [...iface.capabilities] : undefined,
          website_url: iface?.websiteUrl,
          privacy_policy_url: iface?.privacyPolicyUrl,
          terms_of_service_url: iface?.termsOfServiceUrl,
          default_prompt: normalizeDefaultPrompt(loc.defaultPrompt),
          screenshots: iface?.screenshots?.length ? [...iface.screenshots] : undefined,
          manifest_apps: manifestApps.length ? manifestApps : undefined,
          manifest_mcp_servers: manifestMcpServers.length ? manifestMcpServers : undefined,
          manifest_skills: manifestSkills.length ? manifestSkills : undefined,
          has_hooks: summary?.has_hooks ? true : undefined,
        }) as Available,
      )
    }
  }
  return result
}

export function toDetail(addon: AddonLoader.LoadedAddon): Detail {
  const skills = (addon.skills ?? []).map((skill) =>
    compactObject({
      name: skill.name,
      namespaced_name: AddonLoader.addonSkillName(addon.addonId, skill.name),
      display_name: skill.displayName,
      description: skill.description,
      location: skill.location,
    }),
  )
  return compactObject({
    ...toInfo(addon),
    root: addon.root,
    manifest_path: AddonLoader.findManifestPath(addon.root) ?? undefined,
    mcp_servers: addon.mcpServers ?? {},
    skills,
    hooks: addon.hooks ? Object.keys(addon.hooks) : [],
    unsupported_hook_events: addon.unsupportedHookEvents ?? [],
  }) as Detail
}

export interface Interface {
  readonly getAddons: () => Effect.Effect<AddonLoader.LoadedAddon[]>
  readonly getPaths: () => Effect.Effect<string[]>
  readonly getMcpServers: () => Effect.Effect<Record<string, AddonLoader.AddonMcpConfigInfo>>
  readonly getSkills: () => Effect.Effect<AddonSkillWithPlugin[]>
  readonly getSkillList: () => Effect.Effect<SkillListItem[]>
  readonly getSkillContent: (addonKey: string, name: string) => Effect.Effect<SkillContent, Error>
  readonly getHooks: () => Effect.Effect<Partial<Hooks>>
  readonly getMarketplaces: () => Effect.Effect<AddonLoader.Marketplace[]>
  readonly getAvailableAddons: (locale?: string) => Effect.Effect<Available[]>
  readonly invalidate: () => Effect.Effect<void>
  readonly installAddon: (input: AddonInstallInput) => Effect.Effect<AddonInstallOutcome, Error>
  readonly previewLocalArchive: (archivePath: string, locale?: string) => Effect.Effect<LocalArchivePreview, Error>
  readonly installLocalArchive: (archivePath: string) => Effect.Effect<AddonInstallOutcome, Error>
  readonly uninstallAddon: (key: string) => Effect.Effect<AddonUninstallOutcome, Error>
  readonly setAddonEnabled: (addonKey: string, enabled: boolean) => Effect.Effect<void, Error>
  readonly setMcpEnabled: (
    addonKey: string,
    name: string,
    enabled: boolean,
    options?: { removeGlobalMcp?: boolean },
  ) => Effect.Effect<void, Error>
  readonly setSkillEnabled: (addonKey: string, name: string, enabled: boolean) => Effect.Effect<void, Error>
  readonly setSkillInstalled: (addonKey: string, name: string, installed: boolean) => Effect.Effect<void, Error>
  readonly createLocalSkill: (input: SkillCreateRequest) => Effect.Effect<SkillCreateOutcome, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Addon") {}

function safeKey(key: string) {
  return createHash("sha1").update(key).digest("hex")
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

// AddonLoader patches use `undefined` to signal deletion of a plugins entry,
// which Config.Info's strict shape doesn't model. Config.updateGlobal honors
// `undefined`-as-delete on both jsonc and non-jsonc paths, so we just relax
// the type once here instead of casting at every call site.
function toConfigPatch(patch: {
  plugins?: Record<string, unknown> | undefined
  mcp?: Record<string, unknown | undefined>
}): Config.Info {
  return patch as unknown as Config.Info
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const cfgSvc = yield* Config.Service
    const state = yield* InstanceState.make<State>(
      Effect.fn("Addon.state")(function* () {
        const cfg = yield* cfgSvc.get()
        yield* Effect.tryPromise({
          try: () => cleanupLegacyDefaultMarketplace(cfg),
          catch: (error) => error,
        }).pipe(
          Effect.tapError((error) =>
            Effect.sync(() => log.warn("failed to clean up legacy default marketplace", { error })),
          ),
          Effect.orElseSucceed(() => undefined),
        )
        const paths = defaultAddonPaths(cfg)
        const marketplaces: AddonLoader.ResolvedMarketplaceInput[] = Object.entries(cfg.marketplaces ?? {}).map(
          ([name, mp]) => ({ name, root: resolveMarketplaceRoot(name, mp) }),
        )

        // 用户没显式配过名为 "personal" 的 marketplace,且默认个人目录 <data>/personal 下有
        // marketplace.json → 自动加载,使 plugin-creator skill 创建的本地插件无需 `marketplace add`
        // 即可出现在插件页「个人」分类。用户显式配了 personal 时以其配置为准(此处不覆盖)。
        if (!marketplaces.some((m) => m.name === "personal")) {
          const personalRoot = join(Global.Path.data, "personal")
          if (hasMarketplaceManifest(personalRoot)) {
            marketplaces.push({ name: "personal", root: personalRoot })
          }
        }

        const result: AddonLoader.AddonLoadResult = yield* Effect.tryPromise({
          try: () => AddonLoader.loadAddonsFromPaths(paths, { config: cfg, marketplaces }),
          catch: (error) => error,
        }).pipe(
          Effect.tapError((error) => Effect.sync(() => log.warn("failed to load addons", { error }))),
          Effect.orElseSucceed(() => ({ addons: [], errors: [], marketplaces: [] })),
        )

        if (result.errors.length) log.warn("addon loading errors", { errors: result.errors })

        // 给每个 marketplace plugin 注入 plugin.json 里的 interface 信息（logo / brandColor / displayName …）
        // 同时收集 plugin manifest 顶层 paths 摘要（has_apps / has_skills / has_hooks）。
        const enriched = yield* Effect.tryPromise({
          try: () => enrichMarketplaces(result.marketplaces),
          catch: (error) => error,
        }).pipe(
          Effect.tapError((error) => Effect.sync(() => log.warn("failed to enrich marketplaces", { error }))),
          Effect.orElseSucceed(() => ({
            marketplaces: result.marketplaces,
            summaries: new Map<string, PluginManifestSummary>(),
          })),
        )

        // 已安装 addon 的 logo/composerIcon 读成 data URI（sideload / registry 安装的也能显示图标）。
        const addonAssets = yield* Effect.tryPromise({
          try: () => enrichAddonAssets(result.addons, enriched.marketplaces),
          catch: (error) => error,
        }).pipe(
          Effect.tapError((error) => Effect.sync(() => log.warn("failed to enrich addon assets", { error }))),
          Effect.orElseSucceed(() => new Map() as AddonAssets),
        )

        return {
          paths,
          addons: result.addons,
          mcpServers: Object.assign(
            {},
            ...result.addons.filter((addon) => !addon.disabled).map((addon) => addon.mcpServers ?? {}),
          ),
          marketplaces: enriched.marketplaces,
          manifestSummaries: enriched.summaries,
          addonAssets,
        }
      }),
    )
    const unregisterInvalidator = registerAddonCapabilityInvalidator(() => InstanceState.invalidateAll(state))
    yield* Effect.addFinalizer(() => Effect.sync(unregisterInvalidator))

    const getAddons = Effect.fn("Addon.getAddons")(function* () {
      return yield* InstanceState.use(state, (s) => s.addons)
    })

    const getPaths = Effect.fn("Addon.getPaths")(function* () {
      return yield* InstanceState.use(state, (s) => s.paths)
    })

    const getMcpServers = Effect.fn("Addon.getMcpServers")(function* () {
      return yield* InstanceState.use(state, (s) => s.mcpServers)
    })

    const getSkills = Effect.fn("Addon.getSkills")(function* () {
      const addons = yield* InstanceState.use(state, (s) => s.addons)
      const cfg = yield* cfgSvc.get()
      const result: AddonSkillWithPlugin[] = []
      for (const addon of addons) {
        if (addon.disabled) continue
        const disabled = new Set(AddonLoader.disabledSkillNames(cfg, addon.addonId))
        for (const skill of addon.skills ?? []) {
          if (disabled.has(skill.name)) continue
          result.push({
            addonName: addon.addonId.addonName,
            namespacedName: AddonLoader.addonSkillName(addon.addonId, skill.name),
            skill,
          })
        }
      }
      return result
    })

    const getSkillList = Effect.fn("Addon.getSkillList")(function* () {
      const s = yield* InstanceState.use(state, (st) => st)
      const cfg = yield* cfgSvc.get()
      const overrideIndex = new Map<
        string,
        { category?: string; logo?: string; brandColor?: string; displayName?: string }
      >()
      for (const m of s.marketplaces) {
        for (const p of m.plugins) {
          overrideIndex.set(`${p.name}@${m.name}`, {
            category: p.category ?? p.interface?.category,
            logo: p.interface?.logo,
            brandColor: p.interface?.brandColor,
            displayName: p.interface?.displayName,
          })
        }
      }
      const result: SkillListItem[] = []
      for (const addon of s.addons) {
        if (addon.disabled) continue
        const addonKey = AddonLoader.addonKey(addon.addonId)
        const disabled = new Set(AddonLoader.disabledSkillNames(cfg, addon.addonId))
        const meta = overrideIndex.get(addonKey)
        const ownIface = addon.manifest.interfaceInfo
        // marketplace 没声明（registry/sideload 安装）时，回退到 addon 自身：logo 用 addonAssets 的
        // data URI（包内相对路径渲染不出），分类/品牌色/展示名用自身 interface —— 与 marketplace 技能一致。
        for (const skill of addon.skills ?? []) {
          result.push(
            compactObject({
              namespaced_name: AddonLoader.addonSkillName(addon.addonId, skill.name),
              name: skill.name,
              display_name: skill.displayName,
              description: skill.description,
              location: skill.location,
              enabled: !disabled.has(skill.name),
              addon_key: addonKey,
              addon_name: addon.addonId.addonName,
              addon_display_name: meta?.displayName ?? ownIface?.displayName,
              marketplace_name: addon.addonId.marketplaceName,
              category: meta?.category ?? ownIface?.category,
              logo: meta?.logo ?? s.addonAssets.get(addonKey)?.logo,
              brand_color: meta?.brandColor ?? ownIface?.brandColor,
            }) as SkillListItem,
          )
        }
      }
      const personal = yield* Effect.tryPromise({
        try: () => loadPersonalSkillItems(cfg),
        catch: asError,
      }).pipe(
        Effect.tapError((error) => Effect.sync(() => log.warn("failed to load personal skills", { error }))),
        Effect.orElseSucceed(() => [] as SkillListItem[]),
      )
      return [...result, ...personal]
    })

    const getSkillContent = Effect.fn("Addon.getSkillContent")(function* (addonKey: string, name: string) {
      if (addonKey === PERSONAL_SKILLS_ADDON_KEY) {
        const cfg = yield* cfgSvc.getGlobal()
        const items = yield* Effect.tryPromise({
          try: () => loadPersonalSkillItems(cfg),
          catch: asError,
        })
        const item = items.find((candidate) => candidate.name === name)
        if (!item) return yield* Effect.fail(new SkillNotFoundError(`${addonKey}:${name}`))
        const content = yield* Effect.tryPromise({
          try: () => readFile(item.location, "utf-8"),
          catch: asError,
        })
        return { addon_key: addonKey, name: item.name, content } satisfies SkillContent
      }
      const addonId = yield* Effect.try({
        try: () => AddonLoader.parseAddonKey(addonKey),
        catch: asError,
      })
      const addons = yield* InstanceState.use(state, (s) => s.addons)
      const addon = addons.find((a) => AddonLoader.addonIdEquals(a.addonId, addonId))
      const skill = addon?.skills?.find((candidate) => candidate.name === name)
      if (!addon || addon.disabled || !skill) {
        return yield* Effect.fail(new SkillNotFoundError(`${addonKey}:${name}`))
      }
      const content = yield* Effect.tryPromise({
        try: () => readFile(skill.location, "utf-8"),
        catch: asError,
      })
      return { addon_key: addonKey, name: skill.name, content } satisfies SkillContent
    })

    const getHooks = Effect.fn("Addon.getHooks")(function* () {
      const addons = yield* InstanceState.use(state, (s) => s.addons)
      let result: AddonLoader.AddonHooksResult = { hooks: {}, unsupportedEvents: [] }
      for (const addon of addons) {
        if (addon.disabled || !addon.hooks) continue
        result = mergeResults(result, { hooks: addon.hooks, unsupportedEvents: [] })
      }
      return result.hooks
    })

    const getMarketplaces = Effect.fn("Addon.getMarketplaces")(function* () {
      return yield* InstanceState.use(state, (s) => s.marketplaces)
    })

    const getAvailableAddons = Effect.fn("Addon.getAvailableAddons")(function* (locale?: string) {
      const s = yield* InstanceState.use(state, (st) => st)
      const list = toAvailableList(s.addons, s.marketplaces, s.manifestSummaries, s.addonAssets, locale)
      // 部分第三方 marketplace 插件依赖 ChatGPT connector(.app.json),
      // 真实工作流: Codex 起一个 host-owned MCP server 连 chatgpt.com/backend-api/wham/apps
      // + bearer ChatGPT access_token,把用户 ChatGPT 账号下已授权的 connector 当 tool 暴露。
      // 我们没接 ChatGPT auth 体系,这些插件装上也用不了,先按 manifest_apps 非空过滤掉。
      // 已安装的保留(用户能进详情卸载),sideload addon 同样保留。
      return list.filter((item) => item.installed || (item.manifest_apps?.length ?? 0) === 0)
    })

    const invalidate = Effect.fn("Addon.invalidate")(function* () {
      yield* InstanceState.invalidate(state)
    })

    const installAddon = Effect.fn("Addon.installAddon")(function* (input: AddonInstallInput) {
      if (input.registryNamespace) {
        return yield* Effect.fail(new NamespacedMarketplaceInstallError(AddonLoader.addonKey(input)))
      }
      const cfg = yield* cfgSvc.getGlobal()
      const mpCfg = cfg.marketplaces?.[input.marketplaceName]
      // 优先用用户显式配置；没有时回退到已加载 state.marketplaces，覆盖隐式默认 clone
      // （marketplace.json 自报 name 如 "openai-curated" 与 cfg key 不一定一致）。
      let marketplaceRoot: string | undefined
      if (mpCfg) {
        marketplaceRoot = resolveMarketplaceRoot(input.marketplaceName, mpCfg)
      } else {
        const loaded = yield* InstanceState.use(state, (s) =>
          s.marketplaces.find((m) => m.name === input.marketplaceName),
        )
        if (loaded) marketplaceRoot = loaded.root
      }
      if (!marketplaceRoot) {
        return yield* Effect.fail(
          new MarketplaceNotConfiguredError(input.marketplaceName, Object.keys(cfg.marketplaces ?? {})),
        )
      }
      const entry = yield* Effect.tryPromise({
        try: () => AddonLoader.findInstallableAddonInMarketplace(marketplaceRoot, input.addonName),
        catch: asError,
      })

      const cacheRoot = addonsCacheRoot()
      const stagingRoot = addonsStagingRoot()
      const lockKey = `addon-install-${safeKey(AddonLoader.addonKey(entry.addonId))}`

      const result = yield* Effect.tryPromise({
        try: () =>
          Flock.withLock(lockKey, async () => {
            await mkdir(stagingRoot, { recursive: true })
            await mkdir(cacheRoot, { recursive: true })
            const materialized = await AddonLoader.materializeAddonSource({
              source: entry.source,
              stagingRoot,
            })
            try {
              return await AddonLoader.installAddonToCache({
                sourcePath: materialized.path,
                addonId: entry.addonId,
                cacheRoot,
              })
            } finally {
              await materialized.cleanup()
            }
          }),
        catch: asError,
      })

      const key = AddonLoader.addonKey(entry.addonId)
      yield* cfgSvc.updateGlobal(toConfigPatch(AddonLoader.setAddonEnabled(entry.addonId, true)))
      // Drop our cached LoadedAddon[] so the next getAddons() picks up the
      // freshly-installed cache entry and the updated `plugins` config.
      yield* InstanceState.invalidate(state)
      return {
        key,
        version: result.version,
        installedPath: result.installedPath,
        authPolicy: entry.policy.authentication,
      }
    })

    const installLocalArchive = Effect.fn("Addon.installLocalArchive")(function* (archivePath: string) {
      const stagingRoot = addonsStagingRoot()
      const cacheRoot = addonsCacheRoot()
      const materialized = yield* Effect.tryPromise({
        try: async () => {
          await mkdir(stagingRoot, { recursive: true })
          return AddonLoader.materializeLocalAddonArchive({ archivePath, stagingRoot })
        },
        catch: asError,
      })

      const result = yield* Effect.tryPromise({
        try: async () => {
          try {
            const manifestPath = AddonLoader.findManifestPath(materialized.path)
            if (!manifestPath) {
              throw new AddonLoader.LocalAddonArchiveError("local addon archive does not contain a plugin manifest")
            }
            const manifest = JSON.parse(await readFile(manifestPath, "utf-8")) as { name?: unknown }
            if (typeof manifest.name !== "string" || !manifest.name.trim()) {
              throw new AddonLoader.LocalAddonArchiveError('local addon manifest must define a non-empty "name"')
            }
            const addonId = { addonName: manifest.name, marketplaceName: "personal" }
            return await Flock.withLock(`addon-install-${safeKey(AddonLoader.addonKey(addonId))}`, async () => {
              await mkdir(cacheRoot, { recursive: true })
              const installed = await AddonLoader.installAddonToCache({
                sourcePath: materialized.path,
                addonId,
                cacheRoot,
              })
              return { addonId, installed }
            })
          } finally {
            await materialized.cleanup()
          }
        },
        catch: asError,
      })

      yield* cfgSvc.updateGlobal(toConfigPatch(AddonLoader.setAddonEnabled(result.addonId, true)))
      yield* InstanceState.invalidate(state)
      return {
        key: AddonLoader.addonKey(result.addonId),
        version: result.installed.version,
        installedPath: result.installed.installedPath,
        authPolicy: "ON_USE" as const,
      }
    })

    const previewLocalArchive = Effect.fn("Addon.previewLocalArchive")(function* (archivePath: string, locale?: string) {
      const stagingRoot = addonsStagingRoot()
      const materialized = yield* Effect.tryPromise({
        try: async () => {
          await mkdir(stagingRoot, { recursive: true })
          return AddonLoader.materializeLocalAddonArchive({ archivePath, stagingRoot })
        },
        catch: asError,
      })

      return yield* Effect.tryPromise({
        try: async () => {
          try {
            const manifestPath = AddonLoader.findManifestPath(materialized.path)
            if (!manifestPath) {
              throw new AddonLoader.LocalAddonArchiveError("local addon archive does not contain a plugin manifest")
            }
            const rawText = await readFile(manifestPath, "utf-8")
            const raw = (() => {
              try {
                return JSON.parse(rawText) as { name?: unknown }
              } catch {
                throw new AddonLoader.LocalAddonArchiveError("local addon manifest is invalid")
              }
            })()
            if (typeof raw.name !== "string" || !raw.name.trim()) {
              throw new AddonLoader.LocalAddonArchiveError('local addon manifest must define a non-empty "name"')
            }
            const manifest = await AddonLoader.parseManifest(materialized.path, manifestPath)
            if (!manifest) {
              throw new AddonLoader.LocalAddonArchiveError("local addon manifest is invalid")
            }
            const loaded = await loadPluginInterface(materialized.path)
            const iface = loaded?.interface ?? manifest.interfaceInfo
            const summary = loaded?.summary
            const localized = localizeInterface(
              {
                displayName: iface?.displayName,
                shortDescription: iface?.shortDescription,
                longDescription: iface?.longDescription,
                defaultPrompt: iface?.defaultPrompt,
              },
              iface?.locales,
              locale,
            )
            const addonId = { addonName: manifest.name, marketplaceName: "personal" }
            const logo = iface?.logo ? await readLogoAsDataUri(materialized.path, iface.logo) : undefined
            const composerIcon = iface?.composerIcon
              ? await readLogoAsDataUri(materialized.path, iface.composerIcon)
              : undefined
            return compactObject({
              key: AddonLoader.addonKey(addonId),
              name: manifest.name,
              version: manifest.version,
              display_name: localized.displayName,
              description: localized.shortDescription ?? localized.longDescription ?? manifest.description,
              marketplace_name: "personal",
              category: iface?.category,
              keywords: manifest.keywords,
              installation: "AVAILABLE" as const,
              installed: false,
              logo,
              composer_icon: composerIcon,
              brand_color: iface?.brandColor,
              long_description: localized.longDescription,
              developer_name: iface?.developerName,
              capabilities: iface?.capabilities?.length ? [...iface.capabilities] : undefined,
              website_url: iface?.websiteUrl,
              privacy_policy_url: iface?.privacyPolicyUrl,
              terms_of_service_url: iface?.termsOfServiceUrl,
              default_prompt: normalizeDefaultPrompt(localized.defaultPrompt),
              screenshots: iface?.screenshots?.length ? [...iface.screenshots] : undefined,
              manifest_apps: summary?.apps?.length ? summary.apps : undefined,
              manifest_mcp_servers: summary?.mcp_servers?.length ? summary.mcp_servers : undefined,
              manifest_skills: summary?.skills?.length ? summary.skills : undefined,
              has_hooks: summary?.has_hooks ? true : undefined,
            }) as LocalArchivePreview
          } finally {
            await materialized.cleanup()
          }
        },
        catch: asError,
      })
    })

    const uninstallAddon = Effect.fn("Addon.uninstallAddon")(function* (key: string) {
      const addonId = yield* Effect.try({
        try: () => AddonLoader.parseAddonKey(key),
        catch: asError,
      })
      const cacheRoot = addonsCacheRoot()
      const lockKey = `addon-install-${safeKey(AddonLoader.addonKey(addonId))}`
      yield* Effect.tryPromise({
        try: () =>
          Flock.withLock(lockKey, async () => {
            await AddonLoader.uninstallAddonFromCache({ addonId, cacheRoot })
          }),
        catch: asError,
      })
      yield* cfgSvc.updateGlobal(toConfigPatch(AddonLoader.clearAddon(addonId)))
      // Drop our cached LoadedAddon[] so the next getAddons() reflects the
      // removed cache entry.
      yield* InstanceState.invalidate(state)
      return { key: AddonLoader.addonKey(addonId) }
    })

    const setAddonEnabled = Effect.fn("Addon.setAddonEnabled")(function* (addonKey: string, enabled: boolean) {
      const addonId = yield* Effect.try({
        try: () => AddonLoader.parseAddonKey(addonKey),
        catch: asError,
      })
      const addons = yield* InstanceState.use(state, (s) => s.addons)
      const addon = addons.find((a) => AddonLoader.addonIdEquals(a.addonId, addonId))
      if (!addon) {
        return yield* Effect.fail(new AddonNotFoundError(addonKey))
      }
      yield* cfgSvc.updateGlobal(toConfigPatch(AddonLoader.setAddonEnabled(addonId, enabled)))
      yield* InstanceState.invalidate(state)
    })

    const setMcpEnabled = Effect.fn("Addon.setMcpEnabled")(function* (
      addonKey: string,
      name: string,
      enabled: boolean,
      options?: { removeGlobalMcp?: boolean },
    ) {
      const addonId = yield* Effect.try({
        try: () => AddonLoader.parseAddonKey(addonKey),
        catch: asError,
      })
      const addons = yield* InstanceState.use(state, (s) => s.addons)
      const addon = addons.find((a) => AddonLoader.addonIdEquals(a.addonId, addonId))
      if (!addon || !Object.hasOwn(addon.mcpServers ?? {}, name)) {
        return yield* Effect.fail(new McpNotFoundError(`${addonKey}:${name}`))
      }
      yield* cfgSvc.updateGlobal(
        toConfigPatch({
          ...AddonLoader.setMcpEnabled(addon.addonId, name, enabled),
          ...(options?.removeGlobalMcp ? { mcp: { [name]: undefined } } : {}),
        }),
      )
      yield* InstanceState.invalidateAll(state)
    })

    const setSkillEnabled = Effect.fn("Addon.setSkillEnabled")(function* (
      addonKey: string,
      name: string,
      enabled: boolean,
    ) {
      if (addonKey === PERSONAL_SKILLS_ADDON_KEY) {
        const cfg = yield* cfgSvc.getGlobal()
        const items = yield* Effect.tryPromise({
          try: () => loadPersonalSkillItems(cfg),
          catch: asError,
        })
        const item = items.find((candidate) => candidate.name === name)
        if (!item) {
          return yield* Effect.fail(new SkillNotFoundError(`${addonKey}:${name}`))
        }
        yield* Effect.tryPromise({
          try: async () => {
            if (enabled) {
              await writeFile(join(dirname(item.location), PERSONAL_SKILL_INSTALL_MARKER), "", "utf-8")
              return
            }
          },
          catch: asError,
        })
        yield* cfgSvc.updateGlobal(withPersonalSkillPath(cfg, dirname(item.location), enabled))
        yield* cfgSvc.updateGlobal(
          toConfigPatch(
            AddonLoader.setSkillEnabled(
              PERSONAL_SKILLS_ADDON_ID,
              item.name,
              enabled,
              cfg.plugins?.[PERSONAL_SKILLS_ADDON_KEY],
            ),
          ),
        )
        yield* InstanceState.invalidate(state)
        return
      }
      const addonId = yield* Effect.try({
        try: () => AddonLoader.parseAddonKey(addonKey),
        catch: asError,
      })
      const addons = yield* InstanceState.use(state, (s) => s.addons)
      const addon = addons.find((a) => AddonLoader.addonIdEquals(a.addonId, addonId))
      if (!addon || !(addon.skills ?? []).some((s) => s.name === name)) {
        return yield* Effect.fail(new SkillNotFoundError(`${addonKey}:${name}`))
      }
      const cfg = yield* cfgSvc.getGlobal()
      const existing = cfg.plugins?.[AddonLoader.addonKey(addonId)]
      yield* cfgSvc.updateGlobal(toConfigPatch(AddonLoader.setSkillEnabled(addonId, name, enabled, existing)))
      yield* InstanceState.invalidate(state)
    })

    const setSkillInstalled = Effect.fn("Addon.setSkillInstalled")(function* (
      addonKey: string,
      name: string,
      installed: boolean,
    ) {
      if (addonKey !== PERSONAL_SKILLS_ADDON_KEY) {
        return yield* Effect.fail(new SkillNotFoundError(`${addonKey}:${name}`))
      }
      const cfg = yield* cfgSvc.getGlobal()
      const items = yield* Effect.tryPromise({
        try: () => loadPersonalSkillItems(cfg),
        catch: asError,
      })
      const item = items.find((candidate) => candidate.name === name)
      if (!item) {
        return yield* Effect.fail(new SkillNotFoundError(`${addonKey}:${name}`))
      }
      yield* Effect.tryPromise({
        try: async () => {
          if (installed) {
            await writeFile(join(dirname(item.location), PERSONAL_SKILL_INSTALL_MARKER), "", "utf-8")
            return
          }
          await rm(join(dirname(item.location), PERSONAL_SKILL_INSTALL_MARKER), { force: true })
        },
        catch: asError,
      })
      yield* cfgSvc.updateGlobal(withPersonalSkillPath(cfg, dirname(item.location), installed))
      yield* cfgSvc.updateGlobal(
        toConfigPatch(
          AddonLoader.setSkillEnabled(
            PERSONAL_SKILLS_ADDON_ID,
            item.name,
            true,
            cfg.plugins?.[PERSONAL_SKILLS_ADDON_KEY],
          ),
        ),
      )
      yield* InstanceState.invalidate(state)
    })

    const createLocalSkill = Effect.fn("Addon.createLocalSkill")(function* (input: SkillCreateRequest) {
      const skillName = input.name.trim()
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(skillName)) {
        return yield* Effect.fail(new InvalidSkillNameError(skillName))
      }
      const description = input.description.trim()
      if (!description) {
        return yield* Effect.fail(new InvalidSkillNameError("description required"))
      }
      const addonId = yield* Effect.try({
        try: () => AddonLoader.parseAddonKey(input.addon_key),
        catch: asError,
      })
      const addons = yield* InstanceState.use(state, (s) => s.addons)
      const addon = addons.find((a) => AddonLoader.addonIdEquals(a.addonId, addonId))
      if (!addon) {
        return yield* Effect.fail(new SkillNotFoundError(input.addon_key))
      }
      const skillsRoot = join(addon.root, "skills")
      const skillDir = join(skillsRoot, skillName)
      const skillFile = join(skillDir, "SKILL.md")
      if (existsSync(skillFile)) {
        return yield* Effect.fail(new SkillAlreadyExistsError(`${input.addon_key}:${skillName}`))
      }
      const frontmatterLines = [`name: ${skillName}`, `description: ${description}`]
      if (input.display_name) frontmatterLines.push(`displayName: ${input.display_name}`)
      const body = (input.content ?? "").trim()
      const md = `---\n${frontmatterLines.join("\n")}\n---\n\n${body || `# ${input.display_name ?? skillName}\n`}\n`
      yield* Effect.tryPromise({
        try: async () => {
          await mkdir(skillDir, { recursive: true })
          await writeFile(skillFile, md, "utf-8")
        },
        catch: asError,
      })
      yield* InstanceState.invalidate(state)
      return {
        namespaced_name: AddonLoader.addonSkillName(addon.addonId, skillName),
        location: skillFile,
      }
    })

    return Service.of({
      getAddons,
      getPaths,
      getMcpServers,
      getSkills,
      getSkillList,
      getSkillContent,
      getHooks,
      getMarketplaces,
      getAvailableAddons,
      invalidate,
      installAddon,
      previewLocalArchive,
      installLocalArchive,
      uninstallAddon,
      setAddonEnabled,
      setMcpEnabled,
      setSkillEnabled,
      setSkillInstalled,
      createLocalSkill,
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Config.defaultLayer))

export * as Addon from "."
