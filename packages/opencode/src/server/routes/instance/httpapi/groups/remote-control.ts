import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { described } from "./metadata"

// 公开 DTO 只包含 renderer 展示所需的短期配对状态和设备摘要，不暴露长期设备凭证。
const Pairing = Schema.Struct({
  pairing_id: Schema.String,
  secret: Schema.String,
  expires_at: Schema.String,
  qr: Schema.String,
})

const Connection = Schema.Struct({
  id: Schema.String,
  device_id: Schema.String,
  name: Schema.String,
  platform: Schema.optional(Schema.String),
  online: Schema.Boolean,
  last_connected_at: Schema.optional(Schema.String),
})

const Status = Schema.Struct({
  state: Schema.Literals(["auth_required", "disconnected", "connecting", "connected", "error"]),
  device_id: Schema.String,
  device_name: Schema.String,
  error: Schema.optional(Schema.String),
  pairing: Schema.optional(Pairing),
  pending_pairings: Schema.Array(
    Schema.Struct({
      pairing_id: Schema.String,
      name: Schema.String,
      platform: Schema.optional(Schema.String),
      requested_at: Schema.optional(Schema.String),
    }),
  ),
  connections: Schema.Array(Connection),
})

export const RemoteControlPaths = {
  status: "/global/remote-control/status",
  pairings: "/global/remote-control/pairings",
  pairingApprove: "/global/remote-control/pairings/:pairingID/approve",
  pairingReject: "/global/remote-control/pairings/:pairingID/reject",
  connections: "/global/remote-control/connections",
  connection: "/global/remote-control/connections/:connectionID",
} as const

// Effect HttpApi 与 Hono 使用同一公开形状，防止切换服务后端时设置页行为分叉。
export const RemoteControlApi = HttpApi.make("remoteControl").add(
  HttpApiGroup.make("remoteControl")
    .add(
      HttpApiEndpoint.get("status", RemoteControlPaths.status, {
        success: described(Status, "Remote control status"),
      }).annotateMerge(
        OpenApi.annotations({ identifier: "remoteControl.status", summary: "Get remote control status" }),
      ),
      HttpApiEndpoint.post("pairingCreate", RemoteControlPaths.pairings, {
        success: described(Pairing, "Pairing created"),
      }).annotateMerge(OpenApi.annotations({ identifier: "remoteControl.pairing.create", summary: "Create pairing" })),
      HttpApiEndpoint.post("pairingApprove", RemoteControlPaths.pairingApprove, {
        params: { pairingID: Schema.String },
        success: Schema.Boolean,
      }).annotateMerge(
        OpenApi.annotations({ identifier: "remoteControl.pairing.approve", summary: "Approve pairing" }),
      ),
      HttpApiEndpoint.post("pairingReject", RemoteControlPaths.pairingReject, {
        params: { pairingID: Schema.String },
        success: Schema.Boolean,
      }).annotateMerge(OpenApi.annotations({ identifier: "remoteControl.pairing.reject", summary: "Reject pairing" })),
      HttpApiEndpoint.get("connectionList", RemoteControlPaths.connections, {
        success: described(Schema.Array(Connection), "Connected devices"),
      }).annotateMerge(
        OpenApi.annotations({ identifier: "remoteControl.connection.list", summary: "List connections" }),
      ),
      HttpApiEndpoint.delete("connectionRemove", RemoteControlPaths.connection, {
        params: { connectionID: Schema.String },
        success: Schema.Boolean,
      }).annotateMerge(
        OpenApi.annotations({ identifier: "remoteControl.connection.remove", summary: "Remove connection" }),
      ),
    )
    // Effect HttpApi 不经过 Hono 全局中间件，因此远控管理组必须显式校验本地 sidecar 凭证。
    .middleware(Authorization)
    .annotateMerge(OpenApi.annotations({ title: "Remote control", description: "Desktop remote control management." })),
)
