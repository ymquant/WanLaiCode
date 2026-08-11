import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { Platform } from "@/context/platform"
import { createRoot } from "solid-js"
import {
  desktopPersistedWrite,
  flushPersistedWrites,
  Persist,
  PersistTesting as persistTesting,
  removePersisted,
  scopedInstance,
} from "./persist"

class MemoryStorage implements Storage {
  private values = new Map<string, string>()
  readonly events: string[] = []
  readonly calls = { get: 0, set: 0, remove: 0 }

  clear() {
    this.values.clear()
  }

  get length() {
    return this.values.size
  }

  key(index: number) {
    return Array.from(this.values.keys())[index] ?? null
  }

  getItem(key: string) {
    this.calls.get += 1
    this.events.push(`get:${key}`)
    if (key.startsWith("opencode.throw")) throw new Error("storage get failed")
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string) {
    this.calls.set += 1
    this.events.push(`set:${key}`)
    if (key.startsWith("opencode.quota")) throw new DOMException("quota", "QuotaExceededError")
    if (key.startsWith("opencode.throw")) throw new Error("storage set failed")
    this.values.set(key, value)
  }

  removeItem(key: string) {
    this.calls.remove += 1
    this.events.push(`remove:${key}`)
    if (key.startsWith("opencode.throw")) throw new Error("storage remove failed")
    this.values.delete(key)
  }
}

const storage = new MemoryStorage()

beforeEach(() => {
  storage.clear()
  storage.events.length = 0
  storage.calls.get = 0
  storage.calls.set = 0
  storage.calls.remove = 0
  Object.defineProperty(globalThis, "localStorage", {
    value: storage,
    configurable: true,
  })
})

describe("persist localStorage resilience", () => {
  test("does not cache values as persisted when quota write and eviction fail", () => {
    const storageApi = persistTesting.localStorageWithPrefix("opencode.quota.scope")
    storageApi.setItem("value", '{"value":1}')

    expect(storage.getItem("opencode.quota.scope:value")).toBeNull()
    expect(storageApi.getItem("value")).toBeNull()
  })

  test("disables only the failing scope when storage throws", () => {
    const bad = persistTesting.localStorageWithPrefix("opencode.throw.scope")
    bad.setItem("value", '{"value":1}')

    const before = storage.calls.set
    bad.setItem("value", '{"value":2}')
    expect(storage.calls.set).toBe(before)
    expect(bad.getItem("value")).toBeNull()

    const healthy = persistTesting.localStorageWithPrefix("opencode.safe.scope")
    healthy.setItem("value", '{"value":3}')
    expect(storage.getItem("opencode.safe.scope:value")).toBe('{"value":3}')
  })

  test("failing fallback scope does not poison direct storage scope", () => {
    const broken = persistTesting.localStorageWithPrefix("opencode.throw.scope2")
    broken.setItem("value", '{"value":1}')

    const direct = persistTesting.localStorageDirect()
    direct.setItem("direct-value", '{"value":5}')

    expect(storage.getItem("direct-value")).toBe('{"value":5}')
  })

  test("normalizer rejects malformed JSON payloads", () => {
    const result = persistTesting.normalize({ value: "ok" }, '{"value":"\\x"}')
    expect(result).toBeUndefined()
  })

  test("workspace storage sanitizes Windows filename characters", () => {
    const result = persistTesting.workspaceStorage("C:\\Users\\foo")

    expect(result).toStartWith("opencode.workspace.")
    expect(result.endsWith(".dat")).toBeTrue()
    expect(/[:\\/]/.test(result)).toBeFalse()
  })

  test("workspace target keeps raw path storage as legacy fallback", () => {
    const target = Persist.workspace("C:\\Users\\foo", "vcs")

    expect(target.storage).toBe(persistTesting.workspaceStorage("C:/Users/developer"))
    expect(target.legacyStorageNames).toEqual([persistTesting.workspaceStorage("C:\\Users\\foo")])
  })

  test("workspace target keeps backslash storage as fallback for normalized Windows paths", () => {
    const target = Persist.workspace("C:/Users/developer", "vcs")

    expect(target.storage).toBe(persistTesting.workspaceStorage("C:/Users/developer"))
    expect(target.legacyStorageNames).toEqual([persistTesting.workspaceStorage("C:\\Users\\foo")])
  })

  test("migrates direct legacy keys into scoped storage", () => {
    storage.setItem("legacy.workspace", '{"value":2}')
    const target = Persist.workspace("C:/Users/developer", "demo", ["legacy.workspace"])
    const current = persistTesting.localStorageWithPrefix(target.storage!)
    const legacyStore = persistTesting.localStorageDirect()

    const result = persistTesting.migrateLegacy({
      current,
      legacyStore,
      stores: [],
      keys: target.legacy!,
      key: target.key,
      defaults: { value: 1 },
    })

    expect(result).toBe('{"value":2}')
    expect(storage.getItem(`${target.storage}:${target.key}`)).toBe('{"value":2}')
    expect(legacyStore.getItem("legacy.workspace")).toBeNull()
    expect(storage.getItem("legacy.workspace")).toBeNull()
  })

  test("removes legacy workspace storage when removing persisted target", () => {
    const target = Persist.workspace("C:\\Users\\foo", "terminal")
    storage.setItem(`${target.storage}:${target.key}`, '{"value":1}')
    storage.setItem(`${target.legacyStorageNames![0]}:${target.key}`, '{"value":2}')

    removePersisted(target)

    expect(storage.getItem(`${target.storage}:${target.key}`)).toBeNull()
    expect(storage.getItem(`${target.legacyStorageNames![0]}:${target.key}`)).toBeNull()
  })
})

