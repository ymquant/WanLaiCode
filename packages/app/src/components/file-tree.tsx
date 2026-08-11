import { useFile } from "@/context/file"
import { encodeFilePath } from "@/context/file/path"
import { useLanguage } from "@/context/language"
import { REVEAL_IN_FOLDER_OPENER_ID } from "@/utils/path-openers"
import { AppIcon } from "@opencode-ai/ui/app-icon"
import { FileIcon } from "@opencode-ai/ui/file-icon"
import { Icon } from "@opencode-ai/ui/icon"
import { ContextMenu } from "@opencode-ai/ui/context-menu"
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  on,
  onCleanup,
  Show,
  splitProps,
  Switch,
  untrack,
  type ComponentProps,
  type JSX,
  type ParentProps,
} from "solid-js"
import { Dynamic } from "solid-js/web"
import type { FileNode } from "@opencode-ai/sdk/v2"

const MAX_DEPTH = 128

function pathToFileUrl(filepath: string): string {
  return `file://${encodeFilePath(filepath)}`
}

type Kind = "add" | "del" | "mix"

export type Filter = {
  files: Set<string>
  dirs: Set<string>
}

export function shouldListRoot(input: { level: number; dir?: { loaded?: boolean; loading?: boolean } }) {
  if (input.level !== 0) return false
  if (input.dir?.loaded) return false
  if (input.dir?.loading) return false
  return true
}

export function shouldListExpanded(input: {
  level: number
  dir?: { expanded?: boolean; loaded?: boolean; loading?: boolean }
}) {
  if (input.level === 0) return false
  if (!input.dir?.expanded) return false
  if (input.dir.loaded) return false
  if (input.dir.loading) return false
  return true
}

export function dirsToExpand(input: {
  level: number
  filter?: { dirs: Set<string> }
  expanded: (dir: string) => boolean
}) {
  if (input.level !== 0) return []
  if (!input.filter) return []
  return [...input.filter.dirs].filter((dir) => !input.expanded(dir))
}

const kindLabel = (kind: Kind) => {
  if (kind === "add") return "A"
  if (kind === "del") return "D"
  return "M"
}

const kindTextColor = (kind: Kind) => {
  if (kind === "add") return "color: var(--icon-diff-add-base)"
  if (kind === "del") return "color: var(--icon-diff-delete-base)"
  return "color: var(--icon-diff-modified-base)"
}

const kindDotColor = (kind: Kind) => {
  if (kind === "add") return "background-color: var(--icon-diff-add-base)"
  if (kind === "del") return "background-color: var(--icon-diff-delete-base)"
  return "background-color: var(--icon-diff-modified-base)"
}

const visibleKind = (node: FileNode, kinds?: ReadonlyMap<string, Kind>, marks?: Set<string>) => {
  const kind = kinds?.get(node.path)
  if (!kind) return
  if (!marks?.has(node.path)) return
  return kind
}

const FOLDER_ICON_SVG = `<svg class="size-4 shrink-0" fill="none" viewBox="0 0 20 20" preserveAspectRatio="xMidYMid meet" aria-hidden="true"><path d="M2.08301 2.91675V16.2501H17.9163V5.41675H9.99967L8.33301 2.91675H2.08301Z" stroke="currentColor" stroke-linecap="round"/></svg>`

const buildDragImage = (target: HTMLElement, node: FileNode) => {
  const fileIcon = target.querySelector('[data-component="file-icon"]')
  const text = target.querySelector("span")
  if (!text) return

  const image = document.createElement("div")
  image.className =
    "flex items-center gap-x-2 px-2 py-1 bg-surface-raised-base rounded-md border border-border-base text-12-regular text-text-strong"
  image.style.position = "absolute"
  image.style.top = "-1000px"

  if (fileIcon) {
    image.appendChild(fileIcon.cloneNode(true))
  } else if (node.type === "directory") {
    const wrapper = document.createElement("div")
    wrapper.innerHTML = FOLDER_ICON_SVG
    const svg = wrapper.firstElementChild
    if (svg) image.appendChild(svg)
  } else {
    const svg = target.querySelector("svg")
    if (svg) image.appendChild(svg.cloneNode(true))
  }

  const label = document.createElement("span")
  label.className = "text-text-strong"
  label.textContent = text.textContent ?? ""
  image.appendChild(label)
  return image
}

