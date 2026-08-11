import { Schema } from "effect"
import * as MessageV2 from "@/session/message-v2"
import { ErrorMessageMapSchema } from "@opencode-ai/core/error/message-map"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware } from "../middleware/workspace-routing"
import { described } from "./metadata"

const root = "/wanlaicode/user-center"

export const WanlaiCodeUserCenterPaths = {
  status: `${root}/status`,
  login: `${root}/login`,
  entitlements: `${root}/entitlements`,
  tokenPacks: `${root}/token-packs`,
  updateChannel: `${root}/update-channel`,
  apiKey: `${root}/api-key`,
  balanceBilling: `${root}/balance-billing`,
  purchasePlans: `${root}/purchase/plans`,
  purchasePage: `${root}/purchase/page`,
  usage: `${root}/usage`,
  usageStats: `${root}/usage/stats`,
  communityPost: `${root}/community/posts`,
  imageGenerate: `${root}/images/generate`,
  imageIntent: `${root}/images/intent`,
  codexIntegrationStatus: `${root}/integrations/codex/status`,
  codexIntegrationImport: `${root}/integrations/codex/import`,
  codexIntegrationRestore: `${root}/integrations/codex/restore`,
} as const

export const WanlaiCodeUserCenterJson = Schema.Record(Schema.String, Schema.Unknown).annotate({
  identifier: "WanlaiCodeUserCenterJson",
})

export class WanlaiCodeUserCenterError extends Schema.ErrorClass<WanlaiCodeUserCenterError>(
  "WanlaiCodeUserCenterError",
)(
  {
    name: Schema.Literal("WanlaiCodeUserCenterError"),
    data: Schema.Struct({
      message: Schema.String,
      reason: Schema.optional(Schema.String),
    }),
  },
  { httpApiStatus: 400 },
) {}

// 账号密码登录入参：本地 /wanlaicode/user-center/login → 远端 /api/v1/auth/login。
// 不接受 apiBase 之类的端点覆盖：登录目标一律由 brand 配置解析，避免凭据被转发到任意主机。
export const WanlaiCodeUserCenterLoginInput = Schema.Struct({
  email: Schema.String,
  password: Schema.String,
})

export const WanlaiCodeUserCenterStatus = Schema.Struct({
  authenticated: Schema.Boolean,
  auth_type: Schema.optional(Schema.Union([Schema.Literal("oauth"), Schema.Literal("api")])),
  requires_oauth: Schema.Boolean,
  // 本地仍有万来 OAuth 凭据但已失效时单独标记，供远控页提示重新认证而不是误报“未登录”。
  oauth_reauth_required: Schema.Boolean,
  product_code: Schema.String,
  api_base: Schema.String,
  codex_base_url: Schema.String,
  site_url: Schema.String,
  purchase_url: Schema.String,
  account_id: Schema.optional(Schema.String),
  account_email: Schema.optional(Schema.String),
  account_name: Schema.optional(Schema.String),
}).annotate({ identifier: "WanlaiCodeUserCenterStatus" })

export const WanlaiCodeUserCenterEntitlements = Schema.Struct({
  items: Schema.Array(WanlaiCodeUserCenterJson),
}).annotate({ identifier: "WanlaiCodeUserCenterEntitlements" })

export const WanlaiCodeUserCenterTokenPackItem = Schema.Struct({
  id: Schema.Number,
  token_pack_id: Schema.Number,
  name: Schema.String,
  billing_token_quota: Schema.Number,
  billing_token_used: Schema.Number,
  remaining: Schema.Number,
  starts_at: Schema.optional(Schema.String),
  expires_at: Schema.optional(Schema.String),
  status: Schema.String,
})

export const WanlaiCodeUserCenterTokenPacks = Schema.Struct({
  items: Schema.Array(WanlaiCodeUserCenterTokenPackItem),
  server_now_ms: Schema.Number,
}).annotate({ identifier: "WanlaiCodeUserCenterTokenPacks" })

