import { Icon } from "@opencode-ai/ui/icon"
import { Spinner } from "@opencode-ai/ui/spinner"
import type { Accessor, Component } from "solid-js"
import { Show } from "solid-js"
import { useLanguage } from "@/context/language"
import "./git-generate-button.css"

export const GitGenerateButton: Component<{
  generating: Accessor<boolean>
  disabled?: boolean
  onGenerate: () => void
}> = (props) => {
  const language = useLanguage()
  const blocked = () => props.generating() || props.disabled

  return (
    <button
      type="button"
      data-component="git-generate-button"
      data-generating={props.generating() ? "true" : undefined}
      class="flex items-center gap-1 text-13-regular text-text-base hover:text-text-strong transition-colors disabled:opacity-50"
      disabled={blocked()}
      aria-busy={props.generating()}
      aria-disabled={blocked()}
      tabIndex={blocked() ? -1 : 0}
      onClick={(event) => {
        if (blocked()) {
          event.preventDefault()
          event.stopImmediatePropagation()
          return
        }
        props.onGenerate()
      }}
    >
      <Show
        when={props.generating()}
        fallback={<Icon name="sparkle" size="small" class="size-3.5 shrink-0 text-current" />}
      >
        <Spinner class="size-3.5 shrink-0 text-current" />
      </Show>
      <span data-slot="git-generate-label">
        {props.generating()
          ? language.t("dialog.gitGenerate.action.generating")
          : language.t("dialog.gitGenerate.action.generate")}
      </span>
    </button>
  )
}
