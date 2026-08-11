import { For, type JSX, type JSXElement, Show, createMemo, createResource, createSignal } from "solid-js"
import { Popover } from "@opencode-ai/ui/popover"
import { Icon } from "@opencode-ai/ui/icon"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { showToast } from "@opencode-ai/ui/toast"
import { useLanguage } from "@/context/language"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { useProviders } from "@/hooks/use-providers"
import { usePlatform } from "@/context/platform"
import {
  type BalanceWindowKey,
  fetchEntitlements,
  getEntitlementsCache,
  invalidateEntitlementsCache,
  selectBalanceWindows,
  unwrapSDK,
  unwrapSDKSafe,
  useUserCenterEvents,
  windowLimit,
  windowRemaining,
} from "@/pages/users/shared"
import {
  selectActiveEntitlement,
  type SoftwareEntitlementWindow,
  type TabID,
  type UserCenterStatus,
} from "@/pages/users/types"
import { openUserCenterOverlay } from "@/context/open-user-center"
import { recordIssueAction, stableHash } from "@/utils/issue-report-snapshot"
import { DialogConfirm } from "@/components/dialog-confirm"
import { createStore } from "solid-js/store"
import { accountPopoverState, authenticatedAccountStatus, isLatestAccountStatusRequest } from "./account-status"

// 退出登录确认弹窗（Codex 样式：标题 + 副标题 + 取消 / 红色退出按钮）
const SignOutConfirmDialog = (props: { onConfirm: () => Promise<void> }): JSX.Element => {
  const language = useLanguage()
  return (
    <DialogConfirm
      title={language.t("sidebar.account.signOut.confirm.title")}
      description={language.t("sidebar.account.signOut.confirm.description")}
      confirmLabel={language.t("sidebar.account.signOut")}
      onConfirm={props.onConfirm}
    />
  )
}

