import { describe, expect, test } from "bun:test"
import { APICallError } from "ai"
import { MessageV2 } from "../../src/session/message-v2"
import { ProviderTransform } from "@/provider/transform"
import type { Provider } from "@/provider/provider"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { SessionID, MessageID, PartID } from "../../src/session/schema"
import { Question } from "../../src/question"

const sessionID = SessionID.make("session")
const providerID = ProviderID.make("test")
const model: Provider.Model = {
  id: ModelID.make("test-model"),
  providerID,
  api: {
    id: "test-model",
    url: "https://example.com",
    npm: "@ai-sdk/openai",
  },
  name: "Test Model",
  capabilities: {
    temperature: true,
    reasoning: false,
    attachment: false,
    toolcall: true,
    input: {
      text: true,
      audio: false,
      image: false,
      video: false,
      pdf: false,
    },
    output: {
      text: true,
      audio: false,
      image: false,
      video: false,
      pdf: false,
    },
    interleaved: false,
  },
  cost: {
    input: 0,
    output: 0,
    cache: {
      read: 0,
      write: 0,
    },
  },
  limit: {
    context: 0,
    input: 0,
    output: 0,
  },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
}

function userInfo(id: string): MessageV2.User {
  return {
    id,
    sessionID,
    role: "user",
    time: { created: 0 },
    agent: "user",
    model: { providerID, modelID: ModelID.make("test") },
    tools: {},
    mode: "",
  } as unknown as MessageV2.User
}

function assistantInfo(
  id: string,
  parentID: string,
  error?: MessageV2.Assistant["error"],
  meta?: { providerID: string; modelID: string },
): MessageV2.Assistant {
  const infoModel = meta ?? { providerID: model.providerID, modelID: model.api.id }
  return {
    id,
    sessionID,
    role: "assistant",
    time: { created: 0 },
    error,
    parentID,
    modelID: infoModel.modelID,
    providerID: infoModel.providerID,
    mode: "",
    agent: "agent",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
  } as unknown as MessageV2.Assistant
}

function basePart(messageID: string, id: string) {
  return {
    id: PartID.make(id),
    sessionID,
    messageID: MessageID.make(messageID),
  }
}

describe("session.message-v2 text phase", () => {
  test("accepts official commentary and final_answer phases", () => {
    const commentary = MessageV2.TextPart.zod.parse({
      ...basePart("msg_assistant", "prt_commentary"),
      type: "text",
      text: "正在检查",
      phase: "commentary",
    })
    const finalAnswer = MessageV2.TextPart.zod.parse({
      ...basePart("msg_assistant", "prt_final"),
      type: "text",
      text: "检查完成",
      phase: "final_answer",
    })

    // phase 是官方 agentMessage 展示契约，必须经过持久化 schema 原样保留。
    expect(commentary.phase).toBe("commentary")
    expect(finalAnswer.phase).toBe("final_answer")
  })

  test("rejects unknown text phases", () => {
    const parsed = MessageV2.TextPart.zod.safeParse({
      ...basePart("msg_assistant", "prt_invalid"),
      type: "text",
      text: "invalid",
      phase: "analysis",
    })

    // 未知值不能静默进入最终区，否则后续新增协议会被当前客户端错误归类。
    expect(parsed.success).toBe(false)
  })
})

