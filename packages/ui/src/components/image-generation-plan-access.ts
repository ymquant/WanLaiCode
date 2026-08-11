export type ImageGenerationUpgradePlan = {
  id: string
  name: string
  price: number
  validityDays?: number
  validityUnit?: string
}

type ImageGenerationUpgradeTarget =
  | { type: "in-app" }
  | {
      type: "external"
      url: string
    }

const wanlaiCodeProductKeys = new Set(["wanlaicode", "wanlaicodex"])

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function stringValue(value: unknown) {
  if (typeof value !== "string") return undefined
  const normalized = value.trim()
  return normalized || undefined
}

function numberValue(value: unknown) {
  const normalized = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN
  return Number.isFinite(normalized) ? normalized : undefined
}

function normalizedProductKey(value: unknown) {
  return stringValue(value)?.toLowerCase().replace(/[^a-z0-9]/g, "") ?? ""
}

// 历史工具 metadata 可能缺少新字段；仅保留真实布尔值，禁止把 undefined 压成 false。
export function parseImageGenerationMetadataFlag(value: unknown) {
  if (value === true) return true
  if (value === false) return false
  return undefined
}

// 工具 metadata 来自本地服务端，但会随历史消息长期保存；这里仍逐字段校验，避免旧版本或损坏数据渲染出假套餐。
export function parseImageGenerationUpgradePlans(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!isRecord(item)) return []
    const id = stringValue(item.id)
    const name = stringValue(item.name)
    const price = numberValue(item.price)
    if (!id || !name || price === undefined || price < 0) return []
    const validityDays = numberValue(item.validityDays)
    const validityUnit = stringValue(item.validityUnit)
    return [
      {
        id,
        name,
        price,
        ...(validityDays !== undefined && validityDays > 0 ? { validityDays: Math.floor(validityDays) } : {}),
        ...(validityUnit ? { validityUnit } : {}),
      } satisfies ImageGenerationUpgradePlan,
    ]
  })
}

// 全局缓存保存完整 storefront 数据；这里只保留真实 WanlaiCode 软件套餐且严格验证生图布尔开关。
export function parseImageGenerationStorefrontPlans(value: unknown) {
  if (!Array.isArray(value)) return []
  return parseImageGenerationUpgradePlans(
    value.filter(isRecord).filter((plan) => {
      if (plan.tokenPackId !== null && plan.tokenPackId !== undefined) return false
      if (plan.allowImageGeneration !== true) return false
      if (!Array.isArray(plan.softwareProductCodes)) return false
      return plan.softwareProductCodes.some((code) => wanlaiCodeProductKeys.has(normalizedProductKey(code)))
    }),
  )
}

// 套餐名称按当前语言生成自然列表，拒绝卡只回答“哪些套餐支持”，不再展示容易误解为可购买的价格卡片。
export function formatImageGenerationPlanNames(plans: readonly ImageGenerationUpgradePlan[], locale: string) {
  return new Intl.ListFormat(locale, { style: "short", type: "conjunction" }).format(plans.map((plan) => plan.name))
}

// 无 app 内入口时仅允许可信的 HTTP(S) 购买地址，拒绝 javascript/file 等协议进入外链处理器。
export function safeImageGenerationPurchaseUrl(value: unknown) {
  const raw = stringValue(value)
  if (!raw || !URL.canParse(raw)) return undefined
  const url = new URL(raw)
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined
  return url.toString()
}

// 升级操作始终优先复用 app 内用户中心；只有宿主未注入该能力时才回退真实购买外链。
export function resolveImageGenerationUpgradeTarget(input: {
  supportedPlans: readonly ImageGenerationUpgradePlan[]
  upgradePlans: readonly ImageGenerationUpgradePlan[]
  purchaseEnabled: boolean | undefined
  planCatalogAvailable: boolean | undefined
  hasInAppHandler: boolean
  hasExternalHandler: boolean
  purchaseUrl: unknown
}): ImageGenerationUpgradeTarget | undefined {
  // 后台明确关闭购买时必须忽略历史地址，避免旧 metadata 重新放出已经停用的入口。
  if (input.purchaseEnabled === false) return undefined
  // 查看套餐页不等于允许购买：支持套餐即使因额度较低不可直接升级，也应允许用户进入套餐页查看。
  if (input.planCatalogAvailable !== false && input.supportedPlans.length === 0 && input.upgradePlans.length === 0)
    return undefined
  // 应用内套餐页不依赖历史消息里的外链地址；只有降级到外部浏览器时才要求可信 URL。
  if (input.hasInAppHandler) return { type: "in-app" }
  if (!input.hasExternalHandler) return undefined
  const url = safeImageGenerationPurchaseUrl(input.purchaseUrl)
  if (!url) return undefined
  return { type: "external", url }
}
