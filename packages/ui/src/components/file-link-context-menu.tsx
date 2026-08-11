import { For, Show, createMemo, createSignal } from "solid-js"
import { DropdownMenu } from "./dropdown-menu"
import { AppIcon, type AppIconProps } from "./app-icon"
import { Icon } from "./icon"
import type { IconProps } from "./icon"
import { useI18n } from "../context/i18n"
import "./file-link-context-menu.css"

type FileContextMenuOpenerItem = {
  id: string
  label: string
  icon: { type: string; id?: string; src?: string; name?: string }
  onSelect: () => void | Promise<void> | undefined
}

export type FileContextMenuActions = {
  openInVSCode?: (absPath: string) => void
  openInBrowser?: (absPath: string) => void
  openWithDefault?: (absPath: string) => void
  openInTerminal?: (absPath: string) => void
  openInGitBash?: (absPath: string) => void
  copyPath?: (absPath: string) => void
  copyFileContent?: (absPath: string) => void
  revealInFolder?: (absPath: string) => void
  openFileExplorer?: (absPath: string) => void
  openerItems?: (absPath: string) => FileContextMenuOpenerItem[]
}

function IconSpacer(props: { width?: number; height?: number }) {
  const w = `${props.width ?? 22}px`
  const h = `${props.height ?? 22}px`
  return <span style={{ width: w, height: h }} class="shrink-0" aria-hidden="true" />
}

function IconCell(props: { children: any }) {
  return <span class="size-[22px] shrink-0 flex items-center justify-center" aria-hidden="true">{props.children}</span>
}

function OpenerIcon(props: { item: FileContextMenuOpenerItem; fallback?: "vscode" | "file-explorer" }) {
  if (props.item.icon.type === "image" && props.item.icon.src) {
    return <img src={props.item.icon.src} alt="" class="w-[22px] h-[22px]" />
  }
  if (props.item.icon.type === "app" && props.item.icon.id) {
    return <AppIcon id={props.item.icon.id as AppIconProps["id"]} alt="" class="w-[22px] h-[22px]" />
  }
  return (
    <Icon
      name={(props.item.icon.type === "icon" && props.item.icon.name ? props.item.icon.name : "open-file") as IconProps["name"]}
      size="small"
    />
  )
}

export function primaryFileContextOpener(actions: FileContextMenuActions, absolutePath: string) {
  const openWithItems = actions.openerItems?.(absolutePath)?.filter((item) => item.id !== "reveal-in-folder") ?? []
  return openWithItems[0]
}

