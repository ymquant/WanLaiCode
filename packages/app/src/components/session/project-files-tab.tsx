import { createEffect, createMemo, createResource, createSignal, For, Match, on, onMount, Show, Switch, batch } from "solid-js"
import { Dynamic } from "solid-js/web"
import { Tabs } from "@opencode-ai/ui/tabs"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Button } from "@opencode-ai/ui/button"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { AppIcon, type AppIconProps } from "@opencode-ai/ui/app-icon"
import { ResizeHandle } from "@opencode-ai/ui/resize-handle"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import { useFileComponent } from "@opencode-ai/ui/context/file"
import { Markdown } from "@opencode-ai/ui/markdown"
import { sampledChecksum } from "@opencode-ai/core/util/encode"
import { createStore } from "solid-js/store"
import { useFile } from "@/context/file"
import { useLanguage } from "@/context/language"
import { useSessionLayout } from "@/pages/session/session-layout"
import { useSync } from "@/context/sync"
import { useSDK } from "@/context/sdk"
import { usePlatform, type InstalledOpener } from "@/context/platform"
import { usePrompt } from "@/context/prompt"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { showToast } from "@opencode-ai/ui/toast"
import { getFilename } from "@opencode-ai/core/util/path"
import { knownOpenerOverride } from "@/utils/project-openers"
import { createPathOpenerItems } from "@/utils/path-openers"
import { getDefaultEditorOpener, orderOpenersByDefaultEditor, setDefaultEditorOpener } from "@/utils/default-opener"
import { fileManagerInfo } from "@/utils/file-manager"
import FileTree, { FileContextMenu, type FileContextMenuActions, type Filter } from "@/components/file-tree"
import { DialogFileCreate } from "@/components/dialog-file-create"
import { DialogFileRename } from "@/components/dialog-file-rename"
import { DialogConfirm } from "@/components/dialog-confirm"
import { getSkillPreview } from "@/utils/skill-preview"
import { createFileTreeStore } from "@/context/file/tree-store"
import { Persist, persisted } from "@/utils/persist"
import { PdfPreview } from "@/components/file-preview/pdf-preview"
import { AudioPreview } from "@/components/file-preview/audio-preview"
import { VideoPreview } from "@/components/file-preview/video-preview"
import { SpreadsheetPreview } from "@/components/file-preview/spreadsheet-preview"
import { DocxPreview } from "@/components/file-preview/docx-preview"
import { PptxPreview } from "@/components/file-preview/pptx-preview"
import { FontPreview } from "@/components/file-preview/font-preview"
import {
  BinaryFilePlaceholder,
  FileOpenErrorPlaceholder,
  LegacyOfficePlaceholder,
} from "@/components/file-preview/binary-placeholder"
import { getProjectFilesPersistKey } from "./project-files-persist"
import { isMarkdownProjectFilePath } from "./project-files-path"

export const PROJECT_FILES_TAB_ID = "project-files:default"

export function isProjectFilesTab(tab: string) {
  return tab === PROJECT_FILES_TAB_ID
}


type SessionTabsApi = {
  all: () => string[]
  active: () => string | undefined
  preview: () => string | undefined
  open: (tab: string, opts?: { preview?: boolean }) => void | Promise<void>
  setActive: (tab: string | undefined) => void
  setAll: (all: string[]) => void
  close: (tab: string) => void
}

/** 打开或激活唯一的 default「浏览项目文件」标签；若当前浏览预览已变成文件标签，先将其固定。 */
export function openBrowseProjectFilesTab(tabs: SessionTabsApi) {
  const preview = tabs.preview()
  const active = tabs.active()
  if (preview && active === preview && tabs.all().includes(preview) && !isProjectFilesTab(preview)) {
    void tabs.open(preview, { preview: false })
  }

  if (tabs.all().includes(PROJECT_FILES_TAB_ID)) {
    tabs.setActive(PROJECT_FILES_TAB_ID)
    return
  }
  void tabs.open(PROJECT_FILES_TAB_ID)
  tabs.setActive(PROJECT_FILES_TAB_ID)
}

