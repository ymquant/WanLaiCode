import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { convertMcpConfig, loadAndConvertMcpConfig, loadMcpConfigDeclaration } from "./mcp-adapter"

const originalToken = process.env.ADDON_TEST_TOKEN
const originalEnvHeader = process.env.ADDON_TEST_HEADER

afterEach(() => {
  if (originalToken === undefined) delete process.env.ADDON_TEST_TOKEN
  else process.env.ADDON_TEST_TOKEN = originalToken
  if (originalEnvHeader === undefined) delete process.env.ADDON_TEST_HEADER
  else process.env.ADDON_TEST_HEADER = originalEnvHeader
})

describe("convertMcpConfig", () => {
  test("converts command servers to local MCP config", () => {
    expect(
      convertMcpConfig({
        shell: {
          command: "node",
          args: ["server.js"],
          env: { A: "1" },
          cwd: "tools",
          tool_timeout_sec: 7,
        },
      }),
    ).toEqual({
      shell: {
        type: "local",
        command: ["node", "server.js"],
        environment: { A: "1" },
        cwd: "tools",
        timeout: 7000,
      },
    })
  })

  test("resolves command cwd relative to addon root", () => {
    expect(
      convertMcpConfig(
        {
          local: {
            command: "./bin/server",
            cwd: ".",
          },
        },
        "/tmp/addon-root",
      ),
    ).toEqual({
      local: {
        type: "local",
        command: ["./bin/server"],
        cwd: "/tmp/addon-root",
      },
    })
  })

  test("converts url servers to remote MCP config", () => {
    expect(
      convertMcpConfig({
        remote: {
          url: "https://example.com/mcp",
          http_headers: { "X-Static": "yes" },
          tool_timeout_sec: 3,
        },
      }),
    ).toEqual({
      remote: {
        type: "remote",
        url: "https://example.com/mcp",
        headers: { "X-Static": "yes" },
        timeout: 3000,
      },
    })
  })

  test("preserves disabled servers", () => {
    expect(
      convertMcpConfig({
        disabled: {
          command: "node",
          enabled: false,
        },
      }),
    ).toEqual({
      disabled: {
        type: "local",
        command: ["node"],
        enabled: false,
      },
    })
  })

  test("injects bearer and env HTTP headers from environment", () => {
    process.env.ADDON_TEST_TOKEN = "secret"
    process.env.ADDON_TEST_HEADER = "from-env"

    expect(
      convertMcpConfig({
        remote: {
          url: "https://example.com/mcp",
          bearer_token_env_var: "ADDON_TEST_TOKEN",
          env_http_headers: { "X-Env": "ADDON_TEST_HEADER" },
        },
      }),
    ).toEqual({
      remote: {
        type: "remote",
        url: "https://example.com/mcp",
        headers: {
          Authorization: "Bearer secret",
          "X-Env": "from-env",
        },
      },
    })
  })
})

describe("loadAndConvertMcpConfig", () => {
  test("keeps environment header provenance separate from resolved runtime values", async () => {
    const root = mkdtempSync(join(tmpdir(), "addon-mcp-provenance-"))
    process.env.ADDON_TEST_TOKEN = "resolved-token-canary"
    process.env.ADDON_TEST_HEADER = "resolved-header-canary"
    try {
      writeFileSync(
        join(root, ".mcp.json"),
        JSON.stringify({
          remote: {
            url: "https://example.com/mcp",
            bearer_token_env_var: "ADDON_TEST_TOKEN",
            env_http_headers: { "X-Env": "ADDON_TEST_HEADER" },
          },
        }),
      )

      expect(await loadMcpConfigDeclaration(root, ".mcp.json")).toEqual({
        remote: {
          url: "https://example.com/mcp",
          bearer_token_env_var: "ADDON_TEST_TOKEN",
          env_http_headers: { "X-Env": "ADDON_TEST_HEADER" },
        },
      })
      expect(await loadAndConvertMcpConfig(root, ".mcp.json")).toEqual({
        remote: {
          type: "remote",
          url: "https://example.com/mcp",
          headers: {
            Authorization: "Bearer resolved-token-canary",
            "X-Env": "resolved-header-canary",
          },
        },
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("loads flat .mcp.json files", async () => {
    const root = mkdtempSync(join(tmpdir(), "addon-mcp-flat-"))
    try {
      writeFileSync(join(root, ".mcp.json"), JSON.stringify({ shell: { command: "node" } }))

      expect(await loadAndConvertMcpConfig(root, ".mcp.json")).toEqual({
        shell: { type: "local", command: ["node"] },
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("loads mcpServers wrapper files", async () => {
    const root = mkdtempSync(join(tmpdir(), "addon-mcp-wrapper-"))
    try {
      mkdirSync(join(root, "config"), { recursive: true })
      writeFileSync(
        join(root, "config", "mcp.json"),
        JSON.stringify({ mcpServers: { remote: { url: "https://example.com/mcp" } } }),
      )

      expect(await loadAndConvertMcpConfig(root, "config/mcp.json")).toEqual({
        remote: { type: "remote", url: "https://example.com/mcp" },
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
