import { Hono } from "hono"
import { stream } from "hono/streaming"
import { describeRoute, validator, resolver } from "hono-openapi"
import { SessionID, MessageID, PartID } from "@/session/schema"
import z from "zod"
import { Session } from "@/session/session"
import { MessageV2 } from "@/session/message-v2"
import { NotFoundError } from "@/storage/storage"
import { SessionPrompt } from "@/session/prompt"
import { SessionRunState } from "@/session/run-state"
import { SessionCompaction } from "@/session/compaction"
import { SessionRevert } from "@/session/revert"
import { SessionShare } from "@/share/session"
import { SessionStatus } from "@/session/status"
import { SessionSummary } from "@/session/summary"
import { Todo } from "@/session/todo"
import { Effect } from "effect"
import { Agent } from "@/agent/agent"
import { Snapshot } from "@/snapshot"
import { Command } from "@/command"
import * as Log from "@opencode-ai/core/util/log"
import { Permission } from "@/permission"
import { PermissionID } from "@/permission/schema"
import { ModelID, ProviderID } from "@/provider/schema"
import { errors } from "../../error"
import { lazy } from "@/util/lazy"
import { zodObject } from "@/util/effect-zod"
import { jsonRequest, runRequest } from "./trace"
import * as ApiError from "./httpapi/errors"

const log = Log.create({ service: "server" })
const remoteAutoReviewPermission = "__wanlai_remote_auto_review"

const QueryBoolean = z.union([
  z.preprocess((value) => (value === "true" ? true : value === "false" ? false : value), z.boolean()),
  z.enum(["true", "false"]),
])

function queryBoolean(value: z.infer<typeof QueryBoolean> | undefined) {
  if (value === undefined) return
  return value === true || value === "true"
}

