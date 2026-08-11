import { Component, For, Show, createMemo } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { useLanguage } from "@/context/language"
import { usePrompt } from "@/context/prompt"

const PREVIEW_LEN = 280

export const PromptAddToChatSelectionTag: Component = () => {
  const prompt = usePrompt()
  const language = useLanguage()
  const label = createMemo(() => {
    const count = prompt.addToChat.count()
    const key =
      count === 1 ? "session.addToChat.selectionCount.one" : "session.addToChat.selectionCount.other"
    return language.t(key, { count })
  })

  const tooltipBody = createMemo(() => {
    const list = prompt.addToChat.snippets()
    if (list.length === 0) return null
    return (
      <div class="flex max-w-[min(90vw,22rem)] max-h-56 flex-col gap-2 overflow-y-auto text-left text-12-regular text-text-invert-base">
        <For each={list}>
          {(snippet) => {
            const body = snippet.length > PREVIEW_LEN ? `${snippet.slice(0, PREVIEW_LEN)}…` : snippet
            return (
              <div class="min-w-0 whitespace-pre-wrap break-words text-12-regular leading-snug">
                {'"'}
                {body}
                {'"'}
              </div>
            )
          }}
        </For>
      </div>
    )
  })

  return (
    <Show when={prompt.addToChat.count() > 0}>
      <div class="px-2 pt-2 pb-1">
        <div class="inline-flex max-w-full items-center gap-0.5 rounded-full bg-background-stronger pr-0.5 shadow-xs-border">
          <Tooltip value={tooltipBody()} placement="top" openDelay={400}>
            <div
              data-component="add-to-chat-selection-tag"
              class="inline-flex min-w-0 max-w-[min(100%,14rem)] cursor-default items-center gap-1.5 py-1 pl-2 pr-1 text-12-regular text-text-strong select-none"
            >
              <Icon name="speech-bubble" size="small" class="shrink-0 text-icon-weak" />
              <span class="min-w-0 truncate">{label()}</span>
            </div>
          </Tooltip>
          <IconButton
            icon="circle-x"
            size="small"
            variant="ghost"
            class="shrink-0 rounded-full"
            aria-label={language.t("session.addToChat.clear")}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => prompt.addToChat.clear()}
          />
        </div>
      </div>
    </Show>
  )
}
