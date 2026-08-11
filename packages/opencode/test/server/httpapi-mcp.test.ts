import { afterEach, describe, expect, test } from "bun:test"
import { Context, Effect, Layer } from "effect"
import { Flag } from "@opencode-ai/core/flag/flag"
import { ExperimentalHttpApiServer } from "../../src/server/routes/instance/httpapi/server"
import { McpPaths } from "../../src/server/routes/instance/httpapi/groups/mcp"
import { Server } from "../../src/server/server"
import * as Log from "@opencode-ai/core/util/log"
import { resetDatabase } from "../fixture/db"
import { TestInstance, disposeAllInstances, tmpdir } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

void Log.init({ print: false })

const original = Flag.WANLAICODE_EXPERIMENTAL_HTTPAPI
const context = Context.empty() as Context.Context<unknown>
const it = testEffect(Layer.empty)

function app(experimental: boolean) {
  Flag.WANLAICODE_EXPERIMENTAL_HTTPAPI = experimental
  return experimental ? Server.Default().app : Server.Legacy().app
}
type TestApp = ReturnType<typeof app>

function request(route: string, directory: string, init?: RequestInit) {
  const headers = new Headers(init?.headers)
  headers.set("x-opencode-directory", directory)
  return ExperimentalHttpApiServer.webHandler().handler(
    new Request(`http://localhost${route}`, {
      ...init,
      headers,
    }),
    context,
  )
}

const readResponse = Effect.fnUntraced(function* (input: { app: TestApp; path: string; headers: HeadersInit }) {
  const response = yield* Effect.promise(() =>
    Promise.resolve(input.app.request(input.path, { method: "POST", headers: input.headers })),
  )
  return {
    status: response.status,
    body: yield* Effect.promise(() => response.text()),
  }
})

afterEach(async () => {
  Flag.WANLAICODE_EXPERIMENTAL_HTTPAPI = original
  await disposeAllInstances()
  await resetDatabase()
})

describe("mcp HttpApi", () => {
  test("serves status endpoint", async () => {
    await using tmp = await tmpdir({
      config: {
        mcp: {
          demo: {
            type: "local",
            command: ["echo", "demo"],
            enabled: false,
          },
        },
      },
    })

    const response = await request(McpPaths.status, tmp.path)
    expect(response.status).toBe(200)
    // supports_oauth 由 status() 在响应边界按 mcpConfig 派生:remote && oauth!==false。
    // demo 是 type=local 的 stdio server → false,前端据此隐藏 Authenticate 按钮。
    expect(await response.json()).toEqual({ demo: { status: "disabled", supports_oauth: false } })
  })

  test("serves add, connect, and disconnect endpoints", async () => {
    await using tmp = await tmpdir({
      config: {
        mcp: {
          demo: {
            type: "local",
            command: ["echo", "demo"],
            enabled: false,
          },
        },
      },
    })

    const added = await request(McpPaths.status, tmp.path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "added",
        config: {
          type: "local",
          command: ["echo", "added"],
          enabled: false,
        },
      }),
    })
    expect(added.status).toBe(200)
    expect(await added.json()).toMatchObject({ added: { status: "disabled" } })

    const connected = await request("/mcp/demo/connect", tmp.path, { method: "POST" })
    expect(connected.status).toBe(200)
    expect(await connected.json()).toBe(true)

    const disconnected = await request("/mcp/demo/disconnect", tmp.path, { method: "POST" })
    expect(disconnected.status).toBe(200)
    expect(await disconnected.json()).toBe(true)
  })

  test("serves deterministic OAuth endpoints", async () => {
    await using tmp = await tmpdir({
      config: {
        mcp: {
          demo: {
            type: "local",
            command: ["echo", "demo"],
            enabled: false,
          },
        },
      },
    })

    const start = await request("/mcp/demo/auth", tmp.path, { method: "POST" })
    expect(start.status).toBe(400)

    const authenticate = await request("/mcp/demo/auth/authenticate", tmp.path, { method: "POST" })
    expect(authenticate.status).toBe(400)

    const removed = await request("/mcp/demo/auth", tmp.path, { method: "DELETE" })
    expect(removed.status).toBe(200)
    expect(await removed.json()).toEqual({ success: true })
  })

  it.instance(
    "matches legacy unsupported OAuth error responses",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const headers = { "x-opencode-directory": tmp.directory }
        const legacy = app(false)
        const httpapi = app(true)

        yield* Effect.forEach(["/mcp/demo/auth", "/mcp/demo/auth/authenticate"], (path) =>
          Effect.gen(function* () {
            const legacyResponse = yield* readResponse({ app: legacy, path, headers })
            const httpapiResponse = yield* readResponse({ app: httpapi, path, headers })

            expect(legacyResponse).toEqual({
              status: 400,
              body: JSON.stringify({ error: "MCP server demo does not support OAuth" }),
            })
            expect(httpapiResponse).toEqual(legacyResponse)
          }),
        )
      }),
    {
      config: {
        formatter: false,
        lsp: false,
        mcp: {
          demo: {
            type: "local",
            command: ["echo", "demo"],
            enabled: false,
          },
        },
      },
    },
  )
})
