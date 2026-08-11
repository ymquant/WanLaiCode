import { Provider } from "@/provider/provider"
import {
  imageCount,
  imageGenerationGroupDisabledText,
  maxImageGenerationCount,
  readableImageGenerationErrorWithMessages,
  saveGeneratedImage,
  WanlaiCodeImageGeneration,
} from "@/provider/wanlaicode-image-generation"
import { ImageGenerationPlanAccessError } from "@/provider/wanlaicode-image-generation-plan"
import { MessageV2 } from "@/session/message-v2"
import { ModelID, ProviderID } from "@/provider/schema"
import { Effect, Schema } from "effect"
import * as Tool from "./tool"

const imageModelPattern = /(?:^|[-_/])(?:gpt-image|dall-e)(?:[-_/]|$)/i
const imageFailureText = /(图片生成失败|正在生成更细致的图片|Image generation failed|Generating a more detailed image|Request failed)/i
const wanlaiCodeProviderID = ProviderID.make("wanlaicode")
const wanlaiCodeDefaultImageModelID = ModelID.make("gpt-image-2")
const contextAttachmentMaxChars = 8_000
const ambiguousFollowupPattern =
  /^(?:[?？!.。…]+|啥|什么|什么情况|啥情况|怎么回事|什么意思|啥意思|呢|然后呢|继续呢|再呢|why|what|huh|ok|好的|好|嗯|啊|哦)$/i
const explicitVisualOutputPattern =
  /(?:图片|图像|图画|插图|插画|配图|海报|卡片|信息图|图文|视觉|头像|壁纸|封面|表情包|贴纸|画|绘制|作图|出图|这张图|上一张图|上图|image|picture|poster|card|infographic|visual|avatar|wallpaper|cover|illustration|artwork|sticker|emoji|draw|render)/i
// 图标/logo/banner 在编程语境里高频出现（修图标按钮、换 logo 组件），只有和生成动词搭配时才算生图意图。
const visualAssetRequestPattern =
  /(?:生成|画|绘制|设计|做|制作|来一?[张个幅]|create|generate|design|draw|make)[^\n]{0,12}(?:图标|徽标|banner|横幅|icon|logo)/i
// “张/幅”是图片专用量词，跟生成动词搭配即视为明确生图（“再帮我生成2张鱼会飞”）；
// “修好这 3 个图片按钮”这类界面描述用的是“个”，不构成生图意图。
const countedImageRequestPattern =
  /(?:生成|画|绘制|做|制作|设计|出|来|给我|create|generate|draw|make|design)[^\n]{0,8}(?:\d{1,2}|[一二两三四五六七八九十])\s*(?:张|幅)/i
const textArtifactPattern =
  /(?:题|题目|选择题|问答题|练习题|答案|解析|文案|文章|报告|总结|说明|解释|代码|脚本|程序|网页|应用|游戏|quiz|question|answer|explanation|article|report|summary|code|script|program|app|game)/i

const ImageAttachment = Schema.Struct({
  data_url: Schema.String.annotate({
    description: "A data URL or public HTTP(S) URL for a reference image to edit.",
  }),
  mime: Schema.optional(Schema.String).annotate({ description: "Image MIME type, such as image/png." }),
  filename: Schema.optional(Schema.String).annotate({ description: "Optional reference image filename." }),
})

export const Parameters = Schema.Struct({
  prompt: Schema.String.annotate({
    description:
      "The concrete prompt for the image model. Resolve vague requests from the conversation before calling this tool.",
  }),
  context_text: Schema.optional(Schema.String).annotate({
    description:
      "Compact conversation facts, content, style constraints, or prior visual details the image model should use.",
  }),
  action: Schema.optional(Schema.Literals(["generate", "edit"])).annotate({
    description: "Use edit when the request modifies or continues an uploaded/recent image; otherwise generate.",
  }),
  input_images: Schema.optional(Schema.Array(ImageAttachment)).annotate({
    description: "Explicit reference images. Usually omit this and set action=edit to use recent chat images.",
  }),
  use_recent_images: Schema.optional(Schema.Boolean).annotate({
    description: "Set true when the latest request points at recent uploaded or generated images.",
  }),
  count: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  ).annotate({ description: "Number of images to generate; values above the service limit are clamped server-side." }),
  size: Schema.optional(Schema.String).annotate({
    description: 'Optional size such as "1024x1024", "1536x1024", "1024x1536", or "auto".',
  }),
})