describe("session.message-v2.toModelMessage", () => {
  test("filters out messages with no parts", async () => {
    const input: MessageV2.WithParts[] = [
      {
        info: userInfo("m-empty"),
        parts: [],
      },
      {
        info: userInfo("m-user"),
        parts: [
          {
            ...basePart("m-user", "p1"),
            type: "text",
            text: "hello",
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "hello" }],
      },
    ])
  })

  test("filters out messages with only ignored parts", async () => {
    const messageID = "m-user"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(messageID),
        parts: [
          {
            ...basePart(messageID, "p1"),
            type: "text",
            text: "ignored",
            ignored: true,
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([])
  })

  test("includes synthetic text parts", async () => {
    const messageID = "m-user"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(messageID),
        parts: [
          {
            ...basePart(messageID, "p1"),
            type: "text",
            text: "hello",
            synthetic: true,
          },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo("m-assistant", messageID),
        parts: [
          {
            ...basePart("m-assistant", "a1"),
            type: "text",
            text: "assistant",
            synthetic: true,
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "hello" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "assistant" }],
      },
    ])
  })

  test("replays an inferred text phase through provider options", async () => {
    const userID = "m-user-phase-replay"
    const assistantID = "m-assistant-phase-replay"
    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [{ ...basePart(userID, "u-phase"), type: "text", text: "continue" }] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a-phase"),
            type: "text",
            text: "正在检查",
            phase: "commentary",
          },
        ] as MessageV2.Part[],
      },
    ]

    // 网关未在 wire metadata 中返回 phase 时，processor 的兼容推断也必须进入下一轮模型回放。
    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([
      { role: "user", content: [{ type: "text", text: "continue" }] },
      {
        role: "assistant",
        content: [{ type: "text", text: "正在检查", providerOptions: { openai: { phase: "commentary" } } }],
      },
    ])
  })

  test("handles arbitrary text metadata while replaying an inferred phase", async () => {
    const userID = "m-user-phase-metadata"
    const assistantID = "m-assistant-phase-metadata"
    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [{ ...basePart(userID, "u-phase-metadata"), type: "text", text: "continue" }] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a-phase-metadata"),
            type: "text",
            text: "正在检查",
            phase: "commentary",
            metadata: { nullable: null, source: "gateway" },
          },
        ] as MessageV2.Part[],
      },
    ]

    // metadata 是开放结构；非对象值不能让 phase 检测抛错，AI SDK 仍按既有契约过滤无效 provider 项。
    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([
      { role: "user", content: [{ type: "text", text: "continue" }] },
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "正在检查",
            providerOptions: { openai: { phase: "commentary" } },
          },
        ],
      },
    ])
  })

  test("keeps an explicit provider phase ahead of the inferred text phase", async () => {
    const userID = "m-user-explicit-phase"
    const assistantID = "m-assistant-explicit-phase"
    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [{ ...basePart(userID, "u-explicit-phase"), type: "text", text: "continue" }] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a-explicit-phase"),
            type: "text",
            text: "最终回复",
            phase: "commentary",
            metadata: { openai: { itemId: "msg_explicit", phase: "final_answer" } },
          },
        ] as MessageV2.Part[],
      },
    ]

    // wire metadata 是 provider 的权威结果，兼容推断只能补缺，不能把显式 final_answer 改回 commentary。
    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([
      { role: "user", content: [{ type: "text", text: "continue" }] },
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "最终回复",
            providerOptions: { openai: { itemId: "msg_explicit", phase: "final_answer" } },
          },
        ],
      },
    ])
  })

  test("converts user text/file parts and injects compaction/subtask prompts", async () => {
    const messageID = "m-user"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(messageID),
        parts: [
          {
            ...basePart(messageID, "p1"),
            type: "text",
            text: "hello",
          },
          {
            ...basePart(messageID, "p2"),
            type: "text",
            text: "ignored",
            ignored: true,
          },
          {
            ...basePart(messageID, "p3"),
            type: "file",
            mime: "image/png",
            filename: "img.png",
            url: "https://example.com/img.png",
          },
          {
            ...basePart(messageID, "p4"),
            type: "file",
            mime: "text/plain",
            filename: "note.txt",
            url: "https://example.com/note.txt",
          },
          {
            ...basePart(messageID, "p5"),
            type: "file",
            mime: "application/x-directory",
            filename: "dir",
            url: "https://example.com/dir",
          },
          {
            ...basePart(messageID, "p6"),
            type: "compaction",
            auto: true,
          },
          {
            ...basePart(messageID, "p7"),
            type: "subtask",
            prompt: "prompt",
            description: "desc",
            agent: "agent",
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "hello" },
          {
            type: "file",
            mediaType: "image/png",
            filename: "img.png",
            data: "https://example.com/img.png",
          },
          { type: "text", text: "What did we do so far?" },
          { type: "text", text: "The following tool was executed by the user" },
        ],
      },
    ])
  })

  test("downgrades local file image URLs before sending model messages", async () => {
    const messageID = "m-user-local-image"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(messageID),
        parts: [
          {
            ...basePart(messageID, "p1-local-image"),
            type: "text",
            text: "continue",
          },
          {
            ...basePart(messageID, "p2-local-image"),
            type: "file",
            mime: "image/png",
            filename: "generated.png",
            url: "file:///tmp/generated.png",
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "continue" },
          { type: "text", text: "[Attached image/png: generated.png]" },
        ],
      },
    ])
  })

  test("converts assistant tool completion into tool-call + tool-result messages with attachments", async () => {
    const userID = "m-user"
    const assistantID = "m-assistant"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1"),
            type: "text",
            text: "run tool",
          },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "text",
            text: "done",
            metadata: { openai: { assistant: "meta" } },
          },
          {
            ...basePart(assistantID, "a2"),
            type: "tool",
            callID: "call-1",
            tool: "bash",
            state: {
              status: "completed",
              input: { cmd: "ls" },
              output: "ok",
              title: "Bash",
              metadata: {},
              time: { start: 0, end: 1 },
              attachments: [
                {
                  ...basePart(assistantID, "file-1"),
                  type: "file",
                  mime: "image/png",
                  filename: "attachment.png",
                  url: "data:image/png;base64,Zm9v",
                },
              ],
            },
            metadata: { openai: { tool: "meta" } },
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "run tool" }],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "done", providerOptions: { openai: { assistant: "meta" } } },
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "bash",
            input: { cmd: "ls" },
            providerExecuted: undefined,
            providerOptions: { openai: { tool: "meta" } },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "bash",
            output: {
              type: "content",
              value: [
                { type: "text", text: "ok" },
                { type: "media", mediaType: "image/png", data: "Zm9v" },
              ],
            },
            providerOptions: { openai: { tool: "meta" } },
          },
        ],
      },
    ])
  })

  test("downgrades local file image URLs extracted from tool results", async () => {
    const userID = "m-user-tool-local-image"
    const assistantID = "m-assistant-tool-local-image"
    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1-tool-local-image"),
            type: "text",
            text: "continue editing",
          },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1-tool-local-image"),
            type: "tool",
            callID: "call-local-image",
            tool: "image_generation",
            state: {
              status: "completed",
              input: { prompt: "fish" },
              output: "Generated 1 image.",
              title: "Generated 1 image",
              metadata: {},
              time: { start: 0, end: 1 },
              attachments: [
                {
                  ...basePart(assistantID, "file-local-image"),
                  type: "file",
                  mime: "image/png",
                  filename: "generated.png",
                  url: "file:///tmp/generated.png",
                },
              ],
            },
          },
        ] as MessageV2.Part[],
      },
    ]

    const result = await MessageV2.toModelMessages(input, model)

    expect(JSON.stringify(result)).not.toContain("file://")
    expect(result).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "continue editing" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-local-image",
            toolName: "image_generation",
            input: { prompt: "fish" },
            providerExecuted: undefined,
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-local-image",
            toolName: "image_generation",
            output: {
              type: "content",
              value: [{ type: "text", text: "Generated 1 image." }],
            },
          },
        ],
      },
    ])
  })

  test("preserves jpeg tool-result media for anthropic models", async () => {
    const anthropicModel: Provider.Model = {
      ...model,
      id: ModelID.make("anthropic/claude-opus-4-7"),
      providerID: ProviderID.make("anthropic"),
      api: {
        id: "claude-opus-4-7-20250805",
        url: "https://api.anthropic.com",
        npm: "@ai-sdk/anthropic",
      },
      capabilities: {
        ...model.capabilities,
        attachment: true,
        input: {
          ...model.capabilities.input,
          image: true,
          pdf: true,
        },
      },
    }
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]).toString(
      "base64",
    )
    const userID = "m-user-anthropic"
    const assistantID = "m-assistant-anthropic"
    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1-anthropic"),
            type: "text",
            text: "run tool",
          },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1-anthropic"),
            type: "tool",
            callID: "call-anthropic-1",
            tool: "read",
            state: {
              status: "completed",
              input: { filePath: "/tmp/rails-demo.png" },
              output: "Image read successfully",
              title: "Read",
              metadata: {},
              time: { start: 0, end: 1 },
              attachments: [
                {
                  ...basePart(assistantID, "file-anthropic-1"),
                  type: "file",
                  mime: "image/jpeg",
                  filename: "rails-demo.png",
                  url: `data:image/jpeg;base64,${jpeg}`,
                },
              ],
            },
          },
        ] as MessageV2.Part[],
      },
    ]

    const result = ProviderTransform.message(await MessageV2.toModelMessages(input, anthropicModel), anthropicModel, {})
    expect(result).toHaveLength(3)
    expect(result[2].role).toBe("tool")
    expect(result[2].content[0]).toMatchObject({
      type: "tool-result",
      toolCallId: "call-anthropic-1",
      toolName: "read",
      output: {
        type: "content",
        value: [
          { type: "text", text: "Image read successfully" },
          { type: "media", mediaType: "image/jpeg", data: jpeg },
        ],
      },
    })
  })

  test("omits provider metadata when assistant model differs", async () => {
    const userID = "m-user"
    const assistantID = "m-assistant"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1"),
            type: "text",
            text: "run tool",
          },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID, userID, undefined, { providerID: "other", modelID: "other" }),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "text",
            text: "done",
            metadata: { openai: { assistant: "meta" } },
          },
          {
            ...basePart(assistantID, "a2"),
            type: "reasoning",
            text: "thinking",
            metadata: { openai: { reasoning: "meta" } },
            time: { start: 0 },
          },
          {
            ...basePart(assistantID, "a3"),
            type: "tool",
            callID: "call-1",
            tool: "bash",
            state: {
              status: "completed",
              input: { cmd: "ls" },
              output: "ok",
              title: "Bash",
              metadata: {},
              time: { start: 0, end: 1 },
            },
            metadata: { openai: { tool: "meta" } },
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "run tool" }],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "done" },
          { type: "text", text: "thinking" },
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "bash",
            input: { cmd: "ls" },
            providerExecuted: undefined,
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "bash",
            output: { type: "text", value: "ok" },
          },
        ],
      },
    ])
  })

  test("omits empty/whitespace reasoning parts for same model", async () => {
    const userID = "m-user"
    const assistantID = "m-assistant"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [{ ...basePart(userID, "u1"), type: "text", text: "hi" }] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          { ...basePart(assistantID, "a1"), type: "reasoning", text: "", time: { start: 0 } },
          { ...basePart(assistantID, "a2"), type: "reasoning", text: "   ", time: { start: 0 } },
          {
            ...basePart(assistantID, "a3"),
            type: "reasoning",
            text: "真实思考",
            metadata: { openai: { r: "m" } },
            time: { start: 0 },
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        content: [{ type: "reasoning", text: "真实思考", providerOptions: { openai: { r: "m" } } }],
      },
    ])
  })

  test("strips non-object metadata (e.g. originalText) from reasoning providerOptions", async () => {
    const userID = "m-user"
    const assistantID = "m-assistant"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [{ ...basePart(userID, "u1"), type: "text", text: "hi" }] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "reasoning",
            text: "翻译后的中文",
            metadata: { originalText: "english", openai: { keep: "me" } },
            time: { start: 0 },
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        content: [{ type: "reasoning", text: "翻译后的中文", providerOptions: { openai: { keep: "me" } } }],
      },
    ])
  })

  test("strips skill display metadata from providerOptions", async () => {
    const userID = "m-user"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1"),
            type: "text",
            text: "# Skill\n\nUse this workflow.",
            metadata: {
              skill: { name: "skill-creator", location: "/Users/developer/.codex/skills/skill-creator/SKILL.md" },
              openai: { keep: "me" },
            },
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "# Skill\n\nUse this workflow." }],
      },
    ])
  })

  test("replays signed original reasoning, not the translation", async () => {
    const userID = "m-user"
    const assistantID = "m-assistant"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [{ ...basePart(userID, "u1"), type: "text", text: "hi" }] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "reasoning",
            // text 是 UI 展示用的译文；originalText 是模型产出的带签名英文原文
            text: "翻译后的中文",
            originalText: "let me inspect the files",
            metadata: { anthropic: { signature: "sig-abc" } },
            time: { start: 0 },
          },
        ] as MessageV2.Part[],
      },
    ]

    // 回放给模型的必须是 originalText（与 signature 匹配），而非译文；
    // 否则签名与内容不符 → 思考块被丢 → interleaved 下 Anthropic 持续 400（断线）。
    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        content: [
          {
            type: "reasoning",
            text: "let me inspect the files",
            providerOptions: { anthropic: { signature: "sig-abc" } },
          },
        ],
      },
    ])
  })

  test("replays a legitimate repeated reasoning block without content-shape trimming", async () => {
    const userID = "m-user-replayed-reasoning"
    const assistantID = "m-assistant-replayed-reasoning"
    const reasoning = "inspect the context, tools, and remaining work.\n".repeat(120)
    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [{ ...basePart(userID, "u1-replayed-reasoning"), type: "text", text: "continue" }] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1-replayed-reasoning"),
            type: "reasoning",
            text: reasoning + reasoning,
            time: { start: 0, end: 1 },
          },
        ] as MessageV2.Part[],
      },
    ]

    // H+H 也可能是模型有意生成的合法正文；没有 provider replay 标记时，回放上下文必须逐字保留。
    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([
      { role: "user", content: [{ type: "text", text: "continue" }] },
      {
        role: "assistant",
        content: [{ type: "reasoning", text: reasoning + reasoning, providerOptions: undefined }],
      },
    ])
  })

  test("drops assistant message left with only step-start after empty text removed", async () => {
    const userID = "m-user"
    const assistantID = "m-assistant"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [{ ...basePart(userID, "u1"), type: "text", text: "hi" }] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          { ...basePart(assistantID, "a1"), type: "step-start" },
          { ...basePart(assistantID, "a2"), type: "text", text: "" },
        ] as MessageV2.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ])
  })

  test("replaces compacted tool output with placeholder", async () => {
    const userID = "m-user"
    const assistantID = "m-assistant"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1"),
            type: "text",
            text: "run tool",
          },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "tool",
            callID: "call-1",
            tool: "bash",
            state: {
              status: "completed",
              input: { cmd: "ls" },
              output: "this should be cleared",
              title: "Bash",
              metadata: {},
              time: { start: 0, end: 1, compacted: 1 },
            },
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "run tool" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "bash",
            input: { cmd: "ls" },
            providerExecuted: undefined,
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "bash",
            output: { type: "text", value: "[Old tool result content cleared]" },
          },
        ],
      },
    ])
  })

  test("truncates tool output when requested", async () => {
    const userID = "m-user"
    const assistantID = "m-assistant"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1"),
            type: "text",
            text: "run tool",
          },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "tool",
            callID: "call-1",
            tool: "bash",
            state: {
              status: "completed",
              input: { cmd: "ls" },
              output: "abcdefghij",
              title: "Shell",
              metadata: {},
              time: { start: 0, end: 1 },
            },
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model, { toolOutputMaxChars: 4 })).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "run tool" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "bash",
            input: { cmd: "ls" },
            providerExecuted: undefined,
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "bash",
            output: {
              type: "text",
              value: "abcd\n[Tool output truncated for compaction: omitted 6 chars]",
            },
          },
        ],
      },
    ])
  })

  test("converts assistant tool error into error-text tool result", async () => {
    const userID = "m-user"
    const assistantID = "m-assistant"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1"),
            type: "text",
            text: "run tool",
          },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "tool",
            callID: "call-1",
            tool: "bash",
            state: {
              status: "error",
              input: { cmd: "ls" },
              error: "nope",
              time: { start: 0, end: 1 },
              metadata: {},
            },
            metadata: { openai: { tool: "meta" } },
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "run tool" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "bash",
            input: { cmd: "ls" },
            providerExecuted: undefined,
            providerOptions: { openai: { tool: "meta" } },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "bash",
            output: { type: "error-text", value: "nope" },
            providerOptions: { openai: { tool: "meta" } },
          },
        ],
      },
    ])
  })

  test("forwards partial bash output for aborted tool calls", async () => {
    const userID = "m-user"
    const assistantID = "m-assistant"
    const output = [
      "31403",
      "12179",
      "4575",
      "",
      "<shell_metadata>",
      "User aborted the command",
      "</shell_metadata>",
    ].join("\n")

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1"),
            type: "text",
            text: "run tool",
          },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "tool",
            callID: "call-1",
            tool: "bash",
            state: {
              status: "error",
              input: { command: "for i in {1..20}; do print -- $RANDOM; sleep 1; done" },
              error: "Tool execution aborted",
              metadata: { interrupted: true, output },
              time: { start: 0, end: 1 },
            },
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "run tool" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "bash",
            input: { command: "for i in {1..20}; do print -- $RANDOM; sleep 1; done" },
            providerExecuted: undefined,
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "bash",
            output: { type: "text", value: output },
          },
        ],
      },
    ])
  })

  test("interrupted tool call with no output reads as a non-failure note", async () => {
    const userID = "m-user"
    const assistantID = "m-assistant"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [{ ...basePart(userID, "u1"), type: "text", text: "explore" }] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "tool",
            callID: "call-1",
            tool: "read",
            // 用户暂停/停止打断了这次工具调用：processor cleanup 会落成
            // status error + interrupted，但没有 output。
            state: {
              status: "error",
              input: { filePath: "game.js" },
              error: "Tool execution aborted",
              metadata: { interrupted: true },
              time: { start: 0, end: 1 },
            },
          },
        ] as MessageV2.Part[],
      },
    ]

    const messages = await MessageV2.toModelMessages(input, model)
    const toolMsg = messages.find((m) => m.role === "tool")
    expect(toolMsg).toBeDefined()
    const result = (toolMsg!.content as any[])[0]
    // 关键：不能是 error 态，否则模型会以为工具坏了；文本必须点明这是被打断、非失败。
    expect(result.output.type).not.toBe("error-text")
    const text = result.output.type === "text" ? result.output.value : JSON.stringify(result.output)
    expect(text.toLowerCase()).toContain("interrupt")
    expect(text).not.toBe("Tool execution aborted")
  })

  test("filters assistant messages with non-abort errors", async () => {
    const assistantID = "m-assistant"

    const input: MessageV2.WithParts[] = [
      {
        info: assistantInfo(
          assistantID,
          "m-parent",
          new MessageV2.APIError({ message: "boom", isRetryable: true }).toObject() as MessageV2.APIError,
        ),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "text",
            text: "should not render",
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([])
  })

  test("preserves partial aborted output and adds a model-visible interruption boundary", async () => {
    const assistantID1 = "m-assistant-1"
    const assistantID2 = "m-assistant-2"

    const aborted = new MessageV2.AbortedError({ message: "aborted" }).toObject() as MessageV2.Assistant["error"]

    const input: MessageV2.WithParts[] = [
      {
        info: assistantInfo(assistantID1, "m-parent", aborted),
        parts: [
          {
            ...basePart(assistantID1, "a1"),
            type: "reasoning",
            text: "thinking",
            time: { start: 0 },
          },
          {
            ...basePart(assistantID1, "a2"),
            type: "text",
            text: "partial answer",
          },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID2, "m-parent", aborted),
        // 停止在下一条 assistant 创建前命中时，服务端会留下没有 part 的终态 tombstone。
        parts: [],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "thinking", providerOptions: undefined },
          { type: "text", text: "partial answer" },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `<turn_aborted>
The user interrupted the previous turn on purpose. Any running unified exec processes may still be running in the background. If any tools/commands were aborted, they may have partially executed.
</turn_aborted>`,
          },
        ],
      },
    ])
  })

  test("preserves OpenRouter reasoning details through provider transform", async () => {
    const assistantID = "m-assistant"
    const openrouterModel: Provider.Model = {
      ...model,
      id: ModelID.make("deepseek/deepseek-v4-pro"),
      providerID: ProviderID.make("openrouter"),
      api: {
        id: "deepseek/deepseek-v4-pro",
        url: "https://openrouter.ai/api/v1",
        npm: "@openrouter/ai-sdk-provider",
      },
      capabilities: {
        ...model.capabilities,
        reasoning: true,
        interleaved: { field: "reasoning_details" },
      },
    }
    const reasoningDetails = [
      {
        type: "reasoning.text",
        text: "thinking",
        format: "unknown",
        index: 0,
      },
    ]
    const input: MessageV2.WithParts[] = [
      {
        info: assistantInfo(assistantID, "m-parent", undefined, {
          providerID: openrouterModel.providerID,
          modelID: openrouterModel.id,
        }),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "reasoning",
            text: "thinking",
            time: { start: 0 },
            metadata: {
              openrouter: {
                reasoning_details: reasoningDetails,
              },
            },
          },
          {
            ...basePart(assistantID, "a2"),
            type: "text",
            text: "answer",
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(
      ProviderTransform.message(await MessageV2.toModelMessages(input, openrouterModel), openrouterModel, {}),
    ).toStrictEqual([
      {
        role: "assistant",
        content: [
          {
            type: "reasoning",
            text: "thinking",
            providerOptions: {
              openrouter: {
                reasoning_details: reasoningDetails,
              },
            },
          },
          { type: "text", text: "answer" },
        ],
      },
    ])
  })

  test("splits assistant messages on step-start boundaries", async () => {
    const assistantID = "m-assistant"

    const input: MessageV2.WithParts[] = [
      {
        info: assistantInfo(assistantID, "m-parent"),
        parts: [
          {
            ...basePart(assistantID, "p1"),
            type: "text",
            text: "first",
          },
          {
            ...basePart(assistantID, "p2"),
            type: "step-start",
          },
          {
            ...basePart(assistantID, "p3"),
            type: "text",
            text: "second",
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "assistant",
        content: [{ type: "text", text: "first" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "second" }],
      },
    ])
  })

  test("drops messages that only contain step-start parts", async () => {
    const assistantID = "m-assistant"

    const input: MessageV2.WithParts[] = [
      {
        info: assistantInfo(assistantID, "m-parent"),
        parts: [
          {
            ...basePart(assistantID, "p1"),
            type: "step-start",
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([])
  })

  test("pairs dangling pending/running tool calls with a non-failure interruption note", async () => {
    const userID = "m-user"
    const assistantID = "m-assistant"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1"),
            type: "text",
            text: "run tool",
          },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "tool",
            callID: "call-pending",
            tool: "bash",
            state: {
              status: "pending",
              input: { cmd: "ls" },
              raw: "",
            },
          },
          {
            ...basePart(assistantID, "a2"),
            type: "tool",
            callID: "call-running",
            tool: "read",
            state: {
              status: "running",
              input: { path: "/tmp" },
              time: { start: 0 },
            },
          },
        ] as MessageV2.Part[],
      },
    ]

    const result = await MessageV2.toModelMessages(input, model)

    expect(result).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "run tool" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-pending",
            toolName: "bash",
            input: { cmd: "ls" },
            providerExecuted: undefined,
          },
          {
            type: "tool-call",
            toolCallId: "call-running",
            toolName: "read",
            input: { path: "/tmp" },
            providerExecuted: undefined,
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-pending",
            toolName: "bash",
            output: {
              type: "text",
              value:
                "This tool call was interrupted before it finished, so it produced no result. This is not a tool failure — continue normally, and re-run the call only if its result is still needed.",
            },
          },
          {
            type: "tool-result",
            toolCallId: "call-running",
            toolName: "read",
            output: {
              type: "text",
              value:
                "This tool call was interrupted before it finished, so it produced no result. This is not a tool failure — continue normally, and re-run the call only if its result is still needed.",
            },
          },
        ],
      },
    ])
  })

  test("omits large media attachments from interrupted tool output", async () => {
    const userID = "m-user"
    const assistantID = "m-assistant"
    const largeData = "a".repeat(11_000_000)

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1"),
            type: "text",
            text: "generate images",
          },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "tool",
            callID: "call-1",
            tool: "image_generation",
            state: {
              status: "error",
              input: { prompt: "cat", n: 8 },
              error: "Tool execution aborted",
              metadata: { interrupted: true },
              time: { start: 0, end: 1 },
              attachments: [
                {
                  ...basePart(assistantID, "file-1"),
                  type: "file",
                  mime: "image/png",
                  filename: "image.png",
                  url: `data:image/png;base64,${largeData}`,
                },
              ],
            },
          },
        ] as MessageV2.Part[],
      },
    ]

    const result = await MessageV2.toModelMessages(input, model)

    expect(JSON.stringify(result).includes(largeData)).toBe(false)
    expect(result).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "generate images" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "image_generation",
            input: { prompt: "cat", n: 8 },
            providerExecuted: undefined,
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "image_generation",
            output: { type: "text", value: "Tool execution interrupted after producing 1 attachment(s)." },
          },
        ],
      },
    ])
  })
})

