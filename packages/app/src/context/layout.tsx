import { createStore, produce, reconcile } from "solid-js/store"
import { batch, createEffect, createMemo, onCleanup, onMount, type Accessor } from "solid-js"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { makeEventListener } from "@solid-primitives/event-listener"
import { createMediaQuery } from "@solid-primitives/media"
import { useGlobalSync } from "./global-sync"
import { useGlobalSDK } from "./global-sdk"
import { useServer } from "./server"
import { usePlatform } from "./platform"
import { Project } from "@opencode-ai/sdk/v2"
import { Persist, persisted, removePersisted } from "@/utils/persist"
import { decode64 } from "@/utils/base64"
import { same } from "@/utils/same"
import { createScrollPersistence, type SessionScroll } from "./layout-scroll"
import { createPathHelpers } from "./file/path"
import { pathKey } from "@/utils/path-key"
import { isScratchSessionPath } from "@/utils/scratch"

const AVATAR_COLOR_KEYS = ["pink", "mint", "orange", "purple", "cyan", "lime"] as const
const DEFAULT_SIDEBAR_WIDTH = 344
/** Tailwind `lg` — docked sidebar vs mobile overlay (`layout.tsx` sidebar-nav-*). */
const WIDE_SIDEBAR_MEDIA = "(min-width: 1024px)"
const DEFAULT_FILE_TREE_WIDTH = 200
const DEFAULT_SESSION_WIDTH = 600
export const DEFAULT_REVIEW_PANEL_WIDTH = 315
const DEFAULT_TERMINAL_HEIGHT = 280
export type AvatarColorKey = (typeof AVATAR_COLOR_KEYS)[number]

export function getAvatarColors(key?: string) {
  if (key && AVATAR_COLOR_KEYS.includes(key as AvatarColorKey)) {
    return {
      background: `var(--avatar-background-${key})`,
      foreground: `var(--avatar-text-${key})`,
    }
  }
  return {
    background: "var(--surface-info-base)",
    foreground: "var(--text-base)",
  }
}

type SessionTabs = {
  active?: string
  all: string[]
  preview?: string
}

type SessionView = {
  scroll: Record<string, SessionScroll>
  reviewOpen?: string[]
  pendingMessage?: string
  pendingMessageAt?: number
}

type TabHandoff = {
  dir: string
  id: string
  at: number
}

export type LocalProject = Partial<Project> & { worktree: string; expanded: boolean }

export type ReviewDiffStyle = "unified" | "split"

export function resolveTreeExpanded(
  store: Record<string, boolean>,
  key: string,
  ctx: { isActiveProject: boolean; parentKey?: string },
): boolean {
  if (key in store) return store[key]
  if (ctx.parentKey && ctx.parentKey in store) return store[ctx.parentKey]
  return ctx.isActiveProject
}

export function resolvePinnedSort<T extends string>(items: T[], pinned: string[]): T[] {
  const itemSet = new Set<string>(items)
  const pinnedFiltered = pinned.filter((p) => itemSet.has(p)) as T[]
  const pinnedSet = new Set<string>(pinnedFiltered)
  const rest = items.filter((i) => !pinnedSet.has(i))
  return [...pinnedFiltered, ...rest]
}

/**
 * 会话级面板开关的取值规则：只认当前 sessionKey 自己的记录，未记录过一律视为关闭。
 * 不要回退到任何全局字段，否则会话 A 打开后会泄漏到会话 B。
 *
 * 用 `=== true` 而不是 `?? false`：这两个 map 的 store 默认值是 `{}`，空对象没有任何已知
 * key，persist 的 merge() 会把持久化里的每个 sessionKey 走「未知键」分支原样透传、不做类型
 * 校验。旧版本或手工写入的 `"false"` 这类字符串若原样返回，下游 truthy 判断会当成打开。
 */
export function resolveSessionPanelOpened(map: Record<string, boolean> | undefined, key: string) {
  return map?.[key] === true
}

export function ensureSessionKey(key: string, touch: (key: string) => void, seed: (key: string) => void) {
  touch(key)
  seed(key)
  return key
}

export function projectOpenRequestDirectory(event: unknown) {
  if (!event || typeof event !== "object") return
  const value = event as { type?: unknown; properties?: unknown }
  if (value.type !== "project.open.requested") return
  if (!value.properties || typeof value.properties !== "object") return
  const directory = (value.properties as { directory?: unknown }).directory
  if (typeof directory !== "string" || !directory.trim()) return
  return directory
}

export function createSessionKeyReader(sessionKey: string | Accessor<string>, ensure: (key: string) => void) {
  const key = typeof sessionKey === "function" ? sessionKey : () => sessionKey
  return () => {
    const value = key()
    ensure(value)
    return value
  }
}

export function pruneSessionKeys(input: {
  keep?: string
  max: number
  used: Map<string, number>
  view: string[]
  tabs: string[]
  // 会话级面板开关的 key：只开过面板、没滚动也没发消息的会话不会进 view/tabs，
  // 漏掉它就永远淘汰不到，持久化条目会突破 max 无上限增长
  panels?: string[]
}) {
  if (!input.keep) return []

  const keys = new Set<string>([...input.view, ...input.tabs, ...(input.panels ?? [])])
  if (keys.size <= input.max) return []

  const score = (key: string) => {
    if (key === input.keep) return Number.MAX_SAFE_INTEGER
    return input.used.get(key) ?? 0
  }

  return Array.from(keys)
    .sort((a, b) => score(b) - score(a))
    .slice(input.max)
}

