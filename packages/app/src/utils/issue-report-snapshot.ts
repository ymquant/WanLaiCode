import type { ContentPart, Prompt } from "@/context/prompt"

const MAX_EVENTS = 120
const MAX_TEXT = 2000
const MAX_STACK = 8000
const MAX_SNAPSHOT_TEXT = 120_000
const MAX_DROPPED_TEXT_SAMPLE = 200_000
const MAX_REDACT_DEPTH = 8

export type IssueReportEventType =
  | "action"
  | "console"
  | "error"
  | "unhandledrejection"
  | "network"
  | "longtask"
  | "desktop"

export type IssueReportEvent = {
  type: IssueReportEventType
  name: string
  at: number
  message?: string
  stack?: string
  data?: Record<string, unknown>
}

export type IssueReportSnapshot = {
  schema_version: 1
  created_at: string
  page: {
    href: string
    path: string
    visibility: DocumentVisibilityState
    focused: boolean
    user_agent: string
    language: string
    viewport: {
      width: number
      height: number
      device_pixel_ratio: number
    }
  }
  app: {
    platform: string
    os?: string
    version?: string
    sentry_enabled?: boolean
  }
  runtime: {
    memory?: Record<string, number>
    timezone?: string
  }
  context?: Record<string, unknown>
  events: IssueReportEvent[]
  desktop?: Record<string, unknown>
}

export type IssueReportPayload = {
  title: string
  description: string
  category: string
  severity: string
  sentry_event_id?: string
  app_version?: string
  platform?: string
  os?: string
  snapshot: IssueReportSnapshot
}

export type IssueReportPromptPartSummary = {
  type: ContentPart["type"]
  index: number
  start?: number
  end?: number
  content_length?: number
  content_hash?: string
  path_hash?: string
  path_ext?: string
  name_hash?: string
  addon_hash?: string
  filename_hash?: string
  filename_ext?: string
  mime?: string
  data_url_bytes?: number
  selection?: boolean
}

export type IssueReportDragFileSummary = {
  index: number
  name_hash: string
  ext: string
  size: number
  type: string
  last_modified?: number
}

export type IssueReportDroppedTextSummary = {
  length: number
  hash: string
  lines: number
  truncated: boolean
  starts_with_file_prefix: boolean
  looks_like_path: boolean
  looks_like_url: boolean
}

export type IssueReportAttachmentSummary = {
  name_hash: string
  ext: string
  size: number
  type: string
}

type PlatformInput = {
  platform: string
  os?: string
  version?: string
  sentryEnabled?: boolean
  context?: Record<string, unknown>
}

const events: IssueReportEvent[] = []

// 问题报告的实际提交由 Provider 注入（走 SDK 转发到社区投稿）。未注入时视为未配置。
export type IssueReportSubmitter = (input: {
  payload: IssueReportPayload
  attachments: File[]
}) => Promise<{ skipped: boolean }>
let issueReportSubmitter: IssueReportSubmitter | undefined

function trim(value: string, max = MAX_TEXT) {
  if (value.length <= max) return value
  return value.slice(0, max) + "…"
}

export function stableHash(value: string) {
  let hash = 2166136261
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, "0")
}

