import { existsSync } from "fs"
import { execFile } from "child_process"
import fs from "fs/promises"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { parse } from "jsonc-parser"
import { promisify } from "util"
import type { ConfigProxy } from "@/config/proxy"
import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "net.proxy" })

type Fetch = typeof globalThis.fetch
type FetchInput = Parameters<Fetch>[0]
type FetchInit = Parameters<Fetch>[1]
type ProxyMode = ConfigProxy.Mode
type ProxyInfo = ConfigProxy.Info

type ResolvedProxy =
  | {
      mode: Exclude<ProxyMode, "none">
      proxy: string
      source: "config" | "env"
    }
  | {
      mode: ProxyMode
      proxy?: undefined
      source?: undefined
    }

export type SystemProxyInfo = {
  http?: string
  https?: string
  all?: string
  no_proxy?: string
}

const CONFIG_FILES = ["config.json", "wanlaicode.json", "wanlaicode.jsonc"] as const
const BUILTIN_NO_PROXY = ["localhost", "127.0.0.1", "::1", ".local"] as const
const SYSTEM_PROXY_COMMAND_TIMEOUT_MS = 2_000
// 代理端点判定不可达后的「冷却期」:期内直接直连,不再逐请求重撞死代理;过期后再试一次以便代理恢复后自动回切。
const PROXY_DEAD_TTL_MS = 30_000
// 「连接建立阶段」失败:请求还没发出去(连不上代理端口/解析不了代理主机),如已退出的代理软件留下的 127.0.0.1:port。
// 只匹配这类错误才降级——保证本次请求从未发送,重试直连既不会重复发送非幂等 POST、也不会踩到已消费的 body。
// 刻意不含 ECONNRESET/EPIPE/ETIMEDOUT/UND_ERR_SOCKET 等 mid-flight 错误:那些可能发生在请求已发出之后,无法安全重试。
const PROXY_UNREACHABLE_PATTERN =
  /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|EADDRNOTAVAIL|UND_ERR_CONNECT_TIMEOUT|connection refused|getaddrinfo|failed to connect|unable to connect|could not connect/i
const agentCache = new Map<string, unknown>()
const deadProxies = new Map<string, number>()
const execFileAsync = promisify(execFile)
let directAgent: unknown
let osProxyCache: { expires: number; info: SystemProxyInfo } | undefined

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function clean(value: unknown) {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed : undefined
}

function mode(value: unknown): ProxyMode | undefined {
  if (value === "system" || value === "manual" || value === "none") return value
  return undefined
}

function normalizeProxyInfo(value: unknown): ProxyInfo | undefined {
  if (!isRecord(value)) return undefined
  const result = {
    mode: mode(value.mode),
    url: clean(value.url),
    http_url: clean(value.http_url),
    https_url: clean(value.https_url),
    no_proxy: clean(value.no_proxy),
  }
  if (!result.mode && !result.url && !result.http_url && !result.https_url && !result.no_proxy) return undefined
  return result
}

export async function readGlobalProxyConfig() {
  let result: ProxyInfo | undefined
  for (const file of CONFIG_FILES) {
    const filepath = path.join(Global.Path.config, file)
    if (!existsSync(filepath)) continue
    try {
      const parsed = parse(await fs.readFile(filepath, "utf8"))
      const next = normalizeProxyInfo(isRecord(parsed) ? parsed.proxy : undefined)
      if (next) result = { ...result, ...next }
    } catch {}
  }
  return result
}

function env(name: string) {
  return clean(process.env[name])
}

function envProxyFor(url: URL) {
  if (url.protocol === "http:") return env("HTTP_PROXY") ?? env("http_proxy") ?? env("ALL_PROXY") ?? env("all_proxy")
  return (
    env("HTTPS_PROXY") ??
    env("https_proxy") ??
    env("ALL_PROXY") ??
    env("all_proxy") ??
    env("HTTP_PROXY") ??
    env("http_proxy")
  )
}

function envSystemProxy() {
  return {
    http: envProxyFor(new URL("http://example.com")),
    https: envProxyFor(new URL("https://example.com")),
    all: env("ALL_PROXY") ?? env("all_proxy"),
    no_proxy: env("NO_PROXY") ?? env("no_proxy"),
  } satisfies SystemProxyInfo
}

function mergeProxyInfo(left: SystemProxyInfo, right: SystemProxyInfo) {
  return {
    http: left.http ?? right.http,
    https: left.https ?? right.https,
    all: left.all ?? right.all,
    no_proxy: [left.no_proxy, right.no_proxy].filter(Boolean).join(",") || undefined,
  } satisfies SystemProxyInfo
}

function scutilValue(output: string, key: string) {
  return output.match(new RegExp(`^\\s*${key}\\s*:\\s*(.+)\\s*$`, "m"))?.[1]?.trim()
}

