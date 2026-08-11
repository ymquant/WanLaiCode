import { MetaProvider } from "@solidjs/meta"
import { render } from "solid-js/web"
import "@opencode-ai/app/index.css"
import { Font } from "@opencode-ai/ui/font"
import "./styles.css"
import { Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import type { InitStep, SqliteMigrationProgress } from "../preload/types"
import { initI18n, t } from "./i18n"

const root = document.getElementById("root")!
const lines = ["Just a moment...", "Migrating your database", "This may take a couple of minutes"]
const delays = [3000, 9000]

const detectDesktopOs = () => {
  const ua = navigator.userAgent
  if (ua.includes("Mac")) return "macos"
  if (ua.includes("Windows")) return "windows"
  if (ua.includes("Linux")) return "linux"
  return undefined
}

const os = detectDesktopOs()
if (os) document.documentElement.dataset.desktopOs = os

function LoadingLogo() {
  return (
    <svg
      data-slot="desktop-loading-logo-svg"
      viewBox="0 0 520 420"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      shape-rendering="geometricPrecision"
      aria-hidden="true"
    >
      <defs>
        <g id="desktop-loading-logo-glyph">
          <polygon points="64,210 104,170 184,250 264,170 344,250 424,170 464,210 424,250 344,330 264,250 184,330 104,250" />
          <polygon points="264,40 304,80 264,120 224,80" />
          <polygon points="184,120 224,160 184,200 144,160" />
          <polygon points="344,120 384,160 344,200 304,160" />
          <polygon points="264,330 304,370 264,410 224,370" />
        </g>
      </defs>
      <use data-slot="desktop-loading-logo-sketch" href="#desktop-loading-logo-glyph" />
    </svg>
  )
}

render(() => {
  const [step, setStep] = createSignal<InitStep | null>(null)
  const [line, setLine] = createSignal(0)
  const [percent, setPercent] = createSignal(0)
  // t() 本身不是响应式的，语言载入完成后靠这个信号触发一次重算
  const [localeRev, setLocaleRev] = createSignal(0)
  void initI18n().then(() => setLocaleRev((rev) => rev + 1))

  const phase = createMemo(() => step()?.phase)
  const unreachable = createMemo(() => phase() === "server_unreachable")
  const notice = createMemo(() => {
    localeRev()
    return {
      title: t("desktop.loading.sidecar.slow.title"),
      hint: t("desktop.loading.sidecar.slow.hint"),
    }
  })

  const value = createMemo(() => {
    if (phase() === "done") return 100
    return Math.max(25, Math.min(100, percent()))
  })

  window.api.awaitInitialization((next) => setStep(next as InitStep)).catch(() => undefined)

  onMount(() => {
    setLine(0)
    setPercent(0)

    const timers = delays.map((ms, i) => setTimeout(() => setLine(i + 1), ms))

    const listener = window.api.onSqliteMigrationProgress((progress: SqliteMigrationProgress) => {
      if (progress.type === "InProgress") setPercent(Math.max(0, Math.min(100, progress.value)))
      if (progress.type === "Done") {
        setPercent(100)
        setStep({ phase: "done" })
      }
    })

    onCleanup(() => {
      listener()
      timers.forEach(clearTimeout)
    })
  })

  createEffect(() => {
    if (phase() !== "done") return

    const timer = setTimeout(() => window.api.loadingWindowComplete(), 1000)
    onCleanup(() => clearTimeout(timer))
  })

  const status = createMemo(() => {
    if (phase() === "done") return "All done"
    if (unreachable()) return notice().title
    if (phase() === "sqlite_waiting") return lines[line()]
    return "Just a moment..."
  })

  return (
    <MetaProvider>
      <div data-component="desktop-loading-root" class="w-screen h-screen flex flex-col items-center justify-center">
        <Font />
        <div data-component="desktop-loading-glass" aria-live="polite">
          <div data-slot="desktop-loading-logo">
            <LoadingLogo />
            <span data-slot="desktop-loading-logo-sweep" aria-hidden="true" />
          </div>
          <span class="sr-only">
            {status()} {Math.round(value())}%
          </span>
        </div>
        <Show when={unreachable()}>
          <div data-slot="desktop-loading-notice" role="status">
            <p data-slot="desktop-loading-notice-title">{notice().title}</p>
            <p data-slot="desktop-loading-notice-hint">{notice().hint}</p>
          </div>
        </Show>
      </div>
    </MetaProvider>
  )
}, root)
