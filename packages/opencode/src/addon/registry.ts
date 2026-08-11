import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises"
import { createHash } from "crypto"
import { tmpdir } from "os"
import path from "path"
import * as tar from "tar"
import { Context, Effect, Layer } from "effect"
import * as AddonLoader from "@opencode-ai/addon"
import {
  createRegistryClient,
  RegistryError,
  type FetchImpl,
  type ListPluginsParams,
  type RegistryClient,
} from "@opencode-ai/addon"
import { Flock } from "@opencode-ai/core/util/flock"
import * as Log from "@opencode-ai/core/util/log"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { isNoEntitlementRuntimeError, isOAuthExpiredError, resolveConfig } from "@/provider/wanlaicode"
import { WanlaiCodeRefreshCoordinator } from "@/provider/wanlaicode-refresh-coordinator"
import { addonsCacheRoot, addonsStagingRoot } from "@/addon/paths"

// Fixed marketplace name for everything installed from the WanLaiCode registry.
// The loader scans cache paths and tags discovered addons with their
// path-derived identity. `addonsCacheRoot()` is always in `defaultAddonPaths(cfg)`,
// so installing into `cache/wanlaicode/<namespace>/<slug>/<version>` and enabling
// `config.plugins["<slug>@wanlaicode/<namespace>"]` is enough for
// `Addon.getAddons()` to load it. No `config.marketplaces` entry is required.
const MARKETPLACE_NAME = "wanlaicode"
const log = Log.create({ service: "registry" })

export interface InstallInput {
  namespace: string
  slug: string
  version?: string
}

export interface InstallResult {
  key: string
  version: string
  installedPath: string
}

export interface PublishLocalPluginInput {
  root: string
  name: string
  version?: string
}

type ClientReturn<K extends keyof RegistryClient> = RegistryClient[K] extends (...args: never[]) => Promise<infer R>
  ? R
  : never

export interface Interface {
  readonly listPlugins: (params: ListPluginsParams) => Effect.Effect<ClientReturn<"listPlugins">, Error>
  readonly getPlugin: (ns: string, slug: string, locale?: string) => Effect.Effect<ClientReturn<"getPlugin">, Error>
  readonly deletePlugin: (ns: string, slug: string) => Effect.Effect<void, Error>
  readonly install: (input: InstallInput) => Effect.Effect<InstallResult, Error>
  readonly me: () => Effect.Effect<ClientReturn<"me">, Error>
  readonly createNamespace: (name: string) => Effect.Effect<ClientReturn<"createNamespace">, Error>
  readonly myPlugins: (locale?: string) => Effect.Effect<{ user: ClientReturn<"me">; plugins: ClientReturn<"listPlugins">["items"] }, Error>
  readonly listComments: (ns: string, slug: string, page?: number) => Effect.Effect<ClientReturn<"listComments">, Error>
  readonly postComment: (ns: string, slug: string, content: string) => Effect.Effect<ClientReturn<"postComment">, Error>
  readonly deleteComment: (ns: string, slug: string, publicId: string) => Effect.Effect<void, Error>
  readonly getMyRating: (ns: string, slug: string) => Effect.Effect<ClientReturn<"getMyRating">, Error>
  readonly putRating: (ns: string, slug: string, value: number) => Effect.Effect<ClientReturn<"putRating">, Error>
  readonly deleteRating: (ns: string, slug: string) => Effect.Effect<void, Error>
  readonly publishLocalPlugin: (input: PublishLocalPluginInput) => Effect.Effect<unknown, Error>
  readonly deleteVersion: (ns: string, slug: string, version: string) => Effect.Effect<void, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Registry") {}

const asError = (e: unknown) => (e instanceof Error ? e : new Error(String(e)))

// 后端返回的 logo_url 是相对 registry 的路径（如 /api/v1/plugins/<ns>/<slug>/logo）。
// 前端把它当 <img src> 用时会相对 app 自身 origin 解析 → 落到本地 404。这里在 server 端
// 绝对化到 registry base（app 不需要、也不应知道后端地址）；该端点的 302 预签名跳转浏览器会自动跟随。
function absolutizeLogo<T extends { logo_url: string | null }>(base: string, plugin: T): T {
  if (!plugin.logo_url || /^https?:\/\//i.test(plugin.logo_url)) return plugin
  return { ...plugin, logo_url: `${base}${plugin.logo_url}` }
}

// AddonLoader patches use `undefined` to signal deletion of a plugins entry,
// which Config.Info's strict shape doesn't model. updateGlobal honors
// undefined-as-delete on both paths, so we relax the type once here. Mirrors
// `addon/index.ts:toConfigPatch`.
function toConfigPatch(patch: { plugins?: Record<string, unknown> | undefined }): Config.Info {
  return patch as unknown as Config.Info
}

async function normalizePublishManifest(root: string) {
  const manifestPath = AddonLoader.findManifestPath(root)
  if (!manifestPath) return
  const raw = JSON.parse(await readFile(manifestPath, "utf-8")) as unknown
  if (!raw || typeof raw !== "object") return
  const manifest = raw as { interface?: unknown }
  if (!manifest.interface || typeof manifest.interface !== "object") return
  const info = manifest.interface as { defaultPrompt?: unknown }
  if (typeof info.defaultPrompt !== "string") return
  info.defaultPrompt = [info.defaultPrompt]
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2))
}

