import { createQuery } from "@tanstack/solid-query"
import { Component, createSignal, For, Show } from "solid-js"
import { useGlobalSDK } from "@/context/global-sdk"
import { useLanguage } from "@/context/language"
import { Dialog } from "@opencode-ai/ui/dialog"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { List } from "@opencode-ai/ui/list"
import type { AddonDetail, AddonInfo, AddonMcpServer } from "@opencode-ai/sdk/v2"

type StatusKind = "enabled" | "disabled" | "error"

function statusKind(info: { disabled: boolean; error?: string }): StatusKind {
  if (info.error) return "error"
  if (info.disabled) return "disabled"
  return "enabled"
}

const statusDotClass: Record<StatusKind, string> = {
  enabled: "bg-icon-success-base",
  disabled: "bg-border-weak-base",
  error: "bg-icon-critical-base",
}

const statusTextClass: Record<StatusKind, string> = {
  enabled: "text-text-success",
  disabled: "text-text-weaker",
  error: "text-text-danger",
}

function StatusDot(props: { kind: StatusKind }) {
  return <div class={`size-1.5 rounded-full shrink-0 ${statusDotClass[props.kind]}`} />
}

function mcpKindLabel(server: AddonMcpServer) {
  if (server.type === "local") return server.command.slice(0, 2).join(" ") || "local"
  return server.url
}

export const DialogSelectAddon: Component = () => {
  const sdk = useGlobalSDK()
  const language = useLanguage()
  const [activeKey, setActiveKey] = createSignal<string | undefined>(undefined)

  const list = createQuery(() => ({
    queryKey: ["addon", "list", "global"],
    queryFn: async () => {
      const result = await sdk.client.addon.list()
      return result.data ?? []
    },
  }))

  const detail = createQuery(() => ({
    queryKey: ["addon", "detail", "global", activeKey() ?? ""],
    enabled: !!activeKey(),
    queryFn: async () => {
      const key = activeKey()
      if (!key) return null
      const result = await sdk.client.addon.get({ key })
      return result.data ?? null
    },
  }))

  const items = () => list.data ?? []
  const total = () => items().length
  const enabledCount = () => items().filter((i) => !i.disabled && !i.error).length
  const activeAddon = () => items().find((i) => i.key === activeKey())

  return (
    <Show
      when={activeKey() !== undefined}
      fallback={
        <Dialog
          title={language.t("dialog.addon.title")}
          description={language.t("dialog.addon.description", { enabled: enabledCount(), total: total() })}
        >
          <Show when={list.isError}>
            <div class="text-13-regular text-text-danger px-2 py-3">
              {language.t("dialog.addon.error")}
              {list.error instanceof Error ? `: ${list.error.message}` : ""}
            </div>
          </Show>
          <List
            search={{ placeholder: language.t("common.search.placeholder"), autofocus: true }}
            emptyMessage={language.t("dialog.addon.empty")}
            key={(x) => x?.key ?? ""}
            items={items}
            filterKeys={["name", "display_name", "marketplace_name", "description"]}
            sortBy={(a, b) => {
              const market = (a.marketplace_name ?? "").localeCompare(b.marketplace_name ?? "")
              if (market !== 0) return market
              return (a.name ?? "").localeCompare(b.name ?? "")
            }}
            onSelect={(addon) => {
              if (!addon) return
              setActiveKey(addon.key)
            }}
          >
            {(addon) => {
              const kind = statusKind(addon)
              return (
                <div class="w-full flex items-center gap-x-3 min-w-0 text-left">
                  <StatusDot kind={kind} />
                  <div class="flex flex-col gap-0.5 min-w-0 flex-1">
                    <div class="flex items-center gap-2 min-w-0">
                      <span class="text-14-regular text-text-base truncate">
                        {addon.display_name?.trim() || addon.name || "(unnamed)"}
                      </span>
                      <Show when={addon.marketplace_name}>
                        <span class="text-11-regular text-text-weaker shrink-0 truncate">
                          {addon.marketplace_name}
                        </span>
                      </Show>
                      <Show when={kind !== "enabled"}>
                        <span class={`text-11-regular shrink-0 ${statusTextClass[kind]}`}>
                          {addon.error ?? language.t(`dialog.addon.status.${kind}`)}
                        </span>
                      </Show>
                    </div>
                    <Show when={addon.description}>
                      <span class="text-11-regular text-text-weaker truncate">{addon.description}</span>
                    </Show>
                  </div>
                </div>
              )
            }}
          </List>
        </Dialog>
      }
    >
      <DialogAddonDetail
        addon={detail.data}
        fallback={activeAddon()}
        loading={!!activeKey() && detail.isLoading}
        error={detail.isError && detail.error instanceof Error ? detail.error.message : undefined}
        onBack={() => setActiveKey(undefined)}
      />
    </Show>
  )
}

