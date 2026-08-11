import { describe, expect, test } from "bun:test"
import { completeWanlaiCodeLogin } from "./wanlaicode-login-complete"

describe("completeWanlaiCodeLogin", () => {
  test("refreshes provider state before opening the main window", async () => {
    const calls: string[] = []

    await completeWanlaiCodeLogin({
      dispose: async () => {
        calls.push("dispose")
      },
      invalidateBootstrap: async () => {
        calls.push("bootstrap")
      },
      invalidateProviders: async () => {
        calls.push("providers")
      },
      openMainWindow: async () => {
        calls.push("open")
      },
    })

    expect(calls).toEqual(["dispose", "bootstrap", "providers", "open"])
  })

  test("continues refreshing when disposal fails", async () => {
    const calls: string[] = []

    await completeWanlaiCodeLogin({
      dispose: async () => {
        throw new Error("already disposed")
      },
      invalidateBootstrap: async () => {
        calls.push("bootstrap")
      },
      invalidateProviders: async () => {
        calls.push("providers")
      },
    })

    expect(calls).toEqual(["bootstrap", "providers"])
  })
})
