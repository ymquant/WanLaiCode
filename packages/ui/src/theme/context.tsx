import { createEffect, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { makeEventListener } from "@solid-primitives/event-listener"
import { createSimpleContext } from "../context/helper"
import oc2ThemeJson from "./themes/oc-2.json"
import wanlaiThemeJson from "./themes/wanlai-theme.json"
import { resolveThemeVariant, themeToCss } from "./resolve"
import type { DesktopTheme } from "./types"

export type ColorScheme = "light" | "dark" | "system"
export type ThemeContextProps = {
  defaultTheme?: string
  colorScheme?: ColorScheme
  getSystemMode?: () => Promise<"light" | "dark"> | "light" | "dark"
  onSystemModeChange?: (cb: (mode: "light" | "dark") => void) => () => void
  onThemeApplied?: (theme: DesktopTheme, mode: "light" | "dark", colorScheme: ColorScheme) => Promise<void> | void
}

const STORAGE_KEYS = {
  THEME_ID: "opencode-theme-id",
  COLOR_SCHEME: "opencode-color-scheme",
  THEME_CSS_LIGHT: "opencode-theme-css-light",
  THEME_CSS_DARK: "opencode-theme-css-dark",
} as const

const THEME_STYLE_ID = "oc-theme"
let files: Record<string, () => Promise<{ default: DesktopTheme }>> | undefined
let ids: string[] | undefined
let known: Set<string> | undefined

function getFiles() {
  if (files) return files
  files = import.meta.glob<{ default: DesktopTheme }>("./themes/*.json")
  return files
}

function themeIDs() {
  if (ids) return ids
  const sorted = Object.keys(getFiles())
    .map((path) => path.slice("./themes/".length, -".json".length))
    .sort()
  ids = ["wanlai-theme", ...sorted.filter((id) => id !== "wanlai-theme")]
  return ids
}

function knownThemes() {
  if (known) return known
  known = new Set(themeIDs())
  return known
}

const names: Record<string, string> = {
  "oc-2": "OC-2",
  amoled: "AMOLED",
  aura: "Aura",
  ayu: "Ayu",
  carbonfox: "Carbonfox",
  catppuccin: "Catppuccin",
  "catppuccin-frappe": "Catppuccin Frappe",
  "catppuccin-macchiato": "Catppuccin Macchiato",
  cobalt2: "Cobalt2",
  cursor: "Cursor",
  dracula: "Dracula",
  everforest: "Everforest",
  flexoki: "Flexoki",
  github: "GitHub",
  gruvbox: "Gruvbox",
  kanagawa: "Kanagawa",
  "lucent-orng": "Lucent Orng",
  material: "Material",
  matrix: "Matrix",
  mercury: "Mercury",
  monokai: "Monokai",
  nightowl: "Night Owl",
  nord: "Nord",
  "one-dark": "One Dark",
  onedarkpro: "One Dark Pro",
  opencode: "WanLaiCode",
  orng: "Orng",
  "osaka-jade": "Osaka Jade",
  palenight: "Palenight",
  rosepine: "Rose Pine",
  shadesofpurple: "Shades of Purple",
  solarized: "Solarized",
  synthwave84: "Synthwave '84",
  tokyonight: "Tokyonight",
  vercel: "Vercel",
  vesper: "Vesper",
  "wanlai-theme": "wanlai-theme",
  zenburn: "Zenburn",
}
const oc2Theme = oc2ThemeJson as DesktopTheme
const wanlaiTheme = wanlaiThemeJson as DesktopTheme

function normalize(id: string | null | undefined) {
  return id === "oc-1" ? "oc-2" : id
}

function read(key: string) {
  if (typeof localStorage !== "object") return null
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string) {
  if (typeof localStorage !== "object") return
  try {
    localStorage.setItem(key, value)
  } catch {}
}

function drop(key: string) {
  if (typeof localStorage !== "object") return
  try {
    localStorage.removeItem(key)
  } catch {}
}

function clear() {
  drop(STORAGE_KEYS.THEME_CSS_LIGHT)
  drop(STORAGE_KEYS.THEME_CSS_DARK)
}

function ensureThemeStyleElement(): HTMLStyleElement {
  const existing = document.getElementById(THEME_STYLE_ID) as HTMLStyleElement | null
  if (existing) return existing
  const element = document.createElement("style")
  element.id = THEME_STYLE_ID
  document.head.appendChild(element)
  return element
}

function fallbackSystemMode(): "light" | "dark" {
  if (typeof window !== "object") return "light"
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
}

function applyThemeCss(theme: DesktopTheme, themeId: string, mode: "light" | "dark") {
  const isDark = mode === "dark"
  const variant = isDark ? theme.dark : theme.light
  const tokens = resolveThemeVariant(variant, isDark)
  const css = themeToCss(tokens)

  if (themeId !== "oc-2") {
    write(isDark ? STORAGE_KEYS.THEME_CSS_DARK : STORAGE_KEYS.THEME_CSS_LIGHT, css)
  }

  const fullCss = `:root {
  color-scheme: ${mode};
  --text-mix-blend-mode: ${isDark ? "plus-lighter" : "multiply"};
  ${css}
}`

  document.getElementById("oc-theme-preload")?.remove()
  ensureThemeStyleElement().textContent = fullCss
  document.documentElement.dataset.theme = themeId
  document.documentElement.dataset.colorScheme = mode
}

function cacheThemeVariants(theme: DesktopTheme, themeId: string) {
  if (themeId === "oc-2") return
  for (const mode of ["light", "dark"] as const) {
    const isDark = mode === "dark"
    const variant = isDark ? theme.dark : theme.light
    const tokens = resolveThemeVariant(variant, isDark)
    const css = themeToCss(tokens)
    write(isDark ? STORAGE_KEYS.THEME_CSS_DARK : STORAGE_KEYS.THEME_CSS_LIGHT, css)
  }
}

// 主题上下文初始化逻辑独立成函数，测试可以直接验证系统配色同步行为。
export function createThemeContext(props: ThemeContextProps) {
    const themeId = normalize(read(STORAGE_KEYS.THEME_ID) ?? props.defaultTheme) ?? "wanlai-theme"
    // props.colorScheme 强制锁定配色(如登录窗口固定 light),无视 localStorage / 系统主题切换
    const colorScheme = props.colorScheme ?? (read(STORAGE_KEYS.COLOR_SCHEME) as ColorScheme | null) ?? "system"
    const mode = colorScheme === "system" ? fallbackSystemMode() : colorScheme
    const [store, setStore] = createStore({
      themes: {
        "oc-2": oc2Theme,
        "wanlai-theme": wanlaiTheme,
      } as Record<string, DesktopTheme>,
      themeId,
      colorScheme,
      mode,
      previewThemeId: null as string | null,
      previewScheme: null as ColorScheme | null,
    })

    const loads = new Map<string, Promise<DesktopTheme | undefined>>()

    const load = (id: string) => {
      const next = normalize(id)
      if (!next) return Promise.resolve(undefined)
      const hit = store.themes[next]
      if (hit) return Promise.resolve(hit)
      const pending = loads.get(next)
      if (pending) return pending
      const file = getFiles()[`./themes/${next}.json`]
      if (!file) return Promise.resolve(undefined)
      const task = file()
        .then((mod) => {
          const theme = mod.default
          setStore("themes", next, theme)
          return theme
        })
        .finally(() => {
          loads.delete(next)
        })
      loads.set(next, task)
      return task
    }

    const syncSystemMode = () =>
      Promise.resolve(props.getSystemMode?.() ?? fallbackSystemMode()).then((next) => {
        if (store.previewScheme || store.colorScheme !== "system") return
        if (next !== "light" && next !== "dark") return
        if (store.mode === next) return
        setStore("mode", next)
      })

    const applyTheme = (theme: DesktopTheme, themeId: string, mode: "light" | "dark") => {
      applyThemeCss(theme, themeId, mode)
      const source = store.previewScheme ?? store.colorScheme
      const applied = props.onThemeApplied?.(theme, mode, source)
      if (source !== "system") return

      // Electron 的 nativeTheme.themeSource 通过异步 IPC 切回 system。renderer 的
      // prefers-color-scheme 可能仍是旧值；等 IPC 落定后再用主进程 nativeTheme 校正。
      void Promise.resolve(applied).then(() => {
        if (store.previewScheme || store.colorScheme !== "system") return
        void syncSystemMode()
      })
    }

    const ids = () => {
      const extra = Object.keys(store.themes)
        .filter((id) => !knownThemes().has(id))
        .sort()
      const all = themeIDs()
      if (extra.length === 0) return all
      return [...all, ...extra]
    }

    const loadThemes = () => Promise.all(themeIDs().map(load)).then(() => store.themes)

    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEYS.THEME_ID && e.newValue) {
        const next = normalize(e.newValue)
        if (!next) return
        if (next !== "oc-2" && !knownThemes().has(next) && !store.themes[next]) return
        setStore("themeId", next)
        if (next === "oc-2") {
          clear()
          return
        }
        void load(next).then((theme) => {
          if (!theme || store.themeId !== next) return
          cacheThemeVariants(theme, next)
        })
      }
      if (e.key === STORAGE_KEYS.COLOR_SCHEME && e.newValue && !props.colorScheme) {
        setStore("colorScheme", e.newValue as ColorScheme)
        if (e.newValue === "system") {
          void syncSystemMode()
          return
        }
        setStore("mode", e.newValue as "light" | "dark")
      }
    }

    onMount(() => {
      makeEventListener(window, "storage", onStorage)

      const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)")
      const onMedia = () => {
        if (store.colorScheme !== "system") return
        void syncSystemMode()
      }
      makeEventListener(mediaQuery, "change", onMedia)
      props.onSystemModeChange?.((mode) => {
        if (store.colorScheme !== "system") return
        setStore("mode", mode)
      })

      const rawTheme = read(STORAGE_KEYS.THEME_ID)
      const savedTheme = normalize(rawTheme ?? props.defaultTheme) ?? "wanlai-theme"
      const savedScheme = props.colorScheme ?? (read(STORAGE_KEYS.COLOR_SCHEME) as ColorScheme | null) ?? "system"
      if (rawTheme && rawTheme !== savedTheme) {
        write(STORAGE_KEYS.THEME_ID, savedTheme)
        clear()
      }
      if (savedTheme !== store.themeId) setStore("themeId", savedTheme)
      if (savedScheme !== store.colorScheme) setStore("colorScheme", savedScheme)
      if (savedScheme === "system") void syncSystemMode()
      else setStore("mode", savedScheme)
      void load(savedTheme).then((theme) => {
        if (!theme || store.themeId !== savedTheme) return
        cacheThemeVariants(theme, savedTheme)
      })
    })

    createEffect(() => {
      const theme = store.themes[store.themeId]
      if (!theme) return
      applyTheme(theme, store.themeId, store.mode)
    })

    const setTheme = (id: string) => {
      const next = normalize(id)
      if (!next) {
        console.warn(`Theme "${id}" not found`)
        return
      }
      if (next !== "oc-2" && !knownThemes().has(next) && !store.themes[next]) {
        console.warn(`Theme "${id}" not found`)
        return
      }
      setStore("themeId", next)
      if (next === "oc-2") {
        write(STORAGE_KEYS.THEME_ID, next)
        clear()
        return
      }
      void load(next).then((theme) => {
        if (!theme || store.themeId !== next) return
        cacheThemeVariants(theme, next)
        write(STORAGE_KEYS.THEME_ID, next)
      })
    }

    const setColorScheme = (scheme: ColorScheme) => {
      // 强制锁定配色的窗口(如登录窗口固定 light)忽略切换,避免写入共享 localStorage 污染主窗口的明暗选择
      if (props.colorScheme) return
      setStore("colorScheme", scheme)
      write(STORAGE_KEYS.COLOR_SCHEME, scheme)
      if (scheme === "system") void syncSystemMode()
      else setStore("mode", scheme)
    }

    return {
      themeId: () => store.themeId,
      appliedThemeId: () => store.previewThemeId ?? store.themeId,
      colorScheme: () => store.colorScheme,
      mode: () => store.mode,
      appliedMode: () =>
        store.previewScheme
          ? store.previewScheme === "system"
            ? store.mode
            : store.previewScheme
          : store.mode,
      ids,
      name: (id: string) => names[id] ?? store.themes[id]?.name ?? id,
      loadThemes,
      themes: () => store.themes,
      setTheme,
      setColorScheme,
      registerTheme: (theme: DesktopTheme) => setStore("themes", theme.id, theme),
      previewTheme: (id: string) => {
        const next = normalize(id)
        if (!next) return
        if (next !== "oc-2" && !knownThemes().has(next) && !store.themes[next]) return
        setStore("previewThemeId", next)
        void load(next).then((theme) => {
          if (!theme || store.previewThemeId !== next) return
          const mode = store.previewScheme
            ? store.previewScheme === "system"
              ? store.mode
              : store.previewScheme
            : store.mode
          applyTheme(theme, next, mode)
        })
      },
      previewColorScheme: (scheme: ColorScheme) => {
        setStore("previewScheme", scheme)
        const mode = scheme === "system" ? store.mode : scheme
        const id = store.previewThemeId ?? store.themeId
        void load(id).then((theme) => {
          if (!theme) return
          if ((store.previewThemeId ?? store.themeId) !== id) return
          if (store.previewScheme !== scheme) return
          applyTheme(theme, id, mode)
        })
      },
      commitPreview: () => {
        if (store.previewThemeId) {
          setTheme(store.previewThemeId)
        }
        if (store.previewScheme) {
          setColorScheme(store.previewScheme)
        }
        setStore("previewThemeId", null)
        setStore("previewScheme", null)
      },
      cancelPreview: () => {
        setStore("previewThemeId", null)
        setStore("previewScheme", null)
        void load(store.themeId).then((theme) => {
          if (!theme) return
          applyTheme(theme, store.themeId, store.mode)
        })
      },
    }
}

export const { use: useTheme, provider: ThemeProvider } = createSimpleContext({
  name: "Theme",
  init: createThemeContext,
})
