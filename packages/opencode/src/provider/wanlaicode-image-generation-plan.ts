const wanlaiCodeProductKeys = new Set(["wanlaicode", "wanlaicodex"])

export type ImageGenerationUpgradePlan = {
  id: string
  name: string
  price: number
  validityDays?: number
  validityUnit?: string
}

export type ImageGenerationPurchaseAccess = {
  enabled: boolean
  purchaseUrl: string
}

type ImageGenerationPlanAccessErrorInput = {
  purchaseUrl: string
  purchaseEnabled?: boolean
  supportedPlans?: ImageGenerationUpgradePlan[]
  upgradePlans: ImageGenerationUpgradePlan[]
  planCatalogAvailable?: boolean
}

// 套餐门禁拒绝错误保留图片网关既有英文原文，让现有 group_disabled 本地化链路继续生效；
// 工具错误卡会依据拒绝 metadata 覆盖为套餐文案，禁止把这条内部分类哨兵直接展示给用户。
// 同时附带真实购买入口与可升级套餐，供工具元数据和前端拒绝态直接消费。
export class ImageGenerationPlanAccessError extends Error {
  override readonly name = "ImageGenerationPlanAccessError"
  readonly purchaseUrl: string
  readonly purchaseEnabled: boolean | undefined
  readonly supportedPlans: ImageGenerationUpgradePlan[]
  readonly upgradePlans: ImageGenerationUpgradePlan[]
  readonly planCatalogAvailable: boolean

  constructor(input: ImageGenerationPlanAccessErrorInput) {
    super("Image generation is not enabled for this group")
    this.purchaseUrl = input.purchaseUrl
    // 只有设置链路能够判定购买状态时才持久化布尔值，接口失败必须保留未知态。
    this.purchaseEnabled = input.purchaseEnabled
    // 兼容旧调用方：未单独传支持列表时，沿用当时唯一存在的可升级套餐列表。
    this.supportedPlans = input.supportedPlans ?? input.upgradePlans
    this.upgradePlans = input.upgradePlans
    this.planCatalogAvailable = input.planCatalogAvailable ?? Boolean(this.supportedPlans.length)
  }
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
}

function nonEmptyString(input: unknown) {
  if (typeof input !== "string") return undefined
  const value = input.trim()
  return value || undefined
}

function finiteNumber(input: unknown) {
  if (typeof input !== "number" || !Number.isFinite(input)) return undefined
  return input
}

function normalizedProductKey(input: unknown) {
  return (
    nonEmptyString(input)
      ?.toLowerCase()
      .replace(/[^a-z0-9]/g, "") ?? ""
  )
}

// 与用户中心 purchaseSettings 完全同口径：显式 false 才关闭；字段缺失时按最终购买 URL 是否存在兜底。
export function imageGenerationPurchaseAccess(input: {
  purchaseSubscriptionEnabled?: boolean
  purchaseSubscriptionUrl?: string
  fallbackPurchaseUrl: string
}): ImageGenerationPurchaseAccess {
  const purchaseUrl = nonEmptyString(input.purchaseSubscriptionUrl) ?? nonEmptyString(input.fallbackPurchaseUrl) ?? ""
  const enabled = input.purchaseSubscriptionEnabled ?? Boolean(purchaseUrl)
  return { enabled, purchaseUrl: enabled ? purchaseUrl : "" }
}

// storefront 同时存在 wanlai_code 与 wanlai_codex 两类产品编码；归一化后统一识别为本客户端软件产品。
function isWanlaiCodeProduct(input: unknown) {
  return wanlaiCodeProductKeys.has(normalizedProductKey(input))
}

function productCodes(input: Record<string, unknown>) {
  const value = input.softwareProductCodes
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === "string")
}

function statusActive(input: Record<string, unknown>) {
  return nonEmptyString(input.status)?.toLowerCase() === "active"
}

// 门禁只选择 WanlaiCode 产品族权益：优先当前 active 权益，找不到时保留同产品旧权益仅用于升级档位判断；
// 绝不回退到其它软件产品，避免其它产品的同名能力字段越过生图门禁。
export function selectImageGenerationEntitlement(items: readonly unknown[], now = Date.now()) {
  const entitlements = items.filter(isRecord).filter((item) => isWanlaiCodeProduct(item.product_code))
  return (
    entitlements.find((item) => entitlementEffectiveNow(item, now)) ??
    entitlements.find(statusActive) ??
    entitlements[0]
  )
}

// 授权同时要求产品、状态、有效期和能力字段全部有效；false、缺失、字符串 "true" 均 fail closed。
export function imageGenerationAllowed(entitlement: unknown, now = Date.now()) {
  return (
    isRecord(entitlement) &&
    isWanlaiCodeProduct(entitlement.product_code) &&
    entitlementEffectiveNow(entitlement, now) &&
    entitlement.allow_image_generation === true
  )
}

function planGroupID(plan: Record<string, unknown>) {
  return finiteNumber(plan.softwareGroupId) ?? finiteNumber(plan.groupId)
}

function entitlementGroupIDs(entitlement: Record<string, unknown>) {
  return [finiteNumber(entitlement.software_group_id), finiteNumber(entitlement.group_id)].filter(
    (item): item is number => item !== undefined,
  )
}

