import { Platform, usePlatform } from "@/context/platform"
import { makePersisted, type AsyncStorage, type SyncStorage } from "@solid-primitives/storage"
import { checksum } from "@opencode-ai/core/util/encode"
import { createMemo, createResource, getOwner, runWithOwner, type Accessor } from "solid-js"
import type { SetStoreFunction, Store } from "solid-js/store"
import { pathKey } from "@/utils/path-key"

type InitType = Promise<string> | string | null
type PersistedWithReady<T> = [
  Store<T>,
  SetStoreFunction<T>,
  InitType,
  Accessor<boolean> & { promise: undefined | Promise<any> },
]

type PersistTarget = {
  storage?: string
  legacyStorageNames?: string[]
  key: string
  legacy?: string[]
  migrate?: (value: unknown) => unknown
  // 桌面端默认直写，只有显式声明为 true 的高频 key（如逐键输入的草稿）才进 400ms 合并写窗口。
  // 设置/布局/会话元数据这类小改动大后果的 store 必须保持写入即落盘，不能容忍「改完立刻退出丢改动」的窗口。
  coalesce?: boolean
}

const LEGACY_STORAGE = "default.dat"
const GLOBAL_STORAGE = "opencode.global.dat"
const LOCAL_PREFIX = "opencode."
const fallback = new Map<string, boolean>()

const CACHE_MAX_ENTRIES = 500
const CACHE_MAX_BYTES = 8 * 1024 * 1024

type CacheEntry = { value: string; bytes: number }
const cache = new Map<string, CacheEntry>()
const cacheTotal = { bytes: 0 }

function cacheDelete(key: string) {
  const entry = cache.get(key)
  if (!entry) return
  cacheTotal.bytes -= entry.bytes
  cache.delete(key)
}

function cachePrune() {
  for (;;) {
    if (cache.size <= CACHE_MAX_ENTRIES && cacheTotal.bytes <= CACHE_MAX_BYTES) return
    const oldest = cache.keys().next().value as string | undefined
    if (!oldest) return
    cacheDelete(oldest)
  }
}

function cacheSet(key: string, value: string) {
  const bytes = value.length * 2
  if (bytes > CACHE_MAX_BYTES) {
    cacheDelete(key)
    return
  }

  const entry = cache.get(key)
  if (entry) cacheTotal.bytes -= entry.bytes
  cache.delete(key)
  cache.set(key, { value, bytes })
  cacheTotal.bytes += bytes
  cachePrune()
}

function cacheGet(key: string) {
  const entry = cache.get(key)
  if (!entry) return
  cache.delete(key)
  cache.set(key, entry)
  return entry.value
}

function fallbackDisabled(scope: string) {
  return fallback.get(scope) === true
}

function fallbackSet(scope: string) {
  fallback.set(scope, true)
}

function quota(error: unknown) {
  if (error instanceof DOMException) {
    if (error.name === "QuotaExceededError") return true
    if (error.name === "NS_ERROR_DOM_QUOTA_REACHED") return true
    if (error.name === "QUOTA_EXCEEDED_ERR") return true
    if (error.code === 22 || error.code === 1014) return true
    return false
  }

  if (!error || typeof error !== "object") return false
  const name = (error as { name?: string }).name
  if (name === "QuotaExceededError" || name === "NS_ERROR_DOM_QUOTA_REACHED") return true
  if (name && /quota/i.test(name)) return true

  const code = (error as { code?: number }).code
  if (code === 22 || code === 1014) return true

  const message = (error as { message?: string }).message
  if (typeof message !== "string") return false
  if (/quota/i.test(message)) return true
  return false
}

type Evict = { key: string; size: number }

function evict(storage: Storage, keep: string, value: string) {
  const total = storage.length
  const indexes = Array.from({ length: total }, (_, index) => index)
  const items: Evict[] = []

  for (const index of indexes) {
    const name = storage.key(index)
    if (!name) continue
    if (!name.startsWith(LOCAL_PREFIX)) continue
    if (name === keep) continue
    const stored = storage.getItem(name)
    items.push({ key: name, size: stored?.length ?? 0 })
  }

  items.sort((a, b) => b.size - a.size)

  for (const item of items) {
    storage.removeItem(item.key)
    cacheDelete(item.key)

    try {
      storage.setItem(keep, value)
      cacheSet(keep, value)
      return true
    } catch (error) {
      if (!quota(error)) throw error
    }
  }

  return false
}

