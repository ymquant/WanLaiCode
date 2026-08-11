import { Component, Show, createEffect, onCleanup, onMount } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { useLanguage } from "@/context/language"
import { closePastedAttachmentPreview, type PastedAttachmentKind } from "./pasted-attachment"

export type PastedAttachmentPreviewProps = {
  path: string
  kind: PastedAttachmentKind
  filename: string
  value: string
  dirty: boolean
  saving?: boolean
  onInput: (value: string) => void
  onSave: () => Promise<boolean>
  onClose: () => void
  onOpenExternal: () => void
}

export const PastedAttachmentPreview: Component<PastedAttachmentPreviewProps> = (props) => {
  const language = useLanguage()
  let textareaRef: HTMLTextAreaElement | undefined

  createEffect(() => {
    props.path
    requestAnimationFrame(() => textareaRef?.focus())
  })

  const closePreview = () =>
    closePastedAttachmentPreview({
      dirty: props.dirty,
      onSave: props.onSave,
      onClose: props.onClose,
    })

  onMount(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      event.preventDefault()
      void closePreview()
    }
    window.addEventListener("keydown", onKeyDown)
    onCleanup(() => window.removeEventListener("keydown", onKeyDown))
  })

  const kindLabel = () =>
    props.kind === "json" ? language.t("prompt.attachment.pastedJson") : language.t("prompt.attachment.pastedText")

  return (
    <div
      class="flex min-h-[200px] max-h-[min(48vh,420px)] w-full flex-col overflow-hidden rounded-xl border border-border-base bg-surface-raised-stronger-non-alpha shadow-xs"
      data-component="pasted-attachment-preview"
    >
      <div class="flex min-w-0 items-center gap-2 border-b border-border-weak-base px-4 py-2.5">
        <div class="flex min-w-0 flex-1 flex-col gap-0.5">
          <span class="truncate text-14-medium text-text-strong">{props.filename}</span>
          <span class="truncate text-12-regular text-text-weak">{kindLabel()}</span>
        </div>
        <Show when={props.dirty}>
          <span class="shrink-0 text-12-regular text-text-weak">{language.t("prompt.attachment.preview.unsaved")}</span>
        </Show>
        <Show when={props.saving}>
          <span class="shrink-0 text-12-regular text-text-weak">{language.t("prompt.attachment.preview.saving")}</span>
        </Show>
        <Button size="small" variant="ghost" disabled={!props.dirty || props.saving} onClick={() => void props.onSave()}>
          {language.t("prompt.attachment.preview.save")}
        </Button>
        <Button size="small" variant="ghost" onClick={() => props.onOpenExternal()}>
          {language.t("prompt.attachment.preview.openExternal")}
        </Button>
        <IconButton
          icon="close"
          variant="ghost"
          aria-label={language.t("prompt.attachment.preview.close")}
          onClick={() => void closePreview()}
        />
      </div>
      <textarea
        ref={(el) => (textareaRef = el)}
        class="min-h-[160px] flex-1 resize-none bg-transparent px-4 py-3 font-mono text-13-regular leading-6 text-text-strong outline-none"
        value={props.value}
        spellcheck={false}
        onInput={(event) => props.onInput(event.currentTarget.value)}
        onBlur={() => {
          if (props.dirty) void props.onSave()
        }}
      />
    </div>
  )
}

export default PastedAttachmentPreview
