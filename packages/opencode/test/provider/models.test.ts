import { describe, expect, beforeAll, beforeEach, afterEach, afterAll } from "bun:test"
import { Effect, Layer, Ref } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Flag } from "@opencode-ai/core/flag/flag"
import { ModelsDev } from "../../src/provider/models"
import { Env } from "../../src/env"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { WanlaiCodeAuth } from "../../src/provider/wanlaicode"
import { it } from "../lib/effect"
import { rm, writeFile, utimes, mkdir, mkdtemp } from "fs/promises"
import os from "os"
import path from "path"

// test/preload.ts pins OPENCODE_MODELS_PATH to a fixture so other tests can
// resolve providers without network. These tests need to drive the on-disk
// cache themselves and silence the eager refresh fork. Save/restore around
// the suite — never leak the mutation to subsequent test files in the same
// bun process.
const ORIGINAL_MODELS_PATH = Flag.WANLAICODE_MODELS_PATH
const ORIGINAL_DISABLE_FETCH = Flag.WANLAICODE_DISABLE_MODELS_FETCH
const ORIGINAL_DISABLE_SNAPSHOT = Flag.WANLAICODE_DISABLE_MODELS_SNAPSHOT
beforeAll(() => {
  Flag.WANLAICODE_DISABLE_MODELS_FETCH = true
  // The build-time snapshot may be present locally (gitignored). Disable it
  // so disk-empty tests can observe the real disk/fetch fallback.
  Flag.WANLAICODE_DISABLE_MODELS_SNAPSHOT = true
})
let cacheDir: string | undefined
let cacheFile = ""
const wanlaiCodeModelsURL = () => WanlaiCodeAuth.resolveConfig().endpoints.models

const fixture: Record<string, ModelsDev.Provider> = {
  acme: {
    id: "acme",
    name: "Acme",
    env: ["ACME_API_KEY"],
    models: {
      "acme-1": {
        id: "acme-1",
        name: "Acme One",
        release_date: "2026-01-01",
        attachment: false,
        reasoning: false,
        temperature: true,
        tool_call: true,
        limit: { context: 128000, output: 8192 },
      },
    },
  },
}

const fixture2: Record<string, ModelsDev.Provider> = {
  beta: {
    id: "beta",
    name: "Beta",
    env: ["BETA_API_KEY"],
    models: {
      "beta-1": {
        id: "beta-1",
        name: "Beta One",
        release_date: "2026-02-01",
        attachment: false,
        reasoning: true,
        temperature: false,
        tool_call: false,
        limit: { context: 64000, output: 4096 },
      },
    },
  },
}

interface MockState {
  body: string
  status: number
  calls: Array<{ url: string; authorization?: string }>
  bodies?: Record<string, string>
  statuses?: Record<string, number>
}

const makeMockClient = (state: Ref.Ref<MockState>) =>
  HttpClient.make((request) =>
    Effect.gen(function* () {
      yield* Ref.update(state, (s) => ({ ...s, calls: [...s.calls, { url: request.url }] }))
      const s = yield* Ref.get(state)
      const status = Object.entries(s.statuses ?? {}).find(([url]) => request.url.includes(url))?.[1] ?? s.status
      return HttpClientResponse.fromWeb(
        request,
        new Response(Object.entries(s.bodies ?? {}).find(([url]) => request.url.includes(url))?.[1] ?? s.body, {
          status,
        }),
      )
    }),
  )

const buildLayer = (state: Ref.Ref<MockState>) =>
  // Layer.fresh is required: ModelsDev.layer is a module-level Layer constant,
  // and Effect.provide uses a process-global MemoMap by default — without fresh,
  // every test would reuse the cachedInvalidateWithTTL state from the first run.
  Layer.fresh(ModelsDev.layer).pipe(
    Layer.provide(Layer.succeed(HttpClient.HttpClient, makeMockClient(state))),
    Layer.provide(AppFileSystem.defaultLayer),
    Layer.provide(Env.defaultLayer),
    Layer.provide(Auth.defaultLayer),
    Layer.provide(Config.defaultLayer),
  )

const writeCache = (data: object, mtimeMs?: number) =>
  Effect.promise(async () => {
    await mkdir(path.dirname(cacheFile), { recursive: true })
    await writeFile(cacheFile, JSON.stringify(data))
    if (mtimeMs !== undefined) {
      const t = mtimeMs / 1000
      await utimes(cacheFile, t, t)
    }
  })

const provided = <A, E>(state: Ref.Ref<MockState>, eff: Effect.Effect<A, E, ModelsDev.Service>) =>
  Effect.gen(function* () {
    // PR #52 后 wanlaicode fetch 走 createFetchWithoutProxy（node:http 直接），
    // 不经 HttpClient mock；用 setFetchWithoutProxyForTesting 钩进同一份 state.calls。
    WanlaiCodeAuth.setFetchWithoutProxyForTesting(async (input, init) => {
      const url = input.toString()
      const authorization = new Headers(init?.headers).get("authorization") ?? undefined
      await Effect.runPromise(Ref.update(state, (s) => ({ ...s, calls: [...s.calls, { url, authorization }] })))
      const s = await Effect.runPromise(Ref.get(state))
      const body = Object.entries(s.bodies ?? {}).find(([u]) => url.includes(u))?.[1] ?? s.body
      const status = Object.entries(s.statuses ?? {}).find(([u]) => url.includes(u))?.[1] ?? s.status
      return new Response(body, { status })
    })
    yield* Effect.addFinalizer(() => Effect.sync(() => WanlaiCodeAuth.setFetchWithoutProxyForTesting(undefined)))
    return yield* eff.pipe(Effect.provide(buildLayer(state)))
  }).pipe(Effect.scoped)

