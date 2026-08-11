import { createMemo, createSignal, Show } from "solid-js"
import { showToast } from "@opencode-ai/ui/toast"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useModels } from "@/context/models"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import { useProviders } from "@/hooks/use-providers"
import {
  BLANK_PROJECT_DEFAULT_BASE,
  blankProjectCreateErrorKey,
} from "@/pages/layout/codex-sidebar/blank-project"
import { CdxClose, CdxModal } from "./codex-ui"
import { CdxIcon } from "./cdx-icons"
import { CdxSchedulePill } from "./schedule-popover"
import { CdxSelect, execEnvOptions, reasoningOptions } from "./controls"
import { coerceSchedule, type ScheduleConfig } from "./schedule"
import { projectName } from "./format"
import type { AutomationTemplate } from "./templates"

type ExecEnv = "local" | "worktree" | "thread"
type Reasoning = "none" | "minimal" | "low" | "medium" | "high" | "xhigh"

type Editing = {
  id: string
  title: string
  prompt: string
  scheduleConfig: unknown
  directory?: string | null
}

// 目录 → 项目展示名(优先后端 name,否则取路径末段),对照 Codex 项目下拉
function projectLabel(p: { worktree: string; name?: string }) {
  const name = p.name?.trim()
  if (name) return name
  return projectName(p.worktree) || p.worktree
}

