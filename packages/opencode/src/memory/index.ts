import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { Context, Effect, Layer, Semaphore } from "effect"

import * as InstanceState from "@/effect/instance-state"
import { NotFoundError } from "@/storage/storage"
import { MemoryDocuments, type IndexItem } from "./documents"
import { MemoryPaths } from "./paths"
import {
  InvalidMemoryError,
  MemoryID,
  type Detail,
  type Draft,
  type Entry,
  type ListInput,
  type ResetInput,
  type Scope,
  type UpdateInput,
} from "./schema"

export * from "./context"
export * as MemoryContext from "./context"
export * as MemoryDocuments from "./documents"
export * as MemoryPaths from "./paths"
export * as MemoryProcessor from "./processor"
export * as Memory from "./schema"

const indexFilename = "MEMORY.md"
const locks = new Map<string, Semaphore.Semaphore>()

function lock(directory: string) {
  const existing = locks.get(directory)
  if (existing) return existing
  const created = Semaphore.makeUnsafe(1)
  locks.set(directory, created)
  return created
}

function digest(input: string, length: number) {
  return createHash("sha256").update(input).digest("hex").slice(0, length)
}

function id(scope: Scope, key: string, name: string) {
  return MemoryID.ascending(`mem_${digest(`${scope}\0${key}\0${name}`, 26)}`)
}

function notFound(memoryID: MemoryID) {
  return new NotFoundError({ message: `Memory not found: ${memoryID}` })
}

function isNotFound(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
}

function readText(filepath: string) {
  return Effect.tryPromise({
    try: () => readFile(filepath, "utf8"),
    catch: (cause) => new InvalidMemoryError({ message: `Failed to read memory file: ${String(cause)}` }),
  })
}

function readOptional(filepath: string) {
  return Effect.tryPromise({
    try: () => readFile(filepath, "utf8").catch((error: unknown) => (isNotFound(error) ? undefined : Promise.reject(error))),
    catch: (cause) => new InvalidMemoryError({ message: `Failed to read memory file: ${String(cause)}` }),
  })
}

function atomicWrite(filepath: string, content: string) {
  return Effect.tryPromise({
    try: async () => {
      await mkdir(path.dirname(filepath), { recursive: true })
      const temp = path.join(path.dirname(filepath), `.${path.basename(filepath)}.${process.pid}.${randomUUID()}.tmp`)
      try {
        await writeFile(temp, content, "utf8")
        await rename(temp, filepath)
      } finally {
        await unlink(temp).catch(() => undefined)
      }
    },
    catch: (cause) => new InvalidMemoryError({ message: `Failed to write memory file: ${String(cause)}` }),
  })
}

function removeFile(filepath: string) {
  return Effect.tryPromise({
    try: () => unlink(filepath).catch((error: unknown) => (isNotFound(error) ? undefined : Promise.reject(error))),
    catch: (cause) => new InvalidMemoryError({ message: `Failed to delete memory file: ${String(cause)}` }),
  })
}

type Target = {
  directory: string
  key: string
  scope: Scope
}

function target(scope: Scope) {
  return Effect.gen(function* () {
    const ctx = yield* InstanceState.context
    const directory = yield* Effect.promise(() => MemoryPaths.scopeDirectory(ctx, scope))
    return { directory, key: scope === "global" ? "global" : path.basename(directory), scope } satisfies Target
  })
}

function entry(target: Target, item: IndexItem): Entry {
  return {
    id: id(target.scope, target.key, item.name),
    scope: target.scope,
    name: item.name,
    title: item.title,
    summary: item.summary,
  }
}

function matches(input: ListInput, item: Entry) {
  if (input.scope && item.scope !== input.scope) return false
  if (!input.search) return true
  const query = input.search.toLowerCase()
  return item.title.toLowerCase().includes(query) || item.summary.toLowerCase().includes(query)
}

export type NotFound = InstanceType<typeof NotFoundError>

