import { describe, expect } from "bun:test"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Effect, Layer } from "effect"
import { MessageID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(SessionStatus.defaultLayer, CrossSpawnSpawner.defaultLayer))

describe("session status run identity", () => {
  it.live("keeps startedAt across busy and retry but advances it after idle", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessionID = SessionID.make("session-status-run-identity")
        const status = yield* SessionStatus.Service

        yield* status.set(sessionID, { type: "busy" })
        const initial = yield* status.get(sessionID)
        expect(initial.type).toBe("busy")
        if (initial.type !== "busy" || initial.startedAt === undefined) return
        const initialStartedAt = initial.startedAt
        expect(typeof initialStartedAt).toBe("number")

        yield* status.set(sessionID, { type: "retry", attempt: 1, message: "retry", next: 0 })
        const retry = yield* status.get(sessionID)
        expect(retry).toMatchObject({ type: "retry", startedAt: initialStartedAt })

        yield* status.set(sessionID, { type: "busy", turnID: MessageID.make("message-root") })
        const bound = yield* status.get(sessionID)
        // turnID 后到时仍属于最初 busy 代次，前端等待器可以安全地把 unresolved steer 绑定到它。
        expect(bound).toMatchObject({
          type: "busy",
          turnID: "message-root",
          startedAt: initialStartedAt,
        })

        yield* status.set(sessionID, { type: "idle" })
        yield* status.set(sessionID, { type: "busy" })
        const restarted = yield* status.get(sessionID)
        expect(restarted.type).toBe("busy")
        if (restarted.type !== "busy") return
        expect(restarted.startedAt).toBeGreaterThan(initialStartedAt)
      }),
    ),
  )
})
