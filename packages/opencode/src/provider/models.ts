import { Global } from "@opencode-ai/core/global"
import path from "path"
import { Context, Duration, Effect, Layer, Option, Schedule, Schema, SynchronizedRef } from "effect"
import { HttpBody, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { Installation } from "../installation"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Flock } from "@opencode-ai/core/util/flock"
import { Hash } from "@opencode-ai/core/util/hash"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { withTransientReadRetry } from "@/util/effect-http-client"
import { Env } from "../env"
import { Auth } from "../auth"
import { Config } from "@/config/config"
import { NetProxy } from "@/net/proxy"
import { WanlaiCodeAuth } from "@/provider/wanlaicode"
import { WanlaiCodeRefreshCoordinator } from "@/provider/wanlaicode-refresh-coordinator"
import { Pricing } from "./pricing"

const Cost = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  cache_read: Schema.optional(Schema.Finite),
  cache_write: Schema.optional(Schema.Finite),
  context_over_200k: Schema.optional(
    Schema.Struct({
      input: Schema.Finite,
      output: Schema.Finite,
      cache_read: Schema.optional(Schema.Finite),
      cache_write: Schema.optional(Schema.Finite),
    }),
  ),
})

export const Model = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  family: Schema.optional(Schema.String),
  release_date: Schema.String,
  reasoning_options: Schema.optional(
    Schema.Array(
      Schema.StructWithRest(
        Schema.Struct({
          type: Schema.String,
          values: Schema.optional(Schema.Array(Schema.String)),
        }),
        [Schema.Record(Schema.String, Schema.Any)],
      ),
    ),
  ),
  reasoning_efforts: Schema.optional(Schema.Array(Schema.String)),
  attachment: Schema.Boolean,
  reasoning: Schema.Boolean,
  temperature: Schema.Boolean,
  tool_call: Schema.Boolean,
  interleaved: Schema.optional(
    Schema.Union([
      Schema.Literal(true),
      Schema.Struct({
        field: Schema.Literals(["reasoning_content", "reasoning_details"]),
      }),
    ]),
  ),
  cost: Schema.optional(Cost),
  limit: Schema.Struct({
    context: Schema.Finite,
    input: Schema.optional(Schema.Finite),
    output: Schema.Finite,
  }),
  modalities: Schema.optional(
    Schema.Struct({
      input: Schema.Array(Schema.Literals(["text", "audio", "image", "video", "pdf"])),
      output: Schema.Array(Schema.Literals(["text", "audio", "image", "video", "pdf"])),
    }),
  ),
  experimental: Schema.optional(
    Schema.Struct({
      modes: Schema.optional(
        Schema.Record(
          Schema.String,
          Schema.Struct({
            cost: Schema.optional(Cost),
            provider: Schema.optional(
              Schema.Struct({
                body: Schema.optional(Schema.Record(Schema.String, Schema.MutableJson)),
                headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
              }),
            ),
          }),
        ),
      ),
    }),
  ),
  status: Schema.optional(Schema.Literals(["alpha", "beta", "deprecated"])),
  provider: Schema.optional(
    Schema.Struct({ npm: Schema.optional(Schema.String), api: Schema.optional(Schema.String) }),
  ),
  wanlaicode: Schema.optional(
    Schema.Struct({ rate_multiplier: Schema.Number }),
  ),
  pricing: Schema.optional(Pricing),
})
export type Model = Schema.Schema.Type<typeof Model>

export const Provider = Schema.Struct({
  api: Schema.optional(Schema.String),
  name: Schema.String,
  env: Schema.Array(Schema.String),
  id: Schema.String,
  npm: Schema.optional(Schema.String),
  models: Schema.Record(Schema.String, Model),
})

