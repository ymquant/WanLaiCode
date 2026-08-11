import type { ErrorAction } from "@opencode-ai/core/error/error-actions"
import { createMemo, createResource, For, Show } from "solid-js"
import { useGlobalSDK } from "@/context/global-sdk"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { ErrorActionView } from "@/components/error-action-view"
import {
  AuthStatusFallback,
  formatDateTime,
  formatNumber,
  InlineState,
  QuotaProgress,
  SettingsRow,
  SettingsSection,
  unwrapSDKSafe,
  useUserCenterEvents,
} from "./shared"
import { canReadTokenPacks, type UserCenterStatusProps } from "./types"

// Token 包单条数据结构（对应后端 tokenPacks() 返回的 items 元素）
type TokenPackItem = {
  id?: number
  token_pack_id?: number
  name?: string
  billing_token_quota?: number
  billing_token_used?: number
  remaining?: number
  starts_at?: string | null
  expires_at?: string | null
  status?: string
}

type TokenPacksData = {
  items: TokenPackItem[]
  server_now_ms?: number
  __error?: string
  __errorObj?: unknown
}

function AuthFallback(props: UserCenterStatusProps & { onErrorAction?: (action: ErrorAction) => void }) {
  const language = useLanguage()
  return <AuthStatusFallback {...props} title={language.t("users.tokenPack.title")} onErrorAction={props.onErrorAction} />
}

// 按状态排序：active 优先，expired/inactive 置后
function sortTokenPacks(items: TokenPackItem[]): TokenPackItem[] {
  return [...items].sort((a, b) => {
    const aActive = a.status === "active" ? 0 : 1
    const bActive = b.status === "active" ? 0 : 1
    return aActive - bActive
  })
}

function tokenPackStatusLabel(item: TokenPackItem, language: ReturnType<typeof useLanguage>) {
  switch (item.status) {
    case "active":
      return language.t("users.tokenPack.status.active")
    case "expired":
      return language.t("users.tokenPack.status.expired")
    // 后端实际返回 "depleted"（耗尽），映射到 exhausted 语言键（已耗尽/已用完）
    case "depleted":
      return language.t("users.tokenPack.status.exhausted")
    default:
      return language.t("users.tokenPack.status.inactive")
  }
}

export function TokenPackBalance(props: UserCenterStatusProps) {
  const language = useLanguage()
  const globalSDK = useGlobalSDK()
  const platform = usePlatform()
  const productCode = () => props.status()?.product_code ?? "wanlaicode"

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

  const [tokenPacks, { refetch: refetchTokenPacks }] = createResource(
    () => (canReadTokenPacks(props.status()) ? productCode() : undefined),
    () =>
      unwrapSDKSafe(globalSDK.client.wanlaicodeUserCenter.tokenPacks(), {
        items: [],
      } as TokenPacksData),
  )
  useUserCenterEvents(globalSDK, {
    resources: ["entitlements", "status"],
    onChange: () => {
      if (canReadTokenPacks(props.status())) void refetchTokenPacks()
    },
  })

  const tokenPacksData = createMemo(() => tokenPacks.latest as TokenPacksData | undefined)
  const sortedPacks = createMemo(() => sortTokenPacks(tokenPacksData()?.items ?? []))

  return (
    <section class="grid gap-7">
      <Show when={canReadTokenPacks(props.status())} fallback={<AuthFallback {...props} onErrorAction={handleErrorAction} />}>
        <SettingsSection title={language.t("users.tokenPack.title")}>
          <Show when={tokenPacksData()?.__error}>
            {(error) => <ErrorActionView error={tokenPacksData()?.__errorObj ?? error()} onAction={handleErrorAction} />}
          </Show>
          <Show when={!tokenPacksData()?.__error}>
            <Show
              when={tokenPacks.loading && !tokenPacksData()}
              fallback={
                <Show
                  when={sortedPacks().length > 0}
                  fallback={
                    <InlineState
                      title={language.t("users.tokenPack.empty.title")}
                      description={language.t("users.tokenPack.empty.description")}
                    />
                  }
                >
                  <For each={sortedPacks()}>
                    {(pack) => {
                      const isActive = () => pack.status === "active"
                      const total = () => pack.billing_token_quota ?? 0
                      const used = () => pack.billing_token_used ?? 0
                      const remaining = () => pack.remaining ?? Math.max(total() - used(), 0)

                      return (
                        <SettingsRow
                          title={
                            <span
                              class="flex items-center gap-2"
                              classList={{ "opacity-50": !isActive() }}
                            >
                              <span>{pack.name || language.t("users.tokenPack.fallbackName")}</span>
                              <span
                                class="rounded-full px-2 py-0.5 text-11-medium"
                                classList={{
                                  "bg-surface-interactive-base text-text-on-interactive": isActive(),
                                  "bg-surface-base-active text-text-weak": !isActive(),
                                }}
                              >
                                {tokenPackStatusLabel(pack, language)}
                              </span>
                            </span>
                          }
                          description={
                            <span classList={{ "opacity-50": !isActive() }}>
                              {language.t("users.tokenPack.expiry", {
                                time: formatDateTime(pack.expires_at, language.intl()),
                              })}
                            </span>
                          }
                          align="start"
                        >
                          <Show
                            when={total() > 0}
                            fallback={
                              <span
                                class="text-12-regular text-text-weak"
                                classList={{ "opacity-50": !isActive() }}
                              >
                                {language.t("users.tokenPack.remaining", {
                                  value: formatNumber(remaining(), language.intl()),
                                })}
                              </span>
                            }
                          >
                            <div classList={{ "opacity-50": !isActive() }}>
                              <QuotaProgress
                                usedTokens={used()}
                                remainingTokens={remaining()}
                                totalTokens={total()}
                              />
                            </div>
                          </Show>
                        </SettingsRow>
                      )
                    }}
                  </For>
                </Show>
              }
            >
              <InlineState title={language.t("users.auth.loading")} />
            </Show>
          </Show>
        </SettingsSection>
      </Show>
    </section>
  )
}
