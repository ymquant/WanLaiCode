import { createStore, produce } from "solid-js/store"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { batch, createEffect, createMemo, createRoot, on, onCleanup } from "solid-js"
import { useParams } from "@solidjs/router"
import { useSDK } from "./sdk"
import type { Platform } from "./platform"
import type { PtyCreateResponse } from "@opencode-ai/sdk/v2"
import { ServerConnection, useServer } from "./server"
import { defaultTitle, titleNumber } from "./terminal-title"
import { Persist, persisted, removePersisted } from "@/utils/persist"

export type LocalPTY = {
  id: string
  title: string
  titleNumber: number
  shellOwnsTitle?: boolean
  rows?: number
  cols?: number
  buffer?: string
  scrollY?: number
  cursor?: number
  theme_foreground?: string
  theme_background?: string
}

const WORKSPACE_KEY = "__workspace__"
const MAX_TERMINAL_SESSIONS = 20

// 当 conversation id 缺失时（项目落地页），使用此占位以便和实际会话维度区分
const NO_SESSION_KEY = "__no-session__"

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function text(value: unknown) {
  return typeof value === "string" ? value : undefined
}

function num(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function numberFromTitle(title: string) {
  return titleNumber(title, MAX_TERMINAL_SESSIONS)
}

const MAX_TITLE_LENGTH = 200

function sanitizeTitle(title: string): string {
  const stripped = title.replace(/<[^>]*>/g, "")
  const cleaned = stripped.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
  return cleaned.slice(0, MAX_TITLE_LENGTH).trim()
}

function pty(value: unknown): LocalPTY | undefined {
  if (!record(value)) return

  const id = text(value.id)
  if (!id) return

  const title = text(value.title) ?? ""
  const number = num(value.titleNumber)
  const rows = num(value.rows)
  const cols = num(value.cols)
  const buffer = text(value.buffer)
  const scrollY = num(value.scrollY)
  const cursor = num(value.cursor)
  const themeForeground = text(value.theme_foreground)
  const themeBackground = text(value.theme_background)
  const shellOwnsTitle = typeof value.shellOwnsTitle === "boolean" ? value.shellOwnsTitle : undefined

  return {
    id,
    title: sanitizeTitle(title),
    titleNumber: number && number > 0 ? number : (numberFromTitle(title) ?? 0),
    ...(shellOwnsTitle !== undefined ? { shellOwnsTitle } : {}),
    ...(rows !== undefined ? { rows } : {}),
    ...(cols !== undefined ? { cols } : {}),
    ...(buffer !== undefined ? { buffer } : {}),
    ...(scrollY !== undefined ? { scrollY } : {}),
    ...(cursor !== undefined ? { cursor } : {}),
    ...(themeForeground !== undefined ? { theme_foreground: themeForeground } : {}),
    ...(themeBackground !== undefined ? { theme_background: themeBackground } : {}),
  }
}

export function migrateTerminalState(value: unknown) {
  if (!record(value)) return value

  const seen = new Set<string>()
  const all = (Array.isArray(value.all) ? value.all : []).flatMap((item) => {
    const next = pty(item)
    if (!next || seen.has(next.id)) return []
    seen.add(next.id)
    return [next]
  })

  const active = text(value.active)

  return {
    active: active && seen.has(active) ? active : all[0]?.id,
    all,
  }
}

export function getWorkspaceTerminalCacheKey(dir: string, scope?: string) {
  if (scope) return `${scope}:${dir}:${WORKSPACE_KEY}`
  return `${dir}:${WORKSPACE_KEY}`
}

// 终端实例按「项目目录 + 会话 id」联合键缓存。会话 id 缺失时退化为项目级。
export function getSessionTerminalCacheKey(dir: string, sessionID: string | undefined, scope?: string) {
  const sessionPart = sessionID ?? NO_SESSION_KEY
  if (scope) return `${scope}:${dir}:${sessionPart}`
  return `${dir}:${sessionPart}`
}

export function getTerminalServerScope(conn: ServerConnection.Any | undefined, key: ServerConnection.Key) {
  if (!conn) return
  if (conn.type === "sidecar" && conn.variant === "base") return
  if (conn.type === "http") {
    try {
      const url = new URL(conn.http.url)
      if (
        url.hostname === "localhost" ||
        url.hostname === "127.0.0.1" ||
        url.hostname === "::1" ||
        url.hostname === "[::1]"
      )
        return
    } catch {
      return key
    }
  }
  return key
}

export function getLegacyTerminalStorageKeys(dir: string, legacySessionID?: string) {
  if (!legacySessionID) return [`${dir}/terminal.v1`]
  return [`${dir}/terminal/${legacySessionID}.v1`, `${dir}/terminal.v1`]
}

export type TerminalRunInput = { title: string; command: string; cwd: string; os?: Platform["os"]; terminalID?: string }

export type TerminalSession = ReturnType<typeof createWorkspaceTerminalSession>

type TerminalCacheEntry = {
  value: TerminalSession
  dispose: VoidFunction
}

const caches = new Set<Map<string, TerminalCacheEntry>>()

const trimTerminal = (pty: LocalPTY) => {
  if (!pty.buffer && pty.cursor === undefined && pty.scrollY === undefined) return pty
  return {
    ...pty,
    buffer: undefined,
    cursor: undefined,
    scrollY: undefined,
    theme_foreground: undefined,
    theme_background: undefined,
  }
}

export function clearWorkspaceTerminals(dir: string, sessionIDs?: string[], platform?: Platform, scope?: string) {
  const baseKey = scope ? `terminal:${scope}` : "terminal"

  // 清掉项目目录下所有的会话级（含「无会话」占位）和项目级缓存
  const cacheKeys = new Set<string>()
  cacheKeys.add(getSessionTerminalCacheKey(dir, undefined, scope))
  cacheKeys.add(getWorkspaceTerminalCacheKey(dir, scope))
  for (const id of sessionIDs ?? []) {
    cacheKeys.add(getSessionTerminalCacheKey(dir, id, scope))
  }
  for (const cache of caches) {
    for (const key of cacheKeys) {
      const entry = cache.get(key)
      entry?.value.clear()
    }
  }

  // 持久化条目：项目级 + 各会话级
  void removePersisted(Persist.workspace(dir, baseKey), platform)
  for (const id of sessionIDs ?? []) {
    void removePersisted(Persist.session(dir, id, baseKey), platform)
  }

  if (scope) return
  const legacy = new Set(getLegacyTerminalStorageKeys(dir))
  for (const id of sessionIDs ?? []) {
    for (const key of getLegacyTerminalStorageKeys(dir, id)) {
      legacy.add(key)
    }
  }
  for (const key of legacy) {
    void removePersisted({ key }, platform)
  }
}

export function createWorkspaceTerminalSession(
  sdk: ReturnType<typeof useSDK>,
  dir: string,
  sessionID: string | undefined,
  scope?: string,
) {
  // 旧版终端持久化是项目级（workspace）；新版按会话级。读取时通过 legacy 数组兜底，让旧数据被一次性迁移过来。
  const baseKey = scope ? `terminal:${scope}` : "terminal"
  const legacy = scope ? [] : getLegacyTerminalStorageKeys(dir, sessionID)
  const target = sessionID
    ? Persist.session(dir, sessionID, baseKey, legacy)
    : Persist.workspace(dir, baseKey, legacy)

  const [store, setStore, _, ready] = persisted(
    {
      ...target,
      migrate: migrateTerminalState,
    },
    createStore<{
      active?: string
      all: LocalPTY[]
    }>({
      all: [],
    }),
  )

  let creationPromise: Promise<string | undefined> | null = null

  const pickNextTerminalNumber = () => {
    const existingTitleNumbers = new Set(
      store.all.flatMap((pty) => {
        const direct = Number.isFinite(pty.titleNumber) && pty.titleNumber > 0 ? pty.titleNumber : undefined
        if (direct !== undefined) return [direct]
        const parsed = numberFromTitle(pty.title)
        if (parsed === undefined) return []
        return [parsed]
      }),
    )

    return (
      Array.from({ length: existingTitleNumbers.size + 1 }, (_, index) => index + 1).find(
        (number) => !existingTitleNumbers.has(number),
      ) ?? 1
    )
  }

  const removeExited = (id: string) => {
    if (disposed) return
    const all = store.all
    const index = all.findIndex((x) => x.id === id)
    if (index === -1) return
    const active = store.active === id ? (index === 0 ? all[1]?.id : all[0]?.id) : store.active
    batch(() => {
      setStore("active", active)
      setStore(
        "all",
        produce((draft) => {
          draft.splice(index, 1)
        }),
      )
    })
  }

  const unsub = sdk.event.on("pty.exited", (event: { properties: { id: string } }) => {
    removeExited(event.properties.id)
  })
  onCleanup(unsub)
  // 项目切换时 createWorkspaceTerminalSession 所在的 createRoot 会被 dispose；
  // clone/new/run 等异步函数在 await 后 setStore 会写入已 dispose 的响应式节点，
  // 导致 SolidJS cleanNode 遇到 null 的 sourceSlots/observers 而崩溃
  // （TypeError: Cannot read properties of null (reading '1')）。
  // disposed 标志让这些异步写入在 dispose 后安全跳过。
  let disposed = false
  onCleanup(() => { disposed = true })

  const update = (client: ReturnType<typeof useSDK>["client"], pty: Partial<LocalPTY> & { id: string }) => {
    if (disposed) return
    const index = store.all.findIndex((x) => x.id === pty.id)
    const previous = index >= 0 ? store.all[index] : undefined
    const sanitized = pty.title !== undefined ? { ...pty, title: sanitizeTitle(pty.title) } : pty
    if (index >= 0) {
      setStore("all", index, (item) => ({ ...item, ...sanitized }))
    }
    client.pty
      .update({
        ptyID: pty.id,
        title: sanitized.title,
        size: pty.cols && pty.rows ? { rows: pty.rows, cols: pty.cols } : undefined,
      })
      .catch((error: unknown) => {
        if (disposed) return
        // 非 dispose 场景下的 404（NotFoundError）说明 PTY 已在服务端消失但前端仍显示：
        // 终端组件的 WebSocket 会通过 gone() 检测到 404 并走 onConnectError 恢复（recreateTerminal），
        // 此处保留乐观更新、不回滚也不报错，避免与组件层恢复流程重复处理造成闪烁。
        // 其它错误仍按原语义回滚乐观更新并记录错误日志。
        if (typeof error === "object" && error !== null && (error as { name?: string }).name === "NotFoundError") return
        if (previous) {
          const currentIndex = store.all.findIndex((item) => item.id === pty.id)
          if (currentIndex >= 0) setStore("all", currentIndex, previous)
        }
        console.error("Failed to update terminal", error)
      })
  }

  const clone = async (client: ReturnType<typeof useSDK>["client"], id: string) => {
    const index = store.all.findIndex((x) => x.id === id)
    const pty = store.all[index]
    if (!pty) return
    const next = await client.pty
      .create({
        title: pty.title,
      })
      .catch((error: unknown) => {
        console.error("Failed to clone terminal", error)
        return undefined
      })
    if (!next?.data) return
    if (disposed) {
      // PTY 已在服务端创建并注册；dispose 后直接 return 会遗留不可达进程，
      // 显式移除避免交互 shell/命令在 LRU 淘汰等场景下持续运行但 UI 无法访问。
      await client.pty.remove({ ptyID: next.data.id }).catch((error: unknown) => {
        console.error("Failed to remove orphaned cloned terminal", error)
      })
      return
    }

    const active = store.active === pty.id

    batch(() => {
      setStore("all", index, {
        id: next.data.id,
        title: sanitizeTitle(next.data.title ?? pty.title),
        titleNumber: pty.titleNumber,
        shellOwnsTitle: pty.shellOwnsTitle,
        buffer: undefined,
        cursor: undefined,
        scrollY: undefined,
        rows: undefined,
        cols: undefined,
        theme_foreground: undefined,
        theme_background: undefined,
      })
      if (active) {
        setStore("active", next.data.id)
      }
    })
  }

  return {
    ready,
    all: createMemo(() => store.all),
    active: createMemo(() => store.active),
    clear() {
      batch(() => {
        setStore("active", undefined)
        setStore("all", [])
      })
    },
    new(input?: { force?: boolean }) {
      if (!input?.force && store.all.length > 0) return
      if (creationPromise) return

      const nextNumber = pickNextTerminalNumber()
      // sdk.client 是随 directory 变化的响应式 getter；create resolve 期间若发生项目/worktree 切换，
      // 再次读取可能指向新 workspace。在 create 前捕获稳定引用，让创建与清理使用同一个 client。
      const client = sdk.client

      creationPromise = client.pty
        .create({ title: defaultTitle(nextNumber) })
        .then((pty: { data?: PtyCreateResponse }) => {
          const id = pty.data?.id
          if (!id) return
          if (disposed) {
            // PTY 已在服务端创建；dispose 后用同一 client 移除避免遗留不可达进程。
            void client.pty.remove({ ptyID: id }).catch((error: unknown) => {
              console.error("Failed to remove orphaned new terminal", error)
            })
            return
          }
          const newTerminal = {
            id,
            title: sanitizeTitle(pty.data?.title ?? defaultTitle(nextNumber)),
            titleNumber: nextNumber,
            shellOwnsTitle: true,
          }
          setStore("all", store.all.length, newTerminal)
          setStore("active", id)
          return id
        })
        .catch((error: unknown) => {
          console.error("Failed to create terminal", error)
          return undefined
        })
        .finally(() => {
          creationPromise = null
        })
    },
    async run(input: TerminalRunInput) {
      // sdk.client 是响应式 getter；项目/worktree 切换后第二次取可能指向新目录。
      // 在操作开始时捕获稳定 client，避免跨 workspace 写入。
      const client = sdk.client
      const shell = input.os === "windows" ? "powershell" : "sh"
      const args = input.os === "windows"
        ? ["-NoExit", "-NoProfile", "-Command", input.command]
        : ["-lc", `${input.command}; exec \${SHELL:-sh}`]
      const nextNumber = pickNextTerminalNumber()
      const title = sanitizeTitle(input.title || defaultTitle(nextNumber))
      const submit = input.os === "windows" ? "\r" : "\n"

      // 如果指定了 terminalID 且终端存在，复用该终端
      if (input.terminalID && store.all.some((item) => item.id === input.terminalID)) {
        const index = store.all.findIndex((item) => item.id === input.terminalID)
        if (index >= 0) setStore("all", index, "shellOwnsTitle", false)
        setStore("active", input.terminalID)

        await new Promise(resolve => setTimeout(resolve, 100))
        if (disposed) return input.terminalID

        const cleanCommand = input.command.replace(/\n+/g, "").trim()
        const writeData = cleanCommand + submit
        try {
          await client.pty.write({
            ptyID: input.terminalID,
            data: writeData,
          })
        } catch (error) {
          console.error("Failed to write to terminal", error)
        }
        return input.terminalID
      }

      if (!input.terminalID && store.all.length === 1) {
        const existingTerminal = store.all[0]
        const fallbackTitle = existingTerminal.title.trim()
        const canAdopt = fallbackTitle === defaultTitle(existingTerminal.titleNumber || 1)
          || fallbackTitle.endsWith("powershell.EXE")
          || fallbackTitle.endsWith("pwsh.exe")
          || fallbackTitle.endsWith("cmd.exe")
          || fallbackTitle.endsWith("sh")
          || fallbackTitle.endsWith("bash")
        if (canAdopt) {
          setStore("all", 0, {
            ...existingTerminal,
            title,
            shellOwnsTitle: false,
          })
          setStore("active", existingTerminal.id)
          const cleanCommand = input.command.replace(/\n+/g, "").trim()
          const writeData = cleanCommand + submit
          try {
            await client.pty.update({
              ptyID: existingTerminal.id,
              title,
            })
            // title update 期间若已 dispose，停止后续 write 避免跨 workspace 写入。
            if (disposed) return existingTerminal.id
            await client.pty.write({
              ptyID: existingTerminal.id,
              data: writeData,
            })
          } catch (error) {
            console.error("Failed to adopt existing terminal", error)
          }
          return existingTerminal.id
        }
      }

      if (!input.terminalID && creationPromise) {
        const createdID = await creationPromise
        if (disposed) return createdID
        const createdTerminal = createdID ? store.all.find((item) => item.id === createdID) : undefined
        if (createdTerminal && store.all.length === 1) {
          setStore("all", 0, {
            ...createdTerminal,
            title,
            shellOwnsTitle: false,
          })
          setStore("active", createdTerminal.id)
          const cleanCommand = input.command.replace(/\n+/g, "").trim()
          const writeData = cleanCommand + submit
          try {
            await client.pty.update({
              ptyID: createdTerminal.id,
              title,
            })
            // title update 期间若已 dispose，停止后续 write 避免跨 workspace 写入。
            if (disposed) return createdTerminal.id
            await client.pty.write({
              ptyID: createdTerminal.id,
              data: writeData,
            })
          } catch (error) {
            console.error("Failed to adopt pending terminal", error)
          }
          return createdTerminal.id
        }
      }

      // 创建新终端（每个 action 独立终端）
      const pty = await client.pty.create({
        title,
        cwd: input.cwd,
        command: shell,
        args,
      })
      const id = pty.data?.id
      if (!id) return
      if (disposed) {
        // PTY 已在服务端创建；dispose 后移除避免遗留不可达进程。
        await client.pty.remove({ ptyID: id }).catch((error: unknown) => {
          console.error("Failed to remove orphaned run terminal", error)
        })
        return
      }
      setStore("all", store.all.length, {
        id,
        title: sanitizeTitle(pty.data?.title ?? title),
        titleNumber: nextNumber,
        shellOwnsTitle: false,
      })
      setStore("active", id)
      return id
    },
    update(pty: Partial<LocalPTY> & { id: string }) {
      update(sdk.client, pty)
    },
    trim(id: string) {
      const index = store.all.findIndex((x) => x.id === id)
      if (index === -1) return
      setStore("all", index, (pty) => trimTerminal(pty))
    },
    trimAll() {
      setStore("all", (all) => {
        const next = all.map(trimTerminal)
        if (next.every((pty, index) => pty === all[index])) return all
        return next
      })
    },
    async clone(id: string) {
      await clone(sdk.client, id)
    },
    bind() {
      const client = sdk.client
      return {
        trim(id: string) {
          const index = store.all.findIndex((x) => x.id === id)
          if (index === -1) return
          setStore("all", index, (pty) => trimTerminal(pty))
        },
        update(pty: Partial<LocalPTY> & { id: string }) {
          update(client, pty)
        },
        async clone(id: string) {
          await clone(client, id)
        },
      }
    },
    open(id: string) {
      setStore("active", id)
    },
    next() {
      const index = store.all.findIndex((x) => x.id === store.active)
      if (index === -1) return
      const nextIndex = (index + 1) % store.all.length
      setStore("active", store.all[nextIndex]?.id)
    },
    previous() {
      const index = store.all.findIndex((x) => x.id === store.active)
      if (index === -1) return
      const prevIndex = index === 0 ? store.all.length - 1 : index - 1
      setStore("active", store.all[prevIndex]?.id)
    },
    async close(id: string) {
      const index = store.all.findIndex((f) => f.id === id)
      if (index !== -1) {
        batch(() => {
          if (store.active === id) {
            const next = index > 0 ? store.all[index - 1]?.id : store.all[1]?.id
            setStore("active", next)
          }
          setStore(
            "all",
            produce((all) => {
              all.splice(index, 1)
            }),
          )
        })
      }

      await sdk.client.pty.remove({ ptyID: id }).catch((error: unknown) => {
        console.error("Failed to close terminal", error)
      })
    },
    move(id: string, to: number) {
      const index = store.all.findIndex((f) => f.id === id)
      if (index === -1) return
      setStore(
        "all",
        produce((all) => {
          all.splice(to, 0, all.splice(index, 1)[0])
        }),
      )
    },
  }
}

export const { use: useTerminal, provider: TerminalProvider } = createSimpleContext({
  name: "Terminal",
  gate: false,
  init: () => {
    const sdk = useSDK()
    const server = useServer()
    const params = useParams()
    const cache = new Map<string, TerminalCacheEntry>()
    const scope = createMemo(() => {
      return getTerminalServerScope(server.current, server.key)
    })

    caches.add(cache)
    onCleanup(() => caches.delete(cache))

    const disposeAll = () => {
      for (const entry of cache.values()) {
        entry.dispose()
      }
      cache.clear()
    }

    onCleanup(disposeAll)

    const prune = () => {
      while (cache.size > MAX_TERMINAL_SESSIONS) {
        const first = cache.keys().next().value
        if (!first) return
        const entry = cache.get(first)
        entry?.dispose()
        cache.delete(first)
      }
    }

    const loadWorkspace = (dir: string, sessionID: string | undefined, serverScope: string | undefined) => {
      // 终端按「项目目录 + 会话 id」双维度隔离：每个对话拥有独立的 tab 列表与 buffer 历史。
      const key = getSessionTerminalCacheKey(dir, sessionID, serverScope)
      const existing = cache.get(key)
      if (existing) {
        cache.delete(key)
        cache.set(key, existing)
        return existing.value
      }

      const entry = createRoot((dispose) => ({
        value: createWorkspaceTerminalSession(sdk, dir, sessionID, serverScope),
        dispose,
      }))

      cache.set(key, entry)
      prune()
      return entry.value
    }

    const workspace = createMemo(() => loadWorkspace(params.dir!, params.id, scope()))

    createEffect(
      on(
        () => ({ dir: params.dir, id: params.id, scope: scope() }),
        (next, prev) => {
          if (!prev?.dir) return
          if (next.dir === prev.dir && next.id === prev.id && next.scope === prev.scope) return
          // 离开对话/项目：把上一个会话的 buffer 截断释放内存
          loadWorkspace(prev.dir, prev.id, prev.scope).trimAll()
        },
        { defer: true },
      ),
    )

    return {
      ready: () => workspace().ready(),
      all: () => workspace().all(),
      active: () => workspace().active(),
      new: (input?: { force?: boolean }) => workspace().new(input),
      run: (input: TerminalRunInput) => workspace().run(input),
      update: (pty: Partial<LocalPTY> & { id: string }) => workspace().update(pty),
      trim: (id: string) => workspace().trim(id),
      trimAll: () => workspace().trimAll(),
      clone: (id: string) => workspace().clone(id),
      bind: () => workspace(),
      open: (id: string) => workspace().open(id),
      close: (id: string) => workspace().close(id),
      move: (id: string, to: number) => workspace().move(id, to),
      next: () => workspace().next(),
      previous: () => workspace().previous(),
    }
  },
})
