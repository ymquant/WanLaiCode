import { Auth } from "@/auth"
import * as InstanceState from "@/effect/instance-state"
import { NetProxy } from "@/net/proxy"
import { ModelID, ProviderID } from "@/provider/schema"
import * as WanlaiCodeAuth from "@/provider/wanlaicode"
import { WanlaiCodeRefreshCoordinator } from "@/provider/wanlaicode-refresh-coordinator"
import * as MessageV2 from "@/session/message-v2"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import type { ErrorMessageMap } from "@opencode-ai/core/error/message-map"
import { readableErrorMessage } from "@opencode-ai/core/error/localize-message"
import { Context, Effect, Layer, Option } from "effect"
import { Buffer } from "node:buffer"
import { readFile, writeFile } from "fs/promises"
import path from "path"
import { fileURLToPath } from "url"
import {
  ImageGenerationPlanAccessError,
  imageGenerationAllowed,
  imageGenerationPurchaseAccess,
  imageGenerationSupportedPlans,
  imageGenerationUpgradePlans,
  selectImageGenerationEntitlement,
} from "./wanlaicode-image-generation-plan"

const productCode = "wanlaicode"
const proxyFetch = NetProxy.create("WanlaiCode.imageGeneration")
export const maxImageGenerationCount = 8

// 自然语言生图没有客户端图片配置时也必须使用产品要求的统一套餐提示，避免回退到旧的账号组文案或网关英文。
export function imageGenerationGroupDisabledText(language: string | undefined) {
  const normalized = language?.toLowerCase() ?? ""
  if (normalized.includes("hant") || normalized.includes("tw") || normalized.includes("hk")) {
    return "目前套餐不支援圖片生成"
  }
  if (normalized.startsWith("zh")) return "当前套餐不支持生图"
  return "Your current plan does not support image generation."
}

type BackendEnvelope<T> = {
  code?: number
  message?: string
  reason?: string
  data?: T
}

type QueryValue = string | number | boolean | undefined

type BackendRequestInput = {
  accessToken: string
  path: string
  method?: "GET" | "POST"
  query?: Record<string, QueryValue>
  body?: Record<string, unknown>
}

type ImageGenerationPurchaseSettings = {
  purchase_subscription_enabled?: boolean
  purchase_subscription_url?: string
}

export type ImageAttachmentInput = {
  data_url: string
  mime?: string
  filename?: string
}

export type ImageGenerateInput = {
  session_id?: string
  message_id?: string
  prompt: string
  context_text?: string
  model: string
  provider_id?: string
  selected_model?: string
  selected_provider_id?: string
  agent?: string
  count?: number
  size?: string
  quality?: "auto" | "low" | "medium" | "high"
  output_format?: "png" | "jpeg" | "webp"
  moderation?: "auto" | "low"
  loading_text?: string
  failure_prefix?: string
  error_messages?: ErrorMessageMap
  output_directory?: string
  input_images?: readonly ImageAttachmentInput[]
  parts?: readonly (MessageV2.TextPartInput | MessageV2.FilePartInput | MessageV2.AgentPartInput)[]
}

export type GeneratedImage = {
  url: string
  mime: string
  filename: string
  revised_prompt?: string
}

export type ImageGenerationProgress = {
  image: GeneratedImage
  index: number
  total: number
}

type ImageGenerationStart =
  | {
      sessionID: SessionID
      assistantMessage: MessageV2.Assistant
      loadingTextPartID: PartID
      loadingImagePartIDs: PartID[]
      emittedImageIndexes: Set<number>
      failurePrefix: string
      errorMessages?: ErrorMessageMap
    }
  | undefined

export type ImageGenerateResult = {
  images: GeneratedImage[]
  message_id?: string
}

export interface Interface {
  readonly generate: (
    payload: ImageGenerateInput,
    onImage?: (progress: ImageGenerationProgress) => Effect.Effect<void>,
  ) => Effect.Effect<ImageGenerateResult, unknown>
  readonly generateIntoSession: (
    payload: ImageGenerateInput,
  ) => Effect.Effect<ImageGenerateResult, unknown, Session.Service | SessionStatus.Service>
}

type ImageGenerationApiInput = {
  apiKey: string
  payload: ImageGenerateInput
  onImage?: (progress: ImageGenerationProgress) => Promise<void> | void
}

export class Service extends Context.Service<Service, Interface>()("@opencode/WanlaiCodeImageGeneration") {}

const generatedImageExtension = (mime: string, filename?: string) => {
  const ext = filename?.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase()
  if (ext) return ext
  if (mime === "image/jpeg") return "jpg"
  if (mime === "image/webp") return "webp"
  if (mime === "image/gif") return "gif"
  return "png"
}

const generatedImageBuffer = (image: Pick<GeneratedImage, "url" | "mime">) =>
  Effect.promise(async () => {
    if (image.url.startsWith("data:")) {
      const comma = image.url.indexOf(",")
      if (comma === -1) throw new Error("Invalid image data URL")
      return Buffer.from(image.url.slice(comma + 1), image.url.slice(0, comma).includes(";base64") ? "base64" : "utf8")
    }
    const response = await proxyFetch(image.url, { cache: "no-store" })
    if (!response.ok) throw new Error(`Failed to download generated image: ${response.status}`)
    return Buffer.from(await response.arrayBuffer())
  })

