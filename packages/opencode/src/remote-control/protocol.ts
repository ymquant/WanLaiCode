import crypto from "node:crypto"
import type { MessageV2 } from "@/session/message-v2"
import type { Session } from "@/session/session"
import { sniffAttachmentMime } from "@/util/media"

export type RemoteSessionStatus = "idle" | "running" | "retry" | "waiting_approval"

// 手机端只负责切换桌面会话的权限预设；具体权限判断仍由桌面 Permission 服务执行。
export type RemotePermissionMode = "default" | "autoReview"

// 模型目录保留 providerID，避免同名模型在未来扩展到多个 provider 后失去权威映射。
export type RemoteModelInfo = {
  provider_id: string
  model_id: string
  reasoning_efforts: string[]
  context_window: number
}

export type RemoteSessionModel = {
  provider_id: string
  model_id: string
  variant?: string
  context_window?: number
}

export type RemoteSession = {
  id: string
  // 子代理会话保留父级关系，最近会话顶层列表据此与桌面侧边栏保持一致。
  parent_id?: string
  directory: string
  title: string
  status: RemoteSessionStatus
  created_at: number
  updated_at: number
  model?: RemoteSessionModel
  // 每个会话携带其目录下的权威模型目录，避免手机把其他项目独有模型用于当前会话。
  model_catalog?: RemoteModelInfo[]
  permission_mode: RemotePermissionMode
}

export type RemoteHistory = {
  session_id: string
  messages: MessageV2.WithParts[]
  next_cursor?: number
}

export type RemoteHistoryPage = {
  session_id: string
  items: MessageV2.RemoteHistoryPageItem[]
  next_cursor?: string
  high_water: string | null
}

export type RemotePermissionReply = "once" | "always" | "reject"

export type RemotePendingPermission = {
  session_id: string
  request_id: string
  permission: string
  patterns: readonly string[]
  metadata: Record<string, unknown>
}

export type RemotePendingQuestion = {
  session_id: string
  request_id: string
  questions: readonly unknown[]
}

export type RemoteSnapshot = {
  sessions: RemoteSession[]
  permissions: RemotePendingPermission[]
  questions: RemotePendingQuestion[]
}

// 手机原文件、设备端提取正文和 PDF 扫描页使用显式结构，Relay 只接收已校验且可重放的内容快照。
export type RemoteDerivedImage = {
  pageNumber: number
  mimeType: string
  base64: string
}

export type RemoteInputAttachment = {
  filename: string
  mimeType: string
  sizeBytes: number
  base64: string
  sha256?: string
  extractedText?: string
  derivedImages?: readonly RemoteDerivedImage[]
}

export type RemoteAttachmentContent = {
  attachment_id: string
  filename: string
  mime_type: string
  size_bytes: number
  base64: string
  sha256: string
}

export interface RemoteOperations {
  listSessions(): Promise<RemoteSession[]>
  modelCatalog(input?: { directory?: string }): Promise<RemoteModelInfo[]>
  // 空白项目必须在桌面主机创建；手机只负责收集名称和位置，不能直接访问桌面文件系统。
  blankProjectDefaults(input: { parent?: string }): Promise<{ parent: string; name: string }>
  blankProjectExists(input: {
    parent: string
    name: string
  }): Promise<{ parent: string; name: string; path: string; exists: boolean }>
  blankProjectCreate(input: { parent: string; name: string }): Promise<{ parent: string; name: string; path: string }>
  history(input: { session_id: string; cursor?: number; limit?: number }): Promise<RemoteHistory>
  historyPage(input: {
    session_id: string
    direction: "forward" | "backward"
    cursor?: string
    high_water?: string | null
    limit?: number
  }): Promise<RemoteHistoryPage>
  send(input: {
    session_id: string
    text: string
    images?: readonly MessageV2.FilePartInput[]
    attachments?: readonly RemoteInputAttachment[]
    request_id?: string
    client_message_id?: string
  }): Promise<{ message_id?: string }>
  getAttachment(input: { session_id: string; attachment_id: string }): Promise<RemoteAttachmentContent>
  create(input: {
    directory: string
    title?: string
    request_id?: string
    model_id?: string
    variant?: string | null
    permission_mode?: RemotePermissionMode
  }): Promise<RemoteSession>
  // 恢复入口把同一次用户确认中的模型与权限设置交给状态层原子提交，并返回提交后的权威会话。
  resume(input: {
    session_id: string
    model_id?: string
    variant?: string | null
    permission_mode?: RemotePermissionMode
  }): Promise<RemoteSession>
  abort(input: { session_id: string }): Promise<void>
  setModel(input: {
    session_id: string
    model_id: string
    variant?: string | null
  }): Promise<{ model: RemoteSessionModel; previous_model?: RemoteSessionModel }>
  setPermissionMode(input: { session_id: string; mode: RemotePermissionMode }): Promise<{ mode: RemotePermissionMode }>
  permissionMode(input: { session_id: string }): Promise<RemotePermissionMode>
  permissionReply(input: {
    session_id: string
    request_id: string
    reply: RemotePermissionReply
    message?: string
  }): Promise<void>
  reject(input: { session_id: string; request_id: string; message?: string }): Promise<void>
  questionReply(input: { session_id: string; request_id: string; answers: string[][] }): Promise<void>
  questionReject(input: { session_id: string; request_id: string }): Promise<void>
  snapshot(): Promise<RemoteSnapshot>
}

export type RemoteProtocolError = {
  code: string
  message: string
}

export class ProtocolError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

type JsonObject = Record<string, unknown>

export type BridgeServerMessage = JsonObject & { type: string }

export type RemoteDispatchContext = {
  request_scope?: string
}

function object(value: unknown): JsonObject | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  return value as JsonObject
}

function string(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function number(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

const remoteImageMimes = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"])
const remoteImageMaxCount = 5
const remoteImageMaxBytes = 4 * 1024 * 1024
const remoteImagesMaxBytes = 8 * 1024 * 1024
const remoteImageMaxBase64Length = Math.ceil(remoteImageMaxBytes / 3) * 4
const remoteAttachmentMaxCount = 5
export const remoteAttachmentMaxBytes = 4 * 1024 * 1024
const remoteAttachmentsMaxBytes = 8 * 1024 * 1024
const remoteAttachmentMaxBase64Length = Math.ceil(remoteAttachmentMaxBytes / 3) * 4
const remoteAttachmentMaxFilenameBytes = 255
const remoteAttachmentMaxMimeBytes = 255
const remoteAttachmentExtractedTextMaxChars = 128 * 1024
const remoteDerivedImageMaxCount = 3
const remoteDerivedImagesMaxBytes = 3 * 1024 * 1024
const remoteAllDerivedImagesMaxBytes = 8 * 1024 * 1024
const remoteDerivedAttachmentFilenamePrefix = ".wanlai-mobile-derived-"
const remoteAttachmentContextPrefix = "[Mobile attachment extracted content: "
const remoteTextApplicationMimes = new Set([
  "application/json",
  "application/ld+json",
  "application/javascript",
  "application/sql",
  "application/xml",
  "application/x-httpd-php",
  "application/x-javascript",
  "application/x-ndjson",
  "application/x-sh",
  "application/x-yaml",
  "application/yaml",
])
const remoteZipContainerMimes = new Set([
  "application/epub+zip",
  "application/vnd.oasis.opendocument.presentation",
  "application/vnd.oasis.opendocument.spreadsheet",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/zip",
])
const bridgeImageMaxBytes = 10 * 1024 * 1024
const bridgeImagesMaxBytes = 16 * 1024 * 1024
const bridgeImageMaxBase64Length = Math.ceil(bridgeImageMaxBytes / 3) * 4
const bridgeHistoryChunkMaxBytes = 32 * 1024 * 1024
const bridgeHistoryPageLimit = 1
// 极小图片也不能让 retained message ID 集合无界增长；超额项仍保留正文和 imageCount。
const bridgeHistoryImageMessageMaxCount = 4_096
export const bridgeHistoryImageBudgetBytes = 16 * 1024 * 1024

function remoteImageFilename(mime: string, index: number) {
  const extension = mime === "image/jpeg" ? "jpg" : mime.slice("image/".length)
  return `mobile-image-${index + 1}.${extension}`
}

// 手机附件进入会话前必须完成数量、Base64、真实 MIME 和总大小校验，不能依赖模型供应商兜底。
export function remoteImageParts(value: unknown): MessageV2.FilePartInput[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new ProtocolError("INVALID_REMOTE_IMAGE", "images must be an array")
  if (value.length > remoteImageMaxCount) {
    throw new ProtocolError("REMOTE_IMAGE_COUNT_EXCEEDED", `At most ${remoteImageMaxCount} images are allowed`)
  }

  let totalBytes = 0
  return value.map((item, index) => {
    const image = object(item)
    const mime = string(image?.mimeType)
    const encoded = string(image?.base64)
    if (!mime || !remoteImageMimes.has(mime) || !encoded) {
      throw new ProtocolError("INVALID_REMOTE_IMAGE", `Image ${index + 1} has an invalid MIME type or Base64 body`)
    }
    if (encoded.length > remoteImageMaxBase64Length) {
      throw new ProtocolError("REMOTE_IMAGE_TOO_LARGE", `Image ${index + 1} exceeds 4 MiB`)
    }

    const bytes = Buffer.from(encoded, "base64")
    if (bytes.length === 0 || bytes.toString("base64") !== encoded) {
      throw new ProtocolError("INVALID_REMOTE_IMAGE", `Image ${index + 1} must use canonical Base64`)
    }
    if (bytes.length > remoteImageMaxBytes) {
      throw new ProtocolError("REMOTE_IMAGE_TOO_LARGE", `Image ${index + 1} exceeds 4 MiB`)
    }
    if (sniffAttachmentMime(bytes, "") !== mime) {
      throw new ProtocolError("REMOTE_IMAGE_MIME_MISMATCH", `Image ${index + 1} MIME type does not match its bytes`)
    }
    totalBytes += bytes.length
    if (totalBytes > remoteImagesMaxBytes) {
      throw new ProtocolError("REMOTE_IMAGES_TOO_LARGE", "Image attachments exceed 8 MiB in total")
    }

    return {
      type: "file",
      mime,
      filename: remoteImageFilename(mime, index),
      url: `data:${mime};base64,${encoded}`,
    }
  })
}

function remoteAttachmentFilename(value: unknown, index: number) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    value === "." ||
    value === ".." ||
    value.startsWith(remoteDerivedAttachmentFilenamePrefix) ||
    Buffer.byteLength(value, "utf8") > remoteAttachmentMaxFilenameBytes ||
    /[\\/\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(value)
  ) {
    throw new ProtocolError("INVALID_REMOTE_ATTACHMENT", `Attachment ${index + 1} has an unsafe filename`)
  }
  return value
}

export function remoteStoredAttachmentFilename(value: unknown) {
  try {
    return remoteAttachmentFilename(value, 0)
  } catch {
    return
  }
}

function remoteAttachmentMime(value: unknown, index: number, label = "Attachment") {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value, "utf8") > remoteAttachmentMaxMimeBytes ||
    !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u.test(value)
  ) {
    throw new ProtocolError("INVALID_REMOTE_ATTACHMENT", `${label} ${index + 1} has an invalid MIME type`)
  }
  return value
}

