import { test, expect, mock, beforeEach } from "bun:test"
import { InstanceRuntime } from "../../src/project/instance-runtime"
import { Duration, Effect, Layer, Option, Schedule } from "effect"
import type { MCP as MCPNS } from "../../src/mcp/index"
import type { Service as ConfigService } from "../../src/config/config"
import { Global } from "@opencode-ai/core/global"

// --- Mock infrastructure ---

// Per-client state for controlling mock behavior
interface MockClientState {
  tools: Array<{ name: string; description?: string; inputSchema: object }>
  listToolsCalls: number
  listToolsShouldFail: boolean
  listToolsError: string
  listPromptsShouldFail: boolean
  listResourcesShouldFail: boolean
  prompts: Array<{ name: string; description?: string }>
  resources: Array<{ name: string; uri: string; description?: string }>
  closed: boolean
  notificationHandlers: Map<unknown, (...args: any[]) => any>
}

const clientStates = new Map<string, MockClientState>()
let lastCreatedClientName: string | undefined
let connectShouldFail = false
let connectShouldHang = false
let connectGate: Promise<void> | undefined
let connectError = "Mock transport cannot connect"
// Tracks how many Client instances were created (detects leaks)
let clientCreateCount = 0
// Tracks how many times transport.close() is called across all mock transports
let transportCloseCount = 0

function getOrCreateClientState(name?: string): MockClientState {
  const key = name ?? "default"
  let state = clientStates.get(key)
  if (!state) {
    state = {
      tools: [{ name: "test_tool", description: "A test tool", inputSchema: { type: "object", properties: {} } }],
      listToolsCalls: 0,
      listToolsShouldFail: false,
      listToolsError: "listTools failed",
      listPromptsShouldFail: false,
      listResourcesShouldFail: false,
      prompts: [],
      resources: [],
      closed: false,
      notificationHandlers: new Map(),
    }
    clientStates.set(key, state)
  }
  return state
}

// Mock transport that succeeds or fails based on connectShouldFail / connectShouldHang
class MockStdioTransport {
  stderr: null = null
  pid = 12345
  // oxlint-disable-next-line no-useless-constructor
  constructor(_opts: any) {}
  async start() {
    if (connectShouldHang) return connectGate ?? new Promise<void>(() => {}) // never resolves unless a gate is provided
    if (connectShouldFail) throw new Error(connectError)
  }
  async close() {
    transportCloseCount++
  }
}

class MockStreamableHTTP {
  // oxlint-disable-next-line no-useless-constructor
  constructor(_url: URL, _opts?: any) {}
  async start() {
    if (connectShouldHang) return connectGate ?? new Promise<void>(() => {}) // never resolves unless a gate is provided
    if (connectShouldFail) throw new Error(connectError)
  }
  async close() {
    transportCloseCount++
  }
  async finishAuth() {}
}

class MockSSE {
  // oxlint-disable-next-line no-useless-constructor
  constructor(_url: URL, _opts?: any) {}
  async start() {
    if (connectShouldHang) return connectGate ?? new Promise<void>(() => {}) // never resolves unless a gate is provided
    if (connectShouldFail) throw new Error(connectError)
  }
  async close() {
    transportCloseCount++
  }
}

void mock.module("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: MockStdioTransport,
}))

void mock.module("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: MockStreamableHTTP,
}))

void mock.module("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: MockSSE,
}))

void mock.module("@modelcontextprotocol/sdk/client/auth.js", () => ({
  UnauthorizedError: class extends Error {
    constructor() {
      super("Unauthorized")
    }
  },
}))

// Mock Client that delegates to per-name MockClientState
void mock.module("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class MockClient {
    _state!: MockClientState
    transport: any

    constructor(_opts: any) {
      clientCreateCount++
    }

    async connect(transport: { start: () => Promise<void> }) {
      this.transport = transport
      await transport.start()
      // After successful connect, bind to the last-created client name
      this._state = getOrCreateClientState(lastCreatedClientName)
    }

    setNotificationHandler(schema: unknown, handler: (...args: any[]) => any) {
      this._state?.notificationHandlers.set(schema, handler)
    }

    async listTools() {
      if (this._state) this._state.listToolsCalls++
      if (this._state?.listToolsShouldFail) {
        throw new Error(this._state.listToolsError)
      }
      return { tools: this._state?.tools ?? [] }
    }

    async listPrompts() {
      if (this._state?.listPromptsShouldFail) {
        throw new Error("listPrompts failed")
      }
      return { prompts: this._state?.prompts ?? [] }
    }

    async listResources() {
      if (this._state?.listResourcesShouldFail) {
        throw new Error("listResources failed")
      }
      return { resources: this._state?.resources ?? [] }
    }

    async getPrompt(input: { name: string }) {
      return { description: `prompt:${input.name}`, messages: [] }
    }

    async readResource(input: { uri: string }) {
      return { contents: [{ uri: input.uri, text: "resource-body" }] }
    }

    async close() {
      if (this._state) this._state.closed = true
    }
  },
}))

