import { createMemo, Show } from "solid-js"
import type { SessionStatus } from "@opencode-ai/sdk/v2/client"
import { useI18n } from "../context/i18n"
import { Card } from "./card"
import { Tooltip } from "./tooltip"

export function SessionRetry(props: { status: SessionStatus; show?: boolean }) {
  const i18n = useI18n()
  const retry = createMemo(() => {
    if (props.status.type !== "retry") return
    return props.status
  })
  const tooltipMessage = createMemo(() => {
    const current = retry()
    if (!current) return ""
    if (current.code === "STREAM_STALL") return i18n.t("ui.sessionTurn.retry.stalled")
    if (current.message.includes("exceeded your current quota") && current.message.includes("gemini")) {
      return i18n.t("ui.sessionTurn.retry.geminiHot")
    }
    return current.message
  })
  const info = createMemo(() => {
    const current = retry()
    if (!current) return ""
    const label =
      current.code === "STREAM_STALL"
        ? i18n.t("ui.sessionTurn.retry.stalled")
        : i18n.t("ui.sessionTurn.retry.retrying")
    // 无限重试模式无总次数上限，只显示已重试次数，不显示分母。
    if (current.total === undefined) return `${label} (${Math.max(1, current.attempt)})`
    const attempt = Math.min(Math.max(1, current.attempt), current.total)
    return `${label} (${attempt}/${current.total})`
  })

  return (
    <Show when={retry() && (props.show ?? true)}>
      <div data-slot="session-turn-retry">
        <Tooltip value={tooltipMessage()} placement="top">
          <Card variant="normal" class="retry-card">
            <div data-slot="session-turn-retry-info" class="min-w-0 cursor-help">{info()}</div>
          </Card>
        </Tooltip>
      </div>
    </Show>
  )
}
