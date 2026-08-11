import { afterEach, test, expect } from "bun:test"
import { mkdir, unlink } from "fs/promises"
import path from "path"

import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { Global } from "@opencode-ai/core/global"
import { Instance } from "../../src/project/instance"
import { Auth } from "../../src/auth"
import { WithInstance } from "../../src/project/with-instance"
import { Plugin } from "../../src/plugin/index"
import { ModelsDev } from "@/provider/models"
import { Provider } from "@/provider/provider"
import * as WanlaiCodeAuth from "@/provider/wanlaicode"
import { WanlaiCodeRefreshCoordinator } from "@/provider/wanlaicode-refresh-coordinator"
import { ProviderID, ModelID } from "../../src/provider/schema"
import { Filesystem } from "@/util/filesystem"
import { Env } from "../../src/env"
import { Effect } from "effect"
import { Flag } from "@opencode-ai/core/flag/flag"
import { AppRuntime } from "../../src/effect/app-runtime"
import { makeRuntime } from "../../src/effect/run-service"

const env = makeRuntime(Env.Service, Env.defaultLayer)
const set = (k: string, v: string) => env.runSync((svc) => svc.set(k, v))

afterEach(async () => {
  // 刷新协调器持有进程级内存态（最新 refresh token/在途刷新），
  // 不重置会让本文件后续用例复用前一个用例的陈旧 refresh token
  WanlaiCodeRefreshCoordinator.resetForTest()
  await disposeAllInstances()
})

async function run<A, E>(fn: (provider: Provider.Interface) => Effect.Effect<A, E, never>) {
  return AppRuntime.runPromise(
    Effect.gen(function* () {
      const provider = yield* Provider.Service
      return yield* fn(provider)
    }),
  )
}

async function list() {
  return run((provider) => provider.list())
}

async function getProvider(providerID: ProviderID) {
  return run((provider) => provider.getProvider(providerID))
}

async function getModel(providerID: ProviderID, modelID: ModelID) {
  return run((provider) => provider.getModel(providerID, modelID))
}

async function getLanguage(model: Provider.Model) {
  return run((provider) => provider.getLanguage(model))
}

async function closest(providerID: ProviderID, query: string[]) {
  return run((provider) => provider.closest(providerID, query))
}

async function getSmallModel(providerID: ProviderID, options?: { sameProvider?: boolean }) {
  return run((provider) => provider.getSmallModel(providerID, options))
}

async function defaultModel() {
  return run((provider) => provider.defaultModel())
}

async function markPluginDependenciesReady(dir: string) {
  await mkdir(path.join(dir, "node_modules"), { recursive: true })
  await Bun.write(
    path.join(dir, "package-lock.json"),
    JSON.stringify({ packages: { "": { dependencies: { "@opencode-ai/plugin": "0.0.0" } } } }),
  )
}

function paid(providers: Awaited<ReturnType<typeof list>>) {
  // undefined 视为 paid=0；无 key 时 WanlaiCode 仍展示全部模型，但请求会被本地拦截。
  const item = providers[ProviderID.make("wanlaicode")]
  if (!item) return 0
  return Object.values(item.models).filter((model) => model.cost.input > 0).length
}

function model(id: string, input: number, rate_multiplier?: number) {
  return {
    id,
    name: id,
    release_date: "2026-01-01",
    temperature: true,
    tool_call: true,
    cost: { input, output: input },
    limit: { context: 128000, output: 8192 },
    wanlaicode: rate_multiplier === undefined ? undefined : { rate_multiplier },
  }
}

test("models path override does not poison subsequent provider loads", async () => {
  // 配 wanlaicode apiKey 让 wanlaicode 真进 list()——本测验证 models path 切换不互相污染
  await using custom = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: { wanlaicode: { options: { apiKey: "test-key" } } },
        }),
      )
    },
  })

  const previous = Flag.WANLAICODE_MODELS_PATH
  await Bun.write(
    path.join(custom.path, "models.json"),
    JSON.stringify({
      wanlaicode: {
        id: "wanlaicode",
        name: "WanlaiCode",
        api: "https://api.wanlai.ai/v1",
        npm: "@ai-sdk/openai-compatible",
        env: ["WANLAICODE_API_KEY"],
        models: {
          free: model("free", 0, 0),
        },
      },
    }),
  )

  try {
    Flag.WANLAICODE_MODELS_PATH = path.join(custom.path, "models.json")
    await WithInstance.provide({
      directory: custom.path,
      fn: async () => {
        expect(Object.keys(await list())).toEqual(["wanlaicode"])
      },
    })

    await using next = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "wanlaicode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            // 同样给 anthropic 配 apiKey 让它进 list()
            provider: { anthropic: { options: { apiKey: "test-key" } } },
          }),
        )
      },
    })

    Flag.WANLAICODE_MODELS_PATH = previous
    await WithInstance.provide({
      directory: next.path,
      fn: async () => {
        expect((await list())[ProviderID.make("anthropic")]).toBeDefined()
      },
    })
  } finally {
    Flag.WANLAICODE_MODELS_PATH = previous
  }
})

test("wanlaicode loader keeps public models when no api key is configured", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
        }),
      )
    },
  })
  const previous = Flag.WANLAICODE_MODELS_PATH
  await Bun.write(
    path.join(tmp.path, "models.json"),
    JSON.stringify({
      wanlaicode: {
        id: "wanlaicode",
        name: "WanlaiCode",
        api: "https://api.wanlai.ai/v1",
        npm: "@ai-sdk/openai-compatible",
        env: ["WANLAICODE_API_KEY"],
        models: {
          free: model("free", 0, 0),
          paid: model("paid", 0, 1),
          missing: model("missing", 0),
        },
      },
    }),
  )
  Flag.WANLAICODE_MODELS_PATH = path.join(tmp.path, "models.json")
  try {
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        // 显式 remove 跨文件 Auth/Env 可能残留的 wanlaicode entry，保证 ok=false
        delete process.env.WANLAICODE_AUTH_CONTENT
        delete process.env.OPENCODE_AUTH_CONTENT
        await AppRuntime.runPromise(Auth.Service.use((svc) => svc.remove("wanlaicode")).pipe(Effect.orDie))
        await env.runPromise((svc) => svc.remove("WANLAICODE_API_KEY"))
        const providers = await list()
        const wanlaiCode = providers[ProviderID.make("wanlaicode")]
        expect(wanlaiCode?.options.apiKey).toBeDefined()
        expect(wanlaiCode?.options.apiKey).not.toBe("public")
        expect(Object.keys(wanlaiCode?.models ?? {})).toEqual(["free", "paid", "missing"])
      },
    })
  } finally {
    Flag.WANLAICODE_MODELS_PATH = previous
  }
})

test("wanlaicode oauth session without runtime key drops cached legacy fallback models", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
        }),
      )
    },
  })
  const previous = Flag.WANLAICODE_MODELS_PATH
  await Bun.write(
    path.join(tmp.path, "models.json"),
    JSON.stringify({
      wanlaicode: {
        id: "wanlaicode",
        name: "WanlaiCode",
        api: "https://api.wanlai.ai/v1",
        npm: "@ai-sdk/openai-compatible",
        env: ["WANLAICODE_API_KEY"],
        models: {
          "deepseek-v4-flash": model("deepseek-v4-flash", 0, 0),
        },
      },
    }),
  )
  Flag.WANLAICODE_MODELS_PATH = path.join(tmp.path, "models.json")
  try {
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        delete process.env.WANLAICODE_AUTH_CONTENT
        delete process.env.OPENCODE_AUTH_CONTENT
        await env.runPromise((svc) => svc.remove("WANLAICODE_API_KEY"))
        await AppRuntime.runPromise(
          Auth.Service.use((svc) =>
            svc.set("wanlaicode", {
              type: "oauth",
              access: "",
              refresh: "refresh_123",
              expires: Math.floor(Date.now() / 1000) + 7200,
              accountId: "acct_123",
            }),
          ).pipe(Effect.orDie),
        )
        const providers = await list()
        const wanlaiCode = providers[ProviderID.make("wanlaicode")]
        expect(wanlaiCode).toBeUndefined()
        const defaults = Provider.defaultModelIDs(providers)
        expect(defaults[ProviderID.make("wanlaicode")]).toBeUndefined()
      },
    })
  } finally {
    Flag.WANLAICODE_MODELS_PATH = previous
    await AppRuntime.runPromise(Auth.Service.use((svc) => svc.remove("wanlaicode")).pipe(Effect.orDie))
    delete process.env.WANLAICODE_AUTH_CONTENT
    delete process.env.OPENCODE_AUTH_CONTENT
  }
})

test("wanlaicode public provider blocks generation locally when no plan is available", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
        }),
      )
    },
  })
  const previous = Flag.WANLAICODE_MODELS_PATH
  await Bun.write(
    path.join(tmp.path, "models.json"),
    JSON.stringify({
      wanlaicode: {
        id: "wanlaicode",
        name: "WanlaiCode",
        api: "https://api.wanlai.ai/v1",
        npm: "@ai-sdk/openai-compatible",
        env: ["WANLAICODE_API_KEY"],
        models: {
          paid: model("paid", 0, 1),
        },
      },
    }),
  )
  Flag.WANLAICODE_MODELS_PATH = path.join(tmp.path, "models.json")
  try {
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        delete process.env.WANLAICODE_AUTH_CONTENT
        delete process.env.OPENCODE_AUTH_CONTENT
        await AppRuntime.runPromise(Auth.Service.use((svc) => svc.remove("wanlaicode")).pipe(Effect.orDie))
        await env.runPromise((svc) => svc.remove("WANLAICODE_API_KEY"))
        const requests: string[] = []
        WanlaiCodeAuth.setFetchWithoutProxyForTesting(async (input) => {
          requests.push(new URL(input.toString()).pathname)
          return Response.json({ ok: true })
        })
        try {
          const providers = await list()
          const language = await getLanguage(providers[ProviderID.make("wanlaicode")].models["paid"])
          await expect(
            language.doGenerate({
              prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
            }),
          ).rejects.toThrow("当前没有套餐，请先购买套餐")
          expect(requests).toEqual([])
        } finally {
          WanlaiCodeAuth.setFetchWithoutProxyForTesting(undefined)
        }
      },
    })
  } finally {
    Flag.WANLAICODE_MODELS_PATH = previous
  }
})

