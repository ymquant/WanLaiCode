import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { useLanguage } from "@/context/language"

export interface DialogPushFailedProps {
  /** 用户实际执行的命令（仅展示） */
  command: string
  /** 错误输出文本（stderr / stdout 合并） */
  output: string
  /** 用户点击「强制推送」，调用方负责后续 push --force-with-lease + 失败时再次弹本 dialog */
  onForcePush: () => void
}

export function DialogPushFailed(props: DialogPushFailedProps) {
  const dialog = useDialog()
  const language = useLanguage()

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(props.output)
    } catch {
      /* ignore clipboard failures */
    }
  }

  return (
    <Dialog
      fit
      title={
        <span class="flex items-center gap-2">
          <span class="size-2 rounded-full bg-icon-danger-base shrink-0" aria-hidden="true" />
          {language.t("dialog.pushFailed.title")}
        </span>
      }
      class="codex-dialog w-full max-w-[640px] mx-auto !min-h-0"
    >
      <div class="flex flex-col gap-4 px-6 pt-1 pb-6">
        <div class="rounded-[10px] bg-surface-weak-base border border-border-weaker-base px-4 py-3">
          <div class="flex items-start justify-between gap-2">
            <span class="text-13-regular font-mono text-text-strong">{`$ ${props.command}`}</span>
            <IconButton
              icon="copy"
              variant="ghost"
              size="small"
              aria-label={language.t("common.copy")}
              onClick={copy}
            />
          </div>
          <pre class="mt-2 text-13-regular font-mono text-text-base whitespace-pre-wrap break-words max-h-[260px] overflow-auto no-scrollbar">
            {props.output || language.t("dialog.pushFailed.empty")}
          </pre>
        </div>
        <div class="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="large" onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </Button>
          <Button
            type="button"
            variant="primary"
            size="large"
            class="!border-transparent !shadow-none"
            style={{ "background-color": "rgb(25,28,31)", color: "rgb(255,255,255)" }}
            onClick={() => {
              dialog.close()
              props.onForcePush()
            }}
          >
            {language.t("dialog.pushFailed.forcePush")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
