import { withAlpha } from "@opencode-ai/ui/theme/color"
import { useTheme } from "@opencode-ai/ui/theme/context"
import { resolveThemeVariant } from "@opencode-ai/ui/theme/resolve"
import type { HexColor } from "@opencode-ai/ui/theme/types"
import { showToast } from "@opencode-ai/ui/toast"
import type { FitAddon, Ghostty, Terminal as Term } from "ghostty-web"
import { type ComponentProps, createEffect, createMemo, onCleanup, onMount, splitProps } from "solid-js"
import { SerializeAddon } from "@/addons/serialize"
import { matchKeybind, parseKeybind } from "@/context/command"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useSDK } from "@/context/sdk"
import { useServer } from "@/context/server"
import { terminalFontFamily, useSettings } from "@/context/settings"
import type { LocalPTY } from "@/context/terminal"
import { disposeIfDisposable, getHoveredLinkText } from "@/utils/runtime-adapters"
import { createPerfMeter } from "@/utils/perf-meter"
import {
  flushTerminalWriterWhenVisible,
  type TerminalWriterFlushResult,
  terminalWriter,
} from "@/utils/terminal-writer"
import { terminalWebSocketURL } from "@/utils/terminal-websocket-url"

const TOGGLE_TERMINAL_ID = "terminal.toggle"
const DEFAULT_TOGGLE_TERMINAL_KEYBIND = "ctrl+`"
export interface TerminalProps extends ComponentProps<"div"> {
  pty: LocalPTY
  autoFocus?: boolean
  onSubmit?: () => void
  onCleanup?: (pty: Partial<LocalPTY> & { id: string }) => void
  onConnect?: () => void
  onConnectError?: (error: unknown) => void
  /** PTY 通过 OSC 序列上报的标题（一般是 shell 设置的 user@host 或类似信息） */
  onTitle?: (title: string) => void
}

let shared: Promise<{ mod: typeof import("ghostty-web"); ghostty: Ghostty }> | undefined

const loadGhostty = () => {
  if (shared) return shared
  shared = import("ghostty-web")
    .then(async (mod) => ({ mod, ghostty: await mod.Ghostty.load() }))
    .catch((err) => {
      shared = undefined
      throw err
    })
  return shared
}

type TerminalColors = {
  background: string
  foreground: string
  cursor: string
  selectionBackground: string
  yellow: string
  brightYellow: string
  white: string
  brightWhite: string
}

type RgbColor = {
  r: number
  g: number
  b: number
}

const TERMINAL_MINIMUM_TEXT_CONTRAST = 4.5
const ACCESSIBLE_TERMINAL_BRIGHT_YELLOW: Record<"light" | "dark", HexColor> = {
  light: "#9a6700",
  dark: "#d9a441",
}
const ACCESSIBLE_TERMINAL_WHITE: Record<"light" | "dark", HexColor> = {
  light: "#211e1e",
  dark: "#e5e5e5",
}
const ACCESSIBLE_TERMINAL_BRIGHT_WHITE: Record<"light" | "dark", HexColor> = {
  light: "#211e1e",
  dark: "#ffffff",
}

const DEFAULT_TERMINAL_COLORS: Record<"light" | "dark", TerminalColors> = {
  light: {
    background: "#fcfcfc",
    foreground: "#211e1e",
    cursor: "#211e1e",
    selectionBackground: withAlpha("#211e1e", 0.2),
    yellow: "#FFC508",
    brightYellow: "#FFC508",
    white: "#e5e5e5",
    brightWhite: "#ffffff",
  },
  dark: {
    background: "#191515",
    foreground: "#d4d4d4",
    cursor: "#d4d4d4",
    selectionBackground: withAlpha("#d4d4d4", 0.25),
    yellow: "#d9a441",
    brightYellow: "#d9a441",
    white: "#e5e5e5",
    brightWhite: "#ffffff",
  },
}

const debugTerminal = (...values: unknown[]) => {
  if (!import.meta.env.DEV) return
  console.debug("[terminal]", ...values)
}

