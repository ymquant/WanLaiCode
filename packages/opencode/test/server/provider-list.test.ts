import { describe, expect, test } from "bun:test"
import { mergeProviderRegistry, providerListResult } from "../../src/server/routes/instance/provider-list"
import { ProviderID } from "../../src/provider/schema"
import type { ModelsDev } from "../../src/provider/models"
import { Provider } from "../../src/provider/provider"

const wanlaiCodeProvider = {
  id: "wanlaicode",
  env: ["WANLAICODE_API_KEY"],
  npm: "@ai-sdk/openai-compatible",
  api: "http://127.0.0.1:8080/v1",
  name: "万来Code",
  models: {
    "gpt-5.5": {
      id: "gpt-5.5",
      name: "gpt-5.5",
      release_date: "2026-01-01",
      attachment: true,
      reasoning: true,
      temperature: true,
      tool_call: true,
      limit: { context: 128000, output: 8192 },
      modalities: { input: ["text", "image"], output: ["text"] },
    },
  },
} satisfies ModelsDev.Provider

const connectedWanlaiCode = {
  ...Provider.fromModelsDevProvider({
    ...wanlaiCodeProvider,
    models: {
      "gpt-image-2": {
        id: "gpt-image-2",
        name: "gpt-image-2",
        release_date: "2026-01-01",
        attachment: true,
        reasoning: false,
        temperature: true,
        tool_call: true,
        limit: { context: 128000, output: 8192 },
        modalities: { input: ["text", "image"], output: ["image"] },
      },
    },
  }),
  source: "api",
  key: "runtime-key",
} satisfies Provider.Info

describe("mergeProviderRegistry", () => {
  test("keeps WanlaiCode connection state but replaces stale models with latest registry models", () => {
    const providers = mergeProviderRegistry({
      filtered: { wanlaicode: wanlaiCodeProvider },
      connected: { [ProviderID.make("wanlaicode")]: connectedWanlaiCode },
    })

    expect(providers.wanlaicode?.source).toBe("api")
    expect(providers.wanlaicode?.key).toBe("runtime-key")
    expect(Object.keys(providers.wanlaicode?.models ?? {})).toEqual(["gpt-5.5"])
  })
})

describe("providerListResult", () => {
  test("marks WanlaiCode connected when registry has available models", () => {
    const result = providerListResult({
      filtered: { wanlaicode: wanlaiCodeProvider },
      connected: {},
      disabled: new Set(),
    })

    const wanlaiCode = result.all.find((provider) => provider.id === "wanlaicode")
    expect(result.connected).toEqual(["wanlaicode"])
    expect(wanlaiCode?.key).toBe("__wanlaicode_no_entitlement__")
    expect(wanlaiCode?.options?.apiKey).toBe("__wanlaicode_no_entitlement__")
  })
})