test("wanlaicode provider refreshes cached no-plan state when a runtime key appears", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
        }),
      )
    },
  })
  const previous = Flag.WANLAICODE_MODELS_PATH
  await Bun.write(
    path.join(tmp.path, "models.json"),
    JSON.stringify({
      wanlaicode: {
        id: "wanlaicode",
        name: "WanlaiCode",
        api: "https://api.wanlai.ai/v1",
        npm: "@ai-sdk/openai-compatible",
        env: ["WANLAICODE_API_KEY"],
        models: {
          paid: model("paid", 0, 1),
        },
      },
    }),
  )
  Flag.WANLAICODE_MODELS_PATH = path.join(tmp.path, "models.json")
  try {
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        delete process.env.WANLAICODE_AUTH_CONTENT
        delete process.env.OPENCODE_AUTH_CONTENT
        await AppRuntime.runPromise(Auth.Service.use((svc) => svc.remove("wanlaicode")).pipe(Effect.orDie))
        await env.runPromise((svc) => svc.remove("WANLAICODE_API_KEY"))

        const noPlanProviders = await list()
        expect(noPlanProviders[ProviderID.make("wanlaicode")].key).toBeUndefined()
        expect(noPlanProviders[ProviderID.make("wanlaicode")].options.apiKey).toBeDefined()

        await AppRuntime.runPromise(
          Auth.Service.use((svc) =>
            svc.set("wanlaicode", {
              type: "oauth",
              access: "runtime_key_456",
              refresh: "refresh_456",
              expires: Math.floor(Date.now() / 1000) + 7200,
              accountId: "acct_123",
            }),
          ).pipe(Effect.orDie),
        )

        const entitledProviders = await list()
        expect(entitledProviders[ProviderID.make("wanlaicode")].key).toBe("runtime_key_456")
        expect(entitledProviders[ProviderID.make("wanlaicode")].options.apiKey).toBeUndefined()
      },
    })
  } finally {
    Flag.WANLAICODE_MODELS_PATH = previous
    await AppRuntime.runPromise(Auth.Service.use((svc) => svc.remove("wanlaicode")).pipe(Effect.orDie))
    delete process.env.WANLAICODE_AUTH_CONTENT
    delete process.env.OPENCODE_AUTH_CONTENT
  }
})

test('wanlaicode config apiKey literal "public" is treated as a real key', async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: { wanlaicode: { options: { apiKey: "public" } } },
        }),
      )
    },
  })
  const previous = Flag.WANLAICODE_MODELS_PATH
  await Bun.write(
    path.join(tmp.path, "models.json"),
    JSON.stringify({
      wanlaicode: {
        id: "wanlaicode",
        name: "WanlaiCode",
        api: "https://api.wanlai.ai/v1",
        npm: "@ai-sdk/openai-compatible",
        env: ["WANLAICODE_API_KEY"],
        models: {
          paid: model("paid", 0, 1),
        },
      },
    }),
  )
  Flag.WANLAICODE_MODELS_PATH = path.join(tmp.path, "models.json")
  try {
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        delete process.env.WANLAICODE_AUTH_CONTENT
        delete process.env.OPENCODE_AUTH_CONTENT
        await AppRuntime.runPromise(Auth.Service.use((svc) => svc.remove("wanlaicode")).pipe(Effect.orDie))
        await env.runPromise((svc) => svc.remove("WANLAICODE_API_KEY"))
        const requests: string[] = []
        const providers = await list()
        expect(providers[ProviderID.make("wanlaicode")].options.apiKey).toBe("public")
        providers[ProviderID.make("wanlaicode")].options.fetch = async (input: RequestInfo | URL) => {
          requests.push(new URL(input.toString()).pathname)
          return Response.json({
            id: "chatcmpl_123",
            object: "chat.completion",
            created: 0,
            model: "paid",
            choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "ok" } }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          })
        }
        const language = await getLanguage(providers[ProviderID.make("wanlaicode")].models["paid"])
        await language.doGenerate({
          prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
        })
        expect(requests).toEqual(["/v1/chat/completions"])
      },
    })
  } finally {
    Flag.WANLAICODE_MODELS_PATH = previous
  }
})

test("wanlaicode provider uses OAuth runtime key for authenticated requests", async () => {
  const previous = Flag.WANLAICODE_MODELS_PATH
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
        }),
      )
    },
  })
  await Bun.write(
    path.join(tmp.path, "models.json"),
    JSON.stringify({
      wanlaicode: {
        id: "wanlaicode",
        name: "WanlaiCode",
        api: "https://api.wanlai.ai/v1",
        npm: "@ai-sdk/openai-compatible",
        env: ["WANLAICODE_API_KEY"],
        models: {
          paid: model("paid", 0, 1),
        },
      },
    }),
  )
  Flag.WANLAICODE_MODELS_PATH = path.join(tmp.path, "models.json")
  process.env.WANLAICODE_AUTH_CONTENT = JSON.stringify({
    wanlaicode: {
      type: "oauth",
      access: "runtime_key_123",
      refresh: "refresh_123",
      expires: Math.floor(Date.now() / 1000) + 3600,
      accountId: "acct_123",
    },
  })
  try {
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        await env.runPromise((svc) => svc.remove("WANLAICODE_API_KEY"))
        expect((await getProvider(ProviderID.make("wanlaicode"))).key).toBe("runtime_key_123")
      },
    })
  } finally {
    Flag.WANLAICODE_MODELS_PATH = previous
    delete process.env.WANLAICODE_AUTH_CONTENT
    delete process.env.OPENCODE_AUTH_CONTENT
  }
})

test("wanlaicode provider retries chat generation after OAuth refresh on 401", async () => {
  const previous = Flag.WANLAICODE_MODELS_PATH
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
        }),
      )
    },
  })
  await Bun.write(
    path.join(tmp.path, "models.json"),
    JSON.stringify({
      wanlaicode: {
        id: "wanlaicode",
        name: "WanlaiCode",
        api: "https://api.wanlai.ai/v1",
        npm: "@ai-sdk/openai-compatible",
        env: ["WANLAICODE_API_KEY"],
        models: {
          paid: model("paid", 0, 1),
        },
      },
    }),
  )
  Flag.WANLAICODE_MODELS_PATH = path.join(tmp.path, "models.json")
  process.env.WANLAICODE_AUTH_CONTENT = JSON.stringify({
    wanlaicode: {
      type: "oauth",
      access: "runtime_key_123",
      refresh: "refresh_123",
      expires: Math.floor(Date.now() / 1000) + 3600,
      accountId: "acct_123",
    },
  })
  try {
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        await env.runPromise((svc) => svc.remove("WANLAICODE_API_KEY"))
        const calls: Array<{
          path: string
          authorization: string | null
          client: string | null
          deviceID: string | null
        }> = []
        // 刷新协调器走 WanlaiCodeAuth.createFetch（不经过 chat 的 options.fetch），
        // OAuth 刷新相关端点需通过全局 fetch 覆盖来模拟
        WanlaiCodeAuth.setFetchWithoutProxyForTesting(async (input, init) => {
          const url = new URL(input.toString())
          const headers = new Headers(init?.headers)
          calls.push({
            path: url.pathname,
            authorization: headers.get("authorization"),
            client: headers.get("x-wanlai-client"),
            deviceID: headers.get("x-wanlai-device-id"),
          })
          if (url.pathname === "/v1/oauth/token") {
            return Response.json({ access_token: "access_456", refresh_token: "refresh_456", expires_in: 7200 })
          }
          if (url.pathname === "/api/oauth/profile") {
            return Response.json({ entitlement: { plan: "pro" }, account: { uuid: "acct_123" } })
          }
          if (url.pathname === "/api/oauth/wanlaicode/create_api_key") {
            return Response.json({ raw_key: "runtime_key_456" })
          }
          throw new Error(`unexpected request ${url.pathname}`)
        })
        const providers = await list()
        providers[ProviderID.make("wanlaicode")].options.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = new URL(input.toString())
          const headers = new Headers(init?.headers)
          calls.push({
            path: url.pathname,
            authorization: headers.get("authorization"),
            client: headers.get("x-wanlai-client"),
            deviceID: headers.get("x-wanlai-device-id"),
          })
          if (url.pathname.endsWith("/chat/completions") && calls.filter((call) => call.path.endsWith("/chat/completions")).length === 1) {
            return Response.json({ error: "unauthorized" }, { status: 401 })
          }
          return Response.json({
            id: "chatcmpl_123",
            object: "chat.completion",
            created: 0,
            model: "paid",
            choices: [
              {
                index: 0,
                finish_reason: "stop",
                message: { role: "assistant", content: "ok" },
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          })
        }
        try {
          const language = await getLanguage(providers[ProviderID.make("wanlaicode")].models["paid"])
          await language.doGenerate({
            prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
          })
          expect(calls.filter((call) => call.path.endsWith("/chat/completions")).map((call) => call.authorization)).toEqual([
            "Bearer runtime_key_123",
            "Bearer runtime_key_456",
          ])
          expect(calls.some((call) => call.path === "/v1/oauth/token")).toBe(true)
          expect(calls.some((call) => call.path === "/api/oauth/profile")).toBe(true)
          expect(calls.some((call) => call.path === "/api/oauth/wanlaicode/create_api_key")).toBe(true)
          expect(calls.filter((call) => call.path !== "/v1/chat/completions").every((call) => call.client === "wanlaicodex")).toBe(true)
          expect(calls.filter((call) => call.path !== "/v1/chat/completions").every((call) => Boolean(call.deviceID))).toBe(true)
        } finally {
          WanlaiCodeAuth.setFetchWithoutProxyForTesting(undefined)
        }
      },
    })
  } finally {
    Flag.WANLAICODE_MODELS_PATH = previous
    await AppRuntime.runPromise(Auth.Service.use((svc) => svc.remove("wanlaicode")).pipe(Effect.orDie))
    delete process.env.WANLAICODE_AUTH_CONTENT
    delete process.env.OPENCODE_AUTH_CONTENT
  }
})

// 模拟 Key 轮换过渡窗口：第一次刷新拿到的新 Key 在后端尚未生效、重试仍 401，
// 退避后第二次刷新才拿到可用 Key 并成功。验证 wanlaiCodeRefreshFetch 的退避重试循环。
test("wanlaicode provider keeps retrying with backoff while rotated key is not yet ready", async () => {
  const previous = Flag.WANLAICODE_MODELS_PATH
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
        }),
      )
    },
  })
  await Bun.write(
    path.join(tmp.path, "models.json"),
    JSON.stringify({
      wanlaicode: {
        id: "wanlaicode",
        name: "WanlaiCode",
        api: "https://api.wanlai.ai/v1",
        npm: "@ai-sdk/openai-compatible",
        env: ["WANLAICODE_API_KEY"],
        models: {
          paid: model("paid", 0, 1),
        },
      },
    }),
  )
  Flag.WANLAICODE_MODELS_PATH = path.join(tmp.path, "models.json")
  process.env.WANLAICODE_AUTH_CONTENT = JSON.stringify({
    wanlaicode: {
      type: "oauth",
      access: "runtime_key_123",
      refresh: "refresh_123",
      expires: Math.floor(Date.now() / 1000) + 3600,
      accountId: "acct_123",
    },
  })
  try {
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        await env.runPromise((svc) => svc.remove("WANLAICODE_API_KEY"))
        const calls: Array<{ path: string; authorization: string | null }> = []
        // 每次刷新签发递增的 token / runtime key，便于断言刷新发生了两轮
        let refreshCount = 0
        // 刷新协调器走 WanlaiCodeAuth.createFetch（不经过 chat 的 options.fetch），
        // OAuth 刷新相关端点需通过全局 fetch 覆盖来模拟
        WanlaiCodeAuth.setFetchWithoutProxyForTesting(async (input) => {
          const url = new URL(input.toString())
          calls.push({ path: url.pathname, authorization: null })
          if (url.pathname === "/v1/oauth/token") {
            refreshCount += 1
            return Response.json({
              access_token: `access_${refreshCount}`,
              refresh_token: `refresh_${refreshCount}`,
              expires_in: 7200,
            })
          }
          if (url.pathname === "/api/oauth/profile") {
            return Response.json({ entitlement: { plan: "pro" }, account: { uuid: "acct_123" } })
          }
          if (url.pathname === "/api/oauth/wanlaicode/create_api_key") {
            return Response.json({ raw_key: `runtime_key_rotated_${refreshCount}` })
          }
          throw new Error(`unexpected request ${url.pathname}`)
        })
        const providers = await list()
        providers[ProviderID.make("wanlaicode")].options.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = new URL(input.toString())
          const headers = new Headers(init?.headers)
          calls.push({ path: url.pathname, authorization: headers.get("authorization") })
          if (url.pathname.endsWith("/chat/completions")) {
            const attempt = calls.filter((call) => call.path.endsWith("/chat/completions")).length
            // 前两次 chat 请求（旧 Key、第一次轮换出的新 Key）都还是 401，第三次才成功
            if (attempt <= 2) return Response.json({ error: { code: "API_KEY_DISABLED" } }, { status: 401 })
          }
          return Response.json({
            id: "chatcmpl_123",
            object: "chat.completion",
            created: 0,
            model: "paid",
            choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "ok" } }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          })
        }
        try {
          const language = await getLanguage(providers[ProviderID.make("wanlaicode")].models["paid"])
          await language.doGenerate({
            prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
          })
          // 三次 chat 请求：原始 Key → 第一次轮换 Key（仍 401）→ 第二次轮换 Key（成功）
          expect(
            calls.filter((call) => call.path.endsWith("/chat/completions")).map((call) => call.authorization),
          ).toEqual(["Bearer runtime_key_123", "Bearer runtime_key_rotated_1", "Bearer runtime_key_rotated_2"])
          // 刷新发生了两轮
          expect(calls.filter((call) => call.path === "/v1/oauth/token").length).toBe(2)
          expect(calls.filter((call) => call.path === "/api/oauth/wanlaicode/create_api_key").length).toBe(2)
        } finally {
          WanlaiCodeAuth.setFetchWithoutProxyForTesting(undefined)
        }
      },
    })
  } finally {
    Flag.WANLAICODE_MODELS_PATH = previous
    await AppRuntime.runPromise(Auth.Service.use((svc) => svc.remove("wanlaicode")).pipe(Effect.orDie))
    delete process.env.WANLAICODE_AUTH_CONTENT
    delete process.env.OPENCODE_AUTH_CONTENT
  }
})

