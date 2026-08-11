import { Component, createMemo, createSignal, For, Show, onMount, createEffect } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Icon } from "@opencode-ai/ui/icon"
import { Popover } from "@opencode-ai/ui/popover"
import { TextField } from "@opencode-ai/ui/text-field"
import { showToast } from "@opencode-ai/ui/toast"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { useMutation } from "@tanstack/solid-query"
import { createStore, produce } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { useServer } from "@/context/server"
import { usePlatform } from "@/context/platform"
import { SettingsList } from "./settings-list"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { type LocalProject } from "@/context/layout"
import { useLayout } from "@/context/layout"
import TOML from "smol-toml"
import { getFilename } from "@opencode-ai/core/util/path"
import { OPERATION_ICON_OPTIONS, OPERATION_NAME_MAX_LENGTH } from "@/utils/operation-icons"
import { isScratchSessionPath } from "@/utils/scratch"
import { ENVIRONMENT_NAME_MAX_LENGTH } from "@/utils/project-name"

interface EnvVar {
  key: string
  value: string
}

interface Operation {
  name: string
  command: string
  icon?: string
  _deleted?: boolean
  platformSpecific?: boolean
  platforms?: string[]
}

interface EnvironmentFile {
  name: string
  filename: string
}

interface EnvironmentToml {
  environmentName?: string
  name?: string
  setup?: string | { default?: string; macos?: string; linux?: string; windows?: string }
  cleanup?: string | { default?: string; macos?: string; linux?: string; windows?: string }
  operations?: Array<{ name?: string; command?: string; icon?: string; platform_specific?: boolean; platforms?: string[] }>
}

type PlatformScriptKey = "default" | "macos" | "linux" | "windows"

interface PendingRemoveEnvironment {
  project: LocalProject
  env: EnvironmentFile
}