export const AccountPopover = (props: {
  trigger: JSXElement
  onOpenSettings: () => void
  onOpenChange?: (open: boolean) => void
}): JSX.Element => {
  const language = useLanguage()
  const globalSDK = useGlobalSDK()
  const globalSync = useGlobalSync()
  const providers = useProviders()
  const dialog = useDialog()
  const platform = usePlatform()
  const [balanceOpen, setBalanceOpen] = createSignal(false)
  const [popoverOpen, setPopoverOpen] = createSignal(false)
  const [authBoundary, setAuthBoundary] = createStore({ expired: false })
  let statusRequestGeneration = 0

  const runAndClose = (fn: () => void) => () => {
    setPopoverOpen(false)
    fn()
  }

  const removableProviders = createMemo(() => {
    return providers
      .connected()
      .filter((p) => p.source !== "env")
      .map((p) => p.id)
  })
  const authIssueData = (status: UserCenterStatus | null | undefined = userCenterStatus.latest) => ({
    status_authenticated: status?.authenticated,
    auth_type: status?.auth_type,
    account_id_hash: status?.account_id ? stableHash(status.account_id) : undefined,
    account_hash: status?.account_email ? stableHash(status.account_email) : undefined,
    site_hash: status?.site_url ? stableHash(status.site_url) : undefined,
    api_hash: status?.api_base ? stableHash(status.api_base) : undefined,
  })

  const performSignOut = async () => {
    invalidateEntitlementsCache()
    const ids = removableProviders()
    let removedCount = 0
    recordIssueAction("auth.signOut.start", {
      provider_count: ids.length,
      providers: ids,
      ...authIssueData(),
    })

    await Promise.all(
      ids.map(async (providerID) => {
        try {
          await globalSDK.client.auth.remove({ providerID })
          removedCount += 1
        } catch {
          // 单个失败不阻断
        }
      }),
    )

    // dispose 改为 fire-and-forget，不再阻塞 openLoginWindow 调用。
    // 作为兜底，后端 disposeInstance 的每个 disposer 已加 15s 超时
    // （详见 packages/opencode/src/effect/instance-registry.ts），
    // 即使 dispose 未完成，窗口切换销毁渲染上下文后不影响后续流程。
    globalSDK.client.global.dispose().catch(() => {})

    globalSync.set("provider_auth", {})

    try {
      await platform.openLoginWindow?.()
    } catch {
      // 忽略
    }
    recordIssueAction("auth.signOut.finish", {
      provider_count: ids.length,
      removed_count: removedCount,
      ...authIssueData(),
    })

    if (removedCount > 0) {
      showToast({
        variant: "success",
        icon: "circle-check",
        title: language.t("sidebar.account.signOut.toast.title"),
        description: language.t("sidebar.account.signOut.toast.description"),
      })
    } else {
      showToast({
        title: language.t("sidebar.account.signOut.toast.empty"),
      })
    }
  }

  const requestSignOut = () => {
    dialog.show(() => <SignOutConfirmDialog onConfirm={performSignOut} />)
  }

  const [userCenterStatus, { refetch: refetchStatus }] = createResource(
    () => true,
    () => globalSDK.client.wanlaicodeUserCenter.status().then(unwrapSDK),
  )
  const [balanceEntitlements, { refetch: refetchBalance }] = createResource(
    () => true,
    () => fetchEntitlements(() => unwrapSDKSafe(globalSDK.client.wanlaicodeUserCenter.entitlements(), { items: [] })),
  )
  const loadEntitlements = (force = false) =>
    fetchEntitlements(() => unwrapSDKSafe(globalSDK.client.wanlaicodeUserCenter.entitlements(), { items: [] }), {
      force,
    })
  const refreshAccountStatus = () => {
    const requestGeneration = ++statusRequestGeneration
    return Promise.resolve(refetchStatus()).then((status: UserCenterStatus | null | undefined) => {
      // 旧账号请求即使晚到也不能清除新登录建立的认证边界。
      if (isLatestAccountStatusRequest(requestGeneration, statusRequestGeneration) && status) {
        setAuthBoundary("expired", status.oauth_reauth_required === true)
      }
      return status
    })
  }
  useUserCenterEvents(globalSDK, {
    resources: ["status", "entitlements", "api_key", "models", "providers"],
    onChange: (resources) => {
      if (resources.includes("status") || resources.includes("models") || resources.includes("providers")) {
        // 账号切换通常伴随 status/providers 事件，旧账号的额度缓存不能跨越这条认证边界。
        if (resources.includes("status") || resources.includes("providers")) invalidateEntitlementsCache()
        void refreshAccountStatus()
      }
      if (resources.includes("entitlements") || resources.includes("api_key") || resources.includes("status")) {
        void loadEntitlements(true).then(() => refetchBalance())
      }
    },
    onAuthExpired: () => {
      // 事件先于 refetch 完成，立即隐藏 createResource.latest 中仍缓存的旧姓名和套餐。
      setAuthBoundary("expired", true)
      invalidateEntitlementsCache()
      void refreshAccountStatus()
    },
  })
  const balanceEntitlementData = createMemo(() => balanceEntitlements.latest ?? getEntitlementsCache())
  const balanceEntitlement = createMemo(() =>
    selectActiveEntitlement(balanceEntitlementData()?.items ?? [], "wanlaicode"),
  )
  const accountStatus = () => authenticatedAccountStatus(userCenterStatus.latest)
  const accountState = () =>
    accountPopoverState(
      userCenterStatus.latest,
      userCenterStatus.loading,
      userCenterStatus.error !== undefined,
      authBoundary.expired,
    )
  const unavailableTitle = () => {
    if (accountState() === "loading") return language.t("users.auth.loading")
    if (accountState() === "error") return language.t("common.requestFailed")
    if (accountState() === "reauth_required") return language.t("users.auth.expired.title")
    return language.t("users.auth.oauthRequired.title")
  }
  const loginAction = () =>
    accountState() === "reauth_required" ? language.t("errors.action.relogin") : language.t("login.wanlaicode.continue")
  const accountEmail = () => accountStatus()?.account_email
  const accountName = () =>
    accountStatus()?.account_name ?? accountEmail()?.split("@")[0] ?? language.t("sidebar.account.unknownUser")
  const accountInitial = () => accountName().charAt(0).toUpperCase()
  const planName = () => balanceEntitlement()?.plan_name ?? balanceEntitlement()?.product_name
  const planTab = () => (balanceEntitlements.loading || planName() ? "quota" : "purchase")
  const planLabel = () => {
    if (balanceEntitlements.loading) return language.t("common.loading")
    const name = planName()
    if (name) return language.t("sidebar.account.currentPlan", { plan: name })
    return language.t("sidebar.account.openPlus")
  }
  const quotaPercent = (window: SoftwareEntitlementWindow | null | undefined) => {
    if (balanceEntitlements.loading) return "--"
    const limit = windowLimit(window)
    if (limit <= 0) return "--"
    return `${Math.min(100, Math.round((windowRemaining(window) / limit) * 100))}%`
  }
  const quotaRefillTime = (window: SoftwareEntitlementWindow | null | undefined) => {
    if (balanceEntitlements.loading) return "--"
    if (!window?.next_refill_at) return "--"
    const date = new Date(window.next_refill_at)
    if (Number.isNaN(date.getTime())) return window.next_refill_at
    return new Intl.DateTimeFormat(language.intl(), {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(date)
  }
  const balanceWindowLabel = (key: BalanceWindowKey) => {
    if (key === "total") return language.t("sidebar.account.balance.total")
    if (key === "five_hour") return language.t("sidebar.account.balance.fiveHours")
    return language.t("sidebar.account.balance.sevenDays")
  }

  const itemClass =
    "account-popover-item w-full flex items-center gap-3 h-10 px-2 rounded-lg text-[15px] font-medium text-left text-text-base hover:bg-[rgba(255,255,255,0.46)] dark:hover:bg-[rgba(255,255,255,0.08)]"
  const subItemClass =
    "account-popover-subitem w-full flex items-center gap-2 h-8 pl-10 pr-3 rounded-lg text-[14px] font-medium text-left text-text-base hover:bg-[rgba(255,255,255,0.42)] dark:hover:bg-[rgba(255,255,255,0.08)]"

  return (
    <Popover
      placement="top-start"
      open={popoverOpen()}
      onOpenChange={(open) => {
        setPopoverOpen(open)
        props.onOpenChange?.(open)
        // 打开时刷新账号/额度，避免长会话或登出后仍显示启动那一刻的陈旧快照
        if (open) {
          recordIssueAction("auth.accountPopover.open", authIssueData())
          void refreshAccountStatus().then((status) =>
            recordIssueAction("auth.accountStatus.refetched", authIssueData(status)),
          )
          // 即使漏掉账号事件，打开菜单也强制越过旧缓存读取当前账号额度。
          void loadEntitlements(true).then(() => refetchBalance())
        }
      }}
      trigger={props.trigger}
      class="account-popover w-[252px] max-w-[calc(100vw-24px)] [&_[data-slot=popover-body]]:p-2"
    >
      <Show
        when={accountState() === "authenticated"}
        fallback={
          <>
            {/* 非认证状态统一隐藏缓存姓名，但分别保留加载、错误、未登录与重新认证的真实文案。 */}
            <div class="account-popover-account-row flex items-center gap-3 rounded-xl px-2 py-2">
              <Icon name="user" size="small" />
              <span class="text-14-medium text-text-base">{unavailableTitle()}</span>
            </div>
            <Show when={accountState() === "signed_out" || accountState() === "reauth_required"}>
              <button type="button" class={itemClass} onClick={runAndClose(() => void platform.openLoginWindow?.())}>
                <Icon name="enter" size="small" />
                {loginAction()}
              </button>
            </Show>
            <button type="button" class={itemClass} onClick={runAndClose(props.onOpenSettings)}>
              <Icon name="settings-gear" size="small" />
              {language.t("sidebar.footer.settings")}
            </button>
          </>
        }
      >
        <div class="account-popover-account-row flex items-center gap-3 rounded-xl">
          <div class="account-popover-avatar size-8 shrink-0 rounded-full flex items-center justify-center text-[14px] font-medium text-text-weak">
            {accountInitial()}
          </div>
          <div class="min-w-0 flex-1">
            <div class="truncate text-[14px] font-medium text-text-base">{accountName()}</div>
            <div class="truncate text-[14px] text-text-weak">
              {accountEmail() ?? language.t("sidebar.account.emailUnknown")}
            </div>
          </div>
        </div>

        <button type="button" class={itemClass} onClick={runAndClose(() => openUserCenterOverlay(planTab()))}>
          <Icon name={planName() ? "models" : "plus"} size="small" />
          <span class="flex-1 truncate">{planLabel()}</span>
          <Icon name="chevron-right" size="small" class="text-icon-base" />
        </button>

        <div class=" border-t border-border-weaker-base" />

        <button type="button" class={itemClass} onClick={runAndClose(() => openUserCenterOverlay())}>
          <Icon name="user" size="small" />
          {language.t("sidebar.account.userCenter")}
        </button>

        <button type="button" class={itemClass} onClick={runAndClose(props.onOpenSettings)}>
          <Icon name="settings-gear" size="small" />
          {language.t("sidebar.footer.settings")}
        </button>

        <button type="button" class={itemClass} onClick={() => setBalanceOpen((v) => !v)}>
          <Icon name="status" size="small" />
          <span class="flex-1">{language.t("sidebar.account.balance")}</span>
          <Icon name={balanceOpen() ? "chevron-down" : "chevron-right"} size="small" class="text-icon-base" />
        </button>

        <Show when={balanceOpen()}>
          <div class="grid gap-1 py-1">
            <For each={selectBalanceWindows(balanceEntitlement()?.usage)}>
              {(key) => (
                <div class="flex items-center gap-2 h-8 pl-9 pr-3 text-13-regular">
                  <span class="flex-1 text-text-base">{balanceWindowLabel(key)}</span>
                  <span class="text-text-weak">{quotaPercent(balanceEntitlement()?.usage?.[key])}</span>
                  <span class="text-text-weak">{quotaRefillTime(balanceEntitlement()?.usage?.[key])}</span>
                </div>
              )}
            </For>
          </div>

          <button type="button" class={subItemClass} onClick={runAndClose(() => openUserCenterOverlay("quota"))}>
            <span class="flex-1">{language.t("sidebar.account.balance.learnMore")}</span>
            <Icon name="chevron-right" size="small" class="text-icon-base" />
          </button>
        </Show>

        <button type="button" class={itemClass} onClick={runAndClose(requestSignOut)}>
          <Icon name="enter" size="small" class="rotate-180" />
          {language.t("sidebar.account.signOut")}
        </button>
      </Show>
    </Popover>
  )
}