const DialogAddonDetail: Component<{
  addon: AddonDetail | null | undefined
  fallback?: AddonInfo
  loading: boolean
  error?: string
  onBack: () => void
}> = (props) => {
  const language = useLanguage()
  const view = () => props.addon ?? props.fallback
  const detail = () => props.addon

  return (
    <Dialog
      title={
        <IconButton
          tabIndex={-1}
          icon="arrow-left"
          variant="ghost"
          onClick={props.onBack}
          aria-label={language.t("common.goBack")}
        />
      }
      description={
        <Show when={view()}>
          {(info) => {
            const kind = statusKind(info())
            return (
              <div class="flex items-center gap-2 min-w-0">
                <StatusDot kind={kind} />
                <span class="text-14-regular text-text-strong truncate">
                  {info().display_name?.trim() || info().name || "(unnamed)"}
                </span>
                <span class="text-11-regular text-text-weaker shrink-0">{info().marketplace_name}</span>
                <Show when={info().version}>
                  <span class="text-11-regular text-text-subtle shrink-0">{info().version}</span>
                </Show>
                <Show when={kind !== "enabled"}>
                  <span class={`text-11-regular shrink-0 ${statusTextClass[kind]}`}>
                    {info().error ?? language.t(`dialog.addon.status.${kind}`)}
                  </span>
                </Show>
              </div>
            )
          }}
        </Show>
      }
    >
      <div class="flex flex-col gap-4 px-2 pb-3 max-h-[60vh] overflow-y-auto">
        <Show when={view()?.description}>
          <div class="text-13-regular text-text-base">{view()!.description}</div>
        </Show>

        <Show when={detail()?.root}>
          <div class="text-11-regular text-text-weaker break-all">{detail()!.root}</div>
        </Show>

        <Show when={!detail() && props.loading}>
          <div class="text-13-regular text-text-weaker">{language.t("common.loading.ellipsis")}</div>
        </Show>

        <Show when={!detail() && !props.loading && props.error}>
          <div class="text-13-regular text-text-danger">
            {language.t("dialog.addon.error.detail")}: {props.error}
          </div>
        </Show>

        <Show when={detail()}>
          {(d) => {
            const mcp = () => Object.entries(d().mcp_servers ?? {}).sort(([a], [b]) => a.localeCompare(b))
            const skills = () => d().skills ?? []
            const hooks = () => d().hooks ?? []
            const unsupported = () => d().unsupported_hook_events ?? []
            return (
              <>
                <Section title={`MCP Servers · ${mcp().length}`}>
                  <Show when={mcp().length > 0} fallback={<EmptyRow text={language.t("dialog.addon.empty.mcp")} />}>
                    <For each={mcp()}>
                      {([name, server]) => (
                        <ItemRow
                          dot={server.enabled === false ? "disabled" : "enabled"}
                          title={name}
                          subtitle={mcpKindLabel(server)}
                          tag={server.type}
                        />
                      )}
                    </For>
                  </Show>
                </Section>

                <Section title={`Skills · ${skills().length}`}>
                  <Show when={skills().length > 0} fallback={<EmptyRow text={language.t("dialog.addon.empty.skills")} />}>
                    <For each={skills()}>
                      {(skill) => (
                        <ItemRow dot="enabled" title={skill.namespaced_name} subtitle={skill.description} />
                      )}
                    </For>
                  </Show>
                </Section>

                <Section title={`Hooks · ${hooks().length}`}>
                  <Show when={hooks().length > 0} fallback={<EmptyRow text={language.t("dialog.addon.empty.hooks")} />}>
                    <For each={hooks()}>{(hook) => <ItemRow dot="enabled" title={hook} />}</For>
                  </Show>
                </Section>

                <Show when={unsupported().length > 0}>
                  <Section title={`${language.t("dialog.addon.unsupportedHooks")} · ${unsupported().length}`}>
                    <For each={unsupported()}>{(event) => <ItemRow dot="disabled" title={event} muted />}</For>
                  </Section>
                </Show>
              </>
            )
          }}
        </Show>
      </div>
    </Dialog>
  )
}

const Section: Component<{ title: string; children: any }> = (props) => (
  <div class="flex flex-col gap-1">
    <div class="text-11-regular text-text-weaker uppercase tracking-wide">{props.title}</div>
    <div class="flex flex-col gap-0.5 bg-background-base rounded-sm p-2">{props.children}</div>
  </div>
)

const ItemRow: Component<{
  dot: StatusKind
  title: string
  subtitle?: string
  tag?: string
  muted?: boolean
}> = (props) => (
  <div class="flex items-center gap-2 px-2 py-1 min-w-0">
    <StatusDot kind={props.dot} />
    <span class={`text-13-regular truncate ${props.muted ? "text-text-weaker" : "text-text-base"}`}>
      {props.title}
    </span>
    <Show when={props.tag}>
      <span class="text-11-regular text-text-base bg-surface-base px-1.5 py-0.5 rounded-md shrink-0">
        {props.tag}
      </span>
    </Show>
    <Show when={props.subtitle}>
      <span class="text-11-regular text-text-weaker truncate flex-1 text-right">{props.subtitle}</span>
    </Show>
  </div>
)

const EmptyRow: Component<{ text: string }> = (props) => (
  <div class="text-12-regular text-text-weaker italic px-2 py-1">{props.text}</div>
)
