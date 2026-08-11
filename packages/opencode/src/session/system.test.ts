import { describe, expect, test } from "bun:test"
import type { Provider } from "@/provider/provider"
import { provider, PROMPT_MISSING_DEPS } from "./system"

function model(id: string) {
  return { api: { id } } as Provider.Model
}

describe("provider", () => {
  test("所有模型分支都包含「依赖缺失时询问用户是否代为安装」指引", () => {
    const ids = [
      "gpt-4.1",
      "gpt-5",
      "gpt-5-codex",
      "gemini-2.5-pro",
      "claude-sonnet-4-5",
      "trinity-large",
      "kimi-k2",
      "some-unknown-model",
    ]
    for (const id of ids) {
      expect(provider(model(id)).join("\n")).toContain(PROMPT_MISSING_DEPS)
    }
  })

  test("基础提示词在首位，指引在末位", () => {
    const out = provider(model("claude-sonnet-4-5"))
    expect(out.length).toBeGreaterThan(1)
    expect(out[0]).not.toBe(PROMPT_MISSING_DEPS)
    expect(out[out.length - 1]).toBe(PROMPT_MISSING_DEPS)
  })
})
