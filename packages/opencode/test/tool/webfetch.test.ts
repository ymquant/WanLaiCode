import { describe, expect, test } from "bun:test"
import { Global } from "@opencode-ai/core/global"
import path from "path"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { Agent } from "../../src/agent/agent"
import { NetProxy } from "../../src/net/proxy"
import { Truncate } from "@/tool/truncate"
import { Instance } from "../../src/project/instance"
import { WithInstance } from "../../src/project/with-instance"
import { WebFetchTool } from "../../src/tool/webfetch"
import { SessionID, MessageID } from "../../src/session/schema"
import { tmpdir } from "../fixture/fixture"

const projectRoot = path.join(import.meta.dir, "../..")

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("message"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

async function withFetch(fetch: (req: Request) => Response | Promise<Response>, fn: (url: URL) => Promise<void>) {
  using server = Bun.serve({ port: 0, fetch })
  await fn(server.url)
}

function exec(args: { url: string; format: "text" | "markdown" | "html"; timeout?: number }) {
  return WebFetchTool.pipe(
    Effect.flatMap((info) => info.init()),
    Effect.flatMap((tool) => tool.execute(args, ctx)),
    Effect.provide(Layer.mergeAll(FetchHttpClient.layer, Truncate.defaultLayer, Agent.defaultLayer)),
    Effect.runPromise,
  )
}

function execProxy(args: { url: string; format: "text" | "markdown" | "html" }) {
  return WebFetchTool.pipe(
    Effect.flatMap((info) => info.init()),
    Effect.flatMap((tool) => tool.execute(args, ctx)),
    Effect.provide(Layer.mergeAll(NetProxy.layer, Truncate.defaultLayer, Agent.defaultLayer)),
    Effect.runPromise,
  )
}

describe("tool.webfetch", () => {
  test("uses configured proxy for external text requests", async () => {
    const requests: string[] = []
    using proxy = Bun.serve({
      port: 0,
      fetch: (request) => {
        requests.push(request.url)
        return new Response("proxied webfetch", { headers: { "content-type": "text/plain; charset=utf-8" } })
      },
    })
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "wanlaicode.json"),
          JSON.stringify({ proxy: { mode: "manual", url: proxy.url.toString() } }, null, 2),
        )
      },
    })
    const prev = Global.Path.config
    ;(Global.Path as { config: string }).config = tmp.path

    try {
      await WithInstance.provide({
        directory: projectRoot,
        fn: async () => {
          const result = await execProxy({ url: "http://example.com/file.txt", format: "text" })
          expect(result.output).toBe("proxied webfetch")
        },
      })
      expect(requests).toEqual(["http://example.com/file.txt"])
    } finally {
      ;(Global.Path as { config: string }).config = prev
    }
  })

  test("returns image responses as file attachments", async () => {
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
    await withFetch(
      () => new Response(bytes, { status: 200, headers: { "content-type": "IMAGE/PNG; charset=binary" } }),
      async (url) => {
        await WithInstance.provide({
          directory: projectRoot,
          fn: async () => {
            const result = await exec({ url: new URL("/image.png", url).toString(), format: "markdown" })
            expect(result.output).toBe("Image fetched successfully")
            expect(result.attachments).toBeDefined()
            expect(result.attachments?.length).toBe(1)
            expect(result.attachments?.[0].type).toBe("file")
            expect(result.attachments?.[0].mime).toBe("image/png")
            expect(result.attachments?.[0].url.startsWith("data:image/png;base64,")).toBe(true)
            expect(result.attachments?.[0]).not.toHaveProperty("id")
            expect(result.attachments?.[0]).not.toHaveProperty("sessionID")
            expect(result.attachments?.[0]).not.toHaveProperty("messageID")
          },
        })
      },
    )
  })

  test("keeps svg as text output", async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>hello</text></svg>'
    await withFetch(
      () =>
        new Response(svg, {
          status: 200,
          headers: { "content-type": "image/svg+xml; charset=UTF-8" },
        }),
      async (url) => {
        await WithInstance.provide({
          directory: projectRoot,
          fn: async () => {
            const result = await exec({ url: new URL("/image.svg", url).toString(), format: "html" })
            expect(result.output).toContain("<svg")
            expect(result.attachments).toBeUndefined()
          },
        })
      },
    )
  })

  test("keeps text responses as text output", async () => {
    await withFetch(
      () =>
        new Response("hello from webfetch", {
          status: 200,
          headers: { "content-type": "text/plain; charset=utf-8" },
        }),
      async (url) => {
        await WithInstance.provide({
          directory: projectRoot,
          fn: async () => {
            const result = await exec({ url: new URL("/file.txt", url).toString(), format: "text" })
            expect(result.output).toBe("hello from webfetch")
            expect(result.attachments).toBeUndefined()
          },
        })
      },
    )
  })

  test("times out when response body stalls after headers", async () => {
    using server = Bun.serve({
      port: 0,
      idleTimeout: 0,
      fetch() {
        // 秒回响应头,但 body 永不结束 —— 模拟卡死的下游
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("partial chunk..."))
          },
        })
        return new Response(stream, { headers: { "content-type": "text/plain; charset=utf-8" } })
      },
    })
    const start = Date.now()
    await WithInstance.provide({
      directory: projectRoot,
      fn: async () => {
        let err: unknown
        try {
          await exec({ url: server.url.toString(), format: "text", timeout: 2 })
        } catch (e) {
          err = e
        }
        const elapsed = Date.now() - start
        expect(err).toBeDefined()
        // 必须是 2s 超时触发,而非别的错误秒退
        expect(elapsed).toBeGreaterThan(1500)
        expect(elapsed).toBeLessThan(5000)
      },
    })
  }, 15000)
})