function scutilEnabled(output: string, key: string) {
  return scutilValue(output, key) === "1"
}

function scutilProxyURL(output: string, prefix: "HTTP" | "HTTPS") {
  if (!scutilEnabled(output, `${prefix}Enable`)) return
  const host = scutilValue(output, `${prefix}Proxy`)
  const port = scutilValue(output, `${prefix}Port`)
  if (!host || !port) return
  const normalized = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host
  return supportedProxyUrl(`http://${normalized}:${port}`, "env")
}

function scutilExceptions(output: string) {
  const items = output
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*\d+\s*:\s*(.+)\s*$/)?.[1]?.trim())
    .filter((item): item is string => Boolean(item))
  return items.length ? items.join(",") : undefined
}

export function parseMacSystemProxy(output: string) {
  return {
    http: scutilProxyURL(output, "HTTP"),
    https: scutilProxyURL(output, "HTTPS"),
    no_proxy: scutilExceptions(output),
  } satisfies SystemProxyInfo
}

function regValue(output: string, key: string) {
  return output.match(new RegExp(`^\\s*${key}\\s+REG_\\w+\\s+(.+)\\s*$`, "im"))?.[1]?.trim()
}

function regDwordEnabled(value: string | undefined) {
  if (!value) return false
  const raw = value.match(/0x[0-9a-f]+|\d+/i)?.[0]
  if (!raw) return false
  return Number.parseInt(raw, raw.toLowerCase().startsWith("0x") ? 16 : 10) !== 0
}

function windowsProxyUrl(value: string) {
  // supportedProxyUrl 已内部 normalize(裸 host:port 补 http://),不再在此重复 scheme 判断
  return supportedProxyUrl(clean(value) ?? "")
}

function windowsProxyServer(value: string | undefined) {
  const parts = (value ?? "")
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean)
  const entries = parts
    .map((part) => part.match(/^([a-z][a-z0-9+.-]*)\s*=\s*(.+)$/i))
    .filter((match): match is RegExpMatchArray => Boolean(match))
  if (entries.length === 0) {
    const shared = windowsProxyUrl(value ?? "")
    return { http: shared, https: shared } satisfies SystemProxyInfo
  }
  return {
    http: windowsProxyUrl(entries.find((entry) => entry[1]?.toLowerCase() === "http")?.[2] ?? ""),
    https: windowsProxyUrl(entries.find((entry) => entry[1]?.toLowerCase() === "https")?.[2] ?? ""),
  } satisfies SystemProxyInfo
}

function windowsProxyOverride(value: string | undefined) {
  const items = (value ?? "")
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean)
  return items.length ? items.join(",") : undefined
}

export function parseWindowsSystemProxy(output: string) {
  if (!regDwordEnabled(regValue(output, "ProxyEnable"))) return {}
  return {
    ...windowsProxyServer(regValue(output, "ProxyServer")),
    no_proxy: windowsProxyOverride(regValue(output, "ProxyOverride")),
  } satisfies SystemProxyInfo
}

async function osSystemProxy() {
  if (process.env.OPENCODE_DISABLE_OS_PROXY === "1") return {}
  if (process.platform !== "darwin" && process.platform !== "win32") return {}
  const now = Date.now()
  if (osProxyCache && osProxyCache.expires > now) return osProxyCache.info
  const info =
    process.platform === "darwin"
      ? await execFileAsync("scutil", ["--proxy"], { timeout: SYSTEM_PROXY_COMMAND_TIMEOUT_MS })
          .then((result) => parseMacSystemProxy(result.stdout))
          .catch(() => ({}))
      : await execFileAsync("reg.exe", ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"], {
          timeout: SYSTEM_PROXY_COMMAND_TIMEOUT_MS,
          windowsHide: true,
        })
          .then((result) => parseWindowsSystemProxy(result.stdout))
          .catch(() => ({}))
  osProxyCache = { expires: now + 5_000, info }
  return info
}

export async function systemProxy() {
  return mergeProxyInfo(envSystemProxy(), await osSystemProxy())
}

export async function visibleSystemProxy() {
  const info = await systemProxy()
  return {
    http: info.http ? maskProxyUrl(info.http) : undefined,
    https: info.https ? maskProxyUrl(info.https) : undefined,
    all: info.all ? maskProxyUrl(info.all) : undefined,
    no_proxy: info.no_proxy,
  } satisfies SystemProxyInfo
}

function noProxyList(config?: ProxyInfo) {
  return [
    ...BUILTIN_NO_PROXY,
    ...(env("NO_PROXY") ?? env("no_proxy") ?? "").split(/[;,]/),
    ...(config?.no_proxy ?? "").split(/[;,]/),
  ]
    .map((item) => item.trim())
    .filter(Boolean)
}

