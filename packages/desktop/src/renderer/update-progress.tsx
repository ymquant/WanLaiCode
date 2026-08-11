import { MetaProvider } from "@solidjs/meta"
import { render } from "solid-js/web"
import "@opencode-ai/app/index.css"
import { Button } from "@opencode-ai/ui/button"
import { Font } from "@opencode-ai/ui/font"
import { Mark } from "@opencode-ai/ui/logo"
import { Progress } from "@opencode-ai/ui/progress"
import "./styles.css"
import { createMemo, createSignal, Match, onCleanup, onMount, Show, Switch } from "solid-js"
import type { UpdateProgress } from "../preload/types"
import { initI18n, t } from "./i18n"

const root = document.getElementById("root")!

// 1024 进制；MB 之前展示一位小数，KB/B 取整避免「1023.4 KB」这种冗余精度。
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B"
  const units = ["B", "KB", "MB", "GB", "TB"]
  let value = bytes
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  const fractionDigits = i >= 2 ? 1 : 0
  return `${value.toFixed(fractionDigits)} ${units[i]}`
}

function formatSpeed(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond)}/s`
}

render(() => {
  const [progress, setProgress] = createSignal<UpdateProgress>({ phase: "preparing" })
  const [ready, setReady] = createSignal(false)

  void initI18n().finally(() => setReady(true))

  onMount(() => {
    const off = window.api.onUpdateProgress((next) => setProgress(next))
    // frameless 窗口没有原生关闭，installing 阶段 Cancel 又是 disabled；
    // 任何阶段 Esc 都允许关窗，避免极端路径（quitAndInstall 挂起、OS 拒退）下用户被困
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return
      e.preventDefault()
      void window.api.closeUpdateWindow()
    }
    window.addEventListener("keydown", onKey)
    onCleanup(() => {
      off()
      window.removeEventListener("keydown", onKey)
    })
  })

  const phase = createMemo(() => progress().phase)

  const percent = createMemo(() => {
    const p = progress()
    if (p.phase === "downloading") return Math.max(0, Math.min(100, p.percent))
    if (p.phase === "installing") return 100
    // confirm-install 阶段把进度条拉满表示「已下完，待用户确认」，跟 installing 视觉一致。
    if (p.phase === "confirm-install") return 100
    return 0
  })

  const status = createMemo(() => {
    if (!ready()) return ""
    const p = progress()
    if (p.phase === "preparing") return t("desktop.updater.progress.preparing")
    if (p.phase === "downloading") return t("desktop.updater.progress.downloading")
    if (p.phase === "installing") return t("desktop.updater.progress.installing")
    if (p.phase === "confirm-install") return t("desktop.updater.progress.confirmInstallTitle")
    if (p.phase === "error") return t("desktop.updater.progress.failed")
    if (p.phase === "cancelled") return t("desktop.updater.progress.cancelled")
    return ""
  })

  // 原始 error.message 多半是 net:: 之类英文技术串，对终端用户没价值；
  // 翻译过的「更新失败」做主文案，原文降级到副标题，保留排错线索。
  // confirm-install 阶段副标题展示"有 N 个会话仍在工作，立即重启会中断它们"。
  // downloading 阶段把速度 / 已下 / 总量塞进副标题，让用户对剩余时间有感知。
  const detail = createMemo(() => {
    if (!ready()) return ""
    const p = progress()
    if (p.phase === "error") return p.message ?? ""
    if (p.phase === "confirm-install") {
      return t("desktop.updater.progress.confirmInstallDetail", { count: p.busyCount })
    }
    if (p.phase === "downloading") {
      const parts: string[] = []
      if (p.bytesPerSecond > 0) parts.push(formatSpeed(p.bytesPerSecond))
      if (p.total > 0) parts.push(`${formatBytes(p.transferred)} / ${formatBytes(p.total)}`)
      return parts.join(" · ")
    }
    return ""
  })

  // `t()` 不是 reactive accessor，必须包进 memo 才会跟着 ready() 翻译完重渲染；
  // 否则 JSX 在 initI18n resolve 前就先 render 一次，title/按钮永远停在英文。
  const titleLabel = createMemo(() => (ready() ? t("desktop.updater.progress.windowTitle") : ""))
  const cancelLabel = createMemo(() => (ready() ? t("desktop.updater.progress.cancel") : ""))
  const closeLabel = createMemo(() => (ready() ? t("desktop.updater.progress.close") : ""))
  const installNowLabel = createMemo(() => (ready() ? t("desktop.updater.progress.installNow") : ""))
  const laterLabel = createMemo(() => (ready() ? t("desktop.updater.progress.later") : ""))

  const onCancel = () => {
    void window.api.cancelUpdate()
  }

  const onClose = () => {
    void window.api.closeUpdateWindow()
  }

  const onConfirmInstall = () => {
    void window.api.confirmInstall()
  }

  return (
    <MetaProvider>
      <Font />
      <div class="h-dvh w-screen flex flex-col bg-background-base select-none">
        <header
          class="px-5 py-2 border-b border-border-weak-base"
          style={{ "-webkit-app-region": "drag" } as Record<string, string>}
        >
          <span class="text-text-strong text-14-medium font-semibold">{titleLabel()}</span>
        </header>
        <main class="flex-1 px-5 py-4 flex flex-col justify-between gap-3" aria-live="polite">
          <div class="flex items-center gap-4">
            <div class="shrink-0 drop-shadow-md" style={{ width: "48px", height: "48px" }}>
              <Mark class="w-full h-full" />
            </div>
            <div class="flex-1 min-w-0 flex flex-col gap-2">
              <span class="text-text-strong text-14-medium font-semibold truncate">{status()}</span>
              <Show when={detail()}>
                <span class="text-text-soft text-12-regular truncate" title={detail()}>
                  {detail()}
                </span>
              </Show>
              <Progress
                value={percent()}
                class="w-full [&_[data-slot='progress-track']]:h-1.5 [&_[data-slot='progress-track']]:border-0 [&_[data-slot='progress-track']]:rounded-full [&_[data-slot='progress-track']]:bg-surface-weak [&_[data-slot='progress-fill']]:rounded-full [&_[data-slot='progress-fill']]:bg-icon-interactive-base [&_[data-slot='progress-fill']]:transition-[width]"
                aria-label="Update progress"
                getValueLabel={({ value }) => `${Math.round(value)}%`}
              />
            </div>
          </div>
          <div
            class="flex justify-end items-center gap-2"
            style={{ "-webkit-app-region": "no-drag" } as Record<string, string>}
          >
            <Switch>
              <Match when={phase() === "preparing" || phase() === "downloading"}>
                <Button variant="secondary" size="small" onClick={onCancel}>
                  {cancelLabel()}
                </Button>
              </Match>
              <Match when={phase() === "installing"}>
                <Button variant="secondary" size="small" disabled>
                  {cancelLabel()}
                </Button>
              </Match>
              <Match when={phase() === "confirm-install"}>
                <Button variant="secondary" size="small" onClick={onClose}>
                  {laterLabel()}
                </Button>
                <Button variant="primary" size="small" onClick={onConfirmInstall}>
                  {installNowLabel()}
                </Button>
              </Match>
              <Match when={phase() === "error" || phase() === "cancelled"}>
                <Button variant="secondary" size="small" onClick={onClose}>
                  {closeLabel()}
                </Button>
              </Match>
            </Switch>
          </div>
        </main>
      </div>
    </MetaProvider>
  )
}, root)
