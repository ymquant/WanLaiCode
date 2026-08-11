import { ProviderAuth } from "@/provider/auth"
import { Provider } from "@/provider/provider"
import { ProviderID } from "@/provider/schema"
import { Schema, SchemaGetter } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware } from "../middleware/workspace-routing"
import { described } from "./metadata"

const root = "/provider"

// 唯一在 httpapi 侧新增、legacy hono 侧无对应实现的 provider 路由——
// 经 index.ts 无条件桥接到 httpapi handler（同 WanlaiCodeUserCenterPaths 的做法）。
export const ProviderPaths = {
  wanlaicodeOAuthRefresh: "/wanlaicode/oauth/refresh",
} as const

const QueryBoolean = Schema.Literals(["true", "false"]).pipe(
  Schema.decodeTo(Schema.Boolean, {
    decode: SchemaGetter.transform((value) => value === "true"),
    encode: SchemaGetter.transform((value) => (value ? "true" : "false")),
  }),
)

const ProviderListQuery = Schema.Struct({
  refresh: Schema.optional(QueryBoolean),
})

export const WanlaiCodeOAuthRefreshResult = Schema.Struct({
  ok: Schema.Boolean,
})

export const ProviderApi = HttpApi.make("provider")
  .add(
    HttpApiGroup.make("provider")
      .add(
        HttpApiEndpoint.get("list", root, {
          query: ProviderListQuery,
          success: described(Provider.ListResult, "List of providers"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "provider.list",
            summary: "List providers",
            description: "Get a list of all available AI providers, including both available and connected ones.",
          }),
        ),
        HttpApiEndpoint.get("auth", `${root}/auth`, {
          success: described(ProviderAuth.Methods, "Provider auth methods"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "provider.auth",
            summary: "Get provider auth methods",
            description: "Retrieve available authentication methods for all AI providers.",
          }),
        ),
        HttpApiEndpoint.post("validateWanlaiCodeApiKey", `${root}/wanlaicode/api-key/validate`, {
          payload: ProviderAuth.WanlaiCodeApiKeyValidateInput,
          success: described(ProviderAuth.WanlaiCodeApiKeyValidateResult, "API key validation result"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "provider.wanlaicode.apiKey.validate",
            summary: "Validate WanlaiCode API key",
            description: "Validate a WanlaiCode API key through the local server.",
          }),
        ),
        HttpApiEndpoint.post("authorize", `${root}/:providerID/oauth/authorize`, {
          params: { providerID: ProviderID },
          payload: ProviderAuth.AuthorizeInput,
          success: described(Schema.UndefinedOr(ProviderAuth.Authorization), "Authorization URL and method"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "provider.oauth.authorize",
            summary: "Start OAuth authorization",
            description: "Start the OAuth authorization flow for a provider.",
          }),
        ),
        HttpApiEndpoint.post("callback", `${root}/:providerID/oauth/callback`, {
          params: { providerID: ProviderID },
          payload: ProviderAuth.CallbackInput,
          success: described(Schema.Boolean, "OAuth callback processed successfully"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "provider.oauth.callback",
            summary: "Handle OAuth callback",
            description: "Handle the OAuth callback from a provider after user authorization.",
          }),
        ),
        HttpApiEndpoint.post("wanlaicodeOAuthRefresh", ProviderPaths.wanlaicodeOAuthRefresh, {
          success: described(WanlaiCodeOAuthRefreshResult, "WanlaiCode OAuth refresh result"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "provider.wanlaicode.oauth.refresh",
            summary: "Trigger WanlaiCode OAuth refresh",
            description: "Trigger a WanlaiCode OAuth token refresh via the shared coordinator (e.g. on desktop wake).",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "provider",
          description: "Experimental HttpApi provider routes.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode experimental HttpApi",
      version: "0.0.1",
      description: "Experimental HttpApi surface for selected instance routes.",
    }),
  )
