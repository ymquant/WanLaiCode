import { Effect } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { Automation } from "@/automation/automation"
import type { AutomationID, AutomationRunID, CreateInput, UpdateInput } from "@/automation/schema"
import { triggerManualRun } from "@/automation/run"
import { InstanceHttpApi } from "../api"

export const automationHandlers = HttpApiBuilder.group(InstanceHttpApi, "automation", (handlers) =>
  Effect.gen(function* () {
    const list = Effect.fn("AutomationHttpApi.list")(function* () {
      return yield* Effect.sync(() => Automation.list())
    })

    const create = Effect.fn("AutomationHttpApi.create")(function* (ctx: { payload: CreateInput }) {
      return yield* Effect.sync(() => Automation.create(ctx.payload))
    })

    const get = Effect.fn("AutomationHttpApi.get")(function* (ctx: { params: { automationID: AutomationID } }) {
      const found = yield* Effect.sync(() => Automation.get(ctx.params.automationID))
      if (!found) return yield* new HttpApiError.NotFound({})
      return found
    })

    const update = Effect.fn("AutomationHttpApi.update")(function* (ctx: {
      params: { automationID: AutomationID }
      payload: UpdateInput
    }) {
      const updated = yield* Effect.sync(() => Automation.update(ctx.params.automationID, ctx.payload))
      if (!updated) return yield* new HttpApiError.NotFound({})
      return updated
    })

    const remove = Effect.fn("AutomationHttpApi.remove")(function* (ctx: { params: { automationID: AutomationID } }) {
      yield* Effect.sync(() => Automation.remove(ctx.params.automationID))
      return true
    })

    const toggle = Effect.fn("AutomationHttpApi.toggle")(function* (ctx: {
      params: { automationID: AutomationID }
      payload: { enabled: boolean }
    }) {
      const toggled = yield* Effect.sync(() => Automation.setEnabled(ctx.params.automationID, ctx.payload.enabled))
      if (!toggled) return yield* new HttpApiError.NotFound({})
      return toggled
    })

    const run = Effect.fn("AutomationHttpApi.run")(function* (ctx: { params: { automationID: AutomationID } }) {
      // 与 Hono 路由共用同一执行逻辑:建会话/复用绑定对话 + 后台跑 prompt,而非只建一条 running 记录
      const runRecord = yield* Effect.promise(() => triggerManualRun(ctx.params.automationID))
      if (!runRecord) return yield* new HttpApiError.NotFound({})
      return runRecord
    })

    const runs = Effect.fn("AutomationHttpApi.runs")(function* (ctx: { params: { automationID: AutomationID } }) {
      return yield* Effect.sync(() => Automation.listRuns(ctx.params.automationID))
    })

    const runSessions = Effect.fn("AutomationHttpApi.runSessions")(function* () {
      return yield* Effect.sync(() => Automation.listRunSessions())
    })

    // ---------- 收件箱(未读/归档),与 Hono 路由一一对应 ----------

    const unread = Effect.fn("AutomationHttpApi.unread")(function* () {
      return yield* Effect.sync(() => ({
        total: Automation.unreadCount(),
        automationIDs: Automation.unreadAutomationIDs(),
      }))
    })

    const readAll = Effect.fn("AutomationHttpApi.readAll")(function* (ctx: {
      payload: { automationID?: AutomationID }
    }) {
      return yield* Effect.sync(() => ({ count: Automation.markAllRead(ctx.payload.automationID) }))
    })

    const setRunRead = Effect.fn("AutomationHttpApi.setRunRead")(function* (ctx: {
      params: { runID: AutomationRunID }
      payload: { read: boolean }
    }) {
      yield* Effect.sync(() => Automation.setRunRead(ctx.params.runID, ctx.payload.read))
      return { ok: true }
    })

    const archiveRun = Effect.fn("AutomationHttpApi.archiveRun")(function* (ctx: {
      params: { runID: AutomationRunID }
    }) {
      yield* Effect.sync(() => Automation.archiveRun(ctx.params.runID))
      return { ok: true }
    })

    const unarchiveRun = Effect.fn("AutomationHttpApi.unarchiveRun")(function* (ctx: {
      params: { runID: AutomationRunID }
    }) {
      yield* Effect.sync(() => Automation.unarchiveRun(ctx.params.runID))
      return { ok: true }
    })

    const archiveAllRuns = Effect.fn("AutomationHttpApi.archiveAllRuns")(function* (ctx: {
      params: { automationID: AutomationID }
    }) {
      return yield* Effect.sync(() => ({ count: Automation.archiveAllRuns(ctx.params.automationID) }))
    })

    return handlers
      .handle("list", list)
      .handle("runSessions", runSessions)
      .handle("create", create)
      .handle("get", get)
      .handle("update", update)
      .handle("remove", remove)
      .handle("toggle", toggle)
      .handle("run", run)
      .handle("runs", runs)
      .handle("unread", unread)
      .handle("readAll", readAll)
      .handle("setRunRead", setRunRead)
      .handle("archiveRun", archiveRun)
      .handle("unarchiveRun", unarchiveRun)
      .handle("archiveAllRuns", archiveAllRuns)
  }),
)