export const saveGeneratedImage = (
  image: GeneratedImage,
  input: { directory?: string; index: number },
): Effect.Effect<GeneratedImage> => {
  const directory = input.directory
  if (!directory?.trim()) return Effect.succeed(image)
  return Effect.gen(function* () {
    const now = new Date()
    const stamp = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, "0"),
      String(now.getDate()).padStart(2, "0"),
      "-",
      String(now.getHours()).padStart(2, "0"),
      String(now.getMinutes()).padStart(2, "0"),
      String(now.getSeconds()).padStart(2, "0"),
      "-",
      String(now.getMilliseconds()).padStart(3, "0"),
    ].join("")
    const filename = `wanlai-image-${stamp}-${input.index}-${crypto.randomUUID().slice(0, 8)}.${generatedImageExtension(image.mime, image.filename)}`
    const filepath = path.join(directory, filename)
    const buffer = yield* generatedImageBuffer(image)
    yield* Effect.promise(() => writeFile(filepath, buffer))
    return {
      ...image,
      filename,
      // 聊天 WebView 的 CSP/安全策略不会稳定放行 file:// 图片；消息里保留可直接渲染的 data URL，
      // 实体文件仍按 filename 保存到当前工作目录，供文件树和用户后续引用。
      url: `data:${image.mime};base64,${buffer.toString("base64")}`,
    }
  }).pipe(
    // 本地落盘失败不能吞掉已经生成的图片；继续使用原始 URL 展示。
    Effect.catch(() => Effect.succeed(image)),
  )
}

class WanlaiCodeBackendError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly reason?: string,
  ) {
    super(message)
  }
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
}

function stringField(input: Record<string, unknown>, key: string) {
  const value = input[key]
  return typeof value === "string" ? value : undefined
}

function nonEmptyString(input: string | undefined) {
  const value = input?.trim()
  if (!value) return undefined
  return value
}

// 短追问转图片时，上一条 assistant 文本必须压过更早的生图历史，避免把旧图主题串进新图片。
function previousAssistantAnswerSource(context: string | undefined) {
  if (!context?.includes("immediate_previous_assistant_answer:")) return undefined
  return [
    "Previous assistant answer rendering instruction:",
    "The immediate_previous_assistant_answer block is the authoritative source of what to render.",
    "Create a readable information card, document card, worksheet, checklist, table card, or other text-first layout that preserves the answer content and structure.",
    "Do not turn nouns, characters, animals, scenery, products, or examples mentioned inside the answer into the main illustration unless the latest user explicitly asks for an illustration of those things.",
    "Avoid using older conversation images, older generated-image prompts, or prior visual themes as the subject.",
  ].join("\n")
}

function backendErrorReason(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined
  const reason = body.reason
  return typeof reason === "string" && reason ? reason : undefined
}

async function unwrapBackendResponse<T>(response: Response) {
  const text = await response.text()
  const body = (text ? JSON.parse(text) : {}) as BackendEnvelope<T>
  if (!response.ok) {
    throw new WanlaiCodeBackendError(
      response.status,
      body.message ?? `Wanlai API request failed: ${response.status}`,
      backendErrorReason(body),
    )
  }
  if (typeof body.code === "number" && body.code !== 0) {
    throw new WanlaiCodeBackendError(body.code, body.message ?? "Wanlai API request failed", backendErrorReason(body))
  }
  return body.data as T
}

function backendRequest<T>(input: BackendRequestInput) {
  return Effect.tryPromise({
    try: async () => {
      const config = WanlaiCodeAuth.resolveConfig()
      const url = new URL(`/api/v1${input.path}`, config.relayRoot)
      Object.entries(input.query ?? {})
        .filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined && entry[1] !== "")
        .forEach((entry) => url.searchParams.set(entry[0], String(entry[1])))

      return await unwrapBackendResponse<T>(
        await proxyFetch(url, {
          method: input.method ?? "GET",
          headers: {
            Authorization: `Bearer ${input.accessToken}`,
            ...(input.body ? { "Content-Type": "application/json" } : {}),
          },
          body: input.body ? JSON.stringify(input.body) : undefined,
        }),
      )
    },
    catch: (cause) => cause,
  })
}

// 门禁拒绝后的购买推荐沿用用户中心同一个公开配置端点，确保全局购买开关与真实 pay 地址一致。
function imageGenerationPurchaseSettings() {
  return Effect.tryPromise({
    try: async () => {
      const url = new URL(WanlaiCodeAuth.resolveConfig().endpoints.purchaseSettings)
      url.searchParams.set("_t", String(Date.now()))
      return await unwrapBackendResponse<ImageGenerationPurchaseSettings>(await proxyFetch(url))
    },
    catch: (cause) => cause,
  })
}

// 套餐列表沿用用户中心的真实购买链：OAuth 登录时携带同一 access token，让 pay 继续按账号应用
// 可购买规则；API Key 登录没有用户 access token，只读取公开列表。token 仅用于本次请求，不进入消息 metadata。
function imageGenerationStorefrontPlans(input: { purchaseUrl: string; accessToken?: string }) {
  return Effect.tryPromise({
    try: async () => {
      const url = new URL(input.purchaseUrl)
      url.pathname = "/api/subscription-plans"
      url.search = ""
      url.hash = ""
      if (input.accessToken) url.searchParams.set("token", input.accessToken)
      const response = await proxyFetch(url)
      if (!response.ok) throw new Error(`Wanlai purchase plans request failed: ${response.status}`)
      const payload: unknown = await response.json()
      return isRecord(payload) && Array.isArray(payload.plans) ? payload.plans : []
    },
    catch: (cause) => cause,
  })
}