export function FileLinkContextMenu(props: {
  absolutePath: string
  position: { x: number; y: number }
  open: boolean
  onOpenChange: (open: boolean) => void
  actions: FileContextMenuActions
}) {
  const i18n = useI18n()
  const abs = () => props.absolutePath
  const isHtml = () => /\.html?$/i.test(props.absolutePath)
  const openerItems = createMemo(() => props.actions.openerItems?.(abs()) ?? [])
  const revealItem = createMemo(() => openerItems().find((item) => item.id === "reveal-in-folder"))
  const openWithItems = createMemo(() => openerItems().filter((item) => item.id !== "reveal-in-folder"))
  const primaryOpener = createMemo(() => primaryFileContextOpener(props.actions, abs()))
  const [subTriggerWidth, setSubTriggerWidth] = createSignal(80)

  return (
    <DropdownMenu open={props.open} onOpenChange={props.onOpenChange}>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          class="fixed file-link-context-menu"
          style={{
            left: `${props.position.x}px`,
            top: `${props.position.y}px`,
          }}
        >
          <Show
            when={isHtml()}
            fallback={
              <DropdownMenu.Item
                onSelect={() => (primaryOpener() ? primaryOpener()!.onSelect() : props.actions.openInVSCode?.(abs()))}
              >
                <IconCell>
                  <Show when={primaryOpener()} fallback={<AppIcon id="vscode" alt="" class="w-[22px] h-[22px]" />}>
                    {(item) => <OpenerIcon item={item()} fallback="vscode" />}
                  </Show>
                </IconCell>
                {primaryOpener()
                  ? i18n.t("ui.fileContextMenu.openInApp", { app: primaryOpener()!.label })
                  : i18n.t("ui.fileContextMenu.openInVSCode")}
              </DropdownMenu.Item>
            }
          >
            <DropdownMenu.Item
              onSelect={() => props.actions.openInBrowser?.(abs())}
            >
              <IconSpacer width={12} />
              {i18n.t("ui.fileContextMenu.openInBrowser")}
            </DropdownMenu.Item>
          </Show>

          <DropdownMenu.Sub>
            <DropdownMenu.SubTrigger
              ref={(el: HTMLElement) => {
                setSubTriggerWidth(el.offsetWidth)
              }}
            >
              <IconSpacer width={isHtml() ? 12 : 22} />
              {i18n.t("ui.fileContextMenu.openWith")}
              <Icon name="chevron-right" size="small" class="ml-auto" />
            </DropdownMenu.SubTrigger>
            <DropdownMenu.Portal>
              <DropdownMenu.SubContent class="file-link-context-menu-sub" gutter={-(subTriggerWidth() + (isHtml() ? 10 : 0))}>
                <Show
                  when={openWithItems().length > 0}
                  fallback={
                    <Show when={!isHtml()}>
                      <DropdownMenu.Item
                        onSelect={() => props.actions.openInVSCode?.(abs())}
                      >
                        <IconCell><AppIcon id="vscode" alt="" class="w-[22px] h-[22px]" /></IconCell>
                        {i18n.t("ui.fileContextMenu.openWith.vscode")}
                      </DropdownMenu.Item>
                    </Show>
                  }
                >
                  <For each={openWithItems()}>
                    {(item) => (
                      <DropdownMenu.Item onSelect={() => item.onSelect()}>
                        <IconCell><OpenerIcon item={item} fallback="vscode" /></IconCell>
                        {item.label}
                      </DropdownMenu.Item>
                    )}
                  </For>
                </Show>
                <DropdownMenu.Item
                  onSelect={() => props.actions.openWithDefault?.(abs())}
                >
                  <IconSpacer />
                  {i18n.t("ui.fileContextMenu.openWith.defaultApp")}
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  onSelect={() => props.actions.openFileExplorer?.(abs())}
                >
                  <IconCell><AppIcon id="file-explorer" alt="" class="w-[22px] h-[22px]" /></IconCell>
                  {i18n.t("ui.fileContextMenu.fileExplorer")}
                </DropdownMenu.Item>
                <Show when={!isHtml()}>
                  <DropdownMenu.Item
                    onSelect={() => props.actions.openInTerminal?.(abs())}
                  >
                    <IconSpacer />
                    {i18n.t("ui.fileContextMenu.openWith.terminal")}
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    onSelect={() => props.actions.openInGitBash?.(abs())}
                  >
                    <IconCell><AppIcon id="git-bash" alt="" class="w-[18px] h-[18px]" /></IconCell>
                    Git Bash
                  </DropdownMenu.Item>
                </Show>
              </DropdownMenu.SubContent>
            </DropdownMenu.Portal>
          </DropdownMenu.Sub>

          <DropdownMenu.Separator />

          <DropdownMenu.Item
            onSelect={() => props.actions.copyPath?.(abs())}
          >
            <IconSpacer width={isHtml() ? 12 : 22} />
            {i18n.t("ui.fileContextMenu.copyPath")}
          </DropdownMenu.Item>
          <DropdownMenu.Item
            onSelect={() => props.actions.copyFileContent?.(abs())}
          >
            <IconSpacer width={isHtml() ? 12 : 22} />
            {i18n.t("ui.fileContextMenu.copyFileContent")}
          </DropdownMenu.Item>

          <DropdownMenu.Item
            onSelect={() => (revealItem() ? revealItem()!.onSelect() : props.actions.revealInFolder?.(abs()))}
          >
            <Show when={revealItem()} fallback={<IconSpacer width={isHtml() ? 12 : 22} />}>
              {(item) => <IconCell><OpenerIcon item={item()} fallback="file-explorer" /></IconCell>}
            </Show>
            {revealItem()?.label ?? i18n.t("ui.fileContextMenu.revealInFolder")}
          </DropdownMenu.Item>

        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu>
  )
}