// 并发两个 401 请求时，刷新必须共享单飞、且只消耗一次 refresh token：
// 后端把 refresh token 设为单次有效（用过即失效），若两个请求各自用同一旧 token
// 重复刷新，第二次会被后端以 401 拒绝；本用例锁住这个竞争不再发生。
test("wanlaicode provider shares a single refresh across concurrent 401s without reusing a stale refresh token", async () => {
  const previous = Flag.WANLAICODE_MODELS_PATH
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(path.join(dir, "wanlaicode.json"), JSON.stringify({ $schema: "https://opencode.ai/config.json" }))
    },
  })
  await Bun.write(
    path.join(tmp.path, "models.json"),
    JSON.stringify({
      wanlaicode: {
        id: "wanlaicode",
        name: "WanlaiCode",
        api: "https://api.wanlai.ai/v1",
        npm: "@ai-sdk/openai-compatible",
        env: ["WANLAICODE_API_KEY"],
        models: { paid: model("paid", 0, 1) },
      },
    }),
  )
  Flag.WANLAICODE_MODELS_PATH = path.join(tmp.path, "models.json")
  process.env.WANLAICODE_AUTH_CONTENT = JSON.stringify({
    wanlaicode: {
      type: "oauth",
      access: "runtime_key_123",
      refresh: "refresh_123",
      expires: Math.floor(Date.now() / 1000) + 3600,
      accountId: "acct_123",
    },
  })
  try {
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        await env.runPromise((svc) => svc.remove("WANLAICODE_API_KEY"))
        const calls: Array<{ path: string }> = []
        let refreshCount = 0
        let staleRefreshRejected = false
        // refresh token 单次有效：用过即失效
        const validRefreshTokens = new Set(["refresh_123"])
        // 刷新协调器走 WanlaiCodeAuth.createFetch（不经过 chat 的 options.fetch），
        // OAuth 刷新相关端点需通过全局 fetch 覆盖来模拟
        WanlaiCodeAuth.setFetchWithoutProxyForTesting(async (input, init) => {
          const url = new URL(input.toString())
          calls.push({ path: url.pathname })
          if (url.pathname === "/v1/oauth/token") {
            const body = JSON.parse(String(init?.body ?? "{}")) as { refresh_token?: string }
            const presented = body.refresh_token ?? ""
            if (!validRefreshTokens.has(presented)) {
              // 落后的请求用了已失效的 refresh token —— 这正是要避免的竞争
              staleRefreshRejected = true
              return Response.json({ error: "invalid_grant" }, { status: 401 })
            }
            validRefreshTokens.delete(presented)
            refreshCount += 1
            const next = `refresh_${refreshCount}`
            validRefreshTokens.add(next)
            return Response.json({ access_token: `access_${refreshCount}`, refresh_token: next, expires_in: 7200 })
          }
          if (url.pathname === "/api/oauth/profile") {
            return Response.json({ entitlement: { plan: "pro" }, account: { uuid: "acct_123" } })
          }
          if (url.pathname === "/api/oauth/wanlaicode/create_api_key") {
            return Response.json({ raw_key: `runtime_key_rotated_${refreshCount}` })
          }
          throw new Error(`unexpected request ${url.pathname}`)
        })
        const providers = await list()
        providers[ProviderID.make("wanlaicode")].options.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = new URL(input.toString())
          const headers = new Headers(init?.headers)
          calls.push({ path: url.pathname })
          if (url.pathname.endsWith("/chat/completions")) {
            // 仍持原始 Key 的请求需要刷新；任何轮换后的 Key 都放行
            if (headers.get("authorization") === "Bearer runtime_key_123") {
              return Response.json({ error: { code: "API_KEY_DISABLED" } }, { status: 401 })
            }
          }
          return Response.json({
            id: "chatcmpl_123",
            object: "chat.completion",
            created: 0,
            model: "paid",
            choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "ok" } }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          })
        }
        try {
          const language = await getLanguage(providers[ProviderID.make("wanlaicode")].models["paid"])
          // 两个请求并发触发 401
          await Promise.all([
            language.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "a" }] }] }),
            language.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "b" }] }] }),
          ])
          // 没有任何请求拿陈旧 refresh token 去刷新
          expect(staleRefreshRejected).toBe(false)
          // 共享单飞：两个并发 401 只触发了一次刷新
          expect(calls.filter((call) => call.path === "/v1/oauth/token").length).toBe(1)
          expect(calls.filter((call) => call.path === "/api/oauth/wanlaicode/create_api_key").length).toBe(1)
        } finally {
          WanlaiCodeAuth.setFetchWithoutProxyForTesting(undefined)
        }
      },
    })
  } finally {
    Flag.WANLAICODE_MODELS_PATH = previous
    await AppRuntime.runPromise(Auth.Service.use((svc) => svc.remove("wanlaicode")).pipe(Effect.orDie))
    delete process.env.WANLAICODE_AUTH_CONTENT
    delete process.env.OPENCODE_AUTH_CONTENT
  }
})

test("wanlaicode provider does not report login expired for transient runtime key refresh failures", async () => {
  const previous = Flag.WANLAICODE_MODELS_PATH
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(path.join(dir, "wanlaicode.json"), JSON.stringify({ $schema: "https://opencode.ai/config.json" }))
    },
  })
  await Bun.write(
    path.join(tmp.path, "models.json"),
    JSON.stringify({
      wanlaicode: {
        id: "wanlaicode",
        name: "WanlaiCode",
        api: "https://api.wanlai.ai/v1",
        npm: "@ai-sdk/openai-compatible",
        env: ["WANLAICODE_API_KEY"],
        models: { paid: model("paid", 0, 1) },
      },
    }),
  )
  Flag.WANLAICODE_MODELS_PATH = path.join(tmp.path, "models.json")
  process.env.WANLAICODE_AUTH_CONTENT = JSON.stringify({
    wanlaicode: {
      type: "oauth",
      access: "runtime_key_123",
      refresh: "refresh_123",
      expires: Math.floor(Date.now() / 1000) + 3600,
      accountId: "acct_123",
    },
  })
  try {
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        await env.runPromise((svc) => svc.remove("WANLAICODE_API_KEY"))
        // 刷新协调器走 WanlaiCodeAuth.createFetch（不经过 chat 的 options.fetch），
        // OAuth 刷新相关端点需通过全局 fetch 覆盖来模拟
        WanlaiCodeAuth.setFetchWithoutProxyForTesting(async (input) => {
          const url = new URL(input.toString())
          if (url.pathname === "/v1/oauth/token") {
            return Response.json({ access_token: "access_456", refresh_token: "refresh_456", expires_in: 7200 })
          }
          if (url.pathname === "/api/oauth/profile") {
            return Response.json({ entitlement: { plan: "pro" }, account: { uuid: "acct_123" } })
          }
          if (url.pathname === "/api/oauth/wanlaicode/create_api_key") {
            return Response.json({ error: "upstream temporarily unavailable" }, { status: 500 })
          }
          throw new Error(`unexpected request ${url.pathname}`)
        })
        const providers = await list()
        providers[ProviderID.make("wanlaicode")].options.fetch = async (input: RequestInfo | URL) => {
          const url = new URL(input.toString())
          if (url.pathname.endsWith("/chat/completions")) {
            return Response.json({ error: { code: "API_KEY_DISABLED" } }, { status: 401 })
          }
          throw new Error(`unexpected request ${url.pathname}`)
        }
        try {
          const language = await getLanguage(providers[ProviderID.make("wanlaicode")].models["paid"])
          const error = await language
            .doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }] })
            .then(
              () => undefined,
              (cause) => cause,
            )
          expect(String(error?.message ?? error)).toContain("WanlaiCode OAuth runtime key request failed: 500")
          expect(String(error?.message ?? error)).not.toContain("登录已过期")
        } finally {
          WanlaiCodeAuth.setFetchWithoutProxyForTesting(undefined)
        }
      },
    })
  } finally {
    Flag.WANLAICODE_MODELS_PATH = previous
    await AppRuntime.runPromise(Auth.Service.use((svc) => svc.remove("wanlaicode")).pipe(Effect.orDie))
    delete process.env.WANLAICODE_AUTH_CONTENT
    delete process.env.OPENCODE_AUTH_CONTENT
  }
})

