import { createEffect, createSignal, onCleanup, onMount, Show, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"
import { Tabs } from "@opencode-ai/ui/tabs"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"

type BrowserNavState = {
  canGoBack: boolean
  canGoForward: boolean
  favicon: string
  isLoading: boolean
  title: string
  url: string
}

const [browserState, setBrowserState] = createStore<Record<string, { favicon: string; url: string; title: string }>>({})
const [browserNavState, setBrowserNavState] = createStore<Record<string, BrowserNavState>>({})

export function getBrowserNavState(tab: string) {
  return browserNavState[tab]
}

// 把地址栏手动跳转和页面自身触发的跳转分开跟踪，避免页内点击链接或重定向时再次反向触发 loadURL。
const internalNavigations = new Set<string>()
const pendingNavigations = new Map<string, { previous: string; target: string }>()

function initBrowserNavState() {
  if (typeof window === "undefined" || !("api" in window)) return
  const api = (window as any).api
  if (!api?.onBrowserViewState) return
  api.onBrowserViewState((tabId: string, state: BrowserNavState) => {
    const pending = pendingNavigations.get(tabId)
    setBrowserNavState(tabId, state)
    if (
      pending &&
      state.url &&
      state.url !== pending.target &&
      (state.url === pending.previous || state.url === "about:blank")
    ) {
      return
    }
    if (pending && state.url && state.url !== pending.target) {
      pendingNavigations.delete(tabId)
    }
    if (state.title || state.url || state.favicon) {
      setBrowserInfo(tabId, state.url, state.title, state.favicon)
    }
    if (state.url && state.url !== "about:blank") {
      if (pending && state.url === pending.target) {
        pendingNavigations.delete(tabId)
        internalNavigations.delete(tabId)
      }
      if (internalNavigations.has(tabId) && !pending) {
        internalNavigations.delete(tabId)
      }
    }
  })
}

initBrowserNavState()

let openExternalLinkHandler: ((url: string) => void) | undefined

export function setOpenExternalLinkHandler(fn: ((url: string) => void) | undefined) {
  openExternalLinkHandler = fn
}

export function getOpenExternalLinkHandler() {
  return openExternalLinkHandler
}

export function isBrowserTab(tab: string) {
  return tab.startsWith("browser:")
}

export function createBrowserTabId() {
  return `browser:${Date.now()}`
}

export function getBrowserInfo(tab: string) {
  return browserState[tab]
}

function getFallbackBrowserTitle(url: string) {
  try {
    const u = new URL(url)
    if (u.protocol === "file:") {
      const segments = u.pathname.split("/").filter(Boolean)
      return segments[segments.length - 1] || url
    }
    return u.hostname
  } catch {
    return url
  }
}

function setBrowserInfo(tab: string, url: string, title?: string, favicon?: string) {
  setBrowserState(tab, { url, title: title || getFallbackBrowserTitle(url), favicon: favicon || "" })
}

export function setBrowserUrl(tab: string, url: string) {
  const current = browserState[tab]
  const title = current?.url === url ? current.title : undefined
  const favicon = current?.url === url ? current.favicon : undefined
  if (url) {
    pendingNavigations.set(tab, { previous: current?.url || "", target: url })
    internalNavigations.add(tab)
  } else {
    pendingNavigations.delete(tab)
    internalNavigations.delete(tab)
  }
  setBrowserInfo(tab, url, title, favicon)
}

export function removeBrowserTab(tab: string) {
  pendingNavigations.delete(tab)
  internalNavigations.delete(tab)
  setBrowserState(tab, undefined as any)
}

export function hideBrowserTab(tab: string) {
  if (typeof window === "undefined" || !("api" in window)) return
  ;(window as any).api.browserViewHideSync(tab)
}

export function destroyBrowserTab(tab: string) {
  pendingNavigations.delete(tab)
  internalNavigations.delete(tab)
  setBrowserState(tab, undefined as any)
  if (typeof window === "undefined" || !("api" in window)) return
  ;(window as any).api.browserViewClose(tab)
}

const BROWSER_VIEWS_HIDE = "wanlaicode:browser-views-hide"
const BROWSER_VIEWS_SHOW = "wanlaicode:browser-views-show"
const browserViewHideReasons = new Map<string, number>()

export function hideAllBrowserViews(reason = "global") {
  browserViewHideReasons.set(reason, (browserViewHideReasons.get(reason) ?? 0) + 1)
  window.dispatchEvent(new CustomEvent(BROWSER_VIEWS_HIDE))
}

export function showAllBrowserViews(reason = "global") {
  const count = browserViewHideReasons.get(reason)
  if (count === undefined) return
  if (count > 1) {
    browserViewHideReasons.set(reason, count - 1)
    return
  }
  browserViewHideReasons.delete(reason)
  if (browserViewHideReasons.size > 0) return
  window.dispatchEvent(new CustomEvent(BROWSER_VIEWS_SHOW))
}

export function createBrowserViewsHidden(hidden: Accessor<boolean>, reason = "global") {
  createEffect(() => {
    if (!hidden()) return
    hideAllBrowserViews(reason)
    onCleanup(() => showAllBrowserViews(reason))
  })
}

function BrowserFavicon(props: { src?: string; class?: string }) {
  const [failed, setFailed] = createSignal(false)

  createEffect(() => {
    props.src
    setFailed(false)
  })

  return (
    <Show when={props.src && !failed()} fallback={<Icon name="webpage-icon" size="small" class={props.class} />}>
      <img src={props.src} alt="" class={props.class} onError={() => setFailed(true)} />
    </Show>
  )
}

function normalizeUrl(input: string) {
  const trimmed = input.trim()
  if (!trimmed) return ""
  if (/^(https?|file):\/\//i.test(trimmed)) return trimmed
  return `https://${trimmed}`
}

export function BrowserTabContent(props: { tab: string; active?: boolean }) {
  const language = useLanguage()
  const platform = usePlatform()
  const [draft, setDraft] = createSignal("")
  const [error, setError] = createSignal(false)

  const info = () => getBrowserInfo(props.tab)
  const favicon = () => info()?.favicon
  const url = () => info()?.url

  const navigate = (input: string) => {
    const next = normalizeUrl(input)
    if (!next) return
    setError(false)
    setBrowserUrl(props.tab, next)
    setDraft("")
  }

  const placeholder = () => {
    const t = language.t("session.browser.placeholder")
    return t || "Enter URL..."
  }
  const enterUrlText = () => {
    const t = language.t("session.browser.enterUrl")
    return t || "Enter a URL to browse"
  }
  const openExternalText = () => {
    const t = language.t("session.browser.openExternal")
    return t || "Open in external browser"
  }

  const isDesktop = () => platform.platform === "desktop" && typeof window !== "undefined" && "api" in window

  const navState = () => (isDesktop() ? getBrowserNavState(props.tab) : undefined)
  const canGoBack = () => navState()?.canGoBack ?? false
  const canGoForward = () => navState()?.canGoForward ?? false
  const isLoading = () => navState()?.isLoading ?? false
  const currentUrl = () => navState()?.url

  const goBack = () => { if (isDesktop()) (window as any).api.browserViewGoBack(props.tab) }
  const goForward = () => { if (isDesktop()) (window as any).api.browserViewGoForward(props.tab) }
  const stop = () => {
    if (isDesktop()) (window as any).api.browserViewStop(props.tab)
  }
  const reload = () => {
    if (isDesktop()) (window as any).api.browserViewReload(props.tab)
  }

  return (
    <Tabs.Content value={props.tab} class="flex flex-col h-full overflow-hidden contain-strict">
      <div class="flex flex-col shrink-0 border-b border-border-weaker-base bg-background-base">
        <div class="flex items-center gap-1 shrink-0 px-2 py-1.5">
          <Show when={isDesktop()}>
            <div class="flex items-center gap-0.5 shrink-0">
              <IconButton
                icon="chevron-left"
                variant="ghost"
                size="small"
                class="size-6"
                disabled={!canGoBack()}
                onClick={goBack}
                aria-label="Back"
              />
              <IconButton
                icon="chevron-right"
                variant="ghost"
                size="small"
                class="size-6"
                disabled={!canGoForward()}
                onClick={goForward}
                aria-label="Forward"
              />
              <Show when={isLoading()}>
                <IconButton
                  icon="stop"
                  variant="ghost"
                  size="small"
                  class="size-6"
                  onClick={stop}
                  aria-label="Stop"
                />
              </Show>
              <IconButton
                icon="refresh-browse"
                variant="ghost"
                size="small"
                class="size-6"
                onClick={reload}
                aria-label="Refresh"
              />
            </div>
          </Show>
          <div class="flex-1 flex items-center gap-1.5 bg-background-stronger rounded-md px-2 h-7">
            <BrowserFavicon src={favicon()} class="size-3.5 shrink-0 rounded-sm object-contain" />
            <input
              type="text"
              spellcheck={false}
              placeholder={placeholder()}
              value={draft() || url() || ""}
              onInput={(e) => {
                setDraft(e.currentTarget.value)
              }}
              onFocus={(e) => {
                if (!draft() && url()) {
                  setDraft(url()!)
                  e.currentTarget.select()
                }
              }}
              onBlur={() => {
                if (draft() === url()) setDraft("")
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") navigate(e.currentTarget.value)
              }}
              class="flex-1 min-w-0 bg-transparent text-13-regular text-text-base placeholder:text-text-weak outline-none"
            />
            <Show when={url()}>
              <IconButton
                icon="close-small"
                variant="ghost"
                class="h-5 w-5"
                onClick={() => {
                  setBrowserUrl(props.tab, "")
                  setDraft("")
                  setError(false)
                }}
                aria-label="Clear URL"
              />
            </Show>
          </div>
          <IconButton
            icon="square-arrow-top-right"
            variant="ghost"
            size="small"
            class="size-7 shrink-0"
            onClick={() => {
              const u = url() || draft()
              if (u) platform.openLink(normalizeUrl(u))
            }}
            aria-label={openExternalText()}
          />
        </div>
        <Show when={isLoading()}>
          <div class="h-0.5 w-full bg-background-stronger">
            <div class="h-full bg-accent-base w-3/5 animate-pulse" />
          </div>
        </Show>
      </div>

      <div class="flex-1 min-h-0 relative bg-white">
        <Show
          when={url()}
          fallback={
            <div class="absolute inset-0 flex flex-col items-center justify-center gap-3 text-text-weak">
              <Icon name="webpage-icon" size="large" class="size-10 opacity-15" />
              <span class="text-14-regular">{enterUrlText()}</span>
            </div>
          }
        >
          {isDesktop() ? (
            <DesktopBrowserView tab={props.tab} url={url()!} active={props.active !== false} onError={() => setError(true)} />
          ) : (
            <IframeView tab={props.tab} error={error()} onError={() => setError(true)} />
          )}
        </Show>
      </div>
    </Tabs.Content>
  )
}

function IframeView(props: { tab: string; error: boolean; onError: () => void }) {
  const platform = usePlatform()
  const language = useLanguage()
  const info = () => getBrowserInfo(props.tab)
  const url = () => info()?.url

  const cannotLoadText = () => {
    const t = language.t("session.browser.cannotLoad")
    return t || "This page cannot be displayed here. The site may block embedding."
  }
  const openExternalText = () => {
    const t = language.t("session.browser.openExternal")
    return t || "Open in external browser"
  }

  return (
    <Show
      when={!props.error}
      fallback={
        <div class="absolute inset-0 flex flex-col items-center justify-center gap-3 text-text-weak p-8 text-center">
          <Icon name="circle-ban-sign" size="large" class="size-10 opacity-15" />
          <span class="text-14-regular">{cannotLoadText()}</span>
          <span
            class="text-13-regular text-text-link cursor-pointer hover:underline"
            onClick={() => {
              const u = url()
              if (u) platform.openLink(u)
            }}
          >
            {openExternalText()}
          </span>
        </div>
      }
    >
      <iframe
        src={url()}
        class="w-full h-full border-0"
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
        onError={props.onError}
      />
    </Show>
  )
}

function DesktopBrowserView(props: { tab: string; url: string; active: boolean; onError: () => void }) {
  const api = (window as any).api
  let containerRef: HTMLDivElement | undefined
  let boundsFrame: number | undefined
  let lastBounds = ""
  let isShown = false
  let disposed = false

  const sendBounds = () => {
    if (!containerRef) return
    if (browserViewHideReasons.size > 0) {
      if (lastBounds !== "hidden") {
        lastBounds = "hidden"
        isShown = false
        api.browserViewHide(props.tab)
      }
      return
    }
    const rect = containerRef.getBoundingClientRect()
    if (rect.width < 1 || rect.height < 1) {
      if (lastBounds !== "hidden") {
        lastBounds = "hidden"
        isShown = false
        api.browserViewHide(props.tab)
      }
      return
    }
    const x = Math.round(rect.x)
    const y = Math.round(rect.y)
    const w = Math.round(rect.width)
    const h = Math.round(rect.height)
    const key = `${x},${y},${w},${h}`
    if (key === lastBounds) return
    lastBounds = key
    if (!isShown) {
      isShown = true
      api.browserViewShow(props.tab)
    }
    void api.browserViewSetBounds(props.tab, { x, y, width: w, height: h })
  }

  const scheduleSendBounds = () => {
    if (boundsFrame !== undefined) return
    boundsFrame = requestAnimationFrame(() => {
      boundsFrame = undefined
      sendBounds()
    })
  }

  let observer: ResizeObserver | undefined

  onMount(() => {
    const init = async () => {
      await api.browserViewCreate(props.tab)
      if (disposed) {
        api.browserViewClose(props.tab)
        return
      }
      if (getBrowserNavState(props.tab)?.url !== props.url) {
        void api.browserViewNavigate(props.tab, props.url)
      }
      scheduleSendBounds()
    }
    void init()

    window.addEventListener("scroll", scheduleSendBounds, true)

    if (containerRef) {
      observer = new ResizeObserver(() => scheduleSendBounds())
      observer.observe(containerRef)
    }

    const onHide = () => {
      if (boundsFrame !== undefined) {
        cancelAnimationFrame(boundsFrame)
        boundsFrame = undefined
      }
      lastBounds = "hidden"
      isShown = false
      api.browserViewHide(props.tab)
    }
    const onShow = () => {
      if (browserViewHideReasons.size > 0) return
      lastBounds = ""
      isShown = false
      scheduleSendBounds()
    }
    window.addEventListener(BROWSER_VIEWS_HIDE, onHide)
    window.addEventListener(BROWSER_VIEWS_SHOW, onShow)
    onCleanup(() => {
      disposed = true
      window.removeEventListener(BROWSER_VIEWS_HIDE, onHide)
      window.removeEventListener(BROWSER_VIEWS_SHOW, onShow)
    })
  })

  createEffect(() => {
    if (!props.active) {
      if (boundsFrame !== undefined) {
        cancelAnimationFrame(boundsFrame)
        boundsFrame = undefined
      }
      lastBounds = "hidden"
      isShown = false
      api.browserViewHide(props.tab)
      return
    }
    lastBounds = ""
    isShown = false
    if (browserViewHideReasons.size > 0) return
    scheduleSendBounds()
  })

  createEffect(() => {
    const u = props.url
    if (!u) return
    if (!props.active) return
    if (!internalNavigations.has(props.tab)) return
    if (getBrowserNavState(props.tab)?.url === u) {
      internalNavigations.delete(props.tab)
      return
    }
    void api.browserViewNavigate(props.tab, u)
  })

  onCleanup(() => {
    if (boundsFrame !== undefined) cancelAnimationFrame(boundsFrame)
    window.removeEventListener("scroll", scheduleSendBounds, true)
    observer?.disconnect()
    api.browserViewHide(props.tab)
  })

  return <div ref={containerRef} class="absolute inset-0" />
}
