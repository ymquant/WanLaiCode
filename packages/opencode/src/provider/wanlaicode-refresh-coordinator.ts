import { Effect } from "effect"
import { Auth } from "@/auth"
import * as WanlaiCodeAuth from "@/provider/wanlaicode"
import { WanlaiCodeCredentialState } from "@/provider/wanlaicode-credential-state"
import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "wanlaicode-refresh-coordinator" })

type AuthOauth = Extract<Auth.Info, { type: "oauth" }>

export interface RefreshResult {
  runtimeKey: string
  refreshToken: string
  expires: number
  softwareToken: string
}

interface TokenRefresh {
  refreshToken: string
  expiresIn?: number
  softwareToken: string
}

interface RuntimeKeyRefresh {
  runtimeKey: string
  profile: WanlaiCodeAuth.WanlaiCodeProfile
}

interface CoordinatorDeps {
  loadAuth: () => Promise<AuthOauth | undefined>
  saveAuth: (info: AuthOauth) => Promise<void>
  modifyAuth?: (update: (current: AuthOauth | undefined) => AuthOauth | undefined) => Promise<AuthOauth | undefined>
  refreshToken: (input: { refreshToken: string; apiBase?: string }) => Promise<TokenRefresh>
  refreshRuntimeKey: (input: { accessToken: string; apiBase?: string }) => Promise<RuntimeKeyRefresh>
}

type AuthStore = Pick<CoordinatorDeps, "loadAuth" | "saveAuth" | "modifyAuth">

// 懒加载 AppRuntime：静态 import 会与 app-runtime → models/provider → 本模块 形成循环，
// 令 app-runtime 组装 layer 时 ModelsDev.defaultLayer 落入 TDZ 而崩溃
// （破环手法同 control-plane/adapters/worktree.ts）。
const appRuntime = async () => (await import("@/effect/app-runtime")).AppRuntime

// 默认依赖：走真实 AppRuntime + Auth.Service + WanlaiCodeAuth
const defaultDeps: CoordinatorDeps = {
  loadAuth: async () => {
    const rt = await appRuntime()
    const info = await rt.runPromise(Auth.Service.use((auth) => auth.get("wanlaicode").pipe(Effect.orDie)))
    return info?.type === "oauth" ? info : undefined
  },
  saveAuth: async (info) => {
    const rt = await appRuntime()
    await rt.runPromise(Auth.Service.use((auth) => auth.set("wanlaicode", info).pipe(Effect.orDie)))
  },
  modifyAuth: async (update) => {
    const rt = await appRuntime()
    return rt.runPromise(
      Auth.Service.use((auth) => {
        if (!auth.modify) return Effect.die("Auth.modify is unavailable")
        return auth
          .modify("wanlaicode", (current) =>
            // AUTH_CONTENT 是只读启动快照时，锁内读取仍可能返回 source revision；映射到本进程已提交的最新轮换代次。
            update(current?.type === "oauth" ? currentAuth(current) : undefined),
          )
          .pipe(
            Effect.map((current) => (current?.type === "oauth" ? current : undefined)),
            Effect.orDie,
          )
      }),
    )
  },
  refreshToken: async (input) => {
    const rt = await appRuntime()
    const tokens = await rt.runPromise(
      WanlaiCodeAuth.refreshOAuthToken({
        refreshToken: input.refreshToken,
        apiBase: input.apiBase,
        fetch: WanlaiCodeAuth.createFetch("WanlaiCode.refresh.coordinator") as WanlaiCodeAuth.Fetch,
      }),
    )
    return {
      refreshToken: tokens.refresh_token ?? input.refreshToken,
      expiresIn: tokens.expires_in,
      softwareToken: tokens.access_token,
    }
  },
  refreshRuntimeKey: async (input) => {
    const rt = await appRuntime()
    return rt.runPromise(
      WanlaiCodeAuth.completeOAuthRefresh({
        accessToken: input.accessToken,
        apiBase: input.apiBase,
        fetch: WanlaiCodeAuth.createFetch("WanlaiCode.refresh.coordinator") as WanlaiCodeAuth.Fetch,
      }),
    )
  },
}