const OpenAIModel = Schema.Struct({
  id: Schema.String,
  type: Schema.optional(Schema.String),
  display_name: Schema.optional(Schema.String),
  created_at: Schema.optional(Schema.String),
  reasoning: Schema.optional(Schema.Boolean),
  attachment: Schema.optional(Schema.Boolean),
  toolcall: Schema.optional(Schema.Boolean),
  context_length: Schema.optional(Schema.Number),
  context_Length: Schema.optional(Schema.Number),
  max_completion_tokens: Schema.optional(Schema.Number),
  rate_multiplier: Schema.optional(Schema.Number),
  reasoning_options: Schema.optional(
    Schema.Array(
      Schema.StructWithRest(
        Schema.Struct({
          type: Schema.String,
          values: Schema.optional(Schema.Array(Schema.String)),
        }),
        [Schema.Record(Schema.String, Schema.Any)],
      ),
    ),
  ),
  reasoning_efforts: Schema.optional(Schema.Array(Schema.String)),
  modalities: Schema.optional(
    Schema.Struct({
      input: Schema.optional(Schema.Array(Schema.Literals(["text", "audio", "image", "video", "pdf"]))),
      output: Schema.optional(Schema.Array(Schema.Literals(["text", "audio", "image", "video", "pdf"]))),
    }),
  ),
  supported_modalities: Schema.optional(Schema.Array(Schema.Literals(["text", "audio", "image", "video", "pdf"]))),
  supported_output_modalities: Schema.optional(Schema.Array(Schema.Literals(["text", "audio", "image", "video", "pdf"]))),
  pricing: Schema.optional(Pricing),
})

const OpenAIModelsResponse = Schema.Struct({
  data: Schema.Array(OpenAIModel),
})

export type Provider = Schema.Schema.Type<typeof Provider>
type OpenAIModelInfo = Schema.Schema.Type<typeof OpenAIModel>
type OpenAIModelsPayload = Schema.Schema.Type<typeof OpenAIModelsResponse>

function parseJsonText<T>(text: string, fallback: T, label: string) {
  const trimmed = text.trim()
  if (!trimmed) return fallback
  try {
    return JSON.parse(trimmed) as T
  } catch (cause) {
    throw new Error(`${label} returned invalid JSON`, { cause })
  }
}

function parseJsonTextOrFallback<T>(text: string, fallback: T, label: string) {
  try {
    return parseJsonText(text, fallback, label)
  } catch {
    return fallback
  }
}

function emptyOpenAIModelsPayload(): OpenAIModelsPayload {
  return OpenAIModelsResponse.make({ data: [] })
}

function normalizeOpenAIModelsPayload(raw: unknown): OpenAIModelsPayload {
  // 线上存在旧版/灰度后端返回数组或 models 字段的情况；统一归一到 OpenAI 的 data[]，避免客户端把可用模型误解析为空。
  if (Array.isArray(raw)) return OpenAIModelsResponse.make({ data: raw })
  if (typeof raw === "object" && raw !== null) {
    if ("data" in raw && Array.isArray(raw.data)) return OpenAIModelsResponse.make({ data: raw.data })
    if ("models" in raw && Array.isArray(raw.models)) return OpenAIModelsResponse.make({ data: raw.models })
  }
  // 无法识别的结构不是“明确的空列表”；抛错交给现有缓存回退，避免一次异常响应清空用户可用模型。
  throw new Error("WanlaiCode models returned an unsupported response shape")
}

function wanlaiCodeOutputModalities(model: OpenAIModelInfo) {
  // 新后端会下发真实输出模态；type 是业务能力兜底，不能用输入图片能力反推输出图像。
  if (model.modalities?.output?.length) return model.modalities.output
  if (model.supported_output_modalities?.length) return model.supported_output_modalities
  if (model.type === "image") return ["image"] as const
  if (model.type === "video") return ["video"] as const
  return ["text"] as const
}

function wanlaiCodeInputModalities(model: OpenAIModelInfo) {
  // 输入模态只描述附件/上下文输入能力；没有新字段时保留旧 attachment 兼容。
  if (model.modalities?.input?.length) return model.modalities.input
  if (model.supported_modalities?.length) return model.supported_modalities
  return model.attachment ? (["text", "image"] as const) : (["text"] as const)
}

function wanlaiCodeReasoningEfforts(model: OpenAIModelInfo) {
  // reasoning_options 是新版权威推理能力；旧 reasoning_efforts 仅在新版字段缺失时兜底。
  const effort = model.reasoning_options?.find((item) => item.type === "effort" && item.values?.length)
  return effort?.values ?? model.reasoning_efforts
}

