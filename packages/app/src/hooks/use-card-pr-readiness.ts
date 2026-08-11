import type { VcsPullRequestReadiness, VcsPullRequestStatus } from "@opencode-ai/sdk/v2"
import { createQuery, useQueryClient } from "@tanstack/solid-query"
import { createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { useSDK } from "@/context/sdk"
import {
  emptyPrReadiness,
  PR_READINESS_POLL_MS,
  PR_READINESS_STALE_MS,
  prReadinessKey,
  prStatusKey,
} from "@/utils/pr-readiness"

export function useCardPrReadiness(options: {
  vcsKey: () => readonly unknown[]
  enabled: () => boolean
}) {
  const sdk = useSDK()
  const queryClient = useQueryClient()
  const readinessKey = () => prReadinessKey(options.vcsKey())
  const statusKey = () => prStatusKey(options.vcsKey())

  const [documentVisible, setDocumentVisible] = createSignal(
    typeof document === "undefined" ? true : document.visibilityState === "visible",
  )
  onMount(() => {
    const onVisibility = () => setDocumentVisible(document.visibilityState === "visible")
    document.addEventListener("visibilitychange", onVisibility)
    onCleanup(() => document.removeEventListener("visibilitychange", onVisibility))
  })

  const fetchReadiness = () =>
    sdk.client.vcs
      .pullRequestReadiness()
      .then((res) => res.data ?? emptyPrReadiness())
      .catch(() => {
        const cached = queryClient.getQueryData<VcsPullRequestReadiness>(readinessKey())
        if (cached) return cached
        throw new Error("pr-readiness-failed")
      })

  const fetchStatus = () =>
    sdk.client.vcs.pullRequestStatus().then((res) => {
      const status = res.data
      if (!status) throw new Error("pr-status-empty")
      return status
    })

  const refreshReadiness = () =>
    queryClient.fetchQuery({
      queryKey: readinessKey(),
      queryFn: fetchReadiness,
      staleTime: 0,
    })

  const cardPrReadinessQuery = createQuery(() => ({
    queryKey: readinessKey(),
    enabled: options.enabled(),
    staleTime: PR_READINESS_STALE_MS,
    refetchOnWindowFocus: false,
    queryFn: fetchReadiness,
  }))

  const data = createMemo(() => cardPrReadinessQuery.data)

  const fullReady = createMemo(() => !!data())

  const cardPrStatusQuery = createQuery(() => ({
    queryKey: statusKey(),
    enabled: options.enabled() && fullReady(),
    staleTime: PR_READINESS_STALE_MS,
    refetchInterval: options.enabled() && fullReady() && documentVisible() ? PR_READINESS_POLL_MS : false,
    refetchOnWindowFocus: options.enabled() && fullReady(),
    queryFn: fetchStatus,
  }))

  const statusOverlay = createMemo((): VcsPullRequestStatus | undefined =>
    cardPrStatusQuery.isSuccess ? cardPrStatusQuery.data : undefined,
  )

  const ghCli = createMemo(() => statusOverlay()?.gh_cli ?? data()?.gh_cli)
  const ghAuthenticated = createMemo(() => statusOverlay()?.gh_authenticated ?? data()?.gh_authenticated)
  const existingPullRequest = createMemo(() => {
    const status = statusOverlay()
    if (status) return status.existing_pull_request
    return data()?.existing_pull_request
  })

  const isPending = createMemo(
    () => options.enabled() && (!cardPrReadinessQuery.isFetched || cardPrReadinessQuery.isPending),
  )

  const isError = createMemo(
    () => options.enabled() && !data() && cardPrReadinessQuery.isError,
  )

  const isRefreshing = createMemo(
    () => cardPrReadinessQuery.isFetching || cardPrStatusQuery.isFetching,
  )

  let refreshTimer: ReturnType<typeof setTimeout> | undefined
  const scheduleRefreshFull = () => {
    if (refreshTimer) clearTimeout(refreshTimer)
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined
      void refreshReadiness()
    }, 120)
  }

  onCleanup(() => {
    if (refreshTimer) clearTimeout(refreshTimer)
  })

  const syncAfterCreate = async (existing?: { title: string; url: string }) => {
    if (!options.enabled()) return
    if (existing?.url) {
      queryClient.setQueryData(readinessKey(), (old: VcsPullRequestReadiness | undefined) => ({
        ...(old ?? emptyPrReadiness()),
        existing_pull_request: existing,
      }))
    }
    const first = await refreshReadiness()
    if (existing?.url && !first?.existing_pull_request?.url) {
      await new Promise((resolve) => setTimeout(resolve, 500))
      await refreshReadiness()
    }
    if (first) {
      void queryClient.refetchQueries({ queryKey: statusKey(), type: "active" })
    }
  }

  const refreshStatus = () => {
    if (!data()) {
      void refreshReadiness()
      return
    }
    void queryClient.refetchQueries({ queryKey: statusKey(), type: "active" })
  }

  const getSnapshot = () => {
    const full = data()
    const status = statusOverlay()
    if (!full) return undefined
    if (!status) return full
    return {
      ...full,
      gh_cli: status.gh_cli,
      gh_authenticated: status.gh_authenticated,
      branch: status.branch ?? full.branch,
      existing_pull_request: status.existing_pull_request,
    }
  }

  return {
    data,
    ghCli,
    ghAuthenticated,
    existingPullRequest,
    isPending,
    isError,
    isRefreshing,
    syncAfterCreate,
    scheduleRefreshFull,
    refreshStatus,
    getSnapshot,
  }
}
