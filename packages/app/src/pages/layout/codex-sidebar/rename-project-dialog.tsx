import { createSignal } from "solid-js"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useLanguage } from "@/context/language"
import { getFilename } from "@opencode-ai/core/util/path"
import { PROJECT_NAME_MAX_LENGTH } from "@/utils/project-name"
import type { LocalProject } from "@/context/layout"

export function DialogRenameProject(props: {
  project: LocalProject
  onRename: (name: string) => void
}) {
  const dialog = useDialog()
  const language = useLanguage()
  const [name, setName] = createSignal(props.project.name || getFilename(props.project.worktree))
  const [busy, setBusy] = createSignal(false)

  const submit = async () => {
    if (busy()) return
    const trimmed = name().trim()
    if (!trimmed) return
    setBusy(true)
    try {
      await props.onRename(trimmed)
      dialog.close()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      fit
      title={language.t("sidebar.project.menu.rename")}
      class="codex-dialog w-full max-w-[420px] mx-auto !min-h-0 rename-project-dialog"
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
        class="flex flex-col gap-2 p-5 pt-3"
      >
        <div class="text-12-regular text-text-weak -mt-1">
          {language.t("sidebar.project.rename.hint")}
        </div>

        <input
          type="text"
          // 原生 maxlength 只拦新输入（键盘和粘贴），不会去动已经填进来的存量长名称 ——
          // 正好符合「只约束用户新的修改，兼容存量数据」
          maxLength={PROJECT_NAME_MAX_LENGTH}
          value={name()}
          onInput={(e) => setName(e.currentTarget.value)}
          disabled={busy()}
          class="w-full h-9 px-3 text-14-regular text-text-strong bg-surface-raised-stronger-non-alpha border border-border-weaker-base rounded-lg focus:outline-none focus:border-border-weak-base transition-colors duration-200"
          placeholder={getFilename(props.project.worktree)}
        />

        <div class="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" size="large" onClick={() => dialog.close()} disabled={busy()}>
            {language.t("common.cancel")}
          </Button>
          <Button
            type="submit"
            variant="primary"
            size="large"
            disabled={busy() || !name().trim()}
            class="!rounded-full px-3"
          >
            {busy() ? language.t("common.saving") : language.t("common.save")}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