const isImageGenerationModel = (model: Provider.Model) =>
  imageModelPattern.test(model.id) ||
  imageModelPattern.test(model.name) ||
  (model.capabilities.output.image && !model.capabilities.output.text)

const modelKey = (model: Provider.Model) => `${model.providerID}/${model.id}`.toLowerCase()

const wanlaiCodeDefaultImageModel = (): Provider.Model => ({
  id: wanlaiCodeDefaultImageModelID,
  providerID: wanlaiCodeProviderID,
  name: "GPT Image 2",
  api: {
    id: wanlaiCodeDefaultImageModelID,
    npm: "@ai-sdk/openai-compatible",
    url: "",
  },
  status: "active",
  capabilities: {
    toolcall: false,
    attachment: true,
    reasoning: false,
    temperature: false,
    interleaved: false,
    input: { text: true, image: true, audio: false, video: false, pdf: false },
    output: { text: false, image: true, audio: false, video: false, pdf: false },
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 200_000, output: 8_192 },
  options: {},
  headers: {},
  release_date: "2024-01-01",
})

const isProviderModel = (model: unknown): model is Provider.Model =>
  typeof model === "object" &&
  model !== null &&
  "id" in model &&
  typeof model.id === "string" &&
  "name" in model &&
  typeof model.name === "string" &&
  "providerID" in model &&
  typeof model.providerID === "string" &&
  "capabilities" in model &&
  typeof model.capabilities === "object" &&
  model.capabilities !== null &&
  "output" in model.capabilities &&
  typeof model.capabilities.output === "object" &&
  model.capabilities.output !== null &&
  "image" in model.capabilities.output &&
  typeof model.capabilities.output.image === "boolean"

const currentModel = (ctx: Tool.Context) => {
  const model = ctx.extra?.model
  if (isProviderModel(model)) return model
  return undefined
}

const imagePart = (part: MessageV2.Part) => {
  if (part.type !== "file" || !part.mime.startsWith("image/")) return undefined
  return {
    data_url: part.url,
    mime: part.mime,
    filename: part.filename,
  }
}

const imageAttachment = (part: Pick<MessageV2.FilePart, "mime" | "url" | "filename">) => {
  if (!part.mime.startsWith("image/")) return undefined
  if (part.filename?.startsWith("wanlai-image-loading-")) return undefined
  return {
    data_url: part.url,
    mime: part.mime,
    filename: part.filename,
  }
}

const imageGenerationToolAttachments = (part: MessageV2.Part) => {
  if (part.type !== "tool" || part.tool !== "image_generation") return []
  if (part.state.status !== "running" && part.state.status !== "completed" && part.state.status !== "error") return []
  return (part.state.attachments ?? []).flatMap((attachment) => {
    const image = imageAttachment(attachment)
    return image ? [image] : []
  })
}

const attachmentLine = (part: MessageV2.Part) => {
  if (part.type !== "file") return undefined
  if (part.mime.startsWith("image/")) return `[Attached image: ${part.filename || part.mime}]`
  return `[Attached file: ${part.filename || "file"} (${part.mime})]`
}

