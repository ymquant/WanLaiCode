import { useLanguage } from "@/context/language"
import { FileIcon } from "@opencode-ai/ui/file-icon"

/** 文件读取失败时提供与 Codex 一致的居中空状态，避免把系统异常路径直接展示给用户。 */
export function FileOpenErrorPlaceholder() {
  const i18n = useLanguage()
  return (
    <div class="absolute inset-0 flex items-center justify-center bg-background-base px-6 text-center">
      <span class="text-14-regular text-text-weak">{i18n.t("toast.file.loadFailed.title")}</span>
    </div>
  )
}

export function BinaryFilePlaceholder(props: {
  filename: string
  onOpenWithDefault?: () => void
  onRevealInFolder?: () => void
}) {
  const i18n = useLanguage()
  return (
    <div class="flex h-full flex-col items-center justify-center gap-4 px-6 py-16 text-center">
      <div class="flex flex-col gap-1">
        <span class="text-14-semibold text-text-strong truncate max-w-xs">{props.filename}</span>
        <span class="text-13-regular text-text-weak">
          {i18n.t("session.files.binaryCannotPreview")}
        </span>
      </div>
      <div class="flex items-center gap-2">
        <button
          type="button"
          class="flex h-8 items-center justify-center rounded-lg border border-border-base bg-surface-raised-stronger-non-alpha px-3 text-13-medium text-text-strong shadow-[var(--shadow-sm-border-base)] transition-colors hover:bg-surface-base-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border-focus"
          onClick={() => props.onOpenWithDefault?.()}
        >
          {i18n.t("session.files.openWithDefaultApp")}
        </button>
        <button
          type="button"
          class="flex size-8 items-center justify-center rounded-lg border border-border-base bg-surface-raised-stronger-non-alpha shadow-[var(--shadow-sm-border-base)] transition-colors hover:bg-surface-base-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border-focus"
          aria-label={i18n.t("session.files.revealInFolder")}
          onClick={() => props.onRevealInFolder?.()}
        >
          <FileIcon node={{ path: "folder", type: "directory" }} class="size-4" />
        </button>
      </div>
    </div>
  )
}

export function LegacyOfficePlaceholder(props: {
  filename: string
  format: string
  onOpenWithDefault?: () => void
}) {
  const i18n = useLanguage()
  return (
    <div class="flex h-full flex-col items-center justify-center gap-4 px-6 py-16 text-center">
      <div class="flex flex-col gap-1">
        <span class="text-14-semibold text-text-strong truncate max-w-xs">{props.filename}</span>
        <span class="text-13-regular text-text-weak">
          {i18n.t("session.files.legacyOfficeFormat", { format: props.format })}
        </span>
      </div>
      <button
        type="button"
        class="flex h-8 items-center justify-center rounded-lg border border-border-base bg-surface-raised-stronger-non-alpha px-3 text-13-medium text-text-strong shadow-[var(--shadow-sm-border-base)] transition-colors hover:bg-surface-base-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border-focus"
        onClick={() => props.onOpenWithDefault?.()}
      >
        {i18n.t("session.files.openWithDefaultApp")}
      </button>
    </div>
  )
}
