import { finiteNumber } from "./shared"
import type { PurchaseServicePlan, SoftwareEntitlement } from "./types"

const wanlaiCodeProductKeys = new Set(["wanlaicode", "wanlaicodex"])

function normalizeProductCode(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase() : ""
}

function normalizedProductKey(value: unknown) {
  return normalizeProductCode(value).replace(/[^a-z0-9]/g, "")
}

export function numberValue(value: unknown) {
  const next = finiteNumber(value, Number.NaN)
  return Number.isFinite(next) ? next : undefined
}

export function hasSoftwareQuota(plan: PurchaseServicePlan) {
  return (
    finiteNumber(plan.softwareTokenLimit5h) > 0 ||
    finiteNumber(plan.softwareTokenLimit7d) > 0 ||
    finiteNumber(plan.softwareTokenLimit30d) > 0
  )
}

export function isTokenPackPlan(plan: PurchaseServicePlan) {
  return plan.tokenPackId != null
}

// 生图标签只属于 WanlaiCode 产品族的软件套餐；token 包、其它产品和脏能力字段一律失败关闭。
export function planSupportsImageGeneration(plan: PurchaseServicePlan) {
  return (
    !isTokenPackPlan(plan) &&
    plan.allowImageGeneration === true &&
    plan.softwareProductCodes?.some((code) => wanlaiCodeProductKeys.has(normalizedProductKey(code))) === true
  )
}

export function isStorefrontPlan(plan: PurchaseServicePlan) {
  return hasSoftwareQuota(plan) || isTokenPackPlan(plan)
}

export function planMatchesEntitlement(plan: PurchaseServicePlan, entitlement: SoftwareEntitlement | undefined) {
  if (isTokenPackPlan(plan) || !entitlement) return false
  if (plan.id && entitlement.source_plan_id && String(entitlement.source_plan_id) === String(plan.id)) return true

  const planGroup = numberValue(plan.softwareGroupId)
  if (planGroup !== undefined && numberValue(entitlement.software_group_id) === planGroup) return true
  if (planGroup !== undefined && numberValue(entitlement.group_id) === planGroup) return true

  const planCodes = plan.softwareProductCodes?.map(normalizeProductCode).filter(Boolean) ?? []
  return (
    planGroup === undefined &&
    !entitlement.source_plan_id &&
    planCodes.length > 0 &&
    planCodes.includes(normalizeProductCode(entitlement.product_code))
  )
}

export function isCurrentPlanFor(plan: PurchaseServicePlan, entitlement: SoftwareEntitlement | undefined) {
  if (isTokenPackPlan(plan)) return false
  if (!entitlement || entitlement.status !== "active") return false
  return planMatchesEntitlement(plan, entitlement)
}

// 归一化窗口额度用于档位比较：0 / 空 表示无限额度，按最高档处理（与后端口径一致）。
function normSoftwareLimit(value: unknown) {
  const next = numberValue(value)
  return next === undefined || next <= 0 ? Number.POSITIVE_INFINITY : next
}

export function isEntitlementEffectiveNow(entitlement: SoftwareEntitlement | undefined) {
  if (!entitlement || entitlement.status !== "active") return false
  if (!entitlement.expires_at) return true
  const expiresAt = new Date(entitlement.expires_at).getTime()
  return Number.isFinite(expiresAt) ? expiresAt > Date.now() : true
}

function samePlanGroup(plan: PurchaseServicePlan, entitlement: SoftwareEntitlement) {
  const planGroup = numberValue(plan.softwareGroupId)
  return (
    planGroup !== undefined &&
    (numberValue(entitlement.software_group_id) === planGroup || numberValue(entitlement.group_id) === planGroup)
  )
}

// 该套餐相对用户当前「付费、有效」套餐是否为降级（仅允许升级）。
// 当前套餐本身（续费）不算降级；trial / 已过期 / 非 active 权益不参与判定。
// 档位与后端 softwareMonthlyCapacityAtLeast 口径一致：仅比较 30 天月度额度（0=无限为最高档）。
// 不能逐窗口（5h/7d/30d）比较：体验套餐把总量铺平到三个窗口、运营手动调高过窗口额度的权益，
// 逐窗口都会把月度容量更高的套餐误判成降级，导致用户所有套餐置灰、无法升级。
export function isPlanDowngradeFor(plan: PurchaseServicePlan, entitlement: SoftwareEntitlement | undefined) {
  // Token 包是预付额度，与软件套餐档位无可比性，不参与降级判定
  if (isTokenPackPlan(plan)) return false
  if (!entitlement || !isEntitlementEffectiveNow(entitlement)) return false
  if (entitlement.entitlement_kind !== "paid") return false
  // 命中当前套餐即续费，非降级。openPurchase 直接调本函数拦截、无 !current 保护，
  // 且脏数据（group_id 与套餐不符 + 快照额度被调高）下 samePlanGroup 会漏判，故须显式短路，
  // 否则当前套餐的「续费」会被误当降级拦下。
  if (planMatchesEntitlement(plan, entitlement)) return false
  if (samePlanGroup(plan, entitlement)) return false
  return (
    normSoftwareLimit(plan.softwareTokenLimit30d) < normSoftwareLimit(entitlement.usage?.thirty_day?.limit_tokens)
  )
}

// 相对当前有效权益是否为升档（30 天月度额度更高）。
export function isPlanUpgradeFor(plan: PurchaseServicePlan, entitlement: SoftwareEntitlement | undefined) {
  if (isTokenPackPlan(plan)) return false
  if (!entitlement || !isEntitlementEffectiveNow(entitlement)) return false
  if (planMatchesEntitlement(plan, entitlement)) return false
  if (samePlanGroup(plan, entitlement)) return false
  return (
    normSoftwareLimit(plan.softwareTokenLimit30d) > normSoftwareLimit(entitlement.usage?.thirty_day?.limit_tokens)
  )
}
