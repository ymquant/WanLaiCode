import { describe, expect, test } from "bun:test"
import { modelCapabilityMetaKeys } from "./model-capability-meta"

describe("modelCapabilityMetaKeys", () => {
  test("keeps reasoning DeepSeek models as text instead of image or video", () => {
    expect(
      modelCapabilityMetaKeys({
        id: "deepseek-v4-pro",
        capabilities: {
          reasoning: true,
          output: { text: true, image: false, video: false },
        },
      }),
    ).toEqual(["text", "reasoning"])
  })

  test("shows Seedance models as video even when backend only provides an id fallback", () => {
    expect(
      modelCapabilityMetaKeys({
        id: "seedance-2.0-fast-5s-portrait",
        capabilities: {
          output: { text: true, image: false, video: false },
        },
      }),
    ).toEqual(["video"])
  })

  test("uses model type as an output capability fallback", () => {
    expect(
      modelCapabilityMetaKeys({
        id: "custom-video-model",
        type: "video",
        capabilities: {
          output: {},
        },
      }),
    ).toEqual(["video"])
  })

  test("shows explicit image generation models as image", () => {
    expect(
      modelCapabilityMetaKeys({
        id: "gpt-image-2",
        capabilities: {
          output: { text: false, image: true, video: false },
        },
      }),
    ).toEqual(["image"])
  })
})
