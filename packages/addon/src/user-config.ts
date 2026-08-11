import { validAddonSegment } from "./store"

export interface AddonId {
  addonName: string
  marketplaceName: string
  registryNamespace?: string
}

export class InvalidAddonKeyError extends Error {
  constructor(public readonly key: string) {
    super(`invalid addon key: "${key}" (expected "<addon>@<marketplace>")`)
    this.name = "InvalidAddonKeyError"
  }
}

export function parseAddonKey(key: string): AddonId {
  const trimmed = key.trim()
  const at = trimmed.lastIndexOf("@")
  if (at <= 0 || at === trimmed.length - 1) {
    throw new InvalidAddonKeyError(key)
  }
  const addonName = trimmed.slice(0, at).trim()
  const marketplaceParts = trimmed
    .slice(at + 1)
    .trim()
    .split("/")
    .map((item) => item.trim())
  const marketplaceName = marketplaceParts[0]
  const registryNamespace = marketplaceParts[1]
  if (
    marketplaceParts.length > 2 ||
    !marketplaceName ||
    !validAddonSegment(addonName) ||
    !validAddonSegment(marketplaceName) ||
    (registryNamespace !== undefined && !validAddonSegment(registryNamespace))
  ) {
    throw new InvalidAddonKeyError(key)
  }
  if (!registryNamespace) return { addonName, marketplaceName }
  return { addonName, marketplaceName, registryNamespace }
}

export interface AddonUserConfig {
  addon?: {
    enabled?: boolean
    paths?: string[]
  }
  plugins?: Record<
    string,
    {
      enabled?: boolean
      mcp_servers?: Record<string, unknown>
      disabled_skills?: string[]
    }
  >
}

export interface AddonMcpUserConfig {
  enabled?: boolean
  default_tools_approval_mode?: "auto" | "prompt" | "approve"
  enabled_tools?: string[]
  disabled_tools?: string[]
  tools?: Record<string, { approval?: "auto" | "prompt" | "approve" }>
}

export function addonEnabled(config: AddonUserConfig) {
  return config.addon?.enabled !== false
}

export function addonKey(addonId: AddonId) {
  if (addonId.registryNamespace) return `${addonId.addonName}@${addonId.marketplaceName}/${addonId.registryNamespace}`
  return `${addonId.addonName}@${addonId.marketplaceName}`
}

export function addonIdEquals(a: AddonId, b: AddonId) {
  return (
    a.addonName === b.addonName &&
    a.marketplaceName === b.marketplaceName &&
    a.registryNamespace === b.registryNamespace
  )
}

export function addonSkillPrefix(addonId: AddonId) {
  if (addonId.registryNamespace) return `${addonId.registryNamespace}/${addonId.addonName}`
  return addonId.addonName
}

export function addonSkillName(addonId: AddonId, skillName: string) {
  return `${addonSkillPrefix(addonId)}:${skillName}`
}

export function addonOverride(config: AddonUserConfig, addonId: AddonId) {
  return config.plugins?.[addonKey(addonId)]
}

export function isAddonEnabled(config: AddonUserConfig, addonId: AddonId) {
  return addonOverride(config, addonId)?.enabled !== false
}

export interface AddonConfigPatch {
  plugins?: Record<
    string,
    { enabled?: boolean; mcp_servers?: Record<string, unknown>; disabled_skills?: string[] } | undefined
  >
}

export function setAddonEnabled(addonId: AddonId, enabled: boolean): AddonConfigPatch {
  return {
    plugins: {
      [addonKey(addonId)]: { enabled },
    },
  }
}

export function setMcpEnabled(addonId: AddonId, name: string, enabled: boolean): AddonConfigPatch {
  return {
    plugins: {
      [addonKey(addonId)]: {
        mcp_servers: {
          [name]: { enabled },
        },
      },
    },
  }
}

export function disabledSkillNames(config: AddonUserConfig, addonId: AddonId): string[] {
  return addonOverride(config, addonId)?.disabled_skills ?? []
}

export function isSkillEnabled(config: AddonUserConfig, addonId: AddonId, skillName: string): boolean {
  return !disabledSkillNames(config, addonId).includes(skillName)
}

// Toggle a single skill's enabled state, preserving the rest of the plugin entry.
// Pass the existing entry so we can deep-merge without clobbering enabled / mcp_servers.
export function setSkillEnabled(
  addonId: AddonId,
  skillName: string,
  enabled: boolean,
  existing?: { disabled_skills?: readonly string[] },
): AddonConfigPatch {
  const current = existing?.disabled_skills ?? []
  const next = enabled
    ? current.filter((n: string) => n !== skillName)
    : Array.from(new Set([...current, skillName]))
  return {
    plugins: {
      [addonKey(addonId)]: { disabled_skills: next },
    },
  }
}

// Always emit a per-key delete patch instead of clearing the whole `plugins`
// map. Avoids the read-modify-write race where a parallel install adds a
// sibling entry between us reading "plugins is now empty" and writing the
// patch — which would otherwise wipe the freshly-added entry. An empty
// `plugins: {}` may linger, which is harmless.
export function clearAddon(addonId: AddonId): AddonConfigPatch {
  return { plugins: { [addonKey(addonId)]: undefined } }
}

export function applyMcpOverrides<T extends object>(server: T, override?: AddonMcpUserConfig): T {
  if (!override) return server
  const current = server as {
    enabled?: boolean
    default_tools_approval_mode?: "auto" | "prompt" | "approve"
    enabled_tools?: string[]
    disabled_tools?: string[]
    tools?: Record<string, { approval?: "auto" | "prompt" | "approve" }>
  }
  return Object.fromEntries(Object.entries({
    ...server,
    enabled: override.enabled ?? current.enabled,
    default_tools_approval_mode: override.default_tools_approval_mode ?? current.default_tools_approval_mode,
    enabled_tools: override.enabled_tools ?? current.enabled_tools,
    disabled_tools: override.disabled_tools ?? current.disabled_tools,
    tools: override.tools
      ? {
          ...(current.tools ?? {}),
          ...override.tools,
        }
      : current.tools,
  }).filter(([, value]) => value !== undefined)) as T
}
