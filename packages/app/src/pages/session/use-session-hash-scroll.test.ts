import { describe, expect, test } from "bun:test"
import type { UserMessage } from "@opencode-ai/sdk/v2"
import { messageIdFromHash, resolveMessageHashTarget } from "./message-id-from-hash"
import { scrollSessionElement } from "./session-element-scroll"

const user = (id: string) => ({ id, role: "user" }) as UserMessage

describe("messageIdFromHash", () => {
  test("parses hash with leading #", () => {
    expect(messageIdFromHash("#message-abc123")).toBe("abc123")
  })

  test("parses raw hash fragment", () => {
    expect(messageIdFromHash("message-42")).toBe("42")
  })

  test("ignores non-message anchors", () => {
    expect(messageIdFromHash("#review-panel")).toBeUndefined()
  })
})

describe("resolveMessageHashTarget", () => {
  test("uses the logical turn anchor while preserving a steer target", () => {
    const result = resolveMessageHashTarget({
      messageID: "steer-2",
      visibleUserMessages: [user("root-1")],
      messageAnchorID: (messageID) => (messageID === "steer-2" ? "root-1" : undefined),
    })

    // 历史窗口应展开 root 所在行，但浏览器最终仍定位到 turn 内的 steer 气泡。
    expect(result).toEqual({ message: user("root-1"), targetMessageID: "steer-2" })
  })
})

describe("scrollSessionElement", () => {
  test("places every timeline target below the sticky session title", () => {
    const root = document.createElement("div")
    const title = document.createElement("div")
    const target = document.createElement("div")
    title.setAttribute("data-session-title", "")
    root.append(title, target)
    document.body.replaceChildren(root)
    root.scrollTop = 120
    Object.defineProperty(title, "offsetHeight", { configurable: true, value: 48 })
    root.getBoundingClientRect = () => new DOMRect(0, 100)
    target.getBoundingClientRect = () => new DOMRect(0, 500)
    let scroll: ScrollToOptions | undefined
    // happy-dom 不记录 scrollTo 参数，这里只替换实例方法以观察真实 helper 的最终写入。
    Object.defineProperty(root, "scrollTo", { value: (options: ScrollToOptions) => (scroll = options) })

    // hash、Minimap 与命令面板复用同一 helper 后，三者都会得到 500 - 100 + 120 - 48。
    scrollSessionElement({ root, target, behavior: "smooth" })

    expect(scroll).toEqual({ top: 472, behavior: "smooth" })
  })

  test("clamps targets above the scroll root to zero", () => {
    const root = document.createElement("div")
    const target = document.createElement("div")
    root.append(target)
    document.body.replaceChildren(root)
    root.scrollTop = 20
    root.getBoundingClientRect = () => new DOMRect(0, 100)
    target.getBoundingClientRect = () => new DOMRect(0, 30)
    let scroll: ScrollToOptions | undefined
    // 同样只观察实例级 scrollTo，不修改全局 DOM 原型，避免测试之间互相污染。
    Object.defineProperty(root, "scrollTo", { value: (options: ScrollToOptions) => (scroll = options) })

    // 深链目标位于可滚动起点之前时不能产生负 scrollTop。
    scrollSessionElement({ root, target, behavior: "auto" })

    expect(scroll).toEqual({ top: 0, behavior: "auto" })
  })
})

// 跳转后 hash 一直留在 URL 里，而驱动跳转的两个 effect 都依赖消息流，每次更新都会重跑。
// 若照 hash 无条件跳，正在向上滚动阅读的用户会被反复拽回消息头部。
// 判据必须是「这个 hash 兑现过没有」而不是「用户在不在阅读」—— 后者会让深链到
// 尚未加载的消息永久失效：applyHash 里的 pause() 自己把 userScrolled 置真，
// 回填到位后的补跳反被这个守卫挡死。
describe("hash-driven jumps", () => {
  test("only fulfils a given hash once", async () => {
    const source = await Bun.file(new URL("./use-session-hash-scroll.ts", import.meta.url)).text()

    expect(source).toContain("if (hash === appliedHash) return")
    expect(source).toContain(
      "if (!targetId && !clearing && location.hash.slice(1) !== appliedHash) {\n      targetId = messageIdFromHash(location.hash)\n    }",
    )
  })

  test("only marks a hash as applied after the scroll actually happened", async () => {
    const source = await Bun.file(new URL("./use-session-hash-scroll.ts", import.meta.url)).text()

    // 目标还没加载出来时既不能 pause 也不能记账，否则回填后的补跳会失效。
    expect(source).toContain("if (!target) return\n      input.autoScroll.pause()")

    // 消息在数据里 ≠ DOM anchor 已渲染。seek 只重试 4 帧，渲染更慢时会放弃；
    // 若那时已记账，两个 effect 都会跳过后续重试，深链永久失效。
    expect(source).toContain(
      "scrollToMessage(target.message, behavior, target.targetMessageID, (scrolled) => {\n        if (scrolled) appliedHash = hash\n      })",
    )
    expect(source).toContain("if (scrolled) appliedHash = anchorHash")
    expect(source).toContain("onSettled?: (scrolled: boolean) => void")
  })

  test("drops the applied hash when the hash is cleared or the session changes", async () => {
    const source = await Bun.file(new URL("./use-session-hash-scroll.ts", import.meta.url)).text()

    expect(source).toContain('cancel()\n    appliedHash = ""')
    expect(source).toContain('appliedHash = ""\n        input.autoScroll.reset()')
  })
})
