import type { Hooks } from "@opencode-ai/plugin"
import { readdir } from "fs/promises"
import path from "path"
import { findManifestPath, parseManifest, type AddonManifest } from "./manifest"
import { loadAndConvertHooks } from "./hooks-adapter"
import { convertMcpConfig, loadMcpConfigDeclaration, type AddonMcpConfigInfo, type CodexMcpConfig } from "./mcp-adapter"
import { loadSkillsFromAddonRoot, type CodexSkill } from "./skills-loader"
import { findMarketplaceManifestPath, loadMarketplace, type Marketplace } from "./marketplace"
import { activeAddonVersion, validAddonSegment } from "./store"
import {
  type AddonId,
  type AddonMcpUserConfig,
  type AddonUserConfig,
  addonKey,
  addonEnabled,
  addonOverride,
  applyMcpOverrides,
  isAddonEnabled,
} from "./user-config"

export interface LoadedAddon {
  root: string
  manifest: AddonManifest
  addonId: AddonId
  version?: string
  disabled?: boolean
  error?: string
  skills?: CodexSkill[]
  mcpServers?: Record<string, AddonMcpConfigInfo>
  mcpServerDeclarations?: CodexMcpConfig
  hooks?: Partial<Hooks>
  unsupportedHookEvents?: string[]
}

export interface AddonLoadResult {
  addons: LoadedAddon[]
  errors: string[]
  marketplaces: Marketplace[]
}

export interface ResolvedMarketplaceInput {
  name: string
  root: string
}

export interface AddonLoaderOptions {
  config?: AddonUserConfig
  marketplaces?: ResolvedMarketplaceInput[]
}

async function directories(dir: string) {
  return (await readdir(dir, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ name: entry.name, path: path.join(dir, entry.name) }))
    .sort((a, b) => a.path.localeCompare(b.path))
}

async function hasManifest(root: string) {
  return findManifestPath(root) !== null
}

async function discoverAddonRoots(base: string) {
  const roots: Array<{ root: string; marketplaceName: string; version?: string; registryNamespace?: string }> = []

  if (await hasManifest(base)) {
    roots.push({ root: base, marketplaceName: "local" })
  }

  for (const addon of await directories(base)) {
    if (await hasManifest(addon.path)) {
      roots.push({ root: addon.path, marketplaceName: "local" })
    }
  }

  for (const market of await directories(base)) {
    if (!validAddonSegment(market.name)) continue
    for (const addon of await directories(market.path)) {
      if (!validAddonSegment(addon.name)) continue
      const version = await activeAddonVersion(addon.path)
      if (version) {
        const root = path.join(addon.path, version)
        if (await hasManifest(root)) {
          roots.push({ root, marketplaceName: market.name, version })
          continue
        }
      }
      for (const registryAddon of await directories(addon.path)) {
        if (!validAddonSegment(registryAddon.name)) continue
        const registryVersion = await activeAddonVersion(registryAddon.path)
        if (!registryVersion) continue
        const root = path.join(registryAddon.path, registryVersion)
        if (await hasManifest(root)) {
          roots.push({
            root,
            marketplaceName: market.name,
            registryNamespace: addon.name,
            version: registryVersion,
          })
        }
      }
    }
  }

  return Array.from(new Map(roots.map((item) => [item.root, item])).values())
}

