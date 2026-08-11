import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware } from "../middleware/workspace-routing"
import { described } from "./metadata"

export class RegistryRequestError extends Schema.ErrorClass<RegistryRequestError>("RegistryRequestError")(
  { error: Schema.String },
  { httpApiStatus: 400 },
) {}

export class RegistryUnauthorizedError extends Schema.ErrorClass<RegistryUnauthorizedError>(
  "RegistryUnauthorizedError",
)({ error: Schema.String }, { httpApiStatus: 401 }) {}

// —— Schemas mirroring client types in @opencode-ai/addon registry/client.ts

export const RegistrySkillInfo = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
}).annotate({ identifier: "RegistrySkillInfo" })

export const RegistryManifestInfo = Schema.Struct({
  capabilities: Schema.Array(Schema.String),
  default_prompts: Schema.Array(Schema.String),
  screenshots: Schema.Array(Schema.String),
  skills: Schema.Array(RegistrySkillInfo),
  brand_color: Schema.NullOr(Schema.String),
  category: Schema.NullOr(Schema.String),
  developer_name: Schema.NullOr(Schema.String),
  long_description: Schema.NullOr(Schema.String),
  privacy_policy_url: Schema.NullOr(Schema.String),
  short_description: Schema.NullOr(Schema.String),
  terms_of_service_url: Schema.NullOr(Schema.String),
  website_url: Schema.NullOr(Schema.String),
}).annotate({ identifier: "RegistryManifestInfo" })

export const RegistryPluginOut = Schema.Struct({
  namespace: Schema.String,
  slug: Schema.String,
  locale: Schema.String,
  default_locale: Schema.String,
  available_locales: Schema.Array(Schema.String),
  display_name: Schema.String,
  short_description: Schema.optional(Schema.NullOr(Schema.String)),
  long_description: Schema.optional(Schema.NullOr(Schema.String)),
  download_count: Schema.Number,
  rating_avg: Schema.Number,
  rating_count: Schema.Number,
  comment_count: Schema.Number,
  created_at: Schema.String,
  updated_at: Schema.String,
  latest_version: Schema.NullOr(Schema.String),
  logo_url: Schema.NullOr(Schema.String),
  category: Schema.NullOr(Schema.String),
}).annotate({ identifier: "RegistryPluginOut" })

export const RegistryVersionOut = Schema.Struct({
  version: Schema.String,
  size_bytes: Schema.Number,
  checksum: Schema.String,
  download_count: Schema.Number,
  created_at: Schema.String,
}).annotate({ identifier: "RegistryVersionOut" })

export const RegistryPluginDetail = Schema.Struct({
  namespace: Schema.String,
  slug: Schema.String,
  locale: Schema.String,
  default_locale: Schema.String,
  available_locales: Schema.Array(Schema.String),
  display_name: Schema.String,
  short_description: Schema.optional(Schema.NullOr(Schema.String)),
  long_description: Schema.optional(Schema.NullOr(Schema.String)),
  download_count: Schema.Number,
  rating_avg: Schema.Number,
  rating_count: Schema.Number,
  comment_count: Schema.Number,
  created_at: Schema.String,
  updated_at: Schema.String,
  latest_version: Schema.NullOr(Schema.String),
  logo_url: Schema.NullOr(Schema.String),
  category: Schema.NullOr(Schema.String),
  manifest: Schema.NullOr(RegistryManifestInfo),
  versions: Schema.Array(RegistryVersionOut),
}).annotate({ identifier: "RegistryPluginDetail" })

export const RegistryPluginsPage = Schema.Struct({
  items: Schema.Array(RegistryPluginOut),
  total: Schema.Number,
  page: Schema.Number,
  per_page: Schema.Number,
}).annotate({ identifier: "RegistryPluginsPage" })

export const RegistryComment = Schema.Struct({
  id: Schema.String,
  // 列表项(CommentWithAuthor)带 author；创建响应(CommentOut)不带——故 author 字段可选。
  author_uuid: Schema.optional(Schema.String),
  username: Schema.optional(Schema.String),
  content: Schema.String,
  created_at: Schema.String,
  updated_at: Schema.String,
}).annotate({ identifier: "RegistryComment" })

export const RegistryCommentsPage = Schema.Struct({
  items: Schema.Array(RegistryComment),
  total: Schema.Number,
  page: Schema.Number,
  per_page: Schema.Number,
}).annotate({ identifier: "RegistryCommentsPage" })

export const RegistryRating = Schema.Struct({
  rating: Schema.Number,
  created_at: Schema.String,
  updated_at: Schema.String,
}).annotate({ identifier: "RegistryRating" })

