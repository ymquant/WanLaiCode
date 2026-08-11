import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import { ModelsDev } from "@/provider/models"
import { ProviderAuth } from "@/provider/auth"
import { WanlaiCodeAuth } from "@/provider/wanlaicode"
import { ProviderID } from "@/provider/schema"
import { RemoteControlGateway } from "@/remote-control/gateway"
import { errors } from "../../error"
import { lazy } from "@/util/lazy"
import { Effect } from "effect"
import { jsonRequest } from "./trace"
import { providerListResult } from "./provider-list"

const QueryBoolean = z.union([
  z.preprocess((value) => (value === "true" ? true : value === "false" ? false : value), z.boolean()),
  z.enum(["true", "false"]),
])

function queryBoolean(value: z.infer<typeof QueryBoolean> | undefined) {
  if (value === undefined) return
  return value === true || value === "true"
}

export const ProviderRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "List providers",
        description: "Get a list of all available AI providers, including both available and connected ones.",
        operationId: "provider.list",
        responses: {
          200: {
            description: "List of providers",
            content: {
              "application/json": {
                schema: resolver(Provider.ListResult.zod),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          refresh: QueryBoolean.optional().meta({
            description: "Force refresh model registry before listing providers",
          }),
        }),
      ),
      async (c) =>
        jsonRequest("ProviderRoutes.list", c, function* () {
          if (queryBoolean(c.req.valid("query").refresh)) {
            yield* ModelsDev.Service.use((s) => s.refresh(true))
            yield* Provider.Service.use((svc) => svc.refresh())
          }
          const all = yield* ModelsDev.Service.use((s) => s.get())
          const cfg = yield* Config.Service
          const config = yield* cfg.get()
          const disabled = new Set(config.disabled_providers ?? [])
          const enabled = config.enabled_providers ? new Set(config.enabled_providers) : undefined
          const filtered: Record<string, (typeof all)[string]> = {}
          for (const [key, value] of Object.entries(all)) {
            if ((enabled ? enabled.has(key) : true) && !disabled.has(key)) {
              filtered[key] = value
            }
          }
          const connected = yield* Provider.Service.use((svc) => svc.list())
          return providerListResult({ filtered, connected, disabled })
        }),
    )
    .get(
      "/auth",
      describeRoute({
        summary: "Get provider auth methods",
        description: "Retrieve available authentication methods for all AI providers.",
        operationId: "provider.auth",
        responses: {
          200: {
            description: "Provider auth methods",
            content: {
              "application/json": {
                schema: resolver(ProviderAuth.Methods.zod),
              },
            },
          },
        },
      }),
      async (c) =>
        jsonRequest("ProviderRoutes.auth", c, function* () {
          const svc = yield* ProviderAuth.Service
          return yield* svc.methods()
        }),
    )
    .post(
      "/wanlaicode/api-key/validate",
      describeRoute({
        summary: "Validate WanlaiCode API key",
        description: "Validate a WanlaiCode API key through the local server.",
        operationId: "provider.wanlaicode.apiKey.validate",
        responses: {
          200: {
            description: "API key validation result",
            content: {
              "application/json": {
                schema: resolver(ProviderAuth.WanlaiCodeApiKeyValidateResult.zod),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("json", ProviderAuth.WanlaiCodeApiKeyValidateInput.zod),
      async (c) =>
        jsonRequest("ProviderRoutes.wanlaicode.apiKey.validate", c, function* () {
          const input = c.req.valid("json")
          yield* WanlaiCodeAuth.loginWithApiKey({ apiKey: input.apiKey, apiBase: input.apiBase })
          return { ok: true as const }
        }),
    )
    .post(
      "/:providerID/oauth/authorize",
      describeRoute({
        summary: "OAuth authorize",
        description: "Initiate OAuth authorization for a specific AI provider to get an authorization URL.",
        operationId: "provider.oauth.authorize",
        responses: {
          200: {
            description: "Authorization URL and method",
            content: {
              "application/json": {
                schema: resolver(ProviderAuth.Authorization.zod.optional()),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "param",
        z.object({
          providerID: ProviderID.zod.meta({ description: "Provider ID" }),
        }),
      ),
      validator("json", ProviderAuth.AuthorizeInput.zod),
      async (c) =>
        jsonRequest("ProviderRoutes.oauth.authorize", c, function* () {
          const providerID = c.req.valid("param").providerID
          const { method, inputs } = c.req.valid("json")
          const svc = yield* ProviderAuth.Service
          return yield* svc.authorize({
            providerID,
            method,
            inputs,
          })
        }),
    )
    .post(
      "/:providerID/oauth/callback",
      describeRoute({
        summary: "OAuth callback",
        description: "Handle the OAuth callback from a provider after user authorization.",
        operationId: "provider.oauth.callback",
        // body 手动解析（兼容空 body），但 OpenAPI 仍需声明以保持 effect-httpapi parity；
        // resolver() 占位符在 describeRoute.requestBody 里不展开，所以写字面 schema
        requestBody: {
          required: false,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  method: { type: "number", description: "Auth method index" },
                  code: { type: "string", description: "OAuth authorization code" },
                },
                required: ["method"],
              },
            },
          },
        },
        responses: {
          200: {
            description: "OAuth callback processed successfully",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "param",
        z.object({
          providerID: ProviderID.zod.meta({ description: "Provider ID" }),
        }),
      ),
      async (c) => {
        const raw = await c.req.raw.text()

        const decoded = ProviderAuth.CallbackInput.zod.safeParse(raw ? JSON.parse(raw) : {})
        if (!decoded.success) {
          return c.json(
            {
              success: false,
              data: undefined,
              errors: decoded.error.issues.map((issue) => ({
                path: issue.path.join("."),
                message: issue.message,
                code: issue.code,
              })),
            },
            400,
          )
        }

        return jsonRequest("ProviderRoutes.oauth.callback", c, function* () {
          const providerID = c.req.valid("param").providerID
          const { method, code } = decoded.data
          const svc = yield* ProviderAuth.Service
          yield* svc.callback({
            providerID,
            method,
            code,
          })
          if (providerID === "wanlaicode") {
            // OAuth callback 直接写 Auth.Service，成功后必须显式唤醒已处于 auth_required 的远控网关。
            yield* Effect.promise(() => RemoteControlGateway.authChanged())
            const models = yield* ModelsDev.Service
            const provider = yield* Provider.Service
            yield* provider.refresh()
            yield* models.refreshWanlaiCode().pipe(Effect.ignore)
            yield* provider.refresh()
          }
          return true
        })
      },
    ),
)
