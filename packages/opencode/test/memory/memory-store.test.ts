import { describe, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import path from "node:path"
import { mkdir, unlink } from "node:fs/promises"
import { Global } from "@opencode-ai/core/global"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { ChildProcessSpawner } from "effect/unstable/process"

import { MemoryPaths, MemoryStore } from "../../src/memory"
import { provideTmpdirInstance } from "../fixture/fixture"

const run = <A, E>(effect: Effect.Effect<A, E, MemoryStore.Service | ChildProcessSpawner.ChildProcessSpawner>) =>
  Effect.runPromise(effect.pipe(Effect.provide(MemoryStore.defaultLayer), Effect.provide(CrossSpawnSpawner.defaultLayer)))

function isolateGlobalData(dir: string) {
  const previous = Global.Path.data
  return Effect.gen(function* () {
    const target = path.join(dir, "global-data")
    yield* Effect.promise(() => mkdir(target, { recursive: true }))
    ;(Global.Path as { data: string }).data = target
    yield* Effect.addFinalizer(() => Effect.sync(() => ((Global.Path as { data: string }).data = previous)))
    return target
  })
}

const firstDraft = {
  name: "run-package-tests",
  title: "Run package tests",
  summary: "Run tests from the target package directory",
  detail: "Run Bun tests from the package that owns them.\n\n## Why\n\nThe repository root rejects test runs.",
}

const secondDraft = {
  name: "use-uv",
  title: "Use uv",
  summary: "Manage Python environments with uv",
  detail: "Use `uv run`, `uv add`, and `uv sync` for Python work.",
}

describe("MemoryStore", () => {
  test("stores project index and details outside the project directory", async () => {
    await run(
      provideTmpdirInstance((dir) =>
        Effect.gen(function* () {
          const data = yield* isolateGlobalData(dir)
          const store = yield* MemoryStore.Service
          const created = yield* store.create({ scope: "project", draft: firstDraft })
          const projectDir = MemoryPaths.projectDirectory(data, MemoryPaths.projectKey(dir))

          expect(created.title).toBe(firstDraft.title)
          expect(created.document).toContain("# Run package tests")
          expect(yield* Effect.promise(() => Bun.file(path.join(projectDir, "MEMORY.md")).text())).toContain(
            "[Run package tests](run-package-tests.md)",
          )
          expect(
            yield* Effect.promise(() => Bun.file(path.join(projectDir, "run-package-tests.md")).text()),
          ).toContain(firstDraft.detail)
          expect(
            yield* Effect.promise(() => Bun.file(path.join(dir, ".wanlaicode", "memory.md")).exists()),
          ).toBe(false)
        }),
      ).pipe(Effect.scoped),
    )
  })

  test("keeps IDs stable when newer entries are prepended", async () => {
    await run(
      provideTmpdirInstance((dir) =>
        Effect.gen(function* () {
          yield* isolateGlobalData(dir)
          const store = yield* MemoryStore.Service
          const first = yield* store.create({ scope: "project", draft: firstDraft })
          yield* store.create({ scope: "project", draft: secondDraft })
          const listed = yield* store.list({ scope: "project" })

          expect(listed.map((entry) => entry.name)).toEqual(["use-uv", "run-package-tests"])
          expect(listed.find((entry) => entry.name === first.name)?.id).toBe(first.id)
          expect("document" in listed[0]!).toBe(false)
        }),
      ).pipe(Effect.scoped),
    )
  })

  test("updates the detail and rebuilt index without model processing", async () => {
    await run(
      provideTmpdirInstance((dir) =>
        Effect.gen(function* () {
          const data = yield* isolateGlobalData(dir)
          const store = yield* MemoryStore.Service
          const created = yield* store.create({ scope: "project", draft: firstDraft })
          const document = [
            "# Run focused package tests",
            "",
            "> Run only the focused package test from its package directory",
            "",
            "Use the package-local Bun test command.",
            "",
          ].join("\n")
          const updated = yield* store.update({ id: created.id, document })
          const projectDir = MemoryPaths.projectDirectory(data, MemoryPaths.projectKey(dir))

          expect(updated.title).toBe("Run focused package tests")
          expect(updated.document).toBe(document)
          expect(yield* Effect.promise(() => Bun.file(path.join(projectDir, "MEMORY.md")).text())).toContain(
            "Run only the focused package test",
          )
        }),
      ).pipe(Effect.scoped),
    )
  })

  test("physically removes indexed details and resets a scope", async () => {
    await run(
      provideTmpdirInstance((dir) =>
        Effect.gen(function* () {
          const data = yield* isolateGlobalData(dir)
          const store = yield* MemoryStore.Service
          const project = yield* store.create({ scope: "project", draft: firstDraft })
          yield* store.create({ scope: "global", draft: secondDraft })
          const projectDir = MemoryPaths.projectDirectory(data, MemoryPaths.projectKey(dir))
          const globalDir = MemoryPaths.globalDirectory(data)

          yield* store.remove(project.id)
          expect(yield* store.list({ scope: "project" })).toEqual([])
          expect(
            yield* Effect.promise(() => Bun.file(path.join(projectDir, "run-package-tests.md")).exists()),
          ).toBe(false)

          yield* store.reset({ scope: "global" })
          expect(yield* store.list({ scope: "global" })).toEqual([])
          expect(yield* Effect.promise(() => Bun.file(path.join(globalDir, "use-uv.md")).exists())).toBe(false)
        }),
      ).pipe(Effect.scoped),
    )
  })

  test("serializes concurrent removals against the latest index", async () => {
    await run(
      provideTmpdirInstance((dir) =>
        Effect.gen(function* () {
          yield* isolateGlobalData(dir)
          const store = yield* MemoryStore.Service
          const created = yield* Effect.forEach(
            Array.from({ length: 8 }, (_, index) => ({
              ...firstDraft,
              name: `entry-${index}`,
              title: `Entry ${index}`,
              summary: `Concurrent entry ${index}`,
            })),
            (draft) => store.create({ scope: "project", draft }),
          )

          yield* Effect.all(created.map((item) => store.remove(item.id)), { concurrency: "unbounded" })

          expect(yield* store.list({ scope: "project" })).toEqual([])
        }),
      ).pipe(Effect.scoped),
    )
  })

  test("serializes concurrent edits against the latest index", async () => {
    await run(
      provideTmpdirInstance((dir) =>
        Effect.gen(function* () {
          yield* isolateGlobalData(dir)
          const store = yield* MemoryStore.Service
          const first = yield* store.create({ scope: "project", draft: firstDraft })
          const second = yield* store.create({ scope: "project", draft: secondDraft })
          const firstDocument = "# Focused tests\n\n> Run focused tests from the package directory\n\nUse the owning package.\n"
          const secondDocument = "# Python with uv\n\n> Use uv for every Python environment\n\nRun Python through uv.\n"

          yield* Effect.all(
            [
              store.update({ id: first.id, document: firstDocument }),
              store.update({ id: second.id, document: secondDocument }),
            ],
            { concurrency: "unbounded" },
          )

          expect(
            Object.fromEntries((yield* store.list({ scope: "project" })).map((item) => [item.name, item.summary])),
          ).toEqual({
            "run-package-tests": "Run focused tests from the package directory",
            "use-uv": "Use uv for every Python environment",
          })
        }),
      ).pipe(Effect.scoped),
    )
  })

  test("keeps an entry indexed when its detail cannot be deleted", async () => {
    await run(
      provideTmpdirInstance((dir) =>
        Effect.gen(function* () {
          const data = yield* isolateGlobalData(dir)
          const store = yield* MemoryStore.Service
          const created = yield* store.create({ scope: "project", draft: firstDraft })
          const detail = path.join(
            MemoryPaths.projectDirectory(data, MemoryPaths.projectKey(dir)),
            `${created.name}.md`,
          )
          yield* Effect.promise(async () => {
            await unlink(detail)
            await mkdir(detail)
          })

          const result = yield* store.remove(created.id).pipe(Effect.exit)

          expect(Exit.isFailure(result)).toBe(true)
          expect((yield* store.list({ scope: "project" })).map((item) => item.id)).toEqual([created.id])
        }),
      ).pipe(Effect.scoped),
    )
  })

  test("keeps reset retryable when a detail cannot be deleted", async () => {
    await run(
      provideTmpdirInstance((dir) =>
        Effect.gen(function* () {
          const data = yield* isolateGlobalData(dir)
          const store = yield* MemoryStore.Service
          const created = yield* store.create({ scope: "project", draft: firstDraft })
          const detail = path.join(
            MemoryPaths.projectDirectory(data, MemoryPaths.projectKey(dir)),
            `${created.name}.md`,
          )
          yield* Effect.promise(async () => {
            await unlink(detail)
            await mkdir(detail)
          })

          const result = yield* store.reset({ scope: "project" }).pipe(Effect.exit)

          expect(Exit.isFailure(result)).toBe(true)
          expect((yield* store.list({ scope: "project" })).map((item) => item.id)).toEqual([created.id])
        }),
      ).pipe(Effect.scoped),
    )
  })

  test("does not treat an invalid index as a missing memory", async () => {
    await run(
      provideTmpdirInstance((dir) =>
        Effect.gen(function* () {
          const data = yield* isolateGlobalData(dir)
          const store = yield* MemoryStore.Service
          const created = yield* store.create({ scope: "project", draft: firstDraft })
          yield* Effect.promise(() =>
            Bun.write(
              path.join(MemoryPaths.projectDirectory(data, MemoryPaths.projectKey(dir)), "MEMORY.md"),
              "invalid index\n",
            ),
          )

          expect(Exit.isFailure(yield* store.remove(created.id).pipe(Effect.exit))).toBe(true)
        }),
      ).pipe(Effect.scoped),
    )
  })
})
