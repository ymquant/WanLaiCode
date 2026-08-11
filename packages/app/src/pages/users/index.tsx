import { Icon } from "@opencode-ai/ui/icon"
import { ResizeHandle } from "@opencode-ai/ui/resize-handle"
import { useNavigate, useParams, useSearchParams } from "@solidjs/router"
import { createEffect, createMemo, createResource, For, Match, Suspense, Switch } from "solid-js"
import { createStore } from "solid-js/store"
import { useGlobalSDK } from "@/context/global-sdk"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useProviders } from "@/hooks/use-providers"
import { ApiKeys } from "./ApiKeys"
import { PurchasePlans } from "./PurchasePlans"
import { Quota } from "./Quota"
import { TokenPackBalance } from "./TokenPackBalance"
import { InlineState, unwrapSDK, useUserCenterEvents } from "./shared"
import { UsageRecords } from "./UsageRecords"
import { canReadTokenPacks, tabs, type TabID } from "./types"

function UsersContent(props: { initialTab?: TabID; onClose?: () => void }) {
  const language = useLanguage()
  const globalSDK = useGlobalSDK()
  const providers = useProviders()
  const navigate = useNavigate()
  const params = useParams()
  const platform = usePlatform()
  const [searchParams, setSearchParams] = useSearchParams<{ tab?: TabID; from?: string }>()
  const searchTab = createMemo(() => tabs.find((tab) => tab.id === searchParams.tab)?.id ?? "keys")
  const routeInitTab = createMemo(() => props.initialTab ?? searchTab())
  const [state, setState] = createStore({
    activeTab: routeInitTab(),
    sidebarWidth:
      typeof window === "undefined"
        ? 260
        : Math.min(520, Math.max(220, Number(window.localStorage.getItem("users-sidebar-width")) || 260)),
  })
  const windows = () => platform.platform === "desktop" && platform.os === "windows"
  const providerRev = createMemo(() => `providers:${providers.connected().map((provider) => provider.id).join(",")}`)
  const [status, { refetch: refetchStatus }] = createResource(
    providerRev,
    () => globalSDK.client.wanlaicodeUserCenter.status().then(unwrapSDK),
  )
  useUserCenterEvents(globalSDK, {
    resources: ["status", "entitlements", "models", "providers"],
    onChange: () => refetchStatus(),
    onAuthExpired: () => refetchStatus(),
  })
  const activeTitle = createMemo(() =>
    language.t(tabs.find((tab) => tab.id === state.activeTab)?.labelKey ?? "sidebar.account.userCenter"),
  )

  createEffect(() => {
    if (props.onClose) return
    setState("activeTab", searchTab())
  })

  function selectTab(tab: TabID) {
    setState("activeTab", tab)
    if (!props.onClose) setSearchParams({ ...searchParams, tab })
  }

  function fallbackRoute() {
    return params.dir ? `/${params.dir}` : "/"
  }

  function returnTarget() {
    if (!searchParams.from || !searchParams.from.startsWith("/") || searchParams.from.startsWith("//")) return fallbackRoute()
    if (searchParams.from.split(/[?#]/)[0]?.split("/").at(-1) === "users") return fallbackRoute()
    return searchParams.from
  }

  function returnToApp() {
    if (props.onClose) {
      props.onClose()
    } else {
      navigate(returnTarget(), { replace: true })
    }
  }

  function resizeSidebar(width: number) {
    setState("sidebarWidth", width)
    if (typeof window === "undefined") return
    window.localStorage.setItem("users-sidebar-width", String(width))
  }

  return (
    <div
      data-component="users-route-root"
      class="fixed inset-0 z-[70] overflow-hidden text-text-base"
      classList={{ "windows-settings-route": windows() }}
      style={{
        "background-color":
          platform.platform === "desktop" && (platform.os === "macos" || platform.os === "windows")
            ? "transparent"
            : "light-dark(rgb(233,234,232), var(--background-base))",
      }}
    >
      <aside
        data-tauri-drag-region
        class="settings-route-sidebar absolute inset-y-0 left-0 z-25 flex flex-col px-2.5 pb-5 pt-22"
        style={{ width: `${state.sidebarWidth}px` }}
      >
        <button
          type="button"
          class="flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-14-medium text-text-weak transition-colors
            hover:bg-surface-base-hover hover:text-text-strong"
          onClick={returnToApp}
        >
          <Icon name="arrow-left" size="small" />
          {language.t("users.actions.returnToApp")}
        </button>

        <nav class="mt-5 flex flex-col gap-1">
          <For each={tabs.filter((tab) => tab.id !== "token-packs" || canReadTokenPacks(status.latest))}>
            {(tab) => (
              <button
                type="button"
                class="glass-sidebar-menu-row flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-14-medium text-text-base transition-colors hover:text-text-strong"
                classList={{
                  "glass-sidebar-menu-row-active text-text-strong": state.activeTab === tab.id,
                  "glass-sidebar-menu-row-idle": state.activeTab !== tab.id,
                }}
                aria-current={state.activeTab === tab.id ? "page" : undefined}
                onClick={() => selectTab(tab.id)}
              >
                <Icon name={tab.icon} size="small" />
                {language.t(tab.labelKey)}
              </button>
            )}
          </For>
        </nav>
      </aside>

      <div class="absolute inset-y-0 z-30 w-0 overflow-visible" style={{ left: `${state.sidebarWidth}px` }}>
        <ResizeHandle
          direction="horizontal"
          size={state.sidebarWidth}
          min={220}
          max={typeof window === "undefined" ? 520 : Math.min(560, window.innerWidth * 0.42)}
          onResize={resizeSidebar}
        />
      </div>

      <div
        data-slot="main-bg-fill"
        class="absolute inset-y-0 right-0 z-20"
        style={{ left: `${state.sidebarWidth}px`, width: `calc(100% - ${state.sidebarWidth}px)` }}
      >
        <main
          class="settings-route-main relative size-full overflow-y-auto rounded-[12px] bg-background-base shadow-[-2px_0_10px_rgba(0,0,0,0.04),0_-1px_4px_rgba(0,0,0,0.02)]"
          style={
            {
              "-webkit-app-region": "no-drag",
              border: "1px solid light-dark(rgba(0,0,0,0.10), rgba(255,255,255,0.12))",
            } as Record<string, string>
          }
        >
          <div
            class="absolute inset-x-0 top-0 h-12 pointer-events-none"
            style={{ "-webkit-app-region": "drag" } as Record<string, string>}
            aria-hidden
          />
          <div class="users-route-content mx-auto flex min-h-full w-full max-w-[720px] flex-col gap-7 px-8 pb-14 pt-24">
            <h1 class="text-[20px] font-medium leading-tight tracking-normal text-text-strong">{activeTitle()}</h1>

            <Suspense
              fallback={
                <div class="overflow-hidden rounded-[8px] border border-border-weak-base bg-background-base shadow-none">
                  <InlineState title={language.t("users.auth.loading")} />
                </div>
              }
            >
              <Switch>
                <Match when={state.activeTab === "keys"}>
                  <ApiKeys status={() => status.latest} statusLoading={() => status.loading} statusError={() => status.error} selectTab={selectTab} />
                </Match>
                <Match when={state.activeTab === "quota"}>
                  <Quota status={() => status.latest} statusLoading={() => status.loading} statusError={() => status.error} selectTab={selectTab} />
                </Match>
                <Match when={state.activeTab === "usage"}>
                  <UsageRecords status={() => status.latest} statusLoading={() => status.loading} statusError={() => status.error} selectTab={selectTab} />
                </Match>
                <Match when={state.activeTab === "purchase"}>
                  <PurchasePlans status={() => status.latest} statusLoading={() => status.loading} statusError={() => status.error} selectTab={selectTab} />
                </Match>
                <Match when={state.activeTab === "token-packs"}>
                  <TokenPackBalance status={() => status.latest} statusLoading={() => status.loading} statusError={() => status.error} selectTab={selectTab} />
                </Match>
              </Switch>
            </Suspense>
          </div>
        </main>
      </div>
    </div>
  )
}

export default function UsersPage(props: { initialTab?: TabID; onClose?: () => void } = {}) {
  return <UsersContent initialTab={props.initialTab} onClose={props.onClose} />
}
