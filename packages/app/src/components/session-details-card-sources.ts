import type { Message, Part } from "@opencode-ai/sdk/v2"
import { resolveWorkspaceFilePath } from "@opencode-ai/ui/session-turn-path"
import { isPrivateOrLoopbackHost } from "@/utils/safe-http-url"

export const WEB_ACCESS_TOOLS = new Set([
  "websearch",
  "webfetch",
  "web_search",
  "web_search_preview",
])

export function normalizeFilePath(path: string) {
  return path.replace(/\\/g, "/")
}

export function normalizeOutputArtifactKey(path: string, workspaceRoot?: string) {
  if (path.startsWith("http://") || path.startsWith("https://")) return normalizeWebSourceUrl(path)
  const normalized = normalizeFilePath(path)
  if (!workspaceRoot) return normalized
  const root = normalizeFilePath(workspaceRoot).replace(/\/$/, "")
  if (normalized.toLowerCase().startsWith(`${root.toLowerCase()}/`)) {
    return normalized.slice(root.length + 1)
  }
  return normalized
}

/** 工作区内显示相对路径，工作区外保留绝对路径。 */
export function formatOutputArtifactDisplayPath(path: string, workspaceRoot?: string) {
  if (path.startsWith("http://") || path.startsWith("https://")) return path
  if (!workspaceRoot) return normalizeFilePath(path)
  const normalized = normalizeFilePath(path)
  const root = normalizeFilePath(workspaceRoot).replace(/\/$/, "")
  if (normalized.toLowerCase().startsWith(`${root.toLowerCase()}/`)) {
    return normalized.slice(root.length + 1)
  }
  return path
}

type OutputArtifactLike = {
  type?: string
  filename?: string
  url?: string
  mime?: string
}

const OUTPUT_IMAGE_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".bmp",
  ".svg",
  ".ico",
  ".heic",
  ".heif",
  ".avif",
  ".tiff",
  ".tif",
])

const OUTPUT_AUDIO_EXTENSIONS = new Set([
  ".mp3",
  ".wav",
  ".flac",
  ".aac",
  ".ogg",
  ".m4a",
  ".wma",
  ".opus",
  ".aiff",
  ".aif",
  ".caf",
])

const OUTPUT_VIDEO_EXTENSIONS = new Set([
  ".mp4",
  ".mov",
  ".avi",
  ".mkv",
  ".webm",
  ".m4v",
  ".wmv",
  ".mpeg",
  ".mpg",
  ".3gp",
])

const OUTPUT_DOCUMENT_EXTENSIONS = new Set([
  ".pdf",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".md",
  ".mdx",
  ".txt",
  ".rtf",
  ".odt",
  ".ods",
  ".odp",
  ".csv",
  ".tsv",
  ".pages",
  ".numbers",
  ".key",
  ".epub",
  ".mobi",
])

export function outputArtifactExtension(path: string) {
  const base = path.split(/[/\\]/).pop() ?? path
  const idx = base.lastIndexOf(".")
  if (idx <= 0) return ""
  return base.slice(idx).toLowerCase()
}

export function outputArtifactImageMime(path: string) {
  const ext = outputArtifactExtension(path)
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg"
  if (ext === ".png") return "image/png"
  if (ext === ".gif") return "image/gif"
  if (ext === ".webp") return "image/webp"
  if (ext === ".bmp") return "image/bmp"
  if (ext === ".svg") return "image/svg+xml"
  if (ext === ".ico") return "image/x-icon"
  if (ext === ".heic") return "image/heic"
  if (ext === ".heif") return "image/heif"
  if (ext === ".avif") return "image/avif"
  if (ext === ".tiff" || ext === ".tif") return "image/tiff"
  const base = path.split(/[/\\]/).pop() ?? path
  if (base.startsWith("wanlai-image-")) return "image/png"
}

export function isOutputArtifactImagePath(path: string) {
  const ext = outputArtifactExtension(path)
  if (OUTPUT_IMAGE_EXTENSIONS.has(ext)) return true
  const base = path.split(/[/\\]/).pop() ?? path
  return base.startsWith("wanlai-image-")
}

