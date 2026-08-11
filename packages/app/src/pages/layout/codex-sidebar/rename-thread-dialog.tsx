import { type JSX, createSignal, onMount } from "solid-js"
import { produce } from "solid-js/store"
import { showToast } from "@opencode-ai/ui/toast"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { resolveError } from "@opencode-ai/core/error/resolve"

// Codex 风格重命名对话弹窗：紧凑 440px、无 min-height、黑色 primary save 按钮、ghost cancel
export const RenameThreadDialog = (props: {
  sessionID: string
  directory: string
  initial: string
}): JSX.Element => {
  const language = useLanguage()
  const dialog = useDialog()
  const globalSDK = useGlobalSDK()
  const globalSync = useGlobalSync()
  const [value, setValue] = createSignal(props.initial)
  const [busy, setBusy] = createSignal(false)
  let inputEl: HTMLInputElement | undefined

  onMount(() => {
    requestAnimationFrame(() => {
      inputEl?.focus()
      inputEl?.select()
    })
  })

  const submit = async () => {
    const next = value().trim()
    if (!next || next === props.initial) {
      dialog.close()
      return
    }
    setBusy(true)
    try {
      await globalSDK.client.session.update({
        sessionID: props.sessionID,
        directory: props.directory,
        title: next,
      })
      const [, setStore] = globalSync.child(props.directory, { bootstrap: false })
      setStore(
        produce((draft) => {
          const idx = draft.session?.findIndex((s) => s.id === props.sessionID) ?? -1
          if (idx !== -1 && draft.session) draft.session[idx].title = next
        }),
      )
      dialog.close()
    } catch (err) {
      const renameResolved = resolveError(err)
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: renameResolved.category !== "unknown"
          ? language.t(renameResolved.messageKey as any)
          : err instanceof Error ? err.message : String(err),
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div class="fixed inset-0 z-[400] flex items-center justify-center pointer-events-none">
      <div
        data-component="rename-thread-dialog"
        role="dialog"
        aria-modal="true"
        class="pointer-events-auto w-[440px] rounded-[20px] bg-[#ffffff] dark:bg-[#1f1f1f] shadow-[0_24px_60px_-15px_rgba(0,0,0,0.18),0_0_0_0.5px_rgba(0,0,0,0.08)] dark:shadow-[0_24px_60px_-15px_rgba(0,0,0,0.6),0_0_0_0.5px_rgba(255,255,255,0.08)] overflow-hidden"
      >
      <form
        class="flex flex-col gap-4 p-6"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault()
            dialog.close()
          }
        }}
      >
        <div class="flex items-start justify-between gap-2">
          <div class="flex flex-col gap-1">
            <h2 class="text-[17px] font-semibold leading-tight text-text-strong">
              {language.t("sidebar.thread.rename.title")}
            </h2>
            <p class="text-[13px] text-text-weak">
              {language.t("sidebar.thread.rename.subtitle")}
            </p>
          </div>
          <button
            type="button"
            class="size-6 shrink-0 inline-flex items-center justify-center rounded text-text-weak hover:text-text-strong hover:bg-[rgba(0,0,0,0.04)] dark:hover:bg-[rgba(255,255,255,0.06)]"
            onClick={() => dialog.close()}
            aria-label={language.t("sidebar.thread.rename.cancel")}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M3 3L11 11M11 3L3 11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
            </svg>
          </button>
        </div>

        <input
          ref={inputEl}
          type="text"
          class="w-full px-3.5 py-2.5 text-[14px] rounded-[10px] bg-[#f6f6f6] dark:bg-[#2a2a2a] border border-[rgba(0,0,0,0.06)] dark:border-[rgba(255,255,255,0.08)] outline-none text-text-strong placeholder:text-text-weak transition-shadow focus:bg-[#ffffff] dark:focus:bg-[#222] focus:shadow-[0_0_0_3px_rgba(0,102,255,0.15),0_0_0_1px_rgba(0,102,255,0.5)] disabled:opacity-50"
          placeholder={language.t("sidebar.thread.rename.placeholder")}
          value={value()}
          onInput={(e) => setValue(e.currentTarget.value)}
          disabled={busy()}
        />

        <div class="flex items-center justify-end gap-2 pt-1">
          <button
            type="button"
            class="px-3 h-8 text-[13px] rounded-[6px] bg-[#ffffff] dark:bg-transparent border border-[rgba(0,0,0,0.1)] dark:border-[rgba(255,255,255,0.12)] text-text-strong hover:bg-[#f5f5f5] dark:hover:bg-[rgba(255,255,255,0.05)] disabled:opacity-50 transition-colors"
            onClick={() => dialog.close()}
            disabled={busy()}
          >
            {language.t("sidebar.thread.rename.cancel")}
          </button>
          <button
            type="submit"
            style={{ color: "light-dark(#ffffff, #1a1a1a)" }}
            class="px-3 h-8 text-[13px] rounded-[6px] bg-[#1a1a1a] hover:bg-[#000000] dark:bg-[#ffffff] dark:hover:bg-[#ededed] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            disabled={busy() || !value().trim()}
          >
            {language.t("sidebar.thread.rename.save")}
          </button>
        </div>
      </form>
      </div>
    </div>
  )
}
