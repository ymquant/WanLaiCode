import { describe, expect, test } from "bun:test"
import type { OpencodeClient, WanlaiCodeUserCenterPurchasePlans } from "@opencode-ai/sdk/v2/client"
import { QueryClient, QueryObserver } from "@tanstack/solid-query"
import {
  clearPurchasePlansCache,
  ensurePurchasePlans,
  purchasePlansQuery,
  PURCHASE_PLANS_QUERY_KEY,
} from "./purchase-plans"

function purchaseClient(fetcher: () => Promise<WanlaiCodeUserCenterPurchasePlans>) {
  return {
    wanlaicodeUserCenter: {
      purchase: {
        plans: async () => ({ data: await fetcher(), error: undefined }),
      },
    },
  } as unknown as OpencodeClient
}

describe("purchase plans query cache", () => {
  test("命中全局缓存时不重复获取套餐", async () => {
    const queryClient = new QueryClient()
    const calls: number[] = []
    const client = purchaseClient(async () => {
      calls.push(calls.length + 1)
      return { enabled: true, purchase_url: "https://pay.example.com", plans: [{ id: "c2", name: "c2" }] }
    })

    const first = await ensurePurchasePlans(queryClient, client)
    const second = await ensurePurchasePlans(queryClient, client)

    expect(first).toBe(second)
    expect(calls).toEqual([1])
    expect(queryClient.getQueryData<WanlaiCodeUserCenterPurchasePlans>(PURCHASE_PLANS_QUERY_KEY)).toBe(first)
  })

  test("缓存清除后重新获取真实套餐", async () => {
    const queryClient = new QueryClient()
    const calls: number[] = []
    const client = purchaseClient(async () => {
      calls.push(calls.length + 1)
      return { enabled: true, purchase_url: "https://pay.example.com", plans: [] }
    })

    await ensurePurchasePlans(queryClient, client)
    const subscribedQuery = queryClient.getQueryCache().find({ queryKey: PURCHASE_PLANS_QUERY_KEY, exact: true })
    clearPurchasePlansCache(queryClient)
    // 清账号数据时保留原 Query 对象，避免已渲染的历史拒绝卡失去后续缓存更新。
    expect(queryClient.getQueryCache().find({ queryKey: PURCHASE_PLANS_QUERY_KEY, exact: true })).toBe(subscribedQuery)
    await ensurePurchasePlans(queryClient, client)

    expect(calls).toEqual([1, 2])
  })

  test("缓存重置后已挂载的拒绝卡订阅能收到新套餐", async () => {
    const queryClient = new QueryClient()
    const calls: number[] = []
    const client = purchaseClient(async () => {
      calls.push(calls.length + 1)
      return {
        enabled: true,
        purchase_url: "https://pay.example.com",
        plans: [{ id: calls.length === 1 ? "c1" : "c2", name: calls.length === 1 ? "c1" : "c2" }],
      }
    })

    await ensurePurchasePlans(queryClient, client)
    // 模拟目录页中 enabled=false 的 createQuery：它只订阅共享缓存，不会自行请求。
    const observer = new QueryObserver(queryClient, { ...purchasePlansQuery(client), enabled: false })
    const unsubscribe = observer.subscribe(() => {})
    clearPurchasePlansCache(queryClient)
    await ensurePurchasePlans(queryClient, client)

    expect(observer.getCurrentResult().data?.plans[0]?.id).toBe("c2")
    expect(calls).toEqual([1, 2])
    unsubscribe()
  })

  test("多个历史拒绝卡并发缺少缓存时只请求一次真实套餐", async () => {
    const queryClient = new QueryClient()
    const gate = Promise.withResolvers<void>()
    const calls: number[] = []
    const catalog = { enabled: true, purchase_url: "https://pay.example.com", plans: [{ id: "c2", name: "c2" }] }
    const client = purchaseClient(async () => {
      calls.push(calls.length + 1)
      await gate.promise
      return catalog
    })

    const first = ensurePurchasePlans(queryClient, client)
    const second = ensurePurchasePlans(queryClient, client)
    gate.resolve()

    expect(await Promise.all([first, second])).toEqual([catalog, catalog])
    expect(calls).toEqual([1])
  })

  test("真实接口失败时不把错误结果写入套餐数据缓存", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const client = purchaseClient(async () => {
      throw new Error("套餐接口暂时不可用")
    })

    await expect(ensurePurchasePlans(queryClient, client)).rejects.toThrow("套餐接口暂时不可用")
    expect(queryClient.getQueryData<WanlaiCodeUserCenterPurchasePlans>(PURCHASE_PLANS_QUERY_KEY)).toBeUndefined()
  })
})