export async function loadOutputArtifactImagePreview(
  path: string,
  options: {
    inlineUrl?: string
    workspaceRoot?: string
    readFileAsDataURL?: (path: string, mime: string) => Promise<string>
    readFile?: (path: string) => Promise<
      | {
          type: "text" | "binary" | "previewable"
          content: string
          encoding?: "base64"
          mimeType?: string
        }
      | undefined
    >
  },
) {
  if (options.inlineUrl?.startsWith("data:image/")) return options.inlineUrl
  const mime = outputArtifactImageMime(path)
  if (!mime) return undefined
  const absolutePath = options.workspaceRoot
    ? resolveWorkspaceFilePath(options.workspaceRoot, path)
    : path
  if (options.readFileAsDataURL) {
    const url = await options.readFileAsDataURL(absolutePath, mime).catch(() => undefined)
    if (url) return url
  }
  const data = await options.readFile?.(path).catch(() => undefined)
  if (!data?.content) return undefined
  const imageMime = data.mimeType?.startsWith("image/") ? data.mimeType : mime
  if (data.encoding === "base64") return `data:${imageMime};base64,${data.content}`
  if (data.type === "binary") return `data:${imageMime};base64,${data.content}`
  if (data.type === "text" && mime === "image/svg+xml") {
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(data.content)}`
  }
}

export function isRemoteOutputArtifactPath(path: string) {
  const trimmed = path.trim()
  return trimmed.startsWith("http://") || trimmed.startsWith("https://") || trimmed.startsWith("//")
}

export function isSessionOutputArtifactPath(path: string, mime?: string) {
  if (isRemoteOutputArtifactPath(path)) return false
  if (path.includes("__pycache__/") || path.endsWith(".pyc") || path.endsWith(".pyo")) return false
  if (mime?.startsWith("image/")) return true
  if (mime?.startsWith("audio/")) return true
  if (mime?.startsWith("video/")) return true
  if (mime === "application/pdf") return true
  if (
    mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    mime === "application/vnd.ms-excel" ||
    mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    mime === "application/msword" ||
    mime === "application/vnd.openxmlformats-officedocument.presentationml.presentation" ||
    mime === "application/vnd.ms-powerpoint"
  ) {
    return true
  }
  if (mime === "text/plain" || mime === "text/markdown" || mime === "text/csv" || mime === "text/tab-separated-values") {
    return true
  }
  if (mime?.includes("spreadsheetml") || mime?.includes("wordprocessingml") || mime?.includes("presentationml")) {
    return true
  }
  if (mime?.startsWith("application/vnd.")) return true

  const ext = outputArtifactExtension(path)
  if (!ext) return path.startsWith("wanlai-image-")
  if (OUTPUT_IMAGE_EXTENSIONS.has(ext)) return true
  if (OUTPUT_AUDIO_EXTENSIONS.has(ext)) return true
  if (OUTPUT_VIDEO_EXTENSIONS.has(ext)) return true
  if (OUTPUT_DOCUMENT_EXTENSIONS.has(ext)) return true
  return false
}

/**
 * 生成产物：路径来自 write/edit/apply_patch 的结构化 diff，本身即「模型写过这个文件」的证据，
 * 因此不再按可预览类型白名单过滤，只拦截远端地址、目录与编译缓存等噪声。
 * 守卫必须先于任何放行判断，避免 mime 之类的旁路让目录/远端路径被当成产物。
 */
export function isSessionGeneratedArtifactPath(path: string) {
  const trimmed = path.trim()
  if (!trimmed) return false
  if (isRemoteOutputArtifactPath(trimmed)) return false
  if (/(?:^|[/\\])__pycache__[/\\]/.test(trimmed)) return false
  if (trimmed.endsWith(".pyc") || trimmed.endsWith(".pyo")) return false
  if (/[\\/]$/.test(trimmed)) return false
  return !!trimmed.split(/[/\\]/).pop()
}

function outputArtifactLoading(filename?: string) {
  return !!filename?.startsWith("wanlai-image-loading-")
}

function isGeneratedImageArtifact(part: OutputArtifactLike) {
  if (outputArtifactLoading(part.filename)) return false
  const label = outputArtifactLabel(part)
  if (!label) return false
  return isSessionOutputArtifactPath(label, part.mime)
}

export function outputArtifactLabel(part: OutputArtifactLike) {
  const filename = part.filename?.trim()
  if (filename && !outputArtifactLoading(filename) && !isRemoteOutputArtifactPath(filename)) return filename
  if (typeof part.url !== "string" || !part.url || part.url.startsWith("data:")) return undefined
  if (isRemoteOutputArtifactPath(part.url)) return undefined
  try {
    const base = new URL(part.url).pathname.split("/").pop()
    if (base && !isRemoteOutputArtifactPath(base)) return base
  } catch {
    return undefined
  }
  return undefined
}

function outputArtifactInlinePreviewUrl(part: OutputArtifactLike) {
  const url = part.url?.trim()
  if (!url?.startsWith("data:image/")) return undefined
  return url
}

function recordOutputArtifactPreviewUrl(
  map: Map<string, string>,
  part: OutputArtifactLike,
  key: (path: string) => string,
) {
  const name = outputArtifactLabel(part)
  const url = outputArtifactInlinePreviewUrl(part)
  if (!name || !url) return
  map.set(key(name), url)
}

/** 从会话 parts 收集内联 data URL 预览（生图附件、assistant file part 等）。 */
export function sessionOutputArtifactPreviewUrls(
  messages: readonly Message[],
  partsByMessage: Record<string, readonly Part[]>,
  key: (path: string) => string,
) {
  const map = new Map<string, string>()
  for (const message of messages) {
    if (message.role !== "assistant") continue
    const parts = partsByMessage[message.id] ?? []
    for (const part of parts) {
      if (part.type === "file") {
        recordOutputArtifactPreviewUrl(map, part, key)
        continue
      }
      if (part.type !== "tool" || part.tool !== "image_generation") continue
      if (part.state.status !== "running" && part.state.status !== "completed") continue
      const attachments = (part.state as { attachments?: OutputArtifactLike[] }).attachments ?? []
      for (const attachment of attachments) {
        if (attachment.type !== "file") continue
        if (!isGeneratedImageArtifact(attachment)) continue
        recordOutputArtifactPreviewUrl(map, attachment, key)
      }
    }
  }
  return map
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * shell 工具产物事件：读取 shell / bash-output / kill-shell 元数据里的 `files`。
 *
 * 该字段由服务端对比命令前后的 cwd 状态得出（见 opencode 的 ShellFiles.scanChangedFiles）：
 * - `change`：命令结束后 mtime 晚于命令开始，即「本轮写过且此刻存在」。
 * - `unlink`：命令开始时存在、结束后已消失，即「本轮删除」，用于回收残留条目。
 *
 * 都是真实文件系统状态而非对正文的猜测。后台命令的产物由 bash-output / kill-shell
 * 在进程退出后补扫上报，因此这三个工具的 part 都要读。
 *
 * 这里替代了此前的「扫正文提及」兜底。正文无法区分「本轮生成」「引用既有文件」「目录清单」
 * 「生成失败」「原计划输出」——`无法保存到 report.pdf` 这类失败措辞同样含路径，任何关键词
 * 排除规则都会持续遇到语义变体，在误报与漏报之间反复摆动。而输出区每行都是「打开这个产物」
 * 的按钮，点不开的行直接破坏不变量，所以只信文件系统状态，不再猜测自然语言。
 */
export function shellOutputFileEventsFromParts(parts: readonly Part[]) {
  const events: { path: string; event: "change" | "unlink" }[] = []
  for (const part of parts) {
    if (part.type !== "tool") continue
    if (part.state?.status !== "completed") continue
    const metadata = isPlainRecord(part.state?.metadata) ? part.state.metadata : undefined
    const files = metadata?.files
    if (!Array.isArray(files)) continue
    for (const item of files) {
      if (!isPlainRecord(item)) continue
      // 结构化守卫：apply_patch / patch 的 metadata.files 也叫 files，但形状是
      // { type, filePath, relativePath, patch }，没有 event。只认带合法 event 的条目，
      // 避免靠「字段名恰好不同」这种巧合来区分两种来源（那种耦合一改就静默串味）。
      if (item.event !== "change" && item.event !== "unlink") continue
      const file = item.path
      if (typeof file !== "string" || !file) continue
      // 远端 URL 不是本地产物。
      if (isRemoteOutputArtifactPath(file)) continue
      // unlink 不过可预览类型白名单：被删除的文件必须无条件回收。
      // 条目可能是 diff 来源以 generated 放行进来的（例如 app.js 不在可预览白名单内），
      // 若这里也按白名单过滤，shell 删掉它之后就永远回收不掉，留一行点不开的残留。
      if (item.event === "unlink") {
        events.push({ path: file, event: "unlink" })
        continue
      }
      if (!isSessionOutputArtifactPath(file)) continue
      events.push({ path: file, event: "change" })
    }
  }
  // 不在此处按路径去重：同一轮内可能先 change 后 unlink（写完又删），
  // 去重会吃掉后到的 unlink。顺序应用交由调用方，recordSessionOutputArtifact 本身幂等。
  return events
}

export function finalizeSessionOutputArtifacts(
  entries: readonly { path: string; seq: number }[],
  key = (path: string) => normalizeOutputArtifactKey(path),
) {
  const latest = new Map<string, { path: string; seq: number }>()
  for (const entry of entries) {
    const k = key(entry.path)
    const prev = latest.get(k)
    if (!prev || entry.seq > prev.seq) latest.set(k, entry)
  }
  return [...latest.values()].sort((a, b) => b.seq - a.seq).map((entry) => entry.path)
}

export function recordSessionOutputArtifact(
  entries: { path: string; seq: number }[],
  seq: { value: number },
  path: string | undefined,
  options?: {
    mime?: string
    bump?: boolean
    generated?: boolean
    key?: (path: string) => string
  },
) {
  const key = options?.key ?? ((item: string) => normalizeOutputArtifactKey(item))
  if (!path) return
  const allowed =
    options?.generated === true
      ? isSessionGeneratedArtifactPath(path)
      : isSessionOutputArtifactPath(path, options?.mime)
  if (!allowed) return
  const existing = entries.find((entry) => key(entry.path) === key(path))
  if (existing) {
    if (options?.bump !== true) return
    existing.seq = seq.value++
    existing.path = path
    return
  }
  entries.push({ path, seq: seq.value++ })
}

/**
 * 移除已收录的产物条目。
 * 输出区每行都是「打开这个产物」的按钮，被删除 / 内容清空的文件点开必然失败，
 * 与 d16954e7f 为 featured 卡确立的「删除轮不展示可打开对象」是同一条不变量。
 * featuredFile 每轮重算所以过滤即可，本函数跨轮累积，必须显式回收旧条目。
 */
export function removeSessionOutputArtifact(
  entries: { path: string; seq: number }[],
  path: string | undefined,
  key: (path: string) => string = (item: string) => normalizeOutputArtifactKey(item),
) {
  if (!path) return
  const target = key(path)
  for (let i = entries.length - 1; i >= 0; i--) {
    if (key(entries[i].path) === target) entries.splice(i, 1)
  }
}

/** 从 assistant 消息 parts 收集生成产物（生图附件、assistant file part 等）。 */
export function outputArtifactsFromParts(parts: readonly Part[]) {
  const paths: string[] = []

  for (const part of parts) {
    if (part.type === "file") {
      if (typeof part.url === "string" && isRemoteOutputArtifactPath(part.url)) continue
      const name = outputArtifactLabel(part)
      if (name && isSessionOutputArtifactPath(name, part.mime)) paths.push(name)
      continue
    }
    if (part.type !== "tool" || part.tool !== "image_generation") continue
    if (part.state.status !== "running" && part.state.status !== "completed") continue
    const attachments = (part.state as { attachments?: OutputArtifactLike[] }).attachments ?? []
    for (const attachment of attachments) {
      if (attachment.type !== "file") continue
      if (!isGeneratedImageArtifact(attachment)) continue
      const name = outputArtifactLabel(attachment)
      if (name) paths.push(name)
    }
  }

  return paths
}

export function normalizeWebSourceUrl(url: string) {
  try {
    const parsed = new URL(url)
    const pathname =
      parsed.pathname.length > 1 && parsed.pathname.endsWith("/")
        ? parsed.pathname.slice(0, -1)
        : parsed.pathname
    return `${parsed.protocol}//${parsed.host.toLowerCase()}${pathname}${parsed.search}${parsed.hash}`
  } catch {
    return url.trim()
  }
}