const RemoveConfirmDialog = (props: { title: string; description: string; cancelLabel: string; confirmLabel: string; onCancel: () => void; onConfirm: () => void }) => {
  return (
    <div class="fixed inset-0 z-[70] flex items-center justify-center bg-black/20 px-4">
      <div class="w-full max-w-[440px] overflow-hidden rounded-xl bg-surface-raised-stronger-non-alpha shadow-lg-border-base">
        <div class="flex items-center justify-between px-5 pt-4 pb-3">
          <div class="text-16-medium text-text-strong">{props.title}</div>
          <button type="button" onClick={props.onCancel} class="flex size-8 items-center justify-center rounded-lg text-text-weak transition-colors hover:bg-surface-base-hover hover:text-text-strong">
            <Icon name="close" class="size-4" />
          </button>
        </div>
        <div class="px-6 pt-0 pb-2 text-14-regular text-text-base">
          {props.description}
        </div>
        <div class="flex justify-end items-center gap-2 px-5 pb-5 pt-2">
          <Button type="button" variant="ghost" size="large" onClick={props.onCancel}>
            {props.cancelLabel}
          </Button>
          <button
            type="button"
            onClick={props.onConfirm}
            class="h-9 px-4 rounded-lg text-14-medium transition-colors"
            style={{
              "background-color": "rgba(232,79,79,0.12)",
              color: "#E5484D",
            }}
          >
            {props.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

export interface SettingsEnvironmentProps {
  scratchChatDir?: () => string | undefined
}

export const SettingsEnvironment: Component<SettingsEnvironmentProps> = (props) => {
  const language = useLanguage()
  const server = useServer()
  const layout = useLayout()
  const platform = usePlatform()
  const globalSDK = useGlobalSDK()
  const globalSync = useGlobalSync()

  const [editingProject, setEditingProject] = createSignal<LocalProject | null>(null)
  const [editingEnvFile, setEditingEnvFile] = createSignal<string | null>(null)
  const [editMode, setEditMode] = createSignal<"view" | "edit">("view")
  const [environmentsMap, setEnvironmentsMap] = createStore<Record<string, EnvironmentFile[]>>({})
  const [pendingRemoveProject, setPendingRemoveProject] = createSignal<LocalProject | null>(null)
  const [pendingRemoveEnvironment, setPendingRemoveEnvironment] = createSignal<PendingRemoveEnvironment | null>(null)

  // 过滤掉散对话隐藏 project（scratch-sessions），和侧边栏逻辑一致
  const projects = () => {
    const scratch = props.scratchChatDir?.()
    return layout.projects.list().filter((p) => !isScratchSessionPath(p.worktree, scratch))
  }

  const addProject = async () => {
    if (!platform.openDirectoryPickerDialog) return
    const result = await platform.openDirectoryPickerDialog({
      title: language.t("settings.environment.addProject"),
      multiple: false,
    })
    if (!result || Array.isArray(result)) return
    const directory = result
    server.projects.open(directory)
  }

  const startEditProject = (project: LocalProject) => {
    setEditingProject(project)
    setEditingEnvFile(null)
  }

  const startViewEnvFile = (project: LocalProject, filename: string) => {
    setEditingProject(project)
    setEditingEnvFile(filename)
    setEditMode("view")
  }

  const startEditEnvFile = (project: LocalProject, filename: string) => {
    setEditingProject(project)
    setEditingEnvFile(filename)
    setEditMode("edit")
  }

  const cancelEdit = () => {
    setEditingProject(null)
    setEditingEnvFile(null)
    setEditMode("view")
  }

  const confirmRemoveProject = (project: LocalProject) => {
    layout.projects.cleanup(project.worktree)
    server.projects.close(project.worktree)
    setPendingRemoveProject(null)
  }

  const removeProject = (project: LocalProject) => {
    setPendingRemoveProject(project)
  }

  const removeEnvironment = (project: LocalProject, env: EnvironmentFile) => {
    setPendingRemoveEnvironment({ project, env })
  }

  const confirmRemoveEnvironment = async (pending: PendingRemoveEnvironment) => {
    if (!platform.deleteEnvironment) return
    try {
      await platform.deleteEnvironment(pending.project.worktree, pending.env.filename)
      setPendingRemoveEnvironment(null)
      await loadEnvironments(pending.project)
    } catch (e) {
      showToast({ title: language.t("common.error"), description: String(e) })
    }
  }

  const getProjectName = (worktree: string) => {
    const parts = worktree.split(/[\\/]/)
    return parts[parts.length - 1] ?? worktree
  }

  const loadEnvironments = async (project: LocalProject) => {
    if (!platform.listEnvironments) return
    const files = await platform.listEnvironments(project.worktree)
    const sorted = [...files].sort((a, b) => {
      if (a === "environment.toml") return -1
      if (b === "environment.toml") return 1
      return 0
    })
    const environments = await Promise.all(
      sorted.map(async (filename) => {
        if (!platform.readEnvironment) {
          return { name: project.name || getProjectName(project.worktree), filename }
        }
        const content = await platform.readEnvironment(project.worktree, filename)
        if (!content) return { name: project.name || getProjectName(project.worktree), filename }
        const parsed = TOML.parse(content) as EnvironmentToml
        return { name: parsed.environmentName?.trim() || parsed.name?.trim() || project.name || getProjectName(project.worktree), filename }
      }),
    )
    setEnvironmentsMap(produce((state) => {
      state[project.worktree] = environments
    }))
  }

  const addEnvironment = async (project: LocalProject) => {
    if (!platform.listEnvironments) return

    const files = await platform.listEnvironments(project.worktree)
    const filename = !files.includes("environment.toml")
      ? "environment.toml"
      : `environment-${files
          .flatMap((file) => {
            const match = file.match(/^environment-(\d+)\.toml$/)
            return match ? [Number(match[1])] : []
          })
          .reduce((max, value) => Math.max(max, value), 0) + 1}.toml`

    startEditEnvFile(project, filename)
  }

  // Load environments for all projects when project list changes
  createEffect(() => {
    const allProjects = projects()
    if (allProjects.length === 0) return
    for (const project of allProjects) {
      void loadEnvironments(project)
    }
  })

  return (
    <>
      <style>{`
        .settings-scrollbar {
          scrollbar-width: thin;
          scrollbar-color: var(--border-weak-base) transparent;
        }

        .settings-scrollbar::-webkit-scrollbar {
          width: 10px;
        }

        .settings-scrollbar::-webkit-scrollbar-track {
          background: transparent;
        }

        .settings-scrollbar::-webkit-scrollbar-thumb {
          background: var(--border-weak-base);
          border-radius: 999px;
          border: 2px solid transparent;
          background-clip: padding-box;
        }

        .settings-scrollbar::-webkit-scrollbar-thumb:hover {
          background: var(--border-weak-hover);
          border: 2px solid transparent;
          background-clip: padding-box;
        }
      `}</style>
      <div class="settings-scrollbar flex h-full flex-col overflow-y-auto bg-background-base px-4 pb-10 sm:px-10 sm:pb-10">
        <Show
          when={!editingProject()}
          fallback={
            <EditProjectContent
              project={editingProject()!}
              envFile={editingEnvFile()}
              mode={editMode()}
              onCancel={cancelEdit}
              onSaved={() => {
                if (editingProject()) {
                  loadEnvironments(editingProject()!)
                }
              }}
              onEdit={() => setEditMode("edit")}
            />
          }
        >
          <div
            class="sticky top-0 z-10"
            style={{
              background: "linear-gradient(to bottom, var(--background-base) calc(100% - 24px), transparent)",
            }}
          >
            <div class="flex flex-col gap-1 pt-6 pb-8 max-w-[720px]">
              <h2 class="text-16-medium text-text-strong">{language.t("settings.environment.title")}</h2>
              <p class="text-13-regular text-text-weak">
                {language.t("settings.environment.description")}{" "}
                <a
                  href="https://doc.wanlai.ai/"
                  class="text-text-interactive-base hover:underline"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {language.t("common.learnMore")}
                </a>
              </p>
            </div>
          </div>

          <div class="flex flex-col gap-8 max-w-[720px]">
            <div class="flex flex-col gap-1">
              <div class="flex items-center justify-between pb-2">
                <h3 class="text-14-medium text-text-strong">{language.t("settings.environment.selectProject")}</h3>
                <Button size="large" variant="secondary" onClick={addProject} class="!border-0 !shadow-none !rounded-xl px-3 [&:hover:not(:disabled)]:!bg-surface-weak" style={{ "--button-secondary-base": "var(--background-weak)" } as any}>
                  {language.t("settings.environment.addProject")}
                </Button>
              </div>
              <div class="[&>div]:rounded-[18px] [&>div]:border [&>div]:border-border-weaker-base [&>div]:bg-surface-raised-stronger-non-alpha [&>div]:px-0 [&>div]:shadow-none">
                <SettingsList>
                  <Show
                    when={projects().length > 0}
                    fallback={
                      <div class="px-4 py-4 text-14-regular text-text-weak sm:px-[14px]">
                        {language.t("settings.environment.noProjects")}
                      </div>
                    }
                  >
                    <For each={projects()}>
                      {(project) => (
                        <div class="flex flex-col border-b border-border-weaker-base last:border-none">
                          <div class="group flex min-h-16 flex-wrap items-center justify-between gap-4 px-4 py-4 sm:px-[14px]">
                            <div class="flex items-center gap-3 min-w-0">
                              <Icon name="folder" class="size-5 shrink-0 text-text-base" />
                              <span class="text-14-medium text-text-strong truncate">{project.name || getProjectName(project.worktree)}</span>
                            </div>
                            <div class="flex items-center gap-1">
                              <Tooltip value={language.t("settings.environment.addEnvironment")} placement="top" openDelay={200}>
                                <Button
                                  size="large"
                                  variant="secondary"
                                  icon="plus"
                                  onClick={() => void addEnvironment(project)}
                                  aria-label={language.t("settings.environment.addEnvironment")}
                                  class="!border-0 !shadow-none size-8 [&>svg]:stroke-[2.5] !rounded-xl [&:hover:not(:disabled)]:!bg-surface-base-hover !px-2"
                                  style={{ "--button-secondary-base": "var(--background-weak)" } as any}
                                />
                              </Tooltip>
                              <Tooltip value={language.t("settings.environment.removeProject")} placement="top" openDelay={200}>
                                <Button
                                  size="large"
                                  variant="secondary"
                                  icon="trash"
                                  onClick={() => removeProject(project)}
                                  aria-label={language.t("settings.environment.removeProject")}
                                  class="!border-0 !shadow-none size-8 [&>svg]:stroke-[2.5] !rounded-xl [&:hover:not(:disabled)]:!bg-surface-base-hover !px-2 text-text-weak hover:!text-icon-danger"
                                  style={{ "--button-secondary-base": "var(--background-weak)" } as any}
                                />
                              </Tooltip>
                            </div>
                          </div>
                          {/* 环境文件列表 */}
                          <EnvironmentList
                            project={project}
                            environments={environmentsMap[project.worktree] ?? []}
                            onEdit={(filename) => startViewEnvFile(project, filename)}
                            onRemove={(env) => removeEnvironment(project, env)}
                          />
                        </div>
                      )}
                    </For>
                  </Show>
                </SettingsList>
              </div>
            </div>
          </div>
        </Show>
        <Show when={pendingRemoveProject()}>
          {(project) => (
            <RemoveConfirmDialog
              title={language.t("settings.environment.removeProject.confirm.title")}
              description={language.t("settings.environment.removeProject.confirm.description")}
              cancelLabel={language.t("common.cancel")}
              confirmLabel={language.t("settings.environment.removeProject")}
              onCancel={() => setPendingRemoveProject(null)}
              onConfirm={() => confirmRemoveProject(project())}
            />
          )}
        </Show>
        <Show when={pendingRemoveEnvironment()}>
          {(pending) => (
            <RemoveConfirmDialog
              title={language.t("settings.environment.removeEnvironment.confirm.title")}
              description={language.t("settings.environment.removeEnvironment.confirm.description")}
              cancelLabel={language.t("common.cancel")}
              confirmLabel={language.t("settings.environment.removeEnvironment")}
              onCancel={() => setPendingRemoveEnvironment(null)}
              onConfirm={() => void confirmRemoveEnvironment(pending())}
            />
          )}
        </Show>
      </div>
    </>
  )
}

function EnvironmentList(props: {
  project: LocalProject
  environments: EnvironmentFile[]
  onEdit: (filename: string) => void
  onRemove: (env: EnvironmentFile) => void
}) {
  const language = useLanguage()

  return (
    <Show when={props.environments.length > 0}>
      <div class="flex flex-col">
        <For each={props.environments}>
          {(env, index) => (
            <div classList={{ "border-b border-border-weaker-base": index() < props.environments.length - 1 }}>
              <div class="flex items-center justify-between gap-4 px-4 py-3 sm:px-[14px] hover:bg-surface-base-hover cursor-pointer" onClick={() => props.onEdit(env.filename)}>
                <div class="flex flex-col min-w-0">
                  <span class="text-14-medium text-text-strong">{env.name}</span>
                  <span class="text-12-regular text-text-weak">{env.filename}</span>
                </div>
                <div class="flex items-center gap-1 shrink-0">
                  <Tooltip value={language.t("common.view")} placement="top" openDelay={200}>
                    <Button
                      size="large"
                      variant="secondary"
                      icon="eye"
                      onClick={(event: MouseEvent) => {
                        event.stopPropagation()
                        props.onEdit(env.filename)
                      }}
                      aria-label={language.t("common.view")}
                      class="!border-0 !shadow-none size-8 [&>svg]:stroke-[2.5] !rounded-xl [&:hover:not(:disabled)]:!bg-surface-base-hover !px-2 text-text-weak"
                      style={{ "--button-secondary-base": "var(--background-weak)" } as any}
                    />
                  </Tooltip>
                  <Tooltip value={language.t("settings.environment.removeEnvironment")} placement="top" openDelay={200}>
                    <Button
                      size="large"
                      variant="secondary"
                      icon="trash"
                      onClick={(event: MouseEvent) => {
                        event.stopPropagation()
                        props.onRemove(env)
                      }}
                      aria-label={language.t("settings.environment.removeEnvironment")}
                      class="!border-0 !shadow-none size-8 [&>svg]:stroke-[2.5] !rounded-xl [&:hover:not(:disabled)]:!bg-surface-base-hover !px-2 text-text-weak hover:!text-icon-danger"
                      style={{ "--button-secondary-base": "var(--background-weak)" } as any}
                    />
                  </Tooltip>
                </div>
              </div>
            </div>
          )}
        </For>
      </div>
    </Show>
  )
}

function EditProjectContent(props: {
  project: LocalProject
  envFile: string | null
  mode: "view" | "edit"
  onCancel: () => void
  onSaved: () => void
  onEdit: () => void
}) {
  const language = useLanguage()
  const globalSDK = useGlobalSDK()
  const globalSync = useGlobalSync()
  const platform = usePlatform()

  const folderName = createMemo(() => getFilename(props.project.worktree))
  const defaultName = createMemo(() => props.project.name || folderName())
  const defaultSetup = createMemo(() => props.project.commands?.setup ?? "")
  const defaultCleanup = createMemo(() => props.project.commands?.cleanup ?? "")
  const defaultEnv = createMemo<EnvVar[]>(() => {
    const env = props.project.env
    if (!env) return []
    return Object.entries(env).map(([key, value]) => ({ key, value: String(value) }))
  })

  const [store, setStore] = createStore({
    name: defaultName(),
    setupScripts: {
      default: defaultSetup(),
      macos: "",
      linux: "",
      windows: "",
    },
    cleanupScripts: {
      default: defaultCleanup(),
      macos: "",
      linux: "",
      windows: "",
    },
    envVars: defaultEnv(),
    operations: [] as Operation[],
  })

  const [setupTab, setSetupTab] = createSignal<PlatformScriptKey>("default")
  const [cleanupTab, setCleanupTab] = createSignal<PlatformScriptKey>("default")
  const [showSetupEnvVars, setShowSetupEnvVars] = createSignal(false)
  const [copiedScript, setCopiedScript] = createSignal<"setup" | "cleanup" | null>(null)

  const setupScript = createMemo(() => store.setupScripts[setupTab()])
  const cleanupScript = createMemo(() => store.cleanupScripts[cleanupTab()])

  // 加载环境文件内容
  createEffect(async () => {
    const envFile = props.envFile
    if (!envFile || !platform.readEnvironment) return
    const worktree = props.project.worktree
    try {
      const content = await platform.readEnvironment(worktree, envFile)
      if (!content) return

      const parsed = TOML.parse(content) as EnvironmentToml

      setStore("name", parsed.environmentName?.trim() || parsed.name?.trim() || props.project.name || folderName())

      const parsePlatformScript = (value: string | { default?: string; macos?: string; linux?: string; windows?: string } | undefined, field: "setupScripts" | "cleanupScripts") => {
        if (!value) return
        if (typeof value === "string") {
          setStore(field, "default", value.trim())
        } else {
          for (const key of ["default", "macos", "linux", "windows"] as const) {
            if (value[key]) setStore(field, key, value[key]!.trim())
          }
        }
      }

      parsePlatformScript(parsed.setup, "setupScripts")
      parsePlatformScript(parsed.cleanup, "cleanupScripts")

      if (parsed.operations && parsed.operations.length > 0) {
        const ops: Operation[] = parsed.operations
          .filter((op) => op.name || op.command)
          .map((op) => ({
            name: op.name ?? "",
            command: op.command ?? "",
            icon: op.icon,
            platformSpecific: op.platform_specific ?? false,
            platforms: op.platforms ?? [],
          }))
        if (ops.length > 0) setStore("operations", ops)
      }
    } catch (e) {
      console.error("TOML parse error:", e)
      const message = e instanceof Error ? e.message : String(e)
      showToast({ title: language.t("common.requestFailed"), description: message })
    }
  })

  const addEnvVar = () => {
    setStore("envVars", [...store.envVars, { key: "", value: "" }])
  }

  const writeClipboardText = async (value: string) => {
    if (navigator.clipboard?.writeText) {
      return navigator.clipboard.writeText(value).then(
        () => true,
        () => false,
      )
    }
    const textarea = document.createElement("textarea")
    textarea.value = value
    textarea.setAttribute("readonly", "")
    textarea.style.position = "fixed"
    textarea.style.opacity = "0"
    document.body.appendChild(textarea)
    textarea.select()
    const copied = document.execCommand("copy")
    textarea.remove()
    return copied
  }

  const copyScript = async (kind: "setup" | "cleanup", value: string) => {
    if (!value.trim()) return
    const copied = await writeClipboardText(value)
    if (!copied) {
      showToast({ title: language.t("settings.environment.copyFailed") })
      return
    }
    setCopiedScript(kind)
    setTimeout(() => {
      setCopiedScript((current) => current === kind ? null : current)
    }, 1200)
  }

  const removeEnvVar = (index: number) => {
    setStore("envVars", store.envVars.filter((_, i) => i !== index))
  }

  const updateEnvVar = (index: number, field: keyof EnvVar, value: string) => {
    setStore("envVars", produce((draft) => {
      draft[index][field] = value
    }))
  }

  const addOperation = () => {
    setStore("operations", [...store.operations, { name: "", command: "" }])
  }

  const removeOperation = (index: number) => {
    setStore("operations", index, { _deleted: true })
  }

  const restoreOperation = (index: number) => {
    setStore("operations", index, { _deleted: false })
  }

  const updateOperation = (index: number, field: "name" | "command" | "icon", value: string) => {
    setStore("operations", produce((draft) => {
      draft[index][field] = value
    }))
  }

  const saveMutation = useMutation(() => ({
    mutationFn: async () => {
      const environmentName = store.name.trim() || undefined
      const setupDefault = store.setupScripts.default.trim() || undefined
      const setupMacos = store.setupScripts.macos.trim() || undefined
      const setupLinux = store.setupScripts.linux.trim() || undefined
      const setupWindows = store.setupScripts.windows.trim() || undefined
      const setup = (!setupMacos && !setupLinux && !setupWindows) ? setupDefault : {
        default: setupDefault,
        ...(setupMacos && { macos: setupMacos }),
        ...(setupLinux && { linux: setupLinux }),
        ...(setupWindows && { windows: setupWindows }),
      }

      const cleanupDefault = store.cleanupScripts.default.trim() || undefined
      const cleanupMacos = store.cleanupScripts.macos.trim() || undefined
      const cleanupLinux = store.cleanupScripts.linux.trim() || undefined
      const cleanupWindows = store.cleanupScripts.windows.trim() || undefined
      const cleanup = (!cleanupMacos && !cleanupLinux && !cleanupWindows) ? cleanupDefault : {
        default: cleanupDefault,
        ...(cleanupMacos && { macos: cleanupMacos }),
        ...(cleanupLinux && { linux: cleanupLinux }),
        ...(cleanupWindows && { windows: cleanupWindows }),
      }

      const ops = store.operations.filter((op) => !op._deleted && (op.name.trim() || op.command.trim()))
      const opsMeta = ops.length > 0 ? ops : undefined

      const env: Record<string, string> = {}
      for (const { key, value } of store.envVars) {
        if (key.trim()) env[key.trim()] = value
      }

      // 保存到环境文件
      if (props.envFile && platform.writeEnvironment) {
        if (platform.ensureEnvironmentsDir) {
          await platform.ensureEnvironmentsDir()
        }
        const tomlContent = generateTomlContent(environmentName, setup, cleanup, ops)
        await platform.writeEnvironment(props.project.worktree, props.envFile, tomlContent)
      }

      setStore("operations", ops)
    },
    onSuccess: () => {
      showToast({ title: language.t("settings.environment.saved") })
      props.onSaved()
      props.onCancel()
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

  const platformTabs = [
    { key: "default" as const, label: language.t("project.edit.tab.default") },
    { key: "macos" as const, label: language.t("project.edit.tab.macos") },
    { key: "linux" as const, label: language.t("project.edit.tab.linux") },
    { key: "windows" as const, label: language.t("project.edit.tab.windows") },
  ]

  const operationPlatformTabs = platformTabs.filter((t) => t.key !== "default")
  const currentPlatformScriptKey = () => {
    const os = platform.os
    if (os === "macos" || os === "linux" || os === "windows") return os
    return "default"
  }
  const displayScript = (scripts: Record<PlatformScriptKey, string>) => {
    const platformKey = currentPlatformScriptKey()
    const key = scripts[platformKey].trim() ? platformKey : "default"
    return {
      key,
      label: platformTabs.find((tab) => tab.key === key)?.label ?? language.t("project.edit.tab.default"),
      value: scripts[key],
    }
  }
  const setupDisplayScript = createMemo(() => displayScript(store.setupScripts))
  const cleanupDisplayScript = createMemo(() => displayScript(store.cleanupScripts))

  return (
    <div class="flex flex-col h-full overflow-y-auto settings-scrollbar">
      <Show
        when={props.mode === "view"}
        fallback={
          <>
            {/* 顶部标题栏 - 编辑模式 */}
            <div class="sticky top-0 z-20 flex items-center gap-2 pt-6 pb-4 border-b border-border-weaker-base bg-background-base">
              <Button
                type="button"
                variant="ghost"
                size="small"
                onClick={props.onCancel}
                class="!text-text-weak hover:!text-text-strong"
                style={{ "-webkit-app-region": "no-drag" } as Record<string, string>}
              >
                <Icon name="arrow-left" class="size-4" />
              </Button>
              <h2 class="text-16-medium text-text-strong">{language.t("dialog.project.edit.title")}</h2>
            </div>

            <div class="flex flex-col gap-6 flex-1 px-4 pt-2 pb-10 sm:px-10 sm:pb-10">

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

            {/* 名称 */}
            <TextField
              type="text"
              label={language.t("project.edit.environmentName")}
              placeholder={folderName()}
              maxLength={ENVIRONMENT_NAME_MAX_LENGTH}
              value={store.name}
              onChange={(v) => setStore("name", v.slice(0, ENVIRONMENT_NAME_MAX_LENGTH))}
            />

            {/* 设置脚本 */}
            <div class="flex flex-col gap-2">
              <div>
                <label class="text-14-medium text-text-strong">{language.t("project.edit.setupScript")}</label>
                <p class="text-12-regular text-text-weak mt-0.5">
                  {language.t("project.edit.setupScriptDescription")}
                </p>
              </div>
              <div class="flex items-center gap-1">
                <For each={platformTabs}>
                  {(tab) => (
                    <button
                      type="button"
                      onClick={() => setSetupTab(tab.key)}
                      class={`rounded-full px-3 py-1 text-12-regular transition-colors ${
                        setupTab() === tab.key
                          ? "bg-surface-base-active text-text-strong"
                          : "text-text-weak hover:text-text-strong hover:bg-surface-base-hover"
                      }`}
                    >
                      {tab.label}
                    </button>
                  )}
                </For>
                <div class="flex-1" />
                <Popover
                  open={showSetupEnvVars()}
                  onOpenChange={setShowSetupEnvVars}
                  triggerAs={Button}
                  triggerProps={{
                    type: "button",
                    variant: "secondary",
                    size: "small",
                    class: "!border-0 !shadow-none !rounded-xl px-3 [&:hover:not(:disabled)]:!bg-surface-weak",
                    style: { "--button-secondary-base": "var(--background-weak)" } as any,
                  }}
                  trigger={language.t("project.edit.variables")}
                  // 本组件同时被独立设置页（根容器 z-70）和设置弹窗（Dialog z-300）复用，
                  // 取 310 才能在两种宿主下都盖住，Popover content 默认 z-50 会被 Dialog 覆盖
                  class="[&_[data-slot=popover-body]]:p-0 w-auto bg-transparent border-0 shadow-none !z-[310]"
                  gutter={4}
                  placement="bottom-end"
                >
                  <Show when={showSetupEnvVars()}>
                    <div class="rounded-xl bg-surface-raised-stronger-non-alpha shadow-[var(--shadow-lg-border-base)] p-4 min-w-[300px]">
                      <div class="text-14-medium text-text-strong mb-3">{language.t("project.edit.envVarsTitle")}</div>
                      <div class="flex flex-col gap-3">
                        <div class="flex flex-col gap-1.5">
                          <span class="text-12-regular text-text-weak">{language.t("project.edit.sourceTreePath")}</span>
                          <div class="rounded-lg bg-surface-base px-3 py-2 text-13-regular text-text-strong font-mono">
                            WANLAICODE_SOURCE_TREE_PATH
                          </div>
                        </div>
                        <div class="flex flex-col gap-1.5">
                          <span class="text-12-regular text-text-weak">{language.t("project.edit.worktreePath")}</span>
                          <div class="rounded-lg bg-surface-base px-3 py-2 text-13-regular text-text-strong font-mono">
                            WANLAICODE_WORKTREE_PATH
                          </div>
                        </div>
                      </div>
                    </div>
                  </Show>
                </Popover>
              </div>
              <div class="relative">
                <Show when={setupScript().trim()}>
                  <IconButton
                    icon="copy"
                    variant="ghost"
                    size="small"
                    class="absolute right-3 top-3 z-10"
                    aria-label={language.t("settings.environment.copySetupScript")}
                    onClick={() => void copyScript("setup", setupScript())}
                  />
                </Show>
                <Show when={copiedScript() === "setup"}>
                  <div class="absolute right-0 -top-11 z-20 inline-flex h-9 items-center whitespace-nowrap rounded-xl border border-border-weaker-base bg-surface-raised-stronger-non-alpha px-3 text-13-regular text-text-strong shadow-[0_6px_20px_rgba(0,0,0,0.12)] after:absolute after:left-1/2 after:top-full after:size-2 after:-translate-x-1/2 after:-translate-y-1/2 after:rotate-45 after:border-b after:border-r after:border-border-weaker-base after:bg-surface-raised-stronger-non-alpha">
                    <span>{language.t("settings.environment.copied")}</span>
                  </div>
                </Show>
                <textarea
                  class="w-full rounded-xl border border-border-weaker-base bg-surface-raised-stronger-non-alpha px-4 py-3 pr-14 text-13-regular text-text-strong placeholder:text-text-weak focus:border-border-weak-base focus:outline-none resize-none font-mono"
                  rows={4}
                  placeholder={language.t("project.edit.setupScriptPlaceholder")}
                  value={setupScript()}
                  onInput={(e) => setStore("setupScripts", setupTab(), e.currentTarget.value)}
                />
              </div>
            </div>

            {/* 清理脚本 */}
            <div class="flex flex-col gap-2">
              <div>
                <label class="text-14-medium text-text-strong">{language.t("project.edit.cleanupScript")}</label>
                <p class="text-12-regular text-text-weak mt-0.5">
                  {language.t("project.edit.cleanupScriptDescription")}
                </p>
              </div>
              <div class="flex items-center gap-1">
                <For each={platformTabs}>
                  {(tab) => (
                    <button
                      type="button"
                      onClick={() => setCleanupTab(tab.key)}
                      class={`rounded-full px-3 py-1 text-12-regular transition-colors ${
                        cleanupTab() === tab.key
                          ? "bg-surface-base-active text-text-strong"
                          : "text-text-weak hover:text-text-strong hover:bg-surface-base-hover"
                      }`}
                    >
                      {tab.label}
                    </button>
                  )}
                </For>
                <div class="flex-1" />
              </div>
              <div class="relative">
                <Show when={cleanupScript().trim()}>
                  <IconButton
                    icon="copy"
                    variant="ghost"
                    size="small"
                    class="absolute right-3 top-3 z-10"
                    aria-label={language.t("settings.environment.copyCleanupScript")}
                    onClick={() => void copyScript("cleanup", cleanupScript())}
                  />
                </Show>
                <Show when={copiedScript() === "cleanup"}>
                  <div class="absolute right-0 -top-11 z-20 inline-flex h-9 items-center whitespace-nowrap rounded-xl border border-border-weaker-base bg-surface-raised-stronger-non-alpha px-3 text-13-regular text-text-strong shadow-[0_6px_20px_rgba(0,0,0,0.12)] after:absolute after:left-1/2 after:top-full after:size-2 after:-translate-x-1/2 after:-translate-y-1/2 after:rotate-45 after:border-b after:border-r after:border-border-weaker-base after:bg-surface-raised-stronger-non-alpha">
                    <span>{language.t("settings.environment.copied")}</span>
                  </div>
                </Show>
                <textarea
                  class="w-full rounded-xl border border-border-weaker-base bg-surface-raised-stronger-non-alpha px-4 py-3 pr-14 text-13-regular text-text-strong placeholder:text-text-weak focus:border-border-weak-base focus:outline-none resize-none font-mono"
                  rows={3}
                  placeholder={language.t("project.edit.cleanupScriptPlaceholder")}
                  value={cleanupScript()}
                  onInput={(e) => setStore("cleanupScripts", cleanupTab(), e.currentTarget.value)}
                />
              </div>
            </div>

            {/* 操作 */}
            <div class="flex flex-col gap-3">
              <div class="flex items-center justify-between">
                <div>
                  <label class="text-14-medium text-text-strong">{language.t("project.edit.operations")}</label>
                  <p class="text-12-regular text-text-weak mt-0.5">
                    {language.t("project.edit.operationsDescription")}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="secondary"
                  size="small"
                  onClick={addOperation}
                  class="!border-0 !shadow-none !rounded-xl px-3 [&:hover:not(:disabled)]:!bg-surface-weak shrink-0"
                  style={{ "--button-secondary-base": "var(--background-weak)" } as any}
                >
                  {language.t("project.edit.addOperation")}
                </Button>
              </div>
              <Show
                when={store.operations.length > 0}
                fallback={
                  <div class="rounded-xl border border-border-weaker-base bg-surface-raised-stronger-non-alpha px-4 py-3 text-13-regular text-text-weak">
                    {language.t("project.edit.noOperations")}
                  </div>
                }
              >
                <div class="flex flex-col gap-3">
                  <For each={store.operations}>
                    {(op, index) => {
                      const [iconPickerOpen, setIconPickerOpen] = createSignal(false)
                      const iconOptions = OPERATION_ICON_OPTIONS.map((option) => ({ ...option, label: language.t(option.label) }))
                      const selectedIcon = () => iconOptions.find((o) => o.icon === op.icon) ?? iconOptions[0]
                      const isDeleted = () => op._deleted === true
                      return (
                        <Show
                          when={isDeleted()}
                          fallback={
                            <div class="flex flex-col gap-2 p-3 rounded-xl border border-border-weaker-base bg-surface-raised-stronger-non-alpha">
                              <div class="text-13-medium text-text-strong">{language.t("project.edit.operationName")}</div>
                              <div class="flex items-center gap-2">
                                <Popover
                                  open={iconPickerOpen()}
                                  onOpenChange={setIconPickerOpen}
                                  triggerAs={Button}
                                  triggerProps={{
                                    type: "button",
                                    variant: "secondary",
                                    size: "small",
                                    class: "!border-0 !shadow-none !rounded-lg px-2 [&:hover:not(:disabled)]:!bg-surface-weak shrink-0",
                                    style: { "--button-secondary-base": "var(--background-weak)" } as any,
                                  }}
                                  trigger={<Icon name={selectedIcon().icon} size="small" class="text-icon-strong-base" />}
                                  // 本组件同时被独立设置页（根容器 z-70）和设置弹窗（Dialog z-300）复用，
                                  // 取 310 才能在两种宿主下都盖住，Popover content 默认 z-50 会被 Dialog 覆盖
                                  class="[&_[data-slot=popover-body]]:p-0 w-auto bg-transparent border-0 shadow-none !z-[310]"
                                  gutter={4}
                                  placement="bottom-start"
                                >
                                  <Show when={iconPickerOpen()}>
                                    <div class="rounded-xl bg-surface-raised-stronger-non-alpha shadow-[var(--shadow-lg-border-base)] p-1 min-w-[160px]">
                                      <For each={iconOptions}>
                                        {(option) => (
                                          <button
                                            type="button"
                                            onClick={() => {
                                              updateOperation(index(), "icon", option.icon)
                                              setIconPickerOpen(false)
                                            }}
                                            class="flex items-center gap-2 w-full px-3 py-2 rounded-lg text-13-regular text-text-strong hover:bg-surface-base-hover transition-colors"
                                          >
                                            <Icon name={option.icon} size="small" class="text-icon-strong-base" />
                                            <span>{option.label}</span>
                                            <Show when={op.icon === option.icon}>
                                              <Icon name="check" size="small" class="ml-auto text-icon-weak" />
                                            </Show>
                                          </button>
                                        )}
                                      </For>
                                    </div>
                                  </Show>
                                </Popover>
                                <TextField
                                  type="text"
                                  placeholder={language.t("project.edit.operationName")}
                                  maxLength={OPERATION_NAME_MAX_LENGTH}
                                  value={op.name}
                                  onChange={(v) => updateOperation(index(), "name", v.slice(0, OPERATION_NAME_MAX_LENGTH))}
                                  class="flex-1"
                                />
                              </div>
                              <div class="text-13-medium text-text-strong">{language.t("project.edit.operationCommand")}</div>
                              <textarea
                                class="w-full rounded-xl border border-border-weaker-base bg-surface-raised-stronger-non-alpha px-4 py-3 text-13-regular text-text-strong placeholder:text-text-weak focus:border-border-weak-base focus:outline-none resize-none font-mono"
                                style={{ height: "90px" }}
                                placeholder={language.t("project.edit.operationCommand")}
                                value={op.command}
                                onInput={(e) => updateOperation(index(), "command", e.currentTarget.value)}
                              />
                              <div class="pt-1">
                                <div class="flex items-center justify-between">
                                  <div class="text-13-medium text-text-strong">{language.t("project.edit.platform")}</div>
                                  <div class="flex items-center gap-1 flex-1 justify-center">
                                    <Show when={op.platformSpecific}>
                                      <div class="flex items-center gap-1">
                                        <For each={operationPlatformTabs}>
                                          {(tab) => {
                                            const isActive = () => (op.platforms ?? [])[0] === tab.key
                                            return (
                                              <button
                                                type="button"
                                                onClick={() => {
                                                  setStore("operations", index(), { platforms: [tab.key] })
                                                }}
                                                class={`rounded-full px-3 py-1 text-12-regular transition-colors ${
                                                  isActive()
                                                    ? "bg-surface-base-active text-text-strong"
                                                    : "text-text-weak hover:text-text-strong hover:bg-surface-base-hover"
                                                }`}
                                              >
                                                {tab.label}
                                              </button>
                                            )
                                          }}
                                        </For>
                                      </div>
                                    </Show>
                                  </div>
                                  <Tooltip value={language.t("project.edit.removeOperation")} placement="top" openDelay={200}>
                                    <Button
                                      size="large"
                                      variant="secondary"
                                      icon="trash"
                                      onClick={() => removeOperation(index())}
                                      aria-label={language.t("project.edit.removeOperation")}
                                      class="!border-0 !shadow-none size-8 [&>svg]:stroke-[2.5] !rounded-xl [&:hover:not(:disabled)]:!bg-surface-base-hover !px-2 text-text-weak hover:!text-icon-danger"
                                      style={{ "--button-secondary-base": "var(--background-weak)" } as any}
                                    />
                                  </Tooltip>
                                </div>
                                <div class="text-12-regular text-text-weak mt-0.5">{language.t("project.edit.platformDescription")}</div>
                                <label class="flex items-center gap-2 cursor-pointer mt-1">
                                  <input
                                    type="checkbox"
                                    checked={op.platformSpecific ?? false}
                                    onChange={(e) => {
                                      const checked = e.currentTarget.checked
                                      setStore("operations", index(), { platformSpecific: checked })
                                      if (!checked) {
                                        setStore("operations", index(), { platforms: [] })
                                      } else {
                                        const currentPlatform = platform.os
                                        const defaultPlatform = currentPlatform === "macos" ? "macos" : currentPlatform === "linux" ? "linux" : "windows"
                                        setStore("operations", index(), { platforms: [defaultPlatform] })
                                      }
                                    }}
                                    class="rounded border-border-weak-base bg-surface-base"
                                  />
                                  <span class="text-13-regular text-text-strong">{language.t("project.edit.platformSpecific")}</span>
                                </label>
                              </div>
                            </div>
                          }
                        >
                          <div class="flex items-center gap-3 p-3 rounded-xl border border-border-weaker-base bg-surface-raised-stronger-non-alpha opacity-50">
                            <div class="flex-1 text-13-regular text-text-weak line-through truncate">
                              {op.name || op.command || language.t("project.edit.operationName")}
                            </div>
                            <Button
                              type="button"
                              variant="secondary"
                              size="small"
                              onClick={() => restoreOperation(index())}
                              class="!border-0 !shadow-none shrink-0"
                              style={{ "--button-secondary-base": "var(--background-weak)" } as any}
                            >
                              <Icon name="reset" size="small" class="text-icon-strong-base" />
                            </Button>
                          </div>
                        </Show>
                      )
                    }}
                  </For>
                </div>
              </Show>
            </div>

            {/* 底部按钮 */}
            <div class="flex justify-end gap-2 pt-4 border-t border-border-weaker-base">
              {/* <Button type="button" variant="ghost" size="large" onClick={props.onCancel}>
                {language.t("common.cancel")}
              </Button> */}
              <Button
                type="button"
                variant="primary"
                size="large"
                disabled={saveMutation.isPending}
                onClick={handleSave}
                class="!rounded-full px-3 [&:hover:not(:disabled)]:opacity-75"
              >
                {saveMutation.isPending ? language.t("common.saving") : language.t("common.save")}
              </Button>
            </div>
            </div>
          </>
        }
      >
        {/* 观看模式 */}
        <div class="flex flex-col h-full overflow-y-auto settings-scrollbar">
          {/* 顶部标题栏 */}
          <div class="sticky top-0 z-20 flex items-center gap-2 pt-6 pb-4 border-b border-border-weaker-base bg-background-base">
            <Button
              type="button"
              variant="ghost"
              size="small"
              onClick={props.onCancel}
              class="!text-text-weak hover:!text-text-strong"
              style={{ "-webkit-app-region": "no-drag" } as Record<string, string>}
            >
              <Icon name="arrow-left" class="size-4" />
            </Button>
            <h2 class="text-16-medium text-text-strong">{language.t("project.edit.environmentDetails")}</h2>
          </div>

          <div class="flex flex-col gap-6 flex-1 px-4 pt-2 pb-10 sm:px-10 sm:pb-10">

          {/* 项目 */}
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

          {/* 名称 */}
          <div class="flex flex-col gap-2">
            <label class="text-14-medium text-text-strong">{language.t("project.edit.environmentName")}</label>
            <div class="rounded-xl border border-border-weaker-base bg-surface-raised-stronger-non-alpha px-4 py-3 text-14-regular text-text-strong">
              {store.name || folderName()}
            </div>
          </div>

          {/* 设置脚本 */}
          <div class="flex flex-col gap-2">
            <div class="flex items-start justify-between gap-3">
              <div>
                <label class="text-14-medium text-text-strong">{language.t("project.edit.setupScript")}</label>
                <p class="text-12-regular text-text-weak mt-0.5">
                  {language.t("project.edit.setupScriptDescription")}
                </p>
              </div>
              <Popover
                open={showSetupEnvVars()}
                onOpenChange={setShowSetupEnvVars}
                triggerAs={Button}
                triggerProps={{
                  type: "button",
                  variant: "secondary",
                  size: "small",
                  class: "!border-0 !shadow-none !rounded-xl px-3 [&:hover:not(:disabled)]:!bg-surface-weak shrink-0",
                  style: { "--button-secondary-base": "var(--background-weak)" } as any,
                }}
                trigger={language.t("project.edit.variables")}
                // 本组件同时被独立设置页（根容器 z-70）和设置弹窗（Dialog z-300）复用，
                // 取 310 才能在两种宿主下都盖住，Popover content 默认 z-50 会被 Dialog 覆盖
                class="[&_[data-slot=popover-body]]:p-0 w-auto bg-transparent border-0 shadow-none !z-[310]"
                gutter={4}
                placement="bottom-end"
              >
                <Show when={showSetupEnvVars()}>
                  <div class="rounded-xl bg-surface-raised-stronger-non-alpha shadow-[var(--shadow-lg-border-base)] p-4 min-w-[300px]">
                    <div class="text-14-medium text-text-strong mb-3">{language.t("project.edit.envVarsTitle")}</div>
                    <div class="flex flex-col gap-3">
                      <div class="flex flex-col gap-1.5">
                        <span class="text-12-regular text-text-weak">{language.t("project.edit.sourceTreePath")}</span>
                        <div class="rounded-lg bg-surface-base px-3 py-2 text-13-regular text-text-strong font-mono">
                          WANLAICODE_SOURCE_TREE_PATH
                        </div>
                      </div>
                      <div class="flex flex-col gap-1.5">
                        <span class="text-12-regular text-text-weak">{language.t("project.edit.worktreePath")}</span>
                        <div class="rounded-lg bg-surface-base px-3 py-2 text-13-regular text-text-strong font-mono">
                          WANLAICODE_WORKTREE_PATH
                        </div>
                      </div>
                    </div>
                  </div>
                </Show>
              </Popover>
            </div>
            <div class="relative rounded-xl border border-border-weaker-base bg-surface-raised-stronger-non-alpha px-4 py-3 pr-14">
              <Show when={setupDisplayScript().value.trim()}>
                <IconButton
                  icon="copy"
                  variant="ghost"
                  size="small"
                  class="absolute right-3 top-3 z-10"
                  aria-label={language.t("settings.environment.copySetupScript")}
                  onClick={() => void copyScript("setup", setupDisplayScript().value)}
                />
              </Show>
              <Show when={copiedScript() === "setup"}>
                <div class="absolute right-0 -top-11 z-20 inline-flex h-9 items-center whitespace-nowrap rounded-xl border border-border-weaker-base bg-surface-raised-stronger-non-alpha px-3 text-13-regular text-text-strong shadow-[0_6px_20px_rgba(0,0,0,0.12)] after:absolute after:left-1/2 after:top-full after:size-2 after:-translate-x-1/2 after:-translate-y-1/2 after:rotate-45 after:border-b after:border-r after:border-border-weaker-base after:bg-surface-raised-stronger-non-alpha">
                  <span>{language.t("settings.environment.copied")}</span>
                </div>
              </Show>
              <div class="text-12-regular text-text-weak mb-1">{setupDisplayScript().label}</div>
              <pre class="text-13-regular text-text-strong font-mono whitespace-pre-wrap break-all">{setupDisplayScript().value || "—"}</pre>
            </div>
          </div>

          {/* 清理脚本 */}
          <div class="flex flex-col gap-2">
            <div>
              <label class="text-14-medium text-text-strong">{language.t("project.edit.cleanupScript")}</label>
              <p class="text-12-regular text-text-weak mt-0.5">
                {language.t("project.edit.cleanupScriptDescription")}
              </p>
            </div>
            <div class="relative rounded-xl border border-border-weaker-base bg-surface-raised-stronger-non-alpha px-4 py-3 pr-14">
              <Show when={cleanupDisplayScript().value.trim()}>
                <IconButton
                  icon="copy"
                  variant="ghost"
                  size="small"
                  class="absolute right-3 top-3 z-10"
                  aria-label={language.t("settings.environment.copyCleanupScript")}
                  onClick={() => void copyScript("cleanup", cleanupDisplayScript().value)}
                />
              </Show>
              <Show when={copiedScript() === "cleanup"}>
                <div class="absolute right-0 -top-11 z-20 inline-flex h-9 items-center whitespace-nowrap rounded-xl border border-border-weaker-base bg-surface-raised-stronger-non-alpha px-3 text-13-regular text-text-strong shadow-[0_6px_20px_rgba(0,0,0,0.12)] after:absolute after:left-1/2 after:top-full after:size-2 after:-translate-x-1/2 after:-translate-y-1/2 after:rotate-45 after:border-b after:border-r after:border-border-weaker-base after:bg-surface-raised-stronger-non-alpha">
                  <span>{language.t("settings.environment.copied")}</span>
                </div>
              </Show>
              <div class="text-12-regular text-text-weak mb-1">{cleanupDisplayScript().label}</div>
              <pre class="text-13-regular text-text-strong font-mono whitespace-pre-wrap break-all">{cleanupDisplayScript().value || "—"}</pre>
            </div>
          </div>

          {/* 操作 */}
          <div class="flex flex-col gap-2">
            <div>
              <label class="text-14-medium text-text-strong">{language.t("project.edit.operations")}</label>
              <p class="text-12-regular text-text-weak mt-0.5">
                {language.t("project.edit.operationsDescription")}
              </p>
            </div>
            <Show
              when={store.operations.filter((op) => !op._deleted).length > 0}
              fallback={
                <div class="rounded-xl border border-border-weaker-base bg-surface-raised-stronger-non-alpha px-4 py-3 text-13-regular text-text-weak">
                  {language.t("project.edit.noOperations")}
                </div>
              }
            >
              <div class="flex flex-col gap-2">
                <For each={store.operations.filter((op) => !op._deleted)}>
                  {(op) => {
                    const iconOptions = OPERATION_ICON_OPTIONS.map((option) => ({ ...option, label: language.t(option.label) }))
                    const selectedIcon = () => iconOptions.find((o) => o.icon === op.icon) ?? iconOptions[0]
                    return (
                      <div class="flex items-center gap-2 rounded-xl border border-border-weaker-base bg-surface-raised-stronger-non-alpha px-4 py-3">
                        <Icon name={selectedIcon().icon} size="small" class="text-icon-strong-base shrink-0" />
                        <span class="text-13-regular text-text-strong truncate">{op.name || op.command || "—"}</span>
                      </div>
                    )
                  }}
                </For>
              </div>
            </Show>
          </div>
          </div>

          {/* 底部按钮 */}
          <div class="flex justify-end gap-2 pt-4 border-t border-border-weaker-base">
            {/* <Button type="button" variant="ghost" size="large" onClick={props.onCancel}>
              {language.t("common.close")}
            </Button> */}
            <Button
              type="button"
              variant="primary"
              size="large"
              onClick={props.onEdit}
              class="!rounded-full px-2 py-2 [&:hover:not(:disabled)]:opacity-75"
            >
              {language.t("project.edit.editLocalEnvironment")}
            </Button>
          </div>
        </div>
      </Show>
    </div>
  )
}

export function generateTomlContent(
  environmentName?: string,
  setup?: string | { default?: string; macos?: string; linux?: string; windows?: string },
  cleanup?: string | { default?: string; macos?: string; linux?: string; windows?: string },
  operations?: Operation[],
): string {
  const literal = (value: string) => {
    const safe = value.replace(/'''/g, "'\\''")
    return `'''\n${safe}\n'''`
  }
  let content = ""
  if (environmentName) {
    content += `environmentName = "${environmentName.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"\n\n`
  }
  if (setup) {
    if (typeof setup === "string") {
      content += `setup = ${literal(setup)}\n\n`
    } else {
      content += "[setup]\n"
      for (const key of ["default", "macos", "linux", "windows"] as const) {
        if (setup[key]) content += `${key} = ${literal(setup[key])}\n`
      }
      content += "\n"
    }
  }
  if (cleanup) {
    if (typeof cleanup === "string") {
      content += `cleanup = ${literal(cleanup)}\n\n`
    } else {
      content += "[cleanup]\n"
      for (const key of ["default", "macos", "linux", "windows"] as const) {
        if (cleanup[key]) content += `${key} = ${literal(cleanup[key])}\n`
      }
      content += "\n"
    }
  }
  if (operations && operations.length > 0) {
    for (const op of operations) {
      content += `[[operations]]\n`
      if (op.name) content += `name = "${op.name.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"\n`
      if (op.icon) content += `icon = "${op.icon}"\n`
      if (op.command) content += `command = ${literal(op.command)}\n`
      if (op.platformSpecific) {
        content += `platform_specific = true\n`
        if (op.platforms && op.platforms.length > 0) {
          content += `platforms = [${op.platforms.map((p) => `"${p}"`).join(", ")}]\n`
        }
      }
      content += `\n`
    }
  }
  return content || "# Empty environment file\n"
}