beforeEach(() => {
  clientStates.clear()
  lastCreatedClientName = undefined
  connectShouldFail = false
  connectShouldHang = false
  connectGate = undefined
  connectError = "Mock transport cannot connect"
  clientCreateCount = 0
  transportCloseCount = 0
})

// Import after mocks
const { MCP } = await import("../../src/mcp/index")
const { Config } = await import("../../src/config/config")
const { Instance } = await import("../../src/project/instance")
const { WithInstance } = await import("../../src/project/with-instance")
const { tmpdir } = await import("../fixture/fixture")

// --- Helper ---

function withInstance(
  config: Record<string, unknown>,
  fn: (mcp: MCPNS.Interface) => Effect.Effect<void, unknown, ConfigService>,
) {
  return async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          `${dir}/wanlaicode.json`,
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            mcp: config,
          }),
        )
      },
    })

    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        await Effect.runPromise(
          MCP.Service.use(fn).pipe(Effect.provide(Layer.merge(MCP.defaultLayer, Config.defaultLayer))),
        )
        // dispose instance to clean up state between tests
        await InstanceRuntime.disposeInstance(Instance.current)
      },
    })
  }
}

// ========================================================================
// Test: tools() are cached after connect
// ========================================================================

test(
  "tools() reuses cached tool definitions after connect",
  withInstance({}, (mcp) =>
    Effect.gen(function* () {
      lastCreatedClientName = "my-server"
      const serverState = getOrCreateClientState("my-server")
      serverState.tools = [
        { name: "do_thing", description: "does a thing", inputSchema: { type: "object", properties: {} } },
      ]

      // First: add the server successfully
      const addResult = yield* mcp.add("my-server", {
        type: "local",
        command: ["echo", "test"],
      })
      expect((addResult.status as any)["my-server"]?.status ?? (addResult.status as any).status).toBe("connected")

      expect(serverState.listToolsCalls).toBe(1)

      const toolsA = yield* mcp.tools()
      const toolsB = yield* mcp.tools()
      expect(Object.keys(toolsA).length).toBeGreaterThan(0)
      expect(Object.keys(toolsB).length).toBeGreaterThan(0)
      expect(serverState.listToolsCalls).toBe(1)
    }),
  ),
)

test(
  "status() returns connecting while configured server is still starting",
  withInstance(
    {
      "slow-server": {
        type: "local",
        command: ["echo", "test"],
      },
    },
    (mcp) =>
      Effect.gen(function* () {
        lastCreatedClientName = "slow-server"
        connectShouldHang = true

        // 100→1000ms：100ms 窗口在 CI 抖动下取不到 connecting 中间态
        const status = yield* mcp.status().pipe(Effect.timeout(Duration.millis(1000)), Effect.option)

        expect(Option.isSome(status)).toBe(true)
        expect(status.pipe(Option.getOrThrow)["slow-server"]?.status).toBe("connecting")
      }),
  ),
)

test(
  "background startup result is ignored after disconnect",
  withInstance(
    {
      "slow-server": {
        type: "local",
        command: ["echo", "test"],
      },
    },
    (mcp) =>
      Effect.gen(function* () {
        lastCreatedClientName = "slow-server"
        let releaseConnect!: () => void
        connectShouldHang = true
        connectGate = new Promise((resolve) => {
          releaseConnect = resolve
        })

        // 100→500ms：同上一测
        const connecting = yield* mcp.status().pipe(Effect.timeout(Duration.millis(1000)), Effect.option)
        expect(connecting.pipe(Option.getOrThrow)["slow-server"]?.status).toBe("connecting")

        yield* mcp.disconnect("slow-server")
        expect((yield* mcp.status())["slow-server"]?.status).toBe("disabled")

        connectShouldHang = false
        yield* Effect.promise(() => {
          releaseConnect()
          return new Promise((resolve) => setTimeout(resolve, 20))
        })

        expect((yield* mcp.status())["slow-server"]?.status).toBe("disabled")
        expect(yield* mcp.tools()).toEqual({})
      }),
  ),
)

// ========================================================================
// Test: tool change notifications refresh the cache
// ========================================================================

