import { describe, expect, test } from "bun:test"
import { extractJsonObject, normalizeClassification } from "../../src/provider/intent"

describe("extractJsonObject", () => {
  test("parses a bare JSON object", () => {
    expect(extractJsonObject('{"action":"none","confidence":0.9}')).toEqual({ action: "none", confidence: 0.9 })
  })

  test("parses JSON wrapped in ```json fences", () => {
    expect(extractJsonObject('```json\n{"action":"edit","confidence":0.8}\n```')).toEqual({
      action: "edit",
      confidence: 0.8,
    })
  })

  test("extracts JSON embedded in surrounding prose", () => {
    expect(extractJsonObject('Sure! {"action":"generate","confidence":0.95} hope it helps')).toEqual({
      action: "generate",
      confidence: 0.95,
    })
  })

  test("skips literal braces in prose and finds the real object", () => {
    expect(extractJsonObject('uses {nested {braces}} then {"action":"edit","confidence":0.7}')).toEqual({
      action: "edit",
      confidence: 0.7,
    })
  })

  test("returns undefined when there is no JSON", () => {
    expect(extractJsonObject("action: edit, no json here")).toBeUndefined()
    expect(extractJsonObject("")).toBeUndefined()
  })

  test("ignores JSON arrays (only objects)", () => {
    expect(extractJsonObject('[{"action":"none"}]')).toEqual({ action: "none" })
  })
})

describe("normalizeClassification", () => {
  const actions = ["generate", "edit", "none"] as const

  test("normalizes action casing and clamps confidence", () => {
    expect(normalizeClassification({ action: "EDIT", confidence: 1.4 }, actions)).toEqual({
      action: "edit",
      confidence: 1,
      data: { action: "EDIT", confidence: 1.4 },
    })
  })

  test("coerces string confidence and keeps reason", () => {
    expect(normalizeClassification({ action: "generate", confidence: "0.6", reason: "wants image" }, actions)).toEqual({
      action: "generate",
      confidence: 0.6,
      reason: "wants image",
      data: { action: "generate", confidence: "0.6", reason: "wants image" },
    })
  })

  test("defaults confidence to 0.5 when missing or non-numeric", () => {
    expect(normalizeClassification({ action: "none" }, actions)).toEqual({
      action: "none",
      confidence: 0.5,
      data: { action: "none" },
    })
  })

  test("treats chat route without action as none", () => {
    expect(normalizeClassification({ route: "chat", confidence: 0.8, reason: "normal chat" }, actions)).toEqual({
      action: "none",
      confidence: 0.8,
      reason: "normal chat",
      data: { route: "chat", confidence: 0.8, reason: "normal chat" },
    })
  })

  test("treats image tool route without action as generate", () => {
    expect(
      normalizeClassification(
        {
          route: "tool",
          tool: "image_generation",
          confidence: 0.92,
          image_prompt: "生成一张猫图",
        },
        actions,
      ),
    ).toEqual({
      action: "generate",
      confidence: 0.92,
      data: {
        route: "tool",
        tool: "image_generation",
        confidence: 0.92,
        image_prompt: "生成一张猫图",
      },
    })
  })

  test("preserves extra tool plan fields", () => {
    expect(
      normalizeClassification(
        {
          route: "tool",
          tool: "image_generation",
          action: "generate",
          confidence: 0.9,
          image_prompt: "做成信息图",
          context_text: "会议纪要",
        },
        actions,
      ),
    ).toEqual({
      action: "generate",
      confidence: 0.9,
      data: {
        route: "tool",
        tool: "image_generation",
        action: "generate",
        confidence: 0.9,
        image_prompt: "做成信息图",
        context_text: "会议纪要",
      },
    })
  })

  test("rejects actions outside the allowed set", () => {
    expect(normalizeClassification({ action: "delete", confidence: 1 }, actions)).toBeUndefined()
    expect(normalizeClassification(undefined, actions)).toBeUndefined()
  })
})
