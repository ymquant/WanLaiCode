import { createResource, Show } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { useGlobalSDK } from "@/context/global-sdk"
import { useLanguage } from "@/context/language"
import { CdxIcon } from "./cdx-icons"
import { CdxStatusBadge } from "./controls"
import { coerceSchedule, scheduleSummary } from "./schedule"
import { nextRunLabel, lastRunLabel, projectName } from "./format"
import { closeAutomationPanel } from "./panel-store"
import "./codex.css"

// 会话右侧边栏的自动化详情面板(对照 Codex):点对话内联卡片后展示。
export function AutomationDetailPanel(props: { automationID: string }) {
  const sdk = useGlobalSDK()
  const language = useLanguage()
  const navigate = useNavigate()
  const t = language.t

  const [automation] = createResource(
    () => props.automationID,
    async (id) => {
      // 自动化可能已被删除:SDK 在 404 时会抛异常,这里兜住返回 null,展示空态而非崩溃
      try {
        const res = await sdk.client.automation.get({ automationID: id })
        return res.error ? null : res.data
      } catch {
        return null
      }
    },
  )

  const projectLabel = (dir: string | null) => projectName(dir) || "—"

  function viewFull() {
    const a = automation()
    if (!a) return
    closeAutomationPanel()
    navigate(`/automations/${a.id}`)
  }

  return (
    <div class="cdx cdx-autopanel">
      <div class="cdx-autopanel__top">
        <div class="cdx-autopanel__top-title">
          <CdxIcon name="clock" size={15} class="shrink-0" />
          <span class="truncate">{automation()?.title ?? "…"}</span>
        </div>
      </div>

      <Show
        when={automation()}
        fallback={<div class="cdx-autopanel__empty">{automation.loading ? "…" : t("automation.detail.back")}</div>}
      >
        {(a) => (
          <div class="cdx-autopanel__body">
            <div class="cdx-autopanel__h1">{a().title}</div>
            <Show when={a().prompt}>
              <div class="cdx-autopanel__prompt">{a().prompt}</div>
            </Show>

            <div class="cdx-sec">{t("automation.detail.status")}</div>
            <div class="cdx-frow">
              <span class="cdx-frow__label">{t("automation.detail.status")}</span>
              <div class="cdx-frow__value">
                <CdxStatusBadge enabled={a().enabled} />
              </div>
            </div>
            <div class="cdx-frow">
              <span class="cdx-frow__label">{t("automation.detail.nextRun")}</span>
              <div class="cdx-frow__value">
                <span class="cdx-badge">{nextRunLabel(a().enabled, a().nextRunAt, t)}</span>
              </div>
            </div>
            <div class="cdx-frow">
              <span class="cdx-frow__label">{t("automation.detail.lastRun")}</span>
              <div class="cdx-frow__value">
                <span class="cdx-badge">{lastRunLabel(a().lastRunAt, t)}</span>
              </div>
            </div>

            <div class="cdx-sec">{t("automation.detail.details")}</div>
            <div class="cdx-frow">
              <span class="cdx-frow__label">{t("automation.detail.project")}</span>
              <div class="cdx-frow__value">
                <span class="cdx-frow__plain">{projectLabel(a().directory)}</span>
              </div>
            </div>
            <div class="cdx-frow">
              <span class="cdx-frow__label">{t("automation.detail.repeats")}</span>
              <div class="cdx-frow__value">
                <span class="cdx-frow__plain">{scheduleSummary(coerceSchedule(a().scheduleConfig), t)}</span>
              </div>
            </div>
          </div>
        )}
      </Show>

      <div class="cdx-autopanel__footer">
        <button type="button" class="cdx-btn cdx-btn--secondary cdx-autopanel__view" onClick={viewFull}>
          {t("automation.card.viewFull")}
          <CdxIcon name="chevronRight" class="shrink-0" />
        </button>
      </div>
    </div>
  )
}
