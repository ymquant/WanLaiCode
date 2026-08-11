import { test, expect, mock, beforeEach } from "bun:test"
import { Duration, Effect, Layer, Schedule } from "effect"
import { mkdirSync, writeFileSync } from "fs"
import { join } from "path"
import type { MCP as MCPNS } from "../../src/mcp/index"

let lastCreatedClientName: string | undefined

void mock.module("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: class MockStdioTransport {
    stderr: null = null
    pid = 12345
    constructor(_opts: unknown) {}
    async start() {}
    async close() {}
  },
}))

void mock.module("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class MockClient {
    transport: unknown
    async connect(transport: { start: () => Promise<void> }) {
      this.transport = transport
      await transport.start()
    }
    setNotificationHandler() {}
    async listTools() {
      return {
        tools: [
          {
            name: lastCreatedClientName === "addon-server" ? "addon_tool" : "other_tool",
            description: "test",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      }
    }
    async close() {}
  },
}))

beforeEach(() => {
  lastCreatedClientName = undefined
})

const { MCP } = await import("../../src/mcp/index")
const { Config } = await import("../../src/config/config")
const { Addon } = await import("../../src/addon")
const { WithInstance } = await import("../../src/project/with-instance")
const { InstanceRuntime } = await import("../../src/project/instance-runtime")
const { Instance } = await import("../../src/project/instance")
const { tmpdir } = await import("../fixture/fixture")

// MCP, Config and Addon must share the same per-instance state for reconcile to
// observe a config change, so provide them in one merged layer (the layer refs
// are singletons → Effect memoizes them to the same service instances).
const SharedLayer = Layer.mergeAll(MCP.defaultLayer, Config.defaultLayer, Addon.defaultLayer)

function writeAddon(root: string) {
  mkdirSync(join(root, "local-market", "hello", "local", ".codex-plugin"), { recursive: true })
  writeFileSync(
    join(root, "local-market", "hello", "local", ".codex-plugin", "plugin.json"),
    JSON.stringify({ name: "hello", version: "0.1.0" }),
  )
  writeFileSync(
    join(root, "local-market", "hello", "local", ".mcp.json"),
    JSON.stringify({
      "addon-server": {
        command: "node",
        args: ["server.js"],
      },
    }),
  )
}

test("MCP service loads servers from addon fixtures", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      const addonRoot = join(dir, "addons")
      writeAddon(addonRoot)
      await Bun.write(
        join(dir, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          addon: {
            paths: [addonRoot],
          },
        }),
      )
    },
  })

  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      await Effect.runPromise(
        MCP.Service.use((mcp: MCPNS.Interface) =>
          Effect.gen(function* () {
            lastCreatedClientName = "addon-server"
            yield* Effect.gen(function* () {
              const status = yield* mcp.status()
              if (status["addon-server"]?.status !== "connected") {
                return yield* Effect.fail(new Error("addon-server not connected"))
              }
            }).pipe(Effect.retry({ times: 50, schedule: Schedule.spaced(Duration.millis(10)) }))
            const tools = yield* mcp.tools()
            expect(Object.keys(tools)).toContain("addon-server_addon_tool")
          }),
        ).pipe(Effect.provide(MCP.defaultLayer)),
      )
      await InstanceRuntime.disposeInstance(Instance.current)
    },
  })
})

test("reconcile tears down a disabled addon's MCP server and drops its tools", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      const addonRoot = join(dir, "addons")
      writeAddon(addonRoot)
      await Bun.write(
        join(dir, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          addon: { paths: [addonRoot] },
        }),
      )
    },
  })

  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const mcp = yield* MCP.Service
          const cfg = yield* Config.Service
          const addon = yield* Addon.Service

          lastCreatedClientName = "addon-server"
          yield* Effect.gen(function* () {
            const status = yield* mcp.status()
            if (status["addon-server"]?.status !== "connected") {
              return yield* Effect.fail(new Error("addon-server not connected"))
            }
          }).pipe(Effect.retry({ times: 50, schedule: Schedule.spaced(Duration.millis(10)) }))
          expect(Object.keys(yield* mcp.tools())).toContain("addon-server_addon_tool")

          // Disable the addon via project config, mirroring what setAddonEnabled
          // persists, then invalidate the caches the way the toggle handler does.
          yield* Effect.promise(() =>
            Bun.write(
              join(tmp.path, "wanlaicode.json"),
              JSON.stringify({
                $schema: "https://opencode.ai/config.json",
                addon: { paths: [join(tmp.path, "addons")] },
                plugins: { "hello@local-market": { enabled: false } },
              }),
            ),
          )
          yield* cfg.invalidate()
          yield* addon.invalidate()

          yield* mcp.reconcile()

          // The orphaned connection is torn down and its tools are no longer offered.
          const status = yield* mcp.status()
          expect(status["addon-server"]?.status).not.toBe("connected")
          expect(Object.keys(yield* mcp.tools())).not.toContain("addon-server_addon_tool")
        }).pipe(Effect.provide(SharedLayer)),
      )
      await InstanceRuntime.disposeInstance(Instance.current)
    },
  })
})
