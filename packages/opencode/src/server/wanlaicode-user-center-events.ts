import { Auth } from "@/auth"
import { GlobalBus } from "@/bus/global"
import { AppRuntime } from "@/effect/app-runtime"
import { ModelsDev } from "@/provider/models"
import * as WanlaiCodeAuth from "@/provider/wanlaicode"
import { WanlaiCodeRefreshCoordinator } from "@/provider/wanlaicode-refresh-coordinator"
import { Event } from "@/provider/wanlaicode-user-center-events"
import * as Log from "@opencode-ai/core/util/log"
import { Effect } from "effect"

const log = Log.create({ service: "wanlaicode-user-center-events" })

type BackendEvent = {
  id?: string
  type?: string
  product_code?: string
  resources?: string[]
  reason?: string
  created_at?: string
}

type Stop = () => void

let stopCurrent: Stop | undefined
let refreshOAuthSessionPromise: Promise<void> | undefined
const seenEventIDs = new Map<string, number>()
const SEEN_EVENT_LIMIT = 200

export function start(): Stop {
  if (stopCurrent) return stopCurrent

  let stopped = false
  let connecting = false
  let ws: WebSocket | undefined
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  let tokenRefreshTimer: ReturnType<typeof setTimeout> | undefined
  let attempt = 0
  let messageQueue = Promise.resolve()

  const clearReconnect = () => {
    if (!reconnectTimer) return
    clearTimeout(reconnectTimer)
    reconnectTimer = undefined
  }
  const clearTokenRefresh = () => {
    if (!tokenRefreshTimer) return
    clearTimeout(tokenRefreshTimer)
    tokenRefreshTimer = undefined
  }

  const stop: Stop = () => {
    stopped = true
    clearReconnect()
    clearTokenRefresh()
    if (typeof globalThis.removeEventListener === "function") {
      globalThis.removeEventListener("online", onlineHandler)
    }
    if (ws) {
      try {
        ws.close()
      } catch {}
      ws = undefined
    }
    if (stopCurrent === stop) stopCurrent = undefined
  }

  const scheduleReconnect = (immediate = false) => {
    if (stopped || reconnectTimer) return
    const base = immediate ? 0 : Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5))
    const jitter = base > 0 ? Math.floor(Math.random() * Math.min(1000, Math.max(250, base * 0.2))) : 0
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined
      void connect()
    }, base + jitter)
    attempt++
  }

  const connect = async () => {
    if (stopped || connecting) return
    connecting = true
    try {
      const session = await oauthSession()
      if (!session) {
        scheduleReconnect()
        return
      }
      const token = await refreshAccessToken(session)
      if (stopped) return
      scheduleTokenRefresh(token.expiresIn)
      ws = openWebSocket(token.accessToken, session.apiBase)
      ws.addEventListener("open", () => {
        attempt = 0
      })
      ws.addEventListener("message", (message) => {
        // 每条失效事件只绑定建立当前 socket 的凭据；旧 socket 的迟到消息不能误伤刚完成的新登录。
        messageQueue = messageQueue
          .then(() => handleMessage(message.data, token.credential))
          .catch((error) => {
            log.warn("software events message handling failed", { error: errorMessage(error) })
          })
      })
      ws.addEventListener("close", () => {
        ws = undefined
        scheduleReconnect()
      })
      ws.addEventListener("error", () => {
        try {
          ws?.close()
        } catch {}
      })
    } catch (error) {
      if (isAuthFailure(error)) {
        emitAuthExpired(errorMessage(error))
        scheduleReconnect()
        return
      }
      log.warn("software events connect failed", { error: errorMessage(error) })
      scheduleReconnect()
    } finally {
      connecting = false
    }
  }

  void connect()

  const onlineHandler = () => scheduleReconnect(true)
  if (typeof globalThis.addEventListener === "function") {
    globalThis.addEventListener("online", onlineHandler)
  }

  stopCurrent = stop
  return stop

  function scheduleTokenRefresh(expiresIn?: number) {
    clearTokenRefresh()
    if (stopped || !expiresIn || expiresIn <= 90) return
    tokenRefreshTimer = setTimeout(
      () => {
        tokenRefreshTimer = undefined
        try {
          ws?.close()
        } catch {}
        scheduleReconnect(true)
      },
      Math.max(30_000, (expiresIn - 60) * 1000),
    )
  }
}