function remoteCanonicalAttachmentBytes(input: {
  encoded: unknown
  index: number
  label: string
  maxBytes: number
  maxBase64Length: number
}) {
  if (typeof input.encoded !== "string" || input.encoded.length === 0) {
    throw new ProtocolError("INVALID_REMOTE_ATTACHMENT", `${input.label} ${input.index + 1} has no Base64 body`)
  }
  if (input.encoded.length > input.maxBase64Length) {
    throw new ProtocolError("REMOTE_ATTACHMENT_TOO_LARGE", `${input.label} ${input.index + 1} exceeds 4 MiB`)
  }
  const bytes = Buffer.from(input.encoded, "base64")
  if (bytes.length === 0 || bytes.toString("base64") !== input.encoded) {
    throw new ProtocolError("INVALID_REMOTE_ATTACHMENT", `${input.label} ${input.index + 1} must use canonical Base64`)
  }
  if (bytes.length > input.maxBytes) {
    throw new ProtocolError("REMOTE_ATTACHMENT_TOO_LARGE", `${input.label} ${input.index + 1} exceeds 4 MiB`)
  }
  return bytes
}

function remoteZipContainer(bytes: Uint8Array) {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    ((bytes[2] === 0x03 && bytes[3] === 0x04) ||
      (bytes[2] === 0x05 && bytes[3] === 0x06) ||
      (bytes[2] === 0x07 && bytes[3] === 0x08))
  )
}

function validateRemoteAttachmentMime(bytes: Uint8Array, mime: string, index: number, label = "Attachment") {
  const sniffed = sniffAttachmentMime(bytes, "")
  if (sniffed && sniffed !== mime) {
    throw new ProtocolError(
      "REMOTE_ATTACHMENT_MIME_MISMATCH",
      `${label} ${index + 1} MIME type does not match its bytes`,
    )
  }
  if ((remoteImageMimes.has(mime) || mime === "application/pdf") && sniffed !== mime) {
    throw new ProtocolError(
      "REMOTE_ATTACHMENT_MIME_MISMATCH",
      `${label} ${index + 1} MIME type does not match its bytes`,
    )
  }
  if (remoteZipContainerMimes.has(mime) && !remoteZipContainer(bytes)) {
    throw new ProtocolError(
      "REMOTE_ATTACHMENT_MIME_MISMATCH",
      `${label} ${index + 1} MIME type does not match its bytes`,
    )
  }
  if (mime.startsWith("text/") || remoteTextApplicationMimes.has(mime)) {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    } catch {
      throw new ProtocolError(
        "REMOTE_ATTACHMENT_MIME_MISMATCH",
        `${label} ${index + 1} declares UTF-8 text but contains binary data`,
      )
    }
  }
}

function remoteDerivedImages(value: unknown, attachmentIndex: number) {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    throw new ProtocolError(
      "INVALID_REMOTE_ATTACHMENT",
      `Attachment ${attachmentIndex + 1} derivedImages must be an array`,
    )
  }
  if (value.length > remoteDerivedImageMaxCount) {
    throw new ProtocolError(
      "REMOTE_ATTACHMENT_DERIVED_IMAGE_COUNT_EXCEEDED",
      `Attachment ${attachmentIndex + 1} may include at most ${remoteDerivedImageMaxCount} derived images`,
    )
  }

  let totalBytes = 0
  const pages = new Set<number>()
  return value.map((item, index): RemoteDerivedImage => {
    const image = object(item)
    const pageNumber = number(image?.pageNumber)
    if (!pageNumber || !Number.isInteger(pageNumber) || pageNumber < 1 || pages.has(pageNumber)) {
      throw new ProtocolError(
        "INVALID_REMOTE_ATTACHMENT",
        `Attachment ${attachmentIndex + 1} derived image ${index + 1} has an invalid page number`,
      )
    }
    pages.add(pageNumber)
    const mimeType = remoteAttachmentMime(image?.mimeType, index, "Derived image")
    if (mimeType !== "image/jpeg" && mimeType !== "image/png") {
      throw new ProtocolError(
        "INVALID_REMOTE_ATTACHMENT",
        `Attachment ${attachmentIndex + 1} derived image ${index + 1} must be JPEG or PNG`,
      )
    }
    const bytes = remoteCanonicalAttachmentBytes({
      encoded: image?.base64,
      index,
      label: "Derived image",
      maxBytes: remoteAttachmentMaxBytes,
      maxBase64Length: remoteAttachmentMaxBase64Length,
    })
    validateRemoteAttachmentMime(bytes, mimeType, index, "Derived image")
    totalBytes += bytes.length
    if (totalBytes > remoteDerivedImagesMaxBytes) {
      throw new ProtocolError(
        "REMOTE_ATTACHMENT_DERIVED_IMAGES_TOO_LARGE",
        `Attachment ${attachmentIndex + 1} derived images exceed 3 MiB in total`,
      )
    }
    return { pageNumber, mimeType, base64: image?.base64 as string }
  })
}

// 普通文件在进入 SessionPrompt 前完成文件名、MIME、真实尺寸、摘要和派生内容校验，避免 Relay 字段绕过本地限制。
export function remoteAttachmentInputs(value: unknown): RemoteInputAttachment[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new ProtocolError("INVALID_REMOTE_ATTACHMENT", "attachments must be an array")
  if (value.length > remoteAttachmentMaxCount) {
    throw new ProtocolError(
      "REMOTE_ATTACHMENT_COUNT_EXCEEDED",
      `At most ${remoteAttachmentMaxCount} attachments are allowed`,
    )
  }

  let totalBytes = 0
  return value.map((item, index) => {
    const attachment = object(item)
    if (!attachment) {
      throw new ProtocolError("INVALID_REMOTE_ATTACHMENT", `Attachment ${index + 1} must be an object`)
    }
    const filename = remoteAttachmentFilename(attachment.filename, index)
    const mimeType = remoteAttachmentMime(attachment.mimeType, index)
    const bytes = remoteCanonicalAttachmentBytes({
      encoded: attachment.base64,
      index,
      label: "Attachment",
      maxBytes: remoteAttachmentMaxBytes,
      maxBase64Length: remoteAttachmentMaxBase64Length,
    })
    if (!Number.isInteger(attachment.sizeBytes) || attachment.sizeBytes !== bytes.length) {
      throw new ProtocolError(
        "REMOTE_ATTACHMENT_SIZE_MISMATCH",
        `Attachment ${index + 1} sizeBytes does not match its Base64 body`,
      )
    }
    validateRemoteAttachmentMime(bytes, mimeType, index)
    totalBytes += bytes.length
    if (totalBytes > remoteAttachmentsMaxBytes) {
      throw new ProtocolError("REMOTE_ATTACHMENTS_TOO_LARGE", "File attachments exceed 8 MiB in total")
    }

    const sha256 = attachment.sha256
    const actualSha256 = crypto.createHash("sha256").update(bytes).digest("hex")
    if (sha256 !== undefined && (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(sha256))) {
      throw new ProtocolError("INVALID_REMOTE_ATTACHMENT", `Attachment ${index + 1} has an invalid SHA-256 digest`)
    }
    if (sha256 !== undefined && sha256 !== actualSha256) {
      throw new ProtocolError(
        "REMOTE_ATTACHMENT_DIGEST_MISMATCH",
        `Attachment ${index + 1} SHA-256 does not match its bytes`,
      )
    }

    const extractedText = attachment.extractedText
    if (extractedText !== undefined && typeof extractedText !== "string") {
      throw new ProtocolError("INVALID_REMOTE_ATTACHMENT", `Attachment ${index + 1} extractedText must be a string`)
    }
    if (typeof extractedText === "string" && extractedText.length > remoteAttachmentExtractedTextMaxChars) {
      throw new ProtocolError(
        "REMOTE_ATTACHMENT_TEXT_TOO_LARGE",
        `Attachment ${index + 1} extracted text exceeds 128K characters`,
      )
    }
    const derivedImages = remoteDerivedImages(attachment.derivedImages, index)
    return {
      filename,
      mimeType,
      sizeBytes: bytes.length,
      base64: attachment.base64 as string,
      sha256: actualSha256,
      ...(typeof extractedText === "string" && extractedText.length > 0 ? { extractedText } : {}),
      ...(derivedImages.length > 0 ? { derivedImages } : {}),
    }
  })
}

function remoteFilePartBytes(part: MessageV2.FilePartInput) {
  const marker = part.url.indexOf(",")
  return marker < 0 ? 0 : Buffer.from(part.url.slice(marker + 1), "base64").length
}

// 新客户端会为图片同时发送 attachments 与旧 images；按内容去重后再执行跨字段总量门禁，避免模型看到两份相同图片。
export function remoteInputAttachments(imagesValue: unknown, attachmentsValue: unknown) {
  const attachments = remoteAttachmentInputs(attachmentsValue)
  const attachmentKeys = new Set(attachments.map((item) => `${item.mimeType}\u0000${item.base64}`))
  const images = remoteImageParts(imagesValue).filter((part) => {
    const marker = part.url.indexOf(",")
    return !attachmentKeys.has(`${part.mime}\u0000${marker < 0 ? "" : part.url.slice(marker + 1)}`)
  })
  if (attachments.length + images.length > remoteAttachmentMaxCount) {
    throw new ProtocolError(
      "REMOTE_ATTACHMENT_COUNT_EXCEEDED",
      `At most ${remoteAttachmentMaxCount} attachments are allowed`,
    )
  }
  if (
    attachments.reduce((sum, item) => sum + item.sizeBytes, 0) +
      images.reduce((sum, item) => sum + remoteFilePartBytes(item), 0) >
    remoteAttachmentsMaxBytes
  ) {
    throw new ProtocolError("REMOTE_ATTACHMENTS_TOO_LARGE", "File attachments exceed 8 MiB in total")
  }
  const derivedBytes = attachments.reduce(
    (sum, attachment) =>
      sum +
      (attachment.derivedImages ?? []).reduce(
        (subtotal, image) => subtotal + Buffer.from(image.base64, "base64").length,
        0,
      ),
    0,
  )
  if (derivedBytes > remoteAllDerivedImagesMaxBytes) {
    throw new ProtocolError("REMOTE_ATTACHMENT_DERIVED_IMAGES_TOO_LARGE", "Derived images exceed 8 MiB in total")
  }
  return { images, attachments }
}

function remoteDerivedFilename(attachmentIndex: number, image: RemoteDerivedImage) {
  const extension = image.mimeType === "image/jpeg" ? "jpg" : "png"
  return `${remoteDerivedAttachmentFilenamePrefix}${attachmentIndex + 1}-page-${image.pageNumber}.${extension}`
}

// 原文件保持真实 MIME 供原生文件模型读取，提取正文和扫描页作为同一用户消息中的辅助上下文进入模型。
export function remoteAttachmentMessageParts(attachments: readonly RemoteInputAttachment[]) {
  return attachments.flatMap(
    (attachment, index): Array<MessageV2.TextPartInput | MessageV2.FilePartInput> => [
      {
        type: "file",
        mime: attachment.mimeType,
        filename: attachment.filename,
        url: `data:${attachment.mimeType};base64,${attachment.base64}`,
      },
      // text/plain 已由 SessionPrompt 原生解码；其他格式才追加设备端正文，避免同一内容进入模型两次。
      ...(attachment.extractedText && attachment.mimeType !== "text/plain"
        ? [
            {
              type: "text" as const,
              synthetic: true,
              text: `${remoteAttachmentContextPrefix}${attachment.filename}]\n${attachment.extractedText}\n[End mobile attachment extracted content]`,
            },
          ]
        : []),
      ...(attachment.derivedImages ?? []).map((image) => ({
        type: "file" as const,
        mime: image.mimeType,
        filename: remoteDerivedFilename(index, image),
        url: `data:${image.mimeType};base64,${image.base64}`,
      })),
    ],
  )
}

