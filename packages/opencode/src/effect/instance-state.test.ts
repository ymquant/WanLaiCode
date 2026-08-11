import { expect, test } from "bun:test"
import { Deferred, Effect } from "effect"
import { InstanceState } from "./instance-state"
import { InstanceRef } from "./instance-ref"
import { disposeInstance } from "./instance-registry"
import type { InstanceContext } from "@/project/instance"

test("forEach cannot revive a state from a context disposed after its snapshot", async () => {
  let initialized = 0
  let finalized = 0
  let visited = 0
  const ctx = {
    directory: "/tmp/instance-state-dispose-race",
    worktree: "/tmp/instance-state-dispose-race",
    project: { id: "instance-state-dispose-race" },
  } as InstanceContext

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const state = yield* InstanceState.make(() =>
        Effect.acquireRelease(
          Effect.sync(() => {
            initialized += 1
            return initialized
          }),
          () =>
            Effect.sync(() => {
              finalized += 1
            }),
        ),
      )
      yield* InstanceState.get(state).pipe(Effect.provideService(InstanceRef, ctx))

      const staleIteration = InstanceState.forEach(state, () =>
        Effect.sync(() => {
          visited += 1
        }),
      )
      yield* Effect.promise(() => disposeInstance(ctx.directory))
      const before = {
        contexts: state.contexts.size,
        initialized,
        finalized,
      }

      yield* staleIteration
      return {
        before,
        after: {
          contexts: state.contexts.size,
          initialized,
          finalized,
          visited,
        },
      }
    }).pipe(Effect.scoped),
  )

  expect(result.before).toEqual({ contexts: 0, initialized: 1, finalized: 1 })
  expect(result.after).toEqual({ contexts: 0, initialized: 1, finalized: 1, visited: 0 })
})

test("concurrent disposers share retirement and wait for an active forEach pin", async () => {
  let finalized = 0
  const ctx = {
    directory: "/tmp/instance-state-concurrent-dispose",
    worktree: "/tmp/instance-state-concurrent-dispose",
    project: { id: "instance-state-concurrent-dispose" },
  } as InstanceContext

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const state = yield* InstanceState.make(() =>
        Effect.acquireRelease(
          Effect.succeed("live"),
          () =>
            Effect.sync(() => {
              finalized += 1
            }),
        ),
      )
      yield* InstanceState.get(state).pipe(Effect.provideService(InstanceRef, ctx))

      yield* InstanceState.forEach(state, () =>
        Effect.gen(function* () {
          yield* Deferred.succeed(entered, undefined)
          yield* Deferred.await(release)
        }),
      ).pipe(Effect.forkScoped)
      yield* Deferred.await(entered)

      const disposals = yield* Effect.sync(() => [disposeInstance(ctx.directory), disposeInstance(ctx.directory)])
      yield* Effect.gen(function* () {
        if (state.contexts.size !== 0) return yield* Effect.fail("context is not retired yet")
      }).pipe(Effect.retry({ times: 100 }))

      const whilePinned = { contexts: state.contexts.size, finalized }
      yield* Deferred.succeed(release, undefined)
      yield* Effect.promise(() => Promise.all(disposals))
      return {
        whilePinned,
        after: {
          contexts: state.contexts.size,
          finalized,
        },
      }
    }).pipe(Effect.scoped),
  )

  expect(result.whilePinned).toEqual({ contexts: 0, finalized: 0 })
  expect(result.after).toEqual({ contexts: 0, finalized: 1 })
})
