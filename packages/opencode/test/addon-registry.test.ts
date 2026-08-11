import { afterEach, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { mkdir, readFile, rm, stat, writeFile } from "fs/promises"
import path from "path"
import * as tar from "tar"
import type { FetchImpl } from "@opencode-ai/addon"
import { Auth } from "../src/auth"
import { Config } from "../src/config/config"
import * as Registry from "../src/addon/registry"
import * as WanlaiCodeAuth from "../src/provider/wanlaicode"
import { WanlaiCodeRefreshCoordinator } from "../src/provider/wanlaicode-refresh-coordinator"
import { disposeAllInstances, provideTestInstance, tmpdir } from "./fixture/fixture"

const ACCESS_TOKEN = "test-access-token-abc"
// Must match the value pinned in test/preload.ts (set before any src/ import,
// because provider/wanlaicode snapshots WANLAICODE_PLUGIN_REGISTRY_URL at load).
const REGISTRY_BASE = "https://registry.test.invalid"

afterEach(async () => {
  await disposeAllInstances()
  // 本测试写入的都是【全局】状态（共享同一 XDG_DATA_HOME，见 preload.ts），与项目目录无关，
  // 不清理会污染后续用例：
  // - RegistryService.install 落到 addonsCacheRoot() → demo@wanlaicode 被路径扫描读到
  //   （如 httpapi-addon 的「list returns empty」非空）。
  // - auth.set("wanlaicode") 落到 auth.json → 被「无鉴权」用例读到（如 ModelsDev get() 收到 Bearer）。
  await rm(addonsCachePath("wanlaicode", "demo"), { recursive: true, force: true })
  await rm(addonsCachePath("wanlaicode", "alice", "demo"), { recursive: true, force: true })
  await rm(path.join(process.env.XDG_DATA_HOME!, "wanlaicode", "auth.json"), { force: true })
})

// Build a real .tar.gz on disk whose top-level entry is a wrapper dir
// (registry tars carry a `<ns>-<slug>/` wrapper → materialize strips 1).
async function buildRegistryTar(stageDir: string, wrapperName: string, version: string): Promise<Uint8Array> {
  const pluginDir = path.join(stageDir, wrapperName, ".codex-plugin")
  await mkdir(pluginDir, { recursive: true })
  await writeFile(path.join(pluginDir, "plugin.json"), JSON.stringify({ name: "demo", version }))
  const stream = tar.c({ gzip: true, cwd: stageDir }, [wrapperName]) as unknown as AsyncIterable<Uint8Array>
  const chunks: Uint8Array[] = []
  for await (const chunk of stream) chunks.push(chunk)
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const out = new Uint8Array(total)
  let p = 0
  for (const c of chunks) {
    out.set(c, p)
    p += c.length
  }
  return out
}

function envelope(data: unknown) {
  return new Response(JSON.stringify({ code: 0, message: "", data }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

function addonsCachePath(market: string, ...segments: string[]) {
  return path.join(process.env.XDG_DATA_HOME!, "wanlaicode", "addons", "cache", market, ...segments)
}

test("install: downloads tar, materializes to cache, injects Bearer, enables in config", async () => {
  await using project = await tmpdir()
  await using stage = await tmpdir()

  const VERSION = "1.2.0"
  const tarball = await buildRegistryTar(stage.path, "alice-demo", VERSION)
  const downloadAuthHeaders: Array<string | null> = []

  const fetchImpl: FetchImpl = async (input, init) => {
    const url = typeof input === "string" ? input : input.toString()
    const auth = new Headers(init?.headers).get("authorization")
    // metadata: GET /api/v1/plugins/alice/demo
    if (url === `${REGISTRY_BASE}/api/v1/plugins/alice/demo`) {
      return envelope({
        namespace: "alice",
        slug: "demo",
        latest_version: VERSION,
        versions: [],
      })
    }
    // download: GET .../versions/<v>/download
    if (url === `${REGISTRY_BASE}/api/v1/plugins/alice/demo/versions/${VERSION}/download`) {
      downloadAuthHeaders.push(auth)
      return new Response(tarball as unknown as BodyInit, {
        status: 200,
        headers: { "content-type": "application/gzip" },
      })
    }
    return new Response("not found", { status: 404 })
  }

  const result = await provideTestInstance({
    directory: project.path,
    fn: () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const auth = yield* Auth.Service
          yield* auth.set("wanlaicode", {
            type: "oauth",
            refresh: "r",
            access: "sk-runtime-key", // 推理用 runtime key（插件后端不认）
            softwareToken: ACCESS_TOKEN, // OAuth JWT —— 插件后端 Bearer 用它
            expires: 9999999999, // 远未过期，避免触发刷新
          })
          const registry = yield* Registry.Service
          return yield* registry.install({ namespace: "alice", slug: "demo" })
        }).pipe(
          Effect.provide(Registry.layerWith({ fetchImpl })),
          Effect.provide(Layer.merge(Config.defaultLayer, Auth.defaultLayer)),
        ),
      ),
  })

  // (1) install lands cacheRoot/wanlaicode/alice/demo/<version>/.codex-plugin/plugin.json
  expect(result.version).toBe(VERSION)
  expect(result.key).toBe("demo@wanlaicode/alice")
  const manifestPath = path.join(addonsCachePath("wanlaicode", "alice", "demo"), VERSION, ".codex-plugin", "plugin.json")
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
  expect(manifest.name).toBe("demo")
  await stat(manifestPath) // throws if missing

  // (2) download fetch carried Authorization: Bearer <softwareToken(OAuth JWT)>
  expect(downloadAuthHeaders).toContain(`Bearer ${ACCESS_TOKEN}`)

  // (3) config.plugins["demo@wanlaicode/alice"].enabled === true
  const cfg = await provideTestInstance({
    directory: project.path,
    fn: () =>
      Effect.runPromise(
        Effect.gen(function* () {
          return yield* (yield* Config.Service).getGlobal()
        }).pipe(Effect.provide(Config.defaultLayer)),
      ),
  })
  expect(cfg.plugins?.["demo@wanlaicode/alice"]?.enabled).toBe(true)
})

test("publishLocalPlugin: uploads a gzipped tarball for a local addon root", async () => {
  await using project = await tmpdir()
  await using source = await tmpdir()
  await using upload = await tmpdir()

  const pluginRoot = path.join(source.path, "demo")
  await mkdir(path.join(pluginRoot, ".codex-plugin"), { recursive: true })
  await writeFile(
    path.join(pluginRoot, ".codex-plugin", "plugin.json"),
    JSON.stringify({
      name: "demo",
      version: "1.0.0",
      interface: { defaultPrompt: "Help me use Demo." },
    }),
  )
  await writeFile(path.join(pluginRoot, "marker.txt"), "uploaded")

  const seen: { auth: string | null; fileName: string; entries: string[]; defaultPrompt: unknown }[] = []
  const fetchImpl: FetchImpl = async (input, init) => {
    const url = new URL(input.toString())
    if (url.pathname === "/api/v1/me") {
      return envelope({
        wanlai_uuid: "00000000-0000-0000-0000-000000000001",
        email: "user@example.com",
        username: "user",
        role: "user",
        status: "active",
        namespace: "alice",
        created_at: "",
        updated_at: "",
      })
    }
    if (String(input) !== `${REGISTRY_BASE}/api/v1/plugins/alice/demo/versions`) return new Response("not found", { status: 404 })
    const file = (await new Request(input, init).formData()).get("file")
    if (!(file instanceof File)) return new Response("missing file", { status: 400 })
    const tarPath = path.join(upload.path, file.name)
    await writeFile(tarPath, Buffer.from(await file.arrayBuffer()))
    const entries: string[] = []
    await tar.t({ file: tarPath, onentry: (entry) => entries.push(entry.path) })
    const extractDir = path.join(upload.path, "extract")
    await mkdir(extractDir, { recursive: true })
    await tar.x({ file: tarPath, cwd: extractDir })
    const manifest = JSON.parse(await readFile(path.join(extractDir, "package/.codex-plugin/plugin.json"), "utf-8")) as {
      interface?: { defaultPrompt?: unknown }
    }
    seen.push({
      auth: new Headers(init?.headers).get("authorization"),
      fileName: file.name,
      entries,
      defaultPrompt: manifest.interface?.defaultPrompt,
    })
    return envelope({ namespace: "alice", slug: "demo", version: "1.0.0" })
  }

  await provideTestInstance({
    directory: project.path,
    fn: () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const auth = yield* Auth.Service
          yield* auth.set("wanlaicode", {
            type: "oauth",
            refresh: "r",
            access: "sk-runtime-key",
            softwareToken: ACCESS_TOKEN,
            expires: 9999999999,
          })
          const registry = yield* Registry.Service
          return yield* registry.publishLocalPlugin({
            root: pluginRoot,
            name: "demo",
            version: "1.0.0",
          })
        }).pipe(
          Effect.provide(Registry.layerWith({ fetchImpl })),
          Effect.provide(Layer.merge(Config.defaultLayer, Auth.defaultLayer)),
        ),
      ),
  })

  expect(seen).toHaveLength(1)
  expect(seen[0]!.auth).toBe(`Bearer ${ACCESS_TOKEN}`)
  expect(seen[0]!.fileName).toBe("demo-1.0.0.tgz")
  expect(seen[0]!.entries).toContain("package/.codex-plugin/plugin.json")
  expect(seen[0]!.entries).toContain("package/marker.txt")
  expect(seen[0]!.defaultPrompt).toEqual(["Help me use Demo."])
  expect(JSON.parse(await readFile(path.join(pluginRoot, ".codex-plugin/plugin.json"), "utf-8")).interface.defaultPrompt).toBe(
    "Help me use Demo.",
  )
})

