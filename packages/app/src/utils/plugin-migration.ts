import type { AddonAvailable, RegistryPluginOut } from "@opencode-ai/sdk/v2"

export const REGISTRY_MARKETPLACE = "wanlaicode"

export function registryAddonKey(plugin: Pick<RegistryPluginOut, "namespace" | "slug">): string {
  return `${plugin.slug}@${REGISTRY_MARKETPLACE}/${plugin.namespace}`
}

export function addonMentionKey(
  addon: Pick<AddonAvailable, "key" | "name" | "marketplace_name"> & { registry_namespace?: string },
): string {
  if (addon.marketplace_name === REGISTRY_MARKETPLACE && addon.registry_namespace) {
    return `${addon.name}@${REGISTRY_MARKETPLACE}/${addon.registry_namespace}`
  }
  return addon.key
}

export function addonNamespaceFromKey(addonKey: string): string | undefined {
  const marketStart = addonKey.lastIndexOf("@")
  if (marketStart < 0) return undefined
  const namespaceStart = addonKey.indexOf("/", marketStart + 1)
  if (namespaceStart < 0) return undefined
  return addonKey.slice(namespaceStart + 1).trim() || undefined
}

export function isBuiltinMarketplace(name: string): boolean {
  return name.startsWith("openai-")
}

export function isLegacyRegistryAddon(addon: AddonAvailable): boolean {
  return addon.marketplace_name === REGISTRY_MARKETPLACE && !addonNamespaceFromKey(addon.key)
}

export function migrationTargetForAddon(input: {
  addon: AddonAvailable
  registryPlugins: RegistryPluginOut[]
  installedRegistryKeys: Set<string>
}): RegistryPluginOut | undefined {
  if (!input.addon.installed) return undefined
  if (!isBuiltinMarketplace(input.addon.marketplace_name ?? "") && !isLegacyRegistryAddon(input.addon)) return undefined
  const candidates = input.registryPlugins.filter((plugin) => plugin.slug === input.addon.name)
  if (candidates.length !== 1) return undefined
  if (input.installedRegistryKeys.has(registryAddonKey(candidates[0]))) return undefined
  return candidates[0]
}

export function isAddonSupersededByInstalledRegistry(input: {
  addon: AddonAvailable
  registryPlugins: RegistryPluginOut[]
  installedRegistryKeys: Set<string>
}): boolean {
  if (!input.addon.installed) return false
  if (!isBuiltinMarketplace(input.addon.marketplace_name ?? "") && !isLegacyRegistryAddon(input.addon)) return false
  const candidates = input.registryPlugins.filter((plugin) => plugin.slug === input.addon.name)
  if (candidates.length !== 1) return false
  return input.installedRegistryKeys.has(registryAddonKey(candidates[0]))
}

export function migrationSourceKeysForTarget(input: {
  target: RegistryPluginOut
  addons: AddonAvailable[]
  registryPlugins: RegistryPluginOut[]
}): string[] {
  const targetKey = registryAddonKey(input.target)
  return [
    ...new Set(
      input.addons
        .filter((addon) => {
          if (addon.key === targetKey) return false
          const candidates = input.registryPlugins.filter((plugin) => plugin.slug === addon.name)
          return candidates.length === 1 && registryAddonKey(candidates[0]) === targetKey
        })
        .filter((addon) => isBuiltinMarketplace(addon.marketplace_name ?? "") || isLegacyRegistryAddon(addon))
        .filter((addon) => addon.installed)
        .map((addon) => addon.key),
    ),
  ]
}