const imageGenerationContextLine = (part: MessageV2.Part) => {
  if (part.type !== "tool" || part.tool !== "image_generation") return undefined
  if (part.state.status !== "running" && part.state.status !== "completed" && part.state.status !== "error") return undefined
  const prompt = typeof part.state.input.prompt === "string" ? part.state.input.prompt.trim() : undefined
  const context = typeof part.state.input.context_text === "string" ? part.state.input.context_text.trim() : undefined
  const output = part.state.status === "completed" ? part.state.output.trim() : undefined
  const revisedPrompts =
    part.state.status === "completed" && Array.isArray(part.state.metadata.revisedPrompts)
      ? part.state.metadata.revisedPrompts
          .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
          .join("\n")
          .trim()
      : undefined
  const images = imageGenerationToolAttachments(part)
    .map((image) => `[Generated image: ${image.filename || image.mime || "image"}]`)
    .join("\n")
  const body = [
    prompt ? `previous_image_request:\n${prompt}` : undefined,
    context ? `previous_image_context:\n${context}` : undefined,
    output ? `previous_image_output:\n${output}` : undefined,
    revisedPrompts ? `previous_revised_prompts:\n${revisedPrompts}` : undefined,
    images || undefined,
  ]
    .filter(Boolean)
    .join("\n")
    .trim()
  return body || undefined
}

const collectRecentImages = (messages: MessageV2.WithParts[], limit = 4) => {
  const latestUser = messages.findLast((message) => message.info.role === "user")
  const current = latestUser?.parts.flatMap((part) => {
    const image = imagePart(part)
    return image ? [image] : []
  })
  if (current?.length) return current.slice(0, limit)

  const generated = messages
    .slice()
    .reverse()
    .flatMap((message) =>
      message.parts
        .slice()
        .reverse()
        .flatMap(imageGenerationToolAttachments),
    )
    .slice(0, limit)
  if (generated.length > 0) return generated

  return messages
    .slice()
    .reverse()
    .flatMap((message) =>
      message.parts.flatMap((part) => {
        const image = imagePart(part)
        return image ? [image] : []
      }),
    )
    .slice(0, limit)
}

const textPart = (part: MessageV2.Part) => {
  const text = MessageV2.visibleUserTextPart(part)
  if (!text || imageFailureText.test(text)) return undefined
  return text
}

const latestUserText = (messages: MessageV2.WithParts[]) =>
  messages
    .findLast((message) => message.info.role === "user")
    ?.parts.map(textPart)
    .filter((item): item is string => !!item)
    .join("\n")
    .trim()

const latestUserSkillName = (messages: MessageV2.WithParts[]) =>
  messages
    .findLast((message) => message.info.role === "user")
    ?.parts.flatMap((part) => {
      if (part.type !== "text") return []
      const skill = part.metadata?.skill
      if (!skill || typeof skill !== "object" || Array.isArray(skill)) return []
      const name = (skill as Record<string, unknown>).name
      return typeof name === "string" ? [name] : []
    })[0]

// 图片数量、尺寸、格式和文案都是客户端 UI 配置，只信任持久化在用户消息上的值；
// 模型工具参数无法伪造它们，否则误调用能靠一个自填字段绕过下面的生图意图校验。
const latestUserImageGenerationConfig = (messages: MessageV2.WithParts[]) => {
  const latestUser = messages.findLast((message) => message.info.role === "user")
  return latestUser?.info.role === "user" ? latestUser.info.imageGeneration : undefined
}

const configuredImageCount = (messages: MessageV2.WithParts[]) => {
  const count = latestUserImageGenerationConfig(messages)?.count
  if (!count || !Number.isFinite(count)) return undefined
  return Math.max(1, Math.floor(count))
}

const latestUserAllowsImageGeneration = (
  messages: MessageV2.WithParts[],
  params: Pick<Schema.Schema.Type<typeof Parameters>, "action" | "input_images" | "use_recent_images">,
) => {
  const text = latestUserText(messages)
  if (!text) return true
  if (latestUserSkillName(messages) === "imagegen") return true
  if (configuredImageCount(messages)) return true
  if (params.action === "edit" || params.use_recent_images === true || !!params.input_images?.length) return true
  const wantsVisual =
    explicitVisualOutputPattern.test(text) ||
    visualAssetRequestPattern.test(text) ||
    countedImageRequestPattern.test(text)
  if (textArtifactPattern.test(text) && !wantsVisual) return false
  return wantsVisual
}