test("wanlaicode provider routes chat completions through dedicated transport", async () => {
  const previous = Flag.WANLAICODE_MODELS_PATH
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
        }),
      )
    },
  })
  await Bun.write(
    path.join(tmp.path, "models.json"),
    JSON.stringify({
      wanlaicode: {
        id: "wanlaicode",
        name: "WanlaiCode",
        api: "https://api.wanlai.ai/v1",
        npm: "@ai-sdk/openai-compatible",
        env: ["WANLAICODE_API_KEY"],
        models: {
          paid: model("paid", 0, 1),
        },
      },
    }),
  )
  Flag.WANLAICODE_MODELS_PATH = path.join(tmp.path, "models.json")
  process.env.WANLAICODE_AUTH_CONTENT = JSON.stringify({
    wanlaicode: {
      type: "oauth",
      access: "runtime_key_123",
      refresh: "refresh_123",
      expires: Math.floor(Date.now() / 1000) + 3600,
      accountId: "acct_123",
    },
  })
  const previousFetch = globalThis.fetch
  globalThis.fetch = Object.assign(
    async () => {
      throw new Error("global fetch should not be used for wanlaicode chat")
    },
    { preconnect: undefined as unknown as typeof fetch.preconnect },
  )
  try {
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        await env.runPromise((svc) => svc.remove("WANLAICODE_API_KEY"))
        const requests: Array<{
          path: string
          authorization: string | null
          client: string | null
          deviceID: string | null
          deviceName: string | null
          deviceOS: string | null
          deviceArch: string | null
        }> = []
        const originalTransport = WanlaiCodeAuth.createFetchWithoutProxy()
        WanlaiCodeAuth.setFetchWithoutProxyForTesting(async (input, init) => {
          const url = new URL(input.toString())
          const headers = new Headers(init?.headers)
          requests.push({
            path: url.pathname,
            authorization: headers.get("authorization"),
            client: headers.get("x-wanlai-client"),
            deviceID: headers.get("x-wanlai-device-id"),
            deviceName: headers.get("x-wanlai-device-name"),
            deviceOS: headers.get("x-wanlai-os"),
            deviceArch: headers.get("x-wanlai-arch"),
          })
          if (url.pathname === "/v1/chat/completions") {
            return Response.json({
              id: "chatcmpl_123",
              object: "chat.completion",
              created: 0,
              model: "paid",
              choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "ok" } }],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            })
          }
          if (url.pathname === "/v1/oauth/token") {
            return Response.json({ access_token: "access_456", refresh_token: "refresh_456", expires_in: 7200 })
          }
          if (url.pathname === "/api/oauth/profile") {
            return Response.json({ entitlement: { plan: "pro" }, account: { uuid: "acct_123" } })
          }
          if (url.pathname === "/api/oauth/wanlaicode/create_api_key") {
            return Response.json({ raw_key: "runtime_key_456" })
          }
          return originalTransport(input, init)
        })
        try {
          const providers = await list()
          const language = await getLanguage(providers[ProviderID.make("wanlaicode")].models["paid"])
          await language.doGenerate({
            prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
          })
          const chatRequest = requests.find((request) => request.path === "/v1/chat/completions")
          expect(chatRequest?.client).toBe("wanlaicodex")
          expect(chatRequest?.deviceID).toBeTruthy()
          expect(chatRequest?.deviceName).toBeTruthy()
          expect(chatRequest?.deviceOS).toBeTruthy()
          expect(chatRequest?.deviceArch).toBeTruthy()
          expect(chatRequest?.deviceName).toMatch(/^[\x20-\x7E]+$/)
          expect(chatRequest?.deviceOS).toMatch(/^[\x20-\x7E]+$/)
          expect(chatRequest?.deviceArch).toMatch(/^[\x20-\x7E]+$/)
        } finally {
          WanlaiCodeAuth.setFetchWithoutProxyForTesting(undefined)
        }
      },
    })
  } finally {
    globalThis.fetch = previousFetch
    Flag.WANLAICODE_MODELS_PATH = previous
    delete process.env.WANLAICODE_AUTH_CONTENT
    delete process.env.OPENCODE_AUTH_CONTENT
  }
})

test("provider loaded from env variable", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      set("ANTHROPIC_API_KEY", "test-api-key")
      const providers = await list()
      expect(providers[ProviderID.anthropic]).toBeDefined()
      // Provider should retain its connection source even if custom loaders
      // merge additional options.
      expect(providers[ProviderID.anthropic].source).toBe("env")
      expect(providers[ProviderID.anthropic].options.headers["anthropic-beta"]).toBeDefined()
    },
  })
})

test("provider loaded from config with apiKey option", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            anthropic: {
              options: {
                apiKey: "config-api-key",
              },
            },
          },
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await list()
      expect(providers[ProviderID.anthropic]).toBeDefined()
    },
  })
})

test("disabled_providers excludes provider", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          disabled_providers: ["anthropic"],
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      set("ANTHROPIC_API_KEY", "test-api-key")
      const providers = await list()
      expect(providers[ProviderID.anthropic]).toBeUndefined()
    },
  })
})

test("enabled_providers restricts to only listed providers", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          enabled_providers: ["anthropic"],
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      set("ANTHROPIC_API_KEY", "test-api-key")
      set("OPENAI_API_KEY", "test-openai-key")
      const providers = await list()
      expect(providers[ProviderID.anthropic]).toBeDefined()
      expect(providers[ProviderID.openai]).toBeUndefined()
    },
  })
})

test("model whitelist filters models for provider", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            anthropic: {
              whitelist: ["claude-sonnet-4-20250514"],
            },
          },
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      set("ANTHROPIC_API_KEY", "test-api-key")
      const providers = await list()
      expect(providers[ProviderID.anthropic]).toBeDefined()
      const models = Object.keys(providers[ProviderID.anthropic].models)
      expect(models).toContain("claude-sonnet-4-20250514")
      expect(models.length).toBe(1)
    },
  })
})

test("model blacklist excludes specific models", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            anthropic: {
              blacklist: ["claude-sonnet-4-20250514"],
            },
          },
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      set("ANTHROPIC_API_KEY", "test-api-key")
      const providers = await list()
      expect(providers[ProviderID.anthropic]).toBeDefined()
      const models = Object.keys(providers[ProviderID.anthropic].models)
      expect(models).not.toContain("claude-sonnet-4-20250514")
    },
  })
})

test("custom model alias via config", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            anthropic: {
              models: {
                "my-alias": {
                  id: "claude-sonnet-4-20250514",
                  name: "My Custom Alias",
                },
              },
            },
          },
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      set("ANTHROPIC_API_KEY", "test-api-key")
      const providers = await list()
      expect(providers[ProviderID.anthropic]).toBeDefined()
      expect(providers[ProviderID.anthropic].models["my-alias"]).toBeDefined()
      expect(providers[ProviderID.anthropic].models["my-alias"].name).toBe("My Custom Alias")
    },
  })
})

test("custom provider with npm package", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            "custom-provider": {
              name: "Custom Provider",
              npm: "@ai-sdk/openai-compatible",
              api: "https://api.custom.com/v1",
              env: ["CUSTOM_API_KEY"],
              models: {
                "custom-model": {
                  name: "Custom Model",
                  tool_call: true,
                  limit: {
                    context: 128000,
                    output: 4096,
                  },
                },
              },
              options: {
                apiKey: "custom-key",
              },
            },
          },
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await list()
      expect(providers[ProviderID.make("custom-provider")]).toBeDefined()
      expect(providers[ProviderID.make("custom-provider")].name).toBe("Custom Provider")
      expect(providers[ProviderID.make("custom-provider")].models["custom-model"]).toBeDefined()
    },
  })
})

test("custom DeepSeek openai-compatible model defaults interleaved reasoning field", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            "custom-provider": {
              name: "Custom Provider",
              npm: "@ai-sdk/openai-compatible",
              api: "https://api.custom.com/v1",
              models: {
                "deepseek-r1": {
                  name: "DeepSeek R1",
                },
                "deepseek-details": {
                  name: "DeepSeek Details",
                  interleaved: { field: "reasoning_details" },
                },
                "custom-model": {
                  name: "Custom Model",
                },
              },
              options: {
                apiKey: "custom-key",
              },
            },
            "custom-anthropic-provider": {
              name: "Custom Anthropic Provider",
              npm: "@ai-sdk/anthropic",
              api: "https://api.custom.com/v1",
              models: {
                "deepseek-r1": {
                  name: "DeepSeek R1",
                },
              },
              options: {
                apiKey: "custom-key",
              },
            },
          },
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await list()
      const provider = providers[ProviderID.make("custom-provider")]
      expect(provider.models["deepseek-r1"].capabilities.interleaved).toEqual({ field: "reasoning_content" })
      expect(provider.models["deepseek-details"].capabilities.interleaved).toEqual({ field: "reasoning_details" })
      expect(provider.models["custom-model"].capabilities.interleaved).toBe(false)
      expect(
        providers[ProviderID.make("custom-anthropic-provider")].models["deepseek-r1"].capabilities.interleaved,
      ).toBe(false)
    },
  })
})

test("env variable takes precedence, config merges options", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            anthropic: {
              options: {
                timeout: 60000,
                chunkTimeout: 15000,
              },
            },
          },
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      set("ANTHROPIC_API_KEY", "env-api-key")
      const providers = await list()
      expect(providers[ProviderID.anthropic]).toBeDefined()
      // Config options should be merged
      expect(providers[ProviderID.anthropic].options.timeout).toBe(60000)
      expect(providers[ProviderID.anthropic].options.chunkTimeout).toBe(15000)
    },
  })
})

test("getModel returns model for valid provider/model", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      set("ANTHROPIC_API_KEY", "test-api-key")
      const model = await getModel(ProviderID.anthropic, ModelID.make("claude-sonnet-4-20250514"))
      expect(model).toBeDefined()
      expect(String(model.providerID)).toBe("anthropic")
      expect(String(model.id)).toBe("claude-sonnet-4-20250514")
      const language = await getLanguage(model)
      expect(language).toBeDefined()
    },
  })
})

test("getModel throws ModelNotFoundError for invalid model", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      set("ANTHROPIC_API_KEY", "test-api-key")
      expect(getModel(ProviderID.anthropic, ModelID.make("nonexistent-model"))).rejects.toThrow()
    },
  })
})

test("getModel throws ModelNotFoundError for invalid provider", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      expect(getModel(ProviderID.make("nonexistent-provider"), ModelID.make("some-model"))).rejects.toThrow()
    },
  })
})

test("parseModel correctly parses provider/model string", () => {
  const result = Provider.parseModel("anthropic/claude-sonnet-4")
  expect(String(result.providerID)).toBe("anthropic")
  expect(String(result.modelID)).toBe("claude-sonnet-4")
})

test("parseModel handles model IDs with slashes", () => {
  const result = Provider.parseModel("openrouter/anthropic/claude-3-opus")
  expect(String(result.providerID)).toBe("openrouter")
  expect(String(result.modelID)).toBe("anthropic/claude-3-opus")
})

test("defaultModel returns first available model when no config set", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      set("ANTHROPIC_API_KEY", "test-api-key")
      const model = await defaultModel()
      expect(model.providerID).toBeDefined()
      expect(model.modelID).toBeDefined()
    },
  })
})

test("defaultModel respects config model setting", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          model: "anthropic/claude-sonnet-4-20250514",
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      set("ANTHROPIC_API_KEY", "test-api-key")
      const model = await defaultModel()
      expect(String(model.providerID)).toBe("anthropic")
      expect(String(model.modelID)).toBe("claude-sonnet-4-20250514")
    },
  })
})

test("provider with baseURL from config", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            "custom-openai": {
              name: "Custom OpenAI",
              npm: "@ai-sdk/openai-compatible",
              env: [],
              models: {
                "gpt-4": {
                  name: "GPT-4",
                  tool_call: true,
                  limit: { context: 128000, output: 4096 },
                },
              },
              options: {
                apiKey: "test-key",
                baseURL: "https://custom.openai.com/v1",
              },
            },
          },
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await list()
      expect(providers[ProviderID.make("custom-openai")]).toBeDefined()
      expect(providers[ProviderID.make("custom-openai")].options.baseURL).toBe("https://custom.openai.com/v1")
    },
  })
})

