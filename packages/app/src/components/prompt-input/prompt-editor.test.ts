import { describe, expect, test } from "bun:test"
import type { Prompt } from "@/context/prompt"
import { promptEditorText, promptFromEditorText } from "./prompt-editor"

describe("prompt editor helpers", () => {
  test("flattens non-image non-file prompt parts into editable text", () => {
    const prompt: Prompt = [
      { type: "text", content: "fix ", start: 0, end: 4 },
      { type: "agent", name: "build", content: "@build", start: 4, end: 10 },
      { type: "file", path: "src/app.ts", content: "@src/app.ts", start: 10, end: 21 },
      { type: "image", id: "img", filename: "a.png", mime: "image/png", dataUrl: "data:image/png;base64,AAA" },
    ]

    // file parts are now attachments, not in editable text
    expect(promptEditorText(prompt)).toBe("fix @build")
  })

  test("rebuilds a text prompt and preserves images and files", () => {
    const image = {
      type: "image" as const,
      id: "img",
      filename: "a.png",
      mime: "image/png",
      dataUrl: "data:image/png;base64,AAA",
    }
    const file = {
      type: "file" as const,
      path: "src/app.ts",
      content: "@app.ts",
      start: 0,
      end: 7,
    }

    expect(promptFromEditorText("hello", [image, file])).toEqual({
      prompt: [{ type: "text", content: "hello", start: 0, end: 5 }, image, file],
      cursor: 5,
    })
  })

  test("preserves structured agent parts when editing text around them", () => {
    const prompt: Prompt = [
      { type: "text", content: "fix ", start: 0, end: 4 },
      { type: "agent", name: "build", content: "@build", start: 4, end: 10 },
      { type: "file", path: "src/app.ts", content: "@src/app.ts", start: 11, end: 22 },
      { type: "image", id: "img", filename: "a.png", mime: "image/png", dataUrl: "data:image/png;base64,AAA" },
    ]

    // file parts are attachments, not matched from text
    expect(promptFromEditorText("please fix @build today", prompt)).toEqual({
      prompt: [
        { type: "text", content: "please fix ", start: 0, end: 11 },
        { type: "agent", name: "build", content: "@build", start: 11, end: 17 },
        { type: "text", content: " today", start: 17, end: 23 },
        { type: "image", id: "img", filename: "a.png", mime: "image/png", dataUrl: "data:image/png;base64,AAA" },
        { type: "file", path: "src/app.ts", content: "@src/app.ts", start: 11, end: 22 },
      ],
      cursor: 23,
    })
  })

  test("drops structured parts that are removed from the edited text", () => {
    const prompt: Prompt = [
      { type: "text", content: "fix ", start: 0, end: 4 },
      { type: "agent", name: "build", content: "@build", start: 4, end: 10 },
      { type: "file", path: "src/app.ts", content: "@src/app.ts", start: 11, end: 22 },
    ]

    // file parts are always preserved as attachments
    expect(promptFromEditorText("fix quickly", prompt)).toEqual({
      prompt: [
        { type: "text", content: "fix quickly", start: 0, end: 11 },
        { type: "file", path: "src/app.ts", content: "@src/app.ts", start: 11, end: 22 },
      ],
      cursor: 11,
    })
  })

  test("file parts are not in editable text", () => {
    const prompt: Prompt = [{ type: "file", path: "D:\\repo\\foo.txt", content: "@foo.txt", start: 0, end: 8 }]

    // file parts are attachments, not in text
    expect(promptEditorText(prompt)).toBe("")
    // file parts are always preserved
    expect(promptFromEditorText("please check", prompt)).toEqual({
      prompt: [
        { type: "text", content: "please check", start: 0, end: 12 },
        { type: "file", path: "D:\\repo\\foo.txt", content: "@foo.txt", start: 0, end: 8 },
      ],
      cursor: 12,
    })
  })

  test("still flattens image parts out of editable text", () => {
    const prompt: Prompt = [
      { type: "text", content: "look ", start: 0, end: 5 },
      { type: "image", id: "img", filename: "a.png", mime: "image/png", dataUrl: "data:image/png;base64,AAA" },
    ]

    expect(promptEditorText(prompt)).toBe("look ")
  })

  test("preserves structured skill parts when editing prompt text", () => {
    const prompt: Prompt = [
      {
        type: "skill",
        name: "skill-creator",
        location: "/Users/developer/.codex/skills/skill-creator/SKILL.md",
        content: "/skill-creator ",
        start: 0,
        end: 15,
      },
    ]

    expect(promptEditorText(prompt)).toBe("/skill-creator ")
    expect(promptFromEditorText("/skill-creator now", prompt)).toEqual({
      prompt: [
        {
          type: "skill",
          name: "skill-creator",
          location: "/Users/developer/.codex/skills/skill-creator/SKILL.md",
          content: "/skill-creator ",
          start: 0,
          end: 15,
        },
        { type: "text", content: "now", start: 15, end: 18 },
      ],
      cursor: 18,
    })
  })
})