function write(storage: Storage, key: string, value: string) {
  try {
    storage.setItem(key, value)
    cacheSet(key, value)
    return true
  } catch (error) {
    if (!quota(error)) throw error
  }

  try {
    storage.removeItem(key)
    cacheDelete(key)
    storage.setItem(key, value)
    cacheSet(key, value)
    return true
  } catch (error) {
    if (!quota(error)) throw error
  }

  const ok = evict(storage, key, value)
  return ok
}

function snapshot(value: unknown) {
  return JSON.parse(JSON.stringify(value)) as unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function merge(defaults: unknown, value: unknown): unknown {
  if (value === undefined) return defaults
  if (value === null) return value

  if (Array.isArray(defaults)) {
    if (Array.isArray(value)) return value
    return defaults
  }

  if (isRecord(defaults)) {
    if (!isRecord(value)) return defaults

    const result: Record<string, unknown> = { ...defaults }
    for (const key of Object.keys(value)) {
      if (key in defaults) {
        result[key] = merge((defaults as Record<string, unknown>)[key], (value as Record<string, unknown>)[key])
      } else {
        result[key] = (value as Record<string, unknown>)[key]
      }
    }
    return result
  }

  return value
}

function parse(value: string) {
  try {
    return JSON.parse(value) as unknown
  } catch {
    return undefined
  }
}

function normalize(defaults: unknown, raw: string, migrate?: (value: unknown) => unknown) {
  const parsed = parse(raw)
  if (parsed === undefined) return
  const migrated = migrate ? migrate(parsed) : parsed
  const merged = merge(defaults, migrated)
  return JSON.stringify(merged)
}

function readCurrent(input: {
  storage: SyncStorage
  key: string
  defaults: unknown
  migrate?: (value: unknown) => unknown
}) {
  const raw = input.storage.getItem(input.key)
  if (raw === null) return
  const next = normalize(input.defaults, raw, input.migrate)
  if (next === undefined) {
    input.storage.removeItem(input.key)
    return null
  }
  if (raw !== next) input.storage.setItem(input.key, next)
  return next
}

function migrateLegacy(input: {
  current: SyncStorage
  legacyStore?: SyncStorage
  stores: SyncStorage[]
  keys: string[]
  key: string
  defaults: unknown
  migrate?: (value: unknown) => unknown
}) {
  for (const store of input.stores) {
    const raw = store.getItem(input.key)
    if (raw === null) continue

    const next = normalize(input.defaults, raw, input.migrate)
    if (next === undefined) {
      store.removeItem(input.key)
      continue
    }
    input.current.setItem(input.key, next)
    store.removeItem(input.key)
    return next
  }

  if (!input.legacyStore) return null

  for (const key of input.keys) {
    const raw = input.legacyStore.getItem(key)
    if (raw === null) continue

    const next = normalize(input.defaults, raw, input.migrate)
    if (next === undefined) {
      input.legacyStore.removeItem(key)
      continue
    }
    input.current.setItem(input.key, next)
    input.legacyStore.removeItem(key)
    return next
  }

  return null
}

async function readCurrentAsync(input: {
  storage: AsyncStorage
  key: string
  defaults: unknown
  migrate?: (value: unknown) => unknown
}) {
  const raw = await input.storage.getItem(input.key)
  if (raw === null) return
  const next = normalize(input.defaults, raw, input.migrate)
  if (next === undefined) {
    await input.storage.removeItem(input.key).catch(() => undefined)
    return null
  }
  // 规范化回写是 best-effort：已读到有效值后不能因写失败让整次读取 reject（否则回退默认值覆盖真数据）
  if (raw !== next) await input.storage.setItem(input.key, next).catch(() => undefined)
  return next
}

async function removeAsync(storage: AsyncStorage, key: string) {
  try {
    await storage.removeItem(key)
  } catch {}
}

async function migrateLegacyAsync(input: {
  current: AsyncStorage
  legacyStore?: AsyncStorage
  stores: AsyncStorage[]
  keys: string[]
  key: string
  defaults: unknown
  migrate?: (value: unknown) => unknown
  // 桌面端 current 是合并写 wrapper：普通 setItem 只是把值塞进待写缓冲就立即 resolve，
  // 用它判断“写成功”恒真。迁移必须绕开缓冲直接确认落盘，传入 wrapper 的 setItemDurable；
  // 非桌面/测试场景没有缓冲层，退回 current.setItem 语义不变。
  writeDurable?: (key: string, value: string) => Promise<void>
}) {
  const writeDurable = input.writeDurable ?? ((key, value) => input.current.setItem(key, value))
  for (const store of input.stores) {
    const raw = await store.getItem(input.key)
    if (raw === null) continue

    const next = normalize(input.defaults, raw, input.migrate)
    if (next === undefined) {
      await removeAsync(store, input.key)
      continue
    }
    // 迁移写入是 best-effort（值已读到，写失败不让读取 reject），
    // 但只有目标确认写成功才删除 legacy 源——否则下次启动两边皆空、数据永久回默认
    const wrote = await writeDurable(input.key, next).then(
      () => true,
      () => false,
    )
    if (wrote) await removeAsync(store, input.key)
    return next
  }

  if (!input.legacyStore) return null

  for (const key of input.keys) {
    const raw = await input.legacyStore.getItem(key)
    if (raw === null) continue

    const next = normalize(input.defaults, raw, input.migrate)
    if (next === undefined) {
      await removeAsync(input.legacyStore, key)
      continue
    }
    const wrote = await writeDurable(input.key, next).then(
      () => true,
      () => false,
    )
    if (wrote) await removeAsync(input.legacyStore, key)
    return next
  }

  return null
}

function workspaceStorage(dir: string) {
  const head = (dir.slice(0, 12) || "workspace").replace(/[^a-zA-Z0-9._-]/g, "-")
  const sum = checksum(dir) ?? "0"
  return `opencode.workspace.${head}.${sum}.dat`
}

function legacyWorkspaceStorage(dir: string) {
  const storage = workspaceStorage(pathKey(dir))
  const result = new Set<string>()
  const raw = workspaceStorage(dir)
  if (raw !== storage) result.add(raw)

  const key = pathKey(dir)
  const drive = key.length >= 3 && key[1] === ":" && key[2] === "/"
  if (drive) {
    const backslash = workspaceStorage(key.replaceAll("/", "\\"))
    if (backslash !== storage) result.add(backslash)
  }

  if (result.size === 0) return
  return [...result]
}

function localStorageWithPrefix(prefix: string): SyncStorage {
  const base = `${prefix}:`
  const scope = `prefix:${prefix}`
  const item = (key: string) => base + key
  return {
    getItem: (key) => {
      const name = item(key)
      const cached = cacheGet(name)
      if (fallbackDisabled(scope)) return cached ?? null

      const stored = (() => {
        try {
          return localStorage.getItem(name)
        } catch {
          fallbackSet(scope)
          return null
        }
      })()
      if (stored === null) return cached ?? null
      cacheSet(name, stored)
      return stored
    },
    setItem: (key, value) => {
      const name = item(key)
      if (fallbackDisabled(scope)) return
      try {
        if (write(localStorage, name, value)) return
      } catch {
        fallbackSet(scope)
        return
      }
      fallbackSet(scope)
    },
    removeItem: (key) => {
      const name = item(key)
      cacheDelete(name)
      if (fallbackDisabled(scope)) return
      try {
        localStorage.removeItem(name)
      } catch {
        fallbackSet(scope)
      }
    },
  }
}

function localStorageDirect(): SyncStorage {
  const scope = "direct"
  return {
    getItem: (key) => {
      const cached = cacheGet(key)
      if (fallbackDisabled(scope)) return cached ?? null

      const stored = (() => {
        try {
          return localStorage.getItem(key)
        } catch {
          fallbackSet(scope)
          return null
        }
      })()
      if (stored === null) return cached ?? null
      cacheSet(key, stored)
      return stored
    },
    setItem: (key, value) => {
      if (fallbackDisabled(scope)) return
      try {
        if (write(localStorage, key, value)) return
      } catch {
        fallbackSet(scope)
        return
      }
      fallbackSet(scope)
    },
    removeItem: (key) => {
      cacheDelete(key)
      if (fallbackDisabled(scope)) return
      try {
        localStorage.removeItem(key)
      } catch {
        fallbackSet(scope)
      }
    },
  }
}

// 桌面端的持久化写是 IPC → 主进程 conf.set()，而 conf 每次 set 都同步读回整个文件
// （readFileSync + JSON.parse + validate）再带 fsync 写回。实测单次 7.4–19.5ms，
// 也就是每敲一个字就把 Electron 主进程阻塞十几到几十毫秒 —— 这正是「输入框打字卡顿」。
//
// 这里在最底层的 AsyncStorage 上包一层合并写：窗口内同 key 后写覆盖前写，窗口到点一次性落盘。
// 语义取「最多每 N 毫秒写一次」而非「停手 N 毫秒后才写」：后者在持续输入时会无限推迟，
// 崩溃丢的就不止一个窗口了。
const COALESCE_WRITE_MS = 400

type CoalescedAsyncStorage = AsyncStorage & {
  flush: () => Promise<void>
  // 绕开合并写缓冲直接落盘并等待完成：迁移「确认写成功才删 legacy」的判定、以及卸载期间的
  // 兜底写都不能停在定时器里等下一次窗口——那时窗口可能已经不会再来。
  setItemDurable: (key: string, value: string) => Promise<void>
}

const coalescedStorages = new Map<string, CoalescedAsyncStorage>()
const pendingFlushes = new Set<() => Promise<void>>()

// 桌面端单个 key 的写入路径：只有显式声明 coalesce 才走缓冲 setItem（≤400ms 才落盘）；
// 否则一律走 setItemDurable 绕开缓冲，保证设置/布局/会话元数据这类 store 写入即落盘，
// 不因批量套用合并写而引入「改完立刻退出丢改动」的窗口。抽成独立函数供 persisted() 和测试共用。
export async function desktopPersistedWrite(input: {
  coalesce?: boolean
  current: Pick<AsyncStorage, "setItem">
  durable: Pick<CoalescedAsyncStorage, "setItemDurable">
  key: string
  value: string
}): Promise<void> {
  if (input.coalesce) {
    await input.current.setItem(input.key, input.value)
    return
  }
  await input.durable.setItemDurable(input.key, input.value)
}

// pagehide/beforeunload 触发后，同一收尾流程里产生的写（例如滚动位置）不能再进 400ms 合并窗口——
// 定时器到点前进程就可能已经卸载。标记置位后 setItem 直接透传给 inner，牺牲这几次写的合并收益换取送达。
let unloading = false

// 计时器可注入：生产环境用真实 setTimeout/clearTimeout（默认），测试可以传入假调度器，
// 摆脱「sleep 一段接近窗口长度的时间、赌 CI 不卡顿」的墙钟依赖，改为同步可控地驱动窗口触发。
type CoalesceScheduler = {
  setTimeout: (fn: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
}

const realScheduler: CoalesceScheduler = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

function coalesceAsyncWrites(
  inner: AsyncStorage,
  options?: { delayMs?: number; scheduler?: CoalesceScheduler },
): CoalescedAsyncStorage {
  const delayMs = options?.delayMs ?? COALESCE_WRITE_MS
  const scheduler = options?.scheduler ?? realScheduler
  // 待写值必须参与读：读路径（readCurrentAsync / migrateLegacyAsync）拿的是这一层，
  // 若只拦写不拦读，窗口内的读会拿到旧值，规范化回写会把新草稿覆盖回去。
  const pending = new Map<string, string>()
  let timer: unknown

  const flush = async () => {
    if (timer !== undefined) {
      scheduler.clearTimeout(timer)
      timer = undefined
    }
    if (pending.size === 0) return
    const batch = [...pending]
    pending.clear()
    // 写失败不再彻底静默丢弃：失败的 key 重新放回待写队列，下一个窗口再试一次。
    // 若期间又有更新值覆盖了同一 key，保留更新值，不用这次失败的旧值覆盖它。
    await Promise.all(
      batch.map(async ([key, value]) => {
        try {
          await inner.setItem(key, value)
        } catch {
          if (!pending.has(key)) pending.set(key, value)
        }
      }),
    )
    if (pending.size > 0 && timer === undefined) {
      timer = scheduler.setTimeout(() => {
        timer = undefined
        void flush()
      }, delayMs)
    }
  }
  pendingFlushes.add(flush)

  const writeDurable = (key: string, value: string) => {
    // 直写前先撤销同 key 的待写值，避免它稍后被窗口定时器重复落盘、或与直写产生竞态覆盖。
    pending.delete(key)
    return inner.setItem(key, value)
  }

  return {
    flush,
    getItem: async (key) => {
      const buffered = pending.get(key)
      if (buffered !== undefined) return buffered
      return inner.getItem(key)
    },
    setItem: async (key, value) => {
      if (unloading) {
        await writeDurable(key, value).catch(() => undefined)
        return
      }
      pending.set(key, value)
      // 只在窗口空闲时起表：持续输入期间不重置，保证最多 delayMs 就落一次盘。
      if (timer === undefined) {
        timer = scheduler.setTimeout(() => {
          timer = undefined
          void flush()
        }, delayMs)
      }
    },
    setItemDurable: async (key, value) => {
      await writeDurable(key, value)
    },
    removeItem: async (key) => {
      // 必须撤掉待写，否则排队中的旧值会在删除之后把数据写回来。
      pending.delete(key)
      await inner.removeItem(key)
    },
  }
}

// 窗口隐藏/卸载时立刻落盘：否则最后一个窗口内的草稿会丢。
export async function flushPersistedWrites() {
  await Promise.all([...pendingFlushes].map((flush) => flush()))
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  const flushNow = () => void flushPersistedWrites()
  const markUnloadingAndFlush = () => {
    // 必须先置位再 flush：本监听器注册得早，先于业务层（如 layout 滚动位置）的 pagehide 处理执行；
    // 置位后业务层随后触发的写会在 setItem 里直接透传，不再依赖必然错过的合并窗口定时器。
    unloading = true
    flushNow()
  }
  window.addEventListener("pagehide", markUnloadingAndFlush)
  window.addEventListener("beforeunload", markUnloadingAndFlush)
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushNow()
  })
}

