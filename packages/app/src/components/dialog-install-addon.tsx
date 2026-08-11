import { Component, For, Show, type JSX } from "solid-js"
import { useMutation, useQueryClient } from "@tanstack/solid-query"
import { Button } from "@opencode-ai/ui/button"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { showToast } from "@opencode-ai/ui/toast"
import type { AddonAvailable } from "@opencode-ai/sdk/v2"
import { useGlobalSDK } from "@/context/global-sdk"
import { useLanguage } from "@/context/language"
import { formatServerError } from "@/utils/server-errors"

function displayName(info: AddonAvailable): string {
  return info.display_name?.trim() || info.name || info.key
}

export const DialogInstallAddon: Component<{
  addon: AddonAvailable
  version?: string
  onInstall?: () => Promise<unknown>
  onInstalled?: () => void
}> = (props) => {
  const language = useLanguage()
  const sdk = useGlobalSDK()
  const queryClient = useQueryClient()
  const dialog = useDialog()

  const install = useMutation(() => ({
    mutationFn: async () => {
      if (props.onInstall) return props.onInstall()
      return sdk.client.addon.install({ addonInstallRequest: { addon_key: props.addon.key } })
    },
    onSuccess: async () => {
      // refetchType:"all" 让 inactive 页(如未挂载的 Manage 页)也立即后台重拉,
      // 不只标 stale;配合 Manage 页 refetchOnMount:"always" 双重保证刷新。
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["addon", "available", "global"], refetchType: "all" }),
        queryClient.invalidateQueries({ queryKey: ["addon", "list", "global"], refetchType: "all" }),
        queryClient.invalidateQueries({ queryKey: ["addon", "detail", props.addon.key], refetchType: "all" }),
      ])
      props.onInstalled?.()
      dialog.close()
    },
    onError: (err) =>
      showToast({
        variant: "error",
        title: language.t("plugins.install.failed"),
        description: formatServerError(err, language.t, language.t("common.requestFailed")),
      }),
  }))

  const installCta = () =>
    install.isPending
      ? language.t("plugins.installing")
      : language.t("plugins.install.dialog.cta", { name: displayName(props.addon) })

  return (
    <Dialog fit>
      {/* fit 模式 dialog 跟随内容高度;内层用一个 max-h 限制 + overflow-y-auto,
          整窗（logo / 信息卡 / 按钮）作为一个滚动单元 —— 视口够大时无滚动条,不够时整体卷动。 */}
      <div class="w-full max-h-[calc(100vh-96px)] overflow-y-auto px-6 py-6 flex flex-col gap-6">
        <div class="flex flex-col items-center gap-3">
          <PluginLogo addon={props.addon} />
          <div class="text-18-medium text-text-strong">
            {language.t("plugins.install.dialog.title", { name: displayName(props.addon) })}
          </div>
          <Show when={props.addon.developer_name}>
            <div class="text-13-regular text-text-weak">
              {language.t("plugins.install.dialog.developer", { name: props.addon.developer_name! })}
            </div>
          </Show>
        </div>

        <div class="border border-border-weak-base rounded-xl px-5 py-4 flex flex-col gap-4">
          <div class="flex items-center gap-2 flex-wrap">
            <div class="text-14-medium text-text-strong">{displayName(props.addon)}</div>
            <span class="text-12-regular text-text-weak px-2 py-0.5 rounded-full border border-border-weak-base">
              {props.addon.marketplace_name}
            </span>
            <Show when={props.version}>
              <span class="text-12-regular text-text-weak px-2 py-0.5 rounded-full border border-border-weak-base">
                v{props.version}
              </span>
            </Show>
          </div>
          <Show when={props.addon.registry_namespace}>
            <Row label={`${language.t("plugins.detail.info.namespace")}: ${props.addon.registry_namespace!}`} />
          </Show>
          <Show when={props.addon.developer_name}>
            <Row label={language.t("plugins.install.dialog.by", { name: props.addon.developer_name! })} />
          </Show>
          <Show when={props.addon.category}>
            <Row
              label={language.t("plugins.install.dialog.category", { name: props.addon.category! })}
            />
          </Show>
          <Show when={props.addon.long_description || props.addon.description}>
            <Section title={language.t("plugins.install.dialog.about")}>
              <p class="text-13-regular text-text-base whitespace-pre-line">
                {props.addon.long_description || props.addon.description}
              </p>
            </Section>
          </Show>
          <Show when={hasIncludes(props.addon)}>
            <Section title={language.t("plugins.install.dialog.includes")}>
              <Show when={(props.addon.manifest_skills ?? []).length > 0}>
                <Subhead label={language.t("plugins.install.dialog.skills.heading")} />
                <Chips
                  items={(props.addon.manifest_skills ?? []).map(
                    (s) => s.display_name ?? s.name,
                  )}
                />
              </Show>
              <Show when={(props.addon.manifest_mcp_servers ?? []).length > 0}>
                <Subhead label={language.t("plugins.install.dialog.mcp.heading")} />
                <Chips items={(props.addon.manifest_mcp_servers ?? []).map((m) => m.name)} />
              </Show>
              <Show when={(props.addon.manifest_apps ?? []).length > 0}>
                <Subhead label={language.t("plugins.install.dialog.apps.heading")} />
                <Chips items={(props.addon.manifest_apps ?? []).map((a) => a.name)} />
              </Show>
            </Section>
          </Show>
          <Show when={(props.addon.capabilities ?? []).length > 0}>
            <Section title={language.t("plugins.install.dialog.capabilities")}>
              <Chips items={[...(props.addon.capabilities ?? [])]} />
            </Section>
          </Show>
        </div>

        <Button
          class="w-full !rounded-[50px]"
          variant="primary"
          size="large"
          disabled={install.isPending}
          onClick={() => install.mutate()}
        >
          {installCta()}
        </Button>
      </div>
    </Dialog>
  )
}

