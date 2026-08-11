import { describe, expect, test } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import { Agent } from "@/agent/agent"
import { ModelID, ProviderID } from "@/provider/schema"
import { ambiguousImageGenerationFollowup, ImageGenerationTool } from "@/tool/image-generation"
import { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { WanlaiCodeImageGeneration, type ImageGenerateInput } from "@/provider/wanlaicode-image-generation"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { MessageV2 } from "@/session/message-v2"
import { ProviderTest } from "../fake/provider"
import { testEffect } from "../lib/effect"
import { tmpdir } from "../fixture/fixture"
import { pathToFileURL } from "url"

const textModel = ProviderTest.model({
  id: ModelID.make("gpt-5.5"),
  providerID: ProviderID.make("wanlaicode"),
  name: "GPT 5.5",
})

const agentInfo: Agent.Info = {
  name: "build",
  mode: "primary",
  permission: [],
  options: {},
}

const ctx: Tool.Context = {
  sessionID: SessionID.descending(),
  messageID: MessageID.ascending(),
  agent: "build",
  abort: new AbortController().signal,
  messages: [],
  extra: { model: textModel },
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const userInfo = (id: string): MessageV2.User =>
  ({
    id: MessageID.make(id),
    sessionID: ctx.sessionID,
    role: "user",
    time: { created: 0 },
    agent: "user",
    model: { providerID: textModel.providerID, modelID: textModel.id },
    tools: {},
    mode: "",
  }) as unknown as MessageV2.User

const partBase = (messageID: string, id: string) => ({
  id: PartID.make(id),
  sessionID: ctx.sessionID,
  messageID: MessageID.make(messageID),
})

const userMessage = (id: string, parts: MessageV2.Part[]): MessageV2.WithParts => ({
  info: userInfo(id),
  parts,
})

const withImageConfig = (
  message: MessageV2.WithParts,
  imageGeneration: MessageV2.User["imageGeneration"],
): MessageV2.WithParts => ({
  ...message,
  info: { ...(message.info as MessageV2.User), imageGeneration },
})

const assistantMessage = (id: string, parts: MessageV2.Part[]): MessageV2.WithParts =>
  ({
    info: {
      id: MessageID.make(id),
      sessionID: ctx.sessionID,
      role: "assistant",
      time: { created: 0, completed: 0 },
      mode: "build",
      agent: "build",
      path: { cwd: "/tmp", root: "/tmp" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: textModel.id,
      providerID: textModel.providerID,
    },
    parts,
  }) as MessageV2.WithParts

const agentLayer = Layer.succeed(
  Agent.Service,
  Agent.Service.of({
    get: () => Effect.succeed(agentInfo),
    list: () => Effect.succeed([agentInfo]),
    defaultAgent: () => Effect.succeed("build"),
    generate: () =>
      Effect.succeed({
        identifier: "build",
        whenToUse: "test",
        systemPrompt: "test",
      }),
  }),
)

describe("tool.image_generation", () => {
  const calls: ImageGenerateInput[] = []
  const provider = ProviderTest.fake({
    model: textModel,
    info: ProviderTest.info(
      {
        id: ProviderID.make("wanlaicode"),
        name: "WanlaiCode",
        source: "api",
      },
      textModel,
    ),
  })
  const imageLayer = Layer.succeed(
    WanlaiCodeImageGeneration.Service,
    WanlaiCodeImageGeneration.Service.of({
      generate: (payload) =>
        Effect.sync(() => {
          calls.push(payload)
          return {
            images: [
              {
                url: "data:image/png;base64,aW1hZ2U=",
                mime: "image/png",
                filename: "wanlai-image-1.png",
              },
            ],
          }
        }),
      generateIntoSession: () => Effect.die(new Error("not used")),
    }),
  )
  const it = testEffect(Layer.mergeAll(provider.layer, imageLayer, Truncate.defaultLayer, agentLayer))

  it.effect("万来普通模型未声明图片输出时兜底使用内置图片模型", () =>
    Effect.gen(function* () {
      calls.length = 0
      const info = yield* ImageGenerationTool
      const tool = yield* info.init()
      const result = yield* tool.execute({ prompt: "生成一条会飞的鱼" }, ctx)

      expect(calls).toHaveLength(1)
      expect(calls[0].provider_id).toBe("wanlaicode")
      expect(calls[0].model).toBe("gpt-image-2")
      expect(result.attachments?.[0]?.mime).toBe("image/png")
      expect(result.metadata.model).toBe("wanlaicode/gpt-image-2")
    }),
  )

  it.effect("生成图片会保存到当前工作目录", () =>
    Effect.gen(function* () {
      calls.length = 0
      const tmp = yield* Effect.promise(() => tmpdir())
      yield* Effect.addFinalizer(() => Effect.promise(() => tmp[Symbol.asyncDispose]()))
      const info = yield* ImageGenerationTool
      const tool = yield* info.init()
      const result = yield* tool.execute(
        { prompt: "生成一条会飞的鱼" },
        { ...ctx, extra: { ...ctx.extra, cwd: tmp.path } },
      )
      const files = yield* Effect.promise(() => Array.fromAsync(new Bun.Glob("wanlai-image-*.png").scan(tmp.path)))

      expect(files).toHaveLength(1)
      expect(result.attachments?.[0]?.url).toBe("data:image/png;base64,aW1hZ2U=")
      expect(result.attachments?.[0]?.filename).toBe(files[0])
      expect(yield* Effect.promise(() => Bun.file(`${tmp.path}/${files[0]}`).text())).toBe("image")
    }),
  )

  it.effect("万来多模态文本模型仍兜底使用内置图片模型", () =>
    Effect.gen(function* () {
      calls.length = 0
      const multimodalTextModel = ProviderTest.model({
        ...textModel,
        capabilities: {
          ...textModel.capabilities,
          output: { ...textModel.capabilities.output, text: true, image: true },
        },
      })
      const info = yield* ImageGenerationTool
      const tool = yield* info.init()
      yield* tool.execute({ prompt: "生成一条会飞的鱼" }, { ...ctx, extra: { model: multimodalTextModel } })

      expect(calls).toHaveLength(1)
      expect(calls[0].provider_id).toBe("wanlaicode")
      expect(calls[0].model).toBe("gpt-image-2")
    }),
  )

  it.effect("当前用户图片附件会自动传给图片生成 API", () =>
    Effect.gen(function* () {
      calls.length = 0
      const info = yield* ImageGenerationTool
      const tool = yield* info.init()
      yield* tool.execute(
        { prompt: "按这张图做一张海报" },
        {
          ...ctx,
          messages: [
            userMessage("msg_image", [
              { ...partBase("msg_image", "prt_text"), type: "text", text: "按这张图做一张海报" },
              {
                ...partBase("msg_image", "prt_image"),
                type: "file",
                mime: "image/png",
                filename: "reference.png",
                url: "data:image/png;base64,cmVmZXJlbmNl",
              },
            ]),
          ],
        },
      )

      expect(calls).toHaveLength(1)
      expect(calls[0].input_images).toEqual([
        { data_url: "data:image/png;base64,cmVmZXJlbmNl", mime: "image/png", filename: "reference.png" },
      ])
      expect(calls[0].context_text).toContain("按这张图做一张海报")
      expect(calls[0].context_text).toContain("[Attached image: reference.png]")
    }),
  )

  it.effect("短追问不会被上一轮图片上下文误当成继续生图", () =>
    Effect.gen(function* () {
      calls.length = 0
      const info = yield* ImageGenerationTool
      const tool = yield* info.init()
      const exit = yield* tool
        .execute(
          { prompt: "继续生成图片" },
          {
            ...ctx,
            messages: [userMessage("msg_question", [{ ...partBase("msg_question", "prt_question"), type: "text", text: "?" }])],
          },
        )
        .pipe(Effect.exit)

      expect(exit._tag).toBe("Failure")
      expect(calls).toHaveLength(0)
    }),
  )

  it.effect("上一轮图片不会把最新普通文本请求强行带进生图工具", () =>
    Effect.gen(function* () {
      calls.length = 0
      const info = yield* ImageGenerationTool
      const tool = yield* info.init()
      const exit = yield* tool
        .execute(
          { prompt: "继续上一轮视觉卡片风格，补充新的内容", action: "generate" },
          {
            ...ctx,
            messages: [
              assistantMessage("msg_image_card", [
                {
                  ...partBase("msg_image_card", "tool_image_card"),
                  type: "tool",
                  callID: "image_generation_card",
                  tool: "image_generation",
                  state: {
                    status: "completed",
                    input: { prompt: "把鱼会飞主题选择题做成图片" },
                    output: "Generated 1 image.",
                    title: "Generated 1 image",
                    metadata: { imageCount: 1 },
                    time: { start: 1, end: 2 },
                    attachments: [
                      {
                        ...partBase("msg_image_card", "generated_card"),
                        type: "file",
                        mime: "image/png",
                        filename: "question-card.png",
                        url: "data:image/png;base64,Y2FyZA==",
                      },
                    ],
                  },
                },
              ]),
              userMessage("msg_latest", [
                { ...partBase("msg_latest", "prt_latest"), type: "text", text: "再生成5道关于鱼会飞的选择题" },
              ]),
            ],
          },
        )
        .pipe(Effect.exit)

      expect(exit._tag).toBe("Failure")
      expect(calls).toHaveLength(0)
    }),
  )

  it.effect("文件附件展开文本会进入图片生成上下文", () =>
    Effect.gen(function* () {
      calls.length = 0
      const info = yield* ImageGenerationTool
      const tool = yield* info.init()
      yield* tool.execute(
        { prompt: "把附件内容做成信息图" },
        {
          ...ctx,
          messages: [
            userMessage("msg_file", [
              { ...partBase("msg_file", "prt_text_file"), type: "text", text: "把附件内容做成信息图" },
              {
                ...partBase("msg_file", "prt_file_read"),
                type: "text",
                synthetic: true,
                text: "Revenue: Q1 120, Q2 180, Q3 260",
              },
              {
                ...partBase("msg_file", "prt_file"),
                type: "file",
                mime: "text/plain",
                filename: "metrics.csv",
                url: "file:///tmp/metrics.csv",
              },
            ]),
          ],
        },
      )

      expect(calls).toHaveLength(1)
      expect(calls[0].context_text).toContain("Revenue: Q1 120, Q2 180, Q3 260")
      expect(calls[0].context_text).toContain("[Attached file: metrics.csv (text/plain)]")
    }),
  )

  it.effect("普通文本转图不会携带旧图片附件上下文", () =>
    Effect.gen(function* () {
      calls.length = 0
      const info = yield* ImageGenerationTool
      const tool = yield* info.init()
      yield* tool.execute(
        {
          prompt: "把上一条选择题做成图片",
          context_text: "immediate_previous_assistant_answer:\n1. 选择题内容\n答案：A",
          action: "generate",
        },
        {
          ...ctx,
          messages: [
            userMessage("old_image", [
              {
                ...partBase("old_image", "prt_old_image"),
                type: "file",
                mime: "image/png",
                filename: "old-generated.png",
                url: "data:image/png;base64,b2xk",
              },
            ]),
            userMessage("current", [{ ...partBase("current", "prt_current"), type: "text", text: "生成图片" }]),
          ],
        },
      )

      expect(calls).toHaveLength(1)
      expect(calls[0].context_text).toContain("immediate_previous_assistant_answer")
      expect(calls[0].context_text).toContain("选择题内容")
      expect(calls[0].context_text).not.toContain("[Attached image: old-generated.png]")
      expect(calls[0].input_images).toBeUndefined()
    }),
  )

  it.effect("上一条回答转图片时不会复用更早生成图的 revised prompt", () =>
    Effect.gen(function* () {
      calls.length = 0
      const info = yield* ImageGenerationTool
      const tool = yield* info.init()
      yield* tool.execute(
        {
          prompt: "把上一条 assistant 回答排版成一张清晰的中文信息卡/文档卡图片。只使用 context_text 中 immediate_previous_assistant_answer 的内容，不要使用更早的图片。",
          context_text: [
            "Image generation source priority:",
            "Use only the immediate_previous_assistant_answer below as the image content source.",
            "",
            "latest_user_request:",
            "给我图片",
            "",
            "immediate_previous_assistant_answer:",
            "交付风险清单：\n1. 上下文短追问容易串到旧图片。\n2. 发布前必须跑回归测试。",
          ].join("\n"),
          action: "generate",
        },
        {
          ...ctx,
          messages: [
            assistantMessage("old_generated", [
              {
                ...partBase("old_generated", "tool_old_generated"),
                type: "tool",
                callID: "image_generation_old",
                tool: "image_generation",
                state: {
                  status: "completed",
                  input: { prompt: "生成一条会飞的鱼" },
                  output: "Generated 1 image.\nImage 1 revised prompt: A blue-purple flying fish in the sky.",
                  title: "Generated 1 image",
                  metadata: {
                    imageCount: 1,
                    revisedPrompts: ["A blue-purple flying fish in the sky."],
                  },
                  time: { start: 1, end: 2 },
                  attachments: [
                    {
                      ...partBase("old_generated", "old_fish_image"),
                      type: "file",
                      mime: "image/png",
                      filename: "flying-fish.png",
                      url: "data:image/png;base64,ZmlzaA==",
                    },
                  ],
                },
              },
            ]),
            userMessage("current", [{ ...partBase("current", "prt_current"), type: "text", text: "给我图片" }]),
          ],
        },
      )

      expect(calls).toHaveLength(1)
      expect(calls[0].context_text).toContain("交付风险清单")
      expect(calls[0].context_text).toContain("发布前必须跑回归测试")
      expect(calls[0].context_text).not.toContain("A blue-purple flying fish")
      expect(calls[0].context_text).not.toContain("[Attached image: flying-fish.png]")
      expect(calls[0].input_images).toBeUndefined()
    }),
  )

  it.effect("追改图片优先使用上一轮 image_generation 工具产出的图片和上下文", () =>
    Effect.gen(function* () {
      calls.length = 0
      const info = yield* ImageGenerationTool
      const tool = yield* info.init()
      yield* tool.execute(
        { prompt: "再把头像改成匿名头像", action: "edit", use_recent_images: true },
        {
          ...ctx,
          messages: [
            userMessage("msg_1", [
              {
                ...partBase("msg_1", "prt_source"),
                type: "file",
                mime: "image/png",
                filename: "original.png",
                url: "data:image/png;base64,b3JpZ2luYWw=",
              },
              { ...partBase("msg_1", "prt_text_1"), type: "text", text: "把图中发言的人改成宣传大王" },
            ]),
            assistantMessage("msg_2", [
              {
                ...partBase("msg_2", "tool_1"),
                type: "tool",
                callID: "image_generation_1",
                tool: "image_generation",
                state: {
                  status: "completed",
                  input: { prompt: "把图中发言的人改成宣传大王", context_text: "昵称必须是宣传大王" },
                  output: "Generated 1 image.\nImage 1 revised prompt: 保持聊天截图布局，把发言人昵称改为宣传大王。",
                  title: "Generated 1 image",
                  metadata: {
                    imageCount: 1,
                    revisedPrompts: ["保持聊天截图布局，把发言人昵称改为宣传大王。"],
                  },
                  time: { start: 1, end: 2 },
                  attachments: [
                    {
                      ...partBase("msg_2", "generated_1"),
                      type: "file",
                      mime: "image/png",
                      filename: "generated.png",
                      url: "data:image/png;base64,Z2VuZXJhdGVk",
                    },
                  ],
                },
              },
            ]),
            userMessage("msg_3", [
              { ...partBase("msg_3", "prt_text_3"), type: "text", text: "再把头像改成匿名头像" },
            ]),
          ],
        },
      )

      expect(calls).toHaveLength(1)
      expect(calls[0].input_images).toEqual([
        { data_url: "data:image/png;base64,Z2VuZXJhdGVk", mime: "image/png", filename: "generated.png" },
      ])
      expect(calls[0].context_text).toContain("Use the latest generated image as the edit source")
      expect(calls[0].context_text).toContain("Preserve all previously achieved text")
      expect(calls[0].context_text).toContain("宣传大王")
      expect(calls[0].context_text).toContain("匿名头像")
      expect(calls[0].context_text).toContain("previous_revised_prompts")
    }),
  )

  it.effect("追改图片支持上一轮已落盘的 file URL 图片", () =>
    Effect.gen(function* () {
      calls.length = 0
      const tmp = yield* Effect.promise(() => tmpdir())
      yield* Effect.addFinalizer(() => Effect.promise(() => tmp[Symbol.asyncDispose]()))
      const imagePath = `${tmp.path}/generated.png`
      yield* Effect.promise(() => Bun.write(imagePath, "generated"))
      const info = yield* ImageGenerationTool
      const tool = yield* info.init()
      yield* tool.execute(
        { prompt: "把鱼换成巧嘴，然后人物真实点", action: "edit", use_recent_images: true },
        {
          ...ctx,
          messages: [
            assistantMessage("msg_1", [
              {
                ...partBase("msg_1", "tool_1"),
                type: "tool",
                callID: "image_generation_1",
                tool: "image_generation",
                state: {
                  status: "completed",
                  input: { prompt: "生成一张鱼图" },
                  output: "Generated 1 image.",
                  title: "Generated 1 image",
                  metadata: { imageCount: 1 },
                  time: { start: 1, end: 2 },
                  attachments: [
                    {
                      ...partBase("msg_1", "generated_1"),
                      type: "file",
                      mime: "image/png",
                      filename: "generated.png",
                      url: pathToFileURL(imagePath).toString(),
                    },
                  ],
                },
              },
            ]),
            userMessage("msg_2", [
              { ...partBase("msg_2", "prt_text_2"), type: "text", text: "把鱼换成巧嘴，然后人物真实点" },
            ]),
          ],
        },
      )

      expect(calls).toHaveLength(1)
      expect(calls[0].input_images?.[0]).toEqual({
        data_url: pathToFileURL(imagePath).toString(),
        mime: "image/png",
        filename: "generated.png",
      })
    }),
  )

  const textOnlyMessages = (text: string) => [
    userMessage("msg_intent", [{ ...partBase("msg_intent", "prt_intent"), type: "text", text }]),
  ]

  // 工具描述声明支持头像/封面/壁纸等视觉资产，执行期校验必须和描述保持一致。
  const allowedRequests = [
    "帮我做一个赛博朋克风格的头像",
    "给我一张手机壁纸",
    "做个公众号封面",
    "create an avatar for my profile",
    "design a logo for the studio",
    "再帮我生成2张鱼会飞",
  ]
  for (const text of allowedRequests) {
    it.effect(`明确视觉请求会放行：${text}`, () =>
      Effect.gen(function* () {
        calls.length = 0
        const info = yield* ImageGenerationTool
        const tool = yield* info.init()
        yield* tool.execute({ prompt: text }, { ...ctx, messages: textOnlyMessages(text) })

        expect(calls).toHaveLength(1)
      }),
    )
  }

  // 这些是界面/编程任务：模型误调用工具时必须在套餐校验之前拦下。
  // 正文里直接出现“图片”二字的界面请求（“修好这个图片按钮”）无法在词表层区分，
  // 由模型的 tool_choice=auto 负责不调用工具，prompt.test.ts 覆盖那条链路。
  const rejectedRequests = [
    "下载按钮点了会跳转页面，修复一下这个按钮",
    "fix the icon button in the header",
    "把上面的答案整理成一段文案",
  ]
  for (const text of rejectedRequests) {
    it.effect(`非生图请求会被拦下：${text}`, () =>
      Effect.gen(function* () {
        calls.length = 0
        const info = yield* ImageGenerationTool
        const tool = yield* info.init()
        const exit = yield* tool.execute({ prompt: text }, { ...ctx, messages: textOnlyMessages(text) }).pipe(Effect.exit)

        expect(exit._tag).toBe("Failure")
        expect(calls).toHaveLength(0)
      }),
    )
  }

  it.effect("模型自填数量不能绕过生图意图校验", () =>
    Effect.gen(function* () {
      calls.length = 0
      const text = "下载按钮点了会跳转页面，修复一下这个按钮"
      const info = yield* ImageGenerationTool
      const tool = yield* info.init()
      const exit = yield* tool
        .execute({ prompt: text, count: 4 }, { ...ctx, messages: textOnlyMessages(text) })
        .pipe(Effect.exit)

      expect(exit._tag).toBe("Failure")
      expect(calls).toHaveLength(0)
    }),
  )

  it.effect("客户端配置的张数优先于正文里提到的张数", () =>
    Effect.gen(function* () {
      calls.length = 0
      const text = "参考之前生成10张的方案，这次生成2张鱼图"
      const message = userMessage("msg_config", [
        { ...partBase("msg_config", "prt_config"), type: "text", text },
      ])
      const info = yield* ImageGenerationTool
      const tool = yield* info.init()
      yield* tool.execute(
        { prompt: text, count: 10 },
        {
          ...ctx,
          messages: [withImageConfig(message, { count: 2 })],
        },
      )

      expect(calls).toHaveLength(1)
      expect(calls[0].count).toBe(2)
    }),
  )

  it.effect("超过上限的张数会截断并保留原始请求量", () =>
    Effect.gen(function* () {
      calls.length = 0
      const text = "生成10张鱼会飞的图片"
      const info = yield* ImageGenerationTool
      const tool = yield* info.init()
      const result = yield* tool.execute({ prompt: text, count: 10 }, { ...ctx, messages: textOnlyMessages(text) })

      expect(calls).toHaveLength(1)
      expect(calls[0].count).toBe(8)
      expect(result.metadata.requestedImageCount).toBe(10)
      expect(result.metadata.maxImageCount).toBe(8)
    }),
  )

  it.effect("上游失败时保留客户端失败前缀和真实原因", () =>
    Effect.gen(function* () {
      const failingLayer = Layer.succeed(
        WanlaiCodeImageGeneration.Service,
        WanlaiCodeImageGeneration.Service.of({
          generate: () => Effect.fail(new Error("upstream failed")),
          generateIntoSession: () => Effect.die(new Error("not used")),
        }),
      )
      const text = "生成一张鱼图"
      const message = userMessage("msg_fail", [{ ...partBase("msg_fail", "prt_fail"), type: "text", text }])
      const layers = Layer.mergeAll(provider.layer, failingLayer, Truncate.defaultLayer, agentLayer)
      const info = yield* ImageGenerationTool.pipe(Effect.provide(layers))
      const tool = yield* info.init().pipe(Effect.provide(layers))
      const exit = yield* tool
        .execute(
          { prompt: text },
          {
            ...ctx,
            messages: [withImageConfig(message, { failure_prefix: "生成失败：" })],
          },
        )
        .pipe(Effect.exit, Effect.provide(layers))

      expect(exit._tag).toBe("Failure")
      const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
      expect((error as Error)?.message).toBe("生成失败：upstream failed")
    }),
  )

  it.effect("没有客户端错误文案时按会话语言本地化套餐提示", () =>
    Effect.gen(function* () {
      const deniedLayer = Layer.succeed(
        WanlaiCodeImageGeneration.Service,
        WanlaiCodeImageGeneration.Service.of({
          generate: () => Effect.fail(new Error("Image generation is not enabled for this group")),
          generateIntoSession: () => Effect.die(new Error("not used")),
        }),
      )
      const text = "生成一张鱼图"
      const layers = Layer.mergeAll(provider.layer, deniedLayer, Truncate.defaultLayer, agentLayer)
      const info = yield* ImageGenerationTool.pipe(Effect.provide(layers))
      const tool = yield* info.init().pipe(Effect.provide(layers))
      const exit = yield* tool
        .execute(
          { prompt: text },
          { ...ctx, messages: textOnlyMessages(text), extra: { ...ctx.extra, language: "zh-Hans" } },
        )
        .pipe(Effect.exit, Effect.provide(layers))

      expect(exit._tag).toBe("Failure")
      const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
      expect((error as Error)?.message).toBe("当前套餐不支持生图")
    }),
  )

  it.effect("非万来供应商没有图片模型时仍失败", () =>
    Effect.gen(function* () {
      const openaiModel = ProviderTest.model({
        id: ModelID.make("gpt-5.5"),
        providerID: ProviderID.make("openai"),
        name: "GPT 5.5",
      })
      const openaiProvider = ProviderTest.fake({ model: openaiModel }).layer
      const info = yield* ImageGenerationTool.pipe(
        Effect.provide(Layer.mergeAll(openaiProvider, imageLayer, Truncate.defaultLayer, agentLayer)),
      )
      const tool = yield* info.init().pipe(Effect.provide(Layer.mergeAll(Truncate.defaultLayer, agentLayer)))
      const exit = yield* tool
        .execute({ prompt: "生成图片" }, { ...ctx, extra: { model: openaiModel } })
        .pipe(Effect.exit, Effect.provide(Layer.mergeAll(Truncate.defaultLayer, agentLayer)))

      expect(exit._tag).toBe("Failure")
    }),
  )
})

describe("ambiguousImageGenerationFollowup", () => {
  test("识别裸标点和短追问", () => {
    expect(ambiguousImageGenerationFollowup("?")).toBe(true)
    expect(ambiguousImageGenerationFollowup("啥情况")).toBe(true)
    expect(ambiguousImageGenerationFollowup("再生成三张")).toBe(false)
    expect(ambiguousImageGenerationFollowup("继续画三张不同风格的鱼")).toBe(false)
  })
})
