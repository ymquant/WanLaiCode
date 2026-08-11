import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { AutomationID, AutomationRunID } from "@/automation/schema"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware } from "../middleware/workspace-routing"
import { Authorization } from "../middleware/authorization"
import { described } from "./metadata"

const Template = Schema.Literals(["daily_brief", "weekly_review", "project_monitor", "custom"])
const ScheduleMode = Schema.Literals(["interval", "hourly", "daily", "weekdays", "weekly", "custom"])
const WeekdayCode = Schema.Literals(["SU", "MO", "TU", "WE", "TH", "FR", "SA"])
const ScheduleConfig = Schema.Struct({
  mode: ScheduleMode,
  intervalMinutes: Schema.Number,
  intervalHours: Schema.Number,
  weekdays: Schema.Array(WeekdayCode),
  time: Schema.String,
  customRrule: Schema.String,
})
const ExecutionEnvironment = Schema.Literals(["local", "worktree", "thread"])
const ReasoningEffort = Schema.Literals(["none", "minimal", "low", "medium", "high", "xhigh"])

export const AutomationInfo = Schema.Struct({
  id: AutomationID,
  title: Schema.String,
  enabled: Schema.Boolean,
  template: Template,
  scheduleConfig: ScheduleConfig,
  prompt: Schema.String,
  projectID: Schema.NullOr(Schema.String),
  directory: Schema.NullOr(Schema.String),
  threadSessionID: Schema.NullOr(Schema.String),
  executionEnvironment: ExecutionEnvironment,
  agent: Schema.NullOr(Schema.String),
  model: Schema.NullOr(Schema.String),
  reasoningEffort: Schema.NullOr(ReasoningEffort),
  notificationPolicy: Schema.NullOr(Schema.Literal("failed_runs_only")),
  lastRunAt: Schema.NullOr(Schema.Number),
  nextRunAt: Schema.NullOr(Schema.Number),
  time: Schema.Struct({ created: Schema.Number, updated: Schema.Number }),
})

export const AutomationRunInfo = Schema.Struct({
  id: AutomationRunID,
  automationID: AutomationID,
  sessionID: Schema.NullOr(Schema.String),
  directory: Schema.NullOr(Schema.String),
  trigger: Schema.Literals(["schedule", "manual"]),
  status: Schema.Literals(["running", "success", "error"]),
  startedAt: Schema.Number,
  finishedAt: Schema.NullOr(Schema.Number),
  error: Schema.NullOr(Schema.String),
  readAt: Schema.NullOr(Schema.Number),
  archivedAt: Schema.NullOr(Schema.Number),
  archivedReason: Schema.NullOr(Schema.String),
  inboxTitle: Schema.NullOr(Schema.String),
  inboxSummary: Schema.NullOr(Schema.String),
})

export const AutomationUnread = Schema.Struct({
  total: Schema.Number,
  automationIDs: Schema.Array(AutomationID),
})

export const AutomationOk = Schema.Struct({ ok: Schema.Boolean })
export const AutomationCount = Schema.Struct({ count: Schema.Number })

export const AutomationRunSession = Schema.Struct({
  sessionID: Schema.String,
  automationID: AutomationID,
  status: Schema.Literals(["running", "success", "error"]),
})

const CreatePayload = Schema.Struct({
  title: Schema.String,
  template: Schema.optional(Template),
  scheduleConfig: ScheduleConfig,
  prompt: Schema.String,
  projectID: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.String),
  threadSessionID: Schema.optional(Schema.NullOr(Schema.String)),
  executionEnvironment: Schema.optional(ExecutionEnvironment),
  agent: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  reasoningEffort: Schema.optional(Schema.NullOr(ReasoningEffort)),
  notificationPolicy: Schema.optional(Schema.NullOr(Schema.Literal("failed_runs_only"))),
  enabled: Schema.optional(Schema.Boolean),
})

const UpdatePayload = Schema.Struct({
  title: Schema.optional(Schema.String),
  enabled: Schema.optional(Schema.Boolean),
  template: Schema.optional(Template),
  scheduleConfig: Schema.optional(ScheduleConfig),
  prompt: Schema.optional(Schema.String),
  projectID: Schema.optional(Schema.NullOr(Schema.String)),
  cwd: Schema.optional(Schema.NullOr(Schema.String)),
  threadSessionID: Schema.optional(Schema.NullOr(Schema.String)),
  executionEnvironment: Schema.optional(ExecutionEnvironment),
  agent: Schema.optional(Schema.NullOr(Schema.String)),
  model: Schema.optional(Schema.NullOr(Schema.String)),
  reasoningEffort: Schema.optional(Schema.NullOr(ReasoningEffort)),
  notificationPolicy: Schema.optional(Schema.NullOr(Schema.Literal("failed_runs_only"))),
})

const TogglePayload = Schema.Struct({ enabled: Schema.Boolean })

const root = "/automation"

