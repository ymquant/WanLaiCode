import { resolveError } from "@opencode-ai/core/error/resolve"
import type { ErrorAction } from "@opencode-ai/core/error/error-actions"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Tag } from "@opencode-ai/ui/tag"
import { showToast } from "@opencode-ai/ui/toast"
import { useTheme } from "@opencode-ai/ui/theme/context"
import { createQuery } from "@tanstack/solid-query"
import { createMemo, createResource, createSignal, For, Match, Show, Switch } from "solid-js"
import { purchasePlansQuery } from "@/context/purchase-plans"
import { useGlobalSDK } from "@/context/global-sdk"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { ErrorActionView } from "@/components/error-action-view"
import {
  AuthStatusFallback,
  finiteNumber,
  formatNumber,
  InlineState,
  SettingsSection,
  unwrapSDK,
  unwrapSDKSafe,
  useUserCenterEvents,
} from "./shared"
import {
  canReadSoftware,
  selectActiveEntitlement,
  type PurchasePlansData,
  type PurchaseServicePlan,
  type SoftwareEntitlement,
  type UserCenterStatusProps,
} from "./types"
import {
  isCurrentPlanFor,
  isEntitlementEffectiveNow,
  isPlanDowngradeFor,
  isPlanUpgradeFor,
  isStorefrontPlan,
  isTokenPackPlan,
  planSupportsImageGeneration,
  planMatchesEntitlement,
} from "./purchase-plan-logic"

function AuthFallback(props: UserCenterStatusProps & { onErrorAction?: (action: ErrorAction) => void }) {
  const language = useLanguage()
  return <AuthStatusFallback {...props} title={language.t("users.tabs.purchase")} onErrorAction={props.onErrorAction} />
}