export function remoteAttachmentContextTexts(attachments: readonly RemoteInputAttachment[]) {
  return remoteAttachmentMessageParts(attachments).flatMap((part) =>
    part.type === "text" && part.text.startsWith(remoteAttachmentContextPrefix) ? [part.text] : [],
  )
}

export function isRemoteAttachmentContextText(text: string) {
  return text.startsWith(remoteAttachmentContextPrefix)
}

export function isRemoteDerivedAttachment(part: Pick<MessageV2.FilePart, "filename">) {
  return part.filename?.startsWith(remoteDerivedAttachmentFilenamePrefix) === true
}

// 预览只允许读取会话中完整、规范且仍在 4 MiB 上限内的 data URL；本地 file:// 路径绝不经 Relay 暴露。
export function remoteStoredAttachmentData(part: Pick<MessageV2.FilePart, "mime" | "url">) {
  try {
    remoteAttachmentMime(part.mime, 0)
  } catch {
    return
  }
  const prefix = `data:${part.mime};base64,`
  if (!part.url.startsWith(prefix)) return
  const base64 = part.url.slice(prefix.length)
  if (!base64 || base64.length > remoteAttachmentMaxBase64Length) return
  const bytes = Buffer.from(base64, "base64")
  if (bytes.length === 0 || bytes.length > remoteAttachmentMaxBytes || bytes.toString("base64") !== base64) return
  try {
    validateRemoteAttachmentMime(bytes, part.mime, 0)
  } catch {
    return
  }
  return {
    base64,
    sizeBytes: bytes.length,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
  }
}

function remoteStatus(value: unknown): RemoteSessionStatus {
  if (value === "busy" || value === "running") return "running"
  if (value === "retry") return "retry"
  if (value === "waiting_approval") return "waiting_approval"
  return "idle"
}

export function mapSession(
  session: Pick<Session.GlobalInfo, "id" | "parentID" | "directory" | "title" | "time" | "model">,
  status: unknown = "idle",
  settings: {
    model?: RemoteSessionModel
    model_catalog?: RemoteModelInfo[]
    permission_mode?: RemotePermissionMode
  } = {},
): RemoteSession {
  return {
    id: session.id,
    ...(session.parentID ? { parent_id: String(session.parentID) } : {}),
    directory: session.directory,
    title: session.title,
    status: remoteStatus(status),
    created_at: session.time.created,
    updated_at: session.time.updated,
    ...(settings.model
      ? { model: settings.model }
      : session.model
        ? {
            model: {
              provider_id: session.model.providerID,
              model_id: session.model.id,
              ...(session.model.variant ? { variant: session.model.variant } : {}),
            },
          }
        : {}),
    ...(settings.model_catalog ? { model_catalog: settings.model_catalog } : {}),
    permission_mode: settings.permission_mode ?? "default",
  }
}

function bridgePermissionSettings(mode: RemotePermissionMode) {
  // 两个桌面预设同时投影为旧字段与 Codex 设置，手机旧版和远控新版都能得到同一权威状态。
  return {
    permissionMode: "acceptEdits",
    executionMode: "default",
    planMode: false,
    codexSettings: {
      codexPermissionsMode: mode,
      approvalPolicy: "on-request",
      approvalsReviewer: mode === "autoReview" ? "auto_review" : "user",
      sandboxMode: "workspace-write",
    },
  }
}

function bridgeModelCatalog(catalog: readonly RemoteModelInfo[]) {
  // 会话项与 session_list 顶层复用完全相同的字段名，旧手机忽略新增项字段，新手机可按会话直接切换数据源。
  return {
    codexModels: catalog.map((item) => item.model_id),
    codexModelReasoningEfforts: Object.fromEntries(catalog.map((item) => [item.model_id, item.reasoning_efforts])),
    codexModelContextWindows: Object.fromEntries(catalog.map((item) => [item.model_id, item.context_window])),
  }
}

// ccpocket 仍使用 Claude 通用聊天屏；这里只提供 UI 兼容标记，执行端始终是 WanlaiCode。
export function bridgeSession(session: RemoteSession, pendingRequests: readonly JsonObject[] = []) {
  const permission = bridgePermissionSettings(session.permission_mode)
  const modelSettings = session.model
    ? {
        model: session.model.model_id,
        ...(session.model.variant ? { modelReasoningEffort: session.model.variant } : {}),
        ...(session.model.context_window ? { modelContextWindow: session.model.context_window } : {}),
      }
    : {}
  return {
    id: session.id,
    provider: "claude",
    projectPath: session.directory,
    claudeSessionId: session.id,
    name: session.title,
    status:
      session.status === "running" || session.status === "retry"
        ? "running"
        : session.status === "waiting_approval"
          ? "waiting_approval"
          : "idle",
    createdAt: new Date(session.created_at).toISOString(),
    lastActivityAt: new Date(session.updated_at).toISOString(),
    gitBranch: "",
    lastMessage: "",
    ...permission,
    ...(session.model ? { model: session.model.model_id } : {}),
    codexSettings: { ...permission.codexSettings, ...modelSettings },
    // per-session 目录是模型 setter 的真实校验边界，手机会话页应优先消费这里而不是顶层兼容目录。
    ...bridgeModelCatalog(session.model_catalog ?? []),
    // pendingPermission 保留旧客户端兼容；pendingRequests 始终存在，空数组也代表新协议的权威空快照。
    ...(pendingRequests[0]
      ? {
          pendingPermission: {
            toolUseId: pendingRequests[0].toolUseId,
            toolName: pendingRequests[0].toolName,
            input: pendingRequests[0].input,
          },
        }
      : {}),
    pendingRequests,
  }
}

function bridgeFile(part: MessageV2.FilePart): JsonObject {
  // 手机端已经能直接展示结构化文件；source 同时保留原字段和 metadata 兼容视图，避免文件来源语义在远控层丢失。
  return {
    type: "file",
    id: part.id,
    url: part.url,
    mimeType: part.mime,
    ...(part.filename ? { filename: part.filename } : {}),
    ...(part.source ? { source: part.source, metadata: { source: part.source } } : {}),
  }
}

function bridgeToolFields(part: MessageV2.ToolPart): JsonObject {
  const state = part.state
  const metadata = { ...(part.metadata ?? {}), ...(state.status === "pending" ? {} : (state.metadata ?? {})) }
  const attachments = state.status === "pending" ? [] : (state.attachments ?? []).map(bridgeFile)
  const time = state.status === "pending" ? undefined : state.time
  const end = time && "end" in time ? time.end : undefined
  // tool_use 与 tool_result 共用同一份权威状态投影，确保历史和实时更新不会因两条分支字段不一致而跳动。
  return {
    status: state.status,
    input: state.input,
    ...(state.status === "pending" ? { raw: state.raw } : {}),
    ...(state.status !== "pending" && state.title ? { title: state.title } : {}),
    ...(state.status === "completed" ? { output: state.output } : {}),
    ...(state.status === "error" ? { error: state.error } : {}),
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    // metadata 继续提供手机现有的合并视图，partMetadata 额外保留原始 part 值，避免同名键被 state 覆盖后无法还原。
    ...(part.metadata ? { partMetadata: part.metadata } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(time
      ? {
          time,
          start: time.start,
          startedAt: time.start,
          ...(end !== undefined ? { end, completedAt: end } : {}),
        }
      : {}),
    isError: state.status === "error",
  }
}

function bridgeAssistantContent(part: MessageV2.Part): JsonObject[] {
  if (part.type === "text" && !part.ignored) return [{ type: "text", text: part.text }]
  if (part.type === "reasoning") {
    return [
      {
        type: "reasoning",
        id: part.id,
        text: part.text,
        ...(part.originalText ? { originalText: part.originalText } : {}),
        ...(part.metadata ? { metadata: part.metadata } : {}),
        time: part.time,
      },
    ]
  }
  if (part.type === "tool") {
    return [{ type: "tool_use", id: part.callID, name: part.tool, ...bridgeToolFields(part) }]
  }
  if (part.type === "file") return [bridgeFile(part)]
  if (part.type === "step-start") return [{ type: "thinking", thinking: "Step started" }]
  if (part.type === "step-finish") return [{ type: "thinking", thinking: "Step completed" }]
  return []
}

function safeBridgeFilename(part: MessageV2.FilePart) {
  // 占位符只展示清理后的文件名，不能把本地路径、远程 URL 或控制字符带到手机聊天正文。
  const filename = part.filename
    ?.replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, 256)
  return filename || "attachment"
}

function bridgeUserMedia(message: MessageV2.WithParts) {
  const candidates = message.parts.filter(
    (part): part is MessageV2.FilePart =>
      part.type === "file" && remoteImageMimes.has(part.mime) && !isRemoteDerivedAttachment(part),
  )
  const images: Array<{ url: string; mimeType: string }> = []
  const embedded = new Set<MessageV2.FilePart>()
  let totalBytes = 0
  for (const part of candidates) {
    if (images.length >= remoteImageMaxCount) continue
    const prefix = `data:${part.mime};base64,`
    if (!part.url.startsWith(prefix)) continue
    const encoded = part.url.slice(prefix.length)
    if (!encoded || encoded.length > bridgeImageMaxBase64Length) continue
    const bytes = Buffer.from(encoded, "base64")
    if (
      bytes.length === 0 ||
      bytes.length > bridgeImageMaxBytes ||
      bytes.toString("base64") !== encoded ||
      sniffAttachmentMime(bytes, "") !== part.mime ||
      totalBytes + bytes.length > bridgeImagesMaxBytes
    ) {
      continue
    }
    totalBytes += bytes.length
    // 原生图片保持旧 images 形状；普通文件引用由独立 attachments 字段承担，不能改变既有图片协议。
    images.push({ url: part.url, mimeType: part.mime })
    embedded.add(part)
  }
  return { images, imageCount: candidates.length, embedded }
}

function bridgeUserAttachments(message: MessageV2.WithParts) {
  const embedded = new Set<MessageV2.FilePart>()
  const attachments = message.parts.flatMap((part) => {
    if (
      part.type !== "file" ||
      remoteImageMimes.has(part.mime) ||
      isRemoteDerivedAttachment(part) ||
      !part.filename
    ) {
      return []
    }
    const filename = remoteStoredAttachmentFilename(part.filename)
    const reference = remoteStoredAttachmentData(part)
    if (!reference || !filename) return []
    embedded.add(part)
    // 历史只同步不可枚举引用和内容摘要；原始 Base64 必须由已认证设备带 sessionId 按需读取。
    return [
      {
        id: part.id,
        url: `attachment://${part.id}`,
        filename,
        mimeType: part.mime,
        sizeBytes: reference.sizeBytes,
        sha256: reference.sha256,
      },
    ]
  })
  return { attachments, embedded }
}

