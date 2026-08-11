import { describe, expect, test } from "bun:test"
import { RUN_BLOCKED_TOOLS, runContract, runHeader } from "../../src/automation/message"
import { cooldownUntil, gateBackoffAt, gateMessage, runOutcome } from "../../src/automation/run"
import type { ScheduleConfig } from "../../src/automation/schema"
import type { MessageV2 } from "../../src/session/message-v2"

const automation = {
  id: "atm_test" as never,
  title: "每日科技新闻",
  lastRunAt: null as number | null,
}

describe("runHeader", () => {
  test("三行元信息:名字、ID、上次运行", () => {
    expect(runHeader(automation).split("\n")).toEqual([
      "Automation: 每日科技新闻",
      "Automation ID: atm_test",
      "Last run: never",
    ])
  })

  test("有上次运行时间时同时给出 ISO 与毫秒时间戳", () => {
    const at = Date.UTC(2026, 6, 29, 1, 0, 0)
    expect(runHeader({ ...automation, lastRunAt: at })).toContain(`Last run: ${new Date(at).toISOString()} (${at})`)
  })

  test("不引用不存在的 memory 文件(Codex 有 memory.md,本项目没有)", () => {
    expect(runHeader(automation)).not.toContain("memory")
  })
})

describe("runContract", () => {
  const text = runContract("atm_test")

  test("声明这不是用户发的、无人值守", () => {
    expect(text).toContain("不是用户发的")
    expect(text).toContain("没有用户在场")
  })

  test("禁止反问与等待确认", () => {
    expect(text).toContain("不要向用户提问")
  })

  // 线上主 bug:模型把带排期措辞的任务提示词重新理解成「请帮我建自动化」并反问用户确认。
  // 这两条是唯一能兜住「库里已存的坏 prompt」的机制,改文案时必须保住语义。
  test("禁止创建/修改自动化,并说明任务里的时间措辞不是让它去配置排期", () => {
    expect(text).toContain("不要创建、修改或删除任何自动化")
    expect(text).toContain("本次就按这个任务做一遍")
  })

  test("带上 automation ID 便于模型定位自身", () => {
    expect(text).toContain("atm_test")
  })
})

describe("RUN_BLOCKED_TOOLS", () => {
  test("自动化运行屏蔽提问与创建自动化两个工具", () => {
    expect(RUN_BLOCKED_TOOLS.has("question")).toBe(true)
    expect(RUN_BLOCKED_TOOLS.has("automation_create")).toBe(true)
  })

  test("不误伤执行类工具", () => {
    for (const id of ["shell", "read", "edit", "write", "webfetch", "websearch", "task"]) {
      expect(RUN_BLOCKED_TOOLS.has(id)).toBe(false)
    }
  })
})

// 构造一条最小 assistant 结果;runOutcome 只读 role/error/finish 三个字段
function assistant(patch: Record<string, unknown>): MessageV2.WithParts {
  return { info: { role: "assistant", ...patch }, parts: [] } as unknown as MessageV2.WithParts
}

