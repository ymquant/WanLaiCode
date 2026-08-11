import { describe, expect, test } from "bun:test"
import { awaitSidecarHealth } from "./sidecar-health"

const never = new Promise<void>(() => {})
const defer = () => {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe("awaitSidecarHealth", () => {
  test("stays silent when the sidecar becomes healthy before the slow threshold", async () => {
    let slowCalls = 0
    const result = await awaitSidecarHealth({
      wait: Promise.resolve(),
      slowMs: 50,
      timeoutMs: 200,
      onSlow: () => slowCalls++,
    })

    expect(result).toEqual({ healthy: true, notifiedSlow: false })
    expect(slowCalls).toBe(0)
  })

  test("notifies once while still waiting, then reports healthy when it recovers", async () => {
    const health = defer()
    let slowCalls = 0
    const pending = awaitSidecarHealth({
      wait: health.promise,
      slowMs: 10,
      timeoutMs: 500,
      onSlow: () => slowCalls++,
    })

    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(slowCalls).toBe(1)

    health.resolve()
    expect(await pending).toEqual({ healthy: true, notifiedSlow: true })
    expect(slowCalls).toBe(1)
  })

  test("reports unhealthy after the timeout without throwing", async () => {
    let slowCalls = 0
    const result = await awaitSidecarHealth({
      wait: never,
      slowMs: 10,
      timeoutMs: 60,
      onSlow: () => slowCalls++,
    })

    expect(result).toEqual({ healthy: false, notifiedSlow: true })
    expect(slowCalls).toBe(1)
  })

  test("treats a rejected health wait as unhealthy instead of propagating", async () => {
    const health = defer()
    const pending = awaitSidecarHealth({
      wait: health.promise,
      slowMs: 1000,
      timeoutMs: 1000,
      onSlow: () => undefined,
    })

    health.reject(new Error("boom"))
    expect(await pending).toEqual({ healthy: false, notifiedSlow: false })
  })

  test("suppresses a slow-timer callback that lands after the health wait settled", async () => {
    let slowCalls = 0
    let fireSlow: (() => void) | undefined

    const result = await awaitSidecarHealth({
      wait: Promise.resolve(),
      slowMs: 10,
      timeoutMs: 100,
      onSlow: () => slowCalls++,
      setTimer: ((fn: () => void, ms: number) => {
        if (ms === 10) fireSlow = fn
        return ms
      }) as unknown as typeof setTimeout,
      clearTimer: (() => undefined) as unknown as typeof clearTimeout,
    })

    expect(result).toEqual({ healthy: true, notifiedSlow: false })

    // 模拟回调已入队、赶在 clearTimer 之后才执行：正常启动不该闪告警
    fireSlow?.()
    expect(slowCalls).toBe(0)
  })

  test("clears both timers so a resolved startup leaves nothing pending", async () => {
    const cleared: unknown[] = []
    await awaitSidecarHealth({
      wait: Promise.resolve(),
      slowMs: 50,
      timeoutMs: 200,
      onSlow: () => undefined,
      clearTimer: ((handle: unknown) => cleared.push(handle)) as typeof clearTimeout,
    })

    expect(cleared).toHaveLength(2)
  })
})

describe("startup wiring", () => {
  test("main process surfaces the notice instead of silently swallowing the timeout", async () => {
    const source = await Bun.file(new URL("./index.ts", import.meta.url)).text()

    expect(source).toContain('import { awaitSidecarHealth } from "./sidecar-health"')
    expect(source).toContain("const SIDECAR_SLOW_NOTICE_MS = 8_000")
    expect(source).toContain("const SIDECAR_HEALTH_TIMEOUT_MS = 30_000")
    expect(source).toContain('setInitStep({ phase: "server_unreachable" })')
    // 旧的静默吞掉写法不能再出现
    expect(source).not.toContain('throw new Error("Sidecar health check timed out")')
  })

  test("loading window renders the notice for the unreachable phase", async () => {
    const source = await Bun.file(new URL("../renderer/loading.tsx", import.meta.url)).text()

    expect(source).toContain('phase() === "server_unreachable"')
    expect(source).toContain('data-slot="desktop-loading-notice"')
    expect(source).toContain("desktop.loading.sidecar.slow.title")
    expect(source).toContain("desktop.loading.sidecar.slow.hint")
    expect(source).toContain("flex flex-col items-center justify-center")
  })

  test("init step union carries the unreachable phase", async () => {
    const source = await Bun.file(new URL("../preload/types.ts", import.meta.url)).text()

    expect(source).toContain('{ phase: "server_unreachable" }')
  })

  test("notice copy exists in both shipped locales", async () => {
    const en = await Bun.file(new URL("../renderer/i18n/en.ts", import.meta.url)).text()
    const zh = await Bun.file(new URL("../renderer/i18n/zh.ts", import.meta.url)).text()

    for (const dict of [en, zh]) {
      expect(dict).toContain("desktop.loading.sidecar.slow.title")
      expect(dict).toContain("desktop.loading.sidecar.slow.hint")
    }
    expect(zh).toContain("127.0.0.1")
  })
})
