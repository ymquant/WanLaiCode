import { describe, expect, test } from "bun:test"

// 回归守卫:计划 Popover 必须是 modal。
// 它被用在「手动创建」的模态 CdxModal(Kobalte Dialog,带 focus-trap)内,且 portal 到 body;
// 非 modal 时 Dialog 的 focus-trap 会把焦点拽回 → 自定义 Popover 的 onFocusIn 判为「外部」→ 弹窗一开就闪退。
// modal 让 Kobalte 把焦点锁在 popover 内,杜绝这次抢焦点。详见 ui/components/popover.tsx 的 onFocusIn。
describe("schedule popover", () => {
  test("CdxSchedulePill 的 Popover 标记为 modal(否则在创建弹窗里会闪退)", async () => {
    const src = await Bun.file(new URL("./schedule-popover.tsx", import.meta.url)).text()
    const open = src.indexOf("<Popover")
    const tag = src.slice(open, src.indexOf("trigger={", open))
    // 必须是独立的 modal 属性行,而非注释里的 "modal" 字样
    expect(tag).toMatch(/\n\s*modal\s*\n/)
  })
})