test("publishLocalPlugin: refreshes software token and retries once after registry 401", async () => {
  await using project = await tmpdir()
  await using source = await tmpdir()
  await using upload = await tmpdir()

  const pluginRoot = path.join(source.path, "demo")
  await mkdir(path.join(pluginRoot, ".codex-plugin"), { recursive: true })
  await writeFile(
    path.join(pluginRoot, ".codex-plugin", "plugin.json"),
    JSON.stringify({ name: "demo", version: "1.0.0" }),
  )

  const publishAuthHeaders: Array<string | null> = []
  const fetchImpl: FetchImpl = async (input, init) => {
    const url = new URL(input.toString())
    if (url.pathname === "/api/v1/me") {
      return envelope({
        wanlai_uuid: "00000000-0000-0000-0000-000000000001",
        email: "user@example.com",
        username: "user",
        role: "user",
        status: "active",
        namespace: "alice",
        created_at: "",
        updated_at: "",
      })
    }
    if (url.pathname === "/api/v1/plugins/alice/demo/versions") {
      publishAuthHeaders.push(new Headers(init?.headers).get("authorization"))
      if (publishAuthHeaders.length === 1) {
        return new Response(JSON.stringify({ code: 401, message: "登录已过期，请重新登录", data: null }), {
          status: 401,
          headers: { "content-type": "application/json" },
        })
      }
      const file = (await new Request(input, init).formData()).get("file")
      if (!(file instanceof File)) return new Response("missing file", { status: 400 })
      await writeFile(path.join(upload.path, file.name), Buffer.from(await file.arrayBuffer()))
      return envelope({ namespace: "alice", slug: "demo", version: "1.0.0" })
    }
    return new Response("not found", { status: 404 })
  }

  // 401 后的刷新走统一刷新协调器，协调器用 WanlaiCodeAuth.createFetch（不经过 registry 注入的 fetchImpl），
  // 因此 OAuth 刷新端点需通过全局 fetch 覆盖来模拟。
  const refreshPaths: string[] = []
  WanlaiCodeRefreshCoordinator.resetForTest()
  WanlaiCodeAuth.setFetchWithoutProxyForTesting(async (input) => {
    const url = new URL(input.toString())
    refreshPaths.push(url.pathname)
    if (url.pathname === "/v1/oauth/token") {
      return Response.json({ access_token: "fresh-software-token", refresh_token: "fresh-refresh", expires_in: 7200 })
    }
    if (url.pathname === "/api/oauth/profile") {
      return Response.json({ account: { uuid: "acct_123", email: "user@example.com" } })
    }
    if (url.pathname === "/api/oauth/wanlaicode/create_api_key") {
      return Response.json({ raw_key: "fresh-runtime-key" })
    }
    return new Response("not found", { status: 404 })
  })

  try {
    await provideTestInstance({
      directory: project.path,
      fn: () =>
        Effect.runPromise(
          Effect.gen(function* () {
            const auth = yield* Auth.Service
            yield* auth.set("wanlaicode", {
              type: "oauth",
              refresh: "stale-refresh",
              access: "stale-runtime-key",
              softwareToken: "stale-software-token",
              expires: 9999999999,
            })
            const registry = yield* Registry.Service
            return yield* registry.publishLocalPlugin({
              root: pluginRoot,
              name: "demo",
              version: "1.0.0",
            })
          }).pipe(
            Effect.provide(Registry.layerWith({ fetchImpl })),
            Effect.provide(Layer.merge(Config.defaultLayer, Auth.defaultLayer)),
          ),
        ),
    })

    expect(publishAuthHeaders).toEqual(["Bearer stale-software-token", "Bearer fresh-software-token"])
    expect(refreshPaths).toEqual(["/v1/oauth/token", "/api/oauth/profile", "/api/oauth/wanlaicode/create_api_key"])
  } finally {
    WanlaiCodeAuth.setFetchWithoutProxyForTesting(undefined)
    WanlaiCodeRefreshCoordinator.resetForTest()
  }
})