function nextSessionTabsForOpen(
  current: SessionTabs | undefined,
  tab: string,
  opts?: { preview?: boolean },
): SessionTabs {
  const all = current?.all ?? []
  const preview = current?.preview && all.includes(current.preview) ? current.preview : undefined
  if (tab === "review") return { all: all.filter((x) => x !== "review"), active: tab }
  if (tab === "context") return { all: [tab, ...all.filter((x) => x !== tab)], active: tab }

  if (opts?.preview) {
    if (preview && all.includes(preview)) {
      const idx = all.indexOf(preview)
      const next = [...all]
      next[idx] = tab
      const seen = new Set<string>()
      return {
        all: next.flatMap((item) => {
          if (seen.has(item)) return []
          seen.add(item)
          return [item]
        }),
        active: tab,
        preview: tab,
      }
    }
    if (all.includes(tab)) return { all, active: tab, preview: tab }
    return { all: [...all, tab], active: tab, preview: tab }
  }

  if (opts?.preview === false) {
    const nextPreview = preview === tab ? undefined : preview
    if (!all.includes(tab)) return { all: [...all, tab], active: tab, preview: nextPreview }
    return { all, active: tab, preview: nextPreview }
  }

  if (!all.includes(tab)) return { all: [...all, tab], active: tab, preview }
  return { all, active: tab, preview }
}

const sessionPath = (key: string) => {
  const dir = key.split("/")[0]
  if (!dir) return
  const root = decode64(dir)
  if (!root) return
  return createPathHelpers(() => root)
}

const normalizeSessionTab = (path: ReturnType<typeof createPathHelpers> | undefined, tab: string) => {
  if (!tab.startsWith("file://")) return tab
  if (!path) return tab
  return path.tab(tab)
}

const normalizeSessionTabList = (path: ReturnType<typeof createPathHelpers> | undefined, all: string[]) => {
  const seen = new Set<string>()
  return all.flatMap((tab) => {
    const value = normalizeSessionTab(path, tab)
    if (seen.has(value)) return []
    seen.add(value)
    return [value]
  })
}

const normalizeStoredSessionTabs = (key: string, tabs: SessionTabs) => {
  const path = sessionPath(key)
  const all = normalizeSessionTabList(path, tabs.all).filter((tab) => !tab.startsWith("browser:"))
  const active = tabs.active ? normalizeSessionTab(path, tabs.active) : tabs.active
  return {
    all,
    active: active?.startsWith("browser:") ? all[0] : active,
  }
}

