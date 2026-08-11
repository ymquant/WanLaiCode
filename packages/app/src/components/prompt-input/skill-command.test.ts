import { describe, expect, test } from "bun:test"
import type { ImageAttachmentPart } from "@/context/prompt"
import { skillCommandPrompt, skillCommandText } from "./skill-command"

describe("skill command prompt", () => {
  test("formats a skill name as a slash command", () => {
    expect(skillCommandText(" code-review ")).toBe("/code-review ")
  })

  test("builds prompt parts and keeps image attachments", () => {
    const image: ImageAttachmentPart = {
      type: "image",
      id: "img_1",
      filename: "screen.png",
      mime: "image/png",
      dataUrl: "data:image/png;base64,AA==",
    }

    expect(skillCommandPrompt("code-review", [image], "/Users/developer/.codex/skills/code-review/SKILL.md")).toEqual({
      prompt: [
        {
          type: "skill",
          name: "code-review",
          location: "/Users/developer/.codex/skills/code-review/SKILL.md",
          content: "/code-review ",
          start: 0,
          end: 13,
        },
        image,
      ],
      cursor: 13,
    })
  })
})
