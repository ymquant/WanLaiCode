import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Flag } from "@opencode-ai/core/flag/flag"
import { mkdir, rm } from "fs/promises"
import path from "path"
import { Server } from "../../src/server/server"
import { GlobalPaths } from "../../src/server/routes/instance/httpapi/groups/global"
import { disposeAllInstances } from "../fixture/fixture"
import { waitGlobalBusEventPromise } from "./global-bus"

const original = Flag.WANLAICODE_EXPERIMENTAL_HTTPAPI

async function clearGlobalConfig() {
  const directory = path.join(process.env.XDG_CONFIG_HOME!, "wanlaicode")
  await rm(directory, { recursive: true, force: true })
  await mkdir(directory, { recursive: true })
}

beforeEach(clearGlobalConfig)

afterEach(async () => {
  Flag.WANLAICODE_EXPERIMENTAL_HTTPAPI = original
  await disposeAllInstances()
  await clearGlobalConfig()
})

describe.each([
  ["Hono", false],
  ["HttpApi", true],
] as const)("global config %s route", (_, experimental) => {
  test("keeps instances alive for hot updates and disposes them for non-hot updates", async () => {
    Flag.WANLAICODE_EXPERIMENTAL_HTTPAPI = experimental
    const app = experimental ? Server.Default().app : Server.Legacy().app
    const patch = (config: Record<string, unknown>) =>
      app.request(GlobalPaths.config, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(config),
      })

    const updated = waitGlobalBusEventPromise({
      predicate: (event) => event.payload.type === "global.config.updated",
    })
    expect((await patch({ rules: [{ id: "hot", title: "Hot", content: "Use hot rules", enabled: true }] })).status).toBe(200)
    await updated
    await expect(
      waitGlobalBusEventPromise({
        timeout: 100,
        predicate: (event) => event.payload.type === "global.disposed",
      }),
    ).rejects.toThrow()

    const disposed = waitGlobalBusEventPromise({
      predicate: (event) => event.payload.type === "global.disposed",
    })
    expect((await patch({ shell: "powershell" })).status).toBe(200)
    await disposed
  })
})
