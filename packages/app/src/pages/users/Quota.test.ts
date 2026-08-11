import { describe, expect, test } from "bun:test"
import { entitlementSupportsImageGeneration } from "./types"

describe("个人中心当前套餐生图能力", () => {
  test("仅后端明确返回 allow_image_generation=true 时视为支持生图", () => {
    expect(entitlementSupportsImageGeneration({ allow_image_generation: true })).toBe(true)
    expect(entitlementSupportsImageGeneration({ allow_image_generation: false })).toBe(false)
    expect(entitlementSupportsImageGeneration({})).toBe(false)
    expect(entitlementSupportsImageGeneration({ allow_image_generation: "true" })).toBe(false)
  })

  test("当前套餐卡片通过统一能力判断渲染设计令牌标签", async () => {
    const source = await Bun.file(new URL("./Quota.tsx", import.meta.url)).text()
    const zh = await Bun.file(new URL("../../i18n/zh.ts", import.meta.url)).text()

    // 标签必须绑定后端权益判断，同时保留原套餐描述与升级入口，避免新增能力展示破坏既有交互。
    expect(source).toContain("<Show when={entitlementSupportsImageGeneration(item())}>")
    expect(source).toContain("<Tag")
    expect(source).toContain('size="large"')
    expect(source).toContain('language.t("users.quota.imageGenerationSupported")')
    expect(source).toContain("border-border-success-base")
    expect(source).toContain("bg-surface-diff-add-base")
    expect(source).toContain("bg-icon-success-base")
    expect(source).toContain("text-text-strong")
    expect(source).toContain('language.t("users.quota.planDescription"')
    expect(source).toContain('language.t("users.actions.upgrade")')
    expect(zh).toContain('"users.quota.imageGenerationSupported": "支持生图"')
  })
})
