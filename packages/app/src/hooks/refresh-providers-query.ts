import type { OpencodeClient, ProviderListResponse } from "@opencode-ai/sdk/v2/client"
import type { QueryClient } from "@tanstack/solid-query"
import { createRoot, createSignal } from "solid-js"
import { useQueryClient } from "@tanstack/solid-query"
import { normalizeProviderList, providerListWithFallback } from "@/context/global-sync/utils"
import { useGlobalSDK } from "@/context/global-sdk"

export type RefreshProviderOutcome =
  | { status: "success" }
  | { status: "cached" }
  | { status: "failed"; message?: string }

const refreshState = createRoot(() => {
  const [refreshing, setRefreshing] = createSignal(false)
  return { refreshing, setRefreshing }
})

function refreshErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  if (!error || typeof error !== "object") return undefined
  const obj = error as Record<string, unknown>
  const message = [obj.message, obj.statusText].find((value) => typeof value === "string")
  return message
}

export function resolveRefreshedProviderList(input: {
  next: ProviderListResponse
  previous?: ProviderListResponse
  global?: ProviderListResponse
}) {
  const data = providerListWithFallback({
    current: input.next,
    previous: input.previous,
    global: input.global,
  })!
  return {
    data,
    fresh: data === input.next,
  }
}

async function fetchProviderList(input: {
  sdk: OpencodeClient
  queryClient?: QueryClient
  directory: string | null
  refresh?: boolean
}) {
  const previous = input.queryClient?.getQueryData<ProviderListResponse>([input.directory, "providers"])
  const global = input.directory ? input.queryClient?.getQueryData<ProviderListResponse>([null, "providers"]) : undefined
  try {
    const response = await input.sdk.provider.list(input.refresh ? { refresh: true } : undefined)
    if (!response.data) throw response.error ?? new Error("provider list returned empty response")
    const next = normalizeProviderList(response.data)
    return resolveRefreshedProviderList({ next, previous, global })
  } catch (err) {
    const fallback = providerListWithFallback({ current: undefined, previous, global })
    if (fallback) return { data: fallback, fresh: false }
    throw err
  }
}

async function applyProviderList(queryClient: QueryClient, data: ProviderListResponse) {
  queryClient.setQueryData<ProviderListResponse>([null, "providers"], data)
  await queryClient.refetchQueries({
    predicate: (query) => query.queryKey[1] === "providers" && query.queryKey[0] !== null,
    type: "all",
  })
}

export async function refreshProviderListOnce(
  queryClient: QueryClient,
  sdk: OpencodeClient,
): Promise<RefreshProviderOutcome> {
  try {
    const result = await fetchProviderList({
      sdk,
      queryClient,
      directory: null,
      refresh: true,
    })
    await applyProviderList(queryClient, result.data)
    return result.fresh ? { status: "success" } : { status: "cached" }
  } catch (error) {
    console.error("[refresh-providers] failed to refresh provider list", error)
    return { status: "failed", message: refreshErrorMessage(error) }
  }
}

export function useRefreshProviders() {
  const globalSDK = useGlobalSDK()
  const queryClient = useQueryClient()

  const refresh = async (): Promise<RefreshProviderOutcome | undefined> => {
    if (refreshState.refreshing()) return
    refreshState.setRefreshing(true)
    try {
      return await refreshProviderListOnce(queryClient, globalSDK.client)
    } finally {
      refreshState.setRefreshing(false)
    }
  }

  return { refresh, refreshing: refreshState.refreshing }
}
