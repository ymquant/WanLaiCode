import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import {
  createSessionKeyReader,
  ensureSessionKey,
  projectOpenRequestDirectory,
  pruneSessionKeys,
  resolvePinnedSort,
  resolveSessionPanelOpened,
  resolveTreeExpanded,
} from "./layout"

describe("remote project open event", () => {
  test("只接受带有效目录的远控项目打开请求", () => {
    expect(
      projectOpenRequestDirectory({
        type: "project.open.requested",
        properties: { directory: "/Users/developer/Documents/New project" },
      }),
    ).toBe("/Users/developer/Documents/New project")
    expect(
      projectOpenRequestDirectory({ type: "project.open.requested", properties: { directory: "" } }),
    ).toBeUndefined()
    expect(
      projectOpenRequestDirectory({ type: "project.updated", properties: { directory: "/tmp/other" } }),
    ).toBeUndefined()
  })
})

describe("layout session-key helpers", () => {
  test("couples touch and scroll seed in order", () => {
    const calls: string[] = []
    const result = ensureSessionKey(
      "dir/a",
      (key) => calls.push(`touch:${key}`),
      (key) => calls.push(`seed:${key}`),
    )

    expect(result).toBe("dir/a")
    expect(calls).toEqual(["touch:dir/a", "seed:dir/a"])
  })

  test("reads dynamic accessor keys lazily", () => {
    const seen: string[] = []

    createRoot((dispose) => {
      const [key, setKey] = createSignal("dir/one")
      const read = createSessionKeyReader(key, (value) => seen.push(value))

      expect(read()).toBe("dir/one")
      setKey("dir/two")
      expect(read()).toBe("dir/two")

      dispose()
    })

    expect(seen).toEqual(["dir/one", "dir/two"])
  })
})

describe("pruneSessionKeys", () => {
  test("keeps active key and drops lowest-used keys", () => {
    const drop = pruneSessionKeys({
      keep: "k4",
      max: 3,
      used: new Map([
        ["k1", 1],
        ["k2", 2],
        ["k3", 3],
        ["k4", 4],
      ]),
      view: ["k1", "k2", "k4"],
      tabs: ["k1", "k3", "k4"],
    })

    expect(drop).toEqual(["k1"])
    expect(drop.includes("k4")).toBe(false)
  })

  test("does not prune without keep key", () => {
    const drop = pruneSessionKeys({
      keep: undefined,
      max: 1,
      used: new Map([
        ["k1", 1],
        ["k2", 2],
      ]),
      view: ["k1"],
      tabs: ["k2"],
    })

    expect(drop).toEqual([])
  })

  // 只开过面板的会话不会产生 sessionView/sessionTabs 记录：ensureKey 走 scroll.seed()，
  // 而 seed() 只写 createScrollPersistence 内部的内存 cache，store.sessionView 仅在真实滚动
  // （onFlush）或 pendingMessage.set 时才落库。若候选集合漏掉面板 map，这些会话永远进不了
  // drop，prune 里的 delete 形同虚设，持久化条目会突破 MAX_SESSION_KEYS 无上限增长。
  test("仅有面板记录（无 view/tabs）的会话也能被淘汰", () => {
    const panels = Array.from({ length: 5 }, (_, i) => `p${i}`)
    const drop = pruneSessionKeys({
      keep: "p4",
      max: 3,
      used: new Map(panels.map((key, i) => [key, i])),
      view: [],
      tabs: [],
      panels,
    })

    expect(drop.sort()).toEqual(["p0", "p1"])
    expect(drop.includes("p4")).toBe(false)
  })

  test("面板 key 与 view/tabs 去重后统一计入上限", () => {
    const drop = pruneSessionKeys({
      keep: "k3",
      max: 2,
      used: new Map([
        ["k1", 1],
        ["k2", 2],
        ["k3", 3],
      ]),
      view: ["k1"],
      tabs: ["k1"],
      panels: ["k1", "k2", "k3"],
    })

    expect(drop).toEqual(["k1"])
  })
})

describe("resolveTreeExpanded", () => {
  test("已 persist 的 key 优先生效", () => {
    expect(resolveTreeExpanded({ "/a": false }, "/a", { isActiveProject: true })).toBe(false)
  })

  test("未见过的 active project 默认展开", () => {
    expect(resolveTreeExpanded({}, "/a", { isActiveProject: true })).toBe(true)
  })

  test("未见过的非 active project 默认折叠", () => {
    expect(resolveTreeExpanded({}, "/a", { isActiveProject: false })).toBe(false)
  })

  test("workspace 首次见到时跟随 parent 状态", () => {
    expect(
      resolveTreeExpanded({ "/proj": true }, "/proj/ws", {
        isActiveProject: false,
        parentKey: "/proj",
      }),
    ).toBe(true)
  })
})

