import type { WanlaiCodeUserCenterJson, WanlaiCodeUserCenterStatus } from "@opencode-ai/sdk/v2/client"
import type { IconProps } from "@opencode-ai/ui/icon"

export type TabID = "keys" | "quota" | "usage" | "purchase" | "token-packs"
export type PlatformFilter = (typeof platformFilters)[number]

export const platformFilters = ["all", "openai", "anthropic", "gemini"] as const
export const usagePageSize = 10

export const tabs: Array<{
  id: TabID
  labelKey: "users.tabs.keys" | "users.tabs.quota" | "users.tabs.usage" | "users.tabs.purchase" | "users.tabs.tokenPacks"
  icon: IconProps["name"]
}> = [
  { id: "keys", labelKey: "users.tabs.keys", icon: "shield" },
  { id: "quota", labelKey: "users.tabs.quota", icon: "models" },
  { id: "usage", labelKey: "users.tabs.usage", icon: "status" },
  { id: "purchase", labelKey: "users.tabs.purchase", icon: "square-arrow-top-right" },
  { id: "token-packs", labelKey: "users.tabs.tokenPacks", icon: "status" },
] as const

export type UserCenterStatus = WanlaiCodeUserCenterStatus

export type UserCenterStatusProps = {
  status: () => UserCenterStatus | undefined
  statusLoading: () => boolean
  statusError: () => unknown
  // 切换用户中心 tab：覆盖层模式下 URL 参数不生效，必须走容器回调
  selectTab: (tab: TabID) => void
}

export function canReadSoftware(status: UserCenterStatus | undefined) {
  return status?.auth_type === "oauth" || status?.auth_type === "api"
}

// token 包为 OAuth 专属：API-key 会话无用户身份，不应显示 token 包标签页
export function canReadTokenPacks(status: UserCenterStatus | undefined) {
  return status?.auth_type === "oauth"
}

export type SoftwareEntitlementWindow = {
  mode?: string
  limit_tokens?: number
  used_tokens?: number
  remaining_tokens?: number
  next_refill_at?: string | null
}

export type SoftwareEntitlement = WanlaiCodeUserCenterJson & {
  group_id?: number | null
  software_group_id?: number | null
  // 后端套餐组的生图能力原字段；缺失或 false 均表示当前权益不支持生图。
  allow_image_generation?: boolean
  product_code?: string
  product_name?: string
  plan_name?: string
  status?: string
  entitlement_kind?: string
  source_order_id?: number | string | null
  source_plan_id?: number | string | null
  expires_at?: string | null
  api_key_preview?: string
  usage?: {
    five_hour?: SoftwareEntitlementWindow | null
    seven_day?: SoftwareEntitlementWindow | null
    thirty_day?: SoftwareEntitlementWindow | null
    total?: SoftwareEntitlementWindow | null
  }
}

// 仅接受后端明确返回的布尔 true，避免缺失值或字符串 "true" 被误判为已开通能力。
export function entitlementSupportsImageGeneration(
  entitlement: { allow_image_generation?: unknown } | undefined,
) {
  return entitlement?.allow_image_generation === true
}

export type PurchaseServicePlan = WanlaiCodeUserCenterJson & {
  id?: string
  groupId?: number | null
  softwareGroupId?: number | null
  groupName?: string | null
  name?: string
  description?: string | null
  price?: number
  originalPrice?: number | null
  validityDays?: number
  validityUnit?: string
  features?: string[]
  softwareProductCodes?: string[]
  softwareTokenLimit5h?: number | null
  softwareTokenLimit7d?: number | null
  softwareTokenLimit30d?: number | null
  // 购买接口从真实软件套餐组映射出的生图能力；仅布尔 true 才能展示支持标识。
  allowImageGeneration?: boolean
  productName?: string | null
  tokenPackId?: number | null
  tokenPackQuota?: number | null
  tokenPackValidityDays?: number | null
}

export type PurchasePlansData = {
  enabled?: boolean
  purchase_url?: string
  plans?: WanlaiCodeUserCenterJson[]
  __error?: string
  __errorObj?: unknown
}

export type UsageRecord = WanlaiCodeUserCenterJson & {
  id?: number
  request_id?: string
  model?: string
  platform?: string | null
  request_type?: "unknown" | "sync" | "stream" | "ws_v2"
  stream?: boolean
  input_tokens?: number
  output_tokens?: number
  cache_creation_tokens?: number
  cache_read_tokens?: number
  cache_creation_5m_tokens?: number
  cache_creation_1h_tokens?: number
  software_consumed_tokens?: number
  rate_multiplier?: number
  duration_ms?: number
  first_token_ms?: number | null
  created_at?: string
}

export type UsageStats = WanlaiCodeUserCenterJson & {
  total_requests?: number
  total_input_tokens?: number
  total_output_tokens?: number
  total_cache_tokens?: number
  total_tokens?: number
  total_software_consumed_tokens?: number
  average_duration_ms?: number
}

export function selectActiveEntitlement(items: WanlaiCodeUserCenterJson[], productCode: string) {
  const entitlements = items as SoftwareEntitlement[]
  return (
    entitlements.find((item) => item.product_code === productCode && item.status === "active") ??
    entitlements.find((item) => item.product_code === productCode) ??
    entitlements.find((item) => item.status === "active") ??
    entitlements[0]
  )
}