function wanlaiCodeProvider(
  config: ReturnType<typeof WanlaiCodeAuth.resolveConfig>,
  models: readonly OpenAIModelInfo[],
): Record<string, Provider> {
  return {
    wanlaicode: {
      id: "wanlaicode",
      env: ["WANLAICODE_API_KEY"],
      npm: "@ai-sdk/openai-compatible",
      api: config.apiBase,
      name: "万来Code",
      models: Object.fromEntries(
        models.map((model) => [
          model.id,
          {
            id: model.id,
            name: model.display_name ?? model.id,
            family: model.id.split(/[.:/_-]/)[0] || model.id,
            attachment: model.attachment ?? false,
            reasoning: model.reasoning ?? false,
            temperature: true,
            tool_call: model.toolcall ?? true,
            release_date: model.created_at?.slice(0, 10) ?? "2024-01-01",
            reasoning_options: model.reasoning_options,
            reasoning_efforts: wanlaiCodeReasoningEfforts(model),
            modalities: {
              input: [...wanlaiCodeInputModalities(model)],
              output: [...wanlaiCodeOutputModalities(model)],
            },
            wanlaicode: model.rate_multiplier === undefined ? undefined : { rate_multiplier: model.rate_multiplier },
            // TODO: /v1/models 目前还没有返回 input/output cost 字段。
            // cost: { input: 0, output: 0 } 只是兼容通用免费模型判断的临时占位。
            // WanlaiCode provider 暂时使用 wanlaicode.rate_multiplier 判断是否免费。
            // 等接口提供标准 cost 字段后切回通用 cost 判断。
            cost: { input: 0, output: 0 },
            limit: { context: model.context_length ?? model.context_Length ?? 200000, output: model.max_completion_tokens ?? 128000 },
            pricing: model.pricing,
          },
        ]),
      ),
    },
  } satisfies Record<string, Provider>
}

function isWanlaiCodeNoEntitlement(error: unknown) {
  return WanlaiCodeAuth.isNoEntitlementRuntimeError(error) || WanlaiCodeAuth.isNoEntitlementError(error)
}

function hasProviderModels(provider: Provider | undefined) {
  return Object.keys(provider?.models ?? {}).length > 0
}

function isLegacyWanlaiCodeFreeFallback(provider: Provider | undefined) {
  const models = Object.values(provider?.models ?? {})
  return models.length === 1 && models[0]?.id === "deepseek-v4-flash" && models[0]?.wanlaicode?.rate_multiplier === 0
}

function replaceWanlaiCodeModels(previous: Record<string, Provider> | undefined, wanlaiCode: Record<string, Provider>) {
  return { ...(previous ?? {}), ...wanlaiCode }
}

export interface Interface {
  readonly get: () => Effect.Effect<Record<string, Provider>>
  readonly revision?: () => Effect.Effect<number>
  readonly refresh: (force?: boolean) => Effect.Effect<void>
  readonly refreshWanlaiCode: () => Effect.Effect<void, unknown>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ModelsDev") { }

export const layer: Layer.Layer<
  Service,
  never,
  AppFileSystem.Service | HttpClient.HttpClient | Env.Service | Auth.Service | Config.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service
    const env = yield* Env.Service
    const auth = yield* Auth.Service
    const config = yield* Config.Service
    const client = yield* HttpClient.HttpClient
    const http = HttpClient.filterStatusOk(withTransientReadRetry(client))

    const source = Flag.WANLAICODE_MODELS_URL || "https://models.dev"
    const defaultFilepath = path.join(
      Global.Path.cache,
      source === "https://models.dev" ? "models.json" : `models-${Hash.fast(source)}.json`,
    )
    const filepath = () => Flag.WANLAICODE_MODELS_PATH ?? defaultFilepath
    const ttl = Duration.minutes(5)
    const lockKey = () => `models-dev:${filepath()}`
    const cachedGets = SynchronizedRef.makeUnsafe<
      Record<string, readonly [Effect.Effect<Record<string, Provider>>, Effect.Effect<void>]>
    >({})
    const revisionRef = SynchronizedRef.makeUnsafe(0)
    const cacheFingerprintRef = SynchronizedRef.makeUnsafe<Record<string, string>>({})

    const fresh = Effect.fnUntraced(function* () {
      const stat = yield* fs.stat(filepath()).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (!stat) return false
      const mtime = Option.getOrElse(stat.mtime, () => new Date(0)).getTime()
      return Date.now() - mtime < Duration.toMillis(ttl)
    })

