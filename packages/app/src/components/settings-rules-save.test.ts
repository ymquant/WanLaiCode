import { describe, expect, test } from "bun:test"
import { createSettingsRulesSaveQueue, restoreSettingsRulesConfig } from "./settings-rules-save"

describe("settings rules save queue", () => {
  test("runs saves in invocation order", async () => {
    const pending: Array<() => void> = []
    const calls: string[] = []
    const save = createSettingsRulesSaveQueue()

    const first = save(async () => {
      calls.push("first:start")
      await new Promise<void>((resolve) => pending.push(resolve))
      calls.push("first:end")
    })
    const second = save(async () => {
      calls.push("second")
    })

    await Promise.resolve()
    expect(calls).toEqual(["first:start"])
    pending.shift()?.()
    await Promise.all([first, second])
    expect(calls).toEqual(["first:start", "first:end", "second"])
  })

  test("continues after a failed save", async () => {
    const calls: string[] = []
    const save = createSettingsRulesSaveQueue()

    await expect(save(async () => Promise.reject(new Error("failed")))).rejects.toThrow("failed")
    await save(async () => {
      calls.push("second")
    })

    expect(calls).toEqual(["second"])
  })

  test("does not replace config refreshed while a save was pending", () => {
    const previous = { rules: [] }
    const optimistic = { rules: [{ id: "local" }] }
    const refreshed = { rules: [{ id: "remote" }] }

    expect(restoreSettingsRulesConfig({ current: refreshed, optimistic, previous })).toBe(refreshed)
    expect(restoreSettingsRulesConfig({ current: optimistic, optimistic, previous })).toBe(previous)
  })
})
