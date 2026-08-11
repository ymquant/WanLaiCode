#!/usr/bin/env bun

import path from "path"
import { Global } from "@opencode-ai/core/global"
import { NetProxy } from "../src/net/proxy"

type ProxyConfig = {
  mode?: "system" | "manual" | "none"
  url?: string
  http_url?: string
  https_url?: string
  no_proxy?: string
}

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

let proxyHits = 0
let targetHits = 0

const target = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch() {
    targetHits++
    return new Response("direct", { headers: { "content-type": "text/plain" } })
  },
})

const externalUrl = "http://example.test/proxy-smoke"
const loopbackUrl = `http://127.0.0.1:${target.port}/proxy-smoke`
const proxy = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(request) {
    proxyHits++
    return new Response(`proxied ${request.url}`, { headers: { "content-type": "text/plain" } })
  },
})

const proxyUrl = `http://127.0.0.1:${proxy.port}`
const reports: Array<{ name: string; proxyHits: number; targetHits: number }> = []

function clearProxyEnv() {
  for (const key of envKeys) delete process.env[key]
}

async function writeConfig(proxy: ProxyConfig | undefined) {
  await Bun.write(
    path.join(Global.Path.config, "wanlaicode.json"),
    JSON.stringify(proxy === undefined ? {} : { proxy }, null, 2),
  )
}

function displayConfig(proxyConfig: ProxyConfig | undefined) {
  if (proxyConfig === undefined) return "{}"
  return JSON.stringify(
    Object.fromEntries(
      Object.entries({
        mode: proxyConfig.mode ?? "system",
        url: proxyConfig.url,
        http_url: proxyConfig.http_url,
        https_url: proxyConfig.https_url,
        no_proxy: proxyConfig.no_proxy,
      }).filter((entry) => entry[1]),
    ),
  )
}

async function scenario(
  name: string,
  proxyConfig: ProxyConfig | undefined,
  expected: string,
  run: () => Promise<string>,
) {
  proxyHits = 0
  targetHits = 0
  console.log("")
  console.log(`开始测试：${name}`)
  console.log(`  配置：${displayConfig(proxyConfig)}`)
  console.log(`  预期：${expected}`)
  await writeConfig(proxyConfig)
  const actual = await run()
  console.log(`  实际：${actual}`)
  console.log(`  命中统计：代理 ${proxyHits} 次，本地目标 ${targetHits} 次`)
  console.log(`通过：${name}`)
  reports.push({ name, proxyHits, targetHits })
}

function expectHit(name: string, actual: number, expected: number) {
  if (actual === expected) return
  throw new Error(`${name}：预期 ${expected} 次，实际 ${actual} 次`)
}

async function read(fetcher: typeof fetch) {
  return await fetcher(externalUrl, { signal: AbortSignal.timeout(5_000) }).then((res) => res.text())
}

try {
  await using tmp = await (async () => {
    const dir = await Bun.$`mktemp -d`.text().then((value) => value.trim())
    return {
      path: dir,
      async [Symbol.asyncDispose]() {
        await Bun.$`rm -rf ${dir}`.quiet()
      },
    }
  })()

  ;(Global.Path as { config: string }).config = tmp.path
  clearProxyEnv()
  process.env.OPENCODE_DISABLE_OS_PROXY = "1"

  console.log("代理冒烟测试开始")
  console.log(`  临时配置目录：${tmp.path}`)
  console.log(`  外部请求目标：${externalUrl}`)
  console.log(`  本地直连目标：${loopbackUrl}`)
  console.log(`  假代理地址：${proxyUrl}`)
  console.log("  说明：本脚本只使用临时配置和本地测试服务，不会修改真实用户配置。")

  await scenario("手动代理会让外部应用 HTTP 请求走配置的代理", { mode: "manual", url: proxyUrl }, "请求返回假代理响应，代理命中 1 次，本地目标不命中", async () => {
    const body = await read(NetProxy.create("proxy-smoke.manual"))
    if (!body.startsWith("proxied ")) throw new Error(`手动代理：响应不符合预期 ${JSON.stringify(body)}`)
    expectHit("手动代理的代理命中次数", proxyHits, 1)
    expectHit("手动代理的本地目标命中次数", targetHits, 0)
    return `收到响应 ${JSON.stringify(body)}`
  })

  await scenario("关闭代理会强制应用 HTTP 请求直连", { mode: "none", url: proxyUrl }, "解析结果为 none，且不会命中假代理", async () => {
    const resolved = await NetProxy.resolve(externalUrl)
    if (resolved.mode !== "none" || resolved.proxy) throw new Error(`关闭代理：解析结果不符合预期 ${JSON.stringify(resolved)}`)
    expectHit("关闭代理的代理命中次数", proxyHits, 0)
    expectHit("关闭代理的本地目标命中次数", targetHits, 0)
    return `解析结果 ${JSON.stringify(resolved)}`
  })

  await scenario("no_proxy 命中时会绕过手动代理", { mode: "manual", url: proxyUrl, no_proxy: "example.test" }, "example.test 被 no_proxy 命中，解析结果不带代理地址", async () => {
    const resolved = await NetProxy.resolve(externalUrl)
    if (resolved.mode !== "manual" || resolved.proxy) throw new Error(`no_proxy：解析结果不符合预期 ${JSON.stringify(resolved)}`)
    expectHit("no_proxy 的代理命中次数", proxyHits, 0)
    expectHit("no_proxy 的本地目标命中次数", targetHits, 0)
    return `解析结果 ${JSON.stringify(resolved)}`
  })

  await scenario("本地 loopback 地址始终绕过代理", { mode: "manual", url: proxyUrl }, "127.0.0.1 直连本地目标，代理不命中，本地目标命中 1 次", async () => {
    const body = await NetProxy.create("proxy-smoke.loopback")(loopbackUrl, { signal: AbortSignal.timeout(5_000) }).then((res) =>
      res.text(),
    )
    if (body !== "direct") throw new Error(`loopback：响应不符合预期 ${JSON.stringify(body)}`)
    expectHit("loopback 的代理命中次数", proxyHits, 0)
    expectHit("loopback 的本地目标命中次数", targetHits, 1)
    return `收到本地目标响应 ${JSON.stringify(body)}`
  })

  process.env.HTTP_PROXY = proxyUrl
  await scenario("系统代理模式会读取 HTTP_PROXY 环境变量", { mode: "system" }, `HTTP_PROXY=${proxyUrl} 时请求返回假代理响应`, async () => {
    const body = await read(NetProxy.create("proxy-smoke.system"))
    if (!body.startsWith("proxied ")) throw new Error(`系统代理：响应不符合预期 ${JSON.stringify(body)}`)
    expectHit("系统代理的代理命中次数", proxyHits, 1)
    expectHit("系统代理的本地目标命中次数", targetHits, 0)
    return `收到响应 ${JSON.stringify(body)}`
  })

  console.log("")
  console.log("测试汇总：")
  for (const report of reports) console.log(`  - ${report.name}：通过（代理 ${report.proxyHits} 次，本地目标 ${report.targetHits} 次）`)
  console.log("")
  console.log(`代理冒烟测试全部通过：${reports.length}/${reports.length}`)
  console.log(`外部请求目标：${externalUrl}`)
  console.log(`本地直连目标：${loopbackUrl}`)
  console.log(`假代理地址：${proxyUrl}`)
} finally {
  target.stop(true)
  proxy.stop(true)
  ;(Global.Path as { config: string }).config = originalConfig
  for (const key of envKeys) {
    if (originalEnv[key] === undefined) delete process.env[key]
    else process.env[key] = originalEnv[key]
  }
}