function normalizeHost(host: string) {
  return host.toLowerCase().replace(/^\[/, "").replace(/\]$/, "")
}

function splitNoProxyRule(input: string) {
  const value = input.trim().toLowerCase()
  if (!value) return
  if (value === "*") return { host: "*", port: undefined }
  if (value.startsWith("[")) {
    const end = value.indexOf("]")
    if (end === -1) return { host: normalizeHost(value), port: undefined }
    return {
      host: normalizeHost(value.slice(1, end)),
      port: value[end + 1] === ":" ? value.slice(end + 2) || undefined : undefined,
    }
  }
  const colon = value.indexOf(":")
  if (colon !== -1 && colon === value.lastIndexOf(":")) {
    return { host: normalizeHost(value.slice(0, colon)), port: value.slice(colon + 1) || undefined }
  }
  return { host: normalizeHost(value), port: undefined }
}

function defaultPort(url: URL) {
  if (url.port) return url.port
  if (url.protocol === "http:") return "80"
  if (url.protocol === "https:") return "443"
  return ""
}

function wildcardHost(pattern: string, host: string) {
  return new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*")}$`).test(host)
}

export function shouldBypass(url: URL, config?: ProxyInfo) {
  if (url.protocol !== "http:" && url.protocol !== "https:") return true
  const host = normalizeHost(url.hostname)
  if (host === "localhost" || host === "::1" || host.startsWith("127.") || host.endsWith(".local")) return true
  const port = defaultPort(url)
  return noProxyList(config).some((item) => {
    const rule = splitNoProxyRule(item)
    if (!rule) return false
    if (rule.host === "*") return true
    if (rule.port && rule.port !== port) return false
    if (rule.host.startsWith("*.")) {
      const suffix = rule.host.slice(1)
      return host === suffix.slice(1) || host.endsWith(suffix)
    }
    if (rule.host.startsWith(".")) return host === rule.host.slice(1) || host.endsWith(rule.host)
    if (rule.host === "<local>") return !host.includes(".") && !host.includes(":")
    if (rule.host.includes("*")) return wildcardHost(rule.host, host)
    return host === rule.host
  })
}

function supportedProxyUrl(value: string, _source?: "config" | "env") {
  const trimmed = value.trim()
  if (!trimmed) return undefined
  // 裸 host:port 补 http://(与系统/环境变量代理路径一致);非 http(s)/无法解析返回 undefined → 直连。
  // 不抛错:坏配置不再拖垮所有请求,而是降级直连(manual 模式由 resolve 记 warn 日志,便于诊断)。
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
  try {
    const url = new URL(withScheme)
    if (url.protocol === "http:" || url.protocol === "https:") return url.toString()
  } catch {}
  return undefined
}

export function maskProxyUrl(value: string) {
  let masked = value
  try {
    const url = new URL(value)
    url.username = url.username ? "***" : ""
    url.password = url.password ? "***" : ""
    masked = url.toString()
  } catch {}
  // 兜底:URL 解析放过的非标准位置 userinfo 仍要打码——new URL 失败(非法 port/无 scheme)走 catch,
  // 或 user:pass@host 被当 opaque path(无 //authority)时提取不到 username/password——
  // 用保守正则把 [scheme://]user:pass@ 形式的凭证遮蔽,杜绝非法手写代理地址把明文凭证写进日志。
  return masked.replace(/(:\/\/)?[^/@\s:]+(?::[^/@\s]+)?@/g, (_m, sep) => `${sep ?? ""}***:***@`)
}

export async function resolve(url: string | URL): Promise<ResolvedProxy> {
  const target = typeof url === "string" ? new URL(url) : url
  const config = await readGlobalProxyConfig()
  const mode = config?.mode ?? "none"
  if (mode === "none") return { mode }
  if (shouldBypass(target, config)) return { mode }
  if (mode === "manual") {
    const value = target.protocol === "http:" ? (config?.http_url ?? config?.url) : (config?.https_url ?? config?.url)
    if (!value) return { mode }
    const proxy = supportedProxyUrl(value, "config")
    if (!proxy) {
      log.warn("manual proxy url is not a valid http(s) url; using direct connection", { value: maskProxyUrl(value) })
      return { mode }
    }
    return { mode, proxy, source: "config" }
  }
  const system = await systemProxy()
  const proxy = supportedProxyUrl((target.protocol === "http:" ? system.http : system.https) ?? system.all ?? "", "env")
  return proxy ? { mode, proxy, source: "env" } : { mode }
}

function requestUrl(input: FetchInput) {
  try {
    if (typeof input === "string" || input instanceof URL) return new URL(input)
    return new URL(input.url)
  } catch {
    return undefined
  }
}

