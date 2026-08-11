import { describe, expect, test } from "bun:test"
import { localizeErrorMessage, readableErrorMessage } from "./localize-message"

describe("localizeErrorMessage", () => {
  test("maps group-disabled english errors to client text", () => {
    expect(
      localizeErrorMessage(new Error("Image generation is not enabled for this group"), {
        group_disabled: "当前账号组未开通图片生成功能，请联系管理员开通后再试。",
      }),
    ).toBe("当前账号组未开通图片生成功能，请联系管理员开通后再试。")
  })

  test("maps reason-coded errors to category messages", () => {
    expect(
      readableErrorMessage(new Error("SOFTWARE_BILLING_COST_UNAVAILABLE: The requested model is not available"), {
        upgrade_required: "当前套餐不支持该模型，请升级套餐后使用。",
      }),
    ).toBe("当前套餐不支持该模型，请升级套餐后使用。")
  })

  test("falls back to raw message when no mapping exists", () => {
    expect(readableErrorMessage(new Error("Request failed"), { unknown: "出错了，请重试。" })).toBe("Request failed")
  })
})
