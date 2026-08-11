import os from "os"
import crypto from "crypto"
import fs from "fs"
import childProcess from "child_process"
import { Effect, Schedule } from "effect"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { getBrand } from "@opencode-ai/brand"

import { Auth } from "@/auth"
import { ModelsDev } from "@/provider/models"
import { Provider } from "@/provider/provider"
import { WanlaiCodeCredentialState } from "@/provider/wanlaicode-credential-state"
import { NetProxy } from "@/net/proxy"

// brand-aware endpoint：getBrand() 在 Node 环境读 WANLAICODE_BRAND env（默认 main brand），
// 子 brand 的 apiBase / siteUrl 在 @opencode-ai/brand 的 BRANDS 表里定义。
const brand = getBrand()

export function endpointDefaults(environment: Readonly<Record<string, string | undefined>> = process.env) {
  // 正式构建继续使用品牌注册地址；本地联调只有显式注入环境变量时才切换 OAuth 与 API，避免污染发布包。
  return {
    apiBase: environment.WANLAICODE_API_BASE?.trim() || brand.backend.apiBase,
    siteUrl: environment.WANLAICODE_SITE_URL?.trim() || brand.backend.siteUrl,
  }
}

const endpoints = endpointDefaults()
const purchaseUrl = process.env.WANLAICODE_PURCHASE_URL?.trim().replace(/\/+$/, "") || "https://pay.wanlai.ai/pay"

// 默认配置始终指向品牌线上服务；本地联调通过 WANLAICODE_* 环境变量显式覆盖。
export const defaultConfig = {
  apiBase: endpoints.apiBase,
  siteUrl: endpoints.siteUrl,
  purchaseUrl,
  purchaseFallbackUrl: purchaseUrl,
  model: process.env.WANLAICODE_DEFAULT_MODEL?.trim() || "deepseek-v4-flash",
  clientId: "wanlaicode-cli",
  scope: "user:profile user:inference",
  // 插件市场 host root：env 覆盖（联调指向 192.168.1.36:8080）→ brand 显式配置 → 从 apiBase 派生
  pluginRegistry:
    process.env.WANLAICODE_PLUGIN_REGISTRY_URL?.replace(/\/+$/, "") ||
    brand.backend.registryUrl?.replace(/\/+$/, "") ||
    brand.backend.apiBase.replace(/\/+$/, "").replace(/\/v1$/, ""),
}

// 本地服务配置：当前桌面直接连接本机 API、OAuth 站点和购买页，结构与线上配置保持一致。
// export const defaultConfig = {
//   apiBase: "http://127.0.0.1:8080/v1",
//   siteUrl: "http://127.0.0.1:3001",
//   purchaseUrl: "http://127.0.0.1:3000/pay",
//   purchaseFallbackUrl: "http://127.0.0.1:3000/pay",
//   model: "gpt-5.5",
//   clientId: "wanlaicode-cli",
//   scope: "user:profile user:inference",
//   // 插件市场 host root：env 覆盖（联调指向 192.168.1.36:8080）→ brand 显式配置 → 从 apiBase 派生
//   pluginRegistry:
//     process.env.WANLAICODE_PLUGIN_REGISTRY_URL?.replace(/\/+$/, "") ||
//     brand.backend.registryUrl?.replace(/\/+$/, "") ||
//     brand.backend.apiBase.replace(/\/+$/, "").replace(/\/v1$/, ""),
// }

const purchaseUrlCache = new Map<string, { value: string; expiresAt: number }>()
const fetchWithoutProxyOverride = { current: undefined as Fetch | undefined }
let softwareHeadersCache: Record<string, string> | undefined

function normalizeSoftwareHeaderValue(value: string | undefined, maxLength: number) {
  return (value ?? "")
    .replace(/[\r\n\t]/g, " ")
    .replace(/[\x00-\x1F\x7F]/g, "")
    .replace(/[^\x20-\x7E]/g, "")
    .trim()
    .slice(0, maxLength)
}

const genericHardwareNames = new Set([
  "default string",
  "none",
  "not applicable",
  "not available",
  "not specified",
  "oem",
  "system manufacturer",
  "system product name",
  "to be filled by o.e.m.",
  "unknown",
])

function commandLines(file: string, args: string[], maxLength: number) {
  try {
    return childProcess
      .execFileSync(file, args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 1000,
        windowsHide: true,
      })
      .split(/\r?\n/)
      .map((line) => normalizeSoftwareHeaderValue(line, maxLength))
      .filter(Boolean)
  } catch {
    return []
  }
}

function hardwareName(...values: Array<string | undefined>) {
  return (
    values
      .map((value) => normalizeSoftwareHeaderValue(value, 128))
      .find((value) => value && !genericHardwareNames.has(value.toLowerCase())) ?? ""
  )
}

function readHardwareFile(path: string, maxLength = 128) {
  try {
    return normalizeSoftwareHeaderValue(fs.readFileSync(path, "utf8"), maxLength)
  } catch {
    return ""
  }
}

function environmentValue(keys: string[]) {
  for (const key of keys) {
    const value = normalizeSoftwareHeaderValue(process.env[key], 128)
    if (value) return value
  }
  return ""
}

function deviceName() {
  switch (os.platform()) {
    case "darwin":
      return (
        hardwareName(...commandLines("/usr/sbin/sysctl", ["-n", "hw.model"], 128)) ||
        normalizeSoftwareHeaderValue(`${deviceOS()} ${deviceArch()}`, 128)
      )
    case "win32":
      return (
        hardwareName(
          ...commandLines(
            "powershell.exe",
            [
              "-NoProfile",
              "-NonInteractive",
              "-ExecutionPolicy",
              "Bypass",
              "-Command",
              "$p=Get-CimInstance Win32_ComputerSystemProduct;$c=Get-CimInstance Win32_ComputerSystem;@($p.Name,$c.Model,$c.Manufacturer)|Where-Object { $_ }",
            ],
            128,
          ),
          ...commandLines("wmic", ["csproduct", "get", "name"], 128).filter((line) => line.toLowerCase() !== "name"),
        ) || normalizeSoftwareHeaderValue(`${deviceOS()} ${deviceArch()}`, 128)
      )
    case "linux": {
      const vendor = hardwareName(
        readHardwareFile("/sys/devices/virtual/dmi/id/sys_vendor"),
        readHardwareFile("/sys/devices/virtual/dmi/id/board_vendor"),
      )
      const product = hardwareName(
        readHardwareFile("/sys/devices/virtual/dmi/id/product_name"),
        readHardwareFile("/sys/devices/virtual/dmi/id/board_name"),
      )
      if (vendor && product && !product.toLowerCase().includes(vendor.toLowerCase()))
        return `${vendor} ${product}`.slice(0, 128)
      return product || vendor || normalizeSoftwareHeaderValue(`${deviceOS()} ${deviceArch()}`, 128)
    }
    default:
      return normalizeSoftwareHeaderValue(`${os.platform()} ${deviceArch()}`, 128)
  }
}

