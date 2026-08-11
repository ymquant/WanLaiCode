import { describe, expect, test } from "bun:test"
import { displayImageFailureText, displaySessionErrorText } from "./session-error-display"

const t = (key: string) =>
  ({
    "errors.category.upgrade_required": "当前套餐不支持该模型，请升级套餐后使用。",
    "errors.category.auth_expired": "登录已过期，请重新登录。",
    "errors.category.unknown": "出错了，请重试。",
    "ui.sessionTurn.error.imageGenerationFailed": "图片生成失败：",
    "prompt.imageGeneration.message.loading": "正在生成更细致的图片，请稍候。",
  })[key] ?? key

describe("session-error-display", () => {
  test("localizes mixed image failure text", () => {
    expect(
      displayImageFailureText(
        "图片生成失败: SOFTWARE_BILLING_COST_UNAVAILABLE: The requested model is not available",
        t,
      ),
    ).toBe("图片生成失败：当前套餐不支持该模型，请升级套餐后使用。")
  })

  test("localizes english failure prefix with reason-coded body", () => {
    expect(
      displayImageFailureText(
        "Image generation failed: SOFTWARE_BILLING_COST_UNAVAILABLE: The requested model is not available",
        t,
      ),
    ).toBe("图片生成失败：当前套餐不支持该模型，请升级套餐后使用。")
  })

  test("localizes loading text", () => {
    expect(displayImageFailureText("Generating a more detailed image. Please wait.", t)).toBe(
      "正在生成更细致的图片，请稍候。",
    )
  })

  test("localizes plain backend reason messages", () => {
    expect(displaySessionErrorText("SOFTWARE_BILLING_COST_UNAVAILABLE: The requested model is not available", t)).toBe(
      "当前套餐不支持该模型，请升级套餐后使用。",
    )
  })

  test("localizes oauth authorization expired messages", () => {
    expect(displaySessionErrorText("WanlaiCode OAuth authorization expired", t)).toBe("登录已过期，请重新登录。")
  })

  test("does not misclassify generic quota prose", () => {
    expect(displaySessionErrorText("you exceeded your quota for this billing period", t)).toBe(
      "you exceeded your quota for this billing period",
    )
  })

  // 无法分类的后端错误原样返回，确保 errorRawDetail 能展示给用户而不被过滤
  test("unclassifiable backend errors return raw unchanged", () => {
    expect(displaySessionErrorText("some weird backend error", t)).toBe("some weird backend error")
    expect(displaySessionErrorText("internal server error", t)).toBe("internal server error")
  })
})
