import { describe, expect, test } from "bun:test"
import { resolveModelSwitchNotice } from "./model-switch-notice"

const anthropic = { providerID: "anthropic", modelID: "claude-sonnet-4" }
const openai = { providerID: "openai", modelID: "gpt-4o" }

describe("resolveModelSwitchNotice", () => {
  test("真实切换到不同模型且带锚点时生成提示", () => {
    expect(
      resolveModelSwitchNotice({ from: anthropic, to: openai, afterMessageID: "msg-1" }),
    ).toEqual({
      type: "create",
      notice: { afterMessageID: "msg-1", from: anthropic, to: openai },
    })
  })

  test("重新选中同一模型时保持现状", () => {
    expect(
      resolveModelSwitchNotice({ from: anthropic, to: { ...anthropic }, afterMessageID: "msg-1" }),
    ).toEqual({ type: "keep" })
  })

  test("模型变更但缺少锚点（如快捷键循环）时清空提示", () => {
    expect(
      resolveModelSwitchNotice({ from: anthropic, to: openai, afterMessageID: undefined }),
    ).toEqual({ type: "clear" })
  })

  test("没有来源模型时保持现状", () => {
    expect(
      resolveModelSwitchNotice({ from: undefined, to: openai, afterMessageID: "msg-1" }),
    ).toEqual({ type: "keep" })
  })

  test("清空模型选择时保持现状", () => {
    expect(
      resolveModelSwitchNotice({ from: anthropic, to: undefined, afterMessageID: "msg-1" }),
    ).toEqual({ type: "keep" })
  })
})
