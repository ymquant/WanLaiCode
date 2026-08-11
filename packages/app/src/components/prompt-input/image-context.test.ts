import { describe, expect, test } from "bun:test"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import { buildImageGenerationContext } from "./image-context"

const user = (id: string): Message => ({
  id,
  sessionID: "ses_1",
  role: "user",
  time: { created: Date.now() },
  agent: "build",
  model: { providerID: "wanlaicode", modelID: "gpt-5.5" },
})

const assistant = (id: string): Message => ({
  id,
  sessionID: "ses_1",
  role: "assistant",
  time: { created: Date.now() },
  parentID: "msg_parent",
  modelID: "gpt-image-2",
  providerID: "wanlaicode",
  mode: "build",
  agent: "build",
  path: { cwd: "/repo", root: "/repo" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
})

const textPart = (messageID: string, text: string): Part => ({
  id: `prt_${messageID}`,
  sessionID: "ses_1",
  messageID,
  type: "text",
  text,
})

const ignoredTextPart = (messageID: string, text: string): Part => ({
  id: `prt_${messageID}`,
  sessionID: "ses_1",
  messageID,
  type: "text",
  text,
  ignored: true,
})

const imagePart = (messageID: string, url: string): Part => ({
  id: `img_${messageID}`,
  sessionID: "ses_1",
  messageID,
  type: "file",
  mime: "image/png",
  filename: "generated.png",
  url,
})

describe("buildImageGenerationContext", () => {
  test("includes snippets, file context, and recent conversation in context_text", () => {
    const result = buildImageGenerationContext({
      text: "按刚才这个风格生成一张封面",
      snippets: ["选中的聊天片段"],
      contextItems: [
        {
          type: "file",
          path: "src/app.ts",
          selection: { startLine: 1, startChar: 0, endLine: 3, endChar: 0 },
          comment: "重点使用这里的产品名",
          preview: "const product = 'Wanlai'",
        },
      ],
      messages: [user("msg_1"), assistant("msg_2")],
      partsByMessage: {
        msg_1: [textPart("msg_1", "我们刚才确定了极简风格")],
        msg_2: [textPart("msg_2", "好的，保持黑白高对比")],
      },
      currentImages: [],
      intent: { enabled: true, source: "auto" },
    })

    expect(result.prompt).toBe("按刚才这个风格生成一张封面")
    expect(result.contextText).toContain("Selected chat excerpts")
    expect(result.contextText).toContain("选中的聊天片段")
    expect(result.contextText).toContain("src/app.ts:1-3")
    expect(result.contextText).toContain("Current conversation")
  })

  test("does not include recent conversation for standalone image requests", () => {
    const result = buildImageGenerationContext({
      text: "生成一张猫图",
      snippets: [],
      contextItems: [],
      messages: [user("msg_1"), assistant("msg_2")],
      partsByMessage: {
        msg_1: [textPart("msg_1", "生成一张猫图")],
        msg_2: [textPart("msg_2", "图片生成失败： Request failed")],
      },
      currentImages: [],
      intent: { enabled: true, source: "auto" },
    })

    expect(result.contextText).toBeUndefined()
  })

  test("includes recent conversation for generic image requests without their own subject", () => {
    const result = buildImageGenerationContext({
      text: "生成个图片",
      snippets: [],
      contextItems: [],
      messages: [user("msg_1"), assistant("msg_2")],
      partsByMessage: {
        msg_1: [textPart("msg_1", "帮我整理一个产品发布活动方案")],
        msg_2: [textPart("msg_2", "活动主题是 Wanlai Code 新版本发布，核心卖点是智能编程和团队协作。")],
      },
      currentImages: [],
      intent: { enabled: true, source: "auto" },
    })

    expect(result.contextText).toContain("Current conversation")
    expect(result.contextText).toContain("产品发布活动方案")
    expect(result.contextText).toContain("智能编程和团队协作")
  })

  test("includes recent conversation for contextual visual wording in explicit image mode", () => {
    const result = buildImageGenerationContext({
      text: "用信息图卡片展示",
      snippets: [],
      contextItems: [],
      messages: [user("msg_1"), assistant("msg_2")],
      partsByMessage: {
        msg_1: [textPart("msg_1", "把这段会议纪要提炼一下")],
        msg_2: [textPart("msg_2", "会议结论：本周完成 Windows 主题修复，下周聚焦图片生成上下文体验。")],
      },
      currentImages: [],
      intent: { enabled: true, source: "auto" },
    })

    expect(result.contextText).toContain("Current conversation")
    expect(result.contextText).toContain("Windows 主题修复")
    expect(result.contextText).toContain("图片生成上下文体验")
  })

  test("includes recent conversation for edit requests even without contextual reference words", () => {
    const result = buildImageGenerationContext({
      text: "加个万来Code水印，保持原来的内容",
      snippets: [],
      contextItems: [],
      messages: [user("msg_1"), assistant("msg_2")],
      partsByMessage: {
        msg_1: [textPart("msg_1", "水印放右下角，不遮挡主体。")],
        msg_2: [textPart("msg_2", "好的，会保留主体构图。")],
      },
      currentImages: [{ type: "image", id: "img", filename: "current.png", mime: "image/png", dataUrl: "data:image/png;base64,current" }],
      intent: { enabled: true, source: "auto", isEdit: true },
    })

    expect(result.contextText).toContain("Current conversation")
    expect(result.contextText).toContain("水印放右下角")
  })

  test("marks current uploaded images as the primary edit target in context_text", () => {
    const result = buildImageGenerationContext({
      text: "改成 gitee 风格",
      snippets: [],
      contextItems: [],
      messages: [assistant("msg_1")],
      partsByMessage: {
        msg_1: [textPart("msg_1", "上一张图是在线题库红色页面。"), imagePart("msg_1", "data:image/png;base64,old")],
      },
      currentImages: [{ type: "image", id: "img", filename: "uploaded.png", mime: "image/png", dataUrl: "data:image/png;base64,current" }],
      intent: { enabled: true, source: "auto", isEdit: true, wantsPreviousImage: true },
    })

    expect(result.contextText).toContain("Current uploaded images (primary edit target")
    expect(result.contextText).toContain("uploaded.png")
    expect(result.contextText).toContain("Current conversation")
    expect(result.inputImages).toEqual([
      { data_url: "data:image/png;base64,current", mime: "image/png", filename: "uploaded.png" },
    ])
  })

  test("filters Chinese image generation placeholders from recent conversation", () => {
    const result = buildImageGenerationContext({
      text: "按刚才的风格再生成一张",
      snippets: [],
      contextItems: [],
      messages: [assistant("msg_1"), user("msg_2")],
      partsByMessage: {
        msg_1: [textPart("msg_1", "正在生成更细致的图片")],
        msg_2: [textPart("msg_2", "画面要更明亮")],
      },
      currentImages: [],
      intent: { enabled: true, source: "auto" },
    })

    expect(result.contextText).toContain("画面要更明亮")
    expect(result.contextText).not.toContain("正在生成更细致的图片")
  })

  test("filters ignored text parts from recent conversation", () => {
    const result = buildImageGenerationContext({
      text: "生成个图片",
      snippets: [],
      contextItems: [],
      messages: [assistant("msg_1"), user("msg_2")],
      partsByMessage: {
        msg_1: [ignoredTextPart("msg_1", "问题已忽略")],
        msg_2: [textPart("msg_2", "做成选择题卡片")],
      },
      currentImages: [],
      intent: { enabled: true, source: "auto" },
    })

    expect(result.contextText).toContain("做成选择题卡片")
    expect(result.contextText).not.toContain("问题已忽略")
  })

  test("uses current image attachments before historical images", () => {
    const result = buildImageGenerationContext({
      text: "把这张图改成水彩风",
      snippets: [],
      contextItems: [],
      messages: [assistant("msg_1")],
      partsByMessage: {
        msg_1: [imagePart("msg_1", "data:image/png;base64,old")],
      },
      currentImages: [{ type: "image", id: "img", filename: "current.png", mime: "image/png", dataUrl: "data:image/png;base64,current" }],
      intent: { enabled: true, source: "auto", wantsPreviousImage: true },
    })

    expect(result.inputImages).toEqual([
      { data_url: "data:image/png;base64,current", mime: "image/png", filename: "current.png" },
    ])
  })

  test("includes recent generated image only when requested", () => {
    const result = buildImageGenerationContext({
      text: "把上一张图改成赛博朋克风",
      snippets: [],
      contextItems: [],
      messages: [assistant("msg_1")],
      partsByMessage: {
        msg_1: [imagePart("msg_1", "data:image/png;base64,old")],
      },
      currentImages: [],
      intent: { enabled: true, source: "auto", wantsPreviousImage: true },
    })

    expect(result.inputImages).toEqual([
      { data_url: "data:image/png;base64,old", mime: "image/png", filename: "generated.png" },
    ])
  })

  test("carries prior image for visual question-card continuations", () => {
    const result = buildImageGenerationContext({
      text: "再多加几道选择题",
      snippets: [],
      contextItems: [],
      messages: [assistant("msg_1")],
      partsByMessage: {
        msg_1: [
          textPart(
            "msg_1",
            "上一张图是蓝白风格选择题卡片，包含 1-5 题：水的化学式、红色星球、三角形分类。",
          ),
          imagePart("msg_1", "data:image/png;base64,old"),
        ],
      },
      currentImages: [],
      intent: { enabled: true, source: "auto" },
    })

    expect(result.contextText).toContain("Current conversation")
    expect(result.contextText).toContain("蓝白风格选择题卡片")
    expect(result.inputImages).toEqual([
      { data_url: "data:image/png;base64,old", mime: "image/png", filename: "generated.png" },
    ])
  })

  test("includes recent generated http image URLs as edit references", () => {
    const result = buildImageGenerationContext({
      text: "把头像改成匿名头像",
      snippets: [],
      contextItems: [],
      messages: [assistant("msg_1")],
      partsByMessage: {
        msg_1: [imagePart("msg_1", "https://cdn.example.com/generated.png")],
      },
      currentImages: [],
      intent: { enabled: true, source: "auto", wantsPreviousImage: true },
    })

    expect(result.inputImages).toEqual([
      { data_url: "https://cdn.example.com/generated.png", mime: "image/png", filename: "generated.png" },
    ])
  })

  test("uses previous user image attachments when the latest request edits the referenced screenshot", () => {
    const result = buildImageGenerationContext({
      text: "我是让你把我截图给你的那个图片改好看点",
      snippets: [],
      contextItems: [],
      messages: [user("msg_1")],
      partsByMessage: {
        msg_1: [imagePart("msg_1", "https://cdn.example.com/user-upload.png")],
      },
      currentImages: [],
      intent: { enabled: true, source: "auto", wantsPreviousImage: true },
    })

    expect(result.contextText).toContain("Previous chat images")
    expect(result.contextText).toContain("user upload")
    expect(result.inputImages).toEqual([
      { data_url: "https://cdn.example.com/user-upload.png", mime: "image/png", filename: "generated.png" },
    ])
  })

  test("does not use previous user image attachments for non-visual follow-ups", () => {
    const result = buildImageGenerationContext({
      text: "谢谢",
      snippets: [],
      contextItems: [],
      messages: [user("msg_1")],
      partsByMessage: {
        msg_1: [imagePart("msg_1", "https://cdn.example.com/user-upload.png")],
      },
      currentImages: [],
      intent: { enabled: true, source: "auto" },
    })

    expect(result.inputImages).toEqual([])
    expect(result.contextText ?? "").not.toContain("Previous chat images")
  })

  test("carries all historical assistant images by default", () => {
    const result = buildImageGenerationContext({
      text: "水上停个航母",
      snippets: [],
      contextItems: [],
      messages: [assistant("msg_1"), assistant("msg_2"), assistant("msg_3")],
      partsByMessage: {
        msg_1: [imagePart("msg_1", "data:image/png;base64,first")],
        msg_2: [imagePart("msg_2", "data:image/png;base64,second")],
        msg_3: [imagePart("msg_3", "data:image/png;base64,third")],
      },
      currentImages: [],
      intent: { enabled: true, source: "auto", wantsPreviousImage: true },
    })

    expect(result.inputImages).toEqual([
      { data_url: "data:image/png;base64,third", mime: "image/png", filename: "generated.png" },
      { data_url: "data:image/png;base64,second", mime: "image/png", filename: "generated.png" },
      { data_url: "data:image/png;base64,first", mime: "image/png", filename: "generated.png" },
    ])
  })

  test("carries the entire session conversation, not just the last few messages", () => {
    const messages: Message[] = []
    const partsByMessage: Record<string, Part[]> = {}
    for (let i = 1; i <= 20; i++) {
      const id = `msg_${i}`
      const msg = i % 2 === 1 ? user(id) : assistant(id)
      messages.push(msg)
      partsByMessage[id] = [textPart(id, `第${i}条会话内容标记`)]
    }

    const result = buildImageGenerationContext({
      text: "给我图片",
      snippets: [],
      contextItems: [],
      messages,
      partsByMessage,
      currentImages: [],
      intent: { enabled: true, source: "auto" },
    })

    // 最早与最近的会话都应保留（不再只取最近 6 条）
    expect(result.contextText).toContain("第1条会话内容标记")
    expect(result.contextText).toContain("第20条会话内容标记")
    expect(result.contextText).toContain("Current conversation")
  })

  test("keeps long generation context intact unless a caller cap is requested", () => {
    const messages: Message[] = []
    const partsByMessage: Record<string, Part[]> = {}
    // 图片执行上下文默认使用当前会话上下文；只有显式调用方传上限时才裁剪。
    for (let i = 1; i <= 30; i++) {
      const id = `msg_${i}`
      messages.push(i % 2 === 1 ? user(id) : assistant(id))
      partsByMessage[id] = [textPart(id, `标记${i}-` + "填充".repeat(330))]
    }

    const result = buildImageGenerationContext({
      text: "给我图片",
      snippets: [],
      contextItems: [],
      messages,
      partsByMessage,
      currentImages: [],
      intent: { enabled: true, source: "auto" },
    })

    expect(result.contextText).toContain("标记1-")
    expect(result.contextText).toContain("标记30-")
    expect(result.contextText).not.toContain("earlier truncated")
  })

  test("caps image generation context while retaining compacted head and latest tail", () => {
    const messages: Message[] = []
    const partsByMessage: Record<string, Part[]> = {}
    for (let i = 1; i <= 24; i++) {
      const id = `msg_${i}`
      messages.push(i % 2 === 1 ? user(id) : assistant(id))
      partsByMessage[id] = [
        textPart(
          id,
          i === 1
            ? `压缩摘要头部：上一轮已经生成蓝白选择题卡片。${"头部".repeat(260)}`
            : i === 24
              ? `最新尾部：用户现在要求继续加题并保持卡片风格。${"尾部".repeat(260)}`
              : `中间历史${i}-` + "填充".repeat(260),
        ),
      ]
    }

    const result = buildImageGenerationContext({
      text: "再多加几道选择题",
      snippets: [],
      contextItems: [],
      messages,
      partsByMessage,
      currentImages: [],
      intent: { enabled: true, source: "auto" },
      maxContextTextChars: 1_400,
    })

    expect(result.contextText?.length).toBeLessThanOrEqual(1_400)
    expect(result.contextText).toContain("压缩摘要头部")
    expect(result.contextText).toContain("最新尾部")
    expect(result.contextText).toContain("Middle context omitted for image generation context")
  })
})
