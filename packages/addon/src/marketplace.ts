import { existsSync } from "fs"
import { readFile } from "fs/promises"
import path from "path"
import type { AddonInterfaceInfo } from "./manifest"
import type { AddonId } from "./user-config"

const MARKETPLACE_MANIFEST_RELATIVE_PATHS = [
  ".agents/plugins/marketplace.json",
  ".claude-plugin/marketplace.json",
] as const

export type MarketplacePluginInstallPolicy = "NOT_AVAILABLE" | "AVAILABLE" | "INSTALLED_BY_DEFAULT"
export type MarketplacePluginAuthPolicy = "ON_INSTALL" | "ON_USE"

const VALID_INSTALL_POLICY: MarketplacePluginInstallPolicy[] = ["NOT_AVAILABLE", "AVAILABLE", "INSTALLED_BY_DEFAULT"]
const VALID_AUTH_POLICY: MarketplacePluginAuthPolicy[] = ["ON_INSTALL", "ON_USE"]

export interface MarketplacePluginPolicy {
  installation: MarketplacePluginInstallPolicy
  authentication: MarketplacePluginAuthPolicy
  products?: string[]
}

export type MarketplacePluginSource =
  | { type: "local"; path: string }
  | { type: "git"; url: string; subdir?: string; ref?: string; sha?: string }
  | { type: "remote-tar"; url: string; strip?: number }

export interface MarketplaceInterface {
  displayName?: string
}

export interface MarketplacePlugin {
  name: string
  source: MarketplacePluginSource
  policy: MarketplacePluginPolicy
  category?: string
  interface?: AddonInterfaceInfo
  keywords?: string[]
}

export interface Marketplace {
  name: string
  manifestPath: string
  root: string
  interface?: MarketplaceInterface
  plugins: MarketplacePlugin[]
  unsupportedPlugins: Array<{ name?: string; reason: string }>
}

export class MarketplaceParseError extends Error {
  constructor(
    public readonly manifestPath: string,
    message: string,
  ) {
    super(`${manifestPath}: ${message}`)
    this.name = "MarketplaceParseError"
  }
}

export class AddonNotFoundInMarketplaceError extends Error {
  constructor(
    public readonly addonName: string,
    public readonly marketplaceName: string,
  ) {
    super(`addon "${addonName}" not found in marketplace "${marketplaceName}"`)
    this.name = "AddonNotFoundInMarketplaceError"
  }
}

export class AddonInstallNotAvailableError extends Error {
  constructor(
    public readonly addonName: string,
    public readonly marketplaceName: string,
  ) {
    super(`addon "${addonName}" in marketplace "${marketplaceName}" is not available for install`)
    this.name = "AddonInstallNotAvailableError"
  }
}

export interface InstallableAddonEntry {
  addonId: AddonId
  source: MarketplacePluginSource
  policy: MarketplacePluginPolicy
}

export async function findInstallableAddonInMarketplace(
  marketplaceRoot: string,
  addonName: string,
): Promise<InstallableAddonEntry> {
  const manifestPath = findMarketplaceManifestPath(marketplaceRoot)
  if (!manifestPath) {
    throw new MarketplaceParseError(marketplaceRoot, "marketplace manifest not found")
  }
  const marketplace = await loadMarketplace(manifestPath)
  const entry = marketplace.plugins.find((p) => p.name === addonName)
  if (!entry) throw new AddonNotFoundInMarketplaceError(addonName, marketplace.name)
  if (entry.policy.installation === "NOT_AVAILABLE") {
    throw new AddonInstallNotAvailableError(addonName, marketplace.name)
  }
  return {
    addonId: { addonName: entry.name, marketplaceName: marketplace.name },
    source: entry.source,
    policy: entry.policy,
  }
}

export function findMarketplaceManifestPath(root: string): string | null {
  for (const rel of MARKETPLACE_MANIFEST_RELATIVE_PATHS) {
    const full = path.join(root, rel)
    if (existsSync(full)) return full
  }
  return null
}

