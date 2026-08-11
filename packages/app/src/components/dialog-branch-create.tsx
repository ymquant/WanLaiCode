import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { TextField } from "@opencode-ai/ui/text-field"
import { showToast } from "@opencode-ai/ui/toast"
import { createMemo, createSignal, onMount, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { useSettings } from "@/context/settings"
import { formatServerError } from "@/utils/server-errors"

export interface DialogBranchCreateProps {
  onOpenPrefixSettings: () => void
}

const INVALID_CHARS = /[\s~^:?*\[\\]/

export function DialogBranchCreate(props: DialogBranchCreateProps) {
  const dialog = useDialog()
  const language = useLanguage()
  const settings = useSettings()
  const sdk = useSDK()

  const initial = () => `${settings.git.branchPrefix()}/`
  const [value, setValue] = createSignal(initial())
  const [submitting, setSubmitting] = createSignal(false)
  // 拉取本地分支列表用于查重——dialog 打开时拉一次，不阻塞渲染
  const [existing, setExisting] = createSignal<Set<string>>(new Set())
  onMount(() => {
    void sdk.client.vcs
      .listBranches()
      .then((res) => setExisting(new Set(res.data?.branches ?? [])))
      .catch(() => undefined)
  })

  const error = createMemo<string | undefined>(() => {
    const text = value().trim()
    if (!text) return language.t("dialog.branch.create.error.empty")
    if (text.endsWith("/")) return language.t("dialog.branch.create.error.trailingSlash")
    if (INVALID_CHARS.test(text)) return language.t("dialog.branch.create.error.invalidChars")
    if (text.includes("//")) return language.t("dialog.branch.create.error.invalidChars")
    if (existing().has(text)) return language.t("dialog.branch.create.error.exists")
    return undefined
  })

  const canSubmit = () => !error() && !submitting()

  const handleSubmit = async (e?: Event) => {
    e?.preventDefault()
    e?.stopPropagation()
    if (!canSubmit()) return
    const name = value().trim()
    setSubmitting(true)
    try {
      await sdk.client.vcs.createBranch({ vcsCreateBranchInput: { name } })
      dialog.close()
    } catch (err: unknown) {
      showToast({
        title: language.t("dialog.branch.create.toast.failed.title"),
        description: formatServerError(err, language.t),
      })
    } finally {
      setSubmitting(false)
    }
  }

  // dialog.show 内部会立即 dispose 当前 dialog，不需要先 close
  const openSettings = () => {
    props.onOpenPrefixSettings()
  }

  return (
    <Dialog
      fit
      title={language.t("dialog.branch.create.title")}
      class="codex-dialog w-full max-w-[520px] mx-auto !min-h-0"
    >
      <div class="flex flex-col gap-5 px-6 pt-1 pb-6">
        <div class="flex flex-col gap-1.5">
          {/* 标签行：左侧字段名，右侧「设置前缀」链接，与 Codex 1:1 */}
          <div class="flex items-center justify-between">
            <span class="text-13-medium text-text-strong">{language.t("dialog.branch.create.field.name")}</span>
            <button
              type="button"
              class="text-13-regular text-text-weak hover:text-text-base transition-colors"
              onClick={openSettings}
            >
              {language.t("dialog.branch.create.action.configurePrefix")}
            </button>
          </div>
          <TextField
            autofocus
            type="text"
            label={language.t("dialog.branch.create.field.name")}
            hideLabel
            value={value()}
            onChange={setValue}
            onKeyDown={(e: KeyboardEvent) => {
              if (e.key === "Enter") void handleSubmit(e)
            }}
            spellcheck={false}
            autocorrect="off"
            autocomplete="off"
            autocapitalize="off"
          />
          {/* 错误文案独立 render，不走 Kobalte validationState（避免输入框出现红色边框） */}
          <Show when={error()}>
            <span class="text-12-regular text-text-weak">{error()}</span>
          </Show>
        </div>

        <div class="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="large" onClick={() => dialog.close()}>
            {language.t("common.close")}
          </Button>
          <Button
            type="button"
            variant="primary"
            size="large"
            disabled={!canSubmit()}
            class="!border-transparent !shadow-none"
            style={{
              "background-color": canSubmit() ? "rgb(25,28,31)" : "rgb(186,189,192)",
              color: "rgb(255,255,255)",
            }}
            onClick={(e: MouseEvent) => void handleSubmit(e)}
          >
            {submitting()
              ? language.t("dialog.branch.create.action.submitting")
              : language.t("dialog.branch.create.action.submit")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