const useTerminalUiBindings = (input: {
  container: HTMLDivElement
  term: Term
  cleanups: VoidFunction[]
  handlePointerDown: () => void
  handleLinkClick: (event: MouseEvent) => void
}) => {
  const handleCopy = (event: ClipboardEvent) => {
    const selection = input.term.getSelection()
    if (!selection) return

    const clipboard = event.clipboardData
    if (!clipboard) return

    event.preventDefault()
    clipboard.setData("text/plain", selection)
  }

  const handlePaste = (event: ClipboardEvent) => {
    const clipboard = event.clipboardData
    const text = clipboard?.getData("text/plain") ?? clipboard?.getData("text") ?? ""
    if (!text) return

    event.preventDefault()
    event.stopPropagation()
    input.term.paste(text)
  }

  const handleTextareaFocus = () => {
    input.term.options.cursorBlink = true
  }
  const handleTextareaBlur = () => {
    input.term.options.cursorBlink = false
  }

  input.container.addEventListener("copy", handleCopy, true)
  input.cleanups.push(() => input.container.removeEventListener("copy", handleCopy, true))

  input.container.addEventListener("paste", handlePaste, true)
  input.cleanups.push(() => input.container.removeEventListener("paste", handlePaste, true))

  input.container.addEventListener("pointerdown", input.handlePointerDown)
  input.cleanups.push(() => input.container.removeEventListener("pointerdown", input.handlePointerDown))

  input.container.addEventListener("click", input.handleLinkClick, {
    capture: true,
  })
  input.cleanups.push(() =>
    input.container.removeEventListener("click", input.handleLinkClick, {
      capture: true,
    }),
  )

  input.term.textarea?.addEventListener("focus", handleTextareaFocus)
  input.term.textarea?.addEventListener("blur", handleTextareaBlur)
  input.cleanups.push(() => input.term.textarea?.removeEventListener("focus", handleTextareaFocus))
  input.cleanups.push(() => input.term.textarea?.removeEventListener("blur", handleTextareaBlur))
}

const persistTerminal = (input: {
  term: Term | undefined
  addon: SerializeAddon | undefined
  cursor: number
  id: string
  colors?: TerminalColors
  onCleanup?: (pty: Partial<LocalPTY> & { id: string }) => void
}) => {
  if (!input.addon || !input.onCleanup || !input.term) return
  const buffer = serializeTerminalBuffer(input.addon)

  input.onCleanup({
    id: input.id,
    buffer,
    cursor: input.cursor,
    rows: input.term.rows,
    cols: input.term.cols,
    scrollY: input.term.getViewportY(),
    theme_background: input.colors?.background,
    theme_foreground: input.colors?.foreground,
  })
}

const serializeTerminalBuffer = (addon: SerializeAddon | undefined, excludeModes?: boolean) => {
  if (!addon) return ""
  try {
    return addon.serialize({
      excludeModes,
    })
  } catch {
    debugTerminal("failed to serialize terminal buffer")
    return ""
  }
}

const hexToRgb = (value: string) => {
  const normalized = value.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)
  if (!normalized) return
  const raw = normalized[1].length === 3 ? normalized[1].split("").map((part) => `${part}${part}`).join("") : normalized[1]
  const parsed = Number.parseInt(raw, 16)
  return {
    r: (parsed >> 16) & 0xff,
    g: (parsed >> 8) & 0xff,
    b: parsed & 0xff,
  }
}

const parseColor = (value: string) => {
  const hex = hexToRgb(value)
  if (hex) return hex

  const normalized = value.trim().match(/^rgba?\(([^)]+)\)$/i)
  if (!normalized) return
  const parts = normalized[1].split(",").slice(0, 3).map((part) => Number.parseFloat(part.trim()))
  if (parts.length !== 3 || parts.some((part) => Number.isNaN(part))) return
  return {
    r: Math.max(0, Math.min(255, Math.round(parts[0]!))),
    g: Math.max(0, Math.min(255, Math.round(parts[1]!))),
    b: Math.max(0, Math.min(255, Math.round(parts[2]!))),
  }
}

const colorChannelToLinear = (value: number) => {
  const normalized = value / 255
  if (normalized <= 0.04045) return normalized / 12.92
  return ((normalized + 0.055) / 1.055) ** 2.4
}

const relativeLuminance = (value: RgbColor) => {
  return (
    0.2126 * colorChannelToLinear(value.r) +
    0.7152 * colorChannelToLinear(value.g) +
    0.0722 * colorChannelToLinear(value.b)
  )
}

export const getContrastRatio = (foreground: string, background: string) => {
  const foregroundColor = parseColor(foreground)
  const backgroundColor = parseColor(background)
  if (!foregroundColor || !backgroundColor) return 0
  const foregroundLuminance = relativeLuminance(foregroundColor)
  const backgroundLuminance = relativeLuminance(backgroundColor)
  const lighter = Math.max(foregroundLuminance, backgroundLuminance)
  const darker = Math.min(foregroundLuminance, backgroundLuminance)
  return (lighter + 0.05) / (darker + 0.05)
}

