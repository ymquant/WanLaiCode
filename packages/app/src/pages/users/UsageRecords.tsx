import type { ErrorAction } from "@opencode-ai/core/error/error-actions"
import { Icon } from "@opencode-ai/ui/icon"
import { createMemo, createResource, createSignal, For, Match, Show, Switch } from "solid-js"
import { useGlobalSDK } from "@/context/global-sdk"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import {
  AuthStatusFallback,
  cacheTokens,
  finiteNumber,
  formatDateTime,
  formatDuration,
  formatNumber,
  InlineErrorState,
  InlineState,
  SettingsRow,
  SettingsSection,
  TokenBreakdown,
  unwrapSDKSafe,
} from "./shared"
import { platformFilters, usagePageSize, type PlatformFilter, type UsageRecord, type UsageStats, type UserCenterStatusProps } from "./types"

function UsageTableHeader() {
  const language = useLanguage()

  return (
    <div
      class="hidden border-b border-border-weaker-base px-4 py-2.5 text-12-medium uppercase tracking-normal
        text-text-weak sm:grid sm:grid-cols-[minmax(0,1fr)_280px] sm:gap-3"
    >
      <div>{language.t("users.usage.table.model")}</div>
      <div class="grid grid-cols-[1.7fr_0.9fr] gap-x-4">
        <div>{language.t("users.usage.table.token")}</div>
        <div>{language.t("users.usage.table.actual")}</div>
      </div>
    </div>
  )
}

function requestTypeLabel(row: UsageRecord, language: ReturnType<typeof useLanguage>) {
  if (row.request_type === "ws_v2") return language.t("users.usage.type.ws")
  if (row.request_type === "stream" || row.stream) return language.t("users.usage.type.stream")
  if (row.request_type === "sync" || row.stream === false) return language.t("users.usage.type.sync")
  return language.t("users.usage.type.unknown")
}

function redistributeProportional(raw: { input: number; output: number; cache: number }, total: number) {
  // Largest-remainder allocation keeps displayed input/output/cache integers summing exactly to billed total.
  const rawTotal = raw.input + raw.output + raw.cache
  if (total <= 0 || rawTotal <= 0) return { input: 0, output: 0, cache: 0, total }

  const scaled = (Object.entries(raw) as Array<[keyof typeof raw, number]>)
    .filter((entry) => entry[1] > 0)
    .map(([key, value]) => ({
      key,
      value: Math.floor((value / rawTotal) * total),
      remainder: (value / rawTotal) * total - Math.floor((value / rawTotal) * total),
    }))
  const remainder = total - scaled.reduce((sum, item) => sum + item.value, 0)
  return [...scaled]
    .sort((a, b) => b.remainder - a.remainder)
    .map((item, index) => ({ ...item, value: item.value + (index < remainder ? 1 : 0) }))
    .reduce(
      (tokens, item) => ({ ...tokens, [item.key]: item.value }),
      { input: 0, output: 0, cache: 0, total },
    )
}

function visibleTokenBreakdown(row: UsageRecord) {
  const raw = {
    input: finiteNumber(row.input_tokens),
    output: finiteNumber(row.output_tokens),
    cache: cacheTokens(row),
  }
  const rawTotal = raw.input + raw.output + raw.cache
  return redistributeProportional(raw, Math.max(0, Math.round(finiteNumber(row.software_consumed_tokens, rawTotal))))
}