function linuxDistributionName() {
  try {
    const content = fs.readFileSync("/etc/os-release", "utf8")
    const match = content.match(/^PRETTY_NAME=(.*)$/m) || content.match(/^NAME=(.*)$/m)
    return normalizeSoftwareHeaderValue(match?.[1]?.replace(/^["']|["']$/g, "").replace(/\\"/g, '"'), 48)
  } catch {
    return ""
  }
}

function macOSProductVersion() {
  try {
    return normalizeSoftwareHeaderValue(
      childProcess
        .execFileSync("/usr/bin/sw_vers", ["-productVersion"], {
          encoding: "utf8",
          timeout: 1000,
        })
        .trim(),
      24,
    )
  } catch {
    return ""
  }
}

// Fallback marketing-name mapping based on Darwin and Windows kernel versions.
function darwinProductVersion(major: number, minor: number) {
  if (major >= 25) return `macOS ${major + 1}${minor > 0 ? `.${minor}` : ""}`
  if (major >= 20) return `macOS ${major - 9}${minor > 0 ? `.${minor}` : ""}`
  if (major >= 16) return `macOS 10.${major - 4}`
  return "macOS"
}

function darwinOSName() {
  const productVersion = macOSProductVersion()
  if (productVersion) return `macOS ${productVersion}`
  const parts = os
    .release()
    .split(".")
    .map((part) => Number(part))
  const major = parts[0] || 0
  const minor = parts[1] || 0
  if (!Number.isFinite(major) || major <= 0) return "macOS"
  return darwinProductVersion(major, minor)
}

// Fallback marketing-name mapping based on Windows NT version and build number.
function windowsOSName() {
  const parts = os
    .release()
    .split(".")
    .map((part) => Number(part))
  const major = parts[0] || 0
  const build = parts[2] || 0
  if (major >= 10 && build >= 22000) return "Windows 11"
  if (major >= 10) return "Windows 10"
  if (major === 6 && parts[1] === 3) return "Windows 8.1"
  if (major === 6 && parts[1] === 2) return "Windows 8"
  if (major === 6 && parts[1] === 1) return "Windows 7"
  return "Windows"
}

function deviceOS() {
  switch (os.platform()) {
    case "darwin":
      return normalizeSoftwareHeaderValue(darwinOSName(), 64)
    case "win32":
      return normalizeSoftwareHeaderValue(windowsOSName(), 64)
    case "linux":
      return normalizeSoftwareHeaderValue(linuxDistributionName() || "Linux", 64)
    default:
      return normalizeSoftwareHeaderValue(os.platform(), 64)
  }
}

function deviceArch() {
  const value = os.arch().toLowerCase()
  if (value === "arm64" || value === "aarch64") return "ARM64"
  if (value === "x64" || value === "x86_64" || value === "amd64") return "x64"
  if (value === "ia32" || value === "x86") return "x86"
  return normalizeSoftwareHeaderValue(os.arch(), 32)
}

// 从系统命令/文件输出中解析机器码。与“读取”过程分离，便于对各平台解析做确定性单测。
export function parseMachineGUID(platform: NodeJS.Platform, lines: string[]) {
  switch (platform) {
    case "darwin": {
      // ioreg 输出形如：    "IOPlatformUUID" = "564D8C7F-...."，取引号内的 UUID。
      const line = lines.find((item) => item.includes("IOPlatformUUID"))
      return normalizeSoftwareHeaderValue(line?.match(/"([0-9A-Fa-f-]{16,})"/)?.[1], 128)
    }
    case "win32": {
      // reg query 输出形如：MachineGuid    REG_SZ    a1b2c3...，按首列精确匹配键名后取行尾值，
      // 避免误命中仅在路径等位置包含该子串的其它行。
      for (const item of lines) {
        const tokens = item.split(/\s+/).filter(Boolean)
        if (tokens[0] === "MachineGuid" && tokens.length >= 3) return normalizeSoftwareHeaderValue(tokens.at(-1), 128)
      }
      return ""
    }
    case "linux": {
      // /etc/machine-id 直接就是机器码本身，校验为 hex 以防文件损坏时误用脏数据。
      const value = normalizeSoftwareHeaderValue(lines.find(Boolean), 128)
      return /^[0-9a-f]{16,}$/i.test(value) ? value : ""
    }
    default:
      return ""
  }
}

// 系统级机器码：由操作系统自身维护，重装 App、清空 App 数据/缓存后依旧不变，
// 因此作为设备唯一标识的来源，而非我们自行落盘、可被删除的随机 id。
function machineGUID() {
  switch (os.platform()) {
    case "darwin":
      return parseMachineGUID("darwin", commandLines("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], 256))
    case "win32": {
      const reg = `${process.env.windir || process.env.SystemRoot || "C:\\Windows"}\\System32\\reg.exe`
      return parseMachineGUID(
        "win32",
        commandLines(reg, ["QUERY", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"], 256),
      )
    }
    case "linux":
      return parseMachineGUID("linux", [
        readHardwareFile("/etc/machine-id", 128) || readHardwareFile("/var/lib/dbus/machine-id", 128),
      ])
    default:
      return ""
  }
}

function deviceID() {
  // 优先用系统机器码：稳定且真正唯一。命名空间前缀避免与其它读取同一机器码的程序产生相同哈希。
  const guid = machineGUID()
  if (guid) return crypto.createHash("sha256").update(`wanlaicode-device|${guid.toLowerCase()}`).digest("hex")

  // 兜底：极少数受限环境（容器无 machine-id、权限受限等）读不到系统机器码时，
  // 退回机器特征拼接——稳定性弱于系统机器码，仅保证始终有值。
  const seed =
    [
      os.hostname(),
      os.platform(),
      os.arch(),
      os.homedir(),
      environmentValue(["USER", "USERNAME", "COMPUTERNAME", "HOSTNAME"]),
    ]
      .map((item) => normalizeSoftwareHeaderValue(item, 128))
      .filter(Boolean)
      .join("|") || `${os.platform()}|${os.arch()}`

  return crypto.createHash("sha256").update(seed).digest("hex")
}

export function softwareHeaders() {
  softwareHeadersCache ??= {
    "X-Wanlai-Client": "wanlaicodex",
    "X-Wanlai-Client-Version": normalizeSoftwareHeaderValue(InstallationVersion, 64),
    "X-Wanlai-Device-Id": deviceID(),
    "X-Wanlai-Device-Name": deviceName(),
    "X-Wanlai-OS": deviceOS(),
    "X-Wanlai-Arch": deviceArch(),
  }
  return softwareHeadersCache
}

function withSoftwareHeaders(headers: HeadersInit | undefined) {
  const result = new Headers(softwareHeaders())
  new Headers(headers).forEach((value, key) => result.set(key, value))
  return result
}

export function normalizeApiBase(apiBase = defaultConfig.apiBase) {
  return apiBase.replace(/\/+$/, "").replace(/\/v1$/, "") + "/v1"
}

export function relayRoot(apiBase = defaultConfig.apiBase) {
  return normalizeApiBase(apiBase).replace(/\/v1$/, "")
}

export function resolveConfig(input: { apiBase?: string; siteUrl?: string; pluginRegistry?: string } = {}) {
  const apiBase = normalizeApiBase(input.apiBase)
  const root = relayRoot(apiBase)
  return {
    ...defaultConfig,
    apiBase,
    siteUrl: (input.siteUrl ?? defaultConfig.siteUrl).replace(/\/+$/, ""),
    relayRoot: root,
    endpoints: {
      models: `${apiBase}/models`,
      chatCompletions: `${apiBase}/chat/completions`,
      apiKeyProfile: `${root}/api/wanlaicode_profile`,
      oauthProfile: `${root}/api/oauth/profile`,
      createRuntimeKey: `${root}/api/oauth/wanlaicode/create_api_key`,
      purchaseSettings: `${root}/api/v1/settings/public`,
      oauthToken: `${root}/v1/oauth/token`,
      // 正式渠道默认复用品牌后端；本地远控的独立覆盖由 gateway 处理，不能污染 OAuth、购买和模型端点。
      remoteControl: `${root}/api/v1/remote-control`,
      pluginRegistry: (input.pluginRegistry ?? defaultConfig.pluginRegistry).replace(/\/+$/, ""),
    },
  }
}

export function buildAuthorizeUrl(input: {
  redirectUri: string
  state: string
  codeChallenge: string
  siteUrl?: string
}) {
  const config = resolveConfig({ siteUrl: input.siteUrl })
  const url = new URL("/software/oauth/authorize", config.siteUrl)
  url.searchParams.set("client_id", config.clientId)
  url.searchParams.set("redirect_uri", input.redirectUri)
  url.searchParams.set("response_type", "code")
  url.searchParams.set("state", input.state)
  url.searchParams.set("code_challenge", input.codeChallenge)
  url.searchParams.set("code_challenge_method", "S256")
  url.searchParams.set("scope", config.scope)
  // 强制授权页忽略浏览器里残留的旧登录态、重新登录，
  // 修复「桌面端登出后切换新账号，授权登录拿到的仍是旧账号」。
  url.searchParams.set("prompt", "login")
  return url
}

function base64UrlEncode(buffer: ArrayBuffer) {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
}

function generateRandomString(length: number, chars: string) {
  return Array.from(crypto.getRandomValues(new Uint8Array(length)))
    .map((byte) => chars[byte % chars.length])
    .join("")
}

export async function createCodeChallenge(codeVerifier: string) {
  return base64UrlEncode(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier)))
}

export async function startOAuth(input: { redirectUri?: string; siteUrl?: string }) {
  const codeVerifier = generateRandomString(43, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
  const state = generateRandomString(43, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")
  const codeChallenge = await createCodeChallenge(codeVerifier)
  return {
    state,
    codeVerifier,
    codeChallenge,
    url: input.redirectUri
      ? buildAuthorizeUrl({
        redirectUri: input.redirectUri,
        state,
        codeChallenge,
        siteUrl: input.siteUrl,
      })
      : undefined,
  }
}

const isBun = typeof Bun !== "undefined"

const callbackPage = (input: {
  title: string
  message: string
  tone: "success" | "error"
  detail?: string
  redirectUrl?: string
}) => {
  const favicon = encodeURIComponent(
    `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" fill="none">
      <rect x="0" y="0" width="512" height="512" rx="110" fill="#14161C"/>
      <g transform="translate(64 64) scale(0.75)">
        <polygon points="0,256 51,205 154,307 256,205 358,307 461,205 512,256 461,307 358,410 256,307 154,410 51,307" fill="#F0C419" fill-rule="evenodd"/>
        <polygon points="256,0 307,51 256,102 205,51" fill="#F0C419"/>
        <polygon points="154,102 205,154 154,205 102,154" fill="#F0C419"/>
        <polygon points="358,102 410,154 358,205 307,154" fill="#F0C419"/>
        <polygon points="256,410 307,461 256,512 205,461" fill="#F0C419"/>
      </g>
    </svg>
  `.trim(),
  )

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${input.title}</title>
  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,${favicon}" />
  <style>
    :root {
      color-scheme: light;
      --bg: #f3f4f6;
      --card: rgba(255, 255, 255, 0.92);
      --border: rgba(15, 23, 42, 0.06);
      --text: #1d1d1f;
      --muted: #6e6e73;
      --success: #34c759;
      --error: #ff3b30;
      --success-bg: #dff2e5;
      --error-bg: #fde4e2;
      --detail-bg: #f4f4f6;
      --shadow: 0 28px 90px rgba(148, 163, 184, 0.34);
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 32px;
      font-family: Inter, "SF Pro Display", "SF Pro Text", system-ui, sans-serif;
      background:
        radial-gradient(circle at top, rgba(147, 197, 253, 0.3), transparent 42%),
        linear-gradient(180deg, #f8fafc 0%, var(--bg) 100%);
      color: var(--text);
    }

    .card {
      width: min(100%, 460px);
      padding: 22px 22px 20px;
      border-radius: 24px;
      background: var(--card);
      border: 1px solid var(--border);
      box-shadow: var(--shadow);
      backdrop-filter: blur(20px);
    }

    .traffic-lights {
      display: flex;
      gap: 8px;
      margin-bottom: 22px;
    }

    .traffic-lights span {
      width: 12px;
      height: 12px;
      border-radius: 999px;
      display: block;
    }

    .traffic-lights span:nth-child(1) { background: #ff5f57; }
    .traffic-lights span:nth-child(2) { background: #febc2e; }
    .traffic-lights span:nth-child(3) { background: #28c840; }

    .hero {
      display: grid;
      grid-template-columns: 56px 1fr;
      align-items: center;
      column-gap: 18px;
      margin-bottom: 14px;
    }

    .icon {
      width: 56px;
      height: 56px;
      border-radius: 16px;
      display: grid;
      place-items: center;
      background: ${input.tone === "success" ? "var(--success-bg)" : "var(--error-bg)"};
      color: ${input.tone === "success" ? "var(--success)" : "var(--error)"};
    }

    .icon svg {
      width: 28px;
      height: 28px;
      display: block;
    }

    h1 {
      margin: 0;
      font-size: 24px;
      font-weight: 760;
      line-height: 1.16;
      letter-spacing: -0.035em;
    }

    .message {
      margin: 0;
      font-size: 15px;
      line-height: 1.6;
      color: var(--muted);
    }

    .detail {
      margin-top: 16px;
      padding: 14px 16px;
      border-radius: 14px;
      background: var(--detail-bg);
      color: var(--text);
      font-size: 14px;
      line-height: 1.5;
      word-break: break-word;
      transition: color 160ms ease, opacity 160ms ease;
    }

    .detail::before {
      content: "";
      display: inline-block;
      width: 10px;
      height: 10px;
      margin-right: 10px;
      border-radius: 999px;
      vertical-align: -1px;
      background: rgba(110, 110, 115, 0.35);
      transition: transform 220ms ease, opacity 160ms ease, background 160ms ease;
    }

    .detail[data-close-state="pending"] {
      color: var(--muted);
    }

    .detail[data-close-state="pending"]::before {
      opacity: 0.8;
    }

    .detail[data-close-state="closing"] {
      color: var(--text);
    }

    .detail[data-close-state="closing"]::before {
      background: var(--success);
      animation: pulse 0.9s ease-in-out infinite;
    }

    .detail[data-close-state="manual"] {
      color: var(--muted);
    }

    .detail[data-close-state="manual"]::before {
      background: var(--error);
      opacity: 0.88;
    }

    @keyframes pulse {
      0%,
      100% {
        transform: scale(0.9);
        opacity: 0.45;
      }

      50% {
        transform: scale(1.08);
        opacity: 1;
      }
    }
  </style>
</head>
<body>
  <main class="card">
    <div class="traffic-lights" aria-hidden="true">
      <span></span>
      <span></span>
      <span></span>
    </div>
    <section class="hero">
      <div class="icon" aria-hidden="true">${input.tone === "success"
      ? `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M5 12.5L10 17.5L19 6.5" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>`
      : `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 7V13" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/><circle cx="12" cy="17" r="1.2" fill="currentColor"/></svg>`
    }</div>
      <h1>${input.title}</h1>
    </section>
    <p class="message">${input.message}</p>
    ${input.detail ? `<p class="detail" data-close-state="pending">${input.detail}</p>` : ""}
  </main>
  ${input.tone === "success"
      ? `<script>
  const detail = document.querySelector(".detail")
  const updateDetail = (text, state) => {
    if (!detail) return
    detail.textContent = text
    detail.setAttribute("data-close-state", state)
  }
  const redirectUrl = ${JSON.stringify(input.redirectUrl ?? defaultConfig.siteUrl)}
  let remaining = 5
  updateDetail("窗口将在 5 秒后自动关闭", "pending")
  const countdown = setInterval(() => {
    remaining -= 1
    if (remaining <= 0) {
      clearInterval(countdown)
      updateDetail("正在尝试自动关闭窗口…", "closing")
      return
    }
    updateDetail("窗口将在 " + remaining + " 秒后自动关闭", "pending")
  }, 1000)
  setTimeout(() => {
    clearInterval(countdown)
    updateDetail("正在尝试自动关闭窗口…", "closing")
    window.close()
    window.open("", "_self")?.close()
    setTimeout(() => {
      if (window.closed) return
      let redirectRemaining = 5
      updateDetail("浏览器阻止了自动关闭，" + redirectRemaining + " 秒后将跳转到 万来Code 官网。", "manual")
      const redirectCountdown = setInterval(() => {
        redirectRemaining -= 1
        if (redirectRemaining <= 0) {
          clearInterval(redirectCountdown)
          updateDetail("正在跳转到 万来Code 官网…", "closing")
          window.location.replace(redirectUrl)
          return
        }
        updateDetail("浏览器阻止了自动关闭，" + redirectRemaining + " 秒后将跳转到 万来Code 官网。", "manual")
      }, 1000)
    }, 1000)
  }, 5000)
</script>`
      : ""
    }
</body>
</html>`
}

export async function createOAuthCallback(input: { state: string; timeoutMs?: number }) {
  let complete: ((result: { code?: string; error?: Error }) => void) | undefined
  let settled = false
  let timeout: ReturnType<typeof setTimeout> | undefined

  const settle = (result: { code?: string; error?: Error }) => {
    if (settled) return
    settled = true
    if (timeout) clearTimeout(timeout)
    complete?.(result)
  }

  const handleRequest = (url: string): { status: number; headers: Record<string, string>; body: string } => {
    const callbackUrl = new URL(url)
    if (callbackUrl.pathname !== "/callback") {
      return {
        status: 404,
        headers: { "Content-Type": "text/html; charset=utf-8" },
        body: callbackPage({
          title: "页面不存在",
          message: "当前地址不是有效的授权回调地址，请返回 WanlaiCode 重新发起登录。",
          tone: "error",
        }),
      }
    }
    if (callbackUrl.searchParams.get("state") !== input.state) {
      settle({ error: new Error("Invalid OAuth state") })
      return {
        status: 400,
        headers: { "Content-Type": "text/html; charset=utf-8" },
        body: callbackPage({
          title: "授权失败",
          message: "登录状态校验失败，请关闭此窗口后重新尝试授权。",
          tone: "error",
          detail: "state mismatch",
        }),
      }
    }
    const code = callbackUrl.searchParams.get("code")
    if (!code) {
      settle({ error: new Error("Missing authorization code") })
      return {
        status: 400,
        headers: { "Content-Type": "text/html; charset=utf-8" },
        body: callbackPage({
          title: "授权失败",
          message: "没有收到授权码，请关闭此窗口后重新尝试授权。",
          tone: "error",
          detail: "missing authorization code",
        }),
      }
    }
    settle({ code })
    return {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
      body: callbackPage({
        title: "授权成功",
        message: "现在可以关闭此窗口并返回 万来Code。",
        tone: "success",
        detail: "此窗口将自动关闭",
        redirectUrl: defaultConfig.siteUrl,
      }),
    }
  }

  const waitPromise = new Promise<string>((resolve, reject) => {
    complete = (result) => {
      if (result.error) return reject(result.error)
      resolve(result.code ?? "")
    }
  })

  let redirectUri = ""
  let stopServer: () => void
  const createNodeServer = async () => {
    const http = await import("node:http")
    const server = http.createServer((_req, res) => {
      const result = handleRequest(`http://127.0.0.1${_req.url ?? ""}`)
      res.writeHead(result.status, result.headers)
      res.end(result.body)
    })
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(0, "127.0.0.1", resolve)
    })
    const address = server.address()
    if (!address || typeof address === "string") {
      server.close()
      throw new Error("OAuth callback server did not return a TCP address")
    }
    return {
      redirectUri: `http://127.0.0.1:${address.port}/callback`,
      stopServer: () => server.close(),
    }
  }

  if (isBun) {
    try {
      const server = Bun.serve({
        port: 0,
        fetch: (request) => {
          const result = handleRequest(request.url)
          return new Response(result.body, { status: result.status, headers: result.headers })
        },
      })
      redirectUri = `http://127.0.0.1:${server.port}/callback`
      stopServer = () => server.stop(true)
    } catch {
      const server = await createNodeServer()
      redirectUri = server.redirectUri
      stopServer = server.stopServer
    }
  } else {
    const server = await createNodeServer()
    redirectUri = server.redirectUri
    stopServer = server.stopServer
  }

  timeout = setTimeout(() => {
    settle({ error: new Error("OAuth callback timeout") })
  }, input.timeoutMs ?? 300_000)

  return {
    redirectUri,
    wait: () => waitPromise,
    stop: () => {
      if (timeout) clearTimeout(timeout)
      stopServer()
    },
  }
}

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>

export class OAuthExpiredError extends Error {
  override readonly name = "WanlaiCodeOAuthExpiredError"

  constructor(message = "登录已过期，请重新登录 Wanlai", options?: ErrorOptions) {
    super(message, options)
  }
}

export class NoEntitlementError extends Error {
  override readonly name = "WanlaiCodeNoEntitlementError"

  constructor(message = "当前没有可用套餐，请先购买或开通套餐", options?: ErrorOptions) {
    super(message, options)
  }
}

type JsonRequest = {
  apiBase?: string
  fetch?: Fetch
  endpoint: (config: ReturnType<typeof resolveConfig>) => string
  method?: string
  headers?: HeadersInit
  body?: BodyInit | undefined
  error: (response: Response, body: string) => Error
  label?: string
}

function requestMethod(method = "GET") {
  return method.toUpperCase()
}

async function requestWithoutProxy(input: string, init?: RequestInit, label = "WanlaiCode.request") {
  const http = await import("node:http")
  const https = await import("node:https")

  return await new Promise<Response>((resolve, reject) => {
    const url = new URL(input)
    const secure = url.protocol === "https:"
    const request = (secure ? https.request : http.request)(
      url,
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (secure ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: requestMethod(init?.method),
        headers: init?.headers ? Object.fromEntries(new Headers(init.headers).entries()) : undefined,
        agent: false,
      },
      (response) => {
        const headers = new Headers(
          Object.entries(response.headers).flatMap<[string, string]>(([key, value]) =>
            value === undefined ? [] : [[key, Array.isArray(value) ? value.join(", ") : value]],
          ),
        )
        const contentType = headers.get("content-type") ?? ""
        if (contentType.includes("text/event-stream")) {
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              response.on("data", (chunk) =>
                controller.enqueue(Buffer.isBuffer(chunk) ? new Uint8Array(chunk) : new Uint8Array(Buffer.from(chunk))),
              )
              response.on("end", () => controller.close())
              response.on("error", (error) => controller.error(error))
            },
            cancel(reason) {
              response.destroy(reason instanceof Error ? reason : undefined)
            },
          })
          resolve(
            new Response(body, {
              status: response.statusCode ?? 500,
              headers,
            }),
          )
          return
        }

        const chunks: Buffer[] = []
        response.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
        response.on("end", () => {
          resolve(
            new Response(Buffer.concat(chunks), {
              status: response.statusCode ?? 500,
              headers,
            }),
          )
        })
        response.on("error", (error) => reject(error))
      },
    )
    request.on("error", (error) => {
      reject(error)
    })
    request.setTimeout(300000, () => {
      request.destroy()
      reject(new Error("Request timeout"))
    })

    if (init?.body === undefined || init.body === null) {
      request.end()
      return
    }

    if (typeof init.body === "string" || init.body instanceof Uint8Array) {
      request.end(init.body)
      return
    }

    if (init.body instanceof ArrayBuffer) {
      request.end(Buffer.from(init.body))
      return
    }

    if (ArrayBuffer.isView(init.body)) {
      request.end(Buffer.from(init.body.buffer, init.body.byteOffset, init.body.byteLength))
      return
    }

    reject(new Error("Unsupported fetch body for WanlaiCode request"))
  })
}

export function createFetchWithoutProxy(label = "WanlaiCode.request"): Fetch {
  return (input, init) => (fetchWithoutProxyOverride.current ?? requestWithoutProxy)(input, init, label)
}

export function createFetch(label = "WanlaiCode.request"): Fetch {
  const proxyFetch = NetProxy.create(label)
  return (input, init) => (fetchWithoutProxyOverride.current ?? proxyFetch)(input, init)
}

export function setFetchWithoutProxyForTesting(fetch?: Fetch) {
  fetchWithoutProxyOverride.current = fetch
}

function jsonFetch<T>(input: JsonRequest) {
  return Effect.tryPromise({
    try: async () => {
      const response = await (input.fetch ?? createFetch(input.label))(
        input.endpoint(resolveConfig({ apiBase: input.apiBase })),
        {
          ...(input.method ? { method: input.method } : {}),
          headers: withSoftwareHeaders(input.headers),
          ...(input.body !== undefined ? { body: input.body } : {}),
        },
      )
      const body = await response.text()
      if (!response.ok) throw input.error(response, body)
      return body ? (JSON.parse(body) as T) : (undefined as T)
    },
    catch: (cause) => cause,
  })
}

export function oauthExpiredError(cause: unknown) {
  return new OAuthExpiredError("登录已过期，请重新登录 Wanlai", { cause })
}

export function isOAuthExpiredError(error: unknown) {
  return error instanceof OAuthExpiredError
}

export class OAuthRefreshError extends Error {
  constructor(
    input: {
      status: number
      statusText?: string
      reason?: string
      body: string
    },
    options?: ErrorOptions,
  ) {
    super(
      `WanlaiCode OAuth token refresh failed: ${input.status}${input.statusText ? ` ${input.statusText}` : ""}`,
      options,
    )
    this.status = input.status
    this.reason = input.reason
    this.body = input.body
  }

  readonly status: number
  readonly reason?: string
  readonly body: string
}

const LOGIN_EXPIRED_REASONS = new Set([
  "SOFTWARE_OAUTH_REFRESH_TOKEN_INVALID",
  "SOFTWARE_OAUTH_AUTHORIZATION_EXPIRED",
  "INVALID_GRANT",
])

function normalizeOAuthReason(reason: string | undefined) {
  return reason?.trim().toUpperCase()
}

function parseOAuthErrorReason(body: string) {
  if (!body) return undefined
  try {
    const parsed = JSON.parse(body) as { reason?: unknown; error?: unknown }
    return typeof parsed.reason === "string"
      ? parsed.reason
      : typeof parsed.error === "string"
        ? parsed.error
        : undefined
  } catch {
    return undefined
  }
}

export function oauthRefreshErrorReason(error: unknown) {
  return error instanceof OAuthRefreshError ? normalizeOAuthReason(error.reason) : undefined
}

export function isOAuthRefreshReasonInvalid(reason: string | undefined, status = 401) {
  const normalized = normalizeOAuthReason(reason)
  return status === 401 && !!normalized && LOGIN_EXPIRED_REASONS.has(normalized)
}

export function isOAuthRefreshTokenInvalid(error: unknown) {
  if (!(error instanceof OAuthRefreshError)) return false
  return isOAuthRefreshReasonInvalid(error.reason, error.status)
}

export function noEntitlementError(cause: unknown) {
  return new NoEntitlementError("当前没有可用套餐，请先购买或开通套餐", { cause })
}

export function isNoEntitlementRuntimeError(error: unknown) {
  return error instanceof NoEntitlementError
}

export function exchangeOAuthCode(input: {
  code: string
  redirectUri: string
  codeVerifier: string
  apiBase?: string
  fetch?: Fetch
}) {
  return jsonFetch<OAuthTokenResponse>({
    apiBase: input.apiBase,
    fetch: input.fetch,
    endpoint: (config) => config.endpoints.oauthToken,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: defaultConfig.clientId,
      code: input.code,
      redirect_uri: input.redirectUri,
      code_verifier: input.codeVerifier,
    }),
    error: (response, body) =>
      new Error(`WanlaiCode OAuth token exchange failed: ${response.status} ${response.statusText} - ${body}`),
    label: "WanlaiCode.oauth.token",
  }).pipe(
    Effect.retry({
      times: 2,
      schedule: Schedule.exponential("500 millis"),
      while: (error) => {
        const msg = error instanceof Error ? error.message : String(error)
        return (
          msg.includes("fetch") ||
          msg.includes("ECONN") ||
          msg.includes("500") ||
          msg.includes("502") ||
          msg.includes("503")
        )
      },
    }),
  )
}

export function validateOAuthProfile(input: { accessToken: string; apiBase?: string; fetch?: Fetch }) {
  return jsonFetch<WanlaiCodeProfile>({
    apiBase: input.apiBase,
    fetch: input.fetch,
    endpoint: (config) => config.endpoints.oauthProfile,
    headers: { Authorization: `Bearer ${input.accessToken}` },
    error: (response) => new Error(`WanlaiCode OAuth profile request failed: ${response.status}`),
    label: "WanlaiCode.oauth.profile",
  }).pipe(
    Effect.retry({
      times: 2,
      schedule: Schedule.exponential("500 millis"),
      while: (error) => {
        const msg = error instanceof Error ? error.message : String(error)
        return (
          msg.includes("fetch") ||
          msg.includes("ECONN") ||
          msg.includes("500") ||
          msg.includes("502") ||
          msg.includes("503")
        )
      },
    }),
  )
}

export function refreshOAuthToken(input: { refreshToken: string; apiBase?: string; fetch?: Fetch }) {
  return jsonFetch<OAuthTokenResponse>({
    apiBase: input.apiBase,
    fetch: input.fetch,
    endpoint: (config) => config.endpoints.oauthToken,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: defaultConfig.clientId,
      refresh_token: input.refreshToken,
      scope: defaultConfig.scope,
    }),
    error: (response, body) =>
      new OAuthRefreshError({
        status: response.status,
        statusText: response.statusText,
        reason: parseOAuthErrorReason(body),
        body,
      }),
    label: "WanlaiCode.oauth.refresh",
  })
}