function bridgeUserText(message: MessageV2.WithParts, embedded: ReadonlySet<MessageV2.FilePart>) {
  return message.parts
    .flatMap((part) => {
      if (part.type === "text" && !part.ignored && !part.synthetic) return [part.text]
      // PDF 扫描页只补充模型视觉输入，不作为用户选择的独立附件或占位文本重复展示。
      if (part.type === "file" && isRemoteDerivedAttachment(part)) return []
      // 非 data URL、损坏、超额或第六张之后的图片仍以安全占位符出现，不能在同步时静默消失。
      if (part.type === "file" && !embedded.has(part)) return [`[File: ${safeBridgeFilename(part)}]`]
      return []
    })
    .join("\n")
}

// 一个 OpenCode assistant message 可同时含 tool 调用与结果，因此适配为 assistant + tool_result 序列。
export function bridgeMessages(message: MessageV2.WithParts): BridgeServerMessage[] {
  if (message.info.role === "user") {
    const media = bridgeUserMedia(message)
    const files = bridgeUserAttachments(message)
    // 普通文件由新附件卡片承载；图片只有同时进入旧 images 字段时才省略占位，确保旧客户端仍能发现超额图片。
    const embedded = new Set([
      ...media.embedded,
      ...[...files.embedded].filter((part) => !remoteImageMimes.has(part.mime)),
    ])
    return [
      {
        type: "user_input",
        text: bridgeUserText(message, embedded),
        userMessageUuid: message.info.id,
        turnId: message.info.id,
        timestamp: new Date(message.info.time.created).toISOString(),
        sessionId: message.info.sessionID,
        imageCount: media.imageCount,
        attachmentCount: files.attachments.length,
        ...(message.info.remoteClientMessageID ? { clientMessageId: message.info.remoteClientMessageID } : {}),
        ...(media.images.length > 0 ? { images: media.images } : {}),
        ...(files.attachments.length > 0 ? { attachments: files.attachments } : {}),
      },
    ]
  }

  const turnId = message.info.parentID
  const content = message.parts.flatMap(bridgeAssistantContent)
  const assistant: BridgeServerMessage[] = content.length
    ? [
        {
          type: "assistant",
          messageUuid: message.info.id,
          turnId,
          sessionId: message.info.sessionID,
          message: {
            id: message.info.id,
            role: "assistant",
            content,
            model: message.info.modelID,
          },
        },
      ]
    : []
  const results = message.parts.flatMap((part): BridgeServerMessage[] => {
    if (part.type !== "tool") return []
    if (part.state.status === "completed") {
      return [
        {
          type: "tool_result",
          toolUseId: part.callID,
          toolName: part.tool,
          content: part.state.output,
          ...bridgeToolFields(part),
          turnId,
          sessionId: message.info.sessionID,
        },
      ]
    }
    if (part.state.status === "error") {
      return [
        {
          type: "tool_result",
          toolUseId: part.callID,
          toolName: part.tool,
          content: part.state.error,
          ...bridgeToolFields(part),
          turnId,
          sessionId: message.info.sessionID,
        },
      ]
    }
    return []
  })
  const result: BridgeServerMessage[] =
    message.info.time.completed || message.info.error
      ? [
          {
            type: "result",
            subtype: message.info.error ? "error" : "success",
            sessionId: message.info.sessionID,
            turnId,
            cost: message.info.cost,
            tokens: message.info.tokens,
            inputTokens: message.info.tokens.input,
            cachedInputTokens: message.info.tokens.cache.read,
            cacheWriteTokens: message.info.tokens.cache.write,
            outputTokens: message.info.tokens.output,
            reasoningTokens: message.info.tokens.reasoning,
            ...(message.info.tokens.total !== undefined ? { totalTokens: message.info.tokens.total } : {}),
            turnStartedAt: new Date(message.info.time.created).toISOString(),
            ...(message.info.time.completed !== undefined
              ? {
                  duration: Math.max(0, message.info.time.completed - message.info.time.created),
                  turnCompletedAt: new Date(message.info.time.completed).toISOString(),
                }
              : {}),
            ...(message.info.error ? { error: JSON.stringify(message.info.error) } : {}),
            ...(message.info.finish ? { stopReason: message.info.finish } : {}),
          },
        ]
      : []
  return [...assistant, ...results, ...result]
}

// tool part 的每次 pending/running/completed/error 更新都投影为同一 callID，手机可原位更新 loading 与终态。
export function bridgeToolUpdate(message: MessageV2.WithParts, callID: string): BridgeServerMessage[] {
  if (message.info.role === "user") return []
  const part = message.parts.find((item): item is MessageV2.ToolPart => item.type === "tool" && item.callID === callID)
  if (!part) return []
  // 同一 assistant message 可能包含多个并发工具；必须发送完整快照，不能只发当前工具导致其它工具在手机端消失。
  const assistant = bridgeMessages(message).find((item) => item.type === "assistant")
  if (!assistant) return []
  return [
    assistant,
    ...bridgeMessages(message).filter((item) => item.type === "tool_result" && item.toolUseId === callID),
  ]
}

function boundedHistoryEntry(
  entry: { seq: number; message: BridgeServerMessage },
  sessionID: string,
): { seq: number; message: BridgeServerMessage } {
  if (Buffer.byteLength(JSON.stringify(entry), "utf8") <= bridgeHistoryChunkMaxBytes) return entry
  return {
    seq: entry.seq,
    message: {
      type: "error",
      errorCode: "REMOTE_HISTORY_ENTRY_TOO_LARGE",
      message: "A desktop message is too large to display on mobile",
      sessionId: sessionID,
    },
  }
}

function dataUrlBytes(value: unknown) {
  if (typeof value !== "string" || !value.startsWith("data:")) return 0
  const marker = value.indexOf(",")
  if (marker < 0) return Buffer.byteLength(value, "utf8")
  const header = value.slice(0, marker)
  const payload = value.slice(marker + 1)
  if (!/;base64(?:;|$)/i.test(header)) return Buffer.byteLength(payload, "utf8")
  try {
    return Buffer.from(payload, "base64").byteLength
  } catch {
    // 损坏 data URL 也必须占用预算，不能借解析失败绕过历史传输上限。
    return Buffer.byteLength(payload, "utf8")
  }
}

function bridgeAttachmentBytes(value: unknown) {
  return dataUrlBytes(object(value)?.url)
}

function bridgeHistoryMessageImageBytes(message: BridgeServerMessage) {
  // 用户图片、assistant file、tool_use/tool_result attachments 都按实际 wire 中的 data URL 统一计费。
  if (message.type === "user_input") {
    return Array.isArray(message.images)
      ? message.images.reduce((total, image) => total + bridgeAttachmentBytes(image), 0)
      : 0
  }
  if (message.type === "assistant") {
    const content = object(message.message)?.content
    if (!Array.isArray(content)) return 0
    return content.reduce((total, item) => {
      const value = object(item)
      if (!value) return total
      const fileBytes = value.type === "file" || value.type === "image" ? bridgeAttachmentBytes(value) : 0
      const attachments = Array.isArray(value.attachments)
        ? value.attachments.reduce((sum, attachment) => sum + bridgeAttachmentBytes(attachment), 0)
        : 0
      return total + fileBytes + attachments
    }, 0)
  }
  if (message.type === "tool_result") {
    const attachments = Array.isArray(message.attachments)
      ? message.attachments.reduce((total, attachment) => total + bridgeAttachmentBytes(attachment), 0)
      : 0
    const images = Array.isArray(message.images)
      ? message.images.reduce((total, image) => total + bridgeAttachmentBytes(image), 0)
      : 0
    return attachments + images
  }
  return 0
}

function stripBridgeAttachment(value: unknown) {
  const attachment = object(value)
  if (!attachment || dataUrlBytes(attachment.url) === 0) return value
  return {
    ...attachment,
    url: "",
    metadata: {
      ...(object(attachment.metadata) ?? {}),
      remoteOmitted: true,
      omittedReason: "history_attachment_budget",
    },
  }
}

function stripBridgeHistoryAttachments(message: BridgeServerMessage) {
  if (message.type === "user_input") {
    delete message.images
    return
  }
  if (message.type === "assistant") {
    const payload = object(message.message)
    if (!payload || !Array.isArray(payload.content)) return
    payload.content = payload.content.map((item) => {
      const value = object(item)
      if (!value) return item
      const next = value.type === "file" || value.type === "image" ? stripBridgeAttachment(value) : value
      const mapped = object(next) ?? value
      return Array.isArray(mapped.attachments)
        ? { ...mapped, attachments: mapped.attachments.map(stripBridgeAttachment) }
        : mapped
    })
    return
  }
  if (message.type !== "tool_result") return
  if (Array.isArray(message.attachments)) message.attachments = message.attachments.map(stripBridgeAttachment)
  if (Array.isArray(message.images)) message.images = message.images.map(stripBridgeAttachment)
}

function normalizedHistoryStatus(status: RemoteSessionStatus | undefined) {
  return status === "running" || status === "retry" ? "running" : (status ?? "idle")
}

// 首包用 snapshot 清理旧缓存，后续 delta 按稳定 Bridge seq 追加，避免图片历史累积后形成单个超限 relay。
export function bridgeHistory(history: RemoteHistory, status: RemoteSessionStatus = "idle"): BridgeServerMessage[] {
  const groups = history.messages.map((message) => bridgeMessages(message))
  let remainingImageBytes = bridgeHistoryImageBudgetBytes
  let retainedImageMessages = 0
  // 从最新原生消息向前保留完整附件组；超过预算时只清空 data URL，结构、正文和附件元数据继续保留。
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const group = groups[index]
    if (!group) continue
    const bytes = group.reduce((total, message) => total + bridgeHistoryMessageImageBytes(message), 0)
    if (bytes === 0) continue
    if (bytes <= remainingImageBytes && retainedImageMessages < bridgeHistoryImageMessageMaxCount) {
      remainingImageBytes -= bytes
      retainedImageMessages += 1
      continue
    }
    group.forEach(stripBridgeHistoryAttachments)
  }
  const messages = groups.flat()
  const entries = messages.map((message, index) => boundedHistoryEntry({ seq: index + 1, message }, history.session_id))
  const chunks: Array<typeof entries> = []
  let current: typeof entries = []
  let currentBytes = 512
  for (const entry of entries) {
    const bytes = Buffer.byteLength(JSON.stringify(entry), "utf8")
    if (current.length > 0 && currentBytes + bytes > bridgeHistoryChunkMaxBytes) {
      chunks.push(current)
      current = []
      currentBytes = 512
    }
    current.push(entry)
    currentBytes += bytes
  }
  if (current.length > 0 || chunks.length === 0) chunks.push(current)

  const normalizedStatus = normalizedHistoryStatus(status)
  return chunks.map((chunk, index) => {
    const firstSeq = chunk[0]?.seq ?? 0
    const lastSeq = chunk.at(-1)?.seq ?? 0
    const last = index === chunks.length - 1
    if (index === 0) {
      return {
        type: "history_snapshot",
        sessionId: history.session_id,
        fromSeq: 0,
        toSeq: lastSeq,
        messages: chunk,
        ...(last ? { status: normalizedStatus } : {}),
        reason: "reset",
      }
    }
    return {
      type: "history_delta",
      sessionId: history.session_id,
      fromSeq: firstSeq,
      toSeq: lastSeq,
      messages: chunk,
      ...(last ? { status: normalizedStatus } : {}),
    }
  })
}

