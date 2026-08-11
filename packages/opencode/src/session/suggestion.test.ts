import { describe, expect, test } from "bun:test"
import { SessionSuggestion } from "./suggestion"

const msg = (role: string, text: string, extra?: { synthetic?: boolean; ignored?: boolean }) => ({
  info: { role },
  parts: [{ type: "text", text, ...extra }],
})

describe("SessionSuggestion.transcript", () => {
  test("formats role-prefixed transcript from text parts", () => {
    const result = SessionSuggestion.transcript([msg("user", "fix the bug"), msg("assistant", "done, tests pass")])
    expect(result).toBe("user: fix the bug\n\nassistant: done, tests pass")
  })

  test("keeps only the last CONTEXT_MESSAGES messages", () => {
    const messages = Array.from({ length: 10 }, (_, i) => msg("user", `m${i}`))
    const result = SessionSuggestion.transcript(messages)
    expect(result.split("\n\n")).toHaveLength(SessionSuggestion.CONTEXT_MESSAGES)
    expect(result.startsWith(`user: m${10 - SessionSuggestion.CONTEXT_MESSAGES}`)).toBe(true)
    expect(result.endsWith("user: m9")).toBe(true)
  })

  test("truncates each message to CONTEXT_CHARS", () => {
    const result = SessionSuggestion.transcript([msg("user", "x".repeat(SessionSuggestion.CONTEXT_CHARS + 500))])
    expect(result.length).toBe("user: ".length + SessionSuggestion.CONTEXT_CHARS)
  })

  test("skips synthetic, ignored, and non-text parts", () => {
    const result = SessionSuggestion.transcript([
      msg("user", "hidden", { synthetic: true }),
      msg("user", "skipped", { ignored: true }),
      { info: { role: "assistant" }, parts: [{ type: "tool" }] },
      msg("user", "visible"),
    ])
    expect(result).toBe("user: visible")
  })

  test("returns empty string when nothing usable", () => {
    expect(SessionSuggestion.transcript([])).toBe("")
  })

  test("does not split a surrogate pair at the truncation boundary", () => {
    const result = SessionSuggestion.transcript([msg("user", "x" + "😀".repeat(1500))])
    expect(result.length).toBe("user: ".length + SessionSuggestion.CONTEXT_CHARS - 1)
    expect(/[\uD800-\uDBFF]$/.test(result)).toBe(false)
  })
})

describe("SessionSuggestion.clean", () => {
  test("takes first non-empty line and strips think tags", () => {
    expect(SessionSuggestion.clean("<think>reasoning</think>\n\nrun the tests\nsecond line")).toBe("run the tests")
  })

  test("strips surrounding quotes", () => {
    expect(SessionSuggestion.clean('"run the tests"')).toBe("run the tests")
  })

  test("strips curly and fullwidth quotes", () => {
    expect(SessionSuggestion.clean("“运行测试”")).toBe("运行测试")
    expect(SessionSuggestion.clean("‘run the tests’")).toBe("run the tests")
  })

  test("discards unclosed think block instead of leaking reasoning", () => {
    expect(SessionSuggestion.clean("<think>internal reasoning\nrun the tests")).toBeUndefined()
  })

  test("truncates to MAX_LENGTH", () => {
    const result = SessionSuggestion.clean("x".repeat(SessionSuggestion.MAX_LENGTH + 50))
    expect(result?.length).toBe(SessionSuggestion.MAX_LENGTH)
    expect(result?.endsWith("...")).toBe(true)
  })

  test("does not split a surrogate pair when truncating", () => {
    const result = SessionSuggestion.clean("x".repeat(SessionSuggestion.MAX_LENGTH - 4) + "😀😀😀")
    expect(result).toBe("x".repeat(SessionSuggestion.MAX_LENGTH - 4) + "...")
  })

  test("returns undefined for empty output", () => {
    expect(SessionSuggestion.clean("")).toBeUndefined()
    expect(SessionSuggestion.clean("\n  \n")).toBeUndefined()
    expect(SessionSuggestion.clean('""')).toBeUndefined()
  })

  test("returns undefined for no-suggestion sentinels", () => {
    expect(SessionSuggestion.clean("NONE")).toBeUndefined()
    expect(SessionSuggestion.clean("none.")).toBeUndefined()
    expect(SessionSuggestion.clean("Nothing")).toBeUndefined()
    expect(SessionSuggestion.clean("N/A")).toBeUndefined()
  })
})

describe("SessionSuggestion.hasNewerUserMessage", () => {
  const entry = (role: string, id: string) => ({ info: { role, id } })

  test("false when only assistant messages follow the last user message", () => {
    const messages = [entry("user", "msg_1"), entry("assistant", "msg_2"), entry("assistant", "msg_3")]
    expect(SessionSuggestion.hasNewerUserMessage(messages, "msg_1")).toBe(false)
  })

  test("true when a newer user message exists", () => {
    const messages = [entry("user", "msg_1"), entry("assistant", "msg_2"), entry("user", "msg_4")]
    expect(SessionSuggestion.hasNewerUserMessage(messages, "msg_1")).toBe(true)
  })

  test("uses timeline position when a newer regular ID sorts before a remote ID", () => {
    const remoteID = "msg_remote_ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
    const newerID = "msg_f645ca787001MekQG2E4456W4P"
    const messages = [entry("user", remoteID), entry("assistant", "msg_response"), entry("user", newerID)]

    // 手机远控 ID 的字典序更大，但数组中的后续用户消息仍必须让旧建议失效。
    expect(SessionSuggestion.hasNewerUserMessage(messages, remoteID)).toBe(true)
  })

  test("uses array position when the later user message has a smaller id", () => {
    // 客户端生成的 ID 可以逆序到达，后出现的用户消息仍必须让旧建议失效。
    const messages = [entry("user", "msg_z"), entry("assistant", "msg_y"), entry("user", "msg_a")]
    expect(SessionSuggestion.hasNewerUserMessage(messages, "msg_z")).toBe(true)
  })

  test("false when the last user message is the newest user message", () => {
    expect(SessionSuggestion.hasNewerUserMessage([entry("user", "msg_1")], "msg_1")).toBe(false)
    expect(SessionSuggestion.hasNewerUserMessage([], "msg_1")).toBe(false)
  })

  test("does not infer ordering when the reference message is outside the window", () => {
    // 分页窗口缺少目标时没有可靠位置，不能再用 ID 大小误判建议已经过期。
    expect(SessionSuggestion.hasNewerUserMessage([entry("user", "msg_z")], "msg_a")).toBe(false)
  })
})