describe("session.message-v2.fromError", () => {
  test("serializes context_length_exceeded as ContextOverflowError", () => {
    const input = {
      type: "error",
      error: {
        code: "context_length_exceeded",
      },
    }
    const result = MessageV2.fromError(input, { providerID })

    expect(result).toStrictEqual({
      name: "ContextOverflowError",
      data: {
        message: "Input exceeds context window of this model",
        responseBody: JSON.stringify(input),
      },
    })
  })

  test("serializes response error codes", () => {
    const cases = [
      {
        code: "insufficient_quota",
        message: "Quota exceeded. Check your plan and billing details.",
      },
      {
        code: "usage_not_included",
        message: "To use Codex with your ChatGPT plan, upgrade to Plus: https://chatgpt.com/explore/plus.",
      },
      {
        code: "invalid_prompt",
        message: "Invalid prompt from test",
      },
    ]

    cases.forEach((item) => {
      const input = {
        type: "error",
        error: {
          code: item.code,
          message: item.code === "invalid_prompt" ? item.message : undefined,
        },
      }
      const result = MessageV2.fromError(input, { providerID })

      expect(result).toStrictEqual({
        name: "APIError",
        data: {
          message: item.message,
          isRetryable: false,
          responseBody: JSON.stringify(input),
        },
      })
    })
  })

  test("serializes OpenAI response server_error stream chunks as retryable APIError", () => {
    const body = {
      type: "error",
      sequence_number: 2,
      error: {
        type: "server_error",
        code: "server_error",
        message:
          "An error occurred while processing your request. You can retry your request, or contact us through our help center at help.openai.com if the error persists. Please include the request ID req_77eccd008d984bf6bf82d1b2c2b68715 in your message.",
        param: null,
      },
    }
    const result = MessageV2.fromError({ message: JSON.stringify(body) }, { providerID })

    expect(result).toStrictEqual({
      name: "APIError",
      data: {
        message: body.error.message,
        isRetryable: true,
        responseBody: JSON.stringify(body),
      },
    })
  })

  test("detects context overflow from APICallError provider messages", () => {
    const cases = [
      "prompt is too long: 213462 tokens > 200000 maximum",
      "Your input exceeds the context window of this model",
      "The input token count (1196265) exceeds the maximum number of tokens allowed (1048575)",
      "Please reduce the length of the messages or completion",
      "400 status code (no body)",
      "413 status code (no body)",
    ]

    cases.forEach((message) => {
      const error = new APICallError({
        message,
        url: "https://example.com",
        requestBodyValues: {},
        statusCode: 400,
        responseHeaders: { "content-type": "application/json" },
        isRetryable: false,
      })
      const result = MessageV2.fromError(error, { providerID })
      expect(MessageV2.ContextOverflowError.isInstance(result)).toBe(true)
    })
  })

  test("detects context overflow from context_length_exceeded code in response body", () => {
    const error = new APICallError({
      message: "Request failed",
      url: "https://example.com",
      requestBodyValues: {},
      statusCode: 422,
      responseHeaders: { "content-type": "application/json" },
      responseBody: JSON.stringify({
        error: {
          message: "Some message",
          type: "invalid_request_error",
          code: "context_length_exceeded",
        },
      }),
      isRetryable: false,
    })
    const result = MessageV2.fromError(error, { providerID })
    expect(MessageV2.ContextOverflowError.isInstance(result)).toBe(true)
  })

  test("does not classify 429 no body as context overflow", () => {
    const result = MessageV2.fromError(
      new APICallError({
        message: "429 status code (no body)",
        url: "https://example.com",
        requestBodyValues: {},
        statusCode: 429,
        responseHeaders: { "content-type": "application/json" },
        isRetryable: false,
      }),
      { providerID },
    )
    expect(MessageV2.ContextOverflowError.isInstance(result)).toBe(false)
    expect(MessageV2.APIError.isInstance(result)).toBe(true)
  })

  test("serializes unknown inputs", () => {
    const result = MessageV2.fromError(123, { providerID })

    expect(result).toStrictEqual({
      name: "UnknownError",
      data: {
        message: "123",
      },
    })
  })

  test("serializes tagged errors with their message", () => {
    const result = MessageV2.fromError(new Question.RejectedError(), { providerID })

    expect(result).toStrictEqual({
      name: "UnknownError",
      data: {
        message: "The user dismissed this question",
      },
    })
  })

  test("classifies ZlibError from fetch as retryable APIError", () => {
    const zlibError = new Error(
      'ZlibError fetching "https://opencode.cloudflare.dev/anthropic/messages". For more information, pass `verbose: true` in the second argument to fetch()',
    )
    ;(zlibError as any).code = "ZlibError"
    ;(zlibError as any).errno = 0
    ;(zlibError as any).path = ""

    const result = MessageV2.fromError(zlibError, { providerID })

    expect(MessageV2.APIError.isInstance(result)).toBe(true)
    expect((result as MessageV2.APIError).data.isRetryable).toBe(true)
    expect((result as MessageV2.APIError).data.message).toInclude("decompression")
  })

  test("classifies ZlibError as AbortedError when abort context is provided", () => {
    const zlibError = new Error(
      'ZlibError fetching "https://opencode.cloudflare.dev/anthropic/messages". For more information, pass `verbose: true` in the second argument to fetch()',
    )
    ;(zlibError as any).code = "ZlibError"
    ;(zlibError as any).errno = 0

    const result = MessageV2.fromError(zlibError, { providerID, aborted: true })

    expect(result.name).toBe("MessageAbortedError")
  })

  test("classifies stream stall as retryable APIError", () => {
    const stallError = new Error("Stream stalled: no SSE chunk for 120000ms")
    ;(stallError as any).code = "STREAM_STALL"

    const result = MessageV2.fromError(stallError, { providerID })

    expect(MessageV2.APIError.isInstance(result)).toBe(true)
    expect((result as MessageV2.APIError).data.isRetryable).toBe(true)
  })

  test("classifies stream stall as AbortedError when user aborted", () => {
    const stallError = new Error("Stream stalled: no SSE chunk for 120000ms")
    ;(stallError as any).code = "STREAM_STALL"

    const result = MessageV2.fromError(stallError, { providerID, aborted: true })

    expect(result.name).toBe("MessageAbortedError")
  })
})