// 重连时把当前仍待处理的权限和问题重新发给手机，避免漏掉瞬时 asked 事件后无法继续会话。
function bridgeQuestions(questions: readonly unknown[]) {
  return questions.map((question) => {
    const value = object(question) ?? {}
    return {
      question: string(value.question) ?? "",
      header: string(value.header) ?? "Question",
      options: Array.isArray(value.options) ? value.options : [],
      multiSelect: value.multiple === true,
      custom: value.custom !== false,
    }
  })
}

function bridgePendingRequests(snapshot: RemoteSnapshot, sessionID: string): BridgeServerMessage[] {
  const permissions = snapshot.permissions
    .filter((request) => request.session_id === sessionID)
    .map((request) => ({
      type: "permission_request",
      requestKind: "permission",
      toolUseId: request.request_id,
      toolName: request.permission,
      input: {
        patterns: request.patterns,
        metadata: request.metadata,
        availableDecisions: ["accept", "acceptForSession", "decline"],
      },
      sessionId: request.session_id,
    }))
  const questions = snapshot.questions
    .filter((request) => request.session_id === sessionID)
    .map((request) => ({
      type: "permission_request",
      requestKind: "question",
      toolUseId: request.request_id,
      toolName: "AskUserQuestion",
      input: { questions: bridgeQuestions(request.questions) },
      sessionId: request.session_id,
    }))
  return [...permissions, ...questions]
}

// session_list 与历史恢复共用同一份待处理队列，不能再用单个 pendingPermission 覆盖并发请求。
export function bridgeSessionList(snapshot: RemoteSnapshot, catalog: readonly RemoteModelInfo[] = []) {
  return {
    type: "session_list",
    // Flutter 会同时校验 remote_ready 与 session_list；两处都声明文件能力后才允许上传，避免新手机把附件发给旧桌面静默丢失。
    capabilities: ["start_request_idempotency", "file_input_v1"],
    sessions: snapshot.sessions.map((session) =>
      bridgeSession(
        session,
        bridgePendingRequests(snapshot, session.id).map((request) => ({
          ...request,
          requestKind: request.requestKind,
        })),
      ),
    ),
    allowedDirs: [],
    // 顶层目录继续服务旧手机和新建页；服务层保证多目录场景只返回所有目录都支持的安全交集。
    ...bridgeModelCatalog(catalog),
  }
}

type RemoteHistoryStreamOptions = { active?: () => boolean }

function remoteHistoryStreamActive(options: RemoteHistoryStreamOptions) {
  return options.active?.() ?? true
}

async function retainedHistoryAttachments(
  operations: RemoteOperations,
  sessionID: string,
  options: RemoteHistoryStreamOptions,
) {
  const retained = new Set<string>()
  let remainingImageBytes = bridgeHistoryImageBudgetBytes
  let pageCursor: string | undefined
  let highWater: string | null | undefined
  // 每个分页 await 前后都检查 job 代次，close/换号后最多再完成当前一条 SQLite 查询。
  for (;;) {
    if (!remoteHistoryStreamActive(options)) return
    const page = await operations.historyPage({
      session_id: sessionID,
      cursor: pageCursor,
      high_water: highWater,
      limit: bridgeHistoryPageLimit,
      direction: "backward",
    })
    if (!remoteHistoryStreamActive(options)) return
    highWater = page.high_water
    for (const item of page.items) {
      if (item.type === "oversized") continue
      const bytes = bridgeMessages(item.message).reduce(
        (total, message) => total + bridgeHistoryMessageImageBytes(message),
        0,
      )
      if (bytes === 0 || bytes > remainingImageBytes) continue
      remainingImageBytes -= bytes
      retained.add(item.message.info.id)
    }
    if (
      remainingImageBytes === 0 ||
      retained.size >= bridgeHistoryImageMessageMaxCount ||
      page.next_cursor === undefined
    ) {
      return { retained, highWater: highWater ?? null }
    }
    pageCursor = page.next_cursor
  }
}

function oversizedHistoryMessage(sessionID: string, messageID: string): BridgeServerMessage {
  return {
    type: "error",
    errorCode: "REMOTE_HISTORY_ENTRY_TOO_LARGE",
    message: "A desktop message is too large to display on mobile",
    sessionId: sessionID,
    messageUuid: messageID,
  }
}

async function* streamBridgeHistory(
  message: JsonObject,
  operations: RemoteOperations,
  options: RemoteHistoryStreamOptions,
) {
  const sessionID = requireSessionID(message)
  const imageSelection = await retainedHistoryAttachments(operations, sessionID, options)
  if (!imageSelection || !remoteHistoryStreamActive(options)) return
  let pageCursor: string | undefined
  let nextSeq = 1
  let firstChunk = true
  const retainedImages = imageSelection.retained
  let entries: Array<{ seq: number; message: BridgeServerMessage }> = []
  let entriesBytes = 512

  for (;;) {
    if (!remoteHistoryStreamActive(options)) return
    const page = await operations.historyPage({
      session_id: sessionID,
      cursor: pageCursor,
      high_water: imageSelection.highWater,
      limit: bridgeHistoryPageLimit,
      direction: "forward",
    })
    if (!remoteHistoryStreamActive(options)) return
    const finalPage = page.next_cursor === undefined
    let status: RemoteSessionStatus | undefined
    if (finalPage) {
      const sessions = await operations.listSessions()
      if (!remoteHistoryStreamActive(options)) return
      status = normalizedHistoryStatus(sessions.find((session) => session.id === sessionID)?.status)
    }

    for (const item of page.items) {
      const mappedMessages =
        item.type === "oversized" ? [oversizedHistoryMessage(sessionID, item.messageID)] : bridgeMessages(item.message)
      for (const mapped of mappedMessages) {
        // 第二遍只让预扫选中的原生消息携带 data URL；未入选项仍保留结构、imageCount 与完整文本。
        if (item.type === "message" && !retainedImages.has(item.message.info.id)) {
          stripBridgeHistoryAttachments(mapped)
        }
        const entry = boundedHistoryEntry({ seq: nextSeq, message: mapped }, sessionID)
        const bytes = Buffer.byteLength(JSON.stringify(entry), "utf8")
        if (entries.length > 0 && entriesBytes + bytes > bridgeHistoryChunkMaxBytes) {
          const lastSeq = entries.at(-1)?.seq ?? nextSeq - 1
          yield firstChunk
            ? {
                type: "history_snapshot",
                sessionId: sessionID,
                fromSeq: 0,
                toSeq: lastSeq,
                messages: entries,
                reason: "reset",
              }
            : {
                type: "history_delta",
                sessionId: sessionID,
                fromSeq: entries[0]?.seq ?? nextSeq,
                toSeq: lastSeq,
                messages: entries,
              }
          firstChunk = false
          entries = []
          entriesBytes = 512
        }
        entries.push(entry)
        entriesBytes += bytes
        nextSeq += 1
      }
    }

    if (finalPage && (entries.length > 0 || firstChunk)) {
      const lastSeq = entries.at(-1)?.seq ?? nextSeq - 1
      yield firstChunk
        ? {
            type: "history_snapshot",
            sessionId: sessionID,
            fromSeq: 0,
            toSeq: lastSeq,
            messages: entries,
            ...(finalPage ? { status } : {}),
            reason: "reset",
          }
        : {
            type: "history_delta",
            sessionId: sessionID,
            fromSeq: entries[0]?.seq ?? nextSeq,
            toSeq: lastSeq,
            messages: entries,
            ...(finalPage ? { status } : {}),
          }
      firstChunk = false
    }

    if (finalPage) break
    pageCursor = page.next_cursor
  }

  // 权威历史完成后再恢复当前等待中的授权和提问，保持手机应用 snapshot/delta 的顺序稳定。
  if (!remoteHistoryStreamActive(options)) return
  const snapshot = await operations.snapshot()
  if (!remoteHistoryStreamActive(options)) return
  for (const pending of bridgePendingRequests(snapshot, sessionID)) yield pending
}

// Gateway 必须优先消费该异步流；普通 dispatch 禁止把多页历史重新聚合成一个无界数组。
export function remoteHistorySessionID(payload: unknown) {
  const input = object(payload)
  const message = object(input?.message)
  const type = string(message?.type)
  if (input?.type !== "bridge.client_message" || (type !== "get_history" && type !== "get_history_delta")) return
  return string(message?.sessionId) ?? string(message?.session_id)
}

export function streamRemoteHistoryPayload(
  payload: unknown,
  operations: RemoteOperations,
  options: RemoteHistoryStreamOptions = {},
): AsyncIterable<BridgeServerMessage> | undefined {
  const input = object(payload)
  const message = object(input?.message)
  const type = string(message?.type)
  if (input?.type !== "bridge.client_message" || (type !== "get_history" && type !== "get_history_delta")) return
  return (async function* () {
    for await (const item of streamBridgeHistory(message!, operations, options)) {
      yield { type: "bridge.server_message", message: item }
    }
  })()
}

function bridgeQuestionAnswers(result: unknown) {
  const value = string(result)
  if (!value) throw new ProtocolError("INVALID_QUESTION_ANSWER", "Question answer is required")
  try {
    const parsed = JSON.parse(value) as unknown
    const parsedObject = object(parsed)
    const answers = parsedObject?.answers
    if (Array.isArray(answers) && answers.every((answer) => Array.isArray(answer))) {
      return answers.map((answer) => answer.filter((item): item is string => typeof item === "string"))
    }
    const answerMap = object(answers)
    const questions = parsedObject?.questions
    if (answerMap && Array.isArray(questions)) {
      return questions.map((question) => {
        const text = string(object(question)?.question)
        const answer = text ? string(answerMap[text]) : undefined
        return answer ? answer.split(", ").filter(Boolean) : []
      })
    }
  } catch {
    // 单题旧客户端会直接发送选项文本，保留这一兼容路径。
  }
  // 首页紧凑卡片会按“问题标题: 答案”逐行发送，多题时按原显示顺序还原二维答案。
  const compact = value.split("\n").map((line) => /^\s*[^:]+:\s*(.+)\s*$/.exec(line)?.[1])
  if (compact.length > 0 && compact.every((answer): answer is string => !!answer)) {
    return compact.map((answer) => answer.split(", ").filter(Boolean))
  }
  return [[value]]
}

async function idempotentResolution(action: () => Promise<void>) {
  try {
    await action()
  } catch (error) {
    // 桌面重启后审批结果缓存会丢失，但底层请求已不再 pending 时应视为同一操作已经成功完成。
    if (error instanceof ProtocolError && error.code === "REQUEST_ALREADY_RESOLVED") return
    throw error
  }
}

function requireSessionID(message: JsonObject) {
  const sessionID = string(message.sessionId) ?? string(message.session_id)
  if (!sessionID) throw new ProtocolError("INVALID_REQUEST", "sessionId is required")
  return sessionID
}

