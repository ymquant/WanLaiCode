import { describe, expect, test } from "bun:test"
import { parsePromptWithPluginMentions } from "@/context/prompt-parse"

describe("parsePromptWithPluginMentions", () => {
  test("parses plain text with no mentions", () => {
    const parts = parsePromptWithPluginMentions("hello world")
    expect(parts).toEqual([{ type: "text", content: "hello world", start: 0, end: 11 }])
  })

  test("parses plugin mention link into PluginAttachmentPart", () => {
    const parts = parsePromptWithPluginMentions("[@my-plugin](plugin://com.example.plugin)")
    expect(parts).toHaveLength(1)
    expect(parts[0]).toMatchObject({ type: "plugin", name: "my-plugin", addonKey: "com.example.plugin" })
  })

  test("leaves malformed plugin mention links as text", () => {
    const parts = parsePromptWithPluginMentions("[@bad](plugin://with space)")
    expect(parts).toEqual([{ type: "text", content: "[@bad](plugin://with space)", start: 0, end: 27 }])
  })

  test("parses skill mention link into SkillPart with wire-text content", () => {
    const parts = parsePromptWithPluginMentions("[Plugin Creator](skill://plugin-creator) ")
    expect(parts).toHaveLength(2)
    expect(parts[0]).toMatchObject({
      type: "skill",
      name: "plugin-creator",
      content: "/plugin-creator ",
      start: 0,
      end: 16,
    })
    expect(parts[1]).toMatchObject({ type: "text", content: " ", start: 16, end: 17 })
  })

  test("skill wire text starts at correct position after leading text", () => {
    const parts = parsePromptWithPluginMentions("hey [My Skill](skill://my-skill) there")
    const skill = parts.find((p) => p.type === "skill")
    expect(skill).toMatchObject({ type: "skill", name: "my-skill", content: "/my-skill " })
    const text = parts.find((p) => p.type === "text" && p.content === "hey ")
    expect(text).toBeDefined()
  })

  test("multiple mixed mentions are sorted and all parsed", () => {
    const parts = parsePromptWithPluginMentions(
      "[@p](plugin://key) then [S](skill://s-skill) end",
    )
    expect(parts.some((p) => p.type === "plugin")).toBe(true)
    expect(parts.some((p) => p.type === "skill")).toBe(true)
    expect(parts.some((p) => p.type === "text" && p.content === " then ")).toBe(true)
    expect(parts.some((p) => p.type === "text" && p.content === " end")).toBe(true)
  })

  test("resolveDisplayName overrides plugin display name", () => {
    const parts = parsePromptWithPluginMentions("[@fallback](plugin://key)", (k) =>
      k === "key" ? "Pretty Name" : undefined,
    )
    expect(parts[0]).toMatchObject({ type: "plugin", content: "Pretty Name" })
  })
})