beforeEach(async () => {
  cacheDir = await mkdtemp(path.join(os.tmpdir(), "opencode-models-test-"))
  cacheFile = path.join(cacheDir, "models.json")
  Flag.WANLAICODE_MODELS_PATH = cacheFile
  Flag.WANLAICODE_DISABLE_MODELS_FETCH = true
  // 置空 JSON 而不是 delete:Auth.all() 里 `if (authContent)` 对未设置/空串都为假,
  // 会回落读 Global.Path.data/auth.json —— 那样用例的认证前置条件就取决于跑它的
  // 机器有没有登录态(CI windows runner 上有,linux 上没有,于是同一份代码结果不同)。
  process.env.WANLAICODE_AUTH_CONTENT = "{}"
  process.env.OPENCODE_AUTH_CONTENT = "{}"
  await rm(cacheFile, { force: true })
})

afterEach(async () => {
  if (!cacheDir) return
  await rm(cacheDir, { recursive: true, force: true })
  cacheDir = undefined
  cacheFile = ""
})

afterAll(() => {
  Flag.WANLAICODE_MODELS_PATH = ORIGINAL_MODELS_PATH
  Flag.WANLAICODE_DISABLE_MODELS_FETCH = ORIGINAL_DISABLE_FETCH
  Flag.WANLAICODE_DISABLE_MODELS_SNAPSHOT = ORIGINAL_DISABLE_SNAPSHOT
  delete process.env.WANLAICODE_AUTH_CONTENT
  delete process.env.OPENCODE_AUTH_CONTENT
})

const initialState: MockState = {
  body: JSON.stringify(fixture),
  status: 200,
  calls: [],
}