function bridgeSessionCreated(session: RemoteSession, clientRequestID?: string) {
  const settings = bridgeSession(session)
  return {
    type: "system",
    subtype: "session_created",
    sessionId: session.id,
    claudeSessionId: session.id,
    provider: "claude",
    projectPath: session.directory,
    // 仅 start ACK 传入原始 ID；resume 不携带该字段，避免手机误收束另一条新建请求。
    ...(clientRequestID ? { clientRequestId: clientRequestID } : {}),
    permissionMode: settings.permissionMode,
    executionMode: settings.executionMode,
    planMode: settings.planMode,
    // SystemMessage 读取顶层 Codex 字段；同时保留嵌套对象供 recent/session_list 兼容路径消费。
    ...settings.codexSettings,
    codexSettings: settings.codexSettings,
    ...(session.model
      ? {
          model: session.model.model_id,
          modelReasoningEffort: session.model.variant ?? null,
          ...(session.model.context_window ? { modelContextWindow: session.model.context_window } : {}),
        }
      : {}),
  }
}

function permissionSettingAliases(input: JsonObject | undefined) {
  if (!input) return {}
  // 每一层先把 snake_case 投影成 canonical camelCase，随后外层字段才能稳定覆盖嵌套审批设置。
  return {
    ...input,
    ...(input.codexPermissionsMode !== undefined || input.codex_permissions_mode !== undefined
      ? { codexPermissionsMode: input.codexPermissionsMode ?? input.codex_permissions_mode }
      : {}),
    ...(input.approvalsReviewer !== undefined || input.approvals_reviewer !== undefined
      ? { approvalsReviewer: input.approvalsReviewer ?? input.approvals_reviewer }
      : {}),
    ...(input.approvalPolicy !== undefined || input.approval_policy !== undefined
      ? { approvalPolicy: input.approvalPolicy ?? input.approval_policy }
      : {}),
    ...(input.sandboxMode !== undefined || input.sandbox_mode !== undefined
      ? { sandboxMode: input.sandboxMode ?? input.sandbox_mode }
      : {}),
    ...(input.executionMode !== undefined || input.execution_mode !== undefined
      ? { executionMode: input.executionMode ?? input.execution_mode }
      : {}),
    ...(input.mode !== undefined || input.permissionMode !== undefined || input.permission_mode !== undefined
      ? { mode: input.mode ?? input.permissionMode ?? input.permission_mode }
      : {}),
  }
}

function requestedPermissionSettings(input: JsonObject) {
  // snake 嵌套 < camel 嵌套 < 消息顶层，确保 Bridge 与 native 两种 envelope 得到相同覆盖顺序。
  return {
    ...permissionSettingAliases(object(input.codex_settings)),
    ...permissionSettingAliases(object(input.codexSettings)),
    ...permissionSettingAliases(input),
  }
}

function normalizedPermissionMode(
  settings: ReturnType<typeof requestedPermissionSettings>,
): RemotePermissionMode | undefined {
  // 先把 canonical、Codex reviewer 与旧 Claude mode 收敛为两档模式，完整组合约束由下层统一校验。
  if (settings.codexPermissionsMode !== undefined) {
    const explicit = string(settings.codexPermissionsMode)
    if (explicit === "default" || explicit === "autoReview") return explicit
    throw new ProtocolError(
      "set_permission_mode_rejected",
      `Unsupported permission mode: ${String(settings.codexPermissionsMode)}`,
    )
  }
  const mode = string(settings.mode)
  // native setter 的三种 mode 字段允许直接携带桌面两档 canonical 值，再兼容旧客户端的 auto 别名。
  if (mode === "default" || mode === "autoReview") return mode
  if (string(settings.approvalsReviewer) === "auto_review" || mode === "auto") return "autoReview"
  // 旧客户端的 Claude 权限模式无法一一映射到桌面两档预设；只要明确提供非空旧值就安全降级为 default。
  if (string(settings.approvalsReviewer) || string(settings.mode)) return "default"
  return undefined
}

function requestedModelSetting(input: JsonObject, keys: string[], label: string) {
  // 顶层、camel 容器和 snake 容器按字段汇总，避免两个容器字段分散时整体 ?? 丢掉后一半设置。
  const values = [input, object(input.codexSettings), object(input.codex_settings)].flatMap((source) =>
    source ? keys.flatMap((key) => (source[key] === undefined ? [] : [source[key]])) : [],
  )
  const first = values[0]
  if (values.some((value) => !Object.is(value, first))) {
    // 同一语义的多个别名不能靠优先级静默覆盖，否则移动端与 native 客户端会得到不同模型状态。
    throw new ProtocolError("set_codex_model_rejected", `Conflicting ${label} values`)
  }
  return first
}

function requestedCreateModel(input: JsonObject) {
  const rawModel = requestedModelSetting(input, ["model", "model_id"], "model")
  const modelID = string(rawModel)
  // create 与 resume 必须同权校验：显式空值或错误类型不是“未指定”，否则客户端会误以为目标模型已生效。
  if (rawModel !== undefined && !modelID) {
    throw new ProtocolError("set_codex_model_rejected", "Model must be a non-empty string")
  }
  const rawVariant = requestedModelSetting(
    input,
    ["modelReasoningEffort", "model_reasoning_effort"],
    "modelReasoningEffort",
  )
  // 空字符串既不是“省略”也不是协议约定的显式清空，必须与错误类型一起在进入状态层前拒绝。
  if (rawVariant !== undefined && rawVariant !== null && (typeof rawVariant !== "string" || rawVariant.length === 0)) {
    throw new ProtocolError("set_codex_model_rejected", "modelReasoningEffort must be a non-empty string or null")
  }
  return {
    ...(modelID ? { model_id: modelID } : {}),
    ...(rawVariant !== undefined ? { variant: rawVariant as string | null } : {}),
  }
}

function requestedResumeModel(input: JsonObject) {
  const model = requestedCreateModel(input)
  if (model.variant !== undefined && !model.model_id) {
    throw new ProtocolError("set_codex_model_rejected", "A reasoning effort requires a model")
  }
  return model
}

function requestedPermissionMode(input: JsonObject): RemotePermissionMode | undefined {
  const settings = requestedPermissionSettings(input)
  const hasApprovalSettings = [
    settings.mode,
    settings.codexPermissionsMode,
    settings.approvalPolicy,
    settings.approvalsReviewer,
    settings.sandboxMode,
    settings.executionMode,
  ].some((value) => value !== undefined)
  if (!hasApprovalSettings) return undefined

  // 显式 mode alias 若为空或类型错误，不能借默认回退变成一次有效的 default 写入。
  if (settings.mode !== undefined && !string(settings.mode)) {
    throw new ProtocolError("set_permission_mode_rejected", `Unsupported permission mode: ${String(settings.mode)}`)
  }
  const mode = normalizedPermissionMode(settings) ?? "default"
  const modeAlias = string(settings.mode)
  const canonicalAlias =
    modeAlias === "default" || modeAlias === "autoReview"
      ? modeAlias
      : modeAlias === "auto"
        ? ("autoReview" as const)
        : undefined
  // canonical mode 三别名与 Codex 模式描述同一事实；仅旧 Claude 模式允许由 Codex 字段覆盖以维持兼容。
  if (settings.codexPermissionsMode !== undefined && canonicalAlias !== undefined && canonicalAlias !== mode) {
    throw new ProtocolError("set_permission_mode_rejected", "Conflicting canonical and Codex permission modes")
  }
  const approvalPolicy = settings.approvalPolicy
  const reviewer = settings.approvalsReviewer
  const sandboxMode = settings.sandboxMode
  const executionMode = settings.executionMode
  // 桌面当前只承诺 on-request + workspace-write；其他 Codex 组合不能降级成看似成功的默认权限。
  if (approvalPolicy !== undefined && approvalPolicy !== "on-request") {
    throw new ProtocolError("set_permission_mode_rejected", `Unsupported approval policy: ${String(approvalPolicy)}`)
  }
  if (reviewer !== undefined && reviewer !== "user" && reviewer !== "auto_review") {
    throw new ProtocolError("set_permission_mode_rejected", `Unsupported approvals reviewer: ${String(reviewer)}`)
  }
  if (sandboxMode !== undefined && sandboxMode !== "workspace-write" && sandboxMode !== "on") {
    throw new ProtocolError("set_permission_mode_rejected", `Unsupported sandbox mode: ${String(sandboxMode)}`)
  }
  if (executionMode !== undefined && executionMode !== "default") {
    throw new ProtocolError("set_permission_mode_rejected", `Unsupported execution mode: ${String(executionMode)}`)
  }
  if (reviewer !== undefined && (reviewer === "auto_review") !== (mode === "autoReview")) {
    throw new ProtocolError("set_permission_mode_rejected", "Conflicting permission mode and approvals reviewer")
  }
  return mode
}

function requiredPermissionMode(input: JsonObject) {
  const mode = requestedPermissionMode(input)
  // setter 缺省不能被解释成“写入 default”，否则字段丢失或客户端拼写错误会无提示地改掉用户设置。
  if (!mode) throw new ProtocolError("INVALID_REQUEST", "Permission mode is required")
  return mode
}

function bridgePermissionModeChanged(sessionID: string, mode: RemotePermissionMode): BridgeServerMessage {
  const settings = bridgePermissionSettings(mode)
  return {
    type: "system",
    subtype: "set_permission_mode",
    sessionId: sessionID,
    provider: "claude",
    ...settings,
    ...settings.codexSettings,
  }
}

async function dispatchBridgeInput(
  input: JsonObject,
  operations: RemoteOperations,
  context: RemoteDispatchContext,
): Promise<BridgeServerMessage[]> {
  const sessionID = requireSessionID(input)
  const unsupported =
    !!string(input.imageId) ||
    !!string(input.imageBase64) ||
    !!object(input.skill) ||
    (Array.isArray(input.skills) && input.skills.length > 0) ||
    (Array.isArray(input.mentions) && input.mentions.length > 0)
  if (unsupported) {
    throw new ProtocolError(
      "UNSUPPORTED_INPUT_ATTACHMENT",
      "Remote input supports files and images, but skills, mentions, and legacy image fields are unavailable",
    )
  }
  const parsed = remoteInputAttachments(input.images, input.attachments)
  const text = typeof input.text === "string" ? input.text : ""
  if (!text.trim() && parsed.images.length === 0 && parsed.attachments.length === 0) {
    throw new ProtocolError("INVALID_REQUEST", "Input text or attachment is required")
  }
  const clientMessageID = string(input.clientMessageId)
  await operations.send({
    session_id: sessionID,
    text,
    ...(parsed.images.length > 0 ? { images: parsed.images } : {}),
    ...(parsed.attachments.length > 0 ? { attachments: parsed.attachments } : {}),
    ...(clientMessageID ? { client_message_id: clientMessageID } : {}),
    ...(clientMessageID
      ? { request_id: JSON.stringify([context.request_scope ?? "bridge", sessionID, clientMessageID]) }
      : {}),
  })
  return [
    {
      type: "input_ack",
      sessionId: sessionID,
      ...(clientMessageID ? { clientMessageId: clientMessageID } : {}),
      queued: false,
    },
  ]
}

function bridgeAttachmentFailure(
  sessionID: string,
  attachmentID: string,
  error: RemoteProtocolError,
  requestID?: string,
) {
  const allowed = new Set(["attachment_not_found", "attachment_forbidden", "attachment_expired"])
  const known = allowed.has(error.code)
  const errorCode = known ? error.code : "attachment_expired"
  return {
    type: "attachment_content",
    sessionId: sessionID,
    attachmentId: attachmentID,
    ...(requestID ? { requestId: requestID } : {}),
    errorCode,
    error: known ? error.message : "Attachment content is no longer available",
  }
}