export const AutomationApi = HttpApi.make("automation")
  .add(
    HttpApiGroup.make("automation")
      .add(
        HttpApiEndpoint.get("list", root, {
          success: described(Schema.Array(AutomationInfo), "List of automations"),
        }).annotateMerge(OpenApi.annotations({ identifier: "automation.list", summary: "List automations" })),
        HttpApiEndpoint.post("create", root, {
          payload: CreatePayload,
          success: described(AutomationInfo, "Created automation"),
          error: [HttpApiError.BadRequest],
        }).annotateMerge(OpenApi.annotations({ identifier: "automation.create", summary: "Create automation" })),
        HttpApiEndpoint.get("runSessions", `${root}/run-sessions`, {
          success: described(Schema.Array(AutomationRunSession), "Automation-originated sessions"),
        }).annotateMerge(
          OpenApi.annotations({ identifier: "automation.runSessions", summary: "List automation-originated sessions" }),
        ),
        HttpApiEndpoint.get("get", `${root}/:automationID`, {
          params: { automationID: AutomationID },
          success: described(AutomationInfo, "Automation"),
          error: [HttpApiError.NotFound],
        }).annotateMerge(OpenApi.annotations({ identifier: "automation.get", summary: "Get automation" })),
        HttpApiEndpoint.patch("update", `${root}/:automationID`, {
          params: { automationID: AutomationID },
          payload: UpdatePayload,
          success: described(AutomationInfo, "Updated automation"),
          error: [HttpApiError.BadRequest, HttpApiError.NotFound],
        }).annotateMerge(OpenApi.annotations({ identifier: "automation.update", summary: "Update automation" })),
        HttpApiEndpoint.delete("remove", `${root}/:automationID`, {
          params: { automationID: AutomationID },
          success: described(Schema.Boolean, "Deleted"),
          error: [HttpApiError.NotFound],
        }).annotateMerge(OpenApi.annotations({ identifier: "automation.remove", summary: "Delete automation" })),
        HttpApiEndpoint.post("toggle", `${root}/:automationID/toggle`, {
          params: { automationID: AutomationID },
          payload: TogglePayload,
          success: described(AutomationInfo, "Toggled automation"),
          error: [HttpApiError.NotFound],
        }).annotateMerge(OpenApi.annotations({ identifier: "automation.toggle", summary: "Toggle automation" })),
        HttpApiEndpoint.post("run", `${root}/:automationID/run`, {
          params: { automationID: AutomationID },
          success: described(AutomationRunInfo, "Run started"),
          error: [HttpApiError.NotFound],
        }).annotateMerge(OpenApi.annotations({ identifier: "automation.run", summary: "Trigger automation run" })),
        HttpApiEndpoint.get("runs", `${root}/:automationID/runs`, {
          params: { automationID: AutomationID },
          success: described(Schema.Array(AutomationRunInfo), "Automation runs"),
        }).annotateMerge(OpenApi.annotations({ identifier: "automation.runs", summary: "List automation runs" })),
        // 收件箱(未读/归档)。两套路由必须成对新增 —— 只加 hono 一侧会让 httpapi 后端 404,
        // 只加 httpapi 一侧会让默认 hono 后端把请求当 SPA 路由返回 HTML。
        HttpApiEndpoint.get("unread", `${root}/inbox/unread`, {
          success: described(AutomationUnread, "Unread state"),
        }).annotateMerge(
          OpenApi.annotations({ identifier: "automation.unread", summary: "Automation inbox unread state" }),
        ),
        HttpApiEndpoint.post("readAll", `${root}/inbox/read-all`, {
          payload: Schema.Struct({ automationID: Schema.optional(AutomationID) }),
          success: described(AutomationCount, "Marked count"),
        }).annotateMerge(
          OpenApi.annotations({ identifier: "automation.readAll", summary: "Mark automation runs read" }),
        ),
        HttpApiEndpoint.post("setRunRead", `${root}/runs/:runID/read`, {
          params: { runID: AutomationRunID },
          payload: Schema.Struct({ read: Schema.Boolean }),
          success: described(AutomationOk, "OK"),
        }).annotateMerge(
          OpenApi.annotations({ identifier: "automation.setRunRead", summary: "Set automation run read state" }),
        ),
        HttpApiEndpoint.post("archiveRun", `${root}/runs/:runID/archive`, {
          params: { runID: AutomationRunID },
          success: described(AutomationOk, "OK"),
        }).annotateMerge(
          OpenApi.annotations({ identifier: "automation.archiveRun", summary: "Archive automation run" }),
        ),
        HttpApiEndpoint.post("unarchiveRun", `${root}/runs/:runID/unarchive`, {
          params: { runID: AutomationRunID },
          success: described(AutomationOk, "OK"),
        }).annotateMerge(
          OpenApi.annotations({ identifier: "automation.unarchiveRun", summary: "Unarchive automation run" }),
        ),
        HttpApiEndpoint.post("archiveAllRuns", `${root}/:automationID/runs/archive-all`, {
          params: { automationID: AutomationID },
          success: described(AutomationCount, "Archived count"),
        }).annotateMerge(
          OpenApi.annotations({ identifier: "automation.archiveAllRuns", summary: "Archive all runs" }),
        ),
      )
      .annotateMerge(OpenApi.annotations({ title: "automation", description: "Automation routes." }))
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode automation HttpApi",
      version: "0.0.1",
      description: "HttpApi surface for automation routes.",
    }),
  )
