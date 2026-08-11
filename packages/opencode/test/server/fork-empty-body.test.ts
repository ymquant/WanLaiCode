import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Flag } from "@opencode-ai/core/flag/flag"
import * as Log from "@opencode-ai/core/util/log"
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import { WithInstance } from "../../src/project/with-instance"
import { Server } from "../../src/server/server"
import { Session } from "@/session/session"
import { MessageID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

void Log.init({ print: false })

const original = Flag.WANLAICODE_EXPERIMENTAL_HTTPAPI

afterEach(async () => {
  Flag.WANLAICODE_EXPERIMENTAL_HTTPAPI = original
  await disposeAllInstances()
  await resetDatabase()
})

function app(experimental: boolean) {
  Flag.WANLAICODE_EXPERIMENTAL_HTTPAPI = experimental
  return experimental ? Server.Default().app : Server.Legacy().app
}

function runSession<A, E>(fx: Effect.Effect<A, E, Session.Service>) {
  return Effect.runPromise(fx.pipe(Effect.provide(Session.defaultLayer)))
}

function createSession(directory: string) {
  return WithInstance.provide({
    directory,
    fn: async () => {
      const session = await runSession(Session.Service.use((svc) => svc.create({})))
      await runSession(
        Effect.gen(function* () {
          const svc = yield* Session.Service
          yield* svc.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            sessionID: session.id,
            agent: "build",
            model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
            time: { created: Date.now() },
          })
        }),
      )
      return session.id
    },
  })
}

// Forking the last assistant message sends `fork({ sessionID })` with no
// messageID. The generated client strips the empty body AND drops Content-Type,
// producing a bodyless POST that the effect-httpapi backend rejected with a
// 400 (empty response body). The SDK must backfill an empty JSON body so the
// optional payload decodes to {} on both backends.
for (const backend of [false, true] as const) {
  describe(`fork without messageID via SDK (${backend ? "httpapi" : "hono"})`, () => {
    test("returns a forked session", async () => {
      await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })
      const sessionID = await createSession(tmp.path)
      const backendApp = app(backend)
      const client = createOpencodeClient({
        baseUrl: "http://localhost",
        directory: tmp.path,
        fetch: ((request: Request) => backendApp.request(request)) as unknown as typeof fetch,
      })

      const res = await client.session.fork({ sessionID })

      expect(res.error).toBeUndefined()
      expect(res.data?.id).toBeTruthy()
    })
  })
}
