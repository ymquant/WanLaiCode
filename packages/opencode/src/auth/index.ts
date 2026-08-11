import path from "path"
import { Effect, Layer, Record, Result, Schema, Context } from "effect"
import { zod } from "@/util/effect-zod"
import { NonNegativeInt } from "@/util/schema"
import { Global } from "@opencode-ai/core/global"
import { env } from "@opencode-ai/core/flag/flag"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"

export const OAUTH_DUMMY_KEY = "opencode-oauth-dummy-key"
export const REMOTE_CONTROL_CREDENTIAL_PREFIX = "wanlaicode-remote-control"

// 远控设备令牌借用 0600 auth.json 持久化，但它不是可拉取 .well-known 配置的 provider URL。
export function isRemoteControlCredentialKey(key: string) {
  return key.startsWith(`${REMOTE_CONTROL_CREDENTIAL_PREFIX}:`)
}

const file = path.join(Global.Path.data, "auth.json")

const fail = (message: string) => (cause: unknown) => new AuthError({ message, cause })

export class Oauth extends Schema.Class<Oauth>("OAuth")({
  type: Schema.Literal("oauth"),
  refresh: Schema.String,
  access: Schema.String,
  // access 存推理用的 runtime key（sk-）；softwareToken 存 OAuth JWT，给插件市场等
  // “软件”后端做 Bearer（它们按 OAuth JWT 校验，不认 runtime key）。expires 是 JWT 的过期时间。
  softwareToken: Schema.optional(Schema.String),
  expires: NonNegativeInt,
  accountId: Schema.optional(Schema.String),
  accountEmail: Schema.optional(Schema.String),
  accountName: Schema.optional(Schema.String),
  enterpriseUrl: Schema.optional(Schema.String),
}) {}

export class Api extends Schema.Class<Api>("ApiAuth")({
  type: Schema.Literal("api"),
  key: Schema.String,
  accountEmail: Schema.optional(Schema.String),
  accountName: Schema.optional(Schema.String),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.String)),
}) {}

export class WellKnown extends Schema.Class<WellKnown>("WellKnownAuth")({
  type: Schema.Literal("wellknown"),
  key: Schema.String,
  token: Schema.String,
}) {}

const _Info = Schema.Union([Oauth, Api, WellKnown]).annotate({ discriminator: "type", identifier: "Auth" })
export const Info = Object.assign(_Info, { zod: zod(_Info) })
export type Info = Schema.Schema.Type<typeof _Info>

export class AuthError extends Schema.TaggedErrorClass<AuthError>()("AuthError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

export interface Interface {
  readonly get: (providerID: string) => Effect.Effect<Info | undefined, AuthError>
  readonly all: () => Effect.Effect<Record<string, Info>, AuthError>
  readonly set: (key: string, info: Info) => Effect.Effect<void, AuthError>
  readonly remove: (key: string) => Effect.Effect<void, AuthError>
  // 旧测试与插件 mock 可以暂不实现；正式 layer 始终提供锁内 CAS 修改能力。
  readonly modify?: (
    key: string,
    updater: (current: Info | undefined) => Info | undefined,
  ) => Effect.Effect<Info | undefined, AuthError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Auth") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fsys = yield* AppFileSystem.Service
    const flock = yield* EffectFlock.Service
    const decode = Schema.decodeUnknownOption(Info)

    const all = Effect.fn("Auth.all")(function* () {
      const authContent = env("AUTH_CONTENT")
      if (authContent) {
        try {
          return JSON.parse(authContent)
        } catch (err) {}
      }

      const data = (yield* fsys.readJson(file).pipe(Effect.orElseSucceed(() => ({})))) as Record<string, unknown>
      return Record.filterMap(data, (value) => Result.fromOption(decode(value), () => undefined))
    })

    const get = Effect.fn("Auth.get")(function* (providerID: string) {
      return (yield* all())[providerID]
    })

    // 所有认证写操作共用 auth.json 对应的跨进程文件锁，确保读、判断和写入不可被其他进程插入。
    const withAuthLock = <A>(body: Effect.Effect<A, AuthError>) =>
      flock.withLock(body, `auth:${file}`).pipe(
        Effect.mapError((cause) => {
          if (cause instanceof AuthError) return cause
          return fail("Failed to lock auth data")(cause)
        }),
      )

    // modify 在锁内重新读取最新凭据并执行 updater；undefined 表示 CAS 拒绝，文件保持原样。
    const modify = Effect.fn("Auth.modify")(function* (
      key: string,
      updater: (current: Info | undefined) => Info | undefined,
    ) {
      const norm = key.replace(/\/+$/, "")
      return yield* withAuthLock(
        Effect.gen(function* () {
          const data = yield* all()
          const next = updater(data[norm] ?? data[key] ?? data[norm + "/"])
          if (next === undefined) return undefined

          if (norm !== key) delete data[key]
          delete data[norm + "/"]
          yield* fsys
            .writeJson(file, { ...data, [norm]: next }, 0o600)
            .pipe(Effect.mapError(fail("Failed to write auth data")))
          return next
        }),
      )
    })

    // set 复用 modify，避免新增凭据与刷新凭据走不同锁或不同归一化规则。
    const set = Effect.fn("Auth.set")(function* (key: string, info: Info) {
      yield* modify(key, () => info)
    })

    const remove = Effect.fn("Auth.remove")(function* (key: string) {
      const norm = key.replace(/\/+$/, "")
      yield* withAuthLock(
        Effect.gen(function* () {
          const data = yield* all()
          delete data[key]
          delete data[norm]
          yield* fsys.writeJson(file, data, 0o600).pipe(Effect.mapError(fail("Failed to write auth data")))
        }),
      )
    })

    return Service.of({ get, all, set, remove, modify })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(EffectFlock.defaultLayer),
  Layer.provide(AppFileSystem.defaultLayer),
)

export * as Auth from "."