    const fetchApi = Effect.fn("ModelsDev.fetchApi")(function* () {
      return yield* HttpClientRequest.get(`${source}/api.json`).pipe(
        HttpClientRequest.setHeader("User-Agent", Installation.USER_AGENT),
        http.execute,
        Effect.flatMap((res) => res.text),
        Effect.timeout("10 seconds"),
      )
    })

    const wanlaiCodeConfigApiKey = Effect.fn("ModelsDev.wanlaiCodeConfigApiKey")(function* () {
      return yield* config
        .get()
        .pipe(
          Effect.map((value) => value.provider?.wanlaicode?.options?.apiKey),
          Effect.catchCause(() => Effect.succeed(undefined)),
        )
    })

    const wanlaiCodeEnvApiKey = Effect.fn("ModelsDev.wanlaiCodeEnvApiKey")(function* () {
      return yield* env.get("WANLAICODE_API_KEY").pipe(Effect.catchCause(() => Effect.succeed(undefined)))
    })

    const wanlaiCodeApiKey = Effect.fn("ModelsDev.wanlaiCodeApiKey")(function* () {
      const authInfo = yield* auth.get("wanlaicode").pipe(Effect.orDie)
      return (
        (authInfo?.type === "api" ? authInfo.key : undefined) ??
        (authInfo?.type === "oauth" ? authInfo.access : undefined) ??
        (authInfo?.type === "wellknown" ? authInfo.token : undefined) ??
        (yield* wanlaiCodeConfigApiKey()) ??
        (yield* wanlaiCodeEnvApiKey())
      )
    })

    const fetchWanlaiCodeModels = Effect.fn("ModelsDev.fetchWanlaiCodeModels")(function* (mode?: { public?: boolean }) {
      const authInfo = yield* auth.get("wanlaicode").pipe(Effect.orDie)
      const oauthInfo = authInfo?.type === "oauth" ? authInfo : undefined
      const apiKey =
        (authInfo?.type === "api" ? authInfo.key : undefined) ??
        (oauthInfo?.access ?? undefined) ??
        (authInfo?.type === "wellknown" ? authInfo.token : undefined) ??
        (yield* wanlaiCodeConfigApiKey()) ??
        (yield* wanlaiCodeEnvApiKey())
      const config =
        authInfo?.type === "api" && authInfo.metadata?.apiBase
          ? WanlaiCodeAuth.resolveConfig({ apiBase: authInfo.metadata.apiBase })
          : WanlaiCodeAuth.resolveConfig()
      const execute = (key?: string) =>
        Effect.tryPromise({
          try: () => {
            const headers = {
              Accept: "application/json",
              "User-Agent": Installation.USER_AGENT,
            } as Record<string, string>
            if (oauthInfo?.access && key) headers.Authorization = `Bearer ${key}`
            return WanlaiCodeAuth.createFetch("WanlaiCode.models")(config.endpoints.models, {
              method: "GET",
              headers,
            })
          },
          catch: (cause) => cause,
        }).pipe(
              Effect.flatMap((response) => {
                if (!response.ok) {
                  return Effect.tryPromise({
                    try: async () => {
                      const body = await response.text()
                      const err = new Error(
                        `WanlaiCode models request failed: ${response.status} ${response.statusText} - ${body}`,
                      )
                        // statusFromError 走 "status" in error 分支取值；丢了 status 会让 401 走 fail 分支而不是 refresh
                        ; (err as Error & { status: number }).status = response.status
                      throw err
                    },
                    catch: (cause) => cause,
                  })
                }
                return Effect.succeed(response)
              }),
            )
      const requestKey = mode?.public ? undefined : apiKey
      const refreshableOAuthInfo = mode?.public ? undefined : oauthInfo
      const parse = (response: Response) =>
        Effect.tryPromise({
          try: async () => {
            if (response.status === 204) return emptyOpenAIModelsPayload()
            const text = await response.text()
            return normalizeOpenAIModelsPayload(parseJsonText(text, { data: [] }, "WanlaiCode models"))
          },
          catch: (cause) => cause,
        }).pipe(Effect.timeout("10 seconds"))
      const retryWithRefresh = (oauthInfo: Extract<Auth.Info, { type: "oauth" }>) =>
        Effect.tryPromise({
          try: () => WanlaiCodeRefreshCoordinator.refresh({ reason: "models-401" }),
          catch: (cause) => cause,
        }).pipe(
          Effect.flatMap((refreshed) =>
            // 协调器只会把明确 invalid_grant 分类成登录过期；网络、5xx 和并发换号错误必须保留原语义。
            // 空 runtime key 代表账号仍有效但没有推理权益，交给外层读取公开模型，不能触发重新登录提示。
            refreshed.runtimeKey
              ? execute(refreshed.runtimeKey)
              : Effect.fail(WanlaiCodeAuth.noEntitlementError("runtime key unavailable")),
          ),
          Effect.flatMap(parse),
        )
      const statusFromError = (error: unknown) => {
        if (typeof error !== "object" || error === null) return undefined
        if ("status" in error && typeof error.status === "number") return error.status
        if (!("reason" in error) || typeof error.reason !== "object" || error.reason === null) return undefined
        if ("status" in error.reason && typeof error.reason.status === "number") return error.reason.status
        if (!("response" in error.reason) || typeof error.reason.response !== "object" || error.reason.response === null)
          return undefined
        if ("status" in error.reason.response && typeof error.reason.response.status === "number")
          return error.reason.response.status
        return undefined
      }
      const payload = yield* execute(requestKey).pipe(
        Effect.flatMap((response) => {
          if (!refreshableOAuthInfo || response.status !== 401) return parse(response)
          return retryWithRefresh(refreshableOAuthInfo)
        }),
        Effect.catch((error: unknown) => {
          if (!refreshableOAuthInfo || statusFromError(error) !== 401) return Effect.fail(error)
          return retryWithRefresh(refreshableOAuthInfo)
        }),
        Effect.retry({
          times: 2,
          schedule: Schedule.exponential("200 millis"),
          while: (error: unknown) => {
            const status = statusFromError(error)
            // 4xx 是鉴权/权限问题，重试无意义；网络异常或 5xx 才重试
            if (status !== undefined) return status >= 500
            const msg = error instanceof Error ? error.message : String(error)
            return msg.includes("fetch") || msg.includes("ECONN") || msg.includes("Timeout")
          },
        }),
      )
      const result = wanlaiCodeProvider(config, payload.data)
      return result
    })