/** 将 default 浏览标签原地替换为文件标签，实现「选中文件后标签名变为文件名」。 */
function replaceDefaultBrowseTab(tabs: SessionTabsApi, fileTab: string, opts?: { preview?: boolean }) {
  const current = tabs.all()
  const defaultIdx = current.indexOf(PROJECT_FILES_TAB_ID)
  if (defaultIdx === -1) {
    void tabs.open(fileTab, opts)
    return
  }

  const without = current.filter((tab) => tab !== PROJECT_FILES_TAB_ID && tab !== fileTab)
  const insertAt = Math.min(defaultIdx, without.length)
  const next = [...without.slice(0, insertAt), fileTab, ...without.slice(insertAt)]
  batch(() => {
    tabs.setAll(next)
    void tabs.open(fileTab, opts)
  })
}

/** 将当前标签原地替换为另一文件标签（浏览预览链：情况 1）。 */
function replaceTabInPlace(tabs: SessionTabsApi, currentTab: string, fileTab: string, opts?: { preview?: boolean }) {
  const current = tabs.all()
  const idx = current.indexOf(currentTab)
  if (idx === -1) {
    void tabs.open(fileTab, opts)
    return
  }

  const without = current.filter((tab) => tab !== currentTab && tab !== fileTab)
  const insertAt = Math.min(idx, without.length)
  const next = [...without.slice(0, insertAt), fileTab, ...without.slice(insertAt)]
  batch(() => {
    tabs.setAll(next)
    void tabs.open(fileTab, opts)
  })
}

/** 文件已在外层标签条打开时只激活，不新建/不替换。 */
export function activateOrOpenSessionFileTab(
  tabs: SessionTabsApi,
  fileTab: string,
  opts?: { preview?: boolean },
) {
  if (tabs.all().includes(fileTab)) {
    tabs.setActive(fileTab)
    return
  }
  void tabs.open(fileTab, opts)
  tabs.setActive(fileTab)
}

