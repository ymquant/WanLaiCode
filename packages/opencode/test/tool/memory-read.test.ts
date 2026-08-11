import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { Global } from "@opencode-ai/core/global"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"

import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { MemoryStore } from "@/memory"
import { MessageID, SessionID } from "@/session/schema"
import { MemoryReadTool } from "@/tool/memory-read"
import { Truncate } from "@/tool/truncate"
import { provideTmpdirInstance } from "../fixture/fixture"

const layer = Layer.mergeAll(
  MemoryStore.defaultLayer,
  Config.defaultLayer,
  Truncate.defaultLayer,
  Agent.defaultLayer,
  CrossSpawnSpawner.defaultLayer,
)

function isolateGlobalData(dir: string) {
  const previous = Global.Path.data
  return Effect.gen(function* () {
    const target = path.join(dir, "global-data")
    yield* Effect.promise(() => mkdir(target, { recursive: true }))
    ;(Global.Path as { data: string }).data = target
    yield* Effect.addFinalizer(() => Effect.sync(() => ((Global.Path as { data: string }).data = previous)))
  })
}

const ctx = {
  sessionID: SessionID.descending(),
  messageID: MessageID.ascending(),
  agent: "build",
  abort: new AbortController().signal,
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

describe("memory_read tool", () => {
  test("reads a detail registered in the current project index", async () => {
    await Effect.runPromise(
      provideTmpdirInstance((dir) =>
        Effect.gen(function* () {
          yield* isolateGlobalData(dir)
          const store = yield* MemoryStore.Service
          yield* store.create({
            scope: "project",
            draft: {
              name: "run-package-tests",
              title: "Run package tests",
              summary: "Run tests from the package directory",
              detail: "Use the package-local Bun command.",
            },
          })
          const tool = yield* MemoryReadTool
          const def = yield* tool.init()
          const result = yield* def.execute({ scope: "project", name: "run-package-tests" }, ctx)

          expect(result.metadata.found).toBe(true)
          expect(result.output).toContain("# Run package tests")
          expect(result.output).toContain("Use the package-local Bun command.")
        }),
      ).pipe(Effect.scoped, Effect.provide(layer)),
    )
  })

  test("does not read invalid or unindexed names", async () => {
    await Effect.runPromise(
      provideTmpdirInstance((dir) =>
        Effect.gen(function* () {
          yield* isolateGlobalData(dir)
          const tool = yield* MemoryReadTool
          const def = yield* tool.init()
          const invalid = yield* def.execute({ scope: "project", name: "../secret" }, ctx)
          const missing = yield* def.execute({ scope: "project", name: "not-indexed" }, ctx)

          expect(invalid.metadata.found).toBe(false)
          expect(missing.metadata.found).toBe(false)
          expect(invalid.output).toContain("not found")
          expect(missing.output).toContain("not found")
        }),
      ).pipe(Effect.scoped, Effect.provide(layer)),
    )
  })
})
