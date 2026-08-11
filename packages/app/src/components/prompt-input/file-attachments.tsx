import { Component, For, Show } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { FileAttachmentItem } from "@opencode-ai/ui/file-attachment"
import type { FileAttachmentPart } from "@/context/prompt"
import { canRestorePastedText } from "./paste"
import { useLanguage } from "@/context/language"
import { pastedAttachmentKind } from "./pasted-attachment"

type PromptFileAttachmentsProps = {
  attachments: FileAttachmentPart[]
  onOpen: (attachment: FileAttachmentPart) => void
  onRemove: (path: string) => void
  onShowInTextField?: (attachment: FileAttachmentPart) => void
  pastedTextLabel: string
  showInTextFieldLabel: string
  removeLabel: string
  class?: string
}

const removeClass =
  "absolute top-1 right-1 z-20 size-4 rounded-full flex items-center justify-center transition-opacity hover:opacity-80"
const removeStyle = {
  background: "var(--text-strong)",
}
const removeIconClass = "size-3"
const removeIconStyle = {
  color: "var(--surface-strong)",
}

export const PromptFileAttachments: Component<PromptFileAttachmentsProps> = (props) => {
  const language = useLanguage()
  const subtitle = (attachment: FileAttachmentPart) => {
    if (attachment.pastedText) {
      if (!props.onShowInTextField || !canRestorePastedText(attachment.pastedText.characterCount)) {
        return props.pastedTextLabel
      }

      return (
        // 粘贴文本长度适中时复刻 ChatGPT：卡片副标题直接作为恢复到编辑器的操作入口。
        <button
          type="button"
          class="inline-flex max-w-full cursor-pointer items-center gap-0.5 truncate text-left underline underline-offset-2 hover:text-text-strong"
          onPointerDown={(event) => {
            event.preventDefault()
            event.stopPropagation()
          }}
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            props.onShowInTextField?.(attachment)
          }}
          aria-label={props.showInTextFieldLabel}
        >
          {props.showInTextFieldLabel}
          <Icon name="chevron-right" class="size-3 shrink-0" aria-hidden="true" />
        </button>
      )
    }

    const kind = pastedAttachmentKind(attachment.path)
    if (kind === "text") return language.t("prompt.attachment.pastedText")
    if (kind === "json") return language.t("prompt.attachment.pastedJson")
  }

  return (
    <Show when={props.attachments.length > 0}>
      <div class={props.class ?? "flex flex-wrap gap-2 px-2 pt-2"}>
        <For each={props.attachments}>
          {(attachment) => (
            <Tooltip value={attachment.path} placement="top" contentClass="break-all">
              <div class="relative group">
                <FileAttachmentItem
                  filename={attachment.content.replace(/^@/, "")}
                  path={attachment.path}
                  layout="card"
                  class="h-16"
                  subtitle={subtitle(attachment)}
                  onClick={() => props.onOpen(attachment)}
                />
                {/* ChatGPT 的粘贴文本卡片始终显示关闭按钮，普通附件继续仅在悬停时显示。 */}
                <button
                  type="button"
                  onPointerDown={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                  }}
                  onClick={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    props.onRemove(attachment.path)
                  }}
                  class={`${removeClass} ${attachment.pastedText ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
                  style={removeStyle}
                  aria-label={props.removeLabel}
                >
                  <Icon name="close" class={removeIconClass} style={removeIconStyle} />
                </button>
              </div>
            </Tooltip>
          )}
        </For>
      </div>
    </Show>
  )
}