export const { use: useLayout, provider: LayoutProvider } = createSimpleContext({
  name: "Layout",
  init: () => {
    const globalSdk = useGlobalSDK()
    const globalSync = useGlobalSync()
    const server = useServer()
    const platform = usePlatform()

    const isRecord = (value: unknown): value is Record<string, unknown> =>
      typeof value === "object" && value !== null && !Array.isArray(value)

    const migrate = (value: unknown) => {
      if (!isRecord(value)) return value

      const sidebar = value.sidebar
      const migratedSidebar = (() => {
        if (!isRecord(sidebar)) return sidebar
        if (typeof sidebar.workspaces !== "boolean") return sidebar
        return {
          ...sidebar,
          workspaces: {},
          workspacesDefault: sidebar.workspaces,
        }
      })()

      const review = value.review
      const fileTree = value.fileTree
      const migratedFileTree = (() => {
        if (!isRecord(fileTree)) return fileTree
        if (fileTree.tab === "changes" || fileTree.tab === "all") return fileTree

        const width = typeof fileTree.width === "number" ? fileTree.width : DEFAULT_FILE_TREE_WIDTH
        return {
          ...fileTree,
          opened: false,
          width: width === 260 ? DEFAULT_FILE_TREE_WIDTH : width,
          tab: "changes",
        }
      })()

      const migratedReview = (() => {
        if (!isRecord(review)) return review
        if (typeof review.panelOpened === "boolean") return review

        const opened = isRecord(fileTree) && typeof fileTree.opened === "boolean" ? fileTree.opened : false
        return {
          ...review,
          panelOpened: opened,
        }
      })()

      const sessionTabs = value.sessionTabs
      const migratedSessionTabs = (() => {
        if (!isRecord(sessionTabs)) return sessionTabs

        let changed = false
        const next = Object.fromEntries(
          Object.entries(sessionTabs).map(([key, tabs]) => {
            if (!isRecord(tabs) || !Array.isArray(tabs.all)) return [key, tabs]

            const current = {
              all: tabs.all.filter((tab): tab is string => typeof tab === "string"),
              active: typeof tabs.active === "string" ? tabs.active : undefined,
            }
            const normalized = normalizeStoredSessionTabs(key, current)
            if (current.all.length !== tabs.all.length) changed = true
            if (!same(current.all, normalized.all) || current.active !== normalized.active) changed = true
            if (tabs.active !== undefined && typeof tabs.active !== "string") changed = true
            return [key, normalized]
          }),
        )

        if (!changed) return sessionTabs
        return next
      })()

      if (
        migratedSidebar === sidebar &&
        migratedReview === review &&
        migratedFileTree === fileTree &&
        migratedSessionTabs === sessionTabs
      ) {
        return value
      }

      return {
        ...value,
        sidebar: migratedSidebar,
        review: migratedReview,
        fileTree: migratedFileTree,
        sessionTabs: migratedSessionTabs,
      }
    }

    const target = Persist.global("layout", ["layout.v6"])
    const [store, setStore, _, ready] = persisted(
      { ...target, migrate },
      createStore({
        sidebar: {
          opened: true,
          width: DEFAULT_SIDEBAR_WIDTH,
          workspaces: {} as Record<string, boolean>,
          workspacesDefault: false,
        },
        terminal: {
          height: DEFAULT_TERMINAL_HEIGHT,
          opened: false,
        },
        // 会话级终端面板开关：以 sessionKey（由项目目录 + conversation id 组成）独立保存 opened 状态
        terminalBySession: {} as Record<string, boolean>,
        // 会话级右侧审查面板开关：同样以 sessionKey 独立保存，避免在一个对话里打开后泄漏到其他对话
        reviewPanelBySession: {} as Record<string, boolean>,
        review: {
          diffStyle: "split" as ReviewDiffStyle,
          /** @deprecated 已被会话级 `reviewPanelBySession` 取代，仅为兼容旧持久化数据保留，不要再读取。 */
          panelOpened: false,
          diffWordWrap: undefined as boolean | undefined,
          diffDontLoadFullFiles: undefined as boolean | undefined,
          diffRichPreview: undefined as boolean | undefined,
          diffWordDiffs: undefined as boolean | undefined,
          diffIgnoreWhitespace: undefined as boolean | undefined,
        },
        fileTree: {
          opened: false,
          width: DEFAULT_FILE_TREE_WIDTH,
          tab: "changes" as "changes" | "all",
        },
        session: {
          width: DEFAULT_SESSION_WIDTH,
        },
        mobileSidebar: {
          opened: false,
        },
        sessionTabs: {} as Record<string, SessionTabs>,
        treeExpanded: {} as Record<string, boolean>,
        pinnedProjects: [] as string[],
        pinnedThreads: [] as string[],
        // sidebar 筛选/排序偏好（下拉菜单持久化）
        sidebarFilter: {
          organize: "byProject" as "byProject" | "recent" | "chrono",
          sortBy: "updated" as "created" | "updated",
          show: "all" as "all" | "relevant",
        },
        sessionView: {} as Record<string, SessionView>,
        handoff: {
          tabs: undefined as TabHandoff | undefined,
        },
        lastProjectSession: {} as { [directory: string]: { directory: string; id: string; at: number } },
        workspaceOrder: {} as Record<string, string[]>,
        workspaceName: {} as Record<string, string>,
        workspaceExpanded: {} as Record<string, boolean>,
      }),
    )

    const MAX_SESSION_KEYS = 50
    const PENDING_MESSAGE_TTL_MS = 2 * 60 * 1000
    const usage = {
      active: undefined as string | undefined,
      pruned: false,
      used: new Map<string, number>(),
    }

    const SESSION_STATE_KEYS = [
      { key: "prompt", legacy: "prompt", version: "v2" },
      { key: "terminal", legacy: "terminal", version: "v1" },
      { key: "file-view", legacy: "file", version: "v1" },
    ] as const

    const dropSessionState = (keys: string[]) => {
      for (const key of keys) {
        const parts = key.split("/")
        const dir = parts[0]
        const session = parts[1]
        if (!dir) continue

        for (const entry of SESSION_STATE_KEYS) {
          const target = session ? Persist.session(dir, session, entry.key) : Persist.workspace(dir, entry.key)
          void removePersisted(target, platform)

          const legacyKey = `${dir}/${entry.legacy}${session ? "/" + session : ""}.${entry.version}`
          void removePersisted({ key: legacyKey }, platform)
        }
      }
    }

    function prune(keep?: string) {
      const drop = pruneSessionKeys({
        keep,
        max: MAX_SESSION_KEYS,
        used: usage.used,
        view: Object.keys(store.sessionView),
        tabs: Object.keys(store.sessionTabs),
        // 两个会话级面板 map 都要参与候选，否则「只开过面板」的会话进不了 drop，下面的 delete 永远不执行
        panels: [...Object.keys(store.reviewPanelBySession ?? {}), ...Object.keys(store.terminalBySession ?? {})],
      })
      if (drop.length === 0) return

      setStore(
        produce((draft) => {
          for (const key of drop) {
            delete draft.sessionView[key]
            delete draft.sessionTabs[key]
            delete draft.reviewPanelBySession[key]
            delete draft.terminalBySession[key]
          }
        }),
      )

      scroll.drop(drop)
      dropSessionState(drop)

      for (const key of drop) {
        usage.used.delete(key)
      }
    }

    function touch(sessionKey: string) {
      usage.active = sessionKey
      usage.used.set(sessionKey, Date.now())

      if (!ready()) return
      if (usage.pruned) return

      usage.pruned = true
      prune(sessionKey)
    }

    const scroll = createScrollPersistence({
      debounceMs: 250,
      getSnapshot: (sessionKey) => store.sessionView[sessionKey]?.scroll,
      onFlush: (sessionKey, next) => {
        const current = store.sessionView[sessionKey]
        const keep = usage.active ?? sessionKey
        if (!current) {
          setStore("sessionView", sessionKey, { scroll: next })
          prune(keep)
          return
        }

        setStore("sessionView", sessionKey, "scroll", (prev) => ({ ...prev, ...next }))
        prune(keep)
      },
    })

    const ensureKey = (key: string) => ensureSessionKey(key, touch, (sessionKey) => scroll.seed(sessionKey))

    createEffect(() => {
      if (!ready()) return
      if (usage.pruned) return
      const active = usage.active
      if (!active) return
      usage.pruned = true
      prune(active)
    })

    onMount(() => {
      const flush = () => batch(() => scroll.flushAll())
      const handleVisibility = () => {
        if (document.visibilityState !== "hidden") return
        flush()
      }

      makeEventListener(window, "pagehide", flush)
      makeEventListener(document, "visibilitychange", handleVisibility)

      onCleanup(() => {
        scroll.dispose()
      })
    })

    const [colors, setColors] = createStore<Record<string, AvatarColorKey>>({})
    const colorRequested = new Map<string, AvatarColorKey>()

    function pickAvailableColor(used: Set<string>): AvatarColorKey {
      const available = AVATAR_COLOR_KEYS.filter((c) => !used.has(c))
      if (available.length === 0) return AVATAR_COLOR_KEYS[Math.floor(Math.random() * AVATAR_COLOR_KEYS.length)]
      return available[Math.floor(Math.random() * available.length)]
    }

    function enrich(project: { worktree: string; expanded: boolean }) {
      const [childStore] = globalSync.child(project.worktree, { bootstrap: false })
      const projectID = childStore.project
      const metadata = projectID
        ? globalSync.data.project.find((x) => x.id === projectID)
        : globalSync.data.project.find((x) => x.worktree === project.worktree)

      // Preserve local icon override from per-workspace localStorage cache (childStore.icon).
      // Without this, different subdirectories of the same git repo would share the same
      // icon from the database instead of using their individual overrides.
      let base = { ...metadata, ...project } as Partial<typeof metadata> & typeof project
      // 当后端 metadata.name 缺失（无后端记录、或 id 为 "global"、或 id 未确定）时，
      // 用 childStore.projectMeta.name 作为本地 override —— 这样用户在 sidebar inline rename
      // 写入的本地名字 cmd+r 后仍能恢复，不会回退到 worktree basename。
      // 后端项目一旦真返回 name（非空），仍以后端为准。
      if (!base.name) {
        const localName = childStore.projectMeta?.name?.trim()
        if (localName) base = { ...base, name: localName } as typeof base
      }
      if (childStore.icon) {
        return { ...base, icon: { ...base.icon, override: childStore.icon } }
      }
      return base
    }

    const roots = createMemo(() => {
      const map = new Map<string, string>()
      for (const project of globalSync.data.project) {
        const sandboxes = project.sandboxes ?? []
        for (const sandbox of sandboxes) {
          map.set(sandbox, project.worktree)
        }
      }
      return map
    })

    const rootFor = (directory: string) => {
      const map = roots()
      if (map.size === 0) return directory

      const visited = new Set<string>()
      const chain = [directory]

      while (chain.length) {
        const current = chain[chain.length - 1]
        if (!current) return directory

        const next = map.get(current)
        if (!next) return current

        if (visited.has(next)) return directory
        visited.add(next)
        chain.push(next)
      }

      return directory
    }

    createEffect(() => {
      const projects = server.projects.list()
      const seen = new Set(projects.map((project) => project.worktree))

      batch(() => {
        for (const project of projects) {
          const root = rootFor(project.worktree)
          if (root === project.worktree) continue

          server.projects.close(project.worktree)

          if (!seen.has(root)) {
            server.projects.open(root)
            seen.add(root)
          }

          if (project.expanded) server.projects.expand(root)
        }
      })
    })

    const enriched = createMemo(() => server.projects.list().map(enrich))
    // 给每个 project 叠加 avatar 颜色。enrich/colorize 每次都会产生全新对象引用，
    // 若直接交给 <For> 会按引用 diff，导致每次 project 数据更新都全量销毁重建所有
    // ProjectRow（右键菜单的 Trigger 随之被卸载 → 菜单弹出后秒消失，并造成持续重渲染）。
    // 这里用 reconcile 按 worktree 复用既有节点，保持引用稳定。
    const colorize = () =>
      enriched().map((project) => {
        const color = project.icon?.color ?? colors[project.worktree]
        if (!color) return project
        const icon = project.icon ? { ...project.icon, color } : { color }
        return { ...project, icon }
      })
    const [stableList, setStableList] = createStore<LocalProject[]>(colorize() as LocalProject[])
    createEffect(() => setStableList(reconcile(colorize() as LocalProject[], { key: "worktree" })))
    const list = () => stableList

    createEffect(() => {
      const projects = enriched()
      if (projects.length === 0) return
      if (!globalSync.ready) return

      for (const project of projects) {
        if (!project.id) continue
        if (project.id === "global") continue
        globalSync.project.icon(project.worktree, project.icon?.override)
      }
    })

    createEffect(() => {
      const projects = enriched()
      if (projects.length === 0) return

      for (const project of projects) {
        if (project.icon?.color) colorRequested.delete(project.worktree)
      }

      const used = new Set<string>()
      for (const project of projects) {
        const color = project.icon?.color ?? colors[project.worktree]
        if (color) used.add(color)
      }

      for (const project of projects) {
        if (project.icon?.color || project.icon?.override || project.icon?.url) continue
        const worktree = project.worktree
        const existing = colors[worktree]
        const color = existing ?? pickAvailableColor(used)
        if (!existing) {
          used.add(color)
          setColors(worktree, color)
        }
        if (!project.id) continue

        const requested = colorRequested.get(worktree)
        if (requested === color) continue
        colorRequested.set(worktree, color)

        if (project.id === "global") {
          globalSync.project.meta(worktree, { icon: { color } })
          continue
        }

        void globalSdk.client.project
          .update({ projectID: project.id, directory: worktree, icon: { color } })
          .catch(() => {
            if (colorRequested.get(worktree) === color) colorRequested.delete(worktree)
          })
      }
    })

    let sessionFrame: number | undefined
    let sessionTimer: number | undefined
    let stopProjectOpen = () => {}

    onMount(() => {
      stopProjectOpen = globalSdk.event.listen((event) => {
        const directory = projectOpenRequestDirectory(event.details)
        if (!directory) return
        const root = rootFor(directory)
        // 远控新建只同步项目列表，不导航或覆盖桌面用户正在查看的会话。
        void globalSync.project.loadSessions(root)
        server.projects.open(root)
      })
      sessionFrame = requestAnimationFrame(() => {
        sessionFrame = undefined
        sessionTimer = window.setTimeout(() => {
          sessionTimer = undefined
          void Promise.all(
            server.projects
              .list()
              .filter((project) => !isScratchSessionPath(project.worktree))
              .map((project) => {
                return globalSync.project.loadSessions(project.worktree)
              }),
          )
        }, 0)
      })
    })

    onCleanup(() => {
      stopProjectOpen()
      if (sessionFrame !== undefined) cancelAnimationFrame(sessionFrame)
      if (sessionTimer !== undefined) window.clearTimeout(sessionTimer)
    })

    const wideSidebar = createMediaQuery(WIDE_SIDEBAR_MEDIA)

    createEffect(() => {
      if (!wideSidebar()) return
      if (!store.mobileSidebar?.opened) return
      setStore("mobileSidebar", "opened", false)
    })

    return {
      ready,
      handoff: {
        tabs: createMemo(() => store.handoff?.tabs),
        setTabs(dir: string, id: string) {
          setStore("handoff", "tabs", { dir, id, at: Date.now() })
        },
        clearTabs() {
          if (!store.handoff?.tabs) return
          setStore("handoff", "tabs", undefined)
        },
      },
      projects: {
        list,
        open(directory: string) {
          const root = rootFor(directory)
          if (server.projects.list().find((x) => x.worktree === root)) return
          void globalSync.project.loadSessions(root)
          server.projects.open(root)
        },
        close(directory: string) {
          server.projects.close(directory)
        },
        cleanup(directory: string) {
          const project = list().find((p) => pathKey(p.worktree) === pathKey(directory))
          const sandboxes = project?.sandboxes ?? []
          const dirs = [directory, ...sandboxes]

          setStore(
            produce((draft) => {
              delete draft.lastProjectSession[directory]
              delete draft.workspaceOrder[directory]
              for (const d of dirs) {
                delete draft.workspaceExpanded[d]
                delete draft.workspaceName[pathKey(d)]
                delete draft.workspaceName[d]
              }
            }),
          )
        },
        expand(directory: string) {
          server.projects.expand(directory)
        },
        collapse(directory: string) {
          server.projects.collapse(directory)
        },
        move(directory: string, toIndex: number) {
          server.projects.move(directory, toIndex)
        },
      },
      sidebar: {
        opened: createMemo(() => (wideSidebar() ? store.sidebar.opened : (store.mobileSidebar?.opened ?? false))),
        open() {
          if (!wideSidebar()) {
            setStore("mobileSidebar", "opened", true)
            return
          }
          setStore("sidebar", "opened", true)
        },
        close() {
          if (!wideSidebar()) {
            setStore("mobileSidebar", "opened", false)
            return
          }
          setStore("sidebar", "opened", false)
        },
        toggle() {
          if (!wideSidebar()) {
            setStore("mobileSidebar", "opened", (x) => !x)
            return
          }
          setStore("sidebar", "opened", (x) => !x)
        },
        width: createMemo(() => store.sidebar.width),
        resize(width: number) {
          setStore("sidebar", "width", width)
        },
        workspaces(directory: string) {
          return () => store.sidebar.workspaces[directory] ?? store.sidebar.workspacesDefault ?? false
        },
        setWorkspaces(directory: string, value: boolean) {
          setStore("sidebar", "workspaces", directory, value)
        },
        toggleWorkspaces(directory: string) {
          const current = store.sidebar.workspaces[directory] ?? store.sidebar.workspacesDefault ?? false
          setStore("sidebar", "workspaces", directory, !current)
        },
      },
      tree: {
        expanded(key: string, ctx: { isActiveProject: boolean; parentKey?: string }) {
          return () => resolveTreeExpanded(store.treeExpanded ?? {}, key, ctx)
        },
        set(key: string, value: boolean) {
          setStore(
            "treeExpanded",
            produce((s: Record<string, boolean>) => {
              s[key] = value
            }),
          )
        },
        toggle(key: string, ctx: { isActiveProject: boolean; parentKey?: string }) {
          const current = resolveTreeExpanded(store.treeExpanded ?? {}, key, ctx)
          setStore(
            "treeExpanded",
            produce((s: Record<string, boolean>) => {
              s[key] = !current
            }),
          )
        },
        isPinned(worktree: string) {
          return () => (store.pinnedProjects ?? []).includes(worktree)
        },
        pin(worktree: string) {
          setStore(
            "pinnedProjects",
            produce((s: string[]) => {
              if (!s.includes(worktree)) s.push(worktree)
            }),
          )
        },
        unpin(worktree: string) {
          setStore(
            "pinnedProjects",
            produce((s: string[]) => {
              const i = s.indexOf(worktree)
              if (i >= 0) s.splice(i, 1)
            }),
          )
        },
        togglePin(worktree: string) {
          // 内联展开避免 `this` 解构隐患（不复用 pin/unpin）
          const list = store.pinnedProjects ?? []
          if (list.includes(worktree)) {
            setStore(
              "pinnedProjects",
              produce((s: string[]) => {
                const i = s.indexOf(worktree)
                if (i >= 0) s.splice(i, 1)
              }),
            )
            return
          }
          setStore(
            "pinnedProjects",
            produce((s: string[]) => {
              if (!s.includes(worktree)) s.push(worktree)
            }),
          )
        },
        pinnedList: createMemo(() => store.pinnedProjects ?? []),
        // thread (session) pin —— 用于 sidebar "置顶" section
        isThreadPinned(sessionID: string) {
          return () => (store.pinnedThreads ?? []).includes(sessionID)
        },
        pinThread(sessionID: string) {
          setStore(
            "pinnedThreads",
            produce((s: string[]) => {
              if (!s.includes(sessionID)) s.push(sessionID)
            }),
          )
        },
        unpinThread(sessionID: string) {
          setStore(
            "pinnedThreads",
            produce((s: string[]) => {
              const i = s.indexOf(sessionID)
              if (i >= 0) s.splice(i, 1)
            }),
          )
        },
        toggleThreadPin(sessionID: string) {
          const list = store.pinnedThreads ?? []
          if (list.includes(sessionID)) {
            setStore(
              "pinnedThreads",
              produce((s: string[]) => {
                const i = s.indexOf(sessionID)
                if (i >= 0) s.splice(i, 1)
              }),
            )
            return
          }
          setStore(
            "pinnedThreads",
            produce((s: string[]) => {
              if (!s.includes(sessionID)) s.push(sessionID)
            }),
          )
        },
        pinnedThreadList: createMemo(() => store.pinnedThreads ?? []),
        // 筛选/排序偏好
        filter: createMemo(() => store.sidebarFilter ?? { organize: "byProject", sortBy: "updated", show: "all" }),
        setFilter<K extends "organize" | "sortBy" | "show">(key: K, value: string) {
          setStore("sidebarFilter", key as never, value as never)
        },
      },
      terminal: {
        height: createMemo(() => store.terminal.height),
        resize(height: number) {
          setStore("terminal", "height", height)
        },
      },
      review: {
        diffStyle: createMemo(() => store.review?.diffStyle ?? "split"),
        setDiffStyle(diffStyle: ReviewDiffStyle) {
          if (!store.review) {
            setStore("review", { diffStyle, panelOpened: true })
            return
          }
          setStore("review", "diffStyle", diffStyle)
        },
        diffWordWrap: createMemo(() => store.review?.diffWordWrap ?? false),
        setDiffWordWrap(diffWordWrap: boolean) {
          if (store.review?.diffWordWrap === diffWordWrap) return
          if (!store.review) {
            setStore("review", { diffStyle: "split" as ReviewDiffStyle, panelOpened: true, diffWordWrap })
            return
          }
          setStore("review", "diffWordWrap", diffWordWrap)
        },
        diffDontLoadFullFiles: createMemo(() => store.review?.diffDontLoadFullFiles ?? true),
        setDiffDontLoadFullFiles(diffDontLoadFullFiles: boolean) {
          if (store.review?.diffDontLoadFullFiles === diffDontLoadFullFiles) return
          if (!store.review) {
            setStore("review", {
              diffStyle: "split" as ReviewDiffStyle,
              panelOpened: true,
              diffDontLoadFullFiles,
            })
            return
          }
          setStore("review", "diffDontLoadFullFiles", diffDontLoadFullFiles)
        },
        diffRichPreview: createMemo(() => store.review?.diffRichPreview ?? false),
        setDiffRichPreview(diffRichPreview: boolean) {
          if (store.review?.diffRichPreview === diffRichPreview) return
          if (!store.review) {
            setStore("review", {
              diffStyle: "split" as ReviewDiffStyle,
              panelOpened: true,
              diffRichPreview,
            })
            return
          }
          setStore("review", "diffRichPreview", diffRichPreview)
        },
        diffWordDiffs: createMemo(() => store.review?.diffWordDiffs ?? false),
        setDiffWordDiffs(diffWordDiffs: boolean) {
          if (store.review?.diffWordDiffs === diffWordDiffs) return
          if (!store.review) {
            setStore("review", {
              diffStyle: "split" as ReviewDiffStyle,
              panelOpened: true,
              diffWordDiffs,
            })
            return
          }
          setStore("review", "diffWordDiffs", diffWordDiffs)
        },
        diffIgnoreWhitespace: createMemo(() => store.review?.diffIgnoreWhitespace ?? false),
        setDiffIgnoreWhitespace(diffIgnoreWhitespace: boolean) {
          if (store.review?.diffIgnoreWhitespace === diffIgnoreWhitespace) return
          if (!store.review) {
            setStore("review", {
              diffStyle: "split" as ReviewDiffStyle,
              panelOpened: true,
              diffIgnoreWhitespace,
            })
            return
          }
          setStore("review", "diffIgnoreWhitespace", diffIgnoreWhitespace)
        },
      },
      fileTree: {
        opened: createMemo(() => store.fileTree?.opened ?? false),
        width: createMemo(() => store.fileTree?.width ?? DEFAULT_FILE_TREE_WIDTH),
        tab: createMemo(() => store.fileTree?.tab ?? "changes"),
        setTab(tab: "changes" | "all") {
          if (!store.fileTree) {
            setStore("fileTree", { opened: true, width: DEFAULT_FILE_TREE_WIDTH, tab })
            return
          }
          setStore("fileTree", "tab", tab)
        },
        open() {
          if (!store.fileTree) {
            setStore("fileTree", { opened: true, width: DEFAULT_FILE_TREE_WIDTH, tab: "changes" })
            return
          }
          setStore("fileTree", "opened", true)
        },
        close() {
          if (!store.fileTree) {
            setStore("fileTree", { opened: false, width: DEFAULT_FILE_TREE_WIDTH, tab: "changes" })
            return
          }
          setStore("fileTree", "opened", false)
        },
        toggle() {
          if (!store.fileTree) {
            setStore("fileTree", { opened: true, width: DEFAULT_FILE_TREE_WIDTH, tab: "changes" })
            return
          }
          setStore("fileTree", "opened", (x) => !x)
        },
        resize(width: number) {
          if (!store.fileTree) {
            setStore("fileTree", { opened: true, width, tab: "changes" })
            return
          }
          setStore("fileTree", "width", width)
        },
      },
      session: {
        width: createMemo(() => store.session?.width ?? DEFAULT_SESSION_WIDTH),
        resize(width: number) {
          if (!store.session) {
            setStore("session", { width })
            return
          }
          setStore("session", "width", width)
        },
      },
      mobileSidebar: {
        opened: createMemo(() => store.mobileSidebar?.opened ?? false),
        show() {
          setStore("mobileSidebar", "opened", true)
        },
        hide() {
          setStore("mobileSidebar", "opened", false)
        },
        toggle() {
          setStore("mobileSidebar", "opened", (x) => !x)
        },
      },
      pendingMessage: {
        set(sessionKey: string, messageID: string) {
          const at = Date.now()
          touch(sessionKey)
          const current = store.sessionView[sessionKey]
          if (!current) {
            setStore("sessionView", sessionKey, {
              scroll: {},
              pendingMessage: messageID,
              pendingMessageAt: at,
            })
            prune(usage.active ?? sessionKey)
            return
          }

          setStore(
            "sessionView",
            sessionKey,
            produce((draft) => {
              draft.pendingMessage = messageID
              draft.pendingMessageAt = at
            }),
          )
        },
        consume(sessionKey: string) {
          const current = store.sessionView[sessionKey]
          const message = current?.pendingMessage
          const at = current?.pendingMessageAt
          if (!message || !at) return

          setStore(
            "sessionView",
            sessionKey,
            produce((draft) => {
              delete draft.pendingMessage
              delete draft.pendingMessageAt
            }),
          )

          if (Date.now() - at > PENDING_MESSAGE_TTL_MS) return
          return message
        },
      },
      view(sessionKey: string | Accessor<string>) {
        const key = createSessionKeyReader(sessionKey, ensureKey)
        const s = createMemo(() => store.sessionView[key()] ?? { scroll: {} })
        // 会话级终端 opened 状态：以 sessionKey 为 key 独立保存。
        // 升级前的全局 `store.terminal.opened` 不做兼容回退，所有会话升级后默认关闭，由用户重新开启。
        const terminalOpened = createMemo(() => resolveSessionPanelOpened(store.terminalBySession, key()))
        // 会话级审查面板 opened 状态：与终端面板一致按 sessionKey 独立保存。
        // 升级前的全局 `store.review.panelOpened` 不做兼容回退，所有会话升级后默认关闭，由用户重新开启。
        const reviewPanelOpened = createMemo(() => resolveSessionPanelOpened(store.reviewPanelBySession, key()))

        function setTerminalOpened(next: boolean) {
          const sessionId = key()
          if (resolveSessionPanelOpened(store.terminalBySession, sessionId) === next) return
          setStore("terminalBySession", sessionId, next)
        }

        /** 与 `fileTree.close()` 一致：审查面板与变更文件树共用 `fileTree.opened`，关审查时避免侧栏再露出文件树。 */
        function collapseFileTreeWithReviewPanel() {
          if (!store.fileTree) {
            setStore("fileTree", { opened: false, width: DEFAULT_FILE_TREE_WIDTH, tab: "changes" })
            return
          }
          setStore("fileTree", "opened", false)
        }

        function setReviewPanelOpened(next: boolean) {
          const sessionId = key()
          if (resolveSessionPanelOpened(store.reviewPanelBySession, sessionId) === next) return
          setStore("reviewPanelBySession", sessionId, next)
          if (!next) collapseFileTreeWithReviewPanel()
        }

        return {
          scroll(tab: string) {
            return scroll.scroll(key(), tab)
          },
          setScroll(tab: string, pos: SessionScroll) {
            scroll.setScroll(key(), tab, pos)
          },
          terminal: {
            opened: terminalOpened,
            open() {
              setTerminalOpened(true)
            },
            close() {
              setTerminalOpened(false)
            },
            toggle() {
              setTerminalOpened(!terminalOpened())
            },
          },
          reviewPanel: {
            opened: reviewPanelOpened,
            open() {
              setReviewPanelOpened(true)
            },
            close() {
              setReviewPanelOpened(false)
            },
            toggle() {
              setReviewPanelOpened(!reviewPanelOpened())
            },
          },
          review: {
            open: createMemo(() => s().reviewOpen ?? []),
            setOpen(open: string[]) {
              const session = key()
              const next = Array.from(new Set(open))
              const current = store.sessionView[session]
              if (!current) {
                setStore("sessionView", session, {
                  scroll: {},
                  reviewOpen: next,
                })
                return
              }

              if (same(current.reviewOpen, next)) return
              setStore("sessionView", session, "reviewOpen", next)
            },
            openPath(path: string) {
              const session = key()
              const current = store.sessionView[session]
              if (!current) {
                setStore("sessionView", session, {
                  scroll: {},
                  reviewOpen: [path],
                })
                return
              }

              if (!current.reviewOpen) {
                setStore("sessionView", session, "reviewOpen", [path])
                return
              }

              if (current.reviewOpen.includes(path)) return
              setStore("sessionView", session, "reviewOpen", current.reviewOpen.length, path)
            },
            closePath(path: string) {
              const session = key()
              const current = store.sessionView[session]?.reviewOpen
              if (!current) return

              const index = current.indexOf(path)
              if (index === -1) return
              setStore(
                "sessionView",
                session,
                "reviewOpen",
                produce((draft) => {
                  if (!draft) return
                  draft.splice(index, 1)
                }),
              )
            },
            togglePath(path: string) {
              const session = key()
              const current = store.sessionView[session]?.reviewOpen
              if (!current || !current.includes(path)) {
                this.openPath(path)
                return
              }

              this.closePath(path)
            },
          },
        }
      },
      tabs(sessionKey: string | Accessor<string>) {
        const key = createSessionKeyReader(sessionKey, ensureKey)
        const path = createMemo(() => sessionPath(key()))
        const tabs = createMemo(() => store.sessionTabs[key()] ?? { all: [] })
        const normalize = (tab: string) => normalizeSessionTab(path(), tab)
        const normalizeAll = (all: string[]) => normalizeSessionTabList(path(), all)
        return {
          tabs,
          active: createMemo(() => tabs().active),
          all: createMemo(() => tabs().all.filter((tab) => tab !== "review")),
          preview: createMemo(() => tabs().preview),
          setActive(tab: string | undefined) {
            const session = key()
            const next = tab ? normalize(tab) : tab
            if (!store.sessionTabs[session]) {
              setStore("sessionTabs", session, { all: [], active: next })
            } else {
              setStore("sessionTabs", session, "active", next)
            }
          },
          setAll(all: string[]) {
            const session = key()
            const next = normalizeAll(all).filter((tab) => tab !== "review")
            if (!store.sessionTabs[session]) {
              setStore("sessionTabs", session, { all: next, active: undefined })
            } else {
              setStore("sessionTabs", session, "all", next)
            }
          },
          async open(tab: string, opts?: { preview?: boolean }) {
            const session = key()
            const next = nextSessionTabsForOpen(store.sessionTabs[session], normalize(tab), opts)
            setStore("sessionTabs", session, next)
          },
          close(tab: string) {
            const session = key()
            const current = store.sessionTabs[session]
            if (!current) return

            if (tab === "review") {
              if (current.active !== tab) return
              setStore("sessionTabs", session, "active", current.all[0])
              return
            }

            const all = current.all.filter((x) => x !== tab)
            const preview = current.preview === tab ? undefined : current.preview
            if (current.active !== tab) {
              setStore("sessionTabs", session, "all", all)
              if (preview !== undefined) {
                setStore("sessionTabs", session, "preview", preview)
              }
              return
            }

            const index = current.all.findIndex((f) => f === tab)
            const next = current.all[index - 1] ?? current.all[index + 1] ?? all[0]
            batch(() => {
              setStore("sessionTabs", session, "all", all)
              setStore("sessionTabs", session, "active", next)
              if (preview !== undefined) {
                setStore("sessionTabs", session, "preview", preview)
              }
            })
          },
          move(tab: string, to: number) {
            const session = key()
            const current = store.sessionTabs[session]
            if (!current) return
            const index = current.all.findIndex((f) => f === tab)
            if (index === -1) return
            setStore(
              "sessionTabs",
              session,
              "all",
              produce((opened) => {
                opened.splice(to, 0, opened.splice(index, 1)[0])
              }),
            )
          },
        }
      },
    }
  },
})
