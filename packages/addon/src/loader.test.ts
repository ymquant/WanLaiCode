import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { loadAddonsFromPaths } from "./loader"
import { addonKey } from "./user-config"

let rootTmpDir: string

beforeAll(() => {
  rootTmpDir = mkdtempSync(join(tmpdir(), "addon-loader-test-"))
})

afterAll(() => {
  rmSync(rootTmpDir, { recursive: true, force: true })
})

function writeManifest(root: string, data: Record<string, unknown>) {
  mkdirSync(join(root, ".codex-plugin"), { recursive: true })
  writeFileSync(join(root, ".codex-plugin", "plugin.json"), JSON.stringify(data))
}

function writeJson(root: string, rel: string, data: Record<string, unknown>) {
  mkdirSync(join(root, rel, ".."), { recursive: true })
  writeFileSync(join(root, rel), JSON.stringify(data))
}

describe("loadAddonsFromPaths", () => {
  test("loads a single plugin layout", async () => {
    const root = join(rootTmpDir, "single")
    writeManifest(root, { name: "single", version: "0.1.0" })

    const result = await loadAddonsFromPaths([root], {})

    expect(result.errors).toEqual([])
    expect(result.addons).toHaveLength(1)
    expect(result.addons[0]?.root).toBe(root)
    expect(result.addons[0]?.addonId).toEqual({ addonName: "single", marketplaceName: "local" })
  })

  test("loads flat child plugin layouts", async () => {
    const base = join(rootTmpDir, "flat")
    writeManifest(join(base, "alpha"), { name: "alpha", version: "0.1.0" })
    writeManifest(join(base, "beta"), { name: "beta", version: "0.1.0" })

    const result = await loadAddonsFromPaths([base], {})

    expect(result.addons.map((addon) => addon.addonId.addonName).sort()).toEqual(["alpha", "beta"])
    expect(result.addons.map((addon) => addon.addonId.marketplaceName)).toEqual(["local", "local"])
  })

  test("loads active versions from cache layouts", async () => {
    const base = join(rootTmpDir, "cache")
    writeManifest(join(base, "openai", "github", "0.1.0"), { name: "github", version: "0.1.0" })
    writeManifest(join(base, "openai", "github", "local"), { name: "github", version: "local" })
    writeManifest(join(base, "openai", "linear", "0.2.0"), { name: "linear", version: "0.2.0" })

    const result = await loadAddonsFromPaths([base], {})

    expect(
      result.addons
        .map((addon) => `${addon.addonId.addonName}@${addon.addonId.marketplaceName}:${addon.version}`)
        .sort(),
    ).toEqual(["github@openai:local", "linear@openai:0.2.0"])
    expect(result.addons.find((addon) => addon.addonId.addonName === "github")?.root).toBe(
      join(base, "openai", "github", "local"),
    )
  })

  test("loads namespace-aware registry cache layouts independently", async () => {
    const base = join(rootTmpDir, "registry-cache")
    writeManifest(join(base, "wanlaicode", "alice", "github", "0.1.0"), { name: "github", version: "0.1.0" })
    writeManifest(join(base, "wanlaicode", "bob", "github", "0.1.0"), { name: "github", version: "0.1.0" })

    const result = await loadAddonsFromPaths([base], {})

    expect(result.addons.map((addon) => addonKey(addon.addonId)).sort()).toEqual([
      "github@wanlaicode/alice",
      "github@wanlaicode/bob",
    ])
  })

  test("marks plugins disabled by user config", async () => {
    const root = join(rootTmpDir, "disabled")
    writeManifest(root, { name: "github", version: "0.1.0" })

    const result = await loadAddonsFromPaths([root], {
      config: { plugins: { "github@local": { enabled: false } } },
    })

    expect(result.addons[0]?.disabled).toBe(true)
  })

  test("loads default .mcp.json and applies per-plugin mcp overrides", async () => {
    const root = join(rootTmpDir, "mcp-default")
    writeManifest(root, { name: "github", version: "0.1.0" })
    writeJson(root, ".mcp.json", {
      shell: { command: "node", args: ["server.js"] },
    })

    const result = await loadAddonsFromPaths([root], {
      config: {
        plugins: {
          "github@local": {
            mcp_servers: {
              shell: { enabled: false },
            },
          },
        },
      },
    })

    expect(result.addons[0]?.mcpServers).toEqual({
      shell: {
        type: "local",
        command: ["node", "server.js"],
        enabled: false,
      },
    })
  })

  test("loads manifest mcpServers path", async () => {
    const root = join(rootTmpDir, "mcp-custom")
    writeManifest(root, { name: "linear", version: "0.1.0", mcpServers: "config/mcp.json" })
    writeJson(root, "config/mcp.json", {
      mcpServers: {
        remote: { url: "https://example.com/mcp" },
      },
    })

    const result = await loadAddonsFromPaths([root], {})

    expect(result.addons[0]?.mcpServers).toEqual({
      remote: { type: "remote", url: "https://example.com/mcp" },
    })
    expect(result.addons[0]?.mcpServerDeclarations).toEqual({
      remote: { url: "https://example.com/mcp" },
    })
  })

  test("marketplace.json registers catalog without auto-loading its plugins", async () => {
    // Plugins listed in marketplace.json are NOT auto-loaded — `addon install`
    // is required to materialize them into the cache. The catalog itself is
    // registered so `addon install` can resolve sources later.
    const base = join(rootTmpDir, "mp-driven")
    mkdirSync(join(base, ".agents/plugins"), { recursive: true })
    writeFileSync(
      join(base, ".agents/plugins/marketplace.json"),
      JSON.stringify({
        name: "codex-curated",
        plugins: [
          { name: "alpha", source: "./plugins/alpha" },
          { name: "beta", source: { source: "local", path: "./plugins/beta" } },
        ],
      }),
    )
    writeManifest(join(base, "plugins/alpha"), { name: "alpha-internal", version: "0.1.0" })
    writeManifest(join(base, "plugins/beta"), { name: "beta-internal", version: "0.1.0" })

    const result = await loadAddonsFromPaths([base], {})

    expect(result.marketplaces).toHaveLength(1)
    expect(result.marketplaces[0]?.name).toBe("codex-curated")
    expect(result.marketplaces[0]?.plugins).toHaveLength(2)
    expect(result.addons).toHaveLength(0)
  })

  test("explicit marketplace input registers catalog only", async () => {
    // Same rule for marketplaces declared via cfg.marketplaces — installation
    // is required before plugins show up in the loaded addon list.
    const root = join(rootTmpDir, "mp-explicit")
    mkdirSync(join(root, ".agents/plugins"), { recursive: true })
    writeFileSync(
      join(root, ".agents/plugins/marketplace.json"),
      JSON.stringify({
        name: "codex-curated",
        plugins: [{ name: "explicit", source: "./plugins/explicit" }],
      }),
    )
    writeManifest(join(root, "plugins/explicit"), { name: "explicit", version: "0.1.0" })

    const result = await loadAddonsFromPaths([], {
      marketplaces: [{ name: "openai", root }],
    })

    expect(result.marketplaces[0]?.name).toBe("codex-curated")
    expect(result.addons).toHaveLength(0)
  })

  test("marketplace input without manifest falls back to directory scan", async () => {
    const root = join(rootTmpDir, "mp-fallback")
    writeManifest(join(root, "plugin-a"), { name: "plugin-a", version: "0.1.0" })

    const result = await loadAddonsFromPaths([], {
      marketplaces: [{ name: "openai", root }],
    })

    expect(result.marketplaces).toHaveLength(0)
    expect(result.addons[0]?.addonId).toEqual({
      addonName: "plugin-a",
      marketplaceName: "openai",
    })
  })

  test("legacy ~/.codex/plugins/cache layout still discovers plugins", async () => {
    const base = join(rootTmpDir, "legacy-cache")
    writeManifest(join(base, "openai", "github", "0.1.0"), { name: "github", version: "0.1.0" })

    const result = await loadAddonsFromPaths([base], {})

    expect(result.addons.map((addon) => `${addon.addonId.addonName}@${addon.addonId.marketplaceName}`)).toEqual([
      "github@openai",
    ])
  })
})
