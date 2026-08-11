import { describe, expect, test } from "bun:test"
import { resolveSkillPreviewPath } from "./skill-preview"

describe("skill preview", () => {
  test("resolves builtin skill location to Codex system skill file", () => {
    expect(
      resolveSkillPreviewPath({
        path: "builtin:imagegen",
        name: "imagegen",
        home: "/Users/developer",
      }),
    ).toBe("/Users/developer/.codex/skills/.system/imagegen/SKILL.md")
  })

  test("keeps non-builtin skill paths unchanged", () => {
    expect(
      resolveSkillPreviewPath({
        path: "/Users/developer/.codex/skills/skill-creator/SKILL.md",
        name: "skill-creator",
        home: "/Users/developer",
      }),
    ).toBe("/Users/developer/.codex/skills/skill-creator/SKILL.md")
  })
})
