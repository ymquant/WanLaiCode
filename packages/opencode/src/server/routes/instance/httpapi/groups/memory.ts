import { Memory } from "@/memory"
import { SessionID } from "@/session/schema"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Schema } from "effect"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware } from "../middleware/workspace-routing"
import { described } from "./metadata"

const root = "/memory"

export const MemoryConfig = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
  default_mode: Schema.optional(Schema.Literals(["auto", "read_only", "off"])),
  max_prompt_entries: Schema.optional(Schema.Number),
  max_prompt_chars: Schema.optional(Schema.Number),
})

export const MemoryListQuery = Schema.Struct({
  scope: Schema.optional(Memory.Scope),
  search: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.NumberFromString),
})

export const MemoryResetPayload = Memory.ResetInput
export const MemoryCreatePayload = Schema.Struct({
  scope: Memory.Scope,
  content: Schema.String,
  sessionID: SessionID,
})
export const MemoryUpdatePayload = Schema.Struct({
  document: Schema.String,
})

export const MemoryPaths = {
  list: root,
  create: root,
  get: `${root}/:memoryID`,
  update: `${root}/:memoryID`,
  remove: `${root}/:memoryID`,
  reset: `${root}/reset`,
  config: `${root}/config`,
} as const

export const MemoryApi = HttpApi.make("memory")
  .add(
    HttpApiGroup.make("memory")
      .add(
        HttpApiEndpoint.get("list", MemoryPaths.list, {
          query: MemoryListQuery,
          success: described(Schema.Array(Memory.Entry), "List memory index entries"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(OpenApi.annotations({ identifier: "memory.list", summary: "List memory index entries" })),
        HttpApiEndpoint.post("create", MemoryPaths.create, {
          payload: MemoryCreatePayload,
          success: described(Memory.Detail, "Created processed memory"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(OpenApi.annotations({ identifier: "memory.create", summary: "Create processed memory" })),
        HttpApiEndpoint.get("get", MemoryPaths.get, {
          params: { memoryID: Memory.MemoryID },
          success: described(Memory.Detail, "Memory detail"),
          error: [HttpApiError.BadRequest, HttpApiError.NotFound],
        }).annotateMerge(OpenApi.annotations({ identifier: "memory.get", summary: "Get memory detail" })),
        HttpApiEndpoint.patch("update", MemoryPaths.update, {
          params: { memoryID: Memory.MemoryID },
          payload: MemoryUpdatePayload,
          success: described(Memory.Detail, "Updated memory detail"),
          error: [HttpApiError.BadRequest, HttpApiError.NotFound],
        }).annotateMerge(OpenApi.annotations({ identifier: "memory.update", summary: "Update memory detail" })),
        HttpApiEndpoint.delete("remove", MemoryPaths.remove, {
          params: { memoryID: Memory.MemoryID },
          success: described(Schema.Boolean, "Deleted memory"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(OpenApi.annotations({ identifier: "memory.delete", summary: "Delete memory" })),
        HttpApiEndpoint.post("reset", MemoryPaths.reset, {
          payload: MemoryResetPayload,
          success: described(Schema.Boolean, "Reset memories"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(OpenApi.annotations({ identifier: "memory.reset", summary: "Reset memories" })),
        HttpApiEndpoint.get("getConfig", MemoryPaths.config, {
          success: described(MemoryConfig, "Get memory config"),
        }).annotateMerge(OpenApi.annotations({ identifier: "memory.config.get", summary: "Get memory config" })),
        HttpApiEndpoint.patch("updateConfig", MemoryPaths.config, {
          payload: MemoryConfig,
          success: described(MemoryConfig, "Update memory config"),
        }).annotateMerge(OpenApi.annotations({ identifier: "memory.config.update", summary: "Update memory config" })),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