const mixColor = (from: RgbColor, to: RgbColor, ratio: number): RgbColor => {
  return {
    r: Math.round(from.r + (to.r - from.r) * ratio),
    g: Math.round(from.g + (to.g - from.g) * ratio),
    b: Math.round(from.b + (to.b - from.b) * ratio),
  }
}

const rgbToHex = (value: RgbColor) => {
  return `#${value.r.toString(16).padStart(2, "0")}${value.g.toString(16).padStart(2, "0")}${value.b.toString(16).padStart(2, "0")}` as HexColor
}

export const ensureTerminalTextContrast = (input: {
  background: string
  preferred: HexColor
  fallback: HexColor
  minimumContrast?: number
}) => {
  const minimumContrast = input.minimumContrast ?? TERMINAL_MINIMUM_TEXT_CONTRAST
  if (getContrastRatio(input.preferred, input.background) >= minimumContrast) return input.preferred
  if (getContrastRatio(input.fallback, input.background) >= minimumContrast) return input.fallback

  const background = parseColor(input.background)
  const fallback = parseColor(input.fallback)
  if (!background || !fallback) return input.fallback

  const anchor =
    relativeLuminance(background) >= 0.5
      ? { r: 0, g: 0, b: 0 }
      : { r: 255, g: 255, b: 255 }

  let best = input.fallback
  for (let index = 1; index <= 24; index++) {
    const candidate = rgbToHex(mixColor(fallback, anchor, index / 24))
    best = candidate
    if (getContrastRatio(candidate, input.background) >= minimumContrast) return candidate
  }

  return best
}