const withFileDragImage = (event: DragEvent, node: FileNode) => {
  const image = buildDragImage(event.currentTarget as HTMLElement, node)
  if (!image) return
  document.body.appendChild(image)
  event.dataTransfer?.setDragImage(image, 0, 12)
  setTimeout(() => document.body.removeChild(image), 0)
}

const FileTreeNode = (
  p: ParentProps &
    ComponentProps<"div"> &
    ComponentProps<"button"> & {
      node: FileNode
      level: number
      active?: string
      nodeClass?: string
      draggable: boolean
      variant?: "default" | "review"
      kinds?: ReadonlyMap<string, Kind>
      marks?: Set<string>
      as?: "div" | "button"
    },
) => {
  const [local, rest] = splitProps(p, [
    "node",
    "level",
    "active",
    "nodeClass",
    "draggable",
    "variant",
    "kinds",
    "marks",
    "as",
    "children",
    "class",
    "classList",
  ])
  const kind = () => visibleKind(local.node, local.kinds, local.marks)
  const review = () => local.variant === "review"
  const active = () => review() ? local.node.path === local.active : !!kind() && !local.node.ignored
  const showKind = () => (review() ? undefined : kind())
  const color = () => {
    const value = showKind()
    if (!value) return
    return kindTextColor(value)
  }

  return (
    <Dynamic
      component={local.as ?? "div"}
      classList={{
        "w-full min-w-0 flex items-center justify-start text-left transition-colors cursor-pointer select-auto": true,
        "h-6 gap-x-1.5 rounded-md px-1.5 py-0 hover:bg-surface-raised-base-hover active:bg-surface-base-active":
          !review(),
        "h-8 gap-x-2 rounded-md px-1.5 py-0 hover:bg-surface-raised-base-hover active:bg-surface-base-active":
          review(),
        "bg-surface-base-active": local.node.path === local.active,
        ...local.classList,
        [local.class ?? ""]: !!local.class,
        [local.nodeClass ?? ""]: !!local.nodeClass,
      }}
      style={`padding-left: ${
        review()
          ? Math.max(0, 8 + local.level * 14 - (local.node.type === "file" ? 24 : 4))
          : Math.max(0, 8 + local.level * 12 - (local.node.type === "file" ? 24 : 4))
      }px`}
      role={local.as === "button" ? undefined : "button"}
      tabIndex={local.as === "button" ? undefined : 0}
      onKeyDown={(event: KeyboardEvent) => {
        if (local.as === "button") return
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault()
          ;(event.currentTarget as HTMLElement).click()
        }
      }}
      draggable={local.draggable}
      onDragStart={(event: DragEvent) => {
        if (!local.draggable) return
        event.dataTransfer?.setData("text/plain", `file:${local.node.path}`)
        event.dataTransfer?.setData("text/uri-list", pathToFileUrl(local.node.path))
        if (event.dataTransfer) event.dataTransfer.effectAllowed = "copy"
        withFileDragImage(event, local.node)
      }}
      {...rest}
    >
      {local.children}
      <span
        classList={{
          "flex-1 min-w-0 whitespace-nowrap truncate": true,
          "text-12-medium": !review(),
          "text-14-regular": review(),
          "text-text-weak": local.node.ignored,
          "text-text-strong": !local.node.ignored,
        }}
        style={!review() && active() ? color() : undefined}
      >
        {local.node.name}
      </span>
      {(() => {
        const value = showKind()
        if (!value) return null
        if (local.node.type === "file") {
          return (
            <span class="shrink-0 w-4 text-center text-12-medium" style={kindTextColor(value)}>
              {kindLabel(value)}
            </span>
          )
        }
        return <div class="shrink-0 size-1.5 mr-1.5 rounded-full" style={kindDotColor(value)} />
      })()}
    </Dynamic>
  )
}

