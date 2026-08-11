import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import type { ContextItem, ImageAttachmentPart } from "@/context/prompt"

export type ImageGenerationContext = {
  prompt: string
  contextText?: string
  inputImages: Array<{ data_url: string; mime?: string; filename?: string }>
}

export type ImageGenerationContextIntent = {
  enabled: boolean
  source?: "auto"
  isEdit?: boolean
  wantsPreviousImage?: boolean
}

// 只在显式图片模型路径需要裁剪执行上下文时使用；普通模型的生图判断交给后端 image_generation 工具。
export const IMAGE_GENERATION_CONTEXT_MAX_CHARS = 24_000

type BuildImageGenerationContextInput = {
  text: string
  snippets: readonly string[]
  contextItems: readonly (ContextItem & { key?: string })[]
  messages: readonly Message[]
  partsByMessage: Record<string, Part[] | undefined>
  currentImages: readonly ImageAttachmentPart[]
  intent: ImageGenerationContextIntent
  maxContextTextChars?: number
}

const section = (title: string, lines: readonly string[]) => {
  const body = lines.map((line) => line.trim()).filter(Boolean)
  if (body.length === 0) return undefined
  return `${title}:\n${body.join("\n")}`
}

const textParts = (parts: readonly Part[] | undefined) =>
  (parts ?? [])
    .filter(
      (part): part is Extract<Part, { type: "text" }> =>
        part.type === "text" && !part.synthetic && !part.ignored,
    )
    .map((part) => part.text.trim())
    .filter(Boolean)

const imageParts = (parts: readonly Part[] | undefined) =>
  (parts ?? [])
    .filter((part): part is Extract<Part, { type: "file" }> => part.type === "file" && part.mime.startsWith("image/"))
    .map((part) => ({
      data_url: part.url,
      mime: part.mime,
      filename: part.filename,
    }))

const range = (item: ContextItem) => {
  if (!item.selection) return item.path
  return `${item.path}:${item.selection.startLine}-${item.selection.endLine}`
}

const fileContextLines = (items: readonly ContextItem[]) =>
  items.flatMap((item) => {
    if (item.type !== "file") return []
    const values = [`- ${range(item)}`]
    const comment = item.comment?.trim()
    const preview = item.preview?.trim()
    if (comment) values.push(`  Comment: ${comment}`)
    if (preview) values.push(`  Preview: ${preview}`)
    return values
  })

// 当前上传图是本轮用户显式给的编辑目标，必须写入上下文文本里；
// 否则分类模型只看到历史对话，容易把上一轮生成内容当成本轮要改的图片。
const currentImageLines = (items: readonly ImageAttachmentPart[]) =>
  items.map((item, index) => `- Image ${index + 1}: ${item.filename || "uploaded image"} (${item.mime || "image"})`)

// 只用于显式图片模型路径决定是否携带最近图片上下文；普通模型不在前端做生图意图判断。
const visualImageEditReference =
  /(截图|图片|照片|原图|这张|那张|上一张|刚才|刚刚|上面|之前|发给你|上传|我发|我传).{0,24}(改|修|美化|优化|换|重绘|重新|好看|漂亮|高级|突破)|(?:改|修|美化|优化|换|重绘|重新).{0,16}(好看|漂亮|高级|风格|截图|图片|照片|图)|(?:给我|来|出|做).{0,8}一张(?:新的|新|图|图片|照片|突破)|make (?:it|this|that).{0,20}(better|prettier)|new (?:version|image)/i
export const hasVisualImageEditReference = (text: string) =>
  visualImageEditReference.test(text)

const contextualReference =
  /(刚才|刚刚|上面|前面|上一|之前|这个风格|这种风格|同样风格|延续|继续|按.*风格|previous|earlier|above|same style|that style|this style|continue)/i
const shortContextualFollowup =
  /^\s*(?:\d+|[A-D]|[一二三四五六七八九十]+|再来(?:一个|一张)?|继续|换一个|下一个|重新来|就这个)\s*[。.!！?？]*\s*$/i
// 这类话本身不一定是生图请求；只有在 intent 已启用/有图片上下文时，才把它当作视觉任务续写来携带上一张图和会话。
const visualTaskContinuation =
  /(再\s*(?:多)?(?:加|出|来|给|生成|做|补充)|继续\s*(?:出|生成|做|补充|加)|多\s*(?:加|出|来|给|生成|做|补充)|换一批|按(?:这个|这种|上面|刚才).*格式).{0,16}(?:题|选择题|问题|卡片|海报|图片|图|练习|worksheet|card|quiz)/i
