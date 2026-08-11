import { type Accessor, For, Show, createSignal, type JSX } from "solid-js"
import {
  DragDropProvider,
  DragDropSensors,
  DragOverlay,
  SortableProvider,
  closestCenter,
  type DragEvent,
} from "@thisbeyond/solid-dnd"
import { ConstrainDragXAxis } from "@/utils/solid-dnd"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Tooltip, TooltipKeybind } from "@opencode-ai/ui/tooltip"
import type { LocalProject } from "@/context/layout"
import { useLayout } from "@/context/layout"
import { useLanguage } from "@/context/language"
import { useCommand } from "@/context/command"
import { ProjectRow } from "./project-row"
import { partitionPinnedProjects } from "./pin"
import { FilterMenu } from "./filter-menu"
import { SectionChevron } from "./section-chevron"

export const SidebarProjects = (props: {
  projects: Accessor<LocalProject[]>
  pinned: Accessor<string[]>
  activeThreadId: Accessor<string | undefined>
  sortNow: Accessor<number>
  handleDragStart: (event: unknown) => void
  handleDragEnd: () => void
  handleDragOver: (event: DragEvent) => void
  renderProjectOverlay: () => JSX.Element
  onArchiveSession: (sessionID: string, directory: string) => Promise<void>
  onCreateWorktree: (project: LocalProject) => void
  onRename: (project: LocalProject) => void
  onRemove: (project: LocalProject) => void
  onNewChatInProject: (project: LocalProject) => void
  onAddProject: () => void
  onAddBlankProject: () => void
  scratchChatDir?: () => string | undefined
}): JSX.Element => {
  const language = useLanguage()
  const layout = useLayout()
  const command = useCommand()
  // 已置顶项目移到顶部「置顶」区（pinned.tsx），这里只渲染剩下的一半，避免同一项目出现两次。
  // 顺序保持后端 canonical 列表顺序 —— drag 排序的 toIndex 是按 canonical 列表算的。
  const sorted = () =>
    partitionPinnedProjects({
      projects: props.projects(),
      pinned: props.pinned(),
      scratchDir: props.scratchChatDir?.(),
    }).rest

  const sectionExpanded = layout.tree.expanded("section:projects", { isActiveProject: true })
  const toggleSection = () => layout.tree.toggle("section:projects", { isActiveProject: true })

  const [filterOpen, setFilterOpen] = createSignal(false)
  const [addOpen, setAddOpen] = createSignal(false)
  let filterAnchor: HTMLButtonElement | undefined

  return (
    <div class="flex flex-col gap-1 px-2 py-1">
      <div class="group/section flex items-center justify-between pl-4 pr-1">
        <button
          type="button"
          onClick={toggleSection}
          aria-expanded={sectionExpanded()}
          class="flex flex-1 items-center gap-1 py-1.5 text-12-regular text-text-weak text-left rounded hover:text-text-base"
        >
          {language.t("sidebar.section.projects")}
          <SectionChevron expanded={sectionExpanded} />
        </button>
        <div
          class="flex items-center gap-0.5 opacity-0 pointer-events-none transition-opacity duration-120 group-hover/section:opacity-100 group-hover/section:pointer-events-auto group-focus-within/section:opacity-100 group-focus-within/section:pointer-events-auto"
          classList={{
            "opacity-100 pointer-events-auto": filterOpen() || addOpen(),
          }}
        >
          <Tooltip value={language.t("sidebar.filter.tooltip")} placement="top">
            <IconButton
              ref={(el) => (filterAnchor = el as HTMLButtonElement)}
              icon="sliders"
              variant="ghost"
              size="small"
              class="size-6"
              onClick={() => setFilterOpen((v) => !v)}
              aria-label={language.t("sidebar.filter.tooltip")}
            />
          </Tooltip>
          <DropdownMenu placement="bottom-end" open={addOpen()} onOpenChange={setAddOpen}>
            <TooltipKeybind
              placement="top"
              title={language.t("sidebar.filter.add.project")}
              keybind={command.keybind("project.open") ?? ""}
            >
              <DropdownMenu.Trigger
                as={IconButton}
                icon="folder-add-left"
                variant="ghost"
                size="small"
                class="size-6"
                aria-label={language.t("sidebar.filter.add.project")}
              />
            </TooltipKeybind>
            <DropdownMenu.Portal>
              <DropdownMenu.Content>
                <DropdownMenu.Item onSelect={props.onAddBlankProject}>
                  <Icon name="plus-small" size="small" class="text-text-base" />
                  <DropdownMenu.ItemLabel>
                    {language.t("sidebar.filter.add.blank")}
                  </DropdownMenu.ItemLabel>
                </DropdownMenu.Item>
                <DropdownMenu.Item onSelect={props.onAddProject}>
                  <Icon name="folder" size="small" class="text-text-base" />
                  <DropdownMenu.ItemLabel>
                    {language.t("sidebar.filter.add.existing")}
                  </DropdownMenu.ItemLabel>
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu>
        </div>
      </div>

      <FilterMenu open={filterOpen} onClose={() => setFilterOpen(false)} anchor={() => filterAnchor} />

      <Show when={sectionExpanded()}>
        <DragDropProvider
          onDragStart={props.handleDragStart}
          onDragEnd={props.handleDragEnd}
          onDragOver={props.handleDragOver}
          collisionDetector={closestCenter}
        >
          <DragDropSensors />
          <ConstrainDragXAxis />
          <SortableProvider ids={sorted().map((p) => p.worktree)}>
            <For each={sorted()}>
              {(project) => (
                <ProjectRow
                  project={project}
                  activeThreadId={props.activeThreadId}
                  sortNow={props.sortNow}
                  onArchiveSession={props.onArchiveSession}
                  onCreateWorktree={props.onCreateWorktree}
                  onRename={props.onRename}
                  onRemove={props.onRemove}
                  onNewChatInProject={props.onNewChatInProject}
                />
              )}
            </For>
          </SortableProvider>
          <DragOverlay>{props.renderProjectOverlay()}</DragOverlay>
        </DragDropProvider>
      </Show>
    </div>
  )
}
