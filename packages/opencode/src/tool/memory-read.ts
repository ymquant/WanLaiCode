import { Config } from "@/config/config"
import { Memory, MemoryStore } from "@/memory"
import { Effect, Schema } from "effect"
import * as Tool from "./tool"

const Parameters = Schema.Struct({
  scope: Memory.Scope.annotate({ description: "The scope shown in the memory index." }),
  name: Schema.String.annotate({ description: "The exact memory name shown in the memory index, without .md." }),
})

type Metadata = {
  found: boolean
  reason?: string
}

export const MemoryReadTool = Tool.define<typeof Parameters, Metadata, MemoryStore.Service | Config.Service>(
  "memory_read",
  Effect.gen(function* () {
    const store = yield* MemoryStore.Service
    const config = yield* Config.Service

    return {
      description: [
        "Read the full detail for an item shown in the WanlaiCode memory index.",
        "Use the exact scope and name from the index. Do not rely on a summary without reading its detail when it matters.",
        "Current user instructions and repository evidence take precedence over saved memory.",
      ].join("\n"),
      parameters: Parameters,
      execute: (params) =>
        Effect.gen(function* () {
          const cfg = yield* config.getGlobal()
          if (cfg.memory?.enabled === false || cfg.memory?.default_mode === "off") {
            return {
              title: "Memory unavailable",
              output: "Memory is disabled, so the detail was not read.",
              metadata: { found: false, reason: "disabled" },
            }
          }
          return yield* store.getByName(params).pipe(
            Effect.match({
              onFailure: () => ({
                title: "Memory not found",
                output: `Memory not found: ${params.scope}/${params.name}`,
                metadata: { found: false, reason: "not_found" },
              }),
              onSuccess: (detail) => ({
                title: detail.title,
                output: detail.document,
                metadata: { found: true },
              }),
            }),
          )
        }),
    }
  }),
)