async function oauthSession() {
  const info = await AppRuntime.runPromise(Auth.Service.use((auth) => auth.get("wanlaicode").pipe(Effect.orDie)))
  if (!info || info.type !== "oauth") return undefined
  return {
    credential: info,
    runtimeKey: info.access,
    softwareToken: info.softwareToken,
    refreshToken: info.refresh,
    accountId: info.accountId,
    accountEmail: info.accountEmail,
    accountName: info.accountName,
    siteUrl: info.enterpriseUrl,
    expiresIn: Math.max(0, info.expires - Math.floor(Date.now() / 1000)),
    apiBase: undefined as string | undefined,
  }
}

export async function refreshAccessToken(session: Awaited<ReturnType<typeof oauthSession>> & {}) {
  // 服务端已经明确撤销的凭据代次不能复用旧 JWT 重连，也不能再次触发普通 refresh 尝试。
  if (WanlaiCodeRefreshCoordinator.isCredentialInvalid(session.credential)) {
    throw new WanlaiCodeAuth.OAuthExpiredError("WanlaiCode OAuth credential has been revoked")
  }
  // OAuth 回调已保存的 JWT 尚未临近过期时直接建立事件连接，避免启动阶段额外轮换 refresh token。
  if (session.softwareToken && session.expiresIn > 60) {
    return { accessToken: session.softwareToken, expiresIn: session.expiresIn, credential: session.credential }
  }
  const result = await WanlaiCodeRefreshCoordinator.refresh({ apiBase: session.apiBase, reason: "usercenter-ws" })
  return {
    accessToken: result.softwareToken,
    expiresIn: Math.max(0, result.expires - Math.floor(Date.now() / 1000)),
    credential: {
      ...session.credential,
      access: result.runtimeKey,
      refresh: result.refreshToken,
      softwareToken: result.softwareToken,
      expires: result.expires,
    },
  }
}

function openWebSocket(accessToken: string, apiBase?: string) {
  const config = WanlaiCodeAuth.resolveConfig({ apiBase })
  const url = new URL("/api/v1/software/events", config.relayRoot)
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  return new WebSocket(url, ["wanlaicode-software-events", `jwt.${accessToken}`])
}

async function handleMessage(data: unknown, credential?: Extract<Auth.Info, { type: "oauth" }>) {
  const event = parseBackendEvent(data)
  if (!event) return
  if (isDuplicateEvent(event)) return
  if (event.type === "software.auth.expired") {
    const current = await AppRuntime.runPromise(Auth.Service.use((auth) => auth.get("wanlaicode").pipe(Effect.orDie)))
    // 旧 socket 的迟到撤权只污染它捕获的历史 revision；当前已重新登录时不能再把新会话广播成过期。
    if (invalidateCredentialForBackendEvent(event, credential, current)) {
      emitAuthExpired(event.reason, event.product_code)
    }
    return
  }
  const resources = resourcesFromBackendEvent(event)
  if (resources.some((item) => item === "status" || item === "entitlements" || item === "api_key")) {
    await refreshOAuthSession()
  }
  if (resources.some((item) => item === "models" || item === "providers")) {
    await refreshProviders()
  }
  GlobalBus.emit("event", {
    directory: "global",
    payload: {
      type: Event.UserCenterChanged.type,
      properties: {
        resources,
        reason: event.reason,
        product_code: event.product_code,
      },
    },
  })
}

