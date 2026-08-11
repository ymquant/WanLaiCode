import { describe, expect, test } from "bun:test"
import { autoScrollAction, shouldHoldUserControl } from "./create-auto-scroll"

// userScrolled 表示「用户正在向上滚动阅读」。它一旦被误清，下一次 ResizeObserver
// 就会把正在阅读的用户拽到底部；一旦该清不清，新会话会既不落底也无法自救。
// 两个方向都出过问题，这里锁住清除路径。
describe("create-auto-scroll reading state", () => {
  test("does not clear userScrolled just because the container cannot scroll right now", async () => {
    const source = await Bun.file(new URL("./create-auto-scroll.tsx", import.meta.url)).text()

    // DOM 重建、工具卡片重组、content-visibility 切换都会让 scrollHeight 有一帧塌到
    // clientHeight。若在这一帧清掉 userScrolled，正在阅读的用户会被拽到底部。
    expect(source).not.toContain('if (!canScroll(el)) {\n      if (store.userScrolled) setStore("userScrolled", false)')
  })

  test("restores bottom-following only when the user scrolls back near the bottom", () => {
    expect(autoScrollAction({ distance: 9, threshold: 10, userGesture: true, userScrolled: true, auto: false })).toBe(
      "resume",
    )
    expect(autoScrollAction({ distance: 10, threshold: 10, userGesture: true, userScrolled: true, auto: false })).toBe(
      "pause",
    )
  })

  test("reset clears the reading state without scrolling", async () => {
    const source = await Bun.file(new URL("./create-auto-scroll.tsx", import.meta.url)).text()

    // 实例跨会话存活，切换会话必须清掉上一个会话的阅读状态；但不能顺手滚动，
    // 否则会和 hash 定位抢位置。
    const reset = source.slice(source.indexOf("reset: () => {"), source.indexOf("consumeReset:"))
    expect(reset).toContain('setStore("userScrolled", false)')
    expect(reset).not.toContain("scrollToBottom")
  })

  test("reset is distinguishable from the user scrolling back to the bottom", async () => {
    const source = await Bun.file(new URL("./create-auto-scroll.tsx", import.meta.url)).text()

    // 观察 userScrolled 翻回 false 的一方会把它当成「用户滚回底部了」并清掉 URL hash。
    // 切会话的程序化重置若不加区分，会把刚打开的会话上的深链目标一并抹掉。
    expect(source).toContain("resetConsumed = true")
    expect(source).toContain("consumeReset: () => {")
    // 读取即消费，否则会误吞下一次真正由用户触发的转换。
    expect(source).toContain("resetConsumed = false\n      return value")
  })

  test("leaves upward compensation to native scroll anchoring", async () => {
    const source = await Bun.file(new URL("./create-auto-scroll.tsx", import.meta.url)).text()

    // 用户向上阅读期间本 hook 完全不动 scrollTop——视口上方的高度变化由浏览器原生
    // 滚动锚定补偿。曾经在这里加过一层 JS 兜底，它自身的锚点基准会与实际滚动位置
    // 脱钩并主动制造跳变，已移除。
    expect(source).toContain("if (store.userScrolled) return\n      if (!active()) return")
    expect(source).not.toContain("elementFromPoint")
  })

  test("lets a confirmed user scroll override a stale automatic scroll marker", () => {
    // 流式更新可能刚写过 scrollTop，自动标记仍在 1.5 秒有效期内；真实手势不能因此被误判成程序滚动。
    expect(autoScrollAction({ distance: 240, threshold: 10, userGesture: true, userScrolled: false, auto: true })).toBe(
      "pause",
    )
  })

  test("keeps programmatic scrolling attached and resumes when the user reaches the bottom", () => {
    expect(
      autoScrollAction({ distance: 240, threshold: 10, userGesture: false, userScrolled: false, auto: true }),
    ).toBe("follow")
    // 用户拖拽或连续向下滚动到阈值内时恢复跟随，后续 token 继续自然贴底。
    expect(autoScrollAction({ distance: 4, threshold: 10, userGesture: true, userScrolled: true, auto: true })).toBe(
      "resume",
    )
  })

  test("resumes immediately when a confirmed gesture reaches the bottom", () => {
    // 官方 Codex 到达底部后立即进入 user_follow，后续 token 增高必须继续贴底。
    expect(
      autoScrollAction({
        distance: 4,
        threshold: 10,
        userGesture: true,
        userControl: true,
        direction: "toward",
        userScrolled: true,
        auto: true,
      }),
    ).toBe("resume")
    // 没有真实手势确认时仍保留惯性窗口，不能让程序滚动自行解除用户控制。
    expect(
      autoScrollAction({
        distance: 4,
        threshold: 10,
        userGesture: false,
        userControl: true,
        direction: "toward",
        userScrolled: true,
        auto: true,
      }),
    ).toBe("hold")
    expect(
      autoScrollAction({
        distance: 120,
        threshold: 10,
        userGesture: true,
        userControl: true,
        direction: "toward",
        userScrolled: false,
        auto: true,
      }),
    ).toBe("pause")
  })

  test("keeps a light upward gesture detached inside the bottom threshold", () => {
    // 从底部只向上移动 4px 仍是明确的阅读意图，不能因为距离小于 10px 就恢复并抖回底部。
    expect(
      autoScrollAction({
        distance: 4,
        threshold: 10,
        userGesture: true,
        userControl: true,
        direction: "away",
        userScrolled: true,
        auto: true,
      }),
    ).toBe("pause")
  })

  test("does not acquire the user-control window for a downward gesture already at the bottom", () => {
    expect(shouldHoldUserControl({ distance: 4, threshold: 10, direction: "toward" })).toBe(false)
    // 同一位置的向上手势必须在浏览器改变 scrollTop 前暂停，避免流式更新抢回位置。
    expect(shouldHoldUserControl({ distance: 4, threshold: 10, direction: "away" })).toBe(true)
    expect(shouldHoldUserControl({ distance: 80, threshold: 10, direction: "toward" })).toBe(true)
  })
})
