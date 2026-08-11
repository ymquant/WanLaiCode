import { Icon, type IconName } from "@opencode-ai/ui/icon"
import { ResizeHandle } from "@opencode-ai/ui/resize-handle"
import { useNavigate, useParams, useSearchParams } from "@solidjs/router"
import { createEffect, For, Match, onCleanup, onMount, Switch, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { SettingsEnvironment } from "@/components/settings-environment"
import { SettingsGeneral } from "@/components/settings-general"
import { SettingsAppearance } from "@/components/settings-appearance"
import { SettingsGit } from "@/components/settings-git"
import { SettingsKeybinds } from "@/components/settings-keybinds"
import { SettingsModels } from "@/components/settings-models"
import { SettingsPersonalization } from "@/components/settings-personalization"
import { SettingsProviders } from "@/components/settings-providers"
import { SettingsProxy } from "@/components/settings-proxy"
import { SettingsArchivedSessions } from "@/components/settings-archived-sessions"
import { SettingsMemory } from "@/components/settings-memory"
import { SettingsRemoteControl } from "@/components/settings-remote-control"
import { SettingsAppSnapshots } from "@/components/settings-app-snapshots"
import { SettingsRules } from "@/components/settings-rules"
import type { SettingsTab } from "@/components/dialog-settings"

type SettingsNavItem = {
  id: SettingsTab
  icon: IconName
  iconViewBox?: string
  labelKey: string
  macosOnly?: boolean
}

const settingsGroups: Array<{ sectionKey: string; items: SettingsNavItem[] }> = [
  {
    sectionKey: "settings.section.desktop",
    items: [
      { id: "general", icon: "settings-gear2", iconViewBox: "0 0 1024 1024", labelKey: "settings.tab.general" },
      { id: "appearance", icon: "sun", labelKey: "settings.tab.appearance" },
      { id: "shortcuts", icon: "keyboard", labelKey: "settings.tab.shortcuts" },
      { id: "appSnapshots", icon: "window-cursor", labelKey: "appSnapshots.title", macosOnly: true },
      { id: "personalization", icon: "personalization2", labelKey: "settings.personalization.title" },
      { id: "memory", icon: "brain", labelKey: "settings.memory.title" },
      // 手机连接属于桌面级能力，与代理/provider 等服务配置分组隔离。
      { id: "remoteControl", icon: "laptop", labelKey: "settings.remote.title" },
      // 规则配置属于桌面设置，和 main 的规则持久化页面保持同一导航入口。
      { id: "rules", icon: "bullet-list", labelKey: "settings.rules.title" },
    ],
  },
  {
    sectionKey: "settings.section.server",
    items: [
      { id: "providers", icon: "providers", labelKey: "settings.providers.title" },
      { id: "models", icon: "providers2", iconViewBox: "0 0 1024 1024", labelKey: "settings.models.title" },
      { id: "git", icon: "git-branch-filled2", iconViewBox: "0 0 1024 1024", labelKey: "settings.git.title" },
      { id: "proxy", icon: "globe", labelKey: "settings.proxy.title" },
      { id: "environment", icon: "folder", iconViewBox: "0 0 20 20", labelKey: "settings.environment.title" },
    ],
  },
  {
    sectionKey: "settings.section.archived",
    items: [{ id: "archivedSessions", icon: "archive", labelKey: "settings.archivedSessions.title" }],
  },
]

const settingsTabs = settingsGroups.flatMap((group) => group.items)
const SETTINGS_MAIN_DRAG_HEIGHT = 96
const SETTINGS_MAIN_DRAG_BLOCK_SELECTOR = [
  "a",
  "button",
  "input",
  "label",
  "select",
  "summary",
  "textarea",
  "[contenteditable='true']",
  "[data-settings-drag-block]",
  "[role='button']",
  "[role='combobox']",
  "[role='menuitem']",
  "[role='switch']",
  "[role='textbox']",
].join(",")

const tabFromSearch = (tab: string | undefined): SettingsTab =>
  settingsTabs.find((item) => item.id === tab)?.id ?? "general"

const iconStyle: JSX.CSSProperties = { width: "15px", height: "15px" }

export default function SettingsPage(props: { initialTab?: SettingsTab; onClose?: () => void }) {
  const language = useLanguage()
  const navigate = useNavigate()
  const params = useParams()
  const platform = usePlatform()
  const [searchParams, setSearchParams] = useSearchParams<{ tab?: SettingsTab; from?: string }>()
  const [state, setState] = createStore({
    activeTab: tabFromSearch(props.initialTab ?? searchParams.tab),
    sidebarWidth:
      typeof window === "undefined"
        ? 260
        : Math.min(520, Math.max(220, Number(window.localStorage.getItem("settings-sidebar-width")) || 260)),
  })
  let mainPanelElement: HTMLElement | undefined
  const windows = () => platform.platform === "desktop" && platform.os === "windows"
  const desktop = () => platform.platform === "desktop"
  // 共享设置路由在 Web 也会渲染，手机远控项必须只留给真正启动 sidecar 的桌面宿主。
  const visibleSettingsGroups = () =>
    settingsGroups.map((group) => ({
      ...group,
      // 远控只在桌面 sidecar 可用，应用快照仍遵循 main 的 macOS-only 限制。
      items: group.items.filter(
        (item) => (!item.macosOnly || platform.os === "macos") && (item.id !== "remoteControl" || desktop()),
      ),
    }))

  // overlay 模式（props.onClose 存在）下 tab 完全收到本地 state，不读写会话 URL。
  // route 模式下保持旧行为：URL tab 参数驱动 activeTab，selectTab 同步写回 URL。
  createEffect(() => {
    if (props.onClose) return
    const tab = searchParams.tab
    if (tab) setState("activeTab", tabFromSearch(tab))
  })

  createEffect(() => {
    // Web 端直接打开旧 remoteControl URL 时回退到通用设置，避免出现没有控制面的空白页。
    if (!desktop() && state.activeTab === "remoteControl") setState("activeTab", "general")
  })

  function selectTab(tab: SettingsTab) {
    setState("activeTab", tab)
    if (!props.onClose) setSearchParams({ ...searchParams, tab })
  }

  function fallbackRoute() {
    return params.dir ? `/${params.dir}` : "/"
  }

  function returnTarget() {
    if (!searchParams.from || !searchParams.from.startsWith("/") || searchParams.from.startsWith("//"))
      return fallbackRoute()
    if (searchParams.from.split(/[?#]/)[0]?.split("/").at(-1) === "settings") return fallbackRoute()
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
    window.localStorage.setItem("settings-sidebar-width", String(width))
  }

  function canStartMainPanelDrag(event: PointerEvent) {
    if (!desktop() || event.button !== 0 || event.defaultPrevented || !platform.moveWindowForDrag) return false
    if (!(event.currentTarget instanceof HTMLElement)) return false
    if (!(event.target instanceof Element)) return false

    const rect = event.currentTarget.getBoundingClientRect()
    if (event.clientY - rect.top > SETTINGS_MAIN_DRAG_HEIGHT) return false

    // The top of each settings tab is mostly blank titlebar space, but some tabs
    // keep search fields and action buttons there. Never convert real controls
    // into window drags.
    if (event.target.closest(SETTINGS_MAIN_DRAG_BLOCK_SELECTOR)) return false

    return true
  }

  function handleMainPanelPointerDown(event: PointerEvent) {
    if (!canStartMainPanelDrag(event)) return
    startMainPanelDrag(event)
  }

  function startMainPanelDrag(event: PointerEvent) {
    if (event.button !== 0 || !platform.moveWindowForDrag) return

    event.preventDefault()
    event.stopPropagation()

    const startPointerX = event.screenX
    const startPointerY = event.screenY
    const startWindowX = window.screenX
    const startWindowY = window.screenY
    const startWindowWidth = windows() ? window.outerWidth : undefined
    const startWindowHeight = windows() ? window.outerHeight : undefined
    let frame = 0
    let nextPosition: { x: number; y: number; width?: number; height?: number } | undefined

    const flush = () => {
      frame = 0
      if (!nextPosition) return
      void platform.moveWindowForDrag?.(nextPosition)
    }

    const scheduleMove = (input: PointerEvent) => {
      nextPosition = {
        x: startWindowX + input.screenX - startPointerX,
        y: startWindowY + input.screenY - startPointerY,
        width: startWindowWidth,
        height: startWindowHeight,
      }
      if (!frame) frame = window.requestAnimationFrame(flush)
    }

    const stop = () => {
      if (frame) window.cancelAnimationFrame(frame)
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", stop)
      window.removeEventListener("pointercancel", stop)
    }

    const move = (input: PointerEvent) => {
      if ((input.buttons & 1) === 0) {
        stop()
        return
      }
      input.preventDefault()
      scheduleMove(input)
    }

    window.addEventListener("pointermove", move, { passive: false })
    window.addEventListener("pointerup", stop, { once: true })
    window.addEventListener("pointercancel", stop, { once: true })
  }

  onMount(() => {
    const element = mainPanelElement
    if (!element) return

    const listener = (event: PointerEvent) => handleMainPanelPointerDown(event)
    element.addEventListener("pointerdown", listener, { capture: true })
    onCleanup(() => element.removeEventListener("pointerdown", listener, { capture: true }))
  })

  return (
    <>
      <style>{`
        /* 窄屏保留可操作的图标导航，把主要宽度让给设置内容；桌面布局不受影响。 */
        @media (max-width: 640px) {
          [data-component="settings-route-root"] .settings-route-sidebar {
            width: 56px !important;
            padding-left: 8px;
            padding-right: 8px;
          }
          [data-component="settings-route-root"] .settings-route-sidebar nav {
            gap: 8px;
          }
          [data-component="settings-route-root"] .settings-route-sidebar [data-settings-nav-label],
          [data-component="settings-route-root"] .settings-route-sidebar [data-settings-section-label],
          [data-component="settings-route-root"] .settings-route-sidebar [data-settings-footer] {
            display: none;
          }
          [data-component="settings-route-root"] .settings-route-sidebar button {
            width: 40px;
            justify-content: center;
            padding-left: 0;
            padding-right: 0;
          }
          [data-component="settings-route-root"] [data-slot="settings-resize"] {
            display: none;
          }
          [data-component="settings-route-root"] [data-slot="main-bg-fill"] {
            left: 56px !important;
            width: calc(100% - 56px) !important;
          }
        }
      `}</style>
      <div
        data-component="settings-route-root"
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
            aria-label={language.t("users.actions.returnToApp")}
            title={language.t("users.actions.returnToApp")}
            onClick={returnToApp}
          >
            <Icon name="arrow-left" size="small" />
            <span data-settings-nav-label>{language.t("users.actions.returnToApp")}</span>
          </button>

          <nav class="mt-5 flex flex-col gap-4">
            <For each={visibleSettingsGroups()}>
              {(group) => (
                <div class="flex flex-col gap-1">
                  <div data-settings-section-label class="px-2 pb-1 text-12-medium text-text-weak">
                    {language.t(group.sectionKey)}
                  </div>
                  <For each={group.items}>
                    {(item) => (
                      <button
                        type="button"
                        class="glass-sidebar-menu-row flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-14-medium text-text-base transition-colors hover:text-text-strong"
                        classList={{
                          "glass-sidebar-menu-row-active text-text-strong": state.activeTab === item.id,
                          "glass-sidebar-menu-row-idle": state.activeTab !== item.id,
                        }}
                        aria-current={state.activeTab === item.id ? "page" : undefined}
                        aria-label={language.t(item.labelKey)}
                        title={language.t(item.labelKey)}
                        onClick={() => selectTab(item.id)}
                      >
                        <Icon name={item.icon} viewBox={item.iconViewBox} style={iconStyle} />
                        <span data-settings-nav-label>{language.t(item.labelKey)}</span>
                      </button>
                    )}
                  </For>
                </div>
              )}
            </For>
          </nav>

          <div data-settings-footer class="mt-auto flex flex-col gap-1 px-2 text-12-medium text-text-weak">
            <span>{language.t("app.name.desktop")}</span>
            <span class="text-11-regular">v{platform.version}</span>
          </div>
        </aside>

        <div
          data-slot="settings-resize"
          class="absolute inset-y-0 z-30 w-0 overflow-visible"
          style={{ left: `${state.sidebarWidth}px` }}
        >
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
            ref={(element) => {
              mainPanelElement = element
            }}
            class="settings-route-main relative size-full overflow-hidden rounded-[12px] bg-background-base shadow-[-2px_0_10px_rgba(0,0,0,0.04),0_-1px_4px_rgba(0,0,0,0.02)]"
            style={
              {
                "-webkit-app-region": "no-drag",
                border: "1px solid light-dark(rgba(0,0,0,0.10), rgba(255,255,255,0.12))",
              } as Record<string, string>
            }
          >
            <div class="settings-route-content mx-auto h-full w-full max-w-[920px]">
              <Switch>
                <Match when={state.activeTab === "general"}>
                  <SettingsGeneral />
                </Match>
                <Match when={state.activeTab === "appearance"}>
                  <SettingsAppearance />
                </Match>
                <Match when={state.activeTab === "shortcuts"}>
                  <SettingsKeybinds />
                </Match>
                {/* main 的应用快照功能只在 macOS 导航中显示，直接访问时仍由组件自身提供兼容提示。 */}
                <Match when={state.activeTab === "appSnapshots"}>
                  <SettingsAppSnapshots />
                </Match>
                <Match when={state.activeTab === "providers"}>
                  <SettingsProviders />
                </Match>
                <Match when={state.activeTab === "models"}>
                  <SettingsModels />
                </Match>
                <Match when={state.activeTab === "git"}>
                  <SettingsGit />
                </Match>
                <Match when={state.activeTab === "proxy"}>
                  <SettingsProxy />
                </Match>
                <Match when={state.activeTab === "personalization"}>
                  <SettingsPersonalization />
                </Match>
                <Match when={state.activeTab === "memory"}>
                  <SettingsMemory />
                </Match>
                {/* 规则编辑器与远控页面共用同一设置路由，互不覆盖状态。 */}
                <Match when={state.activeTab === "rules"}>
                  <SettingsRules />
                </Match>
                <Match when={desktop() && state.activeTab === "remoteControl"}>
                  <SettingsRemoteControl />
                </Match>
                <Match when={state.activeTab === "environment"}>
                  <SettingsEnvironment />
                </Match>
                <Match when={state.activeTab === "archivedSessions"}>
                  <SettingsArchivedSessions />
                </Match>
              </Switch>
            </div>
          </main>
        </div>
      </div>
    </>
  )
}