export function FileContextMenu(props: ParentProps<{
  node: FileNode
  onFileClick?: (file: FileNode) => void
  actions: FileContextMenuActions
  triggerClass?: string
}>) {
  const language = useLanguage()
  const openerItems = createMemo(() => props.actions.openerItems?.(props.node.path) ?? [])
  const revealInFinderItem = createMemo(() => openerItems().find((item) => item.id === REVEAL_IN_FOLDER_OPENER_ID))
  const openWithItems = createMemo(() => openerItems().filter((item) => item.id !== REVEAL_IN_FOLDER_OPENER_ID))
  const [openWithExpanded, setOpenWithExpanded] = createSignal(false)
  const [openWithSide, setOpenWithSide] = createSignal<"left" | "right">("left")
  let openWithTriggerRef: HTMLDivElement | undefined
  let openWithFlyoutRef: HTMLDivElement | undefined
  const updateOpenWithSide = () => {
    const rect = openWithTriggerRef?.getBoundingClientRect()
    if (!rect) return
    const width = openWithFlyoutRef?.getBoundingClientRect().width ?? 240
    const canOpenLeft = rect.left >= width
    const canOpenRight = window.innerWidth - rect.right >= width
    setOpenWithSide(canOpenLeft || !canOpenRight ? "left" : "right")
  }
  createEffect(() => {
    if (!openWithExpanded()) return
    updateOpenWithSide()
  })

  return (
    <ContextMenu>
      <ContextMenu.Trigger as="div" class={props.triggerClass}>{props.children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content class="codex-chat-menu" style="overflow:visible">
          <ContextMenu.Item onSelect={() => (revealInFinderItem() ? revealInFinderItem()!.onSelect() : props.actions.onRevealInFinder?.(props.node.path))}>
            {revealInFinderItem()?.icon.type === "app" && revealInFinderItem()?.icon.id
              ? <AppIcon id={revealInFinderItem()!.icon.id as any} alt="" class="size-4" />
              : props.actions.revealInFinderIcon?.() ?? <Icon name="open-file" size="small" />}
            <span>{revealInFinderItem()?.label ?? props.actions.revealInFinderLabel?.() ?? language.t("command.file.revealInFinder", { name: "" })}</span>
          </ContextMenu.Item>
          <Show when={openWithItems().length > 0}>
            <div
              class="relative"
              onMouseEnter={() => {
                setOpenWithExpanded(true)
                updateOpenWithSide()
              }}
              onMouseLeave={() => setOpenWithExpanded(false)}
            >
              <div ref={openWithTriggerRef} data-slot="context-menu-sub-trigger" data-expanded={openWithExpanded() ? "" : undefined}>
                <span class="size-4" />
                <span>{language.t("session.files.openWith")}</span>
                <span class="flex-1" />
                <Icon name="chevron-right" size="small" />
              </div>
              <Show when={openWithExpanded()}>
                <div
                  ref={openWithFlyoutRef}
                  data-component="context-menu-sub-content"
                  data-slot="context-menu-flyout-content"
                  data-side={openWithSide()}
                  class="codex-chat-menu"
                >
                  <For each={openWithItems()}>
                    {(item) => (
                      <ContextMenu.Item onSelect={() => item.onSelect()}>
                        <Switch>
                          <Match when={item.icon.type === "app"}>
                            <AppIcon id={item.icon.id as any} alt="" class="size-4" />
                          </Match>
                          <Match when={item.icon.type === "image"}>
                            <img src={item.icon.src} alt="" class="size-4" />
                          </Match>
                          <Match when={item.icon.type === "icon"}>
                            <Icon name={item.icon.name as any} size="small" />
                          </Match>
                        </Switch>
                        <span>{item.label}</span>
                      </ContextMenu.Item>
                    )}
                  </For>
                </div>
              </Show>
            </div>
          </Show>
          <ContextMenu.Separator />
          <Show when={props.actions.onCreateFile || props.actions.onCreateFolder}>
            <ContextMenu.Item onSelect={() => props.actions.onCreateFile?.(props.node.path, props.node.type === "directory")}>
              <span class="size-4" />
              <span>{language.t("session.files.newFile")}</span>
            </ContextMenu.Item>
            <ContextMenu.Item onSelect={() => props.actions.onCreateFolder?.(props.node.path, props.node.type === "directory")}>
              <span class="size-4" />
              <span>{language.t("session.files.newFolder")}</span>
            </ContextMenu.Item>
            <Show when={props.actions.onRename && props.node.path !== ""}>
              <ContextMenu.Item onSelect={() => props.actions.onRename?.(props.node.path)}>
                <span class="size-4" />
                <span>{language.t("common.rename")}</span>
              </ContextMenu.Item>
            </Show>
            <ContextMenu.Separator />
          </Show>
          <ContextMenu.Item onSelect={() => props.actions.onCopyPath?.(props.node.path)}>
            <span class="size-4" />
            <span>{language.t("session.files.copyPath")}</span>
          </ContextMenu.Item>
          <ContextMenu.Item onSelect={() => props.actions.onAddToChat?.(props.node.path)}>
            <span class="size-4" />
            <span>{language.t("session.addToChat.button")}</span>
          </ContextMenu.Item>
          <Show when={props.actions.onDelete && props.node.path !== ""}>
            <ContextMenu.Separator />
            <ContextMenu.Item onSelect={() => props.actions.onDelete?.(props.node.path)}>
              <span class="size-4" />
              <span>{language.t("common.delete")}</span>
            </ContextMenu.Item>
          </Show>
          <Show when={props.actions.onRefresh && props.node.path === ""}>
            <ContextMenu.Separator />
            <ContextMenu.Item onSelect={() => props.actions.onRefresh?.()}>
              <span class="size-4" />
              <span>{language.t("plugins.menu.refresh")}</span>
            </ContextMenu.Item>
          </Show>
          <Show when={props.actions.onClose}>
            <ContextMenu.Separator />
            <ContextMenu.Item onSelect={() => props.actions.onClose?.(props.node.path)}>
              <span class="size-4" />
              <span>{language.t("common.closeTab")}</span>
            </ContextMenu.Item>
          </Show>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu>
  )
}

export type FileContextMenuActions = {
  onRevealInFinder?: (path: string) => void
  revealInFinderLabel?: () => string
  revealInFinderIcon?: () => JSX.Element
  onClose?: (path: string) => void
  onCopyPath?: (path: string) => void
  onAddToChat?: (path: string) => void
  onCreateFile?: (path: string, isDirectory: boolean) => void
  onCreateFolder?: (path: string, isDirectory: boolean) => void
  onRefresh?: () => void
  onRename?: (path: string) => void
  onDelete?: (path: string) => void
  openerItems?: (path: string) => Array<{
    id: string
    label: string
    icon: { type: string; id?: string; src?: string; name?: string }
    onSelect: () => void | Promise<void> | undefined
  }>
}

export default function FileTree(props: {
  path: string
  class?: string
  nodeClass?: string
  active?: string
  variant?: "default" | "review"
  level?: number
  allowed?: readonly string[]
  modified?: readonly string[]
  kinds?: ReadonlyMap<string, Kind>
  draggable?: boolean
  onFileClick?: (file: FileNode) => void
  onFileDoubleClick?: (file: FileNode) => void
  fileContextMenu?: FileContextMenuActions
  tree?: {
    state: (path: string) => { expanded?: boolean; loaded?: boolean; loading?: boolean; error?: string } | undefined
    children: (path: string) => FileNode[]
    expand: (path: string) => void
    collapse: (path: string) => void
    isUserCollapsed: (path: string) => boolean
    list: (path: string) => Promise<void> | void
  }

  _filter?: Filter
  _marks?: Set<string>
  _deeps?: Map<string, number>
  _kinds?: ReadonlyMap<string, Kind>
  _chain?: readonly string[]
}) {
  const file = useFile()
  const tree = () => props.tree ?? file.tree
  const level = props.level ?? 0
  const draggable = () => props.draggable ?? true

  const [pendingClick, setPendingClick] = createSignal<ReturnType<typeof setTimeout> | null>(null)

  const handleFileClick = (node: FileNode) => {
    const existing = pendingClick()
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      setPendingClick(null)
      props.onFileClick?.(node)
    }, 250)
    setPendingClick(timer)
  }

  const handleFileDoubleClick = (node: FileNode) => {
    const existing = pendingClick()
    if (existing) clearTimeout(existing)
    setPendingClick(null)
    props.onFileDoubleClick?.(node)
  }

  onCleanup(() => {
    const timer = pendingClick()
    if (timer) clearTimeout(timer)
  })

  const key = (p: string) =>
    file
      .normalize(p)
      .replace(/[\\/]+$/, "")
      .replaceAll("\\", "/")
  const chain = props._chain ? [...props._chain, key(props.path)] : [key(props.path)]

  const filter = createMemo(() => {
    if (props._filter) return props._filter

    const allowed = props.allowed
    if (!allowed) return

    const files = new Set(allowed)
    const dirs = new Set<string>()

    for (const item of allowed) {
      const parts = item.split("/")
      const parents = parts.slice(0, -1)
      for (const [idx] of parents.entries()) {
        const dir = parents.slice(0, idx + 1).join("/")
        if (dir) dirs.add(dir)
      }
    }

    return { files, dirs }
  })

  const marks = createMemo(() => {
    if (props._marks) return props._marks

    const out = new Set<string>()
    for (const item of props.modified ?? []) out.add(item)
    for (const item of props.kinds?.keys() ?? []) out.add(item)
    if (out.size === 0) return
    return out
  })

  const kinds = createMemo(() => {
    if (props._kinds) return props._kinds
    return props.kinds
  })

  const deeps = createMemo(() => {
    if (props._deeps) return props._deeps

    const out = new Map<string, number>()

    const root = props.path
    if (!(tree().state(root)?.expanded ?? false)) return out

    const seen = new Set<string>()
    const stack: { dir: string; lvl: number; i: number; kids: string[]; max: number }[] = []

    const push = (dir: string, lvl: number) => {
      const id = key(dir)
      if (seen.has(id)) return
      seen.add(id)

      const kids = tree()
        .children(dir)
        .filter((node) => node.type === "directory" && (tree().state(node.path)?.expanded ?? false))
        .map((node) => node.path)

      stack.push({ dir, lvl, i: 0, kids, max: lvl })
    }

    push(root, level - 1)

    while (stack.length > 0) {
      const top = stack[stack.length - 1]!

      if (top.i < top.kids.length) {
        const next = top.kids[top.i]!
        top.i++
        push(next, top.lvl + 1)
        continue
      }

      out.set(top.dir, top.max)
      stack.pop()

      const parent = stack[stack.length - 1]
      if (!parent) continue
      parent.max = Math.max(parent.max, top.max)
    }

    return out
  })

  createEffect(() => {
    const current = filter()
    const dirs = dirsToExpand({
      level,
      filter: current,
      expanded: (dir) => untrack(() => tree().state(dir)?.expanded) ?? false,
    })
    for (const dir of dirs) {
      if (tree().isUserCollapsed(dir)) continue
      tree().expand(dir)
    }
  })

  createEffect(
    on(
      () => props.path,
      (path) => {
        const dir = untrack(() => tree().state(path))
        if (!shouldListRoot({ level, dir })) return
        void tree().list(path)
      },
      { defer: false },
    ),
  )

  const nodes = createMemo(() => {
    const nodes = tree().children(props.path)
    const current = filter()
    if (!current) return nodes

    const parent = (path: string) => {
      const idx = path.lastIndexOf("/")
      if (idx === -1) return ""
      return path.slice(0, idx)
    }

    const leaf = (path: string) => {
      const idx = path.lastIndexOf("/")
      return idx === -1 ? path : path.slice(idx + 1)
    }

    const out = nodes.filter((node) => {
      if (node.type === "file") return current.files.has(node.path)
      return current.dirs.has(node.path)
    })

    const seen = new Set(out.map((node) => node.path))

    for (const dir of current.dirs) {
      if (parent(dir) !== props.path) continue
      if (seen.has(dir)) continue
      out.push({
        name: leaf(dir),
        path: dir,
        absolute: dir,
        type: "directory",
        ignored: false,
      })
      seen.add(dir)
    }

    for (const item of current.files) {
      if (parent(item) !== props.path) continue
      if (seen.has(item)) continue
      out.push({
        name: leaf(item),
        path: item,
        absolute: item,
        type: "file",
        ignored: false,
      })
      seen.add(item)
    }

    out.sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === "directory" ? -1 : 1
      }
      return a.name.localeCompare(b.name)
    })

    return out
  })

  return (
    <div data-component="filetree" class={`flex flex-col gap-0.5 ${props.class ?? ""}`}>
      <For each={nodes()}>
        {(node) => {
          const expanded = () => tree().state(node.path)?.expanded ?? false
          const directoryError = () => tree().state(node.path)?.error
          const deep = () => deeps().get(node.path) ?? -1

          const Branch = () => (
            <Switch>
              <Match when={node.type === "directory"}>
                <div data-component="collapsible" data-variant="ghost" data-scope="filetree" class="w-full">
                  <FileTreeNode
                    node={node}
                    level={level}
                    active={props.active}
                    variant={props.variant}
                    nodeClass={props.nodeClass}
                    draggable={draggable()}
                    kinds={kinds()}
                    marks={marks()}
                    onClick={() => expanded() ? tree().collapse(node.path) : tree().expand(node.path)}
                  >
                    <div
                      classList={{
                        "size-4 flex items-center justify-center text-text-base": true,
                        "ml-0.5": props.variant === "review",
                      }}
                    >
                      <Icon name={expanded() ? "chevron-down" : "chevron-right"} size="small" />
                    </div>
                  </FileTreeNode>
                  <Show when={expanded()}>
                    <div class="relative pt-0.5">
                      <div
                        classList={{
                          "absolute top-0 bottom-0 w-px pointer-events-none opacity-0 transition-opacity duration-150 ease-out motion-reduce:transition-none": true,
                          "bg-border-weak-base": props.variant !== "review",
                          "bg-border-weaker-base": props.variant === "review",
                          "group-hover/filetree:opacity-100": expanded() && deep() === level,
                          "group-hover/filetree:opacity-50": !(expanded() && deep() === level),
                        }}
                        style={`left: ${
                          props.variant === "review"
                            ? Math.max(0, 8 + level * 14 - 4) + 8
                            : Math.max(0, 8 + level * 12 - 4) + 8
                        }px`}
                      />
                      <Show when={directoryError()}>
                        <div
                          class="flex items-center gap-1.5 py-1"
                          style={`padding-left: ${
                            props.variant === "review"
                              ? Math.max(0, 8 + (level + 1) * 14 - 4)
                              : Math.max(0, 8 + (level + 1) * 12 - 4)
                          }px`}
                        >
                          <Icon name="warning" size="small" class="shrink-0 text-icon-weak" />
                          <span class="text-12-regular text-text-weak truncate">{directoryError()}</span>
                        </div>
                      </Show>
                      <Show
                        when={level < MAX_DEPTH && !chain.includes(key(node.path))}
                        fallback={<div class="px-2 py-1 text-12-regular text-text-weak">...</div>}
                      >
                        <FileTree
                          path={node.path}
                          level={level + 1}
                          allowed={props.allowed}
                          modified={props.modified}
                          kinds={props.kinds}
                          active={props.active}
                          variant={props.variant}
                          draggable={props.draggable}
                          onFileClick={props.onFileClick}
                          onFileDoubleClick={props.onFileDoubleClick}
                          fileContextMenu={props.fileContextMenu}
                          tree={props.tree}
                          _filter={filter()}
                          _marks={marks()}
                          _deeps={deeps()}
                          _kinds={kinds()}
                          _chain={chain}
                        />
                      </Show>
                    </div>
                  </Show>
                </div>
              </Match>
              <Match when={node.type === "file"}>
                <FileTreeNode
                  node={node}
                  level={level}
                  active={props.active}
                  variant={props.variant}
                  nodeClass={props.nodeClass}
                  draggable={draggable()}
                  kinds={kinds()}
                  marks={marks()}
                  as="div"
                  onClick={() => handleFileClick(node)}
                  onDblClick={() => handleFileDoubleClick(node)}
                >
                  <div classList={{ "w-4 shrink-0": true, "ml-0.5": props.variant === "review" }} />
                  <Switch>
                    <Match when={node.ignored}>
                      <FileIcon
                        node={node}
                        class="size-4 filetree-icon filetree-icon--mono"
                        style="color: var(--icon-weak-base)"
                        mono
                      />
                    </Match>
                    <Match when={!node.ignored}>
                      <FileIcon node={node} class="size-4 shrink-0 filetree-icon filetree-icon--color" />
                    </Match>
                  </Switch>
                </FileTreeNode>
              </Match>
            </Switch>
          )

          return (
            <Show
              when={props.fileContextMenu}
              fallback={<Branch />}
            >
              <FileContextMenu node={node} onFileClick={props.onFileClick} actions={props.fileContextMenu!}>
                <Branch />
              </FileContextMenu>
            </Show>
          )
        }}
      </For>
    </div>
  )
}
