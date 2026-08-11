import { batch, createMemo, onCleanup, onMount, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"
import { makeEventListener } from "@solid-primitives/event-listener"
import { createMediaQuery } from "@solid-primitives/media"
import type { Message } from "@opencode-ai/sdk/v2/client"
import { same } from "@/utils/same"

/** 桌面端最小窗口可至 480px；Web 仍用 768px md 布局。 */
export const SESSION_DESKTOP_APP_MEDIA = "(min-width: 480px)"
export const SESSION_DESKTOP_WEB_MEDIA = "(min-width: 768px)"

export function createSessionDesktopLayout(platform: { platform: string }) {
  const web = createMediaQuery(SESSION_DESKTOP_WEB_MEDIA)
  const app = createMediaQuery(SESSION_DESKTOP_APP_MEDIA)
  return createMemo(() => (platform.platform === "desktop" ? app() : web()))
}

export function createSessionChromeVisible(
  platform: { platform: string },
  isDesktop: Accessor<boolean>,
  reviewLayoutControlsVisible: Accessor<boolean>,
) {
  return createMemo(() => (platform.platform === "desktop" ? isDesktop() : reviewLayoutControlsVisible()))
}

const emptyTabs: string[] = []

type Tabs = {
  active: Accessor<string | undefined>
  all: Accessor<string[]>
}

type TabsInput = {
  tabs: Accessor<Tabs>
  pathFromTab: (tab: string) => string | undefined
  normalizeTab: (tab: string) => string
  review?: Accessor<boolean>
  hasReview?: Accessor<boolean>
}

export const getSessionKey = (dir: string | undefined, id: string | undefined) => `${dir ?? ""}${id ? `/${id}` : ""}`

// 「有活才起表」判据：和 session.tsx:3542-3561 / sidebar-items.tsx:180-191 同一套守卫 ——
// status 尚未从 bootstrap 加载下来(undefined)且没有任何未收尾 assistant 时，没有必要起 1Hz 定时器
// 唤醒渲染；抽成纯函数供 message-timeline.tsx 的 createEffect 守卫和测试共用。
export const runStateTimerShouldRun = (input: {
  statusLoaded: boolean
  messages: readonly { role: Message["role"]; time: { created: number; completed?: number } }[]
}) => {
  if (input.statusLoaded) return true
  return input.messages.some((message) => message.role === "assistant" && typeof message.time?.completed !== "number")
}

export const sessionMessageRenderState = (input: { messagesReady: boolean; syncError: unknown }) => ({
  timeline: input.messagesReady,
  staleError: input.messagesReady && !!input.syncError,
  loading: !input.messagesReady && !input.syncError,
  blockingError: !input.messagesReady && !!input.syncError,
})

export const runSessionSyncRetry = async (input: {
  sessionID: string
  sync: (sessionID: string, opts: { force: true }) => Promise<unknown>
  refetch: () => unknown
  beforeSync?: () => void
  activeSessionID?: () => string | undefined
}) => {
  input.beforeSync?.()
  await input.sync(input.sessionID, { force: true })
  if (input.activeSessionID && input.activeSessionID() !== input.sessionID) return
  input.refetch()
}

export const runSessionSyncAutoRetry = async (input: {
  sessionID: string
  retry: () => Promise<unknown>
  delays?: number[]
  sleep?: (delay: number) => Promise<void>
  activeSessionID?: () => string | undefined
}) => {
  const delays = input.delays ?? [2000, 4000, 6000]
  const sleep = input.sleep ?? ((delay) => new Promise<void>((resolve) => setTimeout(resolve, delay)))

  for (const delay of delays) {
    await sleep(delay)
    if (input.activeSessionID && input.activeSessionID() !== input.sessionID) return
    try {
      await input.retry()
      return
    } catch {
      continue
    }
  }
}

export const consumeSessionSyncDebugError = (input: {
  enabled: boolean
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">
}) => {
  if (!input.enabled) return false
  const value = input.storage.getItem("debug-sync-error")
  if (!value) return false
  const count = Number(value)
  if (!Number.isFinite(count) || count <= 0) {
    input.storage.removeItem("debug-sync-error")
    return false
  }
  if (count <= 1) input.storage.removeItem("debug-sync-error")
  else input.storage.setItem("debug-sync-error", String(count - 1))
  return true
}

export const createSessionTabs = (input: TabsInput) => {
  const review = input.review ?? (() => false)
  const hasReview = input.hasReview ?? (() => false)
  const contextOpen = createMemo(() => input.tabs().active() === "context" || input.tabs().all().includes("context"))
  const openedTabs = createMemo(
    () => {
      const seen = new Set<string>()
      return input
        .tabs()
        .all()
        .flatMap((tab) => {
          if (tab === "context" || tab === "review") return []
          const value = input.pathFromTab(tab) ? input.normalizeTab(tab) : tab
          if (seen.has(value)) return []
          seen.add(value)
          return [value]
        })
    },
    emptyTabs,
    { equals: same },
  )
  const activeTab = createMemo(() => {
    const active = input.tabs().active()
    if (active === "context") return active
    if (active === "review" && review()) return active
    if (active && active.startsWith("browser:")) return active
    if (active && active.startsWith("project-files:")) return active
    if (active && input.pathFromTab(active)) return input.normalizeTab(active)

    const first = openedTabs()[0]
    if (first) return first
    if (contextOpen()) return "context"
    if (review() && hasReview()) return "review"
    return "empty"
  })
  const activeFileTab = createMemo(() => {
    const active = activeTab()
    if (active.startsWith("browser:")) return
    if (active.startsWith("project-files:")) return
    if (!openedTabs().includes(active)) return
    return active
  })
  const activeBrowserTab = createMemo(() => {
    const active = activeTab()
    if (!active.startsWith("browser:")) return
    return active
  })
  const closableTab = createMemo(() => {
    const active = activeTab()
    if (active === "context") return active
    if (!openedTabs().includes(active)) return
    return active
  })

  return {
    contextOpen,
    openedTabs,
    activeTab,
    activeFileTab,
    activeBrowserTab,
    closableTab,
  }
}

export const focusTerminalById = (id: string) => {
  const wrapper = document.getElementById(`terminal-wrapper-${id}`)
  const terminal = wrapper?.querySelector('[data-component="terminal"]')
  if (!(terminal instanceof HTMLElement)) return false

  const textarea = terminal.querySelector("textarea")
  if (textarea instanceof HTMLTextAreaElement) {
    textarea.focus()
    return true
  }

  terminal.focus()
  terminal.dispatchEvent(
    typeof PointerEvent === "function"
      ? new PointerEvent("pointerdown", { bubbles: true, cancelable: true })
      : new MouseEvent("pointerdown", { bubbles: true, cancelable: true }),
  )
  return true
}

const skip = new Set(["Alt", "Control", "Meta", "Shift"])

export const shouldFocusTerminalOnKeyDown = (event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey">) => {
  if (skip.has(event.key)) return false
  return !(event.ctrlKey || event.metaKey || event.altKey)
}

export const createOpenReviewFile = (input: {
  showAllFiles: () => void
  tabForPath: (path: string) => string
  openTab: (tab: string) => void
  setActive: (tab: string) => void
  loadFile: (path: string) => any | Promise<void>
}) => {
  return (path: string) => {
    batch(() => {
      input.showAllFiles()
      const maybePromise = input.loadFile(path)
      const open = () => {
        const tab = input.tabForPath(path)
        input.openTab(tab)
        input.setActive(tab)
      }
      if (maybePromise instanceof Promise) void maybePromise.then(open)
      else open()
    })
  }
}

export const createOpenSessionFileTab = (input: {
  normalizeTab: (tab: string) => string
  openTab: (tab: string, opts?: { preview?: boolean }) => void
  pathFromTab: (tab: string) => string | undefined
  loadFile: (path: string) => void
  openReviewPanel: () => void
  setActive: (tab: string) => void
  allTabs?: () => string[]
}) => {
  return (value: string, opts?: { preview?: boolean }) => {
    const next = input.normalizeTab(value)
    if (!input.allTabs?.().includes(next)) input.openTab(next, opts)

    const path = input.pathFromTab(next)
    if (!path) {
      input.setActive(next)
      return
    }

    input.loadFile(path)
    input.openReviewPanel()
    input.setActive(next)
  }
}

export const getTabReorderIndex = (tabs: readonly string[], from: string, to: string) => {
  const fromIndex = tabs.indexOf(from)
  const toIndex = tabs.indexOf(to)
  if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) return undefined
  return toIndex
}

export const createSizing = () => {
  const [state, setState] = createStore({ active: false })
  let t: number | undefined

  const stop = () => {
    if (t !== undefined) {
      clearTimeout(t)
      t = undefined
    }
    setState("active", false)
  }

  const start = () => {
    if (t !== undefined) {
      clearTimeout(t)
      t = undefined
    }
    setState("active", true)
  }

  onMount(() => {
    makeEventListener(window, "pointerup", stop)
    makeEventListener(window, "pointercancel", stop)
    makeEventListener(window, "blur", stop)
  })

  onCleanup(() => {
    if (t !== undefined) clearTimeout(t)
  })

  return {
    active: () => state.active,
    start,
    touch() {
      start()
      t = window.setTimeout(stop, 120)
    },
  }
}

export type Sizing = ReturnType<typeof createSizing>
