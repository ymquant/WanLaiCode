import { normalizeLocale, type Locale } from "@opencode-ai/app"
import { I18nProvider } from "@opencode-ai/ui/context"
import { ImagePreview } from "@opencode-ai/ui/image-preview"
import { Font } from "@opencode-ai/ui/font"
import { dict as uiEn } from "@opencode-ai/ui/i18n/en"
import { dict as uiZh } from "@opencode-ai/ui/i18n/zh"
import { dict as uiZht } from "@opencode-ai/ui/i18n/zht"
import { ThemeProvider } from "@opencode-ai/ui/theme/context"
import { MetaProvider } from "@solidjs/meta"
import { createResource, createSignal, Show } from "solid-js"
import { render } from "solid-js/web"
import "@opencode-ai/app/index.css"
import "./styles.css"
import { initI18n } from "./i18n"

const root = document.getElementById("root")
if (!(root instanceof HTMLElement)) {
  throw new Error("Root element not found")
}

const previewId = new URLSearchParams(location.search).get("id")

const uiDict = (locale: Locale): typeof uiEn => {
  if (locale === "zh") return uiZh
  if (locale === "zht") return uiZht
  return uiEn
}

render(() => {
  const [ready, setReady] = createSignal(false)
  const [locale, setLocale] = createSignal<Locale>("en")

  void initI18n()
    .then((value) => {
      setLocale(normalizeLocale(value))
    })
    .finally(() => setReady(true))

  const [payload] = createResource(async () => {
    if (!previewId) return null
    return window.api.consumeImagePreviewPayload(previewId)
  })

  return (
    <Show when={ready() && payload()}>
      {(data) => (
        <MetaProvider>
          <Font />
          <ThemeProvider>
            <I18nProvider
              value={{
                locale,
                t: (key, params) => {
                  const dict = uiDict(locale())
                  const text = dict[key] ?? String(key)
                  if (!params) return text
                  return text.replace(/{{\s*([^}]+?)\s*}}/g, (_match: string, rawKey: string) => {
                    const value = params[rawKey]
                    return value === undefined ? "" : String(value)
                  })
                },
              }}
            >
              <ImagePreview
                mode="window"
                src={data().src}
                alt={data().alt}
                onClose={() => void window.api.windowAction("close")}
              />
            </I18nProvider>
          </ThemeProvider>
        </MetaProvider>
      )}
    </Show>
  )
}, root)