export const RegistryUser = Schema.Struct({
  wanlai_uuid: Schema.String,
  email: Schema.String,
  username: Schema.String,
  role: Schema.String,
  status: Schema.String,
  namespace: Schema.NullOr(Schema.String),
  created_at: Schema.String,
  updated_at: Schema.String,
}).annotate({ identifier: "RegistryUser" })

export const RegistryInstallRequest = Schema.Struct({
  namespace: Schema.String,
  slug: Schema.String,
  version: Schema.optional(Schema.String),
}).annotate({ identifier: "RegistryInstallRequest" })

export const RegistryPublishRequest = Schema.Struct({
  addon_key: Schema.String,
}).annotate({ identifier: "RegistryPublishRequest" })

export const RegistryNamespaceRequest = Schema.Struct({
  name: Schema.String,
}).annotate({ identifier: "RegistryNamespaceRequest" })

export const RegistryNamespaceOutcome = Schema.Struct({
  namespace: Schema.String,
}).annotate({ identifier: "RegistryNamespaceOutcome" })

export const RegistryMyPluginsOutcome = Schema.Struct({
  user: RegistryUser,
  plugins: Schema.Array(RegistryPluginOut),
}).annotate({ identifier: "RegistryMyPluginsOutcome" })

export const RegistryInstallOutcome = Schema.Struct({
  key: Schema.String,
  version: Schema.String,
  installed_path: Schema.String,
}).annotate({ identifier: "RegistryInstallOutcome" })

export const RegistryPublishOutcome = Schema.Struct({
  ok: Schema.Boolean,
}).annotate({ identifier: "RegistryPublishOutcome" })

export const RegistryCommentRequest = Schema.Struct({
  content: Schema.String,
}).annotate({ identifier: "RegistryCommentRequest" })

export const RegistryRatingRequest = Schema.Struct({
  rating: Schema.Number,
}).annotate({ identifier: "RegistryRatingRequest" })

export const RegistryListQuery = Schema.Struct({
  q: Schema.optional(Schema.String),
  page: Schema.optional(Schema.NumberFromString),
  per_page: Schema.optional(Schema.NumberFromString),
  sort: Schema.optional(Schema.String),
  locale: Schema.optional(Schema.String),
})

export const RegistryLocaleQuery = Schema.Struct({
  locale: Schema.optional(Schema.String),
})

export const RegistryPageQuery = Schema.Struct({
  page: Schema.optional(Schema.NumberFromString),
})

export const RegistryPaths = {
  listPlugins: "/registry/plugins",
  getPlugin: "/registry/plugins/:namespace/:slug",
  install: "/registry/install",
  publish: "/registry/publish",
  me: "/registry/me",
  namespaces: "/registry/namespaces",
  myPlugins: "/registry/my/plugins",
  comments: "/registry/plugins/:namespace/:slug/comments",
  commentDelete: "/registry/plugins/:namespace/:slug/comments/:publicId",
  rating: "/registry/plugins/:namespace/:slug/rating",
  version: "/registry/plugins/:namespace/:slug/versions/:version",
} as const

