import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { InstanceState } from "@/effect/instance-state"
import { Automation } from "@/automation/automation"
import { defaultScheduleConfig } from "@/automation/schema"
import { globalAutomationDirectory } from "@/automation/directory"
import { MessageV2 } from "@/session/message-v2"

const ScheduleMode = Schema.Literals(["interval", "hourly", "daily", "weekdays", "weekly", "custom"])
const WeekdayCode = Schema.Literals(["SU", "MO", "TU", "WE", "TH", "FR", "SA"])
const AutomationScope = Schema.Literals(["current_project", "global"])

export const Parameters = Schema.Struct({
  title: Schema.String.annotate({ description: "简短的自动化标题(展示在自动化列表里)" }),
  prompt: Schema.String.annotate({
    description: [
      "每次到点运行时执行的任务提示词。只描述任务本身。",
      "禁止写入排期与投递语义:不要出现「每天」「每周」「每隔 N 分钟」「北京时间 09:00」「定时」「发送给我」这类措辞,",
      "也不要写归属哪个项目/对话 —— 这些已由 mode/time/weekdays/intervalMinutes/scope 参数承载,写进来会让运行时的模型",
      "把它重新理解成一次「请帮我建立自动化」的请求而去反问用户,导致自动化永远不执行真正的任务。",
      "必须自包含、可独立执行:运行时没有用户在场、也读不到本次对话的上下文。需要时把输出格式要求写进去。",
      "反例:「每天北京时间 09:00 汇总当天科技新闻并发送给我」。正例:「汇总当天最新、重要的科技新闻,每条包含标题、来源、发布时间和一到两句摘要」。",
    ].join(""),
  }),
  mode: Schema.optional(ScheduleMode).annotate({
    description:
      "计划模式:interval(每隔 intervalMinutes 分钟)、daily(每天 time 运行)、weekdays(周一至周五 time)、weekly(weekdays 指定的星期 time)、hourly(每 intervalHours 小时)、custom(用 customRrule)。缺省 daily。",
  }),
  intervalMinutes: Schema.optional(Schema.Number).annotate({
    description: "interval 模式的间隔分钟数,缺省 30",
  }),
  time: Schema.optional(Schema.String).annotate({
    description: "daily/weekdays/weekly 模式的运行时刻,24 小时制 HH:MM,缺省 09:00",
  }),
  weekdays: Schema.optional(Schema.Array(WeekdayCode)).annotate({
    description:
      "weekly 模式的星期,只取第一个生效(SU/MO/TU/WE/TH/FR/SA),必须显式传一个。需要每周多天(如周一三五)时改用 mode=custom + customRrule=FREQ=WEEKLY;BYDAY=MO,WE,FR;BYHOUR=9;BYMINUTE=0",
  }),
  intervalHours: Schema.optional(Schema.Number).annotate({
    description: "hourly 模式的间隔小时数",
  }),
  customRrule: Schema.optional(Schema.String).annotate({
    description: "custom 模式的 iCalendar RRULE 文本,如 FREQ=DAILY;BYHOUR=9;BYMINUTE=0",
  }),
  scope: Schema.optional(AutomationScope).annotate({
    description:
      "自动化归属:current_project 绑定当前项目和当前对话;global 不属于任何项目,运行时创建独立会话。缺省 current_project。用户明确说不关联项目/不属于当前项目/全局/独立自动化时使用 global。",
  }),
})

type Metadata = { automationID: string }

const DESCRIPTION = [
  "创建一个按计划重复运行的自动化(对照 Codex 的 create-via-chat)。",
  "仅在已经与用户确认清楚以下四点后才调用:",
  "1) 自动化要做什么(写进 prompt,作为独立任务);2) 一个简短标题;3) 运行计划;4) 是否属于当前项目/当前对话。",
  "把用户原话拆成两部分再填参数:任务本身填 prompt,时间/周期填 mode+time+weekdays+intervalMinutes,",
  "两者不得重复 —— prompt 里再出现一次排期措辞会让每次运行的模型误判成「用户要建自动化」而反问,自动化就永远不干活。",
  "自动化默认绑定到当前项目和当前对话(到点把 prompt 注入本对话继续执行),计划默认每隔 30 分钟,可按用户要求调整。",
  "如果用户明确说不属于当前项目、全局、独立或不关联项目,把 scope 设为 global。",
  "确认这四点时用普通文字对话、一次问一个,不要用 question 工具弹选择控件。",
].join("\n")