const registryUser = {
  wanlai_uuid: "00000000-0000-0000-0000-000000000001",
  email: "user@example.com",
  username: "user",
  role: "user",
  status: "active",
  namespace: "alice",
  created_at: "",
  updated_at: "",
}

const protectedReads: Array<{
  name: string
  path: string
  data: unknown
  run: (registry: Registry.Interface) => Effect.Effect<unknown, Error>
}> = [
  {
    name: "me",
    path: "/api/v1/me",
    data: registryUser,
    run: (registry) => registry.me(),
  },
  {
    name: "getMyRating",
    path: "/api/v1/plugins/alice/demo/rating",
    data: null,
    run: (registry) => registry.getMyRating("alice", "demo"),
  },
  {
    name: "myPlugins",
    path: "/api/v1/me",
    data: registryUser,
    run: (registry) => registry.myPlugins(),
  },
]

protectedReads.forEach((entry) => {
  test(`${entry.name}: refreshes software token and retries once after registry 401`, async () => {
    await using project = await tmpdir()

    const authHeaders: Array<string | null> = []
    const fetchImpl: FetchImpl = async (input, init) => {
      const url = new URL(input.toString())
      if (url.pathname === entry.path) {
        authHeaders.push(new Headers(init?.headers).get("authorization"))
        if (authHeaders.length === 1) {
          return new Response(JSON.stringify({ code: 401, message: "token expired", data: null }), {
            status: 401,
            headers: { "content-type": "application/json" },
          })
        }
        return envelope(entry.data)
      }
      if (url.pathname === "/api/v1/plugins") {
        return envelope({ items: [], total: 0, page: 1, per_page: 100 })
      }
      return new Response("not found", { status: 404 })
    }

    const refreshPaths: string[] = []
    WanlaiCodeRefreshCoordinator.resetForTest()
    WanlaiCodeAuth.setFetchWithoutProxyForTesting(async (input) => {
      const url = new URL(input.toString())
      refreshPaths.push(url.pathname)
      if (url.pathname === "/v1/oauth/token") {
        return Response.json({ access_token: "fresh-software-token", refresh_token: "fresh-refresh", expires_in: 7200 })
      }
      if (url.pathname === "/api/oauth/profile") {
        return Response.json({ account: { uuid: "acct_123", email: "user@example.com" } })
      }
      if (url.pathname === "/api/oauth/wanlaicode/create_api_key") {
        return Response.json({ raw_key: "fresh-runtime-key" })
      }
      return new Response("not found", { status: 404 })
    })

    try {
      await provideTestInstance({
        directory: project.path,
        fn: () =>
          Effect.runPromise(
            Effect.gen(function* () {
              const auth = yield* Auth.Service
              yield* auth.set("wanlaicode", {
                type: "oauth",
                refresh: "stale-refresh",
                access: "stale-runtime-key",
                softwareToken: "stale-software-token",
                expires: 9999999999,
              })
              return yield* entry.run(yield* Registry.Service)
            }).pipe(
              Effect.provide(Registry.layerWith({ fetchImpl })),
              Effect.provide(Layer.merge(Config.defaultLayer, Auth.defaultLayer)),
            ),
          ),
      })

      expect(authHeaders).toEqual(["Bearer stale-software-token", "Bearer fresh-software-token"])
      expect(refreshPaths).toEqual(["/v1/oauth/token", "/api/oauth/profile", "/api/oauth/wanlaicode/create_api_key"])
    } finally {
      WanlaiCodeAuth.setFetchWithoutProxyForTesting(undefined)
      WanlaiCodeRefreshCoordinator.resetForTest()
    }
  })
})

