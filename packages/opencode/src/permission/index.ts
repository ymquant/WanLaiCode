import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { ConfigPermission } from "@/config/permission"
import { InstanceState } from "@/effect/instance-state"
import { ProjectID } from "@/project/schema"
import { MessageID, SessionID } from "@/session/schema"
import { PermissionTable } from "@/session/session.sql"
import { Database } from "@/storage/db"
import { eq } from "drizzle-orm"
import { zod } from "@/util/effect-zod"
import * as Log from "@opencode-ai/core/util/log"
import { withStatics } from "@/util/schema"
import { Wildcard } from "@/util/wildcard"
import { Cause, Context, Deferred, Effect, Exit, Layer, Schema } from "effect"
import os from "os"
import { evaluate as evalRule } from "./evaluate"
import { PermissionID } from "./schema"
import { PermissionMode } from "./mode"
import { redactCredentials } from "./redact"
import { Identifier } from "@/id/id"

const log = Log.create({ service: "permission" })

export const Action = Schema.Literals(["allow", "deny", "ask"])
  .annotate({ identifier: "PermissionAction" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type Action = Schema.Schema.Type<typeof Action>

export const Rule = Schema.Struct({
  permission: Schema.String,
  pattern: Schema.String,
  action: Action,
})
  .annotate({ identifier: "PermissionRule" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type Rule = Schema.Schema.Type<typeof Rule>

export const Ruleset = Schema.mutable(Schema.Array(Rule))
  .annotate({ identifier: "PermissionRuleset" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type Ruleset = Schema.Schema.Type<typeof Ruleset>

export class Request extends Schema.Class<Request>("PermissionRequest")({
  id: PermissionID,
  sessionID: SessionID,
  permission: Schema.String,
  patterns: Schema.Array(Schema.String),
  metadata: Schema.Record(Schema.String, Schema.Unknown),
  always: Schema.Array(Schema.String),
  tool: Schema.optional(
    Schema.Struct({
      messageID: MessageID,
      callID: Schema.String,
    }),
  ),
}) {
  static readonly zod = zod(this)
}

export const ReviewDecision = Schema.Literals(["approve", "deny", "ask_user"])
export const ReviewRisk = Schema.Literals(["low", "medium", "high", "critical"])
export const ReviewResult = Schema.Struct({
  decision: ReviewDecision,
  risk: ReviewRisk,
  reason: Schema.String,
  providerID: Schema.String,
  modelID: Schema.String,
  halt: Schema.Boolean,
})
export type ReviewResult = Schema.Schema.Type<typeof ReviewResult>
export type Reviewer = (input: { request: Request; ruleset: Ruleset }) => Effect.Effect<ReviewResult, unknown>
export type ReviewOutcome =
  | { status: "reviewing" }
  | (Omit<ReviewResult, "halt"> & { status: "approved" | "denied" | "escalated" })
  | { status: "failed"; reason: "reviewer_unavailable" }
export type ReviewOptions = {
  onReview?: (review: ReviewOutcome) => Effect.Effect<void>
}
export const ReviewerRef = Context.Reference<Reviewer | undefined>("@opencode/PermissionReviewer", {
  defaultValue: () => undefined,
})

export const Reply = Schema.Literals(["once", "always", "reject"]).pipe(withStatics((s) => ({ zod: zod(s) })))
export type Reply = Schema.Schema.Type<typeof Reply>

export const Fallback = Schema.Literals(["allow", "reject", "ask"])
  .annotate({ identifier: "PermissionFallback" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type Fallback = Schema.Schema.Type<typeof Fallback>

// 运行级权限兜底:fiber/run 作用域的 Context.Reference,prompt 包裹 loop 时 provide。
// 同 fiber 下所有 ask 调用点(主循环/doom_loop/workflow/子会话)自动继承;不进公开 API、
// run 结束自动失效(无残留)、不同 run 不同 fiber(无并发污染)。
export const FallbackRef = Context.Reference<Fallback>("@opencode/PermissionFallback", {
  defaultValue: () => "ask",
})

const reply = {
  reply: Reply,
  message: Schema.optional(Schema.String),
}

export const ReplyBody = Schema.Struct(reply)
  .annotate({ identifier: "PermissionReplyBody" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type ReplyBody = Schema.Schema.Type<typeof ReplyBody>

export class Approval extends Schema.Class<Approval>("PermissionApproval")({
  projectID: ProjectID,
  patterns: Schema.Array(Schema.String),
}) {
  static readonly zod = zod(this)
}

export const Event = {
  Asked: BusEvent.define("permission.asked", Request),
  Replied: BusEvent.define(
    "permission.replied",
    Schema.Struct({
      sessionID: SessionID,
      requestID: PermissionID,
      reply: Reply,
    }),
  ),
  ReviewStarted: BusEvent.define(
    "permission.review.started",
    Schema.Struct({
      reviewID: Schema.String,
      permissionID: PermissionID,
      sessionID: SessionID,
      summary: Schema.String,
      startedAt: Schema.Number,
    }),
  ),
  ReviewApproved: BusEvent.define(
    "permission.review.approved",
    Schema.Struct({
      reviewID: Schema.String,
      permissionID: PermissionID,
      sessionID: SessionID,
      summary: Schema.String,
      decision: ReviewDecision,
      risk: ReviewRisk,
      reason: Schema.String,
      providerID: Schema.String,
      modelID: Schema.String,
      completedAt: Schema.Number,
    }),
  ),
  ReviewDenied: BusEvent.define(
    "permission.review.denied",
    Schema.Struct({
      reviewID: Schema.String,
      permissionID: PermissionID,
      sessionID: SessionID,
      summary: Schema.String,
      decision: ReviewDecision,
      risk: ReviewRisk,
      reason: Schema.String,
      providerID: Schema.String,
      modelID: Schema.String,
      completedAt: Schema.Number,
    }),
  ),
  ReviewEscalated: BusEvent.define(
    "permission.review.escalated",
    Schema.Struct({
      reviewID: Schema.String,
      permissionID: PermissionID,
      sessionID: SessionID,
      summary: Schema.String,
      decision: ReviewDecision,
      risk: ReviewRisk,
      reason: Schema.String,
      providerID: Schema.String,
      modelID: Schema.String,
      completedAt: Schema.Number,
    }),
  ),
  ReviewFailed: BusEvent.define(
    "permission.review.failed",
    Schema.Struct({
      reviewID: Schema.String,
      permissionID: PermissionID,
      sessionID: SessionID,
      summary: Schema.String,
      reason: Schema.String,
      completedAt: Schema.Number,
    }),
  ),
}

export class RejectedError extends Schema.TaggedErrorClass<RejectedError>()("PermissionRejectedError", {}) {
  override get message() {
    return "The user rejected permission to use this specific tool call."
  }
}

export class CorrectedError extends Schema.TaggedErrorClass<CorrectedError>()("PermissionCorrectedError", {
  feedback: Schema.String,
}) {
  override get message() {
    return `The user rejected permission to use this specific tool call with the following feedback: ${this.feedback}`
  }
}

export class DeniedError extends Schema.TaggedErrorClass<DeniedError>()("PermissionDeniedError", {
  ruleset: Schema.Any,
}) {
  override get message() {
    return `The user has specified a rule which prevents you from using this specific tool call. Here are some of the relevant rules ${JSON.stringify(this.ruleset)}`
  }
}

export class ReviewDeniedError extends Schema.TaggedErrorClass<ReviewDeniedError>()("PermissionReviewDeniedError", {
  risk: ReviewRisk,
  reason: Schema.String,
  halt: Schema.Boolean,
}) {
  override get message() {
    return `The permission reviewer denied this specific tool call: ${this.reason}`
  }
}

export type Error = DeniedError | RejectedError | CorrectedError | ReviewDeniedError

export const AskInput = Schema.Struct({
  ...Request.fields,
  id: Schema.optional(PermissionID),
  ruleset: Ruleset,
  fallback: Schema.optional(Fallback),
})
  .annotate({ identifier: "PermissionAskInput" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type AskInput = Schema.Schema.Type<typeof AskInput>

export const ReplyInput = Schema.Struct({
  requestID: PermissionID,
  ...reply,
})
  .annotate({ identifier: "PermissionReplyInput" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type ReplyInput = Schema.Schema.Type<typeof ReplyInput>

export interface Interface {
  readonly ask: (input: AskInput, options?: ReviewOptions) => Effect.Effect<void, Error>
  readonly reply: (input: ReplyInput) => Effect.Effect<void>
  readonly list: () => Effect.Effect<ReadonlyArray<Request>>
}

interface PendingEntry {
  info: Request
  deferred: Deferred.Deferred<void, RejectedError | CorrectedError>
}

interface State {
  pending: Map<PermissionID, PendingEntry>
  approved: Ruleset
}

export function evaluate(permission: string, pattern: string, ...rulesets: Ruleset[]): Rule {
  return evalRule(permission, pattern, ...rulesets)
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Permission") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const state = yield* InstanceState.make<State>(
      Effect.fn("Permission.state")(function* (ctx) {
        const row = Database.use((db) =>
          db.select().from(PermissionTable).where(eq(PermissionTable.project_id, ctx.project.id)).get(),
        )
        const state = {
          pending: new Map<PermissionID, PendingEntry>(),
          approved: row?.data ?? [],
        }

        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            for (const item of state.pending.values()) {
              yield* Deferred.fail(item.deferred, new RejectedError())
            }
            state.pending.clear()
          }),
        )

        return state
      }),
    )

    const ask = Effect.fn("Permission.ask")(function* (input: AskInput, options?: ReviewOptions) {
      const { approved } = yield* InstanceState.get(state)
      const { ruleset, fallback, ...request } = input
      const mode = yield* PermissionMode.Ref
      let needsAsk = false

      for (const pattern of request.patterns) {
        const configured = evaluate(request.permission, pattern, ruleset)
        if (configured.action === "deny") {
          return yield* new DeniedError({
            ruleset: ruleset.filter((rule) => Wildcard.match(request.permission, rule.permission)),
          })
        }
        const rule = evaluate(request.permission, pattern, ruleset, approved)
        log.info("evaluated", { permission: request.permission, pattern, action: rule })
        if (rule.action === "deny") {
          return yield* new DeniedError({
            ruleset: ruleset.filter((rule) => Wildcard.match(request.permission, rule.permission)),
          })
        }
        if (rule.action === "allow" && mode !== "auto_review") continue
        needsAsk = true
      }

      if (!needsAsk) return

      // 无人值守兜底:本来会弹窗挂起的请求按运行级 fallback 决策,绝不挂起。
      // 优先级:显式 AskInput.fallback > run 作用域的 FallbackRef > 默认 ask。
      // deny 已在上方循环里优先短路,黑名单天然高于这里的放行。
      // FallbackRef 由 prompt 包裹 loop 时 provide,同 fiber 下所有 ask(doom_loop/workflow/子会话)自动继承。
      const decision = fallback ?? (yield* FallbackRef)
      if (decision === "allow") {
        log.info("auto-allow", { permission: request.permission, patterns: request.patterns })
        return
      }
      if (decision === "reject") {
        return yield* new DeniedError({
          ruleset: ruleset.filter((rule) => Wildcard.match(request.permission, rule.permission)),
        })
      }

      const id = request.id ?? PermissionID.ascending()
      const info = Schema.decodeUnknownSync(Request)({
        id,
        ...request,
      })

      if (mode === "full_access") return

      if (mode === "auto_review") {
        const reviewer = yield* ReviewerRef
        if (reviewer) {
          const reviewID = Identifier.create("review", "ascending")
          const summary = redactReviewSummary(info)
          if (options?.onReview) yield* options.onReview({ status: "reviewing" })
          yield* bus.publish(Event.ReviewStarted, {
            reviewID,
            permissionID: info.id,
            sessionID: info.sessionID,
            summary,
            startedAt: Date.now(),
          })
          const reviewed = yield* reviewer({ request: info, ruleset }).pipe(
            Effect.onExit((exit) => {
              if (Exit.isSuccess(exit) || !Cause.hasInterruptsOnly(exit.cause)) return Effect.void
              return bus.publish(Event.ReviewFailed, {
                reviewID,
                permissionID: info.id,
                sessionID: info.sessionID,
                summary,
                reason: "review_cancelled",
                completedAt: Date.now(),
              })
            }),
            Effect.exit,
          )
          if (Exit.isSuccess(reviewed)) {
            const outcome: ReviewOutcome = {
              status:
                reviewed.value.decision === "approve"
                  ? "approved"
                  : reviewed.value.decision === "deny"
                    ? "denied"
                    : "escalated",
              decision: reviewed.value.decision,
              risk: reviewed.value.risk,
              reason: reviewed.value.reason,
              providerID: reviewed.value.providerID,
              modelID: reviewed.value.modelID,
            }
            if (options?.onReview) yield* options.onReview(outcome)
            const completed = {
              reviewID,
              permissionID: info.id,
              sessionID: info.sessionID,
              summary,
              decision: reviewed.value.decision,
              risk: reviewed.value.risk,
              reason: reviewed.value.reason,
              providerID: reviewed.value.providerID,
              modelID: reviewed.value.modelID,
              completedAt: Date.now(),
            }
            if (reviewed.value.decision === "approve") {
              yield* bus.publish(Event.ReviewApproved, completed)
              return
            }
            if (reviewed.value.decision === "deny") {
              yield* bus.publish(Event.ReviewDenied, completed)
              return yield* new ReviewDeniedError({
                risk: reviewed.value.risk,
                reason: reviewed.value.reason,
                halt: reviewed.value.halt,
              })
            }
            yield* bus.publish(Event.ReviewEscalated, completed)
          } else if (Cause.hasInterruptsOnly(reviewed.cause)) {
            return yield* Effect.failCause(reviewed.cause).pipe(Effect.orDie)
          } else {
            const reason = "reviewer_unavailable" as const
            if (options?.onReview) yield* options.onReview({ status: "failed", reason })
            yield* bus.publish(Event.ReviewFailed, {
              reviewID,
              permissionID: info.id,
              sessionID: info.sessionID,
              summary,
              reason,
              completedAt: Date.now(),
            })
          }
        }
      }

      return yield* waitForHumanReply(info)
    })

    const waitForHumanReply = Effect.fn("Permission.waitForHumanReply")(function* (info: Request) {
      const { pending } = yield* InstanceState.get(state)
      log.info("asking", { id: info.id, permission: info.permission, patterns: info.patterns })

      const deferred = yield* Deferred.make<void, RejectedError | CorrectedError>()
      pending.set(info.id, { info, deferred })
      yield* bus.publish(Event.Asked, info)
      return yield* Effect.ensuring(
        Deferred.await(deferred),
        Effect.gen(function* () {
          // pending 里还在 = 不是经 reply() 正常应答移除的（fiber 被中断/teardown）。
          // 这种情况必须补发一个终止事件，否则客户端的权限对话框会变成永远点不掉的孤儿。
          if (!pending.has(info.id)) return
          pending.delete(info.id)
          yield* bus.publish(Event.Replied, {
            sessionID: info.sessionID,
            requestID: info.id,
            reply: "reject",
          })
        }),
      )
    })

    const reply = Effect.fn("Permission.reply")(function* (input: ReplyInput) {
      const { approved, pending } = yield* InstanceState.get(state)
      const existing = pending.get(input.requestID)
      if (!existing) return

      pending.delete(input.requestID)
      yield* bus.publish(Event.Replied, {
        sessionID: existing.info.sessionID,
        requestID: existing.info.id,
        reply: input.reply,
      })

      if (input.reply === "reject") {
        yield* Deferred.fail(
          existing.deferred,
          input.message ? new CorrectedError({ feedback: input.message }) : new RejectedError(),
        )

        for (const [id, item] of pending.entries()) {
          if (item.info.sessionID !== existing.info.sessionID) continue
          pending.delete(id)
          yield* bus.publish(Event.Replied, {
            sessionID: item.info.sessionID,
            requestID: item.info.id,
            reply: "reject",
          })
          yield* Deferred.fail(item.deferred, new RejectedError())
        }
        return
      }

      yield* Deferred.succeed(existing.deferred, undefined)
      if (input.reply === "once") return

      for (const pattern of existing.info.always) {
        approved.push({
          permission: existing.info.permission,
          pattern,
          action: "allow",
        })
      }

      for (const [id, item] of pending.entries()) {
        if (item.info.sessionID !== existing.info.sessionID) continue
        const ok = item.info.patterns.every(
          (pattern) => evaluate(item.info.permission, pattern, approved).action === "allow",
        )
        if (!ok) continue
        pending.delete(id)
        yield* bus.publish(Event.Replied, {
          sessionID: item.info.sessionID,
          requestID: item.info.id,
          reply: "always",
        })
        yield* Deferred.succeed(item.deferred, undefined)
      }
    })

    const list = Effect.fn("Permission.list")(function* () {
      const pending = (yield* InstanceState.get(state)).pending
      return Array.from(pending.values(), (item) => item.info)
    })

    return Service.of({ ask, reply, list })
  }),
)

function expand(pattern: string): string {
  if (pattern.startsWith("~/")) return os.homedir() + pattern.slice(1)
  if (pattern === "~") return os.homedir()
  if (pattern.startsWith("$HOME/")) return os.homedir() + pattern.slice(5)
  if (pattern.startsWith("$HOME")) return os.homedir() + pattern.slice(5)
  return pattern
}

function redactReviewSummary(info: Request) {
  return redactCredentials(`${info.permission}: ${info.patterns[0] ?? ""}`)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160)
}

export function fromConfig(permission: ConfigPermission.Info) {
  const ruleset: Ruleset = []
  for (const [key, value] of Object.entries(permission)) {
    if (typeof value === "string") {
      ruleset.push({ permission: key, action: value, pattern: "*" })
      continue
    }
    ruleset.push(
      ...Object.entries(value).map(([pattern, action]) => ({ permission: key, pattern: expand(pattern), action })),
    )
  }
  return ruleset
}

export function merge(...rulesets: Ruleset[]): Ruleset {
  return rulesets.flat()
}

const EDIT_TOOLS = ["edit", "write", "apply_patch"]

export function disabled(tools: string[], ruleset: Ruleset): Set<string> {
  const result = new Set<string>()
  for (const tool of tools) {
    const permission = EDIT_TOOLS.includes(tool) ? "edit" : tool
    const rule = ruleset.findLast((rule) => Wildcard.match(permission, rule.permission))
    if (!rule) continue
    if (rule.pattern === "*" && rule.action === "deny") result.add(tool)
  }
  return result
}

export const defaultLayer = layer.pipe(Layer.provide(Bus.layer))

export * as Permission from "."
