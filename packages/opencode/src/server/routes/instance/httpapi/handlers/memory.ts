import { Config } from "@/config/config"
import { MemoryProcessor, MemoryStore } from "@/memory"
import { NotFoundError } from "@/storage/storage"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { MemoryConfig, MemoryListQuery, MemoryResetPayload, MemoryUpdatePayload } from "../groups/memory"
import { markInstanceForDisposal } from "../lifecycle"
import * as InstanceState from "@/effect/instance-state"

const defaults = {
  enabled: true,
  default_mode: "auto" as const,
  max_prompt_entries: 8,
  max_prompt_chars: 4000,
}

function badRequest<E, A, R>(effect: Effect.Effect<A, E, R>) {
  return effect.pipe(Effect.mapError(() => new HttpApiError.BadRequest({})))
}

function detailError(error: unknown) {
  if (NotFoundError.isInstance(error)) return new HttpApiError.NotFound({})
  return new HttpApiError.BadRequest({})
}

export const memoryHandlers = HttpApiBuilder.group(InstanceHttpApi, "memory", (handlers) =>
  Effect.gen(function* () {
    const store = yield* MemoryStore.Service
    const processor = yield* MemoryProcessor.Service
    const config = yield* Config.Service

    const list = Effect.fn("MemoryHttpApi.list")(function* (ctx: { query: typeof MemoryListQuery.Type }) {
      return yield* badRequest(
        store.list({ scope: ctx.query.scope, search: ctx.query.search, limit: ctx.query.limit }),
      )
    })

    const create = Effect.fn("MemoryHttpApi.create")(function* (ctx: {
      payload: { scope: "global" | "project"; content: string; sessionID: Parameters<MemoryProcessor.Interface["process"]>[0]["sessionID"] }
    }) {
      const cfg = yield* config.getGlobal()
      const mode = cfg.memory?.default_mode ?? "auto"
      if (cfg.memory?.enabled === false || mode === "off" || mode === "read_only") {
        return yield* Effect.fail(new HttpApiError.BadRequest({}))
      }
      const draft = yield* badRequest(
        processor.process({ content: ctx.payload.content, sessionID: ctx.payload.sessionID }),
      )
      return yield* badRequest(store.create({ scope: ctx.payload.scope, draft }))
    })

    const get = Effect.fn("MemoryHttpApi.get")(function* (ctx: { params: { memoryID: Parameters<MemoryStore.Interface["get"]>[0] } }) {
      return yield* store.get(ctx.params.memoryID).pipe(Effect.mapError(detailError))
    })

    const update = Effect.fn("MemoryHttpApi.update")(function* (ctx: {
      params: { memoryID: Parameters<MemoryStore.Interface["get"]>[0] }
      payload: typeof MemoryUpdatePayload.Type
    }) {
      return yield* store
        .update({ id: ctx.params.memoryID, document: ctx.payload.document })
        .pipe(Effect.mapError(detailError))
    })

    const remove = Effect.fn("MemoryHttpApi.remove")(function* (ctx: {
      params: { memoryID: Parameters<MemoryStore.Interface["remove"]>[0] }
    }) {
      yield* badRequest(store.remove(ctx.params.memoryID))
      return true
    })

    const reset = Effect.fn("MemoryHttpApi.reset")(function* (ctx: { payload: typeof MemoryResetPayload.Type }) {
      yield* badRequest(store.reset(ctx.payload))
      return true
    })

    const getConfig = Effect.fn("MemoryHttpApi.getConfig")(function* () {
      const cfg = yield* config.getGlobal()
      return { ...defaults, ...cfg.memory }
    })

    const updateConfig = Effect.fn("MemoryHttpApi.updateConfig")(function* (ctx: { payload: typeof MemoryConfig.Type }) {
      const cfg = yield* config.getGlobal()
      const updated = yield* config.updateGlobal({ memory: { ...cfg.memory, ...ctx.payload } })
      yield* markInstanceForDisposal(yield* InstanceState.context, "memory-config-update")
      return { ...defaults, ...updated.info.memory }
    })

    return handlers
      .handle("list", list)
      .handle("create", create)
      .handle("get", get)
      .handle("update", update)
      .handle("remove", remove)
      .handle("reset", reset)
      .handle("getConfig", getConfig)
      .handle("updateConfig", updateConfig)
  }),
)
