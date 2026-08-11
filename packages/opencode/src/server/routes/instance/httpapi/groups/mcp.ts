import { MCP } from "@/mcp"
import * as McpManagement from "@/mcp/management"
import { ConfigMCP } from "@/config/mcp"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware } from "../middleware/workspace-routing"
import { described } from "./metadata"

export const AddPayload = Schema.Struct({
  name: Schema.String,
  config: ConfigMCP.Info,
})

export const StatusMap = Schema.Record(Schema.String, MCP.Status)
export const AuthStartResponse = Schema.Struct({
  authorizationUrl: Schema.String,
  oauthState: Schema.String,
})
export const AuthCallbackPayload = Schema.Struct({
  code: Schema.String,
})
export const AuthRemoveResponse = Schema.Struct({
  success: Schema.Literal(true),
})
export class UnsupportedOAuthError extends Schema.ErrorClass<UnsupportedOAuthError>("McpUnsupportedOAuthError")(
  { error: Schema.String },
  { httpApiStatus: 400 },
) {}
export class ManagementRequestError extends Schema.ErrorClass<ManagementRequestError>("McpManagementRequestError")(
  {
    code: Schema.String,
    error: Schema.String,
  },
  { httpApiStatus: 400 },
) {}

const managementMessages: Record<string, string> = {
  name_required: "MCP server name is required",
  name_invalid: "MCP server name is invalid",
  timeout_invalid: "MCP timeout must be a positive integer",
  command_required: "MCP command is required",
  row_incomplete: "MCP configuration row is incomplete",
  env_invalid: "MCP environment variable name is invalid",
  key_duplicate: "MCP configuration keys must be unique",
  url_invalid: "MCP URL must use HTTP or HTTPS",
  authorization_conflict: "Authorization must be configured through a bearer token environment variable",
  redirect_uri_invalid: "MCP OAuth redirect URI must use HTTP or HTTPS",
  read_only: "Addon-provided MCP servers are read-only",
  conflict: "An MCP server with this name already exists",
  write_failed: "MCP configuration could not be saved",
  name_mismatch: "MCP server name does not match request path",
}

export function managementErrorBody(code: string) {
  return {
    code,
    error: managementMessages[code] ?? "MCP management request failed",
  }
}

export const ManagementSuccess = Schema.Struct({ success: Schema.Literal(true) }).annotate({
  identifier: "McpManagementSuccess",
})

export const McpPaths = {
  status: "/mcp",
  manage: "/mcp/manage",
  manageGet: "/mcp/manage/:name",
  manageSave: "/mcp/manage/save",
  manageToggle: "/mcp/manage/:name/toggle",
  auth: "/mcp/:name/auth",
  authCallback: "/mcp/:name/auth/callback",
  authAuthenticate: "/mcp/:name/auth/authenticate",
  connect: "/mcp/:name/connect",
  disconnect: "/mcp/:name/disconnect",
} as const

