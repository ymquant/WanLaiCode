import { describe, expect, test } from "bun:test"
import { afterGlobalConfigUpdate, shouldDisposeAfterGlobalConfigUpdate } from "../../src/server/global-lifecycle"

describe("global config disposal", () => {
  test("does not dispose instances for hot instruction settings", async () => {
    expect(shouldDisposeAfterGlobalConfigUpdate({ instruction_import: { agents_md: false } })).toBe(false)
    expect(shouldDisposeAfterGlobalConfigUpdate({ rules: [] })).toBe(false)
    expect(shouldDisposeAfterGlobalConfigUpdate({ rules: [], shell: "powershell" })).toBe(true)
  })

  test("coordinates disposal only for changed non-hot updates", () => {
    let disposed = 0
    const dispose = () => disposed++

    afterGlobalConfigUpdate({ changed: true, config: { rules: [] }, dispose })
    afterGlobalConfigUpdate({ changed: false, config: { shell: "powershell" }, dispose })
    expect(disposed).toBe(0)

    afterGlobalConfigUpdate({ changed: true, config: { shell: "powershell" }, dispose })
    expect(disposed).toBe(1)
  })

  test("refreshes all cached instances from the global config service", async () => {
    const config = await Bun.file(new URL("../../src/config/config.ts", import.meta.url)).text()
    const marketplace = await Bun.file(new URL("../../src/addon/marketplace.ts", import.meta.url)).text()

    expect(config).toContain("yield* InstanceState.invalidateAll(state)")
    expect(config).not.toContain("const instances = new Set<string>()")
    expect(config).not.toContain("clearInstances")
    expect(marketplace).not.toContain("Effect.provide(Config.defaultLayer)")
  })
})