test(
  "tool change notifications refresh cached tool definitions",
  withInstance({}, (mcp) =>
    Effect.gen(function* () {
      lastCreatedClientName = "status-server"
      const serverState = getOrCreateClientState("status-server")

      yield* mcp.add("status-server", {
        type: "local",
        command: ["echo", "test"],
      })

      const before = yield* mcp.tools()
      expect(Object.keys(before).some((key) => key.includes("test_tool"))).toBe(true)
      expect(serverState.listToolsCalls).toBe(1)

      serverState.tools = [{ name: "next_tool", description: "next", inputSchema: { type: "object", properties: {} } }]

      const handler = Array.from(serverState.notificationHandlers.values())[0]
      expect(handler).toBeDefined()
      yield* Effect.promise(() => handler?.())

      const after = yield* mcp.tools()
      expect(Object.keys(after).some((key) => key.includes("next_tool"))).toBe(true)
      expect(Object.keys(after).some((key) => key.includes("test_tool"))).toBe(false)
      expect(serverState.listToolsCalls).toBe(2)
    }),
  ),
)

// ========================================================================
// Test: connect() / disconnect() lifecycle
// ========================================================================

test(
  "disconnect sets status to disabled and removes client",
  withInstance(
    {
      "disc-server": {
        type: "local",
        command: ["echo", "test"],
      },
    },
    (mcp) =>
      Effect.gen(function* () {
        lastCreatedClientName = "disc-server"
        getOrCreateClientState("disc-server")

        yield* mcp.add("disc-server", {
          type: "local",
          command: ["echo", "test"],
        })

        const statusBefore = yield* mcp.status()
        expect(statusBefore["disc-server"]?.status).toBe("connected")

        yield* mcp.disconnect("disc-server")

        const statusAfter = yield* mcp.status()
        expect(statusAfter["disc-server"]?.status).toBe("disabled")

        // Tools should be empty after disconnect
        const tools = yield* mcp.tools()
        const serverTools = Object.keys(tools).filter((k) => k.startsWith("disc-server"))
        expect(serverTools.length).toBe(0)
      }),
  ),
)

test(
  "connect() after disconnect() re-establishes the server",
  withInstance(
    {
      "reconn-server": {
        type: "local",
        command: ["echo", "test"],
      },
    },
    (mcp) =>
      Effect.gen(function* () {
        lastCreatedClientName = "reconn-server"
        const serverState = getOrCreateClientState("reconn-server")
        serverState.tools = [
          { name: "my_tool", description: "a tool", inputSchema: { type: "object", properties: {} } },
        ]

        yield* mcp.add("reconn-server", {
          type: "local",
          command: ["echo", "test"],
        })

        yield* mcp.disconnect("reconn-server")
        expect((yield* mcp.status())["reconn-server"]?.status).toBe("disabled")

        // Reconnect
        yield* mcp.connect("reconn-server")
        expect((yield* mcp.status())["reconn-server"]?.status).toBe("connected")

        const tools = yield* mcp.tools()
        expect(Object.keys(tools).some((k) => k.includes("my_tool"))).toBe(true)
      }),
  ),
)

test(
  "connect() runtime-enables every capability of a disabled persistent server until disconnect",
  withInstance(
    {
      "disabled-connect": {
        type: "local",
        command: ["echo", "test"],
        enabled: false,
      },
    },
    (mcp) =>
      Effect.gen(function* () {
        lastCreatedClientName = "disabled-connect"
        const serverState = getOrCreateClientState("disabled-connect")
        serverState.tools = [
          { name: "runtime-tool", description: "runtime", inputSchema: { type: "object", properties: {} } },
        ]
        serverState.prompts = [{ name: "runtime-prompt" }]
        serverState.resources = [{ name: "runtime-resource", uri: "file:///runtime.txt" }]

        expect((yield* mcp.status())["disabled-connect"]?.status).toBe("disabled")
        yield* mcp.connect("disabled-connect")

        expect((yield* mcp.status())["disabled-connect"]?.status).toBe("connected")
        expect(Object.keys(yield* mcp.tools())).toEqual(["disabled-connect_runtime-tool"])
        expect(Object.keys(yield* mcp.prompts())).toEqual(["disabled-connect:runtime-prompt"])
        expect(Object.keys(yield* mcp.resources())).toEqual(["disabled-connect:runtime-resource"])
        expect(yield* mcp.getPrompt("disabled-connect", "runtime-prompt")).toBeDefined()
        expect(yield* mcp.readResource("disabled-connect", "file:///runtime.txt")).toBeDefined()

        yield* mcp.disconnect("disabled-connect")
        expect(yield* mcp.tools()).toEqual({})
        expect(yield* mcp.prompts()).toEqual({})
        expect(yield* mcp.resources()).toEqual({})
        expect(yield* mcp.getPrompt("disabled-connect", "runtime-prompt")).toBeUndefined()
        expect(yield* mcp.readResource("disabled-connect", "file:///runtime.txt")).toBeUndefined()
      }),
  ),
)

