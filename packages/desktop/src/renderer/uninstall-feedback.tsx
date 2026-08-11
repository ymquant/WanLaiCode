// @refresh reload
import { MetaProvider } from "@solidjs/meta"
import { createSignal, For, Show } from "solid-js"
import { render } from "solid-js/web"
import "@opencode-ai/app/index.css"
import { Button } from "@opencode-ai/ui/button"
import { Font } from "@opencode-ai/ui/font"
import { Mark } from "@opencode-ai/ui/logo"
import { isValidFeedbackText, countFeedbackChars } from "../uninstall-feedback/shared"
import { initI18n, t } from "./i18n"
import "./styles.css"

const MAX_IMAGES = 5
const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const ALLOWED_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"]

const root = document.getElementById("root")

// frameless 窗口拖拽区
const DRAG = { "-webkit-app-region": "drag" } as Record<string, string>
const NO_DRAG = { "-webkit-app-region": "no-drag" } as Record<string, string>

type PickedImage = { name: string; type: string; bytes: Uint8Array; preview: string }

const STYLE = `
@keyframes uf-fade-up { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
.uf-enter { animation: uf-fade-up 0.55s cubic-bezier(0.16, 1, 0.3, 1) both; }
.uf-d1 { animation-delay: 0.05s; } .uf-d2 { animation-delay: 0.10s; }
.uf-d3 { animation-delay: 0.15s; } .uf-d4 { animation-delay: 0.20s; }
@keyframes uf-spin { to { transform: rotate(360deg); } }
.uf-spin { animation: uf-spin 0.6s linear infinite; }
.uf-scroll::-webkit-scrollbar, .uf-area::-webkit-scrollbar { width: 8px; }
.uf-scroll::-webkit-scrollbar-thumb, .uf-area::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, currentColor 16%, transparent); border-radius: 999px;
}
.uf-area { field-sizing: content; }
`