export function ProjectFilesTabContent(props: { tab: string; active?: boolean; embedded?: boolean }) {
  const file = useFile()
  const language = useLanguage()
  const platform = usePlatform()
  const fileComponent = useFileComponent()
  const { tabs, params } = useSessionLayout()
  const sync = useSync()
  const sdk = useSDK()
  const prompt = usePrompt()
  const dialog = useDialog()

  const persistKey = getProjectFilesPersistKey(props.embedded)
  const embeddedTreeStore = props.embedded
    ? createFileTreeStore({
        scope: () => sdk.directory,
        normalizeDir: (input) => file.normalize(input).replace(/\/+$/, ""),
        list: (dir) => sdk.client.file.list({ path: dir }).then((x) => x.data ?? []),
        onError: (dir, message) => {
          if (dir === "") {
            showToast({
              variant: "error",
              title: language.t("toast.file.listFailed.title"),
              description: message,
            })
          }
        },
      })
    : undefined
  const embeddedTree = embeddedTreeStore
    ? {
        list: embeddedTreeStore.listDir,
        refresh: (input: string) => embeddedTreeStore.listDir(input, { force: true }),
        state: embeddedTreeStore.dirState,
        children: embeddedTreeStore.children,
        expand: embeddedTreeStore.expandDir,
        collapse: embeddedTreeStore.collapseDir,
        isUserCollapsed: embeddedTreeStore.isUserCollapsed,
      }
    : undefined
  const tree = () => embeddedTree ?? file.tree

  const [projectFiles, setProjectFiles, , projectFilesReady] = persisted(
    Persist.scoped(sdk.directory, params.id, persistKey),
    createStore<{
      openTabs?: string[]
      activeTab?: string
      previewTab?: string
      browsePreviewTab?: string
      selectedPath?: string
      collapsed: boolean
    }>({
      collapsed: false,
    }),
  )
  const collapsed = () => projectFiles.collapsed
  const [treeWidth, setTreeWidth] = createSignal(280)
  const [search, setSearch] = createSignal("")
  const [wordWrap, setWordWrap] = createSignal(true)
  const [enhancedView, setEnhancedView] = createSignal(true)
  const isAbsolutePath = (input: string) =>
    input.startsWith("/") || /^[A-Za-z]:[\\/]/.test(input) || input.startsWith("\\\\")
  const absolutePath = (input: string) => isAbsolutePath(input) ? input : `${sdk.directory}/${input}`

  // 将旧版内层 openTabs 拍平迁移到外层 session tabs（一次性）
  let migrated = false
  createEffect(() => {
    if (props.embedded) return
    if (!projectFilesReady() || migrated) return
    migrated = true
    const legacy = projectFiles.openTabs
    if (!legacy || legacy.length === 0) return

    const session = tabs()
    const existing = new Set(session.all())
    const promoted = legacy.filter((tab) => file.pathFromTab(tab) && !existing.has(tab))
    batch(() => {
      if (promoted.length > 0) {
        session.setAll([...session.all().filter((tab) => tab !== PROJECT_FILES_TAB_ID), ...promoted])
      }
      const preferred =
        projectFiles.activeTab && (promoted.includes(projectFiles.activeTab) || existing.has(projectFiles.activeTab))
          ? projectFiles.activeTab
          : promoted.at(-1)
      if (preferred) {
        session.setActive(preferred)
        const restoredPath = file.pathFromTab(preferred)
        if (restoredPath) void file.load(restoredPath)
      }
      setProjectFiles("openTabs", [])
      setProjectFiles("activeTab", undefined)
      setProjectFiles("previewTab", undefined)
    })
  })

  const path = createMemo(() => {
    if (isProjectFilesTab(props.tab)) return projectFiles.selectedPath
    return props.tab.startsWith("file://") ? file.pathFromTab(props.tab) : props.tab
  })

  createEffect(() => {
    const p = path()
    if (p) void file.load(p)
  })

  createEffect(() => {
    if (!props.active) return
    if (!isProjectFilesTab(props.tab)) return
    if (props.embedded) return
    if (!projectFiles.selectedPath) return
    setProjectFiles("selectedPath", undefined)
  })

  createEffect(() => {
    if (props.embedded) return
    const marked = projectFiles.browsePreviewTab
    if (!marked) return
    if (!tabs().all().includes(marked)) setProjectFiles("browsePreviewTab", undefined)
  })

  const openFileTab = (filePath: string, opts?: { preview?: boolean }) => {
    const fileTab = file.tab(filePath)
    const session = tabs()
    const currentTab = props.tab
    const preview = opts?.preview ?? false

    if (session.all().includes(fileTab) && fileTab !== currentTab) {
      if (!preview) void session.open(fileTab, { preview: false })
      session.setActive(fileTab)
      void file.load(filePath)
      return
    }

    const isDefaultBrowse = isProjectFilesTab(currentTab)
    const isBrowseOriginPreview =
      !isDefaultBrowse &&
      session.preview() === currentTab &&
      projectFiles.browsePreviewTab === currentTab

    if (isDefaultBrowse) {
      replaceDefaultBrowseTab(session, fileTab, opts)
      setProjectFiles("browsePreviewTab", preview ? fileTab : undefined)
    } else if (isBrowseOriginPreview) {
      if (fileTab === currentTab) {
        if (!preview) {
          void session.open(fileTab, { preview: false })
          setProjectFiles("browsePreviewTab", undefined)
        }
      } else {
        replaceTabInPlace(session, currentTab, fileTab, opts)
        setProjectFiles("browsePreviewTab", preview ? fileTab : undefined)
      }
    } else {
      activateOrOpenSessionFileTab(session, fileTab, opts)
    }

    void file.load(filePath)
  }

  const searchFilter = createMemo(() => {
    const q = search().trim().toLowerCase()
    if (!q) return undefined
    const files = new Set<string>()
    const dirs = new Set<string>()
    const allNodes = tree().children("")
    const walk = (nodes: { path: string; type: string; name: string }[]) => {
      for (const node of nodes) {
        if (node.type === "file") {
          if (node.name.toLowerCase().includes(q)) {
            files.add(node.path)
            const parts = node.path.split(/[\\/]/)
            for (let i = 1; i < parts.length; i++) {
              dirs.add(parts.slice(0, i).join("/"))
            }
          }
        } else {
          walk(tree().children(node.path))
        }
      }
    }
    walk(allNodes)
    return { files, dirs } as Filter
  })

  const state = createMemo(() => {
    const p = path()
    if (!p) return
    return file.get(p)
  })
  const contents = createMemo(() => state()?.content?.content ?? "")
  const cacheKey = createMemo(() => sampledChecksum(contents()))

  const projectName = createMemo(() => {
    const worktree = sync.project?.worktree ?? sdk.directory
    return getFilename(worktree)
  })

  const fullPath = createMemo(() => {
    const p = path()
    if (!p) return
    return absolutePath(p)
  })

  const pathSegments = createMemo(() => {
    const p = path()
    if (!p) return []
    const skill = getSkillPreview(p)
    if (skill) return skill.path.split(/[\\/]/).filter(Boolean)
    return [projectName(), ...p.split(/[\\/]/).filter(Boolean)]
  })

  const isMarkdownFile = createMemo(() => {
    const p = path()
    if (!p) return false
    return isMarkdownProjectFilePath(p)
  })

  const [projectOpeners, { refetch: refetchOpeners }] = createResource<InstalledOpener[], boolean>(
    () => platform.platform === "desktop" && typeof platform.listInstalledOpeners === "function",
    async (enabled) => {
      if (!enabled) return []
      return (await platform.listInstalledOpeners?.()) ?? []
    },
  )

  const openerItems = createMemo(() => {
    const p = fullPath()
    if (!p) return []
    return createPathOpenerItems({
      path: p,
      // 文件预览页和输入框附件共用默认编辑器偏好，避免不同入口打开到不同编辑器。
      openers: orderOpenersByDefaultEditor(projectOpeners() ?? []),
      platform,
      t: (key, params) => language.t(key as Parameters<typeof language.t>[0], params),
      includeTerminals: false,
      onSelectOpener: (opener) => {
        if (opener.kind === "editor") setDefaultEditorOpener(opener)
      },
    })
  })

  const fileContextMenu = createMemo<FileContextMenuActions>(() => {
    const fm = fileManagerInfo(platform.os)
    return {
      onRevealInFinder: (path: string) => {
        void platform.showItemInFolder?.(absolutePath(path))
      },
      revealInFinderLabel: () => language.t("command.file.revealInFinder", { name: language.t(fm.nameKey) }),
      revealInFinderIcon: () => <AppIcon id={fm.iconId} alt="" class="size-4" />,
      onCopyPath: (path: string) => {
        navigator.clipboard.writeText(absolutePath(path))
      },
      onAddToChat: (path: string) => {
        const current = prompt.current()
        const cursor = prompt.cursor() ?? current.reduce((sum, p) => sum + ("content" in p ? (p.content as string).length : 0), 0)
        const content = "@" + getFilename(path)
        const attachment: { type: "file"; path: string; content: string; start: number; end: number } = {
          type: "file",
          path: absolutePath(path),
          content,
          start: 0,
          end: content.length,
        }
        prompt.set([...current, attachment], cursor)
      },
      onCreateFile: platform.writeFile ? (relativePath: string, isDirectory: boolean) => {
        const parentDir = isDirectory ? relativePath : relativePath.includes("/") || relativePath.includes("\\") ? relativePath.replace(/[\\/][^\\/]+$/, "") : ""
        dialog.show(() => (
          <DialogFileCreate
            type="file"
            onConfirm={async (name) => {
              const filePath = `${absolutePath(parentDir)}/${name}`
              const exists = await sdk.client.file.exists({ path: filePath }).then((x) => x.data?.exists).catch(() => false)
              if (exists) throw new Error("File already exists")
              await platform.writeFile?.(filePath, "")
              if (!isAbsolutePath(parentDir)) {
                tree().expand(parentDir)
                tree().refresh(parentDir)
              }
            }}
          />
        ))
      } : undefined,
      onCreateFolder: platform.ensureDirectory ? (relativePath: string, isDirectory: boolean) => {
        const parentDir = isDirectory ? relativePath : relativePath.includes("/") || relativePath.includes("\\") ? relativePath.replace(/[\\/][^\\/]+$/, "") : ""
        dialog.show(() => (
          <DialogFileCreate
            type="folder"
            onConfirm={async (name) => {
              await platform.ensureDirectory?.(`${absolutePath(parentDir)}/${name}`)
              if (!isAbsolutePath(parentDir)) {
                tree().expand(parentDir)
                tree().refresh(parentDir)
              }
            }}
          />
        ))
      } : undefined,
      openerItems: (path: string) =>
        createPathOpenerItems({
          path: absolutePath(path),
          // 文件树右键菜单也按同一默认编辑器排序，首项就是直接点击附件时使用的编辑器。
          openers: orderOpenersByDefaultEditor(projectOpeners() ?? []),
          platform,
          t: (key, params) => language.t(key as Parameters<typeof language.t>[0], params),
          includeTerminals: false,
          onSelectOpener: (opener) => {
            if (opener.kind === "editor") setDefaultEditorOpener(opener)
          },
        }),
      onRefresh: () => { tree().refresh("") },
      onRename: platform.renameFile ? (path: string) => {
        const absPath = absolutePath(path)
        dialog.show(() => (
          <DialogFileRename
            path={absPath}
            onConfirm={async (newName) => {
              const newPath = `${absPath.replace(/[\\/][^\\/]+$/, "") || sdk.directory}/${newName}`
              await platform.renameFile?.(absPath, newPath)
              const parentDir = absPath.replace(/[\\/][^\\/]+$/, "").replace(sdk.directory, "").replace(/^[\\/]/, "")
              tree().refresh(parentDir)
            }}
          />
        ))
      } : undefined,
      onDelete: platform.trashFile ? (path: string) => {
        const absPath = absolutePath(path)
        const parentDir = absPath.replace(/[\\/][^\\/]+$/, "").replace(sdk.directory, "").replace(/^[\\/]/, "")
        dialog.show(() => (
          <DialogConfirm
            title={language.t("session.files.deleteConfirm.title")}
            description={language.t("session.files.deleteConfirm.description")}
            confirmLabel={language.t("session.files.deleteConfirm.action")}
            onConfirm={async () => {
              try {
                await platform.trashFile?.(absPath)
                tree().refresh(parentDir)
              } catch {
                showToast({ title: language.t("session.files.deleteFailed"), variant: "error" })
                throw new Error("delete failed")
              }
            }}
          />
        ))
      } : undefined,
    }
  })

  const openerTriggerIcon = createMemo(() => {
    const item = getDefaultEditorOpener(projectOpeners() ?? [])
    if (!item) return { type: "app" as const, id: "vscode" as const }
    const override = knownOpenerOverride({ bundleId: item.bundleId, app: item.app, name: item.name })
    if (override.iconId) return { type: "app" as const, id: override.iconId }
    if (item.iconDataUrl) return { type: "image" as const, src: item.iconDataUrl }
    return { type: "icon" as const, name: "open-file" as const }
  })

  const isAppIcon = (icon: { type: string; id?: AppIconProps["id"] }): icon is { type: "app"; id: AppIconProps["id"] } =>
    icon.type === "app" && Boolean(icon.id)

  const renderOpenerIcon = (icon: ReturnType<typeof openerTriggerIcon> | ReturnType<typeof openerItems>[number]["icon"]) => {
    if (isAppIcon(icon)) return <AppIcon id={icon.id} alt="" class="size-4" />
    if (icon.type === "image") return <img src={icon.src} alt="" class="size-4" draggable={false} />
    return <Icon name="open-file" size="small" class="size-4" />
  }

  const openProjectFile = (filePath: string, opts: { preview: boolean }) => {
    if (props.embedded) {
      setProjectFiles("selectedPath", filePath)
      void file.load(filePath)
      return
    }

    if (!isProjectFilesTab(props.tab)) {
      openFileTab(filePath, opts)
      return
    }

    const fileTab = file.tab(filePath)
    const session = tabs()
    if (session.all().includes(fileTab)) {
      session.close(PROJECT_FILES_TAB_ID)
      session.setActive(fileTab)
      void file.load(filePath)
      return
    }

    replaceDefaultBrowseTab(session, fileTab, opts)
    session.setActive(fileTab)
    setProjectFiles("selectedPath", filePath)
    setProjectFiles("browsePreviewTab", opts.preview ? fileTab : undefined)
    void file.load(filePath)
  }

  const handleFileClick = (node: { path: string; type: string }) => {
    if (node.type !== "file") return
    openProjectFile(node.path, { preview: true })
  }

  const handleFileDoubleClick = (node: { path: string; type: string }) => {
    if (node.type !== "file") return
    const fileTab = file.tab(node.path)
    const session = tabs()
    if (session.preview() === fileTab) {
      void session.open(fileTab, { preview: false })
    }
    openProjectFile(node.path, { preview: false })
  }

  const copyPath = async () => {
    const p = fullPath()
    if (!p) return
    await navigator.clipboard.writeText(p)
  }

  const copyContent = async () => {
    const c = contents()
    if (!c) return
    await navigator.clipboard.writeText(c)
  }

  const loadTree = () => {
    const dir = tree().state("")
    if (!dir?.loaded && !dir?.loading) {
      void tree().list("")
    }
  }

  onMount(loadTree)

  createEffect(
    on(
      () => file.ready(),
      () => loadTree(),
    ),
  )

  createEffect(
    on(
      () => [sdk.directory, params.id] as const,
      () => {
        if (!embeddedTreeStore) return
        embeddedTreeStore.reset()
        loadTree()
      },
      { defer: true },
    ),
  )

  const renderFile = (source: string) => (
    <div class="relative overflow-hidden pb-40">
      <Dynamic
        component={fileComponent}
        mode="text"
        file={{
          name: path() ?? "",
          contents: source,
          cacheKey: cacheKey(),
        }}
        overflow={wordWrap() ? "wrap" : "scroll"}
        class="select-text"
      />
    </div>
  )

  const previewKind = createMemo<"reader" | "text" | "loading" | "error" | "empty">(() => {
    const c = state()?.content
    if (!state()?.loaded) {
      if (state()?.loading) return "loading"
      if (state()?.error) return "error"
      return "empty"
    }
    if (!c) return "empty"
    if (c.type === "binary") return "reader"
    if (c.type === "previewable") return "reader"
    if (c.encoding === "base64") return "reader"
    return "text"
  })

  return (
    <Tabs.Content value={props.tab} class="flex flex-col h-full overflow-hidden contain-strict">
      {/* Breadcrumb path bar */}
        <div
          data-component="project-files-toolbar"
          class="shrink-0 flex items-center justify-between px-3 py-1.5 border-b border-border-weaker-base bg-background-base min-w-0"
        >
          {/* Breadcrumb path */}
          <div class="flex items-center gap-1 min-w-0 flex-1 overflow-hidden">
            <Show when={path()} fallback={<span class="text-13-medium text-text-weaker">/</span>}>
              <div class="flex items-center gap-1 min-w-0 truncate">
                <For each={pathSegments()}>
                  {(seg, idx) => (
                    <>
                      {idx() > 0 && <span class="text-12-regular text-text-weaker shrink-0">&gt;</span>}
                      <span
                        class="text-13-medium"
                        classList={{
                          "text-text-weak": idx() < pathSegments().length - 1,
                          "text-text-strong": idx() === pathSegments().length - 1,
                        }}
                      >
                        {seg}
                      </span>
                    </>
                  )}
                </For>
              </div>
            </Show>
          </div>
          {/* Right actions */}
          <div class="flex items-center gap-1 shrink-0 ml-2">
            <Show when={path()}>
              <Tooltip value={language.t("session.files.moreActions")}>
                <DropdownMenu placement="bottom-end" gutter={4}>
                  <DropdownMenu.Trigger
                    as={Button}
                    variant="ghost"
                    class="size-6 p-0"
                    aria-label={language.t("session.files.moreActions")}
                  >
                    <Icon name="ellipsis-horizontal" size="small" class="size-4" />
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content class="codex-chat-menu min-w-[160px]">
                      <DropdownMenu.Item onSelect={() => void copyPath()}>
                        <Icon name="link" size="small" />
                        <DropdownMenu.ItemLabel>{language.t("session.files.copyPath")}</DropdownMenu.ItemLabel>
                      </DropdownMenu.Item>
                      <DropdownMenu.Item onSelect={() => void copyContent()}>
                        <Icon name="copy" size="small" />
                        <DropdownMenu.ItemLabel>{language.t("session.files.copyContent")}</DropdownMenu.ItemLabel>
                      </DropdownMenu.Item>
                      <DropdownMenu.Separator />
                      <DropdownMenu.Item onSelect={() => setWordWrap(!wordWrap())}>
                        <Icon name="auto-wrap" size="small" />
                        <DropdownMenu.ItemLabel>
                          {wordWrap() ? language.t("session.files.disableWordWrap") : language.t("session.files.enableWordWrap")}
                        </DropdownMenu.ItemLabel>
                      </DropdownMenu.Item>
                      <Show when={isMarkdownFile()}>
                        <DropdownMenu.Item onSelect={() => setEnhancedView(!enhancedView())}>
                          <Icon name="code" size="small" />
                          <DropdownMenu.ItemLabel>
                            {enhancedView() ? language.t("session.files.disableEnhancedView") : language.t("session.files.enableEnhancedView")}
                          </DropdownMenu.ItemLabel>
                        </DropdownMenu.Item>
                      </Show>
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu>
              </Tooltip>
              <Tooltip value={language.t("command.project.openIn")}>
                <DropdownMenu
                  placement="bottom-end"
                  gutter={4}
                  onOpenChange={(open) => {
                    if (open) void refetchOpeners()
                  }}
                >
                  <DropdownMenu.Trigger
                    as={Button}
                    variant="ghost"
                    class="size-6 p-0"
                    aria-label={language.t("command.project.openIn")}
                  >
                    {renderOpenerIcon(openerTriggerIcon())}
                  </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content class="codex-chat-menu min-w-[160px]">
                    <For each={openerItems()}>
                      {(item) => (
                        <DropdownMenu.Item onSelect={() => void item.onSelect()}>
                          {renderOpenerIcon(item.icon)}
                          <DropdownMenu.ItemLabel>{item.label}</DropdownMenu.ItemLabel>
                        </DropdownMenu.Item>
                      )}
                    </For>
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu>
              </Tooltip>
            </Show>
            <IconButton
              icon={collapsed() ? "folder-open-codex" : "folder-codex"}
              variant="ghost"
              size="small"
              class="size-6"
              onClick={() => setProjectFiles("collapsed", !projectFiles.collapsed)}
              aria-label={collapsed() ? language.t("session.files.expandTree") : language.t("session.files.collapseTree")}
            />
          </div>
        </div>

      {/* Split pane: editor left, tree right */}
      <div class="flex-1 min-h-0 flex overflow-hidden">
        {/* File content panel (left) */}
        <div class="relative flex-1 min-w-[calc(3rem+78px)] h-full overflow-hidden bg-background-base">
          <Show
            when={path()}
            fallback={
              <div class="h-full w-full min-w-[calc(3rem+78px)] flex flex-col items-center justify-center gap-2 px-6 text-center text-text-weak">
                <Icon name="folder" size="medium" />
                <span class="text-14-semibold text-text-strong whitespace-nowrap shrink-0">
                  {language.t("session.files.openFile")}
                </span>
                <span class="text-13-regular text-text-weak block w-full">
                  {language.t("session.files.selectFromTree")}
                </span>
              </div>
            }
          >
            <Show
              when={previewKind() === "text"}
              fallback={
                <Switch>
                  <Match when={state()?.loaded}>
                    <Show
                      when={state()?.content}
                      keyed
                      fallback={<BinaryFilePlaceholder filename={getFilename(path() ?? "")} />}
                    >
                      {(content) => {
                      const c = content

                      if (c.type === "binary") return (
                        <BinaryFilePlaceholder
                          filename={getFilename(path() ?? "")}
                          onOpenWithDefault={() => {
                            const p = fullPath()
                            if (p) void platform.openPath?.(p)
                          }}
                          onRevealInFolder={() => {
                            const p = fullPath()
                            if (p) void platform.showItemInFolder?.(p)
                          }}
                        />
                      )

                      const isImg = c.encoding === "base64" && c.mimeType?.startsWith("image/")
                      if (isImg) {
                        return (
                          <div class="flex items-center justify-center h-full p-4">
                            <img
                              src={`data:${c.mimeType};base64,${c.content}`}
                              alt={path() ?? ""}
                              class="max-w-full max-h-full object-contain"
                            />
                          </div>
                        )
                      }

                      const isAudio = c.encoding === "base64" && c.mimeType?.startsWith("audio/")
                      if (isAudio) return <AudioPreview content={c} filename={getFilename(path() ?? "")} />

                      const isVideo = c.encoding === "base64" && c.mimeType?.startsWith("video/")
                      if (isVideo) return <VideoPreview content={c} filename={getFilename(path() ?? "")} />

                      const isPdf = c.encoding === "base64" && c.mimeType === "application/pdf"
                      if (isPdf) return <PdfPreview content={c} />

                      const isDocx = c.type === "previewable" && c.mimeType?.includes("wordprocessingml")
                      if (isDocx) return <DocxPreview content={c} />

                      const isXlsx = c.type === "previewable" && (c.mimeType?.includes("spreadsheetml") || c.mimeType === "application/vnd.ms-excel")
                      if (isXlsx) return <SpreadsheetPreview content={c} filename={getFilename(path() ?? "")} />

                      const isPptx = c.type === "previewable" && c.mimeType?.includes("presentationml")
                      if (isPptx) return <PptxPreview content={c} filename={getFilename(path() ?? "")} />

                      const isLegacyOffice = c.type === "previewable" && (
                        c.mimeType === "application/msword" ||
                        c.mimeType === "application/vnd.ms-powerpoint"
                      )
                      if (isLegacyOffice) return (
                        <LegacyOfficePlaceholder
                          filename={getFilename(path() ?? "")}
                          format={c.mimeType?.includes("word") ? ".doc" : ".ppt"}
                          onOpenWithDefault={() => {
                            const p = fullPath()
                            if (p) void platform.openPath?.(p)
                          }}
                        />
                      )

                      const isFont = c.type === "previewable" && c.mimeType?.startsWith("font/")
                      if (isFont) return <FontPreview content={c} filename={getFilename(path() ?? "")} />

                      return (
                        <BinaryFilePlaceholder
                          filename={getFilename(path() ?? "")}
                          onOpenWithDefault={() => {
                            const p = fullPath()
                            if (p) void platform.openPath?.(p)
                          }}
                        />
                      )
                      }}
                    </Show>
                  </Match>
                  <Match when={state()?.loading}>
                    <div class="flex h-full items-center justify-center text-text-weak">
                      {language.t("common.loading")}...
                    </div>
                  </Match>
                  <Match when={state()?.error}>
                    <FileOpenErrorPlaceholder />
                  </Match>
                </Switch>
              }
            >
              <ScrollView class="h-full">
                <Switch>
                  <Match when={state()?.loaded}>
                    {(() => {
                      if (isMarkdownProjectFilePath(path() ?? "")) {
                        return enhancedView()
                          ? <div class="p-6"><Markdown text={contents()} cacheKey={cacheKey()} class="select-text" /></div>
                          : renderFile(contents())
                      }
                      return renderFile(contents())
                    })()}
                  </Match>
                  <Match when={state()?.loading}>
                    <div class="px-6 py-4 text-text-weak">{language.t("common.loading")}...</div>
                  </Match>
                  <Match when={state()?.error}>
                    <FileOpenErrorPlaceholder />
                  </Match>
                </Switch>
              </ScrollView>
            </Show>
          </Show>
        </div>

        {/* Resize handle */}
        <Show when={!collapsed()}>
          <div class="relative shrink-0 self-stretch w-0 z-30">
            <ResizeHandle
              direction="horizontal"
              edge="start"
              size={treeWidth()}
              min={160}
              max={500}
              onResize={(w) => setTreeWidth(w)}
            />
          </div>
        </Show>

        {/* File tree panel (right) */}
        <div
          class="shrink-0 h-full overflow-hidden bg-background-base transition-all duration-300"
          classList={{ "border-l border-border-weaker-base": !collapsed() }}
          style={{ width: collapsed() ? "0px" : `${treeWidth()}px` }}
        >
          <Show when={!collapsed()}>
            <div class="h-full flex flex-col">
              {/* Search input */}
              <div class="shrink-0 px-2 py-1.5">
                <div class="flex items-center gap-1.5 px-2 py-1 rounded-md bg-surface-raised-base border border-border-weak-base">
                  <Icon name="magnifying-glass" size="small" class="size-3.5 text-icon-weak shrink-0" />
                  <input
                    type="text"
                    class="flex-1 min-w-0 bg-transparent outline-none text-12-regular text-text-strong placeholder:text-text-weak"
                    placeholder={language.t("session.files.filterFiles")}
                    value={search()}
                    onInput={(e) => setSearch(e.currentTarget.value)}
                  />
                </div>
              </div>

              {/* File tree */}
              <FileContextMenu
                node={{ name: "", path: "", absolute: "", type: "directory", ignored: false }}
                actions={fileContextMenu()}
                triggerClass="flex-1 min-h-0 flex flex-col"
              >
                <div class="flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-2 py-1">
                  <Show when={file.ready()} fallback={
                    <div class="flex items-center justify-center h-full text-text-weak">
                      <span class="text-13-regular">{language.t("common.loading")}...</span>
                    </div>
                  }>
                    <FileTree
                      path=""
                      level={0}
                      draggable={true}
                      onFileClick={handleFileClick}
                      onFileDoubleClick={handleFileDoubleClick}
                      fileContextMenu={fileContextMenu()}
                      tree={tree()}
                      _filter={searchFilter()}
                    />
                  </Show>
                </div>
              </FileContextMenu>
            </div>
          </Show>
        </div>
      </div>
    </Tabs.Content>
  )
}