// 核心编辑器:标题 / prompt / 计划(全模式 Popover)真可编辑、可创建。
// 运行环境 / 项目 暂为视觉占位(详情页字段栏已接入完整下拉)。
export function AutomationEditorDialog(props: {
  template?: AutomationTemplate
  editing?: Editing
  onCreated?: () => void
  onUseTemplate?: () => void
}) {
  const dialog = useDialog()
  const globalSDK = useGlobalSDK()
  const language = useLanguage()
  const layout = useLayout()
  const platform = usePlatform()
  const server = useServer()

  const source = props.editing ?? props.template
  const [title, setTitle] = createSignal(source?.title ?? "")
  const [prompt, setPrompt] = createSignal(source?.prompt ?? "")
  const [directory, setDirectory] = createSignal<string | null>(
    (source as { directory?: string | null })?.directory ?? null,
  )
  // 「对话」(thread/heartbeat)模式:附着的已置顶对话 sessionID
  const [threadSessionID, setThreadSessionID] = createSignal<string | null>(
    (source as { threadSessionID?: string | null })?.threadSessionID ?? null,
  )
  const [schedule, setSchedule] = createSignal<ScheduleConfig>(
    coerceSchedule(
      (source as { scheduleConfig?: unknown })?.scheduleConfig,
      (source as { scheduleKind?: string })?.scheduleKind,
    ),
  )
  const [execEnv, setExecEnv] = createSignal<string>(
    (source as { executionEnvironment?: string })?.executionEnvironment ?? "local",
  )
  const models = useModels()
  const globalSync = useGlobalSync()
  const providers = useProviders()
  // 模型默认跟「新建会话的默认模型」一致(后端用此默认建自动化会话):
  // 全局配置默认 → 已连接 provider 的默认模型(= 后端默认,如 gpt-5.5)→ 最近使用的
  const defaultModelId = () => {
    if (globalSync.data.config.model) return globalSync.data.config.model
    const defaults = providers.default() as Record<string, string> | undefined
    for (const p of providers.connected()) {
      const id = defaults?.[p.id]
      if (id) return `${p.id}/${id}`
    }
    const r = models.recent.list()[0]
    return r ? `${r.providerID}/${r.modelID}` : null
  }
  const [model, setModel] = createSignal<string | null>(
    (source as { model?: string | null })?.model ?? defaultModelId(),
  )
  const [reasoning, setReasoning] = createSignal<string>(
    (source as { reasoningEffort?: string | null })?.reasoningEffort ?? "medium",
  )
  const [creating, setCreating] = createSignal(false)
  const [creatingProject, setCreatingProject] = createSignal(false)

  const modelOptions = createMemo(() => models.list().map((m) => ({ id: `${m.provider.id}/${m.id}`, label: m.name })))
  // 可选项目(对照 Codex:必选,无默认),value=目录(worktree)
  const projectOptions = createMemo(() =>
    layout.projects
      .list()
      .map((p) => ({ id: p.worktree, label: projectLabel(p as { worktree: string; name?: string }) })),
  )
  // 「对话」模式的「选择已置顶对话」选项:跨项目解析 pinnedThreadList → {id, label, directory}
  // (对照 sidebar pinned.tsx 的解析方式)
  const pinnedThreadOptions = createMemo(() => {
    const ids = new Set(layout.tree.pinnedThreadList())
    const out: Array<{ id: string; label: string; directory: string }> = []
    if (ids.size === 0) return out
    // 同一对话可能出现在 worktree 与多个 sandbox 目录里,按 session id 去重避免重复项
    const seen = new Set<string>()
    for (const project of layout.projects.list()) {
      const dirs = [project.worktree, ...((project as { sandboxes?: string[] }).sandboxes ?? [])]
      for (const dir of dirs) {
        const [store] = globalSync.child(dir, { bootstrap: false })
        for (const session of store.session ?? []) {
          if (!ids.has(session.id) || session.parentID || session.time?.archived) continue
          if (seen.has(session.id)) continue
          seen.add(session.id)
          out.push({ id: session.id, label: session.title || session.id.slice(0, 8), directory: dir })
        }
      }
    }
    return out
  })
  // 选已置顶对话:记下 sessionID + 其所属项目目录(thread 模式 cwd 用它)
  function pickThread(id: string) {
    setThreadSessionID(id)
    const opt = pinnedThreadOptions().find((o) => o.id === id)
    if (opt) setDirectory(opt.directory)
  }

  async function createProject() {
    if (!platform.createBlankProject || !platform.getBlankProjectDefaults) return
    setCreatingProject(true)
    try {
      const defaults = await platform.getBlankProjectDefaults({ baseName: BLANK_PROJECT_DEFAULT_BASE })
      const dir = await platform.createBlankProject({ parent: defaults.parent, name: defaults.name })
      layout.projects.open(dir)
      server.projects.touch(dir)
      setDirectory(dir)
    } catch (err) {
      const key = blankProjectCreateErrorKey(err)
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: key ? language.t(key) : err instanceof Error ? err.message : String(err),
      })
    } finally {
      setCreatingProject(false)
    }
  }

  async function save() {
    const isThread = execEnv() === "thread"
    const dir = directory()
    // 对话模式必选已置顶对话;其余模式必选项目
    if (!title().trim() || !prompt().trim() || (isThread ? !threadSessionID() : !dir)) {
      showToast({ title: language.t("automation.editor.required") })
      return
    }
    const thread = isThread ? threadSessionID() : null
    setCreating(true)
    const editing = props.editing
    const res = editing
      ? await globalSDK.client.automation.update({
          automationID: editing.id,
          title: title().trim(),
          scheduleConfig: schedule(),
          prompt: prompt().trim(),
          cwd: dir ?? undefined,
          threadSessionID: thread ?? undefined,
          executionEnvironment: execEnv() as ExecEnv,
          model: model() ?? undefined,
          reasoningEffort: reasoning() as Reasoning,
        })
      : await globalSDK.client.automation.create({
          title: title().trim(),
          template: "custom",
          scheduleConfig: schedule(),
          prompt: prompt().trim(),
          cwd: dir ?? undefined,
          threadSessionID: thread ?? undefined,
          executionEnvironment: execEnv() as ExecEnv,
          model: model() ?? undefined,
          reasoningEffort: reasoning() as Reasoning,
        })
    setCreating(false)
    if (res.error) {
      showToast({ title: language.t(editing ? "automation.toast.updateFailed" : "automation.toast.createFailed") })
      return
    }
    showToast({ title: language.t(editing ? "automation.toast.updated" : "automation.toast.created") })
    dialog.close()
    props.onCreated?.()
  }


  return (
    <CdxModal
      maxWidth={860}
      title={
        <input
          autofocus
          value={title()}
          onInput={(e) => setTitle(e.currentTarget.value)}
          placeholder={language.t("automation.editor.titlePlaceholder")}
          class="cdx-title-input"
        />
      }
      action={
        <div class="flex items-center gap-2">
          <button
            type="button"
            class="cdx-btn cdx-btn--ghost cdx-btn--sm"
            onClick={() => {
              setTitle("")
              setPrompt("")
            }}
          >
            {language.t("automation.editor.clear")}
          </button>
          <Show when={!props.editing}>
            <button
              type="button"
              class="cdx-btn cdx-btn--secondary cdx-btn--sm"
              onClick={() => props.onUseTemplate?.()}
            >
              {language.t("automation.editor.useTemplate")}
            </button>
          </Show>
          <CdxClose onClick={() => dialog.close()} />
        </div>
      }
    >
      <div class="flex flex-col gap-4">
        <div class="flex flex-col gap-1.5">
          <label class="cdx-field__label" for="automation-prompt">
            {language.t("automation.editor.promptLabel")}
          </label>
          <textarea
            id="automation-prompt"
            value={prompt()}
            onInput={(e) => setPrompt(e.currentTarget.value)}
            placeholder={language.t("automation.editor.promptPlaceholder")}
            class="cdx-textarea"
          />
          <p class="cdx-field__help">{language.t("automation.editor.promptHelp")}</p>
        </div>

        <div class="cdx-modal__footer" style={{ "flex-wrap": "wrap" }}>
          <div class="cdx-toolbar">
            <CdxSelect
              value={execEnv()}
              options={execEnvOptions(language.t, execEnv())}
              cdxIcon={execEnv() === "local" ? "laptop" : "worktree"}
              onChange={(v) => {
                setExecEnv(v)
                // 绑定对话(thread/heartbeat)默认每隔 30 分钟(对照 Codex)
                if (v === "thread" && schedule().mode !== "interval") {
                  setSchedule({ ...schedule(), mode: "interval", intervalMinutes: 30 })
                }
              }}
              triggerClass="cdx-pill"
            />
            <Show
              when={execEnv() === "thread"}
              fallback={
                <div class="cdx-project-picker">
                  <CdxSelect
                    value={directory()}
                    options={projectOptions()}
                    cdxIcon="folder"
                    placeholder={language.t("automation.editor.chooseProject")}
                    ariaLabel={language.t("automation.detail.project")}
                    onChange={setDirectory}
                    triggerClass="cdx-pill cdx-project-picker__select"
                  />
                  <Show when={platform.createBlankProject && platform.getBlankProjectDefaults}>
                    <button
                      type="button"
                      class="cdx-pill cdx-pill--action"
                      disabled={creatingProject()}
                      aria-label={language.t("sidebar.filter.add.blank")}
                      onClick={() => void createProject()}
                    >
                      <CdxIcon name="folder" class="cdx-pill__lead shrink-0" />
                      <span class="cdx-select__label truncate">
                        {creatingProject() ? language.t("common.loading") : language.t("sidebar.filter.add.blank")}
                      </span>
                    </button>
                  </Show>
                </div>
              }
            >
              <CdxSelect
                value={threadSessionID()}
                options={pinnedThreadOptions()}
                cdxIcon="clock"
                placeholder={language.t("automation.editor.chooseThread")}
                ariaLabel={language.t("automation.editor.chooseThread")}
                onChange={pickThread}
                triggerClass="cdx-pill cdx-thread-picker__select"
              />
            </Show>
            <CdxSchedulePill config={schedule()} onChange={setSchedule} />
            <CdxSelect
              value={model()}
              options={modelOptions()}
              cdxIcon="model"
              placeholder={language.t("automation.detail.modelDefault")}
              ariaLabel={language.t("automation.detail.model")}
              onChange={setModel}
              triggerClass="cdx-pill cdx-model-pill"
            />
            <CdxSelect
              value={reasoning()}
              options={reasoningOptions(language.t)}
              cdxIcon="reasoning"
              iconOnly
              ariaLabel={language.t("automation.detail.reasoning")}
              onChange={setReasoning}
              triggerClass="cdx-iconbtn"
            />
          </div>

          <div class="flex items-center gap-2">
            <button type="button" class="cdx-btn cdx-btn--ghost" onClick={() => dialog.close()}>
              {language.t("automation.editor.cancel")}
            </button>
            <button
              type="button"
              class="cdx-btn cdx-btn--primary"
              disabled={creating() || creatingProject() || !title().trim() || !prompt().trim() || !directory()}
              title={!directory() ? language.t("automation.editor.chooseProject") : undefined}
              onClick={save}
            >
              {language.t(props.editing ? "automation.editor.save" : "automation.editor.create")}
            </button>
          </div>
        </div>
      </div>
    </CdxModal>
  )
}