export interface Interface {
  readonly list: (input?: ListInput) => Effect.Effect<Entry[], InvalidMemoryError>
  readonly get: (id: MemoryID) => Effect.Effect<Detail, NotFound | InvalidMemoryError>
  readonly getByName: (input: { scope: Scope; name: string }) => Effect.Effect<Detail, NotFound | InvalidMemoryError>
  readonly create: (input: { scope: Scope; draft: Draft }) => Effect.Effect<Detail, InvalidMemoryError>
  readonly update: (input: UpdateInput) => Effect.Effect<Detail, NotFound | InvalidMemoryError>
  readonly remove: (id: MemoryID) => Effect.Effect<void, InvalidMemoryError>
  readonly reset: (input: ResetInput) => Effect.Effect<void, InvalidMemoryError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/MemoryStore") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const readTarget = Effect.fn("MemoryStore.readTarget")(function* (target: Target) {
      const text = yield* readOptional(path.join(target.directory, indexFilename))
      if (text === undefined) return []
      return yield* Effect.try({
        try: () => MemoryDocuments.parseIndex(text).map((item) => entry(target, item)),
        catch: (cause) =>
          cause instanceof InvalidMemoryError
            ? cause
            : new InvalidMemoryError({ message: `Invalid memory index: ${String(cause)}` }),
      })
    })

    const targets = Effect.fn("MemoryStore.targets")(function* (scope?: Scope) {
      if (scope) return [yield* target(scope)]
      return yield* Effect.all([target("global"), target("project")])
    })

    const read = Effect.fn("MemoryStore.read")(function* (scope?: Scope) {
      return (yield* Effect.all((yield* targets(scope)).map(readTarget))).flat()
    })

    const locate = Effect.fn("MemoryStore.locate")(function* (memoryID: MemoryID) {
      for (const current of yield* targets()) {
        const entries = yield* readTarget(current)
        const found = entries.find((item) => item.id === memoryID)
        if (found) return { target: current, entries, entry: found }
      }
      return yield* Effect.fail(notFound(memoryID))
    })

    const detail = Effect.fn("MemoryStore.detail")(function* (target: Target, item: Entry) {
      const document = yield* readText(path.join(target.directory, `${item.name}.md`)).pipe(
        Effect.catchTag("InvalidMemoryError", () => Effect.fail(notFound(item.id))),
      )
      return { ...item, document } satisfies Detail
    })

    const rewrite = Effect.fn("MemoryStore.rewrite")(function* (target: Target, entries: Entry[]) {
      yield* atomicWrite(path.join(target.directory, indexFilename), MemoryDocuments.serializeIndex(entries))
    })

    return Service.of({
      list: (input = {}) =>
        Effect.gen(function* () {
          return (yield* read(input.scope)).filter((item) => matches(input, item)).slice(0, input.limit ?? 100)
        }),
      get: (memoryID) =>
        Effect.gen(function* () {
          const found = yield* locate(memoryID)
          return yield* detail(found.target, found.entry)
        }),
      getByName: (input) =>
        Effect.gen(function* () {
          yield* Effect.try({
            try: () => MemoryDocuments.validateName(input.name),
            catch: (cause) =>
              cause instanceof InvalidMemoryError
                ? cause
                : new InvalidMemoryError({ message: `Invalid memory name: ${String(cause)}` }),
          })
          const current = yield* target(input.scope)
          const found = (yield* readTarget(current)).find((item) => item.name === input.name)
          if (!found) return yield* Effect.fail(notFound(id(current.scope, current.key, input.name)))
          return yield* detail(current, found)
        }),
      create: (input) =>
        Effect.gen(function* () {
          const current = yield* target(input.scope)
          return yield* lock(current.directory).withPermits(1)(
            Effect.gen(function* () {
              const entries = yield* readTarget(current)
              const draft = MemoryDocuments.validateDraft(input.draft)
              const suffix = digest(JSON.stringify(draft), 8)
              const base = entries.some((item) => item.name === draft.name) ? `${draft.name}-${suffix}` : draft.name
              const name = entries.some((item) => item.name === base)
                ? `${base}-${entries.filter((item) => item.name.startsWith(base)).length + 1}`
                : base
              const item = entry(current, { name, title: draft.title, summary: draft.summary })
              const document = MemoryDocuments.serializeDetail(draft)
              yield* atomicWrite(path.join(current.directory, `${name}.md`), document)
              yield* rewrite(current, [item, ...entries])
              return { ...item, document } satisfies Detail
            }),
          )
        }),
      update: (input) =>
        Effect.gen(function* () {
          const found = yield* locate(input.id)
          return yield* lock(found.target.directory).withPermits(1)(
            Effect.gen(function* () {
              const entries = yield* readTarget(found.target)
              const current = entries.find((item) => item.id === input.id)
              if (!current) return yield* Effect.fail(notFound(input.id))
              const parsed = yield* Effect.try({
                try: () => MemoryDocuments.parseDetail(input.document),
                catch: (cause) =>
                  cause instanceof InvalidMemoryError
                    ? cause
                    : new InvalidMemoryError({ message: `Invalid memory detail: ${String(cause)}` }),
              })
              const updated = { ...current, title: parsed.title, summary: parsed.summary }
              yield* atomicWrite(path.join(found.target.directory, `${updated.name}.md`), input.document)
              yield* rewrite(
                found.target,
                entries.map((item) => (item.id === updated.id ? updated : item)),
              )
              return { ...updated, document: input.document } satisfies Detail
            }),
          )
        }),
      remove: (memoryID) =>
        Effect.gen(function* () {
          const found = yield* locate(memoryID).pipe(
            Effect.catchIf(NotFoundError.isInstance, () => Effect.succeed(undefined)),
          )
          if (!found) return
          yield* lock(found.target.directory).withPermits(1)(
            Effect.gen(function* () {
              const entries = yield* readTarget(found.target)
              const current = entries.find((item) => item.id === memoryID)
              if (!current) return
              yield* removeFile(path.join(found.target.directory, `${current.name}.md`))
              yield* rewrite(found.target, entries.filter((item) => item.id !== memoryID))
            }),
          )
        }),
      reset: (input) =>
        Effect.gen(function* () {
          const current = yield* target(input.scope)
          yield* lock(current.directory).withPermits(1)(
            Effect.gen(function* () {
              const entries = yield* readTarget(current)
              yield* Effect.all(entries.map((item) => removeFile(path.join(current.directory, `${item.name}.md`))))
              yield* rewrite(current, [])
            }),
          )
        }),
    })
  }),
)

export const defaultLayer = layer

export * as MemoryStore from "./index"
