import { describe, expect, test } from "bun:test"
import {
  conversationMinimapIndexAtOffset,
  conversationMinimapTop,
  shouldShowConversationMinimap,
} from "./conversation-minimap"

describe("shouldShowConversationMinimap", () => {
  test("keeps the preview entry for a single logical turn", () => {
    // 连续引导归入同一 turn 后一级条目会收敛为一个，不能因此让用户失去 Minimap 入口。
    expect(shouldShowConversationMinimap(1)).toBe(true)
    expect(shouldShowConversationMinimap(0)).toBe(false)
  })

  test("drives the production minimap visibility guard", async () => {
    const source = await Bun.file(new URL("./message-timeline.tsx", import.meta.url)).text()

    // 生产组件必须复用经过单 turn 验证的判定，防止以后又退回大于一个条目才显示。
    expect(source).toContain("<Show when={shouldShowConversationMinimap(props.items().length)}>")
  })

  test("uses the session panel width instead of the viewport breakpoint", async () => {
    const source = await Bun.file(new URL("./message-timeline.tsx", import.meta.url)).text()
    const styles = await Bun.file(new URL("../../index.css", import.meta.url)).text()

    // 项目侧栏属于 viewport、却不属于会话可用空间；显示规则必须读取现有 @container session panel。
    expect(source).not.toContain("hidden xl:block")
    expect(styles).toContain('@container (min-width: 928px)')
    expect(styles).toContain('[data-card-open="true"] [data-component="conversation-minimap"]')
  })
})

describe("conversationMinimapIndexAtOffset", () => {
  test("centers and hits the only logical turn", () => {
    const height = 220
    const center = conversationMinimapTop({ index: 0, total: 1, height })

    // 单条 Minimap 没有 step 间距，必须固定在轨道中心，并保留完整 10px 命中高度。
    expect(center).toBe(height / 2)
    expect(conversationMinimapIndexAtOffset({ pointer: center - 5, total: 1, height })).toBe(0)
    expect(conversationMinimapIndexAtOffset({ pointer: center + 5, total: 1, height })).toBe(0)
    expect(conversationMinimapIndexAtOffset({ pointer: center - 6, total: 1, height })).toBeUndefined()
    expect(conversationMinimapIndexAtOffset({ pointer: center + 6, total: 1, height })).toBeUndefined()
  })

  test("ignores the blank space above and below the rendered bars", () => {
    const total = 4
    const height = 220
    const first = conversationMinimapTop({ index: 0, total, height })
    const last = conversationMinimapTop({ index: total - 1, total, height })

    expect(conversationMinimapIndexAtOffset({ pointer: first - 6, total, height })).toBeUndefined()
    expect(conversationMinimapIndexAtOffset({ pointer: last + 6, total, height })).toBeUndefined()
  })

  test("keeps the full bar height interactive", () => {
    const total = 4
    const height = 220
    const first = conversationMinimapTop({ index: 0, total, height })
    const last = conversationMinimapTop({ index: total - 1, total, height })

    expect(conversationMinimapIndexAtOffset({ pointer: first - 5, total, height })).toBe(0)
    expect(conversationMinimapIndexAtOffset({ pointer: last + 5, total, height })).toBe(total - 1)
  })

  test("selects the nearest bar while moving inside the track", () => {
    const total = 4
    const height = 220
    const second = conversationMinimapTop({ index: 1, total, height })
    const third = conversationMinimapTop({ index: 2, total, height })

    expect(conversationMinimapIndexAtOffset({ pointer: second + (third - second) * 0.4, total, height })).toBe(1)
    expect(conversationMinimapIndexAtOffset({ pointer: second + (third - second) * 0.6, total, height })).toBe(2)
  })
})