export function createRuntimeKey(input: { accessToken: string; apiBase?: string; fetch?: Fetch }) {
  return jsonFetch<RuntimeKeyResponse>({
    apiBase: input.apiBase,
    fetch: input.fetch,
    endpoint: (config) => config.endpoints.createRuntimeKey,
    method: "POST",
    headers: { Authorization: `Bearer ${input.accessToken}` },
    error: (response, body) =>
      new Error(`WanlaiCode OAuth runtime key request failed: ${response.status} ${response.statusText} - ${body}`),
    label: "WanlaiCode.oauth.runtime-key",
  }).pipe(
    Effect.flatMap((result) =>
      result.raw_key
        ? Effect.succeed(result.raw_key)
        : Effect.fail(new Error("WanlaiCode OAuth runtime key response does not include raw_key")),
    ),
  )
}

export function createRuntimeKeyOrEmpty(input: { accessToken: string; apiBase?: string; fetch?: Fetch }) {
  return createRuntimeKey(input).pipe(Effect.catchIf(isNoEntitlementError, () => Effect.succeed("")))
}

export function validateApiKey(input: { apiKey: string; apiBase?: string; fetch?: Fetch }) {
  return jsonFetch<ApiKeyProfile>({
    apiBase: input.apiBase,
    fetch: input.fetch,
    endpoint: (config) => config.endpoints.apiKeyProfile,
    headers: { "x-api-key": input.apiKey },
    error: (response) => new Error(`WanlaiCode API key profile request failed: ${response.status}`),
    label: "WanlaiCode.api.profile",
  })
}