let deps: CoordinatorDeps = defaultDeps
// 进程内最新凭据必须绑定首次读取的来源代次；退出后重新登录时，来源变化会立即丢弃旧账号 token。
let shared: { sourceRevision: string; info: AuthOauth } | undefined
let inflight: Promise<RefreshResult> | undefined

// 对外保留协调器原有 API；失效注册表独立后，OAuth callback 可在不形成循环依赖的前提下清理新凭据。
export const credentialRevision = WanlaiCodeCredentialState.credentialRevision
export const markCredentialInvalid = WanlaiCodeCredentialState.markCredentialInvalid
export const clearCredentialInvalid = WanlaiCodeCredentialState.clearCredentialInvalid
export const isCredentialInvalid = WanlaiCodeCredentialState.isCredentialInvalid

function currentAuth(base: AuthOauth) {
  if (!shared) return base
  const revision = credentialRevision(base)
  if (revision === credentialRevision(shared.info)) {
    // 凭据代次相同时采用存储中的最新资料/runtime key，并同步内存；不能因 revision 忽略账号资料的并发补全。
    shared = { ...shared, info: base }
    return base
  }
  if (revision === shared.sourceRevision) return shared.info
  // Auth.Service 读到不属于当前轮换链的新代次时，以新登录持久化结果为权威。
  shared = undefined
  return base
}

async function persistTokens(base: AuthOauth, next: TokenRefresh, authStore: AuthStore): Promise<AuthOauth> {
  const sourceRevision = shared?.sourceRevision ?? credentialRevision(base)
  const expires = WanlaiCodeAuth.oauthTokenExpiresAt({ accessToken: next.softwareToken, expiresIn: next.expiresIn })
  const info = await modifyCurrentCredential(authStore, base, (current) => ({
    ...current,
    refresh: next.refreshToken,
    softwareToken: next.softwareToken,
    expires,
  }))
  // token endpoint 可能立即废弃旧 refresh token；CAS 成功后再更新内存权威，随后才请求 profile/runtime key。
  shared = { sourceRevision, info }
  return info
}

async function persistRuntimeKey(
  base: AuthOauth,
  next: RuntimeKeyRefresh,
  authStore: AuthStore,
): Promise<RefreshResult> {
  const info = await modifyCurrentCredential(authStore, base, (current) => ({
    ...current,
    access: next.runtimeKey,
    accountId: next.profile.account?.uuid ?? current.accountId,
    accountEmail: WanlaiCodeAuth.profileAccountEmail(next.profile) ?? current.accountEmail,
    accountName: WanlaiCodeAuth.profileAccountName(next.profile) ?? current.accountName,
  }))
  // 第二次原子修改只补全推理 key 与资料，不得改动刚刚保存的 OAuth token 代次。
  if (shared) shared = { ...shared, info }
  return {
    runtimeKey: next.runtimeKey,
    refreshToken: info.refresh,
    expires: info.expires,
    softwareToken: info.softwareToken ?? "",
  }
}

async function modifyCurrentCredential(
  authStore: AuthStore,
  expected: AuthOauth,
  update: (current: AuthOauth) => AuthOauth,
): Promise<AuthOauth> {
  const expectedRevision = credentialRevision(expected)
  if (authStore.modifyAuth) {
    const modified = await authStore.modifyAuth((current) => {
      if (!current || credentialRevision(current) !== expectedRevision) return undefined
      // 明确撤权可能发生在网络请求返回与 CAS 提交之间；失效的来源或目标代次都不得写回并复活登录态。
      if (isCredentialInvalid(current)) return undefined
      const next = update(current)
      if (isCredentialInvalid(next)) return undefined
      return next
    })
    if (modified) return modified
    if (isCredentialInvalid(expected)) throw WanlaiCodeAuth.oauthExpiredError("oauth credential revision is invalid")
    // 登录、退出和刷新都在 Auth.modify 的同一跨进程锁内提交；CAS 失败时旧结果绝不能再尝试覆盖。
    throw new Error("wanlaicode oauth credential changed during refresh")
  }

  // 仅测试 mock 可缺少原子 modify；正式 Auth layer 始终走上方跨进程锁内的 CAS。
  const loaded = await authStore.loadAuth()
  const current = loaded ? currentAuth(loaded) : undefined
  if (!current || credentialRevision(current) !== expectedRevision) {
    throw new Error("wanlaicode oauth credential changed during refresh")
  }
  if (isCredentialInvalid(current)) throw WanlaiCodeAuth.oauthExpiredError("oauth credential revision is invalid")
  const modified = update(current)
  // 测试兼容存储也必须遵守同一撤权优先级，历史失效目标不能被非 callback 刷新重新写入。
  if (isCredentialInvalid(modified)) throw WanlaiCodeAuth.oauthExpiredError("oauth credential revision is invalid")
  await authStore.saveAuth(modified)
  return modified
}