function hasIncludes(info: AddonAvailable): boolean {
  return (
    (info.manifest_apps?.length ?? 0) > 0 ||
    (info.manifest_mcp_servers?.length ?? 0) > 0 ||
    (info.manifest_skills?.length ?? 0) > 0
  )
}

function Row(props: { label: string }): JSX.Element {
  return <div class="text-13-regular text-text-base">{props.label}</div>
}

function Section(props: { title: string; children: JSX.Element }): JSX.Element {
  return (
    <div class="flex flex-col gap-2">
      <div class="text-13-medium text-text-strong">{props.title}</div>
      {props.children}
    </div>
  )
}

function Subhead(props: { label: string }): JSX.Element {
  return (
    <div class="text-11-medium uppercase tracking-wide text-text-weak mt-1">{props.label}</div>
  )
}

function Chips(props: { items: string[] }): JSX.Element {
  return (
    <div class="flex flex-wrap gap-2">
      <For each={props.items}>
        {(label) => (
          <span class="text-12-regular text-text-base px-2.5 py-0.5 rounded-lg border border-border-weak-base bg-background-stronger leading-5">
            {label}
          </span>
        )}
      </For>
    </div>
  )
}

function PluginLogo(props: { addon: AddonAvailable }): JSX.Element {
  const bg = () =>
    props.addon.brand_color ? { "background-color": props.addon.brand_color } : undefined
  return (
    <Show
      when={props.addon.logo}
      fallback={
        <div
          class="size-14 rounded-2xl flex items-center justify-center bg-surface-base text-text-strong"
          style={bg()}
        >
          <Icon name="mcp" size="medium" />
        </div>
      }
    >
      <img
        src={props.addon.logo}
        alt={displayName(props.addon)}
        class="size-14 rounded-2xl object-cover bg-surface-base"
      />
    </Show>
  )
}
