import { Show } from "solid-js"
import { useI18n } from "../context/i18n"
import { Icon } from "./icon"
import { Tooltip } from "./tooltip"
import {
  parseToolPermissionReview,
  permissionReviewPresentation,
  type ToolPermissionReviewData,
} from "./tool-permission-review-data"

export { parseToolPermissionReview, permissionReviewPresentation, type ToolPermissionReviewData }

export function ToolPermissionReview(props: { review: ToolPermissionReviewData | undefined }) {
  const i18n = useI18n()
  const view = () => (props.review ? permissionReviewPresentation(props.review) : undefined)
  const reason = () => {
    const value = view()?.reason
    if (!value) return ""
    if (value.startsWith("ui.toolPermissionReview.")) return i18n.t(value)
    return value
  }
  const reviewer = () => [view()?.providerID, view()?.modelID].filter((value): value is string => !!value).join(" / ")

  return (
    <Show when={view()}>
      {(item) => (
        <Tooltip
          placement="top"
          gutter={6}
          openDelay={250}
          value={
            <div data-slot="tool-permission-review-tooltip" class="flex max-w-96 flex-col gap-1 text-left">
              <div class="text-12-medium">{i18n.t(item().label)}</div>
              <Show when={item().risk}>
                {(risk) => (
                  <div class="text-12-regular text-text-weak">
                    {i18n.t("ui.toolPermissionReview.detail.risk", {
                      risk: i18n.t(`ui.toolPermissionReview.risk.${risk()}`),
                    })}
                  </div>
                )}
              </Show>
              <Show when={reason()}>
                {(value) => (
                  <div class="text-12-regular whitespace-pre-wrap break-words">
                    {i18n.t("ui.toolPermissionReview.detail.reason", { reason: value() })}
                  </div>
                )}
              </Show>
              <Show when={reviewer()}>
                {(value) => (
                  <div class="text-12-regular text-text-weak">
                    {i18n.t("ui.toolPermissionReview.detail.reviewer", { reviewer: value() })}
                  </div>
                )}
              </Show>
            </div>
          }
        >
          <span
            data-component="tool-permission-review"
            data-status={props.review?.status}
            aria-label={i18n.t(item().label)}
            class="inline-flex size-4 shrink-0 items-center justify-center"
            classList={{
              "text-icon-weak": item().tone === "neutral",
              "text-text-on-critical-base": item().tone === "danger",
            }}
          >
            <Icon
              name={item().icon}
              size="small"
              viewBox={item().icon === "hand" ? "0 0 1024 1024" : undefined}
            />
          </span>
        </Tooltip>
      )}
    </Show>
  )
}