export function isNoEntitlementError(error: unknown) {
  const msg = error instanceof Error ? error.message : String(error)
  return (
    /\b(no_entitlement|software_product_not_entitled|software_entitlement_not_found)\b/i.test(msg) ||
    /user does not have this software product/i.test(msg) ||
    /software entitlement not found/i.test(msg)
  )
}

export function loginWithApiKey(input: { apiKey: string; apiBase?: string; fetch?: Fetch }) {
  return Effect.gen(function* () {
    const profile = yield* validateApiKey(input)
    const auth = yield* Auth.Service
    const models = yield* ModelsDev.Service
    const provider = yield* Provider.Service
    yield* auth.set("wanlaicode", {
      type: "api",
      key: input.apiKey,
      accountEmail: profileAccountEmail(profile),
      accountName: profileAccountName(profile),
      metadata: input.apiBase ? { apiBase: resolveConfig({ apiBase: input.apiBase }).apiBase } : undefined,
    })
    yield* provider.refresh()
    yield* models.refreshWanlaiCode()
    yield* provider.refresh()
    return profile
  })
}

// ===== 账号密码登录（本地 /wanlaicode/user-center/login 的 provider 侧实现）=====
// 远端是两套 token 体系：/api/v1/auth/login 发的用户 JWT 调不通 software OAuth 系列
// （/api/oauth/profile、/v1/oauth/token 均 401），因此不能落成 OAuth 会话；
// 改为用 JWT 换取软件 API key，复用与「API key 登录」完全一致的会话。
// 端点直接由 relayRoot 拼出，不侵入 resolveConfig 的既有 endpoints。

