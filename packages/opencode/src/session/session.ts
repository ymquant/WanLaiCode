import { Slug } from "@opencode-ai/core/util/slug"
import path from "path"
import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Decimal } from "decimal.js"
import { type ProviderMetadata, type LanguageModelUsage } from "ai"
import { Flag } from "@opencode-ai/core/flag/flag"
import { InstallationVersion } from "@opencode-ai/core/installation/version"

import { Database } from "@/storage/db"
import { NotFoundError } from "@/storage/storage"
import { eq } from "drizzle-orm"
import { and } from "drizzle-orm"
import { gte } from "drizzle-orm"
import { isNull, isNotNull } from "drizzle-orm"
import { desc } from "drizzle-orm"
import { like } from "drizzle-orm"
import { inArray } from "drizzle-orm"
import { lt } from "drizzle-orm"
import { or } from "drizzle-orm"
import { sql } from "drizzle-orm"
import { SyncEvent } from "../sync"
import type { SQL } from "drizzle-orm"
import { MessageTable, PartTable, SessionTable } from "./session.sql"
import { ProjectTable } from "../project/project.sql"
import { Storage } from "@/storage/storage"
import * as Log from "@opencode-ai/core/util/log"
import { MessageV2 } from "./message-v2"
import type { InstanceContext } from "../project/instance"
import { InstanceState } from "@/effect/instance-state"
import { Snapshot } from "@/snapshot"
import { ProjectID } from "../project/schema"
import { WorkspaceID } from "../control-plane/schema"
import { SessionID, MessageID, PartID } from "./schema"
import { Goal, GoalStatus, validateObjective, GoalValidationError } from "./goal"
import { SessionStatus } from "./status"
import { ModelID, ProviderID } from "@/provider/schema"

import type { Provider } from "@/provider/provider"
import { Permission } from "@/permission"
import { Global } from "@opencode-ai/core/global"
import { Effect, Layer, Option, Context, Schema, Semaphore, Types } from "effect"
import { zod } from "@/util/effect-zod"
import { NonNegativeInt, optionalOmitUndefined, withStatics } from "@/util/schema"

const log = Log.create({ service: "session" })

const parentTitlePrefix = "New session - "
const childTitlePrefix = "Child session - "

function createDefaultTitle(isChild = false) {
  return (isChild ? childTitlePrefix : parentTitlePrefix) + new Date().toISOString()
}

export function isDefaultTitle(title: string) {
  return new RegExp(
    `^(${parentTitlePrefix}|${childTitlePrefix})\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$`,
  ).test(title)
}

type SessionRow = typeof SessionTable.$inferSelect

export function fromRow(row: SessionRow): Info {
  const summary =
    row.summary_additions !== null || row.summary_deletions !== null || row.summary_files !== null
      ? {
          additions: row.summary_additions ?? 0,
          deletions: row.summary_deletions ?? 0,
          files: row.summary_files ?? 0,
          diffs: row.summary_diffs ?? undefined,
        }
      : undefined
  const share = row.share_url ? { url: row.share_url } : undefined
  const revert = row.revert ?? undefined
  const forkedFrom = row.forked_from ?? undefined
  return {
    id: row.id,
    slug: row.slug,
    projectID: row.project_id,
    workspaceID: row.workspace_id ?? undefined,
    directory: row.directory,
    path: row.path ?? undefined,
    parentID: row.parent_id ?? undefined,
    title: row.title,
    agent: row.agent ?? undefined,
    model: row.model
      ? {
          id: ModelID.make(row.model.id),
          providerID: ProviderID.make(row.model.providerID),
          variant: row.model.variant,
        }
      : undefined,
    version: row.version,
    summary,
    share,
    revert,
    forkedFrom,
    permission: row.permission ?? undefined,
    time: {
      created: row.time_created,
      updated: row.time_updated,
      compacting: row.time_compacting ?? undefined,
      archived: row.time_archived ?? undefined,
    },
  }
}

export function toRow(info: Info) {
  return {
    id: info.id,
    project_id: info.projectID,
    workspace_id: info.workspaceID,
    parent_id: info.parentID,
    slug: info.slug,
    directory: info.directory,
    path: info.path,
    title: info.title,
    agent: info.agent,
    model: info.model,
    version: info.version,
    share_url: info.share?.url,
    summary_additions: info.summary?.additions,
    summary_deletions: info.summary?.deletions,
    summary_files: info.summary?.files,
    summary_diffs: info.summary?.diffs,
    revert: info.revert ?? null,
    forked_from: info.forkedFrom ?? null,
    permission: info.permission,
    time_created: info.time.created,
    time_updated: info.time.updated,
    time_compacting: info.time.compacting,
    time_archived: info.time.archived,
  }
}