function safeString(value: unknown) {
  if (value instanceof Error) return `${value.name}: ${value.message}`
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export function redactText(value: string) {
  return value
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[email]")
    .replace(/\b1[3-9]\d{9}\b/g, "[phone]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(
      /\b(authorization|cookie|set-cookie|x-api-key|api[_-]?key|token|access[_-]?token|refresh[_-]?token|password|secret)\s*[:=]\s*([^\s,;"']+)/gi,
      "$1=[redacted]",
    )
    .replace(
      /([?&](?:authorization|cookie|api[_-]?key|token|access[_-]?token|refresh[_-]?token|password|secret|code)=)[^&#\s"']+/gi,
      "$1[redacted]",
    )
    .replace(/([A-Za-z]:\\(?:[^\\/:*?"<>|\r\n]+\\)*)([^\\/:*?"<>|\r\n]*)/g, "[path]/$2")
    .replace(/\/(?:Users|home)\/[^/\s]+\/([^\s"'<>]*)/g, "/[home]/$1")
}

export function sanitizeIssueError(error: unknown, fallbackMessage = "User submitted issue report") {
  const source = error instanceof Error ? error : new Error(error ? safeString(error) : fallbackMessage)
  const sanitized = new Error(redactedString(source.message || fallbackMessage))
  sanitized.name = redactedString(source.name || "Error")
  if (source.stack) sanitized.stack = trim(redactText(source.stack), MAX_STACK)
  return sanitized
}

function redactedString(value: string) {
  return trim(redactText(value))
}

function redactedUrlString(value: string) {
  const valueRedacted = redactText(value)
  try {
    const url = new URL(valueRedacted)
    const appUrl = ["localhost", "127.0.0.1", "::1"].includes(url.hostname)
    return `${url.origin}${appUrl ? routePath(url.pathname) : networkPath(url.pathname)}${url.search ? "?[query]" : ""}`
  } catch {
    return trim(valueRedacted)
  }
}

function redactedEntries(value: object) {
  try {
    return Object.entries(value as Record<string, unknown>)
  } catch {
    return undefined
  }
}

function redacted(value: unknown, seen = new WeakSet<object>(), depth = 0): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === "string") return redactedString(value)
  if (typeof value === "number" || typeof value === "boolean") return value
  if (typeof value !== "object") return trim(String(value))
  if (seen.has(value)) return "[circular]"
  if (depth >= MAX_REDACT_DEPTH) return "[max-depth]"
  seen.add(value)
  if (Array.isArray(value)) {
    const result = value.slice(0, 30).map((item) => redacted(item, seen, depth + 1))
    seen.delete(value)
    return result
  }
  const entries = redactedEntries(value)
  if (!entries) {
    seen.delete(value)
    return "[unserializable]"
  }
  const result = Object.fromEntries(
    entries.slice(0, 80).map(([key, item]) => {
      if (/token|secret|password|authorization|cookie|api[-_]?key/i.test(key)) return [key, "[redacted]"]
      if (/url|href/i.test(key) && typeof item === "string") return [key, redactedUrlString(item)]
      return [key, redacted(item, seen, depth + 1)]
    }),
  )
  seen.delete(value)
  return result
}

export function recordIssueEvent(input: Omit<IssueReportEvent, "at"> & { at?: number }) {
  events.push({
    ...input,
    at: input.at ?? Date.now(),
    message: input.message ? trim(redactText(input.message)) : undefined,
    stack: input.stack ? trim(redactText(input.stack), MAX_STACK) : undefined,
    data: input.data ? (redacted(input.data) as Record<string, unknown>) : undefined,
  })
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS)
}

export function recordIssueAction(name: string, data?: Record<string, unknown>) {
  recordIssueEvent({
    type: "action",
    name,
    stack: new Error(name).stack,
    data,
  })
}

export function getIssueEvents() {
  return [...events]
}

export function clearIssueEvents() {
  events.splice(0)
}

export function setIssueReportSubmitter(submitter: IssueReportSubmitter | undefined) {
  issueReportSubmitter = submitter
}

function jsonSize(value: unknown) {
  try {
    return JSON.stringify(value).length
  } catch {
    return 0
  }
}

function ext(name: string) {
  const idx = name.lastIndexOf(".")
  if (idx === -1) return ""
  return name.slice(idx + 1).toLowerCase()
}

export function summarizeDragFiles(files: File[]) {
  return files.slice(0, 20).map((file, index): IssueReportDragFileSummary => ({
    index,
    name_hash: stableHash(file.name),
    ext: ext(file.name),
    size: file.size,
    type: file.type,
    last_modified: file.lastModified || undefined,
  }))
}

export function summarizeDroppedText(value: string): IssueReportDroppedTextSummary {
  const sample = value.slice(0, MAX_DROPPED_TEXT_SAMPLE)
  return {
    length: value.length,
    hash: stableHash(sample),
    lines: value ? value.split(/\r\n|\r|\n/).length : 0,
    truncated: value.length > sample.length,
    starts_with_file_prefix: value.startsWith("file:"),
    looks_like_path: /^(?:[A-Za-z]:\\|\/|\\\\|~\/)/.test(value.trim()),
    looks_like_url: /^[a-z][a-z0-9+.-]*:/i.test(value.trim()),
  }
}

export function summarizeIssueAttachment(file: File): IssueReportAttachmentSummary {
  return {
    name_hash: stableHash(file.name),
    ext: ext(file.name),
    size: file.size,
    type: file.type,
  }
}

function mimeExt(type: string) {
  if (type === "image/jpeg") return "jpg"
  if (type === "image/png") return "png"
  if (type === "image/webp") return "webp"
  if (type === "image/gif") return "gif"
  return "bin"
}

export function issueReportAttachmentFilename(file: File, kind = "attachment", extOverride?: string) {
  const summary = summarizeIssueAttachment(file)
  const extension = extOverride ?? (summary.ext || mimeExt(file.type))
  return `issue-${kind.replace(/[^\w.-]+/g, "-")}-${stableHash(`${file.name}:${file.size}:${file.type}:${file.lastModified}`)}.${extension}`
}

function summarizePart(part: ContentPart, index: number): IssueReportPromptPartSummary {
  const base = {
    type: part.type,
    index,
    start: "start" in part ? part.start : undefined,
    end: "end" in part ? part.end : undefined,
    content_length: "content" in part && typeof part.content === "string" ? part.content.length : undefined,
    content_hash: "content" in part && typeof part.content === "string" ? stableHash(part.content) : undefined,
  }

  if (part.type === "file") {
    return {
      ...base,
      path_hash: stableHash(part.path),
      path_ext: ext(part.path),
      selection: Boolean(part.selection),
    }
  }
  if (part.type === "image") {
    return {
      ...base,
      filename_hash: stableHash(part.filename),
      filename_ext: ext(part.filename),
      mime: part.mime,
      data_url_bytes: part.dataUrl.length,
      content_length: undefined,
      content_hash: undefined,
    }
  }
  if (part.type === "agent") {
    return {
      ...base,
      name_hash: stableHash(part.name),
    }
  }
  if (part.type === "plugin") {
    return {
      ...base,
      name_hash: stableHash(part.name),
      addon_hash: stableHash(part.addonKey),
    }
  }
  return base
}

export function summarizePromptParts(prompt: Prompt) {
  return {
    total: prompt.length,
    json_bytes: jsonSize(prompt),
    parts: prompt.map(summarizePart),
    counts: prompt.reduce(
      (acc, part) => {
        acc[part.type] = (acc[part.type] ?? 0) + 1
        return acc
      },
      {} as Record<ContentPart["type"], number>,
    ),
  }
}

export function promptEditDelta(before: Prompt, after: Prompt) {
  const beforeParts = summarizePromptParts(before)
  const afterParts = summarizePromptParts(after)
  return {
    before: beforeParts,
    after: afterParts,
    removed: beforeParts.parts.filter((part) => {
      if (part.type === "image") {
        return !afterParts.parts.some((item) => item.type === "image" && item.filename_hash === part.filename_hash)
      }
      if (part.path_hash) return !afterParts.parts.some((item) => item.path_hash === part.path_hash)
      if (part.content_hash) return !afterParts.parts.some((item) => item.content_hash === part.content_hash)
      return false
    }),
  }
}

function pageSnapshot() {
  const width = typeof window === "undefined" ? 0 : window.innerWidth
  const height = typeof window === "undefined" ? 0 : window.innerHeight
  return {
    href: typeof location === "undefined" ? "" : pageHref(),
    path: typeof location === "undefined" ? "" : routePath(location.pathname),
    visibility: typeof document === "undefined" ? "visible" : document.visibilityState,
    focused: typeof document === "undefined" ? false : document.hasFocus(),
    user_agent: typeof navigator === "undefined" ? "" : navigator.userAgent,
    language: typeof navigator === "undefined" ? "" : navigator.language,
    viewport: {
      width,
      height,
      device_pixel_ratio: typeof window === "undefined" ? 1 : window.devicePixelRatio,
    },
  }
}

function pageHref() {
  try {
    const url = new URL(location.href)
    return `${url.origin}${routePath(url.pathname)}`
  } catch {
    return routePath(redactText(location.pathname))
  }
}

function routePath(pathname: string) {
  const publicRootSegments = new Set(["index.html", "users", "settings", "automations", "plugins"])
  const segments = pathname.split("/")
  return segments
    .map((segment, index) => {
      if (!segment) return segment
      if (index === 1) return publicRootSegments.has(segment) ? segment : `[project:${stableHash(segment)}]`
      if (segments[1] === "automations" && index === 2) return `[automation:${stableHash(segment)}]`
      if (segments[1] === "plugins" && index === 2 && segment !== "manage") return `[plugin:${stableHash(segment)}]`
      if (segments[index - 1] === "session") return `[session:${stableHash(segment)}]`
      return redactText(segment)
    })
    .join("/")
}

function networkPath(pathname: string) {
  const staticSegments = new Set(["api", "v1", "v2", "v3", "auth", "user-center", "software", "issue-reports"])
  return pathname
    .split("/")
    .map((segment) => {
      if (!segment) return segment
      if (staticSegments.has(segment)) return segment
      if (/^\d+$/.test(segment) || /^[a-f0-9-]{8,}$/i.test(segment) || /^(ses|msg|proj|user|org|att)_/.test(segment)) {
        return `[id:${stableHash(segment)}]`
      }
      return redactText(segment)
    })
    .join("/")
}

function memorySnapshot() {
  if (typeof performance === "undefined") return undefined
  const memory = (performance as Performance & { memory?: Record<string, number> }).memory
  if (!memory) return undefined
  return Object.fromEntries(Object.entries(memory).filter(([, value]) => typeof value === "number"))
}

export function createIssueReportSnapshot(input: PlatformInput, desktop?: Record<string, unknown>): IssueReportSnapshot {
  const snapshot: IssueReportSnapshot = {
    schema_version: 1,
    created_at: new Date().toISOString(),
    page: pageSnapshot(),
    app: {
      platform: input.platform,
      os: input.os,
      version: input.version,
      sentry_enabled: input.sentryEnabled,
    },
    runtime: {
      memory: memorySnapshot(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
    context: input.context ? (redacted(input.context) as Record<string, unknown>) : undefined,
    events: getIssueEvents(),
    desktop: desktop ? (redacted(desktop) as Record<string, unknown>) : undefined,
  }
  const serialized = JSON.stringify(snapshot)
  if (serialized.length <= MAX_SNAPSHOT_TEXT) return snapshot
  return {
    ...snapshot,
    events: snapshot.events.slice(-Math.max(20, Math.floor(snapshot.events.length / 2))),
    desktop: {
      ...snapshot.desktop,
      truncated: true,
      original_bytes: serialized.length,
    },
  }
}

export async function submitIssueReport(input: {
  payload: IssueReportPayload
  attachments?: File[]
}) {
  if (!issueReportSubmitter) return { skipped: true as const }
  const result = await issueReportSubmitter({ payload: input.payload, attachments: input.attachments ?? [] })
  return { skipped: result.skipped }
}

export function installIssueReportGlobalListeners() {
  if (typeof window === "undefined") return () => {}
  const originalError = console.error
  const originalWarn = console.warn
  const originalInfo = console.info
  const originalLog = console.log
  const originalDebug = console.debug
  const originalFetch = window.fetch
  const observer =
    typeof PerformanceObserver === "function"
      ? (() => {
          try {
            const value = new PerformanceObserver((list) => {
              for (const entry of list.getEntries()) {
                recordIssueEvent({
                  type: "longtask",
                  name: "performance.longtask",
                  data: {
                    duration: entry.duration,
                    start_time: entry.startTime,
                  },
                })
              }
            })
            value.observe({ entryTypes: ["longtask"] })
            return value
          } catch {
            return undefined
          }
        })()
      : undefined
  const onError = (event: ErrorEvent) => {
    recordIssueEvent({
      type: "error",
      name: "window.error",
      message: event.message,
      stack: event.error instanceof Error ? event.error.stack : undefined,
      data: { filename: event.filename, lineno: event.lineno, colno: event.colno },
    })
  }
  const onUnhandledRejection = (event: PromiseRejectionEvent) => {
    const reason = event.reason
    recordIssueEvent({
      type: "unhandledrejection",
      name: "window.unhandledrejection",
      message: safeString(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    })
  }
  const recordConsole = (name: string, args: unknown[], original: (...data: unknown[]) => void) => {
    recordIssueEvent({
      type: "console",
      name,
      message: args
        .map((arg) => (arg instanceof Error || typeof arg === "string" ? safeString(arg) : safeString(redacted(arg))))
        .join(" "),
    })
    original(...args)
  }
  console.error = (...args: unknown[]) => {
    recordConsole("console.error", args, originalError)
  }
  console.warn = (...args: unknown[]) => {
    recordConsole("console.warn", args, originalWarn)
  }
  console.info = (...args: unknown[]) => {
    recordConsole("console.info", args, originalInfo)
  }
  console.log = (...args: unknown[]) => {
    recordConsole("console.log", args, originalLog)
  }
  console.debug = (...args: unknown[]) => {
    recordConsole("console.debug", args, originalDebug)
  }
  if (originalFetch) {
    window.fetch = Object.assign(async (resource: RequestInfo | URL, init?: RequestInit) => {
      const startedAt = performance.now()
      try {
        const response = await originalFetch(resource, init)
        if (!response.ok) {
          recordIssueEvent({
            type: "network",
            name: "fetch.nonOk",
            data: networkSnapshot(resource, init, {
              status: response.status,
              duration_ms: Math.round(performance.now() - startedAt),
            }),
          })
        }
        return response
      } catch (err) {
        recordIssueEvent({
          type: "network",
          name: "fetch.rejected",
          message: safeString(err),
          stack: err instanceof Error ? err.stack : undefined,
          data: networkSnapshot(resource, init, {
            duration_ms: Math.round(performance.now() - startedAt),
          }),
        })
        throw err
      }
    }, originalFetch)
  }
  window.addEventListener("error", onError)
  window.addEventListener("unhandledrejection", onUnhandledRejection)
  return () => {
    window.removeEventListener("error", onError)
    window.removeEventListener("unhandledrejection", onUnhandledRejection)
    console.error = originalError
    console.warn = originalWarn
    console.info = originalInfo
    console.log = originalLog
    console.debug = originalDebug
    if (originalFetch) window.fetch = originalFetch
    observer?.disconnect()
  }
}

function networkSnapshot(resource: RequestInfo | URL, init: RequestInit | undefined, extra: Record<string, unknown>) {
  const request = resource instanceof Request ? resource : undefined
  const rawUrl = request?.url ?? String(resource)
  return {
    method: init?.method ?? request?.method ?? "GET",
    url: networkUrl(rawUrl),
    ...extra,
  }
}

function networkUrl(value: string) {
  try {
    const url = new URL(value, location.href)
    return redactText(`${url.origin}${networkPath(url.pathname)}`)
  } catch {
    return redactText(value.split("?")[0])
  }
}

export function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error("read attachment failed"))
    reader.readAsDataURL(blob)
  })
}

// 映射到社区投稿平台取值（windows/macos/linux/other）。
// mac/darwin 必须先判：`darwin` 含 `win` 子串，先判 win 会把 darwin 误判成 windows。
// 当前调用点传的是已归一化的 platform.os，取不到裸 darwin，这里只作为取值收窄前的兜底。
export function normalizeCommunityPlatform(os?: string, platform?: string): string {
  const value = `${os ?? ""} ${platform ?? ""}`.toLowerCase()
  if (value.includes("mac") || value.includes("darwin")) return "macos"
  if (value.includes("win")) return "windows"
  if (value.includes("linux")) return "linux"
  return "other"
}