export function marketplaceRootFromManifestPath(manifestPath: string): string {
  const abs = path.resolve(manifestPath)
  for (const rel of MARKETPLACE_MANIFEST_RELATIVE_PATHS) {
    const segs = rel.split("/")
    let cur = abs
    let ok = true
    for (let i = segs.length - 1; i >= 0; i--) {
      if (path.basename(cur) !== segs[i]) {
        ok = false
        break
      }
      cur = path.dirname(cur)
    }
    if (ok) return cur
  }
  return path.dirname(abs)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const result: string[] = []
  for (const item of value) {
    if (typeof item === "string") result.push(item)
  }
  return result.length ? result : undefined
}

function trimNonEmpty(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed.length ? trimmed : undefined
}

function isGithubShorthandSegment(segment: string): boolean {
  if (!segment) return false
  return [...segment].every((ch) => /[A-Za-z0-9._-]/.test(ch))
}

function looksLikeGithubShorthand(source: string): boolean {
  const segments = source.split("/")
  if (segments.length !== 2) return false
  return isGithubShorthandSegment(segments[0]!) && isGithubShorthandSegment(segments[1]!)
}

function normalizeGithubShorthandUrl(source: string): string | null {
  if (!looksLikeGithubShorthand(source)) return null
  const [owner, repoRaw] = source.split("/") as [string, string]
  const repo = repoRaw.endsWith(".git") ? repoRaw.slice(0, -4) : repoRaw
  if (!repo) return null
  return `https://github.com/${owner}/${repo}.git`
}

function normalizeGithubGitUrl(url: string): string {
  if (url.startsWith("https://github.com/") && !url.endsWith(".git")) {
    return `${url}.git`
  }
  return url
}

function normalizeRelativeGitUrl(manifestPath: string, url: string): string {
  const root = marketplaceRootFromManifestPath(manifestPath)
  let cur = root
  for (const segment of url.split(/[\\/]/)) {
    if (segment === "" || segment === ".") continue
    if (segment === "..") {
      throw new MarketplaceParseError(
        manifestPath,
        "relative git plugin source url must stay within the marketplace root",
      )
    }
    cur = path.join(cur, segment)
  }
  return cur
}

export function normalizeGitPluginSourceUrl(manifestPath: string, url: string): string {
  const trimmed = url.trim()
  if (!trimmed) throw new MarketplaceParseError(manifestPath, "git plugin source url must not be empty")
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) return normalizeGithubGitUrl(trimmed)
  if (
    trimmed.startsWith("./") ||
    trimmed.startsWith("../") ||
    trimmed.startsWith(".\\") ||
    trimmed.startsWith("..\\")
  ) {
    return normalizeRelativeGitUrl(manifestPath, trimmed)
  }
  if (trimmed.startsWith("file://") || trimmed.startsWith("/")) {
    throw new MarketplaceParseError(
      manifestPath,
      `git plugin source url must not be a local filesystem path: ${trimmed}`,
    )
  }
  if (trimmed.startsWith("ssh://") || (trimmed.startsWith("git@") && trimmed.includes(":"))) return trimmed
  const shorthand = normalizeGithubShorthandUrl(trimmed)
  if (shorthand) return shorthand
  throw new MarketplaceParseError(manifestPath, `invalid git plugin source url: ${trimmed}`)
}

export function normalizeRemotePluginSubdir(manifestPath: string, raw: string): string {
  const trimmed = raw.trim()
  const stripped = trimmed.startsWith("./") ? trimmed.slice(2) : trimmed
  if (!stripped) throw new MarketplaceParseError(manifestPath, "git plugin source path must not be empty")
  for (const seg of stripped.split(/[\\/]/)) {
    if (seg === "" || seg === "." || seg === "..") {
      throw new MarketplaceParseError(manifestPath, "git plugin source path must stay within the repository root")
    }
  }
  return stripped
}

