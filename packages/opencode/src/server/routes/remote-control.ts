import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { RemoteControlGateway } from "@/remote-control/gateway"
import { lazy } from "@/util/lazy"

// 本地公开 schema 只描述短期配对二维码和设备摘要，长期 OAuth/device token 不进入 SDK。
const pairing = z.object({
  pairing_id: z.string(),
  secret: z.string(),
  expires_at: z.string(),
  qr: z.string(),
})

const connection = z.object({
  id: z.string(),
  device_id: z.string(),
  name: z.string(),
  platform: z.string().optional(),
  online: z.boolean(),
  last_connected_at: z.string().optional(),
})

const status = z.object({
  state: z.enum(["auth_required", "disconnected", "connecting", "connected", "error"]),
  device_id: z.string(),
  device_name: z.string(),
  error: z.string().optional(),
  pairing: pairing.optional(),
  pending_pairings: z.array(
    z.object({
      pairing_id: z.string(),
      name: z.string(),
      platform: z.string().optional(),
      requested_at: z.string().optional(),
    }),
  ),
  connections: z.array(connection),
})

// renderer 只能访问这些裁剪后的管理接口，OAuth 和 device_token 始终留在 sidecar 内部。
export const RemoteControlRoutes = lazy(() =>
  new Hono()
    // 状态查询供设置页轮询，沿用 Server 顶层 AuthMiddleware 的随机 sidecar 密码保护。
    .get(
      "/status",
      describeRoute({
        operationId: "remoteControl.status",
        summary: "Get remote control status",
        responses: {
          200: { description: "Remote control status", content: { "application/json": { schema: resolver(status) } } },
        },
      }),
      (context) => context.json(RemoteControlGateway.status()),
    )
    // 配对和连接变更均在 main process 内完成，renderer 只提交不敏感的资源 ID。
    .post(
      "/pairings",
      describeRoute({
        operationId: "remoteControl.pairing.create",
        summary: "Create remote control pairing",
        responses: {
          200: { description: "Pairing created", content: { "application/json": { schema: resolver(pairing) } } },
        },
      }),
      async (context) => context.json(await RemoteControlGateway.createPairing()),
    )
    .post(
      "/pairings/:pairingID/approve",
      describeRoute({
        operationId: "remoteControl.pairing.approve",
        summary: "Approve remote control pairing",
        responses: {
          200: { description: "Pairing approved", content: { "application/json": { schema: resolver(z.boolean()) } } },
        },
      }),
      validator("param", z.object({ pairingID: z.string() })),
      async (context) => {
        await RemoteControlGateway.approvePairing(context.req.valid("param").pairingID)
        return context.json(true)
      },
    )
    .post(
      "/pairings/:pairingID/reject",
      describeRoute({
        operationId: "remoteControl.pairing.reject",
        summary: "Reject remote control pairing",
        responses: {
          200: { description: "Pairing rejected", content: { "application/json": { schema: resolver(z.boolean()) } } },
        },
      }),
      validator("param", z.object({ pairingID: z.string() })),
      async (context) => {
        await RemoteControlGateway.rejectPairing(context.req.valid("param").pairingID)
        return context.json(true)
      },
    )
    .get(
      "/connections",
      describeRoute({
        operationId: "remoteControl.connection.list",
        summary: "List remote control connections",
        responses: {
          200: {
            description: "Connected devices",
            content: { "application/json": { schema: resolver(connection.array()) } },
          },
        },
      }),
      async (context) => context.json(await RemoteControlGateway.listConnections()),
    )
    .delete(
      "/connections/:connectionID",
      describeRoute({
        operationId: "remoteControl.connection.remove",
        summary: "Remove remote control connection",
        responses: {
          200: {
            description: "Connection removed",
            content: { "application/json": { schema: resolver(z.boolean()) } },
          },
        },
      }),
      validator("param", z.object({ connectionID: z.string() })),
      async (context) => {
        await RemoteControlGateway.removeConnection(context.req.valid("param").connectionID)
        return context.json(true)
      },
    ),
)