export const McpApi = HttpApi.make("mcp")
  .add(
    HttpApiGroup.make("mcp")
      .add(
        HttpApiEndpoint.get("status", McpPaths.status, {
          success: described(Schema.Record(Schema.String, MCP.Status), "MCP server status"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "mcp.status",
            summary: "Get MCP status",
            description: "Get the status of all Model Context Protocol (MCP) servers.",
          }),
        ),
        HttpApiEndpoint.post("add", McpPaths.status, {
          payload: AddPayload,
          success: described(StatusMap, "MCP server added successfully"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "mcp.add",
            summary: "Add MCP server",
            description: "Dynamically add a new Model Context Protocol (MCP) server to the system.",
          }),
        ),
        HttpApiEndpoint.get("managementList", McpPaths.manage, {
          success: described(Schema.Array(McpManagement.Item), "MCP servers available for visual management"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "mcp.management.list",
            summary: "List managed MCP servers",
            description: "List custom and addon-provided MCP servers with their management capabilities.",
          }),
        ),
        HttpApiEndpoint.get("managementGet", McpPaths.manageGet, {
          params: { name: Schema.String },
          success: described(McpManagement.Detail, "MCP server management detail"),
          error: [ManagementRequestError, HttpApiError.NotFound],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "mcp.management.get",
            summary: "Get managed MCP server",
            description: "Get an MCP server's editable configuration without resolving secret environment values.",
          }),
        ),
        HttpApiEndpoint.post("managementSave", McpPaths.manageSave, {
          payload: McpManagement.SaveInput,
          success: described(McpManagement.Detail, "Saved MCP server management detail"),
          error: [ManagementRequestError, HttpApiError.NotFound],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "mcp.management.save",
            summary: "Save managed MCP server",
            description: "Create, update, or rename a custom MCP server.",
          }),
        ),
        HttpApiEndpoint.delete("managementRemove", McpPaths.manageGet, {
          params: { name: Schema.String },
          success: described(ManagementSuccess, "MCP server removed"),
          error: [ManagementRequestError, HttpApiError.NotFound],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "mcp.management.remove",
            summary: "Remove managed MCP server",
            description: "Remove a custom MCP server.",
          }),
        ),
        HttpApiEndpoint.post("managementToggle", McpPaths.manageToggle, {
          params: { name: Schema.String },
          payload: McpManagement.ToggleInput,
          success: described(ManagementSuccess, "MCP server enabled state updated"),
          error: [ManagementRequestError, HttpApiError.NotFound],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "mcp.management.toggle",
            summary: "Toggle managed MCP server",
            description: "Enable or disable a custom or addon-provided MCP server.",
          }),
        ),
        HttpApiEndpoint.post("authStart", McpPaths.auth, {
          params: { name: Schema.String },
          success: described(AuthStartResponse, "OAuth flow started"),
          error: [UnsupportedOAuthError, HttpApiError.NotFound],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "mcp.auth.start",
            summary: "Start MCP OAuth",
            description: "Start OAuth authentication flow for a Model Context Protocol (MCP) server.",
          }),
        ),
        HttpApiEndpoint.post("authCallback", McpPaths.authCallback, {
          params: { name: Schema.String },
          payload: AuthCallbackPayload,
          success: described(MCP.Status, "OAuth authentication completed"),
          error: [HttpApiError.BadRequest, HttpApiError.NotFound],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "mcp.auth.callback",
            summary: "Complete MCP OAuth",
            description:
              "Complete OAuth authentication for a Model Context Protocol (MCP) server using the authorization code.",
          }),
        ),
        HttpApiEndpoint.post("authAuthenticate", McpPaths.authAuthenticate, {
          params: { name: Schema.String },
          success: described(MCP.Status, "OAuth authentication completed"),
          error: [UnsupportedOAuthError, HttpApiError.NotFound],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "mcp.auth.authenticate",
            summary: "Authenticate MCP OAuth",
            description: "Start OAuth flow and wait for callback (opens browser).",
          }),
        ),
        HttpApiEndpoint.delete("authRemove", McpPaths.auth, {
          params: { name: Schema.String },
          success: described(AuthRemoveResponse, "OAuth credentials removed"),
          error: HttpApiError.NotFound,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "mcp.auth.remove",
            summary: "Remove MCP OAuth",
            description: "Remove OAuth credentials for an MCP server.",
          }),
        ),
        HttpApiEndpoint.post("connect", McpPaths.connect, {
          params: { name: Schema.String },
          success: described(Schema.Boolean, "MCP server connected successfully"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "mcp.connect",
            description: "Connect an MCP server.",
          }),
        ),
        HttpApiEndpoint.post("disconnect", McpPaths.disconnect, {
          params: { name: Schema.String },
          success: described(Schema.Boolean, "MCP server disconnected successfully"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "mcp.disconnect",
            description: "Disconnect an MCP server.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "mcp",
          description: "Experimental HttpApi MCP routes.",
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
