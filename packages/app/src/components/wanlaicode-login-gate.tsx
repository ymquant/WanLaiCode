import { For, Show, createEffect, createMemo, createResource, createSignal, onCleanup, onMount, type JSX } from "solid-js"
import { Mark } from "@opencode-ai/ui/logo"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { DialogConnectProvider } from "@/components/dialog-connect-provider"
import { DialogLoginPassword } from "@/components/dialog-login-password"
import { SettingsProxy } from "@/components/settings-proxy"
import { useUserCenterEvents } from "@/pages/users/shared"

const LOGIN_OVERLAY_ALPHA = 0.2
const LOGIN_DIALOG_OVERLAY_SELECTOR = '[data-component="dialog-overlay"]'
const LOGIN_DRAG = { "-webkit-app-region": "drag" } as Record<string, string>

function loginDialogOverlayAmount(overlay: HTMLElement) {
  const style = getComputedStyle(overlay)
  if (style.display === "none" || style.visibility === "hidden") return 0
  const elementOpacity = Number.parseFloat(style.opacity)
  const opacity = Number.isFinite(elementOpacity) ? elementOpacity : 1
  return opacity <= 0 ? 0 : opacity
}

function loginTitlebarColor(amount: number) {
  const shade = LOGIN_OVERLAY_ALPHA * Math.min(1, Math.max(0, amount))
  const channel = Math.round(255 * (1 - shade))
  return `rgb(${channel}, ${channel}, ${channel})`
}

function syncLoginTitlebarOverlay(
  last: { amount: number; color: string },
  setOverlayAmount: (amount: number) => void,
  overlay?: HTMLElement | null,
) {
  const node = overlay ?? document.querySelector<HTMLElement>(LOGIN_DIALOG_OVERLAY_SELECTOR)
  const amount = node ? loginDialogOverlayAmount(node) : 0
  if (amount !== last.amount) {
    last.amount = amount
    setOverlayAmount(amount)
  }
  const color = loginTitlebarColor(amount)
  if (color === last.color) return
  last.color = color
  void window.api?.setTitlebar?.({
    mode: "light",
    backgroundColor: color,
    symbolColor: "#000000",
  })
}

function bindLoginDialogOverlay(
  overlay: HTMLElement,
  last: { amount: number; color: string },
  setOverlayAmount: (amount: number) => void,
) {
  const sync = () => syncLoginTitlebarOverlay(last, setOverlayAmount, overlay)
  sync()
  overlay.addEventListener("transitionend", sync)
  overlay.addEventListener("animationend", sync)
  return () => {
    overlay.removeEventListener("transitionend", sync)
    overlay.removeEventListener("animationend", sync)
  }
}

type LoginPlatform = "macos" | "windows" | "web"
type LoginWindowControls = "macos" | "windows" | "none"
type Language = ReturnType<typeof useLanguage>

type LoginVisualInput = {
  os?: "macos" | "windows" | "linux"
  chrome?: "auto" | LoginWindowControls
  t: Language["t"]
}

type WanlaiCodeLoginVisual = ReturnType<typeof wanlaiCodeLoginVisual>

type WanlaiCodeLoginViewProps = {
  visual: WanlaiCodeLoginVisual
  topDragRegion?: boolean
  overlayAmount?: number
  labels: {
    minimize: string
    close: string
  }
  onPrimary?: JSX.EventHandlerUnion<HTMLButtonElement, MouseEvent>
  onSecondary?: JSX.EventHandlerUnion<HTMLButtonElement, MouseEvent>
  onPassword?: JSX.EventHandlerUnion<HTMLButtonElement, MouseEvent>
  onRegister?: JSX.EventHandlerUnion<HTMLButtonElement, MouseEvent>
  onProxy?: JSX.EventHandlerUnion<HTMLButtonElement, MouseEvent>
  onMinimize?: JSX.EventHandlerUnion<HTMLButtonElement, MouseEvent>
  onClose?: JSX.EventHandlerUnion<HTMLButtonElement, MouseEvent>
}