export function uniquePreserveOrder(items: readonly string[], key = (item: string) => item) {
  const seen = new Set<string>()
  const result: string[] = []
  for (const item of items) {
    const k = key(item)
    if (seen.has(k)) continue
    seen.add(k)
    result.push(item)
  }
  return result
}

/** 去重后按时间倒序：最新项在最前，最早项在最后。 */
export function uniquePreserveOrderLatestFirst(items: readonly string[], key = (item: string) => item) {
  return orderOutputArtifactsLatestFirst(items, key)
}

/** 按收集顺序保留每个 key 的最新一次，再按序号倒序输出。 */
export function orderOutputArtifactsLatestFirst(
  items: readonly string[],
  key = (item: string) => item,
) {
  const latest = new Map<string, { item: string; seq: number }>()
  items.forEach((item, seq) => {
    const k = key(item)
    const prev = latest.get(k)
    if (!prev || seq > prev.seq) latest.set(k, { item, seq })
  })
  return [...latest.values()].sort((a, b) => b.seq - a.seq).map((entry) => entry.item)
}

export function partUsesWebAccess(part: Part): boolean {
  return part.type === "tool" && WEB_ACCESS_TOOLS.has(part.tool)
}

export function urlsFromText(text: string | undefined) {
  if (!text) return []
  const seen = new Set<string>()
  const urls: string[] = []
  const push = (raw: string) => {
    const item = raw.replace(/[),.;:!?]+$/g, "")
    if (!item || !isDisplayableWebSourceUrl(item) || seen.has(item)) return
    seen.add(item)
    urls.push(item)
  }
  for (const match of text.matchAll(/https?:\/\/[^\s<>"'`)\]]+/g)) push(match[0])
  for (const match of text.matchAll(/\[[^\]]*\]\((https?:\/\/[^)]+)\)/g)) push(match[1])
  return urls
}

