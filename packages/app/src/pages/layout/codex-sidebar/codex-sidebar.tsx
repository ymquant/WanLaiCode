import { type Accessor, createSignal, onCleanup, onMount, Show, type JSX } from "solid-js"
import { makeEventListener } from "@solid-primitives/event-listener"
import type { DragEvent as SolidDndDragEvent } from "@thisbeyond/solid-dnd"
import type { LocalProject } from "@/context/layout"
import { usePlatform } from "@/context/platform"
import { useLanguage } from "@/context/language"
import { SidebarGlobals } from "./globals"
import { SidebarPinned } from "./pinned"
import { SidebarProjects } from "./projects"
import { SidebarChats } from "./chats"
import { SidebarAutomations } from "./automations"
import { SidebarFooter } from "./footer"
import { hasDroppedDirectory, resolveDroppedDirectoryPath } from "./folder-drop"

// 不能加 data-tauri-drag-region —— macOS 的 region 计算会拦截浮动按钮的 mousedown，即便它们 z=100 在视觉之上
const SidebarHeader = (): JSX.Element => {
  const platform = usePlatform()
  if (platform.platform === "desktop" && platform.os === "windows") return null as unknown as JSX.Element
  return <div class="h-10 shrink-0" aria-hidden="true" />
}

// Codex 风格左 sidebar：纵向 4 区块
export const CodexSidebar = (props: {
  projects: Accessor<LocalProject[]>
  pinned: Accessor<string[]>
  activeThreadId: Accessor<string | undefined>
  sortNow: Accessor<number>
  handleDragStart: (event: unknown) => void
  handleDragEnd: () => void
  handleDragOver: (event: SolidDndDragEvent) => void
  renderProjectOverlay: () => JSX.Element
  onNewChat: () => void
  onNewChatInProject: (project: LocalProject) => void
  onSearch: () => void
  onPlugins: () => void
  onAutomations: () => void
  onQuickChat: () => void
  onArchiveSession: (sessionID: string, directory: string) => Promise<void>
  onCreateWorktree: (project: LocalProject) => void
  onRename: (project: LocalProject) => void
  onRemove: (project: LocalProject) => void
  onOpenSettings: () => void
  onAccountPopoverOpenChange?: (open: boolean) => void
  onAddProject: () => void
  onAddBlankProject: () => void
  scratchChatDir?: () => string | undefined
  onNewChatScratch: () => void
  onFolderDrop: (directory: string) => Promise<void>
}): JSX.Element => {
  const language = useLanguage()
  const platform = usePlatform()
  const [dragOver, setDragOver] = createSignal(false)

  let containerRef: HTMLDivElement | undefined

  const getFilePath = (file: File) => {
    if (platform.getPathForFile) {
      try {
        const path = platform.getPathForFile(file)
        if (path) return path
      } catch {
      }
    }
  }

  const handleDragOver = (event: DragEvent) => {
    if (!containerRef || !containerRef.contains(event.target as Node)) return
    if (!hasDroppedDirectory(event.dataTransfer?.items)) return
    event.preventDefault()
    setDragOver(true)
  }

  const handleDragLeave = (event: DragEvent) => {
    if (!containerRef) return
    if (containerRef.contains(event.relatedTarget as Node)) return
    setDragOver(false)
  }

  const handleDrop = (event: DragEvent) => {
    if (!containerRef || !containerRef.contains(event.target as Node)) return
    if (!hasDroppedDirectory(event.dataTransfer?.items)) return
    event.preventDefault()
    event.stopPropagation()
    setDragOver(false)

    const dir = resolveDroppedDirectoryPath({
      items: event.dataTransfer?.items,
      files: event.dataTransfer?.files,
      getPathForFile: getFilePath,
    })
    if (dir) void props.onFolderDrop(dir)
  }

  onMount(() => {
    makeEventListener(document, "dragover", handleDragOver, { capture: true })
    makeEventListener(document, "dragleave", handleDragLeave, { capture: true })
    makeEventListener(document, "drop", handleDrop, { capture: true })
  })

  onCleanup(() => setDragOver(false))

  return (
    <div
      ref={(el) => (containerRef = el)}
      class="flex flex-col h-full w-full relative"
    >
      <Show when={dragOver()}>
        <div class="absolute inset-0 z-50 flex items-center justify-center bg-[rgba(0,0,0,0.06)] border-2 border-dashed border-icon-info-active rounded-lg pointer-events-none">
          <div class="px-4 py-2 rounded-lg bg-bg-base text-14-medium text-text-base shadow-lg">
            {language.t("sidebar.dropFolder.hint")}
          </div>
        </div>
      </Show>
      {/* bg-[rgb(245,245,244)] 去除覆盖背景 毛玻璃需要  */}
      <SidebarHeader />
      <SidebarGlobals
        onNewChat={props.onNewChat}
        onSearch={props.onSearch}
        onPlugins={props.onPlugins}
        onAutomations={props.onAutomations}
        onQuickChat={props.onQuickChat}
      />
      <div class="flex-1 min-h-0 overflow-y-auto [scrollbar-color:rgba(0,0,0,0.1)_transparent] [&::-webkit-scrollbar-thumb]:bg-[rgba(0,0,0,0.1)]">
        <SidebarPinned
          projects={props.projects}
          pinned={props.pinned}
          activeThreadId={props.activeThreadId}
          sortNow={props.sortNow}
          onArchiveSession={props.onArchiveSession}
          onCreateWorktree={props.onCreateWorktree}
          onRename={props.onRename}
          onRemove={props.onRemove}
          onNewChatInProject={props.onNewChatInProject}
          scratchChatDir={props.scratchChatDir}
        />
        <SidebarProjects
          projects={props.projects}
          pinned={props.pinned}
          activeThreadId={props.activeThreadId}
          sortNow={props.sortNow}
          handleDragStart={props.handleDragStart}
          handleDragEnd={props.handleDragEnd}
          handleDragOver={props.handleDragOver}
          renderProjectOverlay={props.renderProjectOverlay}
          onArchiveSession={props.onArchiveSession}
          onCreateWorktree={props.onCreateWorktree}
          onRename={props.onRename}
          onRemove={props.onRemove}
          onNewChatInProject={props.onNewChatInProject}
          onAddProject={props.onAddProject}
          onAddBlankProject={props.onAddBlankProject}
          scratchChatDir={props.scratchChatDir}
        />
        <SidebarChats
          scratchChatDir={props.scratchChatDir}
          activeThreadId={props.activeThreadId}
          sortNow={props.sortNow}
          onArchiveSession={props.onArchiveSession}
          onNewChat={props.onNewChatScratch}
        />
        <SidebarAutomations
          activeThreadId={props.activeThreadId}
          sortNow={props.sortNow}
          onArchiveSession={props.onArchiveSession}
        />
      </div>
      <SidebarFooter onOpenSettings={props.onOpenSettings} onAccountPopoverOpenChange={props.onAccountPopoverOpenChange} />
    </div>
  )
}