export const PersistTesting = {
  coalesceAsyncWrites,
  coalescedStorageFor,
  coalescedStorages,
  COALESCE_WRITE_MS,
  localStorageDirect,
  localStorageWithPrefix,
  migrateLegacy,
  migrateLegacyAsync,
  normalize,
  workspaceStorage,
  // 仅供测试重置卸载标记，避免一个 test 触发 pagehide 后影响同文件后续用例。
  resetUnloadingForTest: () => {
    unloading = false
  },
}

export const Persist = {
  global(key: string, legacy?: string[]): PersistTarget {
    return { storage: GLOBAL_STORAGE, key, legacy }
  },
  workspace(dir: string, key: string, legacy?: string[]): PersistTarget {
    const storage = workspaceStorage(pathKey(dir))
    return { storage, legacyStorageNames: legacyWorkspaceStorage(dir), key: `workspace:${key}`, legacy }
  },
  session(dir: string, session: string, key: string, legacy?: string[]): PersistTarget {
    const storage = workspaceStorage(pathKey(dir))
    return {
      storage,
      legacyStorageNames: legacyWorkspaceStorage(dir),
      key: `session:${session}:${key}`,
      legacy,
    }
  },
  scoped(dir: string, session: string | undefined, key: string, legacy?: string[]): PersistTarget {
    if (session) return Persist.session(dir, session, key, legacy)
    return Persist.workspace(dir, key, legacy)
  },
}