const passwordLoginProductCode = "wanlaicode"

// 从错误响应体中解析人类可读的 message（message → error → reason 依次兜底）。
function parsePasswordLoginErrorMessage(body: string) {
  if (!body) return undefined
  try {
    const parsed = JSON.parse(body) as { message?: unknown; error?: unknown; reason?: unknown }
    for (const value of [parsed.message, parsed.error, parsed.reason]) {
      if (typeof value === "string" && value) return value
    }
    return undefined
  } catch {
    return undefined
  }
}

// /api/v1 信封：HTTP 200 也可能携带业务错误（code!==0、message 为人话）；空 body 同样按异常响应处理。
type V1Envelope<T> = { code?: number; message?: string; data?: T }

function unwrapV1Envelope<T>(body: V1Envelope<T> | undefined, label: string) {
  if (body && (typeof body.code !== "number" || body.code === 0)) return Effect.succeed(body.data)
  const message = typeof body?.message === "string" && body.message ? body.message : `${label}: unexpected response`
  return Effect.fail(new SoftwareApiKeyRequestError(body?.code ?? 0, message))
}

// 携带 HTTP 状态码的请求错误：读取当前 key 时需要区分 404（新账号无 key）与其它失败。
class SoftwareApiKeyRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

// 用账号体系的用户 JWT 读取（无则创建）当前软件 API key。
// /api/v1/software/* 系列接受用户 JWT，这是密码登录换取桌面端会话凭据的通道。
function passwordLoginApiKey(input: { accessToken: string; apiBase?: string; fetch?: Fetch }) {
  return Effect.gen(function* () {
    const headers = { Authorization: `Bearer ${input.accessToken}` }
    const error = (response: Response, body: string) =>
      new SoftwareApiKeyRequestError(
        response.status,
        parsePasswordLoginErrorMessage(body) ?? `WanlaiCode software api key request failed: ${response.status}`,
      )
    const current = yield* jsonFetch<V1Envelope<{ raw_key?: string }>>({
      apiBase: input.apiBase,
      fetch: input.fetch,
      endpoint: (config) =>
        `${config.relayRoot}/api/v1/software/api-keys/current?product_code=${passwordLoginProductCode}`,
      headers,
      error,
      label: "WanlaiCode.password.apiKey.current",
    }).pipe(
      Effect.flatMap((body) => unwrapV1Envelope(body, "WanlaiCode software api key request failed")),
      // 仅 404（新账号还没有 key）回退到创建；401/5xx/网络错误等原样上抛，避免误走创建并丢失真实错误。
      Effect.catch((cause: unknown) =>
        cause instanceof SoftwareApiKeyRequestError && cause.status === 404
          ? Effect.succeed(undefined)
          : Effect.fail(cause),
      ),
    )
    if (current?.raw_key) return current.raw_key
    const created = yield* jsonFetch<V1Envelope<{ raw_key?: string }>>({
      apiBase: input.apiBase,
      fetch: input.fetch,
      endpoint: (config) => `${config.relayRoot}/api/v1/software/api-keys`,
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ product_code: passwordLoginProductCode, replace_existing: false }),
      error,
      label: "WanlaiCode.password.apiKey.create",
    }).pipe(Effect.flatMap((body) => unwrapV1Envelope(body, "WanlaiCode software api key request failed")))
    const rawKey = created?.raw_key
    if (!rawKey) return yield* Effect.fail(new Error("WanlaiCode email/password login failed: missing software api key"))
    return rawKey
  })
}

