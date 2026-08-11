import { createSignal } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useLanguage } from "@/context/language"

export function DialogPermissionFullAccess(props: { onConfirm: () => Promise<void> }) {
  const dialog = useDialog()
  const language = useLanguage()
  const [busy, setBusy] = createSignal(false)
  const [hoveringConfirm, setHoveringConfirm] = createSignal(false)

  const confirm = async () => {
    if (busy()) return
    setBusy(true)
    try {
      await props.onConfirm()
      dialog.close()
    } catch {
      setBusy(false)
    }
  }

  const items = [
    {
      icon: "folder-codex" as const,
      iconClass: "text-[#2EA7FF]",
      title: language.t("prompt.permission.full.confirm.files.title"),
      description: language.t("prompt.permission.full.confirm.files.description"),
    },
    {
      icon: "terminal" as const,
      iconClass: "rounded-md bg-[#4A4A4A] p-1 text-white",
      title: language.t("prompt.permission.full.confirm.terminal.title"),
      description: language.t("prompt.permission.full.confirm.terminal.description"),
    },
    {
      icon: "globe" as const,
      iconClass: "text-[#2BC4FF]",
      title: language.t("prompt.permission.full.confirm.apps.title"),
      description: language.t("prompt.permission.full.confirm.apps.description"),
    },
  ]

  return (
    <Dialog
      fit
      action={<span class="size-8" aria-hidden="true" />}
      title={
        <div class="flex items-center gap-2 text-16-bold text-text-strong">
          <Icon name="warning" size="normal" class="text-text-strong" />
          <span>{language.t("prompt.permission.full.confirm.title")}</span>
        </div>
      }
      description={
        <div class="text-14-regular leading-5 text-text-weak">
          {language.t("prompt.permission.full.confirm.description")}
        </div>
      }
      class="dialog-permission-full-access !w-[min(440px,calc(100vw-32px))] !rounded-[16px]"
    >
      <div class="flex flex-col gap-3 px-4 pb-4">
        <div class="overflow-hidden rounded-[12px] bg-surface-base px-3">
          {items.map((item, index) => (
            <div
              classList={{
                "flex items-center gap-3 py-3": true,
                "border-b border-border-weak-base": index < items.length - 1,
              }}
            >
              <Icon name={item.icon} size="medium" class={item.iconClass} />
              <div class="min-w-0 flex flex-col gap-0.5">
                <div class="text-14-bold text-text-strong">{item.title}</div>
                <div class="text-12-regular text-text-weak">{item.description}</div>
              </div>
            </div>
          ))}
        </div>

        <div class="text-14-regular leading-5 text-text-weak">
          {language.t("prompt.permission.full.confirm.risk")}
        </div>

        <div class="flex items-center justify-end gap-2">
          <Button
            type="button"
            variant="secondary"
            size="normal"
            class="!h-9 !rounded-full !px-4"
            onClick={() => dialog.close()}
            disabled={busy()}
          >
            {language.t("common.cancel")}
          </Button>
          <button
            type="button"
            disabled={busy()}
            onMouseEnter={() => setHoveringConfirm(true)}
            onMouseLeave={() => setHoveringConfirm(false)}
            onClick={() => void confirm()}
            class="flex h-9 items-center gap-1.5 rounded-full px-4 text-14-medium text-[#E5484D] transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
            style={{ "background-color": hoveringConfirm() ? "rgba(232,72,77,0.2)" : "rgba(232,72,77,0.12)" }}
          >
            <Icon name="warning" size="small" />
            {language.t("prompt.permission.full.confirm.action")}
          </button>
        </div>
      </div>
    </Dialog>
  )
}