describe("session.message-v2.isQueuedUserMessage", () => {
  const finished = (id: string, parentID: string) =>
    ({ ...assistantInfo(id, parentID), finish: "stop" }) as MessageV2.Assistant
  const inflight = (id: string, parentID: string) =>
    ({ ...assistantInfo(id, parentID), finish: "tool-calls" }) as MessageV2.Assistant
  const isQ = (msgs: MessageV2.WithParts[], id: string) => MessageV2.isQueuedUserMessage(msgs, MessageID.make(id))

  // a(已答:b 终态) → c(在途处理:d 工具循环中) → e,f(排队)
  const running: MessageV2.WithParts[] = [
    { info: userInfo("a"), parts: [] },
    { info: finished("b", "a"), parts: [] },
    { info: userInfo("c"), parts: [] },
    { info: inflight("d", "c"), parts: [] },
    { info: userInfo("e"), parts: [] },
    { info: userInfo("f"), parts: [] },
  ]

  test("在途任务之后的排队消息可撤销", () => {
    expect(isQ(running, "e")).toBe(true)
    expect(isQ(running, "f")).toBe(true)
  })
  test("旧 remote ID 的字典序不影响排队消息判定", () => {
    const parentID = `msg_remote_${"z".repeat(64)}`
    const assistantID = "msg_019f0000000000000000000001"
    const queuedID = "msg_019f0000000000000000000002"
    const msgs: MessageV2.WithParts[] = [
      { info: userInfo(parentID), parts: [] },
      { info: inflight(assistantID, parentID), parts: [] },
      { info: userInfo(queuedID), parts: [] },
    ]

    // queuedID 字典序小于 parentID，但在真实消息数组中位于在途 parent 之后。
    expect(isQ(msgs, queuedID)).toBe(true)
  })
  test("正在处理的消息(在途 assistant 的 parent)不可撤销", () => expect(isQ(running, "c")).toBe(false))
  test("已回答的消息不可撤销", () => expect(isQ(running, "a")).toBe(false))
  test("assistant 消息不可撤销", () => expect(isQ(running, "d")).toBe(false))
  test("不存在的消息返回 false", () => expect(isQ(running, "zzz")).toBe(false))

  // 窗口：新消息已发但 assistant 尚未落库(无在途 assistant) → 当前正在启动处理的消息不可撤销
  test("无在途 assistant 时(处理窗口)当前消息不可撤销", () => {
    expect(
      isQ(
        [
          { info: userInfo("a"), parts: [] },
          { info: finished("b", "a"), parts: [] },
          { info: userInfo("c"), parts: [] }, // 正在启动处理，assistant 未建
        ],
        "c",
      ),
    ).toBe(false)
    // 完全空历史里的首条消息同理
    expect(isQ([{ info: userInfo("z"), parts: [] }], "z")).toBe(false)
  })

  // 完成的工具轮:a(user) → b(tool-calls 步) → c(stop 步)都属 a;之后 d(user)是正在被处理的新回合。
  // 旧实现遍历取「最后一个非 terminal」会命中被 c 取代的历史 tool-calls 步 b(parent a)→ 误判 d 可撤销 →
  // 删除会丢失正在处理的 d。只看最新一条 assistant(c,terminal)后应判定无在途回合 → d 不可撤销。
  test("完成工具轮后正在处理的消息不可撤销(superseded tool-calls 步不算在途)", () => {
    const msgs: MessageV2.WithParts[] = [
      { info: userInfo("a"), parts: [] },
      { info: inflight("b", "a"), parts: [] },
      { info: finished("c", "a"), parts: [] },
      { info: userInfo("d"), parts: [] },
    ]
    expect(isQ(msgs, "d")).toBe(false)
  })
})

