import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import type { FileContent } from "@opencode-ai/sdk/v2"

const sampleText = "The quick brown fox jumps over the lazy dog. 0123456789"
const sampleChinese = "敏捷的棕色狐狸跳过了懒狗。你好世界！"

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes.buffer
}

export function FontPreview(props: { content: FileContent; filename?: string }) {
  const i18n = useLanguage()
  const [loaded, setLoaded] = createSignal(false)
  const [error, setError] = createSignal("")
  const [fontName, setFontName] = createSignal("")
  const family = `PreviewFont-${crypto.randomUUID()}`
  let disposed = false
  let registeredFont: FontFace | undefined

  const fontFamily = createMemo(() => `"${family}"`)

  createEffect(() => {
    const b64 = props.content.content
    if (!b64) return

    const buffer = base64ToArrayBuffer(b64)
    const name = fontFamily()

    const font = new FontFace(name, buffer)
    font.load()
      .then((f) => {
        if (disposed) return
        document.fonts.add(f)
        registeredFont = f
        setFontName(f.family)
        setLoaded(true)
      })
      .catch((e) => setError(e instanceof Error ? e.message : i18n.t("session.files.preview.font.loadFailed")))
  })

  onCleanup(() => {
    disposed = true
    if (registeredFont) document.fonts.delete(registeredFont)
  })

  return (
    <div class="flex flex-col items-center justify-center gap-6 py-12 px-6 h-full overflow-auto">
      <div class="text-14-semibold text-text-strong">{fontName() || props.filename}</div>
      <Show when={!error()} fallback={
        <div class="text-14-regular text-text-weak">{error()}</div>
      }>
        <Show when={loaded()} fallback={
          <div class="text-14-regular text-text-weak">{i18n.t("common.loading")}...</div>
        }>
          <div class="flex flex-col gap-4 items-center">
            <div style={{ "font-family": fontFamily(), "font-size": "24px" }} class="text-text-strong">
              {sampleText}
            </div>
            <div style={{ "font-family": fontFamily(), "font-size": "18px" }} class="text-text-base">
              {sampleChinese}
            </div>
            <div style={{ "font-family": fontFamily(), "font-size": "48px" }} class="text-text-strong mt-2">
              Aa
            </div>
          </div>
        </Show>
      </Show>
    </div>
  )
}
