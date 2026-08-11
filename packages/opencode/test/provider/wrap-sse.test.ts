import { test, expect, describe } from "bun:test"
import {
  wrapSSE,
  resolveChunkTimeout,
  isSSEKeepAliveEvent,
  isSSEStallKeepAlive,
  stripSSEKeepAlive,
} from "../../src/provider/provider"
import { ProviderID } from "../../src/provider/schema"

function eventStream(body: ReadableStream<Uint8Array>) {
  return new Response(body, { headers: { "content-type": "text/event-stream" } })
}

function streamOf(chunks: string[]) {
  const encoder = new TextEncoder()
  return eventStream(
    new ReadableStream<Uint8Array>({
      start(c) {
        for (const chunk of chunks) c.enqueue(encoder.encode(chunk))
        c.close()
      },
    }),
  )
}

async function readAll(res: Response) {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let out = ""
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    out += decoder.decode(value, { stream: true })
  }
  out += decoder.decode()
  return out
}

describe("provider.wrapSSE", () => {
  test("aborts with STREAM_STALL error when no chunk arrives within timeout", async () => {
    const res = eventStream(new ReadableStream<Uint8Array>({ start() {} }))
    const ctl = new AbortController()

    const reader = wrapSSE(res, 30, ctl).body!.getReader()
    let caught: unknown
    try {
      await reader.read()
    } catch (e) {
      caught = e
    }

    expect(caught).toBeDefined()
    expect((caught as { code?: string }).code).toBe("STREAM_STALL")
  })

  test("does not abort the upstream signal on stall (must not look like a user abort)", async () => {
    const res = eventStream(new ReadableStream<Uint8Array>({ start() {} }))
    const ctl = new AbortController()

    const reader = wrapSSE(res, 30, ctl).body!.getReader()
    await reader.read().catch(() => {})

    expect(ctl.signal.aborted).toBe(false)
  })

  test("passes chunks through without timing out while data keeps flowing", async () => {
    let push: ((v: Uint8Array) => void) | undefined
    let close: (() => void) | undefined
    const res = eventStream(
      new ReadableStream<Uint8Array>({
        start(c) {
          push = (v) => c.enqueue(v)
          close = () => c.close()
        },
      }),
    )
    const ctl = new AbortController()

    const reader = wrapSSE(res, 50, ctl).body!.getReader()
    push!(new TextEncoder().encode("data: a\n\n"))
    const first = await reader.read()
    expect(first.done).toBe(false)

    close!()
    const end = await reader.read()
    expect(end.done).toBe(true)
  })

  // 核心回归:心跳持续灌字节时字节级看门狗会被喂活而永不触发,事件级必须仍能判停滞。
  test("stalls even while keepalive comments keep the byte stream flowing", async () => {
    const encoder = new TextEncoder()
    let push: ((v: Uint8Array) => void) | undefined
    const res = eventStream(
      new ReadableStream<Uint8Array>({
        start(c) {
          push = (v) => c.enqueue(v)
        },
      }),
    )
    const ctl = new AbortController()
    const reader = wrapSSE(res, 40, ctl).body!.getReader()
    const beat = setInterval(() => push!(encoder.encode(": ping\n\n")), 8)

    let caught: unknown
    try {
      while (true) await reader.read()
    } catch (e) {
      caught = e
    } finally {
      clearInterval(beat)
    }

    expect((caught as { code?: string }).code).toBe("STREAM_STALL")
  })

  // 真实内容事件穿插心跳之间时不应误判停滞。
  test("keeps the stream alive while real content events arrive between heartbeats", async () => {
    const encoder = new TextEncoder()
    let push: ((v: Uint8Array) => void) | undefined
    let close: (() => void) | undefined
    const res = eventStream(
      new ReadableStream<Uint8Array>({
        start(c) {
          push = (v) => c.enqueue(v)
          close = () => c.close()
        },
      }),
    )
    const ctl = new AbortController()
    const reader = wrapSSE(res, 60, ctl).body!.getReader()
    let beats = 0
    const beat = setInterval(() => {
      push!(encoder.encode(": ping\n\n"))
      push!(encoder.encode('data: {"choices":[{"delta":{"content":"x"}}]}\n\n'))
      if (++beats >= 12) {
        clearInterval(beat)
        close!()
      }
    }, 10)

    let done = false
    let errored: unknown
    try {
      while (true) {
        const { done: d } = await reader.read()
        if (d) {
          done = true
          break
        }
      }
    } catch (e) {
      errored = e
    } finally {
      clearInterval(beat)
    }

    expect(errored).toBeUndefined()
    expect(done).toBe(true)
  })
})