describe("sanitizeMessage", () => {
  const mid = MessageID.make("m1")
  const textPart = (id: string, text: string) =>
    ({ id: PartID.make(id), sessionID, messageID: mid, type: "text", text }) as unknown as MessageV2.Part
  const reasoningPart = (id: string, text: string) =>
    ({
      id: PartID.make(id),
      sessionID,
      messageID: mid,
      type: "reasoning",
      text,
      time: { start: 1000, end: 2000 },
    }) as unknown as MessageV2.Part

  test("全部合法 → 原样返回", () => {
    const msg = {
      info: userInfo("m1"),
      parts: [textPart("p1", "hi"), textPart("p2", "yo")],
    } as unknown as MessageV2.WithParts
    // 未命中任何修复规则时保持对象引用，避免历史列表读取产生无意义的整树替换。
    expect(MessageV2.sanitizeMessage(msg)).toBe(msg)
  })

  test("合法长推理严格双份 → 读取时保持原文", () => {
    const reasoning = "逐项检查上下文、工具结果和剩余任务。\n".repeat(300)
    const msg = {
      info: userInfo("m1"),
      parts: [reasoningPart("p1", reasoning + reasoning)],
    } as unknown as MessageV2.WithParts

    // sanitize 只负责 schema 损坏隔离；没有可靠来源标记时不能把重复形状误判为脏数据。
    expect((MessageV2.sanitizeMessage(msg)?.parts[0] as MessageV2.ReasoningPart).text).toBe(reasoning + reasoning)
  })

  test("单条 part 缺必填字段 → 丢弃坏 part、保留其余（[崩溃残留]）", () => {
    const good = textPart("p1", "hi")
    const badMissingText = {
      id: PartID.make("pb"),
      sessionID,
      messageID: mid,
      type: "text",
    } as unknown as MessageV2.Part
    const out = MessageV2.sanitizeMessage({
      info: userInfo("m1"),
      parts: [good, badMissingText],
    } as unknown as MessageV2.WithParts)
    expect(out?.parts).toEqual([good])
  })

  test("未知 part 类型 → 丢弃", () => {
    const good = textPart("p1", "hi")
    const bogus = { id: PartID.make("pb"), sessionID, messageID: mid, type: "bogus" } as unknown as MessageV2.Part
    const out = MessageV2.sanitizeMessage({
      info: userInfo("m1"),
      parts: [bogus, good],
    } as unknown as MessageV2.WithParts)
    expect(out?.parts).toEqual([good])
  })

  test("info 不可编码 → 整条消息丢弃（返回 undefined，避免整会话下发失败）", () => {
    // 小数 time.created 破坏 NonNegativeInt：过滤 part 后整条仍不可编码 → 丢弃
    const badInfo = { ...userInfo("m1"), time: { created: 1000.5 } } as unknown as MessageV2.Info
    expect(
      MessageV2.sanitizeMessage({ info: badInfo, parts: [textPart("p1", "hi")] } as unknown as MessageV2.WithParts),
    ).toBeUndefined()
  })

  test("sanitizeMessages 批量：丢弃不可编码的整条、保留其余", () => {
    const ok = { info: userInfo("m1"), parts: [textPart("p1", "hi")] } as unknown as MessageV2.WithParts
    const badInfo = {
      info: { ...userInfo("m2"), time: { created: 1.5 } },
      parts: [],
    } as unknown as MessageV2.WithParts
    expect(MessageV2.sanitizeMessages([ok, badInfo, ok])).toEqual([ok, ok])
  })
})