function imageFormat(format: ImageGenerateInput["output_format"] | undefined) {
  return format ?? "png"
}

function imageMime(format: ImageGenerateInput["output_format"] | undefined) {
  if (format === "jpeg") return "image/jpeg"
  if (format === "webp") return "image/webp"
  return "image/png"
}

export function imageGenerationPrompt(
  input: {
    prompt: string
    context_text?: string
    input_images?: readonly ImageAttachmentInput[]
  },
  batch?: { index: number; total: number },
) {
  const prompt = input.prompt.trim()
  const context = input.context_text?.trim()
  const editing = (input.input_images?.length ?? 0) > 0
  const batchInstruction =
    batch && batch.total > 1
      ? [
          "Batch output instruction:",
          `This API request is image ${batch.index} of ${batch.total}. The batch count is handled by separate output files, not by drawing multiple images inside one canvas.`,
          "Create exactly one complete standalone image in this file.",
          "Do not create a collage, triptych, multi-panel layout, storyboard, contact sheet, grid, split screen, or multiple variants inside the same image.",
          "If the user asked for multiple images, styles, or options, choose one distinct variant for this file only.",
        ].join("\n")
      : undefined
  if (!context) return [prompt, batchInstruction].filter(Boolean).join("\n\n")
  // 图片模型不直接看到整段对话时，用上下文补足“画什么”和“怎么改”。
  return [
    editing
      ? "You are editing the provided input image(s) for an ongoing chat session."
      : "You are generating an image for an ongoing chat session.",
    editing
      ? "The provided input image(s) are the primary source of visual truth. Preserve their main content/layout unless the user explicitly asks to change it."
      : "Use the session context below to decide the subject and content of the image.",
    editing
      ? "Use the session context only to understand the requested edit and style constraints; do not replace the uploaded image with older chat content."
      : "If the user's request is brief or generic, infer what to draw from this context rather than producing an unrelated image.",
    previousAssistantAnswerSource(context),
    "",
    "Session context:",
    context,
    "",
    `User image request: ${prompt}`,
    ...(batchInstruction ? ["", batchInstruction] : []),
  ].join("\n")
}

export function imageRequestPayload(input: ImageGenerateInput, batch?: { index: number; total: number }) {
  return {
    model: input.model,
    prompt: imageGenerationPrompt(input, batch),
    ...(input.size ? { size: input.size } : {}),
    ...(input.quality ? { quality: input.quality } : {}),
    ...(input.output_format ? { output_format: input.output_format } : {}),
    ...(input.moderation ? { moderation: input.moderation } : {}),
  }
}

export function imageCount(count: number | undefined) {
  if (!count || !Number.isFinite(count)) return 1
  return Math.min(maxImageGenerationCount, Math.max(1, Math.floor(count)))
}

function imageLoadingUrl(size: string | undefined) {
  const match = size?.match(/^(\d+)\s*[xX×]\s*(\d+)$/)
  const width = match ? Number(match[1]) : 1024
  const height = match ? Number(match[2]) : 1024
  const ratio = Math.min(1.8, Math.max(0.55, width / height))
  const viewWidth = ratio >= 1 ? 1024 : Math.round(1024 * ratio)
  const viewHeight = ratio >= 1 ? Math.round(1024 / ratio) : 1024
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${viewWidth} ${viewHeight}">
  <defs>
    <pattern id="dots" width="24" height="24" patternUnits="userSpaceOnUse">
      <circle cx="2" cy="2" r="1.4" fill="rgba(255,255,255,.22)"/>
    </pattern>
    <linearGradient id="shine" x1="0" x2="1">
      <stop offset="0" stop-color="rgba(255,255,255,0)"/>
      <stop offset=".5" stop-color="rgba(255,255,255,.16)"/>
      <stop offset="1" stop-color="rgba(255,255,255,0)"/>
      <animateTransform attributeName="gradientTransform" type="translate" values="-1 0;1 0" dur="1.8s" repeatCount="indefinite"/>
    </linearGradient>
  </defs>
  <rect width="100%" height="100%" rx="56" fill="#2f2f2f"/>
  <rect width="100%" height="100%" rx="56" fill="url(#dots)"/>
  <rect width="100%" height="100%" rx="56" fill="url(#shine)"/>
</svg>`
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`
}