async function loadAddon(input: {
  root: string
  marketplaceName: string
  version?: string
  registryNamespace?: string
  addonNameOverride?: string
  config: AddonUserConfig
}) {
  const manifest = await parseManifest(input.root)
  const fallbackName = path.basename(input.root).replace(/^@/, "") || "unknown"
  const addonName = input.addonNameOverride ?? manifest?.name ?? fallbackName
  const addonId: AddonId = input.registryNamespace
    ? { addonName, marketplaceName: input.marketplaceName, registryNamespace: input.registryNamespace }
    : { addonName, marketplaceName: input.marketplaceName }

  if (!manifest) {
    return {
      root: input.root,
      manifest: { name: addonId.addonName, paths: {} },
      addonId,
      version: input.version,
      error: "Failed to parse manifest",
    } satisfies LoadedAddon
  }

  const mcpServerDeclarations = await loadMcpConfigDeclaration(input.root, manifest.paths.mcpServers ?? ".mcp.json")
  const mcpServers = mcpServerDeclarations ? convertMcpConfig(mcpServerDeclarations, input.root) : undefined
  const skills = await loadSkillsFromAddonRoot(input.root, manifest.paths.skills)
  const hooksResult = manifest.paths.hooks ? await loadAndConvertHooks(input.root, manifest.paths.hooks) : null
  const overrides = addonOverride(input.config, addonId)

  return {
    root: input.root,
    manifest,
    addonId,
    version: input.version ?? manifest.version,
    disabled: !isAddonEnabled(input.config, addonId) || undefined,
    skills: skills.length ? skills : undefined,
    mcpServers: mcpServers
      ? (Object.fromEntries(
          Object.entries(mcpServers).map(([name, server]) => [
            name,
            applyMcpOverrides(server, overrides?.mcp_servers?.[name] as AddonMcpUserConfig | undefined),
          ]),
        ) as Record<string, AddonMcpConfigInfo>)
      : undefined,
    mcpServerDeclarations,
    hooks: hooksResult && Object.keys(hooksResult.hooks).length ? hooksResult.hooks : undefined,
    unsupportedHookEvents: hooksResult?.unsupportedEvents.length ? hooksResult.unsupportedEvents : undefined,
  } satisfies LoadedAddon
}

function dedupe<T extends { root: string; addonId: AddonId }>(items: T[]): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const item of items) {
    const key = `${addonKey(item.addonId)}::${item.root}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}

export async function loadAddonsFromPaths(paths: string[], options: AddonLoaderOptions = {}): Promise<AddonLoadResult> {
  const config = options.config ?? {}
  if (!addonEnabled(config)) return { addons: [], errors: [], marketplaces: [] }

  // Marketplaces with a marketplace.json are catalogs of installable addons,
  // not load sources. Track them so `addon install` can resolve sources, but
  // do NOT auto-load their plugins — installation must materialize them into
  // a cache path first. Marketplace inputs WITHOUT a manifest fall back to
  // legacy cache-layout scanning (e.g. `~/.codex/plugins/cache/<market>/...`)
  // and tag the discovered addons with the input's marketplace name.
  const marketplacesByPath = new Map<string, Marketplace>()
  const marketplaceErrors: string[] = []
  const registerMarketplace = async (manifestPath: string) => {
    if (marketplacesByPath.has(manifestPath)) return
    try {
      marketplacesByPath.set(manifestPath, await loadMarketplace(manifestPath))
    } catch (err) {
      marketplaceErrors.push(`marketplace ${manifestPath}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const marketplaceFallbackAddons: LoadedAddon[] = []
  for (const input of options.marketplaces ?? []) {
    const manifestPath = findMarketplaceManifestPath(input.root)
    if (manifestPath) {
      await registerMarketplace(manifestPath)
      continue
    }
    const roots = await discoverAddonRoots(input.root)
    for (const root of roots) {
      marketplaceFallbackAddons.push(
        await loadAddon({ root: root.root, marketplaceName: input.name, version: root.version, config }),
      )
    }
  }

  const pathLoaded = await Promise.all(
    paths.map(async (base) => {
      const manifestPath = findMarketplaceManifestPath(base)
      // Same rule for path-discovered marketplaces: register the catalog,
      // skip auto-load. Cache-layout addons inside the path are still
      // picked up below if `discoverAddonRoots` finds them.
      if (manifestPath) await registerMarketplace(manifestPath)
      const roots = await discoverAddonRoots(base)
      return Promise.all(roots.map((root) => loadAddon({ ...root, config })))
    }),
  )
  const pathAddons = pathLoaded.flat()

  const addons = dedupe([...marketplaceFallbackAddons, ...pathAddons])
  return {
    addons,
    errors: [
      ...marketplaceErrors,
      ...addons.flatMap((addon) => (addon.error ? [`${addonKey(addon.addonId)}: ${addon.error}`] : [])),
    ],
    marketplaces: Array.from(marketplacesByPath.values()),
  }
}