const imageFailureText = /(图片生成失败|正在生成更细致的图片|Image generation failed|Generating a more detailed image|Request failed)/i
const normalizedText = (value: string) => value.replace(/\s+/g, " ").trim()

// 携带整段会话，不做本地数量/长度裁剪；由上游模型/API 自己处理真实上下文窗口。
const conversationLines = (
  messages: readonly Message[],
  partsByMessage: Record<string, Part[] | undefined>,
  currentText: string,
) =>
  messages.flatMap((message) => {
    const text = textParts(partsByMessage[message.id]).join("\n").trim()
    if (!text) return []
    if (message.role === "assistant" && imageFailureText.test(text)) return []
    if (message.role === "user" && normalizedText(text) === normalizedText(currentText)) return []
    return [`${message.role === "assistant" ? "Assistant" : "User"}: ${text}`]
  })

const historicalImageParts = (messages: readonly Message[], partsByMessage: Record<string, Part[] | undefined>) =>
  messages
    .slice()
    .reverse()
    .flatMap((message) =>
      imageParts(partsByMessage[message.id]).map((image) => ({
        ...image,
        source: message.role,
      })),
    )

// 历史用户上传的截图也属于会话图片上下文；用户后续说“改好看点/给我一张新的”时，
// 这里必须把它作为图片模型的编辑输入，否则文本模型会理解意图但执行层拿不到图。
const previousImageLines = (items: ReturnType<typeof historicalImageParts>) =>
  items.map(
    (item, index) =>
      `- Image ${index + 1}: ${item.filename || "chat image"} (${item.mime || "image"}, ${
        item.source === "user" ? "user upload" : "assistant output"
      })`,
  )

// 上下文保留头部压缩摘要和最新尾部，避免显式图片模型路径的上下文超窗。
const clampContextText = (value: string | undefined, max: number | undefined) => {
  const text = value?.trim()
  if (!text) return undefined
  if (!max || max <= 0 || text.length <= max) return text
  const marker =
    "\n\n[Middle context omitted for image generation context; compacted session summaries stay in the retained context when available.]\n\n"
  const budget = Math.max(0, max - marker.length)
  const head = Math.floor(budget * 0.25)
  const tail = budget - head
  return `${head > 0 ? text.slice(0, head).trimEnd() : ""}${marker}${tail > 0 ? text.slice(-tail).trimStart() : ""}`
}

export function buildImageGenerationContext(input: BuildImageGenerationContextInput): ImageGenerationContext {
  const currentInputImages = input.currentImages.map((attachment) => ({
    data_url: attachment.dataUrl,
    mime: attachment.mime,
    filename: attachment.filename,
  }))
  const carriesPreviousImage =
    input.intent.wantsPreviousImage ||
    (!!input.intent.enabled &&
      (contextualReference.test(input.text) ||
        shortContextualFollowup.test(input.text) ||
        visualTaskContinuation.test(input.text) ||
        hasVisualImageEditReference(input.text)))
  const previousImageCandidates =
    currentInputImages.length > 0 || !carriesPreviousImage
      ? []
      : historicalImageParts(input.messages, input.partsByMessage)
  const previousImages = previousImageCandidates.map((image) => ({
    data_url: image.data_url,
    mime: image.mime,
    filename: image.filename,
  }))

  const shouldUseRecentConversation =
    contextualReference.test(input.text) ||
    shortContextualFollowup.test(input.text) ||
    visualTaskContinuation.test(input.text) ||
    hasVisualImageEditReference(input.text) ||
    !!input.intent.isEdit ||
    !!input.intent.wantsPreviousImage ||
    input.intent.enabled
  const conversationSection = shouldUseRecentConversation
    ? section(
        "Current conversation (use it as the basis for what to generate; the user's request above takes priority)",
        conversationLines(input.messages, input.partsByMessage, input.text),
      )
    : undefined
  const sections = [
    section("Current uploaded images (primary edit target; use these before any previous chat image)", currentImageLines(input.currentImages)),
    section("Previous chat images (newest first; valid edit references when the latest request points to them)", previousImageLines(previousImageCandidates)),
    section("Selected chat excerpts", input.snippets),
    section("Files and comments", fileContextLines(input.contextItems)),
    conversationSection,
  ].filter((item): item is string => !!item)

  const contextText = sections.length > 0 ? sections.join("\n\n") : undefined
  return {
    prompt: input.text.trim(),
    contextText: clampContextText(contextText, input.maxContextTextChars),
    inputImages: [...currentInputImages, ...previousImages],
  }
}
