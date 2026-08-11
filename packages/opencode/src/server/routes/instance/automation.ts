import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { Automation } from "@/automation/automation"
import type { AutomationID, AutomationRunID, CreateInput, UpdateInput } from "@/automation/schema"
import { triggerManualRun } from "@/automation/run"
import { errors } from "../../error"
import { lazy } from "@/util/lazy"

const TEMPLATE = z.enum(["daily_brief", "weekly_review", "project_monitor", "custom"])
const SCHEDULE_MODE = z.enum(["interval", "hourly", "daily", "weekdays", "weekly", "custom"])
const WEEKDAY = z.enum(["SU", "MO", "TU", "WE", "TH", "FR", "SA"])
const SCHEDULE_CONFIG = z.object({
  mode: SCHEDULE_MODE,
  intervalMinutes: z.number(),
  intervalHours: z.number(),
  weekdays: z.array(WEEKDAY),
  time: z.string(),
  customRrule: z.string(),
})
const EXEC_ENV = z.enum(["local", "worktree", "thread"])
const REASONING = z.enum(["none", "minimal", "low", "medium", "high", "xhigh"])

const INFO = z.object({
  id: z.string(),
  title: z.string(),
  enabled: z.boolean(),
  template: TEMPLATE,
  scheduleConfig: SCHEDULE_CONFIG,
  prompt: z.string(),
  projectID: z.string().nullable(),
  directory: z.string().nullable(),
  threadSessionID: z.string().nullable(),
  executionEnvironment: EXEC_ENV,
  agent: z.string().nullable(),
  model: z.string().nullable(),
  reasoningEffort: REASONING.nullable(),
  notificationPolicy: z.literal("failed_runs_only").nullable(),
  lastRunAt: z.number().nullable(),
  nextRunAt: z.number().nullable(),
  time: z.object({ created: z.number(), updated: z.number() }),
})

const RUN = z.object({
  id: z.string(),
  automationID: z.string(),
  sessionID: z.string().nullable(),
  directory: z.string().nullable(),
  trigger: z.enum(["schedule", "manual"]),
  status: z.enum(["running", "success", "error"]),
  startedAt: z.number(),
  finishedAt: z.number().nullable(),
  error: z.string().nullable(),
  readAt: z.number().nullable(),
  archivedAt: z.number().nullable(),
  archivedReason: z.string().nullable(),
  inboxTitle: z.string().nullable(),
  inboxSummary: z.string().nullable(),
})

const CREATE = z.object({
  title: z.string(),
  template: TEMPLATE.optional(),
  scheduleConfig: SCHEDULE_CONFIG,
  prompt: z.string(),
  projectID: z.string().optional(),
  cwd: z.string().optional(),
  threadSessionID: z.string().nullable().optional(),
  executionEnvironment: EXEC_ENV.optional(),
  agent: z.string().optional(),
  model: z.string().optional(),
  reasoningEffort: REASONING.nullable().optional(),
  notificationPolicy: z.literal("failed_runs_only").nullable().optional(),
  enabled: z.boolean().optional(),
})

const UPDATE = z.object({
  title: z.string().optional(),
  enabled: z.boolean().optional(),
  template: TEMPLATE.optional(),
  scheduleConfig: SCHEDULE_CONFIG.optional(),
  prompt: z.string().optional(),
  projectID: z.string().nullable().optional(),
  cwd: z.string().nullable().optional(),
  threadSessionID: z.string().nullable().optional(),
  executionEnvironment: EXEC_ENV.optional(),
  agent: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  reasoningEffort: REASONING.nullable().optional(),
  notificationPolicy: z.literal("failed_runs_only").nullable().optional(),
})

const RUN_SESSION = z.object({
  sessionID: z.string(),
  automationID: z.string(),
  status: z.enum(["running", "success", "error"]),
})

const PARAM = z.object({ automationID: z.string() })
const RUN_PARAM = z.object({ runID: z.string() })
const OK = z.object({ ok: z.boolean() })
const COUNT = z.object({ count: z.number() })
const UNREAD = z.object({ total: z.number(), automationIDs: z.string().array() })

