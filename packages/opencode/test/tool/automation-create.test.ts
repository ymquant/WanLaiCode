import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AutomationCreateTool } from "../../src/tool/automation-create"
import { Automation } from "../../src/automation/automation"
import { globalAutomationDirectory } from "../../src/automation/directory"
import type { AutomationID } from "../../src/automation/schema"
import { Truncate } from "@/tool/truncate"
import { Tool } from "@/tool/tool"
import { Agent } from "../../src/agent/agent"
import { SessionID, MessageID } from "../../src/session/schema"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const ctx: Tool.Context = {
  sessionID: SessionID.make("ses_test-automation-tool"),
  messageID: MessageID.make(""),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

afterEach(async () => {
  await disposeAllInstances()
})

const it = testEffect(Layer.mergeAll(Truncate.defaultLayer, Agent.defaultLayer))

const init = Effect.fn("AutomationCreateToolTest.init")(function* () {
  const info = yield* AutomationCreateTool
  return yield* info.init()
})

// 运行工具并按返回的 automationID 取回落库结果(不依赖 list 顺序,实例 DB 在用例间共享)
const create = Effect.fn("AutomationCreateToolTest.create")(function* (
  args: Tool.InferParameters<typeof AutomationCreateTool>,
) {
  const tool = yield* init()
  const result = yield* tool.execute(args, ctx)
  const id = (result.metadata as { automationID: AutomationID }).automationID
  const got = yield* Effect.sync(() => Automation.get(id))
  return { result, got: got! }
})

describe("tool.automation_create", () => {
  it.instance("默认在当前项目和当前对话创建自动化并落库", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { result, got } = yield* create({ title: "每日简报", prompt: "总结今天的进展" } as any)
      expect(result.output).toContain("已创建自动化")
      expect(result.output).toContain("归属:当前项目/对话")
      expect(got.title).toBe("每日简报")
      expect(got.prompt).toBe("总结今天的进展")
      expect(got.directory).toBe(test.directory)
      expect(got.nextRunAt).toBeGreaterThan(Date.now() - 1000)
      // 跟随对话:推理强度默认 medium(消息缺失时模型优雅降级为空)
      expect(got.reasoningEffort).toBe("medium")
      // 默认绑定到当前对话(thread/heartbeat 模式)
      expect(got.executionEnvironment).toBe("thread")
      expect(got.threadSessionID).toBe(ctx.sessionID)
    }),
  )

  it.instance("global scope 创建不属于项目的独立自动化", () =>
    Effect.gen(function* () {
      const { result, got } = yield* create({
        title: "全局提醒",
        prompt: "提醒我休息",
        scope: "global",
      } as any)
      expect(result.output).toContain("归属:不属于项目")
      expect(got.title).toBe("全局提醒")
      expect(got.prompt).toBe("提醒我休息")
      expect(got.directory).toBe(globalAutomationDirectory())
      expect(got.directory).not.toBe(process.cwd())
      expect(got.projectID).toBeNull()
      // 新建一律 local:worktree 从未真的建过工作树,已按 Codex 从可选项里移除(仅存量保留)
      expect(got.executionEnvironment).toBe("local")
      expect(got.threadSessionID).toBeNull()
    }),
  )

  it.instance("current_project scope 显式绑定实例目录和当前对话", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { got } = yield* create({
        title: "项目内监控",
        prompt: "检查这个项目状态",
        scope: "current_project",
      } as any)
      expect(got.directory).toBe(test.directory)
      expect(got.executionEnvironment).toBe("thread")
      expect(got.threadSessionID).toBe(ctx.sessionID)
    }),
  )

  it.instance("缺省绑定对话 → 计划默认每隔 30 分钟", () =>
    Effect.gen(function* () {
      const { got } = yield* create({ title: "x", prompt: "y" } as any)
      expect(got.scheduleConfig.mode).toBe("interval")
      expect(got.scheduleConfig.intervalMinutes).toBe(30)
    }),
  )

  it.instance("custom 模式透传 RRULE", () =>
    Effect.gen(function* () {
      const { got } = yield* create({
        title: "z",
        prompt: "w",
        mode: "custom",
        customRrule: "FREQ=HOURLY;INTERVAL=2",
      } as any)
      expect(got.scheduleConfig.mode).toBe("custom")
      expect(got.scheduleConfig.customRrule).toBe("FREQ=HOURLY;INTERVAL=2")
    }),
  )

  it.instance("weekly 模式带星期", () =>
    Effect.gen(function* () {
      const { got } = yield* create({
        title: "周报",
        prompt: "汇总本周",
        mode: "weekly",
        weekdays: ["FR"],
        time: "17:00",
      } as any)
      expect(got.scheduleConfig.mode).toBe("weekly")
      expect(got.scheduleConfig.weekdays).toEqual(["FR"])
      expect(got.scheduleConfig.time).toBe("17:00")
    }),
  )

  // custom 模式算不出将来运行时不能落库:否则造出「已启用但永远不运行」的僵尸自动化
  // (next_run_at=NULL → 调度器 due 判定永远命中不到 → 一条运行记录都没有)
  for (const [label, customRrule] of [
    ["漏填 customRrule", undefined],
    ["空 customRrule", ""],
    ["非法 RRULE", "每15分钟"],
    ["UNTIL 已过期", "FREQ=DAILY;UNTIL=20200101T000000Z"],
  ] as const) {
    it.instance(`custom 模式无将来运行时拒绝创建(${label})`, () =>
      Effect.gen(function* () {
        const before = yield* Effect.sync(() => Automation.list().length)
        const tool = yield* init()
        const result = yield* tool.execute(
          { title: "坏排期", prompt: "做点什么", mode: "custom", customRrule } as any,
          ctx,
        )
        expect(result.output).toContain("未创建自动化")
        expect(result.output).toContain("算不出任何将来的运行时间")
        expect((result.metadata as { automationID: string }).automationID).toBe("")
        expect(yield* Effect.sync(() => Automation.list().length)).toBe(before)
      }),
    )
  }

  it.instance("custom 模式给出合法 RRULE 时正常创建", () =>
    Effect.gen(function* () {
      const { got } = yield* create({
        title: "周一三五",
        prompt: "汇总",
        mode: "custom",
        customRrule: "FREQ=WEEKLY;BYDAY=MO,WE,FR;BYHOUR=9;BYMINUTE=0",
      } as any)
      expect(got.scheduleConfig.mode).toBe("custom")
      expect(got.nextRunAt).toBeGreaterThan(Date.now() - 1000)
      expect(new Date(got.nextRunAt!).getHours()).toBe(9)
    }),
  )
})