async function runRefresh(options?: { apiBase?: string; auth?: Auth.Interface }): Promise<RefreshResult> {
  // Effect 服务内调用显式沿用该 layer 的 Auth.Interface；gateway/scheduler 等进程入口继续使用默认 AppRuntime。
  const authStore = options?.auth
    ? {
        loadAuth: async () => {
          const info = await Effect.runPromise(options.auth!.get("wanlaicode"))
          return info?.type === "oauth" ? info : undefined
        },
        saveAuth: async (info: AuthOauth) => Effect.runPromise(options.auth!.set("wanlaicode", info)),
        modifyAuth: options.auth.modify
          ? async (update: (current: AuthOauth | undefined) => AuthOauth | undefined) => {
              const current = await Effect.runPromise(
                options.auth!.modify!("wanlaicode", (info) =>
                  // 显式 Effect layer 也可能使用只读 AUTH_CONTENT 测试快照，保持与默认 AppRuntime 相同的代次映射。
                  update(info?.type === "oauth" ? currentAuth(info) : undefined),
                ),
              )
              return current?.type === "oauth" ? current : undefined
            }
          : undefined,
      }
    : { loadAuth: deps.loadAuth, saveAuth: deps.saveAuth, modifyAuth: deps.modifyAuth }
  const loaded = await authStore.loadAuth()
  if (!loaded) throw new Error("wanlaicode oauth credential missing")
  const base = currentAuth(loaded)
  if (isCredentialInvalid(base)) throw WanlaiCodeAuth.oauthExpiredError("oauth credential revision is invalid")
  // WanlaiCode 的 enterpriseUrl 保存 OAuth 站点地址，不是 API base；无显式覆盖时交给 provider 默认配置解析。
  const effectiveApiBase = options?.apiBase
  try {
    const tokens = await deps.refreshToken({ refreshToken: base.refresh, apiBase: effectiveApiBase })
    const tokenInfo = await persistTokens(base, tokens, authStore)
    const next = await deps.refreshRuntimeKey({ accessToken: tokenInfo.softwareToken ?? "", apiBase: effectiveApiBase })
    return await persistRuntimeKey(tokenInfo, next, authStore)
  } catch (error) {
    if (WanlaiCodeAuth.isNoEntitlementRuntimeError(error)) throw error
    if (WanlaiCodeAuth.isOAuthRefreshTokenInvalid(error)) {
      // 容错兜底：可能是另一进程已轮换了 auth.json，重读后用最新 refresh 重试一次
      const reloadedRaw = await authStore.loadAuth()
      const reloaded = reloadedRaw ? currentAuth(reloadedRaw) : undefined
      if (reloaded && credentialRevision(reloaded) !== credentialRevision(base)) {
        if (isCredentialInvalid(reloaded)) throw WanlaiCodeAuth.oauthExpiredError(error)
        try {
          const tokens = await deps.refreshToken({ refreshToken: reloaded.refresh, apiBase: effectiveApiBase })
          const tokenInfo = await persistTokens(reloaded, tokens, authStore)
          const next = await deps.refreshRuntimeKey({
            accessToken: tokenInfo.softwareToken ?? "",
            apiBase: effectiveApiBase,
          })
          return await persistRuntimeKey(tokenInfo, next, authStore)
        } catch (retryError) {
          if (WanlaiCodeAuth.isNoEntitlementRuntimeError(retryError)) throw retryError
          if (WanlaiCodeAuth.isOAuthRefreshTokenInvalid(retryError)) {
            markCredentialInvalid(reloaded)
            throw WanlaiCodeAuth.oauthExpiredError(retryError)
          }
          throw retryError
        }
      }
      markCredentialInvalid(base)
      throw WanlaiCodeAuth.oauthExpiredError(error)
    }
    throw error
  }
}