    const fallbackWanlaiCodeModels = (previous?: Record<string, Provider>): Record<string, Provider> =>
      previous?.wanlaicode && hasProviderModels(previous.wanlaicode) && !isLegacyWanlaiCodeFreeFallback(previous.wanlaicode)
        ? ({ wanlaicode: previous.wanlaicode } satisfies Record<string, Provider>)
        : ({} satisfies Record<string, Provider>)

    const preferPreviousWanlaiCodeWhenFetchedEmpty = (
      previous: Record<string, Provider> | undefined,
      next: Record<string, Provider>,
    ): Record<string, Provider> => {
      const current = next.wanlaicode
      // /v1/models 是账号白名单权威来源；但线上灰度/旧后端可能短暂返回空列表。
      // 有旧缓存时先保留旧模型，避免一次空响应把选择器覆盖成“未找到模型”。
      if (
        current &&
        !hasProviderModels(current) &&
        previous?.wanlaicode &&
        hasProviderModels(previous.wanlaicode) &&
        !isLegacyWanlaiCodeFreeFallback(previous.wanlaicode)
      ) {
        return { wanlaicode: previous.wanlaicode } satisfies Record<string, Provider>
      }
      return next
    }

    const loadFromDisk = () =>
      fs.readJson(filepath()).pipe(
        Effect.catch(() => Effect.succeed(undefined)),
        Effect.map((v) => {
          const data = v as Record<string, Provider> | undefined
          if (isLegacyWanlaiCodeFreeFallback(data?.wanlaicode)) {
            const next = { ...data }
            delete next.wanlaicode
            return next
          }
          // wanlaicode.api 由当前 brand 决定（@opencode-ai/brand），不该跨进程持久化。
          // 用户切 brand（wanlai ↔ codex）后旧值会留在 cache 里：fetch 当前 brand /models 失败时
          // 走 `previous?.wanlaicode` fallback，chat 就用了旧 brand 的 apiBase，掩盖 backend 真实故障。
          // 读盘时强行对齐当前 brand 的 apiBase，让"挂"暴露出来。
          if (data?.wanlaicode) {
            data.wanlaicode = { ...data.wanlaicode, api: WanlaiCodeAuth.resolveConfig().apiBase }
          }
          return data
        }),
      )

