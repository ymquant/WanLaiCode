import { useLanguage } from "@/context/language"
import { DialogFileInput } from "./dialog-file-input"

export function DialogFileCreate(props: { type: "file" | "folder"; onConfirm: (name: string) => Promise<void> | void }) {
  const language = useLanguage()

  const title = () =>
    props.type === "file"
      ? language.t("session.files.createFile.title")
      : language.t("session.files.createFolder.title")

  const placeholder = () =>
    props.type === "file"
      ? language.t("session.files.newFilePrompt")
      : language.t("session.files.newFolderPrompt")

  return (
    <DialogFileInput
      title={title()}
      placeholder={placeholder()}
      action={language.t("session.files.create.action")}
      onSubmit={props.onConfirm}
    />
  )
}
