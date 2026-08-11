import { Addon } from "@/addon"
import { Config } from "@/config/config"
import { ConfigMCP } from "@/config/mcp"
import { addonKey, type CodexMcpServerConfig, type LoadedAddon } from "@opencode-ai/addon"
import { Cause, Context, Effect, Layer, Schema } from "effect"
import { MCP } from "."

export const Pair = Schema.Struct({
  key: Schema.String,
  value: Schema.String,
}).annotate({ identifier: "McpManagementPair" })
export type Pair = Schema.Schema.Type<typeof Pair>

export const EnvPair = Schema.Struct({
  key: Schema.String,
  env: Schema.String,
}).annotate({ identifier: "McpManagementEnvPair" })
export type EnvPair = Schema.Schema.Type<typeof EnvPair>

export const LocalForm = Schema.Struct({
  type: Schema.Literal("local"),
  command: Schema.String,
  args: Schema.mutable(Schema.Array(Schema.String)),
  environment: Schema.mutable(Schema.Array(Pair)),
  inherited_environment: Schema.mutable(Schema.Array(Schema.String)),
  cwd: Schema.optional(Schema.String),
  timeout: Schema.optional(Schema.Number),
}).annotate({ identifier: "McpManagementLocalForm" })
export type LocalForm = Schema.Schema.Type<typeof LocalForm>

export const OAuthForm = Schema.Struct({
  enabled: Schema.Literal(true),
  client_id: Schema.optional(Schema.String),
  client_secret_env: Schema.optional(Schema.String),
  client_secret_configured: Schema.optional(Schema.Boolean),
  scope: Schema.optional(Schema.String),
  redirect_uri: Schema.optional(Schema.String),
}).annotate({ identifier: "McpManagementOAuthForm" })
export type OAuthForm = Schema.Schema.Type<typeof OAuthForm>

export const RemoteForm = Schema.Struct({
  type: Schema.Literal("remote"),
  url: Schema.String,
  bearer_token_env: Schema.optional(Schema.String),
  bearer_token_configured: Schema.optional(Schema.Boolean),
  headers: Schema.mutable(Schema.Array(Pair)),
  environment_headers: Schema.mutable(Schema.Array(EnvPair)),
  oauth: Schema.optional(Schema.Union([OAuthForm, Schema.Literal(false)])),
  timeout: Schema.optional(Schema.Number),
}).annotate({ identifier: "McpManagementRemoteForm" })
export type RemoteForm = Schema.Schema.Type<typeof RemoteForm>

export const Form = Schema.Union([LocalForm, RemoteForm]).annotate({
  identifier: "McpManagementForm",
  discriminator: "type",
})
export type Form = Schema.Schema.Type<typeof Form>

export const Item = Schema.Struct({
  name: Schema.String,
  source: Schema.Union([Schema.Literal("custom"), Schema.Literal("addon")]),
  addon_key: Schema.optional(Schema.String),
  addon_name: Schema.optional(Schema.String),
  type: Schema.Union([Schema.Literal("local"), Schema.Literal("remote")]),
  enabled: Schema.Boolean,
  editable: Schema.Boolean,
  status: MCP.Status,
  supports_oauth: Schema.Boolean,
}).annotate({ identifier: "McpManagementItem" })
export type Item = Schema.Schema.Type<typeof Item>

export const Detail = Schema.Struct({
  ...Item.fields,
  config: Form,
}).annotate({ identifier: "McpManagementDetail" })
export type Detail = Schema.Schema.Type<typeof Detail>

export const SaveInput = Schema.Struct({
  name: Schema.String,
  original_name: Schema.optional(Schema.String),
  config: Form,
}).annotate({ identifier: "McpManagementSaveInput" })
export type SaveInput = Schema.Schema.Type<typeof SaveInput>

export const ToggleInput = Schema.Struct({
  name: Schema.String,
  enabled: Schema.Boolean,
}).annotate({ identifier: "McpManagementToggleInput" })
export type ToggleInput = Schema.Schema.Type<typeof ToggleInput>

const envReference = /^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/
const bearerReference = /^Bearer \{env:([A-Za-z_][A-Za-z0-9_]*)\}$/

function reference(value: string) {
  return envReference.exec(value)?.[1]
}

function bearer(value: string) {
  return bearerReference.exec(value)?.[1]
}

function isAuthorization(key: string) {
  return key.trim().toLowerCase() === "authorization"
}

function compact<T extends Record<string, unknown>>(value: T) {
  return Object.fromEntries(Object.entries(value).filter((entry) => entry[1] !== undefined)) as T
}