function App() {
  const [content, setContent] = createSignal("")
  const [contact, setContact] = createSignal("")
  const [images, setImages] = createSignal<PickedImage[]>([])
  const [submitting, setSubmitting] = createSignal(false)
  const [error, setError] = createSignal<string | undefined>()
  // 上报失败(已写本地兜底)后进入此态：主按钮变「重试」，并露出「继续卸载」逃生通道。
  const [failed, setFailed] = createSignal(false)

  const count = () => countFeedbackChars(content())
  const valid = () => isValidFeedbackText(content())
  const canSubmit = () => valid() && !submitting()

  const EXT: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
  }

  const addFiles = async (files: File[]) => {
    for (const f of files) {
      if (images().length >= MAX_IMAGES) break
      if (!ALLOWED_TYPES.includes(f.type)) {
        setError(t("uninstallFeedback.image.type"))
        continue
      }
      if (f.size > MAX_IMAGE_BYTES) {
        setError(t("uninstallFeedback.image.size"))
        continue
      }
      // 剪贴板粘贴的图片文件名通常是空或固定 "image.png"，给个可辨识的回退名。
      const name = f.name && f.name !== "image.png" ? f.name : `pasted-${images().length + 1}.${EXT[f.type] ?? "png"}`
      const bytes = new Uint8Array(await f.arrayBuffer())
      setImages((prev) => [...prev, { name, type: f.type, bytes, preview: URL.createObjectURL(f) }])
    }
  }

  const onPick = async (e: Event) => {
    const input = e.currentTarget as HTMLInputElement
    const files = [...(input.files ?? [])]
    input.value = ""
    await addFiles(files)
  }

  // 直接粘贴截图：只在剪贴板含图片时拦截，纯文本粘贴照常进输入框。
  const onPaste = async (e: ClipboardEvent) => {
    const items = e.clipboardData?.items
    if (!items) return
    const pics: File[] = []
    for (const it of Array.from(items)) {
      if (it.kind === "file" && it.type.startsWith("image/")) {
        const f = it.getAsFile()
        if (f) pics.push(f)
      }
    }
    if (pics.length === 0) return
    e.preventDefault()
    await addFiles(pics)
  }

  const removeImage = (idx: number) =>
    setImages((prev) => {
      URL.revokeObjectURL(prev[idx].preview)
      return prev.filter((_, i) => i !== idx)
    })

  const submit = async () => {
    if (!canSubmit()) return
    setSubmitting(true)
    setError(undefined)
    const res = await window.api.uninstallFeedbackSubmit({
      content: content().trim(),
      contact: contact().trim() || undefined,
      images: images().map((i) => ({ name: i.name, type: i.type, bytes: i.bytes })),
    })
    // 上报成功时主进程会自行 app.exit(0)；失败则恢复表单、提示，并露出重试/继续。
    if (!res.ok) {
      setSubmitting(false)
      setFailed(true)
      setError(t("uninstallFeedback.error.retry"))
    }
  }

  const cancel = () => window.api.uninstallFeedbackCancel()
  // 反复失败后直接继续卸载：反馈已落本地兜底，绝不阻塞用户。
  const continueUninstall = () => window.api.uninstallFeedbackContinue()

  return (
    <div
      class="relative flex h-dvh w-screen flex-col overflow-hidden bg-background-base text-text-base select-none"
      onPaste={onPaste}
    >
      <style>{STYLE}</style>

      {/* Header — 拖拽区，logo + 标题 */}
      <header class="uf-enter flex items-center gap-3 px-6 pt-6 pb-4" style={DRAG}>
        <div class="shrink-0 drop-shadow-sm">
          <Mark class="h-8 w-8" />
        </div>
        <div class="flex min-w-0 flex-col gap-0.5">
          <h1 class="text-16-medium text-text-strong">{t("uninstallFeedback.title")}</h1>
          <p class="text-12-regular text-text-weak">{t("uninstallFeedback.subtitle")}</p>
        </div>
      </header>

      {/* 表单主体 */}
      <main class="uf-scroll flex flex-1 flex-col gap-3.5 overflow-y-auto px-6 pb-1" style={NO_DRAG}>
        {/* 反馈正文 */}
        <div class="uf-enter uf-d1 rounded-xl border border-border-weak-base bg-surface-base transition-colors duration-200 focus-within:border-border-strong-base">
          <textarea
            class="uf-area block max-h-52 min-h-28 w-full resize-none bg-transparent px-3.5 pt-3 text-14-regular leading-relaxed text-text-strong outline-none placeholder:text-text-weaker"
            placeholder={t("uninstallFeedback.placeholder")}
            value={content()}
            onInput={(e) => setContent(e.currentTarget.value)}
            maxlength={2000}
          />
          <div class="flex items-center justify-end px-3.5 pb-2.5">
            <span
              class="text-11-regular tabular-nums"
              classList={{ "text-text-weaker": !valid(), "text-text-success": valid() }}
            >
              {count()} / 10–2000
            </span>
          </div>
        </div>

        {/* 联系方式 */}
        <div class="uf-enter uf-d2 rounded-xl border border-border-weak-base bg-surface-base transition-colors duration-200 focus-within:border-border-strong-base">
          <input
            class="block w-full bg-transparent px-3.5 py-2.5 text-13-regular text-text-strong outline-none placeholder:text-text-weaker"
            placeholder={t("uninstallFeedback.contact")}
            value={contact()}
            onInput={(e) => setContact(e.currentTarget.value)}
            maxlength={200}
          />
        </div>

        {/* 图片 */}
        <div class="uf-enter uf-d3 flex flex-wrap gap-2.5">
          <For each={images()}>
            {(img, i) => (
              <div class="group/img relative h-16 w-16 overflow-hidden rounded-lg border border-border-weak-base">
                <img src={img.preview} class="h-full w-full object-cover" alt={img.name} />
                <button
                  type="button"
                  onClick={() => removeImage(i())}
                  aria-label="remove"
                  class="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-background-base/80 text-icon-base opacity-0 backdrop-blur-sm transition-opacity duration-150 hover:text-text-danger group-hover/img:opacity-100"
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
                    <path d="M18 6 6 18M6 6l12 12" />
                  </svg>
                </button>
              </div>
            )}
          </For>
          <Show when={images().length < MAX_IMAGES}>
            <label class="flex h-16 w-16 cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border-base text-text-weaker transition-colors duration-150 hover:border-border-strong-base hover:text-text-weak">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                <path d="M12 5v14M5 12h14" />
              </svg>
              <span class="text-10-regular tabular-nums">
                {images().length}/{MAX_IMAGES}
              </span>
              <input type="file" accept={ALLOWED_TYPES.join(",")} multiple class="hidden" onChange={onPick} />
            </label>
          </Show>
        </div>

        {/* 错误 */}
        <Show when={error()}>
          <div class="uf-enter flex items-start gap-2 rounded-lg border border-border-weak-base bg-surface-weak px-3 py-2 text-12-regular text-text-danger">
            <svg class="mt-0.5 shrink-0" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <circle cx="12" cy="12" r="10" />
              <path d="M12 8v5M12 16h.01" />
            </svg>
            <span>{error()}</span>
          </div>
        </Show>
      </main>

      {/* 操作栏 */}
      <footer
        class="uf-enter uf-d4 flex items-center justify-end gap-2 border-t border-border-weaker-base px-6 py-4"
        style={NO_DRAG}
      >
        <Button variant="ghost" size="small" onClick={cancel}>
          {t("uninstallFeedback.cancel")}
        </Button>
        <Show when={failed()}>
          <Button variant="secondary" size="small" onClick={continueUninstall}>
            {t("uninstallFeedback.continue")}
          </Button>
        </Show>
        <Button variant="primary" size="small" disabled={!canSubmit()} onClick={submit}>
          <Show
            when={submitting()}
            fallback={failed() ? t("uninstallFeedback.retry") : t("uninstallFeedback.submit")}
          >
            <span class="inline-flex items-center gap-1.5">
              <span class="uf-spin inline-block h-3.5 w-3.5 rounded-full border-2 border-current border-t-transparent" />
              {t("uninstallFeedback.submitting")}
            </span>
          </Show>
        </Button>
      </footer>
    </div>
  )
}

render(() => {
  const [ready, setReady] = createSignal(false)
  void initI18n().finally(() => setReady(true))
  return (
    <MetaProvider>
      <Font />
      <Show when={ready()}>
        <App />
      </Show>
    </MetaProvider>
  )
}, root!)
