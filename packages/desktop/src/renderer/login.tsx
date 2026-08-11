// @refresh reload

import {
  AppBaseProviders,
  AppInterface,
  loadLocaleDict,
  normalizeLocale,
  type Locale,
  type Platform,
  PlatformProvider,
  ServerConnection,
} from "@opencode-ai/app"
import { WanlaiCodeLoginPage } from "../../../app/src/components/wanlaicode-login-gate"
import { MemoryRouter } from "@solidjs/router"
import type { AsyncStorage } from "@solid-primitives/storage"
import { createEffect, createResource, onCleanup, onMount, Show, type ParentProps } from "solid-js"
import { render } from "solid-js/web"
import pkg from "../../package.json"
import { initI18n, t } from "./i18n"
import "./styles.css"

const root = document.getElementById("root")
if (import.meta.env.DEV && !(root instanceof HTMLElement)) {
  throw new Error(t("error.dev.rootNotFound"))
}

void initI18n()

document.documentElement.style.setProperty("--windows-statusbar-bg", "#ffffff")

const createStorage = () => {
  const cache = new Map<string, AsyncStorage>()
  return (name = "default.dat") => {
    const cached = cache.get(name)
    if (cached) return cached
    const api: AsyncStorage = {
      getItem: (key: string) => window.api.storeGet(name, key),
      setItem: (key: string, value: string) => window.api.storeSet(name, key, value),
      removeItem: (key: string) => window.api.storeDelete(name, key),
      clear: () => window.api.storeClear(name),
      key: async (index: number) => (await window.api.storeKeys(name))[index],
      getLength: () => window.api.storeLength(name),
      get length() {
        return api.getLength()
      },
    }
    cache.set(name, api)
    return api
  }
}

const loadLocale = async (platform: Platform) => {
  const current = await platform.storage?.("opencode.global.dat").getItem("language")
  const legacy = current ? undefined : await platform.storage?.().getItem("language.v1")
  const raw = current ?? legacy
  if (!raw) return
  const locale = raw.match(/"locale"\s*:\s*"([^"]+)"/)?.[1]
  if (!locale) return
  const next = normalizeLocale(locale)
  if (next !== "en") await loadLocaleDict(next)
  return next satisfies Locale
}

const createPlatform = (): Platform => {
  const os = (() => {
    const ua = navigator.userAgent
    if (ua.includes("Mac")) return "macos"
    if (ua.includes("Windows")) return "windows"
    if (ua.includes("Linux")) return "linux"
    return undefined
  })()

  return {
    platform: "desktop",
    os,
    version: pkg.version,
    storage: createStorage(),
    openLink: (url: string) => window.api.openLink(url),
    openSystemBrowserLink: (url: string) => window.api.openSystemBrowserLink(url),
    openMainWindow: () => window.api.openMainWindow(),
    back: () => window.history.back(),
    forward: () => window.history.forward(),
    restart: async () => window.api.relaunch(),
    windowAction: (action) => window.api.windowAction(action),
    getDefaultServer: async () => ServerConnection.Key.make("sidecar"),
    setDefaultServer: async () => undefined,
    notify: async () => undefined,
    fetch: (input, init) => {
      return fetch(input, init)
    },
  }
}

const LoginRoot = (props: ParentProps<{ appChildren?: unknown }>) => <>{props.appChildren}</>

render(() => {
  const platform = createPlatform()
  const [sidecar] = createResource(() => window.api.awaitInitialization(() => undefined))
  const [locale] = createResource(() => loadLocale(platform))

  onMount(() => {
    const handler = () => {
      document.documentElement.style.setProperty("--windows-statusbar-bg", "#ffffff")
      void window.api.setBackgroundColor("#ffffff")
    }
    document.addEventListener("visibilitychange", handler)
    handler()
    onCleanup(() => document.removeEventListener("visibilitychange", handler))
  })

  const servers = () => {
    const data = sidecar()
    if (!data) return []
    return [
      {
        displayName: "Local Server",
        type: "sidecar" as const,
        variant: "base" as const,
        http: {
          url: data.url,
          username: data.username ?? undefined,
          password: data.password ?? undefined,
        },
      },
    ]
  }

  return (
    <PlatformProvider value={platform}>
      <AppBaseProviders locale={locale.latest} colorScheme="light">
        <Show when={!sidecar.loading && !locale.loading}>
          <AppInterface
            defaultServer={ServerConnection.Key.make("sidecar")}
            servers={servers()}
            skipStartupHealthGate
            router={MemoryRouter}
            root={LoginRoot}
          >
            <WanlaiCodeLoginPage />
          </AppInterface>
        </Show>
      </AppBaseProviders>
    </PlatformProvider>
  )
}, root!)
