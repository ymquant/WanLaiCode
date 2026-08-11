import { createResource, createMemo, For, Show } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { DialogSelect, type DialogSelectOption } from "@tui/ui/dialog-select"
import { useDialog } from "@tui/ui/dialog"
import { useSDK } from "@tui/context/sdk"
import { useTheme } from "@tui/context/theme"
import type { AddonDetail, AddonInfo, AddonMcpServer } from "@opencode-ai/sdk/v2"

function statusBadge(theme: ReturnType<typeof useTheme>["theme"], info: { disabled: boolean; error?: string }) {
  if (info.error) return <span style={{ fg: theme.error }}>✗ {info.error}</span>
  if (info.disabled) return <span style={{ fg: theme.textMuted }}>○ Disabled</span>
  return <span style={{ fg: theme.success, attributes: TextAttributes.BOLD }}>✓ Enabled</span>
}

function readNumber(value: number | "NaN" | "Infinity" | "-Infinity"): number {
  return typeof value === "number" ? value : 0
}

function formatCounts(counts: AddonInfo["counts"] | undefined) {
  const safe = counts ?? { mcp_servers: 0, skills: 0, hooks: 0, unsupported_hooks: 0 }
  const parts = [
    ["mcp", readNumber(safe.mcp_servers)],
    ["skill", readNumber(safe.skills)],
    ["hook", readNumber(safe.hooks)],
  ] as const
  const text = parts.map(([label, n]) => `${n} ${label}${n === 1 ? "" : "s"}`).join("  ")
  const unsupported = readNumber(safe.unsupported_hooks)
  if (unsupported > 0) return `${text}  (${unsupported} unsupported)`
  return text
}

function mcpKind(server: AddonMcpServer) {
  if (server.type === "local") return `local · ${server.command.slice(0, 2).join(" ")}`
  return `remote · ${server.url}`
}

export function DialogAddon() {
  const dialog = useDialog()
  const sdk = useSDK()
  const { theme } = useTheme()

  dialog.setSize("large")

  const [addons] = createResource(async () => {
    const result = await sdk.client.addon.list()
    return result.data ?? []
  })

  const options = createMemo<DialogSelectOption<AddonInfo>[]>(() => {
    const list = addons() ?? []
    const sorted = [...list].sort((a, b) => {
      const market = (a.marketplace_name ?? "").localeCompare(b.marketplace_name ?? "")
      if (market !== 0) return market
      return (a.name ?? "").localeCompare(b.name ?? "")
    })
    return sorted.map((addon) => ({
      value: addon,
      title: addon.display_name?.trim() || addon.name || "(unnamed)",
      description: addon.description?.replace(/\s+/g, " ").trim(),
      category: addon.marketplace_name,
      footer: (
        <span>
          {statusBadge(theme, addon)}
          <span style={{ fg: theme.textMuted }}> · {formatCounts(addon.counts)}</span>
        </span>
      ),
      onSelect: () => {
        dialog.replace(() => <DialogAddonDetail addonKey={addon.key} fallback={addon} />)
      },
    }))
  })

  return (
    <Show
      when={!addons.error}
      fallback={
        <box paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
          <text fg={theme.error}>
            Failed to load addons{addons.error instanceof Error ? `: ${addons.error.message}` : ""}
          </text>
        </box>
      }
    >
      <DialogSelect
        title="Addons"
        placeholder="Search addons..."
        options={options()}
        onSelect={(_option) => {
          // navigation handled in option.onSelect
        }}
      />
    </Show>
  )
}