function clean(value: string | undefined) {
  const result = value?.trim()
  return result ? result : undefined
}

function pairs(rows: Pair[]) {
  return rows
    .map((entry) => ({ key: entry.key.trim(), value: entry.value.trim() }))
    .filter((entry) => entry.key && entry.value)
}

function envPairs(rows: EnvPair[]) {
  return rows
    .map((entry) => ({ key: entry.key.trim(), env: entry.env.trim() }))
    .filter((entry) => entry.key && entry.env)
}

export function toForm(config: ConfigMCP.Info): Form {
  if (config.type === "local") {
    const environment = Object.entries(config.environment ?? {})
    return compact({
      type: "local" as const,
      command: config.command[0] ?? "",
      args: config.command.slice(1),
      environment: environment
        .filter((entry) => reference(entry[1]) === undefined)
        .map(([key, value]) => ({ key, value })),
      inherited_environment: environment.flatMap((entry) => {
        const env = reference(entry[1])
        return env ? [env] : []
      }),
      cwd: config.cwd,
      timeout: config.timeout,
    })
  }

  const headers = Object.entries(config.headers ?? {})
  const authorization = headers.find(([key]) => isAuthorization(key))?.[1]
  const oauth = typeof config.oauth === "object" ? config.oauth : undefined
  const oauthForm =
    config.oauth === false
      ? false
      : oauth && Object.values(oauth).some((value) => value !== undefined)
        ? compact({
            enabled: true as const,
            client_id: oauth.clientId,
            client_secret_env: oauth.clientSecret ? reference(oauth.clientSecret) : undefined,
            client_secret_configured:
              oauth.clientSecret && reference(oauth.clientSecret) === undefined ? true : undefined,
            scope: oauth.scope,
            redirect_uri: oauth.redirectUri,
          })
        : undefined
  return compact({
    type: "remote" as const,
    url: config.url,
    bearer_token_env: authorization ? bearer(authorization) : undefined,
    bearer_token_configured: authorization && bearer(authorization) === undefined ? true : undefined,
    headers: headers
      .filter(([key, value]) => !isAuthorization(key) && reference(value) === undefined)
      .map(([key, value]) => ({ key, value })),
    environment_headers: headers.flatMap(([key, value]) => {
      if (isAuthorization(key)) return []
      const env = reference(value)
      return env ? [{ key, env }] : []
    }),
    oauth: oauthForm,
    timeout: config.timeout,
  })
}

function legacyAuthorization(previous: ConfigMCP.Info | undefined) {
  if (previous?.type !== "remote") return
  const value = Object.entries(previous.headers ?? {}).find(([key]) => isAuthorization(key))?.[1]
  if (!value || bearer(value)) return
  return value
}

function legacyClientSecret(previous: ConfigMCP.Info | undefined) {
  if (previous?.type !== "remote" || typeof previous.oauth !== "object") return
  if (!previous.oauth.clientSecret || reference(previous.oauth.clientSecret)) return
  return previous.oauth.clientSecret
}

export function fromForm(form: Form, previous?: ConfigMCP.Info): ConfigMCP.Info {
  if (form.type === "local") {
    const environment = pairs(form.environment)
    const inherited = form.inherited_environment.map((env) => env.trim()).filter(Boolean)
    return compact({
      type: "local" as const,
      command: [form.command.trim(), ...form.args.map((arg) => arg.trim()).filter(Boolean)],
      environment: Object.fromEntries([
        ...environment.map((entry) => [entry.key, entry.value]),
        ...inherited.map((env) => [env, `{env:${env}}`]),
      ]),
      cwd: clean(form.cwd),
      enabled: previous?.enabled,
      timeout: form.timeout,
    })
  }

  const headers = pairs(form.headers).filter((entry) => !isAuthorization(entry.key))
  const environmentHeaders = envPairs(form.environment_headers).filter((entry) => !isAuthorization(entry.key))
  const oauthDisabled = form.oauth === false
  const oauth = typeof form.oauth === "object" ? form.oauth : undefined
  const authorization = clean(form.bearer_token_env)
    ? `Bearer {env:${clean(form.bearer_token_env)}}`
    : form.bearer_token_configured
      ? legacyAuthorization(previous)
      : undefined
  const clientSecret = clean(oauth?.client_secret_env)
    ? `{env:${clean(oauth?.client_secret_env)}}`
    : oauth?.client_secret_configured
      ? legacyClientSecret(previous)
      : undefined
  const oauthConfig = oauthDisabled
    ? false
    : oauth
      ? compact({
          clientId: clean(oauth.client_id),
          clientSecret,
          scope: clean(oauth.scope),
          redirectUri: clean(oauth.redirect_uri),
        })
      : undefined
  return compact({
    type: "remote" as const,
    url: form.url.trim(),
    headers: Object.fromEntries([
      ...headers.map((entry) => [entry.key, entry.value]),
      ...environmentHeaders.map((entry) => [entry.key, `{env:${entry.env}}`]),
      ...(authorization ? [["Authorization", authorization]] : []),
    ]),
    oauth: oauthConfig === false || (oauthConfig && Object.keys(oauthConfig).length) ? oauthConfig : undefined,
    enabled: previous?.enabled,
    timeout: form.timeout,
  })
}

