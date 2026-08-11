import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { TextField } from "@opencode-ai/ui/text-field"
import { createSignal, type Component } from "solid-js"
import { useLanguage } from "@/context/language"

export const DialogPromptEditor: Component<{
  value: string
  onSave: (value: string) => void
}> = (props) => {
  const dialog = useDialog()
  const language = useLanguage()
  const [value, setValue] = createSignal(props.value)

  const save = () => {
    props.onSave(value())
    dialog.close()
  }

  return (
    <Dialog
      title={language.t("dialog.promptEditor.title")}
      description={language.t("dialog.promptEditor.description")}
      size="large"
    >
      <div class="flex flex-col gap-3">
        <TextField
          multiline
          autofocus
          hideLabel
          label={language.t("dialog.promptEditor.title")}
          value={value()}
          onChange={setValue}
          class="min-h-[220px] max-h-[50vh] resize-y"
          onKeyDown={(event: KeyboardEvent) => {
            if (event.key !== "Enter") return
            if (!event.metaKey && !event.ctrlKey) return
            event.preventDefault()
            save()
          }}
        />
        <div class="flex justify-end gap-2">
          <Button variant="ghost" size="large" onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </Button>
          <Button variant="primary" size="large" onClick={save}>
            {language.t("common.save")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
