import { Config } from "@/config/config"
import { Memory, MemoryProcessor, MemoryStore } from "@/memory"
import { Effect, Schema } from "effect"
import * as Tool from "./tool"

const Parameters = Schema.Struct({
  content: Schema.String.annotate({ description: "The clear preference, correction, fact, or workflow to remember." }),
  scope: Schema.optional(Memory.Scope).annotate({ description: "Where this memory applies. Defaults to project." }),
})

type Metadata = {
  saved: boolean
  memoryID?: string
  reason?: string
}

export const MemoryTool = Tool.define<
  typeof Parameters,
  Metadata,
  MemoryStore.Service | MemoryProcessor.Service | Config.Service
>(
  "memory",
  Effect.gen(function* () {
    const store = yield* MemoryStore.Service
    const processor = yield* MemoryProcessor.Service
    const config = yield* Config.Service

    return {
      description: [
        "Save a clear, reusable memory for future WanlaiCode sessions.",
        "Use this when the user explicitly asks you to remember something, or gives a very clear correction that should apply later.",
        "The input is automatically rewritten into a durable title, summary, and detailed document using the current session model.",
        "Do not use this for ambiguous preferences; ask the user in normal conversation whether to remember those.",
      ].join("\n"),
      parameters: Parameters,
      execute: (params, ctx) =>
        Effect.gen(function* () {
          const cfg = yield* config.getGlobal()
          if (cfg.memory?.enabled === false) {
            return {
              title: "Memory disabled",
              output: "Memory is disabled, so nothing was saved.",
              metadata: { saved: false, reason: "disabled" },
            }
          }

          const mode = cfg.memory?.default_mode ?? "auto"
          if (mode === "off" || mode === "read_only") {
            return {
              title: "Memory not saved",
              output: `Memory mode is ${mode}, so nothing was saved.`,
              metadata: { saved: false, reason: mode },
            }
          }

          const draft = yield* processor.process({
            content: params.content.trim(),
            sessionID: ctx.sessionID,
            messages: ctx.messages,
            abort: ctx.abort,
          })
          const saved = yield* store.create({ scope: params.scope ?? "project", draft })

          return {
            title: "Memory saved",
            output: `Saved memory: ${saved.title}\n${saved.summary}`,
            metadata: { saved: true, memoryID: saved.id },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
