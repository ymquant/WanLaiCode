import { useLanguage } from "@/context/language"
import { getFilename } from "@opencode-ai/core/util/path"
import { DialogFileInput } from "./dialog-file-input"

export function DialogFileRename(props: { path: string; onConfirm: (newName: string) => Promise<void> | void }) {
  const language = useLanguage()
  const currentName = getFilename(props.path)

  return (
    <DialogFileInput
      title={language.t("common.rename")}
      initial={currentName}
      action={language.t("common.save")}
      errorFallback={language.t("session.files.renameFailed")}
      onSubmit={props.onConfirm}
      disabled={(value) => value === currentName}
    />
  )
}