describe("resolveSessionPanelOpened", () => {
  test("未记录过的会话默认关闭", () => {
    expect(resolveSessionPanelOpened(undefined, "dir/a")).toBe(false)
    expect(resolveSessionPanelOpened({}, "dir/a")).toBe(false)
  })

  test("只读取当前会话自己的记录，不跨会话泄漏", () => {
    const map = { "dir/a": true }
    expect(resolveSessionPanelOpened(map, "dir/a")).toBe(true)
    expect(resolveSessionPanelOpened(map, "dir/b")).toBe(false)
  })

  test("显式关闭的会话保持关闭", () => {
    expect(resolveSessionPanelOpened({ "dir/a": false }, "dir/a")).toBe(false)
  })

  // store 默认值是 {}，空对象没有已知 key，persist 的 merge() 会把持久化里的每个 sessionKey
  // 走「未知键」分支原样透传、不做类型校验。旧版本或手工写坏的值必须在取值处挡住，
  // 否则 `"false"` 这类字符串会被下游 truthy 判断当成「面板打开」。
  test("损坏的持久化值一律视为关闭，不被 truthy 误判", () => {
    const corrupted = (value: unknown) => ({ "dir/a": value }) as unknown as Record<string, boolean>

    expect(resolveSessionPanelOpened(corrupted("false"), "dir/a")).toBe(false)
    expect(resolveSessionPanelOpened(corrupted("true"), "dir/a")).toBe(false)
    expect(resolveSessionPanelOpened(corrupted(1), "dir/a")).toBe(false)
    expect(resolveSessionPanelOpened(corrupted({}), "dir/a")).toBe(false)
    expect(resolveSessionPanelOpened(corrupted(null), "dir/a")).toBe(false)
  })
})

// 弱证据：源码级断言。真正的 bug 不在 resolveSessionPanelOpened 里，而在 view() 的接线上
// —— 原实现把 reviewPanel.opened 接到全局 store.review.panelOpened，helper 再正确也拦不住。
// provider 依赖 persisted/platform，无法在当前 harness 里实例化做行为测试，因此用源码断言兜住
// 「未来有人把接线改回全局字段」这一种回归。它不能证明运行时行为，只能证明接线读的是哪个字段。
describe("会话级审查面板接线（源码级弱断言）", () => {
  test("reviewPanel 读写都走 reviewPanelBySession，不回退全局 review.panelOpened", async () => {
    const source = await Bun.file(new URL("./layout.tsx", import.meta.url)).text()
    const view = source.indexOf("view(sessionKey: string | Accessor<string>)")
    expect(view).toBeGreaterThan(-1)
    const body = source.slice(view)

    // opened 取值必须按 sessionKey 索引
    expect(body).toContain("resolveSessionPanelOpened(store.reviewPanelBySession, key())")
    // 写入必须落到 per-session map
    expect(body).toContain('setStore("reviewPanelBySession", sessionId, next)')
    // 不得再读旧的全局字段，也不得出现与 store 默认值相反的 `?? true` 兜底
    expect(body).not.toContain("store.review?.panelOpened")
    expect(body).not.toContain("panelOpened ?? true")
  })

  test("store 默认值与 getter 兜底一致为关闭", async () => {
    const source = await Bun.file(new URL("./layout.tsx", import.meta.url)).text()
    expect(source).toContain("reviewPanelBySession: {} as Record<string, boolean>")
    expect(source).toContain("opened: createMemo(() => store.fileTree?.opened ?? false)")
    expect(source).not.toContain("store.fileTree?.opened ?? true")
  })

  test("prune 会连带清理两个会话级面板记录，避免持久化条目无上限增长", async () => {
    const source = await Bun.file(new URL("./layout.tsx", import.meta.url)).text()
    expect(source).toContain("delete draft.reviewPanelBySession[key]")
    // 两个 per-session map 的清理必须对称，否则文档承诺的「与 terminalBySession 模式一致」不成立
    expect(source).toContain("delete draft.terminalBySession[key]")
    // 候选集合必须覆盖两个 map，否则上面的 delete 对「只开过面板」的会话不可达
    expect(source).toContain("Object.keys(store.reviewPanelBySession ?? {})")
    expect(source).toContain("Object.keys(store.terminalBySession ?? {})")
  })
})

describe("resolvePinnedSort", () => {
  test("pinned 项目排到前面，保持各自原相对顺序", () => {
    const projects = ["/a", "/b", "/c", "/d"]
    const pinned = ["/c"]
    expect(resolvePinnedSort(projects, pinned)).toEqual(["/c", "/a", "/b", "/d"])
  })

  test("无 pinned 不改顺序", () => {
    expect(resolvePinnedSort(["/a", "/b"], [])).toEqual(["/a", "/b"])
  })

  test("多个 pinned 按 pinned 数组顺序排前", () => {
    expect(resolvePinnedSort(["/a", "/b", "/c"], ["/c", "/a"])).toEqual(["/c", "/a", "/b"])
  })

  test("pinned 含不在 projects 的 worktree 时忽略", () => {
    expect(resolvePinnedSort(["/a", "/b"], ["/x", "/a"])).toEqual(["/a", "/b"])
  })
})
