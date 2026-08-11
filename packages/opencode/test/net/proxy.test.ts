import { afterEach, describe, expect, test } from "bun:test"
import { Global } from "@opencode-ai/core/global"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { NetProxy } from "../../src/net/proxy"

const envKeys = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "OPENCODE_DISABLE_OS_PROXY",
]
const originalConfig = Global.Path.config
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]))

async function withGlobalConfig<T>(proxy: unknown, fn: () => Promise<T>) {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(path.join(dir, "wanlaicode.json"), JSON.stringify({ proxy }, null, 2))
    },
  })
  ;(Global.Path as { config: string }).config = tmp.path
  return await fn()
}

function clearProxyEnv() {
  for (const key of envKeys) delete process.env[key]
}

afterEach(() => {
  ;(Global.Path as { config: string }).config = originalConfig
  for (const key of envKeys) {
    if (originalEnv[key] === undefined) delete process.env[key]
    else process.env[key] = originalEnv[key]
  }
})

describe("NetProxy", () => {
  test("defaults to none — ignores system/env proxy unless explicitly enabled", async () => {
    clearProxyEnv()
    process.env.OPENCODE_DISABLE_OS_PROXY = "1"
    process.env.HTTPS_PROXY = "http://127.0.0.1:7890"
    await withGlobalConfig(undefined, async () => {
      expect(await NetProxy.resolve("https://example.com")).toEqual({ mode: "none" })
    })
  })

  test("system mode (explicit) reads env proxy", async () => {
    clearProxyEnv()
    process.env.OPENCODE_DISABLE_OS_PROXY = "1"
    process.env.HTTPS_PROXY = "http://127.0.0.1:7890"
    await withGlobalConfig({ mode: "system" }, async () => {
      expect(await NetProxy.resolve("https://example.com")).toMatchObject({
        mode: "system",
        proxy: "http://127.0.0.1:7890/",
        source: "env",
      })
    })
  })

  test("manual protocol-specific URLs override shared proxy URL", async () => {
    clearProxyEnv()
    await withGlobalConfig(
      {
        mode: "manual",
        url: "http://127.0.0.1:7890",
        http_url: "http://127.0.0.1:7891",
        https_url: "http://127.0.0.1:7892",
      },
      async () => {
        expect(await NetProxy.resolve("http://example.com")).toMatchObject({
          mode: "manual",
          proxy: "http://127.0.0.1:7891/",
          source: "config",
        })
        expect(await NetProxy.resolve("https://example.com")).toMatchObject({
          mode: "manual",
          proxy: "http://127.0.0.1:7892/",
          source: "config",
        })
      },
    )
  })

  test("none mode forces direct app-owned HTTP requests", async () => {
    clearProxyEnv()
    process.env.HTTP_PROXY = "http://127.0.0.1:7890"
    await withGlobalConfig({ mode: "none" }, async () => {
      expect(await NetProxy.resolve("http://example.com")).toEqual({ mode: "none" })
    })
  })

  test("no_proxy matches builtin loopback, suffix, wildcard, port, and IPv6 rules", async () => {
    expect(NetProxy.shouldBypass(new URL("http://localhost:4096"))).toBe(true)
    expect(NetProxy.shouldBypass(new URL("http://127.0.0.1:4096"))).toBe(true)
    expect(NetProxy.shouldBypass(new URL("http://service.local"))).toBe(true)
    expect(NetProxy.shouldBypass(new URL("https://api.example.com"), { no_proxy: ".example.com" })).toBe(true)
    expect(NetProxy.shouldBypass(new URL("https://api.example.com:8443"), { no_proxy: "api.example.com:8443" })).toBe(true)
    expect(NetProxy.shouldBypass(new URL("https://api.example.com:443"), { no_proxy: "api.example.com:8443" })).toBe(false)
    expect(NetProxy.shouldBypass(new URL("http://[::1]:4096"))).toBe(true)
    expect(NetProxy.shouldBypass(new URL("https://anything.test"), { no_proxy: "*" })).toBe(true)
    expect(NetProxy.shouldBypass(new URL("https://semicolon.test"), { no_proxy: "api.test;semicolon.test" })).toBe(true)
  })

  test("maskProxyUrl hides credentials", () => {
    expect(NetProxy.maskProxyUrl("http://user:pass@127.0.0.1:7890")).toBe("http://***:***@127.0.0.1:7890/")
  })

  test("maskProxyUrl hides credentials in unparseable proxy urls (no scheme / invalid port)", () => {
    // new URL 成功但 user:pass@ 落在非标准位置(opaque path),提取不到 username/password
    expect(NetProxy.maskProxyUrl("user:pass@127.0.0.1:bad")).not.toContain("pass")
    // new URL 失败(非法 port)走 catch 分支,正则兜底打码
    expect(NetProxy.maskProxyUrl("http://user:pass@127.0.0.1:bad")).toBe("http://***:***@127.0.0.1:bad")
  })

  test("visibleSystemProxy returns environment proxy values without credentials", async () => {
    clearProxyEnv()
    process.env.OPENCODE_DISABLE_OS_PROXY = "1"
    process.env.HTTP_PROXY = "http://user:pass@127.0.0.1:7890"
    process.env.HTTPS_PROXY = "http://127.0.0.1:7891"
    process.env.NO_PROXY = "localhost,127.0.0.1"

    expect(await NetProxy.visibleSystemProxy()).toEqual({
      http: "http://***:***@127.0.0.1:7890/",
      https: "http://127.0.0.1:7891/",
      all: undefined,
      no_proxy: "localhost,127.0.0.1",
    })
  })

  test("parseMacSystemProxy reads enabled macOS web proxy settings", () => {
    expect(
      NetProxy.parseMacSystemProxy(`
<dictionary> {
  ExceptionsList : <array> {
    0 : *.local
    1 : 169.254/16
  }
  HTTPEnable : 1
  HTTPPort : 7890
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7891
  HTTPSProxy : 127.0.0.1
}
`),
    ).toEqual({
      http: "http://127.0.0.1:7890/",
      https: "http://127.0.0.1:7891/",
      no_proxy: "*.local,169.254/16",
    })
  })

  test("parseWindowsSystemProxy reads shared proxy and bypass list from registry output", () => {
    expect(
      NetProxy.parseWindowsSystemProxy(`
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings
    ProxyEnable    REG_DWORD    0x1
    ProxyServer    REG_SZ       127.0.0.1:7890
    ProxyOverride  REG_SZ       localhost;127.*;<local>
`),
    ).toEqual({
      http: "http://127.0.0.1:7890/",
      https: "http://127.0.0.1:7890/",
      no_proxy: "localhost,127.*,<local>",
    })
  })

  test("parseWindowsSystemProxy reads protocol-specific proxy URLs", () => {
    expect(
      NetProxy.parseWindowsSystemProxy(`
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings
    ProxyEnable    REG_DWORD    0x1
    ProxyServer    REG_SZ       http=127.0.0.1:7891;https=http://127.0.0.1:7892
`),
    ).toEqual({
      http: "http://127.0.0.1:7891/",
      https: "http://127.0.0.1:7892/",
      no_proxy: undefined,
    })
  })

  test("parseWindowsSystemProxy returns empty info when disabled", () => {
    expect(
      NetProxy.parseWindowsSystemProxy(`
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings
    ProxyEnable    REG_DWORD    0x0
    ProxyServer    REG_SZ       127.0.0.1:7890
`),
    ).toEqual({})
  })

  test("create falls back to direct (no proxy) on invalid manual proxy URL", async () => {
    clearProxyEnv()
    const previous = globalThis.fetch
    const calls: Array<{ url: string; proxy?: string }> = []
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit & { proxy?: string }) => {
        calls.push({ url: input.toString(), proxy: init?.proxy })
        return new Response("ok")
      },
      { preconnect: previous.preconnect },
    ) as typeof fetch
    try {
      // 非 http(s) 代理(手改 config 绕过前端校验):resolve() 不抛错、降级直连,而非拖垮所有请求
      await withGlobalConfig({ mode: "manual", url: "socks5://127.0.0.1:1080" }, async () => {
        await NetProxy.create("test")("https://example.com")
      })
    } finally {
      globalThis.fetch = previous
    }
    expect(calls).toEqual([{ url: "https://example.com", proxy: undefined }])
  })

  test("no_proxy supports Windows proxy override local and wildcard rules", () => {
    expect(NetProxy.shouldBypass(new URL("https://intranet"), { no_proxy: "<local>" })).toBe(true)
    expect(NetProxy.shouldBypass(new URL("https://intranet.example.com"), { no_proxy: "<local>" })).toBe(false)
    expect(NetProxy.shouldBypass(new URL("https://api.internal.test"), { no_proxy: "*.internal.test" })).toBe(true)
    expect(NetProxy.shouldBypass(new URL("https://10.0.0.8"), { no_proxy: "10.*" })).toBe(true)
  })

  test("create applies proxy to external requests and skips loopback", async () => {
    clearProxyEnv()
    const previous = globalThis.fetch
    const calls: Array<{ url: string; proxy?: string }> = []
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit & { proxy?: string }) => {
        calls.push({ url: input.toString(), proxy: init?.proxy })
        return new Response("ok")
      },
      { preconnect: previous.preconnect },
    ) as typeof fetch
    try {
      await withGlobalConfig({ mode: "manual", url: "http://127.0.0.1:7890" }, async () => {
        const proxyFetch = NetProxy.create("test")
        await proxyFetch("https://example.com")
        await proxyFetch("http://localhost:4096/health")
      })
    } finally {
      globalThis.fetch = previous
    }

    expect(calls).toEqual([
      { url: "https://example.com", proxy: "http://127.0.0.1:7890/" },
      { url: "http://localhost:4096/health", proxy: undefined },
    ])
  })

  test("create falls back to direct when the proxy endpoint is unreachable, then skips the dead proxy", async () => {
    clearProxyEnv()
    const previous = globalThis.fetch
    const calls: Array<{ url: string; proxy?: string }> = []
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit & { proxy?: string }) => {
        calls.push({ url: input.toString(), proxy: init?.proxy })
        // 模拟已退出的代理软件:连到 127.0.0.1:7899 直接被拒
        if (init?.proxy) throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:7899"), { code: "ECONNREFUSED" })
        return new Response("ok")
      },
      { preconnect: previous.preconnect },
    ) as typeof fetch
    try {
      await withGlobalConfig({ mode: "manual", url: "http://127.0.0.1:7899" }, async () => {
        const proxyFetch = NetProxy.create("test")
        // 首个请求:先撞死代理 → 降级直连自愈
        expect((await proxyFetch("https://example.com")).ok).toBe(true)
        // 后续请求:死代理已被短期记忆,直接直连,不再重复撞代理
        expect((await proxyFetch("https://example.com")).ok).toBe(true)
      })
    } finally {
      globalThis.fetch = previous
    }

    expect(calls).toEqual([
      { url: "https://example.com", proxy: "http://127.0.0.1:7899/" },
      { url: "https://example.com", proxy: undefined },
      { url: "https://example.com", proxy: undefined },
    ])
  })

  test("create does not fall back to direct on mid-flight errors (request may already be sent)", async () => {
    clearProxyEnv()
    const previous = globalThis.fetch
    const calls: Array<{ url: string; proxy?: string }> = []
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit & { proxy?: string }) => {
        calls.push({ url: input.toString(), proxy: init?.proxy })
        // ECONNRESET 可能发生在请求已发出之后:不可安全重试,应原样抛出而非静默降级(避免重发非幂等 POST)
        if (init?.proxy) throw Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" })
        return new Response("ok")
      },
      { preconnect: previous.preconnect },
    ) as typeof fetch
    try {
      await withGlobalConfig({ mode: "manual", url: "http://127.0.0.1:7898" }, async () => {
        await expect(NetProxy.create("test")("https://example.com")).rejects.toThrow("ECONNRESET")
      })
    } finally {
      globalThis.fetch = previous
    }
    // 只撞了一次代理,没有降级直连
    expect(calls).toEqual([{ url: "https://example.com", proxy: "http://127.0.0.1:7898/" }])
  })

  test("create rethrows the original connection error (not 'body already used') for an unreplayable POST Request", async () => {
    clearProxyEnv()
    const previous = globalThis.fetch
    const calls: Array<{ url: string; proxy?: string }> = []
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit & { proxy?: string }) => {
        const isReq = input instanceof Request
        calls.push({ url: isReq ? input.url : input.toString(), proxy: init?.proxy })
        if (init?.proxy) {
          // 忠实模拟:真实 fetch 首次尝试即消费 Request body(即便连不上代理、请求未发出)
          if (isReq && input.body) await input.text().catch(() => {})
          throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:7897"), { code: "ECONNREFUSED" })
        }
        // 直连分支:模拟真实 fetch —— 已消费的 Request 无法再次发送
        if (isReq && input.bodyUsed) throw new Error("Request body already used")
        return new Response("ok")
      },
      { preconnect: previous.preconnect },
    ) as typeof fetch
    try {
      await withGlobalConfig({ mode: "manual", url: "http://127.0.0.1:7897" }, async () => {
        const proxyFetch = NetProxy.create("test")
        // 带 body 的 POST Request 撞死代理后 body 已消费,不可安全重放:
        // 应抛出原始连接错误,而非把它替换成 "Request body already used"
        const req = new Request("https://example.com", { method: "POST", body: "hello" })
        const err = await proxyFetch(req).then(() => null, (e: Error) => e)
        expect(err?.message).toContain("ECONNREFUSED")
        expect(err?.message).not.toContain("body")
        // 代理已标记死亡:后续可重放请求直连自愈
        expect((await proxyFetch("https://example.com")).ok).toBe(true)
      })
    } finally {
      globalThis.fetch = previous
    }
    // 第一次仅撞代理(未降级直连),第二次直连
    expect(calls.map((c) => c.proxy)).toEqual(["http://127.0.0.1:7897/", undefined])
  })

  test("create rethrows the original error for a streaming init.body that overrides the Request (not replayable)", async () => {
    clearProxyEnv()
    const previous = globalThis.fetch
    const calls: Array<{ proxy?: string }> = []
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit & { proxy?: string }) => {
        calls.push({ proxy: init?.proxy })
        const body = init?.body
        if (init?.proxy) {
          // 忠实模拟:真实 fetch 首次尝试即锁定/消费流式 body
          if (body instanceof ReadableStream) await body.getReader().read()
          throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:7896"), { code: "ECONNREFUSED" })
        }
        // 直连分支:已锁定的流无法再次发送
        if (body instanceof ReadableStream && body.locked)
          throw new Error("Response body object should not be disturbed or locked")
        return new Response("ok")
      },
      { preconnect: previous.preconnect },
    ) as typeof fetch
    try {
      await withGlobalConfig({ mode: "manual", url: "http://127.0.0.1:7896" }, async () => {
        const stream = new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode("hello"))
            c.close()
          },
        })
        // fetch(request, { body: stream }):init.body 覆盖请求体,Request.bodyUsed 仍可能为 false,
        // 但流首次尝试即被锁定 → 不可重放,应抛出原始连接错误而非 "disturbed or locked"
        const req = new Request("https://example.com", { method: "POST", body: "orig" })
        const err = await NetProxy.create("test")(req, { body: stream, duplex: "half" } as RequestInit).then(
          () => null,
          (e: Error) => e,
        )
        expect(err?.message).toContain("ECONNREFUSED")
        expect(err?.message).not.toContain("disturbed")
      })
    } finally {
      globalThis.fetch = previous
    }
    // 仅撞了一次代理,未降级直连
    expect(calls.map((c) => c.proxy)).toEqual(["http://127.0.0.1:7896/"])
  })

  test("WanlaiCode createFetch uses configured proxy", async () => {
    clearProxyEnv()
    const previous = globalThis.fetch
    const calls: Array<{ url: string; proxy?: string }> = []
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit & { proxy?: string }) => {
        calls.push({ url: input.toString(), proxy: init?.proxy })
        return new Response("{}")
      },
      { preconnect: previous.preconnect },
    ) as typeof fetch
    try {
      await withGlobalConfig({ mode: "manual", url: "http://127.0.0.1:7890" }, async () => {
        const { WanlaiCodeAuth } = await import("../../src/provider/wanlaicode")
        await WanlaiCodeAuth.createFetch("test")("https://api.wanlai.ai/v1/models")
      })
    } finally {
      globalThis.fetch = previous
    }

    expect(calls).toEqual([{ url: "https://api.wanlai.ai/v1/models", proxy: "http://127.0.0.1:7890/" }])
  })
})