describe("ModelsDev Service", () => {
  it.live("get() returns providers from disk when cache file exists", () =>
    Effect.gen(function* () {
      yield* writeCache(fixture)
      const state = yield* Ref.make(initialState)
      const result = yield* provided(
        state,
        ModelsDev.Service.use((s) => s.get()),
      )
      expect(result).toEqual(fixture)
      const final = yield* Ref.get(state)
      expect(final.calls).toEqual([])
    }),
  )

  it.live("get() drops cached legacy WanlaiCode DeepSeek fallback", () =>
    Effect.gen(function* () {
      yield* writeCache({
        ...fixture,
        wanlaicode: {
          id: "wanlaicode",
          name: "万来Code",
          env: ["WANLAICODE_API_KEY"],
          models: {
            "deepseek-v4-flash": {
              id: "deepseek-v4-flash",
              name: "DeepSeek V4 Flash",
              release_date: "2024-01-01",
              attachment: false,
              reasoning: true,
              temperature: true,
              tool_call: true,
              limit: { context: 1000000, output: 384000 },
              wanlaicode: { rate_multiplier: 0 },
            },
          },
        },
      } satisfies Record<string, ModelsDev.Provider>)
      const state = yield* Ref.make(initialState)
      const result = yield* provided(
        state,
        ModelsDev.Service.use((s) => s.get()),
      )
      expect(result.acme?.models["acme-1"]).toBeDefined()
      expect(result.wanlaicode).toBeUndefined()
      const final = yield* Ref.get(state)
      expect(final.calls).toEqual([])
    }),
  )

  it.live("get() uses OAuth runtimeKey when WanlaiCode auth session exists", () =>
    Effect.gen(function* () {
      Flag.WANLAICODE_DISABLE_MODELS_FETCH = false
      process.env.WANLAICODE_AUTH_CONTENT = JSON.stringify({
        wanlaicode: {
          type: "oauth",
          access: "runtime_key_123",
          refresh: "refresh_123",
          expires: Date.now() + 60_000,
        },
      })
      const state = yield* Ref.make<MockState>({
        ...initialState,
        bodies: {
          "/api.json": JSON.stringify(fixture),
          "/v1/models": JSON.stringify({ data: [] }),
        },
      })
      yield* provided(
        state,
        ModelsDev.Service.use((s) => s.get()),
      )
      const final = yield* Ref.get(state)
      expect(final.calls.some((call) => call.url.includes(wanlaiCodeModelsURL()))).toBe(true)
    }),
  )

  it.live("get() fetches WanlaiCode models without auth for public model listing", () =>
    Effect.gen(function* () {
      Flag.WANLAICODE_DISABLE_MODELS_FETCH = false
      const state = yield* Ref.make<MockState>({
        ...initialState,
        bodies: {
          "/api.json": JSON.stringify(fixture),
          "/v1/models": JSON.stringify({
            data: [
              {
                id: "wanlai-free",
                display_name: "Wanlai Free",
                rate_multiplier: 0,
              },
              {
                id: "wanlai-paid",
                display_name: "Wanlai Paid",
                rate_multiplier: 1,
              },
            ],
          }),
        },
      })
      const result = yield* provided(
        state,
        ModelsDev.Service.use((s) => s.get()),
      )
      expect(result.wanlaicode?.models["wanlai-free"]?.wanlaicode?.rate_multiplier).toBe(0)
      expect(result.wanlaicode?.models["wanlai-paid"]?.wanlaicode?.rate_multiplier).toBe(1)
      const final = yield* Ref.get(state)
      const modelsCall = final.calls.find((call) => call.url.includes(wanlaiCodeModelsURL()))
      expect(modelsCall?.authorization).toBeUndefined()
    }),
  )

  it.live("get() keeps WanlaiCode provider exactly aligned with backend account whitelist", () =>
    Effect.gen(function* () {
      Flag.WANLAICODE_DISABLE_MODELS_FETCH = false
      process.env.WANLAICODE_AUTH_CONTENT = JSON.stringify({
        wanlaicode: {
          type: "oauth",
          access: "runtime_key_123",
          refresh: "refresh_123",
          expires: Date.now() + 60_000,
        },
      })
      const state = yield* Ref.make<MockState>({
        ...initialState,
        bodies: {
          "/api.json": JSON.stringify({
            ...fixture,
            deepseek: {
              id: "deepseek",
              name: "DeepSeek",
              env: ["DEEPSEEK_API_KEY"],
              models: {
                "deepseek/deepseek-chat": {
                  id: "deepseek/deepseek-chat",
                  name: "DeepSeek Chat",
                  release_date: "2026-01-01",
                  attachment: false,
                  reasoning: false,
                  temperature: true,
                  tool_call: true,
                  limit: { context: 128000, output: 8192 },
                },
              },
            },
            wanlaicode: {
              id: "wanlaicode",
              name: "万来Code",
              env: ["WANLAICODE_API_KEY"],
              models: {
                "deepseek-chat": {
                  id: "deepseek-chat",
                  name: "DeepSeek Chat",
                  release_date: "2026-01-01",
                  attachment: false,
                  reasoning: false,
                  temperature: true,
                  tool_call: true,
                  limit: { context: 128000, output: 8192 },
                },
                "deepseek-reasoner": {
                  id: "deepseek-reasoner",
                  name: "DeepSeek Reasoner",
                  release_date: "2026-01-01",
                  attachment: false,
                  reasoning: true,
                  temperature: true,
                  tool_call: true,
                  limit: { context: 128000, output: 8192 },
                },
              },
            },
          } satisfies Record<string, ModelsDev.Provider>),
          "/v1/models": JSON.stringify({
            data: [
              { id: "deepseek-v3", display_name: "DeepSeek V3", reasoning: false },
              { id: "deepseek-v4-pro", display_name: "DeepSeek V4 Pro", reasoning: true },
            ],
          }),
        },
      })
      const result = yield* provided(
        state,
        ModelsDev.Service.use((s) => s.get()),
      )
      const wanlaiModelIDs = Object.keys(result.wanlaicode?.models ?? {}).sort()
      expect(wanlaiModelIDs).toEqual(["deepseek-v3", "deepseek-v4-pro"])
      expect(result.wanlaicode?.models["deepseek-chat"]).toBeUndefined()
      expect(result.wanlaicode?.models["deepseek-reasoner"]).toBeUndefined()
      expect(result.wanlaicode?.models["deepseek-v4-flash"]).toBeUndefined()
      expect(result.wanlaicode?.models["deepseek/deepseek-chat"]).toBeUndefined()
      expect(result.deepseek?.models["deepseek/deepseek-chat"]).toBeDefined()
    }),
  )

  it.live("get() maps WanlaiCode image model type to output image modality", () =>
    Effect.gen(function* () {
      Flag.WANLAICODE_DISABLE_MODELS_FETCH = false
      const state = yield* Ref.make<MockState>({
        ...initialState,
        bodies: {
          "/api.json": JSON.stringify(fixture),
          "/v1/models": JSON.stringify({
            data: [
              {
                id: "gpt-image-2",
                type: "image",
                display_name: "gpt-image-2",
                attachment: true,
                rate_multiplier: 2,
              },
            ],
          }),
        },
      })
      const result = yield* provided(
        state,
        ModelsDev.Service.use((s) => s.get()),
      )
      expect(result.wanlaicode?.models["gpt-image-2"]?.modalities?.input).toEqual(["text", "image"])
      expect(result.wanlaicode?.models["gpt-image-2"]?.modalities?.output).toEqual(["image"])
    }),
  )

  it.live("get() maps WanlaiCode video model type to output video modality", () =>
    Effect.gen(function* () {
      Flag.WANLAICODE_DISABLE_MODELS_FETCH = false
      const state = yield* Ref.make<MockState>({
        ...initialState,
        bodies: {
          "/api.json": JSON.stringify(fixture),
          "/v1/models": JSON.stringify({
            data: [
              {
                id: "seedance-2.0-fast-5s-portrait",
                type: "video",
                display_name: "Seedance 2.0 Fast",
                attachment: true,
                rate_multiplier: 5,
              },
            ],
          }),
        },
      })
      const result = yield* provided(
        state,
        ModelsDev.Service.use((s) => s.get()),
      )
      expect(result.wanlaicode?.models["seedance-2.0-fast-5s-portrait"]?.modalities?.input).toEqual(["text", "image"])
      expect(result.wanlaicode?.models["seedance-2.0-fast-5s-portrait"]?.modalities?.output).toEqual(["video"])
    }),
  )

  it.live("get() preserves WanlaiCode backend modalities, reasoning_options, and pricing unit", () =>
    Effect.gen(function* () {
      Flag.WANLAICODE_DISABLE_MODELS_FETCH = false
      const state = yield* Ref.make<MockState>({
        ...initialState,
        bodies: {
          "/api.json": JSON.stringify(fixture),
          "/v1/models": JSON.stringify({
            data: [
              {
                id: "seedance-2.0-fast-10s-landscape",
                type: "video",
                display_name: "Seedance 2.0 Fast",
                modalities: { input: ["text", "image"], output: ["video"] },
                supported_modalities: ["text", "image"],
                supported_output_modalities: ["video"],
              },
              {
                id: "deepseek-v4-pro",
                type: "text",
                display_name: "DeepSeek V4 Pro",
                reasoning: true,
                reasoning_options: [{ type: "effort", values: ["high"] }],
                reasoning_efforts: ["low", "medium", "high"],
                modalities: { input: ["text"], output: ["text"] },
                supported_modalities: ["text"],
                supported_output_modalities: ["text"],
                pricing: { currency: "CNY", unit: "per_1m_tokens", input: 12, output: 24, cache_write: 0, cache_read: 0.1 },
              },
            ],
          }),
        },
      })
      const result = yield* provided(
        state,
        ModelsDev.Service.use((s) => s.get()),
      )
      expect(result.wanlaicode?.models["seedance-2.0-fast-10s-landscape"]?.modalities).toEqual({
        input: ["text", "image"],
        output: ["video"],
      })
      expect(result.wanlaicode?.models["deepseek-v4-pro"]?.modalities).toEqual({
        input: ["text"],
        output: ["text"],
      })
      expect(result.wanlaicode?.models["deepseek-v4-pro"]?.reasoning_options).toEqual([{ type: "effort", values: ["high"] }])
      expect(result.wanlaicode?.models["deepseek-v4-pro"]?.reasoning_efforts).toEqual(["high"])
      expect(result.wanlaicode?.models["deepseek-v4-pro"]?.pricing?.unit).toBe("per_1m_tokens")
    }),
  )

  it.live("get() treats empty WanlaiCode model response as an empty model list", () =>
    Effect.gen(function* () {
      Flag.WANLAICODE_DISABLE_MODELS_FETCH = false
      process.env.WANLAICODE_AUTH_CONTENT = JSON.stringify({
        wanlaicode: {
          type: "oauth",
          access: "runtime_key_123",
          refresh: "refresh_123",
          expires: Date.now() + 60_000,
        },
      })
      const state = yield* Ref.make<MockState>({
        ...initialState,
        bodies: {
          "/api.json": JSON.stringify(fixture),
          "/v1/models": "",
        },
      })
      const result = yield* provided(
        state,
        ModelsDev.Service.use((s) => s.get()),
      )
      expect(result.acme?.models["acme-1"]).toBeDefined()
      expect(result.wanlaicode?.models).toEqual({})
      const final = yield* Ref.get(state)
      expect(final.calls.some((call) => call.url.includes(wanlaiCodeModelsURL()))).toBe(true)
    }),
  )

  it.live("get() accepts legacy WanlaiCode model arrays", () =>
    Effect.gen(function* () {
      Flag.WANLAICODE_DISABLE_MODELS_FETCH = false
      const state = yield* Ref.make<MockState>({
        ...initialState,
        bodies: {
          "/api.json": JSON.stringify(fixture),
          "/v1/models": JSON.stringify([{ id: "legacy-model", display_name: "Legacy Model", rate_multiplier: 1 }]),
        },
      })
      const result = yield* provided(
        state,
        ModelsDev.Service.use((s) => s.get()),
      )
      expect(result.wanlaicode?.models["legacy-model"]?.name).toBe("Legacy Model")
    }),
  )

  it.live("get() accepts legacy WanlaiCode models field", () =>
    Effect.gen(function* () {
      Flag.WANLAICODE_DISABLE_MODELS_FETCH = false
      const state = yield* Ref.make<MockState>({
        ...initialState,
        bodies: {
          "/api.json": JSON.stringify(fixture),
          "/v1/models": JSON.stringify({
            models: [{ id: "legacy-field-model", display_name: "Legacy Field Model", rate_multiplier: 1 }],
          }),
        },
      })
      const result = yield* provided(
        state,
        ModelsDev.Service.use((s) => s.get()),
      )
      expect(result.wanlaicode?.models["legacy-field-model"]?.name).toBe("Legacy Field Model")
    }),
  )

  it.live("get() fetches public WanlaiCode models when OAuth session has no runtime key", () =>
    Effect.gen(function* () {
      Flag.WANLAICODE_DISABLE_MODELS_FETCH = false
      process.env.WANLAICODE_AUTH_CONTENT = JSON.stringify({
        wanlaicode: {
          type: "oauth",
          access: "",
          refresh: "refresh_123",
          expires: Date.now() + 60_000,
        },
      })
      const state = yield* Ref.make<MockState>({
        ...initialState,
        bodies: {
          "/api.json": JSON.stringify(fixture),
          "/v1/models": JSON.stringify({
            data: [{ id: "public-model", display_name: "Public Model" }],
          }),
        },
      })
      const result = yield* provided(
        state,
        ModelsDev.Service.use((s) => s.get()),
      )
      expect(result.acme?.models["acme-1"]).toBeDefined()
      expect(result.wanlaicode?.models["public-model"]?.name).toBe("Public Model")
      expect(result.wanlaicode?.models["public-model"]?.wanlaicode).toBeUndefined()
      expect(Object.keys(result.wanlaicode?.models ?? {})).toEqual(["public-model"])
      expect(result.wanlaicode?.models["deepseek-v4-flash"]).toBeUndefined()
      const final = yield* Ref.get(state)
      const modelsCall = final.calls.find((call) => call.url.includes(wanlaiCodeModelsURL()))
      expect(modelsCall).toBeDefined()
      expect(modelsCall?.authorization).toBeUndefined()
    }),
  )

  it.live("get() falls back when anonymous WanlaiCode model listing is unauthorized", () =>
    Effect.gen(function* () {
      Flag.WANLAICODE_DISABLE_MODELS_FETCH = false
      for (const status of [401, 403]) {
        yield* Effect.promise(() => rm(cacheFile, { force: true }))
        const state = yield* Ref.make<MockState>({
          ...initialState,
          calls: [],
          bodies: {
            "/api.json": JSON.stringify(fixture),
            "/v1/models": JSON.stringify({ error: { message: "unauthorized" } }),
          },
          statuses: {
            "/v1/models": status,
          },
        })
        const result = yield* provided(
          state,
          ModelsDev.Service.use((s) => s.get()),
        )
        expect(result.acme?.models["acme-1"]).toBeDefined()
        expect(result.wanlaicode).toBeUndefined()
        const final = yield* Ref.get(state)
        expect(final.calls.some((call) => call.url.includes(wanlaiCodeModelsURL()))).toBe(true)
      }
    }),
  )

  it.live("get() prefers service-side WanlaiCode auth over env key", () =>
    Effect.gen(function* () {
      Flag.WANLAICODE_DISABLE_MODELS_FETCH = false
      process.env.WANLAICODE_AUTH_CONTENT = JSON.stringify({
        wanlaicode: {
          type: "oauth",
          access: "runtime_key_123",
          refresh: "refresh_123",
          expires: Date.now() + 60_000,
        },
      })
      process.env.WANLAICODE_API_KEY = "env_key_123"
      const state = yield* Ref.make<MockState>({
        ...initialState,
        bodies: {
          "/api.json": JSON.stringify(fixture),
          "/v1/models": JSON.stringify({ data: [] }),
        },
      })
      yield* provided(
        state,
        ModelsDev.Service.use((s) => s.get()),
      )
      const final = yield* Ref.get(state)
      expect(final.calls.some((call) => call.url.includes(wanlaiCodeModelsURL()))).toBe(true)
    }),
  )

  it.live("get() writes fetched models when bundled snapshot exists but disk cache is missing", () =>
    Effect.gen(function* () {
      Flag.WANLAICODE_DISABLE_MODELS_FETCH = false
      process.env.WANLAICODE_AUTH_CONTENT = JSON.stringify({ wanlaicode: { type: "api", key: "test-key" } })
      const state = yield* Ref.make<MockState>({
        ...initialState,
        bodies: {
          "/api.json": JSON.stringify(fixture),
          "/v1/models": JSON.stringify({ data: [] }),
        },
      })
      const result = yield* provided(
        state,
        ModelsDev.Service.use((s) => s.get()),
      )
      const expected = {
        ...fixture,
        wanlaicode: {
          id: "wanlaicode",
          env: ["WANLAICODE_API_KEY"],
          npm: "@ai-sdk/openai-compatible",
          api: WanlaiCodeAuth.resolveConfig().apiBase,
          name: "万来Code",
          models: {},
        },
      }
      expect(result).toEqual(expected)
      const written = JSON.parse(yield* Effect.promise(() => Bun.file(cacheFile).text()))
      expect(written).toEqual(expected)
      const final = yield* Ref.get(state)
      expect(final.calls.some((call) => call.url.includes("/api.json"))).toBe(true)
    }),
  )

  it.live("get() falls back to stale disk cache when fetch fails", () =>
    Effect.gen(function* () {
      Flag.WANLAICODE_DISABLE_MODELS_FETCH = false
      yield* writeCache(fixture, Date.now() - 10 * 60 * 1000)
      const state = yield* Ref.make({ ...initialState, status: 500 })
      const result = yield* provided(
        state,
        ModelsDev.Service.use((s) => s.get()),
      )
      expect(result).toEqual(fixture)
      const final = yield* Ref.get(state)
      expect(final.calls.some((call) => call.url.includes("/api.json"))).toBe(false)
    }),
  )

  it.live("get() falls back to stale disk cache when fetched models JSON is invalid", () =>
    Effect.gen(function* () {
      Flag.WANLAICODE_DISABLE_MODELS_FETCH = false
      yield* writeCache(fixture, Date.now() - 10 * 60 * 1000)
      const state = yield* Ref.make({ ...initialState, body: "{" })
      const result = yield* provided(
        state,
        ModelsDev.Service.use((s) => s.get()),
      )
      expect(result).toEqual(fixture)
      const final = yield* Ref.get(state)
      expect(final.calls.some((call) => call.url.includes("/api.json"))).toBe(false)
    }),
  )

  it.live("get() returns {} when disk empty and fetch disabled", () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(initialState)
      const result = yield* provided(
        state,
        ModelsDev.Service.use((s) => s.get()),
      )
      expect(result).toEqual({})
      const final = yield* Ref.get(state)
      expect(final.calls).toEqual([])
    }),
  )

  it.live("get() is single-flight under concurrent calls", () =>
    Effect.gen(function* () {
      yield* writeCache(fixture)
      const state = yield* Ref.make(initialState)
      const results = yield* provided(
        state,
        Effect.gen(function* () {
          const svc = yield* ModelsDev.Service
          return yield* Effect.all([svc.get(), svc.get(), svc.get(), svc.get(), svc.get()], {
            concurrency: "unbounded",
          })
        }),
      )
      for (const result of results) expect(result).toEqual(fixture)
    }),
  )

  it.live("get() reloads when the on-disk cache is updated", () =>
    Effect.gen(function* () {
      yield* writeCache(fixture)
      const state = yield* Ref.make(initialState)
      const first = yield* provided(
        state,
        Effect.gen(function* () {
          const svc = yield* ModelsDev.Service
          const a = yield* svc.get()
          // The desktop sidecar and WS refresh path can update models.json outside
          // this cached get path; get() must observe a newer mtime immediately.
          yield* writeCache(fixture2)
          const b = yield* svc.get()
          return { a, b }
        }),
      )
      expect(first.a).toEqual(fixture)
      expect(first.b).toEqual(fixture2)
    }),
  )

  it.live("refresh(true) fetches via HttpClient and updates the cache", () =>
    Effect.gen(function* () {
      yield* writeCache(fixture)
      const state = yield* Ref.make({ ...initialState, body: JSON.stringify(fixture2) })
      const result = yield* provided(
        state,
        Effect.gen(function* () {
          const svc = yield* ModelsDev.Service
          const before = yield* svc.get()
          yield* svc.refresh(true)
          const after = yield* svc.get()
          return { before, after }
        }),
      )
      expect(result.before).toEqual(fixture)
      expect(result.after).toEqual(fixture2)
      const final = yield* Ref.get(state)
      // 只断言 /api.json 调一次：跨文件 Auth state 残留可能让 wanlaicode fetch 额外触发
      const apiJsonCalls = final.calls.filter((c) => c.url.includes("/api.json"))
      expect(apiJsonCalls.length).toBe(1)
    }),
  )

  it.live("refresh(false) skips fetch when on-disk file is fresh", () =>
    Effect.gen(function* () {
      // Fresh: mtime within the 5-minute TTL.
      yield* writeCache(fixture, Date.now() - 1000)
      const state = yield* Ref.make({ ...initialState, body: JSON.stringify(fixture2) })
      yield* provided(
        state,
        ModelsDev.Service.use((s) => s.refresh(false)),
      )
      const final = yield* Ref.get(state)
      expect(final.calls).toEqual([])
    }),
  )

  it.live("refresh(false) fetches when on-disk file is stale", () =>
    Effect.gen(function* () {
      // Stale: mtime 10 minutes ago, beyond the 5-minute TTL.
      yield* writeCache(fixture, Date.now() - 10 * 60 * 1000)
      const state = yield* Ref.make({ ...initialState, body: JSON.stringify(fixture2) })
      const after = yield* provided(
        state,
        Effect.gen(function* () {
          const svc = yield* ModelsDev.Service
          yield* svc.refresh(false)
          return yield* svc.get()
        }),
      )
      const final = yield* Ref.get(state)
      // 同 refresh(true)
      const apiJsonCalls = final.calls.filter((c) => c.url.includes("/api.json"))
      expect(apiJsonCalls.length).toBe(1)
      expect(after).toEqual(fixture2)
    }),
  )

  it.live("refresh(true) keeps stale WanlaiCode models when the backend temporarily returns an empty list", () =>
    Effect.gen(function* () {
      yield* writeCache({
        ...fixture,
        wanlaicode: {
          id: "wanlaicode",
          env: ["WANLAICODE_API_KEY"],
          npm: "@ai-sdk/openai-compatible",
          api: WanlaiCodeAuth.resolveConfig().apiBase,
          name: "万来Code",
          models: {
            "gpt-image-2": {
              id: "gpt-image-2",
              name: "GPT Image 2",
              release_date: "2026-01-01",
              attachment: true,
              reasoning: false,
              temperature: true,
              tool_call: true,
              limit: { context: 128000, output: 8192 },
              modalities: { input: ["text", "image"], output: ["image"] },
            },
          },
        },
      } satisfies Record<string, ModelsDev.Provider>, Date.now() - 10 * 60 * 1000)
      const state = yield* Ref.make<MockState>({
        ...initialState,
        bodies: {
          "/api.json": JSON.stringify(fixture),
          "/v1/models": JSON.stringify({ data: [] }),
        },
      })
      const result = yield* provided(
        state,
        Effect.gen(function* () {
          const svc = yield* ModelsDev.Service
          yield* svc.refresh(true)
          return yield* svc.get()
        }),
      )
      expect(result.acme?.models["acme-1"]).toBeDefined()
      expect(Object.keys(result.wanlaicode?.models ?? {})).toEqual(["gpt-image-2"])
    }),
  )

  it.live("refreshWanlaiCode() invalidates cached get() and bumps revision", () =>
    Effect.gen(function* () {
      yield* writeCache({
        ...fixture,
        wanlaicode: {
          id: "wanlaicode",
          env: ["WANLAICODE_API_KEY"],
          npm: "@ai-sdk/openai-compatible",
          api: WanlaiCodeAuth.resolveConfig().apiBase,
          name: "万来Code",
          models: {
            stale: {
              id: "stale",
              name: "Stale",
              release_date: "2026-01-01",
              attachment: false,
              reasoning: false,
              temperature: true,
              tool_call: true,
              limit: { context: 128000, output: 8192 },
            },
          },
        },
      } satisfies Record<string, ModelsDev.Provider>)
      const state = yield* Ref.make<MockState>({
        ...initialState,
        bodies: {
          "/v1/models": JSON.stringify({
            data: [
              {
                id: "gpt-image-2",
                type: "image",
                display_name: "GPT Image 2",
                created_at: "2026-01-01T00:00:00Z",
                attachment: true,
                reasoning: false,
                toolcall: true,
                context_length: 128000,
                max_completion_tokens: 8192,
                rate_multiplier: 1,
              },
            ],
          }),
        },
      })
      const result = yield* provided(
        state,
        Effect.gen(function* () {
          const svc = yield* ModelsDev.Service
          const before = yield* svc.get()
          const beforeRevision = yield* (svc.revision?.() ?? Effect.succeed(0))
          yield* svc.refreshWanlaiCode()
          const afterRevision = yield* (svc.revision?.() ?? Effect.succeed(0))
          const after = yield* svc.get()
          return { before, beforeRevision, after, afterRevision }
        }),
      )

      expect(Object.keys(result.before.wanlaicode?.models ?? {})).toEqual(["stale"])
      expect(result.afterRevision).toBeGreaterThan(result.beforeRevision)
      expect(Object.keys(result.after.wanlaicode?.models ?? {})).toEqual(["gpt-image-2"])
    }),
  )

  it.live("get() retries WanlaiCode models after OAuth refresh on 401", () =>
    Effect.gen(function* () {
      Flag.WANLAICODE_DISABLE_MODELS_FETCH = false
      process.env.WANLAICODE_AUTH_CONTENT = JSON.stringify({
        wanlaicode: {
          type: "oauth",
          access: "runtime_key_123",
          refresh: "refresh_123",
          expires: Date.now() + 60_000,
          accountId: "acct_123",
          enterpriseUrl: "https://wanlai.ai",
        },
      })
      const state = yield* Ref.make<MockState>({
        ...initialState,
        bodies: {
          "/api.json": JSON.stringify(fixture),
          "/v1/oauth/token": JSON.stringify({ access_token: "access_456", refresh_token: "refresh_456", expires_in: 7200 }),
          "/api/oauth/profile": JSON.stringify({ entitlement: { plan: "pro" }, account: { uuid: "acct_123" } }),
          "/api/oauth/wanlaicode/create_api_key": JSON.stringify({ raw_key: "runtime_key_456" }),
          "/v1/models": JSON.stringify({ data: [] }),
        },
      })
      yield* Ref.set(state, {
        ...(yield* Ref.get(state)),
        calls: [],
      })

      // PR #52 后 wanlaicode 走 createFetchWithoutProxy，不经 HttpClient mock；
      // 用 setFetchWithoutProxyForTesting 钩进同一份 state.calls 并模拟 401。
      WanlaiCodeAuth.setFetchWithoutProxyForTesting(async (input, init) => {
        const url = input.toString()
        const authorization = new Headers(init?.headers).get("authorization") ?? undefined
        await Effect.runPromise(Ref.update(state, (s) => ({ ...s, calls: [...s.calls, { url, authorization }] })))
        const s = await Effect.runPromise(Ref.get(state))
        const isWanlaiModels = url.includes(wanlaiCodeModelsURL())
        if (isWanlaiModels && authorization === "Bearer runtime_key_123") {
          return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 })
        }
        const body = Object.entries(s.bodies ?? {}).find(([u]) => url.includes(u))?.[1] ?? s.body
        return new Response(body, { status: s.status })
      })

      const client = HttpClient.make((request) =>
        Effect.gen(function* () {
          yield* Ref.update(state, (s) => ({
            ...s,
            calls: [...s.calls, { url: request.url, authorization: request.headers["authorization"] }],
          }))
          const calls = yield* Ref.get(state)
          const matchingBody = Object.entries(calls.bodies ?? {}).find(([url]) => request.url.includes(url))?.[1] ?? calls.body
          return HttpClientResponse.fromWeb(request, new Response(matchingBody, { status: calls.status }))
        }),
      )

      const layer = Layer.fresh(ModelsDev.layer).pipe(
        Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
        Layer.provide(AppFileSystem.defaultLayer),
        Layer.provide(Env.defaultLayer),
        Layer.provide(Auth.defaultLayer),
        Layer.provide(Config.defaultLayer),
      )

      try {
        const result = yield* ModelsDev.Service.use((s) => s.get()).pipe(Effect.provide(layer))
        const final = yield* Ref.get(state)
        const wanlaiModelCalls = final.calls.filter((call) => call.url.includes(wanlaiCodeModelsURL()))
        expect(wanlaiModelCalls[0]?.authorization).toBe("Bearer runtime_key_123")
        expect(final.calls.some((call) => call.url.includes("/v1/oauth/token"))).toBe(true)
        expect(wanlaiModelCalls).toHaveLength(2)
        expect(result.wanlaicode?.models).toEqual({})
        expect(final.calls.some((call) => call.url.includes("/api/oauth/profile"))).toBe(true)
        expect(final.calls.some((call) => call.url.includes("/api/oauth/wanlaicode/create_api_key"))).toBe(true)
      } finally {
        WanlaiCodeAuth.setFetchWithoutProxyForTesting(undefined)
      }
    }),
  )

  it.live("get() does not refresh API key mode when WanlaiCode models return 401", () =>
    Effect.gen(function* () {
      Flag.WANLAICODE_DISABLE_MODELS_FETCH = false
      process.env.WANLAICODE_AUTH_CONTENT = JSON.stringify({
        wanlaicode: {
          type: "api",
          key: "api_key_123",
        },
      })
      const state = yield* Ref.make<MockState>({
        ...initialState,
        bodies: {
          "/api.json": JSON.stringify(fixture),
        },
      })

      // wanlaicode /v1/models 走 createFetchWithoutProxy，钩进 state.calls 并模拟 401。
      WanlaiCodeAuth.setFetchWithoutProxyForTesting(async (input) => {
        const url = input.toString()
        await Effect.runPromise(Ref.update(state, (s) => ({ ...s, calls: [...s.calls, { url }] })))
        if (url.includes(wanlaiCodeModelsURL())) {
          return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 })
        }
        const s = await Effect.runPromise(Ref.get(state))
        return new Response(s.body, { status: s.status })
      })

      const client = HttpClient.make((request) =>
        Effect.gen(function* () {
          yield* Ref.update(state, (s) => ({ ...s, calls: [...s.calls, { url: request.url }] }))
          const s = yield* Ref.get(state)
          return HttpClientResponse.fromWeb(request, new Response(s.body, { status: s.status }))
        }),
      )

      const layer = Layer.fresh(ModelsDev.layer).pipe(
        Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
        Layer.provide(AppFileSystem.defaultLayer),
        Layer.provide(Env.defaultLayer),
        Layer.provide(Auth.defaultLayer),
        Layer.provide(Config.defaultLayer),
      )

      try {
        const result = yield* ModelsDev.Service.use((s) => s.get()).pipe(Effect.provide(layer))
        expect(result.wanlaicode).toBeUndefined()
        const final = yield* Ref.get(state)
        expect(final.calls.filter((call) => call.url.includes(wanlaiCodeModelsURL()))).toHaveLength(1)
        expect(final.calls.some((call) => call.url.includes("/v1/oauth/token"))).toBe(false)
      } finally {
        WanlaiCodeAuth.setFetchWithoutProxyForTesting(undefined)
      }
    }),
  )

  it.live("refreshWanlaiCode() preserves stale WanlaiCode models when entitlement is missing", () =>
    Effect.gen(function* () {
      const stale = {
        ...fixture,
        wanlaicode: {
          id: "wanlaicode",
          env: ["WANLAICODE_API_KEY"],
          npm: "@ai-sdk/openai-compatible",
          api: WanlaiCodeAuth.resolveConfig().apiBase,
          name: "万来Code",
          models: {
            "stale-model": {
              id: "stale-model",
              name: "Stale Model",
              release_date: "2026-01-01",
              attachment: false,
              reasoning: false,
              temperature: true,
              tool_call: true,
              limit: { context: 128000, output: 8192 },
            },
          },
        },
      } satisfies Record<string, ModelsDev.Provider>
      yield* writeCache(stale)
      const state = yield* Ref.make<MockState>({
        ...initialState,
        bodies: {
          "/v1/models": JSON.stringify({
            error: "software_product_not_entitled",
            message: "user does not have this software product",
          }),
        },
        statuses: {
          "/v1/models": 403,
        },
      })
      const result = yield* provided(
        state,
        Effect.gen(function* () {
          const svc = yield* ModelsDev.Service
          yield* svc.refreshWanlaiCode()
          return JSON.parse(yield* Effect.promise(() => Bun.file(cacheFile).text())) as Record<string, ModelsDev.Provider>
        }),
      )
      expect(result.acme?.models["acme-1"]).toBeDefined()
      expect(result.wanlaicode?.models["stale-model"]).toBeDefined()
      const final = yield* Ref.get(state)
      expect(final.calls.some((call) => call.url.includes(wanlaiCodeModelsURL()))).toBe(true)
    }),
  )

  it.live("refreshWanlaiCode() replaces stale WanlaiCode models after a successful refresh", () =>
    Effect.gen(function* () {
      yield* writeCache({
        ...fixture,
        wanlaicode: {
          id: "wanlaicode",
          env: ["WANLAICODE_API_KEY"],
          npm: "@ai-sdk/openai-compatible",
          api: WanlaiCodeAuth.resolveConfig().apiBase,
          name: "万来Code",
          models: {
            "gpt-image-2": {
              id: "gpt-image-2",
              name: "GPT Image 2",
              release_date: "2026-01-01",
              attachment: true,
              reasoning: false,
              temperature: true,
              tool_call: true,
              limit: { context: 128000, output: 8192 },
              modalities: { input: ["text", "image"], output: ["image"] },
            },
          },
        },
      } satisfies Record<string, ModelsDev.Provider>)
      const state = yield* Ref.make<MockState>({
        ...initialState,
        bodies: {
          "/v1/models": JSON.stringify({
            data: [
              {
                id: "gpt-5.5",
                type: "model",
                display_name: "gpt-5.5",
                attachment: true,
              },
            ],
          }),
        },
      })
      const result = yield* provided(
        state,
        Effect.gen(function* () {
          const svc = yield* ModelsDev.Service
          yield* svc.refreshWanlaiCode()
          return JSON.parse(yield* Effect.promise(() => Bun.file(cacheFile).text())) as Record<string, ModelsDev.Provider>
        }),
      )
      expect(result.acme?.models["acme-1"]).toBeDefined()
      expect(result.wanlaicode?.models["gpt-5.5"]).toBeDefined()
      expect(result.wanlaicode?.models["gpt-image-2"]).toBeUndefined()
    }),
  )

  it.live("refreshWanlaiCode() does not write legacy DeepSeek fallback when no entitlement and no previous models exist", () =>
    Effect.gen(function* () {
      yield* writeCache(fixture)
      const state = yield* Ref.make<MockState>({
        ...initialState,
        bodies: {
          "/v1/models": JSON.stringify({
            error: "software_product_not_entitled",
            message: "user does not have this software product",
          }),
        },
        statuses: {
          "/v1/models": 403,
        },
      })
      const result = yield* provided(
        state,
        Effect.gen(function* () {
          const svc = yield* ModelsDev.Service
          yield* svc.refreshWanlaiCode()
          return JSON.parse(yield* Effect.promise(() => Bun.file(cacheFile).text())) as Record<string, ModelsDev.Provider>
        }),
      )
      expect(result.acme?.models["acme-1"]).toBeDefined()
      expect(result.wanlaicode).toBeUndefined()
      const final = yield* Ref.get(state)
      const modelsCalls = final.calls.filter((call) => call.url.includes(wanlaiCodeModelsURL()))
      expect(modelsCalls).toHaveLength(2)
      expect(modelsCalls.at(-1)?.authorization).toBeUndefined()
    }),
  )

  it.live("refresh swallows HTTP errors and leaves cache intact", () =>
    Effect.gen(function* () {
      yield* writeCache(fixture)
      const state = yield* Ref.make({ ...initialState, status: 500, body: "boom" })
      const result = yield* provided(
        state,
        Effect.gen(function* () {
          const svc = yield* ModelsDev.Service
          yield* svc.refresh(true)
          return yield* svc.get()
        }),
      )
      expect(result).toEqual(fixture)
      // withTransientReadRetry retries 5xx, so calls may be > 1.
      const final = yield* Ref.get(state)
      expect(final.calls.length).toBeGreaterThanOrEqual(1)
    }),
  )

  it.live("cachedGet reuses populate, does not refetch on every call", () =>
    Effect.gen(function* () {
      Flag.WANLAICODE_DISABLE_MODELS_FETCH = false
      process.env.WANLAICODE_AUTH_CONTENT = JSON.stringify({ wanlaicode: { type: "api", key: "test-key" } })
      const state = yield* Ref.make<MockState>({
        ...initialState,
        bodies: {
          "/api.json": JSON.stringify(fixture),
          "/v1/models": JSON.stringify({ data: [] }),
        },
      })
      yield* provided(
        state,
        Effect.gen(function* () {
          const svc = yield* ModelsDev.Service
          yield* svc.get()
          yield* svc.get()
          yield* svc.get()
        }),
      )
      const { calls } = yield* Ref.get(state)
      // api.json + wanlaicode /v1/models = 2 calls total (single populate run)
      // Old bug: each get() would create its own cache → 3× populate → 6 calls
      expect(calls.length).toBe(2)
    }),
  )
})
