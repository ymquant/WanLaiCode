import { Button } from "@opencode-ai/ui/button"
import { Select } from "@opencode-ai/ui/select"
import { Switch } from "@opencode-ai/ui/switch"
import { TextField } from "@opencode-ai/ui/text-field"
import { showToast } from "@opencode-ai/ui/toast"
import { useParams } from "@solidjs/router"
import { createEffect, createMemo, createSignal, For, onCleanup, Show, untrack, type Component, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import { useLayout } from "@/context/layout"
import { authTokenFromCredentials } from "@/utils/server"
import { decode64 } from "@/utils/base64"
import { pathKey } from "@/utils/path-key"
import { SettingsList } from "./settings-list"
import { buildMemoryRequestURL, memoryScopePayload } from "./settings-memory-helpers"

type MemoryScope = "global" | "project"
type MemoryScopeFilter = "all" | MemoryScope
type MemoryMode = "auto" | "read_only" | "off"

type MemoryEntry = {
  id: string
  scope: MemoryScope
  name: string
  title: string
  summary: string
  projectDirectory?: string
}

type MemoryDetail = MemoryEntry & { document: string }

type MemoryConfig = {
  enabled?: boolean
  default_mode?: MemoryMode
  max_prompt_entries?: number
  max_prompt_chars?: number
}

type MemoryContext = {
  directory?: string
  sessionID?: string
}

type RequestQuery = MemoryContext & {
  scope?: MemoryScope
  search?: string
  limit?: number
}

type ProjectOption = {
  id: string
  name?: string
  worktree: string
}

type ProjectFilterOption = ProjectOption | { id: "all"; name: string; worktree: "all" }

const scopes = ["global", "project"] as const
const scopeFilters = ["all", ...scopes] as const
const modes = ["auto", "read_only", "off"] as const
const listClass =
  "[&>div]:rounded-[18px] [&>div]:border [&>div]:border-border-weaker-base [&>div]:bg-surface-raised-stronger-non-alpha [&>div]:px-0 [&>div]:shadow-none"
const switchClass = "settings-general-switch"
const selectClass = "settings-general-select"
const compactSelectClass = "settings-memory-select-compact"
const projectSelectClass = "settings-memory-select-project"

const defaults: Required<MemoryConfig> = {
  enabled: true,
  default_mode: "auto",
  max_prompt_entries: 8,
  max_prompt_chars: 4000,
}

export const SettingsMemory: Component = () => {
  const language = useLanguage()
  const platform = usePlatform()
  const server = useServer()
  const layout = useLayout()
  const params = useParams()
  const directory = createMemo(() => decode64(params.dir))
  const sessionID = createMemo(() => params.id)
  const [state, setState] = createStore({
    loading: true,
    saving: false,
    filter: "all" as MemoryScopeFilter,
    projectFilter: "all",
    search: "",
    config: defaults,
    memories: [] as MemoryEntry[],
    context: {} as MemoryContext,
    form: undefined as
      | undefined
      | {
          id?: string
          scope: MemoryScope
          projectDirectory?: string
          targetProjectLocked?: boolean
          content: string
        },
  })

  const copy = createMemo(() => {
    if (language.locale().startsWith("zh")) {
      return {
        title: "记忆",
        description: "管理会注入到新回答中的长期偏好、项目事实和工作流。",
        enabledTitle: "启用记忆",
        enabledDescription: "关闭后不会查询或写入记忆。",
        modeTitle: "默认模式",
        modeDescription: "控制所有会话如何读取和写入记忆。",
        maxEntriesTitle: "最多注入条数",
        maxEntriesDescription: "超过限制时只注入排序更靠前的记忆索引。",
        maxCharsTitle: "最多注入字符",
        maxCharsDescription: "限制每次回答注入的记忆索引字符数。",
        add: "新增",
        save: "保存",
        cancel: "取消",
        edit: "编辑",
        delete: "删除",
        search: "搜索记忆",
        empty: "暂无记忆",
        loading: "正在加载记忆",
        content: "内容",
        scope: "范围",
        currentProject: "当前项目",
        targetProject: "项目",
        allProjects: "全部项目",
        noOpenProjects: "暂无已打开项目",
        newMemory: "新增记忆",
        editMemory: "编辑记忆",
        saved: "记忆已保存",
        processing: "正在整理并保存",
        sessionRequired: "请先从一个会话进入再新增记忆",
        memoryNotWritable: "当前记忆模式不允许新增记忆",
        deleted: "记忆已删除",
        loadFailed: "加载记忆失败",
        saveFailed: "保存记忆失败",
        deleteFailed: "删除记忆失败",
        unavailableProject: "当前项目不可用",
      }
    }
    return {
      title: "Memory",
      description: "Manage long-term preferences, project facts, and workflows injected into future replies.",
      enabledTitle: "Enable memory",
      enabledDescription: "When disabled, memory is neither read nor written.",
      modeTitle: "Default mode",
      modeDescription: "Controls how all sessions read and write memory.",
      maxEntriesTitle: "Max prompt entries",
      maxEntriesDescription: "When over the limit, only higher-ranked memory index entries are injected.",
      maxCharsTitle: "Max prompt chars",
      maxCharsDescription: "Limits the memory index characters injected into each reply.",
      add: "Add",
      save: "Save",
      cancel: "Cancel",
      edit: "Edit",
      delete: "Delete",
      search: "Search memory",
      empty: "No memories yet",
      loading: "Loading memory",
      content: "Content",
      scope: "Scope",
      currentProject: "Current project",
      targetProject: "Project",
      allProjects: "All projects",
      noOpenProjects: "No open projects",
      newMemory: "New memory",
      editMemory: "Edit memory",
      saved: "Memory saved",
      processing: "Processing and saving",
      sessionRequired: "Open memory settings from a session to add memory",
      memoryNotWritable: "The current memory mode does not allow new memories",
      deleted: "Memory deleted",
      loadFailed: "Failed to load memory",
      saveFailed: "Failed to save memory",
      deleteFailed: "Failed to delete memory",
      unavailableProject: "Project unavailable",
    }
  })

  const labels = {
    scope: (scope: MemoryScopeFilter) => {
      if (language.locale().startsWith("zh")) {
        if (scope === "all") return "全部"
        if (scope === "global") return "全局"
        if (scope === "project") return "项目"
      }
      if (scope === "all") return "All"
      if (scope === "global") return "Global"
      if (scope === "project") return "Project"
      return scope
    },
    formScope: (scope: MemoryScope) => {
      if (language.locale().startsWith("zh")) {
        if (scope === "project") return "项目（当前）"
        return "全局"
      }
      if (scope === "project") return "Project (current)"
      return "Global"
    },
    mode: (mode: MemoryMode) => {
      if (language.locale().startsWith("zh")) {
        if (mode === "auto") return "自动读写"
        if (mode === "read_only") return "只读"
        return "关闭"
      }
      if (mode === "auto") return "Auto"
      if (mode === "read_only") return "Read only"
      return "Off"
    },
  }

  const selectedMode = createMemo(() => modes.find((mode) => mode === state.config.default_mode) ?? "auto")
  const selectedFilter = createMemo(() => scopeFilters.find((scope) => scope === state.filter) ?? "all")
  const canCreate = createMemo(
    () => !!sessionID() && state.config.enabled !== false && state.config.default_mode === "auto",
  )
  const currentProjectPath = createMemo(() => state.context.directory ?? directory())
  const projectOptions = createMemo(() =>
    layout.projects
      .list()
      .flatMap((project) => (project.id && project.worktree ? [{ id: project.id, name: project.name, worktree: project.worktree }] : [])),
  )
  const currentProjectOption = createMemo(() =>
    projectOptions().find((project) => pathKey(project.worktree) === pathKey(currentProjectPath() ?? "")),
  )
  const defaultProjectOption = createMemo(() => currentProjectOption() ?? projectOptions()[0])
  const projectFilterOptions = createMemo<ProjectFilterOption[]>(() => [
    { id: "all", name: copy().allProjects, worktree: "all" },
    ...projectOptions(),
  ])
  const selectedProjectFilter = createMemo(
    () => projectFilterOptions().find((project) => project.worktree === state.projectFilter) ?? projectFilterOptions()[0],
  )

  function basename(input: string) {
    return input.split(/[\\/]/).filter(Boolean).at(-1) ?? input
  }

  function projectLabel(project: ProjectOption | undefined) {
    if (!project) return copy().unavailableProject
    const title = project.name || basename(project.worktree)
    return `${title} · ${project.worktree}`
  }

  function projectFilterLabel(project: ProjectFilterOption | undefined) {
    if (!project) return copy().allProjects
    if (project.worktree === "all") return copy().allProjects
    return projectLabel(project)
  }

  function formProject(form: NonNullable<typeof state.form>) {
    return (
      projectOptions().find((project) => pathKey(project.worktree) === pathKey(form.projectDirectory ?? "")) ??
      defaultProjectOption()
    )
  }

  const scopedMemories = createMemo(() => {
    const query = state.search.trim().toLowerCase()
    return state.memories.filter((memory) => {
      if (state.filter !== "all" && memory.scope !== state.filter) return false
      if (state.projectFilter !== "all") {
        if (memory.scope !== "project") return false
        if (!memory.projectDirectory || pathKey(memory.projectDirectory) !== pathKey(state.projectFilter)) return false
      }
      if (!query) return true
      return `${memory.title} ${memory.summary}`.toLowerCase().includes(query)
    })
  })

  function headers(json: boolean) {
    const result: Record<string, string> = {
      accept: "application/json",
    }
    if (json) result["content-type"] = "application/json"
    const current = server.current
    if (current?.http.password) {
      result.authorization = `Basic ${authTokenFromCredentials({
        username: current.http.username,
        password: current.http.password,
      })}`
    }
    return result
  }

  async function request<T>(path: string, input?: { method?: string; body?: unknown; query?: RequestQuery }) {
    const response = await (platform.fetch ?? fetch)(
      buildMemoryRequestURL(server.current?.http.url ?? "", path, {
        directory: directory(),
        sessionID: sessionID(),
        ...input?.query,
      }),
      {
        method: input?.method ?? "GET",
        headers: headers(input?.body !== undefined),
        body: input?.body === undefined ? undefined : JSON.stringify(input.body),
      },
    )
    if (!response.ok) throw new Error(await response.text())
    return (await response.json()) as T
  }

  async function refresh() {
    setState("loading", true)
    try {
      const [config, projects] = await Promise.all([
        request<MemoryConfig>("/memory/config"),
        request<ProjectOption[]>("/project").catch(() => []),
      ])
      const context = {
        directory: directory(),
        sessionID: sessionID(),
      }
      const [globalMemories, projectMemories] = await Promise.all([
        request<MemoryEntry[]>("/memory", { query: { scope: "global", limit: 200 } }),
        Promise.all(
          projects.map((project) =>
            request<MemoryEntry[]>("/memory", {
              query: { directory: project.worktree, scope: "project", limit: 200 },
            })
              .then((items) => items.map((item) => ({ ...item, projectDirectory: project.worktree })))
              .catch(() => []),
          ),
        ),
      ])
      const memories = Array.from(
        new Map([...globalMemories, ...projectMemories.flat()].map((memory) => [memory.id, memory])).values(),
      )
      setState("config", { ...defaults, ...config })
      setState("context", context)
      setState("memories", memories)
    } catch (error) {
      console.error("[settings-memory] load failed", error)
      showToast({ title: copy().loadFailed, variant: "error" })
    } finally {
      setState("loading", false)
    }
  }

  createEffect(() => {
    const key = `${server.current?.http.url ?? ""}:${directory() ?? ""}:${sessionID() ?? ""}`
    if (!key) return
    let disposed = false
    untrack(() => {
      void refresh().finally(() => {
        if (disposed) return
      })
    })
    onCleanup(() => {
      disposed = true
    })
  })

  async function saveConfig(patch: MemoryConfig) {
    const previous = state.config
    const next = { ...previous, ...patch }
    setState("config", next)
    try {
      await request<MemoryConfig>("/memory/config", { method: "PATCH", body: patch })
    } catch (error) {
      console.error("[settings-memory] config save failed", error)
      setState("config", previous)
      showToast({ title: copy().saveFailed, variant: "error" })
    }
  }

  function openNew() {
    if (!canCreate()) return
    const project = defaultProjectOption()
    setState("form", { scope: "global", projectDirectory: project?.worktree, content: "" })
  }

  async function openEdit(memory: MemoryEntry) {
    const project =
      memory.scope === "project"
        ? projectOptions().find((item) => pathKey(item.worktree) === pathKey(memory.projectDirectory ?? "")) ??
          defaultProjectOption()
        : undefined
    try {
      const detail = await request<MemoryDetail>(`/memory/${memory.id}`, {
        query: memory.projectDirectory ? { directory: memory.projectDirectory } : undefined,
      })
      setState("form", {
        id: memory.id,
        scope: memory.scope,
        projectDirectory: project?.worktree,
        targetProjectLocked: memory.scope === "project",
        content: detail.document,
      })
    } catch (error) {
      console.error("[settings-memory] detail load failed", error)
      showToast({ title: copy().loadFailed, variant: "error" })
    }
  }

  function scopeDisabled(scope: MemoryScope) {
    if (scope === "project") return projectOptions().length === 0
    return false
  }

  function scopeDisabledLabel(scope: MemoryScope) {
    if (scope === "project") return copy().unavailableProject
  }

  async function saveForm() {
    const form = state.form
    if (!form || !form.content.trim() || scopeDisabled(form.scope)) return
    if (!form.id && !canCreate()) return
    const project = form.scope === "project" ? formProject(form) : undefined
    if (form.scope === "project" && !project) return
    setState("saving", true)
    try {
      const query = form.projectDirectory ? { directory: form.projectDirectory } : project ? { directory: project.worktree } : undefined
      if (form.id) {
        await request<MemoryDetail>(`/memory/${form.id}`, {
          method: "PATCH",
          body: { document: form.content.trim() },
          query,
        })
      } else {
        await request<MemoryDetail>("/memory", {
          method: "POST",
          body: {
            ...memoryScopePayload(form.scope),
            content: form.content.trim(),
            sessionID: sessionID(),
          },
          query,
        })
      }
      setState("form", undefined)
      showToast({ title: copy().saved })
      await refresh()
    } catch (error) {
      console.error("[settings-memory] save failed", error)
      showToast({ title: copy().saveFailed, variant: "error" })
    } finally {
      setState("saving", false)
    }
  }

  async function remove(memory: MemoryEntry) {
    try {
      setState(
        "memories",
        state.memories.filter((item) => item.id !== memory.id),
      )
      await request<boolean>(`/memory/${memory.id}`, {
        method: "DELETE",
        query: memory.projectDirectory ? { directory: memory.projectDirectory } : undefined,
      })
      showToast({ title: copy().deleted })
    } catch (error) {
      console.error("[settings-memory] delete failed", error)
      showToast({ title: copy().deleteFailed, variant: "error" })
      await refresh()
    }
  }

  return (
    <>
      <style>{`
        [data-component="switch"].settings-general-switch [data-slot="switch-control"] {
          width: 40px;
          height: 24px;
          border-radius: 999px;
          border: 1px solid var(--border-weaker-base);
          background: var(--surface-weak);
          transition: background-color 150ms, border-color 150ms;
        }

        [data-component="switch"].settings-general-switch [data-slot="switch-thumb"] {
          width: 18px;
          height: 18px;
          border: none;
          border-radius: 999px;
          background: var(--surface-raised-stronger-non-alpha);
          box-shadow: 0 1px 2px color-mix(in srgb, var(--text-strong) 12%, transparent);
          transform: translateX(2px);
          transition: transform 150ms, background-color 150ms;
        }

        [data-component="switch"].settings-general-switch:hover:not([data-disabled], [data-readonly]) [data-slot="switch-control"] {
          border-color: var(--border-weak-hover);
          background: var(--surface-weaker);
        }

        [data-component="switch"].settings-general-switch[data-checked] [data-slot="switch-control"] {
          border-color: #4098ff;
          background: #4098ff;
        }

        [data-component="switch"].settings-general-switch[data-checked] [data-slot="switch-thumb"] {
          transform: translateX(18px);
          background: #ffffff;
        }

        [data-component="switch"].settings-general-switch[data-checked]:hover:not([data-disabled], [data-readonly]) [data-slot="switch-control"] {
          border-color: #2f8cff;
          background: #2f8cff;
        }

        [data-component="switch"].settings-general-switch[data-disabled] [data-slot="switch-control"] {
          border-color: var(--border-weaker-base);
          background: var(--input-disabled);
        }

        [data-component="switch"].settings-general-switch[data-disabled] [data-slot="switch-thumb"] {
          background: var(--surface-raised-stronger-non-alpha);
        }

        [data-slot="select-select-trigger"].settings-general-select {
          width: 180px;
          min-width: 180px;
          height: 36px;
          padding: 0 12px;
          border: 0;
          border-radius: 999px;
          background: var(--surface-weak);
          gap: 12px;
          justify-content: space-between;
          text-align: left;
          box-shadow: none;
        }

        [data-slot="select-select-trigger"].settings-memory-select-compact {
          width: 128px;
          min-width: 128px;
          height: 32px;
          padding: 0 10px;
          border: 1px solid var(--border-weaker-base);
          border-radius: 10px;
          background: var(--surface-raised-stronger-non-alpha);
          gap: 8px;
          justify-content: space-between;
          text-align: left;
          box-shadow: none;
        }

        [data-slot="select-select-trigger"].settings-memory-select-project {
          width: 188px;
          min-width: 188px;
        }

        [data-slot="select-select-trigger"].settings-memory-select-compact [data-slot="select-select-trigger-value"] {
          flex: 1;
          text-align: left;
          color: var(--text-strong);
          font-size: 12px;
          font-weight: 400;
        }

        [data-slot="select-select-trigger"].settings-memory-select-compact [data-slot="select-select-trigger-icon"] {
          width: 14px;
          height: 14px;
          overflow: hidden;
          flex-shrink: 0;
          color: var(--icon-base);
          background: transparent;
          border-radius: 0;
        }

        [data-slot="select-select-trigger"].settings-memory-select-compact [data-slot="select-select-trigger-icon"] [data-slot="icon-svg"] {
          clip-path: inset(45% 0 0 0);
          transform: translateY(-1px);
        }

        [data-slot="select-select-trigger"].settings-memory-select-compact:hover:not(:disabled),
        [data-slot="select-select-trigger"].settings-memory-select-compact[data-expanded],
        [data-slot="select-select-trigger"].settings-memory-select-compact[data-expanded]:hover:not(:disabled) {
          border-color: var(--border-weak-hover);
          background: var(--input-hover);
          box-shadow: none;
        }

        [data-slot="select-select-trigger"].settings-memory-select-compact:focus,
        [data-slot="select-select-trigger"].settings-memory-select-compact:focus-visible {
          border-color: var(--border-weak-hover);
          background: var(--input-focus);
          box-shadow: none;
        }

        [data-slot="select-select-trigger"].settings-general-select [data-slot="select-select-trigger-value"] {
          flex: 1;
          text-align: left;
          color: var(--text-strong);
          font-size: 14px;
          font-weight: 400;
        }

        [data-slot="select-select-trigger"].settings-general-select [data-slot="select-select-trigger-icon"] {
          width: 16px;
          height: 16px;
          overflow: hidden;
          flex-shrink: 0;
          color: var(--icon-base);
          background: transparent;
          border-radius: 0;
        }

        [data-slot="select-select-trigger"].settings-general-select [data-slot="select-select-trigger-icon"] [data-slot="icon-svg"] {
          clip-path: inset(45% 0 0 0);
          transform: translateY(-1px);
        }

        [data-slot="select-select-trigger"].settings-general-select:hover:not(:disabled),
        [data-slot="select-select-trigger"].settings-general-select[data-expanded],
        [data-slot="select-select-trigger"].settings-general-select[data-expanded]:hover:not(:disabled) {
          background: var(--surface-weaker);
          box-shadow: none;
        }

        [data-slot="select-select-trigger"].settings-general-select:focus,
        [data-slot="select-select-trigger"].settings-general-select:focus-visible {
          background: var(--surface-weak);
          box-shadow: none;
        }

        .settings-memory-number {
          width: 160px;
          min-width: 160px;
          height: 36px;
          padding: 0 12px;
          border: 0;
          border-radius: 999px;
          background: var(--surface-weak);
          color: var(--text-strong);
          font-size: 14px;
          font-weight: 400;
          outline: none;
          box-shadow: none;
        }

        .settings-memory-number:hover {
          background: var(--surface-weaker);
        }

        .settings-memory-number:focus,
        .settings-memory-number:focus-visible {
          background: var(--surface-weak);
          box-shadow: none;
        }

        .settings-memory-textarea,
        .settings-memory-search {
          border: 1px solid var(--border-weaker-base);
          border-radius: 10px;
          background: var(--surface-raised-stronger-non-alpha);
          color: var(--text-strong);
          box-shadow: none;
          outline: none;
        }

        .settings-memory-search {
          height: 32px;
          border-radius: 10px;
          font-size: 12px;
        }

        .settings-memory-textarea:hover,
        .settings-memory-search:hover {
          border-color: var(--border-weak-hover);
          background: var(--input-hover);
        }

        .settings-memory-textarea:focus,
        .settings-memory-textarea:focus-visible,
        .settings-memory-search:focus,
        .settings-memory-search:focus-visible {
          border-color: var(--border-weak-hover);
          background: var(--input-focus);
          box-shadow: none;
        }

        .settings-memory-scrollbar {
          scrollbar-width: thin;
          scrollbar-color: var(--border-weak-base) transparent;
        }

        .settings-memory-scrollbar::-webkit-scrollbar {
          width: 10px;
        }

        .settings-memory-scrollbar::-webkit-scrollbar-track {
          background: transparent;
        }

        .settings-memory-scrollbar::-webkit-scrollbar-thumb {
          background: var(--border-weak-base);
          border-radius: 999px;
          border: 2px solid transparent;
          background-clip: padding-box;
        }
      `}</style>
      <div class="settings-memory-scrollbar flex h-full flex-col overflow-y-auto bg-background-base px-4 pb-10 sm:px-10">
        <div
          class="sticky top-0 z-10"
          style={{ background: "linear-gradient(to bottom, var(--background-base) calc(100% - 24px), transparent)" }}
        >
          <div class="flex flex-wrap items-start justify-between gap-3 pt-6 pb-6">
            <div class="flex min-w-0 flex-col gap-1">
              <h2 class="text-16-medium text-text-strong">{copy().title}</h2>
              <Show when={currentProjectPath()}>
                {(projectPath) => (
                  <p class="max-w-[720px] truncate text-11-regular text-text-weak">
                    {copy().currentProject}: <span class="font-mono">{projectPath()}</span>
                  </p>
                )}
              </Show>
            </div>
            <Button
              size="small"
              variant="secondary"
              icon="plus"
              disabled={!canCreate()}
              title={!sessionID() ? copy().sessionRequired : canCreate() ? undefined : copy().memoryNotWritable}
              onClick={openNew}
            >
              {copy().add}
            </Button>
          </div>
        </div>

        <div class="flex w-full flex-col gap-6">
          <div class={listClass}>
            <SettingsList>
              <SettingsRow title={copy().enabledTitle} description={copy().enabledDescription}>
                <Switch class={switchClass} checked={state.config.enabled} onChange={(enabled) => void saveConfig({ enabled })} hideLabel>
                  {copy().enabledTitle}
                </Switch>
              </SettingsRow>
              <SettingsRow title={copy().modeTitle} description={copy().modeDescription}>
                <Select
                  class={selectClass}
                  options={[...modes]}
                  current={selectedMode()}
                  value={(mode) => mode}
                  label={labels.mode}
                  onSelect={(mode) => mode && void saveConfig({ default_mode: mode })}
                  variant="secondary"
                  size="small"
                  triggerVariant="settings"
                />
              </SettingsRow>
              <SettingsRow title={copy().maxEntriesTitle} description={copy().maxEntriesDescription}>
                <NumberField
                  value={state.config.max_prompt_entries}
                  min={1}
                  max={50}
                  label={copy().maxEntriesTitle}
                  onCommit={(max_prompt_entries) => void saveConfig({ max_prompt_entries })}
                />
              </SettingsRow>
              <SettingsRow title={copy().maxCharsTitle} description={copy().maxCharsDescription}>
                <NumberField
                  value={state.config.max_prompt_chars}
                  min={500}
                  max={20000}
                  label={copy().maxCharsTitle}
                  onCommit={(max_prompt_chars) => void saveConfig({ max_prompt_chars })}
                />
              </SettingsRow>
            </SettingsList>
          </div>

          <Show when={state.form}>
            {(form) =>
              <div class={listClass}>
                <SettingsList>
                  <SettingsRow title={copy().content} description={form().id ? copy().editMemory : copy().newMemory}>
                    <div class="flex w-full flex-col gap-3 sm:w-[420px]">
                      <div class="flex flex-wrap gap-2">
                        <LabeledSelect label={copy().scope}>
                          <Select
                            class={selectClass}
                            options={[...scopes]}
                            current={form().scope}
                            value={(scope) => scope}
                            label={(scope) => labels.formScope(scope)}
                            optionDisabled={scopeDisabled}
                            optionTextValue={(scope: MemoryScope) => scopeDisabledLabel(scope) ?? labels.formScope(scope)}
                            onSelect={(scope) => {
                              if (!scope) return
                              const project = form().targetProjectLocked ? formProject(form()) : defaultProjectOption()
                              setState("form", {
                                ...form(),
                                scope,
                                projectDirectory: scope === "project" ? project?.worktree : form().projectDirectory,
                              })
                            }}
                            variant="secondary"
                            size="small"
                            triggerVariant="settings"
                          />
                        </LabeledSelect>
                      </div>
                      <Show when={form().scope === "project"}>
                        <LabeledSelect label={copy().targetProject}>
                          <Select
                            class={selectClass}
                            options={projectOptions()}
                            current={formProject(form())}
                            value={(project) => project.worktree}
                            label={projectLabel}
                            optionTextValue={projectLabel}
                            placeholder={copy().noOpenProjects}
                            disabled={form().targetProjectLocked}
                            onSelect={(project) => {
                              if (!project) return
                              setState("form", {
                                ...form(),
                                projectDirectory: project.worktree,
                              })
                            }}
                            variant="secondary"
                            size="small"
                            triggerVariant="settings"
                            valueClass="max-w-[360px] truncate"
                          />
                        </LabeledSelect>
                      </Show>
                      <TextField
                        multiline
                        label={copy().content}
                        hideLabel
                        value={form().content}
                        onChange={(content) => setState("form", "content", content)}
                        class="settings-memory-textarea min-h-[96px] text-13-regular"
                      />
                      <div class="flex justify-end gap-2">
                        <Button size="small" variant="ghost" onClick={() => setState("form", undefined)}>
                          {copy().cancel}
                        </Button>
                        <Button
                          size="small"
                          variant="secondary"
                          disabled={
                            state.saving ||
                            !form().content.trim() ||
                            scopeDisabled(form().scope) ||
                            (!form().id && !canCreate())
                          }
                          onClick={() => void saveForm()}
                        >
                          {state.saving && !form().id ? copy().processing : copy().save}
                        </Button>
                      </div>
                    </div>
                  </SettingsRow>
                </SettingsList>
              </div>
            }
          </Show>

          <div class={listClass}>
            <SettingsList>
              <div class="flex flex-wrap items-center gap-2 border-b border-border-weaker-base px-4 py-3 sm:flex-nowrap sm:px-[14px]">
                <Select
                  class={compactSelectClass}
                  options={[...scopeFilters]}
                  current={selectedFilter()}
                  value={(scope) => scope}
                  label={(scope) => labels.scope(scope)}
                  onSelect={(scope) => {
                    if (!scope) return
                    setState("filter", scope)
                    if (scope === "global") setState("projectFilter", "all")
                  }}
                  variant="secondary"
                  size="small"
                  triggerVariant="settings"
                />
                <Show when={state.filter !== "global"}>
                  <Select
                    class={`${compactSelectClass} ${projectSelectClass}`}
                    options={projectFilterOptions()}
                    current={selectedProjectFilter()}
                    value={(project) => project.worktree}
                    label={projectFilterLabel}
                    optionTextValue={projectFilterLabel}
                    onSelect={(project) => {
                      if (!project) return
                      setState("projectFilter", project.worktree)
                      if (project.worktree !== "all") setState("filter", "project")
                    }}
                    variant="secondary"
                    size="small"
                    triggerVariant="settings"
                    valueClass="max-w-[360px] truncate"
                  />
                </Show>
                <div class="min-w-[220px] flex-1">
                  <TextField
                    label={copy().search}
                    hideLabel
                    value={state.search}
                    placeholder={copy().search}
                    onChange={(search) => setState("search", search)}
                    class="settings-memory-search text-12-regular"
                  />
                </div>
              </div>

              <Show
                when={!state.loading}
                  fallback={
                    <div class="flex h-16 items-center justify-center px-4 py-3 text-13-regular text-text-weak sm:px-[14px]">
                      {copy().loading}
                    </div>
                  }
              >
                <Show
                  when={scopedMemories().length > 0}
                  fallback={
                    <div class="flex h-16 items-center justify-center px-4 py-3 text-13-regular text-text-weak sm:px-[14px]">
                      {copy().empty}
                    </div>
                  }
                >
                  <For each={scopedMemories()}>
                    {(memory) => (
                      <div class="group flex flex-col gap-2 border-b border-border-weaker-base px-4 py-3 last:border-none sm:flex-row sm:items-start sm:px-[14px]">
                        <div class="flex min-w-0 flex-1 flex-col gap-1">
                          <div class="flex flex-wrap items-center gap-1.5 text-11-regular text-text-weak">
                            <span>{labels.scope(memory.scope)}</span>
                            <Show when={memory.scope === "project"}>
                              <span class="text-text-weaker">/</span>
                              <span class="max-w-[360px] truncate">
                                {projectLabel(
                                  projectOptions().find(
                                    (item) => pathKey(item.worktree) === pathKey(memory.projectDirectory ?? ""),
                                  ),
                                )}
                              </span>
                            </Show>
                          </div>
                          <p class="break-words text-13-medium leading-5 text-text-strong">{memory.title}</p>
                          <p class="whitespace-pre-wrap break-words text-12-regular leading-5 text-text-weak">
                            {memory.summary}
                          </p>
                        </div>
                        <div class="flex shrink-0 justify-end gap-1 opacity-100 sm:opacity-0 sm:transition-opacity sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
                          <Button size="small" variant="ghost" icon="edit" onClick={() => void openEdit(memory)}>
                            {copy().edit}
                          </Button>
                          <Button size="small" variant="ghost" icon="trash" onClick={() => void remove(memory)}>
                            {copy().delete}
                          </Button>
                        </div>
                      </div>
                    )}
                  </For>
                </Show>
              </Show>
            </SettingsList>
          </div>
        </div>
      </div>
    </>
  )
}

const NumberField: Component<{
  value: number
  min: number
  max: number
  label: string
  onCommit: (value: number) => void
}> = (props) => {
  const [value, setValue] = createSignal(String(props.value))

  createEffect(() => setValue(String(props.value)))

  function commit() {
    const number = Number(value())
    if (!Number.isFinite(number)) {
      setValue(String(props.value))
      return
    }
    const next = Math.min(props.max, Math.max(props.min, Math.round(number)))
    setValue(String(next))
    if (next !== props.value) props.onCommit(next)
  }

  function keyDown(event: KeyboardEvent) {
    if (event.key === "Enter") {
      event.preventDefault()
      commit()
      if (event.currentTarget instanceof HTMLElement) event.currentTarget.blur()
    }
    if (event.key === "Escape") {
      event.preventDefault()
      setValue(String(props.value))
      if (event.currentTarget instanceof HTMLElement) event.currentTarget.blur()
    }
  }

  return (
    <div class="w-full sm:w-[160px]">
      <TextField
        label={props.label}
        hideLabel
        type="number"
        min={props.min}
        max={props.max}
        value={value()}
        onChange={setValue}
        onBlur={commit}
        onKeyDown={keyDown}
        class="rounded-[14px] border-0 bg-transparent text-12-regular shadow-none"
      />
    </div>
  )
}

const LabeledSelect: Component<{
  label: string
  children: JSX.Element
}> = (props) => (
  <div class="flex flex-wrap items-center gap-2 text-11-medium text-text-weak">
    <span class="min-w-0">{props.label}</span>
    {props.children}
  </div>
)

interface SettingsRowProps {
  title: string | JSX.Element
  description: string | JSX.Element
  children: JSX.Element
}

const SettingsRow: Component<SettingsRowProps> = (props) => {
  return (
    <div class="flex flex-wrap items-center gap-4 border-b border-border-weaker-base px-4 py-4 last:border-none sm:flex-nowrap sm:px-[14px]">
      <div class="flex min-w-0 flex-1 flex-col gap-0.5">
        <span class="text-14-medium text-text-strong">{props.title}</span>
        <span class="text-12-regular text-text-weak">{props.description}</span>
      </div>
      <div class="flex w-full justify-end sm:w-auto sm:shrink-0">{props.children}</div>
    </div>
  )
}
