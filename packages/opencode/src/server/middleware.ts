import { NamedError } from "@opencode-ai/core/util/error"
import { Session } from "@/session/session"
import type { ErrorHandler, MiddlewareHandler } from "hono"
import { HTTPException } from "hono/http-exception"
import * as Log from "@opencode-ai/core/util/log"
import { Flag } from "@opencode-ai/core/flag/flag"
import { basicAuth } from "hono/basic-auth"
import { cors } from "hono/cors"
import { compress } from "hono/compress"
import * as ServerBackend from "./backend"
import { isAllowedCorsOrigin, type CorsOptions } from "./cors"
import { publicErrorResponse } from "./public-error-response"
import { isPtyConnectPath, PTY_CONNECT_TICKET_QUERY } from "./shared/pty-ticket"
import { isPublicUIPath } from "./shared/public-ui"

const log = Log.create({ service: "server" })

export const ErrorMiddleware: ErrorHandler = (err, c) => {
  log.error("failed", {
    error: err,
  })
  const response = publicErrorResponse(err)
  if (response) return c.json(response.body, { status: response.status })
  if (err instanceof Session.BusyError) {
    return c.json(new NamedError.Unknown({ message: err.message }).toObject(), { status: 400 })
  }
  if (err instanceof HTTPException) return err.getResponse()
  return c.json(
    { name: "InternalError", data: { reason: "INTERNAL_ERROR", message: "Internal server error" } },
    { status: 500 },
  )
}

export const AuthMiddleware: MiddlewareHandler = (c, next) => {
  // Allow CORS preflight requests to succeed without auth.
  // Browser clients sending Authorization headers will preflight with OPTIONS.
  if (c.req.method === "OPTIONS") return next()
  const password = Flag.WANLAICODE_SERVER_PASSWORD
  if (!password) return next()
  if (isPublicUIPath(c.req.method, c.req.path)) return next()
  if (isPtyConnectPath(c.req.path) && c.req.query(PTY_CONNECT_TICKET_QUERY)) return next()
  const username = Flag.WANLAICODE_SERVER_USERNAME ?? "wanlaicode"

  if (c.req.query("auth_token")) c.req.raw.headers.set("authorization", `Basic ${c.req.query("auth_token")}`)

  return basicAuth({ username, password })(c, next)
}

export function LoggerMiddleware(backendAttributes: ServerBackend.Attributes): MiddlewareHandler {
  return async (c, next) => {
    const skip = c.req.path === "/log"
    if (skip) return next()
    const attributes = {
      method: c.req.method,
      path: c.req.path,
      // If this logger grows full-URL fields, redact auth_token and ticket query params.
      ...backendAttributes,
    }
    log.info("request", attributes)
    const timer = log.time("request", attributes)
    await next()
    timer.stop()
  }
}

export function CorsMiddleware(opts?: CorsOptions): MiddlewareHandler {
  return cors({
    maxAge: 86_400,
    origin(input) {
      if (isAllowedCorsOrigin(input, opts)) return input
    },
  })
}

const zipped = compress()
export const CompressionMiddleware: MiddlewareHandler = (c, next) => {
  const path = c.req.path
  const method = c.req.method
  if (path === "/event" || path === "/global/event") return next()
  if (method === "POST" && /\/session\/[^/]+\/(message|prompt_async)$/.test(path)) return next()
  return zipped(c, next)
}
