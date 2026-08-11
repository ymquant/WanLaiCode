import type { ErrorAction } from "@opencode-ai/core/error/error-actions"
import { Button } from "@opencode-ai/ui/button"
import { Switch } from "@opencode-ai/ui/switch"
import { Tag } from "@opencode-ai/ui/tag"
import { showToast } from "@opencode-ai/ui/toast"
import { createMemo, createResource, createSignal, For, Show } from "solid-js"
import { useGlobalSDK } from "@/context/global-sdk"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { ErrorActionView } from "@/components/error-action-view"
import { formatServerError } from "@/utils/server-errors"
import {
  AuthStatusFallback,
  type BalanceWindowKey,
  formatDateTime,
  InlineState,
  QuotaProgress,
  selectBalanceWindows,
  SettingsRow,
  SettingsSection,
  unwrapSDKSafe,
  useUserCenterEvents,
  windowLimit,
  windowRemaining,
  windowUsed,
} from "./shared"
import {
  canReadSoftware,
  entitlementSupportsImageGeneration,
  selectActiveEntitlement,
  type SoftwareEntitlement,
  type UserCenterStatusProps,
} from "./types"

function AuthFallback(props: UserCenterStatusProps & { onErrorAction?: (action: ErrorAction) => void }) {
  const language = useLanguage()
  return <AuthStatusFallback {...props} title={language.t("users.quota.currentPlan")} onErrorAction={props.onErrorAction} />
}