export const SessionRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "List sessions",
        description: "Get a list of all OpenCode sessions, sorted by most recently updated.",
        operationId: "session.list",
        responses: {
          200: {
            description: "List of sessions",
            content: {
              "application/json": {
                schema: resolver(Session.Info.zod.array()),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          directory: z.string().optional().meta({ description: "Filter sessions by directory" }),
          // TODO: in 2.0 remove `scope` and `directory` and default
          // to list all sessions for a project
          scope: z.enum(["project"]).optional().meta({ description: "List all sessions for the current project" }),
          path: z.string().optional().meta({ description: "Filter sessions by project-relative path" }),
          roots: QueryBoolean.optional().meta({ description: "Only return root sessions (no parentID)" }),
          start: z.coerce
            .number()
            .optional()
            .meta({ description: "Filter sessions updated on or after this timestamp (milliseconds since epoch)" }),
          search: z.string().optional().meta({ description: "Filter sessions by title (case-insensitive)" }),
          limit: z.coerce.number().optional().meta({ description: "Maximum number of sessions to return" }),
        }),
      ),
      async (c) => {
        const query = c.req.valid("query")
        return c.json(
          await runRequest(
            "SessionRoutes.list",
            c,
            Session.Service.use((svc) =>
              svc.list({
                directory: query.scope === "project" ? undefined : query.directory,
                path: query.path,
                roots: queryBoolean(query.roots),
                start: query.start,
                search: query.search,
                limit: query.limit,
              }),
            ),
          ),
        )
      },
    )
    .get(
      "/status",
      describeRoute({
        summary: "Get session status",
        description: "Retrieve the current status of all sessions, including active, idle, and completed states.",
        operationId: "session.status",
        responses: {
          200: {
            description: "Get session status",
            content: {
              "application/json": {
                schema: resolver(z.record(z.string(), SessionStatus.Info.zod)),
              },
            },
          },
          ...errors(400),
        },
      }),
      async (c) =>
        jsonRequest("SessionRoutes.status", c, function* () {
          const svc = yield* SessionStatus.Service
          return Object.fromEntries(yield* svc.list())
        }),
    )
    .get(
      "/:sessionID",
      describeRoute({
        summary: "Get session",
        description: "Retrieve detailed information about a specific OpenCode session.",
        tags: ["Session"],
        operationId: "session.get",
        responses: {
          200: {
            description: "Get session",
            content: {
              "application/json": {
                schema: resolver(Session.Info.zod),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: Session.GetInput.zod,
        }),
      ),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        return jsonRequest("SessionRoutes.get", c, function* () {
          const session = yield* Session.Service
          return yield* session.get(sessionID)
        })
      },
    )
    .get(
      "/:sessionID/children",
      describeRoute({
        summary: "Get session children",
        tags: ["Session"],
        description: "Retrieve all child sessions that were forked from the specified parent session.",
        operationId: "session.children",
        responses: {
          200: {
            description: "List of children",
            content: {
              "application/json": {
                schema: resolver(Session.Info.zod.array()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: Session.ChildrenInput.zod,
        }),
      ),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        return jsonRequest("SessionRoutes.children", c, function* () {
          const session = yield* Session.Service
          return yield* session.children(sessionID)
        })
      },
    )
    .get(
      "/:sessionID/todo",
      describeRoute({
        summary: "Get session todos",
        description: "Retrieve the todo list associated with a specific session, showing tasks and action items.",
        operationId: "session.todo",
        responses: {
          200: {
            description: "Todo list",
            content: {
              "application/json": {
                schema: resolver(Todo.Info.zod.array()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
        }),
      ),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        return jsonRequest("SessionRoutes.todo", c, function* () {
          const todo = yield* Todo.Service
          return yield* todo.get(sessionID)
        })
      },
    )
    .post(
      "/",
      describeRoute({
        summary: "Create session",
        description: "Create a new OpenCode session for interacting with AI assistants and managing conversations.",
        operationId: "session.create",
        responses: {
          ...errors(400, 404),
          200: {
            description: "Successfully created session",
            content: {
              "application/json": {
                schema: resolver(Session.Info.zod),
              },
            },
          },
        },
      }),
      validator("json", Session.CreateInput.zod),
      async (c) =>
        jsonRequest("SessionRoutes.create", c, function* () {
          const body = c.req.valid("json") ?? {}
          const svc = yield* SessionShare.Service
          return yield* svc.create(body)
        }),
    )
    .delete(
      "/:sessionID",
      describeRoute({
        summary: "Delete session",
        description: "Delete a session and permanently remove all associated data, including messages and history.",
        operationId: "session.delete",
        responses: {
          200: {
            description: "Successfully deleted session",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: Session.RemoveInput.zod,
        }),
      ),
      async (c) =>
        jsonRequest("SessionRoutes.delete", c, function* () {
          const sessionID = c.req.valid("param").sessionID
          const svc = yield* Session.Service
          yield* svc.remove(sessionID)
          return true
        }),
    )
    .patch(
      "/:sessionID",
      describeRoute({
        summary: "Update session",
        description: "Update properties of an existing session, such as title or other metadata.",
        operationId: "session.update",
        responses: {
          200: {
            description: "Successfully updated session",
            content: {
              "application/json": {
                schema: resolver(Session.Info.zod),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
        }),
      ),
      validator(
        "json",
        z.object({
          title: z.string().optional(),
          permission: Permission.Ruleset.zod.optional(),
          // 桌面模型菜单与手机远控共用 Session.model，选择后立即广播给另一端。
          model: z
            .object({
              id: z.string(),
              providerID: z.string(),
              variant: z.string().optional(),
            })
            .optional(),
          time: z
            .object({
              archived: z.number().nullable().optional(),
            })
            .optional(),
        }),
      ),
      async (c) =>
        jsonRequest("SessionRoutes.update", c, function* () {
          const sessionID = c.req.valid("param").sessionID
          const updates = c.req.valid("json")
          const session = yield* Session.Service
          const current = yield* session.get(sessionID)

          if (updates.title !== undefined) {
            yield* session.setTitle({ sessionID, title: updates.title })
          }
          if (updates.permission !== undefined) {
            const replacesRemoteAutoReview = updates.permission.some(
              (rule) => rule.permission === remoteAutoReviewPermission && rule.pattern === "*",
            )
            // 专用 Auto-review 规则是单值状态；替换旧值，其他真实工具权限继续保持原有 merge 语义。
            const currentPermission = replacesRemoteAutoReview
              ? (current.permission ?? []).filter(
                  (rule) => !(rule.permission === remoteAutoReviewPermission && rule.pattern === "*"),
                )
              : (current.permission ?? [])
            yield* session.setPermission({
              sessionID,
              permission: Permission.merge(currentPermission, updates.permission),
            })
          }
          if (updates.model !== undefined) {
            // Session 服务负责持久化和发布 session.updated，避免 UI 与远控各保存一份模型。
            yield* session.setModel({
              sessionID,
              model: {
                id: ModelID.make(updates.model.id),
                providerID: ProviderID.make(updates.model.providerID),
                variant: updates.model.variant,
              },
            })
          }
          if (updates.time?.archived === null) {
            yield* session.setArchived({ sessionID })
          } else if (updates.time?.archived !== undefined) {
            yield* session.setArchived({ sessionID, time: updates.time.archived })
          }

          return yield* session.get(sessionID)
        }),
    )
    // TODO(v2): remove this dedicated route and rely on the normal `/init` command flow.
    .post(
      "/:sessionID/init",
      describeRoute({
        summary: "Initialize session",
        description:
          "Analyze the current application and create an AGENTS.md file with project-specific agent configurations.",
        operationId: "session.init",
        responses: {
          200: {
            description: "200",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
        }),
      ),
      validator(
        "json",
        z.object({
          modelID: ModelID.zod,
          providerID: ProviderID.zod,
          messageID: MessageID.zod,
        }),
      ),
      async (c) =>
        jsonRequest("SessionRoutes.init", c, function* () {
          const sessionID = c.req.valid("param").sessionID
          const body = c.req.valid("json")
          const svc = yield* SessionPrompt.Service
          yield* svc.command({
            sessionID,
            messageID: body.messageID,
            model: body.providerID + "/" + body.modelID,
            command: Command.Default.INIT,
            arguments: "",
          })
          return true
        }),
    )
    .post(
      "/:sessionID/fork",
      describeRoute({
        summary: "Fork session",
        description: "Create a new session by forking an existing session at a specific message point.",
        operationId: "session.fork",
        responses: {
          200: {
            description: "200",
            content: {
              "application/json": {
                schema: resolver(Session.Info.zod),
              },
            },
          },
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
        }),
      ),
      validator("json", zodObject(Session.ForkInput).omit({ sessionID: true })),
      async (c) =>
        jsonRequest("SessionRoutes.fork", c, function* () {
          const sessionID = c.req.valid("param").sessionID
          const body = c.req.valid("json") as { messageID?: MessageID }
          const svc = yield* Session.Service
          return yield* svc.fork({ ...body, sessionID })
        }),
    )
    .post(
      "/:sessionID/abort",
      describeRoute({
        summary: "Abort session",
        description: "Abort an active session and stop any ongoing AI processing or command execution.",
        operationId: "session.abort",
        responses: {
          200: {
            description: "Aborted session",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
        }),
      ),
      // 把 turnID 写入 Hono 的公开查询契约，确保双 HTTP 后端和生成 SDK 对停止请求的描述一致。
      validator(
        "query",
        z.object({
          // 查询边界直接校验 MessageID；validator 会稳定映射为 400，不能让 handler 内的裸 ZodError 变成 500。
          turnID: MessageID.zod.optional(),
        }),
      ),
      async (c) =>
        jsonRequest("SessionRoutes.abort", c, function* () {
          const svc = yield* SessionPrompt.Service
          // 新版 SDK 用 query 传 turnID，旧 Hono 客户端仍可能把它放在 JSON body；两种形态统一兼容。
          const queryTurnID = c.req.valid("query").turnID
          const raw = yield* Effect.promise(() => c.req.json().catch(() => ({})))
          const body = z.object({ turnID: MessageID.zod.optional() }).parse(raw)
          const turnID = queryTurnID ?? body.turnID
          yield* svc.cancel(c.req.valid("param").sessionID, { resumeQueued: false, turnID })
          return true
        }),
    )
    .post(
      "/:sessionID/share",
      describeRoute({
        summary: "Share session",
        description: "Create a shareable link for a session, allowing others to view the conversation.",
        operationId: "session.share",
        responses: {
          200: {
            description: "Successfully shared session",
            content: {
              "application/json": {
                schema: resolver(Session.Info.zod),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
        }),
      ),
      async (c) =>
        jsonRequest("SessionRoutes.share", c, function* () {
          const sessionID = c.req.valid("param").sessionID
          const share = yield* SessionShare.Service
          const session = yield* Session.Service
          yield* share.share(sessionID)
          return yield* session.get(sessionID)
        }),
    )
    .get(
      "/:sessionID/diff",
      describeRoute({
        summary: "Get message diff",
        description: "Get the file changes (diff) that resulted from a specific user message in the session.",
        operationId: "session.diff",
        responses: {
          200: {
            description: "Successfully retrieved diff",
            content: {
              "application/json": {
                schema: resolver(Snapshot.FileDiff.zod.array()),
              },
            },
          },
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
        }),
      ),
      validator("query", zodObject(SessionSummary.DiffInput).omit({ sessionID: true })),
      async (c) =>
        jsonRequest("SessionRoutes.diff", c, function* () {
          const query = c.req.valid("query") as Omit<SessionSummary.DiffInput, "sessionID">
          const params = c.req.valid("param")
          const summary = yield* SessionSummary.Service
          return yield* summary.diff({
            sessionID: params.sessionID,
            messageID: query.messageID,
          })
        }),
    )
    .delete(
      "/:sessionID/share",
      describeRoute({
        summary: "Unshare session",
        description: "Remove the shareable link for a session, making it private again.",
        operationId: "session.unshare",
        responses: {
          200: {
            description: "Successfully unshared session",
            content: {
              "application/json": {
                schema: resolver(Session.Info.zod),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
        }),
      ),
      async (c) =>
        jsonRequest("SessionRoutes.unshare", c, function* () {
          const sessionID = c.req.valid("param").sessionID
          const share = yield* SessionShare.Service
          const session = yield* Session.Service
          yield* share.unshare(sessionID)
          return yield* session.get(sessionID)
        }),
    )
    .post(
      "/:sessionID/summarize",
      describeRoute({
        summary: "Summarize session",
        description: "Generate a concise summary of the session using AI compaction to preserve key information.",
        operationId: "session.summarize",
        responses: {
          200: {
            description: "Summarized session",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
        }),
      ),
      validator(
        "json",
        z.object({
          providerID: ProviderID.zod,
          modelID: ModelID.zod,
          auto: z.boolean().optional().default(false),
        }),
      ),
      async (c) =>
        jsonRequest("SessionRoutes.summarize", c, function* () {
          const sessionID = c.req.valid("param").sessionID
          const body = c.req.valid("json")
          const session = yield* Session.Service
          const revert = yield* SessionRevert.Service
          const compact = yield* SessionCompaction.Service
          const prompt = yield* SessionPrompt.Service
          const agent = yield* Agent.Service

          yield* revert.cleanup(yield* session.get(sessionID))
          const msgs = yield* session.messages({ sessionID })
          const defaultAgent = yield* agent.defaultAgent()
          let currentAgent = defaultAgent
          for (let i = msgs.length - 1; i >= 0; i--) {
            const info = msgs[i].info
            if (info.role === "user") {
              currentAgent = info.agent || defaultAgent
              break
            }
          }

          yield* compact.create({
            sessionID,
            agent: currentAgent,
            model: {
              providerID: body.providerID,
              modelID: body.modelID,
            },
            auto: body.auto,
          })
          yield* prompt.loop({ sessionID })
          return true
        }),
    )
    .get(
      "/:sessionID/message",
      describeRoute({
        summary: "Get session messages",
        description: "Retrieve all messages in a session, including user prompts and AI responses.",
        operationId: "session.messages",
        responses: {
          200: {
            description: "List of messages",
            content: {
              "application/json": {
                schema: resolver(MessageV2.WithParts.zod.array()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
        }),
      ),
      validator(
        "query",
        z
          .object({
            limit: z.coerce
              .number()
              .int()
              .min(0)
              .optional()
              .meta({ description: "Maximum number of messages to return" }),
            before: z
              .string()
              .optional()
              .meta({ description: "Opaque cursor for loading older messages" })
              .refine(
                (value) => {
                  if (!value) return true
                  try {
                    MessageV2.cursor.decode(value)
                    return true
                  } catch {
                    return false
                  }
                },
                { message: "Invalid cursor" },
              ),
            // compact 仅裁掉超大摘要的 patch 正文；默认 full 保持旧客户端响应不变。
            summaryDiffs: z.enum(["full", "compact"]).optional(),
          })
          .refine((value) => !value.before || value.limit !== undefined, {
            message: "before requires limit",
            path: ["before"],
          }),
      ),
      async (c) => {
        const query = c.req.valid("query")
        const sessionID = c.req.valid("param").sessionID
        const compact = (items: MessageV2.WithParts[]) =>
          query.summaryDiffs === "compact" ? MessageV2.compactMessageSummaryDiffs(items) : items
        if (query.limit === undefined || query.limit === 0) {
          const messages = await runRequest(
            "SessionRoutes.messages",
            c,
            Effect.gen(function* () {
              const session = yield* Session.Service
              yield* session.get(sessionID)
              return yield* session.messages({ sessionID })
            }),
          )
          return c.json(compact(messages))
        }

        await runRequest(
          "SessionRoutes.repairOrphanToolParts",
          c,
          Effect.gen(function* () {
            const session = yield* Session.Service
            yield* session.repairOrphanToolParts(sessionID)
          }),
        )
        const page = await MessageV2.page({
          sessionID,
          limit: query.limit,
          before: query.before,
        })
        if (page.cursor) {
          const url = new URL(c.req.url)
          url.searchParams.set("limit", query.limit.toString())
          url.searchParams.set("before", page.cursor)
          c.header("Access-Control-Expose-Headers", "Link, X-Next-Cursor")
          c.header("Link", `<${url.toString()}>; rel="next"`)
          c.header("X-Next-Cursor", page.cursor)
        }
        // 崩溃遗留的不可编码 message/part 会让客户端解码整会话失败，下发前逐条 salvage。
        return c.json(compact(MessageV2.sanitizeMessages(page.items)))
      },
    )
    .get(
      "/:sessionID/message/:messageID",
      describeRoute({
        summary: "Get message",
        description: "Retrieve a specific message from a session by its message ID.",
        operationId: "session.message",
        responses: {
          200: {
            description: "Message",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    info: MessageV2.Info.zod,
                    parts: MessageV2.Part.zod.array(),
                  }),
                ),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
          messageID: MessageID.zod,
        }),
      ),
      async (c) => {
        const params = c.req.valid("param")
        const message = await MessageV2.get({
          sessionID: params.sessionID,
          messageID: params.messageID,
        })
        const sanitized = MessageV2.sanitizeMessage(message)
        if (!sanitized) throw new NotFoundError({ message: `Message corrupt: ${params.messageID}` })
        return c.json(sanitized)
      },
    )
    .delete(
      "/:sessionID/message/:messageID",
      describeRoute({
        summary: "Delete message",
        description:
          "Permanently delete a specific message (and all of its parts) from a session. This does not revert any file changes that may have been made while processing the message.",
        operationId: "session.deleteMessage",
        responses: {
          200: {
            description: "Successfully deleted message",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
          messageID: MessageID.zod,
        }),
      ),
      async (c) =>
        jsonRequest("SessionRoutes.deleteMessage", c, function* () {
          const params = c.req.valid("param")
          const state = yield* SessionRunState.Service
          const session = yield* Session.Service
          // 排队消息(尚未开始处理)允许 busy 时撤销；其余(处理中/已回答)仍要求 idle，避免破坏进行中的回合。
          const msgs = yield* session.messages({ sessionID: params.sessionID })
          if (!MessageV2.isQueuedUserMessage(msgs, params.messageID)) yield* state.assertNotBusy(params.sessionID)
          yield* session.removeMessage({
            sessionID: params.sessionID,
            messageID: params.messageID,
          })
          return true
        }),
    )
    .delete(
      "/:sessionID/message/:messageID/part/:partID",
      describeRoute({
        description: "Delete a part from a message",
        operationId: "part.delete",
        responses: {
          200: {
            description: "Successfully deleted part",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
          messageID: MessageID.zod,
          partID: PartID.zod,
        }),
      ),
      async (c) =>
        jsonRequest("SessionRoutes.deletePart", c, function* () {
          const params = c.req.valid("param")
          const svc = yield* Session.Service
          yield* svc.removePart({
            sessionID: params.sessionID,
            messageID: params.messageID,
            partID: params.partID,
          })
          return true
        }),
    )
    .patch(
      "/:sessionID/message/:messageID/part/:partID",
      describeRoute({
        description: "Update a part in a message",
        operationId: "part.update",
        responses: {
          200: {
            description: "Successfully updated part",
            content: {
              "application/json": {
                schema: resolver(MessageV2.Part.zod),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
          messageID: MessageID.zod,
          partID: PartID.zod,
        }),
      ),
      validator("json", MessageV2.Part.zod),
      async (c) => {
        const params = c.req.valid("param")
        const body = c.req.valid("json")
        if (body.id !== params.partID || body.messageID !== params.messageID || body.sessionID !== params.sessionID) {
          throw new Error(
            `Part mismatch: body.id='${body.id}' vs partID='${params.partID}', body.messageID='${body.messageID}' vs messageID='${params.messageID}', body.sessionID='${body.sessionID}' vs sessionID='${params.sessionID}'`,
          )
        }
        return jsonRequest("SessionRoutes.updatePart", c, function* () {
          const svc = yield* Session.Service
          return yield* svc.updatePart(body)
        })
      },
    )
    .post(
      "/:sessionID/message",
      describeRoute({
        summary: "Send message",
        description: "Create and send a new message to a session, streaming the AI response.",
        operationId: "session.prompt",
        responses: {
          200: {
            description: "Created message",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    info: MessageV2.Assistant.zod,
                    parts: MessageV2.Part.zod.array(),
                  }),
                ),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
        }),
      ),
      validator("json", zodObject(SessionPrompt.PromptInput).omit({ sessionID: true })),
      async (c) => {
        c.status(200)
        c.header("Content-Type", "application/json")
        return stream(c, async (stream) => {
          const sessionID = c.req.valid("param").sessionID
          const body = c.req.valid("json")
          const msg = await runRequest(
            "SessionRoutes.prompt",
            c,
            SessionPrompt.Service.use((svc) =>
              svc.prompt({ ...body, sessionID } as unknown as SessionPrompt.PromptInput),
            ),
          )
          void stream.write(JSON.stringify(msg))
        })
      },
    )
    .post(
      "/:sessionID/prompt_async",
      describeRoute({
        summary: "Send async message",
        description:
          "Create and send a new message to a session asynchronously, starting the session if needed and returning immediately.",
        operationId: "session.prompt_async",
        responses: {
          204: {
            description: "Prompt accepted",
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
        }),
      ),
      validator("json", zodObject(SessionPrompt.PromptInput).omit({ sessionID: true })),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        const body = c.req.valid("json")
        // legacy 入口也等待完整落库再回 204，与 effect-httpapi 的 durable accepted 语义保持一致。
        await runRequest(
          "SessionRoutes.prompt_async",
          c,
          SessionPrompt.Service.use((svc) =>
            svc.promptAsync({ ...body, sessionID } as unknown as SessionPrompt.PromptInput),
          ),
        )

        return c.body(null, 204)
      },
    )
    .post(
      "/:sessionID/steer",
      describeRoute({
        summary: "Steer active turn",
        description:
          "Persist steering guidance only when targetTurnID still matches the active turn, then continue that same turn after the active step completes.",
        operationId: "session.steer",
        responses: {
          200: {
            description: "Steer persisted",
            content: {
              "application/json": {
                schema: resolver(zodObject(SessionPrompt.SteerAck)),
              },
            },
          },
          ...errors(400, 404, 409),
        },
      }),
      validator("param", z.object({ sessionID: SessionID.zod })),
      validator("json", zodObject(SessionPrompt.SteerInput).omit({ sessionID: true })),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        const body = c.req.valid("json")
        // ACK 在所有 parts 落库后返回；连续引导可直接以此响应作为严格顺序边界。
        const ack = await runRequest(
          "SessionRoutes.steer",
          c,
          SessionPrompt.Service.use((svc) =>
            svc
              .steer({ ...body, sessionID } as SessionPrompt.SteerInput)
              .pipe(
                Effect.mapError((error) =>
                  error instanceof SessionPrompt.SteerEmptyInputError
                    ? ApiError.steerEmptyInput(error)
                    : ApiError.steerTurnInactive(error),
                ),
              ),
          ),
        )
        return c.json(ack)
      },
    )
    .post(
      "/:sessionID/command",
      describeRoute({
        summary: "Send command",
        description: "Send a new command to a session for execution by the AI assistant.",
        operationId: "session.command",
        responses: {
          200: {
            description: "Created message",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    info: MessageV2.Assistant.zod,
                    parts: MessageV2.Part.zod.array(),
                  }),
                ),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
        }),
      ),
      validator("json", zodObject(SessionPrompt.CommandInput).omit({ sessionID: true })),
      async (c) =>
        jsonRequest("SessionRoutes.command", c, function* () {
          const sessionID = c.req.valid("param").sessionID
          const body = c.req.valid("json") as Omit<SessionPrompt.CommandInput, "sessionID">
          const svc = yield* SessionPrompt.Service
          return yield* svc.command({ ...body, sessionID })
        }),
    )
    .post(
      "/:sessionID/shell",
      describeRoute({
        summary: "Run shell command",
        description: "Execute a shell command within the session context and return the AI's response.",
        operationId: "session.shell",
        responses: {
          200: {
            description: "Created message",
            content: {
              "application/json": {
                schema: resolver(MessageV2.WithParts.zod),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
        }),
      ),
      validator("json", zodObject(SessionPrompt.ShellInput).omit({ sessionID: true })),
      async (c) =>
        jsonRequest("SessionRoutes.shell", c, function* () {
          const sessionID = c.req.valid("param").sessionID
          const body = c.req.valid("json") as Omit<SessionPrompt.ShellInput, "sessionID">
          const svc = yield* SessionPrompt.Service
          return yield* svc.shell({ ...body, sessionID })
        }),
    )
    .post(
      "/:sessionID/revert",
      describeRoute({
        summary: "Revert message",
        description: "Revert a specific message in a session, undoing its effects and restoring the previous state.",
        operationId: "session.revert",
        responses: {
          200: {
            description: "Updated session",
            content: {
              "application/json": {
                schema: resolver(Session.Info.zod),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
        }),
      ),
      validator("json", zodObject(SessionRevert.RevertInput).omit({ sessionID: true })),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        const body = c.req.valid("json") as Omit<SessionRevert.RevertInput, "sessionID">
        log.info("revert", body)
        return jsonRequest("SessionRoutes.revert", c, function* () {
          const svc = yield* SessionRevert.Service
          return yield* svc.revert({ sessionID, ...body })
        })
      },
    )
    .post(
      "/:sessionID/unrevert",
      describeRoute({
        summary: "Restore reverted messages",
        description: "Restore all previously reverted messages in a session.",
        operationId: "session.unrevert",
        responses: {
          200: {
            description: "Updated session",
            content: {
              "application/json": {
                schema: resolver(Session.Info.zod),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
        }),
      ),
      async (c) =>
        jsonRequest("SessionRoutes.unrevert", c, function* () {
          const sessionID = c.req.valid("param").sessionID
          const svc = yield* SessionRevert.Service
          return yield* svc.unrevert({ sessionID })
        }),
    )
    .post(
      "/:sessionID/permissions/:permissionID",
      describeRoute({
        summary: "Respond to permission",
        deprecated: true,
        description: "Approve or deny a permission request from the AI assistant.",
        operationId: "permission.respond",
        responses: {
          200: {
            description: "Permission processed successfully",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
          permissionID: PermissionID.zod,
        }),
      ),
      validator("json", z.object({ response: Permission.Reply.zod })),
      async (c) =>
        jsonRequest("SessionRoutes.permissionRespond", c, function* () {
          const params = c.req.valid("param")
          const svc = yield* Permission.Service
          yield* svc.reply({
            requestID: params.permissionID,
            reply: c.req.valid("json").response,
          })
          return true
        }),
    ),
)