    const diskFingerprint = Effect.fn("ModelsDev.diskFingerprint")(function* () {
      const stat = yield* fs.stat(filepath()).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (!stat) return "0"
      const mtime = Option.getOrElse(stat.mtime, () => new Date(0)).getTime()
      const text = yield* fs.readFileStringSafe(filepath()).pipe(Effect.catch(() => Effect.succeed(undefined)))
      return text === undefined ? "0" : `${mtime}:${Hash.fast(text)}`
    })

    // Bundled at build time; absent in dev — `tryPromise` covers both.
    // Tests can opt out via OPENCODE_DISABLE_MODELS_SNAPSHOT to exercise the
    // disk/fetch paths without a stray local snapshot leaking real provider
    // data into the result.
    const loadSnapshot = Flag.WANLAICODE_DISABLE_MODELS_SNAPSHOT
      ? Effect.succeed(undefined)
      : Effect.tryPromise({
        // @ts-ignore — generated at build time, may not exist in dev
        try: () => import("./models-snapshot.js").then((m) => m.snapshot as Record<string, Provider> | undefined),
        catch: () => undefined,
      }).pipe(Effect.catch(() => Effect.succeed(undefined)))

    const fallbackModels = Effect.fnUntraced(function* (previous?: Record<string, Provider>) {
      if (previous) return previous
      const snapshot = yield* loadSnapshot
      return snapshot ?? ({} satisfies Record<string, Provider>)
    })

    const fetchMergedModels = Effect.fn("ModelsDev.fetchMergedModels")(function* (previous?: Record<string, Provider>) {
      const fallback = yield* fallbackModels(previous)
      const models = yield* fetchApi().pipe(
        Effect.map((text) => parseJsonTextOrFallback(text, fallback, "models.dev api") as Record<string, Provider>),
        Effect.catch(() => Effect.succeed(fallback)),
      )
      const wanlaiCode = yield* fetchWanlaiCodeModels().pipe(
        Effect.map((next) => preferPreviousWanlaiCodeWhenFetchedEmpty(previous, next)),
        Effect.catchIf(isWanlaiCodeNoEntitlement, () =>
          fetchWanlaiCodeModels({ public: true }).pipe(
            Effect.catch(() => Effect.succeed(fallbackWanlaiCodeModels(previous))),
          ),
        ),
        Effect.catch(() =>
          previous?.wanlaicode
            ? Effect.succeed({ wanlaicode: previous.wanlaicode } satisfies Record<string, Provider>)
            : Effect.succeed({} satisfies Record<string, Provider>),
        ),
      )
      return { ...models, ...wanlaiCode }
    })

    const fetchAndWrite = Effect.fn("ModelsDev.fetchAndWrite")(function* () {
      const previous = yield* loadFromDisk()
      const text = JSON.stringify(yield* fetchMergedModels(previous))
      yield* fs.writeWithDirs(filepath(), text)
      return text
    })

    const populate = Effect.gen(function* () {
      const fromDisk = yield* loadFromDisk()
      if (fromDisk && (yield* fresh())) return fromDisk
      if (fromDisk) return fromDisk
      if (!Flag.WANLAICODE_DISABLE_MODELS_FETCH) {
        const text = yield* Effect.scoped(
          Effect.gen(function* () {
            yield* Flock.effect(lockKey())
            const nextFromDisk = yield* loadFromDisk()
            if (nextFromDisk && (yield* fresh())) return JSON.stringify(nextFromDisk)
            return yield* fetchAndWrite()
          }),
        ).pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (text) return parseJsonTextOrFallback(text, fromDisk ?? {}, "models cache") as Record<string, Provider>
      }
      const snapshot = yield* loadSnapshot
      if (snapshot) return snapshot
      if (fromDisk) return fromDisk
      return {}
    }).pipe(Effect.withSpan("ModelsDev.populate"), Effect.orDie)