test("model cost defaults to zero when not specified", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            "test-provider": {
              name: "Test Provider",
              npm: "@ai-sdk/openai-compatible",
              env: [],
              models: {
                "test-model": {
                  name: "Test Model",
                  tool_call: true,
                  limit: { context: 128000, output: 4096 },
                },
              },
              options: {
                apiKey: "test-key",
              },
            },
          },
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await list()
      const model = providers[ProviderID.make("test-provider")].models["test-model"]
      expect(model.cost.input).toBe(0)
      expect(model.cost.output).toBe(0)
      expect(model.cost.cache.read).toBe(0)
      expect(model.cost.cache.write).toBe(0)
    },
  })
})

test("model options are merged from existing model", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            anthropic: {
              models: {
                "claude-sonnet-4-20250514": {
                  options: {
                    customOption: "custom-value",
                  },
                },
              },
            },
          },
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      set("ANTHROPIC_API_KEY", "test-api-key")
      const providers = await list()
      const model = providers[ProviderID.anthropic].models["claude-sonnet-4-20250514"]
      expect(model.options.customOption).toBe("custom-value")
    },
  })
})

test("provider removed when all models filtered out", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            anthropic: {
              whitelist: ["nonexistent-model"],
            },
          },
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      set("ANTHROPIC_API_KEY", "test-api-key")
      const providers = await list()
      expect(providers[ProviderID.anthropic]).toBeUndefined()
    },
  })
})

test("closest finds model by partial match", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      set("ANTHROPIC_API_KEY", "test-api-key")
      const result = await closest(ProviderID.anthropic, ["sonnet-4"])
      expect(result).toBeDefined()
      expect(String(result?.providerID)).toBe("anthropic")
      expect(String(result?.modelID)).toContain("sonnet-4")
    },
  })
})

test("closest returns undefined for nonexistent provider", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const result = await closest(ProviderID.make("nonexistent"), ["model"])
      expect(result).toBeUndefined()
    },
  })
})

test("getModel uses realIdByKey for aliased models", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            anthropic: {
              models: {
                "my-sonnet": {
                  id: "claude-sonnet-4-20250514",
                  name: "My Sonnet Alias",
                },
              },
            },
          },
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      set("ANTHROPIC_API_KEY", "test-api-key")
      const providers = await list()
      expect(providers[ProviderID.anthropic].models["my-sonnet"]).toBeDefined()

      const model = await getModel(ProviderID.anthropic, ModelID.make("my-sonnet"))
      expect(model).toBeDefined()
      expect(String(model.id)).toBe("my-sonnet")
      expect(model.name).toBe("My Sonnet Alias")
    },
  })
})

test("provider api field sets model api.url", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            "custom-api": {
              name: "Custom API",
              npm: "@ai-sdk/openai-compatible",
              api: "https://api.example.com/v1",
              env: [],
              models: {
                "model-1": {
                  name: "Model 1",
                  tool_call: true,
                  limit: { context: 8000, output: 2000 },
                },
              },
              options: {
                apiKey: "test-key",
              },
            },
          },
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await list()
      // api field is stored on model.api.url, used by getSDK to set baseURL
      expect(providers[ProviderID.make("custom-api")].models["model-1"].api.url).toBe("https://api.example.com/v1")
    },
  })
})

test("explicit baseURL overrides api field", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            "custom-api": {
              name: "Custom API",
              npm: "@ai-sdk/openai-compatible",
              api: "https://api.example.com/v1",
              env: [],
              models: {
                "model-1": {
                  name: "Model 1",
                  tool_call: true,
                  limit: { context: 8000, output: 2000 },
                },
              },
              options: {
                apiKey: "test-key",
                baseURL: "https://custom.override.com/v1",
              },
            },
          },
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await list()
      expect(providers[ProviderID.make("custom-api")].options.baseURL).toBe("https://custom.override.com/v1")
    },
  })
})

test("model inherits properties from existing database model", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            anthropic: {
              models: {
                "claude-sonnet-4-20250514": {
                  name: "Custom Name for Sonnet",
                },
              },
            },
          },
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      set("ANTHROPIC_API_KEY", "test-api-key")
      const providers = await list()
      const model = providers[ProviderID.anthropic].models["claude-sonnet-4-20250514"]
      expect(model.name).toBe("Custom Name for Sonnet")
      expect(model.capabilities.toolcall).toBe(true)
      expect(model.capabilities.attachment).toBe(true)
      expect(model.limit.context).toBeGreaterThan(0)
    },
  })
})

test("disabled_providers prevents loading even with env var", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          disabled_providers: ["openai"],
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      set("OPENAI_API_KEY", "test-openai-key")
      const providers = await list()
      expect(providers[ProviderID.openai]).toBeUndefined()
    },
  })
})

test("enabled_providers with empty array allows no providers", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          enabled_providers: [],
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      set("ANTHROPIC_API_KEY", "test-api-key")
      set("OPENAI_API_KEY", "test-openai-key")
      const providers = await list()
      expect(Object.keys(providers).length).toBe(0)
    },
  })
})

test("whitelist and blacklist can be combined", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            anthropic: {
              whitelist: ["claude-sonnet-4-20250514", "claude-opus-4-20250514"],
              blacklist: ["claude-opus-4-20250514"],
            },
          },
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      set("ANTHROPIC_API_KEY", "test-api-key")
      const providers = await list()
      expect(providers[ProviderID.anthropic]).toBeDefined()
      const models = Object.keys(providers[ProviderID.anthropic].models)
      expect(models).toContain("claude-sonnet-4-20250514")
      expect(models).not.toContain("claude-opus-4-20250514")
      expect(models.length).toBe(1)
    },
  })
})

test("model modalities default correctly", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            "test-provider": {
              name: "Test",
              npm: "@ai-sdk/openai-compatible",
              env: [],
              models: {
                "test-model": {
                  name: "Test Model",
                  tool_call: true,
                  limit: { context: 8000, output: 2000 },
                },
              },
              options: { apiKey: "test" },
            },
          },
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await list()
      const model = providers[ProviderID.make("test-provider")].models["test-model"]
      expect(model.capabilities.input.text).toBe(true)
      expect(model.capabilities.output.text).toBe(true)
    },
  })
})

test("model with custom cost values", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            "test-provider": {
              name: "Test",
              npm: "@ai-sdk/openai-compatible",
              env: [],
              models: {
                "test-model": {
                  name: "Test Model",
                  tool_call: true,
                  limit: { context: 8000, output: 2000 },
                  cost: {
                    input: 5,
                    output: 15,
                    cache_read: 2.5,
                    cache_write: 7.5,
                  },
                },
              },
              options: { apiKey: "test" },
            },
          },
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await list()
      const model = providers[ProviderID.make("test-provider")].models["test-model"]
      expect(model.cost.input).toBe(5)
      expect(model.cost.output).toBe(15)
      expect(model.cost.cache.read).toBe(2.5)
      expect(model.cost.cache.write).toBe(7.5)
    },
  })
})

test("getSmallModel returns appropriate small model", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      set("ANTHROPIC_API_KEY", "test-api-key")
      const model = await getSmallModel(ProviderID.anthropic)
      expect(model).toBeDefined()
      expect(model?.id).toContain("haiku")
    },
  })
})

test("getSmallModel respects config small_model override", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          small_model: "anthropic/claude-sonnet-4-20250514",
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      set("ANTHROPIC_API_KEY", "test-api-key")
      const model = await getSmallModel(ProviderID.anthropic)
      expect(model).toBeDefined()
      expect(String(model?.providerID)).toBe("anthropic")
      expect(String(model?.id)).toBe("claude-sonnet-4-20250514")
    },
  })
})

test("getSmallModel ignores a cross-provider override when same-provider selection is required", async () => {
  const currentProvider = ProviderID.make("current-provider")
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          small_model: "other-provider/override-model",
          provider: {
            "current-provider": {
              npm: "@ai-sdk/openai-compatible",
              name: "Current",
              options: { apiKey: "current-key", baseURL: "https://current.invalid/v1" },
              models: { "gpt-5-nano": model("gpt-5-nano", 0) },
            },
            "other-provider": {
              npm: "@ai-sdk/openai-compatible",
              name: "Other",
              options: { apiKey: "other-key", baseURL: "https://other.invalid/v1" },
              models: { "override-model": model("override-model", 0) },
            },
          },
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const selected = await getSmallModel(currentProvider, { sameProvider: true })
      expect(selected?.providerID).toBe(currentProvider)
      expect(String(selected?.id)).toBe("gpt-5-nano")
    },
  })
})

test("getSmallModel keeps non-wanlaicode providers same-provider even when wanlaicode is available", async () => {
  // 隐私回归：getSmallModel 的 wanlaicode/deepseek-v4-flash 默认只在主对话本身是
  // wanlaicode 时生效，不能把 anthropic/openai/本地等用户的标题/建议上下文跨 provider
  // 发到 wanlaicode。这里让 wanlaicode（含 deepseek-v4-flash）真正可用，验证 anthropic
  // 主对话仍解析到同 provider 的 haiku，而非 wanlaicode。
  const previous = Flag.WANLAICODE_MODELS_PATH
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: { wanlaicode: { options: { apiKey: "public" } } },
        }),
      )
    },
  })
  await Bun.write(
    path.join(tmp.path, "models.json"),
    JSON.stringify({
      anthropic: {
        id: "anthropic",
        name: "Anthropic",
        npm: "@ai-sdk/anthropic",
        env: ["ANTHROPIC_API_KEY"],
        models: {
          "claude-haiku-4-5": model("claude-haiku-4-5", 0),
          "claude-sonnet-4-20250514": model("claude-sonnet-4-20250514", 0),
        },
      },
      wanlaicode: {
        id: "wanlaicode",
        name: "WanlaiCode",
        api: "https://api.wanlai.ai/v1",
        npm: "@ai-sdk/openai-compatible",
        env: ["WANLAICODE_API_KEY"],
        models: {
          "deepseek-v4-flash": model("deepseek-v4-flash", 0, 1),
        },
      },
    }),
  )
  Flag.WANLAICODE_MODELS_PATH = path.join(tmp.path, "models.json")
  try {
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        set("ANTHROPIC_API_KEY", "test-api-key")
        // 前置：确认 wanlaicode + deepseek-v4-flash 此刻确实可用，否则本测无意义
        const providers = await list()
        expect(providers[ProviderID.make("wanlaicode")]?.models["deepseek-v4-flash"]).toBeDefined()

        // 主对话 anthropic（非 wanlaicode）：小模型必须留在 anthropic，不跨到 wanlaicode
        const small = await getSmallModel(ProviderID.anthropic)
        expect(String(small?.providerID)).toBe("anthropic")
        expect(String(small?.id)).toContain("haiku")

        // 主对话 wanlaicode：默认小模型用 deepseek-v4-flash
        const wlcSmall = await getSmallModel(ProviderID.make("wanlaicode"))
        expect(String(wlcSmall?.providerID)).toBe("wanlaicode")
        expect(String(wlcSmall?.id)).toBe("deepseek-v4-flash")
      },
    })
  } finally {
    Flag.WANLAICODE_MODELS_PATH = previous
  }
})