test("myPlugins: returns current namespace and filters marketplace plugins", async () => {
  await using project = await tmpdir()

  const seen: string[] = []
  const fetchImpl: FetchImpl = async (input) => {
    const url = String(input)
    seen.push(url)
    if (url === `${REGISTRY_BASE}/api/v1/me`) {
      return envelope({
        wanlai_uuid: "00000000-0000-0000-0000-000000000001",
        email: "user@example.com",
        username: "user",
        role: "user",
        status: "active",
        namespace: "alice",
        created_at: "",
        updated_at: "",
      })
    }
    if (url === `${REGISTRY_BASE}/api/v1/plugins?page=1&per_page=100&locale=zh`) {
      return envelope({
        items: [
          {
            namespace: "alice",
            slug: "demo",
            locale: "zh",
            default_locale: "en",
            available_locales: ["en", "zh"],
            display_name: "演示",
            short_description: "本地化描述",
            long_description: "",
            download_count: 0,
            rating_avg: 0,
            rating_count: 0,
            comment_count: 0,
            created_at: "",
            updated_at: "",
            latest_version: "1.0.0",
            logo_url: null,
            category: null,
          },
          {
            namespace: "bob",
            slug: "other",
            locale: "en",
            default_locale: "en",
            available_locales: ["en"],
            display_name: "Other",
            short_description: "",
            long_description: "",
            download_count: 0,
            rating_avg: 0,
            rating_count: 0,
            comment_count: 0,
            created_at: "",
            updated_at: "",
            latest_version: "1.0.0",
            logo_url: null,
            category: null,
          },
        ],
        total: 2,
        page: 1,
        per_page: 100,
      })
    }
    return new Response("not found", { status: 404 })
  }

  const result = await provideTestInstance({
    directory: project.path,
    fn: () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const auth = yield* Auth.Service
          yield* auth.set("wanlaicode", {
            type: "oauth",
            refresh: "r",
            access: "sk-runtime-key",
            softwareToken: ACCESS_TOKEN,
            expires: 9999999999,
          })
          const registry = yield* Registry.Service
          return yield* registry.myPlugins("zh")
        }).pipe(
          Effect.provide(Registry.layerWith({ fetchImpl })),
          Effect.provide(Layer.merge(Config.defaultLayer, Auth.defaultLayer)),
        ),
      ),
  })

  expect(result.user.namespace).toBe("alice")
  expect(result.plugins.map((plugin) => plugin.slug)).toEqual(["demo"])
  expect(result.plugins[0]?.display_name).toBe("演示")
  expect(result.plugins[0]?.short_description).toBe("本地化描述")
  expect(seen).toContain(`${REGISTRY_BASE}/api/v1/me`)
  expect(seen).toContain(`${REGISTRY_BASE}/api/v1/plugins?page=1&per_page=100&locale=zh`)
})