export const AutomationRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "List automations",
        operationId: "automation.list",
        responses: {
          200: { description: "List", content: { "application/json": { schema: resolver(INFO.array()) } } },
        },
      }),
      async (c) => c.json(Automation.list()),
    )
    .get(
      "/run-sessions",
      describeRoute({
        summary: "List automation-originated sessions",
        operationId: "automation.runSessions",
        responses: {
          200: { description: "Sessions", content: { "application/json": { schema: resolver(RUN_SESSION.array()) } } },
        },
      }),
      async (c) => c.json(Automation.listRunSessions()),
    )
    .post(
      "/",
      describeRoute({
        summary: "Create automation",
        operationId: "automation.create",
        responses: {
          200: { description: "Created", content: { "application/json": { schema: resolver(INFO) } } },
          ...errors(400),
        },
      }),
      validator("json", CREATE),
      async (c) => {
        const input = c.req.valid("json") as CreateInput
        return c.json(Automation.create(input))
      },
    )
    .get(
      "/:automationID",
      describeRoute({
        summary: "Get automation",
        operationId: "automation.get",
        responses: {
          200: { description: "Info", content: { "application/json": { schema: resolver(INFO) } } },
          ...errors(404),
        },
      }),
      validator("param", PARAM),
      async (c) => {
        const found = Automation.get(c.req.valid("param").automationID as AutomationID)
        if (!found) return c.json({ error: "Not found" }, 404)
        return c.json(found)
      },
    )
    .patch(
      "/:automationID",
      describeRoute({
        summary: "Update automation",
        operationId: "automation.update",
        responses: {
          200: { description: "Updated", content: { "application/json": { schema: resolver(INFO) } } },
          ...errors(400, 404),
        },
      }),
      validator("param", PARAM),
      validator("json", UPDATE),
      async (c) => {
        const updated = Automation.update(
          c.req.valid("param").automationID as AutomationID,
          c.req.valid("json") as UpdateInput,
        )
        if (!updated) return c.json({ error: "Not found" }, 404)
        return c.json(updated)
      },
    )
    .delete(
      "/:automationID",
      describeRoute({
        summary: "Delete automation",
        operationId: "automation.remove",
        responses: {
          200: { description: "Deleted", content: { "application/json": { schema: resolver(z.boolean()) } } },
          ...errors(404),
        },
      }),
      validator("param", PARAM),
      async (c) => {
        Automation.remove(c.req.valid("param").automationID as AutomationID)
        return c.json(true)
      },
    )
    .post(
      "/:automationID/toggle",
      describeRoute({
        summary: "Toggle automation",
        operationId: "automation.toggle",
        responses: {
          200: { description: "Toggled", content: { "application/json": { schema: resolver(INFO) } } },
          ...errors(404),
        },
      }),
      validator("param", PARAM),
      validator("json", z.object({ enabled: z.boolean() })),
      async (c) => {
        const toggled = Automation.setEnabled(
          c.req.valid("param").automationID as AutomationID,
          c.req.valid("json").enabled,
        )
        if (!toggled) return c.json({ error: "Not found" }, 404)
        return c.json(toggled)
      },
    )
    .post(
      "/:automationID/run",
      describeRoute({
        summary: "Trigger automation run",
        operationId: "automation.run",
        responses: {
          200: { description: "Run started", content: { "application/json": { schema: resolver(RUN) } } },
          ...errors(404),
        },
      }),
      validator("param", PARAM),
      async (c) => {
        const id = c.req.valid("param").automationID as AutomationID
        const runRecord = await triggerManualRun(id)
        if (!runRecord) return c.json({ error: "Not found" }, 404)
        return c.json(runRecord)
      },
    )
    .get(
      "/:automationID/runs",
      describeRoute({
        summary: "List automation runs",
        operationId: "automation.runs",
        responses: {
          200: { description: "Runs", content: { "application/json": { schema: resolver(RUN.array()) } } },
        },
      }),
      validator("param", PARAM),
      async (c) => c.json(Automation.listRuns(c.req.valid("param").automationID as AutomationID)),
    )
    // ---------- 收件箱(未读/归档) ----------
    .get(
      "/inbox/unread",
      describeRoute({
        summary: "Automation inbox unread state",
        operationId: "automation.unread",
        responses: {
          200: { description: "Unread", content: { "application/json": { schema: resolver(UNREAD) } } },
        },
      }),
      async (c) => c.json({ total: Automation.unreadCount(), automationIDs: Automation.unreadAutomationIDs() }),
    )
    .post(
      "/inbox/read-all",
      describeRoute({
        summary: "Mark automation runs read",
        operationId: "automation.readAll",
        responses: {
          200: { description: "Marked", content: { "application/json": { schema: resolver(COUNT) } } },
        },
      }),
      validator("json", z.object({ automationID: z.string().optional() })),
      async (c) => c.json({ count: Automation.markAllRead(c.req.valid("json").automationID as AutomationID) }),
    )
    .post(
      "/runs/:runID/read",
      describeRoute({
        summary: "Set automation run read state",
        operationId: "automation.setRunRead",
        responses: { 200: { description: "OK", content: { "application/json": { schema: resolver(OK) } } } },
      }),
      validator("param", RUN_PARAM),
      validator("json", z.object({ read: z.boolean() })),
      async (c) => {
        Automation.setRunRead(c.req.valid("param").runID as AutomationRunID, c.req.valid("json").read)
        return c.json({ ok: true })
      },
    )
    .post(
      "/runs/:runID/archive",
      describeRoute({
        summary: "Archive automation run",
        operationId: "automation.archiveRun",
        responses: { 200: { description: "OK", content: { "application/json": { schema: resolver(OK) } } } },
      }),
      validator("param", RUN_PARAM),
      async (c) => {
        Automation.archiveRun(c.req.valid("param").runID as AutomationRunID)
        return c.json({ ok: true })
      },
    )
    .post(
      "/runs/:runID/unarchive",
      describeRoute({
        summary: "Unarchive automation run",
        operationId: "automation.unarchiveRun",
        responses: { 200: { description: "OK", content: { "application/json": { schema: resolver(OK) } } } },
      }),
      validator("param", RUN_PARAM),
      async (c) => {
        Automation.unarchiveRun(c.req.valid("param").runID as AutomationRunID)
        return c.json({ ok: true })
      },
    )
    .post(
      "/:automationID/runs/archive-all",
      describeRoute({
        summary: "Archive all runs of an automation",
        operationId: "automation.archiveAllRuns",
        responses: {
          200: { description: "Archived", content: { "application/json": { schema: resolver(COUNT) } } },
        },
      }),
      validator("param", PARAM),
      async (c) => c.json({ count: Automation.archiveAllRuns(c.req.valid("param").automationID as AutomationID) }),
    ),
)