const userRequestedImageCount = (messages: MessageV2.WithParts[]) => {
  const text = latestUserText(messages)
  if (!text) return undefined
  const digit = text.match(/(\d{1,2})\s*(?:(?:张|幅)(?:图片|图像|图|海报|卡片|插图|插画|头像|壁纸|封面|信息图)?|个(?:图片|图像|图|海报|卡片|插图|插画|头像|壁纸|封面|信息图))/i)?.[1]
  const zh = text.match(/([一二两三四五六七八九十])\s*(?:(?:张|幅)(?:图片|图像|图|海报|卡片|插图|插画|头像|壁纸|封面|信息图)?|个(?:图片|图像|图|海报|卡片|插图|插画|头像|壁纸|封面|信息图))/i)?.[1]
  const value = digit
    ? Number(digit)
    : zh
      ? ({ 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 } as const)[
          zh as "一" | "二" | "两" | "三" | "四" | "五" | "六" | "七" | "八" | "九" | "十"
        ]
      : undefined
  return value ? Math.max(1, value) : undefined
}

const requestedImageCount = (
  params: Pick<Schema.Schema.Type<typeof Parameters>, "count">,
  messages: MessageV2.WithParts[],
) => configuredImageCount(messages) ?? params.count ?? userRequestedImageCount(messages)

const imageCountMetadata = (requested: number | undefined) => {
  const effective = imageCount(requested)
  return requested && requested > effective
    ? { requestedImageCount: requested, maxImageCount: maxImageGenerationCount }
    : {}
}

export const ambiguousImageGenerationFollowup = (text: string | undefined) => {
  const normalized = text?.trim()
  if (!normalized) return false
  if (ambiguousFollowupPattern.test(normalized)) return true
  if (normalized.length > 12) return false
  return /^[\p{P}\p{S}\s]+$/u.test(normalized)
}

const contextTextPart = (part: MessageV2.Part) => {
  if (part.type !== "text" || !part.synthetic || part.ignored) return undefined
  const text = part.text.trim()
  if (!text || imageFailureText.test(text)) return undefined
  return text
}

const compactContext = (messages: MessageV2.WithParts[], maxChars = 12_000) => {
  const text = messages
    .slice(-10)
    .flatMap((message) => {
      const body = message.parts.map(textPart).filter((item): item is string => !!item).join("\n").trim()
      const images = message.parts
        .flatMap((part) => {
          const image = imagePart(part)
          return image ? [`[Image: ${image.filename || image.mime || "image"}]`] : []
        })
        .join(" ")
      const line = [body, images].filter(Boolean).join("\n").trim()
      if (!line) return []
      return [`${message.info.role === "assistant" ? "Assistant" : "User"}: ${line}`]
    })
    .join("\n\n")
    .trim()
  if (text.length <= maxChars) return text || undefined
  const marker = "\n\n[Middle context omitted for image generation tool]\n\n"
  const budget = Math.max(0, maxChars - marker.length)
  const head = Math.floor(budget * 0.25)
  const tail = budget - head
  return `${text.slice(0, head).trimEnd()}${marker}${text.slice(-tail).trimStart()}`
}

const collectImageInputs = (params: Schema.Schema.Type<typeof Parameters>, messages: MessageV2.WithParts[]) => {
  if (params.input_images && params.input_images.length > 0) return params.input_images
  if (params.action === "edit" || params.use_recent_images) return collectRecentImages(messages)
  const latestUser = messages.findLast((message) => message.info.role === "user")
  const current = latestUser?.parts.flatMap((part) => {
    const image = imagePart(part)
    return image ? [image] : []
  })
  return current?.length ? current.slice(0, 4) : undefined
}

