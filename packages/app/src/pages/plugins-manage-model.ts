import type { McpManagementItem } from "@opencode-ai/sdk/v2"

export type ManageTab = "plugins" | "apps" | "mcps" | "skills" | "marketplace"
export type ManageTabCounts = Record<ManageTab, number>

export const MANAGE_TABS: ManageTab[] = ["plugins", "apps", "mcps", "skills"]

export function initialManageTab(value: string | undefined): ManageTab {
  return MANAGE_TABS.find((tab) => tab === value) ?? "plugins"
}

export function visibleManageTabs(counts: ManageTabCounts) {
  return MANAGE_TABS.filter((tab) => tab === "mcps" || counts[tab] > 0)
}

export function mcpDetailPath(name: string, oauthAdvanced = false) {
  return `/plugins/manage/mcp/detail/${encodeURIComponent(name)}${oauthAdvanced ? "#oauth-advanced" : ""}`
}

export function mcpOAuthAction(item: Pick<McpManagementItem, "editable" | "supports_oauth" | "status">) {
  if (item.status.status === "needs_client_registration") return item.editable ? ("advanced" as const) : undefined
  if (!item.supports_oauth) return
  if (item.status.status === "connected" || item.status.status === "needs_auth") return "authenticate" as const
}

export function managedMcpListState(
  data: McpManagementItem[] | undefined,
  error: unknown,
  pending: boolean,
): {
  content: "loading" | "error" | "empty" | "list"
  showError: boolean
} {
  if (data === undefined) {
    if (error) return { content: "error", showError: true }
    return { content: pending ? "loading" : "empty", showError: false }
  }
  return {
    content: data.length > 0 ? "list" : "empty",
    showError: !!error,
  }
}

export function filterManagedMcps(
  items: McpManagementItem[],
  query: string,
  labels?: Record<McpManagementItem["source"] | McpManagementItem["type"], string>,
) {
  const search = query.trim().toLowerCase()
  const sorted = [...items].sort((a, b) => a.name.localeCompare(b.name))
  if (!search) return sorted
  return sorted.filter((item) =>
    [item.name, item.source, item.type, labels?.[item.source], labels?.[item.type], item.addon_key, item.addon_name]
      .filter((value): value is string => !!value)
      .some((value) => value.toLowerCase().includes(search)),
  )
}

export function groupManagedMcps(
  items: McpManagementItem[],
  query: string,
  labels?: Record<McpManagementItem["source"] | McpManagementItem["type"], string>,
) {
  const filtered = filterManagedMcps(items, query, labels)
  return {
    custom: filtered.filter((item) => item.source === "custom"),
    addon: filtered.filter((item) => item.source === "addon"),
  }
}