function bridgeInputFailure(input: JsonObject, error: RemoteProtocolError): BridgeServerMessage[] {
  const sessionID = string(input.sessionId) ?? string(input.session_id) ?? ""
  const clientMessageID = string(input.clientMessageId) ?? ""
  // input_rejected 先收束手机 optimistic 状态，随后 error 保留原错误码与用户可见说明。
  return [
    {
      type: "input_rejected",
      sessionId: sessionID,
      clientMessageId: clientMessageID,
      reason: error.message,
    },
    {
      type: "error",
      sessionId: sessionID,
      errorCode: error.code,
      message: error.message,
    },
  ]
}

function requiredBlankProjectField(input: JsonObject, key: "parent" | "name") {
  const value = string(input[key])
  if (!value) {
    throw new ProtocolError(key === "name" ? "invalid_project_name" : "invalid_project_path", `${key} is required`)
  }
  return value
}

// 三个空白项目 RPC 统一返回 requestId，保证手机并发请求不会串收结果。
async function dispatchBridgeBlankProject(
  type: "get_blank_project_defaults" | "check_blank_project_exists" | "create_blank_project",
  input: JsonObject,
  operations: RemoteOperations,
): Promise<BridgeServerMessage[]> {
  const requestID = string(input.requestId)
  if (!requestID) throw new ProtocolError("INVALID_REQUEST", "requestId is required")
  const action =
    type === "get_blank_project_defaults" ? "defaults" : type === "check_blank_project_exists" ? "exists" : "create"
  return Promise.resolve()
    .then(async () => {
      if (type === "get_blank_project_defaults") {
        if (input.parent !== undefined && !string(input.parent)) {
          throw new ProtocolError("invalid_project_path", "parent must be a non-empty string")
        }
        return {
          type: "blank_project_result",
          requestId: requestID,
          action,
          success: true,
          ...(await operations.blankProjectDefaults({ parent: string(input.parent) })),
        }
      }
      const parent = requiredBlankProjectField(input, "parent")
      const name = requiredBlankProjectField(input, "name")
      return {
        type: "blank_project_result",
        requestId: requestID,
        action,
        success: true,
        ...(type === "check_blank_project_exists"
          ? await operations.blankProjectExists({ parent, name })
          : await operations.blankProjectCreate({ parent, name })),
      }
    })
    .then((message) => [message])
    .catch((error) => {
      const info = protocolError(error)
      return [
        {
          type: "blank_project_result",
          requestId: requestID,
          action,
          success: false,
          ...(string(input.parent) ? { parent: string(input.parent) } : {}),
          ...(string(input.name) ? { name: string(input.name) } : {}),
          error: info.message,
          errorCode: info.code,
        },
      ]
    })
}

export async function dispatchBridgeMessage(
  message: unknown,
  operations: RemoteOperations,
  context: RemoteDispatchContext = {},
): Promise<BridgeServerMessage[]> {
  const input = object(message)
  const type = string(input?.type)
  if (!input || !type) throw new ProtocolError("INVALID_REQUEST", "Bridge message type is required")

  if (type === "client_capabilities") {
    // 手机只有收到该响应才把 relay 标记为在线；它证明桌面 gateway、账号和 Bridge 适配层均已就绪。
    const requestedCapabilities = Array.isArray(input.capabilities)
      ? input.capabilities.filter((item): item is string => typeof item === "string")
      : []
    // 新手机只消费 bridge.server_message；能力协商后桌面可以跳过旧的 sync.event 投影。
    const bridgeCapabilities = requestedCapabilities.includes("bridge_only_events")
      ? ["bridge_only_events"]
      : []
    return [
      {
        type: "system",
        subtype: "remote_ready",
        provider: "claude",
        protocolVersion: 1,
        capabilities: [
          "session_sync",
          "permission_sync",
          "question_sync",
          "image_input",
          "file_input_v1",
          "permission_mode",
          "model_selection",
          ...bridgeCapabilities,
        ],
      },
    ]
  }
  if (
    type === "get_blank_project_defaults" ||
    type === "check_blank_project_exists" ||
    type === "create_blank_project"
  ) {
    // 远控桌面直接复用本机项目创建能力，不再让手机误判为旧 Bridge。
    return dispatchBridgeBlankProject(type, input, operations)
  }
  if (type === "list_sessions") {
    const snapshot = await operations.snapshot()
    const directory = string(input.projectPath) ?? string(input.directory)
    // 新建页可按 projectPath 请求精确目录；旧客户端不传目录时仍取得多会话安全交集或 cwd 回退。
    return [bridgeSessionList(snapshot, await operations.modelCatalog(directory ? { directory } : undefined))]
  }
  if (type === "list_recent_sessions") {
    const projectPath = string(input.projectPath)
    const provider = string(input.provider)
    const namedOnly = input.namedOnly === true
    const search = string(input.searchQuery)?.toLocaleLowerCase()
    // 最近会话沿用手机现有筛选语义，但 provider 只是 UI 标记，绝不会启动 Claude 进程。
    const sessions = (await operations.listSessions()).filter((session) => {
      // 桌面侧边栏只把根会话作为顶层项；子代理仍保留在 session_list 中供状态和审批同步。
      if (session.parent_id) return false
      if (provider && provider !== "claude") return false
      if (projectPath && session.directory !== projectPath) return false
      if (namedOnly && !session.title.trim()) return false
      if (search && !`${session.title}\n${session.directory}`.toLocaleLowerCase().includes(search)) return false
      return true
    })
    const limit = Math.max(1, number(input.limit) ?? 50)
    const offset = Math.max(0, number(input.offset) ?? 0)
    const page = sessions.slice(offset, offset + limit)
    return [
      {
        type: "recent_sessions",
        sessions: page.map((session) => {
          const settings = bridgeSession(session)
          return {
            sessionId: session.id,
            provider: "claude",
            name: session.title,
            summary: session.title,
            firstPrompt: "",
            created: new Date(session.created_at).toISOString(),
            modified: new Date(session.updated_at).toISOString(),
            gitBranch: "",
            projectPath: session.directory,
            resumeCwd: session.directory,
            isSidechain: false,
            permissionMode: settings.permissionMode,
            executionMode: settings.executionMode,
            planMode: settings.planMode,
            codexSettings: settings.codexSettings,
          }
        }),
        hasMore: offset + page.length < sessions.length,
        limit,
        offset,
        ...(projectPath ? { projectPath } : {}),
        ...(string(input.requestScope) ? { requestScope: string(input.requestScope) } : {}),
      },
    ]
  }
  if (type === "get_history") {
    // 历史只能由 Gateway 的 async iterable 逐页消费，禁止在通用 dispatch 中重新拼成无界数组。
    throw new ProtocolError("STREAMING_RESPONSE_REQUIRED", "History responses must be streamed")
  }
  if (type === "get_history_delta") {
    // delta 仍返回完整权威 snapshot，但同样必须走流式路径，不能误把 Bridge seq 当作原生 cursor。
    throw new ProtocolError("STREAMING_RESPONSE_REQUIRED", "History responses must be streamed")
  }
  if (type === "get_attachment") {
    const sessionID = string(input.sessionId) ?? string(input.session_id) ?? ""
    const attachmentID = string(input.attachmentId) ?? string(input.attachment_id) ?? ""
    const requestID = string(input.requestId) ?? string(input.request_id)
    if (!sessionID || !attachmentID) {
      return [
        bridgeAttachmentFailure(
          sessionID,
          attachmentID,
          { code: "attachment_not_found", message: "Attachment not found" },
          requestID,
        ),
      ]
    }
    try {
      const attachment = await operations.getAttachment({ session_id: sessionID, attachment_id: attachmentID })
      // 成功响应仍返回稳定 attachmentId，客户端可以把分片重组结果直接写回原占位卡片。
      return [
        {
          type: "attachment_content",
          sessionId: sessionID,
          attachmentId: attachment.attachment_id,
          ...(requestID ? { requestId: requestID } : {}),
          filename: attachment.filename,
          mimeType: attachment.mime_type,
          sizeBytes: attachment.size_bytes,
          base64: attachment.base64,
          sha256: attachment.sha256,
        },
      ]
    } catch (error) {
      return [bridgeAttachmentFailure(sessionID, attachmentID, protocolError(error), requestID)]
    }
  }
  if (type === "input") {
    try {
      return await dispatchBridgeInput(input, operations, context)
    } catch (error) {
      return bridgeInputFailure(input, protocolError(error))
    }
  }
  if (type === "start") {
    const existing = string(input.sessionId)
    const clientRequestID = string(input.clientRequestId)
    const startRequestID = clientRequestID ?? string(input.request_id)
    // start 携带 sessionId 时语义是恢复并原子更新已有会话；新建与恢复分别使用各自的模型校验规则。
    const model = existing ? requestedResumeModel(input) : requestedCreateModel(input)
    const permissionMode = requestedPermissionMode(input)
    const session = existing
      ? await operations.resume({
          session_id: existing,
          ...(model.model_id ? { model_id: model.model_id } : {}),
          ...(model.variant !== undefined ? { variant: model.variant } : {}),
          ...(permissionMode ? { permission_mode: permissionMode } : {}),
        })
      : await operations.create({
          directory: string(input.projectPath) ?? "",
          title: string(input.name),
          request_id: startRequestID ? JSON.stringify([context.request_scope ?? "bridge", startRequestID]) : undefined,
          ...(model.model_id ? { model_id: model.model_id } : {}),
          ...(model.variant !== undefined ? { variant: model.variant } : {}),
          ...(permissionMode ? { permission_mode: permissionMode } : {}),
        })
    return [bridgeSessionCreated(session, clientRequestID)]
  }
  if (type === "resume_session") {
    const sessionID = requireSessionID(input)
    const model = requestedResumeModel(input)
    const permissionMode = requestedPermissionMode(input)
    // 单个 operations 调用是 resume 的事务边界，协议层不能拆成两个 setter 造成部分成功。
    const session = await operations.resume({
      session_id: sessionID,
      ...(model.model_id ? { model_id: model.model_id } : {}),
      ...(model.variant !== undefined ? { variant: model.variant } : {}),
      ...(permissionMode ? { permission_mode: permissionMode } : {}),
    })
    return [bridgeSessionCreated(session)]
  }
  if (type === "set_codex_model") {
    const sessionID = requireSessionID(input)
    const modelID = string(input.model)
    if (!modelID) throw new ProtocolError("set_codex_model_rejected", "Model is required")
    const hasVariant = Object.prototype.hasOwnProperty.call(input, "modelReasoningEffort")
    const rawVariant = input.modelReasoningEffort
    // setter 与 create/resume 使用同一档位约束；空字符串不能被状态层解释成“清空”。
    if (hasVariant && rawVariant !== null && (typeof rawVariant !== "string" || rawVariant.length === 0)) {
      throw new ProtocolError("set_codex_model_rejected", "modelReasoningEffort must be a non-empty string or null")
    }
    const result = await operations.setModel({
      session_id: sessionID,
      model_id: modelID,
      ...(hasVariant ? { variant: rawVariant as string | null } : {}),
    })
    return [
      {
        type: "system",
        subtype: "set_codex_model",
        sessionId: sessionID,
        provider: "claude",
        model: result.model.model_id,
        ...(result.previous_model?.model_id && result.previous_model.model_id !== result.model.model_id
          ? { previousModel: result.previous_model.model_id }
          : {}),
        modelReasoningEffort: result.model.variant ?? null,
        ...(result.model.context_window ? { modelContextWindow: result.model.context_window } : {}),
      },
    ]
  }
  if (type === "set_permission_mode") {
    const sessionID = requireSessionID(input)
    const result = await operations.setPermissionMode({ session_id: sessionID, mode: requiredPermissionMode(input) })
    return [bridgePermissionModeChanged(sessionID, result.mode)]
  }
  if (type === "interrupt" || type === "stop_session") {
    await operations.abort({ session_id: requireSessionID(input) })
    return [{ type: "result", subtype: "interrupted", sessionId: requireSessionID(input) }]
  }
  if (type === "approve" || type === "approve_always" || type === "reject") {
    const sessionID = requireSessionID(input)
    if (type === "reject") {
      await idempotentResolution(() =>
        operations.reject({
          session_id: sessionID,
          request_id: string(input.id) ?? "",
          message: string(input.message),
        }),
      )
    } else {
      await idempotentResolution(() =>
        operations.permissionReply({
          session_id: sessionID,
          request_id: string(input.id) ?? "",
          reply: type === "approve_always" ? "always" : "once",
        }),
      )
    }
    return [{ type: "permission_resolved", toolUseId: string(input.id) ?? "", sessionId: sessionID }]
  }
  if (type === "answer") {
    const sessionID = requireSessionID(input)
    await idempotentResolution(() =>
      operations.questionReply({
        session_id: sessionID,
        request_id: string(input.toolUseId) ?? "",
        answers: bridgeQuestionAnswers(input.result),
      }),
    )
    return [{ type: "permission_resolved", toolUseId: string(input.toolUseId) ?? "", sessionId: sessionID }]
  }

  // 白名单之外的旧 Bridge 命令只能返回错误，绝不尝试猜测或执行相邻功能。
  throw new ProtocolError("unsupported_message", type)
}

