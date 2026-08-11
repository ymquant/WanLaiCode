import { onCleanup, onMount, createSignal, Show } from "solid-js"
import type { FileContent } from "@opencode-ai/sdk/v2"
import { useLanguage } from "@/context/language"
import { validateOfficeZip } from "./office-zip"

export function DocxPreview(props: { content: FileContent; filename?: string }) {
  const i18n = useLanguage()
  const [error, setError] = createSignal("")
  const [ready, setReady] = createSignal(false)
  let containerRef: HTMLDivElement | undefined
  let resizeObserver: ResizeObserver | undefined
  let disposed = false

  const fitPages = () => {
    if (!containerRef) return
    const wrapper = containerRef.querySelector<HTMLElement>(".docx-wrapper")
    const page = wrapper?.querySelector<HTMLElement>("section.docx")
    if (!wrapper || !page) return
    wrapper.style.width = "100%"
    wrapper.querySelectorAll<HTMLElement>("section.docx").forEach((currentPage) => {
      currentPage.style.zoom = "1"
    })
    const pageWidth = page.offsetWidth
    const pageHeight = page.offsetHeight
    if (!pageWidth || !pageHeight) return
    const availableWidth = Math.max(1, containerRef.clientWidth - 32)
    const availableHeight = Math.max(1, containerRef.clientHeight - 32)
    const scale = Math.min(availableWidth / pageWidth, availableHeight / pageHeight)
    wrapper.querySelectorAll<HTMLElement>("section.docx").forEach((currentPage) => {
      currentPage.style.zoom = `${scale}`
    })
  }

  onMount(() => {
    const b64 = props.content.content
    if (!b64) return
    const binary = atob(b64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i)
    }

    validateOfficeZip(bytes)
      .then((validated) => {
        if (disposed) return
        return import("docx-preview").then(({ renderAsync }) => {
          if (disposed || !containerRef) return
          renderAsync(validated.buffer, containerRef, undefined, {
            className: "docx",
            inWrapper: true,
            ignoreWidth: false,
            ignoreHeight: false,
            breakPages: true,
            experimental: true,
            useBase64URL: true,
          })
            .then(() => {
              if (disposed) return
              fitPages()
              if (containerRef) {
                resizeObserver = new ResizeObserver(fitPages)
                resizeObserver.observe(containerRef)
              }
              setReady(true)
            })
            .catch((e) => {
              if (disposed) return
              setError(e instanceof Error ? e.message : i18n.t("session.files.preview.docx.renderFailed"))
            })
        })
      })
      .catch((e) => {
        if (disposed) return
        setError(e instanceof Error ? e.message : i18n.t("session.files.preview.docx.loadFailed"))
      })
  })

  onCleanup(() => {
    disposed = true
    resizeObserver?.disconnect()
    if (containerRef) containerRef.innerHTML = ""
  })

  return (
    <Show when={!error()} fallback={
      <div class="flex h-full items-center justify-center p-6 text-text-weak">{error()}</div>
    }>
      <div
        ref={containerRef}
        data-component="docx-reader"
        class="h-full min-h-0 overflow-auto"
      />
      <Show when={!ready()}>
        <div class="flex h-full items-center justify-center text-text-weak">{i18n.t("session.files.preview.loading")}</div>
      </Show>
    </Show>
  )
}
