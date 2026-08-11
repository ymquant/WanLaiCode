import { describe, expect, test } from "bun:test"
import { followupSendNowDisabled, followupSendNowTooltip } from "@/pages/session/followup-queue"

// 组件本身是纯 props 渲染（SessionFollowupRow），仓库没有 Solid 渲染测试基座；
// 真正的行为——按钮禁用与否、tooltip 取哪条文案——已经抽成两个纯函数供组件调用，
// 这里直接测函数行为，不再对组件源码做字符串匹配。
describe("压缩中禁用引导按钮：followupSendNowDisabled", () => {
  test("既不发送中也没有禁用原因时可点击", () => {
    expect(followupSendNowDisabled({ sendingAny: false })).toBe(false)
  })

  test("发送中禁用（防重复点击）", () => {
    expect(followupSendNowDisabled({ sendingAny: true })).toBe(true)
  })

  test("压缩等原因存在时禁用，即使当前没有正在发送的项", () => {
    expect(followupSendNowDisabled({ sendingAny: false, steerDisabledReason: "压缩中" })).toBe(true)
  })

  test("发送中且带禁用原因，仍是禁用（两个条件是或非与）", () => {
    expect(followupSendNowDisabled({ sendingAny: true, steerDisabledReason: "压缩中" })).toBe(true)
  })
})

describe("压缩中禁用引导按钮：followupSendNowTooltip", () => {
  test("没有禁用原因时用默认 tooltip 文案", () => {
    expect(followupSendNowTooltip({ defaultTooltip: "立即发送" })).toBe("立即发送")
  })

  test("有禁用原因时原因文案优先于默认 tooltip", () => {
    expect(
      followupSendNowTooltip({ steerDisabledReason: "正在压缩会话，压缩完成后才能引导", defaultTooltip: "立即发送" }),
    ).toBe("正在压缩会话，压缩完成后才能引导")
  })
})

describe("SessionFollowupRow 接线到上述纯函数（防止组件内联出第二套不同步的判断逻辑）", () => {
  test("disabled/tooltip 都调用共享的纯函数，而不是各自内联表达式", async () => {
    const src = await Bun.file(new URL("./session-followup-dock.tsx", import.meta.url)).text()
    expect(src).toContain("followupSendNowDisabled({")
    expect(src).toContain("followupSendNowTooltip({")
  })
})
