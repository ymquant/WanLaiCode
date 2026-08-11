import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { createSignal } from "solid-js"
import { useLanguage } from "@/context/language"

export function DialogConfirm(props: {
  title: string
  description?: string
  confirmLabel: string
  onConfirm: () => Promise<void> | void
}) {
  const dialog = useDialog()
  const language = useLanguage()
  const [busy, setBusy] = createSignal(false)
  const [hover, setHover] = createSignal(false)

  return (
    <Dialog
      fit
      title={props.title}
      description={props.description}
      class="w-full max-w-[440px] mx-auto"
    >
      <div class="flex justify-end items-center gap-2 px-5 pb-5 pt-2">
        <Button type="button" variant="ghost" size="large" onClick={() => dialog.close()}>
          {language.t("common.cancel")}
        </Button>
        <button
          type="button"
          disabled={busy()}
          onMouseEnter={() => setHover(true)}
          onMouseLeave={() => setHover(false)}
          onClick={async () => {
            if (busy()) return
            setBusy(true)
            try {
              await props.onConfirm()
              dialog.close()
            } catch {
              setBusy(false)
            }
          }}
          class="h-9 px-4 rounded-lg text-14-medium transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
          style={{
            "background-color": hover() ? "rgba(232,79,79,0.2)" : "rgba(232,79,79,0.12)",
            color: "#E5484D",
          }}
        >
          {busy() ? language.t("common.loading") : props.confirmLabel}
        </button>
      </div>
    </Dialog>
  )
}