const stripThemeDependentAnsi = (value: string, colors?: Pick<LocalPTY, "theme_foreground" | "theme_background">) => {
  const foreground = colors?.theme_foreground ? hexToRgb(colors.theme_foreground) : undefined
  const background = colors?.theme_background ? hexToRgb(colors.theme_background) : undefined

  return value.replace(/\u001b\[([0-9;]*)m/g, (match, raw) => {
    if (!raw) return match

    const input = raw.split(";")
    const output: string[] = []

    for (let i = 0; i < input.length; i++) {
      const token = input[i]
      const code = Number.parseInt(token, 10)
      if (Number.isNaN(code)) {
        output.push(token)
        continue
      }

      if ((code >= 30 && code <= 37) || code === 39 || (code >= 90 && code <= 97)) {
        output.push(token)
        continue
      }
      if ((code >= 40 && code <= 47) || code === 49 || (code >= 100 && code <= 107)) {
        output.push(token)
        continue
      }

      if (code === 38) {
        const mode = input[i + 1]
        if (mode === "2" && foreground) {
          const r = Number.parseInt(input[i + 2] ?? "", 10)
          const g = Number.parseInt(input[i + 3] ?? "", 10)
          const b = Number.parseInt(input[i + 4] ?? "", 10)
          if (r === foreground.r && g === foreground.g && b === foreground.b) {
            output.push("39")
            i += 4
            continue
          }
        }
        output.push(token)
        continue
      }

      if (code === 48) {
        const mode = input[i + 1]
        if (mode === "2" && background) {
          const r = Number.parseInt(input[i + 2] ?? "", 10)
          const g = Number.parseInt(input[i + 3] ?? "", 10)
          const b = Number.parseInt(input[i + 4] ?? "", 10)
          if (r === background.r && g === background.g && b === background.b) {
            output.push("49")
            i += 4
            continue
          }
        }
        output.push(token)
        continue
      }

      output.push(token)
    }

    return `\u001b[${output.join(";")}m`
  })
}

export const Terminal = (props: TerminalProps) => {
  const platform = usePlatform()
  const sdk = useSDK()
  const settings = useSettings()
  const theme = useTheme()
  const language = useLanguage()
  const server = useServer()
  const directory = sdk.directory
  const client = sdk.client
  const url = sdk.url
  const auth = server.current?.http
  const username = auth?.username ?? "wanlaicode"
  const password = auth?.password ?? ""
  const sameOrigin = new URL(url, location.href).origin === location.origin
  let container!: HTMLDivElement
  const [local, others] = splitProps(props, [
    "pty",
    "class",
    "classList",
    "autoFocus",
    "onConnect",
    "onConnectError",
    "onTitle",
  ])
  const id = local.pty.id
  const restore = typeof local.pty.buffer === "string" ? local.pty.buffer : ""
  const restoreSize =
    restore &&
      typeof local.pty.cols === "number" &&
      Number.isSafeInteger(local.pty.cols) &&
      local.pty.cols > 0 &&
      typeof local.pty.rows === "number" &&
      Number.isSafeInteger(local.pty.rows) &&
      local.pty.rows > 0
      ? { cols: local.pty.cols, rows: local.pty.rows }
      : undefined
  const scrollY = typeof local.pty.scrollY === "number" ? local.pty.scrollY : undefined
  let ws: WebSocket | undefined
  let term: Term | undefined
  let _ghostty: Ghostty
  let serializeAddon: SerializeAddon
  let fitAddon: FitAddon
  let handleResize: () => void
  let fitFrame: number | undefined
  let sizeTimer: ReturnType<typeof setTimeout> | undefined
  let pendingSize: { cols: number; rows: number } | undefined
  let lastSize: { cols: number; rows: number } | undefined
  let disposed = false
  const cleanups: VoidFunction[] = []
  const start =
    typeof local.pty.cursor === "number" && Number.isSafeInteger(local.pty.cursor) ? local.pty.cursor : undefined
  let cursor = start ?? 0
  let seek = start !== undefined ? start : restore ? -1 : 0
  let output: ReturnType<typeof terminalWriter> | undefined
  let drop: VoidFunction | undefined
  let reconn: ReturnType<typeof setTimeout> | undefined
  let tries = 0
  let themeSignature: string | undefined
  let serializedThemeForeground = local.pty.theme_foreground
  let serializedThemeBackground = local.pty.theme_background
  const perf = createPerfMeter("terminal-output", { enabled: import.meta.env.DEV ? true : undefined })

  const cleanup = () => {
    if (!cleanups.length) return
    const fns = cleanups.splice(0).reverse()
    for (const fn of fns) {
      try {
        fn()
      } catch (err) {
        debugTerminal("cleanup failed", err)
      }
    }
  }

  const scheduleTerminalWrite = (flush: VoidFunction) => {
    if (document.visibilityState !== "visible") {
      const onVisible = () => {
        if (document.visibilityState !== "visible") return
        document.removeEventListener("visibilitychange", onVisible)
        requestAnimationFrame(flush)
      }
      document.addEventListener("visibilitychange", onVisible)
      cleanups.push(() => document.removeEventListener("visibilitychange", onVisible))
      return
    }
    requestAnimationFrame(flush)
  }

  const flushTerminalOutput = (done?: VoidFunction) => {
    if (!output) {
      done?.()
      return
    }
    if (document.visibilityState !== "visible") {
      perf.count("hidden_deferred")
      done?.()
      return
    }
    output.flush(done)
  }

  const flushTerminalOutputWhenVisible = (done: (result: TerminalWriterFlushResult) => void) => {
    if (output && document.visibilityState !== "visible") perf.count("hidden_cleanup_deferred")
    flushTerminalWriterWhenVisible(output, done)
  }

  const pushSize = (cols: number, rows: number) => {
    return client.pty
      .update({
        ptyID: id,
        size: { cols, rows },
      })
      .catch((err) => {
        debugTerminal("failed to sync terminal size", err)
      })
  }

  const getCssColor = (name: string, fallback: string) => {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback
  }

  const getTerminalColors = (): TerminalColors => {
    const mode = theme.appliedMode() === "dark" ? "dark" : "light"
    const fallback = DEFAULT_TERMINAL_COLORS[mode]
    const currentTheme = theme.themes()[theme.themeId()]
    const cssBackground = getCssColor("--background-base", fallback.background)
    const cssText = getCssColor("--text-stronger", fallback.foreground)
    if (!currentTheme) {
      const white = ensureTerminalTextContrast({
        background: cssBackground,
        preferred: fallback.white as HexColor,
        fallback: ACCESSIBLE_TERMINAL_WHITE[mode],
      })
      const brightWhite = ensureTerminalTextContrast({
        background: cssBackground,
        preferred: fallback.brightWhite as HexColor,
        fallback: ACCESSIBLE_TERMINAL_BRIGHT_WHITE[mode],
      })
      const yellow = ensureTerminalTextContrast({
        background: cssBackground,
        preferred: fallback.yellow as HexColor,
        fallback: ACCESSIBLE_TERMINAL_BRIGHT_YELLOW[mode],
      })
      const brightYellow = ensureTerminalTextContrast({
        background: cssBackground,
        preferred: fallback.brightYellow as HexColor,
        fallback: ACCESSIBLE_TERMINAL_BRIGHT_YELLOW[mode],
      })
      return {
        background: cssBackground,
        foreground: cssText,
        cursor: cssText,
        selectionBackground: withAlpha((cssText.startsWith("#") ? cssText : fallback.foreground) as HexColor, mode === "dark" ? 0.25 : 0.2),
        yellow,
        brightYellow,
        white,
        brightWhite,
      }
    }
    const variant = mode === "dark" ? currentTheme.dark : currentTheme.light
    if (!variant?.seeds && !variant?.palette) {
      const white = ensureTerminalTextContrast({
        background: cssBackground,
        preferred: fallback.white as HexColor,
        fallback: ACCESSIBLE_TERMINAL_WHITE[mode],
      })
      const brightWhite = ensureTerminalTextContrast({
        background: cssBackground,
        preferred: fallback.brightWhite as HexColor,
        fallback: ACCESSIBLE_TERMINAL_BRIGHT_WHITE[mode],
      })
      const yellow = ensureTerminalTextContrast({
        background: cssBackground,
        preferred: fallback.yellow as HexColor,
        fallback: ACCESSIBLE_TERMINAL_BRIGHT_YELLOW[mode],
      })
      const brightYellow = ensureTerminalTextContrast({
        background: cssBackground,
        preferred: fallback.brightYellow as HexColor,
        fallback: ACCESSIBLE_TERMINAL_BRIGHT_YELLOW[mode],
      })
      return {
        background: cssBackground,
        foreground: cssText,
        cursor: cssText,
        selectionBackground: withAlpha((cssText.startsWith("#") ? cssText : fallback.foreground) as HexColor, mode === "dark" ? 0.25 : 0.2),
        yellow,
        brightYellow,
        white,
        brightWhite,
      }
    }
    const resolved = resolveThemeVariant(variant, mode === "dark")
    const text = cssText || resolved["text-stronger"] || fallback.foreground
    const background = cssBackground || resolved["background-base"] || fallback.background
    const alpha = mode === "dark" ? 0.25 : 0.2
    const base = text.startsWith("#") ? (text as HexColor) : (fallback.foreground as HexColor)
    const selectionBackground = withAlpha(base, alpha)
    const white = ensureTerminalTextContrast({
      background,
      preferred: fallback.white as HexColor,
      fallback: ACCESSIBLE_TERMINAL_WHITE[mode],
    })
    const brightWhite = ensureTerminalTextContrast({
      background,
      preferred: fallback.brightWhite as HexColor,
      fallback: ACCESSIBLE_TERMINAL_BRIGHT_WHITE[mode],
    })
    const yellow = ensureTerminalTextContrast({
      background,
      preferred: fallback.yellow as HexColor,
      fallback: ACCESSIBLE_TERMINAL_BRIGHT_YELLOW[mode],
    })
    const brightYellow = ensureTerminalTextContrast({
      background,
      preferred: fallback.brightYellow as HexColor,
      fallback: ACCESSIBLE_TERMINAL_BRIGHT_YELLOW[mode],
    })
    return {
      background,
      foreground: text,
      cursor: text,
      selectionBackground,
      yellow,
      brightYellow,
      white,
      brightWhite,
    }
  }

  const terminalColors = createMemo(getTerminalColors)

  const scheduleFit = () => {
    if (disposed) return
    if (!fitAddon) return
    if (fitFrame !== undefined) return

    fitFrame = requestAnimationFrame(() => {
      fitFrame = undefined
      if (disposed) return
      fitAddon.fit()
    })
  }

  const scheduleSize = (cols: number, rows: number) => {
    if (disposed) return
    if (lastSize?.cols === cols && lastSize?.rows === rows) return

    pendingSize = { cols, rows }

    if (!lastSize) {
      lastSize = pendingSize
      void pushSize(cols, rows)
      return
    }

    if (sizeTimer !== undefined) return
    sizeTimer = setTimeout(() => {
      sizeTimer = undefined
      const next = pendingSize
      if (!next) return
      pendingSize = undefined
      if (disposed) return
      if (lastSize?.cols === next.cols && lastSize?.rows === next.rows) return
      lastSize = next
      void pushSize(next.cols, next.rows)
    }, 100)
  }

  const syncTerminalTheme = (colors: TerminalColors) => {
    if (!term) return

    term.options.theme = colors
    container.style.backgroundColor = colors.background
    const element = term.element
    if (element instanceof HTMLElement) {
      element.style.backgroundColor = colors.background
    }

    const canvas = container.querySelector("canvas")
    if (canvas instanceof HTMLCanvasElement) {
      canvas.style.backgroundColor = colors.background
    }

    const renderer = term.renderer
    const wasmTerm = term.wasmTerm
    if (!renderer || !wasmTerm) return
    renderer.setTheme(colors)
    renderer.clear()
    renderer.render(wasmTerm, true, term.getViewportY(), term)
  }

  const rebuildTerminalTheme = async (colors: TerminalColors) => {
    if (!term || !serializeAddon) return

    const snapshot = stripThemeDependentAnsi(serializeTerminalBuffer(serializeAddon, true), {
      theme_background: serializedThemeBackground,
      theme_foreground: serializedThemeForeground,
    })
    const viewportY = term.getViewportY()

    term.options.theme = colors
    term.reset()
    syncTerminalTheme(colors)
    serializedThemeBackground = colors.background
    serializedThemeForeground = colors.foreground
    if (snapshot) {
      await new Promise<void>((resolve) => term?.write(snapshot, resolve))
    }
    if (viewportY !== undefined) term.scrollToLine(viewportY)
  }

  createEffect(() => {
    const colors = terminalColors()
    if (!term) return
    const nextSignature = JSON.stringify(colors)
    if (!themeSignature) {
      themeSignature = nextSignature
      syncTerminalTheme(colors)
      return
    }
    if (themeSignature === nextSignature) return
    themeSignature = nextSignature
    void rebuildTerminalTheme(colors)
  })

  createEffect(() => {
    const font = terminalFontFamily(settings.appearance.terminalFont())
    if (!term) return
    term.options.fontFamily = font
    scheduleFit()
  })

  let zoom = platform.webviewZoom?.()
  createEffect(() => {
    const next = platform.webviewZoom?.()
    if (next === undefined) return
    if (next === zoom) return
    zoom = next
    scheduleFit()
  })

  const focusTerminal = () => {
    const t = term
    if (!t) return
    t.focus()
    t.textarea?.focus()
    setTimeout(() => t.textarea?.focus(), 0)
  }
  const handlePointerDown = () => {
    const activeElement = document.activeElement
    if (activeElement instanceof HTMLElement && activeElement !== container && !container.contains(activeElement)) {
      activeElement.blur()
    }
    focusTerminal()
  }

  const handleLinkClick = (event: MouseEvent) => {
    if (!event.shiftKey && !event.ctrlKey && !event.metaKey) return
    if (event.altKey) return
    if (event.button !== 0) return

    const t = term
    if (!t) return

    const text = getHoveredLinkText(t)
    if (!text) return

    event.preventDefault()
    event.stopImmediatePropagation()
    platform.openLink(text)
  }

  onMount(() => {
    const run = async () => {
      const loaded = await loadGhostty()
      if (disposed) return

      const mod = loaded.mod
      const g = loaded.ghostty

      const t = new mod.Terminal({
        cursorBlink: true,
        cursorStyle: "bar",
        cols: restoreSize?.cols,
        rows: restoreSize?.rows,
        fontSize: 13,
        fontFamily: terminalFontFamily(settings.appearance.terminalFont()),
        allowTransparency: false,
        convertEol: false,
        theme: terminalColors(),
        scrollback: 10_000,
        ghostty: g,
      })
      cleanups.push(() => t.dispose())
      if (disposed) {
        cleanup()
        return
      }
      _ghostty = g
      term = t
      output = terminalWriter((data, done) => {
        const started = performance.now()
        t.write(data, () => {
          perf.count("write")
          perf.count("write_chars", data.length)
          perf.observe("write_ms", performance.now() - started)
          perf.observe("write_size", data.length)
          done?.()
        })
      }, scheduleTerminalWrite)

      t.attachCustomKeyEventHandler((event) => {
        const key = event.key.toLowerCase()

        if (event.ctrlKey && event.shiftKey && !event.metaKey && key === "c") {
          document.execCommand("copy")
          return true
        }

        // allow for toggle terminal keybinds in parent
        const config = settings.keybinds.get(TOGGLE_TERMINAL_ID) ?? DEFAULT_TOGGLE_TERMINAL_KEYBIND
        const keybinds = parseKeybind(config)

        return matchKeybind(keybinds, event)
      })

      const fit = new mod.FitAddon()
      const serializer = new SerializeAddon()
      cleanups.push(() => disposeIfDisposable(fit))
      t.loadAddon(serializer)
      t.loadAddon(fit)
      fitAddon = fit
      serializeAddon = serializer

      t.open(container)
      serializedThemeBackground = terminalColors().background
      serializedThemeForeground = terminalColors().foreground
      themeSignature = JSON.stringify(terminalColors())
      syncTerminalTheme(terminalColors())
      useTerminalUiBindings({
        container,
        term: t,
        cleanups,
        handlePointerDown,
        handleLinkClick,
      })

      if (local.autoFocus !== false) focusTerminal()

      if (typeof document !== "undefined" && document.fonts) {
        void document.fonts.ready.then(scheduleFit)
      }

      const onResize = t.onResize((size) => {
        scheduleSize(size.cols, size.rows)
      })
      cleanups.push(() => disposeIfDisposable(onResize))
      const onData = t.onData((data) => {
        if (ws?.readyState === WebSocket.OPEN) ws.send(data)
      })
      cleanups.push(() => disposeIfDisposable(onData))
      const onKey = t.onKey((key) => {
        if (key.key == "Enter") {
          props.onSubmit?.()
        }
      })
      cleanups.push(() => disposeIfDisposable(onKey))

      // 监听 shell 通过 OSC 序列设置的标题（如 `\x1b]0;user@host\x07`）
      const onTitleChange = t.onTitleChange((title) => {
        const trimmed = typeof title === "string" ? title.trim() : ""
        if (!trimmed) return
        local.onTitle?.(trimmed)
      })
      cleanups.push(() => disposeIfDisposable(onTitleChange))

      const startResize = () => {
        fit.observeResize()
        handleResize = scheduleFit
        window.addEventListener("resize", handleResize)
        cleanups.push(() => window.removeEventListener("resize", handleResize))
      }

      const write = (data: string) =>
        new Promise<void>((resolve) => {
          if (!output) {
            resolve()
            return
          }
          output.push(data)
          perf.observe("pending_chars", output.pending())
          flushTerminalOutput(resolve)
        })

      const restoredBuffer = restore
        ? stripThemeDependentAnsi(restore, {
            theme_background: local.pty.theme_background,
            theme_foreground: local.pty.theme_foreground,
          })
        : ""

      if (restoredBuffer && restoreSize) {
        await write(restoredBuffer)
        fit.fit()
        scheduleSize(t.cols, t.rows)
        if (scrollY !== undefined) t.scrollToLine(scrollY)
        startResize()
      } else {
        fit.fit()
        scheduleSize(t.cols, t.rows)
        if (restoredBuffer) {
          await write(restoredBuffer)
          if (scrollY !== undefined) t.scrollToLine(scrollY)
        }
        startResize()
      }

      const once = { value: false }
      const decoder = new TextDecoder()

      const fail = (err: unknown) => {
        if (disposed) return
        if (once.value) return
        once.value = true
        local.onConnectError?.(err)
      }

      const gone = () =>
        client.pty
          .get({ ptyID: id }, { throwOnError: false })
          .then((result) => result.response.status === 404)
          .catch((err) => {
            debugTerminal("failed to inspect terminal session", err)
            return false
          })

      const connectToken = async () => {
        const result = await client.pty
          .connectToken(
            { ptyID: id, directory },
            {
              throwOnError: false,
              headers: { "x-opencode-ticket": "1" },
            },
          )
          .catch((err: unknown) => {
            if (err instanceof Error && err.message.includes("Request is not supported")) return
            throw err
          })
        if (!result) return
        if (result.response.status === 200 && result.data?.ticket) return result.data.ticket
        if (result.response.status === 404 || result.response.status === 405) return
        if (result.response.status === 403)
          throw new Error("PTY connect ticket rejected by origin or CSRF checks. Check the server CORS config.")
        throw new Error(`PTY connect ticket failed with ${result.response.status}`)
      }

      const retry = (err: unknown) => {
        if (disposed) return
        if (reconn !== undefined) return

        const ms = Math.min(250 * 2 ** Math.min(tries, 4), 4_000)
        reconn = setTimeout(async () => {
          reconn = undefined
          if (disposed) return
          if (await gone()) {
            if (disposed) return
            fail(err)
            return
          }
          if (disposed) return
          tries += 1
          open()
        }, ms)
      }

      const open = async () => {
        if (disposed) return
        drop?.()

        const ticket = await connectToken().catch((err) => {
          fail(err)
          return undefined
        })
        if (once.value) return
        if (disposed) return

        const socket = new WebSocket(
          terminalWebSocketURL({
            url,
            id,
            directory,
            cursor: seek,
            ticket,
            sameOrigin,
            username,
            password,
            authToken: server.current?.type === "http" ? server.current.authToken : false,
          }),
        )
        socket.binaryType = "arraybuffer"
        ws = socket

        const handleOpen = () => {
          if (disposed) return
          tries = 0
          local.onConnect?.()
          scheduleSize(t.cols, t.rows)
        }

        const handleMessage = (event: MessageEvent) => {
          if (disposed) return
          if (event.data instanceof ArrayBuffer) {
            const bytes = new Uint8Array(event.data)
            if (bytes[0] !== 0) return
            const json = decoder.decode(bytes.subarray(1))
            try {
              const meta = JSON.parse(json) as { cursor?: unknown }
              const next = meta?.cursor
              if (typeof next === "number" && Number.isSafeInteger(next) && next >= 0) {
                cursor = next
                seek = next
              }
            } catch (err) {
              debugTerminal("invalid websocket control frame", err)
            }
            return
          }

          const data = typeof event.data === "string" ? event.data : ""
          if (!data) return
          perf.count("ws_message")
          perf.count("ws_chars", data.length)
          output?.push(data)
          if (output) perf.observe("pending_chars", output.pending())
          cursor += data.length
          seek = cursor
        }

        const handleError = (error: Event) => {
          if (disposed) return
          debugTerminal("websocket error", error)
        }

        const stop = () => {
          socket.removeEventListener("open", handleOpen)
          socket.removeEventListener("message", handleMessage)
          socket.removeEventListener("error", handleError)
          socket.removeEventListener("close", handleClose)
          if (ws === socket) ws = undefined
          if (drop === stop) drop = undefined
          if (socket.readyState !== WebSocket.CLOSED && socket.readyState !== WebSocket.CLOSING) socket.close(1000)
        }

        const handleClose = (event: CloseEvent) => {
          if (ws === socket) ws = undefined
          if (drop === stop) drop = undefined
          socket.removeEventListener("open", handleOpen)
          socket.removeEventListener("message", handleMessage)
          socket.removeEventListener("error", handleError)
          socket.removeEventListener("close", handleClose)
          if (disposed) return
          if (event.code === 1000) return
          retry(new Error(language.t("terminal.connectionLost.abnormalClose", { code: event.code })))
        }

        drop = stop
        socket.addEventListener("open", handleOpen)
        socket.addEventListener("message", handleMessage)
        socket.addEventListener("error", handleError)
        socket.addEventListener("close", handleClose)
      }

      open()
    }

    void run().catch((err) => {
      if (disposed) return
      showToast({
        variant: "error",
        title: language.t("terminal.connectionLost.title"),
        description: err instanceof Error ? err.message : language.t("terminal.connectionLost.description"),
      })
      local.onConnectError?.(err)
    })
  })

  onCleanup(() => {
    disposed = true
    if (fitFrame !== undefined) cancelAnimationFrame(fitFrame)
    if (sizeTimer !== undefined) clearTimeout(sizeTimer)
    if (reconn !== undefined) clearTimeout(reconn)
    drop?.()
    if (ws && ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) ws.close(1000)

    const finalize = (result?: TerminalWriterFlushResult) => {
      const droppedChars = result?.status === "timeout" ? result.droppedChars : 0
      if (droppedChars > 0) perf.count("hidden_cleanup_dropped_chars", droppedChars)
      persistTerminal({
        term,
        addon: serializeAddon,
        cursor: Math.max(start ?? 0, cursor - droppedChars),
        id,
        colors: terminalColors(),
        onCleanup: props.onCleanup,
      })
      cleanup()
      perf.close()
    }

    if (!output) {
      finalize()
      return
    }

    flushTerminalOutputWhenVisible(finalize)
  })

  return (
    <div
      ref={container}
      data-component="terminal"
      data-prevent-autofocus
      tabIndex={-1}
      style={{ "background-color": terminalColors().background }}
      classList={{
        ...local.classList,
        "select-text": true,
        "size-full px-6 py-3 font-mono relative overflow-hidden": true,
        [local.class ?? ""]: !!local.class,
      }}
      {...others}
    />
  )
}
