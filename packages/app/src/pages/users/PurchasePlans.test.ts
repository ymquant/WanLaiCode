import { describe, expect, test } from "bun:test"
import { isPlanDowngradeFor, isPlanUpgradeFor, planSupportsImageGeneration } from "./purchase-plan-logic"
import type { PurchaseServicePlan, SoftwareEntitlement } from "./types"

function plan(input: Partial<PurchaseServicePlan>): PurchaseServicePlan {
  return { id: "plan-x", name: "套餐", ...input } as PurchaseServicePlan
}

function entitlement(input: {
  limit5h?: number
  limit7d?: number
  limit30d?: number
  groupId?: number
  sourcePlanId?: string
}): SoftwareEntitlement {
  return {
    product_code: "wanlaicode",
    entitlement_kind: "paid",
    status: "active",
    software_group_id: input.groupId,
    source_plan_id: input.sourcePlanId,
    usage: {
      five_hour: input.limit5h === undefined ? null : { limit_tokens: input.limit5h },
      seven_day: input.limit7d === undefined ? null : { limit_tokens: input.limit7d },
      thirty_day: input.limit30d === undefined ? null : { limit_tokens: input.limit30d },
    },
  } as SoftwareEntitlement
}

const M = 1_000_000

// 档位判定必须与后端 softwareMonthlyCapacityAtLeast 口径一致：仅比较 30 天月度额度。
// 逐窗口比较会把运营调高过窗口额度的账号（如 5h 被调到 8000M）的所有在售套餐都误判成降级。
describe("isPlanDowngradeFor 仅按 30 天月度额度判档", () => {
  test("运营调高 5h 额度的 Pro 用户,更高档 Max-20x 不判降级", () => {
    // 生产实况:权益快照 5h/7d/30d 全被调成 8000M,Max-20x 标称 200M/4000M/16000M
    const ent = entitlement({ limit5h: 8000 * M, limit7d: 8000 * M, limit30d: 8000 * M, groupId: 1 })
    const max20x = plan({
      softwareGroupId: 3,
      softwareTokenLimit5h: 200 * M,
      softwareTokenLimit7d: 4000 * M,
      softwareTokenLimit30d: 16000 * M,
    })
    expect(isPlanDowngradeFor(max20x, ent)).toBe(false)
    expect(isPlanUpgradeFor(max20x, ent)).toBe(true)
  })

  test("30 天月度额度更低才判降级", () => {
    const ent = entitlement({ limit5h: 8000 * M, limit7d: 8000 * M, limit30d: 8000 * M, groupId: 1 })
    const max5x = plan({
      softwareGroupId: 2,
      softwareTokenLimit5h: 90 * M,
      softwareTokenLimit7d: 1000 * M,
      softwareTokenLimit30d: 4000 * M,
    })
    expect(isPlanDowngradeFor(max5x, ent)).toBe(true)
    expect(isPlanUpgradeFor(max5x, ent)).toBe(false)
  })

  test("标准 Pro 用户升 Max-5x 是升级,买体验套餐是降级", () => {
    const ent = entitlement({ limit5h: 40 * M, limit7d: 200 * M, limit30d: 800 * M, groupId: 1 })
    const max5x = plan({
      softwareGroupId: 2,
      softwareTokenLimit5h: 90 * M,
      softwareTokenLimit7d: 1000 * M,
      softwareTokenLimit30d: 4000 * M,
    })
    const trial = plan({
      softwareGroupId: 7,
      softwareTokenLimit5h: 100 * M,
      softwareTokenLimit7d: 100 * M,
      softwareTokenLimit30d: 100 * M,
    })
    expect(isPlanDowngradeFor(max5x, ent)).toBe(false)
    expect(isPlanUpgradeFor(max5x, ent)).toBe(true)
    expect(isPlanDowngradeFor(trial, ent)).toBe(true)
  })

  test("体验套餐用户升 Pro:5h 窗口更低(40M<100M)不影响升级判定", () => {
    // 体验套餐把总量铺平到三个窗口(100M/100M/100M),Pro 的 5h 只有 40M;
    // 逐窗口比较会把月度容量大 8 倍的 Pro 误判成降级(后端已因此改为仅比 30 天)。
    const ent = entitlement({ limit5h: 100 * M, limit7d: 100 * M, limit30d: 100 * M, groupId: 7 })
    const pro = plan({
      softwareGroupId: 1,
      softwareTokenLimit5h: 40 * M,
      softwareTokenLimit7d: 200 * M,
      softwareTokenLimit30d: 800 * M,
    })
    expect(isPlanDowngradeFor(pro, ent)).toBe(false)
    expect(isPlanUpgradeFor(pro, ent)).toBe(true)
  })

  test("30 天额度 0/缺失视为无限(最高档),有限额度套餐判降级", () => {
    const ent = entitlement({ limit5h: 40 * M, limit7d: 200 * M, groupId: 1 })
    const max20x = plan({
      softwareGroupId: 3,
      softwareTokenLimit5h: 200 * M,
      softwareTokenLimit7d: 4000 * M,
      softwareTokenLimit30d: 16000 * M,
    })
    expect(isPlanDowngradeFor(max20x, ent)).toBe(true)
  })

  test("当前套餐续费不判降级:脏数据(group_id 不符 + 快照额度被调高)也不误拦", () => {
    // 复现截图账号:source_plan_id 命中 Pro,但 group_id 是脏数据(3),快照 30d 被运营调到 8000M。
    // Pro 卡即当前套餐,续费走 openPurchase 直接调 isPlanDowngradeFor,必须短路为非降级。
    const ent = entitlement({
      limit5h: 8000 * M,
      limit7d: 8000 * M,
      limit30d: 8000 * M,
      groupId: 3,
      sourcePlanId: "pro-plan-id",
    })
    const pro = plan({
      id: "pro-plan-id",
      softwareGroupId: 1,
      softwareTokenLimit5h: 40 * M,
      softwareTokenLimit7d: 200 * M,
      softwareTokenLimit30d: 800 * M,
    })
    expect(isPlanDowngradeFor(pro, ent)).toBe(false)
  })

  test("同套餐组不判降级,token 包不参与判定", () => {
    const ent = entitlement({ limit30d: 16000 * M, groupId: 3 })
    const sameGroup = plan({ softwareGroupId: 3, softwareTokenLimit30d: 16000 * M })
    const pack = plan({ tokenPackId: 9, softwareTokenLimit30d: 1 * M })
    expect(isPlanDowngradeFor(sameGroup, ent)).toBe(false)
    expect(isPlanDowngradeFor(pack, ent)).toBe(false)
  })

  test("非 paid/非 active/已过期权益不限制购买", () => {
    const trialKind = {
      ...entitlement({ limit30d: 16000 * M, groupId: 1 }),
      entitlement_kind: "trial",
    } as SoftwareEntitlement
    const expired = {
      ...entitlement({ limit30d: 16000 * M, groupId: 1 }),
      expires_at: "2000-01-01T00:00:00Z",
    } as SoftwareEntitlement
    const lowPlan = plan({ softwareGroupId: 7, softwareTokenLimit30d: 100 * M })
    expect(isPlanDowngradeFor(lowPlan, trialKind)).toBe(false)
    expect(isPlanDowngradeFor(lowPlan, expired)).toBe(false)
    expect(isPlanDowngradeFor(lowPlan, undefined)).toBe(false)
  })
})