const trimContextBlock = (text: string, maxChars = contextAttachmentMaxChars) => {
  if (text.length <= maxChars) return text
  const marker = "\n\n[Attachment context omitted]\n\n"
  const budget = Math.max(0, maxChars - marker.length)
  const head = Math.floor(budget * 0.35)
  const tail = budget - head
  return `${text.slice(0, head).trimEnd()}${marker}${text.slice(-tail).trimStart()}`
}

const attachmentContext = (messages: MessageV2.WithParts[]) => {
  const lines = messages.slice(-8).flatMap((message) => {
    const text = message.parts.map(contextTextPart).filter((item): item is string => !!item).join("\n").trim()
    const attachments = message.parts.map(attachmentLine).filter((item): item is string => !!item).join("\n")
    const imageGeneration = message.parts
      .map(imageGenerationContextLine)
      .filter((item): item is string => !!item)
      .join("\n")
      .trim()
    const body = [text, attachments, imageGeneration].filter(Boolean).join("\n").trim()
    if (!body) return []
    return [`${message.info.role === "assistant" ? "Assistant" : "User"}:\n${body}`]
  })
  if (lines.length === 0) return undefined
  return trimContextBlock(lines.join("\n\n").trim())
}

const latestImageGenerationContext = (messages: MessageV2.WithParts[]) => {
  const context = messages
    .slice()
    .reverse()
    .flatMap((message) =>
      message.parts
        .slice()
        .reverse()
        .flatMap((part) => {
          const text = imageGenerationContextLine(part)
          return text ? [text] : []
        }),
    )[0]
  if (!context) return undefined
  return trimContextBlock(
    [
      "Prior generated image state:",
      "Use the latest generated image as the edit source.",
      "Preserve all previously achieved text, names, layout, style, and visual constraints unless the latest user request explicitly changes them.",
      "Only apply the latest requested change; do not invent a different target image.",
      "",
      context,
    ].join("\n"),
  )
}

const latestUserAttachmentContext = (messages: MessageV2.WithParts[]) => {
  const latestUser = messages.findLast((message) => message.info.role === "user")
  if (!latestUser) return undefined
  const text = latestUser.parts.map(contextTextPart).filter((item): item is string => !!item).join("\n").trim()
  const attachments = latestUser.parts.map(attachmentLine).filter((item): item is string => !!item).join("\n")
  const body = [text, attachments].filter(Boolean).join("\n").trim()
  if (!body) return undefined
  return trimContextBlock(`User:\n${body}`)
}

const imageContextText = (params: Schema.Schema.Type<typeof Parameters>, messages: MessageV2.WithParts[]) => {
  const base = params.context_text?.trim()
  const shouldUseHistoricalAttachmentContext =
    params.action === "edit" || params.use_recent_images === true || !!params.input_images?.length
  const attachments = shouldUseHistoricalAttachmentContext
    ? attachmentContext(messages)
    : latestUserAttachmentContext(messages)
  const fallback = base ? undefined : compactContext(messages)
  const priorGenerated = shouldUseHistoricalAttachmentContext ? latestImageGenerationContext(messages) : undefined
  return [
    base,
    fallback,
    priorGenerated && priorGenerated !== base && priorGenerated !== fallback ? priorGenerated : undefined,
    attachments && attachments !== fallback ? `Attachment context available to this image request:\n${attachments}` : undefined,
  ]
    .filter(Boolean)
    .join("\n\n")
    .trim()
}