function planMatchesEntitlement(plan: Record<string, unknown>, entitlement: Record<string, unknown>) {
  const planID = nonEmptyString(plan.id)
  const sourcePlanID =
    nonEmptyString(entitlement.source_plan_id) ?? finiteNumber(entitlement.source_plan_id)?.toString()
  if (planID && sourcePlanID === planID) return true

  const groupID = planGroupID(plan)
  if (groupID !== undefined && entitlementGroupIDs(entitlement).includes(groupID)) return true

  return (
    groupID === undefined &&
    !sourcePlanID &&
    productCodes(plan).some((item) => normalizedProductKey(item) === normalizedProductKey(entitlement.product_code))
  )
}

function entitlementEffectiveNow(entitlement: Record<string, unknown>, now: number) {
  if (!statusActive(entitlement)) return false
  const expiresAt = nonEmptyString(entitlement.expires_at)
  if (!expiresAt) return true
  const expires = Date.parse(expiresAt)
  return Number.isNaN(expires) || expires > now
}

// 30 天额度的 0/缺失在现有购买规则中表示无限，归一化为最高档。
function normalizedMonthlyLimit(input: unknown) {
  const value = finiteNumber(input)
  return value === undefined || value <= 0 ? Number.POSITIVE_INFINITY : value
}

function entitlementMonthlyLimit(entitlement: Record<string, unknown>) {
  const usage = isRecord(entitlement.usage) ? entitlement.usage : undefined
  const thirtyDay = usage && isRecord(usage.thirty_day) ? usage.thirty_day : undefined
  return thirtyDay?.limit_tokens ?? entitlement.token_limit_30d
}

// 复用现有“仅允许升级”口径：只有付费且当前有效的权益参与档位比较，并且只比较 30 天额度。
export function isImageGenerationPlanDowngrade(plan: unknown, entitlement: unknown, now = Date.now()) {
  if (!isRecord(plan) || !isRecord(entitlement)) return false
  if (nonEmptyString(entitlement.entitlement_kind) !== "paid") return false
  if (!entitlementEffectiveNow(entitlement, now)) return false
  if (planMatchesEntitlement(plan, entitlement)) return false

  const groupID = planGroupID(plan)
  if (groupID !== undefined && entitlementGroupIDs(entitlement).includes(groupID)) return false
  return (
    normalizedMonthlyLimit(plan.softwareTokenLimit30d) < normalizedMonthlyLimit(entitlementMonthlyLimit(entitlement))
  )
}

function softwarePlan(input: Record<string, unknown>) {
  if (input.tokenPackId !== null && input.tokenPackId !== undefined) return false
  if (!productCodes(input).some(isWanlaiCodeProduct)) return false
  // 与 PurchasePlans.hasSoftwareQuota 保持一致：三个窗口至少一个为正才属于现有 storefront 软件套餐；
  // 单个 30d=0 仍按“无限额度”参与档位比较，但三个窗口全为 0 的计划不会被现有购买页展示。
  return [input.softwareTokenLimit5h, input.softwareTokenLimit7d, input.softwareTokenLimit30d].some(
    (item) => (finiteNumber(item) ?? 0) > 0,
  )
}

function upgradePlan(input: Record<string, unknown>): ImageGenerationUpgradePlan | undefined {
  const id = nonEmptyString(input.id)
  const name = nonEmptyString(input.name)
  const price = finiteNumber(input.price)
  if (!id || !name || price === undefined) return undefined

  const validityDays = finiteNumber(input.validityDays)
  const validityUnit = nonEmptyString(input.validityUnit)
  return {
    id,
    name,
    price,
    ...(validityDays !== undefined ? { validityDays } : {}),
    ...(validityUnit ? { validityUnit } : {}),
  }
}

// 支持列表与升级列表共享同一套真实能力校验，区别只在于升级列表还要遵守禁止降级规则。
function imageGenerationCapablePlans(plans: readonly unknown[]) {
  return plans
    .filter(isRecord)
    .filter((plan) => plan.allowImageGeneration === true)
    .filter(softwarePlan)
}

// 说明用途必须保留所有真实支持生图的套餐，即使该套餐因额度较低不能从当前套餐直接购买。
export function imageGenerationSupportedPlans(plans: readonly unknown[]) {
  return imageGenerationCapablePlans(plans)
    .map(upgradePlan)
    .filter((plan): plan is ImageGenerationUpgradePlan => !!plan)
}

// 购买用途继续排除降级套餐，避免“告诉用户哪些套餐支持”意外绕过现有仅允许升级规则。
export function imageGenerationUpgradePlans(input: { plans: readonly unknown[]; entitlement: unknown; now?: number }) {
  return imageGenerationCapablePlans(input.plans)
    .filter((plan) => !isImageGenerationPlanDowngrade(plan, input.entitlement, input.now))
    .map(upgradePlan)
    .filter((plan): plan is ImageGenerationUpgradePlan => !!plan)
}

export * as WanlaiCodeImageGenerationPlan from "./wanlaicode-image-generation-plan"