export function isDisplayableWebSourceUrl(url: string) {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false
    if (isPrivateOrLoopbackHost(parsed.hostname)) return false
    return isWebDataSourceUrl(parsed)
  } catch {
    return false
  }
}

const WEB_SOURCE_HOST_DENY = new Set([
  "schemas.openxmlformats.org",
  "schemas.microsoft.com",
  "purl.org",
  "purl.oclc.org",
  "docs.oasis-open.org",
  "www.opengis.net",
])

function isWebDataSourceUrl(parsed: URL) {
  const host = parsed.hostname.toLowerCase()
  const path = parsed.pathname
  if (WEB_SOURCE_HOST_DENY.has(host)) return false
  if (host.startsWith("schemas.") || host.includes(".schemas.")) return false
  if (host.endsWith(".openxmlformats.org")) return false
  if (host === "www.w3.org" && (/^\/(19|20)\d{2}\//.test(path) || path.startsWith("/XML"))) return false
  if (/\/(spreadsheetml|wordprocessingml|presentationml|officeDocument|relationships)\b/.test(path) && host.includes("openxml")) {
    return false
  }
  if (/\.(xsd|dtd|wsdl|xslt)(\?|$)/i.test(path)) return false
  return true
}

function urlsFromWebsearchOutput(text: string | undefined) {
  if (!text) return []
  for (const line of text.split("\n")) {
    const trimmed = line.trim()
    const match = trimmed.match(/^(https?:\/\/\S+)$/)
    if (match) {
      const urls = urlsFromText(match[1])
      if (urls[0]) return [urls[0]]
    }
  }
  for (const match of text.matchAll(/\[[^\]]*\]\((https?:\/\/[^)]+)\)/g)) {
    const urls = urlsFromText(match[1])
    if (urls[0]) return [urls[0]]
  }
  return []
}

