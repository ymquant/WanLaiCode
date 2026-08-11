import { describe, expect, test } from "bun:test"
import { isImageGenerationModel, normalizeImageGenerationSize } from "./image-generation"
import { promptPlaceholder } from "./placeholder"

describe("promptPlaceholder", () => {
  const t = (key: string, params?: Record<string, string>) => `${key}${params?.example ? `:${params.example}` : ""}`

  test("returns shell placeholder in shell mode", () => {
    const value = promptPlaceholder({
      mode: "shell",
      commentCount: 0,
      example: "example",
      suggest: true,
      t,
    })
    expect(value).toBe("prompt.placeholder.shell:example")
  })

  test("returns summarize placeholders for comment context", () => {
    expect(promptPlaceholder({ mode: "normal", commentCount: 1, example: "example", suggest: true, t })).toBe(
      "prompt.placeholder.summarizeComment",
    )
    expect(promptPlaceholder({ mode: "normal", commentCount: 2, example: "example", suggest: true, t })).toBe(
      "prompt.placeholder.summarizeComments",
    )
  })

  test("returns default placeholder with example when suggestions enabled", () => {
    const value = promptPlaceholder({
      mode: "normal",
      commentCount: 0,
      example: "translated-example",
      suggest: true,
      t,
    })
    expect(value).toBe("prompt.placeholder.normal:translated-example")
  })

  test("returns simple placeholder when suggestions disabled", () => {
    const value = promptPlaceholder({
      mode: "normal",
      commentCount: 0,
      example: "translated-example",
      suggest: false,
      t,
    })
    expect(value).toBe("prompt.placeholder.simple")
  })

  test("returns goal placeholder in goal-input mode", () => {
    const value = promptPlaceholder({
      mode: "normal",
      commentCount: 0,
      example: "translated-example",
      suggest: true,
      goalMode: true,
      t,
    })
    expect(value).toBe("prompt.placeholder.goal")
  })

  test("returns image generation placeholder for image models", () => {
    const value = promptPlaceholder({
      mode: "normal",
      commentCount: 0,
      example: "translated-example",
      suggest: true,
      imageGeneration: true,
      t,
    })
    expect(value).toBe("prompt.imageGeneration.placeholder")
  })

  test("detects image generation models from capabilities and names", () => {
    expect(isImageGenerationModel({ capabilities: { output: { image: true } } })).toBe(true)
    expect(isImageGenerationModel({ id: "gpt-5.5", capabilities: { output: { text: true, image: true } } })).toBe(false)
    expect(isImageGenerationModel({ id: "gpt-image-2" })).toBe(true)
    expect(isImageGenerationModel({ name: "DALL-E 3" })).toBe(true)
    expect(isImageGenerationModel({ id: "vision-image-input-only" })).toBe(false)
    expect(isImageGenerationModel({ id: "gpt-5.2-codex", capabilities: { output: { image: false } } })).toBe(false)
  })

  test("normalizes custom image generation sizes to gateway limits", () => {
    expect(normalizeImageGenerationSize("auto")).toBe("auto")
    expect(normalizeImageGenerationSize("1024x1024")).toBe("1024x1024")
    expect(normalizeImageGenerationSize("5000x1000")).toBe("2304x768")
    expect(normalizeImageGenerationSize("64x64")).toBe("816x816")
  })
})