// 账号密码登录：POST 远端 /api/v1/auth/login 拿用户 JWT → 换软件 API key → loginWithApiKey 落盘。
export function loginWithEmailPassword(input: {
  email: string
  password: string
  apiBase?: string
  fetch?: Fetch
}) {
  return Effect.gen(function* () {
    const login = yield* jsonFetch<V1Envelope<{ access_token?: string }>>({
      apiBase: input.apiBase,
      fetch: input.fetch,
      endpoint: (config) => `${config.relayRoot}/api/v1/auth/login`,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: input.email,
        password: input.password,
      }),
      error: (response, body) =>
        new Error(
          parsePasswordLoginErrorMessage(body) ??
          `WanlaiCode email/password login failed: ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`,
        ),
      label: "WanlaiCode.password.login",
    }).pipe(Effect.flatMap((body) => unwrapV1Envelope(body, "WanlaiCode email/password login failed")))
    const accessToken = login?.access_token
    if (!accessToken)
      return yield* Effect.fail(new Error("WanlaiCode email/password login failed: missing access token"))
    const rawKey = yield* passwordLoginApiKey({ accessToken, apiBase: input.apiBase, fetch: input.fetch })
    return yield* loginWithApiKey({ apiKey: rawKey, apiBase: input.apiBase, fetch: input.fetch })
  })
}

