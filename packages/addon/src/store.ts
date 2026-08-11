import { readdir } from "fs/promises"
import path from "path"

const DEFAULT_ADDON_VERSION = "local"

export function addonCacheRoot(codexHome: string) {
  return path.join(codexHome, "plugins", "cache")
}

export function addonRoot(
  cacheRoot: string,
  market: string,
  addonName: string,
  version: string,
  registryNamespace?: string,
) {
  if (registryNamespace) return path.join(cacheRoot, market, registryNamespace, addonName, version)
  return path.join(cacheRoot, market, addonName, version)
}

export function validAddonSegment(segment: string) {
  if (!segment || segment === "." || segment === "..") return false
  return [...segment].every((ch) => /[A-Za-z0-9._+-]/.test(ch))
}

function compareVersions(a: string, b: string): number {
  try {
    return Bun.semver.order(a, b)
  } catch {
    return a < b ? -1 : a > b ? 1 : 0
  }
}

export async function activeAddonVersion(versionsDir: string) {
  const entries = await readdir(versionsDir, { withFileTypes: true }).catch(() => [])
  const versions = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter(validAddonSegment)
    .sort(compareVersions)

  if (versions.includes(DEFAULT_ADDON_VERSION)) return DEFAULT_ADDON_VERSION
  return versions.at(-1)
}