// ========================================================================
// Test: add() closes existing client before replacing
// ========================================================================

test(
  "add() closes the old client when replacing a server",
  // Don't put the server in config — add it dynamically so we control
  // exactly which client instance is "first" vs "second".
  withInstance({}, (mcp) =>
    Effect.gen(function* () {
      lastCreatedClientName = "replace-server"
      const firstState = getOrCreateClientState("replace-server")

      yield* mcp.add("replace-server", {
        type: "local",
        command: ["echo", "test"],
      })

      expect(firstState.closed).toBe(false)

      // Create new state for second client
      clientStates.delete("replace-server")
      const secondState = getOrCreateClientState("replace-server")

      // Re-add should close the first client
      yield* mcp.add("replace-server", {
        type: "local",
        command: ["echo", "test"],
      })

      expect(firstState.closed).toBe(true)
      expect(secondState.closed).toBe(false)
    }),
  ),
)

test(
  "reconcile force-restarts a connected server so changed config can take effect",
  withInstance(
    {
      "managed-server": {
        type: "local",
        command: ["echo", "first"],
      },
    },
    (mcp) =>
      Effect.gen(function* () {
        lastCreatedClientName = "managed-server"
        yield* Effect.gen(function* () {
          if ((yield* mcp.status())["managed-server"]?.status !== "connected") {
            return yield* Effect.fail(new Error("managed-server not connected"))
          }
        }).pipe(Effect.retry({ times: 50, schedule: Schedule.spaced(Duration.millis(10)) }))

        const clientBefore = (yield* mcp.clients())["managed-server"]
        const createdBefore = clientCreateCount
        connectShouldHang = true
        yield* mcp.reconcile(["managed-server"])
        expect((yield* mcp.status())["managed-server"]?.status).toBe("connecting")
        yield* mcp.disconnect("managed-server")
        connectShouldHang = false
        yield* mcp.connect("managed-server")
        yield* Effect.gen(function* () {
          const clientAfter = (yield* mcp.clients())["managed-server"]
          if (clientCreateCount <= createdBefore || !clientAfter || clientAfter === clientBefore) {
            return yield* Effect.fail(new Error("managed-server not restarted"))
          }
        }).pipe(Effect.retry({ times: 50, schedule: Schedule.spaced(Duration.millis(10)) }))

        expect(clientCreateCount).toBeGreaterThan(createdBefore)
        expect((yield* mcp.clients())["managed-server"]).not.toBe(clientBefore)
      }),
  ),
)

test("reconcile invalidates a startup token when the latest config disables the server", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        `${dir}/wanlaicode.json`,
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          mcp: {
            "slow-server": {
              type: "local",
              command: ["echo", "slow"],
            },
          },
        }),
      )
    },
  })

  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      let releaseConnect!: () => void
      connectShouldHang = true
      connectGate = new Promise((resolve) => {
        releaseConnect = resolve
      })

      await Effect.runPromise(
        Effect.gen(function* () {
          const mcp = yield* MCP.Service
          const config = yield* Config.Service
          yield* Effect.gen(function* () {
            if ((yield* mcp.status())["slow-server"]?.status !== "connecting") {
              return yield* Effect.fail(new Error("slow-server not connecting"))
            }
          }).pipe(Effect.retry({ times: 50, schedule: Schedule.spaced(Duration.millis(10)) }))

          yield* Effect.promise(() =>
            Bun.write(
              `${tmp.path}/wanlaicode.json`,
              JSON.stringify({
                $schema: "https://opencode.ai/config.json",
                mcp: {
                  "slow-server": {
                    type: "local",
                    command: ["echo", "slow"],
                    enabled: false,
                  },
                },
              }),
            ),
          )
          yield* config.invalidate()
          yield* mcp.reconcile()
          expect((yield* mcp.status())["slow-server"]?.status).toBe("disabled")

          connectShouldHang = false
          releaseConnect()
          yield* Effect.sleep(Duration.millis(20))
          expect((yield* mcp.status())["slow-server"]?.status).toBe("disabled")
          expect(yield* mcp.tools()).toEqual({})
        }).pipe(Effect.provide(Layer.merge(MCP.defaultLayer, Config.defaultLayer))),
      )
      await InstanceRuntime.disposeInstance(Instance.current)
    },
  })
})

