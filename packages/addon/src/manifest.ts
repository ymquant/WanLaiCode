import { existsSync } from "fs"
import { readFile } from "fs/promises"
import { basename, isAbsolute, resolve } from "path"
import { Schema } from "effect"

const HookInlineObject = Schema.Struct({
  path: Schema.String,
  events: Schema.Array(Schema.String).pipe(Schema.optional),
  matcher: Schema.String.pipe(Schema.optional),
})

export const RawCodexPluginManifest = Schema.Struct({
  name: Schema.String.pipe(Schema.optional),
  version: Schema.String.pipe(Schema.optional),
  description: Schema.String.pipe(Schema.optional),
  keywords: Schema.Array(Schema.String).pipe(Schema.optional),
  skills: Schema.String.pipe(Schema.optional),
  mcpServers: Schema.String.pipe(Schema.optional),
  apps: Schema.String.pipe(Schema.optional),
  composerIcon: Schema.String.pipe(Schema.optional),
  hooks: Schema.optional(
    Schema.Union([Schema.String, Schema.Array(Schema.String), HookInlineObject, Schema.Array(HookInlineObject)]),
  ),
  // 发布格式（publishing.md）的 plugin.json 用 `interface` key（非 `interfaceInfo`）。
  // marketplace 路径的 loadPluginInterface 也是读 `interface`；这里对齐，否则已安装 addon 的
  // interfaceInfo 永远为空（logo/composerIcon/displayName 等读不到）。
  interface: Schema.Struct({
    displayName: Schema.String.pipe(Schema.optional),
    shortDescription: Schema.String.pipe(Schema.optional),
    longDescription: Schema.String.pipe(Schema.optional),
    developerName: Schema.String.pipe(Schema.optional),
    category: Schema.String.pipe(Schema.optional),
    capabilities: Schema.Array(Schema.String).pipe(Schema.optional),
    websiteURL: Schema.String.pipe(Schema.optional),
    websiteUrl: Schema.String.pipe(Schema.optional),
    privacyPolicyURL: Schema.String.pipe(Schema.optional),
    privacyPolicyUrl: Schema.String.pipe(Schema.optional),
    termsOfServiceURL: Schema.String.pipe(Schema.optional),
    termsOfServiceUrl: Schema.String.pipe(Schema.optional),
    defaultPrompt: Schema.optional(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
    brandColor: Schema.String.pipe(Schema.optional),
    logo: Schema.String.pipe(Schema.optional),
    composerIcon: Schema.String.pipe(Schema.optional),
    screenshots: Schema.Array(Schema.String).pipe(Schema.optional),
    defaultLocale: Schema.String.pipe(Schema.optional),
    locales: Schema.Record(
      Schema.String,
      Schema.Struct({
        displayName: Schema.String.pipe(Schema.optional),
        shortDescription: Schema.String.pipe(Schema.optional),
        longDescription: Schema.String.pipe(Schema.optional),
        defaultPrompt: Schema.optional(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
      }),
    ).pipe(Schema.optional),
  }).pipe(Schema.optional),
})
export type RawCodexPluginManifest = Schema.Schema.Type<typeof RawCodexPluginManifest>

export interface AddonManifestPaths {
  skills?: string
  mcpServers?: string
  apps?: string
  composerIcon?: string
  hooks?: unknown
}

export interface AddonInterfaceInfo {
  displayName?: string
  shortDescription?: string
  longDescription?: string
  developerName?: string
  category?: string
  capabilities?: string[]
  websiteUrl?: string
  privacyPolicyUrl?: string
  termsOfServiceUrl?: string
  defaultPrompt?: string[]
  brandColor?: string
  logo?: string
  // 小尺寸 composer / chip 用图标 —— 通常是单色 SVG,与 logo(品牌全彩 PNG)区分。
  // 例: cloudflare/.codex-plugin/plugin.json -> composerIcon: "./assets/cloudflare-small.svg"
  composerIcon?: string
  screenshots?: string[]
  // 其他语言的名称/描述（BCP-47 locale → 译文）。顶层字段为 defaultLocale 内容；
  // 这里承载非默认语言，供按应用语言协商展示。
  locales?: Record<
    string,
    { displayName?: string; shortDescription?: string; longDescription?: string; defaultPrompt?: string[] }
  >
  defaultLocale?: string
}

export interface AddonManifest {
  name: string
  version?: string
  description?: string
  keywords?: string[]
  paths: AddonManifestPaths
  interfaceInfo?: AddonInterfaceInfo
}

const MANIFEST_CANDIDATES = [
  // 发布规范（publishing.md §3.2）规定清单位于 .wanlaicode-plugin/；优先识别它。
  // 保留 .codex-plugin/ 以兼容历史包。
  ".wanlaicode-plugin/plugin.json",
  ".codex-plugin/plugin.json",
] as const

function validateRelativePath(p: string, fieldName: string): void {
  if (p.startsWith("/") || p.startsWith("~")) {
    throw new Error(`${fieldName}: absolute paths are not allowed: ${p}`)
  }
  const segments = p.split("/")
  for (const seg of segments) {
    if (seg === "..") {
      throw new Error(`${fieldName}: path traversal (..) is not allowed: ${p}`)
    }
  }
}

function validateHooksPaths(hooks: unknown): void {
  if (!hooks) return

  const checkInline = (obj: unknown, idx: string) => {
    if (obj && typeof obj === "object" && "path" in obj) {
      validateRelativePath((obj as { path: string }).path, `hooks[${idx}].path`)
    }
  }

  if (typeof hooks === "string") {
    validateRelativePath(hooks, "hooks")
    return
  }

  if (Array.isArray(hooks)) {
    for (let i = 0; i < hooks.length; i++) {
      const item = hooks[i]
      if (typeof item === "string") {
        validateRelativePath(item, `hooks[${i}]`)
      } else {
        checkInline(item, String(i))
      }
    }
  } else if (typeof hooks === "object") {
    checkInline(hooks, "0")
  }
}

export function findManifestPath(addonRoot: string): string | null {
  for (const candidate of MANIFEST_CANDIDATES) {
    const fullPath = `${addonRoot}/${candidate}`
    if (existsSync(fullPath)) {
      return fullPath
    }
  }
  return null
}

// 给定 plugin manifest 里的 `apps` 字段(指向另一份 JSON 的相对/绝对路径),返回 app key 列表。
// 任意 IO / parse 失败返回空数组 —— 等价"未声明 apps",与历史行为一致。
export async function readAppNamesFromAppsFile(pluginRoot: string, appsRel: string): Promise<string[]> {
  const appsPath = isAbsolute(appsRel) ? appsRel : resolve(pluginRoot, appsRel)
  try {
    const raw = JSON.parse(await readFile(appsPath, "utf-8")) as { apps?: Record<string, unknown> }
    return Object.keys(raw.apps ?? {})
  } catch {
    return []
  }
}

// 读 plugin 目录的 manifest → 解析 `apps` 字段 → 读出 app key 列表。standalone 用(bundle 脚本),
// 调用方已经持有解析后的 manifest 时改用 readAppNamesFromAppsFile 省一次 IO。
//
// "apps" 非空 ⇔ 插件依赖 ChatGPT connector(host-owned MCP server → chatgpt.com/backend-api),
// 我们没接 ChatGPT auth 体系,装上也跑不起来 —— 构建期 (script/bundle-marketplace.ts) 和运行时
// 可见列表过滤 (packages/opencode/src/addon/index.ts:getAvailableAddons) 共用此判定,防止两侧 drift。
export async function readPluginAppNames(pluginDir: string): Promise<string[]> {
  const manifestPath = findManifestPath(pluginDir)
  if (!manifestPath) return []
  let appsRel: string
  try {
    const raw = JSON.parse(await readFile(manifestPath, "utf-8")) as { apps?: unknown }
    if (typeof raw.apps !== "string" || !raw.apps) return []
    appsRel = raw.apps
  } catch {
    return []
  }
  return readAppNamesFromAppsFile(pluginDir, appsRel)
}

export async function parseManifest(addonRoot: string, manifestPath?: string): Promise<AddonManifest | null> {
  const resolvedPath = manifestPath ?? findManifestPath(addonRoot)
  if (!resolvedPath) return null

  let content: string
  try {
    content = await readFile(resolvedPath, "utf-8")
  } catch {
    return null
  }

  try {
    const raw = JSON.parse(content)
    const decoded = Schema.decodeUnknownSync(RawCodexPluginManifest)(raw)

    if (decoded.skills !== undefined) validateRelativePath(decoded.skills, "skills")
    if (decoded.mcpServers !== undefined) validateRelativePath(decoded.mcpServers, "mcpServers")
    if (decoded.apps !== undefined) validateRelativePath(decoded.apps, "apps")
    if (decoded.composerIcon !== undefined) validateRelativePath(decoded.composerIcon, "composerIcon")
    validateHooksPaths(decoded.hooks)

    const dirName = basename(addonRoot).replace(/^@/, "")
    const name = decoded.name || dirName || "unknown"

    let interfaceInfo: AddonInterfaceInfo | undefined
    if (decoded.interface) {
      const info = decoded.interface
      let defaultPrompt: string[] | undefined
      if (info.defaultPrompt !== undefined) {
        const arr = typeof info.defaultPrompt === "string" ? [info.defaultPrompt] : [...info.defaultPrompt]
        defaultPrompt = arr.slice(0, 3).map((s) => s.slice(0, 128))
      }
      interfaceInfo = {
        displayName: info.displayName,
        shortDescription: info.shortDescription,
        longDescription: info.longDescription,
        developerName: info.developerName,
        category: info.category,
        capabilities: info.capabilities ? [...info.capabilities] : undefined,
        websiteUrl: info.websiteURL ?? info.websiteUrl,
        privacyPolicyUrl: info.privacyPolicyURL ?? info.privacyPolicyUrl,
        termsOfServiceUrl: info.termsOfServiceURL ?? info.termsOfServiceUrl,
        defaultPrompt,
        brandColor: info.brandColor,
        logo: info.logo,
        composerIcon: info.composerIcon,
        screenshots: info.screenshots ? [...info.screenshots] : undefined,
        defaultLocale: info.defaultLocale,
        locales: info.locales
          ? Object.fromEntries(
              Object.entries(info.locales).map(([k, v]) => [
                k,
                {
                  displayName: v.displayName,
                  shortDescription: v.shortDescription,
                  longDescription: v.longDescription,
                  defaultPrompt:
                    v.defaultPrompt === undefined
                      ? undefined
                      : (typeof v.defaultPrompt === "string" ? [v.defaultPrompt] : [...v.defaultPrompt])
                          .slice(0, 3)
                          .map((s) => s.slice(0, 128)),
                },
              ]),
            )
          : undefined,
      }
    }

    return {
      name,
      version: decoded.version,
      description: decoded.description,
      keywords: decoded.keywords ? [...decoded.keywords] : undefined,
      paths: {
        skills: decoded.skills,
        mcpServers: decoded.mcpServers,
        apps: decoded.apps,
        composerIcon: decoded.composerIcon,
        hooks: decoded.hooks,
      },
      interfaceInfo,
    }
  } catch (err) {
    console.warn(`[addon] manifest validation failed for ${resolvedPath}:`, err)
    return null
  }
}