export function wanlaiCodeLoginVisual(input: LoginVisualInput) {
  const chrome = input.chrome ?? "auto"
  const windowControls = chrome === "auto" ? (input.os === "macos" ? "macos" : input.os === "windows" ? "windows" : "none") : chrome
  const platform: LoginPlatform = windowControls === "macos" ? "macos" : windowControls === "windows" ? "windows" : "web"

  return {
    platform,
    windowControls,
    fixedReferenceSize: false,
    title: input.t("login.wanlaicode.title"),
    subtitle: input.t("login.wanlaicode.subtitle"),
    badge: input.t("login.wanlaicode.planBadge"),
    primary: input.t("login.wanlaicode.continue"),
    secondary: input.t("login.wanlaicode.other"),
    password: input.t("login.wanlaicode.password"),
    register: input.t("login.wanlaicode.register"),
    proxy: input.t("login.proxy.button"),
  }
}

export function WanlaiCodeLoginView(props: WanlaiCodeLoginViewProps) {
  return (
    <div
      data-component="wanlaicode-login"
      data-platform={props.visual.platform}
      class="relative flex min-h-dvh w-screen items-center justify-center overflow-hidden bg-surface-primary px-8 py-12 text-text-primary"
    >
      <Show when={props.topDragRegion}>
        <div
          data-slot="login-drag-region"
          class="absolute inset-x-0 top-0 z-[1] h-9 bg-white"
          style={LOGIN_DRAG}
        >
          <div
            class="pointer-events-none absolute inset-0 bg-black"
            style={{ opacity: String((props.overlayAmount ?? 0) * LOGIN_OVERLAY_ALPHA) }}
          />
        </div>
      </Show>
      <Show when={props.visual.windowControls === "windows"}>
        <div data-slot="windows-controls" class="absolute right-0 top-[12px] z-10 flex items-start text-text-primary">
          <button
            type="button"
            class="h-8 w-[50px] text-[15px] leading-8 text-text-primary transition-colors hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-border-strong-base"
            onClick={props.onMinimize}
            aria-label={props.labels.minimize}
          >
            −
          </button>
          <button
            type="button"
            class="h-8 w-[50px] text-[15px] leading-8 text-text-primary transition-colors hover:bg-[#d92d20] hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[#191c1f]"
            onClick={props.onClose}
            aria-label={props.labels.close}
          >
            ×
          </button>
        </div>
      </Show>
      <Show when={props.visual.windowControls === "macos"}>
        <div class="absolute left-5 top-5 z-10 flex gap-2" aria-hidden="true">
          <For each={["#ff5f57", "#febc2e", "#d7d7d7"]}>
            {(color) => <div data-slot="macos-traffic-light" class="size-3 rounded-full" style={{ "background-color": color }} />}
          </For>
        </div>
      </Show>

      <div class="relative flex w-full max-w-[420px] -translate-y-[52px] flex-col items-center pt-[86px] text-center">
        <Mark class="size-[52px]" />

        <h1 class="mt-[30px] max-w-[320px] text-balance text-[28px] font-semibold leading-[1.12] tracking-[-0.04em] text-text-primary">
          {props.visual.title}
        </h1>
        <Show when={props.visual.badge}>
          {(badge) => (
            <div class="mt-[16px] inline-flex items-center gap-[5px] rounded-full border border-[#ebe9ff] bg-[#f7f5ff] px-[8px] py-[2px] text-[13px] font-medium text-[#4452ff] shadow-none">
              {badge()}
            </div>
          )}
        </Show>

        <div class="mt-[34px] flex w-full max-w-[340px] flex-col gap-3">
          <button
            type="button"
            data-action="primary"
            aria-label={props.visual.primary}
            class="flex h-[48px] items-center justify-center gap-[10px] rounded-full bg-[#000000] px-6 text-[15px] font-semibold tracking-[-0.01em] text-[#ffffff] shadow-[0_4px_12px_rgba(0,0,0,0.10)] transition-[background-color,transform] hover:bg-[#4f5054] active:translate-y-px focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#000000]"
            onClick={props.onPrimary}
          >
            <span class="text-[#ffffff]">{props.visual.primary}</span>
          </button>
          <button
            type="button"
            data-action="password"
            class="h-[48px] rounded-full border border-[#e5e5e5] bg-white px-6 text-[14px] font-medium text-[#25272a] transition-[background-color,border-color,transform] hover:bg-[#f1f1f1] active:translate-y-px focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#191c1f]"
            onClick={props.onPassword}
          >
            {props.visual.password}
          </button>
          <button
            type="button"
            data-action="secondary"
            class="h-[48px] rounded-full border border-[#e5e5e5] bg-white px-6 text-[14px] font-medium text-[#25272a] transition-[background-color,border-color,transform] hover:bg-[#f1f1f1] active:translate-y-px focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#191c1f]"
            onClick={props.onSecondary}
          >
            {props.visual.secondary}
          </button>
        </div>

        <Show when={props.visual.register}>
          {(register) => (
            <button
              type="button"
              data-action="register"
              class="mt-[18px] text-[13px] font-medium text-text-base underline underline-offset-4 transition-colors hover:text-[#000000]"
              onClick={props.onRegister}
            >
              {register()}
            </button>
          )}
        </Show>

        <Show when={props.visual.proxy}>
          {(proxy) => (
            <button
              type="button"
              data-action="proxy"
              class="mt-[10px] text-[12px] font-medium text-text-weak underline underline-offset-4 transition-colors hover:text-text-base"
              onClick={props.onProxy}
            >
              {proxy()}
            </button>
          )}
        </Show>
      </div>
    </div>
  )
}