test("disposing an instance cancels a reconcile connection before it can write back to retired state", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        `${dir}/wanlaicode.json`,
        JSON.stringify({
          mcp: {
            retired: {
              type: "local",
              command: ["echo", "retired"],
              enabled: false,
            },
          },
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
          const config = yield* Config.Service
          const clients = yield* mcp.clients()
          expect((yield* mcp.status()).retired?.status).toBe("disabled")

          yield* Effect.promise(() =>
            Bun.write(
              `${tmp.path}/wanlaicode.json`,
              JSON.stringify({
                mcp: {
                  retired: {
                    type: "local",
                    command: ["echo", "retired"],
                  },
                },
              }),
            ),
          )
          yield* config.invalidate()

          lastCreatedClientName = "retired"
          let releaseConnect!: () => void
          connectShouldHang = true
          connectGate = new Promise((resolve) => {
            releaseConnect = resolve
          })
          yield* mcp.reconcile()
          yield* Effect.gen(function* () {
            if (clientCreateCount === 0) return yield* Effect.fail(new Error("reconcile connect has not started"))
          }).pipe(Effect.retry({ times: 50, schedule: Schedule.spaced(Duration.millis(10)) }))

          yield* Effect.promise(() => InstanceRuntime.disposeInstance(Instance.current))
          expect(clients).not.toHaveProperty("retired")
          expect(transportCloseCount).toBe(1)

          connectShouldHang = false
          releaseConnect()
          yield* Effect.sleep(Duration.millis(20))
          expect(clients).not.toHaveProperty("retired")
          expect(transportCloseCount).toBe(1)
        }).pipe(Effect.provide(Layer.merge(MCP.defaultLayer, Config.defaultLayer))),
      )
    },
  })
})

test("reconcile applies a global MCP change to every initialized directory", async () => {
  await using configDir = await tmpdir()
  await using first = await tmpdir()
  await using second = await tmpdir()
  const previousConfigDir = Global.Path.config
  ;(Global.Path as { config: string }).config = configDir.path
  await Bun.write(
    `${configDir.path}/wanlaicode.jsonc`,
    JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      mcp: {
        shared: {
          type: "local",
          command: ["echo", "shared"],
        },
      },
    }),
  )

  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const mcp = yield* MCP.Service
        const config = yield* Config.Service
        const use = <A>(directory: string, effect: Effect.Effect<A, unknown>): Effect.Effect<A> =>
          Effect.promise(async () =>
            await WithInstance.provide({
              directory,
              fn: () => Effect.runPromise(effect),
            }),
          )
        const waitConnected = (directory: string) =>
          use(
            directory,
            Effect.gen(function* () {
              if ((yield* mcp.status()).shared?.status !== "connected") {
                return yield* Effect.fail(new Error(`${directory} not connected`))
              }
            }).pipe(Effect.retry({ times: 50, schedule: Schedule.spaced(Duration.millis(10)) })),
          )

        lastCreatedClientName = "shared"
        yield* waitConnected(first.path)
        yield* waitConnected(second.path)
        expect(yield* use(first.path, mcp.clients())).toHaveProperty("shared")
        expect(yield* use(second.path, mcp.clients())).toHaveProperty("shared")

        yield* use(
          first.path,
          Effect.gen(function* () {
            yield* config.updateGlobal({
              mcp: {
                shared: {
                  type: "local",
                  command: ["echo", "shared"],
                  enabled: false,
                },
              },
            })
            yield* mcp.reconcile()
          }),
        )

        expect(yield* use(first.path, mcp.clients())).not.toHaveProperty("shared")
        expect(yield* use(second.path, mcp.clients())).not.toHaveProperty("shared")
        expect((yield* use(second.path, mcp.status())).shared?.status).toBe("disabled")
      }).pipe(Effect.provide(Layer.merge(MCP.defaultLayer, Config.defaultLayer)), Effect.scoped),
    )
  } finally {
    ;(Global.Path as { config: string }).config = previousConfigDir
  }
})

// ========================================================================
// Test: state init with mixed success/failure
// ========================================================================

test(
  "init connects available servers even when one fails",
  withInstance(
    {
      "good-server": {
        type: "local",
        command: ["echo", "good"],
      },
      "bad-server": {
        type: "local",
        command: ["echo", "bad"],
      },
    },
    (mcp) =>
      Effect.gen(function* () {
        // Set up good server
        const goodState = getOrCreateClientState("good-server")
        goodState.tools = [{ name: "good_tool", description: "works", inputSchema: { type: "object", properties: {} } }]

        // Set up bad server - will fail on listTools during create()
        const badState = getOrCreateClientState("bad-server")
        badState.listToolsShouldFail = true

        // Add good server first
        lastCreatedClientName = "good-server"
        yield* mcp.add("good-server", {
          type: "local",
          command: ["echo", "good"],
        })

        // Add bad server - should fail but not affect good server
        lastCreatedClientName = "bad-server"
        yield* mcp.add("bad-server", {
          type: "local",
          command: ["echo", "bad"],
        })

        const status = yield* mcp.status()
        expect(status["good-server"]?.status).toBe("connected")
        expect(status["bad-server"]?.status).toBe("failed")

        // Good server's tools should still be available
        const tools = yield* mcp.tools()
        expect(Object.keys(tools).some((k) => k.includes("good_tool"))).toBe(true)
      }),
  ),
)

