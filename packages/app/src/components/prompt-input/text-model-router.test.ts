import { describe, expect, test } from "bun:test"
import { selectTextModel, type TextModelCandidate } from "./text-model-router"

const model = (providerID: string, id: string, image = false, text = !image): TextModelCandidate => ({
  id,
  name: id,
  provider: { id: providerID },
  capabilities: { input: { text: true }, output: { text, image } },
})

describe("selectTextModel", () => {
  test("uses the current model when it supports text output", () => {
    const current = model("wanlaicode", "gpt-5.5")

    expect(selectTextModel({ current, models: [current], visible: () => true })).toBe(current)
  })

  test("keeps multimodal text models available for chat", () => {
    const current = model("wanlaicode", "gpt-5.5", true, true)

    expect(selectTextModel({ current, models: [current], visible: () => true })).toBe(current)
  })

  test("falls back from an image model to a visible text model", () => {
    const current = model("wanlaicode", "gpt-image-2", true)
    const text = model("wanlaicode", "gpt-5.5")

    expect(selectTextModel({ current, models: [current, text], visible: () => true })).toBe(text)
  })

  test("ignores hidden text models", () => {
    const current = model("wanlaicode", "gpt-image-2", true)
    const hidden = model("wanlaicode", "gpt-5.5")

    expect(selectTextModel({ current, models: [current, hidden], visible: () => false })).toBeUndefined()
  })
})
