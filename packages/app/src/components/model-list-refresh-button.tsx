import { IconButton, type IconButtonProps } from "@opencode-ai/ui/icon-button"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { showToast } from "@opencode-ai/ui/toast"
import type { Component } from "solid-js"
import { createEffect } from "solid-js"
import { useLanguage } from "@/context/language"
import { useRefreshProviders } from "@/hooks/refresh-providers-query"

export const ModelListRefreshButton: Component<{
  class?: string
  iconSize?: IconButtonProps["iconSize"]
  size?: IconButtonProps["size"]
}> = (props) => {
  const language = useLanguage()
  const providers = useRefreshProviders()
  let button: HTMLButtonElement | undefined

  createEffect(() => {
    if (!providers.refreshing()) return
    if (button?.matches(":focus")) button.blur()
  })

  const tooltip = () =>
    providers.refreshing()
      ? language.t("dialog.model.refresh.tooltip.loading")
      : language.t("dialog.model.refresh.tooltip")

  const handleClick = async () => {
    if (providers.refreshing()) return
    const outcome = await providers.refresh()
    if (!outcome) return
    if (outcome.status === "success") {
      showToast({ title: language.t("dialog.model.refresh.toast.success") })
      return
    }
    if (outcome.status === "cached") {
      showToast({ title: language.t("dialog.model.refresh.toast.cached") })
      return
    }
    showToast({
      title: language.t("dialog.model.refresh.toast.failed"),
      description: outcome.message,
    })
  }

  return (
    <Tooltip placement="top" value={tooltip()} closeOnPress={false}>
      <span
        class="inline-flex model-list-refresh-button-wrap"
        data-refreshing={providers.refreshing() ? "true" : undefined}
      >
        <IconButton
          ref={(el) => {
            button = el instanceof HTMLButtonElement ? el : undefined
          }}
          icon="arrow-rotate"
          variant="ghost"
          size={props.size ?? "normal"}
          iconSize={props.iconSize ?? "normal"}
          data-refreshing={providers.refreshing() ? "true" : undefined}
          tabIndex={providers.refreshing() ? -1 : undefined}
          aria-busy={providers.refreshing() || undefined}
          aria-disabled={providers.refreshing() || undefined}
          classList={{
            "model-list-refresh-button": true,
            [props.class ?? ""]: !!props.class,
          }}
          aria-label={tooltip()}
          onFocusCapture={() => {
            if (!providers.refreshing()) return
            button?.blur()
          }}
          onKeyDownCapture={(event: KeyboardEvent) => {
            if (!providers.refreshing()) return
            if (event.key !== "Enter" && event.key !== " ") return
            event.preventDefault()
            event.stopPropagation()
          }}
          onClick={() => void handleClick()}
        />
      </span>
    </Tooltip>
  )
}
