import { describe, expect, test } from "bun:test"
import type { McpManagementItem } from "@opencode-ai/sdk/v2"
import {
  filterManagedMcps,
  groupManagedMcps,
  initialManageTab,
  managedMcpListState,
  mcpOAuthAction,
  mcpDetailPath,
  visibleManageTabs,
} from "./plugins-manage-model"

const managedMcps: McpManagementItem[] = [
  {
    name: "local-tools",
    source: "custom",
    type: "local",
    enabled: true,
    editable: true,
    status: { status: "connected" },
    supports_oauth: false,
  },
  {
    name: "remote-search",
    source: "addon",
    addon_key: "search",
    addon_name: "Search",
    type: "remote",
    enabled: false,
    editable: false,
    status: { status: "disabled" },
    supports_oauth: true,
  },
]

describe("Plugins manage list localization", () => {
  test("renders plugin rows from locale-aware available metadata before raw installed info", async () => {
    const manage = await Bun.file(new URL("./plugins-manage.tsx", import.meta.url)).text()

    expect(manage).toContain("return meta?.display_name?.trim() || info.display_name?.trim() || info.name || info.key")
    expect(manage).toContain("return info.error ?? meta?.description ?? info.description ?? info.marketplace_name")
    expect(manage).toContain("const name = () => pluginDisplayName(props.info, props.meta)")
    expect(manage).toContain("const subtitle = () => pluginDescription(props.info, props.meta)")
  })

  test("supports dropping a local plugin archive onto the page", async () => {
    const manage = await Bun.file(new URL("./plugins-manage.tsx", import.meta.url)).text()

    expect(manage).toContain("resolveDroppedLocalPluginArchive")
    expect(manage).toContain("handleArchiveDrop")
    expect(manage).toContain("onDrop={handleArchiveDrop}")
  })

  test("previews a dropped archive and asks for confirmation before installing", async () => {
    const manage = await Bun.file(new URL("./plugins-manage.tsx", import.meta.url)).text()

    expect(manage).toContain("previewArchive")
    expect(manage).toContain(
      "sdk.client.addon.previewArchive({\n        addonLocalArchivePreviewRequest: { archive_path: archivePath, locale: language.locale() },",
    )
    expect(manage).toContain("DialogLocalPluginArchive")
    expect(manage).toContain("onConfirm")
  })

  test("previews a picked archive before installing", async () => {
    const manage = await Bun.file(new URL("./plugins-manage.tsx", import.meta.url)).text()

    expect(manage).toContain("previewLocalArchive.mutate(archivePath)")
    expect(manage).not.toContain("installLocalArchive.mutate(archivePath)")
  })
})