const SIDECAR_RETRY_INTERVAL_MS = 2000

// 本地 sidecar 拉不通（如被安全/代理软件拦截 127.0.0.1）时不能抛给
// ErrorBoundary 崩掉整个登录窗，降级为未连接并交由横幅提示 + 自动重试
export async function loadLoginGateStatus(
  fetchStatus: () => Promise<{ authenticated?: boolean } | undefined>,
  onUnreachable: (unreachable: boolean) => void,
) {
  try {
    const data = await fetchStatus()
    onUnreachable(false)
    return data
  } catch {
    onUnreachable(true)
    return undefined
  }
}

export function createLoginGateStatus(
  source: () => string,
  fetchStatus: () => Promise<{ authenticated?: boolean } | undefined>,
) {
  const [unreachable, setUnreachable] = createSignal(false)
  // seq 挡掉迟到的旧请求副作用：Solid 只认最新 promise 的返回值，
  // 但 fetcher 内的 setUnreachable 不在该保护内，需自行判活
  let seq = 0
  const [status, { refetch }] = createResource(source, () => {
    const token = ++seq
    return loadLoginGateStatus(fetchStatus, (flag) => {
      if (token === seq) setUnreachable(flag)
    })
  })
  const isConnected = createMemo(() => status.latest?.authenticated === true)
  return { isConnected, unreachable, loading: () => status.loading, refetch }
}

