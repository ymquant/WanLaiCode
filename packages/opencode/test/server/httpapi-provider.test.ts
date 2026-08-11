import { afterEach, describe, expect } from "bun:test"
import { Effect, FileSystem, Layer, Path } from "effect"
import { NodeFileSystem, NodePath } from "@effect/platform-node"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Instance } from "../../src/project/instance"
import { WithInstance } from "../../src/project/with-instance"
import { InstanceRuntime } from "../../src/project/instance-runtime"
import { Server } from "../../src/server/server"
import * as Log from "@opencode-ai/core/util/log"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, provideInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { WanlaiCodeRefreshCoordinator } from "../../src/provider/wanlaicode-refresh-coordinator"

void Log.init({ print: false })

const original = Flag.WANLAICODE_EXPERIMENTAL_HTTPAPI
const it = testEffect(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer))
const providerID = "test-oauth-parity"
const oauthURL = "https://example.com/oauth"
const oauthInstructions = "Finish OAuth"

function app(experimental: boolean) {
  Flag.WANLAICODE_EXPERIMENTAL_HTTPAPI = experimental
  return experimental ? Server.Default().app : Server.Legacy().app
}

function requestAuthorize(input: {
  app: ReturnType<typeof app>
  providerID: string
  method: number
  headers: HeadersInit
}) {
  return Effect.promise(async () => {
    const response = await input.app.request(`/provider/${input.providerID}/oauth/authorize`, {
      method: "POST",
      headers: input.headers,
      body: JSON.stringify({ method: input.method }),
    })
    return {
      status: response.status,
      body: await response.text(),
    }
  })
}

function writeProviderAuthPlugin(dir: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path

    yield* fs.makeDirectory(path.join(dir, ".wanlaicode", "plugin"), { recursive: true })
    yield* fs.writeFileString(
      path.join(dir, ".wanlaicode", "plugin", "provider-oauth-parity.ts"),
      [
        "export default {",
        '  id: "test.provider-oauth-parity",',
        "  server: async () => ({",
        "    auth: {",
        `      provider: "${providerID}",`,
        "      methods: [",
        '        { type: "api", label: "API key" },',
        "        {",
        '          type: "oauth",',
        '          label: "OAuth",',
        "          authorize: async () => ({",
        `            url: "${oauthURL}",`,
        '            method: "code",',
        `            instructions: "${oauthInstructions}",`,
        "            callback: async () => ({ type: 'success', key: 'token' }),",
        "          }),",
        "        },",
        "      ],",
        "    },",
        "  }),",
        "}",
        "",
      ].join("\n"),
    )
  })
}

function requestWanlaiCodeOAuthRefresh(input: { app: ReturnType<typeof app>; dir: string }) {
  return Effect.promise(async () => {
    const response = await input.app.request("/wanlaicode/oauth/refresh", {
      method: "POST",
      headers: { "x-opencode-directory": input.dir },
    })
    return {
      status: response.status,
      body: await response.text(),
    }
  })
}

function withProviderProject<A, E, R>(self: (dir: string) => Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    // 不用 makeTempDirectoryScoped: 它的内置 finalizer 在 windows 上 rm 一次 EBUSY 就抛,
    // 整个 scoped effect 报错。SQLite WAL / plugin worker handle 释放在 windows 上有
    // 几十~几百 ms 滞后,需要 GC + sleep + retry。
    const dir = yield* fs.makeTempDirectory({ prefix: "opencode-test-" })

    yield* fs.writeFileString(
      path.join(dir, "wanlaicode.json"),
      JSON.stringify({ $schema: "https://opencode.ai/config.json", formatter: false, lsp: false }),
    )
    yield* writeProviderAuthPlugin(dir)
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        // 1. dispose instance state (SQLite WAL / plugin worker / etc)
        await WithInstance.provide({
          directory: dir,
          fn: () => InstanceRuntime.disposeInstance(Instance.current),
        }).catch(() => {})
        // 2. windows 上 handle 释放有滞后,GC + sleep + retry rm,最终失败也吞(测试已通过)
        const nodeFs = await import("fs/promises")
        for (let attempt = 0; attempt < 30; attempt++) {
          // @ts-ignore Bun-only GC trigger
          if (typeof Bun !== "undefined" && Bun.gc) Bun.gc(true)
          await new Promise((resolve) => setTimeout(resolve, 100))
          try {
            await nodeFs.rm(dir, { recursive: true, force: true })
            return
          } catch (err) {
            const code = (err as NodeJS.ErrnoException)?.code
            if (code !== "EBUSY" && code !== "ENOTEMPTY") return
          }
        }
      }),
    )

    return yield* self(dir).pipe(provideInstance(dir))
  })
}

