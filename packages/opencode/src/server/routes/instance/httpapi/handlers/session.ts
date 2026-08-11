import * as InstanceState from "@/effect/instance-state"
import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"
import { Agent } from "@/agent/agent"
import { Command } from "@/command"
import { Permission } from "@/permission"
import { PermissionID } from "@/permission/schema"
import { ModelID, ProviderID } from "@/provider/schema"
import { SessionShare } from "@/share/session"
import { Session } from "@/session/session"
import { GoalRuntime } from "@/session/goal-runtime"
import { SessionCompaction } from "@/session/compaction"
import { MessageV2 } from "@/session/message-v2"
import { SessionPrompt } from "@/session/prompt"
import { SessionRevert } from "@/session/revert"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { SessionSummary } from "@/session/summary"
import { Todo } from "@/session/todo"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { NotFoundError } from "@/storage/storage"
import { Effect, Option, Schema } from "effect"
import * as Stream from "effect/Stream"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder, HttpApiError, HttpApiSchema } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import {
  AbortQuery,
  CommandPayload,
  DiffQuery,
  ForkPayload,
  InitPayload,
  ListQuery,
  MessagesQuery,
  PermissionResponsePayload,
  PromptPayload,
  RevertPayload,
  SetGoalPayload,
  ShellPayload,
  SteerPayload,
  SummarizePayload,
  UpdatePayload,
} from "../groups/session"
import * as SessionError from "./session-errors"
import * as ApiError from "../errors"

const remoteAutoReviewPermission = "__wanlai_remote_auto_review"

