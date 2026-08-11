import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { TextField } from "@opencode-ai/ui/text-field"
import { showToast } from "@opencode-ai/ui/toast"
import { useMutation } from "@tanstack/solid-query"
import { createMemo, For, Show } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { type LocalProject } from "@/context/layout"
import { getFilename } from "@opencode-ai/core/util/path"
import { useLanguage } from "@/context/language"
import { Icon } from "@opencode-ai/ui/icon"

interface EnvVar {
  key: string
  value: string
}

export function DialogEditProject(props: { project: LocalProject }) {
  const dialog = useDialog()
  const globalSDK = useGlobalSDK()
  const globalSync = useGlobalSync()
  const language = useLanguage()

  const folderName = createMemo(() => getFilename(props.project.worktree))
  const defaultSetup = createMemo(() => props.project.commands?.setup ?? "")
  const defaultCleanup = createMemo(() => props.project.commands?.cleanup ?? "")
  const defaultEnv = createMemo<EnvVar[]>(() => {
    const env = props.project.env
    if (!env) return []
    return Object.entries(env).map(([key, value]) => ({ key, value: String(value) }))
  })

  const [store, setStore] = createStore({
    setupScript: defaultSetup(),
    cleanupScript: defaultCleanup(),
    envVars: defaultEnv(),
  })

  const addEnvVar = () => {
    setStore("envVars", [...store.envVars, { key: "", value: "" }])
  }

  const removeEnvVar = (index: number) => {
    setStore("envVars", store.envVars.filter((_, i) => i !== index))
  }

  const updateEnvVar = (index: number, field: keyof EnvVar, value: string) => {
    setStore("envVars", produce((draft) => {
      draft[index][field] = value
    }))
  }

  const saveMutation = useMutation(() => ({
    mutationFn: async () => {
      const setup = store.setupScript.trim() || undefined
      const cleanup = store.cleanupScript.trim() || undefined

      const env: Record<string, string> = {}
      for (const { key, value } of store.envVars) {
        if (key.trim()) env[key.trim()] = value
      }

      if (props.project.id && props.project.id !== "global") {
        await globalSDK.client.project.update({
          projectID: props.project.id,
          directory: props.project.worktree,
          commands: { setup, cleanup },
          env: Object.keys(env).length > 0 ? env : undefined,
        })
        globalSync.set(
          "project",
          produce((draft) => {
            const idx = draft.findIndex((p) => p.id === props.project.id)
            if (idx !== -1) draft[idx] = { ...draft[idx], commands: { setup, cleanup }, env: Object.keys(env).length > 0 ? env : undefined }
          }),
        )
      }

      globalSync.project.meta(props.project.worktree, { commands: { setup, cleanup }, env: Object.keys(env).length > 0 ? env : undefined })
    },
    onSuccess: () => {
      dialog.close()
    },
    onError: (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      showToast({ title: language.t("common.requestFailed"), description: message })
    },
  }))

  const handleSave = () => {
    if (saveMutation.isPending) return
    saveMutation.mutate()
  }

  function handleSubmit(e: SubmitEvent) {
    e.preventDefault()
    handleSave()
  }

  return (
    <Dialog
      fit
      title={language.t("dialog.project.edit.title")}
      description={language.t("dialog.project.edit.description")}
      class="codex-dialog w-full max-w-[640px] mx-auto !min-h-0"
    >
      <form onSubmit={handleSubmit} class="flex flex-col gap-6 p-6 pt-0 max-h-[70vh] overflow-y-auto">
        {/* 本地环境 */}
        <div class="flex flex-col gap-2">
          <label class="text-14-medium text-text-strong">{language.t("project.edit.localEnvironment")}</label>
          <div class="flex items-center gap-3 rounded-xl border border-border-weaker-base bg-surface-raised-stronger-non-alpha px-4 py-3">
            <Icon name="folder" class="size-5 shrink-0 text-text-base" />
            <div class="flex flex-col min-w-0">
              <span class="text-14-medium text-text-strong">{folderName()}</span>
              <span class="text-12-regular text-text-weak truncate">{props.project.worktree}</span>
            </div>
          </div>
        </div>

        {/* 设置脚本 */}
        <div class="flex flex-col gap-2">
          <div>
            <label class="text-14-medium text-text-strong">{language.t("project.edit.setupScript")}</label>
            <p class="text-12-regular text-text-weak mt-0.5">
              {language.t("project.edit.setupScriptDescription")}
            </p>
          </div>
          <textarea
            class="w-full rounded-xl border border-border-weaker-base bg-surface-raised-stronger-non-alpha px-4 py-3 text-13-regular text-text-strong placeholder:text-text-weak focus:border-border-weak-base focus:outline-none resize-none font-mono"
            rows={4}
            placeholder={language.t("project.edit.setupScriptPlaceholder")}
            value={store.setupScript}
            onInput={(e) => setStore("setupScript", e.currentTarget.value)}
          />
        </div>

        {/* 清理脚本 */}
        <div class="flex flex-col gap-2">
          <div>
            <label class="text-14-medium text-text-strong">{language.t("project.edit.cleanupScript")}</label>
            <p class="text-12-regular text-text-weak mt-0.5">
              {language.t("project.edit.cleanupScriptDescription")}
            </p>
          </div>
          <textarea
            class="w-full rounded-xl border border-border-weaker-base bg-surface-raised-stronger-non-alpha px-4 py-3 text-13-regular text-text-strong placeholder:text-text-weak focus:border-border-weak-base focus:outline-none resize-none font-mono"
            rows={3}
            placeholder={language.t("project.edit.cleanupScriptPlaceholder")}
            value={store.cleanupScript}
            onInput={(e) => setStore("cleanupScript", e.currentTarget.value)}
          />
        </div>

        {/* 环境变量 */}
        <div class="flex flex-col gap-3">
          <div class="flex items-center justify-end">
            <Button
              type="button"
              variant="ghost"
              size="small"
              onClick={addEnvVar}
              class="!text-text-interactive-base"
            >
              <Icon name="plus" class="size-4" />
              {language.t("project.edit.addEnvVar")}
            </Button>
          </div>
          <Show when={store.envVars.length > 0}>
            <div class="flex flex-col gap-2">
              <For each={store.envVars}>
                {(envVar, index) => (
                  <div class="flex items-center gap-2">
                    <TextField
                      type="text"
                      placeholder={language.t("project.edit.envKey")}
                      value={envVar.key}
                      onChange={(v) => updateEnvVar(index(), "key", v)}
                      class="flex-1"
                    />
                    <TextField
                      type="text"
                      placeholder={language.t("project.edit.envValue")}
                      value={envVar.value}
                      onChange={(v) => updateEnvVar(index(), "value", v)}
                      class="flex-1"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="small"
                      onClick={() => removeEnvVar(index())}
                      class="!text-text-weak hover:!text-text-strong"
                    >
                      <Icon name="close" class="size-4" />
                    </Button>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </div>

        {/* 底部按钮 */}
        <div class="flex justify-end gap-2 pt-2 border-t border-border-weaker-base">
          <Button type="button" variant="ghost" size="large" onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </Button>
          <Button
            type="button"
            variant="primary"
            size="large"
            disabled={saveMutation.isPending}
            onClick={handleSave}
            class="!rounded-full px-3"
          >
            {saveMutation.isPending ? language.t("common.saving") : language.t("common.save")}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
