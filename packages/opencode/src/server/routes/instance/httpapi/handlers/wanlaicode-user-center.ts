import { Auth } from "@/auth"
import { ModelsDev } from "@/provider/models"
import { Provider } from "@/provider/provider"
import { ModelID, ProviderID } from "@/provider/schema"
import { WanlaiCodeAuth } from "@/provider/wanlaicode"
import { WanlaiCodeRefreshCoordinator } from "@/provider/wanlaicode-refresh-coordinator"
import { WanlaiCodeImageGeneration, type ImageGenerateInput } from "@/provider/wanlaicode-image-generation"
import { NetProxy } from "@/net/proxy"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { classifyIntent } from "@/provider/intent"
import { InstanceHttpApi } from "../api"
import { WanlaiCodeUserCenterError } from "../groups/wanlaicode-user-center"
import {
  codexIntegrationStatus,
  installCodexIntegration,
  restoreCodexIntegration,
} from "./wanlaicode-user-center-integrations/codex"

const productCode = "wanlaicode"
const oauthExpiredReason = "SOFTWARE_OAUTH_REFRESH_TOKEN_INVALID"
const proxyFetch = NetProxy.create("WanlaiCode.userCenter")
const imageIntentContextMaxChars = 32_000
const imageIntentAttemptTimeoutMs = 30_000
const imageIntentTotalTimeoutMs = 60_000

class WanlaiCodeBackendError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly reason?: string,
  ) {
    super(message)
  }
}

type BackendEnvelope<T> = {
  code?: number
  message?: string
  reason?: string
  data?: T
}

type QueryValue = string | number | boolean | undefined
type BackendRequestInput = {
  accessToken: string
  path: string
  method?: "GET" | "POST"
  query?: Record<string, QueryValue>
  body?: Record<string, unknown>
}
type PurchaseSettings = {
  purchase_subscription_enabled?: boolean
  purchase_subscription_url?: string
}
type UserInfo = {
  id?: number
  uuid?: string
  email?: string
  username?: string
}
type ImageIntentInput = {
  text: string
  has_image_context: boolean
  recent_context?: string
  current_image_count?: number
  current_image_filenames?: readonly string[]
  provider_id?: string
  model?: string
}
type ImageIntentResult = {
  action: "generate" | "edit" | "none"
  confidence: number
  reason?: string
  route?: "chat" | "tool"
  tool?: "image_generation"
  image_prompt?: string
  context_text?: string
}

function errorMessage(cause: unknown) {
  const seen = new WeakSet<object>()
  const read = (input: unknown): string | undefined => {
    if (input instanceof Error && input.message && input.message !== "[object Object]") return input.message
    if (typeof input === "string" && input && input !== "[object Object]") return input
    if (typeof input !== "object" || input === null || seen.has(input)) return undefined
    seen.add(input)

    if ("data" in input) {
      const message = read((input as { data?: unknown }).data)
      if (message) return message
    }
    if ("error" in input) {
      const message = read((input as { error?: unknown }).error)
      if (message) return message
    }
    if ("message" in input) {
      const message = read((input as { message?: unknown }).message)
      if (message) return message
    }
    if ("cause" in input) {
      const message = read((input as { cause?: unknown }).cause)
      if (message) return message
    }

    try {
      const json = JSON.stringify(input)
      return json && json !== "{}" ? json : undefined
    } catch {
      return undefined
    }
  }
  return read(cause) ?? String(cause)
}

function userCenterError(cause: unknown) {
  const reason =
    cause instanceof WanlaiCodeBackendError
      ? cause.reason
      : cause instanceof WanlaiCodeUserCenterError
        ? cause.data.reason
        : WanlaiCodeAuth.isOAuthExpiredError(cause)
          ? oauthExpiredReason
          : WanlaiCodeAuth.oauthRefreshErrorReason(cause)
  return new WanlaiCodeUserCenterError({
    name: "WanlaiCodeUserCenterError",
    data: {
      message: errorMessage(cause),
      ...(reason !== undefined ? { reason } : {}),
    },
  })
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
}

function stringField(input: Record<string, unknown>, key: string) {
  const value = input[key]
  return typeof value === "string" ? value : undefined
}

function optionalStringField(input: Record<string, unknown>, key: string) {
  return nonEmptyString(stringField(input, key))
}

function hasActiveSoftwareEntitlement(items: Record<string, unknown>[]) {
  return items.some((item) => {
    const status = stringField(item, "status")?.toLowerCase() ?? "active"
    if (["expired", "disabled", "inactive", "cancelled", "canceled", "revoked", "deleted"].includes(status)) return false
    const itemProductCode = stringField(item, "product_code")?.toLowerCase()
    if (itemProductCode && itemProductCode !== productCode) return false
    const expiresAt = stringField(item, "expires_at")
    if (!expiresAt) return true
    const expires = Date.parse(expiresAt)
    return Number.isNaN(expires) || expires > Date.now()
  })
}

function isOAuthRefreshInvalid(cause: unknown) {
  if (cause instanceof WanlaiCodeUserCenterError) return WanlaiCodeAuth.isOAuthRefreshReasonInvalid(cause.data.reason)
  return WanlaiCodeAuth.isOAuthExpiredError(cause) || WanlaiCodeAuth.isOAuthRefreshTokenInvalid(cause)
}

function nonEmptyString(input: string | undefined) {
  const value = input?.trim()
  if (!value) return undefined
  return value
}

// 用户中心状态只在当前凭据有效时返回账号资料，避免缓存姓名与真实认证结论互相矛盾。
export function authenticatedAccountFields(authenticated: boolean, info: Auth.Info | undefined) {
  if (!authenticated || (info?.type !== "oauth" && info?.type !== "api")) return {}
  return {
    account_id: info.type === "oauth" ? info.accountId : undefined,
    account_email: nonEmptyString(info.accountEmail),
    account_name: nonEmptyString(info.accountName),
  }
}

// OAuth 凭据存在但已被判失效时保留“需要重新认证”语义，同时继续禁止所有已登录能力。
export function oauthReauthenticationRequired(authenticated: boolean, info: Auth.Info | undefined) {
  return !authenticated && info?.type === "oauth"
}

export function backendErrorReason(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined
  const reason = (body as { reason?: unknown }).reason
  return typeof reason === "string" && reason ? reason : undefined
}

async function unwrapBackendResponse<T>(response: Response) {
  const text = await response.text()
  const body = (text ? JSON.parse(text) : {}) as BackendEnvelope<T>
  if (!response.ok) {
    throw new WanlaiCodeBackendError(
      response.status,
      body.message ?? `Wanlai API request failed: ${response.status}`,
      backendErrorReason(body),
    )
  }
  if (typeof body.code === "number" && body.code !== 0) {
    throw new WanlaiCodeBackendError(body.code, body.message ?? "Wanlai API request failed", backendErrorReason(body))
  }
  return body.data as T
}