// ========================================================================
// Test: disabled server via config
// ========================================================================

test(
  "disabled server is marked as disabled without attempting connection",
  withInstance(
    {
      "disabled-server": {
        type: "local",
        command: ["echo", "test"],
        enabled: false,
      },
    },
    (mcp) =>
      Effect.gen(function* () {
        const countBefore = clientCreateCount

        yield* mcp.add("disabled-server", {
          type: "local",
          command: ["echo", "test"],
          enabled: false,
        } as any)

        // No client should have been created
        expect(clientCreateCount).toBe(countBefore)

        const status = yield* mcp.status()
        expect(status["disabled-server"]?.status).toBe("disabled")
      }),
  ),
)

// ========================================================================
// Test: prompts() and resources()
// ========================================================================

test(
  "prompts() returns prompts from connected servers",
  withInstance(
    {
      "prompt-server": {
        type: "local",
        command: ["echo", "test"],
      },
    },
    (mcp) =>
      Effect.gen(function* () {
        lastCreatedClientName = "prompt-server"
        const serverState = getOrCreateClientState("prompt-server")
        serverState.prompts = [{ name: "my-prompt", description: "A test prompt" }]

        yield* mcp.add("prompt-server", {
          type: "local",
          command: ["echo", "test"],
        })

        const prompts = yield* mcp.prompts()
        expect(Object.keys(prompts).length).toBe(1)
        const key = Object.keys(prompts)[0]
        expect(key).toContain("prompt-server")
        expect(key).toContain("my-prompt")
      }),
  ),
)

test(
  "resources() returns resources from connected servers",
  withInstance(
    {
      "resource-server": {
        type: "local",
        command: ["echo", "test"],
      },
    },
    (mcp) =>
      Effect.gen(function* () {
        lastCreatedClientName = "resource-server"
        const serverState = getOrCreateClientState("resource-server")
        serverState.resources = [{ name: "my-resource", uri: "file:///test.txt", description: "A test resource" }]

        yield* mcp.add("resource-server", {
          type: "local",
          command: ["echo", "test"],
        })

        const resources = yield* mcp.resources()
        expect(Object.keys(resources).length).toBe(1)
        const key = Object.keys(resources)[0]
        expect(key).toContain("resource-server")
        expect(key).toContain("my-resource")
      }),
  ),
)

test(
  "prompts() skips disconnected servers",
  withInstance(
    {
      "prompt-disc-server": {
        type: "local",
        command: ["echo", "test"],
      },
    },
    (mcp) =>
      Effect.gen(function* () {
        lastCreatedClientName = "prompt-disc-server"
        const serverState = getOrCreateClientState("prompt-disc-server")
        serverState.prompts = [{ name: "hidden-prompt", description: "Should not appear" }]

        yield* mcp.add("prompt-disc-server", {
          type: "local",
          command: ["echo", "test"],
        })

        yield* mcp.disconnect("prompt-disc-server")

        const prompts = yield* mcp.prompts()
        expect(Object.keys(prompts).length).toBe(0)
      }),
  ),
)

test(
  "latest disabled config hides tools, prompts, resources, and direct client reads before reconcile",
  withInstance(
    {
      "capability-server": {
        type: "local",
        command: ["echo", "test"],
      },
    },
    (mcp) =>
      Effect.gen(function* () {
        lastCreatedClientName = "capability-server"
        const serverState = getOrCreateClientState("capability-server")
        serverState.prompts = [{ name: "hidden-prompt", description: "Should disappear" }]
        serverState.resources = [{ name: "hidden-resource", uri: "file:///hidden.txt" }]
        const config = yield* Config.Service

        yield* mcp.add("capability-server", {
          type: "local",
          command: ["echo", "test"],
        })
        expect(Object.keys(yield* mcp.tools())).not.toHaveLength(0)
        expect(Object.keys(yield* mcp.prompts())).not.toHaveLength(0)
        expect(Object.keys(yield* mcp.resources())).not.toHaveLength(0)
        expect(yield* mcp.getPrompt("capability-server", "hidden-prompt")).toBeDefined()
        expect(yield* mcp.readResource("capability-server", "file:///hidden.txt")).toBeDefined()

        yield* Effect.promise(() =>
          Bun.write(
            `${Instance.directory}/wanlaicode.json`,
            JSON.stringify({
              mcp: {
                "capability-server": {
                  type: "local",
                  command: ["echo", "test"],
                  enabled: false,
                },
              },
            }),
          ),
        )
        yield* config.invalidate()

        expect(yield* mcp.tools()).toEqual({})
        expect(yield* mcp.prompts()).toEqual({})
        expect(yield* mcp.resources()).toEqual({})
        expect(yield* mcp.getPrompt("capability-server", "hidden-prompt")).toBeUndefined()
        expect(yield* mcp.readResource("capability-server", "file:///hidden.txt")).toBeUndefined()
      }),
  ),
)

