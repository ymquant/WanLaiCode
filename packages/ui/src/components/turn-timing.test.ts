import { describe, expect, test } from "bun:test"
import { effectiveTurnStart, RESUME_GAP_MS, type TurnActivity } from "./turn-timing"

// created + 该步之后的空档是否为工具循环进行中
const act = (created: number, toolLoopContinues = false): TurnActivity => ({ created, toolLoopContinues })

describe("effectiveTurnStart", () => {
  test("normal turn keeps the user message as the start", () => {
    expect(effectiveTurnStart([act(1_000), act(2_000), act(60_000)])).toBe(1_000)
  })

  test("continuous multi-step turn does not reset between steps", () => {
    // 多步工具轮之间的正常空档（<阈值）不重置
    expect(effectiveTurnStart([act(0, true), act(120_000, true), act(300_000)])).toBe(0)
  })

  test("only the user message present falls back to its timestamp", () => {
    expect(effectiveTurnStart([act(5_000)])).toBe(5_000)
  })

  test("empty timeline returns undefined", () => {
    expect(effectiveTurnStart([])).toBeUndefined()
  })

  test("a long idle gap before the first response resets to that response", () => {
    // app 关闭/会话暂停后恢复：user 很久前创建，assistant 恢复时才出现（间隔前是 user，非工具循环）
    const userCreated = 1_000
    const resumed = userCreated + RESUME_GAP_MS + 1
    expect(effectiveTurnStart([act(userCreated, false), act(resumed, false)])).toBe(resumed)
  })

  test("goal-mode resume counts from the resumed activity run, not the old user message", () => {
    // user t0 → 早期活动（已终结，非工具循环）→ 长时间暂停 → 恢复后的连续活动
    const start = effectiveTurnStart([act(0, false), act(60_000, false), act(3_000_000, false), act(3_060_000)])
    expect(start).toBe(3_000_000)
  })

  test("a long-running tool step is NOT mistaken for an idle gap", () => {
    // 评审场景：user → 某步发出工具调用(finish=tool-calls) → 工具跑 >阈值 → 下一步消息才创建。
    // 该大空档是工具在活动，不应重置起点。
    const start = effectiveTurnStart([
      act(0, false),
      act(5_000, true), // 发出工具调用，随后工具运行超过阈值
      act(5_000 + RESUME_GAP_MS + 1, false), // 长工具结束后才创建下一步
    ])
    expect(start).toBe(0)
  })

  test("only gaps larger than the threshold trigger a reset", () => {
    expect(effectiveTurnStart([act(0, false), act(RESUME_GAP_MS)])).toBe(0)
    expect(effectiveTurnStart([act(0, false), act(RESUME_GAP_MS + 1)])).toBe(RESUME_GAP_MS + 1)
  })

  test("ignores non-numeric timestamps and tolerates unordered input", () => {
    expect(
      effectiveTurnStart([act(2_000), { created: undefined as unknown as number, toolLoopContinues: false }, act(1_000)]),
    ).toBe(1_000)
  })
})
