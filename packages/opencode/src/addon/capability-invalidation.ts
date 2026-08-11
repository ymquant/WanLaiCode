import { Effect } from "effect"

const invalidators = new Set<() => Effect.Effect<void>>()

export function registerAddonCapabilityInvalidator(invalidator: () => Effect.Effect<void>) {
  invalidators.add(invalidator)
  return () => invalidators.delete(invalidator)
}

export const invalidateAddonCapabilities = Effect.fn("Addon.invalidateCapabilities")(function* () {
  yield* Effect.forEach(Array.from(invalidators), (invalidate) => invalidate(), {
    concurrency: "unbounded",
    discard: true,
  })
})
