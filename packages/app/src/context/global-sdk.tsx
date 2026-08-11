import type { Event } from "@opencode-ai/sdk/v2/client"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { createGlobalEmitter } from "@solid-primitives/event-bus"
import { makeEventListener } from "@solid-primitives/event-listener"
import { batch, onCleanup, onMount } from "solid-js"
import z from "zod"
import { createSdkForServer } from "@/utils/server"
import { createPerfMeter } from "@/utils/perf-meter"
import { useLanguage } from "./language"
import { usePlatform } from "./platform"
import { useServer } from "./server"
import {
  coalescedEventKey,
  deltaKey,
  filterStaleDeltas,
  mergeCoalescedPayload,
  type QueuedEvent,
} from "./global-sdk-event-queue"

const abortError = z.object({
  name: z.literal("AbortError"),
})

export const { use: useGlobalSDK, provider: GlobalSDKProvider } = createSimpleContext({
  name: "GlobalSDK",
  init: () => {
    const language = useLanguage()
    const server = useServer()
    const platform = usePlatform()
    const abort = new AbortController()

    const eventFetch = (() => {
      if (!platform.fetch || !server.current) return
      try {
        const url = new URL(server.current.http.url)
        const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1"
        if (url.protocol === "http:" && !loopback) return platform.fetch
      } catch {
        return
      }
    })()

    const currentServer = server.current
    if (!currentServer) throw new Error(language.t("error.globalSDK.noServerAvailable"))

    const eventSdk = createSdkForServer({
      signal: abort.signal,
      fetch: eventFetch,
      server: currentServer.http,
    })
    const emitter = createGlobalEmitter<{
      [key: string]: Event
    }>()
    const perf = createPerfMeter("dialogue-stream", { enabled: import.meta.env.DEV ? true : undefined })

    const FLUSH_FRAME_MS = 16
    const FLUSH_BUDGET_MS = 8
    const STREAM_YIELD_MS = 8
    const RECONNECT_DELAY_MS = 250
    // 事件队列硬上限：超过后丢弃新增的 file.watcher.updated，防止风暴场景无界增长导致 OOM。
    const QUEUE_MAX = 20_000

    let queue: QueuedEvent[] = []
    let buffer: QueuedEvent[] = []
    const coalesced = new Map<string, number>()
    const staleDeltaCutoffs = new Map<string, number>()
    let timer: ReturnType<typeof setTimeout> | undefined
    let last = 0

    const flush = () => {
      if (timer) clearTimeout(timer)
      timer = undefined

      if (queue.length === 0) return

      const started = performance.now()
      const items = queue
      const stale = new Map(staleDeltaCutoffs)
      queue = buffer
      buffer = items
      queue.length = 0
      coalesced.clear()
      staleDeltaCutoffs.clear()
      const events = filterStaleDeltas(items, stale)

      last = Date.now()
      let emitted = 0
      const skipped = items.length - events.length
      let remaining: QueuedEvent[] | undefined
      batch(() => {
        for (let i = 0; i < events.length; i++) {
          if (i > 0 && performance.now() - started > FLUSH_BUDGET_MS) {
            remaining = events.slice(i)
            break
          }
          const event = events[i]
          if (!event) continue
          emitter.emit(event.directory, event.payload)
          emitted += 1
        }
      })

      perf.count("flush")
      perf.count("emitted", emitted)
      if (skipped > 0) perf.count("skipped_delta", skipped)
      perf.observe("batch_size", events.length)
      perf.observe("flush_ms", performance.now() - started)
      if (remaining?.length) {
        perf.count("yielded", remaining.length)
        queue.push(...remaining)
        for (let i = 0; i < queue.length; i++) {
          const item = queue[i]
          if (!item) continue
          const k = coalescedEventKey(item.directory, item.payload)
          if (k) coalesced.set(k, i)
        }
        schedule()
      }
      buffer.length = 0
    }

    const schedule = () => {
      if (timer) return
      const elapsed = Date.now() - last
      timer = setTimeout(flush, Math.max(0, FLUSH_FRAME_MS - elapsed))
    }

    let streamErrorLogged = false
    const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
    const aborted = (error: unknown) => abortError.safeParse(error).success

    let attempt: AbortController | undefined
    let run: Promise<void> | undefined
    let started = false
    const HEARTBEAT_TIMEOUT_MS = 15_000
    let lastEventAt = Date.now()
    let heartbeat: ReturnType<typeof setTimeout> | undefined
    const resetHeartbeat = () => {
      lastEventAt = Date.now()
      if (heartbeat) clearTimeout(heartbeat)
      heartbeat = setTimeout(() => {
        perf.count("heartbeat_abort")
        attempt?.abort()
      }, HEARTBEAT_TIMEOUT_MS)
    }
    const clearHeartbeat = () => {
      if (!heartbeat) return
      clearTimeout(heartbeat)
      heartbeat = undefined
    }

    const start = () => {
      if (started) return run
      started = true
      run = (async () => {
        // oxlint-disable-next-line no-unmodified-loop-condition -- `started` is set to false by stop() which also aborts; both flags are checked to allow graceful exit
        while (!abort.signal.aborted && started) {
          attempt = new AbortController()
          lastEventAt = Date.now()
          const onAbort = () => {
            attempt?.abort()
          }
          abort.signal.addEventListener("abort", onAbort)
          try {
            perf.count("connect_attempt")
            const events = await eventSdk.global.event({
              signal: attempt.signal,
              onSseError: (error) => {
                if (aborted(error)) return
                if (streamErrorLogged) return
                streamErrorLogged = true
                console.error("[global-sdk] event stream error", {
                  url: currentServer.http.url,
                  fetch: eventFetch ? "platform" : "webview",
                  error,
                })
              },
            })
            let yielded = Date.now()
            let firstEvent = true
            perf.mark("stream_open")
            resetHeartbeat()
            for await (const event of events.stream) {
              const receivedAt = Date.now()
              perf.count("received")
              perf.observe("stream_gap_ms", receivedAt - lastEventAt)
              resetHeartbeat()
              streamErrorLogged = false
              if (firstEvent) {
                firstEvent = false
                perf.mark("first_event")
              }
              const directory = event.directory ?? "global"
              if (event.payload.type === "sync") {
                perf.count("sync")
                continue
              }

              const payloadType = String(event.payload.type)
              const payload = event.payload as Event
              if (payloadType === "message.part.delta") perf.count("delta")
              else if (payloadType === "message.part.updated") perf.count("part_updated")
              else if (payloadType === "server.heartbeat") perf.count("heartbeat")
              else perf.count("other")

              const k = coalescedEventKey(directory, payload)
              if (k) {
                const i = coalesced.get(k)
                if (i !== undefined) {
                  const prev = queue[i]
                  queue[i] = { directory, payload: prev ? mergeCoalescedPayload(prev.payload, payload) : payload }
                  perf.count("coalesced")
                  if (payload.type === "message.part.updated") {
                    const part = payload.properties.part
                    staleDeltaCutoffs.set(deltaKey(directory, part.messageID, part.id), queue.length)
                    perf.count("stale_delta")
                  }
                  continue
                }
              }
              // 硬上限兜底：队列积压超阈值时丢弃新增的 file.watcher.updated（最不关键，
              // 目录刷新会自愈），防止编译等风暴把渲染进程内存打爆 OOM。源头 Layer 已折叠，
              // 此路径仅极端情况触发。
              if (queue.length >= QUEUE_MAX && payloadType === "file.watcher.updated") {
                perf.count("dropped_watcher")
                continue
              }
              if (k) coalesced.set(k, queue.length)
              queue.push({ directory, payload })
              perf.observe("queue_depth", queue.length)
              schedule()

              if (Date.now() - yielded < STREAM_YIELD_MS) continue
              yielded = Date.now()
              await wait(0)
            }
          } catch (error) {
            if (!aborted(error) && !streamErrorLogged) {
              streamErrorLogged = true
              console.error("[global-sdk] event stream failed", {
                url: currentServer.http.url,
                fetch: eventFetch ? "platform" : "webview",
                error,
              })
            }
          } finally {
            abort.signal.removeEventListener("abort", onAbort)
            attempt = undefined
            clearHeartbeat()
          }

          if (abort.signal.aborted || !started) return
          perf.count("reconnect")
          await wait(RECONNECT_DELAY_MS)
        }
      })().finally(() => {
        run = undefined
        flush()
        perf.close()
      })
      return run
    }

    const stop = () => {
      started = false
      attempt?.abort()
      clearHeartbeat()
    }

    onMount(() => {
      makeEventListener(document, "visibilitychange", () => {
        if (document.visibilityState !== "visible") return
        if (!started) return
        if (Date.now() - lastEventAt < HEARTBEAT_TIMEOUT_MS) return
        attempt?.abort()
      })
    })

    onCleanup(() => {
      stop()
      abort.abort()
      flush()
      perf.close()
    })

    const sdk = createSdkForServer({
      server: server.current.http,
      fetch: platform.fetch,
      throwOnError: true,
    })

    return {
      url: currentServer.http.url,
      client: sdk,
      event: {
        on: emitter.on.bind(emitter),
        listen: emitter.listen.bind(emitter),
        start,
      },
      createClient(opts: Omit<Parameters<typeof createSdkForServer>[0], "server" | "fetch">) {
        const s = server.current
        if (!s) throw new Error(language.t("error.globalSDK.serverNotAvailable"))
        return createSdkForServer({
          server: s.http,
          fetch: platform.fetch,
          ...opts,
        })
      },
    }
  },
})