export function WanlaiCodeLoginGate() {
  const dialog = useDialog()
  const globalSDK = useGlobalSDK()
  const globalSync = useGlobalSync()
  const language = useLanguage()
  const platform = usePlatform()

  const providerRev = createMemo(() => globalSync.data.provider.connected.join(","))
  const gateStatus = createLoginGateStatus(providerRev, () =>
    globalSDK.client.wanlaicodeUserCenter.status().then((result) => result.data),
  )
  const isConnected = gateStatus.isConnected
  const refetchStatus = gateStatus.refetch

  createEffect(() => {
    if (!gateStatus.unreachable()) return
    const timer = setInterval(() => {
      if (!gateStatus.loading()) void refetchStatus()
    }, SIDECAR_RETRY_INTERVAL_MS)
    onCleanup(() => clearInterval(timer))
  })
  const visual = createMemo(() => wanlaiCodeLoginVisual({ os: platform.os, chrome: "none", t: language.t }))
  const topDragRegion = createMemo(() => platform.platform === "desktop" && platform.os === "windows")
  const [overlayAmount, setOverlayAmount] = createSignal(0)

  onMount(() => {
    if (!topDragRegion()) return
    const last = { amount: -1, color: "" }
    let bound: HTMLElement | undefined
    let unbind: (() => void) | undefined

    const detach = () => {
      unbind?.()
      unbind = undefined
      bound = undefined
    }

    const sync = () => {
      const overlay = document.querySelector<HTMLElement>(LOGIN_DIALOG_OVERLAY_SELECTOR)
      if (!overlay) {
        detach()
        syncLoginTitlebarOverlay(last, setOverlayAmount)
        return
      }
      if (bound === overlay) {
        syncLoginTitlebarOverlay(last, setOverlayAmount, overlay)
        return
      }
      detach()
      bound = overlay
      unbind = bindLoginDialogOverlay(overlay, last, setOverlayAmount)
    }

    const observer = new MutationObserver(sync)
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["style", "class", "hidden"],
    })
    sync()
    onCleanup(() => {
      observer.disconnect()
      detach()
    })
  })

  useUserCenterEvents(globalSDK, {
    resources: ["status", "entitlements"],
    onChange: () => {
      if (!isConnected()) void refetchStatus()
    },
    onAuthExpired: () => refetchStatus(),
  })

  // 挂载后 3s 内忽略自动重定向，避免 sign-out 后登录页闪退到主窗口。
  // 时间窗口覆盖了多次 status refetch 场景（如 provider.connected 变化触发二次读取），
  // 比单次布尔标志更可靠。正常登录的主跳转由 DialogConnectProvider.complete()
  // 中的 window.api.openMainWindow() 负责，此 effect 仅为兜底机制。
  const mountTime = Date.now()
  const AUTO_OPEN_GRACE_MS = 3000
  createEffect(() => {
    if (isConnected() && !gateStatus.loading()) {
      if (Date.now() - mountTime < AUTO_OPEN_GRACE_MS) return
      void platform.openMainWindow?.()
    }
  })

  const showOAuthLogin = () => {
    dialog.show(() => <DialogConnectProvider provider="wanlaicode" preferredMethod="oauth" hideBackButton />)
  }

  const showApiLogin = () => {
    dialog.show(() => <DialogConnectProvider provider="wanlaicode" preferredMethod="api" hideBackButton />)
  }

  const showPasswordLogin = () => {
    dialog.show(() => <DialogLoginPassword onSuccess={() => refetchStatus()} />)
  }

  const openRegisterPage = () => {
    void platform.openLink("https://wanlai.ai/register")
  }

  const showProxySettings = () => {
    dialog.show(() => (
      <Dialog title={language.t("login.proxy.title")} description={language.t("login.proxy.description")}>
        <SettingsProxy compact />
      </Dialog>
    ))
  }

  return (
    <Show when={!isConnected()}>
      <WanlaiCodeLoginView
        visual={visual()}
        topDragRegion={topDragRegion()}
        overlayAmount={overlayAmount()}
        labels={{
          minimize: language.t("titlebar.menu.window.minimize"),
          close: language.t("common.close"),
        }}
        onPrimary={showOAuthLogin}
        onSecondary={showApiLogin}
        onPassword={showPasswordLogin}
        onRegister={openRegisterPage}
        onProxy={showProxySettings}
        onMinimize={() => void platform.windowAction?.("minimize")}
        onClose={() => void platform.windowAction?.("close")}
      />
      <Show when={gateStatus.unreachable()}>
        <div data-slot="sidecar-error" class="pointer-events-none fixed inset-x-0 top-12 z-20 flex justify-center px-6">
          <div class="max-w-[420px] rounded-lg border border-[#f0d0d0] bg-[#fff5f5] px-4 py-3 text-center shadow-sm">
            <p class="text-[13px] font-medium text-[#b42318]">
              {language.t("login.sidecar.unreachable")} {language.t("app.server.retrying")}
            </p>
            <p class="mt-1 text-[12px] leading-[1.5] text-[#8a5854]">{language.t("login.sidecar.hint")}</p>
          </div>
        </div>
      </Show>
    </Show>
  )
}

export const WanlaiCodeLoginPage = WanlaiCodeLoginGate
