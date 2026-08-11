import { describe, expect, test } from "bun:test"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Server } from "../../src/server/server"
import { provideTestInstance, tmpdir } from "../fixture/fixture"
import { clearAuthContentEnv } from "../preload"

const profile = { entitlement: { plan: "pro" }, account: { uuid: "acct_123" } }

type FetchInput = Parameters<typeof fetch>[0]
type FetchInit = Parameters<typeof fetch>[1]

async function withFetch(fn: (requests: Array<{ path: string; apiKey: string | null }>) => Promise<void>) {
  const originalFetch = globalThis.fetch
  const requests: Array<{ path: string; apiKey: string | null }> = []
  const fetchOverride = Object.assign(
    async (input: FetchInput, init?: FetchInit) => {
      const url = input.toString()
      if (url.startsWith("https://api.example.com") || url.startsWith("https://models.dev")) {
        const path = new URL(url).pathname
        requests.push({ path, apiKey: new Headers(init?.headers).get("x-api-key") })
        if (path === "/v1/models")
          return Response.json({
            data: [
              {
                id: "wanlai-test-model",
                display_name: "Wanlai Test Model",
                rate_multiplier: 0,
                attachment: false,
                reasoning: false,
                toolcall: true,
                created_at: "2026-01-01",
                context_length: 200000,
                max_completion_tokens: 128000,
              },
            ],
          })
        if (path === "/api/wanlaicode_profile") return Response.json(profile)
      }
      return originalFetch(input, init)
    },
    { preconnect: originalFetch.preconnect },
  )
  globalThis.fetch = fetchOverride
  try {
    await fn(requests)
  } finally {
    globalThis.fetch = originalFetch
  }
}

describe("WanlaiCode provider proxy", () => {
  test("logs in with API keys through the local provider endpoint", async () => {
    clearAuthContentEnv()
    const originalModelsPath = Flag.WANLAICODE_MODELS_PATH
    const originalDisableFetch = Flag.WANLAICODE_DISABLE_MODELS_FETCH
    const originalDisableSnapshot = Flag.WANLAICODE_DISABLE_MODELS_SNAPSHOT
    const originalHttpApi = Flag.WANLAICODE_EXPERIMENTAL_HTTPAPI
    Flag.WANLAICODE_MODELS_PATH = undefined
    Flag.WANLAICODE_DISABLE_MODELS_FETCH = true
    Flag.WANLAICODE_DISABLE_MODELS_SNAPSHOT = true
    Flag.WANLAICODE_EXPERIMENTAL_HTTPAPI = false
    try {
      await using tmp = await tmpdir()
      await withFetch(async (requests) => {
        await provideTestInstance({
          directory: tmp.path,
          fn: async () => {
            const wanlaiCode = await import("../../src/provider/wanlaicode")
            wanlaiCode.WanlaiCodeAuth.setFetchWithoutProxyForTesting(async (input, init) => {
              const url = input.toString()
              if (url.startsWith("https://api.example.com")) {
                const path = new URL(url).pathname
                requests.push({ path, apiKey: new Headers(init?.headers).get("x-api-key") })
                if (path === "/v1/models")
                  return Response.json({
                    data: [
                      {
                        id: "wanlai-test-model",
                        display_name: "Wanlai Test Model",
                        rate_multiplier: 0,
                        attachment: false,
                        reasoning: false,
                        toolcall: true,
                        created_at: "2026-01-01",
                        context_length: 200000,
                        max_completion_tokens: 128000,
                      },
                    ],
                  })
                if (path === "/api/wanlaicode_profile") return Response.json(profile)
              }
              throw new Error(`Unexpected WanlaiCode test url: ${url}`)
            })
            try {
              const response = await Server.Legacy().app.request("/provider/wanlaicode/api-key/validate", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ apiKey: "test-api-key", apiBase: "https://api.example.com/v1" }),
              })

              expect(response.status).toBe(200)
              expect(await response.json()).toEqual({ ok: true })
              expect(requests).toContainEqual({ path: "/api/wanlaicode_profile", apiKey: "test-api-key" })

              const providers = await Server.Legacy().app.request("/provider")
              const body = await providers.json()
              expect(providers.status).toBe(200)
              expect(body.connected).toEqual(expect.arrayContaining(["wanlaicode"]))
            } finally {
              wanlaiCode.WanlaiCodeAuth.setFetchWithoutProxyForTesting(undefined)
            }
          },
        })
      })
    } finally {
      Flag.WANLAICODE_MODELS_PATH = originalModelsPath
      Flag.WANLAICODE_DISABLE_MODELS_FETCH = originalDisableFetch
      Flag.WANLAICODE_DISABLE_MODELS_SNAPSHOT = originalDisableSnapshot
      Flag.WANLAICODE_EXPERIMENTAL_HTTPAPI = originalHttpApi
      clearAuthContentEnv()
    }
  })
})