export const WanlaiCodeUserCenterProductQuery = Schema.Struct({
  product_code: Schema.optional(Schema.String),
})

export const WanlaiCodeUserCenterApiKeyCreate = Schema.Struct({
  product_code: Schema.optional(Schema.String),
  replace_existing: Schema.optional(Schema.Boolean),
})

export const WanlaiCodeUserCenterApiKey = Schema.Struct({
  raw_key: Schema.optional(Schema.String),
}).annotate({ identifier: "WanlaiCodeUserCenterApiKey" })

// 账户余额按量付费开关：无套餐用户可用账户余额扣费继续使用。
export const WanlaiCodeUserCenterBalanceBilling = Schema.Struct({
  enabled: Schema.Boolean,
}).annotate({ identifier: "WanlaiCodeUserCenterBalanceBilling" })

export const WanlaiCodeUserCenterBalanceBillingUpdate = Schema.Struct({
  enabled: Schema.Boolean,
})

export const WanlaiCodeUserCenterPurchasePlans = Schema.Struct({
  enabled: Schema.Boolean,
  purchase_url: Schema.String,
  plans: Schema.Array(WanlaiCodeUserCenterJson),
}).annotate({ identifier: "WanlaiCodeUserCenterPurchasePlans" })

export const WanlaiCodeUserCenterPurchasePageQuery = Schema.Struct({
  plan_id: Schema.optional(Schema.String),
  software_product: Schema.optional(Schema.String),
  payment_type: Schema.optional(Schema.String),
  user_id: Schema.optional(Schema.NumberFromString),
  user_uuid: Schema.optional(Schema.String),
  theme: Schema.optional(Schema.Union([Schema.Literal("light"), Schema.Literal("dark")])),
  lang: Schema.optional(Schema.String),
  src_host: Schema.optional(Schema.String),
  src_url: Schema.optional(Schema.String),
})

export const WanlaiCodeUserCenterPurchasePage = Schema.Struct({
  enabled: Schema.Boolean,
  url: Schema.String,
}).annotate({ identifier: "WanlaiCodeUserCenterPurchasePage" })

export const WanlaiCodeUserCenterUsageQuery = Schema.Struct({
  page: Schema.optional(Schema.NumberFromString),
  page_size: Schema.optional(Schema.NumberFromString),
  platform: Schema.optional(Schema.String),
  start_date: Schema.optional(Schema.String),
  end_date: Schema.optional(Schema.String),
  timezone: Schema.optional(Schema.String),
})

export const WanlaiCodeUserCenterUsagePage = Schema.Struct({
  items: Schema.Array(WanlaiCodeUserCenterJson),
  total: Schema.Number,
  page: Schema.Number,
  page_size: Schema.Number,
  pages: Schema.Number,
}).annotate({ identifier: "WanlaiCodeUserCenterUsagePage" })

export const WanlaiCodeUserCenterUsageStats = WanlaiCodeUserCenterJson.annotate({
  identifier: "WanlaiCodeUserCenterUsageStats",
})

export const WanlaiCodeUserCenterImageAttachment = Schema.Struct({
  data_url: Schema.String,
  mime: Schema.optional(Schema.String),
  filename: Schema.optional(Schema.String),
}).annotate({ identifier: "WanlaiCodeUserCenterImageAttachment" })