function DialogAddonDetail(props: { addonKey: string; fallback: AddonInfo }) {
  const dialog = useDialog()
  const sdk = useSDK()
  const { theme } = useTheme()

  dialog.setSize("large")

  const [detail] = createResource(async () => {
    const result = await sdk.client.addon.get({ key: props.addonKey })
    return result.data
  })

  const view = createMemo<AddonDetail | AddonInfo>(() => detail() ?? props.fallback)
  const mcpEntries = createMemo(() => {
    const data = detail()
    if (!data) return [] as Array<[string, AddonMcpServer]>
    return Object.entries(data.mcp_servers ?? {}).sort(([a], [b]) => a.localeCompare(b))
  })

  return (
    <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          {view().display_name?.trim() || view().name || "(unnamed)"}
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.replace(() => <DialogAddon />)}>
          back
        </text>
      </box>

      <box flexDirection="column">
        <box flexDirection="row" gap={1}>
          <text fg={theme.textMuted}>key</text>
          <text fg={theme.text}>{view().key}</text>
        </box>
        <Show when={view().version}>
          {(version) => (
            <box flexDirection="row" gap={1}>
              <text fg={theme.textMuted}>version</text>
              <text fg={theme.text}>{version()}</text>
            </box>
          )}
        </Show>
        <box flexDirection="row" gap={1}>
          <text fg={theme.textMuted}>marketplace</text>
          <text fg={theme.text}>{view().marketplace_name}</text>
        </box>
        <box flexDirection="row" gap={1}>
          <text fg={theme.textMuted}>status</text>
          <text>{statusBadge(theme, view())}</text>
        </box>
        <Show when={(view() as AddonDetail).root}>
          {(root) => (
            <box flexDirection="row" gap={1}>
              <text fg={theme.textMuted}>root</text>
              <text fg={theme.text} wrapMode="word">
                {root()}
              </text>
            </box>
          )}
        </Show>
        <Show when={view().description}>
          {(description) => (
            <box flexDirection="column" marginTop={1}>
              <text fg={theme.textMuted}>description</text>
              <text fg={theme.text} wrapMode="word">
                {description()}
              </text>
            </box>
          )}
        </Show>
      </box>

      <Show when={detail.loading}>
        <text fg={theme.textMuted}>Loading detail…</text>
      </Show>

      <Show when={!detail.loading && detail.error}>
        <text fg={theme.error}>
          Failed to load addon detail{detail.error instanceof Error ? `: ${detail.error.message}` : ""}
        </text>
      </Show>

      <Show when={detail()}>
        {(d) => {
          const skills = () => d().skills ?? []
          const hooks = () => d().hooks ?? []
          const unsupported = () => d().unsupported_hook_events ?? []
          return (
            <>
              <box flexDirection="column">
                <text fg={theme.text} attributes={TextAttributes.BOLD}>
                  MCP Servers ({mcpEntries().length})
                </text>
                <Show
                  when={mcpEntries().length > 0}
                  fallback={<text fg={theme.textMuted}>No MCP servers</text>}
                >
                  <For each={mcpEntries()}>
                    {([name, server]) => (
                      <box flexDirection="row" gap={1}>
                        <text fg={theme.textMuted}>•</text>
                        <text fg={theme.text} wrapMode="word">
                          <b>{name}</b> <span style={{ fg: theme.textMuted }}>{mcpKind(server)}</span>
                          <Show when={server.enabled === false}>
                            <span style={{ fg: theme.warning }}> (disabled)</span>
                          </Show>
                        </text>
                      </box>
                    )}
                  </For>
                </Show>
              </box>

              <box flexDirection="column">
                <text fg={theme.text} attributes={TextAttributes.BOLD}>
                  Skills ({skills().length})
                </text>
                <Show when={skills().length > 0} fallback={<text fg={theme.textMuted}>No skills</text>}>
                  <For each={skills()}>
                    {(skill) => (
                      <box flexDirection="row" gap={1}>
                        <text fg={theme.textMuted}>•</text>
                        <text fg={theme.text} wrapMode="word">
                          <b>{skill.namespaced_name}</b>{" "}
                          <span style={{ fg: theme.textMuted }}>
                            {(skill.description ?? "").replace(/\s+/g, " ").trim()}
                          </span>
                        </text>
                      </box>
                    )}
                  </For>
                </Show>
              </box>

              <box flexDirection="column">
                <text fg={theme.text} attributes={TextAttributes.BOLD}>
                  Hooks ({hooks().length})
                </text>
                <Show when={hooks().length > 0} fallback={<text fg={theme.textMuted}>No hooks</text>}>
                  <For each={hooks()}>
                    {(hook) => (
                      <box flexDirection="row" gap={1}>
                        <text fg={theme.textMuted}>•</text>
                        <text fg={theme.text}>{hook}</text>
                      </box>
                    )}
                  </For>
                </Show>
              </box>

              <Show when={unsupported().length > 0}>
                <box flexDirection="column">
                  <text fg={theme.warning} attributes={TextAttributes.BOLD}>
                    Unsupported hook events ({unsupported().length})
                  </text>
                  <For each={unsupported()}>
                    {(event) => (
                      <box flexDirection="row" gap={1}>
                        <text fg={theme.textMuted}>•</text>
                        <text fg={theme.textMuted}>{event}</text>
                      </box>
                    )}
                  </For>
                </box>
              </Show>
            </>
          )
        }}
      </Show>
    </box>
  )
}