export function invalidateCredentialForBackendEvent(
  event: BackendEvent,
  credential?: Extract<Auth.Info, { type: "oauth" }>,
  current?: Auth.Info,
) {
  if (event.type !== "software.auth.expired") return false
  // 服务端明确撤销时写入共享失效注册表，status、图片、gateway 和事件重连会立即得到同一结论。
  if (credential) WanlaiCodeRefreshCoordinator.markCredentialInvalid(credential)
  // 未绑定凭据的旧协议事件仍按保守策略广播；已绑定时只有当前 Auth 仍是同一 OAuth revision 才通知重新登录。
  if (!credential || !current) return true
  if (current.type !== "oauth") return false
  if (
    WanlaiCodeRefreshCoordinator.credentialRevision(current) !==
    WanlaiCodeRefreshCoordinator.credentialRevision(credential)
  ) {
    return false
  }
  return true
}

function isDuplicateEvent(event: BackendEvent) {
  if (!event.id) return false
  if (seenEventIDs.has(event.id)) return true
  seenEventIDs.set(event.id, Date.now())
  if (seenEventIDs.size <= SEEN_EVENT_LIMIT) return false
  const first = seenEventIDs.keys().next().value
  if (first) seenEventIDs.delete(first)
  return false
}

function parseBackendEvent(data: unknown): BackendEvent | undefined {
  try {
    const text =
      typeof data === "string" ? data : data instanceof ArrayBuffer ? new TextDecoder().decode(data) : String(data)
    const parsed = JSON.parse(text)
    if (!parsed || typeof parsed !== "object") return undefined
    return parsed as BackendEvent
  } catch {
    return undefined
  }
}

function normalizeResources(resources: string[] | undefined) {
  const result = Array.from(new Set((resources ?? ["status"]).map((item) => item.trim().toLowerCase()).filter(Boolean)))
  return result.length ? result : ["status"]
}

export function resourcesFromBackendEvent(event: BackendEvent) {
  const resources = normalizeResources(event.resources)
  if (resources.length !== 1 || resources[0] !== "status") return resources
  if (event.type === "software.models.changed") return ["models", "providers"]
  if (event.type === "software.providers.changed") return ["providers"]
  if (event.type === "software.entitlements.changed") return ["status", "entitlements"]
  if (event.type === "software.api_key.changed") return ["status", "api_key"]
  return resources
}

async function refreshOAuthSession() {
  refreshOAuthSessionPromise ??= (async () => {
    const info = await AppRuntime.runPromise(Auth.Service.use((auth) => auth.get("wanlaicode").pipe(Effect.orDie)))
    if (!info || info.type !== "oauth") return
    await WanlaiCodeRefreshCoordinator.refresh({ reason: "usercenter-event" })
  })().finally(() => {
    refreshOAuthSessionPromise = undefined
  })
  try {
    await refreshOAuthSessionPromise
  } catch (error) {
    if (isAuthFailure(error)) {
      emitAuthExpired(errorMessage(error))
      return
    }
    log.warn("software events oauth session refresh failed", { error: errorMessage(error) })
  }
}

async function refreshProviders() {
  try {
    await AppRuntime.runPromise(ModelsDev.Service.use((models) => models.refreshWanlaiCode()))
  } catch (error) {
    log.warn("software events provider refresh failed", { error: errorMessage(error) })
  }
}

function emitAuthExpired(reason?: string, productCode?: string) {
  GlobalBus.emit("event", {
    directory: "global",
    payload: {
      type: Event.UserCenterAuthExpired.type,
      properties: {
        reason,
        product_code: productCode,
      },
    },
  })
}

export function isAuthFailure(error: unknown) {
  // 只有协调器确认的凭据过期，或 token 端点返回的结构化 refresh-token 失效原因，才能撤销全局登录态。
  // profile 的普通 401/403、服务端 5xx 与网络异常都应保留为可重试故障，不能仅凭错误文本猜测认证过期。
  return WanlaiCodeAuth.isOAuthExpiredError(error) || WanlaiCodeAuth.isOAuthRefreshTokenInvalid(error)
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message
  return String(error)
}

export const WanlaiCodeUserCenterEvents = { start }
