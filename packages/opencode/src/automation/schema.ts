import { Schema } from "effect"

import { Identifier } from "@/id/id"
import { ZodOverride } from "@/util/effect-zod"

export const AutomationID = Schema.String.annotate({ [ZodOverride]: Identifier.schema("automation") }).pipe(
  Schema.brand("AutomationID"),
)
export type AutomationID = Schema.Schema.Type<typeof AutomationID>

export const AutomationRunID = Schema.String.annotate({ [ZodOverride]: Identifier.schema("automation_run") }).pipe(
  Schema.brand("AutomationRunID"),
)
export type AutomationRunID = Schema.Schema.Type<typeof AutomationRunID>

export type TemplateKind = "daily_brief" | "weekly_review" | "project_monitor" | "custom"

// 计划模式(对照 Codex):每小时 / 每天 / 工作日 / 每周 / 自定义 RRULE
export type ScheduleMode = "interval" | "hourly" | "daily" | "weekdays" | "weekly" | "custom"

// 星期代码(RRULE 风格)
export type WeekdayCode = "SU" | "MO" | "TU" | "WE" | "TH" | "FR" | "SA"

export const ALL_WEEKDAYS: WeekdayCode[] = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"]

// 计划配置(Codex 模型):mode 决定生效字段
// - hourly: intervalHours(每 N 小时整点)
// - daily/weekdays: time
// - weekly: weekdays[0] + time
// - custom: customRrule(RRULE 文本)
export interface ScheduleConfig {
  mode: ScheduleMode
  // 「间隔」模式:每隔 N 分钟(对照 Codex intervalMinutes / FREQ=MINUTELY)
  intervalMinutes: number
  intervalHours: number
  // 只读以匹配 Effect Schema(Schema.Array 解码为 readonly),领域逻辑仅读取不变更
  weekdays: readonly WeekdayCode[]
  time: string
  customRrule: string
}

// 执行环境(对照 Codex):本地目录 / 独立工作树 / 注入到某对话
export type ExecutionEnvironment = "local" | "worktree" | "thread"

// 推理强度(对照 Codex)
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh"

export type RunTrigger = "schedule" | "manual"
export type RunStatus = "running" | "success" | "error"

export interface Info {
  id: AutomationID
  title: string
  enabled: boolean
  template: TemplateKind
  scheduleConfig: ScheduleConfig
  prompt: string
  projectID: string | null
  directory: string | null
  // 「对话」(thread/heartbeat)模式附着的已置顶对话 sessionID;到点往该对话注入 prompt(不新建会话)
  threadSessionID: string | null
  executionEnvironment: ExecutionEnvironment
  agent: string | null
  model: string | null
  reasoningEffort: ReasoningEffort | null
  // 通知策略:failed_runs_only = 只在失败时通知(成功的运行直接标已读,对照 Codex);
  // null = 每次跑完都通知
  notificationPolicy: NotificationPolicy
  lastRunAt: number | null
  nextRunAt: number | null
  time: { created: number; updated: number }
}

// 通知策略(对照 Codex:枚举只有 failed_runs_only,null = 每次跑完都通知)
export type NotificationPolicy = "failed_runs_only" | null

export interface RunInfo {
  id: AutomationRunID
  automationID: AutomationID
  sessionID: string | null
  // 会话所在目录(base64 编码后用于前端跳转到对应会话)
  directory: string | null
  trigger: RunTrigger
  status: RunStatus
  startedAt: number
  finishedAt: number | null
  error: string | null
  // 收件箱:readAt 为空 = 未读;archivedAt 为空 = 未归档
  readAt: number | null
  archivedAt: number | null
  // 归档原因(对照 Codex 的 archived_reason)。目前只有用户手动归档一条路径,故恒为 null;
  // 保留该列是为将来的自动归档(如批量清理)留位,写入方 archiveRun 已支持传入原因。
  archivedReason: string | null
  // 模型用 ::inbox-item 指令给出的「这次跑出了什么」
  inboxTitle: string | null
  inboxSummary: string | null
}

export interface CreateInput {
  title: string
  template?: TemplateKind
  scheduleConfig: ScheduleConfig
  prompt: string
  projectID?: string
  // 项目工作目录(对照 Codex cwds)。输入字段命名为 cwd 以避开 SDK flat 参数里
  // 与实例路由 query 参数 directory 的命名冲突;落库仍写 directory 列。
  cwd?: string
  threadSessionID?: string | null
  executionEnvironment?: ExecutionEnvironment
  agent?: string
  model?: string
  reasoningEffort?: ReasoningEffort | null
  notificationPolicy?: NotificationPolicy
  enabled?: boolean
}

export interface UpdateInput {
  title?: string
  enabled?: boolean
  template?: TemplateKind
  scheduleConfig?: ScheduleConfig
  prompt?: string
  projectID?: string | null
  cwd?: string | null
  threadSessionID?: string | null
  executionEnvironment?: ExecutionEnvironment
  agent?: string | null
  model?: string | null
  reasoningEffort?: ReasoningEffort | null
  notificationPolicy?: NotificationPolicy
}

// 计划配置默认值(对照 Codex Ht():daily / 09:00 / 全 7 天)
export function defaultScheduleConfig(): ScheduleConfig {
  return { mode: "daily", intervalMinutes: 30, intervalHours: 24, weekdays: [...ALL_WEEKDAYS], time: "09:00", customRrule: "" }
}