const validName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const validEnv = /^[A-Za-z_][A-Za-z0-9_]*$/

function httpUrl(value: string) {
  if (!URL.canParse(value)) return false
  return ["http:", "https:"].includes(new URL(value).protocol)
}

function incomplete(rows: Array<Pair | EnvPair>) {
  return rows.some((row) => {
    const value = ("value" in row ? row.value : row.env).trim()
    return Boolean(row.key.trim()) !== Boolean(value.trim())
  })
}

function duplicate(values: string[]) {
  const keys = values.filter((value) => value.trim()).map((value) => value.toLowerCase())
  return new Set(keys).size !== keys.length
}

function invalidTimeout(timeout: number | undefined) {
  return timeout !== undefined && (!Number.isInteger(timeout) || timeout <= 0)
}

export function validateName(name: string): string | undefined {
  if (!name.trim()) return "name_required"
  if (!validName.test(name.trim())) return "name_invalid"
}

export function validateForm(form: Form): string | undefined {
  if (invalidTimeout(form.timeout)) return "timeout_invalid"

  if (form.type === "local") {
    if (!form.command.trim()) return "command_required"
    if (incomplete(form.environment)) return "row_incomplete"
    if (
      form.environment.some((entry) => entry.key.trim() !== "" && !validEnv.test(entry.key.trim())) ||
      form.inherited_environment.some((env) => env.trim() !== "" && !validEnv.test(env.trim()))
    ) {
      return "env_invalid"
    }
    if (
      duplicate([...form.environment.map((entry) => entry.key), ...form.inherited_environment.map((env) => env.trim())])
    ) {
      return "key_duplicate"
    }
    return
  }

  if (!httpUrl(form.url.trim())) return "url_invalid"
  if (incomplete([...form.headers, ...form.environment_headers])) return "row_incomplete"
  if (
    [
      form.bearer_token_env,
      typeof form.oauth === "object" ? form.oauth.client_secret_env : undefined,
      ...form.environment_headers.map((entry) => entry.env),
    ]
      .filter((env): env is string => env !== undefined)
      .some((env) => env.trim() !== "" && !validEnv.test(env.trim()))
  ) {
    return "env_invalid"
  }

  const headerKeys = [...form.headers.map((entry) => entry.key), ...form.environment_headers.map((entry) => entry.key)]
  if (headerKeys.some(isAuthorization)) return "authorization_conflict"
  if (duplicate(headerKeys)) return "key_duplicate"
  if (typeof form.oauth === "object" && form.oauth.redirect_uri && !httpUrl(form.oauth.redirect_uri.trim())) {
    return "redirect_uri_invalid"
  }
}

export class ManagementError extends Schema.TaggedErrorClass<ManagementError>()("McpManagementError", {
  code: Schema.String,
}) {}