export function resolveLocalPluginSourcePath(manifestPath: string, raw: string): string {
  if (!raw.startsWith("./")) {
    throw new MarketplaceParseError(manifestPath, "local plugin source path must start with `./`")
  }
  const rest = raw.slice(2)
  if (!rest) {
    throw new MarketplaceParseError(manifestPath, "local plugin source path must not be empty")
  }
  for (const seg of rest.split(/[\\/]/)) {
    if (seg === "" || seg === "." || seg === "..") {
      throw new MarketplaceParseError(manifestPath, "local plugin source path must stay within the marketplace root")
    }
  }
  return path.join(marketplaceRootFromManifestPath(manifestPath), rest)
}

function parsePolicy(value: unknown): MarketplacePluginPolicy {
  const policy: MarketplacePluginPolicy = {
    installation: "AVAILABLE",
    authentication: "ON_INSTALL",
  }
  if (!isPlainObject(value)) return policy
  const inst = asString(value.installation)
  if (inst && VALID_INSTALL_POLICY.includes(inst as MarketplacePluginInstallPolicy)) {
    policy.installation = inst as MarketplacePluginInstallPolicy
  }
  const auth = asString(value.authentication)
  if (auth && VALID_AUTH_POLICY.includes(auth as MarketplacePluginAuthPolicy)) {
    policy.authentication = auth as MarketplacePluginAuthPolicy
  }
  const products = asStringArray(value.products)
  if (products) policy.products = products
  return policy
}

function parsePluginInterface(value: unknown): AddonInterfaceInfo | undefined {
  if (!isPlainObject(value)) return undefined
  const result: AddonInterfaceInfo = {
    displayName: asString(value.displayName),
    shortDescription: asString(value.shortDescription),
    longDescription: asString(value.longDescription),
    developerName: asString(value.developerName),
    category: asString(value.category),
    capabilities: asStringArray(value.capabilities),
    websiteUrl: asString(value.websiteURL) ?? asString(value.websiteUrl),
    privacyPolicyUrl: asString(value.privacyPolicyURL) ?? asString(value.privacyPolicyUrl),
    termsOfServiceUrl: asString(value.termsOfServiceURL) ?? asString(value.termsOfServiceUrl),
    brandColor: asString(value.brandColor),
    logo: asString(value.logo),
    composerIcon: asString(value.composerIcon),
    screenshots: asStringArray(value.screenshots),
  }
  if (typeof value.defaultPrompt === "string") {
    result.defaultPrompt = [value.defaultPrompt.slice(0, 128)]
  } else if (Array.isArray(value.defaultPrompt)) {
    result.defaultPrompt = value.defaultPrompt
      .filter((s): s is string => typeof s === "string")
      .slice(0, 3)
      .map((s) => s.slice(0, 128))
  }
  if (isPlainObject(value.locales)) {
    result.locales = Object.fromEntries(
      Object.entries(value.locales).flatMap(([locale, raw]) => {
        if (!isPlainObject(raw)) return []
        const prompt =
          typeof raw.defaultPrompt === "string"
            ? [raw.defaultPrompt.slice(0, 128)]
            : Array.isArray(raw.defaultPrompt)
              ? raw.defaultPrompt
                  .filter((s): s is string => typeof s === "string")
                  .slice(0, 3)
                  .map((s) => s.slice(0, 128))
              : undefined
        return [
          [
            locale,
            {
              displayName: asString(raw.displayName),
              shortDescription: asString(raw.shortDescription),
              longDescription: asString(raw.longDescription),
              defaultPrompt: prompt,
            },
          ],
        ]
      }),
    )
  }
  return result
}