export function Quota(props: UserCenterStatusProps) {
  const language = useLanguage()
  const globalSDK = useGlobalSDK()
  const platform = usePlatform()
  const productCode = () => props.status()?.product_code ?? "wanlaicode"

  // 用户中心内部错误行为路由
  function handleErrorAction(action: ErrorAction) {
    if (action === "relogin") {
      platform.openLoginWindow?.()
      return
    }
    if (action === "open_purchase") {
      props.selectTab("purchase")
      return
    }
    // show_quota：已在额度 tab，重试加载权益让额度信息恢复（旧逻辑打开裸 purchase_url 缺 token 会报“缺少认证信息”）
    if (action === "show_quota") {
      void refetchEntitlements()
      return
    }
  }
  const [entitlements, { refetch: refetchEntitlements }] = createResource(
    () => (canReadSoftware(props.status()) ? productCode() : undefined),
    () => unwrapSDKSafe(globalSDK.client.wanlaicodeUserCenter.entitlements(), { items: [] }),
  )
  useUserCenterEvents(globalSDK, {
    resources: ["entitlements", "status"],
    onChange: () => {
      if (canReadSoftware(props.status())) void refetchEntitlements()
    },
  })
  const entitlementData = createMemo(() => entitlements.latest)
  const entitlement = createMemo<SoftwareEntitlement | undefined>(() =>
    selectActiveEntitlement(entitlementData()?.items ?? [], productCode()),
  )
  const windowLabel = (key: BalanceWindowKey) => {
    switch (key) {
      case "total":
        return language.t("users.quota.period.total")
      case "five_hour":
        return language.t("users.quota.period.fiveHours")
      case "seven_day":
        return language.t("users.quota.period.sevenDays")
      case "thirty_day":
        return language.t("users.quota.period.thirtyDays")
    }
  }
  const periods = createMemo(() => {
    const usage = entitlement()?.usage
    return selectBalanceWindows(usage, { includeThirtyDay: true }).map((key) => ({
      label: windowLabel(key),
      window: usage?.[key],
    }))
  })

  // 账户余额按量付费开关：仅 OAuth 登录可读写（后端约定 API Key 登录恒为关闭）。
  const canToggleBalanceBilling = () => props.status()?.auth_type === "oauth"
  const [balanceBilling] = createResource(
    () => (canToggleBalanceBilling() ? "oauth" : undefined),
    () => unwrapSDKSafe(globalSDK.client.wanlaicodeUserCenter.balanceBilling.get(), { enabled: false }),
  )
  // 本地乐观值：undefined 表示用后端值；切换失败时回滚为 undefined。
  const [balanceOverride, setBalanceOverride] = createSignal<boolean | undefined>(undefined)
  const [balanceSaving, setBalanceSaving] = createSignal(false)
  const balanceEnabled = createMemo(() => balanceOverride() ?? balanceBilling.latest?.enabled ?? false)

  const toggleBalanceBilling = async (next: boolean) => {
    if (balanceSaving()) return
    setBalanceSaving(true)
    setBalanceOverride(next)
    const result = await globalSDK.client.wanlaicodeUserCenter.balanceBilling
      .update({ enabled: next })
      .then((value) => (value.error ? { ok: false as const, error: value.error } : { ok: true as const }))
      .catch((error) => ({ ok: false as const, error }))
    setBalanceSaving(false)
    if (!result.ok) {
      setBalanceOverride(undefined)
      showToast({
        variant: "error",
        title: language.t("users.balanceBilling.toast.updateFailed"),
        description: formatServerError(result.error, language.t),
      })
      return
    }
    showToast({
      variant: "success",
      icon: "circle-check",
      title: language.t(next ? "users.balanceBilling.toast.enabled" : "users.balanceBilling.toast.disabled"),
    })
  }

  return (
    <section class="grid gap-7">
      <Show
        when={canReadSoftware(props.status())}
        fallback={<AuthFallback {...props} onErrorAction={handleErrorAction} />}
      >
        <SettingsSection title={language.t("users.quota.currentPlan")}>
          {/* 权益加载失败：ErrorActionView 提供语义文案和行为按钮 */}
          {/* 传 __errorObj（含 reason 字段的原始 Error）供 resolveError 做语义分类，__error 字符串作兜底 */}
          <Show when={entitlementData()?.__error}>
            {(error) => <ErrorActionView error={entitlementData()?.__errorObj ?? error()} onAction={handleErrorAction} />}
          </Show>
          <Show
            when={entitlement()}
            fallback={
              <InlineState
                title={language.t("users.quota.noPlan.title")}
                description={language.t("users.quota.noPlan.description")}
              />
            }
          >
            {(item) => (
              <SettingsRow
                title={
                  <span class="flex flex-wrap items-center gap-2">
                    <span>{item().product_name || language.t("users.keys.productNameFallback")}</span>
                    {/* 套餐能力以权益接口原字段为准，仅明确开启时展示，避免前端从套餐名称猜测。 */}
                    <Show when={entitlementSupportsImageGeneration(item())}>
                      <Tag
                        size="large"
                        classList={{
                          "!rounded-full": true,
                          "!border-border-success-base": true,
                          "!bg-surface-diff-add-base": true,
                          "gap-1.5": true,
                        }}
                      >
                        <span class="size-1.5 shrink-0 rounded-full bg-icon-success-base" aria-hidden="true" />
                        {/* 文字单独使用页面高对比前景色，避免主题成功色在浅色背景上过淡。 */}
                        <span class="text-text-strong">{language.t("users.quota.imageGenerationSupported")}</span>
                      </Tag>
                    </Show>
                  </span>
                }
                description={language.t("users.quota.planDescription", {
                  plan: item().plan_name || language.t("users.keys.planNameFallback"),
                  expiresAt: formatDateTime(item().expires_at, language.intl()),
                })}
              >
                <Button
                  type="button"
                  size="small"
                  variant="ghost"
                  icon="square-arrow-top-right"
                  onClick={() => props.selectTab("purchase")}
                >
                  {language.t("users.actions.upgrade")}
                </Button>
              </SettingsRow>
            )}
          </Show>
        </SettingsSection>

        <Show when={canToggleBalanceBilling()}>
          <SettingsSection title={language.t("users.balanceBilling.section")}>
            <SettingsRow
              title={language.t("users.balanceBilling.title")}
              description={language.t("users.balanceBilling.description")}
            >
              <Switch
                class="switch-pill"
                checked={balanceEnabled()}
                disabled={balanceBilling.loading || balanceSaving()}
                onChange={(checked) => void toggleBalanceBilling(checked)}
              />
            </SettingsRow>
          </SettingsSection>
        </Show>

        <SettingsSection title={language.t("users.quota.periodSection")}>
          <For each={periods()}>
            {(period) => (
              <SettingsRow
                title={period.label}
                description={language.t("users.quota.refreshDescription", {
                  time: formatDateTime(period.window?.next_refill_at, language.intl()),
                })}
              >
                <QuotaProgress
                  usedTokens={windowUsed(period.window)}
                  remainingTokens={windowRemaining(period.window)}
                  totalTokens={windowLimit(period.window)}
                />
              </SettingsRow>
            )}
          </For>
        </SettingsSection>
      </Show>
    </section>
  )
}