export interface Interface {
  readonly list: () => Effect.Effect<Item[]>
  readonly get: (name: string) => Effect.Effect<Detail, ManagementError>
  readonly save: (input: SaveInput) => Effect.Effect<Detail, ManagementError>
  readonly remove: (name: string) => Effect.Effect<void, ManagementError>
  readonly toggle: (name: string, enabled: boolean) => Effect.Effect<void, ManagementError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/McpManagement") {}

function isConfigured(value: NonNullable<Config.Info["mcp"]>[string]): value is ConfigMCP.Info {
  return "type" in value
}

function editableConfig(config: ConfigMCP.Info) {
  if (config.type !== "local") return true
  return Object.entries(config.environment ?? {}).every(([key, value]) => {
    const env = reference(value)
    return env === undefined || env === key
  })
}

function addonForm(config: ConfigMCP.Info, declaration?: CodexMcpServerConfig): Form {
  if (config.type === "local") {
    if (!declaration?.command) {
      return compact({
        type: "local" as const,
        command: config.command[0] ?? "",
        args: config.command.slice(1),
        environment: [],
        inherited_environment: [],
        cwd: config.cwd,
        timeout: config.timeout,
      })
    }
    const environment = Object.entries(declaration.env ?? {})
    return compact({
      type: "local" as const,
      command: declaration.command,
      args: declaration.args ?? [],
      environment: environment
        .filter((entry) => reference(entry[1]) === undefined)
        .map(([key, value]) => ({ key, value })),
      inherited_environment: environment.flatMap(([key, value]) => (reference(value) === key ? [key] : [])),
      cwd: declaration.cwd,
      timeout: declaration.tool_timeout_sec === undefined ? undefined : declaration.tool_timeout_sec * 1000,
    })
  }

  if (!declaration?.url) {
    return compact({
      type: "remote" as const,
      url: config.url,
      headers: [],
      environment_headers: [],
      oauth: config.oauth === false ? false : undefined,
      timeout: config.timeout,
    })
  }

  const headers = Object.entries(declaration.http_headers ?? {})
  const environmentHeaders = Object.entries(declaration.env_http_headers ?? {})
  const authorization = headers.find(([key]) => isAuthorization(key))?.[1]
  const authorizationEnv = environmentHeaders.find(([key]) => isAuthorization(key))?.[1]
  return compact({
    type: "remote" as const,
    url: declaration.url,
    bearer_token_env:
      declaration.bearer_token_env_var ?? authorizationEnv ?? (authorization ? bearer(authorization) : undefined),
    bearer_token_configured:
      authorization && bearer(authorization) === undefined && !declaration.bearer_token_env_var && !authorizationEnv
        ? true
        : undefined,
    headers: headers.filter(([key]) => !isAuthorization(key)).map(([key, value]) => ({ key, value })),
    environment_headers: environmentHeaders
      .filter(([key]) => !isAuthorization(key))
      .map(([key, env]) => ({ key, env })),
    timeout: declaration.tool_timeout_sec === undefined ? undefined : declaration.tool_timeout_sec * 1000,
  })
}

function addonOwners(addons: LoadedAddon[]) {
  return addons
    .filter((addon) => !addon.disabled)
    .flatMap((addon) =>
      Object.entries(addon.mcpServers ?? {}).map(
        ([name, config]) =>
          [
            name,
            {
              addon,
              config: config as ConfigMCP.Info,
              declaration: addon.mcpServerDeclarations?.[name],
            },
          ] as const,
      ),
    )
    .reduce(
      (result, [name, owner]) => result.set(name, owner),
      new Map<string, { addon: LoadedAddon; config: ConfigMCP.Info; declaration?: CodexMcpServerConfig }>(),
    )
}

type Owner = ReturnType<typeof addonOwners> extends Map<string, infer A> ? A : never

function item(name: string, config: ConfigMCP.Info, status: Record<string, MCP.Status>, owner?: LoadedAddon): Item {
  const enabled = config.enabled !== false
  return {
    name,
    source: owner ? "addon" : "custom",
    addon_key: owner ? addonKey(owner.addonId) : undefined,
    addon_name: owner ? (owner.manifest.interfaceInfo?.displayName ?? owner.manifest.name) : undefined,
    type: config.type,
    enabled,
    editable: !owner && editableConfig(config),
    status: enabled ? (status[name] ?? { status: "connecting" }) : { status: "disabled" },
    supports_oauth: config.type === "remote" && config.oauth !== false,
  }
}

function writeError() {
  return new ManagementError({ code: "write_failed" })
}

function writeBoundary<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return effect.pipe(
    Effect.mapError(writeError),
    Effect.catchCause((cause) => (Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.fail(writeError()))),
  )
}