describe("scopedInstance", () => {
  test("can reopen and reuse an explicitly captured scope", () => {
    createRoot((dispose) => {
      const created: string[] = []
      const instances = scopedInstance(() => "project-a", (key) => {
        created.push(key)
        return { key }
      })

      const original = instances()
      const background = instances.forScope("project-b")
      expect(background).toEqual({ key: "project-b" })
      // 异步 ACK 按捕获目录重复读取时必须复用同一实例，不能创建第二份持久化状态。
      expect(instances.forScope("project-a")).toBe(original)
      expect(instances.forScope("project-b")).toBe(background)
      expect(created).toEqual(["project-a", "project-b"])
      dispose()
    })
  })
})

// 多个 describe 共用：合并写 wrapper 和迁移/删除的测试都需要一份可观测调用次数的 inner AsyncStorage。
const makeInner = () => {
  const values = new Map<string, string>()
  const calls = { set: 0, remove: 0, get: 0 }
  return {
    values,
    calls,
    storage: {
      getItem: async (key: string) => {
        calls.get++
        return values.get(key) ?? null
      },
      setItem: async (key: string, value: string) => {
        calls.set++
        values.set(key, value)
      },
      removeItem: async (key: string) => {
        calls.remove++
        values.delete(key)
      },
    },
  }
}

// 假调度器：用引用相等当句柄，setTimeout 只记录回调、不真的等待，靠测试主动 fire() 推进。
// 用来摆脱「sleep 一段接近窗口长度的时间、赌 CI 不卡顿」的墙钟依赖——真实 setTimeout 在负载
// 高的 CI 上，一次 tick 抖动过窗口长度就会让 debounce 变异体也蹭过一次真实落盘，测试变假绿。
const createFakeScheduler = () => {
  let pending: (() => void) | undefined
  let scheduleCount = 0
  return {
    scheduler: {
      setTimeout: (fn: () => void) => {
        scheduleCount++
        pending = fn
        return fn
      },
      clearTimeout: (handle: unknown) => {
        if (handle === pending) pending = undefined
      },
    },
    fire: () => {
      const fn = pending
      pending = undefined
      fn?.()
    },
    get scheduleCount() {
      return scheduleCount
    },
  }
}