test("provider.sort prioritizes preferred models", () => {
  const models = [
    { id: "random-model", name: "Random" },
    { id: "claude-sonnet-4-latest", name: "Claude Sonnet 4" },
    { id: "gpt-5-turbo", name: "GPT-5 Turbo" },
    { id: "other-model", name: "Other" },
  ] as any[]

  const sorted = Provider.sort(models)
  expect(sorted[0].id).toContain("sonnet-4")
  expect(sorted[0].id).toContain("latest")
  expect(sorted[sorted.length - 1].id).not.toContain("gpt-5")
  expect(sorted[sorted.length - 1].id).not.toContain("sonnet-4")
})

test("multiple providers can be configured simultaneously", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            anthropic: {
              options: { timeout: 30000 },
            },
            openai: {
              options: { timeout: 60000 },
            },
          },
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      set("ANTHROPIC_API_KEY", "test-anthropic-key")
      set("OPENAI_API_KEY", "test-openai-key")
      const providers = await list()
      expect(providers[ProviderID.anthropic]).toBeDefined()
      expect(providers[ProviderID.openai]).toBeDefined()
      expect(providers[ProviderID.anthropic].options.timeout).toBe(30000)
      expect(providers[ProviderID.openai].options.timeout).toBe(60000)
    },
  })
})

test("provider with custom npm package", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            "local-llm": {
              name: "Local LLM",
              npm: "@ai-sdk/openai-compatible",
              env: [],
              models: {
                "llama-3": {
                  name: "Llama 3",
                  tool_call: true,
                  limit: { context: 8192, output: 2048 },
                },
              },
              options: {
                apiKey: "not-needed",
                baseURL: "http://localhost:11434/v1",
              },
            },
          },
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await list()
      expect(providers[ProviderID.make("local-llm")]).toBeDefined()
      expect(providers[ProviderID.make("local-llm")].models["llama-3"].api.npm).toBe("@ai-sdk/openai-compatible")
      expect(providers[ProviderID.make("local-llm")].options.baseURL).toBe("http://localhost:11434/v1")
    },
  })
})

// Edge cases for model configuration

test("model alias name defaults to alias key when id differs", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            anthropic: {
              models: {
                sonnet: {
                  id: "claude-sonnet-4-20250514",
                  // no name specified - should default to "sonnet" (the key)
                },
              },
            },
          },
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      set("ANTHROPIC_API_KEY", "test-api-key")
      const providers = await list()
      expect(providers[ProviderID.anthropic].models["sonnet"].name).toBe("sonnet")
    },
  })
})

test("provider with multiple env var options only includes apiKey when single env", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            "multi-env": {
              name: "Multi Env Provider",
              npm: "@ai-sdk/openai-compatible",
              env: ["MULTI_ENV_KEY_1", "MULTI_ENV_KEY_2"],
              models: {
                "model-1": {
                  name: "Model 1",
                  tool_call: true,
                  limit: { context: 8000, output: 2000 },
                },
              },
              options: {
                baseURL: "https://api.example.com/v1",
              },
            },
          },
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      set("MULTI_ENV_KEY_1", "test-key")
      const providers = await list()
      expect(providers[ProviderID.make("multi-env")]).toBeDefined()
      // When multiple env options exist, key should NOT be auto-set
      expect(providers[ProviderID.make("multi-env")].key).toBeUndefined()
    },
  })
})

test("provider with single env var includes apiKey automatically", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            "single-env": {
              name: "Single Env Provider",
              npm: "@ai-sdk/openai-compatible",
              env: ["SINGLE_ENV_KEY"],
              models: {
                "model-1": {
                  name: "Model 1",
                  tool_call: true,
                  limit: { context: 8000, output: 2000 },
                },
              },
              options: {
                baseURL: "https://api.example.com/v1",
              },
            },
          },
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      set("SINGLE_ENV_KEY", "my-api-key")
      const providers = await list()
      expect(providers[ProviderID.make("single-env")]).toBeDefined()
      // Single env option should auto-set key
      expect(providers[ProviderID.make("single-env")].key).toBe("my-api-key")
    },
  })
})

test("model cost overrides existing cost values", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            anthropic: {
              models: {
                "claude-sonnet-4-20250514": {
                  cost: {
                    input: 999,
                    output: 888,
                  },
                },
              },
            },
          },
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      set("ANTHROPIC_API_KEY", "test-api-key")
      const providers = await list()
      const model = providers[ProviderID.anthropic].models["claude-sonnet-4-20250514"]
      expect(model.cost.input).toBe(999)
      expect(model.cost.output).toBe(888)
    },
  })
})

test("completely new provider not in database can be configured", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            "brand-new-provider": {
              name: "Brand New",
              npm: "@ai-sdk/openai-compatible",
              env: [],
              api: "https://new-api.com/v1",
              models: {
                "new-model": {
                  name: "New Model",
                  tool_call: true,
                  reasoning: true,
                  attachment: true,
                  temperature: true,
                  limit: { context: 32000, output: 8000 },
                  modalities: {
                    input: ["text", "image"],
                    output: ["text"],
                  },
                },
              },
              options: {
                apiKey: "new-key",
              },
            },
          },
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await list()
      expect(providers[ProviderID.make("brand-new-provider")]).toBeDefined()
      expect(providers[ProviderID.make("brand-new-provider")].name).toBe("Brand New")
      const model = providers[ProviderID.make("brand-new-provider")].models["new-model"]
      expect(model.capabilities.reasoning).toBe(true)
      expect(model.capabilities.attachment).toBe(true)
      expect(model.capabilities.input.image).toBe(true)
    },
  })
})

test("disabled_providers and enabled_providers interaction", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          // enabled_providers takes precedence - only these are considered
          enabled_providers: ["anthropic", "openai"],
          // Then disabled_providers filters from the enabled set
          disabled_providers: ["openai"],
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      set("ANTHROPIC_API_KEY", "test-anthropic")
      set("OPENAI_API_KEY", "test-openai")
      set("GOOGLE_GENERATIVE_AI_API_KEY", "test-google")
      const providers = await list()
      // anthropic: in enabled, not in disabled = allowed
      expect(providers[ProviderID.anthropic]).toBeDefined()
      // openai: in enabled, but also in disabled = NOT allowed
      expect(providers[ProviderID.openai]).toBeUndefined()
      // google: not in enabled = NOT allowed (even though not disabled)
      expect(providers[ProviderID.google]).toBeUndefined()
    },
  })
})

test("model with tool_call false", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            "no-tools": {
              name: "No Tools Provider",
              npm: "@ai-sdk/openai-compatible",
              env: [],
              models: {
                "basic-model": {
                  name: "Basic Model",
                  tool_call: false,
                  limit: { context: 4000, output: 1000 },
                },
              },
              options: { apiKey: "test" },
            },
          },
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await list()
      expect(providers[ProviderID.make("no-tools")].models["basic-model"].capabilities.toolcall).toBe(false)
    },
  })
})

test("model defaults tool_call to true when not specified", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            "default-tools": {
              name: "Default Tools Provider",
              npm: "@ai-sdk/openai-compatible",
              env: [],
              models: {
                model: {
                  name: "Model",
                  // tool_call not specified
                  limit: { context: 4000, output: 1000 },
                },
              },
              options: { apiKey: "test" },
            },
          },
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await list()
      expect(providers[ProviderID.make("default-tools")].models["model"].capabilities.toolcall).toBe(true)
    },
  })
})

test("model headers are preserved", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            "headers-provider": {
              name: "Headers Provider",
              npm: "@ai-sdk/openai-compatible",
              env: [],
              models: {
                model: {
                  name: "Model",
                  tool_call: true,
                  limit: { context: 4000, output: 1000 },
                  headers: {
                    "X-Custom-Header": "custom-value",
                    Authorization: "Bearer special-token",
                  },
                },
              },
              options: { apiKey: "test" },
            },
          },
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await list()
      const model = providers[ProviderID.make("headers-provider")].models["model"]
      expect(model.headers).toEqual({
        "X-Custom-Header": "custom-value",
        Authorization: "Bearer special-token",
      })
    },
  })
})

test("provider env fallback - second env var used if first missing", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            "fallback-env": {
              name: "Fallback Env Provider",
              npm: "@ai-sdk/openai-compatible",
              env: ["PRIMARY_KEY", "FALLBACK_KEY"],
              models: {
                model: {
                  name: "Model",
                  tool_call: true,
                  limit: { context: 4000, output: 1000 },
                },
              },
              options: { baseURL: "https://api.example.com" },
            },
          },
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      // Only set fallback, not primary
      set("FALLBACK_KEY", "fallback-api-key")
      const providers = await list()
      // Provider should load because fallback env var is set
      expect(providers[ProviderID.make("fallback-env")]).toBeDefined()
    },
  })
})

test("getModel returns consistent results", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      set("ANTHROPIC_API_KEY", "test-api-key")
      const model1 = await getModel(ProviderID.anthropic, ModelID.make("claude-sonnet-4-20250514"))
      const model2 = await getModel(ProviderID.anthropic, ModelID.make("claude-sonnet-4-20250514"))
      expect(model1.providerID).toEqual(model2.providerID)
      expect(model1.id).toEqual(model2.id)
      expect(model1).toEqual(model2)
    },
  })
})

test("provider name defaults to id when not in database", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            "my-custom-id": {
              // no name specified
              npm: "@ai-sdk/openai-compatible",
              env: [],
              models: {
                model: {
                  name: "Model",
                  tool_call: true,
                  limit: { context: 4000, output: 1000 },
                },
              },
              options: { apiKey: "test" },
            },
          },
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await list()
      expect(providers[ProviderID.make("my-custom-id")].name).toBe("my-custom-id")
    },
  })
})

test("ModelNotFoundError includes suggestions for typos", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      set("ANTHROPIC_API_KEY", "test-api-key")
      try {
        await getModel(ProviderID.anthropic, ModelID.make("claude-sonet-4")) // typo: sonet instead of sonnet
        expect(true).toBe(false) // Should not reach here
      } catch (e: any) {
        expect(e.data.suggestions).toBeDefined()
        expect(e.data.suggestions.length).toBeGreaterThan(0)
      }
    },
  })
})

test("ModelNotFoundError for provider includes suggestions", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      set("ANTHROPIC_API_KEY", "test-api-key")
      try {
        await getModel(ProviderID.make("antropic"), ModelID.make("claude-sonnet-4")) // typo: antropic
        expect(true).toBe(false) // Should not reach here
      } catch (e: any) {
        expect(e.data.suggestions).toBeDefined()
        expect(e.data.suggestions).toContain("anthropic")
      }
    },
  })
})

test("getProvider returns undefined for nonexistent provider", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const provider = await getProvider(ProviderID.make("nonexistent"))
      expect(provider).toBeUndefined()
    },
  })
})

test("getProvider returns provider info", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      set("ANTHROPIC_API_KEY", "test-api-key")
      const provider = await getProvider(ProviderID.anthropic)
      expect(provider).toBeDefined()
      expect(String(provider?.id)).toBe("anthropic")
    },
  })
})

test("closest returns undefined when no partial match found", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      set("ANTHROPIC_API_KEY", "test-api-key")
      const result = await closest(ProviderID.anthropic, ["nonexistent-xyz-model"])
      expect(result).toBeUndefined()
    },
  })
})

test("closest checks multiple query terms in order", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      set("ANTHROPIC_API_KEY", "test-api-key")
      // First term won't match, second will
      const result = await closest(ProviderID.anthropic, ["nonexistent", "haiku"])
      expect(result).toBeDefined()
      expect(result?.modelID).toContain("haiku")
    },
  })
})

