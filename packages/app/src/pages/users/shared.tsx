import { resolveError } from "@opencode-ai/core/error/resolve"
import type { ErrorAction } from "@opencode-ai/core/error/error-actions"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { createEffect, onCleanup, Show, type JSX } from "solid-js"
import type { useGlobalSDK } from "@/context/global-sdk"
import { useLanguage } from "@/context/language"
import type { SoftwareEntitlement, SoftwareEntitlementWindow, UserCenterStatusProps } from "./types"

export type UserCenterEventResource =
  | "status"
  | "entitlements"
  | "api_key"
  | "purchase_plans"
  | "codex_integration"
  | "models"
  | "providers"

type UserCenterEventPayload = {
  type?: string
  properties?: {
    resources?: string[]
    reason?: string
    product_code?: string
  }
}

export function useUserCenterEvents(
  globalSDK: ReturnType<typeof useGlobalSDK>,
  handlers: {
    resources?: UserCenterEventResource[]
    onChange?: (resources: string[], reason?: string) => unknown
    onAuthExpired?: (reason?: string) => unknown
  },
) {
  createEffect(() => {
    const unsubscribe = globalSDK.event.on("global", (rawEvent) => {
      const event = rawEvent as UserCenterEventPayload
      if (event.type === "wanlaicode.user-center.auth.expired") {
        void handlers.onAuthExpired?.(event.properties?.reason)
        return
      }
      if (event.type !== "wanlaicode.user-center.changed") return
      const resources = normalizeUserCenterEventResources(event.properties?.resources)
      const interested = handlers.resources
      if (interested?.length && !interested.some((resource) => resources.includes(resource))) return
      void handlers.onChange?.(resources, event.properties?.reason)
    })
    onCleanup(unsubscribe)
  })
}

function normalizeUserCenterEventResources(resources: string[] | undefined) {
  const result = Array.from(
    new Set(
      (resources ?? ["status"])
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean),
    ),
  )
  return result.length ? result : ["status"]
}

export const formatNumber = (value: number, locale: string) => new Intl.NumberFormat(locale).format(value)
export const formatRate = (value: number) => `${value.toFixed(2)}x`
export const maskSoftwareKey = (value: string) =>
  value.length <= 10 ? value : `${value.slice(0, 6)}****${value.slice(-4)}`

export function finiteNumber(value: unknown, fallback = 0) {
  const next = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN
  return Number.isFinite(next) ? next : fallback
}

export function sdkErrorMessage(error: unknown) {
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
  return read(error) ?? String(error)
}

const LOGIN_EXPIRED_REASONS = new Set([
  "SOFTWARE_OAUTH_REFRESH_TOKEN_INVALID",
  "SOFTWARE_OAUTH_AUTHORIZATION_EXPIRED",
  "INVALID_GRANT",
])

export function isWanlaiAuthExpiredMessage(error: unknown) {
  if (typeof error !== "object" || error === null) return false
  const data =
    "data" in error && typeof error.data === "object" && error.data !== null
      ? (error.data as Record<string, unknown>)
      : (error as Record<string, unknown>)
  const reason = typeof data.reason === "string" ? data.reason : typeof data.error === "string" ? data.error : undefined
  return !!reason && LOGIN_EXPIRED_REASONS.has(reason.trim().toUpperCase())
}

export function unwrapSDK<T>(response: { data: T; error: undefined } | { data: undefined; error: unknown }): T {
  if (response.error !== undefined) {
    const message = sdkErrorMessage(response.error)
    const err = new Error(message) as Error & { reason?: string }
    // response.error 形如 { name, data: { message, reason } }，尝试提取 reason
    const rawErr = response.error as { data?: { reason?: unknown } } | null
    const reason = rawErr?.data?.reason
    if (typeof reason === "string" && reason) err.reason = reason
    throw err
  }
  if (response.data === undefined) throw new Error("Empty SDK response")
  return response.data
}

export async function unwrapSDKSafe<T extends object>(
  request: Promise<unknown>,
  fallback: T,
): Promise<T & { __error?: string; __errorObj?: unknown }> {
  try {
    return unwrapSDK((await request) as { data: T; error: undefined } | { data: undefined; error: unknown })
  } catch (error) {
    // __error 保留字符串供 InlineErrorState message 使用
    // __errorObj 保留原始 Error 对象（含 reason 字段），供 ErrorActionView 做语义分类
    return { ...fallback, __error: sdkErrorMessage(error), __errorObj: error }
  }
}