function parseSource(
  manifestPath: string,
  pluginName: string,
  raw: unknown,
): { kind: "ok"; source: MarketplacePluginSource } | { kind: "skip"; reason: string } {
  if (typeof raw === "string") {
    try {
      return {
        kind: "ok",
        source: { type: "local", path: resolveLocalPluginSourcePath(manifestPath, raw) },
      }
    } catch (err) {
      return { kind: "skip", reason: err instanceof Error ? err.message : String(err) }
    }
  }
  if (!isPlainObject(raw)) {
    return { kind: "skip", reason: `plugin "${pluginName}" has no recognizable source` }
  }
  const sourceTag = asString(raw.source)
  if (!sourceTag) {
    return { kind: "skip", reason: `plugin "${pluginName}" missing source.source field` }
  }
  try {
    if (sourceTag === "local") {
      const localPath = asString(raw.path)
      if (!localPath) throw new MarketplaceParseError(manifestPath, "local source missing `path`")
      return {
        kind: "ok",
        source: { type: "local", path: resolveLocalPluginSourcePath(manifestPath, localPath) },
      }
    }
    if (sourceTag === "url") {
      const url = asString(raw.url)
      if (!url) throw new MarketplaceParseError(manifestPath, "url source missing `url`")
      const subdirRaw = asString(raw.path)
      return {
        kind: "ok",
        source: {
          type: "git",
          url: normalizeGitPluginSourceUrl(manifestPath, url),
          subdir: subdirRaw ? normalizeRemotePluginSubdir(manifestPath, subdirRaw) : undefined,
          ref: trimNonEmpty(asString(raw.ref)),
          sha: trimNonEmpty(asString(raw.sha)),
        },
      }
    }
    if (sourceTag === "git-subdir") {
      const url = asString(raw.url)
      const subdirRaw = asString(raw.path)
      if (!url) throw new MarketplaceParseError(manifestPath, "git-subdir source missing `url`")
      if (!subdirRaw) throw new MarketplaceParseError(manifestPath, "git-subdir source missing `path`")
      return {
        kind: "ok",
        source: {
          type: "git",
          url: normalizeGitPluginSourceUrl(manifestPath, url),
          subdir: normalizeRemotePluginSubdir(manifestPath, subdirRaw),
          ref: trimNonEmpty(asString(raw.ref)),
          sha: trimNonEmpty(asString(raw.sha)),
        },
      }
    }
    return { kind: "skip", reason: `plugin "${pluginName}" has unsupported source.source: ${sourceTag}` }
  } catch (err) {
    return { kind: "skip", reason: err instanceof Error ? err.message : String(err) }
  }
}

export async function loadMarketplace(manifestPath: string): Promise<Marketplace> {
  let raw: unknown
  try {
    const contents = await readFile(manifestPath, "utf-8")
    raw = JSON.parse(contents)
  } catch (err) {
    throw new MarketplaceParseError(manifestPath, err instanceof Error ? err.message : String(err))
  }
  if (!isPlainObject(raw)) {
    throw new MarketplaceParseError(manifestPath, "marketplace manifest must be a JSON object")
  }
  const name = asString(raw.name)
  if (!name) throw new MarketplaceParseError(manifestPath, "marketplace manifest missing `name`")

  const interfaceRaw = raw.interface
  let mInterface: MarketplaceInterface | undefined
  if (isPlainObject(interfaceRaw)) {
    const displayName = asString(interfaceRaw.displayName)
    if (displayName) mInterface = { displayName }
  }

  const root = marketplaceRootFromManifestPath(manifestPath)
  const plugins: MarketplacePlugin[] = []
  const unsupported: Array<{ name?: string; reason: string }> = []
  const pluginsRaw = Array.isArray(raw.plugins) ? raw.plugins : []
  for (const entry of pluginsRaw) {
    if (!isPlainObject(entry)) {
      unsupported.push({ reason: "plugin entry is not an object" })
      continue
    }
    const pluginName = asString(entry.name)
    if (!pluginName) {
      unsupported.push({ reason: "plugin entry missing `name`" })
      continue
    }
    const sourceResult = parseSource(manifestPath, pluginName, entry.source)
    if (sourceResult.kind === "skip") {
      unsupported.push({ name: pluginName, reason: sourceResult.reason })
      continue
    }
    const policy = parsePolicy(entry.policy)
    const interfaceInfo = parsePluginInterface(entry.interface)
    if (interfaceInfo) {
      const cat = asString(entry.category)
      if (cat) interfaceInfo.category = cat
    }
    plugins.push({
      name: pluginName,
      source: sourceResult.source,
      policy,
      category: asString(entry.category),
      interface: interfaceInfo,
      keywords: asStringArray(entry.keywords),
    })
  }

  return {
    name,
    manifestPath,
    root,
    interface: mInterface,
    plugins,
    unsupportedPlugins: unsupported,
  }
}