export function removePersisted(
  target: { storage?: string; legacyStorageNames?: string[]; key: string },
  platform?: Platform,
) {
  const isDesktop = platform?.platform === "desktop" && !!platform.storage

  if (isDesktop) {
    // 命中合并写缓冲时必须走 wrapper 的 removeItem（会连带撤销 pending 里的待写值），
    // 否则直接删原始 storage 只清了当下这次，缓冲里排队的旧值仍会在 ≤400ms 后原样写回来。
    const primaryCoalesced = coalescedStorages.get(target.storage ?? LEGACY_STORAGE)
    if (primaryCoalesced) void primaryCoalesced.removeItem(target.key)
    else void platform.storage?.(target.storage)?.removeItem(target.key)

    for (const storage of target.legacyStorageNames ?? []) {
      const legacyCoalesced = coalescedStorages.get(storage)
      if (legacyCoalesced) void legacyCoalesced.removeItem(target.key)
      else void platform.storage?.(storage)?.removeItem(target.key)
    }
    return
  }

  if (!target.storage) {
    localStorageDirect().removeItem(target.key)
    return
  }

  localStorageWithPrefix(target.storage).removeItem(target.key)
  for (const storage of target.legacyStorageNames ?? []) {
    localStorageWithPrefix(storage).removeItem(target.key)
  }
}