describe("Plugins manage MCP tab", () => {
  test("restores the MCP tab and keeps it visible when it has no servers", () => {
    expect(initialManageTab("mcps")).toBe("mcps")
    expect(initialManageTab(undefined)).toBe("plugins")
    expect(initialManageTab("unknown")).toBe("plugins")
    expect(
      visibleManageTabs({
        plugins: 0,
        apps: 0,
        mcps: 0,
        skills: 0,
        marketplace: 0,
      }),
    ).toEqual(["mcps"])
  })

  test("never exposes the marketplace as a management tab", () => {
    expect(initialManageTab("marketplace")).toBe("plugins")
    expect(
      visibleManageTabs({
        plugins: 1,
        apps: 7,
        mcps: 2,
        skills: 9,
        marketplace: 2,
      }),
    ).toEqual(["plugins", "apps", "mcps", "skills"])
  })

  test("searches managed MCPs by name, source, type, and addon source label", () => {
    expect(filterManagedMcps(managedMcps, "local")).toEqual([managedMcps[0]])
    expect(filterManagedMcps(managedMcps, "custom")).toEqual([managedMcps[0]])
    expect(filterManagedMcps(managedMcps, "remote")).toEqual([managedMcps[1]])
    expect(filterManagedMcps(managedMcps, "search")).toEqual([managedMcps[1]])
    expect(
      filterManagedMcps(managedMcps, "流式 HTTP", {
        custom: "自定义",
        addon: "插件",
        local: "STDIO",
        remote: "流式 HTTP",
      }),
    ).toEqual([managedMcps[1]])
  })

  test("groups filtered MCPs into custom servers and plugin-provided servers", () => {
    expect(groupManagedMcps(managedMcps, "")).toEqual({
      custom: [managedMcps[0]],
      addon: [managedMcps[1]],
    })
    expect(groupManagedMcps(managedMcps, "remote")).toEqual({
      custom: [],
      addon: [managedMcps[1]],
    })
  })

  test("distinguishes an initial failure from an empty list and retains cached rows on refetch failure", () => {
    const error = new Error("management unavailable")

    expect(managedMcpListState(undefined, error, false)).toEqual({
      content: "error",
      showError: true,
    })
    expect(managedMcpListState([], undefined, false)).toEqual({
      content: "empty",
      showError: false,
    })
    expect(managedMcpListState(managedMcps, error, false)).toEqual({
      content: "list",
      showError: true,
    })
    expect(managedMcpListState(undefined, undefined, true)).toEqual({
      content: "loading",
      showError: false,
    })
  })

  test("keeps the new route separate from a server literally named new", () => {
    expect(mcpDetailPath("new")).toBe("/plugins/manage/mcp/detail/new")
    expect(mcpDetailPath("team-server", true)).toBe("/plugins/manage/mcp/detail/team-server#oauth-advanced")
  })

  test("only exposes OAuth actions for the supported status matrix", () => {
    const item = (status: McpManagementItem["status"], supports_oauth = true): McpManagementItem => ({
      ...managedMcps[1],
      status,
      supports_oauth,
    })

    expect(mcpOAuthAction(item({ status: "connected" }))).toBe("authenticate")
    expect(mcpOAuthAction(item({ status: "needs_auth" }))).toBe("authenticate")
    expect(
      mcpOAuthAction({
        ...item({ status: "needs_client_registration", error: "Register a client" }),
        editable: true,
      }),
    ).toBe("advanced")
    expect(mcpOAuthAction(item({ status: "needs_client_registration", error: "Register a client" }))).toBeUndefined()
    expect(mcpOAuthAction(item({ status: "disabled" }))).toBeUndefined()
    expect(mcpOAuthAction(item({ status: "connecting" }))).toBeUndefined()
    expect(mcpOAuthAction(item({ status: "failed", error: "Disconnected" }))).toBeUndefined()
    expect(mcpOAuthAction(item({ status: "connected" }, false))).toBeUndefined()
  })

  test("wires management SDK actions and editor routes", async () => {
    const manage = await Bun.file(new URL("./plugins-manage.tsx", import.meta.url)).text()
    const editor = await Bun.file(new URL("./mcp-editor.tsx", import.meta.url)).text()
    const connection = await Bun.file(new URL("../utils/mcp-connection.ts", import.meta.url)).text()
    const app = await Bun.file(new URL("../app.tsx", import.meta.url)).text()

    expect(manage).toContain('navigate("/plugins/manage/mcp/new")')
    expect(manage).toContain("sdk.client.mcp.management.list")
    expect(manage).toContain("sdk.client.mcp.management.toggle")
    expect(manage).toContain("authenticateMcp")
    expect(manage).toContain("mcpOAuthAction")
    expect(manage).toContain('language.t("plugins.manage.mcp.reauthenticate")')
    expect(manage).not.toContain("function CodexMcpPluginRow(props: { item: McpManagementItem; onOpen: () => void })")
    expect(connection).toContain("client.mcp.auth.authenticate")
    expect(editor).toContain("sdk.client.mcp.management.get")
    expect(editor).toContain("sdk.client.mcp.management.save")
    expect(editor).toContain("sdk.client.mcp.management.remove")
    expect(editor).toContain("formatServerError")
    expect(app).toContain('path="/plugins/manage/mcp/new"')
    expect(app).toContain('path="/plugins/manage/mcp/detail/:name"')
    expect(app).not.toContain('path="/plugins/manage/mcp/:name"')
    expect(manage).toContain("setTab(initialManageTab(searchParams.tab))")
    expect(manage).not.toContain("if (searchParams.tab) setTab")
  })

  test("uses the Codex MCP section layout", async () => {
    const manage = await Bun.file(new URL("./plugins-manage.tsx", import.meta.url)).text()

    expect(manage).toContain('language.t("plugins.manage.mcp.servers")')
    expect(manage).toContain('language.t("plugins.manage.mcp.fromPlugins")')
    expect(manage).toContain('language.t("plugins.manage.mcp.add")')
    expect(manage).toContain("groupManagedMcps")
    expect(manage).toContain("rounded-[20px] border border-border-weaker-base")
  })

  test("keeps OAuth advanced configuration visible for existing remote MCPs", async () => {
    const editor = await Bun.file(new URL("./mcp-editor.tsx", import.meta.url)).text()

    expect(editor).toContain('id="oauth-advanced"')
    expect(editor).not.toContain("compact={!creating()}")
    expect(editor).not.toContain("<Show when={!props.compact}>")
  })

  test("shares the Codex page shell with the other management tabs", async () => {
    const manage = await Bun.file(new URL("./plugins-manage.tsx", import.meta.url)).text()
    const header = await Bun.file(new URL("./plugins-manage-header.tsx", import.meta.url)).text()

    expect(header).toContain("function ManagePageHeader")
    expect(manage).toContain("<ManagePageHeader")
    expect(manage).toContain("h-[94px]")
    expect(manage).toContain("plugins.manage.search.placeholder")
  })

  test("keeps the editor back action outside the drag region", async () => {
    const editor = await Bun.file(new URL("./mcp-editor.tsx", import.meta.url)).text()
    const back = editor.slice(
      editor.lastIndexOf("<button", editor.indexOf('mcp.editor.action.back')),
      editor.indexOf("</button>", editor.indexOf('mcp.editor.action.back')),
    )

    expect(back).toContain("style={NO_DRAG}")
    expect(editor).not.toContain("MCP_DOCUMENTATION_URL")
  })

  test("uses stable indexed rows for dynamic text inputs", async () => {
    const editor = await Bun.file(new URL("./mcp-editor.tsx", import.meta.url)).text()

    expect(editor).toContain("<Index each={props.draft.args}>")
    expect(editor).toContain("<Index each={props.draft.inherited_environment}>")
    expect(editor).toContain("<Index each={props.rows}>")
    expect(editor).not.toContain("<For each={props.draft.args}>")
    expect(editor).not.toContain("<For each={props.draft.inherited_environment}>")
  })
})