afterEach(async () => {
  Flag.WANLAICODE_EXPERIMENTAL_HTTPAPI = original
  WanlaiCodeRefreshCoordinator.resetForTest()
  await disposeAllInstances()
  await resetDatabase()
})

describe("provider HttpApi", () => {
  it.live(
    "matches legacy OAuth authorize response shapes",
    withProviderProject((dir) =>
      Effect.gen(function* () {
        const headers = { "x-opencode-directory": dir, "content-type": "application/json" }
        const legacy = app(false)
        const httpapi = app(true)

        const apiLegacy = yield* requestAuthorize({
          app: legacy,
          providerID,
          method: 0,
          headers,
        })
        const apiHttpApi = yield* requestAuthorize({
          app: httpapi,
          providerID,
          method: 0,
          headers,
        })
        expect(apiLegacy).toEqual({ status: 200, body: "" })
        expect(apiHttpApi).toEqual(apiLegacy)

        const oauthLegacy = yield* requestAuthorize({
          app: legacy,
          providerID,
          method: 1,
          headers,
        })
        const oauthHttpApi = yield* requestAuthorize({
          app: httpapi,
          providerID,
          method: 1,
          headers,
        })
        expect(oauthHttpApi).toEqual(oauthLegacy)
        expect(JSON.parse(oauthHttpApi.body)).toEqual({
          url: oauthURL,
          method: "code",
          instructions: oauthInstructions,
        })
      }),
    ),
    // Windows runner 上 instance + plugin setup 慢，曾跑 81s pass；默认 timeout
    // 触底时偶发挂。给到 5min 留余量。
    300_000,
  )

  it.live(
    "wanlaicode oauth refresh 失败时收敛为 ok:false 且状态恒 200（不抛为 500）",
    withProviderProject((dir) =>
      Effect.gen(function* () {
        // 让协调器同步序言之后的 promise reject：loadAuth 返回 undefined 触发 runRefresh 内部 throw
        WanlaiCodeRefreshCoordinator.configureForTest({
          loadAuth: () => Promise.resolve(undefined),
        })
        const result = yield* requestWanlaiCodeOAuthRefresh({ app: app(true), dir })
        expect(result.status).toBe(200)
        expect(JSON.parse(result.body)).toEqual({ ok: false })
      }),
    ),
    300_000,
  )

  it.live(
    "wanlaicode oauth refresh 成功时返回 ok:true",
    withProviderProject((dir) =>
      Effect.gen(function* () {
        WanlaiCodeRefreshCoordinator.configureForTest({
          loadAuth: () =>
            Promise.resolve({
              type: "oauth",
              access: "sk-old",
              refresh: "R0",
              expires: 0,
              softwareToken: "jwt-old",
            }),
          saveAuth: () => Promise.resolve(),
          // 协调器先保存轮换后的 OAuth 三元组，再单独补全 runtime key；HTTP 测试按真实两阶段协议注入。
          refreshToken: () =>
            Promise.resolve({
              refreshToken: "R1",
              expiresIn: 3600,
              softwareToken: "jwt-new",
            }),
          refreshRuntimeKey: () =>
            Promise.resolve({
              runtimeKey: "sk-new",
              profile: {},
            }),
        })
        const result = yield* requestWanlaiCodeOAuthRefresh({ app: app(true), dir })
        expect(result.status).toBe(200)
        expect(JSON.parse(result.body)).toEqual({ ok: true })
      }),
    ),
    300_000,
  )
})