describe("桌面持久化的合并写", () => {
  test("窗口内连打只落一次盘，且落的是最后一个值", async () => {
    // 症结：每次按键一趟 IPC + conf.set(fsync)，实测阻塞主进程 15–39ms/次。
    const inner = makeInner()
    const s = persistTesting.coalesceAsyncWrites(inner.storage)
    for (const text of ["h", "he", "hel", "hell", "hello"]) await s.setItem("draft", text)
    expect(inner.calls.set).toBe(0)
    await s.flush()
    expect(inner.calls.set).toBe(1)
    expect(inner.values.get("draft")).toBe("hello")
  })

  test("待写值对读可见（否则窗口内读回旧值会把新草稿覆盖掉）", async () => {
    const inner = makeInner()
    const s = persistTesting.coalesceAsyncWrites(inner.storage)
    await s.setItem("draft", "typed")
    expect(await s.getItem("draft")).toBe("typed")
    expect(inner.calls.set).toBe(0)
  })

  test("删除要撤掉待写，否则排队的旧值会在删除后写回来", async () => {
    const inner = makeInner()
    const s = persistTesting.coalesceAsyncWrites(inner.storage)
    await s.setItem("draft", "typed")
    await s.removeItem("draft")
    await s.flush()
    expect(inner.values.has("draft")).toBe(false)
    expect(await s.getItem("draft")).toBe(null)
  })

  test("到点自动落盘，不必等 flush", async () => {
    const inner = makeInner()
    const s = persistTesting.coalesceAsyncWrites(inner.storage)
    await s.setItem("draft", "typed")
    await new Promise((r) => setTimeout(r, persistTesting.COALESCE_WRITE_MS + 80))
    expect(inner.values.get("draft")).toBe("typed")
  })

  test("持续输入不会把落盘无限推迟（取最多每 N 毫秒一次，而非停手才写）", async () => {
    // 用停手才写的语义（trailing debounce），持续打字时窗口被反复重置，崩溃会丢掉整段草稿。
    // 用可控假调度器摆脱墙钟：断言"一串连续 setItem 期间只起过一个定时器"，
    // 而不是靠真实睡眠碰运气——旧版靠 sleep 一段接近窗口长度的时间，CI 抖动时 debounce
    // 变异体也能蹭过一次真实 tick，让守卫可靠性打折。
    const inner = makeInner()
    const fake = createFakeScheduler()
    const s = persistTesting.coalesceAsyncWrites(inner.storage, { scheduler: fake.scheduler })

    // 连续三次 setItem 模拟持续输入：只应起一个定时器（第一次 setItem 时），
    // 后续 setItem 不重置定时器——这正是「最多每 N 毫秒一次」而非「停手才写」的核心不变量。
    // 变异验证：把 setItem 里的「只在 timer === undefined 时起表」改成每次都重新起表，
    // scheduleCount 会从 1 变 3。
    await s.setItem("draft", "1")
    await s.setItem("draft", "2")
    await s.setItem("draft", "3")
    expect(fake.scheduleCount).toBe(1)
    expect(inner.calls.set).toBe(0)

    fake.fire()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(inner.calls.set).toBe(1)
    expect(inner.values.get("draft")).toBe("3")

    // 窗口到点落盘后继续输入必须能再起一个新窗口，而不是被首窗口"用掉"就永久停摆。
    await s.setItem("draft", "4")
    expect(fake.scheduleCount).toBe(2)
    fake.fire()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(inner.calls.set).toBe(2)
    expect(inner.values.get("draft")).toBe("4")
  })

  test("多个 key 在同一窗口内合并成一批", async () => {
    const inner = makeInner()
    const s = persistTesting.coalesceAsyncWrites(inner.storage)
    await s.setItem("a", "1")
    await s.setItem("b", "2")
    await s.setItem("a", "3")
    await s.flush()
    expect(inner.calls.set).toBe(2)
    expect(inner.values.get("a")).toBe("3")
    expect(inner.values.get("b")).toBe("2")
  })
})