function resolveEntry(
  custom: NonNullable<Config.Info["mcp"]>,
  owners: Map<string, Owner>,
  status: Record<string, MCP.Status>,
  name: string,
) {
  const configured = custom[name]
  if (configured && isConfigured(configured)) {
    return { item: item(name, configured, status), config: configured }
  }
  const owner = owners.get(name)
  if (Object.hasOwn(custom, name)) {
    if (!owner || configured?.enabled !== false) return
    const overridden = { ...owner.config, enabled: false }
    return {
      item: item(name, overridden, status, owner.addon),
      config: overridden,
      owner: owner.addon,
      declaration: owner.declaration,
      legacyOverride: true,
    }
  }
  if (!owner) return
  return {
    item: item(name, owner.config, status, owner.addon),
    config: owner.config,
    owner: owner.addon,
    declaration: owner.declaration,
  }
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const addons = yield* Addon.Service
    const mcp = yield* MCP.Service

    const snapshot = Effect.fnUntraced(function* () {
      const [custom, loaded, status] = yield* Effect.all([config.getGlobalMcpRaw(), addons.getAddons(), mcp.status()])
      return { custom, owners: addonOwners(loaded), status }
    })

    const resolve = Effect.fnUntraced(function* (name: string) {
      const state = yield* snapshot()
      return resolveEntry(state.custom, state.owners, state.status, name)
    })

    const list = Effect.fn("McpManagement.list")(function* () {
      const state = yield* snapshot()
      return [
        ...Object.entries(state.custom).flatMap(([name, value]) =>
          isConfigured(value) ? [item(name, value, state.status)] : [],
        ),
        ...Array.from(state.owners.entries()).flatMap(([name, owner]) =>
          Object.hasOwn(state.custom, name)
            ? state.custom[name]?.enabled === false
              ? [item(name, { ...owner.config, enabled: false }, state.status, owner.addon)]
              : []
            : [item(name, owner.config, state.status, owner.addon)],
        ),
      ]
    })

    const get = Effect.fn("McpManagement.get")(function* (name: string) {
      const entry = yield* resolve(name)
      if (!entry) return yield* new ManagementError({ code: "not_found" })
      return {
        ...entry.item,
        config: entry.owner ? addonForm(entry.config, entry.declaration) : toForm(entry.config),
      }
    })

    const save = Effect.fn("McpManagement.save")(function* (input: SaveInput) {
      const name = input.name.trim()
      const nameError = validateName(name)
      if (nameError) return yield* new ManagementError({ code: nameError })
      const formError = validateForm(input.config)
      if (formError) return yield* new ManagementError({ code: formError })

      const [loaded, status] = yield* Effect.all([addons.getAddons(), mcp.status()])
      const owners = addonOwners(loaded)
      const decision = yield* writeBoundary(
        config.updateGlobalMcp((custom) => {
          const original = input.original_name
            ? resolveEntry(custom, owners, status, input.original_name)
            : undefined
          if (input.original_name && !original) return { result: "not_found" as const }
          if (original && !original.item.editable) return { result: "read_only" as const }
          if (name !== input.original_name && (Object.hasOwn(custom, name) || owners.has(name))) {
            return { result: "conflict" as const }
          }
          return {
            patch: {
              ...(input.original_name && input.original_name !== name ? { [input.original_name]: undefined } : {}),
              [name]: fromForm(input.config, original?.config),
            } as NonNullable<Config.Info["mcp"]>,
            result: "saved" as const,
          }
        }),
      )
      if (decision.result !== "saved") return yield* new ManagementError({ code: decision.result })
      yield* mcp.reconcile(
        Array.from(new Set([input.original_name, name].filter((entry): entry is string => entry !== undefined))),
      )
      return yield* get(name)
    })

    const remove = Effect.fn("McpManagement.remove")(function* (name: string) {
      const entry = yield* resolve(name)
      if (!entry) return yield* new ManagementError({ code: "not_found" })
      if (entry.owner) return yield* new ManagementError({ code: "read_only" })
      yield* writeBoundary(config.updateGlobal({ mcp: { [name]: undefined } } as unknown as Config.Info))
      yield* mcp.reconcile()
    })

    const toggle = Effect.fn("McpManagement.toggle")(function* (name: string, enabled: boolean) {
      const entry = yield* resolve(name)
      if (!entry) return yield* new ManagementError({ code: "not_found" })
      if (entry.owner) {
        yield* writeBoundary(
          addons.setMcpEnabled(
            addonKey(entry.owner.addonId),
            name,
            enabled,
            entry.legacyOverride && enabled ? { removeGlobalMcp: true } : undefined,
          ),
        )
        yield* mcp.reconcile()
        return
      }
      const decision = yield* writeBoundary(
        config.updateGlobalMcp((custom) => {
          const current = custom[name]
          if (!Object.hasOwn(custom, name) || !current || !isConfigured(current)) {
            return { result: "not_found" as const }
          }
          return {
            patch: {
              [name]: {
                ...current,
                enabled,
              },
            },
            result: "updated" as const,
          }
        }),
      )
      if (decision.result !== "updated") return yield* new ManagementError({ code: decision.result })
      yield* mcp.reconcile()
    })

    return Service.of({ list, get, save, remove, toggle })
  }),
)

export * as McpManagement from "./management"