    const cachedGet = Effect.fn("ModelsDev.get")(function* () {
      const key = filepath()
      // modifyEffect 让 read-check-create-write 留在一个临界区——同一 key 的并发
      // get 不会各自新建一份 cachedInvalidateWithTTL 把 SynchronizedRef 当 last-write-wins
      // 抢覆盖（拆成 get + update 会留 orphan single-flight 和漂移的 TTL）。
      const entry = yield* SynchronizedRef.modifyEffect(
        cachedGets,
        Effect.fnUntraced(function* (entries) {
          const existing = entries[key]
          if (existing) return [existing, entries] as const
          // 必须 yield* 一次拿 [cachedRun, invalidate] tuple 存进 ref；
          // 存 unrun effect 则每次 use 都新建 cache state，TTL 等同失效
          const created = yield* Effect.cachedInvalidateWithTTL(populate, ttl)
          return [created, { ...entries, [key]: created }] as const
        }),
      )
      const currentFingerprint = yield* diskFingerprint()
      const cachedFingerprint = (yield* SynchronizedRef.get(cacheFingerprintRef))[key]
      if (cachedFingerprint !== undefined && currentFingerprint !== cachedFingerprint) {
        yield* entry[1]
        yield* SynchronizedRef.update(cacheFingerprintRef, (state) => ({ ...state, [key]: currentFingerprint }))
        return yield* entry[0]
      }
      if (cachedFingerprint === undefined) {
        yield* SynchronizedRef.update(cacheFingerprintRef, (state) => ({ ...state, [key]: currentFingerprint }))
      }
      return yield* entry[0]
    })

    const invalidateCached = Effect.fn("ModelsDev.invalidate")(function* () {
      const key = filepath()
      const entry = (yield* SynchronizedRef.get(cachedGets))[key]
      if (!entry) return
      yield* entry[1]
      const currentFingerprint = yield* diskFingerprint()
      yield* SynchronizedRef.update(cacheFingerprintRef, (state) => ({ ...state, [key]: currentFingerprint }))
    })

    const get = (): Effect.Effect<Record<string, Provider>> => cachedGet()
    const revision = () => SynchronizedRef.get(revisionRef)
    const bumpRevision = () => SynchronizedRef.update(revisionRef, (value) => value + 1)

    const refresh = Effect.fn("ModelsDev.refresh")(function* (force = false) {
      if (!force && (yield* fresh())) return
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Flock.effect(lockKey())
          // Re-check under the lock: another process may have refreshed between
          // our outer check and lock acquisition.
          if (!force && (yield* fresh())) return
          yield* fetchAndWrite()
          yield* invalidateCached()
          yield* bumpRevision()
        }),
      ).pipe(
        Effect.tapCause((cause) => Effect.logError("Failed to fetch models.dev", { cause })),
        Effect.ignore,
      )
    })

    const refreshWanlaiCode = Effect.fn("ModelsDev.refreshWanlaiCode")(function* () {
      const previous = yield* loadFromDisk()
      const wanlaiCode = yield* fetchWanlaiCodeModels().pipe(
        Effect.map((next) => preferPreviousWanlaiCodeWhenFetchedEmpty(previous, next)),
        Effect.catchIf(isWanlaiCodeNoEntitlement, () =>
          fetchWanlaiCodeModels({ public: true }).pipe(
            Effect.catch(() => Effect.succeed(fallbackWanlaiCodeModels(previous))),
          ),
        ),
        Effect.catch(() => Effect.succeed(fallbackWanlaiCodeModels(previous))),
      )
      const text = JSON.stringify(replaceWanlaiCodeModels(previous, wanlaiCode))
      yield* fs.writeWithDirs(filepath(), text)
      yield* invalidateCached()
      yield* bumpRevision()
    })

    if (!Flag.WANLAICODE_DISABLE_MODELS_FETCH && !process.argv.includes("--get-yargs-completions")) {
      // Schedule.spaced runs the effect once, then waits between completions.
      yield* Effect.forkScoped(refresh().pipe(Effect.repeat(Schedule.spaced("60 minutes")), Effect.ignore))
    }

    return Service.of({ get, revision, refresh, refreshWanlaiCode })
  }),
)

export const defaultLayer: Layer.Layer<Service> = layer.pipe(
  Layer.provide(NetProxy.layer),
  Layer.provide(AppFileSystem.defaultLayer),
  Layer.provide(Env.defaultLayer),
  Layer.provide(Auth.defaultLayer),
  Layer.provide(Config.defaultLayer),
)

export * as ModelsDev from "./models"
