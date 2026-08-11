import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Show, createSignal, type JSX } from "solid-js"
import { useLanguage } from "@/context/language"

export function DialogFileInput(props: {
  title: string
  description?: JSX.Element
  placeholder?: string
  initial?: string
  action: string
  errorFallback?: string
  transform?: (value: string) => string
  validate?: (value: string) => string | undefined
  onSubmit: (value: string) => Promise<void> | void
  disabled?: (value: string) => boolean
}) {
  const dialog = useDialog()
  const language = useLanguage()
  const [value, setValue] = createSignal(props.initial ?? "")
  const [submitting, setSubmitting] = createSignal(false)
  const [error, setError] = createSignal("")

  const transform = (next: string) => props.transform?.(next) ?? next

  const handleSubmit = async () => {
    if (submitting()) return
    const name = transform(value()).trim()
    if (!name) return
    if (/[\\/]|\.\./.test(name)) {
      setError(language.t("session.files.invalidName"))
      return
    }
    const validationError = props.validate?.(name)
    if (validationError) {
      setError(validationError)
      return
    }
    setError("")
    setSubmitting(true)
    try {
      await props.onSubmit(name)
      dialog.close()
    } catch (err) {
      const message = String((err as any)?.message ?? err ?? "")
      if (message.includes("File already exists")) {
        setError(language.t("session.files.fileAlreadyExists"))
        return
      }
      setError(props.errorFallback ?? language.t("session.files.createFailed"))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog
      fit
      title={props.title}
      class="codex-dialog w-full max-w-[420px] mx-auto !min-h-0 create-file-dialog"
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void handleSubmit()
        }}
        class="flex flex-col gap-2 p-5 pt-3"
      >
        <Show when={props.description}>
          <div class="pb-2 text-13-regular text-text-weak leading-relaxed">{props.description}</div>
        </Show>

        <input
          type="text"
          value={value()}
          onInput={(e) => setValue(transform(e.currentTarget.value))}
          disabled={submitting()}
          class="w-full h-9 px-3 text-14-regular text-text-strong bg-surface-raised-stronger-non-alpha border border-border-weaker-base rounded-lg focus:outline-none focus:border-border-weak-base transition-colors duration-200"
          placeholder={props.placeholder}
          spellcheck={false}
          autocorrect="off"
          autocomplete="off"
          autocapitalize="off"
          autofocus
        />

        <Show when={error()}>
          <p class="text-12-regular text-red-500">{error()}</p>
        </Show>

        <div class="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" size="large" onClick={() => dialog.close()} disabled={submitting()}>
            {language.t("common.cancel")}
          </Button>
          <Button
            type="submit"
            variant="primary"
            size="large"
            disabled={submitting() || !value().trim() || props.disabled?.(value().trim())}
            class="!rounded-full px-3"
          >
            {props.action}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