function formatCompactTokens(value: unknown, locale: string) {
  const tokens = finiteNumber(value)
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`
  return formatNumber(tokens, locale)
}

function formatPlanPrice(value: unknown, locale: string) {
  return `¥${formatNumber(finiteNumber(value), locale)}`
}

function planPeriodLabel(plan: PurchaseServicePlan, language: ReturnType<typeof useLanguage>) {
  // Token 包为一次性额度，不展示周期后缀（/月、/周 等）
  if (isTokenPackPlan(plan)) return ""
  const unit = String(plan.validityUnit || "").toLowerCase()
  if (unit === "month" || plan.validityDays === 30) return language.t("users.purchase.period.month")
  if (unit === "week" || plan.validityDays === 7) return language.t("users.purchase.period.week")
  return language.t("users.purchase.period.days", { value: finiteNumber(plan.validityDays) })
}

function planDescription(plan: PurchaseServicePlan, language: ReturnType<typeof useLanguage>) {
  return plan.description || plan.features?.[0] || plan.productName || language.t("users.purchase.descriptionFallback")
}

function planSubtitle(plan: PurchaseServicePlan, language: ReturnType<typeof useLanguage>) {
  const title = plan.name?.trim() || language.t("users.purchase.planFallback")
  const desc = planDescription(plan, language).trim()
  if (!desc || desc === title) return undefined
  return desc
}

function planQuotaCards(plan: PurchaseServicePlan, language: ReturnType<typeof useLanguage>) {
  return [
    { key: "5h", title: language.t("users.quota.period.fiveHours"), limit: plan.softwareTokenLimit5h },
    { key: "7d", title: language.t("users.quota.period.sevenDays"), limit: plan.softwareTokenLimit7d },
    { key: "30d", title: language.t("users.quota.period.thirtyDays"), limit: plan.softwareTokenLimit30d },
  ].filter((item) => finiteNumber(item.limit) > 0)
}

const purchasePlanQuotaRows = 3

function planQuotaRowSlots(plan: PurchaseServicePlan, language: ReturnType<typeof useLanguage>) {
  const rows = planQuotaCards(plan, language)
  return Array.from({ length: purchasePlanQuotaRows }, (_, index) => rows[index] ?? null)
}

function purchaseSourceContext() {
  if (typeof window === "undefined") return {}
  const origin = window.location.origin
  const href = window.location.href
  return origin.startsWith("http://") || origin.startsWith("https://")
    ? {
        src_host: origin,
        src_url: href,
      }
    : {}
}

function PurchasePaymentDialog(props: { title: string; url: string }) {
  return (
    <Dialog
      size="x-large"
      fit
      transition
      title={props.title}
      class="codex-dialog [&_[data-slot=dialog-body]]:min-h-0 [&_[data-slot=dialog-body]]:overflow-hidden"
    >
      <div class="flex min-h-0 flex-1 flex-col px-4 pb-4">
        <iframe
          src={props.url}
          class="block h-[72vh] min-h-[520px] w-full rounded-[12px] border border-border-weaker-base bg-background-base"
          allowfullscreen
        />
      </div>
    </Dialog>
  )
}

export function PurchasePlans(props: UserCenterStatusProps) {
  const language = useLanguage()
  const globalSDK = useGlobalSDK()
  const platform = usePlatform()
  const theme = useTheme()
  const dialog = useDialog()
  const [paymentBusy, setPaymentBusy] = createSignal(false)
  const productCode = () => props.status()?.product_code ?? "wanlaicode"

  // 用户中心内部错误行为路由
  function handleErrorAction(action: ErrorAction) {
    if (action === "relogin") {
      platform.openLoginWindow?.()
      return
    }
    if (action === "show_quota") {
      props.selectTab("quota")
      return
    }
    // open_purchase：已在购买 tab，重试加载套餐（旧逻辑打开裸 purchase_url 缺 token 会报“缺少认证信息”）
    if (action === "open_purchase") {
      void refetchPlans()
      return
    }
  }

  // 购买页与生图拒绝卡共享同一份 TanStack Query 数据；缓存命中时切换页面不会重复请求套餐。
  const plans = createQuery(() => ({
    ...purchasePlansQuery(globalSDK.client),
    enabled: canReadSoftware(props.status()),
  }))
  const refetchPlans = () => plans.refetch()
  const [entitlements, { refetch: refetchEntitlements }] = createResource(
    () => (canReadSoftware(props.status()) ? productCode() : undefined),
    () => unwrapSDKSafe(globalSDK.client.wanlaicodeUserCenter.entitlements(), { items: [] }),
  )
  useUserCenterEvents(globalSDK, {
    resources: ["purchase_plans", "entitlements", "status"],
    onChange: (resources) => {
      if (!canReadSoftware(props.status())) return
      if (resources.includes("purchase_plans") || resources.includes("status")) void refetchPlans()
      if (resources.includes("entitlements") || resources.includes("status")) void refetchEntitlements()
    },
  })
  const plansData = createMemo(() => plans.data as PurchasePlansData | undefined)
  const currentEntitlement = createMemo<SoftwareEntitlement | undefined>(() =>
    selectActiveEntitlement(entitlements.latest?.items ?? [], productCode()),
  )
  const storefrontPlans = createMemo(() =>
    ((plansData()?.plans ?? []) as PurchaseServicePlan[]).filter(isStorefrontPlan),
  )
  // 当前权益是否已确定：成功返回才算（items 可能为空=新用户）。加载中(latest 未定)或
  // 拉取失败(unwrapSDKSafe 回退带 __error)时为 false。未确定时不放行购买，避免
  // plans 比 entitlements 先返回的 UI 竞态、以及权益接口失败时绕过「仅允许升级」。
  const entitlementsErrored = createMemo(() => !entitlements.loading && !!entitlements.latest?.__error)
  const entitlementsReady = createMemo(
    () => !entitlements.loading && entitlements.latest !== undefined && !entitlements.latest.__error,
  )

  async function openPurchase(plan: PurchaseServicePlan) {
    if (paymentBusy()) return
    // 事件路径再拦截（防 UI 竞态/失败绕过）：当前权益未确定或该套餐相对当前套餐为降级时，不打开购买页。
    if (entitlements.loading || entitlements.latest === undefined) {
      showToast({ title: language.t("users.purchase.entitlementsLoading") })
      return
    }
    if (entitlements.latest.__error) {
      showToast({ title: language.t("users.purchase.entitlementsError") })
      return
    }
    if (isPlanDowngradeFor(plan, currentEntitlement())) return
    if (props.status()?.auth_type !== "oauth") {
      showToast({ title: language.t("users.purchase.oauthRequired") })
      platform.openLink(plansData()?.purchase_url || props.status()?.purchase_url || "")
      return
    }

    setPaymentBusy(true)
    await globalSDK.client.wanlaicodeUserCenter.purchase
      .page({
        plan_id: plan.id,
        software_product: plan.softwareProductCodes?.[0] || productCode(),
        theme: theme.mode() === "dark" ? "dark" : "light",
        lang: language.intl(),
        ...purchaseSourceContext(),
      })
      .then(unwrapSDK)
      .then((result) => {
        if (!result.enabled || !result.url) {
          showToast({ title: language.t("users.purchase.unavailable.title") })
          return
        }
        const title = `${language.t("users.purchase.paymentTitle")} · ${plan.name || language.t("users.purchase.planFallback")}`
        dialog.show(() => <PurchasePaymentDialog title={title} url={result.url} />)
      })
      .catch((err: unknown) => {
        const r = resolveError(err)
        showToast({ title: language.t(r.messageKey as any), description: r.reason ? undefined : r.rawMessage })
      })
      .finally(() => setPaymentBusy(false))
  }

  return (
    <section class="grid gap-7">
      <Show when={canReadSoftware(props.status())} fallback={<AuthFallback {...props} onErrorAction={handleErrorAction} />}>
        <SettingsSection title={language.t("users.purchase.availablePlans")}>
          <Switch>
            <Match when={plans.isLoading && !plansData()}>
              <InlineState title={language.t("users.auth.loading")} />
            </Match>
            <Match when={plans.error && !plansData()}>
              {/* plans.error 是原始错误对象，使用 ErrorActionView 提供语义文案和行为按钮 */}
              <ErrorActionView error={plans.error} onAction={handleErrorAction} />
            </Match>
            <Match when={plansData()?.enabled === false}>
              <InlineState
                icon="warning"
                title={language.t("users.purchase.unavailable.title")}
                description={language.t("users.purchase.unavailable.description")}
              />
            </Match>
            <Match when={storefrontPlans().length === 0}>
              <InlineState
                title={language.t("users.purchase.empty.title")}
                description={language.t("users.purchase.empty.description")}
              />
            </Match>
            <Match when={storefrontPlans().length > 0}>
              <div class="purchase-plans-grid grid grid-cols-1 gap-3 p-4 sm:grid-cols-2">
                <For each={storefrontPlans()}>
                  {(plan) => {
                    const current = () => isCurrentPlanFor(plan, currentEntitlement())
                    // 仅允许升级：相对当前付费有效套餐属降级的，置灰并提示
                    const downgrade = () => !current() && isPlanDowngradeFor(plan, currentEntitlement())
                    const upgrade = () =>
                      !current() &&
                      !downgrade() &&
                      !isTokenPackPlan(plan) &&
                      isPlanUpgradeFor(plan, currentEntitlement())
                    const cardDisabled = () => paymentBusy() || !entitlementsReady()
                    const subtitle = () => planSubtitle(plan, language)
                    const actionLabel = () => {
                      if (current()) return language.t("users.purchase.currentPlanAction")
                      if (downgrade()) return language.t("users.purchase.downgradeBadge")
                      const entitlement = currentEntitlement()
                      if (!isTokenPackPlan(plan) && entitlement) {
                        if (isEntitlementEffectiveNow(entitlement) && isPlanUpgradeFor(plan, entitlement)) {
                          return language.t("users.purchase.upgradePlanAction")
                        }
                        if (planMatchesEntitlement(plan, entitlement)) {
                          return language.t("users.purchase.currentPlanAction")
                        }
                      }
                      return language.t("users.purchase.selectPlan")
                    }
                    const ctaVariant = () => {
                      if (current()) return "current"
                      if (downgrade()) return "muted"
                      return upgrade() ? "primary" : "secondary"
                    }
                    return (
                      <button
                        type="button"
                        class="purchase-plan-card relative flex h-full min-h-[248px] w-full flex-col rounded-[12px] border border-border-weaker-base bg-background-base p-5 pt-6 text-left focus:outline-none enabled:cursor-pointer disabled:cursor-not-allowed"
                        classList={{
                          "purchase-plan-card--current": current(),
                          "purchase-plan-card--upgrade": upgrade(),
                          "purchase-plan-card--downgrade": downgrade(),
                        }}
                        disabled={cardDisabled()}
                        aria-busy={paymentBusy() || undefined}
                        aria-current={current() ? "true" : undefined}
                        onClick={() => void openPurchase(plan)}
                      >
                        <Show when={current()}>
                          <span class="purchase-plan-card__badge absolute -top-2.5 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full px-2.5 py-0.5 text-11-medium">
                            {language.t("users.quota.currentPlan")}
                          </span>
                        </Show>

                        <div class="purchase-plan-card__header">
                          <div class="flex min-w-0 flex-wrap items-center justify-between gap-2">
                            <div class="min-w-0 break-words text-13-regular text-text-weak">
                              {plan.name || language.t("users.purchase.planFallback")}
                            </div>
                            {/* 仅标注 WanlaiCode 产品族的真实软件套餐，避免 token 包和其它产品被脏字段误标为支持生图。 */}
                            <Show when={planSupportsImageGeneration(plan)}>
                              <Tag
                                class="shrink-0"
                                classList={{
                                  "!rounded-full": true,
                                  "!border-border-success-base": true,
                                  "!bg-surface-diff-add-base": true,
                                  "gap-1.5": true,
                                }}
                              >
                                <span class="size-1.5 shrink-0 rounded-full bg-icon-success-base" aria-hidden="true" />
                                <span class="text-text-strong">
                                  {language.t("users.quota.imageGenerationSupported")}
                                </span>
                              </Tag>
                            </Show>
                          </div>
                          <div class="mt-1.5 flex flex-wrap items-baseline gap-1">
                            <span class="purchase-plan-card__price text-20-medium tabular-nums text-text-strong">
                              {formatPlanPrice(plan.price, language.intl())}
                            </span>
                            <span class="text-12-regular text-text-weak">{planPeriodLabel(plan, language)}</span>
                          </div>
                          <Show when={subtitle()}>
                            {(text) => (
                              <p class="purchase-plan-card__subtitle mt-1.5 line-clamp-2 text-12-regular leading-normal text-text-weak">
                                {text()}
                              </p>
                            )}
                          </Show>
                        </div>

                        <div class="purchase-plan-card__quota mt-4 grid gap-0">
                          <Show
                            when={isTokenPackPlan(plan)}
                            fallback={
                              <For each={planQuotaRowSlots(plan, language)}>
                                {(quota) => (
                                  <Show
                                    when={quota}
                                    fallback={
                                      <div
                                        class="purchase-plan-card__quota-row purchase-plan-card__quota-row--placeholder flex items-center justify-between gap-2 py-1.5 text-12-regular"
                                        aria-hidden="true"
                                      />
                                    }
                                  >
                                    {(item) => (
                                      <div class="purchase-plan-card__quota-row flex items-center justify-between gap-2 py-1.5 text-12-regular">
                                        <span class="text-text-weak">{item().title}</span>
                                        <span class="text-12-medium tabular-nums text-text-strong">
                                          {formatCompactTokens(item().limit, language.intl())}
                                        </span>
                                      </div>
                                    )}
                                  </Show>
                                )}
                              </For>
                            }
                          >
                            <div class="purchase-plan-card__quota-row flex items-center justify-between gap-2 py-1.5 text-12-regular">
                              <span class="text-text-weak">{language.t("users.tokenPack.quota")}</span>
                              <span class="text-12-medium tabular-nums text-text-strong">
                                {formatCompactTokens(plan.tokenPackQuota, language.intl())}
                              </span>
                            </div>
                            <div class="purchase-plan-card__quota-row flex items-center justify-between gap-2 py-1.5 text-12-regular">
                              <span class="text-text-weak">{language.t("users.tokenPack.validity")}</span>
                              <span class="text-12-medium tabular-nums text-text-strong">
                                {language.t("users.tokenPack.validityDays", { value: finiteNumber(plan.tokenPackValidityDays) })}
                              </span>
                            </div>
                            <div class="purchase-plan-card__quota-row flex items-center justify-between gap-2 py-1.5 text-12-regular">
                              <span class="text-text-weak">{language.t("users.tokenPack.semantic")}</span>
                              <span class="rounded-full bg-surface-base-active px-2 py-0.5 text-11-medium text-text-weak">
                                {language.t("users.tokenPack.prepaid")}
                              </span>
                            </div>
                          </Show>
                        </div>

                        <div class="mt-auto pt-4">
                          <div
                            role="presentation"
                            data-variant={ctaVariant()}
                            class="purchase-plan-card__cta pointer-events-none"
                          >
                            {actionLabel()}
                          </div>
                          <Show when={!downgrade() && !entitlementsReady()}>
                            <p role="status" class="mt-2 text-center text-11-regular leading-normal text-text-weak">
                              {entitlementsErrored()
                                ? language.t("users.purchase.entitlementsError")
                                : language.t("users.purchase.entitlementsLoading")}
                            </p>
                          </Show>
                        </div>
                      </button>
                    )
                  }}
                </For>
              </div>
            </Match>
          </Switch>
        </SettingsSection>
      </Show>
    </section>
  )
}
