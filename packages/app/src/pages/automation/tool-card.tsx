import { createMemo, createResource } from "solid-js"
import { registerTool, type ToolProps } from "@opencode-ai/ui/message-part"
import { useGlobalSDK } from "@/context/global-sdk"
import { useLanguage } from "@/context/language"
import { useSessionLayout } from "@/pages/session/session-layout"
import { CdxIcon } from "./cdx-icons"
import { coerceSchedule, scheduleSummary } from "./schedule"
import { openAutomationPanel } from "./panel-store"
import "./codex.css"

function snapshotSchedule(input: Record<string, unknown>) {
  return coerceSchedule({
    mode: input.mode,
    intervalMinutes: input.intervalMinutes,
    intervalHours: input.intervalHours,
    weekdays: input.weekdays,
    time: input.time,
    customRrule: input.customRrule,
  })
}

// automation_create 工具的对话内联卡片(对照 Codex):标题 + 计划 + 打开按钮。
// 点击打开按钮会在右侧会话边栏打开该自动化详情面板(openAutomationPanel)。
function AutomationCreateCard(props: ToolProps) {
  const sdk = useGlobalSDK()
  const language = useLanguage()
  const sessionLayout = useSessionLayout()
  const automationID = () => (props.metadata?.automationID as string | undefined) || undefined
  const snapshot = createMemo(() => ({
    id: automationID(),
    deleted: true,
    title: typeof props.input.title === "string" && props.input.title.trim() ? props.input.title.trim() : automationID(),
    schedule: snapshotSchedule(props.input),
  }))
  const [automation] = createResource(automationID, async (id) => {
    // 自动化可能已被删除:SDK 在 404 时会抛异常,这里兜住,避免内联卡片渲染时崩溃整页
    try {
      const res = await sdk.client.automation.get({ automationID: id })
      return res.error ? null : res.data
    } catch {
      return null
    }
  })
  const card = createMemo(() => {
    const current = automation()
    if (current) return { id: current.id, deleted: false, title: current.title, schedule: coerceSchedule(current.scheduleConfig) }
    return snapshot()
  })

  const open = () => {
    const id = card().id
    if (!id || card().deleted) return
    openAutomationPanel(sessionLayout.sessionKey(), id)
  }

  return (
    <div class="cdx cdx-inline-card" data-deleted={card().deleted ? "true" : undefined}>
      <div class="cdx-inline-card__icon">
        <CdxIcon name="clock" size={20} />
      </div>
      <div class="cdx-inline-card__body">
        <div class="cdx-inline-card__title truncate">{card().title}</div>
        <div class="cdx-inline-card__schedule truncate">{scheduleSummary(card().schedule, language.t)}</div>
      </div>
      <button
        type="button"
        class="cdx-inline-card__action"
        disabled={card().deleted || !card().id}
        onClick={open}
      >
        {language.t("automation.card.open")}
      </button>
    </div>
  )
}

registerTool({ name: "automation_create", render: AutomationCreateCard })