describe("runOutcome", () => {
  test("正常收尾 → success", () => {
    expect(runOutcome(assistant({ finish: "stop" }))).toEqual({ status: "success" })
  })

  test("length 截断仍算收尾(与会话层 assistantCompletesInstruction 判据一致)", () => {
    expect(runOutcome(assistant({ finish: "length" })).status).toBe("success")
  })

  // 回归:模型侧失败被 processor.halt 收敛成正常 resolve,只看 prompt 有没有抛异常会一律记 success
  test("assistant 带 error → error,并取出错误文案", () => {
    const outcome = runOutcome(assistant({ finish: "stop", error: { name: "ProviderError", data: { message: "配额耗尽" } } }))
    expect(outcome.status).toBe("error")
    expect(outcome.error).toBe("配额耗尽")
  })

  test("error 无 data.message 时回退到错误名", () => {
    expect(runOutcome(assistant({ error: { name: "UnknownError" } })).error).toBe("UnknownError")
  })

  // 回归:被动中断(实例 scope 关闭/驱逐)走 finalizeInterrupted,只补 completed 不写 finish
  test("没有 finish 的半截回合 → error", () => {
    const outcome = runOutcome(assistant({ time: { created: 1, completed: 2 } }))
    expect(outcome.status).toBe("error")
    expect(outcome.error).toContain("被中断")
  })

  test("停在 tool-calls/unknown → error", () => {
    for (const finish of ["tool-calls", "unknown"]) {
      const outcome = runOutcome(assistant({ finish }))
      expect(outcome.status).toBe("error")
      expect(outcome.error).toContain(finish)
    }
  })

  test("回合被取消导致返回的是 user 消息 → error", () => {
    const outcome = runOutcome({ info: { role: "user" }, parts: [] } as unknown as MessageV2.WithParts)
    expect(outcome.status).toBe("error")
  })
})

function sched(p: Partial<ScheduleConfig> = {}): ScheduleConfig {
  return {
    mode: "daily",
    intervalMinutes: 30,
    intervalHours: 24,
    weekdays: ["SU", "MO", "TU", "WE", "TH", "FR", "SA"],
    time: "09:00",
    customRrule: "",
    ...p,
  }
}

describe("运行门禁", () => {
  test("退避不超过 60 秒", () => {
    const now = new Date(2026, 5, 2, 8, 0, 0).getTime()
    expect(gateBackoffAt(sched({ mode: "daily", time: "09:00" }), now)).toBe(now + 60_000)
  })

  test("排期比 60 秒更近时按排期,不把用户排期往后推", () => {
    // 每隔 1 分钟 → 下次排期在 60 秒内(秒被清零,所以恰好 <= now+60s)
    const now = new Date(2026, 5, 2, 8, 0, 30).getTime()
    const at = gateBackoffAt(sched({ mode: "interval", intervalMinutes: 1 }), now)
    expect(at).toBeLessThanOrEqual(now + 60_000)
  })

  test("算不出排期时用固定 60 秒退避", () => {
    const now = Date.now()
    expect(gateBackoffAt(sched({ mode: "custom", customRrule: "" }), now)).toBe(now + 60_000)
  })

  // 冷却只对间隔型生效:墙钟排期是用户明确指定的时刻,不能被"刚活动过"推掉
  test("墙钟排期不设冷却", () => {
    for (const mode of ["daily", "weekdays", "weekly", "hourly"] as const) {
      expect(cooldownUntil(sched({ mode }), Date.now(), Date.now())).toBeNull()
    }
  })

  test("间隔型:基线取上次运行与会话活动的较晚者", () => {
    const config = sched({ mode: "interval", intervalMinutes: 30 })
    const lastRun = 1_000_000
    const threadTouched = 2_000_000
    expect(cooldownUntil(config, lastRun, threadTouched)).toBe(threadTouched + 30 * 60_000)
    expect(cooldownUntil(config, threadTouched, lastRun)).toBe(threadTouched + 30 * 60_000)
  })

  test("间隔型:从未跑过也没活动过时不设冷却(首次要能跑起来)", () => {
    expect(cooldownUntil(sched({ mode: "interval" }), null, null)).toBeNull()
    expect(cooldownUntil(sched({ mode: "interval" }), null, 0)).toBeNull()
  })
})

describe("gateMessage", () => {
  test("每种原因都给出可读说明,不泄漏内部标识", () => {
    expect(gateMessage("thread_missing")).toContain("对话已不存在")
    expect(gateMessage("thread_busy(busy)")).toContain("正在进行中")
    expect(gateMessage("thread_busy(retry)")).toContain("正在进行中")
    expect(gateMessage("cooldown_not_elapsed")).toContain("间隔")
  })

  test("未知原因兜底也带上原因便于排查", () => {
    expect(gateMessage("something_new")).toContain("something_new")
  })
})
