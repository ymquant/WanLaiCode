import { Component, For, Show } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import type { ImageAttachmentPart } from "@/context/prompt"

type PromptImageAttachmentsProps = {
  attachments: ImageAttachmentPart[]
  onOpen: (attachment: ImageAttachmentPart) => void
  onRemove: (id: string) => void
  removeLabel: string
  class?: string
}

const itemClass =
  "size-16 overflow-hidden rounded-xl border border-border-base bg-surface-base transition-colors group-hover:border-border-strong-base"
const fallbackClass = "size-full flex items-center justify-center"
const imageClass =
  "size-full object-cover transition-transform duration-150 group-hover:scale-[1.02]"
const removeClass =
  "absolute top-1 right-1 z-20 size-4 rounded-full bg-[var(--text-strong)] flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:opacity-80"

export const PromptImageAttachments: Component<PromptImageAttachmentsProps> = (props) => {
  return (
    <Show when={props.attachments.length > 0}>
      <div class={props.class ?? "flex flex-wrap gap-2 px-3 pt-3"}>
        <For each={props.attachments}>
          {(attachment) => (
            <Tooltip value={attachment.filename} placement="top" contentClass="break-all">
              <div class="relative group size-16">
                <div class={itemClass}>
                  <Show
                    when={attachment.mime.startsWith("image/")}
                    fallback={
                      <div class={fallbackClass}>
                        <Icon name="folder" class="size-6 text-text-weak" />
                      </div>
                    }
                  >
                    <img
                      src={attachment.dataUrl}
                      alt={attachment.filename}
                      class={imageClass}
                      onClick={() => props.onOpen(attachment)}
                    />
                  </Show>
                </div>
                <button
                  type="button"
                  onClick={() => props.onRemove(attachment.id)}
                  class={removeClass}
                  aria-label={props.removeLabel}
                >
                  <Icon name="close" class="size-3 text-[var(--surface-strong)]" />
                </button>
              </div>
            </Tooltip>
          )}
        </For>
      </div>
    </Show>
  )
}
