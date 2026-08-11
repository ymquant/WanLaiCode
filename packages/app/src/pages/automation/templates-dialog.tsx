import { For } from "solid-js"
import { showToast } from "@opencode-ai/ui/toast"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useLanguage } from "@/context/language"
import { CdxModal, CdxClose } from "./codex-ui"
import { AUTOMATION_TEMPLATES, type AutomationTemplate } from "./templates"

// 模板库弹层:18 个预设;点卡片回调 onPick(交给上层打开编辑器预填)。
export function AutomationTemplatesDialog(props: { onPick: (t: AutomationTemplate) => void }) {
  const dialog = useDialog()
  const language = useLanguage()

  return (
    <CdxModal
      maxWidth={720}
      title={language.t("automation.templates.title")}
      action={
        <div class="flex items-center gap-2">
          <button
            type="button"
            class="cdx-btn cdx-btn--secondary cdx-btn--sm"
            onClick={() => showToast({ title: language.t("automation.toast.comingSoon") })}
          >
            {language.t("automation.templates.manual")}
          </button>
          <CdxClose onClick={() => dialog.close()} />
        </div>
      }
    >
      <div class="grid grid-cols-1 gap-3 overflow-y-auto pb-1 md:grid-cols-2" style={{ "max-height": "62vh" }}>
        <For each={AUTOMATION_TEMPLATES}>
          {(t) => (
            <button type="button" class="cdx-tpl" onClick={() => props.onPick(t)}>
              <span class="cdx-tpl__emoji">{t.emoji}</span>
              <span class="cdx-tpl__text">{t.prompt}</span>
            </button>
          )}
        </For>
      </div>
    </CdxModal>
  )
}
