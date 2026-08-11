import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { RemoteControlGateway } from "@/remote-control/gateway"
import { RootHttpApi } from "../api"

// Promise 型 gateway 通过 Effect.promise 接入 HttpApi，公开响应中不包含任何长期凭证。
export const remoteControlHandlers = HttpApiBuilder.group(RootHttpApi, "remoteControl", (handlers) =>
  Effect.succeed(
    // 每个 handler 直接委托唯一 gateway，Hono/Effect 两套服务后端不会维护第二份远控状态。
    handlers
      .handle("status", () => Effect.sync(() => RemoteControlGateway.status()))
      .handle("pairingCreate", () => Effect.promise(() => RemoteControlGateway.createPairing()))
      .handle("pairingApprove", (context) =>
        Effect.promise(() => RemoteControlGateway.approvePairing(context.params.pairingID)).pipe(Effect.as(true)),
      )
      .handle("pairingReject", (context) =>
        Effect.promise(() => RemoteControlGateway.rejectPairing(context.params.pairingID)).pipe(Effect.as(true)),
      )
      .handle("connectionList", () => Effect.promise(() => RemoteControlGateway.listConnections()))
      .handle("connectionRemove", (context) =>
        Effect.promise(() => RemoteControlGateway.removeConnection(context.params.connectionID)).pipe(Effect.as(true)),
      ),
  ),
)