function isBun() {
  return typeof Bun !== "undefined" && typeof Bun.version === "string"
}

// undici 常把底层错误包在 TypeError("fetch failed") 的 cause 里,故沿 cause 链递归判定。
function isProxyUnreachable(error: unknown, depth = 0): boolean {
  if (!error || typeof error !== "object" || depth > 5) return false
  const code = (error as { code?: unknown }).code
  if (typeof code === "string" && PROXY_UNREACHABLE_PATTERN.test(code)) return true
  if (error instanceof Error && PROXY_UNREACHABLE_PATTERN.test(error.message)) return true
  const cause = (error as { cause?: unknown }).cause
  return cause && cause !== error ? isProxyUnreachable(cause, depth + 1) : false
}

function proxyDead(proxy: string) {
  const until = deadProxies.get(proxy)
  if (until === undefined) return false
  if (until > Date.now()) return true
  deadProxies.delete(proxy)
  return false
}

function markProxyDead(proxy: string) {
  deadProxies.set(proxy, Date.now() + PROXY_DEAD_TTL_MS)
  agentCache.delete(proxy) // 丢弃被污染的连接池,代理恢复后按需重建
}

// 首次 fetch 尝试会消费请求 body(即便连不上代理、请求未真正发出),故直连重试前必须确认可重放:
// - init.body 存在时会覆盖请求体,以它为准:流式(ReadableStream)一次性、首次尝试即被锁定 → 不可重放;
//   其余(字符串/Buffer 等)可重放。注意此时不能只看 Request.bodyUsed —— 流被 init.body 覆盖时它可能仍为 false。
// - 无 init.body:Request 以自身 bodyUsed 判定;string/URL 无请求体,可重放。
function isReplayable(input: FetchInput, init: FetchInit): boolean {
  const body = init?.body
  if (body !== undefined && body !== null) return !(body instanceof ReadableStream)
  if (input instanceof Request) return !input.bodyUsed
  return true
}

async function dispatcher(proxy: string) {
  const cached = agentCache.get(proxy)
  if (cached) return cached
  const { ProxyAgent } = await import("undici")
  const agent = new ProxyAgent(proxy)
  agentCache.set(proxy, agent)
  return agent
}

async function directDispatcher() {
  if (directAgent) return directAgent
  const { Agent } = await import("undici")
  directAgent = new Agent()
  return directAgent
}

async function fetchDirect(input: FetchInput, init: FetchInit) {
  if (isBun()) return globalThis.fetch(input, init)
  return globalThis.fetch(input, {
    ...init,
    dispatcher: await directDispatcher(),
  } as RequestInit & { dispatcher: unknown })
}

async function fetchWithProxy(input: FetchInput, init: FetchInit, proxy: string) {
  if (isBun()) {
    return globalThis.fetch(input, { ...init, proxy } as RequestInit & { proxy: string })
  }
  return globalThis.fetch(input, {
    ...init,
    dispatcher: await dispatcher(proxy),
  } as RequestInit & { dispatcher: unknown })
}

export function create(_label = "ProxyFetch"): Fetch {
  return Object.assign(async (input: FetchInput, init: FetchInit) => {
    const url = requestUrl(input)
    if (!url) return globalThis.fetch(input, init)
    if (url.protocol !== "http:" && url.protocol !== "https:") return globalThis.fetch(input, init)
    const resolved = await resolve(url)
    if (!resolved.proxy) return fetchDirect(input, init)
    const proxy = resolved.proxy
    // 代理端点近期已判定不可达 → 冷却期内直接直连,避免每个请求都先撞一次死代理
    if (proxyDead(proxy)) return fetchDirect(input, init)
    try {
      return await fetchWithProxy(input, init, proxy)
    } catch (error) {
      // 只处理「连不上代理端点」:mid-flight 断连、上游 5xx 等原样抛出,不掩盖真实故障。
      if (!isProxyUnreachable(error)) throw error
      // 标记短期不可达 + 剔除坏连接池:后续请求走直连自愈,无需重启。
      markProxyDead(proxy)
      // 首次尝试可能已消费 body:仅当可安全重放时才立即直连;不可重放则抛出原始连接错误
      // (下一个请求已因 markProxyDead 走直连),避免把代理错误替换成「Request body already used」。
      if (!isReplayable(input, init)) throw error
      log.warn("proxy endpoint unreachable; falling back to direct connection", { proxy: maskProxyUrl(proxy) })
      return fetchDirect(input, init)
    }
  }, { preconnect: globalThis.fetch.preconnect }) as Fetch
}

export const layer = FetchHttpClient.layer.pipe(
  Layer.provide(Layer.succeed(FetchHttpClient.Fetch, create("ProxyHttpClient"))),
)

export * as NetProxy from "./proxy"