function UsageTableRow(props: { row: UsageRecord }) {
  const language = useLanguage()
  const tokens = createMemo(() => visibleTokenBreakdown(props.row))

  return (
    <div
      class="grid min-h-[76px] gap-3 border-b border-border-weaker-base px-4 py-3 last:border-b-0
        sm:grid-cols-[minmax(0,1fr)_280px] sm:items-center"
    >
      <div class="min-w-0">
        <div class="truncate text-13-medium text-text-strong">{props.row.model || "--"}</div>
        <div class="mt-1 truncate text-13-regular text-text-weak">
          {formatDateTime(props.row.created_at, language.intl())} · {props.row.platform || "--"} ·{" "}
          {requestTypeLabel(props.row, language)} · {formatDuration(props.row.duration_ms)}
        </div>
      </div>
      <div class="grid w-full grid-cols-2 gap-x-4 gap-y-2 text-left sm:grid-cols-[1.7fr_0.9fr]">
        <div>
          <div class="text-12-medium text-text-weak sm:hidden">{language.t("users.usage.table.token")}</div>
          <TokenBreakdown input={tokens().input} output={tokens().output} cache={tokens().cache} />
        </div>
        <div>
          <div class="text-12-medium text-text-weak sm:hidden">{language.t("users.usage.table.actual")}</div>
          <div class="text-12-medium text-text-strong">{formatNumber(tokens().total, language.intl())}</div>
        </div>
      </div>
    </div>
  )
}

function AuthFallback(props: UserCenterStatusProps & { onErrorAction?: (action: ErrorAction) => void }) {
  const language = useLanguage()
  return <AuthStatusFallback {...props} title={language.t("users.usage.summary")} usageRequiresOAuth onErrorAction={props.onErrorAction} />
}

