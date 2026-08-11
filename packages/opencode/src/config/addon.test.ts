import { test, expect } from "bun:test"
import { Info, PluginUserConfig, MarketplaceConfig } from "@/config/addon"

const ConfigAddon = { Info, PluginUserConfig, MarketplaceConfig }

test("Info schema - 解析 enabled: true, paths 配置", () => {
  const result = ConfigAddon.Info.zod.parse({ enabled: true, paths: ["/home/developer/.codex"] })
  expect(result.enabled).toBe(true)
  expect(result.paths).toEqual(["/home/developer/.codex"])
})

test("Info schema - 空对象合法", () => {
  const result = ConfigAddon.Info.zod.parse({})
  expect(result).toBeDefined()
})

test("PluginUserConfig - 解析包含 mcp_servers 的配置", () => {
  const result = ConfigAddon.PluginUserConfig.zod.parse({
    enabled: true,
    mcp_servers: {
      "code-search": {
        enabled: false,
        default_tools_approval_mode: "prompt",
        enabled_tools: ["search"],
        disabled_tools: ["delete"],
        tools: { search: { approval: "auto" } },
      },
    },
  })
  expect(result.enabled).toBe(true)
  expect(result.mcp_servers?.["code-search"]?.enabled).toBe(false)
  expect(result.mcp_servers?.["code-search"]?.default_tools_approval_mode).toBe("prompt")
  expect(result.mcp_servers?.["code-search"]?.enabled_tools).toEqual(["search"])
  expect(result.mcp_servers?.["code-search"]?.disabled_tools).toEqual(["delete"])
  expect(result.mcp_servers?.["code-search"]?.tools?.["search"]?.approval).toBe("auto")
})

test("MarketplaceConfig - 解析 local source 类型", () => {
  const result = ConfigAddon.MarketplaceConfig.zod.parse({
    source_type: "local",
    source: "/Users/developer/marketplace",
  })
  expect(result.source_type).toBe("local")
  expect(result.source).toBe("/Users/developer/marketplace")
})

test("MarketplaceConfig - 解析 git source 类型（完整字段）", () => {
  const result = ConfigAddon.MarketplaceConfig.zod.parse({
    source_type: "git",
    source: "https://github.com/openai/plugins.git",
    ref: "main",
    sparse_paths: ["plugins/foo", "plugins/bar"],
    last_revision: "abc123",
    last_updated: "2024-01-01T00:00:00Z",
  })
  expect(result.source_type).toBe("git")
  expect(result.source).toBe("https://github.com/openai/plugins.git")
  expect(result.ref).toBe("main")
  expect(result.sparse_paths).toEqual(["plugins/foo", "plugins/bar"])
  expect(result.last_revision).toBe("abc123")
  expect(result.last_updated).toBe("2024-01-01T00:00:00Z")
})

test("MarketplaceConfig - 空对象合法（所有字段可选）", () => {
  const result = ConfigAddon.MarketplaceConfig.zod.parse({})
  expect(result).toBeDefined()
})

test("MarketplaceConfig - source_type 无效值被拒绝", () => {
  expect(() => ConfigAddon.MarketplaceConfig.zod.parse({ source_type: "ftp" })).toThrow()
})