export interface MakeOptions {
  // Inject the underlying fetch (used for both registry metadata calls and the
  // tar download) — defaults to global fetch. Primarily a test seam.
  fetchImpl?: FetchImpl
}

export const make = (options: MakeOptions = {}) =>
  Effect.gen(function* () {
    const authSvc = yield* Auth.Service
    const cfgSvc = yield* Config.Service
    const fetchImpl = options.fetchImpl

    // 插件后端按 OAuth JWT 校验，用 softwareToken（不是 access=runtime key）。expires 是 JWT 过期。
    const now = () => Math.floor(Date.now() / 1000)
    const validSoftwareToken = (info: { softwareToken?: string; expires: number }) =>
      info.softwareToken && info.expires > now() + 30 ? info.softwareToken : undefined

    // refresh 失效 = 会话过期：写操作据此抛 401，前端提示重新登录。
    const sessionExpired = () => new RegistryError("登录已过期，请重新登录", 401, 401)

    // 当前有效 token（不触发刷新）——匿名读 / 下载的尽力而为鉴权。
    const currentToken = Effect.fn("Registry.currentToken")(function* () {
      const info = yield* authSvc.get("wanlaicode").pipe(Effect.orElseSucceed(() => undefined))
      return info && info.type === "oauth" ? validSoftwareToken(info) : undefined
    })

    // 确保拿到 JWT：有效直接用；否则走协调器共享刷新换新（轮换 refresh、刷新 runtime key、回存 softwareToken）。
    // required=true 时若拿不到：refresh 失效或无套餐 → 抛"请重新登录"(401)；其它失败 → 抛可重试错误(400)。
    // required=false 时刷新失败静默返回 undefined，仅供 install 匿名降级（公共插件仍可下载）。
    const ensureToken = (required: boolean) =>
      Effect.gen(function* () {
        const info = yield* authSvc.get("wanlaicode").pipe(Effect.orElseSucceed(() => undefined))
        if (!info || info.type !== "oauth") {
          yield* Effect.sync(() =>
            log.warn("plugin registry auth unavailable", {
              required,
              hasInfo: !!info,
              type: info?.type,
            }),
          )
          return required ? yield* Effect.fail(sessionExpired()) : undefined
        }
        const valid = validSoftwareToken(info)
        if (valid) {
          yield* Effect.sync(() =>
            log.warn("plugin registry auth token ready", {
              required,
              source: "cached",
              expiresIn: info.expires - now(),
              hasRefresh: !!info.refresh,
            }),
          )
          return valid
        }
        if (!info.refresh) {
          yield* Effect.sync(() =>
            log.warn("plugin registry auth refresh unavailable", {
              required,
              hasSoftwareToken: !!info.softwareToken,
              expiresIn: info.expires - now(),
            }),
          )
          return required ? yield* Effect.fail(sessionExpired()) : undefined
        }
        yield* Effect.sync(() =>
          log.warn("plugin registry auth token refreshing", {
            required,
            hasSoftwareToken: !!info.softwareToken,
            expiresIn: info.expires - now(),
          }),
        )
        const refreshedToken = yield* Effect.tryPromise({
          try: () => WanlaiCodeRefreshCoordinator.refresh({ reason: "addon-registry" }),
          catch: (cause) => cause,
        }).pipe(
          Effect.map((r) => r.softwareToken as string | undefined),
          Effect.catch((cause) => {
            log.warn("plugin registry auth token refresh failed", {
              required,
              expired: isOAuthExpiredError(cause),
            })
            if (!required) return Effect.succeed(undefined)
            if (isOAuthExpiredError(cause)) return Effect.fail(sessionExpired())
            if (isNoEntitlementRuntimeError(cause)) return Effect.succeed(undefined)
            return Effect.fail(new RegistryError("刷新登录状态失败，请稍后重试", 0, 400))
          }),
        )
        if (refreshedToken) {
          yield* Effect.sync(() => log.warn("plugin registry auth token ready", { required, source: "refresh" }))
          return refreshedToken
        }
        yield* Effect.sync(() => log.warn("plugin registry auth token refresh returned no software token", { required }))
        return required ? yield* Effect.fail(sessionExpired()) : undefined
      })

    const refreshTokenForRetry = Effect.fn("Registry.refreshTokenForRetry")(function* () {
      const info = yield* authSvc.get("wanlaicode").pipe(Effect.orElseSucceed(() => undefined))
      if (!info || info.type !== "oauth" || !info.refresh) return yield* Effect.fail(sessionExpired())
      yield* Effect.sync(() => log.warn("plugin registry token refresh for retry"))
      const refreshedToken = yield* Effect.tryPromise({
        try: () => WanlaiCodeRefreshCoordinator.refresh({ reason: "addon-registry-retry" }),
        catch: (cause) => cause,
      }).pipe(
        Effect.map((r) => r.softwareToken as string | undefined),
        Effect.catch((cause) => {
          if (isOAuthExpiredError(cause)) return Effect.fail(sessionExpired())
          return Effect.fail(new RegistryError("刷新登录状态失败，请稍后重试", 0, 400))
        }),
      )
      if (refreshedToken) return refreshedToken
      return yield* Effect.fail(sessionExpired())
    })

    const withAuthRetry = <A>(operation: (client: RegistryClient) => Promise<A>) =>
      Effect.gen(function* () {
        const token = yield* ensureToken(true)
        return yield* Effect.tryPromise({
          try: () => operation(clientWith(token)),
          catch: asError,
        }).pipe(
          Effect.catch((error: Error) => {
            if (!(error instanceof RegistryError) || error.status !== 401) return Effect.fail(error)
            log.warn("plugin registry request unauthorized, refreshing token and retrying", {
              status: error.status,
              code: error.code,
            })
            return Effect.gen(function* () {
              const refreshedToken = yield* refreshTokenForRetry()
              return yield* Effect.tryPromise({
                try: () => operation(clientWith(refreshedToken)),
                catch: asError,
              })
            })
          }),
        )
      })

    const clientWith = (token: string | undefined) =>
      createRegistryClient({ baseUrl: resolveConfig().endpoints.pluginRegistry, token, fetchImpl })

    const listPlugins = Effect.fn("Registry.listPlugins")(function* (params: ListPluginsParams) {
      const client = clientWith(yield* currentToken())
      const base = resolveConfig().endpoints.pluginRegistry
      const page = yield* Effect.tryPromise({ try: () => client.listPlugins(params), catch: asError })
      return { ...page, items: page.items.map((p) => absolutizeLogo(base, p)) }
    })

    const getPlugin = Effect.fn("Registry.getPlugin")(function* (ns: string, slug: string, locale?: string) {
      const client = clientWith(yield* currentToken())
      const base = resolveConfig().endpoints.pluginRegistry
      const detail = yield* Effect.tryPromise({ try: () => client.getPlugin(ns, slug, { locale }), catch: asError })
      return absolutizeLogo(base, detail)
    })

    const deletePlugin = Effect.fn("Registry.deletePlugin")(function* (ns: string, slug: string) {
      yield* withAuthRetry((client) => client.deletePlugin(ns, slug))
    })

    // 需要用户身份的读写操作统一在 401 后刷新 token 并重试一次。
    const me = Effect.fn("Registry.me")(function* () {
      return yield* withAuthRetry((client) => client.me())
    })

    const createNamespace = Effect.fn("Registry.createNamespace")(function* (name: string) {
      return yield* withAuthRetry((client) => client.createNamespace(name))
    })

    const myPlugins = Effect.fn("Registry.myPlugins")(function* (locale?: string) {
      const user = yield* withAuthRetry((client) => client.me())
      if (!user.namespace) return { user, plugins: [] }
      const client = clientWith(yield* currentToken())
      const base = resolveConfig().endpoints.pluginRegistry
      const params = (page: number) => ({ page, per_page: 100, locale })
      const first = yield* Effect.tryPromise({ try: () => client.listPlugins(params(1)), catch: asError })
      const totalPages = Math.max(1, Math.ceil(first.total / first.per_page))
      const rest = yield* Effect.all(
        Array.from({ length: totalPages - 1 }, (_, index) =>
          Effect.tryPromise({ try: () => client.listPlugins(params(index + 2)), catch: asError }),
        ),
      )
      return {
        user,
        plugins: [first, ...rest]
          .flatMap((page) => page.items)
          .filter((plugin) => plugin.namespace === user.namespace)
          .map((plugin) => absolutizeLogo(base, plugin)),
      }
    })

    const listComments = Effect.fn("Registry.listComments")(function* (ns: string, slug: string, page?: number) {
      const client = clientWith(yield* currentToken())
      return yield* Effect.tryPromise({ try: () => client.listComments(ns, slug, { page }), catch: asError })
    })

    // 写操作：鉴权必需——会话过期时抛"请重新登录"(401)。
    const postComment = Effect.fn("Registry.postComment")(function* (ns: string, slug: string, content: string) {
      return yield* withAuthRetry((client) => client.postComment(ns, slug, content))
    })

    const deleteComment = Effect.fn("Registry.deleteComment")(function* (ns: string, slug: string, publicId: string) {
      yield* withAuthRetry((client) => client.deleteComment(ns, slug, publicId))
    })

    const getMyRating = Effect.fn("Registry.getMyRating")(function* (ns: string, slug: string) {
      return yield* withAuthRetry((client) => client.getMyRating(ns, slug))
    })

    const putRating = Effect.fn("Registry.putRating")(function* (ns: string, slug: string, value: number) {
      return yield* withAuthRetry((client) => client.putRating(ns, slug, value))
    })

    const deleteRating = Effect.fn("Registry.deleteRating")(function* (ns: string, slug: string) {
      yield* withAuthRetry((client) => client.deleteRating(ns, slug))
    })

    const deleteVersion = Effect.fn("Registry.deleteVersion")(function* (ns: string, slug: string, version: string) {
      yield* withAuthRetry((client) => client.deleteVersion(ns, slug, version))
    })

    const publishLocalPlugin = Effect.fn("Registry.publishLocalPlugin")(function* (input: PublishLocalPluginInput) {
      const version = input.version || "local"
      return yield* withAuthRetry(async (client) => {
        const baseUrl = resolveConfig().endpoints.pluginRegistry
        const user = await client.me()
        if (!user.namespace) throw new RegistryError("请先注册插件发布命名空间", 409, 409)
        const dir = await mkdtemp(path.join(tmpdir(), "wanlaicode-plugin-publish-"))
        const packageRoot = path.join(dir, "package-root")
        const filename = `${input.name}-${version}.tgz`
        const file = path.join(dir, filename)
        try {
          log.warn("plugin registry upload preparing", {
            baseUrl,
            root: input.root,
            name: input.name,
            version,
            filename,
          })
          await cp(input.root, packageRoot, { recursive: true })
          await normalizePublishManifest(packageRoot)
          await tar.c({ gzip: true, cwd: packageRoot, file, portable: true, prefix: "package" }, ["."])
          const bytes = await readFile(file)
          log.warn("plugin registry upload request sending", {
            baseUrl,
            filename,
            sizeBytes: bytes.byteLength,
          })
          const body = new ArrayBuffer(bytes.byteLength)
          new Uint8Array(body).set(bytes)
          const result = await client.publishPlugin({
            namespace: user.namespace,
            slug: input.name,
            file: new Blob([body]),
            filename,
          })
          log.warn("plugin registry upload request completed", { baseUrl, filename })
          return result
        } finally {
          await rm(dir, { recursive: true, force: true })
        }
      })
    })

    const install = Effect.fn("Registry.install")(function* (input: InstallInput) {
      // 用 ensureToken(false) 而非 currentToken()：老用户的旧会话无 softwareToken 时会尝试用
      // refresh 换新（私有/鉴权插件的下载需要 Bearer）；刷新失败则静默降级为匿名（公共插件仍可装）。
      const token = yield* ensureToken(false)
      const client = clientWith(token)

      const version =
        input.version ??
        (yield* Effect.tryPromise({ try: () => client.getPlugin(input.namespace, input.slug), catch: asError }))
          .latest_version
      if (!version)
        return yield* Effect.fail(new Error(`plugin ${input.namespace}/${input.slug} has no published version`))

      const downloadUrl = client.resolveDownloadUrl(input.namespace, input.slug, version)
      const cacheRoot = addonsCacheRoot()
      const stagingRoot = addonsStagingRoot()
      const addonId = { addonName: input.slug, marketplaceName: MARKETPLACE_NAME, registryNamespace: input.namespace }
      // installAddonToCache 要求压缩包内 .codex-plugin/plugin.json 的 name 字段与 slug 一致。
      // 注册表包在发布时由后端强制 slug === manifest.name（已通过 hello ⇄ hello 在线验证）。
      const lockKey = `addon-install-${createHash("sha1").update(AddonLoader.addonKey(addonId)).digest("hex")}`

      // Private packages / download counters require the Bearer token on the
      // download too, so inject an Authorization header into the installer's fetch.
      const downloadFetch: FetchImpl = (u, init) => {
        const headers = new Headers(init?.headers)
        if (token) headers.set("authorization", `Bearer ${token}`)
        const base = fetchImpl ?? fetch
        return base(u, { ...init, headers })
      }

      const result = yield* Effect.tryPromise({
        try: () =>
          Flock.withLock(lockKey, async () => {
            await mkdir(stagingRoot, { recursive: true })
            await mkdir(cacheRoot, { recursive: true })
            const materialized = await AddonLoader.materializeAddonSource({
              source: { type: "remote-tar", url: downloadUrl },
              stagingRoot,
              fetchImpl: downloadFetch,
            })
            try {
              return await AddonLoader.installAddonToCache({ sourcePath: materialized.path, addonId, cacheRoot })
            } finally {
              await materialized.cleanup()
            }
          }),
        catch: asError,
      })

      yield* cfgSvc.updateGlobal(toConfigPatch(AddonLoader.setAddonEnabled(addonId, true)))

      return {
        key: AddonLoader.addonKey(addonId),
        version: result.version,
        installedPath: result.installedPath,
      }
    })

    return Service.of({
      listPlugins,
      getPlugin,
      deletePlugin,
      install,
      me,
      createNamespace,
      myPlugins,
      listComments,
      postComment,
      deleteComment,
      getMyRating,
      putRating,
      deleteRating,
      deleteVersion,
      publishLocalPlugin,
    })
  })

export const layerWith = (options: MakeOptions) => Layer.effect(Service, make(options))

export const layer = layerWith({})

export const defaultLayer = layer.pipe(Layer.provide(Layer.merge(Auth.defaultLayer, Config.defaultLayer)))

export * as Registry from "."