test("model limit defaults to zero when not specified", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            "no-limit": {
              name: "No Limit Provider",
              npm: "@ai-sdk/openai-compatible",
              env: [],
              models: {
                model: {
                  name: "Model",
                  tool_call: true,
                  // no limit specified
                },
              },
              options: { apiKey: "test" },
            },
          },
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await list()
      const model = providers[ProviderID.make("no-limit")].models["model"]
      expect(model.limit.context).toBe(0)
      expect(model.limit.output).toBe(0)
    },
  })
})

test("provider options are deeply merged", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            anthropic: {
              options: {
                headers: {
                  "X-Custom": "custom-value",
                },
                timeout: 30000,
              },
            },
          },
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      set("ANTHROPIC_API_KEY", "test-api-key")
      const providers = await list()
      // Custom options should be merged
      expect(providers[ProviderID.anthropic].options.timeout).toBe(30000)
      expect(providers[ProviderID.anthropic].options.headers["X-Custom"]).toBe("custom-value")
      // anthropic custom loader adds its own headers, they should coexist
      expect(providers[ProviderID.anthropic].options.headers["anthropic-beta"]).toBeDefined()
    },
  })
})

test("custom model inherits npm package from models.dev provider config", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            openai: {
              models: {
                "my-custom-model": {
                  name: "My Custom Model",
                  tool_call: true,
                  limit: { context: 8000, output: 2000 },
                },
              },
            },
          },
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      set("OPENAI_API_KEY", "test-api-key")
      const providers = await list()
      const model = providers[ProviderID.openai].models["my-custom-model"]
      expect(model).toBeDefined()
      expect(model.api.npm).toBe("@ai-sdk/openai")
    },
  })
})

test("custom model inherits api.url from models.dev provider", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            openrouter: {
              models: {
                "prime-intellect/intellect-3": {},
                "deepseek/deepseek-r1-0528": {
                  name: "DeepSeek R1",
                },
              },
            },
          },
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      set("OPENROUTER_API_KEY", "test-api-key")
      const providers = await list()
      expect(providers[ProviderID.openrouter]).toBeDefined()

      // New model not in database should inherit api.url from provider
      const intellect = providers[ProviderID.openrouter].models["prime-intellect/intellect-3"]
      expect(intellect).toBeDefined()
      expect(intellect.api.url).toBe("https://openrouter.ai/api/v1")

      // Another new model should also inherit api.url
      const deepseek = providers[ProviderID.openrouter].models["deepseek/deepseek-r1-0528"]
      expect(deepseek).toBeDefined()
      expect(deepseek.api.url).toBe("https://openrouter.ai/api/v1")
      expect(deepseek.name).toBe("DeepSeek R1")
    },
  })
})

test("mode cost preserves over-200k pricing from base model", () => {
  const provider = {
    id: "openai",
    name: "OpenAI",
    env: [],
    api: "https://api.openai.com/v1",
    models: {
      "gpt-5.4": {
        id: "gpt-5.4",
        name: "GPT-5.4",
        family: "gpt",
        release_date: "2026-03-05",
        attachment: true,
        reasoning: true,
        temperature: false,
        tool_call: true,
        cost: {
          input: 2.5,
          output: 15,
          cache_read: 0.25,
          context_over_200k: {
            input: 5,
            output: 22.5,
            cache_read: 0.5,
          },
        },
        limit: {
          context: 1_050_000,
          input: 922_000,
          output: 128_000,
        },
        experimental: {
          modes: {
            fast: {
              cost: {
                input: 5,
                output: 30,
                cache_read: 0.5,
              },
              provider: {
                body: {
                  service_tier: "priority",
                },
              },
            },
          },
        },
      },
    },
  } as unknown as ModelsDev.Provider

  const model = Provider.fromModelsDevProvider(provider).models["gpt-5.4-fast"]
  expect(model.cost.input).toEqual(5)
  expect(model.cost.output).toEqual(30)
  expect(model.cost.cache.read).toEqual(0.5)
  expect(model.cost.cache.write).toEqual(0)
  expect(model.options["serviceTier"]).toEqual("priority")
  expect(model.cost.experimentalOver200K).toEqual({
    input: 5,
    output: 22.5,
    cache: {
      read: 0.5,
      write: 0,
    },
  })
})

test("models.dev normalization fills required response fields", () => {
  const provider = {
    id: "gateway",
    name: "Gateway",
    env: [],
    models: {
      "gpt-5.4": {
        id: "gpt-5.4",
        name: "GPT-5.4",
        family: "gpt",
        cost: {
          input: 2.5,
          output: 15,
        },
        limit: {
          context: 1_050_000,
          input: 922_000,
          output: 128_000,
        },
      },
    },
  } as unknown as ModelsDev.Provider

  const model = Provider.fromModelsDevProvider(provider).models["gpt-5.4"]
  expect(model.api.url).toBe("")
  expect(model.capabilities.temperature).toBe(false)
  expect(model.capabilities.reasoning).toBe(false)
  expect(model.capabilities.attachment).toBe(false)
  expect(model.capabilities.toolcall).toBe(true)
  expect(model.release_date).toBe("")
})

test("fromModelsDevProvider maps WanlaiCode backend output modalities and reasoning_options", () => {
  const provider = {
    id: "wanlaicode",
    name: "万来Code",
    env: [],
    models: {
      "seedance-2.0-fast-10s-landscape": {
        id: "seedance-2.0-fast-10s-landscape",
        name: "Seedance 2.0 Fast",
        release_date: "2026-01-01",
        attachment: true,
        reasoning: false,
        temperature: true,
        tool_call: true,
        limit: { context: 200000, output: 128000 },
        modalities: { input: ["text", "image"], output: ["video"] },
      },
      "deepseek-v4-pro": {
        id: "deepseek-v4-pro",
        name: "DeepSeek V4 Pro",
        release_date: "2026-01-01",
        attachment: false,
        reasoning: true,
        temperature: true,
        tool_call: true,
        limit: { context: 200000, output: 128000 },
        modalities: { input: ["text"], output: ["text"] },
        reasoning_options: [{ type: "effort", values: ["high"] }],
        reasoning_efforts: ["high"],
      },
    },
  } as unknown as ModelsDev.Provider

  const models = Provider.fromModelsDevProvider(provider).models
  expect(models["seedance-2.0-fast-10s-landscape"].capabilities.input.image).toBe(true)
  expect(models["seedance-2.0-fast-10s-landscape"].capabilities.output.video).toBe(true)
  expect(models["seedance-2.0-fast-10s-landscape"].capabilities.output.image).toBe(false)
  expect(models["deepseek-v4-pro"].capabilities.output.text).toBe(true)
  expect(models["deepseek-v4-pro"].capabilities.output.image).toBe(false)
  expect(models["deepseek-v4-pro"].reasoning_options).toEqual([{ type: "effort", values: ["high"] }])
})

test("fromModelsDevProvider ignores invalid legacy reasoning option values", () => {
  const provider = {
    id: "legacy",
    name: "Legacy",
    env: [],
    models: {
      "legacy-reasoning": {
        id: "legacy-reasoning",
        name: "Legacy Reasoning",
        release_date: "2026-01-01",
        reasoning: true,
        limit: { context: 200000, output: 128000 },
        reasoning_options: [{ type: "effort", values: [null, "high"] }],
      },
    },
  } as unknown as ModelsDev.Provider

  // 旧 models.dev / 本地缓存可能把 null 混进 values；Provider 输出必须先清洗，不能让 /provider 整体编码失败。
  expect(Provider.fromModelsDevProvider(provider).models["legacy-reasoning"].reasoning_options).toEqual([
    { type: "effort", values: ["high"] },
  ])
})

test("defaultModelIDs skips providers without models", () => {
  expect(
    Provider.defaultModelIDs({
      empty: { models: {} },
      wanlaicode: { models: { "claude-haiku": { id: "claude-haiku" } } },
    }),
  ).toEqual({ wanlaicode: "claude-haiku" })
})

test("model variants are generated for reasoning models", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      set("ANTHROPIC_API_KEY", "test-api-key")
      const providers = await list()
      // Claude sonnet 4 has reasoning capability
      const model = providers[ProviderID.anthropic].models["claude-sonnet-4-20250514"]
      expect(model.capabilities.reasoning).toBe(true)
      expect(model.variants).toBeDefined()
      expect(Object.keys(model.variants!).length).toBeGreaterThan(0)
    },
  })
})

test("model variants can be disabled via config", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            anthropic: {
              models: {
                "claude-sonnet-4-20250514": {
                  variants: {
                    high: { disabled: true },
                  },
                },
              },
            },
          },
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      set("ANTHROPIC_API_KEY", "test-api-key")
      const providers = await list()
      const model = providers[ProviderID.anthropic].models["claude-sonnet-4-20250514"]
      expect(model.variants).toBeDefined()
      expect(model.variants!["high"]).toBeUndefined()
      // max variant should still exist
      expect(model.variants!["max"]).toBeDefined()
    },
  })
})

test("model variants can be customized via config", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            anthropic: {
              models: {
                "claude-sonnet-4-20250514": {
                  variants: {
                    high: {
                      thinking: {
                        type: "enabled",
                        budgetTokens: 20000,
                      },
                    },
                  },
                },
              },
            },
          },
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      set("ANTHROPIC_API_KEY", "test-api-key")
      const providers = await list()
      const model = providers[ProviderID.anthropic].models["claude-sonnet-4-20250514"]
      expect(model.variants!["high"]).toBeDefined()
      expect(model.variants!["high"].thinking.budgetTokens).toBe(20000)
    },
  })
})

test("disabled key is stripped from variant config", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            anthropic: {
              models: {
                "claude-sonnet-4-20250514": {
                  variants: {
                    max: {
                      disabled: false,
                      customField: "test",
                    },
                  },
                },
              },
            },
          },
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      set("ANTHROPIC_API_KEY", "test-api-key")
      const providers = await list()
      const model = providers[ProviderID.anthropic].models["claude-sonnet-4-20250514"]
      expect(model.variants!["max"]).toBeDefined()
      expect(model.variants!["max"].disabled).toBeUndefined()
      expect(model.variants!["max"].customField).toBe("test")
    },
  })
})

test("all variants can be disabled via config", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            anthropic: {
              models: {
                "claude-sonnet-4-20250514": {
                  variants: {
                    high: { disabled: true },
                    max: { disabled: true },
                  },
                },
              },
            },
          },
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      set("ANTHROPIC_API_KEY", "test-api-key")
      const providers = await list()
      const model = providers[ProviderID.anthropic].models["claude-sonnet-4-20250514"]
      expect(model.variants).toBeDefined()
      expect(Object.keys(model.variants!).length).toBe(0)
    },
  })
})

test("variant config merges with generated variants", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            anthropic: {
              models: {
                "claude-sonnet-4-20250514": {
                  variants: {
                    high: {
                      extraOption: "custom-value",
                    },
                  },
                },
              },
            },
          },
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      set("ANTHROPIC_API_KEY", "test-api-key")
      const providers = await list()
      const model = providers[ProviderID.anthropic].models["claude-sonnet-4-20250514"]
      expect(model.variants!["high"]).toBeDefined()
      // Should have both the generated thinking config and the custom option
      expect(model.variants!["high"].thinking).toBeDefined()
      expect(model.variants!["high"].extraOption).toBe("custom-value")
    },
  })
})