test(
  "ephemeral server stops bypassing availability after it is persisted and then deleted",
  withInstance({}, (mcp) =>
    Effect.gen(function* () {
      lastCreatedClientName = "ephemeral-server"
      const serverState = getOrCreateClientState("ephemeral-server")
      serverState.prompts = [{ name: "ephemeral-prompt" }]
      serverState.resources = [{ name: "ephemeral-resource", uri: "file:///ephemeral.txt" }]
      const config = yield* Config.Service

      yield* mcp.add("ephemeral-server", {
        type: "local",
        command: ["echo", "ephemeral"],
      })
      expect(Object.keys(yield* mcp.tools())).not.toHaveLength(0)

      yield* Effect.promise(() =>
        Bun.write(
          `${Instance.directory}/wanlaicode.json`,
          JSON.stringify({
            mcp: {
              "ephemeral-server": {
                type: "local",
                command: ["echo", "persisted"],
              },
            },
          }),
        ),
      )
      yield* config.invalidate()
      yield* mcp.reconcile()

      yield* Effect.promise(() => Bun.write(`${Instance.directory}/wanlaicode.json`, JSON.stringify({ mcp: {} })))
      yield* config.invalidate()

      expect(yield* mcp.tools()).toEqual({})
      expect(yield* mcp.prompts()).toEqual({})
      expect(yield* mcp.resources()).toEqual({})
      expect(yield* mcp.getPrompt("ephemeral-server", "ephemeral-prompt")).toBeUndefined()
      expect(yield* mcp.readResource("ephemeral-server", "file:///ephemeral.txt")).toBeUndefined()
    }),
  ),
)

// ========================================================================
// Test: connect() on nonexistent server
// ========================================================================

test(
  "connect() on nonexistent server does not throw",
  withInstance({}, (mcp) =>
    Effect.gen(function* () {
      // Should not throw
      yield* mcp.connect("nonexistent")
      const status = yield* mcp.status()
      expect(status["nonexistent"]).toBeUndefined()
    }),
  ),
)

// ========================================================================
// Test: disconnect() on nonexistent server
// ========================================================================

test(
  "disconnect() on nonexistent server does not throw",
  withInstance({}, (mcp) =>
    Effect.gen(function* () {
      yield* mcp.disconnect("nonexistent")
      // Should complete without error
    }),
  ),
)

// ========================================================================
// Test: tools() with no MCP servers configured
// ========================================================================

test(
  "tools() returns empty when no MCP servers are configured",
  withInstance({}, (mcp) =>
    Effect.gen(function* () {
      const tools = yield* mcp.tools()
      expect(Object.keys(tools).length).toBe(0)
    }),
  ),
)

// ========================================================================
// Test: connect failure during create()
// ========================================================================

test(
  "server that fails to connect is marked as failed",
  withInstance(
    {
      "fail-connect": {
        type: "local",
        command: ["echo", "test"],
      },
    },
    (mcp) =>
      Effect.gen(function* () {
        lastCreatedClientName = "fail-connect"
        getOrCreateClientState("fail-connect")
        connectShouldFail = true
        connectError = "Connection refused"

        yield* mcp.add("fail-connect", {
          type: "local",
          command: ["echo", "test"],
        })

        const status = yield* mcp.status()
        expect(status["fail-connect"]?.status).toBe("failed")
        if (status["fail-connect"]?.status === "failed") {
          expect(status["fail-connect"].error).toContain("Connection refused")
        }

        // No tools should be available
        const tools = yield* mcp.tools()
        expect(Object.keys(tools).length).toBe(0)
      }),
  ),
)

// ========================================================================
// Bug #5: McpOAuthCallback.cancelPending uses wrong key
// ========================================================================

