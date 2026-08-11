import type { JSX } from "solid-js"
import { Show, createEffect, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { createSortable } from "@thisbeyond/solid-dnd"
import { Tabs } from "@opencode-ai/ui/tabs"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Icon } from "@opencode-ai/ui/icon"
import { InlineInput } from "@opencode-ai/ui/inline-input"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { useTerminal, type LocalPTY } from "@/context/terminal"
import { useLanguage } from "@/context/language"
import { focusTerminalById } from "@/pages/session/helpers"
import { terminalTabLabel } from "@/pages/session/terminal-label"

export function SortableTerminalTab(props: { terminal: LocalPTY; projectName?: string; onClose?: () => void; active?: boolean }): JSX.Element {
  const terminal = useTerminal()
  const language = useLanguage()
  const sortable = createSortable(props.terminal.id)
  const [store, setStore] = createStore({
    editing: false,
    title: props.terminal.title,
    menuOpen: false,
    menuPosition: { x: 0, y: 0 },
    blurEnabled: false,
  })
  let input: HTMLInputElement | undefined
  let blurFrame: number | undefined
  let editRequested = false

  const label = () => {
    language.locale()
    return terminalTabLabel({
      title: props.terminal.title,
      titleNumber: props.terminal.titleNumber,
      projectName: props.projectName,
      shellOwnsTitle: props.terminal.shellOwnsTitle,
      t: language.t as (key: string, vars?: Record<string, string | number | boolean>) => string,
    })
  }

  const close = () => {
    const count = terminal.all().length
    void terminal.close(props.terminal.id)
    if (count === 1) {
      props.onClose?.()
    }
  }

  const focus = () => {
    if (store.editing) return
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    focusTerminalById(props.terminal.id)
  }

  const edit = (e?: Event) => {
    if (e) {
      e.stopPropagation()
      e.preventDefault()
    }

    setStore("blurEnabled", false)
    setStore("title", props.terminal.title)
    setStore("editing", true)
  }

  const save = () => {
    if (!store.blurEnabled) return

    const value = store.title.trim()
    if (value && value !== props.terminal.title) {
      terminal.update({ id: props.terminal.id, title: value, shellOwnsTitle: false })
    }
    setStore("editing", false)
  }

  const keydown = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault()
      save()
      return
    }
    if (e.key === "Escape") {
      e.preventDefault()
      setStore("editing", false)
    }
  }

  const menu = (e: MouseEvent) => {
    e.preventDefault()
    setStore("menuPosition", { x: e.clientX, y: e.clientY })
    setStore("menuOpen", true)
  }

  createEffect(() => {
    if (!store.editing) return
    if (!input) return
    input.focus()
    input.select()
    if (blurFrame !== undefined) cancelAnimationFrame(blurFrame)
    blurFrame = requestAnimationFrame(() => {
      blurFrame = undefined
      setStore("blurEnabled", true)
    })
  })

  onCleanup(() => {
    if (blurFrame === undefined) return
    cancelAnimationFrame(blurFrame)
  })

  return (
    <div class="relative h-full">
      <div
        use:sortable
        class="group/tab outline-none focus:outline-none focus-visible:outline-none"
        classList={{
          "h-full": true,
          "opacity-0": sortable.isActiveDraggable || store.editing,
          "pointer-events-none": store.editing,
        }}
      >
        <Tabs.Trigger
          value={props.terminal.id}
          onClick={focus}
          onMouseDown={(e) => e.preventDefault()}
          onContextMenu={menu}
          onMiddleClick={close}
          class="!shadow-none"
          hideCloseButton
          closeButton={
            <Tooltip value={language.t("common.closeTab")} placement="bottom" gutter={10}>
              <IconButton
                icon="close-small"
                variant="ghost"
                class="review-tab-close p-0"
                onClick={(e) => {
                  e.stopPropagation()
                  close()
                }}
                aria-label={language.t("common.closeTab")}
              />
            </Tooltip>
          }
          classes={{
            button:
              "border-0 outline-none focus:outline-none focus-visible:outline-none !shadow-none !ring-0",
          }}
        >
          <Icon name="terminal" class="size-4 shrink-0 text-icon-weak" aria-hidden />
          <span
            class="min-w-0 truncate text-14-medium"
            classList={{ invisible: store.editing }}
            onDblClick={edit}
          >
            {label()}
          </span>
        </Tabs.Trigger>
      </div>
      <Show when={store.editing}>
        <div
          class="absolute inset-y-[6px] left-[14px] right-[42px] -translate-y-px z-10 flex items-center gap-[10px] pointer-events-auto"
          onPointerDown={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          onMouseUp={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          onDblClick={(e) => e.stopPropagation()}
          onTouchStart={(e) => e.stopPropagation()}
        >
          <Icon name="terminal" class="size-4 shrink-0 text-icon-weak" aria-hidden />
          <InlineInput
            ref={(el) => {
              input = el
            }}
            type="text"
            value={store.title}
            onInput={(e) => setStore("title", e.currentTarget.value)}
            onBlur={save}
            onKeyDown={keydown}
            onPointerDown={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            onMouseUp={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            onDblClick={(e) => e.stopPropagation()}
            onTouchStart={(e) => e.stopPropagation()}
            class="min-w-0 flex-1 appearance-none bg-transparent text-14-medium text-text-strong"
            style={{ "--inline-input-shadow": "none" }}
          />
        </div>
      </Show>
      <DropdownMenu open={store.menuOpen} onOpenChange={(open) => setStore("menuOpen", open)}>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            class="fixed"
            style={{
              left: `${store.menuPosition.x}px`,
              top: `${store.menuPosition.y}px`,
            }}
            onCloseAutoFocus={(e) => {
              if (!editRequested) return
              e.preventDefault()
              editRequested = false
              requestAnimationFrame(() => edit())
            }}
          >
            <Show when={props.active}>
              <DropdownMenu.Item onSelect={() => (editRequested = true)}>
                <Icon name="edit" class="w-4 h-4 mr-2" />
                {language.t("common.rename")}
              </DropdownMenu.Item>
            </Show>
            <DropdownMenu.Item onSelect={close}>
              <Icon name="close" class="w-4 h-4 mr-2" />
              {language.t("common.close")}
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu>
    </div>
  )
}