function parseForkedTitle(title: string): { base: string; num: number } {
  const match = title.match(/^(.+) \(fork #(\d+)\)$/)
  if (match) return { base: match[1], num: parseInt(match[2], 10) }
  return { base: title, num: 0 }
}

// 在 existingTitles 范围内找出最大 fork 号，再 +1 拼成新 fork 标题。
// 保证同一项目下从同一源多次 fork 的标题严格递增（不会出现两个 (fork #1)）。
function getForkedTitle(sourceTitle: string, existingTitles: Iterable<string>): string {
  const { base } = parseForkedTitle(sourceTitle)
  let maxNum = 0
  // 源本身也算作占用了某个号（如果是 (fork #N) 形式，至少要超过它）
  const sourceParsed = parseForkedTitle(sourceTitle)
  if (sourceParsed.num > maxNum) maxNum = sourceParsed.num
  for (const t of existingTitles) {
    const { base: b, num } = parseForkedTitle(t)
    if (b !== base) continue
    if (num > maxNum) maxNum = num
  }
  return `${base} (fork #${maxNum + 1})`
}

function sessionPath(worktree: string, cwd: string) {
  return path.relative(path.resolve(worktree), cwd).replaceAll("\\", "/")
}

const Summary = Schema.Struct({
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
  files: NonNegativeInt,
  diffs: optionalOmitUndefined(Schema.Array(Snapshot.FileDiff)),
})

const Share = Schema.Struct({
  url: Schema.String,
})

// Legacy HTTP accepted negative values here. Keep archive timestamps permissive
// while excluding non-finite values that cannot round-trip through JSON.
export const ArchivedTimestamp = Schema.Finite

const Time = Schema.Struct({
  created: NonNegativeInt,
  updated: NonNegativeInt,
  compacting: optionalOmitUndefined(NonNegativeInt),
  archived: optionalOmitUndefined(ArchivedTimestamp),
})

const Revert = Schema.Struct({
  messageID: MessageID,
  partID: optionalOmitUndefined(PartID),
  snapshot: optionalOmitUndefined(Schema.String),
  diff: optionalOmitUndefined(Schema.String),
})

// 标识此 session 是从哪个 session/message fork 出来的（持久化在 forked_from 列）。
// 用于派生出的新会话顶部显示「从对话中派生」banner，点击跳回源会话/消息。
const ForkedFrom = Schema.Struct({
  sessionID: SessionID,
  messageID: optionalOmitUndefined(MessageID),
})

const Model = Schema.Struct({
  id: ModelID,
  providerID: ProviderID,
  variant: optionalOmitUndefined(Schema.String),
})

export const Info = Schema.Struct({
  id: SessionID,
  slug: Schema.String,
  projectID: ProjectID,
  workspaceID: optionalOmitUndefined(WorkspaceID),
  directory: Schema.String,
  path: optionalOmitUndefined(Schema.String),
  parentID: optionalOmitUndefined(SessionID),
  summary: optionalOmitUndefined(Summary),
  share: optionalOmitUndefined(Share),
  title: Schema.String,
  agent: optionalOmitUndefined(Schema.String),
  model: optionalOmitUndefined(Model),
  version: Schema.String,
  time: Time,
  permission: optionalOmitUndefined(Permission.Ruleset),
  revert: optionalOmitUndefined(Revert),
  forkedFrom: optionalOmitUndefined(ForkedFrom),
})
  .annotate({ identifier: "Session" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type Info = Types.DeepMutable<Schema.Schema.Type<typeof Info>>

export const ProjectInfo = Schema.Struct({
  id: ProjectID,
  name: optionalOmitUndefined(Schema.String),
  worktree: Schema.String,
})
  .annotate({ identifier: "ProjectSummary" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type ProjectInfo = Types.DeepMutable<Schema.Schema.Type<typeof ProjectInfo>>

export const GlobalInfo = Schema.Struct({
  ...Info.fields,
  project: Schema.NullOr(ProjectInfo),
})
  .annotate({ identifier: "GlobalSession" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type GlobalInfo = Types.DeepMutable<Schema.Schema.Type<typeof GlobalInfo>>

export const CreateInput = Schema.optional(
  Schema.Struct({
    id: Schema.optional(SessionID),
    parentID: Schema.optional(SessionID),
    title: Schema.optional(Schema.String),
    agent: Schema.optional(Schema.String),
    model: Schema.optional(Model),
    permission: Schema.optional(Permission.Ruleset),
    workspaceID: Schema.optional(WorkspaceID),
  }),
).pipe(withStatics((s) => ({ zod: zod(s) })))
export type CreateInput = Types.DeepMutable<Schema.Schema.Type<typeof CreateInput>>

export const ForkInput = Schema.Struct({
  sessionID: SessionID,
  messageID: Schema.optional(MessageID),
  // 派生到该目录（通常是新建的 git worktree 路径）；省略则沿用当前 ctx.directory
  directory: Schema.optional(Schema.String),
}).pipe(withStatics((s) => ({ zod: zod(s) })))
export const GetInput = SessionID
export const ChildrenInput = SessionID
export const RemoveInput = SessionID
export const SetTitleInput = Schema.Struct({ sessionID: SessionID, title: Schema.String }).pipe(
  withStatics((s) => ({ zod: zod(s) })),
)
export const SetArchivedInput = Schema.Struct({
  sessionID: SessionID,
  time: Schema.optional(ArchivedTimestamp),
}).pipe(withStatics((s) => ({ zod: zod(s) })))
export const SetPermissionInput = Schema.Struct({
  sessionID: SessionID,
  permission: Permission.Ruleset,
}).pipe(withStatics((s) => ({ zod: zod(s) })))
export const SetRevertInput = Schema.Struct({
  sessionID: SessionID,
  revert: Schema.optional(Revert),
  summary: Schema.optional(Summary),
}).pipe(withStatics((s) => ({ zod: zod(s) })))
export const MessagesInput = Schema.Struct({
  sessionID: SessionID,
  limit: Schema.optional(NonNegativeInt),
}).pipe(withStatics((s) => ({ zod: zod(s) })))
export type ListInput = {
  directory?: string
  scope?: "project"
  path?: string
  workspaceID?: WorkspaceID
  roots?: boolean
  start?: number
  search?: string
  limit?: number
}

const CreatedEventSchema = Schema.Struct({
  sessionID: SessionID,
  info: Info,
})

const UpdatedShare = Schema.Struct({
  url: Schema.optional(Schema.NullOr(Schema.String)),
})

const UpdatedTime = Schema.Struct({
  created: Schema.optional(Schema.NullOr(NonNegativeInt)),
  updated: Schema.optional(Schema.NullOr(NonNegativeInt)),
  compacting: Schema.optional(Schema.NullOr(NonNegativeInt)),
  archived: Schema.optional(Schema.NullOr(ArchivedTimestamp)),
})

const UpdatedInfo = Schema.Struct({
  id: Schema.optional(Schema.NullOr(SessionID)),
  slug: Schema.optional(Schema.NullOr(Schema.String)),
  projectID: Schema.optional(Schema.NullOr(ProjectID)),
  workspaceID: Schema.optional(Schema.NullOr(WorkspaceID)),
  directory: Schema.optional(Schema.NullOr(Schema.String)),
  path: Schema.optional(Schema.NullOr(Schema.String)),
  parentID: Schema.optional(Schema.NullOr(SessionID)),
  summary: Schema.optional(Schema.NullOr(Summary)),
  share: Schema.optional(UpdatedShare),
  title: Schema.optional(Schema.NullOr(Schema.String)),
  agent: Schema.optional(Schema.NullOr(Schema.String)),
  model: Schema.optional(Schema.NullOr(Model)),
  version: Schema.optional(Schema.NullOr(Schema.String)),
  time: Schema.optional(UpdatedTime),
  permission: Schema.optional(Schema.NullOr(Permission.Ruleset)),
  revert: Schema.optional(Schema.NullOr(Revert)),
  forkedFrom: Schema.optional(Schema.NullOr(ForkedFrom)),
})

const UpdatedEventSchema = Schema.Struct({
  sessionID: SessionID,
  info: UpdatedInfo,
})

export const Event = {
  Created: SyncEvent.define({
    type: "session.created",
    version: 1,
    aggregate: "sessionID",
    schema: CreatedEventSchema,
  }),
  Updated: SyncEvent.define({
    type: "session.updated",
    version: 1,
    aggregate: "sessionID",
    schema: UpdatedEventSchema,
    busSchema: CreatedEventSchema,
  }),
  Deleted: SyncEvent.define({
    type: "session.deleted",
    version: 1,
    aggregate: "sessionID",
    schema: CreatedEventSchema,
  }),
  Diff: BusEvent.define(
    "session.diff",
    Schema.Struct({
      sessionID: SessionID,
      diff: Schema.Array(Snapshot.FileDiff),
    }),
  ),
  Error: BusEvent.define(
    "session.error",
    Schema.Struct({
      sessionID: Schema.optional(SessionID),
      // Reuses MessageV2.Assistant.fields.error (already Schema.optional) so
      // the derived zod keeps the same discriminated-union shape on the bus.
      error: MessageV2.Assistant.fields.error,
    }),
  ),
  Suggestion: BusEvent.define(
    "session.suggestion",
    Schema.Struct({
      sessionID: SessionID,
      text: Schema.String,
    }),
  ),
}

export function plan(input: { slug: string; time: { created: number } }, instance: InstanceContext) {
  const base = instance.project.vcs
    ? path.join(instance.worktree, ".wanlaicode", "plans")
    : path.join(Global.Path.data, "plans")
  return path.join(base, [input.time.created, input.slug].join("-") + ".md")
}

export const getUsage = (input: { model: Provider.Model; usage: LanguageModelUsage; metadata?: ProviderMetadata }) => {
  const safe = (value: number) => {
    if (!Number.isFinite(value)) return 0
    return value
  }
  const inputTokens = safe(input.usage.inputTokens ?? 0)
  const outputTokens = safe(input.usage.outputTokens ?? 0)
  const reasoningTokens = safe(input.usage.outputTokenDetails?.reasoningTokens ?? input.usage.reasoningTokens ?? 0)

  const cacheReadInputTokens = safe(
    input.usage.inputTokenDetails?.cacheReadTokens ?? input.usage.cachedInputTokens ?? 0,
  )
  const cacheWriteInputTokens = safe(
    Number(
      input.usage.inputTokenDetails?.cacheWriteTokens ??
        input.metadata?.["anthropic"]?.["cacheCreationInputTokens"] ??
        // google-vertex-anthropic returns metadata under "vertex" key
        // (AnthropicMessagesLanguageModel custom provider key from 'vertex.anthropic.messages')
        input.metadata?.["vertex"]?.["cacheCreationInputTokens"] ??
        // @ts-expect-error
        input.metadata?.["bedrock"]?.["usage"]?.["cacheWriteInputTokens"] ??
        // @ts-expect-error
        input.metadata?.["venice"]?.["usage"]?.["cacheCreationInputTokens"] ??
        0,
    ),
  )

  // AI SDK v6 normalized inputTokens to include cached tokens across all providers
  // (including Anthropic/Bedrock which previously excluded them). Always subtract cache
  // tokens to get the non-cached input count for separate cost calculation.
  const adjustedInputTokens = safe(inputTokens - cacheReadInputTokens - cacheWriteInputTokens)

  const total = input.usage.totalTokens

  const tokens = {
    total,
    input: adjustedInputTokens,
    output: safe(outputTokens - reasoningTokens),
    reasoning: reasoningTokens,
    cache: {
      write: cacheWriteInputTokens,
      read: cacheReadInputTokens,
    },
  }

  const costInfo =
    input.model.cost?.experimentalOver200K && tokens.input + tokens.cache.read > 200_000
      ? input.model.cost.experimentalOver200K
      : input.model.cost
  return {
    cost: safe(
      new Decimal(0)
        .add(new Decimal(tokens.input).mul(costInfo?.input ?? 0).div(1_000_000))
        .add(new Decimal(tokens.output).mul(costInfo?.output ?? 0).div(1_000_000))
        .add(new Decimal(tokens.cache.read).mul(costInfo?.cache?.read ?? 0).div(1_000_000))
        .add(new Decimal(tokens.cache.write).mul(costInfo?.cache?.write ?? 0).div(1_000_000))
        // TODO: update models.dev to have better pricing model, for now:
        // charge reasoning tokens at the same rate as output tokens
        .add(new Decimal(tokens.reasoning).mul(costInfo?.output ?? 0).div(1_000_000))
        .toNumber(),
    ),
    tokens,
  }
}

export class BusyError extends Error {
  constructor(public readonly sessionID: string) {
    super(`Session ${sessionID} is busy`)
  }
}

export type NotFound = InstanceType<typeof NotFoundError>

export interface Interface {
  readonly list: (input?: ListInput) => Effect.Effect<Info[]>
  readonly create: (input?: {
    id?: SessionID
    parentID?: SessionID
    title?: string
    agent?: string
    model?: Schema.Schema.Type<typeof Model>
    permission?: Permission.Ruleset
    workspaceID?: WorkspaceID
  }) => Effect.Effect<Info, NotFound>
  readonly fork: (input: {
    sessionID: SessionID
    messageID?: MessageID
    directory?: string
  }) => Effect.Effect<Info, NotFound>
  readonly touch: (sessionID: SessionID) => Effect.Effect<void>
  readonly get: (id: SessionID) => Effect.Effect<Info, NotFound>
  readonly setTitle: (input: { sessionID: SessionID; title: string }) => Effect.Effect<void>
  readonly setArchived: (input: { sessionID: SessionID; time?: number }) => Effect.Effect<void, NotFound>
  readonly setPermission: (input: { sessionID: SessionID; permission: Permission.Ruleset }) => Effect.Effect<void>
  readonly setModel: (input: { sessionID: SessionID; model: Schema.Schema.Type<typeof Model> }) => Effect.Effect<void>
  readonly setRevert: (input: {
    sessionID: SessionID
    revert: Info["revert"]
    summary: Info["summary"]
  }) => Effect.Effect<void>
  readonly clearRevert: (sessionID: SessionID) => Effect.Effect<void>
  readonly setSummary: (input: { sessionID: SessionID; summary: Info["summary"] }) => Effect.Effect<void>
  readonly diff: (sessionID: SessionID) => Effect.Effect<Snapshot.FileDiff[]>
  readonly messages: (input: { sessionID: SessionID; limit?: number }) => Effect.Effect<MessageV2.WithParts[]>
  // runner 水位与收尾查询必须走轻量索引，禁止为了定位一条新 assistant 读取整段历史消息。
  readonly messageHighWater: (sessionID: SessionID) => Effect.Effect<number>
  readonly latestAssistant: (input: {
    sessionID: SessionID
    afterSequence?: number
  }) => Effect.Effect<Option.Option<MessageV2.WithParts>>
  readonly repairOrphanToolParts: (sessionID: SessionID) => Effect.Effect<void>
  readonly children: (parentID: SessionID) => Effect.Effect<Info[]>
  readonly remove: (sessionID: SessionID) => Effect.Effect<void, NotFound>
  readonly updateMessage: <T extends MessageV2.Info>(msg: T) => Effect.Effect<T>
  readonly removeMessage: (input: { sessionID: SessionID; messageID: MessageID }) => Effect.Effect<MessageID>
  readonly removePart: (input: { sessionID: SessionID; messageID: MessageID; partID: PartID }) => Effect.Effect<PartID>
  readonly getPart: (input: {
    sessionID: SessionID
    messageID: MessageID
    partID: PartID
  }) => Effect.Effect<MessageV2.Part | undefined>
  readonly updatePart: <T extends MessageV2.Part>(part: T) => Effect.Effect<T>
  readonly updatePartDelta: (input: {
    sessionID: SessionID
    messageID: MessageID
    partID: PartID
    field: string
    delta: string
  }) => Effect.Effect<void>
  /** Finds the first message matching the predicate, searching newest-first. */
  readonly findMessage: (
    sessionID: SessionID,
    predicate: (msg: MessageV2.WithParts) => boolean,
  ) => Effect.Effect<Option.Option<MessageV2.WithParts>>
  readonly setGoal: (input: { sessionID: SessionID; objective: string }) => Effect.Effect<Goal, GoalValidationError>
  readonly setGoalStatus: (input: { sessionID: SessionID; status: GoalStatus }) => Effect.Effect<Goal, NotFound>
  readonly getGoal: (sessionID: SessionID) => Effect.Effect<Goal | null>
  readonly clearGoal: (sessionID: SessionID) => Effect.Effect<boolean>
  readonly addGoalUsage: (input: { sessionID: SessionID; tokens: number; seconds: number }) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Session") {}

export type Patch = Types.DeepMutable<SyncEvent.Event<typeof Event.Updated>["data"]["info"]>

const db = <T>(fn: (d: Parameters<typeof Database.use>[0] extends (trx: infer D) => any ? D : never) => T) =>
  Effect.sync(() => Database.use(fn))

// 串行化同一 session 的 goal 读改写，避免并发 addGoalUsage/setGoalStatus 丢更新（模块级跨实例共享）。
const goalLocks = new Map<string, Semaphore.Semaphore>()
function goalLock(sessionID: string): Semaphore.Semaphore {
  let lock = goalLocks.get(sessionID)
  if (!lock) {
    lock = Semaphore.makeUnsafe(1)
    goalLocks.set(sessionID, lock)
  }
  return lock
}

export const layer: Layer.Layer<Service, never, Bus.Service | Storage.Service | SyncEvent.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const storage = yield* Storage.Service
    const sync = yield* SyncEvent.Service

    const createNext = Effect.fn("Session.createNext")(function* (input: {
      id?: SessionID
      title?: string
      agent?: string
      model?: Schema.Schema.Type<typeof Model>
      parentID?: SessionID
      workspaceID?: WorkspaceID
      directory: string
      path?: string
      permission?: Permission.Ruleset
      forkedFrom?: { sessionID: SessionID; messageID?: MessageID }
    }) {
      const ctx = yield* InstanceState.context
      const id = SessionID.descending(input.id)
      if (input.id) {
        const existing = yield* db((d) => d.select().from(SessionTable).where(eq(SessionTable.id, id)).get())
        if (existing) {
          const info = fromRow(existing)
          if (info.projectID !== ctx.project.id) {
            return yield* Effect.fail(new NotFoundError({ message: `Session not found: ${id}` }))
          }
          return info
        }
      }
      const result: Info = {
        id,
        slug: Slug.create(),
        version: InstallationVersion,
        projectID: ctx.project.id,
        directory: input.directory,
        path: input.path,
        workspaceID: input.workspaceID,
        parentID: input.parentID,
        title: input.title ?? createDefaultTitle(!!input.parentID),
        agent: input.agent,
        model: input.model,
        permission: input.permission,
        forkedFrom: input.forkedFrom,
        time: {
          created: Date.now(),
          updated: Date.now(),
        },
      }
      log.info("created", result)

      yield* sync.run(Event.Created, { sessionID: result.id, info: result })

      if (!Flag.WANLAICODE_EXPERIMENTAL_WORKSPACES) {
        // This only exist for backwards compatibility. We should not be
        // manually publishing this event; it is a sync event now
        yield* bus.publish(Event.Updated, {
          sessionID: result.id,
          info: result,
        })
      }

      return result
    })

    const get = Effect.fn("Session.get")(function* (id: SessionID) {
      const row = yield* db((d) => d.select().from(SessionTable).where(eq(SessionTable.id, id)).get())
      if (!row) return yield* Effect.fail(new NotFoundError({ message: `Session not found: ${id}` }))
      return fromRow(row)
    })

    const list = Effect.fn("Session.list")(function* (input?: ListInput) {
      const ctx = yield* InstanceState.context
      return Array.from(listByProject({ projectID: ctx.project.id, ...input }))
    })

    const children = Effect.fn("Session.children")(function* (parentID: SessionID) {
      const rows = yield* db((d) =>
        d
          .select()
          .from(SessionTable)
          .where(and(eq(SessionTable.parent_id, parentID)))
          .all(),
      )
      return rows.map(fromRow)
    })

    const remove: Interface["remove"] = Effect.fnUntraced(function* (sessionID: SessionID) {
      const session = yield* get(sessionID)
      try {
        const kids = yield* children(sessionID)
        for (const child of kids) {
          yield* remove(child.id)
        }

        // `remove` needs to work in all cases, such as a broken
        // sessions that run cleanup. In certain cases these will
        // run without any instance state, so we need to turn off
        // publishing of events in that case
        const hasInstance = yield* InstanceState.directory.pipe(
          Effect.as(true),
          Effect.catchCause(() => Effect.succeed(false)),
        )

        yield* sync.run(Event.Deleted, { sessionID, info: session }, { publish: hasInstance })
        yield* sync.remove(sessionID)
      } catch (e) {
        log.error(e)
      }
    })

    const updateMessage = <T extends MessageV2.Info>(msg: T): Effect.Effect<T> =>
      Effect.gen(function* () {
        if (msg.role === "assistant") {
          const parent = yield* db((d) =>
            d
              .select({ timeCreated: MessageTable.time_created })
              .from(MessageTable)
              .where(and(eq(MessageTable.id, msg.parentID), eq(MessageTable.session_id, msg.sessionID)))
              .get(),
          )
          if (parent && msg.time.created <= parent.timeCreated) {
            // assistant 必须严格晚于其 parent；把同毫秒写入提升 1ms，确保数据库游标、远控分页和前端
            // 都能继续使用统一的 (time_created, id) 顺序，而不需要引入不可分页的父子关系比较器。
            msg.time.created = parent.timeCreated + 1
          }
        }
        yield* sync.run(MessageV2.Event.Updated, { sessionID: msg.sessionID, info: msg })
        return msg
      }).pipe(Effect.withSpan("Session.updateMessage"))

    const updatePart = <T extends MessageV2.Part>(part: T): Effect.Effect<T> =>
      Effect.gen(function* () {
        yield* sync.run(MessageV2.Event.PartUpdated, {
          sessionID: part.sessionID,
          part: structuredClone(part),
          time: Date.now(),
        })
        return part
      }).pipe(Effect.withSpan("Session.updatePart"))

    const getPart: Interface["getPart"] = Effect.fn("Session.getPart")(function* (input) {
      const row = Database.use((db) =>
        db
          .select()
          .from(PartTable)
          .where(
            and(
              eq(PartTable.session_id, input.sessionID),
              eq(PartTable.message_id, input.messageID),
              eq(PartTable.id, input.partID),
            ),
          )
          .get(),
      )
      if (!row) return
      return {
        ...row.data,
        id: row.id,
        sessionID: row.session_id,
        messageID: row.message_id,
      } as MessageV2.Part
    })

    const create = Effect.fn("Session.create")(function* (input?: {
      id?: SessionID
      parentID?: SessionID
      title?: string
      agent?: string
      model?: Schema.Schema.Type<typeof Model>
      permission?: Permission.Ruleset
      workspaceID?: WorkspaceID
    }) {
      const ctx = yield* InstanceState.context
      const workspace = yield* InstanceState.workspaceID
      return yield* createNext({
        id: input?.id,
        parentID: input?.parentID,
        directory: ctx.directory,
        path: sessionPath(ctx.worktree, ctx.directory),
        title: input?.title,
        agent: input?.agent,
        model: input?.model,
        permission: input?.permission,
        workspaceID: input?.workspaceID ?? workspace,
      })
    })

    const fork = Effect.fn("Session.fork")(function* (input: {
      sessionID: SessionID
      messageID?: MessageID
      // 派生到指定 worktree 目录；不传则沿用源会话当前 ctx.directory
      directory?: string
    }) {
      const ctx = yield* InstanceState.context
      const original = yield* get(input.sessionID)
      // 取同 project 下所有 session 标题，保证 fork 编号严格递增（多次 fork 同源不会出现重复 (fork #1)）
      const projectTitles = yield* db((d) =>
        d
          .select({ title: SessionTable.title })
          .from(SessionTable)
          .where(eq(SessionTable.project_id, ctx.project.id))
          .all(),
      )
      const title = getForkedTitle(
        original.title,
        projectTitles.map((row) => row.title),
      )
      const targetDirectory = input.directory ?? ctx.directory
      const session = yield* createNext({
        directory: targetDirectory,
        path: sessionPath(ctx.worktree, targetDirectory),
        workspaceID: original.workspaceID,
        title,
        forkedFrom: { sessionID: input.sessionID, messageID: input.messageID },
      })
      const msgs = yield* messages({ sessionID: input.sessionID })

      // 截断范围按数组 index 算，不依赖 message id 的字典序：messages() 返回值天然按时间顺序排，
      // 用 findIndex 找到第一条要排除的消息位置即可；未找到 → 克隆全部。避免以后 id 生成规则变化 / 历史
      // 异构数据破坏 `id >= input.messageID` 这种字符串大小判定。
      const stopIndex = input.messageID ? msgs.findIndex((m) => m.info.id === input.messageID) : -1
      const effectiveStop = stopIndex < 0 ? msgs.length : stopIndex
      const selected = msgs.slice(0, effectiveStop)
      const selectedIDs = new Set(selected.map((msg) => msg.info.id))
      const sourceIDs = new Set(msgs.map((msg) => msg.info.id))
      const assistantParents = new Map(
        selected.flatMap((msg) => {
          if (msg.info.role === "user") return []
          const assistant = msg.info
          if (selectedIDs.has(assistant.parentID)) return [[assistant.id, assistant.parentID] as const]
          // 截断范围外仍存在真实 parent 时不能越界复制回复。只有旧派生遗留了跨会话 parent，且结构化
          // 回合链接能在当前源会话中唯一落到用户消息时，才修复该引用，避免再次派生时丢掉整条回答。
          if (sourceIDs.has(assistant.parentID)) return []
          const linkedUser = selected.findLast(
            (candidate) =>
              candidate.info.role === "user" &&
              (candidate.info.id === assistant.instructionThrough ||
                assistant.completedUserMessageIDs?.includes(candidate.info.id) ||
                (assistant.turnID && MessageV2.userTurnID(candidate.info) === assistant.turnID)),
          )
          if (!linkedUser || linkedUser.info.role !== "user") return []
          return [[assistant.id, linkedUser.info.id] as const]
        }),
      )
      // assistant 的 parentID 是必填外键；无法在复制范围内解析父消息时跳过整个孤儿回复。
      const cloneable = selected.filter((msg) => msg.info.role === "user" || assistantParents.has(msg.info.id))
      // 先为完整复制范围预分配 ID，再开始落库；这样导入历史中的同毫秒乱序或前向引用也能正确重写。
      const idMap = new Map(cloneable.map((msg) => [msg.info.id, MessageID.ascending()] as const))
      const partIDMap = new Map<string, PartID>(
        cloneable.flatMap((msg) => msg.parts.map((part) => [part.id, PartID.ascending()] as const)),
      )

      for (const msg of cloneable) {
        const newID = idMap.get(msg.info.id)!

        const parentID = msg.info.role === "assistant" ? idMap.get(assistantParents.get(msg.info.id)!) : undefined
        // fork 会重写消息 ID，因此远控 high-water、引导回合和完成集合里的所有消息引用都要同步映射；
        // 无法映射的旧式不透明回合 ID 保持原值，避免历史迁移后丢失归组信息。
        const turnLinks =
          msg.info.role === "user"
            ? {
                turnID: msg.info.turnID ? (idMap.get(msg.info.turnID) ?? msg.info.turnID) : undefined,
                steerTargetTurnID: msg.info.steerTargetTurnID
                  ? (idMap.get(msg.info.steerTargetTurnID) ?? msg.info.steerTargetTurnID)
                  : undefined,
                continuationTurnID: msg.info.continuationTurnID
                  ? (idMap.get(msg.info.continuationTurnID) ?? msg.info.continuationTurnID)
                  : undefined,
              }
            : {
                turnID: msg.info.turnID ? (idMap.get(msg.info.turnID) ?? msg.info.turnID) : undefined,
                completedUserMessageIDs: msg.info.completedUserMessageIDs?.map((id) => idMap.get(id) ?? id),
                instructionThrough: msg.info.instructionThrough
                  ? (idMap.get(msg.info.instructionThrough) ?? msg.info.instructionThrough)
                  : undefined,
              }
        const cloned = yield* updateMessage({
          ...msg.info,
          ...turnLinks,
          sessionID: session.id,
          id: newID,
          ...(parentID && { parentID }),
        })

        for (const part of msg.parts) {
          const newPartID = partIDMap.get(part.id)!
          const p: MessageV2.Part = {
            ...part,
            id: newPartID,
            messageID: cloned.id,
            sessionID: session.id,
          }
          // 兼容仅靠旧 text marker 记录引导目标的历史；fork 后 marker 必须指向子会话的新消息 ID。
          if (p.type === "text" && typeof p.metadata?.manual_steer_target_turn_id === "string") {
            const legacyTarget = p.metadata.manual_steer_target_turn_id
            // 旧 metadata 可能含任意字符串；只有通过 MessageID 校验后才能进入品牌化映射表，无效值原样保留。
            const mappedLegacyTarget = MessageID.zod.safeParse(legacyTarget).success
              ? idMap.get(MessageID.make(legacyTarget))
              : undefined
            p.metadata = {
              ...p.metadata,
              manual_steer_target_turn_id: mappedLegacyTarget ?? legacyTarget,
            }
          }
          if (p.type === "compaction" && p.tail_start_id) {
            p.tail_start_id = idMap.get(p.tail_start_id)
          }
          if (
            p.type === "tool" &&
            "metadata" in p.state &&
            typeof p.state.metadata?.internalSubtaskPartID === "string"
          ) {
            const mapped = partIDMap.get(p.state.metadata.internalSubtaskPartID)
            const { internalSubtaskPartID: _sourcePartID, ...metadata } = p.state.metadata
            // 内部 task 完成标记引用 SubtaskPart；找不到映射时清掉悬空引用，让旧版签名兼容接管恢复。
            p.state = {
              ...p.state,
              metadata: mapped ? { ...metadata, internalSubtaskPartID: mapped } : metadata,
            }
          }
          yield* updatePart(p)
        }
      }
      return session
    })

    const patch = (sessionID: SessionID, info: Patch) => sync.run(Event.Updated, { sessionID, info })

    const touch = Effect.fn("Session.touch")(function* (sessionID: SessionID) {
      yield* patch(sessionID, { time: { updated: Date.now() } })
    })

    const setTitle = Effect.fn("Session.setTitle")(function* (input: { sessionID: SessionID; title: string }) {
      yield* patch(input.sessionID, { title: input.title })
    })

    const setArchived = Effect.fn("Session.setArchived")(function* (input: { sessionID: SessionID; time?: number }) {
      const current = yield* get(input.sessionID)
      if (input.time !== undefined) {
        yield* patch(input.sessionID, { time: { archived: input.time, updated: current.time.updated } })
        return
      }
      yield* patch(input.sessionID, { time: { archived: null, updated: Date.now() } })
    })

    const setPermission = Effect.fn("Session.setPermission")(function* (input: {
      sessionID: SessionID
      permission: Permission.Ruleset
    }) {
      yield* patch(input.sessionID, { permission: input.permission, time: { updated: Date.now() } })
    })

    const setModel = Effect.fn("Session.setModel")(function* (input: {
      sessionID: SessionID
      model: Schema.Schema.Type<typeof Model>
    }) {
      // 远控模型选择与桌面会话共用持久化字段，重连后不能退回手机侧的临时缓存。
      yield* patch(input.sessionID, { model: input.model, time: { updated: Date.now() } })
    })

    const setRevert = Effect.fn("Session.setRevert")(function* (input: {
      sessionID: SessionID
      revert: Info["revert"]
      summary: Info["summary"]
    }) {
      yield* patch(input.sessionID, { summary: input.summary, time: { updated: Date.now() }, revert: input.revert })
    })

    const clearRevert = Effect.fn("Session.clearRevert")(function* (sessionID: SessionID) {
      yield* patch(sessionID, { time: { updated: Date.now() }, revert: null })
    })

    const setSummary = Effect.fn("Session.setSummary")(function* (input: {
      sessionID: SessionID
      summary: Info["summary"]
    }) {
      yield* patch(input.sessionID, { time: { updated: Date.now() }, summary: input.summary })
    })

    const readGoalRow = (sessionID: SessionID) =>
      Effect.sync(() =>
        Database.use((d) =>
          d.select({ goal: SessionTable.goal }).from(SessionTable).where(eq(SessionTable.id, sessionID)).get(),
        ),
      )

    const writeGoal = (sessionID: SessionID, goal: Goal | null) =>
      Effect.sync(() =>
        Database.use((d) => d.update(SessionTable).set({ goal }).where(eq(SessionTable.id, sessionID)).run()),
      )

    const getGoal = Effect.fn("Session.getGoal")(function* (sessionID: SessionID) {
      const row = yield* readGoalRow(sessionID)
      return (row?.goal as Goal | null) ?? null
    })

    const setGoal = Effect.fn("Session.setGoal")(function* (input: { sessionID: SessionID; objective: string }) {
      const objective = yield* Effect.try({
        try: () => validateObjective(input.objective),
        catch: (e) => (e instanceof GoalValidationError ? e : new GoalValidationError(String(e))),
      })
      return yield* goalLock(input.sessionID).withPermits(1)(
        Effect.gen(function* () {
          const existing = yield* getGoal(input.sessionID)
          const now = Date.now()
          const goal: Goal = {
            sessionID: input.sessionID,
            objective,
            status: "active",
            tokenBudget: null,
            tokensUsed: 0,
            timeUsedSeconds: 0,
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
          }
          yield* writeGoal(input.sessionID, goal)
          yield* bus.publish(SessionStatus.Event.GoalUpdated, {
            sessionID: input.sessionID,
            goal,
            // setGoal 即「用户设定目标」动作：恒 true——重设相同文本也要注入可见 objective 消息并发起一轮
            objectiveChanged: true,
          })
          return goal
        }),
      )
    })

    const setGoalStatus = Effect.fn("Session.setGoalStatus")(function* (input: {
      sessionID: SessionID
      status: GoalStatus
    }) {
      return yield* goalLock(input.sessionID).withPermits(1)(
        Effect.gen(function* () {
          const existing = yield* getGoal(input.sessionID)
          if (!existing)
            return yield* Effect.fail(new NotFoundError({ message: `No goal for session: ${input.sessionID}` }))
          const goal: Goal = { ...existing, status: input.status, updatedAt: Date.now() }
          yield* writeGoal(input.sessionID, goal)
          yield* bus.publish(SessionStatus.Event.GoalUpdated, { sessionID: input.sessionID, goal })
          return goal
        }),
      )
    })

    const clearGoal = Effect.fn("Session.clearGoal")(function* (sessionID: SessionID) {
      return yield* goalLock(sessionID)
        .withPermits(1)(
          Effect.gen(function* () {
            const existing = yield* getGoal(sessionID)
            if (!existing) return false
            yield* writeGoal(sessionID, null)
            yield* bus.publish(SessionStatus.Event.GoalCleared, { sessionID })
            return true
          }),
        )
        .pipe(Effect.ensuring(Effect.sync(() => goalLocks.delete(sessionID)))) // 目标清除后回收锁，避免 goalLocks 无界增长
    })

    const addGoalUsage = Effect.fn("Session.addGoalUsage")(function* (input: {
      sessionID: SessionID
      tokens: number
      seconds: number
    }) {
      // 每个 finish-step 对所有 session 都会调到这里：先无锁读一次判存在，绝大多数 session 没有目标，
      // 直接返回、避免为「没目标」白白获取信号量（getGoal 是廉价的同步单行读）
      if (!(yield* getGoal(input.sessionID))) return
      yield* goalLock(input.sessionID).withPermits(1)(
        Effect.gen(function* () {
          const existing = yield* getGoal(input.sessionID)
          if (!existing) return
          const goal: Goal = {
            ...existing,
            tokensUsed: existing.tokensUsed + Math.max(0, Math.trunc(input.tokens)),
            timeUsedSeconds: existing.timeUsedSeconds + Math.max(0, Math.trunc(input.seconds)),
            updatedAt: Date.now(),
          }
          // 仅持久化用量计数，不发 GoalUpdated：该事件会被 goal-runtime 当成 resume 触发器，
          // 导致每个目标轮的每一步都尝试一次续跑 + GlobalBus 流量 + 失败日志。计数会在下次
          // 真正状态变更（complete/pause 等）或进会话 hydration 时带给前端。
          yield* writeGoal(input.sessionID, goal)
        }),
      )
    })

    const diff = Effect.fn("Session.diff")(function* (sessionID: SessionID) {
      return yield* storage
        .read<Snapshot.FileDiff[]>(["session_diff", sessionID])
        .pipe(Effect.orElseSucceed((): Snapshot.FileDiff[] => []))
    })

    const cleanupOrphanToolParts = Effect.fn("Session.cleanupOrphanToolParts")(function* (sessionID: SessionID) {
      const now = Date.now()
      for (const msg of MessageV2.stream(sessionID)) {
        if (msg.info.role !== "assistant") continue
        for (const part of msg.parts) {
          if (part.type !== "tool") continue
          if (part.state.status !== "running" && part.state.status !== "pending") continue
          const state = {
            status: "error" as const,
            error: "Tool execution was interrupted by process restart",
            input: part.state.input,
            metadata: "metadata" in part.state ? part.state.metadata : undefined,
            title: "title" in part.state ? part.state.title : undefined,
            attachments: "attachments" in part.state ? part.state.attachments : undefined,
            time: {
              ...("time" in part.state ? part.state.time : { start: msg.info.time.created }),
              end: now,
            },
          } satisfies MessageV2.ToolStateError

          yield* updatePart({ ...part, state })
        }
      }
    })

    const orphanCleanedSessions = new Set<string>()

    const repairOrphanToolParts = Effect.fn("Session.repairOrphanToolParts")(function* (sessionID: SessionID) {
      if (orphanCleanedSessions.has(sessionID)) return
      yield* cleanupOrphanToolParts(sessionID).pipe(
        Effect.tapError((err) =>
          Effect.sync(() => log.error("cleanupOrphanToolParts failed", { error: err, sessionID })),
        ),
        Effect.matchEffect({
          onFailure: () => Effect.void,
          onSuccess: () =>
            Effect.sync(() => {
              orphanCleanedSessions.add(sessionID)
            }),
        }),
      )
    })

    const messages = Effect.fn("Session.messages")(function* (input: { sessionID: SessionID; limit?: number }) {
      yield* repairOrphanToolParts(input.sessionID)
      if (input.limit) {
        return MessageV2.sanitizeMessages(MessageV2.page({ sessionID: input.sessionID, limit: input.limit }).items)
      }
      return MessageV2.sanitizeMessages(Array.from(MessageV2.stream(input.sessionID)).reverse())
    })

    // 两个查询都只读取消息序号或单条新 assistant，避免 joinLoop 的基线与收尾触发全会话 hydrate。
    const messageHighWater = Effect.fn("Session.messageHighWater")((sessionID: SessionID) =>
      Effect.sync(() => MessageV2.messageHighWater(sessionID)),
    )
    const latestAssistant = Effect.fn("Session.latestAssistant")((input: {
      sessionID: SessionID
      afterSequence?: number
    }) => Effect.sync(() => Option.fromNullishOr(MessageV2.latestAssistant(input))))

    const removeMessage = Effect.fn("Session.removeMessage")(function* (input: {
      sessionID: SessionID
      messageID: MessageID
    }) {
      yield* sync.run(MessageV2.Event.Removed, {
        sessionID: input.sessionID,
        messageID: input.messageID,
      })
      return input.messageID
    })

    const removePart = Effect.fn("Session.removePart")(function* (input: {
      sessionID: SessionID
      messageID: MessageID
      partID: PartID
    }) {
      yield* sync.run(MessageV2.Event.PartRemoved, {
        sessionID: input.sessionID,
        messageID: input.messageID,
        partID: input.partID,
      })
      return input.partID
    })

    const updatePartDelta = Effect.fnUntraced(function* (input: {
      sessionID: SessionID
      messageID: MessageID
      partID: PartID
      field: string
      delta: string
    }) {
      yield* bus.publish(MessageV2.Event.PartDelta, input)
    })

    /** Finds the first message matching the predicate, searching newest-first. */
    const findMessage = Effect.fn("Session.findMessage")(function* (
      sessionID: SessionID,
      predicate: (msg: MessageV2.WithParts) => boolean,
    ) {
      for (const item of MessageV2.stream(sessionID)) {
        if (predicate(item)) return Option.some(item)
      }
      return Option.none<MessageV2.WithParts>()
    })

    return Service.of({
      list,
      create,
      fork,
      touch,
      get,
      setTitle,
      setArchived,
      setPermission,
      setModel,
      setRevert,
      clearRevert,
      setSummary,
      diff,
      messages,
      messageHighWater,
      latestAssistant,
      repairOrphanToolParts,
      children,
      remove,
      updateMessage,
      removeMessage,
      removePart,
      updatePart,
      getPart,
      updatePartDelta,
      findMessage,
      setGoal,
      setGoalStatus,
      getGoal,
      clearGoal,
      addGoalUsage,
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Bus.layer),
  Layer.provide(Storage.defaultLayer),
  Layer.provide(SyncEvent.defaultLayer),
)

function titleContains(search: string) {
  return sql`instr(lower(${SessionTable.title}), lower(${search})) > 0`
}

function globalSearchContains(search: string) {
  const projectMatch = sql`${SessionTable.project_id} IN (
    SELECT ${ProjectTable.id} FROM ${ProjectTable}
    WHERE instr(lower(coalesce(${ProjectTable.name}, '')), lower(${search})) > 0
       OR instr(lower(${ProjectTable.worktree}), lower(${search})) > 0
  )`
  const directoryMatch = sql`instr(lower(${SessionTable.directory}), lower(${search})) > 0`
  return or(titleContains(search), projectMatch, directoryMatch)!
}

function* listByProject(
  input: ListInput & {
    projectID: ProjectID
  },
) {
  const conditions = [eq(SessionTable.project_id, input.projectID)]

  if (input.workspaceID) {
    conditions.push(eq(SessionTable.workspace_id, input.workspaceID))
  }
  if (input.path !== undefined) {
    if (input.path) {
      const conds = [eq(SessionTable.path, input.path), like(SessionTable.path, `${input.path}/%`)]

      conditions.push(
        input.directory
          ? or(...conds, and(isNull(SessionTable.path), eq(SessionTable.directory, input.directory))!)!
          : or(...conds)!,
      )
    }
  } else if (input.scope !== "project" && !Flag.WANLAICODE_EXPERIMENTAL_WORKSPACES) {
    if (input.directory) {
      conditions.push(eq(SessionTable.directory, input.directory))
    }
  }
  if (input.roots) {
    conditions.push(isNull(SessionTable.parent_id))
  }
  if (input.start) {
    conditions.push(gte(SessionTable.time_updated, input.start))
  }
  if (input.search) {
    conditions.push(titleContains(input.search))
  }

  const limit = input.limit ?? 100

  const rows = Database.use((db) =>
    db
      .select()
      .from(SessionTable)
      .where(and(...conditions))
      .orderBy(desc(SessionTable.time_updated))
      .limit(limit)
      .all(),
  )
  for (const row of rows) {
    yield fromRow(row)
  }
}

export function formatGlobalListCursor(input: { archived?: boolean; time: number; id: string }) {
  if (input.archived) return `${input.time}:${input.id}`
  return String(input.time)
}

function archivedCursorCondition(cursor: number | string): SQL | undefined {
  if (typeof cursor === "number") return lt(SessionTable.time_archived, cursor)
  const sep = cursor.indexOf(":")
  if (sep < 0) {
    const time = Number(cursor)
    return Number.isFinite(time) ? lt(SessionTable.time_archived, time) : undefined
  }
  const time = Number(cursor.slice(0, sep))
  const id = cursor.slice(sep + 1)
  if (!Number.isFinite(time) || !id) return undefined
  return or(
    lt(SessionTable.time_archived, time),
    and(eq(SessionTable.time_archived, time), lt(SessionTable.id, SessionID.make(id))),
  )
}

export function* listGlobal(input?: {
  directory?: string
  roots?: boolean
  start?: number
  cursor?: number | string
  search?: string
  limit?: number
  archived?: boolean
  unlimited?: boolean
}) {
  const conditions: SQL[] = []

  if (input?.directory) {
    conditions.push(eq(SessionTable.directory, input.directory))
  }
  if (input?.roots) {
    conditions.push(isNull(SessionTable.parent_id))
  }
  if (input?.start) {
    conditions.push(gte(SessionTable.time_updated, input.start))
  }
  if (input?.cursor !== undefined) {
    if (input?.archived) {
      const condition = archivedCursorCondition(input.cursor)
      if (condition) conditions.push(condition)
    } else {
      const time = typeof input.cursor === "number" ? input.cursor : Number(input.cursor)
      if (Number.isFinite(time)) conditions.push(lt(SessionTable.time_updated, time))
    }
  }
  if (input?.search) {
    conditions.push(globalSearchContains(input.search))
  }
  if (input?.archived) {
    conditions.push(isNotNull(SessionTable.time_archived))
  } else {
    conditions.push(isNull(SessionTable.time_archived))
  }

  const limit = input?.limit ?? 100

  const rows = Database.use((db) => {
    const query =
      conditions.length > 0
        ? db
            .select()
            .from(SessionTable)
            .where(and(...conditions))
        : db.select().from(SessionTable)
    const order = input?.archived
      ? [desc(SessionTable.time_archived), desc(SessionTable.id)]
      : [desc(SessionTable.time_updated), desc(SessionTable.id)]
    const ordered = query.orderBy(...order)
    // 远控权威快照需要完整读取数据库；普通列表仍必须经过默认或显式分页限制。
    return input?.unlimited ? ordered.all() : ordered.limit(limit).all()
  })

  const ids = [...new Set(rows.map((row) => row.project_id))]
  const projects = new Map<string, ProjectInfo>()

  if (ids.length > 0) {
    const items = Database.use((db) =>
      db
        .select({ id: ProjectTable.id, name: ProjectTable.name, worktree: ProjectTable.worktree })
        .from(ProjectTable)
        .where(inArray(ProjectTable.id, ids))
        .all(),
    )
    for (const item of items) {
      projects.set(item.id, {
        id: item.id,
        name: item.name ?? undefined,
        worktree: item.worktree,
      })
    }
  }

  for (const row of rows) {
    const project = projects.get(row.project_id) ?? null
    yield { ...fromRow(row), project }
  }
}

export * as Session from "./session"
