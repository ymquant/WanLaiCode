import { GlobalBus } from "@/bus/global"
import { PermissionMode } from "@/permission/mode"
import { InstanceStore } from "@/project/instance-store"
import * as Log from "@opencode-ai/core/util/log"
import { Effect, Schema } from "effect"
import { Event } from "./event"

const log = Log.create({ service: "server" })
const hotConfigKeys = new Set(["instruction_import", "permission_mode", "rules"])

export function shouldDisposeAfterGlobalConfigUpdate(config: Record<string, unknown>) {
  return Object.keys(config).some((key) => !hotConfigKeys.has(key))
}

export function afterGlobalConfigUpdate(input: {
  changed: boolean
  config: Record<string, unknown>
  dispose: () => unknown
}) {
  if (!input.changed) return
  const keys = Object.keys(input.config)
  if (keys.length === 1 && keys[0] === "permission_mode") {
    GlobalBus.emit("event", {
      directory: "global",
      payload: {
        type: PermissionMode.Event.Updated.type,
        properties: {
          mode: PermissionMode.resolve(
            Schema.decodeUnknownSync(Schema.optional(PermissionMode.Info))(input.config.permission_mode),
          ),
        },
      },
    })
    return
  }
  GlobalBus.emit("event", {
    directory: "global",
    payload: {
      type: Event.ConfigUpdated.type,
      properties: {},
    },
  })
  if (!shouldDisposeAfterGlobalConfigUpdate(input.config)) return
  input.dispose()
}

export const emitGlobalDisposed = Effect.sync(() =>
  GlobalBus.emit("event", {
    directory: "global",
    payload: {
      type: Event.Disposed.type,
      properties: {},
    },
  }),
)

export const disposeAllInstancesAndEmitGlobalDisposed = Effect.fn("Server.disposeAllInstancesAndEmitGlobalDisposed")(
  function* (options?: { swallowErrors?: boolean }) {
    const store = yield* InstanceStore.Service
    yield* Effect.gen(function* () {
      yield* options?.swallowErrors
        ? store.disposeAll().pipe(
            Effect.catchCause((cause) =>
              Effect.sync(() => {
                log.warn("global disposal failed", { cause })
              }),
            ),
          )
        : store.disposeAll()
      yield* emitGlobalDisposed
    }).pipe(Effect.uninterruptible)
  },
)

export * as GlobalLifecycle from "./global-lifecycle"