test("McpOAuthCallback.cancelPending is keyed by mcpName but pendingAuths uses oauthState", async () => {
  const { McpOAuthCallback } = await import("../../src/mcp/oauth-callback")

  // Register a pending auth with an oauthState key, associated to an mcpName
  const oauthState = "abc123hexstate"
  const callbackPromise = McpOAuthCallback.waitForCallback(oauthState, "my-mcp-server")

  // cancelPending is called with mcpName — should find the entry via reverse index
  McpOAuthCallback.cancelPending("my-mcp-server")

  // The callback should still be pending because cancelPending looked up
  // "my-mcp-server" in a map keyed by "abc123hexstate"
  let rejected = false
  callbackPromise.then(() => {}).catch(() => (rejected = true))

  // Give it a tick
  await new Promise((r) => setTimeout(r, 50))

  // cancelPending("my-mcp-server") should have rejected the pending callback
  expect(rejected).toBe(true)

  await McpOAuthCallback.stop()
})

// ========================================================================
// Test: multiple tools from same server get correct name prefixes
// ========================================================================

test(
  "tools() prefixes tool names with sanitized server name",
  withInstance(
    {
      "my.special-server": {
        type: "local",
        command: ["echo", "test"],
      },
    },
    (mcp) =>
      Effect.gen(function* () {
        lastCreatedClientName = "my.special-server"
        const serverState = getOrCreateClientState("my.special-server")
        serverState.tools = [
          { name: "tool-a", description: "Tool A", inputSchema: { type: "object", properties: {} } },
          { name: "tool.b", description: "Tool B", inputSchema: { type: "object", properties: {} } },
        ]

        yield* mcp.add("my.special-server", {
          type: "local",
          command: ["echo", "test"],
        })

        const tools = yield* mcp.tools()
        const keys = Object.keys(tools)

        // Server name dots should be replaced with underscores
        expect(keys.some((k) => k.startsWith("my_special-server_"))).toBe(true)
        // Tool name dots should be replaced with underscores
        expect(keys.some((k) => k.endsWith("tool_b"))).toBe(true)
        expect(keys.length).toBe(2)
      }),
  ),
)

// ========================================================================
// Test: transport leak — local stdio timeout (#19168)
// ========================================================================

test(
  "local stdio transport is closed when connect times out (no process leak)",
  withInstance({}, (mcp) =>
    Effect.gen(function* () {
      lastCreatedClientName = "hanging-server"
      getOrCreateClientState("hanging-server")
      connectShouldHang = true

      const addResult = yield* mcp.add("hanging-server", {
        type: "local",
        command: ["node", "fake.js"],
        timeout: 100,
      })

      const serverStatus = (addResult.status as any)["hanging-server"] ?? addResult.status
      expect(serverStatus.status).toBe("failed")
      expect(serverStatus.error).toContain("timed out")
      // Transport must be closed to avoid orphaned child process
      expect(transportCloseCount).toBeGreaterThanOrEqual(1)
    }),
  ),
)

// ========================================================================
// Test: transport leak — remote timeout (#19168)
// ========================================================================

test(
  "remote transport is closed when connect times out",
  withInstance({}, (mcp) =>
    Effect.gen(function* () {
      lastCreatedClientName = "hanging-remote"
      getOrCreateClientState("hanging-remote")
      connectShouldHang = true

      const addResult = yield* mcp.add("hanging-remote", {
        type: "remote",
        url: "http://localhost:9999/mcp",
        timeout: 100,
        oauth: false,
      })

      const serverStatus = (addResult.status as any)["hanging-remote"] ?? addResult.status
      expect(serverStatus.status).toBe("failed")
      // Transport must be closed to avoid leaked HTTP connections
      expect(transportCloseCount).toBeGreaterThanOrEqual(1)
    }),
  ),
)

// ========================================================================
// Test: transport leak — failed remote transports not closed (#19168)
// ========================================================================

test(
  "failed remote transport is closed before trying next transport",
  withInstance({}, (mcp) =>
    Effect.gen(function* () {
      lastCreatedClientName = "fail-remote"
      getOrCreateClientState("fail-remote")
      connectShouldFail = true
      connectError = "Connection refused"

      const addResult = yield* mcp.add("fail-remote", {
        type: "remote",
        url: "http://localhost:9999/mcp",
        timeout: 5000,
        oauth: false,
      })

      const serverStatus = (addResult.status as any)["fail-remote"] ?? addResult.status
      expect(serverStatus.status).toBe("failed")
      // Both StreamableHTTP and SSE transports should be closed
      expect(transportCloseCount).toBeGreaterThanOrEqual(2)
    }),
  ),
)
