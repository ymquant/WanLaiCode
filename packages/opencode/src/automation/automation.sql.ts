import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../storage/schema.sql"
import type { AutomationID, AutomationRunID, ScheduleConfig } from "./schema"

export const AutomationTable = sqliteTable("automation", {
  id: text().$type<AutomationID>().primaryKey(),
  title: text().notNull(),
  enabled: integer({ mode: "boolean" }).notNull().$default(() => true),
  template: text().notNull().$default(() => "custom"),
  schedule_kind: text().notNull(),
  schedule_config: text({ mode: "json" }).notNull().$type<ScheduleConfig>(),
  prompt: text().notNull(),
  project_id: text(),
  directory: text(),
  thread_session_id: text(),
  execution_environment: text().notNull().$default(() => "worktree"),
  agent: text(),
  model: text(),
  reasoning_effort: text(),
  // 通知策略:"failed_runs_only" 或 NULL(每次跑完都通知)
  notification_policy: text(),
  last_run_at: integer(),
  next_run_at: integer(),
  ...Timestamps,
})

export const AutomationRunTable = sqliteTable(
  "automation_run",
  {
    id: text().$type<AutomationRunID>().primaryKey(),
    automation_id: text()
      .$type<AutomationID>()
      .notNull()
      .references(() => AutomationTable.id, { onDelete: "cascade" }),
    session_id: text(),
    directory: text(),
    trigger: text().notNull(),
    status: text().notNull(),
    started_at: integer().notNull(),
    finished_at: integer(),
    error: text(),
    // 收件箱(对照 Codex automation_runs 的 read_at / inbox_title / inbox_summary /
    // archived_reason)。read_at 为空 = 未读;archived_at 为空 = 未归档。
    // inbox_title/summary 由模型在回复末尾用 ::inbox-item 指令给出,解析后落这里,
    // 使收件箱列表不必再去读整个会话就能显示「这次跑出了什么」。
    read_at: integer(),
    archived_at: integer(),
    archived_reason: text(),
    inbox_title: text(),
    inbox_summary: text(),
  },
  (table) => [
    index("automation_run_automation_idx").on(table.automation_id),
    // 未读计数(unreadCount / unreadAutomationIDs)每次轮询都跑,判据是
    // read_at IS NULL AND archived_at IS NULL AND status != 'running' —— 按这两列建索引。
    // 列表查询 listRuns 以 automation_id 过滤,由上面那条索引覆盖。
    index("automation_run_archived_at_read_at_idx").on(table.archived_at, table.read_at),
  ],
)