function publicSettingsRequest() {
  return Effect.tryPromise({
    try: async () => {
      const config = WanlaiCodeAuth.resolveConfig()
      const url = new URL(config.endpoints.purchaseSettings)
      url.searchParams.set("_t", String(Date.now()))
      return await unwrapBackendResponse<PurchaseSettings>(await proxyFetch(url))
    },
    catch: (cause) => cause,
  })
}

function storefrontPlansRequest(input: { purchaseUrl: string; accessToken?: string }) {
  return Effect.tryPromise({
    try: async () => {
      const url = new URL(input.purchaseUrl)
      url.pathname = "/api/subscription-plans"
      url.search = ""
      if (input.accessToken) url.searchParams.set("token", input.accessToken)

      const response = await proxyFetch(url)
      if (!response.ok) {
        throw new WanlaiCodeBackendError(response.status, `Wanlai purchase plans request failed: ${response.status}`)
      }

      const text = await response.text()
      if (!text.trim().startsWith("{")) {
        throw new WanlaiCodeBackendError(
          response.status,
          `Wanlai purchase plans returned non-JSON response from ${url.toString()}`,
        )
      }

      const payload = JSON.parse(text) as { plans?: unknown[] }
      return (payload.plans ?? []).filter(isRecord)
    },
    catch: (cause) => cause,
  })
}

export function buildPurchasePageUrl(input: {
  purchaseUrl: string
  siteUrl: string
  accessToken: string
  query: {
    plan_id?: string
    software_product?: string
    payment_type?: string
    user_id?: number
    user_uuid?: string
    theme?: "light" | "dark"
    lang?: string
    src_host?: string
    src_url?: string
  }
}) {
  const url = new URL(input.purchaseUrl)
  const source = sourceContext(input.siteUrl, input.query)
  if (input.query.user_id) url.searchParams.set("user_id", String(input.query.user_id))
  if (input.query.user_uuid) url.searchParams.set("user_uuid", input.query.user_uuid)
  url.searchParams.set("token", input.accessToken)
  url.searchParams.set("theme", input.query.theme ?? "dark")
  url.searchParams.set("ui_mode", "embedded")
  url.searchParams.set("src_host", source.host)
  url.searchParams.set("src_url", source.url)
  url.searchParams.set("tab", "software")
  if (input.query.lang) url.searchParams.set("lang", input.query.lang)
  if (input.query.software_product) url.searchParams.set("software_product", input.query.software_product)
  if (input.query.plan_id) url.searchParams.set("plan_id", input.query.plan_id)
  if (input.query.payment_type) url.searchParams.set("payment_type", input.query.payment_type)
  return url.toString()
}

function sourceContext(siteUrl: string, query: { src_host?: string; src_url?: string }) {
  const site = new URL(siteUrl)
  return {
    host: httpUrl(query.src_host)?.origin ?? site.origin,
    url: httpUrl(query.src_url)?.toString() ?? new URL("/purchase", site).toString(),
  }
}

function httpUrl(value: string | undefined) {
  if (!value) return undefined
  try {
    const url = new URL(value)
    if (url.protocol === "http:" || url.protocol === "https:") return url
  } catch {}
  return undefined
}

function backendRequest<T>(input: BackendRequestInput) {
  return Effect.tryPromise({
    try: async () => {
      const config = WanlaiCodeAuth.resolveConfig()
      const url = new URL(`/api/v1${input.path}`, config.relayRoot)
      Object.entries(input.query ?? {})
        .filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined && entry[1] !== "")
        .forEach((entry) => url.searchParams.set(entry[0], String(entry[1])))

      return await unwrapBackendResponse<T>(
        await proxyFetch(url, {
          method: input.method ?? "GET",
          headers: {
            Authorization: `Bearer ${input.accessToken}`,
            ...(input.body ? { "Content-Type": "application/json" } : {}),
          },
          body: input.body ? JSON.stringify(input.body) : undefined,
        }),
      )
    },
    catch: (cause) => cause,
  })
}

// 转发 multipart/form-data 到后端（社区投稿带附件）。不手动设置 Content-Type，
// 让 fetch 依据 FormData 自动生成 boundary。
function backendMultipartRequest<T>(input: { accessToken: string; path: string; form: FormData }) {
  return Effect.tryPromise({
    try: async () => {
      const config = WanlaiCodeAuth.resolveConfig()
      const url = new URL(`/api/v1${input.path}`, config.relayRoot)
      return await unwrapBackendResponse<T>(
        await proxyFetch(url, {
          method: "POST",
          headers: { Authorization: `Bearer ${input.accessToken}` },
          body: input.form,
        }),
      )
    },
    catch: (cause) => cause,
  })
}

// 把 data:URL 解析为 Blob（服务端把 base64 附件转成 multipart 文件）。
// 逐段解析而非单一正则，以兼容带参数的 MIME（如 text/plain;charset=utf-8;base64）。
function dataUrlToBlob(dataUrl: string, fallbackMime?: string) {
  if (!dataUrl.startsWith("data:")) return undefined
  const comma = dataUrl.indexOf(",")
  if (comma < 0) return undefined
  const header = dataUrl.slice(5, comma)
  const raw = dataUrl.slice(comma + 1)
  const isBase64 = /;base64$/i.test(header)
  const mime = header.replace(/;base64$/i, "").split(";")[0] || fallbackMime || "application/octet-stream"
  const bytes = isBase64 ? Buffer.from(raw, "base64") : Buffer.from(decodeURIComponent(raw), "utf-8")
  return new Blob([bytes], { type: mime })
}

