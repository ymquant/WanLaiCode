import { describe, expect, test } from "bun:test"
import type { Part } from "@opencode-ai/sdk/v2"
import type { Prompt } from "@/context/prompt"
import { extractPromptFromParts } from "@/utils/prompt"
import { buildRequestParts } from "./build-request-parts"

describe("buildRequestParts", () => {
  test("builds typed request and optimistic parts without cast path", () => {
    const prompt: Prompt = [
      { type: "text", content: "hello", start: 0, end: 5 },
      {
        type: "file",
        path: "src/foo.ts",
        content: "@src/foo.ts",
        start: 5,
        end: 16,
        selection: { startLine: 4, startChar: 1, endLine: 6, endChar: 1 },
      },
      { type: "agent", name: "planner", content: "@planner", start: 16, end: 24 },
    ]

    const result = buildRequestParts({
      prompt,
      context: [{ key: "ctx:1", type: "file", path: "src/bar.ts", comment: "check this" }],
      images: [
        { type: "image", id: "img_1", filename: "a.png", mime: "image/png", dataUrl: "data:image/png;base64,AAA" },
      ],
      text: "hello @src/foo.ts @planner",
      messageID: "msg_1",
      sessionID: "ses_1",
      sessionDirectory: "/repo",
    })

    expect(result.requestParts[0]?.type).toBe("text")
    expect(result.requestParts.some((part) => part.type === "agent")).toBe(true)
    expect(
      result.requestParts.some((part) => part.type === "file" && part.url.startsWith("file:///repo/src/foo.ts")),
    ).toBe(true)
    expect(result.requestParts.some((part) => part.type === "text" && part.synthetic)).toBe(true)
    expect(
      result.requestParts.some(
        (part) =>
          part.type === "text" &&
          part.synthetic &&
          part.metadata?.opencodeComment &&
          (part.metadata.opencodeComment as { comment?: string }).comment === "check this",
      ),
    ).toBe(true)

    expect(result.optimisticParts).toHaveLength(result.requestParts.length)
    expect(result.optimisticParts.every((part) => part.sessionID === "ses_1" && part.messageID === "msg_1")).toBe(true)
  })

  test("adds skill metadata to text parts for optimistic chip rendering", () => {
    const result = buildRequestParts({
      prompt: [
        {
          type: "skill",
          name: "skill-creator",
          location: "/Users/developer/.codex/skills/skill-creator/SKILL.md",
          content: "/skill-creator ",
          start: 0,
          end: 15,
        },
      ],
      context: [],
      images: [],
      text: "/skill-creator ",
      messageID: "msg_skill",
      sessionID: "ses_skill",
      sessionDirectory: "/repo",
    })

    expect(result.requestParts[0]).toMatchObject({
      type: "text",
      metadata: {
        skill: {
          name: "skill-creator",
          location: "/Users/developer/.codex/skills/skill-creator/SKILL.md",
        },
      },
    })
    expect(result.optimisticParts[0]).toMatchObject({
      type: "text",
      metadata: {
        skill: {
          name: "skill-creator",
          location: "/Users/developer/.codex/skills/skill-creator/SKILL.md",
        },
      },
    })
  })

  test("keeps skill arguments visible in optimistic metadata", () => {
    const result = buildRequestParts({
      prompt: [
        {
          type: "skill",
          name: "skill-creator",
          location: "/Users/developer/.codex/skills/skill-creator/SKILL.md",
          content: "/skill-creator ",
          start: 0,
          end: 15,
        },
        { type: "text", content: "update this skill", start: 15, end: 32 },
      ],
      context: [],
      images: [],
      text: "/skill-creator update this skill",
      messageID: "msg_skill_args",
      sessionID: "ses_skill_args",
      sessionDirectory: "/repo",
    })

    expect(result.optimisticParts[0]).toMatchObject({
      type: "text",
      metadata: {
        skill: {
          name: "skill-creator",
          location: "/Users/developer/.codex/skills/skill-creator/SKILL.md",
          arguments: "update this skill",
        },
      },
    })
  })

  test("keeps multiple uploaded attachments in order", () => {
    const result = buildRequestParts({
      prompt: [{ type: "text", content: "check these", start: 0, end: 11 }],
      context: [],
      images: [
        { type: "image", id: "img_1", filename: "a.png", mime: "image/png", dataUrl: "data:image/png;base64,AAA" },
        {
          type: "image",
          id: "img_2",
          filename: "b.pdf",
          mime: "application/pdf",
          dataUrl: "data:application/pdf;base64,BBB",
        },
      ],
      text: "check these",
      messageID: "msg_multi",
      sessionID: "ses_multi",
      sessionDirectory: "/repo",
    })

    const files = result.requestParts.filter((part) => part.type === "file" && part.url.startsWith("data:"))

    expect(files).toHaveLength(2)
    expect(files.map((part) => (part.type === "file" ? part.filename : ""))).toEqual(["a.png", "b.pdf"])
  })

  test("deduplicates context files when prompt already includes same path", () => {
    const prompt: Prompt = [{ type: "file", path: "src/foo.ts", content: "@src/foo.ts", start: 0, end: 11 }]

    const result = buildRequestParts({
      prompt,
      context: [
        { key: "ctx:dup", type: "file", path: "src/foo.ts" },
        { key: "ctx:comment", type: "file", path: "src/foo.ts", comment: "focus here" },
      ],
      images: [],
      text: "@src/foo.ts",
      messageID: "msg_2",
      sessionID: "ses_2",
      sessionDirectory: "/repo",
    })

    const fooFiles = result.requestParts.filter(
      (part) => part.type === "file" && part.url.startsWith("file:///repo/src/foo.ts"),
    )
    const synthetic = result.requestParts.filter((part) => part.type === "text" && part.synthetic)

    expect(fooFiles).toHaveLength(2)
    expect(synthetic).toHaveLength(1)
  })

  test("uses full path for file source while keeping short display text", () => {
    const prompt: Prompt = [
      {
        type: "file",
        path: "D:\\work\\foo.txt",
        content: "@foo.txt",
        start: 0,
        end: 8,
      },
    ]

    const result = buildRequestParts({
      prompt,
      context: [],
      images: [],
      text: "@foo.txt",
      messageID: "msg_display",
      sessionID: "ses_display",
      sessionDirectory: "C:\\repo",
    })

    const filePart = result.requestParts.find((part) => part.type === "file")
    expect(filePart).toBeDefined()
    if (filePart?.type === "file") {
      expect(filePart.filename).toBe("foo.txt")
      expect(filePart.url).toContain("/D:/work/foo.txt")
      expect(filePart.source).toBeUndefined()
    }
  })

  test("uses full path for POSIX drop sources while keeping short display text", () => {
    const prompt: Prompt = [
      {
        type: "file",
        path: "/Users/developer/foo.txt",
        content: "@foo.txt",
        start: 0,
        end: 8,
      },
    ]

    const result = buildRequestParts({
      prompt,
      context: [],
      images: [],
      text: "@foo.txt",
      messageID: "msg_display_posix",
      sessionID: "ses_display_posix",
      sessionDirectory: "/repo",
    })

    const filePart = result.requestParts.find((part) => part.type === "file")
    expect(filePart).toBeDefined()
    if (filePart?.type === "file") {
      expect(filePart.filename).toBe("foo.txt")
      expect(filePart.url).toContain("/Users/developer/foo.txt")
      expect(filePart.source).toBeUndefined()
    }
  })

  test("adds file parts for @mentions inside comment text", () => {
    const result = buildRequestParts({
      prompt: [{ type: "text", content: "look", start: 0, end: 4 }],
      context: [
        {
          key: "ctx:comment-mention",
          type: "file",
          path: "src/review.ts",
          comment: "Compare with @src/shared.ts and @src/review.ts.",
        },
      ],
      images: [],
      text: "look",
      messageID: "msg_comment_mentions",
      sessionID: "ses_comment_mentions",
      sessionDirectory: "/repo",
    })

    const files = result.requestParts.filter((part) => part.type === "file")
    expect(files).toHaveLength(2)
    expect(files.some((part) => part.type === "file" && part.url === "file:///repo/src/review.ts")).toBe(true)
    expect(files.some((part) => part.type === "file" && part.url === "file:///repo/src/shared.ts")).toBe(true)
  })

  test("handles Windows paths correctly (simulated on macOS)", () => {
    const prompt: Prompt = [{ type: "file", path: "src\\foo.ts", content: "@src\\foo.ts", start: 0, end: 11 }]

    const result = buildRequestParts({
      prompt,
      context: [],
      images: [],
      text: "@src\\foo.ts",
      messageID: "msg_win_1",
      sessionID: "ses_win_1",
      sessionDirectory: "D:\\projects\\myapp", // Windows path
    })

    // Should create valid file URLs
    const filePart = result.requestParts.find((part) => part.type === "file")
    expect(filePart).toBeDefined()
    if (filePart?.type === "file") {
      // URL should be parseable
      expect(() => new URL(filePart.url)).not.toThrow()
      // Should not have encoded backslashes in wrong place
      expect(filePart.url).not.toContain("%5C")
      // Should have normalized to forward slashes
      expect(filePart.url).toContain("/src/foo.ts")
    }
  })

  test("keeps a Windows workspace file target across history restore and resubmit", () => {
    const directory = "D:\\repo"
    const prompt = extractPromptFromParts(
      [
        { id: "text_win_restore", type: "text", text: "check", sessionID: "ses_win_restore", messageID: "msg_win_restore" },
        {
          id: "file_win_restore",
          type: "file",
          mime: "text/plain",
          url: "file:///D:/repo/src/foo.ts",
          filename: "foo.ts",
          source: {
            type: "file",
            path: "D:\\repo\\src\\foo.ts",
            text: { value: "@foo.ts", start: 0, end: 0 },
          },
          sessionID: "ses_win_restore",
          messageID: "msg_win_restore",
        },
      ] satisfies Part[],
      { directory },
    )
    const restored = prompt.find((part) => part.type === "file")
    const submitted = buildRequestParts({
      prompt,
      context: [],
      images: [],
      text: "check",
      messageID: "msg_win_resubmit",
      sessionID: "ses_win_restore",
      sessionDirectory: directory,
    }).requestParts.find((part) => part.type === "file")

    // 历史恢复和再次提交必须组成等价闭环，不能留下单反斜杠前导后再拼错工作区。
    expect({ restoredPath: restored?.type === "file" ? restored.path : undefined, url: submitted?.url }).toEqual({
      restoredPath: "src/foo.ts",
      url: "file:///D:/repo/src/foo.ts",
    })
  })

  test("does not relativize a file from a neighboring Windows directory", () => {
    const directory = "D:\\repo"
    const prompt = extractPromptFromParts(
      [
        { id: "text_win_neighbor", type: "text", text: "check", sessionID: "ses_win_neighbor", messageID: "msg_win_neighbor" },
        {
          id: "file_win_neighbor",
          type: "file",
          mime: "text/plain",
          url: "file:///D:/repo2/src/foo.ts",
          filename: "foo.ts",
          source: {
            type: "file",
            path: "D:\\repo2\\src\\foo.ts",
            text: { value: "@foo.ts", start: 0, end: 0 },
          },
          sessionID: "ses_win_neighbor",
          messageID: "msg_win_neighbor",
        },
      ] satisfies Part[],
      { directory },
    )
    const restored = prompt.find((part) => part.type === "file")
    const submitted = buildRequestParts({
      prompt,
      context: [],
      images: [],
      text: "check",
      messageID: "msg_win_neighbor_resubmit",
      sessionID: "ses_win_neighbor",
      sessionDirectory: directory,
    }).requestParts.find((part) => part.type === "file")

    // 目录前缀只有在完整边界命中时才能剥离，D:\repo2 不能被 D:\repo 误当作子目录。
    expect({ restoredPath: restored?.type === "file" ? restored.path : undefined, url: submitted?.url }).toEqual({
      restoredPath: "D:/repo2/src/foo.ts",
      url: "file:///D:/repo2/src/foo.ts",
    })
  })

  test("handles Windows absolute path with special characters", () => {
    const prompt: Prompt = [{ type: "file", path: "file#name.txt", content: "@file#name.txt", start: 0, end: 14 }]

    const result = buildRequestParts({
      prompt,
      context: [],
      images: [],
      text: "@file#name.txt",
      messageID: "msg_win_2",
      sessionID: "ses_win_2",
      sessionDirectory: "C:\\Users\\test\\Documents", // Windows path
    })

    const filePart = result.requestParts.find((part) => part.type === "file")
    expect(filePart).toBeDefined()
    if (filePart?.type === "file") {
      // URL should be parseable
      expect(() => new URL(filePart.url)).not.toThrow()
      // Special chars should be encoded
      expect(filePart.url).toContain("file%23name.txt")
      // Should have Windows drive letter properly encoded
      expect(filePart.url).toMatch(/file:\/\/\/[A-Z]:/)
    }
  })

  test("handles Linux absolute paths correctly", () => {
    const prompt: Prompt = [{ type: "file", path: "src/app.ts", content: "@src/app.ts", start: 0, end: 10 }]

    const result = buildRequestParts({
      prompt,
      context: [],
      images: [],
      text: "@src/app.ts",
      messageID: "msg_linux_1",
      sessionID: "ses_linux_1",
      sessionDirectory: "/home/developer/project",
    })

    const filePart = result.requestParts.find((part) => part.type === "file")
    expect(filePart).toBeDefined()
    if (filePart?.type === "file") {
      // URL should be parseable
      expect(() => new URL(filePart.url)).not.toThrow()
      // Should be a normal Unix path
      expect(filePart.url).toBe("file:///home/developer/project/src/app.ts")
    }
  })

  test("handles macOS paths correctly", () => {
    const prompt: Prompt = [{ type: "file", path: "README.md", content: "@README.md", start: 0, end: 9 }]

    const result = buildRequestParts({
      prompt,
      context: [],
      images: [],
      text: "@README.md",
      messageID: "msg_mac_1",
      sessionID: "ses_mac_1",
      sessionDirectory: "/Users/developer/Projects/opencode",
    })

    const filePart = result.requestParts.find((part) => part.type === "file")
    expect(filePart).toBeDefined()
    if (filePart?.type === "file") {
      // URL should be parseable
      expect(() => new URL(filePart.url)).not.toThrow()
      // Should be a normal Unix path
      expect(filePart.url).toBe("file:///Users/developer/Projects/opencode/README.md")
    }
  })

  test("handles context files with Windows paths", () => {
    const prompt: Prompt = []

    const result = buildRequestParts({
      prompt,
      context: [
        { key: "ctx:1", type: "file", path: "src\\utils\\helper.ts" },
        { key: "ctx:2", type: "file", path: "test\\unit.test.ts", comment: "check tests" },
      ],
      images: [],
      text: "test",
      messageID: "msg_win_ctx",
      sessionID: "ses_win_ctx",
      sessionDirectory: "D:\\workspace\\app",
    })

    const fileParts = result.requestParts.filter((part) => part.type === "file")
    expect(fileParts).toHaveLength(2)

    // All file URLs should be valid
    fileParts.forEach((part) => {
      if (part.type === "file") {
        expect(() => new URL(part.url)).not.toThrow()
        expect(part.url).not.toContain("%5C") // No encoded backslashes
      }
    })
  })

  test("handles absolute Windows paths (user manually specifies full path)", () => {
    const prompt: Prompt = [
      { type: "file", path: "D:\\other\\project\\file.ts", content: "@D:\\other\\project\\file.ts", start: 0, end: 25 },
    ]

    const result = buildRequestParts({
      prompt,
      context: [],
      images: [],
      text: "@D:\\other\\project\\file.ts",
      messageID: "msg_abs",
      sessionID: "ses_abs",
      sessionDirectory: "C:\\current\\project",
    })

    const filePart = result.requestParts.find((part) => part.type === "file")
    expect(filePart).toBeDefined()
    if (filePart?.type === "file") {
      // Should handle absolute path that differs from sessionDirectory
      expect(() => new URL(filePart.url)).not.toThrow()
      expect(filePart.url).toContain("/D:/other/project/file.ts")
    }
  })

  test("handles selection with query parameters on Windows", () => {
    const prompt: Prompt = [
      {
        type: "file",
        path: "src\\App.tsx",
        content: "@src\\App.tsx",
        start: 0,
        end: 11,
        selection: { startLine: 10, startChar: 0, endLine: 20, endChar: 5 },
      },
    ]

    const result = buildRequestParts({
      prompt,
      context: [],
      images: [],
      text: "@src\\App.tsx",
      messageID: "msg_sel",
      sessionID: "ses_sel",
      sessionDirectory: "C:\\project",
    })

    const filePart = result.requestParts.find((part) => part.type === "file")
    expect(filePart).toBeDefined()
    if (filePart?.type === "file") {
      // Should have query parameters
      expect(filePart.url).toContain("?start=10&end=20")
      // Should be valid URL
      expect(() => new URL(filePart.url)).not.toThrow()
      // Query params should parse correctly
      const url = new URL(filePart.url)
      expect(url.searchParams.get("start")).toBe("10")
      expect(url.searchParams.get("end")).toBe("20")
    }
  })

  test("handles file paths with dots and special segments on Windows", () => {
    const prompt: Prompt = [
      { type: "file", path: "..\\..\\shared\\util.ts", content: "@..\\..\\shared\\util.ts", start: 0, end: 21 },
    ]

    const result = buildRequestParts({
      prompt,
      context: [],
      images: [],
      text: "@..\\..\\shared\\util.ts",
      messageID: "msg_dots",
      sessionID: "ses_dots",
      sessionDirectory: "C:\\projects\\myapp\\src",
    })

    const filePart = result.requestParts.find((part) => part.type === "file")
    expect(filePart).toBeDefined()
    if (filePart?.type === "file") {
      // Should be valid URL
      expect(() => new URL(filePart.url)).not.toThrow()
      // Should preserve .. segments (backend normalizes)
      expect(filePart.url).toContain("/..")
    }
  })

  test("adds conversation transcripts as hidden synthetic context", () => {
    const result = buildRequestParts({
      prompt: [
        {
          type: "conversation",
          id: "chat_1",
          title: "你好聊什么",
          transcript: "User: 你好\n\nAssistant: 你好！",
          content: "你好聊什么",
          start: 0,
          end: 5,
        },
      ],
      context: [],
      images: [],
      text: "[你好聊什么](chatgpt-conversation://chat_1)",
      messageID: "msg_chat",
      sessionID: "ses_chat",
      sessionDirectory: "/repo",
    })

    expect(result.requestParts[0]).toMatchObject({
      type: "text",
      text: "[你好聊什么](chatgpt-conversation://chat_1)",
    })
    expect(result.requestParts[1]).toMatchObject({
      type: "text",
      synthetic: true,
      text: "Conversation reference: 你好聊什么\n\nUser: 你好\n\nAssistant: 你好！",
      metadata: { conversation_reference: { id: "chat_1", title: "你好聊什么" } },
    })
  })

  test("adds hidden accessibility context before an app snapshot image", () => {
    const result = buildRequestParts({
      prompt: [{ type: "text", content: "fix this", start: 0, end: 8 }],
      context: [],
      images: [
        {
          type: "image",
          id: "snapshot_1",
          filename: "Safari-snapshot.png",
          mime: "image/png",
          dataUrl: "data:image/png;base64,AAA",
          appSnapshot: {
            appName: "Safari",
            bundleIdentifier: "com.apple.Safari",
            windowTitle: "Issue 42",
            displayID: "1",
            imageWidth: 3024,
            imageHeight: 1964,
            accessibilityText: "Visible heading\nOff-screen error details",
            accessibilityTrusted: true,
            textTruncated: false,
            capturedAt: Date.parse("2026-07-13T08:00:00.000Z"),
          },
        },
      ],
      text: "fix this",
      messageID: "msg_snapshot",
      sessionID: "ses_snapshot",
      sessionDirectory: "/repo",
    })

    const contextIndex = result.requestParts.findIndex(
      (part) => part.type === "text" && part.synthetic && part.metadata?.app_snapshot === true,
    )
    const imageIndex = result.requestParts.findIndex(
      (part) => part.type === "file" && part.filename === "Safari-snapshot.png",
    )
    const context = result.requestParts[contextIndex]

    expect(contextIndex).toBeGreaterThan(0)
    expect(imageIndex).toBeGreaterThan(contextIndex)
    expect(context).toMatchObject({ type: "text", synthetic: true, metadata: { app_snapshot: true } })
    if (context?.type === "text") {
      expect(context.text).toContain('"app":"Safari"')
      expect(context.text).toContain('"window":"Issue 42"')
      expect(context.text).toContain('"capture_scope":"display"')
      expect(context.text).toContain('"image_width":3024')
      expect(context.text).toContain("Off-screen error details")
    }
    expect(result.optimisticParts[contextIndex]).toMatchObject({
      type: "text",
      synthetic: true,
      metadata: { app_snapshot: true },
    })
  })
})
