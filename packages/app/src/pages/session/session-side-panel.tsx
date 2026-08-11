import { For, Match, Show, Switch, createEffect, createMemo, createSignal, onCleanup, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { Tabs } from "@opencode-ai/ui/tabs"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { TooltipKeybind } from "@opencode-ai/ui/tooltip"
import { ResizeHandle } from "@opencode-ai/ui/resize-handle"
import { Mark } from "@opencode-ai/ui/logo"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { DragDropProvider, DragDropSensors, DragOverlay, SortableProvider, closestCenter } from "@thisbeyond/solid-dnd"
import type { DragEvent } from "@thisbeyond/solid-dnd"
import type { SnapshotFileDiff, VcsFileDiff } from "@opencode-ai/sdk/v2"
import { ConstrainDragYAxis, getDraggableId } from "@/utils/solid-dnd"
import { useDialog } from "@opencode-ai/ui/context/dialog"

import FileTree from "@/components/file-tree"
import { SessionContextUsage } from "@/components/session-context-usage"
import { SessionContextTab, SortableTab, FileVisual } from "@/components/session"
import {
  BrowserTabContent,
  createBrowserTabId,
  createBrowserViewsHidden,
  destroyBrowserTab,
  hideBrowserTab,
  isBrowserTab,
  removeBrowserTab,
} from "@/components/session/browser-tab"
import { isProjectFilesTab, ProjectFilesTabContent, openBrowseProjectFilesTab } from "@/components/session/project-files-tab"
import { useCommand } from "@/context/command"
import { useFile, type SelectedLineRange } from "@/context/file"
import { useLanguage } from "@/context/language"
import { useLayout, DEFAULT_REVIEW_PANEL_WIDTH } from "@/context/layout"
import { usePlatform } from "@/context/platform"
import { useSettings } from "@/context/settings"
import { useSync } from "@/context/sync"
import { createFileTabListSync } from "@/pages/session/file-tab-scroll"
import { FileTabListScrollBar } from "@/pages/session/file-tab-list-scrollbar"
import { createOpenSessionFileTab, createSessionDesktopLayout, createSessionTabs, getTabReorderIndex, type Sizing } from "@/pages/session/helpers"
import { automationPanel, automationPanelCollapsed } from "@/pages/automation/panel-store"
import { AutomationDetailPanel } from "@/pages/automation/detail-panel"
import { setSessionHandoff } from "@/pages/session/handoff"
import { useSessionLayout } from "@/pages/session/session-layout"
import emptyFileChanges from "@/assets/empty-file-changes.svg"

export function SessionSidePanel(props: {
  canReview: () => boolean
  diffs: () => (SnapshotFileDiff | VcsFileDiff)[]
  diffsReady: () => boolean
  empty: () => string
  hasReview: () => boolean
  reviewCount: () => number
  reviewPanel: () => JSX.Element
  activeDiff?: string
  focusReviewDiff: (path: string) => void
  reviewSnap: boolean
  reviewExpanded: boolean
  size: Sizing
  onOpenReviewPanel: () => boolean
}) {
  const layout = useLayout()
  const platform = usePlatform()
  const settings = useSettings()
  const sync = useSync()
  const file = useFile()
  const language = useLanguage()
  const command = useCommand()
  const dialog = useDialog()
  const { sessionKey, tabs, view } = useSessionLayout()

  const isDesktop = createSessionDesktopLayout(platform)
  const shown = createMemo(
    () =>
      platform.platform !== "desktop" ||
      (import.meta.env.VITE_WANLAICODE_CHANNEL ?? import.meta.env.VITE_OPENCODE_CHANNEL) !== "beta" ||
      settings.general.showFileTree(),
  )

  const reviewOpen = createMemo(() => isDesktop() && view().reviewPanel.opened())
  // 自动化详情面板:点对话内联卡片后打开,按 sessionKey 作用域(对照 Codex 右侧面板)
  // autoOpen:面板是否归属当前会话;autoVisible:再叠加折叠态(折叠时隐藏但保留打开状态可再展开)
  const autoOpen = createMemo(() => isDesktop() && automationPanel()?.sessionKey === sessionKey())
  const autoVisible = createMemo(() => autoOpen() && !automationPanelCollapsed())
  const fileOpen = createMemo(
    () => isDesktop() && shown() && layout.fileTree.opened() && !reviewOpen() && !autoOpen(),
  )
  const open = createMemo(() => reviewOpen() || fileOpen() || autoVisible())
  const reviewTab = createMemo(() => isDesktop())
  const panelWidth = createMemo(() => {
    if (!open()) return "0px"
    if (autoVisible()) return "360px"
    if (reviewOpen() && props.reviewExpanded) return "100%"
    if (reviewOpen()) {
      return `max(${DEFAULT_REVIEW_PANEL_WIDTH}px, calc(100% - ${layout.session.width()}px))`
    }
    return `${layout.fileTree.width()}px`
  })
  const treeWidth = createMemo(() => (fileOpen() ? `${layout.fileTree.width()}px` : "0px"))

  const diffFiles = createMemo(() => props.diffs().map((d) => d.file))
  const kinds = createMemo(() => {
    const merge = (a: "add" | "del" | "mix" | undefined, b: "add" | "del" | "mix") => {
      if (!a) return b
      if (a === b) return a
      return "mix" as const
    }

    const normalize = (p: string) => p.replaceAll("\\\\", "/").replace(/\/+$/, "")

    const out = new Map<string, "add" | "del" | "mix">()
    for (const diff of props.diffs()) {
      const file = normalize(diff.file)
      const kind = diff.status === "added" ? "add" : diff.status === "deleted" ? "del" : "mix"

      out.set(file, kind)

      const parts = file.split("/")
      for (const [idx] of parts.slice(0, -1).entries()) {
        const dir = parts.slice(0, idx + 1).join("/")
        if (!dir) continue
        out.set(dir, merge(out.get(dir), kind))
      }
    }
    return out
  })

  const empty = (msg: string) => (
    <div class="h-full flex flex-col">
      <div class="h-6 shrink-0" aria-hidden />
      <div class="flex-1 pb-64 flex items-center justify-center text-center">
        <div class="flex flex-col items-center gap-4">
          <img src={emptyFileChanges} alt="" aria-hidden="true" class="size-14 shrink-0 object-contain" />
          <div class="text-12-regular text-text-weak">{msg}</div>
        </div>
      </div>
    </div>
  )

  const nofiles = createMemo(() => {
    const state = file.tree.state("")
    if (!state?.loaded) return false
    return file.tree.children("").length === 0
  })

  const normalizeTab = (tab: string) => {
    if (!tab.startsWith("file://")) return tab
    return file.tab(tab)
  }

  const openReviewPanel = () => props.onOpenReviewPanel()

  const closeReviewPanel = () => {
    view().reviewPanel.close()
  }

  const closeTab = (tab: string) => {
    if (isBrowserTab(tab)) {
      destroyBrowserTab(tab)
      tabs().close(tab)
      return
    }
    if (isProjectFilesTab(tab)) {
      tabs().close(tab)
      return
    }
    tabs().close(tab)
  }

  const startCloseTab = (tab: string) => {
    if (!isBrowserTab(tab)) return
    hideBrowserTab(tab)
  }

  const openTab = createOpenSessionFileTab({
    normalizeTab,
    openTab: tabs().open,
    pathFromTab: file.pathFromTab,
    loadFile: file.load,
    openReviewPanel,
    setActive: tabs().setActive,
    allTabs: tabs().all,
  })

  const handleTabChange = (value: string) => {
    if (isBrowserTab(value) || value === "context" || value === "review") {
      if (!view().reviewPanel.opened() && !openReviewPanel()) return
      tabs().open(value)
      tabs().setActive(value)
      return
    }
    if (isProjectFilesTab(value)) {
      if (!view().reviewPanel.opened() && !openReviewPanel()) return
      tabs().open(value)
      tabs().setActive(value)
      return
    }
    openTab(value)
  }

  const tabState = createSessionTabs({
    tabs,
    pathFromTab: file.pathFromTab,
    normalizeTab,
    review: reviewTab,
    hasReview: props.canReview,
  })
  const contextOpen = tabState.contextOpen
  const openedTabs = tabState.openedTabs
  const activeTab = tabState.activeTab
  const activeFileTab = tabState.activeFileTab
  const activeBrowserTab = tabState.activeBrowserTab
  const browseContentTab = createMemo(() => {
    const active = activeTab()
    if (isProjectFilesTab(active)) return active
    return activeFileTab()
  })

  const fileTreeTab = () => layout.fileTree.tab()

  const setFileTreeTabValue = (value: string) => {
    if (value !== "changes" && value !== "all") return
    layout.fileTree.setTab(value)
  }

  const showAllFiles = () => {
    if (fileTreeTab() !== "changes") return
    layout.fileTree.setTab("all")
  }

  const [store, setStore] = createStore({
    activeDraggable: undefined as string | undefined,
  })

  const [tabList, setTabList] = createSignal<HTMLDivElement | undefined>()
  const [addContentMenuOpen, setAddContentMenuOpen] = createSignal(false)
  const browserSessionPanelHidden = createMemo(() => !!dialog.active || addContentMenuOpen())
  createBrowserViewsHidden(browserSessionPanelHidden, "session-panel")

  const handleDragStart = (event: unknown) => {
    const id = getDraggableId(event)
    if (!id) return
    setStore("activeDraggable", id)
  }

  const handleDragOver = (event: DragEvent) => {
    const { draggable, droppable } = event
    if (!draggable || !droppable) return

    const currentTabs = tabs().all()
    const toIndex = getTabReorderIndex(currentTabs, draggable.id.toString(), droppable.id.toString())
    if (toIndex === undefined) return
    tabs().move(draggable.id.toString(), toIndex)
  }

  const handleDragEnd = () => {
    setStore("activeDraggable", undefined)
  }

  const openFileSearch = () => {
    void import("@/components/dialog-select-file").then((x) => {
      dialog.show(() => <x.DialogSelectFile mode="files" onOpenFile={showAllFiles} />)
    })
  }

  const openBrowserTab = () => {
    const tab = createBrowserTabId()
    tabs().open(tab)
    tabs().setActive(tab)
    openReviewPanel()
  }

  const openProjectFilesTab = () => {
    openBrowseProjectFilesTab(tabs())
    openReviewPanel()
  }

  createEffect(() => {
    if (!file.ready()) return

    setSessionHandoff(sessionKey(), {
      files: tabs()
        .all()
        .reduce<Record<string, SelectedLineRange | null>>((acc, tab) => {
          const path = file.pathFromTab(tab)
          if (!path) return acc

          const selected = file.selectedLines(path)
          acc[path] =
            selected && typeof selected === "object" && "start" in selected && "end" in selected
              ? (selected as SelectedLineRange)
              : null

          return acc
        }, {}),
    })
  })

  return (
    <Show when={isDesktop()}>
      <aside
        id="review-panel"
        aria-label={language.t("session.panel.reviewAndFiles")}
        aria-hidden={!open()}
        inert={!open()}
        class="relative min-w-0 h-full flex shrink-0 overflow-hidden bg-background-base"
        classList={{
          "pointer-events-none": !open(),
          "transition-[width] duration-[240ms] ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[width] motion-reduce:transition-none":
            !props.size.active() && !props.reviewSnap,
        }}
        style={{ width: panelWidth() }}
      >
        <div class="size-full flex border-l border-border-weaker-base">
          <div
            aria-hidden={!reviewOpen()}
            inert={!reviewOpen()}
            class="relative min-w-0 h-full flex-1 overflow-hidden bg-background-base"
            classList={{
              "pointer-events-none": !reviewOpen(),
            }}
          >
            <div class="size-full min-w-0 h-full bg-background-base">
              <DragDropProvider
                onDragStart={handleDragStart}
                onDragEnd={handleDragEnd}
                onDragOver={handleDragOver}
                collisionDetector={closestCenter}
              >
                <DragDropSensors />
                <ConstrainDragYAxis />
                <Tabs value={activeTab()} onChange={handleTabChange}>
                  {/* no-drag：审查标签栏整条落在 macOS 顶部 40px 窗口拖拽条（layout.tsx 的 app-region:drag）下，
                      不显式 no-drag 的话整条会被当成拖拽区，点「审查」标签/文件标签/「+」都会变成拖窗口而点不动。
                      macOS 按叶子重判拖拽区，下面各交互叶子另有单独 no-drag 兜底。 */}
                  <div
                    class="sticky top-0 shrink-0 flex flex-col"
                    style={{ "-webkit-app-region": "no-drag" } as Record<string, string>}
                  >
                    <Tabs.List
                      ref={(el: HTMLDivElement) => {
                        setTabList(el)
                        const stop = createFileTabListSync({ el, contextOpen })
                        onCleanup(() => {
                          stop()
                          setTabList(undefined)
                        })
                      }}
                    >
                      <Show when={reviewTab() && props.canReview()}>
                        <Tabs.Trigger
                          value="review"
                          hideCloseButton
                          style={{ "-webkit-app-region": "no-drag" } as Record<string, string>}
                          closeButton={
                            <TooltipKeybind
                              title={language.t("command.review.toggle")}
                              keybind={command.keybind("review.toggle")}
                              placement="bottom"
                              gutter={10}
                            >
                              <IconButton
                                icon="close-small"
                                variant="ghost"
                                class="review-tab-close p-0"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  closeReviewPanel()
                                }}
                                aria-label={language.t("command.review.toggle")}
                              />
                            </TooltipKeybind>
                          }
                        >
                          <div class="flex min-w-0 items-center gap-2">
                            <Icon
                              name="review"
                              size="small"
                              class="review-tab-icon size-3.5 shrink-0"
                              data-slot="review-tab-icon"
                            />
                            <span class="truncate text-14-medium">{language.t("session.tab.review")}</span>
                          </div>
                        </Tabs.Trigger>
                      </Show>
                      {/* 暂不展示「上下文」Tab —— 占比按钮已改为直接触发 /compact，这里入口先隐藏，代码保留以便日后恢复。 */}
                      {/* <Show when={contextOpen()}>
                        <Tabs.Trigger
                          value="context"
                          closeButton={
                            <TooltipKeybind
                              title={language.t("common.closeTab")}
                              keybind={command.keybind("tab.close")}
                              placement="bottom"
                              gutter={10}
                            >
                              <IconButton
                                icon="close-small"
                                variant="ghost"
                                class="h-5 w-5"
                                onClick={() => tabs().close("context")}
                                aria-label={language.t("common.closeTab")}
                              />
                            </TooltipKeybind>
                          }
                          hideCloseButton
                          onMiddleClick={() => tabs().close("context")}
                        >
                          <div class="flex items-center gap-2">
                            <SessionContextUsage variant="indicator" />
                            <div>{language.t("session.tab.context")}</div>
                          </div>
                        </Tabs.Trigger>
                      </Show> */}
                      <SortableProvider ids={openedTabs()}>
                        <For each={openedTabs()}>{(tab) => <SortableTab tab={tab} onTabClose={closeTab} onTabCloseStart={startCloseTab} />}</For>
                      </SortableProvider>
                      {/* 右侧留白跟视口右上角 chrome 按钮数量同步：审查面板开时 expand + layout-right（68px） */}
                      <div
                        class="bg-background-base h-full shrink-0 sticky right-0 z-10 flex items-center justify-center"
                        classList={{
                          "pr-11": !reviewOpen(),
                          "pr-[68px]": reviewOpen(),
                        }}
                      >
                        <DropdownMenu
                          placement="bottom-start"
                          gutter={4}
                          onOpenChange={setAddContentMenuOpen}
                        >
                          <TooltipKeybind
                            title={language.t("command.file.open")}
                            keybind={command.keybind("file.open")}
                            class="flex items-center"
                          >
                            <DropdownMenu.Trigger
                              as={IconButton}
                              icon="plus-small"
                              variant="ghost"
                              iconSize="large"
                              class="!rounded-md"
                              style={{ "-webkit-app-region": "no-drag" } as Record<string, string>}
                              aria-label={language.t("command.file.open")}
                            />
                          </TooltipKeybind>
                          <DropdownMenu.Portal>
                            <DropdownMenu.Content class="codex-chat-menu min-w-48">
                              <DropdownMenu.Item onSelect={openFileSearch}>
                                <Icon name="magnifying-glass" size="small" class="text-text-base" />
                                <DropdownMenu.ItemLabel>{language.t("session.browser.searchFiles")}</DropdownMenu.ItemLabel>
                              </DropdownMenu.Item>
                              <DropdownMenu.Item onSelect={openBrowserTab}>
                                <Icon name="webpage-icon" size="small" class="text-text-base" />
                                <DropdownMenu.ItemLabel>{language.t("session.browser.openBrowser")}</DropdownMenu.ItemLabel>
                              </DropdownMenu.Item>
                              <DropdownMenu.Item onSelect={openProjectFilesTab}>
                                <Icon name="folder" size="small" class="text-text-base" />
                                <DropdownMenu.ItemLabel>
                                  {language.t("session.browser.browseProjectFiles")}
                                </DropdownMenu.ItemLabel>
                              </DropdownMenu.Item>
                            </DropdownMenu.Content>
                          </DropdownMenu.Portal>
                        </DropdownMenu>
                      </div>
                    </Tabs.List>
                    <FileTabListScrollBar list={tabList} />
                  </div>

                  <div class="relative flex-1 min-h-0">
                    <Show when={reviewTab() && props.canReview()}>
                      <Tabs.Content value="review" class="flex flex-col h-full overflow-hidden contain-strict">
                        <Show when={activeTab() === "review"}>{props.reviewPanel()}</Show>
                      </Tabs.Content>
                    </Show>

                    <Tabs.Content value="empty" class="flex flex-col h-full overflow-hidden contain-strict">
                      <Show when={activeTab() === "empty"}>
                        <div class="relative pt-2 flex-1 min-h-0 overflow-hidden">
                          <div class="h-full px-6 pb-42 -mt-4 flex flex-col items-center justify-center text-center gap-6">
                            <Mark class="w-14 h-14 shrink-0" />
                            <div class="text-14-regular text-text-weak max-w-56">
                              {language.t("session.files.selectToOpen")}
                            </div>
                          </div>
                        </div>
                      </Show>
                    </Tabs.Content>

                    <Show when={contextOpen()}>
                      <Tabs.Content value="context" class="flex flex-col h-full overflow-hidden contain-strict">
                        <Show when={activeTab() === "context"}>
                          <div class="relative pt-2 flex-1 min-h-0 overflow-hidden">
                            <SessionContextTab />
                          </div>
                        </Show>
                      </Tabs.Content>
                    </Show>

                    <For each={openedTabs().filter((t) => isBrowserTab(t))}>
                      {(tab) => <BrowserTabContent tab={tab} active={activeBrowserTab() === tab} />}
                    </For>

                    <Show when={browseContentTab()} keyed>
                      {(tab) => <ProjectFilesTabContent tab={tab} active />}
                    </Show>

                  </div>
                </Tabs>
                <DragOverlay>
                  <Show when={store.activeDraggable} keyed>
                    {(tab) => {
                      const path = file.pathFromTab(tab)
                      return (
                        <div data-component="tabs-drag-preview">
                          <Show when={path} fallback={
                            <Show when={isProjectFilesTab(tab)}>
                              <div class="flex items-center gap-x-1.5 min-w-0">
                                <Icon name="folder" size="small" class="size-4 shrink-0" />
                                <span class="text-14-medium truncate">{language.t("session.browser.browseProjectFiles")}</span>
                              </div>
                            </Show>
                          }>
                            {(p) => <FileVisual active path={p()} />}
                          </Show>
                        </div>
                      )
                    }}
                  </Show>
                </DragOverlay>
              </DragDropProvider>
            </div>
          </div>

          <Show when={shown()}>
            <div
              id="file-tree-panel"
              aria-hidden={!fileOpen()}
              inert={!fileOpen()}
              class="relative min-w-0 h-full shrink-0 overflow-hidden"
              classList={{
                "pointer-events-none": !fileOpen(),
                "transition-[width] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[width] motion-reduce:transition-none":
                  !props.size.active(),
              }}
              style={{ width: treeWidth() }}
            >
              <div
                class="h-full flex flex-col overflow-hidden group/filetree"
                classList={{ "border-l border-border-weaker-base": reviewOpen() }}
              >
                <Tabs
                  variant="pill"
                  value={fileTreeTab()}
                  onChange={setFileTreeTabValue}
                  class="h-full"
                  data-scope="filetree"
                >
                  <Tabs.List>
                    <Tabs.Trigger value="changes" class="flex-1" classes={{ button: "w-full" }}>
                      {props.reviewCount()}{" "}
                      {language.t(
                        props.reviewCount() === 1 ? "session.review.change.one" : "session.review.change.other",
                      )}
                    </Tabs.Trigger>
                    <Tabs.Trigger value="all" class="flex-1" classes={{ button: "w-full" }}>
                      {language.t("session.files.all")}
                    </Tabs.Trigger>
                  </Tabs.List>
                  <Tabs.Content value="changes" class="bg-background-stronger px-3 py-0">
                    <Switch>
                      <Match when={props.hasReview() || !props.diffsReady()}>
                        <Show
                          when={props.diffsReady()}
                          fallback={
                            <div class="px-2 py-2 text-12-regular text-text-weak">
                              {language.t("common.loading")}
                              {language.t("common.loading.ellipsis")}
                            </div>
                          }
                        >
                          <FileTree
                            path=""
                            class="pt-3"
                            allowed={diffFiles()}
                            kinds={kinds()}
                            draggable={false}
                            active={props.activeDiff}
                            onFileClick={(node) => props.focusReviewDiff(node.path)}
                          />
                        </Show>
                      </Match>
                    </Switch>
                  </Tabs.Content>
                  <Tabs.Content value="all" class="bg-background-stronger px-3 py-0">
                    <Switch>
                      <Match when={nofiles()}>{empty(language.t("session.files.empty"))}</Match>
                      <Match when={true}>
                        <FileTree
                          path=""
                          class="pt-3"
                          modified={diffFiles()}
                          kinds={kinds()}
                          draggable={true}
                          onFileClick={(node) => {
                            const tab = file.tab(node.path)
                            if (tabs().all().includes(tab)) {
                              tabs().setActive(tab)
                              return
                            }
                            openTab(tab, { preview: true })
                          }}
                          onFileDoubleClick={(node) => openTab(file.tab(node.path), { preview: false })}
                        />
                      </Match>
                    </Switch>
                  </Tabs.Content>
                </Tabs>
              </div>
              <Show when={fileOpen()}>
                <div>
                  <ResizeHandle
                    direction="horizontal"
                    edge="start"
                    size={layout.fileTree.width()}
                    min={200}
                    max={480}
                    onResizeStart={() => props.size.start()}
                    onResize={(width) => {
                      props.size.touch()
                      layout.fileTree.resize(width)
                    }}
                  />
                </div>
              </Show>
            </div>
          </Show>
        </div>
        <Show when={autoVisible() && automationPanel()}>
          {(panel) => (
            <div class="absolute inset-0 z-20 bg-background-base">
              <AutomationDetailPanel automationID={panel().automationID} />
            </div>
          )}
        </Show>
      </aside>
    </Show>
  )
}
