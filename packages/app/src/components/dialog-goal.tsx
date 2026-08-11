import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { TextField } from "@opencode-ai/ui/text-field"
import { createSignal } from "solid-js"
import { useLanguage } from "@/context/language"

/** objective 文本上限，与后端 Goal 模式保持一致 */
const GOAL_OBJECTIVE_MAX_LENGTH = 4000

const PRIMARY_BUTTON_STYLE = {
  "background-color": "rgb(25,28,31)",
  color: "rgb(255,255,255)",
  padding: "6px 22px",
  "border-radius": "999px",
  "font-size": "14px",
  "font-weight": "500",
  "line-height": "20px",
  height: "auto",
  "min-height": "0",
} as const

const PRIMARY_BUTTON_DISABLED_STYLE = {
  ...PRIMARY_BUTTON_STYLE,
  "background-color": "rgb(186,189,192)",
} as const

export interface DialogGoalEditProps {
  /** 当前 objective（用于回填 textarea 与判断是否有改动） */
  objective?: string
  /** 用户确认保存（已 trim、非空且与原值不同时才可触发） */
  onSave: (objective: string) => void
}

/** 「Edit goal」模态弹窗：编辑当前会话的 objective */
export function DialogGoalEdit(props: DialogGoalEditProps) {
  const dialog = useDialog()
  const language = useLanguage()

  const initialObjective = () => props.objective?.trim() ?? ""
  const [value, setValue] = createSignal(props.objective ?? "")

  const trimmed = () => value().trim()
  const canSave = () => {
    const next = trimmed()
    return next.length > 0 && next !== initialObjective()
  }

  const handleSave = () => {
    if (!canSave()) return
    props.onSave(trimmed())
    dialog.close()
  }

  const handleKeyDown = (event: KeyboardEvent) => {
    // ⌘/Ctrl+Enter 提交
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault()
      handleSave()
    }
  }

  return (
    <Dialog
      fit
      class="codex-dialog codex-dialog-narrow w-full mx-auto !min-h-0"
      title={
        <div class="flex flex-col items-start gap-3">
          <Icon name="edit" size="small" class="text-icon-base" />
          <span class="text-16-medium text-text-strong">{language.t("session.goal.dialog.edit.title")}</span>
        </div>
      }
    >
      <div class="dialog-goal-edit-field codex-dialog-narrow flex flex-col gap-3 px-5 pt-1 pb-5">
        <TextField
          type="text"
          label={language.t("session.goal.dialog.edit.title")}
          hideLabel
          multiline
          autofocus
          maxLength={GOAL_OBJECTIVE_MAX_LENGTH}
          value={value()}
          onChange={setValue}
          onKeyDown={handleKeyDown}
          placeholder={language.t("session.goal.dialog.edit.placeholder")}
          spellcheck={false}
          autocorrect="off"
          autocomplete="off"
          autocapitalize="off"
        />
        <div class="flex items-center justify-end gap-2">
          <Button type="button" variant="ghost" class="text-13-regular text-text-base" onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </Button>
          <Button
            type="button"
            variant="primary"
            disabled={!canSave()}
            class="!border-transparent !shadow-none"
            style={canSave() ? PRIMARY_BUTTON_STYLE : PRIMARY_BUTTON_DISABLED_STYLE}
            onClick={handleSave}
          >
            {language.t("session.goal.dialog.edit.save")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

export interface DialogGoalConfirmProps {
  title: string
  description: string
  confirmLabel: string
  cancelLabel: string
  onConfirm: () => void
  onCancel?: () => void
}

/** 通用 Goal 确认弹窗：用于「替换当前目标」「恢复目标」二选一确认 */
export function DialogGoalConfirm(props: DialogGoalConfirmProps) {
  const dialog = useDialog()

  const handleConfirm = () => {
    dialog.close()
    props.onConfirm()
  }

  const handleCancel = () => {
    dialog.close()
    props.onCancel?.()
  }

  return (
    <Dialog
      fit
      class="codex-dialog codex-dialog-narrow w-full mx-auto !min-h-0"
      title={
        <div class="flex flex-col items-start gap-3">
          <Icon name="circle-check" size="small" class="text-icon-base" />
          <span class="text-16-medium text-text-strong">{props.title}</span>
        </div>
      }
    >
      <div class="codex-dialog-narrow flex flex-col gap-4 px-5 pt-1 pb-5">
        <p class="text-13-regular text-text-base leading-5">{props.description}</p>
        <div class="flex items-center justify-end gap-2">
          <Button type="button" variant="ghost" class="text-13-regular text-text-base" onClick={handleCancel}>
            {props.cancelLabel}
          </Button>
          <Button
            type="button"
            variant="primary"
            class="!border-transparent !shadow-none"
            style={PRIMARY_BUTTON_STYLE}
            onClick={handleConfirm}
          >
            {props.confirmLabel}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