export function formatDateTime(value: string | null | undefined, locale: string) {
  if (!value) return "--"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date)
}

export function formatDuration(ms: unknown) {
  const value = finiteNumber(ms)
  if (value <= 0) return "--"
  return `${(value / 1000).toFixed(2)}s`
}

export function cacheTokens(row: {
  cache_creation_tokens?: number
  cache_read_tokens?: number
  cache_creation_5m_tokens?: number
  cache_creation_1h_tokens?: number
}) {
  return (
    finiteNumber(row.cache_creation_tokens) +
    finiteNumber(row.cache_read_tokens) +
    finiteNumber(row.cache_creation_5m_tokens) +
    finiteNumber(row.cache_creation_1h_tokens)
  )
}

export function actualTokens(row: {
  input_tokens?: number
  output_tokens?: number
  cache_creation_tokens?: number
  cache_read_tokens?: number
  cache_creation_5m_tokens?: number
  cache_creation_1h_tokens?: number
}) {
  return finiteNumber(row.input_tokens) + finiteNumber(row.output_tokens) + cacheTokens(row)
}

export function windowLimit(window: SoftwareEntitlementWindow | null | undefined, fallback = 0) {
  return finiteNumber(window?.limit_tokens, fallback)
}

export function windowUsed(window: SoftwareEntitlementWindow | null | undefined) {
  return finiteNumber(window?.used_tokens)
}

export function windowRemaining(window: SoftwareEntitlementWindow | null | undefined) {
  const remaining = finiteNumber(window?.remaining_tokens, Number.NaN)
  if (Number.isFinite(remaining)) return remaining
  return Math.max(windowLimit(window) - windowUsed(window), 0)
}

export type BalanceWindowKey = "total" | "five_hour" | "seven_day" | "thirty_day"

// 决定额度面板要展示哪些窗口:只展示有限额(limit>0)的窗口。
// 「总额型」套餐(如新手试用,额度在 total、5h/7d 未设)→ 展示总额度;
// 「滚动型」套餐(付费,5h/7d 有限额)→ 展示 5h/7d。
// 无任何限额(加载中 / 未配置)时回退,保持原有展示不变。
// includeThirtyDay:额度详情页额外展示 30d 窗口(账号弹窗保持紧凑,不传)。
export function selectBalanceWindows(
  usage:
    | {
        five_hour?: SoftwareEntitlementWindow | null
        seven_day?: SoftwareEntitlementWindow | null
        thirty_day?: SoftwareEntitlementWindow | null
        total?: SoftwareEntitlementWindow | null
      }
    | null
    | undefined,
  options?: { includeThirtyDay?: boolean },
): BalanceWindowKey[] {
  const shown: BalanceWindowKey[] = []
  if (windowLimit(usage?.total) > 0) shown.push("total")
  if (windowLimit(usage?.five_hour) > 0) shown.push("five_hour")
  if (windowLimit(usage?.seven_day) > 0) shown.push("seven_day")
  if (options?.includeThirtyDay && windowLimit(usage?.thirty_day) > 0) shown.push("thirty_day")
  if (shown.length > 0) return shown
  return options?.includeThirtyDay ? ["five_hour", "seven_day", "thirty_day"] : ["five_hour", "seven_day"]
}

export function SettingsSection(props: { title: string; children: JSX.Element }) {
  return (
    <section class="grid gap-2">
      <h2 class="text-14-medium text-text-strong">{props.title}</h2>
      <div class="overflow-hidden rounded-[8px] border border-border-weak-base bg-background-base shadow-none">
        {props.children}
      </div>
    </section>
  )
}

