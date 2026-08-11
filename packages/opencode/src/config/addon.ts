import { Schema } from "effect"
import { zod } from "@/util/effect-zod"
import { withStatics } from "@/util/schema"

// addon 总开关 + 额外搜索路径
export const Info = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean).annotate({
    description: "Enable or disable addon support",
  }),
  paths: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
    description: "Additional paths to search for addons",
  }),
}).pipe(withStatics((s) => ({ zod: zod(s) })))
export type Info = Schema.Schema.Type<typeof Info>

// per-tool approval 覆盖
export const ToolApproval = Schema.Struct({
  approval: Schema.optional(Schema.Literals(["auto", "prompt", "approve"])).annotate({
    description: "Tool-level approval mode override",
  }),
}).pipe(withStatics((s) => ({ zod: zod(s) })))
export type ToolApproval = Schema.Schema.Type<typeof ToolApproval>

// per-mcp-server 覆盖配置（对应 codex plugins.X.mcp_servers.Y 字段）
export const McpServerUserConfig = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean).annotate({
    description: "Enable or disable this MCP server from the addon",
  }),
  default_tools_approval_mode: Schema.optional(Schema.Literals(["auto", "prompt", "approve"])).annotate({
    description: "Default approval mode for all tools from this server",
  }),
  enabled_tools: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
    description: "Whitelist of tool names to enable (others are disabled)",
  }),
  disabled_tools: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
    description: "Blacklist of tool names to disable",
  }),
  tools: Schema.optional(Schema.Record(Schema.String, ToolApproval)).annotate({
    description: "Per-tool approval overrides",
  }),
}).pipe(withStatics((s) => ({ zod: zod(s) })))
export type McpServerUserConfig = Schema.Schema.Type<typeof McpServerUserConfig>

// per-plugin 用户覆盖配置（对应 codex [plugins."<plugin>@<market>"] 字段）
export const PluginUserConfig = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean).annotate({
    description: "Enable or disable this plugin entirely",
  }),
  mcp_servers: Schema.optional(Schema.Record(Schema.String, McpServerUserConfig)).annotate({
    description: "Per-MCP-server configuration overrides for this plugin",
  }),
  disabled_skills: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
    description: "Skill names to disable for this plugin (by skill name, not namespaced)",
  }),
}).pipe(withStatics((s) => ({ zod: zod(s) })))
export type PluginUserConfig = Schema.Schema.Type<typeof PluginUserConfig>

// marketplace 来源配置（对应 codex [marketplaces.X] 字段）
export const MarketplaceConfig = Schema.Struct({
  source_type: Schema.optional(Schema.Literals(["git", "local"])).annotate({
    description: "Type of marketplace source",
  }),
  source: Schema.optional(Schema.String).annotate({
    description: "Git URL or local filesystem path of the marketplace",
  }),
  ref: Schema.optional(Schema.String).annotate({
    description: "Git ref (branch/tag/commit) to checkout",
  }),
  sparse_paths: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
    description: "Sparse-checkout paths within the git repo",
  }),
  last_revision: Schema.optional(Schema.String).annotate({
    description: "Last known git revision (filled after install/upgrade)",
  }),
  last_updated: Schema.optional(Schema.String).annotate({
    description: "ISO timestamp of last update",
  }),
}).pipe(withStatics((s) => ({ zod: zod(s) })))
export type MarketplaceConfig = Schema.Schema.Type<typeof MarketplaceConfig>

// Namespace export for use as `import { ConfigAddon } from "./addon"`
export const ConfigAddon = {
  Info,
  ToolApproval,
  McpServerUserConfig,
  PluginUserConfig,
  MarketplaceConfig,
} as const