function urlsFromWebSearchMetadata(metadata: Record<string, unknown>) {
  const action = metadata.action
  const sources =
    action && typeof action === "object" && !Array.isArray(action)
      ? (action as Record<string, unknown>).sources
      : metadata.sources
  if (!Array.isArray(sources)) return []
  for (const source of sources) {
    if (typeof source === "string") {
      const urls = urlsFromText(source)
      if (urls[0]) return [urls[0]]
    }
    if (source && typeof source === "object" && typeof (source as Record<string, unknown>).url === "string") {
      const urls = urlsFromText((source as Record<string, unknown>).url as string)
      if (urls[0]) return [urls[0]]
    }
  }
  return []
}

function toolPartMetadata(part: Part) {
  if (part.type !== "tool") return undefined
  if ("metadata" in part.state && part.state.metadata && typeof part.state.metadata === "object") {
    return part.state.metadata as Record<string, unknown>
  }
  return part.metadata as Record<string, unknown> | undefined
}

function bashCommandText(part: Part) {
  if (part.type !== "tool" || part.tool !== "bash" || !("input" in part.state)) return ""
  const input = part.state.input as Record<string, unknown>
  const metadata = toolPartMetadata(part)
  if (typeof input.command === "string" && input.command) return input.command
  if (typeof metadata?.command === "string" && metadata.command) return metadata.command
  return ""
}

