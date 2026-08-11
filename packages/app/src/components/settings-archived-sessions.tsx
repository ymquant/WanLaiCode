import { base64Encode } from "@opencode-ai/core/util/encode"
import type { GlobalSession } from "@opencode-ai/sdk/v2/client"
import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Spinner } from "@opencode-ai/ui/spinner"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { showToast } from "@opencode-ai/ui/toast"
import { useNavigate } from "@solidjs/router"
import { createQuery, useQueryClient } from "@tanstack/solid-query"
import {
  Component,
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  type JSX,
} from "solid-js"
import { createStore } from "solid-js/store"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { usePlatform } from "@/context/platform"
import { pathKey } from "@/utils/path-key"
import { formatServerError } from "@/utils/server-errors"
import { sessionTitle } from "@/utils/session-title"
import { ArchivedSessionsFilterMenu } from "./settings-archived-sessions/filter-menu"
import { fetchArchivedSessions } from "./settings-archived-sessions/fetch"
import {
  type ArchivedProjectFilter,
  type ArchivedSort,
  type ArchivedTypeFilter,
  buildArchivedProjectOptions,
  buildProjectDirectoryIndex,
  filterArchivedSessions,
  formatArchivedSessionTime,
  groupArchivedSessions,
  resolveArchivedSessionProject,
  sortArchivedSessions,
  type ProjectCatalogEntry,
} from "./settings-archived-sessions/helpers"
import { ArchivedSessionsProjectMenu, type ArchivedProjectOption } from "./settings-archived-sessions/project-menu"
import {
  ARCHIVED_SESSIONS_AUTOMATION_IDS_QUERY_KEY,
  ARCHIVED_SESSIONS_LIST_QUERY_KEY,
  invalidateArchivedSessionsList,
  removeArchivedSessionFromListCache,
} from "./settings-archived-sessions/sync"
import { unarchiveSession as restoreArchivedSession } from "./settings-archived-sessions/unarchive"

const NO_DRAG = { "-webkit-app-region": "no-drag" } as Record<string, string>

const settingsDropdownClass = "codex-chat-menu min-w-[220px] !z-[80]"

const settingsScrollbarStyle = `
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
`

const settingsArchivedSessionsStyle = `
  ${settingsScrollbarStyle}

  .archived-delete-btn {
    background-color: rgba(232, 79, 79, 0.12);
    color: #e5484d;
    cursor: pointer;
    transition:
      background-color 0.12s ease,
      color 0.12s ease,
      transform 0.08s ease;
  }

  .archived-delete-btn:hover:not(:disabled) {
    background-color: rgba(232, 79, 79, 0.2);
  }

  .archived-delete-btn:active:not(:disabled) {
    background-color: rgba(232, 79, 79, 0.28);
    transform: scale(0.98);
  }

  .archived-delete-btn:disabled {
    cursor: not-allowed;
  }

  .archived-session-row {
    transition: background-color 0.12s ease;
  }

  .archived-session-row:hover {
    background-color: var(--surface-base-hover);
  }

  .archived-session-row:active {
    background-color: var(--surface-base-active);
  }

  .archived-unarchive-btn {
    transition:
      background-color 0.12s ease,
      border-color 0.12s ease,
      transform 0.08s ease;
  }

  .archived-unarchive-btn:hover {
    background-color: var(--surface-base-hover);
    border-color: var(--border-base);
  }

  .archived-unarchive-btn:active {
    background-color: var(--surface-base-active);
    transform: scale(0.98);
  }

  .archived-toolbar-btn {
    transition:
      background-color 0.12s ease,
      transform 0.08s ease;
  }

  .archived-toolbar-btn:active:not(:disabled) {
    background-color: var(--surface-base-active);
    transform: scale(0.98);
  }
`

