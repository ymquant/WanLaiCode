import { ModelsDev } from "@/provider/models"
import { Provider } from "@/provider/provider"
import { ProviderID } from "@/provider/schema"
import { mapValues } from "remeda"

const WANLAICODE_NO_ENTITLEMENT_API_KEY = "__wanlaicode_no_entitlement__"

export function mergeProviderRegistry(input: {
  filtered: Record<string, ModelsDev.Provider>
  connected: Record<ProviderID, Provider.Info>
}) {
  const registry = mapValues(input.filtered, (provider) => Provider.fromModelsDevProvider(provider))
  const providers = Object.assign({}, registry, input.connected)
  const wanlaiCodeID = ProviderID.make("wanlaicode")
  const latestWanlaiCode = registry[wanlaiCodeID]
  const connectedWanlaiCode = input.connected[wanlaiCodeID]

  if (latestWanlaiCode && connectedWanlaiCode) {
    providers[wanlaiCodeID] = {
      ...connectedWanlaiCode,
      name: latestWanlaiCode.name,
      env: latestWanlaiCode.env,
      models: latestWanlaiCode.models,
    }
  }

  return providers
}

export function providerListResult(input: {
  filtered: Record<string, ModelsDev.Provider>
  connected: Record<ProviderID, Provider.Info>
  disabled: Set<string>
}) {
  const providers = mergeProviderRegistry(input)
  const wanlaiCodeID = ProviderID.make("wanlaicode")
  const wanlaiCode = providers[wanlaiCodeID]
  if (wanlaiCode && !input.disabled.has("wanlaicode") && Object.keys(wanlaiCode.models).length > 0) {
    const hasRuntimeKey =
      typeof wanlaiCode.key === "string" && wanlaiCode.key.trim() !== "" && wanlaiCode.key !== WANLAICODE_NO_ENTITLEMENT_API_KEY
    providers[wanlaiCodeID] = {
      ...wanlaiCode,
      source: wanlaiCode.source ?? "custom",
      key: wanlaiCode.key ?? WANLAICODE_NO_ENTITLEMENT_API_KEY,
      options: {
        ...wanlaiCode.options,
        apiKey: hasRuntimeKey ? wanlaiCode.options?.apiKey : wanlaiCode.options?.apiKey ?? WANLAICODE_NO_ENTITLEMENT_API_KEY,
      },
    }
  }

  return {
    all: Object.values(providers),
    default: Provider.defaultModelIDs(providers),
    connected: Object.keys(providers).filter((key) => key in input.connected || key === "wanlaicode"),
  } satisfies Provider.ListResult
}