describe("migrateLegacyAsync 必须等真正落盘才删 legacy", () => {
  const makeLegacyStore = (initial: Record<string, string>) => {
    const values = new Map(Object.entries(initial))
    return {
      values,
      store: {
        getItem: async (key: string) => values.get(key) ?? null,
        setItem: async (key: string, value: string) => {
          values.set(key, value)
        },
        removeItem: async (key: string) => {
          values.delete(key)
        },
      },
    }
  }

  test("传入合并写 wrapper 的 setItemDurable 时，legacy 删除前目标必须已经真正落盘（不依赖定时器/flush）", async () => {
    const inner = makeInner()
    const current = persistTesting.coalesceAsyncWrites(inner.storage)
    const legacy = makeLegacyStore({ "legacy-key": '{"value":9}' })

    const result = await persistTesting.migrateLegacyAsync({
      current,
      legacyStore: legacy.store,
      stores: [],
      keys: ["legacy-key"],
      key: "target-key",
      defaults: { value: 1 },
      writeDurable: current.setItemDurable,
    })

    expect(result).toBe('{"value":9}')
    // 关键断言：函数返回时写已经真正落到 inner，不是靠合并写的 400ms 定时器或手动 flush。
    expect(inner.calls.set).toBe(1)
    expect(inner.values.get("target-key")).toBe('{"value":9}')
    expect(legacy.values.has("legacy-key")).toBe(false)
  })

  test("目标写失败时绝不删除 legacy 源，避免迁移窗口崩溃后两边皆空", async () => {
    const legacy = makeLegacyStore({ "legacy-key": '{"value":9}' })
    const failingCurrent = {
      getItem: async () => null,
      setItem: async () => {},
      removeItem: async () => {},
    }

    const result = await persistTesting.migrateLegacyAsync({
      current: failingCurrent,
      legacyStore: legacy.store,
      stores: [],
      keys: ["legacy-key"],
      key: "target-key",
      defaults: { value: 1 },
      writeDurable: async () => {
        throw new Error("write failed")
      },
    })

    expect(result).toBe('{"value":9}')
    // 目标没有确认写成功，legacy 源必须原样保留。
    expect(legacy.values.has("legacy-key")).toBe(true)
  })
})

describe("removePersisted 必须绕开合并写缓冲，而不是留下能被写回的待写值", () => {
  afterEach(() => {
    persistTesting.coalescedStorages.clear()
  })

  test("命中合并写 wrapper 时改走它的 removeItem，排队中的旧值不会在删除后被定时器写回来", async () => {
    const inner = makeInner()
    const wrapper = persistTesting.coalesceAsyncWrites(inner.storage)
    // 模拟删除前一瞬间恰好有一次待写（例如工作区被移除前终端状态刚写过一次）。
    await wrapper.setItem("session:s1:terminal", '{"cwd":"/old"}')

    const storageName = "opencode.workspace.demo.dat"
    persistTesting.coalescedStorages.set(storageName, wrapper)

    // platform.storage(name) 模拟生产环境里每次调用都拿到未经合并写包装的原始 handle——
    // 这正是旧代码直接调用它而绕开 wrapper pending 的成因。
    const platform = {
      platform: "desktop",
      storage: () => inner.storage,
    } as unknown as Platform

    removePersisted({ storage: storageName, key: "session:s1:terminal" }, platform)
    // 等过原本待写值的合并窗口：命中 wrapper 时不会有任何东西被写回。
    await new Promise((resolve) => setTimeout(resolve, persistTesting.COALESCE_WRITE_MS + 80))

    expect(inner.values.has("session:s1:terminal")).toBe(false)
    expect(await wrapper.getItem("session:s1:terminal")).toBeNull()
  })
})