export const sessionHandlers = HttpApiBuilder.group(InstanceHttpApi, "session", (handlers) =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    const shareSvc = yield* SessionShare.Service
    const promptSvc = yield* SessionPrompt.Service
    const revertSvc = yield* SessionRevert.Service
    const compactSvc = yield* SessionCompaction.Service
    const runState = yield* SessionRunState.Service
    const agentSvc = yield* Agent.Service
    const permissionSvc = yield* Permission.Service
    const statusSvc = yield* SessionStatus.Service
    const todoSvc = yield* Todo.Service
    const summary = yield* SessionSummary.Service

    const list = Effect.fn("SessionHttpApi.list")(function* (ctx: { query: typeof ListQuery.Type }) {
      return yield* session.list({
        directory: ctx.query.scope === "project" ? undefined : ctx.query.directory,
        scope: ctx.query.scope,
        path: ctx.query.path,
        roots: ctx.query.roots,
        start: ctx.query.start,
        search: ctx.query.search,
        limit: ctx.query.limit,
      })
    })

    const status = Effect.fn("SessionHttpApi.status")(function* () {
      return Object.fromEntries(yield* statusSvc.list())
    })

    const get = Effect.fn("SessionHttpApi.get")(function* (ctx: { params: { sessionID: SessionID } }) {
      return yield* SessionError.mapStorageNotFound(session.get(ctx.params.sessionID))
    })

    const children = Effect.fn("SessionHttpApi.children")(function* (ctx: { params: { sessionID: SessionID } }) {
      return yield* session.children(ctx.params.sessionID)
    })

    const todo = Effect.fn("SessionHttpApi.todo")(function* (ctx: { params: { sessionID: SessionID } }) {
      return yield* todoSvc.get(ctx.params.sessionID)
    })

    const diff = Effect.fn("SessionHttpApi.diff")(function* (ctx: {
      params: { sessionID: SessionID }
      query: typeof DiffQuery.Type
    }) {
      return yield* summary.diff({ sessionID: ctx.params.sessionID, messageID: ctx.query.messageID })
    })

    const messages = Effect.fn("SessionHttpApi.messages")(function* (ctx: {
      params: { sessionID: SessionID }
      query: typeof MessagesQuery.Type
    }) {
      // 两条分页分支共用摘要压缩，避免 full-history 与 page 接口返回不一致。
      const compact = (items: MessageV2.WithParts[]) =>
        ctx.query.summaryDiffs === "compact" ? MessageV2.compactMessageSummaryDiffs(items) : items
      if (ctx.query.before && ctx.query.limit === undefined) return yield* new HttpApiError.BadRequest({})
      if (ctx.query.before) {
        const before = ctx.query.before
        yield* Effect.try({
          try: () => MessageV2.cursor.decode(before),
          catch: () => new HttpApiError.BadRequest({}),
        })
      }
      yield* SessionError.mapStorageNotFound(session.get(ctx.params.sessionID))
      yield* session.repairOrphanToolParts(ctx.params.sessionID)
      if (ctx.query.limit === undefined || ctx.query.limit === 0) {
        return compact(yield* session.messages({ sessionID: ctx.params.sessionID }))
      }

      const limit = ctx.query.limit
      const page = yield* SessionError.mapThrownStorageNotFound(() =>
        MessageV2.page({
          sessionID: ctx.params.sessionID,
          limit,
          before: ctx.query.before,
        }),
      )
      // 崩溃遗留的不可编码 message/part 会让整条响应编码失败(整会话 500、重试永远失败)，
      // 下发前逐条 salvage，保证响应可编码、会话仍能打开。
      const items = compact(MessageV2.sanitizeMessages(page.items))
      if (!page.cursor) return items

      const request = yield* HttpServerRequest.HttpServerRequest
      // toURL() honors the Host + x-forwarded-proto headers, so the Link
      // header echoes the real origin instead of a hard-coded localhost.
      const url = Option.getOrElse(HttpServerRequest.toURL(request), () => new URL(request.url, "http://localhost"))
      url.searchParams.set("limit", limit.toString())
      url.searchParams.set("before", page.cursor)
      return HttpServerResponse.jsonUnsafe(items, {
        headers: {
          "Access-Control-Expose-Headers": "Link, X-Next-Cursor",
          Link: `<${url.toString()}>; rel="next"`,
          "X-Next-Cursor": page.cursor,
        },
      })
    })

    const message = Effect.fn("SessionHttpApi.message")(function* (ctx: {
      params: { sessionID: SessionID; messageID: MessageID }
    }) {
      return yield* SessionError.mapStorageNotFound(
        Effect.try({
          try: () => {
            const found = MessageV2.get({ sessionID: ctx.params.sessionID, messageID: ctx.params.messageID })
            const sanitized = MessageV2.sanitizeMessage(found)
            // 单条消息若损坏到无法编码则按 NotFound 处理，避免整条响应 500。
            if (!sanitized) throw new NotFoundError({ message: `Message corrupt: ${ctx.params.messageID}` })
            return sanitized
          },
          catch: (error) => error,
        }).pipe(Effect.catch((error) => (NotFoundError.isInstance(error) ? Effect.fail(error) : Effect.die(error)))),
      )
    })

    const create = Effect.fn("SessionHttpApi.create")(function* (ctx: { payload?: Session.CreateInput }) {
      return yield* SessionError.mapStorageNotFound(shareSvc.create(ctx.payload))
    })

    const createRaw = Effect.fn("SessionHttpApi.createRaw")(function* (ctx: {
      request: HttpServerRequest.HttpServerRequest
    }) {
      const body = yield* Effect.orDie(ctx.request.text)
      if (body.trim().length === 0) return yield* create({})

      const json = yield* Effect.try({
        try: () => JSON.parse(body) as unknown,
        catch: () => new HttpApiError.BadRequest({}),
      })
      const payload = yield* Schema.decodeUnknownEffect(Session.CreateInput)(json).pipe(
        Effect.mapError(() => new HttpApiError.BadRequest({})),
      )
      return yield* create({ payload })
    })

    const remove = Effect.fn("SessionHttpApi.remove")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* SessionError.mapStorageNotFound(session.remove(ctx.params.sessionID))
      return true
    })

    const update = Effect.fn("SessionHttpApi.update")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof UpdatePayload.Type
    }) {
      const current = yield* SessionError.mapStorageNotFound(session.get(ctx.params.sessionID))
      if (ctx.payload.title !== undefined) {
        yield* session.setTitle({ sessionID: ctx.params.sessionID, title: ctx.payload.title })
      }
      if (ctx.payload.permission !== undefined) {
        const replacesRemoteAutoReview = ctx.payload.permission.some(
          (rule) => rule.permission === remoteAutoReviewPermission && rule.pattern === "*",
        )
        // 专用状态只保留最后一条，其他工具权限继续按原顺序合并。
        const currentPermission = replacesRemoteAutoReview
          ? (current.permission ?? []).filter(
              (rule) => !(rule.permission === remoteAutoReviewPermission && rule.pattern === "*"),
            )
          : (current.permission ?? [])
        yield* session.setPermission({
          sessionID: ctx.params.sessionID,
          permission: Permission.merge(currentPermission, ctx.payload.permission),
        })
      }
      if (ctx.payload.model !== undefined) {
        // HttpApi 后端同样走 Session 服务，确保 model 事件和数据库投影与传统路由一致。
        yield* session.setModel({
          sessionID: ctx.params.sessionID,
          model: {
            id: ModelID.make(ctx.payload.model.id),
            providerID: ProviderID.make(ctx.payload.model.providerID),
            variant: ctx.payload.model.variant,
          },
        })
      }
      if (ctx.payload.time?.archived === null) {
        yield* SessionError.mapStorageNotFound(session.setArchived({ sessionID: ctx.params.sessionID }))
      } else if (ctx.payload.time?.archived !== undefined) {
        yield* SessionError.mapStorageNotFound(
          session.setArchived({ sessionID: ctx.params.sessionID, time: ctx.payload.time.archived }),
        )
      }
      return yield* SessionError.mapStorageNotFound(session.get(ctx.params.sessionID))
    })

    const fork = Effect.fn("SessionHttpApi.fork")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof ForkPayload.Type
    }) {
      return yield* SessionError.mapStorageNotFound(
        session.fork({ sessionID: ctx.params.sessionID, messageID: ctx.payload.messageID }),
      )
    })

    const abort = Effect.fn("SessionHttpApi.abort")(function* (ctx: {
      params: { sessionID: SessionID }
      query: typeof AbortQuery.Type
    }) {
      yield* promptSvc.cancel(ctx.params.sessionID, {
        resumeQueued: false,
        turnID: ctx.query.turnID,
        // goal 副作用和 turnID 认领共用 cancel 的提交锁：迟到停止不写库，命中停止又能在 idle 前完成暂停。
        onAccepted: Effect.gen(function* () {
          // getGoal 读库失败不能挡住 abort 的本职，兜底为无 goal；写 paused 失败也只记录告警。
          const goal = yield* session.getGoal(ctx.params.sessionID).pipe(Effect.catchCause(() => Effect.succeed(null)))
          if (goal) GoalRuntime.suppressGoalContinuation(ctx.params.sessionID)
          if (goal?.status !== "active") return
          yield* session
            .setGoalStatus({ sessionID: ctx.params.sessionID, status: "paused" })
            .pipe(Effect.catchCause((cause) => Effect.logWarning("abort: failed to pause active goal", cause)))
        }),
      })
      return true
    })

    const init = Effect.fn("SessionHttpApi.init")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof InitPayload.Type
    }) {
      yield* promptSvc.command({
        sessionID: ctx.params.sessionID,
        messageID: ctx.payload.messageID,
        model: `${ctx.payload.providerID}/${ctx.payload.modelID}`,
        command: Command.Default.INIT,
        arguments: "",
      })
      return true
    })

    const share = Effect.fn("SessionHttpApi.share")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* shareSvc.share(ctx.params.sessionID).pipe(Effect.mapError(() => new HttpApiError.BadRequest({})))
      return yield* SessionError.mapStorageNotFound(session.get(ctx.params.sessionID))
    })

    const unshare = Effect.fn("SessionHttpApi.unshare")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* shareSvc.unshare(ctx.params.sessionID).pipe(Effect.mapError(() => new HttpApiError.BadRequest({})))
      return yield* SessionError.mapStorageNotFound(session.get(ctx.params.sessionID))
    })

    const summarize = Effect.fn("SessionHttpApi.summarize")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof SummarizePayload.Type
    }) {
      yield* revertSvc.cleanup(yield* SessionError.mapStorageNotFound(session.get(ctx.params.sessionID)))
      const messages = yield* session.messages({ sessionID: ctx.params.sessionID })
      const defaultAgent = yield* agentSvc.defaultAgent()
      const currentAgent = messages.findLast((message) => message.info.role === "user")?.info.agent ?? defaultAgent

      yield* compactSvc.create({
        sessionID: ctx.params.sessionID,
        agent: currentAgent,
        model: {
          providerID: ctx.payload.providerID,
          modelID: ctx.payload.modelID,
        },
        auto: ctx.payload.auto ?? false,
      })
      yield* promptSvc.loop({ sessionID: ctx.params.sessionID })
      return true
    })

    const prompt = Effect.fn("SessionHttpApi.prompt")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof PromptPayload.Type
    }) {
      const instance = yield* InstanceState.context
      const workspace = yield* InstanceState.workspaceID
      return HttpServerResponse.stream(
        Stream.fromEffect(
          promptSvc
            .prompt({
              ...ctx.payload,
              sessionID: ctx.params.sessionID,
            })
            .pipe(Effect.provideService(InstanceRef, instance), Effect.provideService(WorkspaceRef, workspace)),
        ).pipe(
          Stream.map((message) => JSON.stringify(message)),
          Stream.encodeText,
        ),
        { contentType: "application/json" },
      )
    })

    const promptAsync = Effect.fn("SessionHttpApi.promptAsync")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof PromptPayload.Type
    }) {
      // 204 现在只在 message 与全部 parts 完整落库、后台回复已调度后返回，避免紧随其后的 steer 抢先落库。
      yield* promptSvc.promptAsync({ ...ctx.payload, sessionID: ctx.params.sessionID })
      return HttpApiSchema.NoContent.make()
    })

    const steer = Effect.fn("SessionHttpApi.steer")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof SteerPayload.Type
    }) {
      // 409 保留目标与实际回合，客户端可以恢复原草稿，禁止把迟到引导静默投递到下一轮。
      return yield* promptSvc
        .steer({ ...ctx.payload, sessionID: ctx.params.sessionID })
        .pipe(
          Effect.mapError((error) =>
            error instanceof SessionPrompt.SteerEmptyInputError
              ? ApiError.steerEmptyInput(error)
              : ApiError.steerTurnInactive(error),
          ),
        )
    })

    const command = Effect.fn("SessionHttpApi.command")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof CommandPayload.Type
    }) {
      return yield* promptSvc.command({ ...ctx.payload, sessionID: ctx.params.sessionID })
    })

    const shell = Effect.fn("SessionHttpApi.shell")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof ShellPayload.Type
    }) {
      return yield* promptSvc.shell({ ...ctx.payload, sessionID: ctx.params.sessionID })
    })

    const revert = Effect.fn("SessionHttpApi.revert")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof RevertPayload.Type
    }) {
      return yield* revertSvc.revert({ sessionID: ctx.params.sessionID, ...ctx.payload })
    })

    const unrevert = Effect.fn("SessionHttpApi.unrevert")(function* (ctx: { params: { sessionID: SessionID } }) {
      return yield* revertSvc.unrevert({ sessionID: ctx.params.sessionID })
    })

    const permissionRespond = Effect.fn("SessionHttpApi.permissionRespond")(function* (ctx: {
      params: { permissionID: PermissionID }
      payload: typeof PermissionResponsePayload.Type
    }) {
      yield* permissionSvc.reply({ requestID: ctx.params.permissionID, reply: ctx.payload.response })
      return true
    })

    const deleteMessage = Effect.fn("SessionHttpApi.deleteMessage")(function* (ctx: {
      params: { sessionID: SessionID; messageID: MessageID }
    }) {
      // 排队消息(尚未开始处理)允许 busy 时撤销；其余(处理中/已回答)仍要求 idle，避免破坏进行中的回合。
      const msgs = yield* session.messages({ sessionID: ctx.params.sessionID })
      if (!MessageV2.isQueuedUserMessage(msgs, ctx.params.messageID))
        yield* runState.assertNotBusy(ctx.params.sessionID)
      yield* session.removeMessage(ctx.params)
      return true
    })

    const deletePart = Effect.fn("SessionHttpApi.deletePart")(function* (ctx: {
      params: { sessionID: SessionID; messageID: MessageID; partID: PartID }
    }) {
      yield* session.removePart(ctx.params)
      return true
    })

    const updatePart = Effect.fn("SessionHttpApi.updatePart")(function* (ctx: {
      params: { sessionID: SessionID; messageID: MessageID; partID: PartID }
      payload: typeof MessageV2.Part.Type
    }) {
      const payload = ctx.payload as MessageV2.Part
      if (
        payload.id !== ctx.params.partID ||
        payload.messageID !== ctx.params.messageID ||
        payload.sessionID !== ctx.params.sessionID
      ) {
        throw new Error(
          `Part mismatch: body.id='${payload.id}' vs partID='${ctx.params.partID}', body.messageID='${payload.messageID}' vs messageID='${ctx.params.messageID}', body.sessionID='${payload.sessionID}' vs sessionID='${ctx.params.sessionID}'`,
        )
      }
      return yield* session.updatePart(payload)
    })

    const setGoal = Effect.fn("SessionHttpApi.setGoal")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof SetGoalPayload.Type
    }) {
      yield* SessionError.mapStorageNotFound(session.get(ctx.params.sessionID))
      if (ctx.payload.objective === undefined && ctx.payload.status === undefined) {
        return yield* new HttpApiError.BadRequest({})
      }
      let goal = yield* session.getGoal(ctx.params.sessionID)
      if (ctx.payload.objective !== undefined) {
        goal = yield* session
          .setGoal({ sessionID: ctx.params.sessionID, objective: ctx.payload.objective })
          .pipe(Effect.mapError(() => new HttpApiError.BadRequest({})))
      }
      if (ctx.payload.status !== undefined) {
        // 「暂停」要同时停下在途回合，仅 active → paused 这一个方向；
        // 其余（恢复 / 模型侧 complete、blocked）只写状态，不打断。
        goal = yield* SessionError.mapStorageNotFound(
          ctx.payload.status === "paused" && goal?.status === "active"
            ? GoalRuntime.pauseActiveGoal(ctx.params.sessionID)
            : session.setGoalStatus({ sessionID: ctx.params.sessionID, status: ctx.payload.status }),
        )
      }
      if (goal === null) {
        return yield* new HttpApiError.BadRequest({})
      }
      return goal
    })

    const getGoal = Effect.fn("SessionHttpApi.getGoal")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* SessionError.mapStorageNotFound(session.get(ctx.params.sessionID))
      return yield* session.getGoal(ctx.params.sessionID)
    })

    const clearGoal = Effect.fn("SessionHttpApi.clearGoal")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* SessionError.mapStorageNotFound(session.get(ctx.params.sessionID))
      return yield* session.clearGoal(ctx.params.sessionID)
    })

    return handlers
      .handle("list", list)
      .handle("status", status)
      .handle("get", get)
      .handle("children", children)
      .handle("todo", todo)
      .handle("diff", diff)
      .handle("messages", messages)
      .handle("message", message)
      .handleRaw("create", createRaw)
      .handle("remove", remove)
      .handle("update", update)
      .handle("fork", fork)
      .handle("abort", abort)
      .handle("init", init)
      .handle("share", share)
      .handle("unshare", unshare)
      .handle("summarize", summarize)
      .handle("prompt", prompt)
      .handle("promptAsync", promptAsync)
      .handle("steer", steer)
      .handle("command", command)
      .handle("shell", shell)
      .handle("revert", revert)
      .handle("unrevert", unrevert)
      .handle("permissionRespond", permissionRespond)
      .handle("deleteMessage", deleteMessage)
      .handle("deletePart", deletePart)
      .handle("updatePart", updatePart)
      .handle("setGoal", setGoal)
      .handle("getGoal", getGoal)
      .handle("clearGoal", clearGoal)
  }),
)
