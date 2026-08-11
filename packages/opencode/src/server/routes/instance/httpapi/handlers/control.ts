import { Auth } from "@/auth"
import { ProviderID } from "@/provider/schema"
import { RemoteControlGateway } from "@/remote-control/gateway"
import * as Log from "@opencode-ai/core/util/log"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { RootHttpApi } from "../api"
import { LogInput } from "../groups/control"

export const controlHandlers = HttpApiBuilder.group(RootHttpApi, "control", (handlers) =>
  Effect.gen(function* () {
    const auth = yield* Auth.Service

    const authSet = Effect.fn("ControlHttpApi.authSet")(function* (ctx: {
      params: { providerID: ProviderID }
      payload: Auth.Info
    }) {
      yield* auth.set(ctx.params.providerID, ctx.payload).pipe(Effect.orDie)
      // Effect HttpApi 与 Hono 登录入口保持一致，账号写入后立刻切换远控连接。
      if (ctx.params.providerID === "wanlaicode") yield* Effect.promise(() => RemoteControlGateway.authChanged())
      return true
    })

    const authRemove = Effect.fn("ControlHttpApi.authRemove")(function* (ctx: { params: { providerID: ProviderID } }) {
      yield* auth.remove(ctx.params.providerID).pipe(Effect.orDie)
      // 退出时先清理旧账号 WS 和设备白名单，再向 renderer 返回成功。
      if (ctx.params.providerID === "wanlaicode") yield* Effect.promise(() => RemoteControlGateway.authChanged())
      return true
    })

    const log = Effect.fn("ControlHttpApi.log")(function* (ctx: { payload: typeof LogInput.Type }) {
      const logger = Log.create({ service: ctx.payload.service })
      logger[ctx.payload.level](ctx.payload.message, ctx.payload.extra)
      return true
    })

    return handlers.handle("authSet", authSet).handle("authRemove", authRemove).handle("log", log)
  }),
)
