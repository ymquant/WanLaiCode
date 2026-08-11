import { useGlobalSync } from "@/context/global-sync"
import { decode64 } from "@/utils/base64"
import { useParams } from "@solidjs/router"
import { createMemo } from "solid-js"

export const popularProviders = [
  "wanlaicode",
  "anthropic",
  "github-copilot",
  "openai",
  "google",
  "openrouter",
  "vercel",
]
const popularProviderSet = new Set(popularProviders)
export const WANLAICODE_NO_ENTITLEMENT_API_KEY = "__wanlaicode_no_entitlement__"

export const isWanlaiCodeNoEntitlementProvider = (provider: { id: string; options?: Record<string, unknown> }) =>
  provider.id === "wanlaicode" && provider.options?.apiKey === WANLAICODE_NO_ENTITLEMENT_API_KEY

export function useProviders() {
  const globalSync = useGlobalSync()
  const params = useParams()
  const dir = createMemo(() => decode64(params.dir) ?? "")
  const providers = () => {
    if (dir()) {
      const [projectStore] = globalSync.child(dir())
      if (projectStore.provider_ready) return projectStore.provider
    }
    return globalSync.data.provider
  }
  return {
    all: () => providers().all,
    default: () => providers().default,
    popular: () => providers().all.filter((p) => popularProviderSet.has(p.id)),
    connected: () => {
      const connected = new Set(providers().connected)
      return providers().all.filter((p) => connected.has(p.id))
    },
    paid: () => {
      const connected = new Set(providers().connected)
      return providers().all.filter(
        (p) =>
          connected.has(p.id) &&
          !isWanlaiCodeNoEntitlementProvider(p) &&
          (p.id !== "opencode" || Object.values(p.models).some((m) => m.cost?.input)),
      )
    },
  }
}