export const ImageGenerationTool = Tool.define(
  "image_generation",
  Effect.gen(function* () {
    const provider = yield* Provider.Service
    const imageGeneration = yield* WanlaiCodeImageGeneration.Service

    const selectImageModel = Effect.fn("ImageGenerationTool.selectImageModel")(function* (ctx: Tool.Context) {
      const current = currentModel(ctx)
      if (current && isImageGenerationModel(current)) return current

      const providers = yield* provider.list()
      const visible = Object.values(providers)
        .flatMap((item) => Object.values(item.models))
        .filter(isImageGenerationModel)
        .filter((model) => model.status !== "deprecated")

      // 后端模型列表可能暂时只暴露普通对话模型；当前会话已在万来时，仍兜底到内置图片模型。
      const shouldFallbackToWanlaiCode =
        providers[wanlaiCodeProviderID] !== undefined || current?.providerID === wanlaiCodeProviderID
      const fallback = shouldFallbackToWanlaiCode ? wanlaiCodeDefaultImageModel() : undefined
      const selected =
        visible.find((model) => modelKey(model) === "wanlaicode/gpt-image-2") ??
        visible.find((model) => current && model.providerID === current.providerID) ??
        (current?.providerID === wanlaiCodeProviderID ? fallback : undefined) ??
        visible.find((model) => /^gpt-image(?:[-_/]|$)/i.test(model.id)) ??
        visible.find((model) => /^dall-e(?:[-_/]|$)/i.test(model.id)) ??
        visible[0] ??
        fallback
      if (!selected) return yield* Effect.fail(new Error("No image generation model is available"))
      return selected
    })

    return {
      description: [
        "Generate or edit images for the user. Use this when the user asks to create a picture, poster, image card, infographic, visual asset, avatar, cover, wallpaper, or asks to modify/restyle/continue an uploaded or recent image.",
        "Do not use this for normal chat, image analysis, code/UI implementation, Mermaid diagrams, or requests asking about an image without creating or editing one.",
        "Do not call this tool for bare punctuation or clarification follow-ups like ?, 什么意思, 啥情况, or 怎么回事. Answer those as normal chat.",
        "For vague requests, read the conversation and pass a concrete prompt plus any needed context_text.",
      ].join("\n"),
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          // 普通模型有时会被上一轮图片上下文带偏，把用户的短追问误判成继续生图。
          // 工具入口再做一次确定性拦截，避免出现只加载 Imagegen/空转几十秒但没有图片的回合。
          if (ambiguousImageGenerationFollowup(latestUserText(ctx.messages))) {
            return yield* Effect.fail(
              new Error("The latest user message is only a clarification/follow-up, not an image generation request."),
            )
          }
          if (!latestUserAllowsImageGeneration(ctx.messages, params)) {
            return yield* Effect.fail(
              new Error("The latest user message does not explicitly request image or visual output."),
            )
          }

          const config = latestUserImageGenerationConfig(ctx.messages)
          const language = typeof ctx.extra?.language === "string" ? ctx.extra.language : undefined
          // 普通自然语言生图没有客户端图片配置，套餐提示必须按会话语言兜底，否则中文用户会看到网关英文原文。
          const errorMessages = {
            ...config?.error_messages,
            group_disabled: config?.error_messages?.group_disabled ?? imageGenerationGroupDisabledText(language),
          }
          const requestedCount = requestedImageCount(params, ctx.messages)
          const count = imageCount(requestedCount)
          const size = config?.size ?? params.size
          const model = yield* selectImageModel(ctx)
          // 普通对话会把附件作为结构化 file/media part 传给模型；图片生成工具是二次调用图片 API，
          // 这里主动从当前会话补齐最近附件，避免只拿到模型写出的简短 prompt 而丢失真实上下文。
          const inputImages = collectImageInputs(params, ctx.messages)

          yield* ctx.metadata({
            title: config?.loading_text || `Generate image with ${model.name || model.id}`,
            metadata: {
              model: `${model.providerID}/${model.id}`,
              action: params.action ?? (inputImages?.length ? "edit" : "generate"),
              inputImageCount: inputImages?.length ?? 0,
              ...imageCountMetadata(requestedCount),
            },
          })

          const completedImages: NonNullable<Tool.ExecuteResult["attachments"]> = []
          const result = yield* imageGeneration
            .generate(
              {
                prompt: params.prompt,
                context_text: imageContextText(params, ctx.messages),
                model: ModelID.make(model.id),
                provider_id: model.providerID,
                count,
                size: size === "auto" ? undefined : size,
                output_format: config?.output_format ?? "png",
                loading_text: config?.loading_text,
                failure_prefix: config?.failure_prefix,
                output_directory: typeof ctx.extra?.cwd === "string" ? ctx.extra.cwd : undefined,
                input_images: inputImages,
                error_messages: errorMessages,
              },
              (progress) =>
                Effect.gen(function* () {
                  const image = yield* saveGeneratedImage(progress.image, {
                    directory: typeof ctx.extra?.cwd === "string" ? ctx.extra.cwd : undefined,
                    index: progress.index,
                  })
                  completedImages[progress.index - 1] = {
                    type: "file" as const,
                    mime: image.mime,
                    filename: image.filename,
                    url: image.url,
                  }
                  return yield* ctx.metadata({
                    title: `Generated ${completedImages.filter(Boolean).length}/${progress.total} image${
                      progress.total === 1 ? "" : "s"
                    }`,
                    metadata: {
                      model: `${model.providerID}/${model.id}`,
                      imageCount: completedImages.filter(Boolean).length,
                      totalImageCount: progress.total,
                      ...imageCountMetadata(requestedCount),
                    },
                    attachments: completedImages.filter(Boolean),
                  })
                }),
            )
            .pipe(
              Effect.catch((cause) => {
                // 工具链路是最终写入 error tool part 的地方：文案要在这里本地化并补上客户端失败前缀，
                // 否则前端只能拿到网关英文原文。
                const readable = readableImageGenerationErrorWithMessages(cause, errorMessages)
                const message = config?.failure_prefix ? `${config.failure_prefix}${readable}` : readable
                if (!(cause instanceof ImageGenerationPlanAccessError)) {
                  return Effect.fail(new Error(message, { cause }))
                }
                // 套餐门禁拒绝时先把真实升级数据写入运行中工具 part；随后沿用原错误链路结束本轮，
                // SessionProcessor.failToolCall 会保留这些 metadata，前端无需再次猜套餐或价格。
                return Effect.gen(function* () {
                  yield* ctx.metadata({
                    title: `Generate image with ${model.name || model.id}`,
                    metadata: {
                      model: `${model.providerID}/${model.id}`,
                      action: params.action ?? (inputImages?.length ? "edit" : "generate"),
                      inputImageCount: inputImages?.length ?? 0,
                      imageGenerationPlanDenied: true,
                      // 支持列表回答“哪些套餐能生图”，升级列表继续只承载当前账号允许购买的套餐。
                      supportedPlans: cause.supportedPlans,
                      upgradePlans: cause.upgradePlans,
                      purchaseUrl: cause.purchaseUrl,
                      purchaseEnabled: cause.purchaseEnabled,
                      planCatalogAvailable: cause.planCatalogAvailable,
                    },
                  })
                  return yield* Effect.fail(new Error(message, { cause }))
                })
              }),
            )
          const images = yield* Effect.forEach(result.images, (image, index) => {
            const completed = completedImages[index]
            if (completed)
              return Effect.succeed({
                ...image,
                mime: completed.mime,
                filename: completed.filename ?? image.filename,
                url: completed.url,
              })
            return saveGeneratedImage(image, {
              directory: typeof ctx.extra?.cwd === "string" ? ctx.extra.cwd : undefined,
              index: index + 1,
            })
          })

          return {
            title: `Generated ${images.length} image${images.length === 1 ? "" : "s"}`,
            output: [
              `Generated ${images.length} image${images.length === 1 ? "" : "s"}.`,
              ...images.flatMap((image, index) =>
                image.revised_prompt ? [`Image ${index + 1} revised prompt: ${image.revised_prompt}`] : [],
              ),
            ].join("\n"),
            metadata: {
              model: `${model.providerID}/${model.id}`,
              imageCount: images.length,
              ...imageCountMetadata(requestedCount),
              revisedPrompts: images.map((image) => image.revised_prompt).filter(Boolean),
            },
            attachments: images.map((image) => ({
              type: "file" as const,
              mime: image.mime,
              filename: image.filename,
              url: image.url,
            })),
          }
        }).pipe(Effect.orDie),
    }
  }),
)