test("myPlugins: paginates before filtering current namespace", async () => {
  await using project = await tmpdir()

  const seen: string[] = []
  const plugin = (namespace: string, slug: string) => ({
    namespace,
    slug,
    locale: "en",
    default_locale: "en",
    available_locales: ["en"],
    display_name: slug,
    short_description: "",
    long_description: "",
    download_count: 0,
    rating_avg: 0,
    rating_count: 0,
    comment_count: 0,
    created_at: "",
    updated_at: "",
    latest_version: "1.0.0",
    logo_url: null,
    category: null,
  })
  const fetchImpl: FetchImpl = async (input) => {
    const url = String(input)
    seen.push(url)
    if (url === `${REGISTRY_BASE}/api/v1/me`) {
      return envelope({
        wanlai_uuid: "00000000-0000-0000-0000-000000000001",
        email: "user@example.com",
        username: "user",
        role: "user",
        status: "active",
        namespace: "alice",
        created_at: "",
        updated_at: "",
      })
    }
    if (url === `${REGISTRY_BASE}/api/v1/plugins?page=1&per_page=100`) {
      return envelope({ items: [plugin("bob", "page-one")], total: 2, page: 1, per_page: 1 })
    }
    if (url === `${REGISTRY_BASE}/api/v1/plugins?page=2&per_page=100`) {
      return envelope({ items: [plugin("alice", "page-two")], total: 2, page: 2, per_page: 1 })
    }
    return new Response("not found", { status: 404 })
  }

  const result = await provideTestInstance({
    directory: project.path,
    fn: () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const auth = yield* Auth.Service
          yield* auth.set("wanlaicode", {
            type: "oauth",
            refresh: "r",
            access: "sk-runtime-key",
            softwareToken: ACCESS_TOKEN,
            expires: 9999999999,
          })
          const registry = yield* Registry.Service
          return yield* registry.myPlugins()
        }).pipe(
          Effect.provide(Registry.layerWith({ fetchImpl })),
          Effect.provide(Layer.merge(Config.defaultLayer, Auth.defaultLayer)),
        ),
      ),
  })

  expect(result.plugins.map((item) => item.slug)).toEqual(["page-two"])
  expect(seen).toContain(`${REGISTRY_BASE}/api/v1/plugins?page=1&per_page=100`)
  expect(seen).toContain(`${REGISTRY_BASE}/api/v1/plugins?page=2&per_page=100`)
})