function imageEndpoint(pathname: string) {
  const url = new URL(WanlaiCodeAuth.resolveConfig().apiBase)
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/${pathname.replace(/^\/+/, "")}`
  return url.toString()
}

function parseJsonObject(text: string) {
  if (!text.trim()) return undefined
  try {
    const parsed = JSON.parse(text)
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

export function imageErrorDetails(text: string) {
  const body = parseJsonObject(text)
  if (!body) return { message: nonEmptyString(text) }
  const nested = isRecord(body.error) ? body.error : undefined
  const fallbackMessage = typeof body.error === "string" ? body.error : undefined
  return {
    message:
      nonEmptyString(stringField(nested ?? body, "message")) ??
      nonEmptyString(fallbackMessage) ??
      nonEmptyString(stringField(body, "message")),
    reason:
      nonEmptyString(stringField(nested ?? body, "type")) ??
      nonEmptyString(stringField(nested ?? body, "reason")) ??
      nonEmptyString(stringField(nested ?? body, "code")) ??
      nonEmptyString(stringField(body, "reason")),
  }
}

function imageResponseError(response: Response, text: string) {
  const details = imageErrorDetails(text)
  return new WanlaiCodeBackendError(
    response.status,
    details.message ?? response.statusText ?? `WanlaiCode image request failed: ${response.status}`,
    details.reason,
  )
}

async function readImageResponse(response: Response) {
  const text = await response.text()
  if (!response.ok) throw imageResponseError(response, text)
  return parseJsonObject(text) ?? {}
}

const privateReferenceImageHosts = [
  /^localhost$/i,
  /\.localhost$/i,
  /\.local$/i,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^0\./,
  /^\[::1\]$/i,
  /^\[fc/i,
  /^\[fd/i,
  /^\[fe80:/i,
]

function assertReferenceImageUrl(value: string) {
  if (value.startsWith("data:")) return
  const url = new URL(value)
  if (url.protocol === "file:") return
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Reference image must be a data or HTTP(S) URL")
  }
  if (privateReferenceImageHosts.some((pattern) => pattern.test(url.hostname))) {
    throw new Error("Reference image URL cannot target local or private network hosts")
  }
}

export async function imageBlob(input: ImageAttachmentInput) {
  assertReferenceImageUrl(input.data_url)
  if (input.data_url.startsWith("file:")) {
    const filepath = fileURLToPath(input.data_url)
    const buffer = await readFile(filepath)
    return new File([new Uint8Array(buffer)], input.filename || path.basename(filepath), {
      type: input.mime || "image/png",
    })
  }
  const response = await proxyFetch(input.data_url, { redirect: "manual" })
  if (response.status >= 300 && response.status < 400) {
    throw new Error("Reference image URL redirects are not allowed")
  }
  if (!response.ok) throw imageResponseError(response, await response.text())
  const blob = await response.blob()
  return new File([blob], input.filename || "reference.png", { type: input.mime || blob.type || "image/png" })
}

async function imagePayloadImages(payload: Record<string, unknown>, format: ImageGenerateInput["output_format"]) {
  const fallbackMime = imageMime(format)
  const data = Array.isArray(payload.data) ? payload.data : []
  return (
    await Promise.all(
      data.map(async (item, index) => {
        if (!isRecord(item)) return undefined
        const b64 = typeof item.b64_json === "string" ? item.b64_json : undefined
        const rawUrl = typeof item.url === "string" ? item.url : undefined
        const revisedPrompt = typeof item.revised_prompt === "string" ? item.revised_prompt : undefined
        const url = b64 ? `data:${fallbackMime};base64,${b64}` : rawUrl
        if (!url) return undefined
        return {
          url,
          mime: url.startsWith("data:") ? (url.match(/^data:([^;,]+)/)?.[1] ?? fallbackMime) : fallbackMime,
          filename: `wanlai-image-${index + 1}.${imageFormat(format)}`,
          ...(revisedPrompt ? { revised_prompt: revisedPrompt } : {}),
        } satisfies GeneratedImage
      }),
    )
  ).filter((item): item is GeneratedImage => !!item)
}

function retryableImageError(cause: unknown) {
  return (
    (cause instanceof WanlaiCodeBackendError && [502, 503, 504].includes(cause.status)) ||
    /upstream_error|upstream request failed/i.test(errorMessage(cause))
  )
}

async function requestSingleImageGenerationApi(input: {
  apiKey: string
  payload: ImageGenerateInput
  batch?: { index: number; total: number }
}) {
  const format = imageFormat(input.payload.output_format)
  const images = input.payload.input_images ?? []
  const common = imageRequestPayload(input.payload, input.batch)
  const response =
    images.length > 0
      ? await proxyFetch(imageEndpoint("/images/edits"), {
          method: "POST",
          cache: "no-store",
          headers: { ...WanlaiCodeAuth.softwareHeaders(), Authorization: `Bearer ${input.apiKey}` },
          body: await Promise.all(images.map(imageBlob)).then((files) => {
            const form = new FormData()
            Object.entries(common).forEach(([key, value]) => form.set(key, value))
            files.forEach((file) => form.append("image[]", file))
            return form
          }),
        })
      : await proxyFetch(imageEndpoint("/images/generations"), {
          method: "POST",
          cache: "no-store",
          headers: {
            ...WanlaiCodeAuth.softwareHeaders(),
            Authorization: `Bearer ${input.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(common),
        })
  return await imagePayloadImages(await readImageResponse(response), format)
}

async function callSingleImageGenerationApi(input: {
  apiKey: string
  payload: ImageGenerateInput
  batch?: { index: number; total: number }
}) {
  return requestSingleImageGenerationApi(input).catch((cause) => {
    if (!retryableImageError(cause)) throw cause
    return requestSingleImageGenerationApi(input)
  })
}

function numberedImage(input: { image: GeneratedImage; index: number; format: ImageGenerateInput["output_format"] }) {
  return {
    ...input.image,
    filename: `wanlai-image-${input.index}.${imageFormat(input.format)}`,
  }
}