const ArchivedDeleteConfirmDialog = (props: {
  title: string
  description: string
  confirm: string
  onConfirm: () => void | Promise<unknown>
}) => {
  const dialog = useDialog()
  const language = useLanguage()
  const [busy, setBusy] = createSignal(false)

  const confirm = async () => {
    setBusy(true)
    try {
      await props.onConfirm()
      dialog.close()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      fit
      title={props.title}
      description={props.description}
      class="codex-dialog w-full max-w-[440px] mx-auto !min-h-0"
    >
      <div class="flex justify-end gap-2 p-6 pt-0">
        <Button type="button" variant="ghost" size="large" disabled={busy()} onClick={() => dialog.close()}>
          {language.t("common.cancel")}
        </Button>
        <button
          type="button"
          disabled={busy()}
          onClick={() => void confirm()}
          class="h-9 px-4 rounded-lg text-14-medium archived-delete-btn disabled:opacity-60"
        >
          {props.confirm}
        </button>
      </div>
    </Dialog>
  )
}

export const SettingsArchivedSessions: Component = () => {
  const language = useLanguage()
  const dialog = useDialog()
  const globalSDK = useGlobalSDK()
  const globalSync = useGlobalSync()
  const layout = useLayout()
  const platform = usePlatform()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const [scratchDir, setScratchDir] = createSignal<string | undefined>()
  const [search, setSearch] = createSignal("")
  const [searchQuery, setSearchQuery] = createSignal("")
  const [filterOpen, setFilterOpen] = createSignal(false)
  const [projectOpen, setProjectOpen] = createSignal(false)

  createEffect((on) => {
    const value = search().trim()
    const timer = setTimeout(() => setSearchQuery(value), 300)
    onCleanup(() => clearTimeout(timer))
  })

  let filterAnchor: HTMLButtonElement | undefined
  let projectAnchor: HTMLButtonElement | undefined

  const [filters, setFilters] = createStore({
    type: "all" as ArchivedTypeFilter,
    sort: "updated" as ArchivedSort,
    project: "all" as ArchivedProjectFilter,
  })

  onMount(() => {
    void platform.ensureScratchChatDir?.()
      .then((dir) => setScratchDir(dir))
      .catch(() => undefined)
  })

  const automationIds = createQuery(() => ({
    queryKey: ARCHIVED_SESSIONS_AUTOMATION_IDS_QUERY_KEY,
    queryFn: async () => {
      const response = await globalSDK.client.automation.runSessions()
      return new Set((response.data ?? []).map((item) => item.sessionID))
    },
  }))

  const archivedSearch = createMemo(() => searchQuery().trim())

  const archived = createQuery(() => {
    const search = archivedSearch()
    return {
      queryKey: [...ARCHIVED_SESSIONS_LIST_QUERY_KEY, search] as const,
      queryFn: () => fetchArchivedSessions(globalSDK.client, search || undefined),
      staleTime: 0,
      refetchOnMount: true,
    }
  })

  const archivedSessions = createMemo(() => archived.data?.sessions ?? [])
  const archivedTruncated = createMemo(() => archived.data?.truncated ?? false)

  const scratchLabel = () => language.t("sidebar.section.chats")

  const projectCatalog = createMemo(() => {
    const entries = new Map<string, ProjectCatalogEntry>()
    const add = (project: { id?: string; worktree: string; name?: string; sandboxes?: string[] }) => {
      const key = pathKey(project.worktree)
      if (entries.has(key)) return
      entries.set(key, {
        id: project.id,
        worktree: project.worktree,
        name: project.name?.trim() || project.worktree.split(/[/\\]/).pop() || project.worktree,
        sandboxes: project.sandboxes,
      })
    }
    for (const project of layout.projects.list()) add(project)
    for (const project of globalSync.data.project) add(project)
    return buildProjectDirectoryIndex([...entries.values()])
  })

  const projectOptions = createMemo<ArchivedProjectOption[]>(() =>
    buildArchivedProjectOptions({
      sessions: archivedSessions(),
      index: projectCatalog(),
      scratchDir: scratchDir(),
      scratchLabel: scratchLabel(),
      type: filters.type,
    }),
  )

  createEffect(() => {
    const project = filters.project
    if (typeof project !== "object") return
    const selected = pathKey(project.worktree)
    if (projectOptions().some((item) => pathKey(item.worktree) === selected)) return
    setFilters("project", "all")
  })

  const filtered = createMemo(() => {
    const search = archivedSearch()
    const sessions = filterArchivedSessions({
      sessions: archivedSessions(),
      index: projectCatalog(),
      scratchDir: scratchDir(),
      scratchLabel: scratchLabel(),
      automationIds: automationIds.data ?? new Set<string>(),
      type: filters.type,
      project: filters.project,
      search,
    })
    return sortArchivedSessions(sessions, filters.sort)
  })

  const groups = createMemo(() =>
    groupArchivedSessions(filtered(), {
      index: projectCatalog(),
      sort: filters.sort,
      scratchDir: scratchDir(),
      scratchLabel: scratchLabel(),
    }),
  )

  const typeLabel = createMemo(() => {
    if (filters.type === "local") return language.t("settings.archivedSessions.filter.type.local")
    if (filters.type === "cloud") return language.t("settings.archivedSessions.filter.type.cloud")
    return language.t("settings.archivedSessions.filter.type.all")
  })

  const projectLabel = createMemo(() => {
    if (filters.project === "all") return language.t("settings.archivedSessions.filter.project.all")
    if (filters.project === "chats") return language.t("settings.archivedSessions.filter.project.chats")
    if (filters.project === "automations") return language.t("settings.archivedSessions.filter.project.automations")
    if (typeof filters.project !== "object") return language.t("settings.archivedSessions.filter.project.all")
    const worktree = filters.project.worktree
    const match = projectOptions().find((item) => pathKey(item.worktree) === pathKey(worktree))
    return match?.name ?? worktree
  })

  const deleteAllConfirmTitle = createMemo(() => {
    if (filters.type === "local") return language.t("settings.archivedSessions.deleteAll.confirm.title.local")
    if (filters.type === "cloud") return language.t("settings.archivedSessions.deleteAll.confirm.title.cloud")
    return language.t("settings.archivedSessions.deleteAll.confirm.title.all")
  })

  const deleteAllConfirmDescription = createMemo(() => {
    if (filters.type === "local") return language.t("settings.archivedSessions.deleteAll.confirm.description.local")
    if (filters.type === "cloud") return language.t("settings.archivedSessions.deleteAll.confirm.description.cloud")
    return language.t("settings.archivedSessions.deleteAll.confirm.description.all")
  })

  const sessionsForProject = (worktree: string) =>
    filtered().filter(
      (session: GlobalSession) =>
        pathKey(
          resolveArchivedSessionProject(session, projectCatalog(), {
            scratchDir: scratchDir(),
            scratchLabel: scratchLabel(),
          }).worktree,
        ) === pathKey(worktree),
    )

  const showDeleteAllConfirm = () => {
    dialog.show(() => (
      <ArchivedDeleteConfirmDialog
        title={deleteAllConfirmTitle()}
        description={deleteAllConfirmDescription()}
        confirm={language.t("common.delete")}
        onConfirm={() => void deleteSessions(filtered())}
      />
    ))
  }

  const showDeleteProjectConfirm = (name: string, worktree: string, count: number) => {
    dialog.show(() => (
      <ArchivedDeleteConfirmDialog
        title={language.t("settings.archivedSessions.deleteProject.confirm.title")}
        description={language.t("settings.archivedSessions.deleteProject.confirm.description", {
          name,
          count,
        })}
        confirm={language.t("settings.archivedSessions.menu.deleteProject")}
        onConfirm={() => void deleteSessions(sessionsForProject(worktree))}
      />
    ))
  }

  const showDeleteSessionConfirm = (session: GlobalSession, name: string) => {
    dialog.show(() => (
      <ArchivedDeleteConfirmDialog
        title={language.t("settings.archivedSessions.delete.one.confirm.title")}
        description={language.t("settings.archivedSessions.delete.one.confirm.description", { name })}
        confirm={language.t("common.delete")}
        onConfirm={() => void deleteSessions([session])}
      />
    ))
  }

  const invalidate = () => {
    invalidateArchivedSessionsList(queryClient)
  }

  const deleteSessions = async (sessions: GlobalSession[]) => {
    const results = await Promise.all(
      sessions.map((session) =>
        globalSDK.client.session
          .delete({ sessionID: session.id, directory: session.directory })
          .then((response) => ({ session, ok: !!response.data }))
          .catch(() => ({ session, ok: false as const })),
      ),
    )
    for (const result of results) {
      if (result.ok) removeArchivedSessionFromListCache(queryClient, result.session.id)
    }
    const failed = results.filter((result) => !result.ok).length
    if (failed > 0) {
      showToast({
        variant: "error",
        title: language.t("settings.archivedSessions.delete.failed"),
        description: language.t("settings.archivedSessions.delete.failed.partial", { count: failed }),
      })
      invalidate()
    }
    return failed === 0
  }

  const unarchiveSession = async (session: GlobalSession) => {
    try {
      await restoreArchivedSession({
        client: globalSDK.client,
        globalSync,
        queryClient,
        session,
      })
    } catch (error) {
      showToast({
        variant: "error",
        title: language.t("settings.archivedSessions.unarchive.failed"),
        description: formatServerError(error, language.t, language.t("common.requestFailed")),
      })
      return false
    }

    invalidate()
    return true
  }

  const unarchiveAndOpen = async (session: GlobalSession) => {
    if (!(await unarchiveSession(session))) return
    navigate(`/${base64Encode(session.directory)}/session/${session.id}`)
  }

  const toolbarButtonClass =
    "archived-toolbar-btn flex h-9 shrink-0 items-center gap-2 rounded-[10px] border border-border-weaker-base bg-surface-raised-stronger-non-alpha px-3 text-13-regular text-text-strong transition-[background-color,transform] duration-100 hover:bg-surface-base-hover"

  const SessionRow = (rowProps: { session: GlobalSession }): JSX.Element => {
    const title = () => {
      const value = sessionTitle(rowProps.session.title)
      if (value === "New session") return language.t("sidebar.thread.placeholder.new")
      if (value === "Child session") return language.t("sidebar.thread.placeholder.child")
      return value || language.t("sidebar.thread.placeholder.new")
    }
    const timestamp = () =>
      formatArchivedSessionTime(
        rowProps.session.time.archived ?? rowProps.session.time.updated ?? rowProps.session.time.created,
        language.intl(),
      )

    return (
      <div class="archived-session-row group flex w-full items-center gap-3 px-4 py-3">
        <button
          type="button"
          class="flex min-w-0 flex-1 flex-col gap-0.5 text-left"
          onClick={() => void unarchiveAndOpen(rowProps.session)}
        >
          <span class="text-14-medium text-text-strong">{title()}</span>
          <span class="text-12-regular text-text-weak">{timestamp()}</span>
        </button>
        <div class="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
          <Tooltip value={language.t("settings.archivedSessions.delete.one")} placement="top" gutter={6}>
            <IconButton
              icon="trash"
              variant="ghost"
              size="small"
              class="size-7 text-icon-weak hover:text-text-strong"
              style={NO_DRAG}
              aria-label={language.t("settings.archivedSessions.delete.one")}
              onClick={(event) => {
                event.stopPropagation()
                showDeleteSessionConfirm(rowProps.session, title())
              }}
            />
          </Tooltip>
          <button
            type="button"
          class="archived-unarchive-btn h-7 shrink-0 rounded-lg border border-border-weaker-base bg-surface-raised-stronger-non-alpha px-2.5 text-13-medium text-text-strong"
            style={NO_DRAG}
            onClick={(event) => {
              event.stopPropagation()
              void unarchiveSession(rowProps.session)
            }}
          >
            {language.t("settings.archivedSessions.unarchive")}
          </button>
        </div>
      </div>
    )
  }

  return (
    <>
      <style>{settingsArchivedSessionsStyle}</style>
      <div class="settings-scrollbar flex h-full flex-col overflow-y-auto bg-background-base px-4 pb-10 sm:px-10 sm:pb-10">
        <div
          class="sticky top-0 z-10"
          style={{
            background: "linear-gradient(to bottom, var(--background-base) calc(100% - 24px), transparent)",
            ...NO_DRAG,
          }}
        >
          <div class="flex items-start justify-between gap-4 pb-4 pt-14">
            <h2 class="text-16-medium text-text-strong">{language.t("settings.archivedSessions.title")}</h2>
            <Tooltip
              value={
                archivedTruncated()
                  ? language.t("settings.archivedSessions.deleteAll.disabled.truncated")
                  : language.t("settings.archivedSessions.deleteAll")
              }
              placement="bottom"
              gutter={6}
            >
              <button
                type="button"
                class="archived-delete-btn flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-3 text-13-medium disabled:opacity-50"
                style={NO_DRAG}
                disabled={filtered().length === 0 || archived.isLoading || archivedTruncated()}
                onClick={(event) => {
                  event.stopPropagation()
                  showDeleteAllConfirm()
                }}
              >
                <Icon name="trash" size="small" />
                {language.t("settings.archivedSessions.deleteAll")}
              </button>
            </Tooltip>
          </div>

          <div class="flex flex-col gap-2 pb-6 sm:flex-row sm:items-center">
            <label class="relative flex min-w-0 flex-1 items-center">
              <Icon name="magnifying-glass" size="small" class="pointer-events-none absolute left-3 text-icon-weak" />
              <input
                type="search"
                value={search()}
                placeholder={language.t("settings.archivedSessions.search.placeholder")}
                class="h-9 w-full rounded-[10px] border border-border-weaker-base bg-surface-raised-stronger-non-alpha pl-9 pr-3 text-13-regular text-text-strong outline-none placeholder:text-text-weak focus:border-border-base"
                style={NO_DRAG}
                onInput={(event) => setSearch(event.currentTarget.value)}
              />
            </label>

            <div class="flex shrink-0 items-center gap-2">
              <button
                ref={(el) => (filterAnchor = el)}
                type="button"
                class={toolbarButtonClass}
                style={NO_DRAG}
                onClick={() => {
                  setProjectOpen(false)
                  setFilterOpen((open) => !open)
                }}
              >
                <Icon name="sliders" size="small" class="text-icon-weak" />
                <span class="max-w-[120px] truncate">{typeLabel()}</span>
                <Icon name="chevron-down" size="small" class="text-icon-weak" />
              </button>

              <button
                ref={(el) => (projectAnchor = el)}
                type="button"
                class={toolbarButtonClass}
                style={NO_DRAG}
                onClick={() => {
                  setFilterOpen(false)
                  setProjectOpen((open) => !open)
                }}
              >
                <Icon name="folder" size="small" class="text-icon-weak" />
                <span class="max-w-[140px] truncate">{projectLabel()}</span>
                <Icon name="chevron-down" size="small" class="text-icon-weak" />
              </button>
            </div>
          </div>
        </div>

        <Show when={!archived.isLoading && !archived.isError && archivedTruncated()}>
          <div class="mb-4 rounded-[10px] border border-border-weaker-base bg-surface-raised-stronger-non-alpha px-4 py-2.5 text-13-regular text-text-weak">
            {language.t("settings.archivedSessions.load.truncated")}
          </div>
        </Show>

        <Show when={archived.isLoading}>
          <div class="flex items-center justify-center py-16">
            <Spinner />
          </div>
        </Show>

        <Show when={!archived.isLoading && archived.isError}>
          <div class="rounded-[14px] border border-border-weaker-base px-4 py-8 text-center text-14-regular text-text-weak">
            {language.t("settings.archivedSessions.load.failed")}
          </div>
        </Show>

        <Show when={!archived.isLoading && !archived.isError && filtered().length === 0}>
          <div class="rounded-[14px] border border-border-weaker-base px-4 py-8 text-center text-14-regular text-text-weak">
            {language.t("settings.archivedSessions.empty")}
          </div>
        </Show>

        <Show when={!archived.isLoading && !archived.isError && filtered().length > 0}>
          <div class="overflow-hidden rounded-[14px] border border-border-weaker-base bg-background-base">
            <For each={groups()}>
              {(group, groupIndex) => (
                <section
                  classList={{
                    "border-t border-border-weaker-base": groupIndex() > 0,
                  }}
                >
                  <div class="flex items-center gap-2 border-b border-border-weaker-base px-4 py-2.5">
                    <Icon name="folder" size="small" class="shrink-0 text-icon-weak" />
                    <span class="min-w-0 flex-1 truncate text-13-regular text-text-weak">{group.name}</span>
                    <span class="shrink-0 text-12-regular text-text-weak">
                      {language.t("settings.archivedSessions.group.chatCount", { count: group.sessions.length })}
                    </span>
                    <DropdownMenu placement="bottom-end" gutter={4}>
                      <DropdownMenu.Trigger
                        class="flex size-7 items-center justify-center rounded-md bg-surface-base text-icon-weak hover:bg-surface-base-hover hover:text-text-strong"
                        style={NO_DRAG}
                        aria-label={language.t("common.moreOptions")}
                      >
                        <Icon name="ellipsis-horizontal" size="small" />
                      </DropdownMenu.Trigger>
                      <DropdownMenu.Portal>
                        <DropdownMenu.Content class={settingsDropdownClass}>
                          <DropdownMenu.Item
                            class="gap-2"
                            disabled={archivedTruncated()}
                            onSelect={() =>
                              showDeleteProjectConfirm(group.name, group.worktree, group.sessions.length)
                            }
                          >
                            <Icon name="trash" size="small" class="shrink-0 text-icon-critical-base" />
                            <DropdownMenu.ItemLabel class="text-icon-critical-base">
                              {language.t("settings.archivedSessions.menu.deleteProject")}
                            </DropdownMenu.ItemLabel>
                          </DropdownMenu.Item>
                        </DropdownMenu.Content>
                      </DropdownMenu.Portal>
                    </DropdownMenu>
                  </div>
                  <For each={group.sessions}>
                    {(session, sessionIndex) => (
                      <>
                        <Show when={sessionIndex() > 0}>
                          <div class="h-px bg-border-weaker-base" />
                        </Show>
                        <SessionRow session={session} />
                      </>
                    )}
                  </For>
                </section>
              )}
            </For>
          </div>
        </Show>
      </div>

      <ArchivedSessionsFilterMenu
        open={filterOpen}
        onClose={() => setFilterOpen(false)}
        anchor={() => filterAnchor}
        type={() => filters.type}
        sort={() => filters.sort}
        onType={(value: ArchivedTypeFilter) => setFilters("type", value)}
        onSort={(value: ArchivedSort) => setFilters("sort", value)}
      />

      <ArchivedSessionsProjectMenu
        open={projectOpen}
        onClose={() => setProjectOpen(false)}
        anchor={() => projectAnchor}
        value={() => filters.project}
        projects={projectOptions}
        onSelect={(value: ArchivedProjectFilter) => setFilters("project", value)}
      />
    </>
  )
}