describe("购买套餐生图能力展示", () => {
  test("只允许 WanlaiCode 产品族的真实软件套餐展示生图能力", () => {
    expect(
      planSupportsImageGeneration(plan({ softwareProductCodes: ["WanlaiCode"], allowImageGeneration: true })),
    ).toBe(true)
    // 产品编码兼容 storefront 当前存在的下划线写法，并覆盖 WanlaiCode 与 WanlaiCodex 两个客户端编码。
    expect(
      planSupportsImageGeneration(plan({ softwareProductCodes: ["wanlai_code"], allowImageGeneration: true })),
    ).toBe(true)
    expect(
      planSupportsImageGeneration(plan({ softwareProductCodes: ["wanlai_codex"], allowImageGeneration: true })),
    ).toBe(true)
    expect(
      planSupportsImageGeneration(
        plan({ tokenPackId: 9, softwareProductCodes: ["wanlaicode"], allowImageGeneration: true }),
      ),
    ).toBe(false)
    expect(
      planSupportsImageGeneration(plan({ softwareProductCodes: ["cursor"], allowImageGeneration: true })),
    ).toBe(false)
    // 购买接口的损坏数据必须 fail closed，字符串 true 不能冒充后台布尔能力字段。
    expect(
      planSupportsImageGeneration({
        softwareProductCodes: ["wanlaicode"],
        allowImageGeneration: "true",
      } as unknown as PurchaseServicePlan),
    ).toBe(false)
  })

  test("仅对后端明确开启生图的套餐显示能力标签", async () => {
    const source = await Bun.file(new URL("./PurchasePlans.tsx", import.meta.url)).text()
    const types = await Bun.file(new URL("./types.ts", import.meta.url)).text()

    // 套餐页是拒绝卡空态的最终落点，必须让用户直接看出哪个真实套餐支持生图。
    expect(types).toContain("allowImageGeneration?: boolean")
    expect(source).toContain("<Show when={planSupportsImageGeneration(plan)}>")
    expect(source).toContain('language.t("users.quota.imageGenerationSupported")')
    expect(source).toContain("border-border-success-base")
    expect(source).toContain("bg-icon-success-base")
    expect(source).toContain("...purchasePlansQuery(globalSDK.client)")
  })
})
