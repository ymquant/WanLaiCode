import { expect } from "bun:test"
import { Effect } from "effect"
import { invalidateAddonCapabilities, registerAddonCapabilityInvalidator } from "../../src/addon/capability-invalidation"
import { it } from "../lib/effect"

it.effect("invalidates every registered addon capability cache", () =>
  Effect.gen(function* () {
    const calls: string[] = []
    const first = registerAddonCapabilityInvalidator(() => Effect.sync(() => calls.push("first")))
    const second = registerAddonCapabilityInvalidator(() => Effect.sync(() => calls.push("second")))
    yield* Effect.addFinalizer(() => Effect.sync(() => {
      first()
      second()
    }))

    yield* invalidateAddonCapabilities()
    expect(calls.sort()).toEqual(["first", "second"])
  }),
)
