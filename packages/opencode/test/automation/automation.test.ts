import { beforeEach, describe, expect, test } from "bun:test"
import { Database } from "@/storage/db"
import { Automation } from "../../src/automation/automation"
import { globalAutomationDirectory, runtimeDirectory } from "../../src/automation/directory"
import type { ScheduleConfig } from "../../src/automation/schema"

function cfg(p: Partial<ScheduleConfig> = {}): ScheduleConfig {
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

beforeEach(() => {
  const db = Database.Client()
  db.run(/*sql*/ `DELETE FROM automation_run`)
  db.run(/*sql*/ `DELETE FROM automation`)
})

describe("Automation CRUD", () => {
  test("create then get round trip", () => {
    const a = Automation.create({
      title: "每日简报",
      scheduleConfig: cfg({ mode: "daily", time: "09:00" }),
      prompt: "总结今天",
    })
    const got = Automation.get(a.id)
    expect(got?.title).toBe("每日简报")
    expect(got?.enabled).toBe(true)
    expect(got?.scheduleConfig.mode).toBe("daily")
    expect(got?.executionEnvironment).toBe("local")
    expect(got?.nextRunAt).toBeGreaterThan(Date.now() - 1000)
  })

  test("list returns created automations", () => {
    expect(Automation.list()).toHaveLength(0)
    Automation.create({ title: "a", scheduleConfig: cfg({ mode: "hourly", intervalHours: 1 }), prompt: "x" })
    Automation.create({ title: "b", scheduleConfig: cfg({ mode: "hourly", intervalHours: 2 }), prompt: "y" })
    expect(Automation.list()).toHaveLength(2)
  })

  test("update changes fields and recomputes nextRun on schedule change", () => {
    const a = Automation.create({ title: "a", scheduleConfig: cfg({ time: "09:00" }), prompt: "x" })
    const before = Automation.get(a.id)!.nextRunAt
    const updated = Automation.update(a.id, { title: "b", scheduleConfig: cfg({ time: "23:59" }) })
    expect(updated?.title).toBe("b")
    expect(updated?.nextRunAt).not.toBe(before)
  })

  test("update reasoning/executionEnvironment", () => {
    const a = Automation.create({ title: "a", scheduleConfig: cfg(), prompt: "x" })
    const updated = Automation.update(a.id, { reasoningEffort: "high", executionEnvironment: "local" })
    expect(updated?.reasoningEffort).toBe("high")
    expect(updated?.executionEnvironment).toBe("local")
  })

  test("setEnabled toggles", () => {
    const a = Automation.create({ title: "a", scheduleConfig: cfg({ mode: "hourly" }), prompt: "x" })
    expect(Automation.setEnabled(a.id, false)?.enabled).toBe(false)
  })

  test("remove deletes", () => {
    const a = Automation.create({ title: "a", scheduleConfig: cfg({ mode: "hourly" }), prompt: "x" })
    Automation.remove(a.id)
    expect(Automation.get(a.id)).toBeUndefined()
  })

  test("run lifecycle records history", () => {
    const a = Automation.create({ title: "a", scheduleConfig: cfg({ mode: "hourly" }), prompt: "x" })
    const run = Automation.startRun({ automationID: a.id, trigger: "manual" })
    expect(run.status).toBe("running")
    Automation.finishRun(run.id, { status: "success", sessionID: "ses_test" })
    const runs = Automation.listRuns(a.id)
    expect(runs).toHaveLength(1)
    expect(runs[0].status).toBe("success")
    expect(runs[0].sessionID).toBe("ses_test")
  })

  test("markInterruptedRuns fails stale running runs", () => {
    const a = Automation.create({ title: "a", scheduleConfig: cfg({ mode: "hourly" }), prompt: "x" })
    const started = Automation.startRun({ automationID: a.id, trigger: "schedule", sessionID: "ses_stale" })

    // 带年龄门槛(默认 30 分钟);staleAfterMs=0 表示「全部视为过期」
    expect(Automation.markInterruptedRuns(started.startedAt + 1, 0)).toBe(1)

    const runs = Automation.listRuns(a.id)
    expect(runs[0].status).toBe("error")
    expect(runs[0].finishedAt).toBe(started.startedAt + 1)
    expect(runs[0].error).toContain("interrupted")
  })

  test("runtime directory fallback is stable for projectless automation", () => {
    expect(runtimeDirectory(null)).toBe(globalAutomationDirectory())
    expect(runtimeDirectory(undefined)).toBe(globalAutomationDirectory())
    expect(runtimeDirectory(null)).not.toBe(process.cwd())
  })

  test("remove cascades runs", () => {
    const a = Automation.create({ title: "a", scheduleConfig: cfg({ mode: "hourly" }), prompt: "x" })
    Automation.startRun({ automationID: a.id, trigger: "schedule" })
    Automation.remove(a.id)
    expect(Automation.listRuns(a.id)).toHaveLength(0)
  })
})

// computeNextRun 可返回 null(无法排期);断言具体时刻的用例先收窄类型
function nextRun(config: ScheduleConfig, from: number): number {
  const next = Automation.computeNextRun(config, from)
  expect(next).not.toBeNull()
  return next!
}

describe("computeNextRun", () => {
  test("daily: 当天时间未到 → 取当天该时刻", () => {
    const from = new Date(2026, 5, 2, 8, 0, 0).getTime()
    const next = new Date(nextRun(cfg({ mode: "daily", time: "09:00" }), from))
    expect(next.getHours()).toBe(9)
    expect(next.getMinutes()).toBe(0)
    expect(next.getDate()).toBe(2)
  })

  test("daily: 当天时间已过 → 取次日", () => {
    const from = new Date(2026, 5, 2, 10, 0, 0).getTime()
    const next = new Date(nextRun(cfg({ mode: "daily", time: "09:00" }), from))
    expect(next.getDate()).toBe(3)
    expect(next.getHours()).toBe(9)
  })

  test("interval: 每隔 N 分钟", () => {
    const from = new Date(2026, 5, 2, 10, 15, 30).getTime()
    const next = new Date(nextRun(cfg({ mode: "interval", intervalMinutes: 30 }), from))
    // 秒被清零后 + 30 分钟
    expect(next.getMinutes()).toBe(45)
    expect(next.getHours()).toBe(10)
    expect(next.getSeconds()).toBe(0)
  })

  test("hourly: 取下一个整点", () => {
    const from = new Date(2026, 5, 2, 10, 15, 0).getTime()
    const next = new Date(nextRun(cfg({ mode: "hourly", intervalHours: 1 }), from))
    expect(next.getMinutes()).toBe(0)
    expect(next.getHours()).toBe(11)
  })

  test("hourly interval=2: 对齐到偶数小时", () => {
    const from = new Date(2026, 5, 2, 9, 15, 0).getTime()
    const next = new Date(nextRun(cfg({ mode: "hourly", intervalHours: 2 }), from))
    expect(next.getHours() % 2).toBe(0)
    expect(next.getMinutes()).toBe(0)
    expect(next.getTime()).toBeGreaterThan(from)
  })

  test("weekdays: 周末跳到下周一", () => {
    // 2026-06-06 是周六
    const from = new Date(2026, 5, 6, 8, 0, 0).getTime()
    const next = new Date(nextRun(cfg({ mode: "weekdays", time: "09:00" }), from))
    expect(next.getDay()).not.toBe(0)
    expect(next.getDay()).not.toBe(6)
    expect(next.getHours()).toBe(9)
  })

  test("weekly: 落在指定周几(MO)且在未来", () => {
    const from = new Date(2026, 5, 2, 10, 0, 0).getTime()
    const next = new Date(nextRun(cfg({ mode: "weekly", weekdays: ["MO"], time: "09:00" }), from))
    expect(next.getDay()).toBe(1)
    expect(next.getTime()).toBeGreaterThan(from)
  })

  test("custom RRULE: BYHOUR 按本地墙钟解释(与 daily 模式同语义,不按 UTC)", () => {
    const from = new Date(2026, 5, 2, 10, 0, 0).getTime()
    const next = new Date(nextRun(cfg({ mode: "custom", customRrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0" }), from))
    expect(next.getTime()).toBeGreaterThan(from)
    // 关键回归:rrule 库默认按 UTC 展开 BYHOUR,东八区会变成本地 17:00
    expect(next.getHours()).toBe(9)
    expect(next.getMinutes()).toBe(0)
    expect(next.getDate()).toBe(3)
  })

  test("custom RRULE: 带 RRULE: 前缀同样按本地墙钟", () => {
    const from = new Date(2026, 5, 2, 10, 0, 0).getTime()
    const next = new Date(nextRun(cfg({ mode: "custom", customRrule: "RRULE:FREQ=WEEKLY;BYDAY=MO;BYHOUR=9" }), from))
    expect(next.getDay()).toBe(1)
    expect(next.getHours()).toBe(9)
  })

  // 回归:这四种输入曾一律返回 from(=now),导致 next_run_at=现在、调度器每 60 秒无限触发一次完整回合
  test.each([
    ["空 RRULE", ""],
    ["非法 RRULE", "GARBAGE"],
    ["中文文本", "每天9点"],
    ["UNTIL 已过期", "FREQ=DAILY;UNTIL=20200101T000000Z"],
  ])("custom RRULE 无有效排期 → null(%s)", (_label, rule) => {
    const from = new Date(2026, 5, 2, 10, 0, 0).getTime()
    expect(Automation.computeNextRun(cfg({ mode: "custom", customRrule: rule }), from)).toBeNull()
  })

  // 回归:weekly 必须只认 weekdays[0]。上游把「未选星期」表达成全 7 天,
  // 若改成「取全部里最近的一个」,未选星期的每周自动化会静默退化成每天运行。
  test("weekly: 未选星期(全 7 天)时仍按 weekdays[0] 排,不退化成每天", () => {
    const from = new Date(2026, 5, 2, 10, 0, 0).getTime() // 周二
    const next = new Date(nextRun(cfg({ mode: "weekly", time: "09:00" }), from)) // cfg 默认全 7 天,[0]="SU"
    expect(next.getDay()).toBe(0)
    // 不能是次日(那就是退化成每天了)
    expect(next.getDate()).not.toBe(3)
  })

  test("weekly: 多天排期走 custom RRULE(BYDAY)", () => {
    // 2026-06-02 是周二;周一三五 的下一次应是当周周三
    const from = new Date(2026, 5, 2, 10, 0, 0).getTime()
    const next = new Date(
      nextRun(cfg({ mode: "custom", customRrule: "FREQ=WEEKLY;BYDAY=MO,WE,FR;BYHOUR=9;BYMINUTE=0" }), from),
    )
    expect(next.getDay()).toBe(3)
    expect(next.getHours()).toBe(9)
  })
})

describe("排期抖动", () => {
  const from = new Date(2026, 5, 2, 8, 0, 0).getTime()

  test("墙钟型计划加确定性抖动,同输入永远同结果", () => {
    const config = cfg({ mode: "daily", time: "09:00" })
    const base = Automation.computeNextRun(config, from)!
    const a = Automation.nextRunAtFor("atm_x", config, from)!
    const b = Automation.nextRunAtFor("atm_x", config, from)!
    expect(a).toBe(b)
    expect(a).toBeGreaterThanOrEqual(base)
    expect(a - base).toBeLessThan(120_000)
  })

  test("不同自动化错开(避免同一秒惊群)", () => {
    const config = cfg({ mode: "daily", time: "09:00" })
    const offsets = ["atm_a", "atm_b", "atm_c", "atm_d", "atm_e"].map(
      (id) => Automation.nextRunAtFor(id, config, from)! - Automation.computeNextRun(config, from)!,
    )
    expect(new Set(offsets).size).toBeGreaterThan(1)
  })

  test("间隔型不抖(准点节奏不能被漂移累积)", () => {
    const config = cfg({ mode: "interval", intervalMinutes: 30 })
    expect(Automation.nextRunAtFor("atm_x", config, from)).toBe(Automation.computeNextRun(config, from))
  })

  test("分钟级与一次性 custom RRULE 不抖", () => {
    for (const rule of ["FREQ=MINUTELY;INTERVAL=30", "FREQ=DAILY;COUNT=1"]) {
      const config = cfg({ mode: "custom", customRrule: rule })
      expect(Automation.nextRunAtFor("atm_x", config, from)).toBe(Automation.computeNextRun(config, from))
    }
  })

  test("无法排期时抖动不会把 null 变成数字", () => {
    expect(Automation.nextRunAtFor("atm_x", cfg({ mode: "custom", customRrule: "" }), from)).toBeNull()
  })
})

describe("排期落库", () => {
  test("非法 custom RRULE 落库为 next_run_at=null,不会被调度器捞起", () => {
    const a = Automation.create({
      title: "坏排期",
      scheduleConfig: cfg({ mode: "custom", customRrule: "" }),
      prompt: "x",
    })
    expect(Automation.get(a.id)!.nextRunAt).toBeNull()
    // 调度器的 due 判定条件
    expect(Automation.list().filter((x) => x.enabled && x.nextRunAt != null && x.nextRunAt <= Date.now())).toHaveLength(
      0,
    )
  })

  test("恢复启用时以当前时刻重排,不保留暂停期间过期的排期", () => {
    const a = Automation.create({ title: "a", scheduleConfig: cfg({ mode: "daily", time: "09:00" }), prompt: "x" })
    // 模拟暂停期间排期过期
    Automation.markRun(a.id, Date.now() - 3 * 24 * 3600_000)
    Automation.setEnabled(a.id, false)
    const stale = Automation.get(a.id)!.nextRunAt!
    expect(stale).toBeLessThan(Date.now())

    const resumed = Automation.setEnabled(a.id, true)
    expect(resumed?.enabled).toBe(true)
    expect(resumed!.nextRunAt!).toBeGreaterThan(Date.now())
  })

  test("markLastRun 只记上次运行,不挤掉已排好的下一次", () => {
    const a = Automation.create({ title: "a", scheduleConfig: cfg({ mode: "interval", intervalMinutes: 30 }), prompt: "x" })
    const scheduled = Automation.get(a.id)!.nextRunAt
    Automation.markLastRun(a.id, 1234)
    const after = Automation.get(a.id)!
    expect(after.lastRunAt).toBe(1234)
    expect(after.nextRunAt).toBe(scheduled)
  })

  test("暂停不改动排期", () => {
    const a = Automation.create({ title: "a", scheduleConfig: cfg({ mode: "daily", time: "09:00" }), prompt: "x" })
    const before = Automation.get(a.id)!.nextRunAt
    expect(Automation.setEnabled(a.id, false)?.nextRunAt).toBe(before)
  })
})

describe("抢占与去重", () => {
  // 构造一条「已到期」的自动化(调度器真正会捞起来的状态)
  function dueAutomation() {
    const a = Automation.create({ title: "a", scheduleConfig: cfg({ mode: "daily", time: "09:00" }), prompt: "x" })
    Automation.markRun(a.id, Date.now() - 3 * 24 * 3600_000)
    const seen = Automation.get(a.id)!.nextRunAt!
    expect(seen).toBeLessThan(Date.now())
    return { id: a.id, seen }
  }

  test("claimRun:第一个抢到,第二个用同一个旧值抢不到(跨进程互斥)", () => {
    const { id, seen } = dueAutomation()
    expect(Automation.claimRun(id, seen, Date.now())).toBe(true)
    // 第二个进程手里还是旧的 next_run_at → 条件不匹配 → 抢不到
    expect(Automation.claimRun(id, seen, Date.now())).toBe(false)
  })

  test("claimRun 抢到后排期推进到将来,不再被调度器捞起", () => {
    const { id, seen } = dueAutomation()
    const at = Date.now()
    expect(Automation.claimRun(id, seen, at)).toBe(true)
    const after = Automation.get(id)!
    expect(after.nextRunAt!).toBeGreaterThan(seen)
    expect(after.nextRunAt!).toBeGreaterThan(at)
  })

  // 对照 Codex 的 kr/Er 分工:抢占只调排期,lastRunAt 是冷却基线,
  // 被门禁挡住的那次不算「跑过」,提前写会让「用户刚活动过就不打断」的判断整体偏移
  test("claimRun 不写 lastRunAt(冷却基线只在真的跑起来时推进)", () => {
    const { id, seen } = dueAutomation()
    const before = Automation.get(id)!.lastRunAt
    Automation.claimRun(id, seen, Date.now())
    expect(Automation.get(id)!.lastRunAt).toBe(before)
    // 真的开始跑才推进
    Automation.markLastRun(id, 999)
    expect(Automation.get(id)!.lastRunAt).toBe(999)
  })

  test("claimRun:未到期(排期没往前走)时拒绝抢占", () => {
    const a = Automation.create({ title: "a", scheduleConfig: cfg({ mode: "daily", time: "09:00" }), prompt: "x" })
    // 刚创建,next_run_at 已在将来;从 now 重算得到同一个值 → 不是真的到期 → 不许抢
    expect(Automation.claimRun(a.id, Automation.get(a.id)!.nextRunAt, Date.now())).toBe(false)
  })

  test("claimRun:没有排期(null)不可抢", () => {
    const a = Automation.create({ title: "a", scheduleConfig: cfg({ mode: "custom", customRrule: "" }), prompt: "x" })
    expect(Automation.get(a.id)!.nextRunAt).toBeNull()
    expect(Automation.claimRun(a.id, null, Date.now())).toBe(false)
    expect(Automation.claimRun(a.id, 12345, Date.now())).toBe(false)
  })

  test("activeRun:只认超时窗口内的 running,僵尸记录不挡手动触发", () => {
    const a = Automation.create({ title: "a", scheduleConfig: cfg({ mode: "hourly" }), prompt: "x" })
    const run = Automation.startRun({ automationID: a.id, trigger: "manual", sessionID: "ses_1" })
    expect(Automation.activeRun(a.id, 30 * 60_000)?.id).toBe(run.id)
    // 窗口收窄到 0 之后,同一条记录就算「过期僵尸」,不再阻挡新的手动运行
    expect(Automation.activeRun(a.id, 0)).toBeUndefined()
    // 已结束的运行不算活跃
    Automation.finishRun(run.id, { status: "success" })
    expect(Automation.activeRun(a.id, 30 * 60_000)).toBeUndefined()
  })

  test("markInterruptedRuns 带年龄门槛,不误杀其它进程正在跑的运行", () => {
    const a = Automation.create({ title: "a", scheduleConfig: cfg({ mode: "hourly" }), prompt: "x" })
    const fresh = Automation.startRun({ automationID: a.id, trigger: "schedule", sessionID: "ses_live" })
    // 门槛 30 分钟:刚起的这条不该被收尾
    expect(Automation.markInterruptedRuns(Date.now(), 30 * 60_000)).toBe(0)
    expect(Automation.listRuns(a.id)[0].status).toBe("running")
    // 门槛设为 0 时(等价于"全部视为过期")才收尾
    expect(Automation.markInterruptedRuns(Date.now() + 1, 0)).toBe(1)
    const after = Automation.listRuns(a.id).find((r) => r.id === fresh.id)!
    expect(after.status).toBe("error")
    expect(after.error).toContain("interrupted")
  })
})

describe("运行记录", () => {
  test("finishRun 不传 sessionID 时保留 startRun 已绑定的会话", () => {
    const a = Automation.create({ title: "a", scheduleConfig: cfg({ mode: "hourly" }), prompt: "x" })
    const run = Automation.startRun({ automationID: a.id, trigger: "schedule", sessionID: "ses_keep" })
    Automation.finishRun(run.id, { status: "error", error: "boom" })
    const runs = Automation.listRuns(a.id)
    expect(runs[0].sessionID).toBe("ses_keep")
    expect(runs[0].error).toBe("boom")
  })

  test("listRuns 最新在前", () => {
    const a = Automation.create({ title: "a", scheduleConfig: cfg({ mode: "hourly" }), prompt: "x" })
    const first = Automation.startRun({ automationID: a.id, trigger: "schedule", sessionID: "ses_1" })
    Automation.finishRun(first.id, { status: "success" })
    const second = Automation.startRun({ automationID: a.id, trigger: "manual", sessionID: "ses_2" })
    const runs = Automation.listRuns(a.id)
    expect(runs[0].id).toBe(second.id)
    expect(runs[1].id).toBe(first.id)
  })
})

describe("收件箱 CRUD", () => {
  // 回归:markAllRead 曾漏掉 ne(status,'running'),会把正在跑的运行提前标已读;
  // finishRun 不清 read_at,该次运行跑完后永远不算未读 —— 用户再也看不到这次结果/失败
  test("markAllRead 不碰正在跑的运行", () => {
    const a = Automation.create({ title: "a", scheduleConfig: cfg({ mode: "hourly" }), prompt: "x" })
    const running = Automation.startRun({ automationID: a.id, trigger: "schedule", sessionID: "ses_run" })
    const done = Automation.startRun({ automationID: a.id, trigger: "schedule", sessionID: "ses_done" })
    Automation.finishRun(done.id, { status: "success" })

    expect(Automation.markAllRead()).toBe(1)
    const runs = Automation.listRuns(a.id)
    expect(runs.find((r) => r.id === running.id)!.readAt).toBeNull()
    expect(runs.find((r) => r.id === done.id)!.readAt).not.toBeNull()

    // 跑完之后仍然算未读
    Automation.finishRun(running.id, { status: "error", error: "boom" })
    expect(Automation.unreadCount()).toBe(1)
  })

  test("unreadCount 排除运行中与已归档", () => {
    const a = Automation.create({ title: "a", scheduleConfig: cfg({ mode: "hourly" }), prompt: "x" })
    Automation.startRun({ automationID: a.id, trigger: "schedule" })
    const done = Automation.startRun({ automationID: a.id, trigger: "schedule" })
    Automation.finishRun(done.id, { status: "success" })
    expect(Automation.unreadCount()).toBe(1)
    expect(Automation.unreadAutomationIDs()).toEqual([a.id])

    Automation.archiveRun(done.id)
    expect(Automation.unreadCount()).toBe(0)
    expect(Automation.unreadAutomationIDs()).toEqual([])
  })

  // listRuns 返回全部(含已归档):归档是展示态,由前端过滤。
  // 服务端若滤掉已归档,UI 上就没有入口能看到它们,unarchiveRun 永远不可达、归档变成单向操作。
  test("归档后仍在列表里(带 archivedAt),取消归档清空该标记并补上已读", () => {
    const a = Automation.create({ title: "a", scheduleConfig: cfg({ mode: "hourly" }), prompt: "x" })
    const run = Automation.startRun({ automationID: a.id, trigger: "manual", sessionID: "ses_1" })
    Automation.finishRun(run.id, { status: "success" })

    Automation.archiveRun(run.id)
    const archived = Automation.listRuns(a.id)
    expect(archived).toHaveLength(1)
    expect(archived[0].archivedAt).not.toBeNull()
    // 已归档不计入未读
    expect(Automation.unreadCount()).toBe(0)

    Automation.unarchiveRun(run.id)
    const back = Automation.listRuns(a.id)
    expect(back[0].archivedAt).toBeNull()
    // 取消归档要补 read_at,否则会凭空多出一条未读
    expect(back[0].readAt).not.toBeNull()
    expect(Automation.unreadCount()).toBe(0)
  })

  test("archiveAllRuns 只归档已结束的,返回条数", () => {
    const a = Automation.create({ title: "a", scheduleConfig: cfg({ mode: "hourly" }), prompt: "x" })
    const running = Automation.startRun({ automationID: a.id, trigger: "schedule" })
    for (const _ of [1, 2]) {
      const r = Automation.startRun({ automationID: a.id, trigger: "schedule" })
      Automation.finishRun(r.id, { status: "success" })
    }
    expect(Automation.archiveAllRuns(a.id)).toBe(2)
    const all = Automation.listRuns(a.id)
    expect(all).toHaveLength(3)
    // 正在跑的那条不归档,其余两条都带上归档标记
    expect(all.find((r) => r.id === running.id)!.archivedAt).toBeNull()
    expect(all.filter((r) => r.archivedAt !== null)).toHaveLength(2)
  })

  test("setRunInboxItem 落模型给的标题摘要", () => {
    const a = Automation.create({ title: "a", scheduleConfig: cfg({ mode: "hourly" }), prompt: "x" })
    const run = Automation.startRun({ automationID: a.id, trigger: "schedule" })
    Automation.setRunInboxItem(run.id, { title: "3 条 AI 新闻", summary: "先看第一条" })
    const got = Automation.listRuns(a.id)[0]
    expect(got.inboxTitle).toBe("3 条 AI 新闻")
    expect(got.inboxSummary).toBe("先看第一条")
  })
})

// 回归:update 是第二条启停入口(PATCH 开放了 enabled),此前只有 setEnabled 做重排,
// 走 update 恢复启用会保留暂停期间过期的 next_run_at,一恢复就补跑一次失效运行
describe("update 恢复启用", () => {
  test("只传 enabled=true 也以现在为基准重排", () => {
    const a = Automation.create({ title: "a", scheduleConfig: cfg({ mode: "daily", time: "09:00" }), prompt: "x" })
    Automation.markRun(a.id, Date.now() - 3 * 24 * 3600_000)
    Automation.setEnabled(a.id, false)
    expect(Automation.get(a.id)!.nextRunAt!).toBeLessThan(Date.now())

    const updated = Automation.update(a.id, { enabled: true })
    expect(updated!.nextRunAt!).toBeGreaterThan(Date.now())
  })

  test("只传 enabled=false 不动排期", () => {
    const a = Automation.create({ title: "a", scheduleConfig: cfg({ mode: "daily", time: "09:00" }), prompt: "x" })
    const before = Automation.get(a.id)!.nextRunAt
    expect(Automation.update(a.id, { enabled: false })!.nextRunAt).toBe(before)
  })
})

// 回归:b72fc7b7e 给 markAllRead 加了「排除 running」的守卫,但回填迁移又把它丢了。
// 三条写 read_at 的路径必须口径一致,否则升级瞬间在跑的运行会被永久静音。
describe("read_at 写入口径一致", () => {
  // 对照 Codex 的 unarchive:read_at = COALESCE(read_at, now)
  test("unarchiveRun 把原本未读的补成已读(不凭空多出未读)", () => {
    const a = Automation.create({ title: "a", scheduleConfig: cfg({ mode: "hourly" }), prompt: "x" })
    const run = Automation.startRun({ automationID: a.id, trigger: "manual", sessionID: "ses_1" })
    Automation.finishRun(run.id, { status: "error", error: "boom" })
    expect(Automation.listRuns(a.id)[0].readAt).toBeNull()

    Automation.archiveRun(run.id)
    Automation.unarchiveRun(run.id)
    expect(Automation.listRuns(a.id)[0].readAt).not.toBeNull()
    expect(Automation.unreadCount()).toBe(0)
  })

  test("unarchiveRun 不覆盖已读时间", () => {
    const a = Automation.create({ title: "a", scheduleConfig: cfg({ mode: "hourly" }), prompt: "x" })
    const run = Automation.startRun({ automationID: a.id, trigger: "manual", sessionID: "ses_1" })
    Automation.finishRun(run.id, { status: "success" })
    Automation.setRunRead(run.id, true)
    const readAt = Automation.listRuns(a.id)[0].readAt!

    Automation.archiveRun(run.id)
    Automation.unarchiveRun(run.id)
    expect(Automation.listRuns(a.id)[0].readAt).toBe(readAt)
  })
})
