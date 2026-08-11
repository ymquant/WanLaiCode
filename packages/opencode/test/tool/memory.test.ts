import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { Global } from "@opencode-ai/core/global"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"

import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { MemoryProcessor, MemoryStore } from "@/memory"
import type { Draft } from "@/memory/schema"
import { MessageID, SessionID } from "@/session/schema"
import { MemoryTool } from "@/tool/memory"
import { Truncate } from "@/tool/truncate"
import { TestConfig } from "../fixture/config"
import { resetDatabase } from "../fixture/db"
import { provideTmpdirInstance } from "../fixture/fixture"

const draft: Draft = {
  name: "run-package-tests",
  title: "Run package tests",
  summary: "Run tests from the target package directory",
  detail: "Use the package-local Bun test command.\n\n## Why\n\nThe root test guard rejects repository-root runs.",
}

const processor = Layer.succeed(
  MemoryProcessor.Service,
  MemoryProcessor.Service.of({ process: () => Effect.succeed(draft) }),
)

const layer = Layer.mergeAll(
  MemoryStore.defaultLayer,
  processor,
  Config.defaultLayer,
  Truncate.defaultLayer,
  Agent.defaultLayer,
  CrossSpawnSpawner.defaultLayer,
)

const ctx = {
  sessionID: SessionID.descending(),
  messageID: MessageID.ascending(),
  agent: "build",
  abort: new AbortController().signal,
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

beforeEach(resetDatabase)
afterEach(resetDatabase)

function isolateGlobalData(dir: string) {
  const previous = Global.Path.data
  return Effect.gen(function* () {
    const target = path.join(dir, "global-data")
    yield* Effect.promise(() => mkdir(target, { recursive: true }))
    ;(Global.Path as { data: string }).data = target
    yield* Effect.addFinalizer(() => Effect.sync(() => ((Global.Path as { data: string }).data = previous)))
  })
}

describe("memory tool", () => {
  test("saves processed project memory instead of the raw request", async () => {
    await Effect.runPromise(
      provideTmpdirInstance((dir) =>
        Effect.gen(function* () {
          yield* isolateGlobalData(dir)
          const store = yield* MemoryStore.Service
          const tool = yield* MemoryTool
          const def = yield* tool.init()
          const result = yield* def.execute({ content: "以后测试别在根目录跑" }, ctx)
          const listed = yield* store.list({ scope: "project" })
          const saved = yield* store.get(listed[0]!.id)

          expect(result.metadata.saved).toBe(true)
          expect(result.output).toContain(draft.title)
          expect(listed.map((item) => item.title)).toEqual([draft.title])
          expect(saved.document).toContain(draft.detail)
          expect(saved.document).not.toContain("以后测试别在根目录跑")
        }),
      ).pipe(Effect.scoped, Effect.provide(layer)),
    )
  })

  test("saves processed global memory in the global scope", async () => {
    await Effect.runPromise(
      provideTmpdirInstance((dir) =>
        Effect.gen(function* () {
          yield* isolateGlobalData(dir)
          const store = yield* MemoryStore.Service
          const tool = yield* MemoryTool
          const def = yield* tool.init()
          const result = yield* def.execute({ scope: "global", content: "所有项目都用 uv" }, ctx)

          expect(result.metadata.saved).toBe(true)
          expect((yield* store.list({ scope: "global" })).map((item) => item.name)).toEqual([draft.name])
          expect(yield* store.list({ scope: "project" })).toEqual([])
        }),
      ).pipe(Effect.scoped, Effect.provide(layer)),
    )
  })

  test("does not process or save in off and read-only modes", async () => {
    for (const default_mode of ["off", "read_only"] as const) {
      const modeLayer = Layer.mergeAll(
        MemoryStore.defaultLayer,
        processor,
        TestConfig.layer({ getGlobal: () => Effect.succeed({ memory: { default_mode } }) }),
        Truncate.defaultLayer,
        Agent.defaultLayer,
        CrossSpawnSpawner.defaultLayer,
      )
      await Effect.runPromise(
        provideTmpdirInstance((dir) =>
          Effect.gen(function* () {
            yield* isolateGlobalData(dir)
            const store = yield* MemoryStore.Service
            const tool = yield* MemoryTool
            const def = yield* tool.init()
            const result = yield* def.execute({ content: "Do not save this" }, ctx)

            expect(result.metadata.saved).toBe(false)
            expect(result.metadata.reason).toBe(default_mode)
            expect(yield* store.list()).toEqual([])
          }),
        ).pipe(Effect.scoped, Effect.provide(modeLayer)),
      )
    }
  })

  test("uses global memory mode instead of project config", async () => {
    const globalOffLayer = Layer.mergeAll(
      MemoryStore.defaultLayer,
      processor,
      TestConfig.layer({
        get: () => Effect.succeed({ memory: { default_mode: "auto" } }),
        getGlobal: () => Effect.succeed({ memory: { default_mode: "off" } }),
      }),
      Truncate.defaultLayer,
      Agent.defaultLayer,
      CrossSpawnSpawner.defaultLayer,
    )

    await Effect.runPromise(
      provideTmpdirInstance((dir) =>
        Effect.gen(function* () {
          yield* isolateGlobalData(dir)
          const store = yield* MemoryStore.Service
          const tool = yield* MemoryTool
          const def = yield* tool.init()
          const result = yield* def.execute({ content: "Do not save this" }, ctx)

          expect(result.metadata.saved).toBe(false)
          expect(result.metadata.reason).toBe("off")
          expect(yield* store.list()).toEqual([])
        }),
      ).pipe(Effect.scoped, Effect.provide(globalOffLayer)),
    )
  })
})
