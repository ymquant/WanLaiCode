import { resolveError } from "@opencode-ai/core/error/resolve"
import type { ErrorAction } from "@opencode-ai/core/error/error-actions"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { Show, createMemo } from "solid-js"
import { useLanguage } from "@/context/language"
import { SettingsRow } from "@/pages/users/shared"

// 需要渲染行为按钮的 action 集合。
// refresh_token / show_message 由调用层或上游自动处理，不呈现按钮。
const ACTION_BUTTON_SET = new Set<ErrorAction>(["relogin", "open_purchase", "show_quota", "backoff_retry", "show_blocked"])

export function ErrorActionView(props: { error: unknown; onAction?: (action: ErrorAction) => void }) {
  const language = useLanguage()

  // createMemo 保持响应式：props.error 变化时自动重新解析
  const resolved = createMemo(() => resolveError(props.error))

  const title = () => language.t(resolved().messageKey as any)
  // 当有 rawMessage 且 rawMessage 与 i18n 文案不同时，作为 description 附带展示
  const description = () => {
    if (resolved().reason) return undefined
    const raw = resolved().rawMessage
    if (!raw) return undefined
    // 防止与通用文案重复展示
    if (raw === title()) return undefined
    return raw
  }

  const showButton = () => ACTION_BUTTON_SET.has(resolved().action)

  return (
    <SettingsRow
      title={
        <span class="flex items-center gap-2">
          <Icon name="warning" size="small" class="shrink-0 text-icon-weak" />
          <span class="flex flex-col gap-1">
            <span>{title()}</span>
            <Show when={description()}>
              <span class="text-13-regular text-text-weak">{description()}</span>
            </Show>
            <Show when={showButton()}>
              <span>
                <Button
                  variant="secondary"
                  class="mt-1 h-7 px-2 py-1 text-12-medium"
                  onClick={() => props.onAction?.(resolved().action)}
                >
                  {language.t(("errors.action." + resolved().action) as any)}
                </Button>
              </span>
            </Show>
          </span>
        </span>
      }
    />
  )
}
