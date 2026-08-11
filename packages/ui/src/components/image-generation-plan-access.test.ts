import { describe, expect, test } from "bun:test"
import {
  formatImageGenerationPlanNames,
  parseImageGenerationMetadataFlag,
  parseImageGenerationStorefrontPlans,
  parseImageGenerationUpgradePlans,
  resolveImageGenerationUpgradeTarget,
  safeImageGenerationPurchaseUrl,
} from "./image-generation-plan-access"

describe("image generation plan access", () => {
  test("只接受带真实名称、价格和 ID 的升级套餐", () => {
    expect(
      parseImageGenerationUpgradePlans([
        { id: "pro", name: " Pro 套餐 ", price: 98, validityDays: 30, validityUnit: "month" },
        { id: "max", name: "Max 套餐", price: "198", validityDays: 90 },
        { id: "missing-price", name: "缺价格" },
        { id: "negative", name: "负价格", price: -1 },
        null,
      ]),
    ).toEqual([
      { id: "pro", name: "Pro 套餐", price: 98, validityDays: 30, validityUnit: "month" },
      { id: "max", name: "Max 套餐", price: 198, validityDays: 90 },
    ])
  })

  test("真实套餐缓存只保留 WanlaiCode 产品族中明确支持生图的软件套餐", () => {
    expect(
      parseImageGenerationStorefrontPlans([
        { id: "c1", name: "c1", price: 10, allowImageGeneration: false, softwareProductCodes: ["wanlai_code"] },
        { id: "c2", name: "c2", price: 20, allowImageGeneration: true, softwareProductCodes: ["wanlai_code"] },
        { id: "cursor", name: "Cursor", price: 30, allowImageGeneration: true, softwareProductCodes: ["cursor"] },
        {
          id: "pack",
          name: "Token 包",
          price: 40,
          tokenPackId: 9,
          allowImageGeneration: true,
          softwareProductCodes: ["wanlaicode"],
        },
      ]),
    ).toEqual([{ id: "c2", name: "c2", price: 20 }])
    expect(formatImageGenerationPlanNames([{ id: "c2", name: "c2", price: 20 }], "zh-CN")).toBe("c2")
  })

  test("升级入口优先 app 内回调，再安全回退 HTTP 外链", () => {
    expect(
      resolveImageGenerationUpgradeTarget({
        supportedPlans: [{ id: "pro", name: "Pro 套餐", price: 98 }],
        upgradePlans: [{ id: "pro", name: "Pro 套餐", price: 98 }],
        purchaseEnabled: true,
        planCatalogAvailable: true,
        hasInAppHandler: true,
        hasExternalHandler: true,
        purchaseUrl: "https://pay.example.com/purchase",
      }),
    ).toEqual({ type: "in-app" })
    expect(
      resolveImageGenerationUpgradeTarget({
        supportedPlans: [{ id: "pro", name: "Pro 套餐", price: 98 }],
        upgradePlans: [{ id: "pro", name: "Pro 套餐", price: 98 }],
        purchaseEnabled: true,
        planCatalogAvailable: true,
        hasInAppHandler: false,
        hasExternalHandler: true,
        purchaseUrl: "https://pay.example.com/purchase",
      }),
    ).toEqual({ type: "external", url: "https://pay.example.com/purchase" })
    expect(safeImageGenerationPurchaseUrl("javascript:alert(1)")).toBeUndefined()
    expect(
      resolveImageGenerationUpgradeTarget({
        supportedPlans: [{ id: "pro", name: "Pro 套餐", price: 98 }],
        upgradePlans: [{ id: "pro", name: "Pro 套餐", price: 98 }],
        purchaseEnabled: true,
        planCatalogAvailable: true,
        hasInAppHandler: false,
        hasExternalHandler: false,
        purchaseUrl: "https://pay.example.com/purchase",
      }),
    ).toBeUndefined()
  })

  test("购买关闭或目录确认没有支持套餐时不提供入口", () => {
    expect(
      resolveImageGenerationUpgradeTarget({
        supportedPlans: [{ id: "pro", name: "Pro 套餐", price: 98 }],
        upgradePlans: [{ id: "pro", name: "Pro 套餐", price: 98 }],
        purchaseEnabled: true,
        planCatalogAvailable: true,
        hasInAppHandler: false,
        hasExternalHandler: true,
        purchaseUrl: "",
      }),
    ).toBeUndefined()
    expect(
      resolveImageGenerationUpgradeTarget({
        supportedPlans: [],
        upgradePlans: [],
        purchaseEnabled: true,
        planCatalogAvailable: true,
        hasInAppHandler: true,
        hasExternalHandler: true,
        purchaseUrl: "https://pay.example.com/purchase",
      }),
    ).toBeUndefined()
  })

  test("套餐目录加载失败时保留进入套餐页查看的入口", () => {
    // 目录失败不代表购买关闭；即使旧消息没有外链，应用内套餐页仍由现有权益与降级规则决定能否购买。
    expect(
      resolveImageGenerationUpgradeTarget({
        supportedPlans: [],
        upgradePlans: [],
        purchaseEnabled: true,
        planCatalogAvailable: false,
        hasInAppHandler: true,
        hasExternalHandler: true,
        purchaseUrl: undefined,
      }),
    ).toEqual({ type: "in-app" })
  })

  test("支持套餐不可直接升级时仍提供查看套餐的文字入口", () => {
    // c2 可能因额度较低不进入 upgradePlans，但查看套餐页不会绕过页面内的降级购买拦截。
    expect(
      resolveImageGenerationUpgradeTarget({
        supportedPlans: [{ id: "c2", name: "c2", price: 20 }],
        upgradePlans: [],
        purchaseEnabled: true,
        planCatalogAvailable: true,
        hasInAppHandler: true,
        hasExternalHandler: true,
        purchaseUrl: "https://pay.example.com/purchase",
      }),
    ).toEqual({ type: "in-app" })
  })

  test("后台明确关闭购买时忽略残留套餐和地址", () => {
    // 关闭开关优先级最高，避免历史 metadata 中的旧 URL 重新打开已停用入口。
    expect(
      resolveImageGenerationUpgradeTarget({
        supportedPlans: [{ id: "pro", name: "Pro 套餐", price: 98 }],
        upgradePlans: [{ id: "pro", name: "Pro 套餐", price: 98 }],
        purchaseEnabled: false,
        planCatalogAvailable: false,
        hasInAppHandler: true,
        hasExternalHandler: true,
        purchaseUrl: "https://pay.example.com/purchase",
      }),
    ).toBeUndefined()
  })

  test("旧会话缺少三态字段时不新增空目录入口", () => {
    expect(parseImageGenerationMetadataFlag(undefined)).toBeUndefined()
    expect(parseImageGenerationMetadataFlag("false")).toBeUndefined()
    expect(parseImageGenerationMetadataFlag(false)).toBe(false)
    expect(
      resolveImageGenerationUpgradeTarget({
        supportedPlans: [],
        upgradePlans: [],
        purchaseEnabled: undefined,
        planCatalogAvailable: undefined,
        hasInAppHandler: true,
        hasExternalHandler: true,
        purchaseUrl: "https://pay.example.com/purchase",
      }),
    ).toBeUndefined()
    // 历史会话原本已有真实升级套餐时，继续保留旧版本已经提供的购买入口。
    expect(
      resolveImageGenerationUpgradeTarget({
        supportedPlans: [],
        upgradePlans: [{ id: "pro", name: "Pro 套餐", price: 98 }],
        purchaseEnabled: undefined,
        planCatalogAvailable: undefined,
        hasInAppHandler: true,
        hasExternalHandler: true,
        purchaseUrl: "https://pay.example.com/purchase",
      }),
    ).toEqual({ type: "in-app" })
  })
})