export function UsageRecords(props: UserCenterStatusProps) {
  const language = useLanguage()
  const globalSDK = useGlobalSDK()
  const platform = usePlatform()
  const [platformFilter, setPlatformFilter] = createSignal<PlatformFilter>("all")
  const [usagePage, setUsagePage] = createSignal(1)

  // 用户中心内部错误行为路由
  function handleErrorAction(action: ErrorAction) {
    if (action === "relogin") {
      platform.openLoginWindow?.()
      return
    }
    if (action === "open_purchase") {
      props.selectTab("purchase")
      return
    }
    if (action === "show_quota") {
      props.selectTab("quota")
      return
    }
  }
  const usageQuery = createMemo(() => {
    if (props.status()?.auth_type !== "oauth") return
    return {
      page: usagePage(),
      platform: platformFilter() === "all" ? undefined : platformFilter(),
    }
  })
  const statsQuery = createMemo(() => {
    if (props.status()?.auth_type !== "oauth") return
    return {
      platform: platformFilter() === "all" ? undefined : platformFilter(),
    }
  })
  const [usage] = createResource(usageQuery, (query) =>
    unwrapSDKSafe(
      globalSDK.client.wanlaicodeUserCenter.usage.list({
        page: String(query.page),
        page_size: String(usagePageSize),
        platform: query.platform,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }),
      { items: [], total: 0, page: query.page, page_size: usagePageSize, pages: 1 },
    ),
  )
  const [stats] = createResource(statsQuery, (query) =>
    unwrapSDKSafe(
      globalSDK.client.wanlaicodeUserCenter.usage.stats({
        platform: query.platform,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }),
      {},
    ),
  )
  const usageData = createMemo(() => usage.latest)
  const statsData = createMemo(() => stats.latest)
  const rows = createMemo(() => (usageData()?.items ?? []) as UsageRecord[])
  const summary = createMemo(() => (statsData() ?? {}) as UsageStats)
  const total = createMemo(() => finiteNumber(usageData()?.total))
  const pageCount = createMemo(() => Math.max(1, finiteNumber(usageData()?.pages, 1)))
  const displayPage = createMemo(() => finiteNumber(usageData()?.page, usagePage()))

  function selectPlatformFilter(platform: PlatformFilter) {
    setPlatformFilter(platform)
    setUsagePage(1)
  }

  return (
    <section class="grid gap-7">
      <Show
        when={props.status()?.auth_type === "oauth"}
        fallback={<AuthFallback {...props} onErrorAction={handleErrorAction} />}
      >
        <SettingsSection title={language.t("users.usage.summary")}>
          <Show when={statsData()?.__error}>
            {(error) => <InlineErrorState message={error()} />}
          </Show>
          <SettingsRow title={language.t("users.usage.requests")} description={language.t("users.usage.currentFilter")}>
            <span class="text-13-medium text-text-strong">
              {formatNumber(finiteNumber(summary().total_requests), language.intl())}
            </span>
          </SettingsRow>
          <SettingsRow title={language.t("users.usage.actualTokens")} description={language.t("users.usage.actualTokensDescription")}>
            <span class="text-13-medium text-text-strong">
              {formatNumber(
                finiteNumber(summary().total_software_consumed_tokens, finiteNumber(summary().total_tokens)),
                language.intl(),
              )}
            </span>
          </SettingsRow>
          <SettingsRow title={language.t("users.usage.platformFilter")} description={language.t("users.usage.platformFilterDescription")}>
            <div class="flex flex-wrap gap-1.5">
              <For each={platformFilters}>
                {(platform) => (
                  <button
                    type="button"
                    class="h-7 rounded-md border border-border-weaker-base bg-background-base px-2.5 text-12-medium
                      text-text-weak transition-colors hover:bg-surface-base-hover hover:text-text-strong"
                    classList={{
                      "border-border-weak-base bg-surface-interactive-base text-text-interactive-base":
                        platformFilter() === platform,
                    }}
                    onClick={() => selectPlatformFilter(platform)}
                  >
                    {platform === "all" ? language.t("users.platform.all") : platform}
                  </button>
                )}
              </For>
            </div>
          </SettingsRow>
        </SettingsSection>

        <SettingsSection title={language.t("users.usage.records")}>
          <Show when={usageData()?.__error}>
            {(error) => <InlineErrorState message={error()} />}
          </Show>
          <Switch>
            <Match when={usage.loading && !usageData()}>
              <InlineState title={language.t("users.auth.loading")} />
            </Match>
            <Match when={usage.error && !usageData()}>
              {/* usage.error 是原始错误对象，使用 resolveError 获取语义文案 */}
              <InlineErrorState message={usage.error instanceof Error ? usage.error.message : String(usage.error)} />
            </Match>
            <Match when={rows().length === 0}>
              <InlineState title={language.t("users.usage.empty.title")} description={language.t("users.usage.empty.description")} />
            </Match>
            <Match when={rows().length > 0}>
              <UsageTableHeader />
              <For each={rows()}>{(row) => <UsageTableRow row={row} />}</For>
              <div class="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-12-regular text-text-weak">
                <span>
                  {language.t("users.usage.pagination", {
                    page: displayPage(),
                    pages: pageCount(),
                    total: total(),
                  })}
                </span>
                <div class="flex items-center gap-1.5">
                  <button
                    type="button"
                    class="flex h-7 items-center gap-1 rounded-md border border-border-weaker-base bg-background-base px-2
                      text-12-medium text-text-base transition-colors hover:bg-surface-base-hover
                      disabled:pointer-events-none disabled:opacity-40"
                    disabled={usage.loading || usagePage() <= 1}
                    onClick={() => setUsagePage((page) => Math.max(1, page - 1))}
                  >
                    <Icon name="chevron-left" size="small" />
                    {language.t("users.actions.previousPage")}
                  </button>
                  <button
                    type="button"
                    class="flex h-7 items-center gap-1 rounded-md border border-border-weaker-base bg-background-base px-2
                      text-12-medium text-text-base transition-colors hover:bg-surface-base-hover
                      disabled:pointer-events-none disabled:opacity-40"
                    disabled={usage.loading || usagePage() >= pageCount()}
                    onClick={() => setUsagePage((page) => Math.min(pageCount(), page + 1))}
                  >
                    {language.t("users.actions.nextPage")}
                    <Icon name="chevron-right" size="small" />
                  </button>
                </div>
              </div>
            </Match>
          </Switch>
        </SettingsSection>
      </Show>
    </section>
  )
}
