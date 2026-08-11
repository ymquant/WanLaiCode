import { describe, expect, test } from "bun:test"
import { runEditMessageSubmit } from "./edit-message-submit"

function deferred() {
  let resolve: () => void = () => undefined
  let reject: (error: Error) => void = () => undefined
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function harness(input?: {
  sessionID?: string
  messageID?: string
  hasLaterMessages?: boolean
  previousRevert?: { messageID: string }
  preflight?: () => Promise<void>
  busy?: () => boolean
  revert?: (messageID: string) => Promise<void>
  unrevert?: () => Promise<void>
}) {
  const busy: boolean[] = []
  const localReverts: Array<{ messageID: string } | undefined> = []
  const backendReverts: string[] = []
  const failures: Error[] = []
  let unreverts = 0
  let sends = 0

  return {
    busy,
    localReverts,
    backendReverts,
    failures,
    unreverts: () => unreverts,
    sends: () => sends,
    run: () =>
      runEditMessageSubmit({
        sessionID: input?.sessionID ?? "session-1",
        messageID: input?.messageID ?? "message-2",
        hasLaterMessages: input?.hasLaterMessages ?? false,
        previousRevert: input?.previousRevert,
        preflight: input?.preflight ?? (() => Promise.resolve()),
        busy: input?.busy ?? (() => false),
        setBusy: (value) => busy.push(value),
        setLocalRevert: (value) => localReverts.push(value),
        revert: async (messageID) => {
          backendReverts.push(messageID)
          await input?.revert?.(messageID)
        },
        unrevert: async () => {
          unreverts += 1
          await input?.unrevert?.()
        },
        send: async () => {
          sends += 1
        },
        fail: (error) => failures.push(error instanceof Error ? error : new Error(String(error))),
      }),
  }
}

describe("runEditMessageSubmit", () => {
  test("does not mark busy, change history, or send while initial preflight is pending or rejected", async () => {
    const gate = deferred()
    const state = harness({ preflight: () => gate.promise })
    const running = state.run()
    await Promise.resolve()

    expect(state.busy).toEqual([])
    expect(state.localReverts).toEqual([])
    expect(state.backendReverts).toEqual([])
    expect(state.sends()).toBe(0)

    gate.reject(new Error("permission mode failed"))
    await running
    expect(state.busy).toEqual([])
    expect(state.localReverts).toEqual([])
    expect(state.backendReverts).toEqual([])
    expect(state.sends()).toBe(0)
    expect(state.failures.map((error) => error.message)).toEqual(["permission mode failed"])
  })

  test("restores an existing backend and local revert when the final preflight fails", async () => {
    const revertGate = deferred()
    let permissionError: Error | undefined
    const state = harness({
      hasLaterMessages: true,
      previousRevert: { messageID: "message-1" },
      preflight: () => (permissionError ? Promise.reject(permissionError) : Promise.resolve()),
      revert: (messageID) => (messageID === "message-2" ? revertGate.promise : Promise.resolve()),
    })
    const running = state.run()
    await Promise.resolve()

    expect(state.busy).toEqual([true])
    expect(state.localReverts).toEqual([{ messageID: "message-2" }])
    expect(state.backendReverts).toEqual(["message-2"])
    expect(state.sends()).toBe(0)

    permissionError = new Error("new permission write failed")
    revertGate.resolve()
    await running
    expect(state.backendReverts).toEqual(["message-2", "message-1"])
    expect(state.localReverts).toEqual([{ messageID: "message-2" }, { messageID: "message-1" }])
    expect(state.busy).toEqual([true, false])
    expect(state.sends()).toBe(0)
    expect(state.failures.map((error) => error.message)).toEqual(["new permission write failed"])
  })

  test("unreverts the backend when final preflight fails without an original revert", async () => {
    let preflights = 0
    const state = harness({
      hasLaterMessages: true,
      preflight: () => {
        preflights += 1
        if (preflights === 1) return Promise.resolve()
        return Promise.reject(new Error("permission mode failed"))
      },
    })

    await state.run()

    expect(state.backendReverts).toEqual(["message-2"])
    expect(state.unreverts()).toBe(1)
    expect(state.localReverts).toEqual([{ messageID: "message-2" }, undefined])
    expect(state.busy).toEqual([true, false])
    expect(state.sends()).toBe(0)
  })

  test("reports backend recovery failure and never sends", async () => {
    let preflights = 0
    const state = harness({
      hasLaterMessages: true,
      preflight: () => {
        preflights += 1
        if (preflights === 1) return Promise.resolve()
        return Promise.reject(new Error("permission mode failed"))
      },
      unrevert: () => Promise.reject(new Error("unrevert failed")),
    })

    await state.run()

    expect(state.failures.map((error) => error.message)).toEqual(["permission mode failed", "unrevert failed"])
    expect(state.localReverts).toEqual([{ messageID: "message-2" }, undefined])
    expect(state.busy).toEqual([true, false])
    expect(state.sends()).toBe(0)
  })

  test("checks a stable preflight again and sends on the successful path without later messages", async () => {
    let preflights = 0
    const state = harness({
      preflight: async () => {
        preflights += 1
      },
    })

    await state.run()

    expect(preflights).toBe(2)
    expect(state.busy).toEqual([true, false])
    expect(state.localReverts).toEqual([])
    expect(state.backendReverts).toEqual([])
    expect(state.sends()).toBe(1)
    expect(state.failures).toEqual([])
  })

  test("single-flights concurrent edits for the same session message", async () => {
    const gate = deferred()
    let preflights = 0
    const state = harness({
      hasLaterMessages: true,
      preflight: () => {
        preflights += 1
        if (preflights === 1) return gate.promise
        return Promise.resolve()
      },
    })

    const first = state.run()
    const duplicate = state.run()
    await Promise.resolve()

    expect(preflights).toBe(1)
    expect(state.busy).toEqual([])
    expect(state.backendReverts).toEqual([])
    expect(state.sends()).toBe(0)

    gate.resolve()
    await Promise.all([first, duplicate])
    expect(preflights).toBe(2)
    expect(state.backendReverts).toEqual(["message-2"])
    expect(state.sends()).toBe(1)
    expect(state.busy).toEqual([true, false])
  })

  test("releases the single-flight lock after a failed initial preflight", async () => {
    let failPreflight = true
    const state = harness({
      preflight: () => (failPreflight ? Promise.reject(new Error("permission mode failed")) : Promise.resolve()),
    })

    await state.run()
    failPreflight = false
    await state.run()

    expect(state.failures.map((error) => error.message)).toEqual(["permission mode failed"])
    expect(state.sends()).toBe(1)
    expect(state.busy).toEqual([true, false])
  })

  test("does not mutate history or send when the session becomes busy during initial preflight", async () => {
    const gate = deferred()
    let externalBusy = false
    let preflights = 0
    const state = harness({
      hasLaterMessages: true,
      busy: () => externalBusy,
      preflight: () => {
        preflights += 1
        if (preflights === 1) return gate.promise
        return Promise.resolve()
      },
    })

    const running = state.run()
    externalBusy = true
    gate.resolve()
    await running

    expect(state.busy).toEqual([])
    expect(state.localReverts).toEqual([])
    expect(state.backendReverts).toEqual([])
    expect(state.sends()).toBe(0)

    externalBusy = false
    await state.run()
    expect(state.backendReverts).toEqual(["message-2"])
    expect(state.sends()).toBe(1)
    expect(state.busy).toEqual([true, false])
  })
})

test("session editMessage delegates permission barriers and history recovery to the submit helper", async () => {
  const source = await Bun.file(new URL("../session.tsx", import.meta.url)).text()
  const editMessage = source.slice(source.indexOf("const editMessage ="), source.indexOf("const revertMutation ="))

  expect(editMessage).toContain("runEditMessageSubmit({")
  expect(editMessage).toContain("preflight: permission.flush")
})
