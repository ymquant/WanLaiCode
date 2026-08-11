import { useLocation, useNavigate, useParams } from "@solidjs/router"
import { Show, createMemo, createResource, type JSX } from "solid-js"
import { useLanguage } from "@/context/language"
import { useGlobalSDK } from "@/context/global-sdk"
import { fetchEntitlements, getEntitlementsCache, unwrapSDKSafe, useUserCenterEvents } from "@/pages/users/shared"
import type { SoftwareEntitlement } from "@/pages/users/types"

function isStarterEntitlement(item: SoftwareEntitlement) {
  return [item.entitlement_kind, item.product_name, item.plan_name]
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.toLowerCase())
    .some(
      (value) =>
        value.includes("trial") ||
        value.includes("starter") ||
        value.includes("free") ||
        value.includes("新手") ||
        value.includes("体验") ||
        value.includes("试用"),
    )
}

// Codex 主区左上角"获取 Plus"按钮：仅在无套餐或新手/试用套餐时展示。
export function GetPlusButton(props: { class?: string }): JSX.Element {
  const language = useLanguage()
  const globalSDK = useGlobalSDK()
  const navigate = useNavigate()
  const params = useParams()
  const location = useLocation()
  const loadEntitlements = (force = false) =>
    fetchEntitlements(() => unwrapSDKSafe(globalSDK.client.wanlaicodeUserCenter.entitlements(), { items: [] }), { force })
  const [entitlements, { refetch }] = createResource(
    () => true,
    () => fetchEntitlements(() => unwrapSDKSafe(globalSDK.client.wanlaicodeUserCenter.entitlements(), { items: [] })),
  )
  useUserCenterEvents(globalSDK, {
    resources: ["entitlements", "status"],
    onChange: () => loadEntitlements(true).then(() => refetch()),
  })
  const entitlementData = createMemo(() => entitlements.latest ?? getEntitlementsCache())
  const activeEntitlement = createMemo<SoftwareEntitlement | undefined>(() => {
    const items = (entitlementData()?.items ?? []) as SoftwareEntitlement[]
    return (
      items.find((item) => item.product_code === "wanlaicode" && (!item.status || item.status === "active")) ??
      items.find((item) => !item.status || item.status === "active")
    )
  })
  const visible = createMemo(() => {
    if (!entitlementData() || entitlementData()?.__error) return false
    const item = activeEntitlement()
    if (!item) return true
    return isStarterEntitlement(item)
  })

  const openPurchase = () => {
    const search = new URLSearchParams({
      tab: "purchase",
      from: `${location.pathname}${location.search}${location.hash}`,
    })
    navigate(`${params.dir ? `/${params.dir}` : ""}/users?${search.toString()}`)
  }

  return (
    <Show when={visible()}>
      <button
        type="button"
        onClick={openPurchase}
        class={[
          "shrink-0 inline-flex items-center gap-1.5 h-7 pl-2.5 pr-3 rounded-full",
          "text-[13px] font-medium leading-none tracking-[-0.005em]",
          "bg-[rgba(155,138,255,0.12)] hover:bg-[rgba(155,138,255,0.20)]",
          "text-[rgb(96,72,224)] dark:text-[rgb(186,168,255)]",
          "transition-colors duration-150",
          props.class ?? "",
        ].join(" ")}
        aria-label={language.t("session.upgrade.getPlus")}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true" class="shrink-0">
          <path
            d="M8 1.5L9.36 5.74C9.5 6.18 9.82 6.5 10.26 6.64L14.5 8L10.26 9.36C9.82 9.5 9.5 9.82 9.36 10.26L8 14.5L6.64 10.26C6.5 9.82 6.18 9.5 5.74 9.36L1.5 8L5.74 6.64C6.18 6.5 6.5 6.18 6.64 5.74L8 1.5Z"
            fill="currentColor"
          />
        </svg>
        <span>{language.t("session.upgrade.getPlus")}</span>
      </button>
    </Show>
  )
}