describe("compactMessageSummaryDiffs", () => {
  const message = (count: number) =>
    ({
      info: {
        ...userInfo("m1"),
        summary: {
          diffs: Array.from({ length: count }, (_, index) => ({
            file: `src/file-${index}.ts`,
            patch: `patch-${index}`,
            additions: 1,
            deletions: 0,
          })),
        },
      },
      parts: [],
    }) as MessageV2.WithParts

  test("超大摘要仅保留文件元数据且不修改原消息", () => {
    const original = message(121)
    const result = MessageV2.compactMessageSummaryDiffs([original])[0]

    // 返回新 info 供 HTTP 下发，持久化消息仍保留完整 patch，审核接口才能继续读取正文。
    expect(result.info.role === "user" && result.info.summary?.diffs[0]?.patch).toBe("")
    expect(original.info.role === "user" && original.info.summary?.diffs[0]?.patch).toBe("patch-0")
    expect(result.parts).toBe(original.parts)
  })

  test("小摘要和 assistant 消息保持原引用", () => {
    const small = message(120)
    const assistant = { info: assistantInfo("a1", "m1"), parts: [] } as MessageV2.WithParts
    const result = MessageV2.compactMessageSummaryDiffs([small, assistant])

    // 常规会话完全沿用原响应，避免为了性能保护改变小 diff 的行内审核体验。
    expect(result[0]).toBe(small)
    expect(result[1]).toBe(assistant)
  })

  test("文件数少但 patch 总正文过大时同样压缩", () => {
    const original = message(1)
    if (original.info.role !== "user" || !original.info.summary) throw new Error("缺少测试摘要")
    // 现场异常不只可能来自文件数量；单个生成文件也能让 JSON 编码占满主进程内存。
    original.info.summary.diffs[0]!.patch = "x".repeat(512 * 1024 + 1)

    const result = MessageV2.compactMessageSummaryDiffs([original])[0]
    expect(result.info.role === "user" && result.info.summary?.diffs[0]?.patch).toBe("")
    expect(original.info.summary.diffs[0]?.patch.length).toBe(512 * 1024 + 1)
  })

  test("超大文件列表限制下发条数且保留原摘要", () => {
    const original = message(501)
    const result = MessageV2.compactMessageSummaryDiffs([original])[0]

    // 会话总文件数由 session summary 单独记录；消息列表只保留可安全 reconcile 的前 500 条元数据。
    expect(result.info.role === "user" && result.info.summary?.diffs).toHaveLength(500)
    expect(original.info.role === "user" && original.info.summary?.diffs).toHaveLength(501)
  })
})
