export const deepLinkEvent = "wanlaicode:deep-link"

const schemes = ["wanlaicode://", "opencode://"] as const

export type PluginInstallDeepLink = {
  namespace: string
  slug: string
  version?: string
}

const parseUrl = (input: string) => {
  if (!schemes.some((scheme) => input.startsWith(scheme))) return
  if (typeof URL.canParse === "function" && !URL.canParse(input)) return
  try {
    return new URL(input)
  } catch {
    return
  }
}

export const parseDeepLink = (input: string) => {
  const url = parseUrl(input)
  if (!url) return
  if (url.hostname !== "open-project") return
  const directory = url.searchParams.get("directory")
  if (!directory) return
  return directory
}

export const parseNewSessionDeepLink = (input: string) => {
  const url = parseUrl(input)
  if (!url) return
  if (url.hostname !== "new-session") return
  const directory = url.searchParams.get("directory")
  if (!directory) return
  const prompt = url.searchParams.get("prompt") || undefined
  if (!prompt) return { directory }
  return { directory, prompt }
}

const parseAddonSegment = (value: string | null) => {
  const segment = value?.trim()
  if (!segment || segment === "." || segment === "..") return
  if (segment.length > 128 || !/^[A-Za-z0-9._+-]+$/.test(segment)) return
  return segment
}

export const parsePluginInstallDeepLink = (input: string): PluginInstallDeepLink | undefined => {
  const url = parseUrl(input)
  if (!url || url.hostname !== "plugin" || url.pathname !== "/install") return
  const namespace = parseAddonSegment(url.searchParams.get("namespace"))
  const slug = parseAddonSegment(url.searchParams.get("slug"))
  if (!namespace || !slug) return
  const rawVersion = url.searchParams.get("version")
  if (rawVersion === null) return { namespace, slug }
  const version = parseAddonSegment(rawVersion)
  if (!version) return
  return { namespace, slug, version }
}

export const collectOpenProjectDeepLinks = (urls: string[]) =>
  urls.map(parseDeepLink).filter((directory): directory is string => !!directory)

export const collectNewSessionDeepLinks = (urls: string[]) =>
  urls.map(parseNewSessionDeepLink).filter((link): link is { directory: string; prompt?: string } => !!link)

export const collectPluginInstallDeepLinks = (urls: string[]) =>
  urls.map(parsePluginInstallDeepLink).filter((link): link is PluginInstallDeepLink => !!link)

type WanlaiCodeWindow = Window & {
  __WANLAICODE__?: {
    deepLinks?: string[]
  }
  /** @deprecated Use __WANLAICODE__ */
  __OPENCODE__?: {
    deepLinks?: string[]
  }
}

export const drainPendingDeepLinks = (target: WanlaiCodeWindow) => {
  const pending = target.__WANLAICODE__?.deepLinks ?? target.__OPENCODE__?.deepLinks ?? []
  if (pending.length === 0) return []
  if (target.__WANLAICODE__) target.__WANLAICODE__.deepLinks = []
  if (target.__OPENCODE__) target.__OPENCODE__.deepLinks = []
  return pending
}