// 单飞刷新：并发调用复用同一次在途刷新
export function refresh(opts?: { apiBase?: string; reason?: string; auth?: Auth.Interface }): Promise<RefreshResult> {
  if (inflight) return inflight
  if (opts?.reason) log.info("oauth refresh", { reason: opts.reason })
  inflight = runRefresh(opts).finally(() => {
    inflight = undefined
  })
  return inflight
}

export function configureForTest(next: Partial<CoordinatorDeps>): void {
  // 自定义内存 store 若未显式提供 modify，必须使用测试 fallback，不能意外写入真实 AppRuntime auth.json。
  deps = {
    ...defaultDeps,
    ...next,
    ...((next.loadAuth || next.saveAuth) && !next.modifyAuth ? { modifyAuth: undefined } : {}),
  }
}

export const REFRESH_LEAD_MS = 5 * 60_000
export const MIN_DELAY_MS = 60_000
export const MAX_DELAY_MS = 24 * 60 * 60_000

// 按 access token 过期时间（unix 秒）算下次刷新延迟：提前 REFRESH_LEAD_MS，clamp 到 [MIN, MAX]
export function computeRefreshDelayMs(expires: number, now: number): number {
  const untilExpiry = expires * 1000 - now
  const target = untilExpiry - REFRESH_LEAD_MS
  return Math.min(MAX_DELAY_MS, Math.max(MIN_DELAY_MS, target))
}

let timer: ReturnType<typeof setTimeout> | undefined

async function scheduleTick(): Promise<void> {
  // 定时器可能早于登录启动；每次触发先读取当前凭据，避免用启动时的固定 60 秒节奏刷新刚登录的 token。
  const current = await deps.loadAuth().catch(() => undefined)
  if (timer === undefined) return
  if (!current) {
    timer = setTimeout(scheduleTick, MIN_DELAY_MS)
    return
  }

  const now = Date.now()
  if (current.expires * 1000 - REFRESH_LEAD_MS > now) {
    // 尚未进入刷新窗口时只重排定时器；按到期时间调度，不能无意义地消耗轮换型 refresh token。
    timer = setTimeout(scheduleTick, computeRefreshDelayMs(current.expires, now))
    return
  }

  try {
    await refresh({ reason: "scheduled" })
  } catch (error) {
    // 定时刷新失败静默（不打扰用户）；下次 tick 或请求 401 会再刷
    log.warn("scheduled oauth refresh failed", { error: error instanceof Error ? error.message : String(error) })
  }
  const info = await deps.loadAuth().catch(() => undefined)
  if (timer === undefined) return
  const delay = info ? computeRefreshDelayMs(info.expires, Date.now()) : MIN_DELAY_MS
  timer = setTimeout(scheduleTick, delay)
}

// 幂等启动定时刷新循环（仅真正 serve 时调用）
export function ensureTokenRefreshScheduler(): void {
  if (timer) return
  timer = setTimeout(scheduleTick, MIN_DELAY_MS)
  log.info("oauth token refresh scheduler started")
}

export function stopTokenRefreshScheduler(): void {
  if (timer) clearTimeout(timer)
  timer = undefined
}

export function resetForTest(): void {
  if (timer) clearTimeout(timer)
  timer = undefined
  deps = defaultDeps
  shared = undefined
  inflight = undefined
  WanlaiCodeCredentialState.resetForTest()
}

export * as WanlaiCodeRefreshCoordinator from "./wanlaicode-refresh-coordinator"