export async function callImageGenerationApi(input: ImageGenerationApiInput) {
  const count = imageCount(input.payload.count)
  if (count === 1) {
    const images = (await callSingleImageGenerationApi(input)).slice(0, 1)
    if (images[0]) await input.onImage?.({ image: images[0], index: 1, total: 1 })
    return images
  }

  const images: GeneratedImage[] = []
  for (const index of Array.from({ length: count }).keys()) {
    // 多图生成按用户维度串行请求，避免一次性占满后端/上游并发槽。
    const image = (await callSingleImageGenerationApi({ ...input, batch: { index: index + 1, total: count } }))[0]
    if (!image) continue
    const normalized = numberedImage({ image, index: index + 1, format: input.payload.output_format })
    await input.onImage?.({ image: normalized, index: index + 1, total: count })
    images.push(normalized)
  }
  if (images.length === count) return images

  throw new Error(`WanlaiCode image response included ${images.length} images, expected ${count}`)
}

export function errorMessage(cause: unknown) {
  const seen = new WeakSet<object>()
  const read = (input: unknown): string | undefined => {
    if (input instanceof Error && input.message && input.message !== "[object Object]") return input.message
    if (typeof input === "string" && input && input !== "[object Object]") return input
    if (typeof input !== "object" || input === null || seen.has(input)) return undefined
    seen.add(input)

    if ("data" in input) {
      const message = read((input as { data?: unknown }).data)
      if (message) return message
    }
    if ("error" in input) {
      const message = read((input as { error?: unknown }).error)
      if (message) return message
    }
    if ("message" in input) {
      const message = read((input as { message?: unknown }).message)
      if (message) return message
    }
    if ("cause" in input) {
      const message = read((input as { cause?: unknown }).cause)
      if (message) return message
    }

    try {
      const json = JSON.stringify(input)
      return json && json !== "{}" ? json : undefined
    } catch {
      return undefined
    }
  }
  return read(cause) ?? String(cause)
}

export function readableImageGenerationError(cause: unknown) {
  const message = errorMessage(cause).trim()
  return readableImageGenerationErrorWithMessages(cause, { group_disabled: message })
}