export function SettingsRow(props: {
  title: string | JSX.Element
  description?: string | JSX.Element
  children?: JSX.Element
  align?: "start" | "center"
}) {
  return (
    <div
      class="flex min-h-[72px] flex-wrap items-center gap-3 border-b border-border-weaker-base px-3 py-3 last:border-b-0
        sm:flex-nowrap"
      classList={{
        "sm:items-start": props.align === "start",
      }}
    >
      <div class="min-w-0 flex-1">
        <div class="text-13-medium text-text-strong">{props.title}</div>
        <Show when={props.description}>
          <div class="mt-1 text-13-regular leading-normal text-text-weak">{props.description}</div>
        </Show>
      </div>
      <Show when={props.children}>
        <div class="flex w-full justify-start sm:w-auto sm:shrink-0 sm:justify-end">{props.children}</div>
      </Show>
    </div>
  )
}

export function QuotaProgress(props: { usedTokens: number; totalTokens: number; remainingTokens?: number }) {
  const language = useLanguage()
  const remainingTokens = () => Math.max(props.remainingTokens ?? props.totalTokens - props.usedTokens, 0)
  const percent = () =>
    props.totalTokens <= 0 ? 0 : Math.min(100, Math.round((props.usedTokens / props.totalTokens) * 100))

  return (
    <div class="w-full sm:w-[300px]">
      <div class="flex items-center justify-between gap-3 text-12-medium text-text-weak">
        <span>{language.t("users.quota.used", { value: formatNumber(props.usedTokens, language.intl()) })}</span>
        <span>{language.t("users.quota.remaining", { value: formatNumber(remainingTokens(), language.intl()) })}</span>
      </div>
      <div class="mt-2 h-1.5 overflow-hidden rounded-full bg-background-stronger">
        <div class="h-full rounded-full bg-surface-interactive-base" style={{ width: `${percent()}%` }} />
      </div>
      <div class="mt-2 flex items-center justify-between gap-3 text-12-regular text-text-weak">
        <span>{language.t("users.quota.total", { value: formatNumber(props.totalTokens, language.intl()) })}</span>
        <span>{percent()}%</span>
      </div>
    </div>
  )
}

export function TokenBreakdown(props: { input: number; output: number; cache: number }) {
  const language = useLanguage()

  return (
    <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-12-medium">
      <span class="text-text-strong">
        {language.t("users.token.input", { value: formatNumber(props.input, language.intl()) })}
      </span>
      <span class="text-text-strong">
        {language.t("users.token.output", { value: formatNumber(props.output, language.intl()) })}
      </span>
      <span class="text-text-interactive-base">
        {language.t("users.token.cache", { value: formatNumber(props.cache, language.intl()) })}
      </span>
    </div>
  )
}

export function InlineState(props: { icon?: "warning" | "circle-check"; title: string; description?: string }) {
  return (
    <SettingsRow
      title={
        <span class="flex items-center gap-2">
          <Show when={props.icon}>
            <Icon name={props.icon!} size="small" class="text-icon-weak" />
          </Show>
          {props.title}
        </span>
      }
      description={props.description}
    />
  )
}

// 模块级 entitlements 缓存，带过期时间和并发去重。
// 用户访问个人中心时写入，其他组件复用，避免页面切换时重复请求。
type EntitlementsResult = { items: SoftwareEntitlement[]; __error?: string; __errorObj?: unknown }

let _entitlementsCache: EntitlementsResult | null = null
let _cacheAt = 0
let _entitlementsGeneration = 0
let _inflight: { generation: number; token: symbol; promise: Promise<EntitlementsResult> } | null = null
const ENTITLEMENTS_CACHE_TTL = 30_000

export function getEntitlementsCache(): EntitlementsResult | null {
  if (_entitlementsCache && Date.now() - _cacheAt < ENTITLEMENTS_CACHE_TTL) return _entitlementsCache
  return null
}

export function setEntitlementsCache(v: EntitlementsResult) {
  _entitlementsCache = v
  _cacheAt = Date.now()
}

export function invalidateEntitlementsCache() {
  // 账号边界变化时推进代次，已发出的旧账号请求即使晚到也不能重新写入缓存。
  _entitlementsGeneration += 1
  _entitlementsCache = null
  _cacheAt = 0
  _inflight = null
}