describe("卸载期间产生的写不能被合并窗口吞掉", () => {
  afterEach(() => {
    persistTesting.resetUnloadingForTest()
  })

  test("pagehide 触发后的写必须直接透传落盘，不能再排进 400ms 合并窗口", async () => {
    const inner = makeInner()
    const s = persistTesting.coalesceAsyncWrites(inner.storage)

    // 对应 layout.tsx 在 pagehide 里稍晚注册、稍晚执行的滚动位置持久化：
    // persist 模块自己的 pagehide 监听器注册得更早，会先跑并置位 unloading。
    window.dispatchEvent(new Event("pagehide"))
    await s.setItem("scroll:s1", "120")

    expect(inner.calls.set).toBe(1)
    expect(inner.values.get("scroll:s1")).toBe("120")
  })

  test("非卸载状态下仍然走合并写，不受影响", async () => {
    const inner = makeInner()
    const s = persistTesting.coalesceAsyncWrites(inner.storage)
    await s.setItem("scroll:s1", "120")
    expect(inner.calls.set).toBe(0)
    await s.flush()
    expect(inner.calls.set).toBe(1)
  })

  test("pagehide 触发时会立即把窗口内仍在等待的待写值一并落盘（不是只影响之后的新写）", async () => {
    // 这条测试注册用的 setItem 发生在 pagehide 之前——覆盖的是 markUnloadingAndFlush 里
    // flushNow() 那一半职责：不仅要让"后续的写"透传，还要把"已经排队但还没到 400ms 窗口"的
    // 待写值立刻冲掉，否则最后一次修改仍然会随进程退出一起丢失。
    const inner = makeInner()
    const s = persistTesting.coalesceAsyncWrites(inner.storage)
    await s.setItem("scroll:s2", "88")
    expect(inner.calls.set).toBe(0)

    window.dispatchEvent(new Event("pagehide"))
    // markUnloadingAndFlush 内部是 fire-and-forget 的 void flushPersistedWrites()，
    // 等一轮事件循环让它的 Promise.all 落定。
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(inner.calls.set).toBe(1)
    expect(inner.values.get("scroll:s2")).toBe("88")
  })
})

describe("flushPersistedWrites 是合并写唯一的落盘兜底，必须真的落到 inner", () => {
  test("直接调用 flushPersistedWrites 会落掉所有仍在等待窗口的待写值，不必等 400ms 定时器", async () => {
    const inner = makeInner()
    const s = persistTesting.coalesceAsyncWrites(inner.storage)
    await s.setItem("draft", "typed")
    expect(inner.calls.set).toBe(0)

    await flushPersistedWrites()

    expect(inner.calls.set).toBe(1)
    expect(inner.values.get("draft")).toBe("typed")
  })

  test("对没有任何待写值的 storage 调用是无害的空操作", async () => {
    const inner = makeInner()
    persistTesting.coalesceAsyncWrites(inner.storage)
    await flushPersistedWrites()
    expect(inner.calls.set).toBe(0)
  })
})

describe("合并写的跨 store 共享待写缓冲（coalescedStorageFor 记忆化）", () => {
  afterEach(() => {
    persistTesting.coalescedStorages.clear()
  })

  test("同一个 storage 名两次调用返回同一个 wrapper 实例", () => {
    const inner = makeInner()
    const first = persistTesting.coalescedStorageFor("shared-store", inner.storage)
    const second = persistTesting.coalescedStorageFor("shared-store", inner.storage)
    expect(second).toBe(first)
  })

  test("不同 storage 名返回不同的 wrapper 实例", () => {
    const innerA = makeInner()
    const innerB = makeInner()
    const a = persistTesting.coalescedStorageFor("store-a", innerA.storage)
    const b = persistTesting.coalescedStorageFor("store-b", innerB.storage)
    expect(a).not.toBe(b)
  })

  test("A 的待写值对通过同一 storage 名拿到 wrapper 的 B 可见（否则跨 store 读回会拿到旧数据）", async () => {
    // 模拟同一个桌面 storage 名下先后创建的两个 persisted()：都会调 coalescedStorageFor(name, inner)，
    // 必须共享同一份 pending，否则后创建的那个读到的是 inner 里的旧值，把先创建的那个还没落盘的新值覆盖回去。
    const inner = makeInner()
    const walkA = persistTesting.coalescedStorageFor("shared-store", inner.storage)
    await walkA.setItem("settings.v3", '{"theme":"dark"}')
    expect(inner.calls.set).toBe(0) // 还没落盘，仍在缓冲里

    const walkB = persistTesting.coalescedStorageFor("shared-store", inner.storage)
    expect(await walkB.getItem("settings.v3")).toBe('{"theme":"dark"}')
  })
})

