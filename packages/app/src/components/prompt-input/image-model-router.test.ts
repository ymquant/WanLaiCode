import { describe, expect, test } from "bun:test"
import { selectImageGenerationModel, type ImageModelCandidate } from "./image-model-router"

const model = (providerID: string, id: string, image = false): ImageModelCandidate => ({
  id,
  name: id,
  provider: { id: providerID },
  capabilities: { output: { image } },
})

describe("selectImageGenerationModel", () => {
  test("uses the current model when it supports image output", () => {
    const current = model("wanlaicode", "gpt-image-2", true)
    expect(selectImageGenerationModel({ current, models: [current], visible: () => true })).toBe(current)
  })

  test("prefers wanlaicode gpt-image-2 over image models under the current provider", () => {
    const current = model("openai", "gpt-5.5")
    const openaiImage = model("openai", "gpt-image-2", true)
    const wanlaiImage = model("wanlaicode", "gpt-image-2", true)

    expect(
      selectImageGenerationModel({
        current,
        models: [current, wanlaiImage, openaiImage],
        visible: () => true,
      }),
    ).toBe(wanlaiImage)
  })

  test("uses current provider image model when wanlaicode gpt-image-2 is unavailable", () => {
    const current = model("openai", "gpt-5.5")
    const openaiImage = model("openai", "gpt-image-2", true)

    expect(
      selectImageGenerationModel({
        current,
        models: [current, openaiImage],
        visible: () => true,
      }),
    ).toBe(openaiImage)
  })

  test("ignores hidden image models", () => {
    const current = model("openai", "gpt-5.5")
    const hidden = model("wanlaicode", "gpt-image-2", true)

    expect(
      selectImageGenerationModel({
        current,
        models: [current, hidden],
        visible: () => false,
      }),
    ).toBeUndefined()
  })
})