test("variants filtered in second pass for database models", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            openai: {
              models: {
                "gpt-5": {
                  variants: {
                    high: { disabled: true },
                  },
                },
              },
            },
          },
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      set("OPENAI_API_KEY", "test-api-key")
      const providers = await list()
      const model = providers[ProviderID.openai].models["gpt-5"]
      expect(model.variants).toBeDefined()
      expect(model.variants!["high"]).toBeUndefined()
      // Other variants should still exist
      expect(model.variants!["medium"]).toBeDefined()
    },
  })
})

test("custom model with variants enabled and disabled", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            "custom-reasoning": {
              name: "Custom Reasoning Provider",
              npm: "@ai-sdk/openai-compatible",
              env: [],
              models: {
                "reasoning-model": {
                  name: "Reasoning Model",
                  tool_call: true,
                  reasoning: true,
                  limit: { context: 128000, output: 16000 },
                  variants: {
                    low: { reasoningEffort: "low" },
                    medium: { reasoningEffort: "medium" },
                    high: { reasoningEffort: "high", disabled: true },
                    custom: { reasoningEffort: "custom", budgetTokens: 5000 },
                  },
                },
              },
              options: { apiKey: "test-key" },
            },
          },
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await list()
      const model = providers[ProviderID.make("custom-reasoning")].models["reasoning-model"]
      expect(model.variants).toBeDefined()
      // Enabled variants should exist
      expect(model.variants!["low"]).toBeDefined()
      expect(model.variants!["low"].reasoningEffort).toBe("low")
      expect(model.variants!["medium"]).toBeDefined()
      expect(model.variants!["medium"].reasoningEffort).toBe("medium")
      expect(model.variants!["custom"]).toBeDefined()
      expect(model.variants!["custom"].reasoningEffort).toBe("custom")
      expect(model.variants!["custom"].budgetTokens).toBe(5000)
      // Disabled variant should not exist
      expect(model.variants!["high"]).toBeUndefined()
      // disabled key should be stripped from all variants
      expect(model.variants!["low"].disabled).toBeUndefined()
      expect(model.variants!["medium"].disabled).toBeUndefined()
      expect(model.variants!["custom"].disabled).toBeUndefined()
    },
  })
})

test("Google Vertex: retains baseURL for custom proxy", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            "vertex-proxy": {
              name: "Vertex Proxy",
              npm: "@ai-sdk/google-vertex",
              api: "https://my-proxy.com/v1",
              env: ["GOOGLE_APPLICATION_CREDENTIALS"], // Mock env var requirement
              models: {
                "gemini-pro": {
                  name: "Gemini Pro",
                  tool_call: true,
                },
              },
              options: {
                project: "test-project",
                location: "us-central1",
                baseURL: "https://my-proxy.com/v1", // Should be retained
              },
            },
          },
        }),
      )
    },
  })

  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      set("GOOGLE_APPLICATION_CREDENTIALS", "test-creds")
      const providers = await list()
      expect(providers[ProviderID.make("vertex-proxy")]).toBeDefined()
      expect(providers[ProviderID.make("vertex-proxy")].options.baseURL).toBe("https://my-proxy.com/v1")
    },
  })
})

test("Google Vertex: supports OpenAI compatible models", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            "vertex-openai": {
              name: "Vertex OpenAI",
              npm: "@ai-sdk/google-vertex",
              env: ["GOOGLE_APPLICATION_CREDENTIALS"],
              models: {
                "gpt-4": {
                  name: "GPT-4",
                  provider: {
                    npm: "@ai-sdk/openai-compatible",
                    api: "https://api.openai.com/v1",
                  },
                },
              },
              options: {
                project: "test-project",
                location: "us-central1",
              },
            },
          },
        }),
      )
    },
  })

  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      set("GOOGLE_APPLICATION_CREDENTIALS", "test-creds")
      const providers = await list()
      const model = providers[ProviderID.make("vertex-openai")].models["gpt-4"]

      expect(model).toBeDefined()
      expect(model.api.npm).toBe("@ai-sdk/openai-compatible")
    },
  })
})

test("cloudflare-ai-gateway loads with env variables", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      set("CLOUDFLARE_ACCOUNT_ID", "test-account")
      set("CLOUDFLARE_GATEWAY_ID", "test-gateway")
      set("CLOUDFLARE_API_TOKEN", "test-token")
      const providers = await list()
      expect(providers[ProviderID.make("cloudflare-ai-gateway")]).toBeDefined()
    },
  })
})

test("cloudflare-ai-gateway forwards config metadata options", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            "cloudflare-ai-gateway": {
              options: {
                metadata: { invoked_by: "test", project: "wanlaicode" },
              },
            },
          },
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      set("CLOUDFLARE_ACCOUNT_ID", "test-account")
      set("CLOUDFLARE_GATEWAY_ID", "test-gateway")
      set("CLOUDFLARE_API_TOKEN", "test-token")
      const providers = await list()
      expect(providers[ProviderID.make("cloudflare-ai-gateway")]).toBeDefined()
      expect(providers[ProviderID.make("cloudflare-ai-gateway")].options.metadata).toEqual({
        invoked_by: "test",
        project: "wanlaicode",
      })
    },
  })
})

test("plugin config providers persist after instance dispose", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      const configDir = path.join(dir, ".wanlaicode")
      const root = path.join(configDir, "plugin")
      await mkdir(root, { recursive: true })
      await markPluginDependenciesReady(configDir)
      await markPluginDependenciesReady(Global.Path.config)
      await Bun.write(
        path.join(root, "demo-provider.ts"),
        [
          "export default {",
          '  id: "demo.plugin-provider",',
          "  server: async () => ({",
          "    async config(cfg) {",
          "      cfg.provider ??= {}",
          "      cfg.provider.demo = {",
          '        name: "Demo Provider",',
          '        npm: "@ai-sdk/openai-compatible",',
          '        api: "https://example.com/v1",',
          "        models: {",
          "          chat: {",
          '            name: "Demo Chat",',
          "            tool_call: true,",
          "            limit: { context: 128000, output: 4096 },",
          "          },",
          "        },",
          "      }",
          "    },",
          "  }),",
          "}",
          "",
        ].join("\n"),
      )
    },
  })

  const first = await WithInstance.provide({
    directory: tmp.path,
    fn: async () =>
      AppRuntime.runPromise(
        Effect.gen(function* () {
          const plugin = yield* Plugin.Service
          const provider = yield* Provider.Service
          yield* plugin.init()
          return yield* provider.list()
        }),
      ),
  })
  expect(first[ProviderID.make("demo")]).toBeDefined()
  expect(first[ProviderID.make("demo")].models[ModelID.make("chat")]).toBeDefined()

  await disposeAllInstances()

  const second = await WithInstance.provide({
    directory: tmp.path,
    fn: async () => list(),
  })
  expect(second[ProviderID.make("demo")]).toBeDefined()
  expect(second[ProviderID.make("demo")].models[ModelID.make("chat")]).toBeDefined()
})

test("plugin config enabled and disabled providers are honored", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      const root = path.join(dir, ".wanlaicode", "plugin")
      await mkdir(root, { recursive: true })
      await Bun.write(
        path.join(root, "provider-filter.ts"),
        [
          "export default {",
          '  id: "demo.provider-filter",',
          "  server: async () => ({",
          "    async config(cfg) {",
          '      cfg.enabled_providers = ["anthropic", "openai"]',
          '      cfg.disabled_providers = ["openai"]',
          "    },",
          "  }),",
          "}",
          "",
        ].join("\n"),
      )
    },
  })

  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      set("ANTHROPIC_API_KEY", "test-anthropic-key")
      set("OPENAI_API_KEY", "test-openai-key")
      const providers = await list()
      expect(providers[ProviderID.anthropic]).toBeDefined()
      expect(providers[ProviderID.openai]).toBeUndefined()
    },
  })
})

test("wanlaicode loader keeps paid models when config apiKey is present", async () => {
  const previous = Flag.WANLAICODE_MODELS_PATH
  await using base = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
        }),
      )
      await Bun.write(
        path.join(dir, "models.json"),
        JSON.stringify({
          wanlaicode: {
            id: "wanlaicode",
            name: "WanlaiCode",
            api: "https://api.wanlai.ai/v1",
            npm: "@ai-sdk/openai-compatible",
            env: ["WANLAICODE_API_KEY"],
            models: {
              free: model("free", 0),
              paid: model("paid", 1),
            },
          },
        }),
      )
    },
  })
  Flag.WANLAICODE_MODELS_PATH = path.join(base.path, "models.json")

  try {
    const none = await WithInstance.provide({
      directory: base.path,
      fn: async () => {
        await AppRuntime.runPromise(Auth.Service.use((svc) => svc.remove("wanlaicode")).pipe(Effect.orDie))
        await env.runPromise((svc) => svc.remove("WANLAICODE_API_KEY"))
        return paid(await list())
      },
    })

    await using keyed = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "wanlaicode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            provider: {
              wanlaicode: {
                options: {
                  apiKey: "test-key",
                },
              },
            },
          }),
        )
      },
    })

    const keyedCount = await WithInstance.provide({
      directory: keyed.path,
      fn: async () => paid(await list()),
    })

    expect(none).toBeGreaterThan(0)
    expect(keyedCount).toBeGreaterThan(0)
  } finally {
    Flag.WANLAICODE_MODELS_PATH = previous
  }
})

test("wanlaicode loader keeps paid models when auth exists", async () => {
  const previous = Flag.WANLAICODE_MODELS_PATH
  await using base = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
        }),
      )
      await Bun.write(
        path.join(dir, "models.json"),
        JSON.stringify({
          wanlaicode: {
            id: "wanlaicode",
            name: "WanlaiCode",
            api: "https://api.wanlai.ai/v1",
            npm: "@ai-sdk/openai-compatible",
            env: ["WANLAICODE_API_KEY"],
            models: {
              free: model("free", 0),
              paid: model("paid", 1),
            },
          },
        }),
      )
    },
  })
  Flag.WANLAICODE_MODELS_PATH = path.join(base.path, "models.json")

  const none = await WithInstance.provide({
    directory: base.path,
    fn: async () => {
      await AppRuntime.runPromise(Auth.Service.use((svc) => svc.remove("wanlaicode")).pipe(Effect.orDie))
      await env.runPromise((svc) => svc.remove("WANLAICODE_API_KEY"))
      return paid(await list())
    },
  })

  await using keyed = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
        }),
      )
    },
  })

  try {
    const keyedCount = await WithInstance.provide({
      directory: keyed.path,
      fn: async () => {
        await AppRuntime.runPromise(
          Auth.Service.use((svc) =>
            svc.set(
              "wanlaicode",
              new Auth.Api({
                type: "api",
                key: "test-key",
              }),
            ),
          ).pipe(Effect.orDie),
        )
        return paid(await list())
      },
    })

    expect(none).toBeGreaterThan(0)
    expect(keyedCount).toBeGreaterThan(0)
  } finally {
    Flag.WANLAICODE_MODELS_PATH = previous
    delete process.env.WANLAICODE_AUTH_CONTENT
    delete process.env.OPENCODE_AUTH_CONTENT
  }
})