describe("合并写只限定在显式声明的 key 上，其余 store 保持直写", () => {
  // 合并写的动机只是逐键输入的草稿；设置/布局/会话元数据这类小改动大后果的 store
  // 必须继续「写入即落盘」，不能被批量套用 400ms 延迟窗口。
  test("desktopPersistedWrite：coalesce 未声明时直接调 setItemDurable，不进缓冲", async () => {
    const calls: string[] = []
    const current = { setItem: async () => void calls.push("buffered") }
    const durable = { setItemDurable: async () => void calls.push("durable") }

    await desktopPersistedWrite({ current, durable, key: "settings.v3", value: '{"theme":"dark"}' })

    expect(calls).toEqual(["durable"])
  })

  test("desktopPersistedWrite：coalesce=true 时走缓冲 setItem，不直接落盘", async () => {
    const calls: string[] = []
    const current = { setItem: async () => void calls.push("buffered") }
    const durable = { setItemDurable: async () => void calls.push("durable") }

    await desktopPersistedWrite({ coalesce: true, current, durable, key: "prompt", value: "typed" })

    expect(calls).toEqual(["buffered"])
  })

  test("非合并写 key 立即落到 inner，不需要等 400ms 窗口或手动 flush", async () => {
    const inner = makeInner()
    const wrapper = persistTesting.coalesceAsyncWrites(inner.storage)

    await desktopPersistedWrite({
      current: wrapper,
      durable: wrapper,
      key: "settings.v3",
      value: '{"theme":"dark"}',
    })

    expect(inner.calls.set).toBe(1)
    expect(inner.values.get("settings.v3")).toBe('{"theme":"dark"}')
  })

  test("声明合并写的 key 只进缓冲，要等 flush/到点才真正落盘", async () => {
    const inner = makeInner()
    const wrapper = persistTesting.coalesceAsyncWrites(inner.storage)

    await desktopPersistedWrite({ coalesce: true, current: wrapper, durable: wrapper, key: "prompt", value: "typed" })
    expect(inner.calls.set).toBe(0)

    await wrapper.flush()
    expect(inner.values.get("prompt")).toBe("typed")
  })
})

describe("合并写失败不再彻底静默丢弃", () => {
  test("flush 落盘失败时把 key 重新放回待写队列，下一个窗口自动重试", async () => {
    const values = new Map<string, string>()
    let failNext = true
    const flakyInner = {
      getItem: async (key: string) => values.get(key) ?? null,
      setItem: async (key: string, value: string) => {
        if (failNext) {
          failNext = false
          throw new Error("write failed")
        }
        values.set(key, value)
      },
      removeItem: async (key: string) => {
        values.delete(key)
      },
    }
    const wrapper = persistTesting.coalesceAsyncWrites(flakyInner)

    await wrapper.setItem("draft", "hello")
    await wrapper.flush()
    // 第一次落盘失败：旧行为是 .catch(() => undefined) 静默吞掉，值永久丢失。
    expect(values.has("draft")).toBe(false)

    // 失败重试会重新起一个 COALESCE_WRITE_MS 定时器，等到点自动再落一次盘。
    await new Promise((resolve) => setTimeout(resolve, persistTesting.COALESCE_WRITE_MS + 80))
    expect(values.get("draft")).toBe("hello")
  })
})