export const AutomationCreateTool = Tool.define<typeof Parameters, Metadata, never>(
  "automation_create",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          // 通过聊天创建默认绑定到当前对话(thread/heartbeat 模式),到点把 prompt 注入本对话;
          // 未显式指定计划时默认每隔 30 分钟(对照 Codex 绑定对话的默认计划)。
          const base = { ...defaultScheduleConfig(), mode: "interval" as const, intervalMinutes: 30 }
          const scheduleConfig = {
            ...base,
            ...(params.mode ? { mode: params.mode } : {}),
            ...(params.time ? { time: params.time } : {}),
            ...(params.weekdays?.length ? { weekdays: [...params.weekdays] } : {}),
            ...(params.intervalMinutes ? { intervalMinutes: params.intervalMinutes } : {}),
            ...(params.intervalHours ? { intervalHours: params.intervalHours } : {}),
            ...(params.customRrule ? { customRrule: params.customRrule } : {}),
          }
          // custom 模式必须真能算出下次运行,否则会造出一个「已启用但永远不运行」的僵尸自动化:
          // next_run_at 落 NULL → 调度器的 due 判定永远命中不到 → 一条运行记录都不会有。
          // 对照 Codex:create/update 在算不出 occurrence 时直接抛
          // 「Automation schedule has no future runs.…」而不是静默落库。
          // 这里不创建、把错误交回模型让它改排期(注意 markRun 不能这样做 —— COUNT=1
          // 这类一次性规则算出 null 是正常终态)。
          if (scheduleConfig.mode === "custom" && Automation.computeNextRun(scheduleConfig, Date.now()) === null) {
            return {
              title: params.title,
              output: [
                `未创建自动化「${params.title}」:custom 模式的 RRULE 算不出任何将来的运行时间`,
                `(customRrule=${JSON.stringify(scheduleConfig.customRrule)})。`,
                "请改用结构化计划(mode=daily/weekdays/weekly/hourly/interval),",
                "或给出合法且仍有将来运行的 RRULE,例如 FREQ=WEEKLY;BYDAY=MO,WE,FR;BYHOUR=9;BYMINUTE=0。",
              ].join(""),
              metadata: { automationID: "" },
            }
          }
          // 跟随当前对话:模型取本次生成所用模型(对照 task.ts 从当前消息读取);
          // 推理强度未持久化在消息上,与手动编辑器一致默认 medium。
          // 取不到消息(理论上不会)时优雅降级为不设模型,避免创建失败。
          const model = yield* Effect.sync(() => {
            try {
              const msg = MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID })
              return msg?.info.role === "assistant" ? `${msg.info.providerID}/${msg.info.modelID}` : undefined
            } catch {
              return undefined
            }
          })
          const scope = params.scope ?? "current_project"
          const created = yield* Effect.sync(() =>
            Automation.create({
              title: params.title,
              prompt: params.prompt,
              ...(scope === "current_project"
                ? { cwd: instance.directory, executionEnvironment: "thread" as const, threadSessionID: ctx.sessionID }
                : { cwd: globalAutomationDirectory(), executionEnvironment: "local" as const }),
              scheduleConfig,
              model,
              reasoningEffort: "medium",
            }),
          )
          const next = created.nextRunAt ? new Date(created.nextRunAt).toLocaleString() : "未排期"
          const scopeLabel = scope === "current_project" ? "当前项目/对话" : "不属于项目"
          return {
            title: created.title,
            output: `已创建自动化「${created.title}」(id ${created.id},归属:${scopeLabel})。下次运行:${next}。可在左侧「自动化」页查看或编辑。`,
            metadata: { automationID: created.id },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