test("myPlugins: does not list plugins before namespace is registered", async () => {
  await using project = await tmpdir()

  const seen: string[] = []
  const fetchImpl: FetchImpl = async (input) => {
    const url = String(input)
    seen.push(url)
    if (url === `${REGISTRY_BASE}/api/v1/me`) {
      return envelope({
        wanlai_uuid: "00000000-0000-0000-0000-000000000001",
        email: "user@example.com",
        username: "user",
        role: "user",
        status: "active",
        namespace: null,
        created_at: "",
        updated_at: "",
      })
    }
    return new Response("not found", { status: 404 })
  }

  const result = await provideTestInstance({
    directory: project.path,
    fn: () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const auth = yield* Auth.Service
          yield* auth.set("wanlaicode", {
            type: "oauth",
            refresh: "r",
            access: "sk-runtime-key",
            softwareToken: ACCESS_TOKEN,
            expires: 9999999999,
          })
          const registry = yield* Registry.Service
          return yield* registry.myPlugins()
        }).pipe(
          Effect.provide(Registry.layerWith({ fetchImpl })),
          Effect.provide(Layer.merge(Config.defaultLayer, Auth.defaultLayer)),
        ),
      ),
  })

  expect(result.user.namespace).toBeNull()
  expect(result.plugins).toEqual([])
  expect(seen).toEqual([`${REGISTRY_BASE}/api/v1/me`])
})