export function fetchEntitlements(
  fetcher: () => Promise<{ items: SoftwareEntitlement[]; __error?: string; __errorObj?: unknown }>,
  options?: { force?: boolean },
): Promise<EntitlementsResult> {
  const cached = options?.force ? null : getEntitlementsCache()
  if (cached) return Promise.resolve(cached)
  if (_inflight?.generation === _entitlementsGeneration) return _inflight.promise
  const generation = _entitlementsGeneration
  const token = Symbol("entitlements-request")
  const promise = fetcher()
    .then((result) => {
      // 只有当前账号代次的成功响应可以成为共享额度缓存，旧响应仍返回给原调用方但不污染新账号。
      if (!result.__error && generation === _entitlementsGeneration) setEntitlementsCache(result)
      return result
    })
    .finally(() => {
      // 旧请求的 finally 只能清理自己，禁止清掉失效后已经启动的新账号请求。
      if (_inflight?.token === token) _inflight = null
    })
  _inflight = { generation, token, promise }
  return promise
}

// 需要渲染行为按钮的 action 集合，与 ErrorActionView 保持一致。
const INLINE_ACTION_BUTTON_SET = new Set<ErrorAction>(["relogin", "open_purchase", "show_quota", "backoff_retry", "show_blocked"])

export function InlineErrorState(props: {
  message: string | undefined
  onAction?: (action: ErrorAction) => void
}) {
  const language = useLanguage()
  // 用 resolveError 解析 message 字符串，获取语义分类 i18n 文案。
  // 对于认证过期(auth_expired)向后兼容地显示 users.auth.expired.* 专属文案。
  const resolved = () => resolveError(props.message)
  const expired = () => isWanlaiAuthExpiredMessage(props.message)
  const title = () => {
    if (expired()) return language.t("users.auth.expired.title")
    return language.t(resolved().messageKey as any)
  }
  const description = () => {
    if (expired()) return language.t("users.auth.expired.description")
    if (resolved().reason) return undefined
    // 如果 rawMessage 与 i18n 文案不同，作为补充描述
    const raw = resolved().rawMessage
    if (!raw || raw === title()) return undefined
    return raw
  }
  const showButton = () => !!props.onAction && INLINE_ACTION_BUTTON_SET.has(resolved().action)

  return (
    <SettingsRow
      title={
        <span class="flex items-center gap-2">
          <Icon name="warning" size="small" class="shrink-0 text-icon-weak" />
          <span class="flex flex-col gap-1">
            <span>{title()}</span>
            <Show when={description()}>
              <span class="text-13-regular text-text-weak">{description()}</span>
            </Show>
            <Show when={showButton()}>
              <span>
                <Button
                  variant="secondary"
                  class="mt-1 h-7 px-2 py-1 text-12-medium"
                  onClick={() => props.onAction?.(resolved().action)}
                >
                  {language.t(("errors.action." + resolved().action) as any)}
                </Button>
              </span>
            </Show>
          </span>
        </span>
      }
    />
  )
}

export function AuthStatusFallback(props: UserCenterStatusProps & {
  title: string
  usageRequiresOAuth?: boolean
  onErrorAction?: (action: ErrorAction) => void
}) {
  const language = useLanguage()
  const status = () => props.status()
  const unsupported = () => status()?.authenticated === true && status()?.auth_type !== "oauth" && status()?.auth_type !== "api"
  const apiKeyUsageOnly = () => props.usageRequiresOAuth && status()?.auth_type === "api"

  return (
    <SettingsSection title={props.title}>
      <Show when={!props.statusLoading() || status()} fallback={<InlineState title={language.t("users.auth.loading")} />}>
        <Show
          when={!props.statusError()}
          fallback={
            // 传入 onErrorAction 时展示行为按钮（由调用方提供路由/平台能力）；否则仅展示语义文案。
            <InlineErrorState message={sdkErrorMessage(props.statusError())} onAction={props.onErrorAction} />
          }
        >
          <Show
            when={!unsupported()}
            fallback={
              <InlineState
                icon="warning"
                title={language.t("users.auth.unsupported.title")}
                description={language.t("users.auth.unsupported.description")}
              />
            }
          >
            <InlineState
              icon="warning"
              title={language.t("users.auth.oauthRequired.title")}
              description={
                apiKeyUsageOnly()
                  ? language.t("users.auth.usageOauthRequired.description")
                  : language.t("users.auth.oauthRequired.description")
              }
            />
          </Show>
        </Show>
      </Show>
    </SettingsSection>
  )
}
