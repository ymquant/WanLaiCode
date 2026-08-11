import { Dialog } from "@opencode-ai/ui/dialog"
import { type Component, Show } from "solid-js"
import { StatusPopoverBody } from "@/components/status-popover-body"
import { useLanguage } from "@/context/language"
import { SDKProvider } from "@/context/sdk"
import { SyncProvider } from "@/context/sync"

export const DialogStatus: Component<{ directory: string }> = (props) => {
  const language = useLanguage()

  return (
    <Dialog title={language.t("dialog.status.title")} class="dialog-status" fit>
      <Show
        when={props.directory}
        fallback={<div class="px-4 py-3 text-13-regular text-text-weak">{language.t("dialog.status.noDirectory")}</div>}
      >
        {(directory) => (
          <SDKProvider directory={directory}>
            <SyncProvider>
              <StatusPopoverBody shown={() => true} presentation="dialog" />
            </SyncProvider>
          </SDKProvider>
        )}
      </Show>
    </Dialog>
  )
}