function saveOAuthSession(input: {
  refreshToken: string
  expiresIn?: number
  runtimeKey: string
  softwareToken?: string
  accountUuid?: string
  accountEmail?: string
  accountName?: string
  siteUrl?: string
}) {
  return Effect.gen(function* () {
    const auth = yield* Auth.Service
    const info = new Auth.Oauth({
      type: "oauth",
      access: input.runtimeKey,
      softwareToken: input.softwareToken,
      refresh: input.refreshToken,
      // OAuth 服务偶尔不返回 expires_in；优先读取 JWT exp，仍不可用时按一小时有效期保存，禁止写成已过期的 0。
      expires: oauthTokenExpiresAt({ accessToken: input.softwareToken, expiresIn: input.expiresIn }),
      accountId: input.accountUuid,
      accountEmail: input.accountEmail,
      accountName: input.accountName,
      enterpriseUrl: (input.siteUrl ?? defaultConfig.siteUrl).replace(/\/+$/, ""),
    })
    yield* auth.set("wanlaicode", info)
    // OAuth callback 是用户明确完成的新登录；写入成功后恢复该凭据，即使服务端恰好复用了同一组三元组。
    WanlaiCodeCredentialState.clearCredentialInvalid(info)
    return info
  })
}

const defaultOAuthTokenLifetimeSeconds = 60 * 60

function oauthJwtExpiresAt(accessToken: string | undefined) {
  const payload = accessToken?.split(".")[1]
  if (!payload) return undefined
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: unknown }
    return typeof parsed.exp === "number" && Number.isFinite(parsed.exp) && parsed.exp > 0
      ? Math.floor(parsed.exp)
      : undefined
  } catch {
    return undefined
  }
}

// 统一计算 OAuth JWT 的绝对过期时间，供登录、刷新协调器和兼容刷新入口保持同一语义。
export function oauthTokenExpiresAt(input: { accessToken?: string; expiresIn?: number; now?: number }) {
  const now = Math.floor((input.now ?? Date.now()) / 1000)
  if (typeof input.expiresIn === "number" && Number.isFinite(input.expiresIn) && input.expiresIn > 0) {
    return now + Math.floor(input.expiresIn)
  }
  const jwtExpires = oauthJwtExpiresAt(input.accessToken)
  // JWT 自带的过期结论即使已在过去也必须尊重，不能用默认时长把真实过期 token 人为延寿。
  if (jwtExpires) return jwtExpires
  return now + defaultOAuthTokenLifetimeSeconds
}

export function loginWithOAuth(input: {
  accessToken: string
  refreshToken: string
  expiresIn: number
  profile: WanlaiCodeProfile
  runtimeKey: string
  siteUrl?: string
}) {
  return Effect.gen(function* () {
    const models = yield* ModelsDev.Service
    const provider = yield* Provider.Service
    yield* saveOAuthSession({
      refreshToken: input.refreshToken,
      expiresIn: input.expiresIn,
      runtimeKey: input.runtimeKey,
      softwareToken: input.accessToken,
      accountUuid: input.profile.account?.uuid,
      accountEmail: profileAccountEmail(input.profile),
      accountName: profileAccountName(input.profile),
      siteUrl: input.siteUrl,
    })
    yield* provider.refresh()
    yield* models.refreshWanlaiCode()
    yield* provider.refresh()
  })
}

// token 兑换与资料/runtime key 补全分阶段执行；协调器会在调用本阶段前先原子保存已轮换的 OAuth 三元组。
export function completeOAuthRefresh(input: { accessToken: string; apiBase?: string; fetch?: Fetch }) {
  return Effect.gen(function* () {
    const profile = yield* validateOAuthProfile(input)
    // 无推理权益只影响 runtime key，不影响软件 JWT 驱动的用户中心、图片生成和手机远控。
    const runtimeKey = yield* createRuntimeKeyOrEmpty(input)
    return { profile, runtimeKey }
  })
}

function sameOAuthCredential(left: Auth.Oauth, right: Auth.Oauth) {
  return left.refresh === right.refresh && left.softwareToken === right.softwareToken && left.expires === right.expires
}

