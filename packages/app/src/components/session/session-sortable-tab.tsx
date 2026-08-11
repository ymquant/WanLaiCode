import { createEffect, createMemo, createSignal, Show } from "solid-js"
import type { JSX } from "solid-js"
import { createSortable } from "@thisbeyond/solid-dnd"
import { FileIcon } from "@opencode-ai/ui/file-icon"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { TooltipKeybind } from "@opencode-ai/ui/tooltip"
import { Tabs } from "@opencode-ai/ui/tabs"
import { getFilename } from "@opencode-ai/core/util/path"
import { useFile } from "@/context/file"
import { useLanguage } from "@/context/language"
import { useCommand } from "@/context/command"
import { useSessionLayout } from "@/pages/session/session-layout"
import { isBrowserTab, getBrowserInfo } from "@/components/session/browser-tab"
import { isProjectFilesTab } from "@/components/session/project-files-tab"
import { getSkillPreview } from "@/utils/skill-preview"

function BrowserFavicon(props: { src?: string; class?: string }) {
  const [failed, setFailed] = createSignal(false)

  createEffect(() => {
    props.src
    setFailed(false)
  })

  return (
    <Show
      when={props.src && !failed()}
      fallback={<Icon name="webpage-icon" size="small" class={props.class} data-slot="review-tab-icon" />}
    >
      <img src={props.src} alt="" class={props.class} data-slot="review-tab-icon" onError={() => setFailed(true)} />
    </Show>
  )
}

export function FileVisual(props: { path: string; active?: boolean; preview?: boolean }): JSX.Element {
  const skill = createMemo(() => getSkillPreview(props.path))
  const label = createMemo(() => skill()?.displayName ?? getFilename(props.path))
  return (
    <div class="flex items-center gap-x-1.5 min-w-0" title={skill()?.path ?? props.path}>
      <Show
        when={!props.active}
        fallback={<FileIcon node={{ path: props.path, type: "file" }} class="size-4 shrink-0" />}
      >
        <span class="relative inline-flex size-4 shrink-0">
          <FileIcon node={{ path: props.path, type: "file" }} class="absolute inset-0 size-4 tab-fileicon-color" />
          <FileIcon node={{ path: props.path, type: "file" }} mono class="absolute inset-0 size-4 tab-fileicon-mono" />
        </span>
      </Show>
      <span
        class="text-14-medium truncate"
        classList={{ italic: props.preview }}
        style={props.preview ? { "font-style": "italic" } : undefined}
      >
        {label()}
      </span>
    </div>
  )
}

export function SortableTab(props: { tab: string; onTabClose: (tab: string) => void; onTabCloseStart?: (tab: string) => void }): JSX.Element {
  const file = useFile()
  const language = useLanguage()
  const command = useCommand()
  const { tabs } = useSessionLayout()
  const sortable = createSortable(props.tab)
  const path = createMemo(() => file.pathFromTab(props.tab))
  const browserInfo = createMemo(() => (isBrowserTab(props.tab) ? getBrowserInfo(props.tab) : undefined))
  const isPreview = createMemo(() => tabs().preview() === props.tab)
  const unpreview = () => {
    if (!isPreview()) return
    void tabs().open(props.tab, { preview: false })
  }
  return (
    <div
      use:sortable
      class="h-full flex items-center"
      classList={{ "opacity-0": sortable.isActiveDraggable }}
      style={{ "-webkit-app-region": "no-drag" } as Record<string, string>}
    >
      <div class="relative">
        <Tabs.Trigger
          value={props.tab}
          onDblClick={unpreview}
          style={{ "-webkit-app-region": "no-drag" } as Record<string, string>}
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
                class="review-tab-close p-0"
                onClick={(e) => {
                  e.stopPropagation()
                  props.onTabCloseStart?.(props.tab)
                  props.onTabClose(props.tab)
                }}
                aria-label={language.t("common.closeTab")}
              />
            </TooltipKeybind>
          }
          hideCloseButton
          onMiddleClick={() => props.onTabClose(props.tab)}
        >
          <Show when={path()} fallback={
            <>
              <Show when={isBrowserTab(props.tab)}>
                <div class="flex items-center gap-x-1.5 min-w-0">
                  <BrowserFavicon src={browserInfo()?.favicon} class="size-4 shrink-0 rounded-sm object-contain" />
                  <span class="text-14-medium truncate">{browserInfo()?.title || "New Tab"}</span>
                </div>
              </Show>
              <Show when={isProjectFilesTab(props.tab)}>
                <div class="flex items-center gap-x-1.5 min-w-0">
                  <Icon name="folder" size="small" class="size-4 shrink-0" />
                  <span class="text-14-medium truncate">{language.t("session.browser.browseProjectFiles")}</span>
                </div>
              </Show>
            </>
          }>
            {(value) => <FileVisual path={value()} preview={isPreview()} />}
          </Show>
        </Tabs.Trigger>
      </div>
    </div>
  )
}
