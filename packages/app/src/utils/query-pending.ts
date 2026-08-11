import { hashKey, type QueryClient } from "@tanstack/solid-query"
import { createEffect, createSignal, onCleanup } from "solid-js"

/**
 * 只订阅 query 的「尚无数据」状态，不创建 useQueries 观察者。
 * useQueries 会把全量 data 深拷贝进 solid store（挂载即深度 unwrap，实测数百 ms），
 * 纯 isLoading 消费场景用本函数免掉这笔成本；数据本身仍由目录 bootstrap 预取，
 * 这里的 ensureQueryData 只兜底缓存未命中。
 */
export function createQueryPending(client: QueryClient, options: () => { queryKey: readonly unknown[] }) {
  const [pending, setPending] = createSignal(true)
  createEffect(() => {
    const opts = options()
    const hash = hashKey(opts.queryKey as never)
    const read = () => {
      const state = client.getQueryState(opts.queryKey as never)
      setPending(!state || state.status === "pending")
    }
    // revalidateIfStale：无 Observer 的 query 没人触发 refetch，已有缓存但过期时后台重取
    const ensure = () => void client.ensureQueryData({ ...opts, revalidateIfStale: true } as never).catch(() => {})
    read()
    ensure()
    const unsub = client.getQueryCache().subscribe((event) => {
      if (hashKey(event.query.queryKey) !== hash) return
      // 无 Observer 的 query 会被 gcTime 回收：收到移除事件时主动重新拉取，避免 pending 卡死
      if (event.type === "removed") ensure()
      read()
    })
    onCleanup(unsub)
  })
  return pending
}