export function readableImageGenerationErrorWithMessages(cause: unknown, messages: ErrorMessageMap | undefined) {
  return readableErrorMessage(cause, messages)
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const auth = yield* Auth.Service

    const oauthAccessToken = Effect.fn("WanlaiCodeImageGeneration.oauthAccessToken")(function* (options?: {
      force?: boolean
    }) {
      const info = yield* auth.get("wanlaicode")
      if (!info) return yield* Effect.fail(new Error("WanlaiCode is not connected"))
      if (info.type !== "oauth") return yield* Effect.fail(new Error("WanlaiCode OAuth login is required"))
      if (WanlaiCodeRefreshCoordinator.isCredentialInvalid(info)) {
        return yield* Effect.fail(WanlaiCodeAuth.oauthExpiredError("oauth credential revision is invalid"))
      }

      const now = Math.floor(Date.now() / 1000)
      // 图片生成与用户中心、远控、定时器共用同一 single-flight；任何入口都不能单独消费轮换型 refresh token。
      if (!options?.force && info.softwareToken && info.expires > now + 30) return info.softwareToken
      const refreshed = yield* Effect.tryPromise({
        try: () =>
          WanlaiCodeRefreshCoordinator.refresh({
            reason: options?.force ? "image-generation-401" : "image-generation",
            // 使用当前 Effect layer 的认证服务，保证测试实例与生产 AppRuntime 都读写同一份凭据。
            auth,
          }),
        catch: (cause) => cause,
      })
      return refreshed.softwareToken
    })

    const currentAuth = Effect.fn("WanlaiCodeImageGeneration.currentAuth")(function* () {
      const info = yield* auth.get("wanlaicode")
      if (!info) return yield* Effect.fail(new Error("WanlaiCode is not connected"))
      return info
    })

    const backendRequestWithOAuthSession = <T>(input: Omit<BackendRequestInput, "accessToken">) =>
      Effect.gen(function* () {
        const request = (accessToken: string) =>
          backendRequest<T>({ ...input, accessToken }).pipe(Effect.map((data) => ({ accessToken, data })))
        return yield* request(yield* oauthAccessToken()).pipe(
          Effect.catch((cause: unknown) => {
            if (!(cause instanceof WanlaiCodeBackendError) || cause.status !== 401) return Effect.fail(cause)
            return Effect.gen(function* () {
              return yield* request(yield* oauthAccessToken({ force: true }))
            })
          }),
        )
      })

    const backendRequestWithOAuthRaw = <T>(input: Omit<BackendRequestInput, "accessToken">) =>
      backendRequestWithOAuthSession<T>(input).pipe(Effect.map((result) => result.data))

    const backendRequestWithOAuth = <T>(input: Omit<BackendRequestInput, "accessToken">) =>
      backendRequestWithOAuthSession<T>(input).pipe(Effect.map((result) => result.data))

    // OAuth 权益走软件后端，API Key 权益走现有 profile 校验；两条路径最终都只认真实
    // allow_image_generation===true，避免用模型可见性或前端状态猜测后台套餐能力。
    const imageGenerationEntitlement = Effect.fn("WanlaiCodeImageGeneration.entitlement")(function* () {
      const info = yield* currentAuth()
      if (info.type === "api") {
        const profile = yield* WanlaiCodeAuth.validateApiKey({ apiKey: info.key })
        return { entitlement: selectImageGenerationEntitlement([profile.entitlement]), accessToken: undefined }
      }
      if (info.type !== "oauth") return { entitlement: undefined, accessToken: undefined }
      const result = yield* backendRequestWithOAuthSession<{ items?: unknown[] }>({ path: "/software/entitlements" })
      return {
        entitlement: selectImageGenerationEntitlement(result.data.items ?? []),
        accessToken: result.accessToken,
      }
    })

    // 只有门禁拒绝时才访问购买服务；购买开关与套餐目录分别限时，目录失败时保留已取得的购买入口，
    // 不能放行生图，也不能因为附加推荐接口异常而丢掉明确的“不支持生图”提示。
    const ensureImageGenerationPlanAccess = Effect.fn("WanlaiCodeImageGeneration.planAccess")(function* () {
      const access = yield* imageGenerationEntitlement()
      if (imageGenerationAllowed(access.entitlement)) return

      const purchaseState = yield* Effect.gen(function* () {
        const settingsState = yield* imageGenerationPurchaseSettings().pipe(
          Effect.map((settings) => ({ settings, available: true })),
          // 设置接口失败时保留既有默认购买地址回退，但记录状态供无入口空态区分真实关闭与加载失败。
          Effect.catch(() => Effect.succeed({ settings: {} as ImageGenerationPurchaseSettings, available: false })),
        )
        // 后台显式关闭购买时不再请求备用 URL；关闭态必须立即生效，不能被静态 fallback 重新打开。
        const fallbackPurchaseUrl =
          settingsState.settings.purchase_subscription_enabled === false ||
          settingsState.settings.purchase_subscription_url
            ? ""
            : yield* WanlaiCodeAuth.getPurchaseUrl({})
        return {
          purchase: imageGenerationPurchaseAccess({
            purchaseSubscriptionEnabled: settingsState.settings.purchase_subscription_enabled,
            purchaseSubscriptionUrl: settingsState.settings.purchase_subscription_url,
            fallbackPurchaseUrl,
          }),
          // 设置接口异常时不能把默认地址推断为已开启；设置可用时沿用现有“显式 false 才关闭”的口径。
          purchaseEnabled: settingsState.available
            ? settingsState.settings.purchase_subscription_enabled === false
              ? false
              : true
            : undefined,
        }
      }).pipe(
        Effect.timeout("2 seconds"),
        Effect.catch(() =>
          Effect.succeed({ purchase: { enabled: false, purchaseUrl: "" }, purchaseEnabled: undefined }),
        ),
      )

      if (!purchaseState.purchase.enabled) {
        return yield* Effect.fail(
          new ImageGenerationPlanAccessError({
            purchaseUrl: "",
            purchaseEnabled: purchaseState.purchaseEnabled,
            supportedPlans: [],
            upgradePlans: [],
            // 购买未开启时没有请求套餐目录，不能伪装成已完成的空目录。
            planCatalogAvailable: false,
          }),
        )
      }

      const planState = yield* imageGenerationStorefrontPlans({
        purchaseUrl: purchaseState.purchase.purchaseUrl,
        accessToken: access.accessToken,
      }).pipe(
        Effect.timeout("2 seconds"),
        Effect.map((plans) => ({ plans, available: true })),
        Effect.catch(() => Effect.succeed({ plans: [] as unknown[], available: false })),
      )
      const recommendation = {
        purchaseUrl: purchaseState.purchase.purchaseUrl,
        purchaseEnabled: purchaseState.purchaseEnabled,
        supportedPlans: imageGenerationSupportedPlans(planState.plans),
        upgradePlans: imageGenerationUpgradePlans({ plans: planState.plans, entitlement: access.entitlement }),
        planCatalogAvailable: planState.available,
      }
      yield* Effect.fail(new ImageGenerationPlanAccessError(recommendation))
    })

    const apiKey = Effect.fn("WanlaiCodeImageGeneration.apiKey")(function* (selectedProductCode?: string) {
      const info = yield* currentAuth()
      if (info.type === "api") return info.key
      if (info.type !== "oauth") return yield* Effect.fail(new Error("WanlaiCode OAuth or API login is required"))

      const current = yield* Effect.gen(function* () {
        return yield* backendRequestWithOAuthRaw<{ raw_key?: string }>({
          path: "/software/api-keys/current",
          query: { product_code: selectedProductCode || productCode },
        })
      }).pipe(
        Effect.catch((cause: unknown) =>
          cause instanceof WanlaiCodeBackendError && cause.status === 404
            ? Effect.succeed({ raw_key: undefined as string | undefined })
            : Effect.fail(cause),
        ),
      )
      if (current.raw_key) return current.raw_key

      const created = yield* backendRequestWithOAuth<{ raw_key?: string }>({
        method: "POST",
        path: "/software/api-keys",
        body: {
          product_code: selectedProductCode || productCode,
          replace_existing: false,
        },
      })
      if (created.raw_key) return created.raw_key
      return yield* Effect.fail(new Error("WanlaiCode software API key is unavailable"))
    })

    const startImageResult = Effect.fn("WanlaiCodeImageGeneration.startImageResult")(function* (
      input: ImageGenerateInput,
    ) {
      if (!input.session_id) return undefined

      const sessions = yield* Session.Service
      const sessionID = SessionID.make(input.session_id)
      const session = yield* sessions.get(sessionID)
      const instance = yield* InstanceState.context
      const agent = input.agent || session.agent || "build"
      // assistant 归因使用真实图片模型，用户消息保留用户原先选择的普通模型。
      const providerID = ProviderID.make(input.provider_id || session.model?.providerID || "wanlaicode")
      const modelID = ModelID.make(input.model)
      const selectedProviderID = ProviderID.make(
        input.selected_provider_id || input.provider_id || session.model?.providerID || "wanlaicode",
      )
      const selectedModelID = ModelID.make(input.selected_model || input.model)
      const userMessageID = input.message_id ? MessageID.make(input.message_id) : MessageID.ascending()
      const existing = yield* sessions.findMessage(sessionID, (message) => message.info.id === userMessageID)
      // 外部直连可能复用已经落库的 steer 消息 ID；此时沿用其活动回合，不能改成消息自身的新回合。
      const turnID =
        Option.isSome(existing) && existing.value.info.role === "user"
          ? MessageV2.userTurnID(existing.value.info)
          : userMessageID
      const userMessage: MessageV2.User = {
        id: userMessageID,
        sessionID,
        role: "user",
        // 图片模型直连同样写入完整回合身份，用户消息与结果 assistant 共享上面解析出的稳定 turnID。
        turnID,
        time: { created: Date.now() },
        agent,
        model: {
          providerID: selectedProviderID,
          modelID: selectedModelID,
        },
      }
      const assistantMessage: MessageV2.Assistant = {
        id: MessageID.ascending(),
        sessionID,
        parentID: userMessage.id,
        role: "assistant",
        // 直连结果不经过主 runLoop，必须在这里显式补齐回合身份，避免刷新后图片结果被拆组。
        turnID: userMessage.turnID,
        time: { created: Date.now() },
        modelID,
        providerID,
        mode: agent,
        agent,
        path: {
          cwd: session.directory,
          root: instance.worktree,
        },
        cost: 0,
        tokens: {
          input: 0,
          output: 0,
          reasoning: 0,
          cache: {
            read: 0,
            write: 0,
          },
        },
      }
      const loadingTextPartID = PartID.ascending()
      const loadingImagePartIDs = Array.from({ length: imageCount(input.count) }).map(() => PartID.ascending())

      yield* sessions.updateMessage(userMessage)
      if (input.parts?.length) {
        yield* Effect.forEach(input.parts, (part) =>
          sessions.updatePart({
            ...part,
            id: part.id ? PartID.make(part.id) : PartID.ascending(),
            sessionID,
            messageID: userMessage.id,
          } as MessageV2.TextPart | MessageV2.FilePart | MessageV2.AgentPart),
        )
      } else {
        yield* sessions.updatePart({
          id: PartID.ascending(),
          sessionID,
          messageID: userMessage.id,
          type: "text",
          text: input.prompt,
        })
      }

      yield* sessions.updateMessage(assistantMessage)
      yield* sessions.updatePart({
        id: loadingTextPartID,
        sessionID,
        messageID: assistantMessage.id,
        type: "text",
        text: input.loading_text || "Generating a more detailed image. Please wait.",
      })
      yield* Effect.forEach(loadingImagePartIDs, (loadingImagePartID, index) =>
        sessions.updatePart({
          id: loadingImagePartID,
          sessionID,
          messageID: assistantMessage.id,
          type: "file" as const,
          mime: "image/svg+xml",
          filename: `wanlai-image-loading-${index + 1}.svg`,
          url: imageLoadingUrl(input.size),
        }),
      )
      yield* sessions.touch(sessionID).pipe(Effect.catch(() => Effect.void))
      return {
        sessionID,
        assistantMessage,
        loadingTextPartID,
        loadingImagePartIDs,
        emittedImageIndexes: new Set<number>(),
        failurePrefix: input.failure_prefix || "Image generation failed:",
        errorMessages: input.error_messages,
      }
    })

    const appendGeneratedImage = Effect.fn("WanlaiCodeImageGeneration.appendGeneratedImage")(function* (
      started: ImageGenerationStart,
      progress: ImageGenerationProgress,
    ) {
      if (!started || started.emittedImageIndexes.has(progress.index)) return

      const sessions = yield* Session.Service
      // 就地替换占位而不是删旧建新：part id 保持不变，前端组件实例得以存活，
      // 从而能把占位阶段按请求 size 算出的宽高比一路带到成图解码前，
      // 避免图片落地瞬间的高度突变把用户的阅读位置顶走。
      const loadingImagePartID = started.loadingImagePartIDs[progress.index - 1]
      yield* sessions.updatePart({
        id: loadingImagePartID ?? PartID.ascending(),
        sessionID: started.sessionID,
        messageID: started.assistantMessage.id,
        type: "file" as const,
        mime: progress.image.mime,
        filename: progress.image.filename,
        url: progress.image.url,
      })
      started.emittedImageIndexes.add(progress.index)
      yield* sessions.touch(started.sessionID).pipe(Effect.catch(() => Effect.void))
    })

    const completeImageResult = Effect.fn("WanlaiCodeImageGeneration.completeImageResult")(function* (
      started: ImageGenerationStart,
      images: GeneratedImage[],
    ) {
      if (!started) return undefined

      const sessions = yield* Session.Service
      yield* sessions
        .removePart({
          sessionID: started.sessionID,
          messageID: started.assistantMessage.id,
          partID: started.loadingTextPartID,
        })
        .pipe(Effect.catch(() => Effect.void))
      yield* Effect.forEach(started.loadingImagePartIDs, (loadingImagePartID, index) =>
        started.emittedImageIndexes.has(index + 1)
          ? Effect.void
          : sessions
              .removePart({
                sessionID: started.sessionID,
                messageID: started.assistantMessage.id,
                partID: loadingImagePartID,
              })
              .pipe(Effect.catch(() => Effect.void)),
      )
      yield* Effect.forEach(images, (image, index) =>
        started.emittedImageIndexes.has(index + 1)
          ? Effect.void
          : appendGeneratedImage(started, { image, index: index + 1, total: images.length }),
      )
      yield* sessions.updateMessage({
        ...started.assistantMessage,
        time: { ...started.assistantMessage.time, completed: Date.now() },
        finish: "stop",
      })
      yield* sessions.touch(started.sessionID).pipe(Effect.catch(() => Effect.void))
      return started.assistantMessage.id
    })

    const failImageResult = Effect.fn("WanlaiCodeImageGeneration.failImageResult")(function* (
      started: ImageGenerationStart,
      cause: unknown,
    ) {
      if (!started) return

      const sessions = yield* Session.Service
      yield* Effect.forEach(started.loadingImagePartIDs, (loadingImagePartID, index) =>
        started.emittedImageIndexes.has(index + 1)
          ? Effect.void
          : sessions
              .removePart({
                sessionID: started.sessionID,
                messageID: started.assistantMessage.id,
                partID: loadingImagePartID,
              })
              .pipe(Effect.catch(() => Effect.void)),
      )
      yield* sessions
        .updatePart({
          id: started.loadingTextPartID,
          sessionID: started.sessionID,
          messageID: started.assistantMessage.id,
          type: "text",
          text: `${started.failurePrefix} ${readableImageGenerationErrorWithMessages(cause, started.errorMessages)}`,
        })
        .pipe(Effect.catch(() => Effect.void))
      yield* sessions
        .updateMessage({
          ...started.assistantMessage,
          time: { ...started.assistantMessage.time, completed: Date.now() },
          finish: "error",
          error: {
            name: "UnknownError",
            data: {
              message: readableImageGenerationErrorWithMessages(cause, started.errorMessages),
            },
          },
        })
        .pipe(Effect.catch(() => Effect.void))
      // 独立图片接口绕过 SessionRunState，失败后也要主动广播 idle；
      // 否则前端乐观 busy 会一直残留到切换会话/整窗重载。
      yield* SessionStatus.Service.use((status) => status.set(started.sessionID, { type: "idle" })).pipe(
        Effect.catch(() => Effect.void),
      )
      yield* sessions.touch(started.sessionID).pipe(Effect.catch(() => Effect.void))
    })

    const generateWithKey = Effect.fn("WanlaiCodeImageGeneration.generateWithKey")(function* (
      payload: ImageGenerateInput,
      onImage?: ImageGenerationApiInput["onImage"],
    ) {
      if (!payload.prompt.trim()) return yield* Effect.fail(new Error("Image prompt is required"))

      // 套餐能力门禁必须早于 API Key 获取/创建和图片接口调用；拒绝后本轮不会产生任何生图扣费。
      yield* ensureImageGenerationPlanAccess()
      const key = yield* apiKey()
      const images = yield* Effect.tryPromise({
        try: () => callImageGenerationApi({ apiKey: key, payload, onImage }),
        catch: (cause) => cause,
      })
      if (images.length === 0) return yield* Effect.fail(new Error("WanlaiCode image response did not include images"))
      return images
    })

    const imageProgress = (onImage: Parameters<Interface["generate"]>[1] | undefined) =>
      onImage ? (progress: ImageGenerationProgress) => Effect.runPromise(onImage(progress)) : undefined

    const generate: Interface["generate"] = Effect.fn("WanlaiCodeImageGeneration.generate")(
      function* (payload, onImage) {
        return { images: yield* generateWithKey(payload, imageProgress(onImage)) }
      },
    )

    const generateIntoSession: Interface["generateIntoSession"] = Effect.fn(
      "WanlaiCodeImageGeneration.generateIntoSession",
    )(function* (payload) {
      const started = yield* startImageResult(payload)
      const sessions = yield* Session.Service
      const completedImages: GeneratedImage[] = []
      const images = yield* generateWithKey(
        payload,
        imageProgress((progress) =>
          Effect.gen(function* () {
            const image = yield* saveGeneratedImage(progress.image, {
              directory: payload.output_directory ?? started?.assistantMessage.path.cwd,
              index: progress.index,
            })
            completedImages[progress.index - 1] = image
            return yield* appendGeneratedImage(started, { ...progress, image }).pipe(
              Effect.provideService(Session.Service, sessions),
            )
          }),
        ),
      ).pipe(
        Effect.catch((cause: unknown) =>
          Effect.gen(function* () {
            yield* failImageResult(started, cause)
            return yield* Effect.fail(cause)
          }),
        ),
      )
      const savedImages = yield* Effect.forEach(images, (image, index) => {
        const completed = completedImages[index]
        if (completed) return Effect.succeed({ ...image, ...completed })
        return saveGeneratedImage(image, {
          directory: payload.output_directory ?? started?.assistantMessage.path.cwd,
          index: index + 1,
        })
      })
      return {
        images: savedImages,
        message_id: yield* completeImageResult(started, savedImages),
      }
    })

    return Service.of({ generate, generateIntoSession })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Auth.defaultLayer))

export const sessionLayer = layer.pipe(
  Layer.provide(Auth.defaultLayer),
  Layer.provide(Session.defaultLayer),
  Layer.provide(SessionStatus.defaultLayer),
)

export { ImageGenerationPlanAccessError } from "./wanlaicode-image-generation-plan"
export type { ImageGenerationUpgradePlan } from "./wanlaicode-image-generation-plan"
export * as WanlaiCodeImageGeneration from "./wanlaicode-image-generation"