export const RegistryApi = HttpApi.make("registry")
  .add(
    HttpApiGroup.make("registry")
      .add(
        HttpApiEndpoint.get("listPlugins", RegistryPaths.listPlugins, {
          query: RegistryListQuery,
          success: described(RegistryPluginsPage, "Plugins page"),
          error: RegistryRequestError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "registry.listPlugins",
            summary: "List marketplace plugins",
            description: "List plugins from the WanLaiCode plugin marketplace with optional search and pagination.",
          }),
        ),
        HttpApiEndpoint.get("getPlugin", RegistryPaths.getPlugin, {
          params: { namespace: Schema.String, slug: Schema.String },
          query: RegistryLocaleQuery,
          success: described(RegistryPluginDetail, "Plugin detail"),
          error: RegistryRequestError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "registry.getPlugin",
            summary: "Get plugin detail",
            description: "Get full detail for a specific plugin from the registry.",
          }),
        ),
        HttpApiEndpoint.delete("deletePlugin", RegistryPaths.getPlugin, {
          params: { namespace: Schema.String, slug: Schema.String },
          success: described(Schema.Struct({ ok: Schema.Boolean }), "Plugin deleted"),
          error: [RegistryRequestError, RegistryUnauthorizedError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "registry.deletePlugin",
            summary: "Delete a published plugin",
            description: "Delete a published plugin. Requires owner or admin permission.",
          }),
        ),
        HttpApiEndpoint.post("install", RegistryPaths.install, {
          payload: RegistryInstallRequest,
          success: described(RegistryInstallOutcome, "Installed"),
          error: RegistryRequestError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "registry.install",
            summary: "Install a marketplace plugin",
            description: "Download and install a plugin from the WanLaiCode registry.",
          }),
        ),
        HttpApiEndpoint.post("publish", RegistryPaths.publish, {
          payload: RegistryPublishRequest,
          success: described(RegistryPublishOutcome, "Published"),
          error: [RegistryRequestError, RegistryUnauthorizedError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "registry.publish",
            summary: "Publish a local plugin",
            description: "Package and upload an installed local plugin to the WanLaiCode registry. Requires login.",
          }),
        ),
        HttpApiEndpoint.get("me", RegistryPaths.me, {
          success: described(RegistryUser, "Current user"),
          error: [RegistryRequestError, RegistryUnauthorizedError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "registry.me",
            summary: "Get current registry user",
            description: "Returns the authenticated user's registry profile. Requires login.",
          }),
        ),
        HttpApiEndpoint.post("createNamespace", RegistryPaths.namespaces, {
          payload: RegistryNamespaceRequest,
          success: described(RegistryNamespaceOutcome, "Namespace created"),
          error: [RegistryRequestError, RegistryUnauthorizedError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "registry.createNamespace",
            summary: "Create current user's registry namespace",
            description: "Registers the authenticated user's one-time plugin publishing namespace.",
          }),
        ),
        HttpApiEndpoint.get("myPlugins", RegistryPaths.myPlugins, {
          query: RegistryLocaleQuery,
          success: described(RegistryMyPluginsOutcome, "Current user's published plugins"),
          error: [RegistryRequestError, RegistryUnauthorizedError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "registry.myPlugins",
            summary: "List my published plugins",
            description: "Returns the authenticated registry user and plugins published under their namespace.",
          }),
        ),
        HttpApiEndpoint.get("listComments", RegistryPaths.comments, {
          params: { namespace: Schema.String, slug: Schema.String },
          query: RegistryPageQuery,
          success: described(RegistryCommentsPage, "Comments page"),
          error: RegistryRequestError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "registry.listComments",
            summary: "List plugin comments",
            description: "List comments for a specific plugin.",
          }),
        ),
        HttpApiEndpoint.post("postComment", RegistryPaths.comments, {
          params: { namespace: Schema.String, slug: Schema.String },
          payload: RegistryCommentRequest,
          success: described(RegistryComment, "Comment created"),
          error: [RegistryRequestError, RegistryUnauthorizedError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "registry.postComment",
            summary: "Post a comment",
            description: "Post a comment on a plugin. Requires login.",
          }),
        ),
        HttpApiEndpoint.delete("deleteComment", RegistryPaths.commentDelete, {
          params: { namespace: Schema.String, slug: Schema.String, publicId: Schema.String },
          success: described(Schema.Struct({ ok: Schema.Boolean }), "Comment deleted"),
          error: [RegistryRequestError, RegistryUnauthorizedError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "registry.deleteComment",
            summary: "Delete a comment",
            description: "Delete a comment by public ID. Requires login.",
          }),
        ),
        HttpApiEndpoint.get("getMyRating", RegistryPaths.rating, {
          params: { namespace: Schema.String, slug: Schema.String },
          success: described(Schema.NullOr(RegistryRating), "My rating"),
          error: [RegistryRequestError, RegistryUnauthorizedError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "registry.getMyRating",
            summary: "Get my rating",
            description: "Get the current user's rating for a plugin. Requires login.",
          }),
        ),
        HttpApiEndpoint.put("putRating", RegistryPaths.rating, {
          params: { namespace: Schema.String, slug: Schema.String },
          payload: RegistryRatingRequest,
          success: described(RegistryRating, "Rating saved"),
          error: [RegistryRequestError, RegistryUnauthorizedError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "registry.putRating",
            summary: "Submit or update rating",
            description: "Submit or update the current user's rating for a plugin. Requires login.",
          }),
        ),
        HttpApiEndpoint.delete("deleteRating", RegistryPaths.rating, {
          params: { namespace: Schema.String, slug: Schema.String },
          success: described(Schema.Struct({ ok: Schema.Boolean }), "Rating deleted"),
          error: [RegistryRequestError, RegistryUnauthorizedError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "registry.deleteRating",
            summary: "Delete rating",
            description: "Remove the current user's rating for a plugin. Requires login.",
          }),
        ),
        HttpApiEndpoint.delete("deleteVersion", RegistryPaths.version, {
          params: { namespace: Schema.String, slug: Schema.String, version: Schema.String },
          success: described(Schema.Struct({ ok: Schema.Boolean }), "Version deleted"),
          error: [RegistryRequestError, RegistryUnauthorizedError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "registry.deleteVersion",
            summary: "Delete a plugin version",
            description: "Delete a published plugin version. Requires owner or admin permission.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "registry",
          description: "Remote plugin marketplace routes.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode registry HttpApi",
      version: "0.0.1",
      description: "Remote plugin marketplace proxy endpoints.",
    }),
  )
