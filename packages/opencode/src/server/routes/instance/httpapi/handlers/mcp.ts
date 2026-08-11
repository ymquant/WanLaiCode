import { MCP } from "@/mcp"
import * as McpManagement from "@/mcp/management"
import { Effect, Schema } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import {
  AddPayload,
  AuthCallbackPayload,
  managementErrorBody,
  ManagementRequestError,
  StatusMap,
  UnsupportedOAuthError,
} from "../groups/mcp"

function managementRequestError(code: string) {
  return new ManagementRequestError(managementErrorBody(code))
}

function managementError(error: McpManagement.ManagementError) {
  if (error.code === "not_found") return new HttpApiError.NotFound({})
  return managementRequestError(error.code)
}

export const mcpHandlers = HttpApiBuilder.group(InstanceHttpApi, "mcp", (handlers) =>
  Effect.gen(function* () {
    const mcp = yield* MCP.Service
    const management = yield* McpManagement.Service

    const status = Effect.fn("McpHttpApi.status")(function* () {
      return yield* mcp.status()
    })

    const add = Effect.fn("McpHttpApi.add")(function* (ctx: { payload: typeof AddPayload.Type }) {
      const result = (yield* mcp.add(ctx.payload.name, ctx.payload.config)).status
      return yield* Schema.decodeUnknownEffect(StatusMap)(
        "status" in result ? { [ctx.payload.name]: result } : result,
      ).pipe(Effect.mapError(() => new HttpApiError.BadRequest({})))
    })

    const authStart = Effect.fn("McpHttpApi.authStart")(function* (ctx: { params: { name: string } }) {
      if (!(yield* mcp.supportsOAuth(ctx.params.name))) {
        return yield* new UnsupportedOAuthError({ error: `MCP server ${ctx.params.name} does not support OAuth` })
      }
      return yield* mcp.startAuth(ctx.params.name)
    })

    const authCallback = Effect.fn("McpHttpApi.authCallback")(function* (ctx: {
      params: { name: string }
      payload: typeof AuthCallbackPayload.Type
    }) {
      return yield* mcp.finishAuth(ctx.params.name, ctx.payload.code)
    })

    const authAuthenticate = Effect.fn("McpHttpApi.authAuthenticate")(function* (ctx: { params: { name: string } }) {
      if (!(yield* mcp.supportsOAuth(ctx.params.name))) {
        return yield* new UnsupportedOAuthError({ error: `MCP server ${ctx.params.name} does not support OAuth` })
      }
      return yield* mcp.authenticate(ctx.params.name)
    })

    const authRemove = Effect.fn("McpHttpApi.authRemove")(function* (ctx: { params: { name: string } }) {
      yield* mcp.removeAuth(ctx.params.name)
      return { success: true as const }
    })

    const connect = Effect.fn("McpHttpApi.connect")(function* (ctx: { params: { name: string } }) {
      yield* mcp.connect(ctx.params.name)
      return true
    })

    const disconnect = Effect.fn("McpHttpApi.disconnect")(function* (ctx: { params: { name: string } }) {
      yield* mcp.disconnect(ctx.params.name)
      return true
    })

    const managementList = Effect.fn("McpHttpApi.managementList")(function* () {
      return yield* management.list()
    })

    const managementGet = Effect.fn("McpHttpApi.managementGet")(function* (ctx: { params: { name: string } }) {
      return yield* management.get(ctx.params.name).pipe(Effect.mapError(managementError))
    })

    const managementSave = Effect.fn("McpHttpApi.managementSave")(function* (ctx: {
      payload: McpManagement.SaveInput
    }) {
      return yield* management.save(ctx.payload).pipe(Effect.mapError(managementError))
    })

    const managementRemove = Effect.fn("McpHttpApi.managementRemove")(function* (ctx: {
      params: { name: string }
    }) {
      yield* management.remove(ctx.params.name).pipe(Effect.mapError(managementError))
      return { success: true as const }
    })

    const managementToggle = Effect.fn("McpHttpApi.managementToggle")(function* (ctx: {
      params: { name: string }
      payload: McpManagement.ToggleInput
    }) {
      if (ctx.params.name !== ctx.payload.name) return yield* managementRequestError("name_mismatch")
      yield* management.toggle(ctx.params.name, ctx.payload.enabled).pipe(Effect.mapError(managementError))
      return { success: true as const }
    })

    return handlers
      .handle("status", status)
      .handle("add", add)
      .handle("managementList", managementList)
      .handle("managementGet", managementGet)
      .handle("managementSave", managementSave)
      .handle("managementRemove", managementRemove)
      .handle("managementToggle", managementToggle)
      .handle("authStart", authStart)
      .handle("authCallback", authCallback)
      .handle("authAuthenticate", authAuthenticate)
      .handle("authRemove", authRemove)
      .handle("connect", connect)
      .handle("disconnect", disconnect)
  }),
)