const BASH_HTTP_CLIENT_RE =
  /\b(curl|wget|httpie|xh|Invoke-RestMethod|Invoke-WebRequest|iwr|irm|requests\.(?:get|post|put|delete)|urllib\.request|httpx?\.(?:get|post)|axios\.(?:get|post)|fetch\s*\(|node\s+-e|bun\s+-e|python(?:3)?\s+-c)\b/i

function isBashHttpRequest(command: string) {
  if (BASH_HTTP_CLIENT_RE.test(command)) return true
  if (!/\bhttps?:\/\//.test(command)) return false
  if (/\b(npm|pnpm|yarn|bun)\s+(install|add|i)\b/i.test(command)) return false
  if (/\bgit\s+(clone|remote)\b/i.test(command)) return false
  return /\b(python(?:3)?|node|bun)\b/i.test(command)
}

function bashSourceUrls(part: Part) {
  const command = bashCommandText(part)
  if (!command || !isBashHttpRequest(command)) return []
  const urls = urlsFromText(command)
  return urls[0] ? [urls[0]] : []
}

function toolSourceInputUrls(part: Part) {
  if (part.type !== "tool" || !("input" in part.state)) return []
  const input = part.state.input as Record<string, unknown>
  const urls: string[] = []
  if (part.tool === "webfetch" && typeof input.url === "string" && input.url) urls.push(input.url)
  if (part.tool === "bash") urls.push(...bashSourceUrls(part))
  return urls.filter(isDisplayableWebSourceUrl)
}

function toolSourceOutputText(part: Part) {
  if (part.type !== "tool") return ""
  if ("output" in part.state && typeof part.state.output === "string") return part.state.output
  const metadata = toolPartMetadata(part)
  if (typeof metadata?.output === "string") return metadata.output
  return ""
}

function partWebSourceUrls(part: Part) {
  if (part.type !== "tool") return []
  if (!WEB_ACCESS_TOOLS.has(part.tool) && part.tool !== "bash") return []
  const urls = [...toolSourceInputUrls(part)]
  if (part.state.status === "pending" || part.state.status === "error") return urls
  if (WEB_ACCESS_TOOLS.has(part.tool)) {
    if (part.tool === "websearch") urls.push(...urlsFromWebsearchOutput(toolSourceOutputText(part)))
    if (part.tool === "web_search" || part.tool === "web_search_preview") {
      const metadata = toolPartMetadata(part)
      if (metadata) urls.push(...urlsFromWebSearchMetadata(metadata))
    }
  }
  return urls
}

function finalizeWebSourceUrls(
  entries: readonly { url: string; seq: number }[],
  key = normalizeWebSourceUrl,
) {
  const latest = new Map<string, { url: string; seq: number }>()
  for (const entry of entries) {
    const k = key(entry.url)
    const prev = latest.get(k)
    if (!prev || entry.seq > prev.seq) latest.set(k, entry)
  }
  return [...latest.values()].sort((a, b) => b.seq - a.seq).map((entry) => entry.url)
}

function collectWebSourceUrlEntries(
  messages: readonly Message[],
  parts: Record<string, Part[] | undefined>,
  entries: { url: string; seq: number }[],
  seq: { value: number },
) {
  let turnFirstUrl: string | undefined
  let turnSeq: number | undefined

  const flushTurn = () => {
    if (!turnFirstUrl) return
    const key = normalizeWebSourceUrl(turnFirstUrl)
    const existing = entries.find((entry) => normalizeWebSourceUrl(entry.url) === key)
    if (existing) {
      existing.seq = turnSeq ?? seq.value++
      existing.url = turnFirstUrl
    } else {
      entries.push({ url: turnFirstUrl, seq: turnSeq ?? seq.value++ })
    }
    turnFirstUrl = undefined
    turnSeq = undefined
  }

  for (const message of messages) {
    if (message.role === "user") {
      flushTurn()
      continue
    }
    for (const part of parts[message.id] ?? []) {
      for (const url of partWebSourceUrls(part)) {
        if (!isDisplayableWebSourceUrl(url)) continue
        if (turnFirstUrl) continue
        turnFirstUrl = url
        turnSeq = seq.value++
      }
    }
  }
  flushTurn()
}

export function sessionWebSourceUrls(
  messages: readonly Message[],
  parts: Record<string, Part[] | undefined>,
) {
  const entries: { url: string; seq: number }[] = []
  const seq = { value: 0 }
  collectWebSourceUrlEntries(messages, parts, entries, seq)
  return finalizeWebSourceUrls(entries)
}

export function sessionsWebSourceUrls(
  sessionIDs: ReadonlySet<string>,
  messagesBySession: Record<string, readonly Message[] | undefined>,
  partsByMessage: Record<string, Part[] | undefined>,
) {
  const entries: { url: string; seq: number }[] = []
  const seq = { value: 0 }
  for (const sessionID of sessionIDs) {
    collectWebSourceUrlEntries(messagesBySession[sessionID] ?? [], partsByMessage, entries, seq)
  }
  return finalizeWebSourceUrls(entries)
}

export function descendantSessionIDs(
  rootID: string,
  sessions: readonly { id: string; parentID?: string }[],
): Set<string> {
  const childrenByParent = sessions.reduce((acc, session) => {
    if (!session.parentID) return acc
    const list = acc.get(session.parentID) ?? []
    acc.set(session.parentID, [...list, session.id])
    return acc
  }, new Map<string, string[]>())

  const ids = new Set([rootID])
  const pending = [rootID]
  while (pending.length > 0) {
    const current = pending.pop()!
    for (const child of childrenByParent.get(current) ?? []) {
      if (ids.has(child)) continue
      ids.add(child)
      pending.push(child)
    }
  }
  return ids
}

export function sessionHasWebSearch(
  messages: readonly Message[],
  parts: Record<string, Part[] | undefined>,
): boolean {
  return messages.some((message) => (parts[message.id] ?? []).some((part) => partUsesWebAccess(part)))
}

export function sessionsHaveWebAccess(
  sessionIDs: ReadonlySet<string>,
  messagesBySession: Record<string, readonly Message[] | undefined>,
  partsByMessage: Record<string, Part[] | undefined>,
): boolean {
  return [...sessionIDs].some((sessionID) =>
    sessionHasWebSearch(messagesBySession[sessionID] ?? [], partsByMessage),
  )
}