export async function dispatchRemotePayload(
  payload: unknown,
  operations: RemoteOperations,
  context: RemoteDispatchContext = {},
) {
  const input = object(payload)
  const type = string(input?.type)
  if (!input || !type) throw new ProtocolError("INVALID_REQUEST", "Payload type is required")

  if (type === "bridge.client_message") {
    return (await dispatchBridgeMessage(input.message, operations, context)).map((message) => ({
      type: "bridge.server_message",
      message,
    }))
  }
  if (type === "session.list") return [{ type: "ack", data: await operations.listSessions() }]
  if (type === "session.history") {
    return [
      {
        type: "ack",
        data: await operations.history({
          session_id: string(input.session_id) ?? "",
          cursor: number(input.cursor),
          limit: number(input.limit),
        }),
      },
    ]
  }
  if (type === "session.send") {
    const requestID = string(input.request_id)
    // 原生 Relay 调用与 Bridge 适配调用复用同一附件校验，不能让备用入口绕过数量、MIME 或摘要门禁。
    const parsed = remoteInputAttachments(input.images, input.attachments)
    return [
      {
        type: "ack",
        data: await operations.send({
          session_id: string(input.session_id) ?? "",
          text: string(input.text) ?? "",
          ...(parsed.images.length > 0 ? { images: parsed.images } : {}),
          ...(parsed.attachments.length > 0 ? { attachments: parsed.attachments } : {}),
          ...(string(input.client_message_id) ? { client_message_id: string(input.client_message_id) } : {}),
          ...(requestID ? { request_id: JSON.stringify([context.request_scope ?? "native", requestID]) } : {}),
        }),
      },
    ]
  }
  if (type === "session.create") {
    const model = requestedCreateModel(input)
    const permissionMode = requestedPermissionMode(input)
    return [
      {
        type: "ack",
        data: await operations.create({
          directory: string(input.directory) ?? "",
          title: string(input.title),
          request_id: string(input.request_id)
            ? JSON.stringify([context.request_scope ?? "native", string(input.request_id)])
            : undefined,
          ...(model.model_id ? { model_id: model.model_id } : {}),
          ...(model.variant !== undefined ? { variant: model.variant } : {}),
          ...(permissionMode ? { permission_mode: permissionMode } : {}),
        }),
      },
    ]
  }
  if (type === "session.model.set" || type === "set_codex_model") {
    const modelID = string(input.model) ?? string(input.model_id)
    if (!modelID) throw new ProtocolError("set_codex_model_rejected", "Model is required")
    const hasVariant =
      Object.prototype.hasOwnProperty.call(input, "model_reasoning_effort") ||
      Object.prototype.hasOwnProperty.call(input, "modelReasoningEffort")
    const rawVariant = Object.prototype.hasOwnProperty.call(input, "model_reasoning_effort")
      ? input.model_reasoning_effort
      : input.modelReasoningEffort
    // native snake/camel 两种别名都只接受非空字符串或 null，拒绝后不得调用 operations。
    if (hasVariant && rawVariant !== null && (typeof rawVariant !== "string" || rawVariant.length === 0)) {
      throw new ProtocolError("set_codex_model_rejected", "model_reasoning_effort must be a non-empty string or null")
    }
    return [
      {
        type: "ack",
        data: await operations.setModel({
          session_id: string(input.session_id) ?? string(input.sessionId) ?? "",
          model_id: modelID,
          ...(hasVariant ? { variant: rawVariant as string | null } : {}),
        }),
      },
    ]
  }
  if (type === "session.permission_mode.set" || type === "set_permission_mode") {
    return [
      {
        type: "ack",
        data: await operations.setPermissionMode({
          session_id: string(input.session_id) ?? string(input.sessionId) ?? "",
          mode: requiredPermissionMode(input),
        }),
      },
    ]
  }
  if (type === "session.abort") {
    await operations.abort({ session_id: string(input.session_id) ?? "" })
    return [{ type: "ack" }]
  }
  if (type === "permission.reply") {
    await operations.permissionReply({
      session_id: string(input.session_id) ?? "",
      request_id: string(input.permission_id) ?? string(input.request_id) ?? "",
      reply: input.reply === "always" ? "always" : input.reply === "reject" ? "reject" : "once",
      message: string(input.message),
    })
    return [{ type: "ack" }]
  }
  if (type === "question.reply") {
    const answers = Array.isArray(input.answers)
      ? input.answers.map((answer) =>
          Array.isArray(answer) ? answer.filter((item): item is string => typeof item === "string") : [],
        )
      : []
    await operations.questionReply({
      session_id: string(input.session_id) ?? "",
      request_id: string(input.question_id) ?? string(input.request_id) ?? "",
      answers,
    })
    return [{ type: "ack" }]
  }
  if (type === "question.reject") {
    await operations.questionReject({
      session_id: string(input.session_id) ?? "",
      request_id: string(input.question_id) ?? string(input.request_id) ?? "",
    })
    return [{ type: "ack" }]
  }
  if (type === "sync.snapshot") return [{ type: "sync.snapshot", data: await operations.snapshot() }]
  throw new ProtocolError("UNSUPPORTED_MESSAGE", `Unsupported remote message: ${type}`)
}

export function protocolError(error: unknown): RemoteProtocolError {
  if (error instanceof ProtocolError) return { code: error.code, message: error.message }
  if (error instanceof Error) return { code: "INTERNAL_ERROR", message: error.message }
  return { code: "INTERNAL_ERROR", message: String(error) }
}

function bridgeErrorMessage(value: unknown) {
  if (typeof value === "string") return value
  if (value === undefined || value === null) return "Session failed"
  const info = object(value)
  return string(info?.message) ?? string(object(info?.data)?.message) ?? JSON.stringify(value)
}

export function bridgeEvent(
  event: { directory?: string; payload?: unknown },
  partType?: "text" | "reasoning",
  turnId?: string,
): BridgeServerMessage[] {
  const payload = object(event.payload)
  const properties = object(payload?.properties)
  const type = string(payload?.type)
  if (!type || !properties) return []
  const sessionID = eventSessionID(event)

  if (type === "message.part.delta") {
    const field = string(properties.field)
    const delta = string(properties.delta)
    if (!delta) return []
    if (!sessionID) return []
    return [
      {
        type: partType === "reasoning" || field === "reasoning" ? "thinking_delta" : "stream_delta",
        text: delta,
        sessionId: sessionID,
        ...(turnId ? { turnId } : {}),
      },
    ]
  }
  if (type === "session.error") {
    if (!sessionID) return []
    const error = object(properties.error)
    return [
      {
        type: "error",
        message: bridgeErrorMessage(properties.error),
        errorCode: string(error?.name) ?? string(error?.code) ?? "SESSION_ERROR",
        sessionId: sessionID,
        ...(turnId ? { turnId } : {}),
      },
    ]
  }
  if (type === "session.status") {
    if (!sessionID) return []
    const status = object(properties.status)?.type
    return [
      {
        type: "status",
        status: status === "busy" || status === "retry" ? "running" : "idle",
        sessionId: sessionID,
      },
    ]
  }
  if (type === "permission.asked") {
    if (!sessionID) return []
    return [
      {
        type: "permission_request",
        requestKind: "permission",
        toolUseId: string(properties.id) ?? "",
        toolName: string(properties.permission) ?? "Permission",
        input: {
          patterns: Array.isArray(properties.patterns) ? properties.patterns : [],
          metadata: object(properties.metadata) ?? {},
          availableDecisions: ["accept", "acceptForSession", "decline"],
        },
        sessionId: sessionID,
        ...(turnId ? { turnId } : {}),
      },
    ]
  }
  if (type === "permission.replied") {
    if (!sessionID) return []
    return [
      {
        type: "permission_resolved",
        requestKind: "permission",
        toolUseId: string(properties.requestID) ?? "",
        sessionId: sessionID,
        ...(turnId ? { turnId } : {}),
      },
    ]
  }
  if (type === "question.asked") {
    if (!sessionID) return []
    const questions = Array.isArray(properties.questions) ? properties.questions : []
    return [
      {
        type: "permission_request",
        requestKind: "question",
        toolUseId: string(properties.id) ?? "",
        toolName: "AskUserQuestion",
        input: {
          questions: bridgeQuestions(questions),
        },
        sessionId: sessionID,
        ...(turnId ? { turnId } : {}),
      },
    ]
  }
  if (type === "question.replied" || type === "question.rejected") {
    if (!sessionID) return []
    return [
      {
        type: "permission_resolved",
        requestKind: "question",
        toolUseId: string(properties.requestID) ?? "",
        sessionId: sessionID,
        ...(turnId ? { turnId } : {}),
      },
    ]
  }
  return []
}

// GlobalBus 各事件的 sessionID 所在层级不同，统一提取后再允许发送 ccpocket 实时消息。
export function eventSessionID(event: { payload?: unknown }) {
  const properties = object(object(event.payload)?.properties)
  return (
    string(properties?.sessionID) ??
    string(object(properties?.info)?.sessionID) ??
    string(object(properties?.part)?.sessionID)
  )
}
