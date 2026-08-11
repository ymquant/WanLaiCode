import type { OpencodeClient, WanlaiCodeUserCenterPurchasePlans } from "@opencode-ai/sdk/v2/client"
import type { QueryClient } from "@tanstack/solid-query"

export const PURCHASE_PLANS_QUERY_KEY = ["wanlaicode", "purchase-plans"] as const

// 套餐属于服务端共享数据：交给全局 QueryClient 缓存，成功后一直复用，直到用户中心事件明确使其失效。
export function purchasePlansQuery(client: OpencodeClient) {
  return {
    queryKey: PURCHASE_PLANS_QUERY_KEY,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
    queryFn: async (): Promise<WanlaiCodeUserCenterPurchasePlans> => {
      const response = await client.wanlaicodeUserCenter.purchase.plans()
      if (response.error !== undefined) throw response.error
      if (!response.data) throw new Error("WanlaiCode purchase plans response is empty")
      return response.data
    },
  }
}

// 严格 cache-first：已有套餐时不触发网络请求；多个拒绝卡并发 miss 时由 TanStack Query 自动合并请求。
export function ensurePurchasePlans(queryClient: QueryClient, client: OpencodeClient) {
  return (
    queryClient.getQueryData<WanlaiCodeUserCenterPurchasePlans>(PURCHASE_PLANS_QUERY_KEY) ??
    queryClient.fetchQuery(purchasePlansQuery(client))
  )
}

// 登录身份或后台套餐变化后重置旧账号数据；保留同一个 Query 对象，确保现有拒绝卡订阅能收到新目录。
export function clearPurchasePlansCache(queryClient: QueryClient) {
  void queryClient.resetQueries({ queryKey: PURCHASE_PLANS_QUERY_KEY, exact: true })
}