export const WanlaiCodeUserCenterImageGenerate = Schema.Struct({
  session_id: Schema.optional(Schema.String),
  message_id: Schema.optional(Schema.String),
  prompt: Schema.String,
  context_text: Schema.optional(Schema.String),
  model: Schema.String,
  provider_id: Schema.optional(Schema.String),
  // 用户当前实际选中的模型。转接出图时，model/provider_id 是被转接的出图模型（如 gpt-image-2，
  // 仅用于图片 API 调用与 assistant 归因），而 selected_model/selected_provider_id 是用户真正选中的
  // 模型（如 gpt-5.5），用于记录到 user message——避免会话模型选择被内部转接静默改写。
  selected_model: Schema.optional(Schema.String),
  selected_provider_id: Schema.optional(Schema.String),
  agent: Schema.optional(Schema.String),
  count: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(8)),
  ),
  size: Schema.optional(Schema.String),
  quality: Schema.optional(
    Schema.Union([Schema.Literal("auto"), Schema.Literal("low"), Schema.Literal("medium"), Schema.Literal("high")]),
  ),
  output_format: Schema.optional(Schema.Union([Schema.Literal("png"), Schema.Literal("jpeg"), Schema.Literal("webp")])),
  moderation: Schema.optional(Schema.Union([Schema.Literal("auto"), Schema.Literal("low")])),
  loading_text: Schema.optional(Schema.String),
  failure_prefix: Schema.optional(Schema.String),
  error_messages: Schema.optional(ErrorMessageMapSchema),
  input_images: Schema.optional(Schema.Array(WanlaiCodeUserCenterImageAttachment)),
  parts: Schema.optional(
    Schema.Array(Schema.Union([MessageV2.TextPartInput, MessageV2.FilePartInput, MessageV2.AgentPartInput])),
  ),
})

export const WanlaiCodeUserCenterGeneratedImage = Schema.Struct({
  url: Schema.String,
  mime: Schema.String,
  filename: Schema.String,
  revised_prompt: Schema.optional(Schema.String),
}).annotate({ identifier: "WanlaiCodeUserCenterGeneratedImage" })

export const WanlaiCodeUserCenterImageGenerateResult = Schema.Struct({
  images: Schema.Array(WanlaiCodeUserCenterGeneratedImage),
  message_id: Schema.optional(Schema.String),
}).annotate({ identifier: "WanlaiCodeUserCenterImageGenerateResult" })

export const WanlaiCodeUserCenterImageIntent = Schema.Struct({
  text: Schema.String,
  has_image_context: Schema.Boolean,
  recent_context: Schema.optional(Schema.String),
  current_image_count: Schema.optional(Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))),
  current_image_filenames: Schema.optional(Schema.Array(Schema.String)),
  provider_id: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
})

export const WanlaiCodeUserCenterImageIntentResult = Schema.Struct({
  action: Schema.Union([Schema.Literal("generate"), Schema.Literal("edit"), Schema.Literal("none")]),
  confidence: Schema.Number,
  reason: Schema.optional(Schema.String),
  route: Schema.optional(Schema.Union([Schema.Literal("chat"), Schema.Literal("tool")])),
  tool: Schema.optional(Schema.Literal("image_generation")),
  image_prompt: Schema.optional(Schema.String),
  context_text: Schema.optional(Schema.String),
}).annotate({ identifier: "WanlaiCodeUserCenterImageIntentResult" })

export const WanlaiCodeUserCenterCodexIntegrationStatus = Schema.Struct({
  installed: Schema.Boolean,
  restorable: Schema.Boolean,
  config_path: Schema.String,
  auth_path: Schema.String,
  provider_id: Schema.Literal("wanlai"),
}).annotate({ identifier: "WanlaiCodeUserCenterCodexIntegrationStatus" })

export const WanlaiCodeUserCenterCodexImport = Schema.Struct({
  product_code: Schema.optional(Schema.String),
})

export const WanlaiCodeUserCenterCodexImportResult = Schema.Struct({
  ok: Schema.Literal(true),
  installed: Schema.Literal(true),
  changed: Schema.Boolean,
}).annotate({ identifier: "WanlaiCodeUserCenterCodexImportResult" })

export const WanlaiCodeUserCenterCodexRestoreResult = Schema.Struct({
  ok: Schema.Literal(true),
  installed: Schema.Literal(false),
  restored_from_backup: Schema.Boolean,
}).annotate({ identifier: "WanlaiCodeUserCenterCodexRestoreResult" })