export function refreshOAuthSessionCore(input: {
  refreshToken: string
  accountUuid?: string
  siteUrl?: string
  apiBase?: string
  fetch?: Fetch
}) {
  return Effect.gen(function* () {
    const auth = yield* Auth.Service
    // Effect 的旧 Layer.mock 会在读取未实现方法时抛错，先检查属性存在性再决定是否走兼容回退。
    const modifyAuth = Reflect.has(auth, "modify") ? auth.modify : undefined
    const existing = yield* auth.get("wanlaicode").pipe(Effect.catch(() => Effect.succeed(undefined)))
    const tokens = yield* refreshOAuthToken(input)
    const previous = existing?.type === "oauth" ? existing : undefined
    const nextTokenInfo = (current: Auth.Info | undefined) => {
      if (previous && (current?.type !== "oauth" || !sameOAuthCredential(current, previous))) return undefined
      if (!previous && current) return undefined
      const source = current?.type === "oauth" ? current : previous
      // token 请求在途收到明确撤权时，兼容刷新入口也必须让撤权结论优先于成功响应。
      if (source && WanlaiCodeCredentialState.isCredentialInvalid(source)) return undefined
      const next = new Auth.Oauth({
        type: "oauth",
        access: source?.access ?? "",
        refresh: tokens.refresh_token ?? input.refreshToken,
        softwareToken: tokens.access_token,
        expires: oauthTokenExpiresAt({ accessToken: tokens.access_token, expiresIn: tokens.expires_in }),
        accountId: source?.accountId ?? input.accountUuid,
        accountEmail: source?.accountEmail,
        accountName: source?.accountName,
        enterpriseUrl: (input.siteUrl ?? source?.enterpriseUrl ?? defaultConfig.siteUrl).replace(/\/+$/, ""),
      })
      // 历史上已明确失效的目标代次只能由 OAuth callback 恢复，普通 refresh 不得复活它。
      if (WanlaiCodeCredentialState.isCredentialInvalid(next)) return undefined
      return next
    }
    // refresh token 在兑换成功时可能立即作废；锁内 CAS 保证先完成的新登录始终胜过旧刷新结果。
    const tokenInfo = modifyAuth
      ? yield* modifyAuth("wanlaicode", nextTokenInfo)
      : yield* Effect.gen(function* () {
        const next = nextTokenInfo(existing)
        if (!next) return undefined
        yield* auth.set("wanlaicode", next)
        return next
      })
    if (tokenInfo?.type !== "oauth") {
      if (previous && WanlaiCodeCredentialState.isCredentialInvalid(previous)) {
        return yield* Effect.fail(oauthExpiredError("oauth credential revision is invalid"))
      }
      return yield* Effect.fail(new Error("wanlaicode oauth credential changed during refresh"))
    }
    const completed = yield* completeOAuthRefresh({
      accessToken: tokens.access_token,
      apiBase: input.apiBase,
      fetch: input.fetch,
    })
    const complete = (current: Auth.Info | undefined) => {
      if (current?.type !== "oauth" || !sameOAuthCredential(current, tokenInfo)) return undefined
      // profile/runtime key 请求期间收到撤权时禁止第二阶段补写，保留刚轮换 token 但维持失效状态。
      if (WanlaiCodeCredentialState.isCredentialInvalid(current)) return undefined
      const next = new Auth.Oauth({
        ...current,
        access: completed.runtimeKey,
        accountId: completed.profile.account?.uuid ?? current.accountId,
        accountEmail: profileAccountEmail(completed.profile) ?? current.accountEmail,
        accountName: profileAccountName(completed.profile) ?? current.accountName,
      })
      if (WanlaiCodeCredentialState.isCredentialInvalid(next)) return undefined
      return next
    }
    // 第二阶段同样在锁内核对 tokenInfo；callback 无论落在网络等待还是提交窗口都不会被覆盖。
    const finalized = modifyAuth
      ? yield* modifyAuth("wanlaicode", complete)
      : yield* Effect.gen(function* () {
        const latest = yield* auth.get("wanlaicode")
        const next = complete(latest)
        if (!next) return undefined
        yield* auth.set("wanlaicode", next)
        return next
      })
    if (finalized?.type !== "oauth") {
      if (WanlaiCodeCredentialState.isCredentialInvalid(tokenInfo)) {
        return yield* Effect.fail(oauthExpiredError("oauth credential revision is invalid"))
      }
      return yield* Effect.fail(new Error("wanlaicode oauth credential changed during refresh"))
    }
    return { profile: completed.profile, runtimeKey: completed.runtimeKey, softwareToken: tokens.access_token }
  })
}

export function refreshOAuthSession(input: {
  refreshToken: string
  accountUuid?: string
  siteUrl?: string
  apiBase?: string
  fetch?: Fetch
}) {
  return Effect.gen(function* () {
    yield* refreshOAuthSessionCore(input)
    const models = yield* ModelsDev.Service
    const provider = yield* Provider.Service
    yield* models.refreshWanlaiCode()
    yield* provider.refresh()
  })
}

export function getPurchaseUrl(input: { apiBase?: string; fetch?: Fetch; now?: () => number }) {
  return Effect.tryPromise({
    try: async () => {
      const config = resolveConfig({ apiBase: input.apiBase })
      const cached = purchaseUrlCache.get(config.relayRoot)
      const now = (input.now ?? Date.now)()
      if (cached && cached.expiresAt > now) return cached.value
      const body = await Effect.runPromise(
        jsonFetch<{ data?: { purchase_subscription_url?: string } }>({
          apiBase: input.apiBase,
          fetch: input.fetch,
          endpoint: (nextConfig) => nextConfig.endpoints.purchaseSettings,
          error: (response) => new Error(`WanlaiCode purchase settings request failed: ${response.status}`),
          label: "WanlaiCode.purchase.settings",
        }),
      )
      const value = body.data?.purchase_subscription_url || defaultConfig.purchaseFallbackUrl
      purchaseUrlCache.set(config.relayRoot, { value, expiresAt: now + 300_000 })
      return value
    },
    catch: (cause) => cause,
  }).pipe(Effect.catch(() => Effect.succeed(defaultConfig.purchaseFallbackUrl)))
}

export function loginWithApiKeyResult(input: { apiKey: string; apiBase?: string; fetch?: Fetch }) {
  return loginWithApiKey(input).pipe(
    Effect.map((profile) => ({ ok: true as const, profile })),
    Effect.catch(() =>
      Effect.gen(function* () {
        const purchaseUrl = yield* getPurchaseUrl({
          apiBase: input.apiBase,
          fetch: input.fetch,
        })
        return {
          ok: false as const,
          error: "no_entitlement" as const,
          purchaseUrl,
        }
      }),
    ),
  )
}

export interface OAuthTokenResponse {
  access_token: string
  refresh_token?: string
  expires_in?: number
}

export interface WanlaiCodeProfile {
  entitlement?: unknown
  account?: {
    uuid?: string
    email?: string
    email_address?: string
    display_name?: string
  }
}

export interface RuntimeKeyResponse {
  raw_key?: string
}

export interface ApiKeyProfile {
  entitlement?: unknown
  account?: {
    uuid?: string
    email?: string
    email_address?: string
    display_name?: string
  }
}

export function profileAccountEmail(profile: WanlaiCodeProfile | ApiKeyProfile) {
  return profile.account?.email_address ?? profile.account?.email
}

export function profileAccountName(profile: WanlaiCodeProfile | ApiKeyProfile) {
  return profile.account?.display_name ?? profileAccountEmail(profile)?.split("@")[0]
}

export * as WanlaiCodeAuth from "./wanlaicode"
