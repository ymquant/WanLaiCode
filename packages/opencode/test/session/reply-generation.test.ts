import { describe, expect, test } from "bun:test"
import { createReplyGenerationTracker } from "@/session/reply-generation"

describe("reply generation tracker", () => {
  test("releases handled generations after every completed reply", () => {
    const tracker = createReplyGenerationTracker()

    // 模拟长生命周期会话连续完成大量失败回复；每轮结束后都不能遗留会话级去重状态。
    const generations = Array.from({ length: 256 }, (_, index) => {
      const generation = tracker.begin("session-long")
      tracker.markHandled("session-long", generation)
      expect(tracker.handled("session-long", generation)).toBe(true)
      tracker.finish("session-long", generation)
      expect(tracker.size(), `reply ${index + 1}`).toBe(0)
      return generation
    })
    // 清理会话状态后也不能复用身份，否则迟到的 scheduled finalizer 可能误删后来回合。
    expect(new Set(generations).size).toBe(generations.length)
  })

  test("keeps an older handled generation until its overlapping reply finishes", () => {
    const tracker = createReplyGenerationTracker()
    const older = tracker.begin("session-overlap")
    const newer = tracker.begin("session-overlap")
    // 任一重叠回复仍存活时，会话必须保持可观测的活动代次。
    expect(tracker.active("session-overlap")).toBe(true)
    tracker.markHandled("session-overlap", older)

    // 新回复先结束时仍要保留旧 runner 的去重身份，防止迟到 waiter 重复发布同一个错误。
    tracker.finish("session-overlap", newer)
    expect(tracker.handled("session-overlap", older)).toBe(true)
    expect(tracker.size()).toBe(1)

    tracker.finish("session-overlap", older)
    expect(tracker.size()).toBe(0)
    expect(tracker.active("session-overlap")).toBe(false)
  })

  test("invalidates a live reply without retaining idle sessions", () => {
    const tracker = createReplyGenerationTracker()
    tracker.invalidate("session-idle")
    expect(tracker.size()).toBe(0)

    const generation = tracker.begin("session-active")
    tracker.invalidate("session-active")

    // stop/shell 推进当前代次后，旧回复的无 runID 兜底必须失效，活动回复结束后状态随即释放。
    expect(tracker.current("session-active", generation)).toBe(false)
    tracker.finish("session-active", generation)
    expect(tracker.size()).toBe(0)
  })
})
