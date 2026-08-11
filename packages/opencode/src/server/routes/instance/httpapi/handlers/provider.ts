import { ProviderAuth } from "@/provider/auth"
import { Config } from "@/config/config"
import { ModelsDev } from "@/provider/models"
import { Provider } from "@/provider/provider"
import { WanlaiCodeAuth } from "@/provider/wanlaicode"
import { WanlaiCodeRefreshCoordinator } from "@/provider/wanlaicode-refresh-coordinator"
import { ProviderID } from "@/provider/schema"
import { RemoteControlGateway } from "@/remote-control/gateway"
import { Effect, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { providerListResult } from "../../provider-list"

export const providerHandlers = HttpApiBuilder.group(InstanceHttpApi, "provider", (handlers) =>
  Effect.gen(function* () {
    const cfg = yield* Config.Service
    const provider = yield* Provider.Service
    const svc = yield* ProviderAuth.Service

    const list = Effect.fn("ProviderHttpApi.list")(function* (ctx: { query: { refresh?: boolean } }) {
      if (ctx.query.refresh) {
        yield* ModelsDev.Service.use((s) => s.refresh(true))
        yield* provider.refresh()
      }
      const all = yield* ModelsDev.Service.use((s) => s.get()).pipe(
        Effect.tapError((error) => Effect.logError("Failed to load model registry for provider list", { error })),
        Effect.catch(() => Effect.succeed({} as Record<string, ModelsDev.Provider>)),
      )
      const config = yield* cfg.get()
      const disabled = new Set(config.disabled_providers ?? [])
      const enabled = config.enabled_providers ? new Set(config.enabled_providers) : undefined
      const filtered: Record<string, (typeof all)[string]> = {}
      for (const [key, value] of Object.entries(all)) {
        if ((enabled ? enabled.has(key) : true) && !disabled.has(key)) filtered[key] = value
      }
      const connected = yield* Provider.Service.use((svc) => svc.list()).pipe(
        Effect.tapError((error) => Effect.logError("Failed to load connected providers", { error })),
        Effect.catch(() => Effect.succeed({} as Record<ProviderID, Provider.Info>)),
      )
      return providerListResult({ filtered, connected, disabled })
    })

    const auth = Effect.fn("ProviderHttpApi.auth")(function* () {
      return yield* svc.methods()
    })

    const validateWanlaiCodeApiKey = Effect.fn("ProviderHttpApi.validateWanlaiCodeApiKey")(function* (ctx: {
      payload: ProviderAuth.WanlaiCodeApiKeyValidateInput
    }) {
      yield* WanlaiCodeAuth.loginWithApiKey({ apiKey: ctx.payload.apiKey, apiBase: ctx.payload.apiBase }).pipe(
        Effect.mapError(() => new HttpApiError.BadRequest({})),
      )
      return { ok: true as const }
    })

    const authorize = Effect.fn("ProviderHttpApi.authorize")(function* (ctx: {
      params: { providerID: ProviderID }
      payload: ProviderAuth.AuthorizeInput
    }) {
      return yield* svc
        .authorize({
          providerID: ctx.params.providerID,
          method: ctx.payload.method,
          inputs: ctx.payload.inputs,
        })
        .pipe(Effect.catch(() => Effect.fail(new HttpApiError.BadRequest({}))))
    })

    const authorizeRaw = Effect.fn("ProviderHttpApi.authorizeRaw")(function* (ctx: {
      params: { providerID: ProviderID }
      request: HttpServerRequest.HttpServerRequest
    }) {
      const body = yield* Effect.orDie(ctx.request.text)
      const payload = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ProviderAuth.AuthorizeInput))(body).pipe(
        Effect.mapError(() => new HttpApiError.BadRequest({})),
      )
      const result = yield* authorize({ params: ctx.params, payload })
      if (result === undefined) return HttpServerResponse.empty({ status: 200 })
      return HttpServerResponse.jsonUnsafe(result)
    })

    const callback = Effect.fn("ProviderHttpApi.callback")(function* (ctx: {
      params: { providerID: ProviderID }
      payload: ProviderAuth.CallbackInput
    }) {
      yield* svc
        .callback({
          providerID: ctx.params.providerID,
          method: ctx.payload.method,
          code: ctx.payload.code,
        })
        .pipe(Effect.catch(() => Effect.fail(new HttpApiError.BadRequest({}))))
      // Effect HttpApi 与 Hono 登录入口保持一致，OAuth 写入后立即恢复手机远控连接。
      if (ctx.params.providerID === "wanlaicode") yield* Effect.promise(() => RemoteControlGateway.authChanged())
      return true
    })

    // 唤醒/手动触发刷新：失败不抛，避免调用方（如桌面端休眠唤醒）弹出噪声
    // 用 tryPromise 而非 promise：需同时捕获同步序言抛出与 promise reject，二者都收敛为 ok:false
    const wanlaicodeOAuthRefresh = Effect.fn("ProviderHttpApi.wanlaicodeOAuthRefresh")(function* () {
      return yield* Effect.tryPromise({
        try: () => WanlaiCodeRefreshCoordinator.refresh({ reason: "resume" }),
        catch: () => new Error("refresh failed"),
      }).pipe(Effect.match({ onFailure: () => ({ ok: false }), onSuccess: () => ({ ok: true }) }))
    })

    return handlers
      .handle("list", list)
      .handle("auth", auth)
      .handle("validateWanlaiCodeApiKey", validateWanlaiCodeApiKey)
      .handleRaw("authorize", authorizeRaw)
      .handle("callback", callback)
      .handle("wanlaicodeOAuthRefresh", wanlaicodeOAuthRefresh)
  }),
)
