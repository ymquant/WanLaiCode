import { Effect, Fiber, ScopedCache, Scope, Context } from "effect"
import * as EffectLogger from "@opencode-ai/core/effect/logger"
import { Instance, type InstanceContext } from "@/project/instance"
import { LocalContext } from "@/util/local-context"
import { InstanceRef, WorkspaceRef } from "./instance-ref"
import { registerDisposer } from "./instance-registry"
import { WorkspaceContext } from "@/control-plane/workspace-context"

const TypeId = "~opencode/InstanceState"

interface LiveContext {
  readonly context: InstanceContext
  readonly waiters: Set<() => void>
  alive: boolean
  pins: number
}

export interface InstanceState<A, E = never, R = never> {
  readonly [TypeId]: typeof TypeId
  readonly cache: ScopedCache.ScopedCache<string, A, E, R>
  readonly directories: Set<string>
  readonly contexts: Map<string, LiveContext>
}

export const bind = <F extends (...args: any[]) => any>(fn: F): F => {
  try {
    return Instance.bind(fn)
  } catch (err) {
    if (!(err instanceof LocalContext.NotFound)) throw err
  }
  const fiber = Fiber.getCurrent()
  const ctx = fiber ? Context.getReferenceUnsafe(fiber.context, InstanceRef) : undefined
  if (!ctx) return fn
  return ((...args: any[]) => Instance.restore(ctx, () => fn(...args))) as F
}

export const context = Effect.gen(function* () {
  return (yield* InstanceRef) ?? Instance.current
})

export const workspaceID = Effect.gen(function* () {
  return (yield* WorkspaceRef) ?? WorkspaceContext.workspaceID
})

export const directory = Effect.map(context, (ctx) => ctx.directory)

export const make = <A, E = never, R = never>(
  init: (ctx: InstanceContext) => Effect.Effect<A, E, R | Scope.Scope>,
): Effect.Effect<InstanceState<A, E, Exclude<R, Scope.Scope>>, never, R | Scope.Scope> =>
  Effect.gen(function* () {
    const directories = new Set<string>()
    const contexts = new Map<string, LiveContext>()
    const retired = new WeakSet<InstanceContext>()
    const retirements = new Map<string, Promise<void>>()
    const cache = yield* ScopedCache.make<string, A, E, R>({
      capacity: Number.POSITIVE_INFINITY,
      lookup: () =>
        Effect.gen(function* () {
          const ctx = yield* context
          if (retired.has(ctx)) return yield* Effect.interrupt
          directories.add(ctx.directory)
          const existing = contexts.get(ctx.directory)
          if (!existing || existing.context !== ctx) {
            contexts.set(ctx.directory, {
              context: ctx,
              waiters: new Set(),
              alive: true,
              pins: 0,
            })
          }
          return yield* init(ctx)
        }),
    })

    const dispose = async (directory: string) => {
      const pending = retirements.get(directory)
      if (pending) return pending

      const retirement = (async () => {
        const entry = contexts.get(directory)
        directories.delete(directory)
        contexts.delete(directory)
        if (entry) {
          entry.alive = false
          retired.add(entry.context)
          if (entry.pins > 0) {
            await new Promise<void>((resolve) => {
              entry.waiters.add(resolve)
            })
          }
        }
        await Effect.runPromise(ScopedCache.invalidate(cache, directory).pipe(Effect.provide(EffectLogger.layer)))
      })()
      retirements.set(directory, retirement)
      try {
        await retirement
      } finally {
        if (retirements.get(directory) === retirement) retirements.delete(directory)
      }
    }
    const off = registerDisposer(dispose)
    yield* Effect.addFinalizer(() => Effect.sync(off))

    return {
      [TypeId]: TypeId,
      cache,
      directories,
      contexts,
    }
  })

export const get = <A, E, R>(self: InstanceState<A, E, R>) =>
  Effect.gen(function* () {
    return yield* ScopedCache.get(self.cache, yield* directory)
  })

export const use = <A, E, R, B>(self: InstanceState<A, E, R>, select: (value: A) => B) => Effect.map(get(self), select)

export const useEffect = <A, E, R, B, E2, R2>(
  self: InstanceState<A, E, R>,
  select: (value: A) => Effect.Effect<B, E2, R2>,
) => Effect.flatMap(get(self), select)

export const has = <A, E, R>(self: InstanceState<A, E, R>) =>
  Effect.gen(function* () {
    return yield* ScopedCache.has(self.cache, yield* directory)
  })

export const invalidate = <A, E, R>(self: InstanceState<A, E, R>) =>
  Effect.gen(function* () {
    return yield* ScopedCache.invalidate(self.cache, yield* directory)
  })

export const invalidateAll = <A, E, R>(self: InstanceState<A, E, R>) =>
  Effect.forEach(Array.from(self.directories), (directory) => ScopedCache.invalidate(self.cache, directory), {
    concurrency: "unbounded",
    discard: true,
  })

export const forEach = <A, E, R, B, E2, R2>(
  self: InstanceState<A, E, R>,
  use: (value: A) => Effect.Effect<B, E2, R2>,
) =>
  Effect.forEach(
    Array.from(self.contexts.entries()),
    ([directory, entry]) =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          if (!entry.alive || self.contexts.get(directory) !== entry) return false
          entry.pins += 1
          return true
        }),
        (pinned) =>
          pinned
            ? ScopedCache.get(self.cache, directory).pipe(
                Effect.flatMap(use),
                Effect.provideService(InstanceRef, entry.context),
              )
            : Effect.void,
        (pinned) =>
          Effect.sync(() => {
            if (!pinned) return
            entry.pins -= 1
            if (entry.pins > 0) return
            for (const waiter of entry.waiters) waiter()
            entry.waiters.clear()
          }),
      ),
    {
      concurrency: "unbounded",
      discard: true,
    },
  )

export * as InstanceState from "./instance-state"
