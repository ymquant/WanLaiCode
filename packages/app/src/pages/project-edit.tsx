import { createEffect, createMemo, For, Show } from "solid-js"
import { useNavigate, useParams } from "@solidjs/router"
import { Button } from "@opencode-ai/ui/button"
import { TextField } from "@opencode-ai/ui/text-field"
import { Icon } from "@opencode-ai/ui/icon"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { showToast } from "@opencode-ai/ui/toast"
import { useMutation } from "@tanstack/solid-query"
import { createStore, produce } from "solid-js/store"
import { decode64 } from "@/utils/base64"
import { getFilename } from "@opencode-ai/core/util/path"
import { projectNamePatch, PROJECT_NAME_MAX_LENGTH } from "@/utils/project-name"

interface EnvVar {
  key: string
  value: string
}

export default function ProjectEditPage() {
  const navigate = useNavigate()
  const params = useParams()
  const globalSDK = useGlobalSDK()
  const globalSync = useGlobalSync()
  const language = useLanguage()

  const projectDir = createMemo(() => decode64(params.dir))
  const project = createMemo(() => {
    const dir = projectDir()
    if (!dir) return undefined
    return globalSync.data.project.find((p) => p.worktree === dir)
  })

  const folderName = createMemo(() => {
    const p = project()
    return p ? getFilename(p.worktree) : ""
  })

  const [store, setStore] = createStore({
    name: "",
    // 名称输入框初始就被填成后端值或目录名，因此「用户是否动过名称」必须单独记：
    // 没动过就完全不带 name 字段，避免只改脚本/环境变量的保存顺手改写存量名称。
    nameTouched: false,
    setupScript: "",
    cleanupScript: "",
    envVars: [] as EnvVar[],
  })

  // 初始化数据。用 createEffect 而不是 onMount：project() 依赖 globalSync 的项目列表，
  // 首次渲染时列表可能还没就绪（刷新页面直达本路由、或列表仍在加载）。onMount 只跑一次，
  // 那种情况下会带着空表单停在这里，之后列表到了也不会再填。
  // initialized 保证只初始化一次，不会在用户已经开始编辑后被后台刷新覆盖掉输入。
  let initialized = false
  createEffect(() => {
    if (initialized) return
    const p = project()
    if (!p) return
    initialized = true
    setStore({
      name: p.name || folderName(),
      setupScript: p.commands?.setup ?? "",
      cleanupScript: p.commands?.cleanup ?? "",
      envVars: p.env ? Object.entries(p.env).map(([key, value]) => ({ key, value: String(value) })) : [],
    })
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
      const p = project()
      if (!p) return

      const setup = store.setupScript.trim() || undefined
      const cleanup = store.cleanupScript.trim() || undefined

      const env: Record<string, string> = {}
      for (const { key, value } of store.envVars) {
        if (key.trim()) env[key.trim()] = value
      }

      const namePatch = projectNamePatch(store.name, folderName(), store.nameTouched)

      await globalSDK.client.project.update({
        projectID: p.id,
        directory: p.worktree,
        ...namePatch,
        commands: { setup, cleanup },
        env: Object.keys(env).length > 0 ? env : undefined,
      })

      globalSync.set(
        "project",
        produce((draft) => {
          const idx = draft.findIndex((proj) => proj.id === p.id)
          if (idx !== -1) draft[idx] = { ...draft[idx], ...namePatch, commands: { setup, cleanup }, env: Object.keys(env).length > 0 ? env : undefined }
        }),
      )

      globalSync.project.meta(p.worktree, { ...namePatch, commands: { setup, cleanup }, env: Object.keys(env).length > 0 ? env : undefined })
    },
    onSuccess: () => {
      showToast({ title: language.t("common.saved") })
      navigate(-1)
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

  const handleBack = () => {
    navigate(-1)
  }

  return (
    <div class="flex h-full flex-col bg-background-base">
      {/* 顶部面包屑导航 */}
      <div class="flex items-center gap-1 border-b border-border-weaker-base px-4 py-2 text-13-regular">
        <button
          onClick={handleBack}
          class="flex items-center gap-1 text-text-weak hover:text-text-strong"
        >
          <Icon name="arrow-left" class="size-4" />
          {language.t("common.back")}
        </button>
        <span class="text-text-weak">›</span>
        <span class="text-text-weak">{language.t("settings.environment.title")}</span>
        <span class="text-text-weak">›</span>
        <span class="text-text-weak">{folderName()}</span>
        <span class="text-text-weak">›</span>
        <span class="text-text-strong">{language.t("project.edit.title")}</span>
      </div>

      {/* 项目数据就绪前不渲染表单：createEffect 初始化依赖 globalSync 的项目列表，
          若在列表到达前就让表单可编辑，列表一到 setStore 会覆盖用户已输入的内容。
          不用「跟踪 dirty 后跳过初始化」的做法 —— 那样用户在加载窗口里动了脚本框，
          名称/清理脚本/环境变量就永远不会被填充，表单会显示成空而非既有值。 */}
      <Show
        when={project()}
        fallback={
          <div class="flex flex-1 items-center justify-center text-14-regular text-text-weak">
            {language.t("common.loading")}
          </div>
        }
      >
      {/* 内容区域 */}
      <div class="flex-1 overflow-y-auto">
        <div class="mx-auto max-w-[720px] px-4 py-6 sm:px-10">
          {/* 标题 */}
          <h1 class="text-18-medium text-text-strong mb-6">{language.t("settings.environment.title")}</h1>

          {/* 本地环境 */}
          <div class="mb-6">
            <h3 class="text-14-medium text-text-strong mb-3">{language.t("project.edit.localEnvironment")}</h3>
            <div class="flex items-center gap-3 rounded-xl border border-border-weaker-base bg-surface-raised-stronger-non-alpha px-4 py-3">
              <Icon name="folder" class="size-5 text-text-base" />
              <div class="flex flex-col">
                <span class="text-14-medium text-text-strong">{folderName()}</span>
                <span class="text-12-regular text-text-weak">{project()?.worktree}</span>
              </div>
            </div>
          </div>

          {/* 名称 */}
          <div class="mb-6">
            <TextField
              type="text"
              label={language.t("project.edit.environmentName")}
              placeholder={folderName()}
              maxLength={PROJECT_NAME_MAX_LENGTH}
              value={store.name}
              onChange={(v) => setStore({ name: v.slice(0, PROJECT_NAME_MAX_LENGTH), nameTouched: true })}
              class="max-w-[320px]"
            />
          </div>

          {/* 设置脚本 */}
          <div class="mb-6">
            <div class="mb-2">
              <label class="text-14-medium text-text-strong">{language.t("project.edit.setupScript")}</label>
              <p class="text-12-regular text-text-weak mt-1">
                {language.t("project.edit.setupScriptDescription")}
              </p>
            </div>
            <textarea
              class="w-full rounded-xl border border-border-weaker-base bg-surface-raised-stronger-non-alpha px-4 py-3 text-13-regular text-text-strong placeholder:text-text-weak focus:border-border-weak-base focus:outline-none resize-y"
              rows={5}
              placeholder={language.t("project.edit.setupScriptPlaceholder")}
              value={store.setupScript}
              onInput={(e) => setStore("setupScript", e.currentTarget.value)}
            />
          </div>

          {/* 清理脚本 */}
          <div class="mb-6">
            <div class="mb-2">
              <label class="text-14-medium text-text-strong">{language.t("project.edit.cleanupScript")}</label>
              <p class="text-12-regular text-text-weak mt-1">
                {language.t("project.edit.cleanupScriptDescription")}
              </p>
            </div>
            <textarea
              class="w-full rounded-xl border border-border-weaker-base bg-surface-raised-stronger-non-alpha px-4 py-3 text-13-regular text-text-strong placeholder:text-text-weak focus:border-border-weak-base focus:outline-none resize-y"
              rows={3}
              placeholder={language.t("project.edit.cleanupScriptPlaceholder")}
              value={store.cleanupScript}
              onInput={(e) => setStore("cleanupScript", e.currentTarget.value)}
            />
          </div>

          {/* 环境变量 */}
          <div class="mb-6">
            <div class="flex items-center justify-between mb-3">
              <label class="text-14-medium text-text-strong">{language.t("project.edit.envVars")}</label>
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
          </div>
        </div>
      </div>

      {/* 底部保存按钮。与表单同处一个 Show 内：表单未填充时不应出现可点的保存按钮，
          否则点下去会把空的脚本/环境变量当成用户意图写回后端。 */}
      <div class="border-t border-border-weaker-base px-4 py-3">
        <div class="mx-auto max-w-[720px] flex justify-end">
          <Button
            variant="primary"
            size="large"
            disabled={saveMutation.isPending}
            onClick={handleSave}
            class="!rounded-full px-3"
          >
            {saveMutation.isPending ? language.t("common.saving") : language.t("common.save")}
          </Button>
        </div>
      </div>
      </Show>
    </div>
  )
}