export const wanlaiCodeUserCenterHandlers = HttpApiBuilder.group(InstanceHttpApi, "wanlaicodeUserCenter", (handlers) =>
  Effect.gen(function* () {
    const auth = yield* Auth.Service
    const models = yield* ModelsDev.Service
    const provider = yield* Provider.Service
    const imageGeneration = yield* WanlaiCodeImageGeneration.Service
    let oauthRuntimeKeyRestore = false

    // 正式 Auth layer 在跨进程文件锁内执行 updater；测试 mock 缺少 modify 时保留等价的顺序 fallback。
    const modifyWanlaiAuth = Effect.fn("WanlaiCodeUserCenter.modifyAuth")(function* (
      update: (current: Auth.Info | undefined) => Auth.Info | undefined,
    ) {
      if (auth.modify) return yield* auth.modify("wanlaicode", update)
      const current = yield* auth.get("wanlaicode").pipe(Effect.catch(() => Effect.succeed(undefined)))
      const modified = update(current)
      if (!modified) return undefined
      yield* auth.set("wanlaicode", modified)
      return modified
    })

    function oauthRefreshError() {
      return new WanlaiCodeAuth.OAuthRefreshError({
        status: 401,
        reason: oauthExpiredReason,
        body: JSON.stringify({ error: oauthExpiredReason.toLowerCase() }),
      })
    }

    const configPayload = Effect.fn("WanlaiCodeUserCenter.config")(function* () {
      const config = WanlaiCodeAuth.resolveConfig()
      // getPurchaseUrl 首次冷启动会发远端请求；status 是启动门控依赖项，必须超时兜底，避免阻塞启动
      const purchaseUrl = yield* WanlaiCodeAuth.getPurchaseUrl({}).pipe(
        Effect.timeout("2 seconds"),
        Effect.catch(() => Effect.succeed(WanlaiCodeAuth.defaultConfig.purchaseFallbackUrl)),
      )
      return {
        product_code: productCode,
        api_base: config.apiBase,
        codex_base_url: config.apiBase,
        site_url: config.siteUrl,
        purchase_url: purchaseUrl,
      }
    })

    const purchaseSettings = Effect.fn("WanlaiCodeUserCenter.purchaseSettings")(function* () {
      const settings = yield* publicSettingsRequest().pipe(Effect.catch(() => Effect.succeed({} as PurchaseSettings)))
      const purchaseUrl = settings.purchase_subscription_url || (yield* WanlaiCodeAuth.getPurchaseUrl({}))
      return {
        enabled: settings.purchase_subscription_enabled ?? Boolean(purchaseUrl),
        purchase_url: purchaseUrl || WanlaiCodeAuth.defaultConfig.purchaseFallbackUrl,
      }
    })

    const oauthAccessToken = Effect.fn("WanlaiCodeUserCenter.oauthAccessToken")(function* (options?: {
      force?: boolean
    }) {
      const info = yield* auth.get("wanlaicode").pipe(Effect.mapError(userCenterError))
      if (!info) return yield* Effect.fail(userCenterError("WanlaiCode is not connected"))
      if (info.type !== "oauth") return yield* Effect.fail(userCenterError("WanlaiCode OAuth login is required"))
      if (WanlaiCodeRefreshCoordinator.isCredentialInvalid(info)) {
        return yield* Effect.fail(userCenterError(oauthRefreshError()))
      }

      const now = Math.floor(Date.now() / 1000)
      // 有效 JWT 直接复用；过期和 401 路径统一进入全局协调器，和图片、远控、定时刷新共享同一次兑换。
      if (!options?.force && info.softwareToken && info.expires > now + 30) return info.softwareToken
      const refreshed = yield* Effect.tryPromise({
        try: () =>
          WanlaiCodeRefreshCoordinator.refresh({
            reason: options?.force ? "user-center-401" : "user-center",
            // handler 已持有稳定 Auth.Service，交给协调器复用可避免跨 layer 读取到另一份测试/实例凭据。
            auth,
          }),
        catch: (cause) => cause,
      }).pipe(Effect.mapError(userCenterError))
      return refreshed.softwareToken
    })

    const currentAuth = Effect.fn("WanlaiCodeUserCenter.currentAuth")(function* () {
      const info = yield* auth.get("wanlaicode").pipe(Effect.mapError(userCenterError))
      if (!info) return yield* Effect.fail(userCenterError("WanlaiCode is not connected"))
      return info
    })

    const backendRequestWithOAuthSession = <T>(input: Omit<BackendRequestInput, "accessToken">) =>
      Effect.gen(function* () {
        const request = (accessToken: string) =>
          backendRequest<T>({ ...input, accessToken }).pipe(Effect.map((data) => ({ accessToken, data })))
        return yield* request(yield* oauthAccessToken()).pipe(
          Effect.catch((cause: unknown) => {
            if (!(cause instanceof WanlaiCodeBackendError) || cause.status !== 401) return Effect.fail(cause)
            return Effect.gen(function* () {
              return yield* request(yield* oauthAccessToken({ force: true }))
            })
          }),
        )
      })

    const backendRequestWithOAuthRaw = <T>(input: Omit<BackendRequestInput, "accessToken">) =>
      backendRequestWithOAuthSession<T>(input).pipe(Effect.map((result) => result.data))

    const backendRequestWithOAuth = <T>(input: Omit<BackendRequestInput, "accessToken">) =>
      backendRequestWithOAuthRaw<T>(input).pipe(Effect.mapError(userCenterError))

    // multipart 转发（社区投稿）。沿用与 JSON 请求一致的 401→强制刷新 token 重试。
    const backendMultipartWithOAuth = <T>(input: { path: string; form: FormData }) =>
      Effect.gen(function* () {
        const request = (accessToken: string) => backendMultipartRequest<T>({ ...input, accessToken })
        return yield* request(yield* oauthAccessToken()).pipe(
          Effect.catch((cause: unknown) => {
            if (!(cause instanceof WanlaiCodeBackendError) || cause.status !== 401) return Effect.fail(cause)
            return Effect.gen(function* () {
              return yield* request(yield* oauthAccessToken({ force: true }))
            })
          }),
        )
      }).pipe(Effect.mapError(userCenterError))

    const accountFromApiKey = Effect.fn("WanlaiCodeUserCenter.accountFromApiKey")(function* (apiKey: string) {
      const profile = yield* WanlaiCodeAuth.validateApiKey({ apiKey }).pipe(Effect.mapError(userCenterError))
      return {
        email: WanlaiCodeAuth.profileAccountEmail(profile),
        name: WanlaiCodeAuth.profileAccountName(profile),
      }
    })

    const accountFromOAuth = Effect.fn("WanlaiCodeUserCenter.accountFromOAuth")(function* (info: Auth.Info) {
      if (info.type !== "oauth") return yield* Effect.fail(userCenterError("WanlaiCode OAuth login is required"))
      return yield* backendRequestWithOAuth<UserInfo>({
        path: "/auth/me",
      }).pipe(
        Effect.map((user) => ({
          email: user.email,
          name: user.username || user.email?.split("@")[0],
        })),
        Effect.catch(() => accountFromApiKey(info.access)),
      )
    })

    const accountFromAuth = Effect.fn("WanlaiCodeUserCenter.accountFromAuth")(function* (info: Auth.Info) {
      if (info.type === "api") return yield* accountFromApiKey(info.key)
      if (info.type !== "oauth") return yield* Effect.fail(userCenterError("WanlaiCode OAuth or API login is required"))

      return yield* accountFromOAuth(info)
    })

    const restoreOAuthRuntimeKeyIfEntitled = Effect.fn("WanlaiCodeUserCenter.restoreOAuthRuntimeKeyIfEntitled")(
      function* (items: Record<string, unknown>[]) {
        const info = yield* auth.get("wanlaicode").pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (info?.type !== "oauth") return
        if (info.access) return
        if (!hasActiveSoftwareEntitlement(items)) return
        if (oauthRuntimeKeyRestore) return
        oauthRuntimeKeyRestore = true
        yield* Effect.gen(function* () {
          const accessToken = yield* oauthAccessToken()
          const latest = yield* auth.get("wanlaicode").pipe(Effect.catch(() => Effect.succeed(undefined)))
          if (latest?.type !== "oauth") return
          if (latest.access) return
          const expectedRevision = WanlaiCodeRefreshCoordinator.credentialRevision(latest)
          const runtimeKey = yield* WanlaiCodeAuth.createRuntimeKey({ accessToken }).pipe(
            Effect.mapError((cause) =>
              WanlaiCodeAuth.isNoEntitlementError(cause) ? WanlaiCodeAuth.noEntitlementError(cause) : cause,
            ),
          )
          const modified = yield* modifyWanlaiAuth((current) => {
            if (current?.type !== "oauth") return undefined
            if (WanlaiCodeRefreshCoordinator.credentialRevision(current) !== expectedRevision) return undefined
            if (current.access) return undefined
            // runtime key 请求期间若发生新登录，锁内代次校验会丢弃旧请求结果；同代次资料则完整保留。
            return {
              ...current,
              access: runtimeKey,
            }
          }).pipe(Effect.mapError(userCenterError))
          if (!modified) return
          yield* models.refreshWanlaiCode().pipe(Effect.ignore)
          yield* provider.refresh().pipe(Effect.ignore)
        }).pipe(
          Effect.catch((cause: unknown) => {
            // 所有入口写入同一个失效代次，gateway/event/status 会立即得到一致认证结论。
            if (isOAuthRefreshInvalid(cause)) WanlaiCodeRefreshCoordinator.markCredentialInvalid(info)
            return Effect.void
          }),
          Effect.ensuring(
            Effect.sync(() => {
              oauthRuntimeKeyRestore = false
            }),
          ),
        )
      },
    )

    const restoreOAuthRuntimeKeyFromEntitlements = Effect.fn(
      "WanlaiCodeUserCenter.restoreOAuthRuntimeKeyFromEntitlements",
    )(function* () {
      const info = yield* auth.get("wanlaicode").pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (info?.type !== "oauth") return
      if (info.access) return
      const data = yield* backendRequestWithOAuth<{ items?: unknown[] }>({
        path: "/software/entitlements",
      }).pipe(
        Effect.catch((cause: unknown) => {
          // 后端明确拒绝当前 OAuth 代次时同步到全局注册表，不能只在用户中心 handler 内记忆。
          if (isOAuthRefreshInvalid(cause)) WanlaiCodeRefreshCoordinator.markCredentialInvalid(info)
          return Effect.succeed({ items: [] })
        }),
      )
      yield* restoreOAuthRuntimeKeyIfEntitled((data.items ?? []).filter(isRecord))
    })

    const persistAccount = Effect.fn("WanlaiCodeUserCenter.persistAccount")(function* (
      info: Auth.Info,
      account: { email?: string; name?: string } | undefined,
    ) {
      if (info.type !== "oauth" && info.type !== "api") return
      const expectedRevision = info.type === "oauth" ? WanlaiCodeRefreshCoordinator.credentialRevision(info) : info.key
      yield* modifyWanlaiAuth((current) => {
        if (!current || current.type !== info.type || (current.type !== "oauth" && current.type !== "api"))
          return undefined
        const currentRevision =
          current.type === "oauth" ? WanlaiCodeRefreshCoordinator.credentialRevision(current) : current.key
        if (currentRevision !== expectedRevision) return undefined
        const accountEmail = nonEmptyString(current.accountEmail) ?? nonEmptyString(account?.email)
        const accountName = nonEmptyString(current.accountName) ?? nonEmptyString(account?.name)
        if (current.accountEmail === accountEmail && current.accountName === accountName) return undefined
        // 远端账号请求只允许补全发起请求时的同一凭据，不能把旧账号资料写进刚完成的新登录。
        return {
          ...current,
          accountEmail,
          accountName,
        }
      }).pipe(Effect.catch(() => Effect.void))
    })

    const status = Effect.fn("WanlaiCodeUserCenter.status")(function* () {
      const info = yield* auth.get("wanlaicode").pipe(Effect.catch(() => Effect.succeed(undefined)))
      // authenticated 仅由本地 info 推导；远端账号信息只用于补全 email/name。
      // 该接口是桌面端启动门控的依赖项，绝不能因远端慢/不可达而阻塞（否则界面卡在 "All done"）。
      // 因此远端补全改为后台异步刷新，本次直接用本地已持久化的 accountEmail/accountName 返回。
      if (info)
        yield* accountFromAuth(info).pipe(
          Effect.flatMap((account) => persistAccount(info, account)),
          Effect.catch(() => Effect.void),
          Effect.forkDetach,
        )
      const authenticated =
        info?.type === "oauth" ? !WanlaiCodeRefreshCoordinator.isCredentialInvalid(info) : info?.type === "api"
      if (authenticated && info?.type === "oauth" && !info.access) {
        yield* restoreOAuthRuntimeKeyFromEntitlements().pipe(Effect.forkDetach)
      }
      const effectiveAuthType =
        authenticated && info?.type === "oauth"
          ? ("oauth" as const)
          : authenticated && info?.type === "api"
            ? ("api" as const)
            : undefined
      return {
        ...(yield* configPayload()),
        authenticated,
        auth_type: effectiveAuthType === "oauth" || effectiveAuthType === "api" ? effectiveAuthType : undefined,
        requires_oauth: effectiveAuthType !== "oauth",
        // 该字段只表达本地凭据历史，不会把失效 OAuth 放宽成 authenticated。
        oauth_reauth_required: oauthReauthenticationRequired(authenticated, info),
        // 授权失效后不能继续返回旧账号资料，否则账号菜单会把“有缓存资料”误画成“仍已登录”。
        ...authenticatedAccountFields(authenticated, info),
      }
    })

    // 账号密码登录：转发远端 /api/v1/auth/login 拿用户 JWT，换取软件 API key 后
    // 落成与「API key 登录」一致的会话（用户 JWT 调不通 software OAuth 系列接口）。登录前即可调用。
    const login = Effect.fn("WanlaiCodeUserCenter.login")(function* (ctx: {
      payload: { email: string; password: string }
    }) {
      yield* WanlaiCodeAuth.loginWithEmailPassword(ctx.payload).pipe(Effect.mapError(userCenterError))
      return true
    })

    const entitlements = Effect.fn("WanlaiCodeUserCenter.entitlements")(function* () {
      const info = yield* currentAuth()
      if (info.type === "api") {
        const profile = yield* WanlaiCodeAuth.validateApiKey({ apiKey: info.key }).pipe(
          Effect.mapError(userCenterError),
        )
        return { items: isRecord(profile.entitlement) ? [profile.entitlement] : [] }
      }
      if (info.type !== "oauth") return yield* Effect.fail(userCenterError("WanlaiCode OAuth or API login is required"))

      const items = yield* Effect.gen(function* () {
        const data = yield* backendRequestWithOAuth<{ items?: unknown[] }>({
          path: "/software/entitlements",
        })
        return (data.items ?? []).filter(isRecord)
      }).pipe(
        Effect.catch((cause: unknown) =>
          isOAuthRefreshInvalid(cause)
            ? Effect.gen(function* () {
                const profile = yield* WanlaiCodeAuth.validateApiKey({ apiKey: info.access }).pipe(
                  Effect.mapError(userCenterError),
                )
                return isRecord(profile.entitlement) ? [profile.entitlement] : ([] as Record<string, unknown>[])
              })
            : Effect.fail(userCenterError(cause)),
        ),
      )
      yield* restoreOAuthRuntimeKeyIfEntitled(items)
      return { items }
    })

    const tokenPacks = Effect.fn("WanlaiCodeUserCenter.tokenPacks")(function* () {
      // token 包为 OAuth 专属功能；API-key 会话无用户身份，直接返回空列表，不报错
      const info = yield* currentAuth()
      if (info.type !== "oauth") return { items: [], server_now_ms: Date.now() }
      const data = yield* backendRequestWithOAuth<{ items?: unknown[]; server_now_ms?: number }>({
        path: "/software/token-packs",
      }).pipe(
        Effect.catch((cause: unknown) =>
          isOAuthRefreshInvalid(cause)
            ? Effect.succeed({ items: [] as unknown[], server_now_ms: Date.now() })
            : Effect.fail(userCenterError(cause)),
        ),
      )
      // 防御性 sanitize：后端返回字段可能缺失或为 null；
      // 数字字段缺失/非数字则补 0，字符串字段缺失则补 ""，
      // 确保 Effect HttpApi 出参编码不因 null/undefined 而返回 400。
      const items = (data.items ?? []).filter(isRecord).map((v) => ({
        id: typeof v["id"] === "number" ? v["id"] : 0,
        token_pack_id: typeof v["token_pack_id"] === "number" ? v["token_pack_id"] : 0,
        name: typeof v["name"] === "string" ? v["name"] : "",
        billing_token_quota: typeof v["billing_token_quota"] === "number" ? v["billing_token_quota"] : 0,
        billing_token_used: typeof v["billing_token_used"] === "number" ? v["billing_token_used"] : 0,
        remaining: typeof v["remaining"] === "number" ? v["remaining"] : 0,
        status: typeof v["status"] === "string" ? v["status"] : "",
        ...(typeof v["starts_at"] === "string" ? { starts_at: v["starts_at"] } : {}),
        ...(typeof v["expires_at"] === "string" ? { expires_at: v["expires_at"] } : {}),
      }))
      return { items, server_now_ms: data.server_now_ms ?? Date.now() }
    })

    // 更新通道是 per-user 偏好，仅 OAuth 登录用户可读写（API-key 会话无用户身份，故不走 entitlements 的 api-key 兜底）。
    const getUpdateChannel = Effect.fn("WanlaiCodeUserCenter.getUpdateChannel")(function* () {
      const data = yield* backendRequestWithOAuth<{
        channel?: string
        withdrawn_versions?: ReadonlyArray<{ version?: unknown; rollback_to?: unknown }>
      }>({ path: "/software/update-channel" })
      // 后端 JSON 仅做类型断言、无运行时校验：若某条 version 不是字符串，Effect HttpApi 出参编码
      // 会让整个端点 400（连带前端"当前通道"渲染失败）。这里 sanitize：丢弃非法条目，
      // rollback_to 非字符串则不带该键（与 group schema 的 Schema.optional(Schema.String) 兼容）。
      const withdrawn = (data.withdrawn_versions ?? [])
        .filter((v): v is { version: string; rollback_to?: unknown } => typeof v?.version === "string")
        .map((v) => ({
          version: v.version,
          ...(typeof v.rollback_to === "string" ? { rollback_to: v.rollback_to } : {}),
        }))
      return { channel: data.channel ?? "prod", withdrawn_versions: withdrawn }
    })

    const setUpdateChannel = Effect.fn("WanlaiCodeUserCenter.setUpdateChannel")(function* (ctx: {
      payload: { channel: "prod" | "canary" }
    }) {
      const data = yield* backendRequestWithOAuth<{ channel?: string }>({
        method: "POST",
        path: "/software/update-channel",
        body: { channel: ctx.payload.channel },
      })
      return { channel: data.channel ?? ctx.payload.channel }
    })

    const apiKeyGet = Effect.fn("WanlaiCodeUserCenter.apiKeyGet")(function* (ctx: {
      query: { product_code?: string }
    }) {
      const info = yield* currentAuth()
      if (info.type === "api") return { raw_key: info.key }
      if (info.type !== "oauth") return yield* Effect.fail(userCenterError("WanlaiCode OAuth or API login is required"))

      const data = yield* Effect.gen(function* () {
        return yield* backendRequestWithOAuthRaw<{ raw_key?: string }>({
          path: "/software/api-keys/current",
          query: { product_code: ctx.query.product_code || productCode },
        })
      }).pipe(
        Effect.catch((cause: unknown) =>
          cause instanceof WanlaiCodeBackendError && cause.status === 404
            ? Effect.succeed({ raw_key: undefined as string | undefined })
            : Effect.fail(userCenterError(cause)),
        ),
      )
      return { raw_key: data.raw_key }
    })

    const apiKeyCreate = Effect.fn("WanlaiCodeUserCenter.apiKeyCreate")(function* (ctx: {
      payload: { product_code?: string; replace_existing?: boolean }
    }) {
      const data = yield* backendRequestWithOAuth<{ raw_key?: string }>({
        method: "POST",
        path: "/software/api-keys",
        body: {
          product_code: ctx.payload.product_code || productCode,
          replace_existing: ctx.payload.replace_existing ?? false,
        },
      })
      return { raw_key: data.raw_key }
    })

    const apiKeyForImport = Effect.fn("WanlaiCodeUserCenter.apiKeyForImport")(function* (selectedProductCode?: string) {
      const info = yield* currentAuth()
      if (info.type === "api") return info.key
      if (info.type !== "oauth") return yield* Effect.fail(userCenterError("WanlaiCode OAuth or API login is required"))

      const current = yield* Effect.gen(function* () {
        return yield* backendRequestWithOAuthRaw<{ raw_key?: string }>({
          path: "/software/api-keys/current",
          query: { product_code: selectedProductCode || productCode },
        })
      }).pipe(
        Effect.catch((cause: unknown) =>
          cause instanceof WanlaiCodeBackendError && cause.status === 404
            ? Effect.succeed({ raw_key: undefined as string | undefined })
            : Effect.fail(userCenterError(cause)),
        ),
      )
      if (current.raw_key) return current.raw_key

      const created = yield* backendRequestWithOAuth<{ raw_key?: string }>({
        method: "POST",
        path: "/software/api-keys",
        body: {
          product_code: selectedProductCode || productCode,
          replace_existing: false,
        },
      }).pipe(Effect.catch((cause: unknown) => Effect.fail(userCenterError(cause))))
      if (created.raw_key) return created.raw_key
      return yield* Effect.fail(userCenterError("WanlaiCode software API key is unavailable"))
    })

    // 读取账户余额按量付费开关（无套餐用户专用）。仅 OAuth 登录支持，API Key 登录默认关闭。
    const balanceBillingGet = Effect.fn("WanlaiCodeUserCenter.balanceBillingGet")(function* () {
      const info = yield* currentAuth()
      if (info.type !== "oauth") return { enabled: false }
      const data = yield* backendRequestWithOAuth<{ enabled?: boolean }>({
        path: "/software/balance-billing",
      })
      return { enabled: data.enabled ?? false }
    })

    const balanceBillingUpdate = Effect.fn("WanlaiCodeUserCenter.balanceBillingUpdate")(function* (ctx: {
      payload: { enabled: boolean }
    }) {
      const info = yield* currentAuth()
      if (info.type !== "oauth") {
        return yield* Effect.fail(userCenterError("WanlaiCode OAuth login is required"))
      }
      const data = yield* backendRequestWithOAuth<{ enabled?: boolean }>({
        method: "POST",
        path: "/software/balance-billing",
        body: { enabled: ctx.payload.enabled },
      })
      return { enabled: data.enabled ?? ctx.payload.enabled }
    })

    const purchasePlans = Effect.fn("WanlaiCodeUserCenter.purchasePlans")(function* () {
      const settings = yield* purchaseSettings()
      if (!settings.enabled) return { ...settings, plans: [] }

      const info = yield* auth.get("wanlaicode").pipe(Effect.catch(() => Effect.succeed(undefined)))
      const accessToken =
        info?.type === "oauth"
          ? yield* oauthAccessToken().pipe(
              Effect.catch((cause: unknown) =>
                isOAuthRefreshInvalid(cause) ? Effect.succeed(undefined) : Effect.fail(userCenterError(cause)),
              ),
            )
          : undefined
      const plans = yield* storefrontPlansRequest({
        purchaseUrl: settings.purchase_url,
        accessToken,
      }).pipe(Effect.mapError(userCenterError))
      return { ...settings, plans }
    })

    const purchasePage = Effect.fn("WanlaiCodeUserCenter.purchasePage")(function* (ctx: {
      query: {
        plan_id?: string
        software_product?: string
        payment_type?: string
        user_id?: number
        user_uuid?: string
        theme?: "light" | "dark"
        lang?: string
        src_host?: string
        src_url?: string
      }
    }) {
      const settings = yield* purchaseSettings()
      if (!settings.enabled) return { enabled: false, url: "" }
      const user = yield* backendRequestWithOAuthSession<UserInfo>({
        path: "/auth/me",
      }).pipe(Effect.mapError(userCenterError))
      return {
        enabled: true,
        url: buildPurchasePageUrl({
          purchaseUrl: settings.purchase_url,
          siteUrl: WanlaiCodeAuth.resolveConfig().siteUrl,
          accessToken: user.accessToken,
          query: {
            ...ctx.query,
            user_id: ctx.query.user_id ?? user.data.id,
            user_uuid: ctx.query.user_uuid ?? user.data.uuid,
          },
        }),
      }
    })

    const usageList = Effect.fn("WanlaiCodeUserCenter.usageList")(function* (ctx: {
      query: {
        page?: number
        page_size?: number
        platform?: string
        start_date?: string
        end_date?: string
        timezone?: string
      }
    }) {
      const data = yield* backendRequestWithOAuth<{
        items?: unknown[]
        total?: number
        page?: number
        page_size?: number
        pages?: number
      }>({
        path: "/usage",
        query: {
          billing_scope: "software",
          page: ctx.query.page,
          page_size: ctx.query.page_size,
          platform: ctx.query.platform,
          start_date: ctx.query.start_date,
          end_date: ctx.query.end_date,
          timezone: ctx.query.timezone,
        },
      })
      return {
        items: (data.items ?? []).filter(isRecord),
        total: data.total ?? 0,
        page: data.page ?? ctx.query.page ?? 1,
        page_size: data.page_size ?? ctx.query.page_size ?? 20,
        pages: data.pages ?? 1,
      }
    })

    const usageStats = Effect.fn("WanlaiCodeUserCenter.usageStats")(function* (ctx: {
      query: {
        platform?: string
        start_date?: string
        end_date?: string
        timezone?: string
      }
    }) {
      const data = yield* backendRequestWithOAuth<unknown>({
        path: "/usage/stats",
        query: {
          billing_scope: "software",
          platform: ctx.query.platform,
          period: ctx.query.start_date || ctx.query.end_date ? undefined : "all",
          start_date: ctx.query.start_date,
          end_date: ctx.query.end_date,
          timezone: ctx.query.timezone,
        },
      })
      return isRecord(data) ? data : {}
    })

    const codexIntegrationStatusHandler = Effect.fn("WanlaiCodeUserCenter.codexIntegrationStatus")(function* () {
      return yield* Effect.tryPromise({
        try: () => codexIntegrationStatus(),
        catch: userCenterError,
      })
    })

    const codexIntegrationImport = Effect.fn("WanlaiCodeUserCenter.codexIntegrationImport")(function* (ctx: {
      payload: { product_code?: string }
    }) {
      const key = yield* apiKeyForImport(ctx.payload.product_code)
      return yield* Effect.tryPromise({
        try: () =>
          installCodexIntegration({
            apiKey: key,
            baseUrl: WanlaiCodeAuth.resolveConfig().apiBase,
          }),
        catch: userCenterError,
      })
    })

    const codexIntegrationRestore = Effect.fn("WanlaiCodeUserCenter.codexIntegrationRestore")(function* () {
      return yield* Effect.tryPromise({
        try: () => restoreCodexIntegration(),
        catch: userCenterError,
      })
    })

    const imageGenerate = Effect.fn("WanlaiCodeUserCenter.imageGenerate")(function* (ctx: {
      payload: ImageGenerateInput
    }) {
      return yield* imageGeneration.generateIntoSession(ctx.payload).pipe(Effect.mapError(userCenterError))
    })

    const clampContext = (value: string | undefined) => {
      const text = value?.trim()
      if (!text) return undefined
      if (text.length <= imageIntentContextMaxChars) return text
      const marker =
        "\n\n[Middle context omitted for image intent classification; use retained compacted summary and latest turns.]\n\n"
      const budget = Math.max(0, imageIntentContextMaxChars - marker.length)
      const head = Math.floor(budget * 0.25)
      const tail = budget - head
      return `${head > 0 ? text.slice(0, head).trimEnd() : ""}${marker}${tail > 0 ? text.slice(-tail).trimStart() : ""}`
    }

    const imageIntentModels = Effect.fn("WanlaiCodeUserCenter.imageIntent.models")(function* (
      payload: ImageIntentInput,
    ) {
      const rankIntentModel = (item: Provider.Model) => {
        const id = item.id.toLowerCase()
        if (id.includes("deepseek") && id.includes("flash")) return 0
        if (id.includes("flash")) return 1
        if (id.includes("mini")) return 2
        if (id.includes("nano")) return 3
        if (id.includes("haiku")) return 4
        // wanlaicode 的 claude 模型仅作最后兜底：优先用更便宜/更快的文本小模型分类，
        // 但当套餐里没有任何其它可用文本模型时，仍允许用 claude 兜底，避免「无可用文本模型」。
        if (item.providerID === ProviderID.make("wanlaicode") && /claude/i.test(item.id)) return 50
        return 10
      }
      const canClassify = (item: Provider.Model) => {
        if (item.capabilities.output.image) return false
        return item.capabilities.input.text && item.capabilities.output.text
      }
      const dedupe = (items: Array<Provider.Model | undefined>) => {
        const seen = new Set<string>()
        return items
          .filter((item): item is Provider.Model => !!item && canClassify(item))
          .filter((item) => {
            const key = `${item.providerID}/${item.id}`
            if (seen.has(key)) return false
            seen.add(key)
            return true
          })
      }

      if (payload.provider_id) {
        const requestedProviderID = ProviderID.make(payload.provider_id)
        const selected = payload.model
          ? yield* provider
              .getModel(requestedProviderID, ModelID.make(payload.model))
              .pipe(Effect.catch(() => Effect.succeed(undefined)))
          : undefined

        const small = yield* provider
          .getSmallModel(requestedProviderID)
          .pipe(Effect.catch(() => Effect.succeed(undefined)))

        const info = yield* provider
          .getProvider(requestedProviderID)
          .pipe(Effect.catch(() => Effect.succeed(undefined)))
        const fallback = info
          ? Object.values(info.models)
              .filter(canClassify)
              .sort((a, b) => rankIntentModel(a) - rankIntentModel(b))
              .at(0)
          : undefined

        const candidates = dedupe([selected, small, fallback]).filter((item) => item.providerID === requestedProviderID)
        if (candidates.length > 0) return candidates
      }

      const current = yield* provider.list()
      const fallback = Object.values(current)
        .flatMap((item) => Object.values(item.models))
        .filter(canClassify)
        .sort((a, b) => rankIntentModel(a) - rankIntentModel(b))
        .at(0)

      const defaults = yield* provider.defaultModel()
      const defaultModel = yield* provider
        .getModel(defaults.providerID, defaults.modelID)
        .pipe(Effect.catch(() => Effect.succeed(undefined)))
      return dedupe([fallback, defaultModel])
    })

    const imageIntent = Effect.fn("WanlaiCodeUserCenter.imageIntent")(function* (ctx: { payload: ImageIntentInput }) {
      const text = ctx.payload.text.trim()
      if (!text) {
        return { action: "none", confidence: 1, reason: "empty input" } satisfies ImageIntentResult
      }

      const context = clampContext(ctx.payload.recent_context)
      const currentImageCount =
        typeof ctx.payload.current_image_count === "number" && Number.isFinite(ctx.payload.current_image_count)
          ? Math.max(0, Math.floor(ctx.payload.current_image_count))
          : 0
      const currentImageFilenames = (ctx.payload.current_image_filenames ?? [])
        .map((item) => item.trim())
        .filter(Boolean)
      const system = [
        "You are the central intent router for a Codex-like chat system.",
        "Decide whether the latest user message should stay in normal chat or call the image_generation tool. Prefer calling the tool when the user asks for a generated or edited image.",
        "The latest user message decides the action for this turn. Use the immediately previous turn as the highest-priority context, then use earlier recent context only as supporting background.",
        "Do not let prior generated images/cards override the latest user intent. If the latest message asks for normal text, questions, analysis, explanation, code, or any non-visual content, return chat/none while preserving prior context for the chat model.",
        "Call image_generation for generate/edit requests: 生成一张图, 给我图片, 用图片的方式给我, 以图片形式给我, 用信息图卡片展示, 把上面的内容做成海报/卡片/图片, or any request to restyle/modify/continue an uploaded or recent image.",
        "If current uploaded images are present, they are the primary edit target for the latest user message. Prefer action=edit for requests like 改成gitee风格, 换个风格, 加/删/改元素, 保持原内容, even if recent chat context mentions older images.",
        "If recent context contains user-uploaded screenshots/images and the latest user asks 改好看点, 美化一下, 优化一下, 给我一张新的/新图/new version, treat that uploaded image as the edit target and call image_generation with action=edit unless the user explicitly asks to modify project files/code.",
        "If the recent context is an image or visual option list and the latest user message is only an option number like 8, 选8, or 第8个, treat it as choosing that visual option for continued generation/editing instead of ordinary chat.",
        "If recent assistant output is a generated image, visual card, SVG/PNG, infographic, poster, worksheet, or question card, only continue with image_generation when the latest user explicitly asks for a visual/image/card/poster format, says 以图片形式/用图片方式/做成卡片/继续这张图, or edits/restyles the existing image.",
        "Normal follow-up generation is chat/none even when recent context contains a visual image/card, unless the latest user explicitly asks for the new content to be generated as an image/card/poster or to edit/continue the image.",
        "For tool calls, action=generate creates a new visual asset; action=edit modifies, restyles, redraws, adds to, removes from, or continues an uploaded/recent image.",
        "The tool input image_prompt is the final prompt for the image model. Resolve vague visual requests like 用图片形式给我 or 再多加几道选择题并做成图片 into concrete subject/content from context instead of repeating the vague wording.",
        "For edits with current uploaded images, image_prompt must describe how to change the uploaded image and what to preserve from it; do not replace the task with older conversation content.",
        "When continuing a visual card/question card, image_prompt must say to preserve the same visual style/layout and add the requested new content.",
        "The tool input context_text is compact context the image model should use. Include the latest visual task, prior card contents, numbering/answer conventions, and style constraints needed for generation/editing.",
        "Do NOT call image_generation for normal chat, questions, analysis, explanation, coding, UI/image component work, image model discussion, diagrams, Mermaid, or any request ABOUT an image rather than a request to create/edit an image.",
        "Do NOT call image_generation when the user asks to create/build/generate a software artifact such as a game, Sokoban/推箱子, app, website, webpage, code, component, script, plugin, or project, unless they explicitly ask for an image/visual asset of it.",
        "Requests to download, preview, open, or display an existing image in software are coding/UI tasks and must return chat/none. Example: 修复下载图片按钮，不要跳转页面. Mentions of 下载图片按钮, image download button, existing image URLs, or OSS object links do not ask to generate an image.",
        "Questions or discussions about how image generation works must return chat/none. Example: 你觉得图片该怎么生成. Only an actual request to create or edit visual output should call the tool.",
        "Asking for the prompt text of a previous image is chat/none, never image_generation. Example: 帮我把你第一次生成图片的那张图片的提示词给我.",
        "When not calling the tool, return route=chat/action=none and omit image_prompt/context_text.",
        'Respond with ONLY a JSON object, no other text, no backticks: {"route":"chat|tool","tool":"image_generation","action":"generate|edit|none","confidence":0..1,"reason":"short","image_prompt":"only for tool route","context_text":"only for tool route"}',
      ].join("\n")
      const userText = [
        `Has image context: ${ctx.payload.has_image_context ? "yes" : "no"}`,
        `Current uploaded image count: ${currentImageCount}`,
        currentImageFilenames.length > 0
          ? `Current uploaded image filenames: ${currentImageFilenames.join(", ")}`
          : undefined,
        context ? `Recent context:\n${context}` : undefined,
        `Latest user message:\n${text}`,
      ]
        .filter(Boolean)
        .join("\n\n")

      const models = yield* imageIntentModels(ctx.payload)
      const candidates = yield* Effect.forEach(
        models,
        (model) => provider.getLanguage(model).pipe(Effect.catch(() => Effect.succeed(undefined))),
        { concurrency: 1 },
      ).pipe(Effect.map((items) => items.filter((item): item is NonNullable<typeof item> => !!item)))

      const result = yield* classifyIntent({
        candidates,
        actions: ["generate", "edit", "none"] as const,
        tools: [
          {
            name: "image_generation",
            description:
              "Route to this tool when the user wants to generate a new image or edit/continue an uploaded or recent image.",
            inputSchema: {
              type: "object",
              properties: {
                action: {
                  type: "string",
                  enum: ["generate", "edit"],
                  description: "generate for a new visual asset; edit for modifying/continuing an existing image.",
                },
                confidence: { type: "number", minimum: 0, maximum: 1 },
                reason: { type: "string" },
                image_prompt: {
                  type: "string",
                  description:
                    "Concrete final prompt for the image model, resolved from the latest message and context.",
                },
                context_text: {
                  type: "string",
                  description: "Compact context facts the image model should use.",
                },
              },
              required: ["action", "confidence", "reason", "image_prompt"],
              additionalProperties: false,
            },
          },
        ],
        system,
        user: userText,
        timeoutMs: imageIntentAttemptTimeoutMs,
        maxOutputTokens: 200,
      }).pipe(Effect.timeout(imageIntentTotalTimeoutMs), Effect.mapError(userCenterError))

      return {
        action: result.action,
        confidence: Math.max(0, Math.min(1, result.confidence)),
        reason: result.reason,
        route:
          result.data.route === "tool" || result.data.route === "chat"
            ? result.data.route
            : result.action === "none"
              ? "chat"
              : "tool",
        tool: result.data.tool === "image_generation" || result.action !== "none" ? "image_generation" : undefined,
        image_prompt: result.action === "none" ? undefined : optionalStringField(result.data, "image_prompt"),
        context_text: result.action === "none" ? undefined : optionalStringField(result.data, "context_text"),
      } satisfies ImageIntentResult
    })

    // 桌面 /bug 问题报告 → 社区投稿（type=bug）。用当前 OAuth 会话转发到后端 /community/posts。
    const communityPost = Effect.fn("WanlaiCodeUserCenter.communityPost")(function* (ctx: {
      payload: {
        title: string
        content: string
        priority?: string
        module?: string
        platform?: string
        attachments?: ReadonlyArray<{ data_url: string; mime?: string; filename?: string }>
      }
    }) {
      const info = yield* currentAuth()
      if (info.type !== "oauth") {
        return yield* Effect.fail(userCenterError("WanlaiCode OAuth login is required"))
      }
      const form = new FormData()
      form.append("type", "bug")
      // 桌面 /bug 问题报告强制为内部投稿：仅官方与作者本人可见，诊断信息不公开。
      form.append("internal", "true")
      form.append("title", ctx.payload.title)
      form.append("content", ctx.payload.content)
      if (ctx.payload.priority) form.append("priority", ctx.payload.priority)
      if (ctx.payload.module) form.append("module", ctx.payload.module)
      if (ctx.payload.platform) form.append("platform", ctx.payload.platform)
      ctx.payload.attachments?.forEach((att, index) => {
        const blob = dataUrlToBlob(att.data_url, att.mime)
        if (blob) form.append("attachments", blob, att.filename ?? `attachment-${index + 1}`)
      })
      const data = yield* backendMultipartWithOAuth<{ id?: number; status?: string; created_at?: string }>({
        path: "/community/posts",
        form,
      })
      return { id: data.id ?? 0, status: data.status, created_at: data.created_at }
    })

    return handlers
      .handle("status", status)
      .handle("login", login)
      .handle("entitlements", entitlements)
      .handle("tokenPacks", tokenPacks)
      .handle("getUpdateChannel", getUpdateChannel)
      .handle("setUpdateChannel", setUpdateChannel)
      .handle("apiKeyGet", apiKeyGet)
      .handle("apiKeyCreate", apiKeyCreate)
      .handle("balanceBillingGet", balanceBillingGet)
      .handle("balanceBillingUpdate", balanceBillingUpdate)
      .handle("purchasePlans", purchasePlans)
      .handle("purchasePage", purchasePage)
      .handle("usageList", usageList)
      .handle("usageStats", usageStats)
      .handle("codexIntegrationStatus", codexIntegrationStatusHandler)
      .handle("codexIntegrationImport", codexIntegrationImport)
      .handle("codexIntegrationRestore", codexIntegrationRestore)
      .handle("imageGenerate", imageGenerate)
      .handle("imageIntent", imageIntent)
      .handle("communityPost", communityPost)
  }),
)