describe("provider.isSSEStallKeepAlive", () => {
  test("treats a bare comment heartbeat as non-activity", () => {
    expect(isSSEStallKeepAlive(": ping")).toBe(true)
  })

  test("treats an empty event as non-activity", () => {
    expect(isSSEStallKeepAlive("")).toBe(true)
  })

  test("treats a ping data frame as non-activity", () => {
    expect(isSSEStallKeepAlive('data: {"type":"ping"}')).toBe(true)
  })

  test("treats a cost-bearing ping as non-activity", () => {
    expect(isSSEStallKeepAlive('data: {"type":"ping","cost":"0.01"}')).toBe(true)
  })

  test("treats an event:ping heartbeat as non-activity", () => {
    expect(isSSEStallKeepAlive('event: ping\ndata: {"type":"ping"}')).toBe(true)
  })

  test("counts a real chat completion chunk as activity", () => {
    expect(isSSEStallKeepAlive('data: {"choices":[{"delta":{"content":"hi"}}]}')).toBe(false)
  })

  test("counts a responses-api delta as activity", () => {
    expect(isSSEStallKeepAlive('event: response.output_text.delta\ndata: {"type":"response.output_text.delta"}')).toBe(
      false,
    )
  })

  test("counts the [DONE] terminator as activity", () => {
    expect(isSSEStallKeepAlive("data: [DONE]")).toBe(false)
  })

  test("counts non-JSON data as activity (never misclassify content)", () => {
    expect(isSSEStallKeepAlive("data: hello")).toBe(false)
  })
})

describe("provider.isSSEKeepAliveEvent", () => {
  test("drops a bare ping data frame", () => {
    expect(isSSEKeepAliveEvent('data: {"type":"ping"}')).toBe(true)
  })

  test("drops an anthropic-style event:ping frame", () => {
    expect(isSSEKeepAliveEvent('event: ping\ndata: {"type":"ping"}')).toBe(true)
  })

  test("keeps the [DONE] terminator", () => {
    expect(isSSEKeepAliveEvent("data: [DONE]")).toBe(false)
  })

  test("keeps a real chat completion chunk", () => {
    expect(isSSEKeepAliveEvent('data: {"choices":[{"delta":{"content":"hi"}}]}')).toBe(false)
  })

  test("keeps the empty-choices cost chunk", () => {
    expect(isSSEKeepAliveEvent('data: {"choices":[],"cost":"0.01"}')).toBe(false)
  })

  test("keeps an error frame", () => {
    expect(isSSEKeepAliveEvent('data: {"error":{"message":"boom"}}')).toBe(false)
  })

  test("keeps non-JSON data untouched", () => {
    expect(isSSEKeepAliveEvent("data: hello")).toBe(false)
  })

  test("keeps frames without a data line", () => {
    expect(isSSEKeepAliveEvent("event: ping")).toBe(false)
  })
})

describe("provider.stripSSEKeepAlive", () => {
  test("removes ping frames but preserves real chunks and the terminator", async () => {
    const res = streamOf([
      'data: {"choices":[{"delta":{"content":"a"}}]}\n\n',
      'data: {"type":"ping"}\n\n',
      'data: {"choices":[{"delta":{"content":"b"}}]}\n\n',
      "data: [DONE]\n\n",
    ])
    expect(await readAll(stripSSEKeepAlive(res))).toBe(
      'data: {"choices":[{"delta":{"content":"a"}}]}\n\n' +
        'data: {"choices":[{"delta":{"content":"b"}}]}\n\n' +
        "data: [DONE]\n\n",
    )
  })

  test("strips a ping split across read boundaries", async () => {
    const res = streamOf([
      'data: {"choices":[{"delta":{"content":"a"}}]}\n\ndata: {"ty',
      'pe":"ping"}\n\ndata: [DONE]\n\n',
    ])
    expect(await readAll(stripSSEKeepAlive(res))).toBe(
      'data: {"choices":[{"delta":{"content":"a"}}]}\n\n' + "data: [DONE]\n\n",
    )
  })

  test("leaves non event-stream responses untouched", async () => {
    const res = new Response("plain body", { headers: { "content-type": "application/json" } })
    expect(stripSSEKeepAlive(res)).toBe(res)
  })
})

describe("provider.resolveChunkTimeout", () => {
  test("defaults wanlaicode to a 120s stall timeout", () => {
    expect(resolveChunkTimeout(ProviderID.make("wanlaicode"), undefined)).toBe(120_000)
  })

  test("respects an explicitly configured value", () => {
    expect(resolveChunkTimeout(ProviderID.make("wanlaicode"), 5000)).toBe(5000)
  })

  test("leaves other providers without a default", () => {
    expect(resolveChunkTimeout(ProviderID.make("openai"), undefined)).toBeUndefined()
  })

  test("falls back to the default for non-positive config", () => {
    expect(resolveChunkTimeout(ProviderID.make("wanlaicode"), 0)).toBe(120_000)
  })
})