// 按 storage 名记忆化：同一个存储的多个 persisted() 必须共享同一份待写缓冲，
// 否则 A 的待写值对 B 的读不可见，跨 store 读回会拿到旧数据。抽成独立函数供 persisted() 与测试共用，
// 测试可以直接验证「同名两次调用返回同一实例、异名返回不同实例、跨实例待写值互相可见」。
export function coalescedStorageFor(name: string, inner: AsyncStorage): CoalescedAsyncStorage {
  const existing = coalescedStorages.get(name)
  if (existing) return existing
  const wrapped = coalesceAsyncWrites(inner)
  coalescedStorages.set(name, wrapped)
  return wrapped
}

export function persisted<T>(
  target: string | PersistTarget,
  store: [Store<T>, SetStoreFunction<T>],
): PersistedWithReady<T> {
  const platform = usePlatform()
  const config: PersistTarget = typeof target === "string" ? { key: target } : target

  const defaults = snapshot(store[0])
  const legacy = config.legacy ?? []

  const isDesktop = platform.platform === "desktop" && !!platform.storage

  const currentStorage = (() => {
    if (isDesktop) {
      const inner = platform.storage?.(config.storage)
      if (!inner) return inner
      return coalescedStorageFor(config.storage ?? LEGACY_STORAGE, inner as AsyncStorage)
    }
    if (!config.storage) return localStorageDirect()
    return localStorageWithPrefix(config.storage)
  })()

  const legacyStorage = (() => {
    if (!isDesktop) return localStorageDirect()
    if (!config.storage) return platform.storage?.()
    return platform.storage?.(LEGACY_STORAGE)
  })()

  const legacyStorageNames = config.legacyStorageNames ?? []

  const storage = (() => {
    if (!isDesktop) {
      const current = currentStorage as SyncStorage
      const legacyStore = legacyStorage as SyncStorage
      const legacyStores = legacyStorageNames.map(localStorageWithPrefix)

      const api: SyncStorage = {
        getItem: (key) => {
          const value = readCurrent({ storage: current, key, defaults, migrate: config.migrate })
          if (value !== undefined) return value
          return migrateLegacy({
            current,
            legacyStore,
            stores: legacyStores,
            keys: legacy,
            key,
            defaults,
            migrate: config.migrate,
          })
        },
        setItem: (key, value) => {
          current.setItem(key, value)
        },
        removeItem: (key) => {
          current.removeItem(key)
        },
      }

      return api
    }

    const current = currentStorage as AsyncStorage
    // isDesktop 分支下 currentStorage 恒为 coalesceAsyncWrites 包出来的 wrapper（见上方 IIFE），
    // 因此这里的向下转型总是安全的，用来把 setItemDurable 递给迁移路径确认落盘。
    const currentDurable = currentStorage as CoalescedAsyncStorage
    const legacyStore = legacyStorage as AsyncStorage | undefined
    const legacyStores = legacyStorageNames
      .map((name) => platform.storage?.(name) as AsyncStorage | undefined)
      .filter((x) => !!x)

    const api: AsyncStorage = {
      // 在 makePersisted 的边界上收敛失败：其内部 init.then(success) 无 rejection handler，
      // getItem 一旦 reject 会产生 unhandledrejection 且 ready 永久卡死。读取失败落定为 null
      //（用内存默认值），迁移/回写失败已在内部做成 best-effort，不会丢已读到的值
      getItem: async (key) => {
        try {
          const value = await readCurrentAsync({ storage: current, key, defaults, migrate: config.migrate })
          if (value !== undefined) return value
          return await migrateLegacyAsync({
            current,
            legacyStore,
            stores: legacyStores,
            keys: legacy,
            key,
            defaults,
            migrate: config.migrate,
            writeDurable: (writeKey, value) => currentDurable.setItemDurable(writeKey, value),
          })
        } catch (error) {
          console.error("persisted read failed, falling back to defaults", config.key, error)
          return null
        }
      },
      // 只有显式声明 coalesce 的 key（草稿）才走合并写缓冲；其余 store 直接 setItemDurable，
      // 绕开缓冲拿到跟合并写引入前一致的「写入即落盘」语义，避免退出/崩溃丢最后一次修改。
      setItem: (key, value) =>
        desktopPersistedWrite({ coalesce: config.coalesce, current, durable: currentDurable, key, value }),
      removeItem: async (key) => {
        await current.removeItem(key)
      },
    }

    return api
  })()

  const [state, setState, init] = makePersisted(store, { name: config.key, storage })

  const isAsync = init instanceof Promise
  const [ready] = createResource(
    () => init,
    async (initValue) => {
      // 读取失败（IPC 拒绝/存储损坏）也要落定：否则 ready 永久 false，
      // 依赖它的输入框/环境列表会无出路地卡在占位态；失败时回退内存默认值
      if (initValue instanceof Promise) {
        try {
          await initValue
        } catch (error) {
          console.error("persisted init failed, falling back to defaults", config.key, error)
        }
      }
      return true
    },
    { initialValue: !isAsync },
  )

  // 暴露的 promise 同样吞掉拒绝：调用方 await 它只是等「读取落定」，不该被拒绝打断
  const settled = init instanceof Promise ? init.then(() => undefined, () => undefined) : undefined

  return [
    state,
    setState,
    init,
    Object.assign(() => (ready.loading ? false : ready.latest === true), {
      promise: settled,
    }),
  ]
}

/**
 * 按 scope（如工作区目录）缓存并响应式切换实例。
 * 常驻树下 directory 是运行期可变信号，persisted(Persist.workspace(dir, ...)) 的
 * 一次性捕获会绑死首个目录；用本函数包一层，scope 变化时自动换到对应实例。
 */
export type ScopedInstanceAccessor<T> = Accessor<T> & {
  // 异步任务必须按发起时快照读取实例，不能在 await 后退回当前响应式 scope。
  forScope(scope: string): T
}

export function scopedInstance<T>(scope: Accessor<string>, create: (scope: string) => T): ScopedInstanceAccessor<T> {
  const cache = new Map<string, T>()
  // runWithOwner 完整保留 owner 链与 context（createRoot 的 detachedOwner 不透传 context）；
  // 实例挂在调用方 owner 下，与 provider 同生命周期
  const owner = getOwner()
  const forScope = (key: string) => {
    const existing = cache.get(key)
    if (existing !== undefined) return existing
    const created = runWithOwner(owner, () => create(key)) as T
    cache.set(key, created)
    return created
  }
  const current = createMemo(() => forScope(scope())) as ScopedInstanceAccessor<T>
  current.forScope = forScope
  return current
}