// 桌面 /bug 问题报告对齐到社区投稿（type=bug）。附件复用出图附件的 base64 形状，
// 服务端再转成 multipart 转发到后端 /community/posts。
export const WanlaiCodeUserCenterCommunityPostInput = Schema.Struct({
  title: Schema.String,
  content: Schema.String,
  priority: Schema.optional(Schema.String),
  module: Schema.optional(Schema.String),
  platform: Schema.optional(Schema.String),
  attachments: Schema.optional(Schema.Array(WanlaiCodeUserCenterImageAttachment)),
}).annotate({ identifier: "WanlaiCodeUserCenterCommunityPostInput" })

export const WanlaiCodeUserCenterCommunityPost = Schema.Struct({
  id: Schema.Number,
  status: Schema.optional(Schema.String),
  created_at: Schema.optional(Schema.String),
}).annotate({ identifier: "WanlaiCodeUserCenterCommunityPost" })

export const WanlaiCodeUserCenterApi = HttpApi.make("wanlaicodeUserCenter")
  .add(
    HttpApiGroup.make("wanlaicodeUserCenter")
      .add(
        HttpApiEndpoint.get("status", WanlaiCodeUserCenterPaths.status, {
          success: described(WanlaiCodeUserCenterStatus, "WanlaiCode user center status"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "wanlaicodeUserCenter.status",
            summary: "Get WanlaiCode user center status",
            description: "Return WanlaiCode login status and default endpoint configuration for the desktop app.",
          }),
        ),
        HttpApiEndpoint.post("login", WanlaiCodeUserCenterPaths.login, {
          payload: WanlaiCodeUserCenterLoginInput,
          success: described(Schema.Boolean, "Successfully logged in with email and password"),
          error: WanlaiCodeUserCenterError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "wanlaicodeUserCenter.login",
            summary: "Login to WanlaiCode with email and password",
            description:
              "Proxy the WanlaiCode email/password login through the local server and persist local auth credentials.",
          }),
        ),
        HttpApiEndpoint.get("entitlements", WanlaiCodeUserCenterPaths.entitlements, {
          success: described(WanlaiCodeUserCenterEntitlements, "WanlaiCode software entitlements"),
          error: WanlaiCodeUserCenterError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "wanlaicodeUserCenter.entitlements",
            summary: "List WanlaiCode software entitlements",
            description: "Proxy the authenticated WanlaiCode software entitlement list through the local server.",
          }),
        ),
        HttpApiEndpoint.get("tokenPacks", WanlaiCodeUserCenterPaths.tokenPacks, {
          success: described(WanlaiCodeUserCenterTokenPacks, "我的token包列表"),
          error: WanlaiCodeUserCenterError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "wanlaicodeUserCenter.tokenPacks",
            summary: "List WanlaiCode token packs",
            description: "Proxy the authenticated WanlaiCode token pack list through the local server.",
          }),
        ),
        HttpApiEndpoint.get("getUpdateChannel", WanlaiCodeUserCenterPaths.updateChannel, {
          success: described(
            Schema.Struct({
              channel: Schema.String,
              withdrawn_versions: Schema.optional(
                Schema.Array(Schema.Struct({ version: Schema.String, rollback_to: Schema.optional(Schema.String) })),
              ),
            }),
            "Current update channel",
          ),
          error: WanlaiCodeUserCenterError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "wanlaicodeUserCenter.updateChannel.get",
            summary: "Get WanlaiCode update channel",
            description: "Get the current software update channel (prod or canary) for the authenticated user.",
          }),
        ),
        HttpApiEndpoint.post("setUpdateChannel", WanlaiCodeUserCenterPaths.updateChannel, {
          payload: Schema.Struct({ channel: Schema.Union([Schema.Literal("prod"), Schema.Literal("canary")]) }),
          success: described(Schema.Struct({ channel: Schema.String }), "Updated channel"),
          error: WanlaiCodeUserCenterError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "wanlaicodeUserCenter.updateChannel.set",
            summary: "Set WanlaiCode update channel",
            description: "Set the software update channel (prod or canary) for the authenticated user.",
          }),
        ),
        HttpApiEndpoint.get("apiKeyGet", WanlaiCodeUserCenterPaths.apiKey, {
          query: WanlaiCodeUserCenterProductQuery,
          success: described(WanlaiCodeUserCenterApiKey, "WanlaiCode software API key"),
          error: WanlaiCodeUserCenterError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "wanlaicodeUserCenter.apiKey.get",
            summary: "Get WanlaiCode software API key",
            description: "Fetch the current raw software API key for the selected WanlaiCode product.",
          }),
        ),
        HttpApiEndpoint.post("apiKeyCreate", WanlaiCodeUserCenterPaths.apiKey, {
          payload: WanlaiCodeUserCenterApiKeyCreate,
          success: described(WanlaiCodeUserCenterApiKey, "Created WanlaiCode software API key"),
          error: WanlaiCodeUserCenterError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "wanlaicodeUserCenter.apiKey.create",
            summary: "Create or rotate WanlaiCode software API key",
            description: "Create the selected WanlaiCode software API key or replace the existing one.",
          }),
        ),
        HttpApiEndpoint.get("balanceBillingGet", WanlaiCodeUserCenterPaths.balanceBilling, {
          success: described(WanlaiCodeUserCenterBalanceBilling, "WanlaiCode balance billing switch"),
          error: WanlaiCodeUserCenterError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "wanlaicodeUserCenter.balanceBilling.get",
            summary: "Get WanlaiCode balance billing switch",
            description: "Proxy the current account balance billing switch through the local server.",
          }),
        ),
        HttpApiEndpoint.post("balanceBillingUpdate", WanlaiCodeUserCenterPaths.balanceBilling, {
          payload: WanlaiCodeUserCenterBalanceBillingUpdate,
          success: described(WanlaiCodeUserCenterBalanceBilling, "Updated WanlaiCode balance billing switch"),
          error: WanlaiCodeUserCenterError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "wanlaicodeUserCenter.balanceBilling.update",
            summary: "Update WanlaiCode balance billing switch",
            description: "Toggle the account balance billing switch through the local server.",
          }),
        ),
        HttpApiEndpoint.get("purchasePlans", WanlaiCodeUserCenterPaths.purchasePlans, {
          success: described(WanlaiCodeUserCenterPurchasePlans, "WanlaiCode purchase plans"),
          error: WanlaiCodeUserCenterError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "wanlaicodeUserCenter.purchase.plans",
            summary: "List WanlaiCode purchase plans",
            description:
              "Load WanlaiCode storefront plans through the local server using the configured purchase service.",
          }),
        ),
        HttpApiEndpoint.get("purchasePage", WanlaiCodeUserCenterPaths.purchasePage, {
          query: WanlaiCodeUserCenterPurchasePageQuery,
          success: described(WanlaiCodeUserCenterPurchasePage, "WanlaiCode embedded purchase page"),
          error: WanlaiCodeUserCenterError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "wanlaicodeUserCenter.purchase.page",
            summary: "Build WanlaiCode embedded purchase page URL",
            description: "Build the iframe purchase URL with the current WanlaiCode OAuth session.",
          }),
        ),
        HttpApiEndpoint.get("usageList", WanlaiCodeUserCenterPaths.usage, {
          query: WanlaiCodeUserCenterUsageQuery,
          success: described(WanlaiCodeUserCenterUsagePage, "WanlaiCode software usage records"),
          error: WanlaiCodeUserCenterError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "wanlaicodeUserCenter.usage.list",
            summary: "List WanlaiCode software usage records",
            description: "Proxy paginated software usage records through the local server.",
          }),
        ),
        HttpApiEndpoint.get("usageStats", WanlaiCodeUserCenterPaths.usageStats, {
          query: WanlaiCodeUserCenterUsageQuery,
          success: described(WanlaiCodeUserCenterUsageStats, "WanlaiCode software usage stats"),
          error: WanlaiCodeUserCenterError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "wanlaicodeUserCenter.usage.stats",
            summary: "Get WanlaiCode software usage stats",
            description: "Proxy software usage summary statistics through the local server.",
          }),
        ),
        HttpApiEndpoint.post("imageGenerate", WanlaiCodeUserCenterPaths.imageGenerate, {
          payload: WanlaiCodeUserCenterImageGenerate,
          success: described(WanlaiCodeUserCenterImageGenerateResult, "WanlaiCode image generation result"),
          error: WanlaiCodeUserCenterError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "wanlaicodeUserCenter.images.generate",
            summary: "Generate images with WanlaiCode",
            description:
              "Generate images through the configured WanlaiCode API and optionally append them to a session.",
          }),
        ),
        HttpApiEndpoint.post("imageIntent", WanlaiCodeUserCenterPaths.imageIntent, {
          payload: WanlaiCodeUserCenterImageIntent,
          success: described(WanlaiCodeUserCenterImageIntentResult, "WanlaiCode image intent classification result"),
          error: WanlaiCodeUserCenterError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "wanlaicodeUserCenter.images.intent",
            summary: "Classify whether a prompt should route to image generation",
            description:
              "Use the configured text model to decide whether an ambiguous contextual prompt should generate or edit an image.",
          }),
        ),
        HttpApiEndpoint.post("communityPost", WanlaiCodeUserCenterPaths.communityPost, {
          payload: WanlaiCodeUserCenterCommunityPostInput,
          success: described(WanlaiCodeUserCenterCommunityPost, "Created WanlaiCode community bug report"),
          error: WanlaiCodeUserCenterError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "wanlaicodeUserCenter.community.post",
            summary: "Submit a WanlaiCode community bug report",
            description:
              "Forward a desktop issue report to the community bug tracker (type=bug) using the current WanlaiCode OAuth session.",
          }),
        ),
        HttpApiEndpoint.get("codexIntegrationStatus", WanlaiCodeUserCenterPaths.codexIntegrationStatus, {
          success: described(WanlaiCodeUserCenterCodexIntegrationStatus, "WanlaiCode Codex local integration status"),
          error: WanlaiCodeUserCenterError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "wanlaicodeUserCenter.integrations.codex.status",
            summary: "Get WanlaiCode Codex local integration status",
            description: "Read the local Codex config and report whether WanlaiCode is already installed.",
          }),
        ),
        HttpApiEndpoint.post("codexIntegrationImport", WanlaiCodeUserCenterPaths.codexIntegrationImport, {
          payload: WanlaiCodeUserCenterCodexImport,
          success: described(WanlaiCodeUserCenterCodexImportResult, "WanlaiCode Codex local integration import result"),
          error: WanlaiCodeUserCenterError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "wanlaicodeUserCenter.integrations.codex.import",
            summary: "Import WanlaiCode into local Codex config",
            description:
              "Write the WanlaiCode provider and software key directly into local Codex configuration files.",
          }),
        ),
        HttpApiEndpoint.post("codexIntegrationRestore", WanlaiCodeUserCenterPaths.codexIntegrationRestore, {
          success: described(
            WanlaiCodeUserCenterCodexRestoreResult,
            "WanlaiCode Codex local integration restore result",
          ),
          error: WanlaiCodeUserCenterError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "wanlaicodeUserCenter.integrations.codex.restore",
            summary: "Restore local Codex config from WanlaiCode",
            description: "Restore the previous Codex config or remove WanlaiCode-managed provider settings.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "wanlaicodeUserCenter",
          description: "WanlaiCode desktop user center routes.",
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
