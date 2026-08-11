import { Effect, Option } from "effect"
import crypto from "node:crypto"
import { eq } from "drizzle-orm"
import { GlobalBus } from "@/bus/global"
import { AppRuntime } from "@/effect/app-runtime"
import { InstanceStore } from "@/project/instance-store"
import { Session } from "@/session/session"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { MessageTable, PartTable, SessionTable } from "@/session/session.sql"
import { MessageV2 } from "@/session/message-v2"
import { SessionPrompt } from "@/session/prompt"
import { SessionStatus } from "@/session/status"
import { Permission } from "@/permission"
import { PermissionID } from "@/permission/schema"
import { Question } from "@/question"
import { QuestionID } from "@/question/schema"
import { Provider } from "@/provider/provider"
import { ModelID, ProviderID } from "@/provider/schema"
import { Database } from "@/storage/db"
import { SyncEvent } from "@/sync"
import { Event as ServerEvent } from "@/server/event"
import {
  ProtocolError,
  isRemoteAttachmentContextText,
  isRemoteDerivedAttachment,
  mapSession,
  remoteAttachmentContextTexts,
  remoteAttachmentMessageParts,
  remoteStoredAttachmentData,
  remoteStoredAttachmentFilename,
  type RemoteModelInfo,
  type RemoteOperations,
  type RemotePermissionMode,
  type RemoteSessionModel,
  type RemoteSessionStatus,
} from "./protocol"
import {
  blankProjectErrorCode,
  blankProjectPathExists,
  createBlankProject,
  prepareBlankProjectDefaults,
  resolveBlankProjectTarget,
} from "./blank-project"

// 新会话在没有现成记录可承载映射时使用稳定主键，确保 start ACK 丢失后不会重复创建。
export function remoteSessionID(requestID: string) {
  const digest = crypto.createHash("sha256").update(`session|${requestID}`).digest("hex")
  return `ses_remote_${digest}`
}

// 用户消息必须保留原生时间有序 ID；请求摘要单独落在消息 JSON，避免破坏会话引擎的先后比较。
export function remoteRequestKey(requestID: string) {
  return crypto.createHash("sha256").update(`message|${requestID}`).digest("hex")
}

function globalSessions() {
  // 手机首次连接必须看到桌面主列表中的全部活动会话，同时保留桌面现有的归档隐藏语义。
  return Array.from(Session.listGlobal({ unlimited: true }))
}

function remoteIdempotencySession(sessionID: string) {
  const active = globalSessions().find((item) => item.id === sessionID)
  if (active) return active
  // request_id 映射是全库唯一主键；归档只影响列表可见性，不能让同一个请求重新占用该 ID。
  return Array.from(Session.listGlobal({ archived: true, unlimited: true })).find((item) => item.id === sessionID)
}

function sessionInfo(sessionID: string) {
  const session = globalSessions().find((item) => item.id === sessionID)
  if (!session) throw new ProtocolError("SESSION_NOT_FOUND", `Session ${sessionID} not found`)
  return session
}

const remoteHistoryResultMaxBytes = 32 * 1024 * 1024
const wanlaiCodeProviderID = ProviderID.make("wanlaicode")

// 文件系统错误在 operations 边界转换为稳定协议码，协议层只负责组装手机响应。
function blankProjectOperation<T>(action: () => T | Promise<T>) {
  return Promise.resolve()
    .then(action)
    .catch((error) => {
      throw new ProtocolError(blankProjectErrorCode(error), error instanceof Error ? error.message : String(error))
    })
}

// 远控权限模式写入 Session.permission 的专用规则，既能跨桌面重启恢复，又不会碰撞真实工具权限。
export const remotePermissionSentinel = "__wanlai_remote_auto_review"

type RemotePermissionSession = Pick<Session.Info, "id" | "parentID" | "permission">

function remotePermissionLineage(sessions: readonly Session.GlobalInfo[]) {
  return new Map<string, RemotePermissionSession>(sessions.map((item) => [String(item.id), item]))
}

function remotePermissionMode(
  session: RemotePermissionSession,
  lineage: ReadonlyMap<string, RemotePermissionSession> = remotePermissionLineage(globalSessions()),
) {
  const visited = new Set<string>()
  let current: RemotePermissionSession | undefined = session
  while (current && !visited.has(String(current.id))) {
    visited.add(String(current.id))
    // 当前会话最后一条显式 allow/deny 优先；没有 sentinel 时再沿 parentID 继承父会话设置。
    const marker = current.permission?.findLast(
      (rule) =>
        rule.permission === remotePermissionSentinel &&
        rule.pattern === "*" &&
        (rule.action === "allow" || rule.action === "deny"),
    )
    if (marker) return marker.action === "allow" ? ("autoReview" as const) : ("default" as const)
    current = current.parentID ? lineage.get(String(current.parentID)) : undefined
  }
  return "default" as const
}

function remotePermissionRules(permission: Permission.Ruleset | undefined, mode: RemotePermissionMode) {
  // 先过滤旧 sentinel，避免重复切换后规则列表不断增长，也避免旧状态覆盖新状态。
  const rules = (permission ?? []).filter((rule) => rule.permission !== remotePermissionSentinel)
  return [
    ...rules,
    {
      permission: remotePermissionSentinel,
      pattern: "*",
      // sentinel 只允许 allow 表示 auto-review；deny 和缺失都代表默认人工审批。
      action: mode === "autoReview" ? ("allow" as const) : ("deny" as const),
    },
  ]
}

type RemoteCreateInput = Parameters<RemoteOperations["create"]>[0]

function validateRemoteCreateRetry(
  session: Pick<Session.Info, "id" | "parentID" | "directory" | "title" | "model" | "permission">,
  input: RemoteCreateInput,
) {
  if (session.directory !== input.directory || (input.title && session.title !== input.title)) {
    throw new ProtocolError("REQUEST_ID_CONFLICT", "request_id was already used with different session input")
  }
  if (input.model_id) {
    const requestedVariant = input.variant ?? undefined
    if (
      session.model?.providerID !== wanlaiCodeProviderID ||
      session.model.id !== input.model_id ||
      session.model.variant !== requestedVariant
    ) {
      throw new ProtocolError("REQUEST_ID_CONFLICT", "request_id was already used with different session input")
    }
  }
  if (input.permission_mode && remotePermissionMode(session) !== input.permission_mode) {
    throw new ProtocolError("REQUEST_ID_CONFLICT", "request_id was already used with different session input")
  }
}

// 多目录合并后仍按从低到高展示标准档位，未知自定义档位稳定排在末尾。
const remoteReasoningEffortOrder = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]

function sortRemoteReasoningEfforts(values: Iterable<string>) {
  return [...new Set(values)].sort((left, right) => {
    const leftRank = remoteReasoningEffortOrder.indexOf(left)
    const rightRank = remoteReasoningEffortOrder.indexOf(right)
    if (leftRank >= 0 && rightRank >= 0) return leftRank - rightRank
    if (leftRank >= 0) return -1
    if (rightRank >= 0) return 1
    return left.localeCompare(right)
  })
}

function remoteReasoningEfforts(model: Provider.Model) {
  // /v1/models 的 reasoning_options 是首选权威字段；旧字段和 variants 只在缺失时兼容。
  const option = model.reasoning_options?.find((item) => item.type === "effort" && item.values?.length)
  const values = option?.values ?? model.reasoning_efforts ?? Object.keys(model.variants ?? {})
  return sortRemoteReasoningEfforts(
    values.filter((value): value is string => typeof value === "string" && value.length > 0),
  )
}

function remoteModelInfo(model: Provider.Model): RemoteModelInfo {
  return {
    provider_id: model.providerID,
    model_id: model.id,
    reasoning_efforts: remoteReasoningEfforts(model),
    context_window: model.limit.context,
  }
}

async function directoryModelCatalog(directory: string) {
  return inDirectory(
    directory,
    Provider.Service.use((service) =>
      service.list().pipe(
        Effect.map((providers) => {
          const provider = providers[wanlaiCodeProviderID]
          return provider ? Provider.sort(Object.values(provider.models)).map(remoteModelInfo) : []
        }),
      ),
    ),
  ).catch(() => [])
}

async function modelCatalog(input?: { directory?: string }) {
  // 显式目录始终只读取该项目；无目录握手则取所有活动目录的安全交集，空会话才回退当前工作目录。
  const directories = input?.directory
    ? [input.directory]
    : [...new Set(globalSessions().map((session) => session.directory))].sort()
  const catalogs = await Promise.all(
    (directories.length > 0 ? directories : [process.cwd()]).map(directoryModelCatalog),
  )
  const shared = new Map(
    (catalogs[0] ?? []).map((model) => [
      `${model.provider_id}\u0000${model.model_id}`,
      { ...model, reasoning_efforts: [...model.reasoning_efforts] },
    ]),
  )
  for (const catalog of catalogs.slice(1)) {
    const current = new Map(catalog.map((model) => [`${model.provider_id}\u0000${model.model_id}`, model]))
    for (const [key, previous] of shared) {
      const model = current.get(key)
      if (!model) {
        shared.delete(key)
        continue
      }
      // 旧手机只能读取顶层目录，因此 variant 同样必须取交集；上下文窗口采用所有目录都安全的最小值。
      shared.set(key, {
        ...previous,
        reasoning_efforts: sortRemoteReasoningEfforts(
          previous.reasoning_efforts.filter((effort) => model.reasoning_efforts.includes(effort)),
        ),
        context_window: Math.min(previous.context_window, model.context_window),
      })
    }
  }
  return [...shared.values()].sort((left, right) =>
    `${left.provider_id}/${left.model_id}`.localeCompare(`${right.provider_id}/${right.model_id}`),
  )
}

async function selectedWanlaiModel(directory: string, modelID: string, variant?: string | null) {
  const target = (await directoryModelCatalog(directory)).find(
    (model) => model.provider_id === wanlaiCodeProviderID && model.model_id === modelID,
  )
  if (!target) throw new ProtocolError("set_codex_model_rejected", `Unknown WanlaiCode model: ${modelID}`)
  // 空档位不等于省略或显式清空，状态层也拒绝非法内部调用，避免静默抹掉现有 variant。
  if (variant === "") {
    throw new ProtocolError("set_codex_model_rejected", "Reasoning effort must be a non-empty string or null")
  }
  const selectedVariant = variant === null ? undefined : variant
  if (selectedVariant && !target.reasoning_efforts.includes(selectedVariant)) {
    throw new ProtocolError(
      "set_codex_model_rejected",
      `Model ${modelID} does not support reasoning effort ${selectedVariant}`,
    )
  }
  return {
    provider_id: target.provider_id,
    model_id: target.model_id,
    ...(selectedVariant ? { variant: selectedVariant } : {}),
    context_window: target.context_window,
  } satisfies RemoteSessionModel
}

async function resolvedSessionModel(
  session: Pick<Session.Info, "id" | "directory" | "model">,
): Promise<RemoteSessionModel | undefined> {
  return inDirectory(
    session.directory,
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const provider = yield* Provider.Service
      const recent = session.model
        ? Option.none<MessageV2.WithParts>()
        : yield* sessions.findMessage(
            SessionID.make(session.id),
            (message) => message.info.role === "user" && !!message.info.model,
          )
      const selected = session.model
        ? { providerID: session.model.providerID, modelID: session.model.id, variant: session.model.variant }
        : Option.isSome(recent) && recent.value.info.role === "user"
          ? recent.value.info.model
          : { ...(yield* provider.defaultModel()), variant: undefined }
      const model = yield* provider
        .getModel(selected.providerID, selected.modelID)
        // 当前模型可能已从目录下架；只放弃 context_window 元数据，数据库中的权威选择仍必须回显并可恢复。
        .pipe(Effect.catchCause(() => Effect.succeed(undefined)))
      return {
        provider_id: selected.providerID,
        model_id: selected.modelID,
        ...(selected.variant ? { variant: selected.variant } : {}),
        ...(model?.limit.context ? { context_window: model.limit.context } : {}),
      }
    }),
  ).catch(() => undefined)
}

function sameRemoteModelSelection(left: RemoteSessionModel | undefined, right: RemoteSessionModel | undefined) {
  // context_window 只是目录元数据；会话选择是否变化只由 provider、model 与 variant 三元组决定。
  return (
    left?.provider_id === right?.provider_id && left?.model_id === right?.model_id && left?.variant === right?.variant
  )
}

function storedRemoteSessionModel(session: Pick<Session.Info, "model">) {
  if (!session.model) return undefined
  // 事务内比较只需要持久化三元组；context_window 属于目录元数据，不参与并发变更判断。
  return {
    provider_id: session.model.providerID,
    model_id: session.model.id,
    ...(session.model.variant ? { variant: session.model.variant } : {}),
  } satisfies RemoteSessionModel
}

function remoteResumeModelPatch(input: {
  selected?: RemoteSessionModel
  current?: RemoteSessionModel
  catalogValidated?: boolean
}) {
  // 未经目录校验的同值模型只能作为条件 no-op；桌面已并发切换时必须保留事务内 current，不能恢复旧事实。
  if (!input.selected || !input.catalogValidated) return undefined
  return sameRemoteModelSelection(input.selected, input.current) ? undefined : input.selected
}

async function selectedSessionModel(
  session: Pick<Session.Info, "id" | "directory" | "model">,
  modelID: string,
  variant?: string | null,
) {
  // 内部调用也必须遵守协议约束，不能让空字符串借同值 no-op 绕过目录层校验。
  if (variant === "") {
    throw new ProtocolError("set_codex_model_rejected", "Reasoning effort must be a non-empty string or null")
  }
  const previous = await resolvedSessionModel(session)
  const requestedVariant = variant === undefined ? previous?.variant : (variant ?? undefined)
  const requested = {
    provider_id: wanlaiCodeProviderID,
    model_id: modelID,
    ...(requestedVariant ? { variant: requestedVariant } : {}),
  }
  if (previous && sameRemoteModelSelection(previous, requested)) {
    // direct resume 会重发桌面权威事实；同一三元组必须在目录校验前短路，允许继续打开已下架模型的旧会话。
    return { model: previous, previous, catalogValidated: false }
  }
  if (variant === undefined && previous?.variant) {
    // 档位缺省时沿用当前值；目标模型不兼容才回到该模型默认值，显式 null 则由下方分支负责清空。
    const model = await selectedWanlaiModel(session.directory, modelID, previous.variant).catch((error) => {
      if (error instanceof ProtocolError && error.code === "set_codex_model_rejected") {
        return selectedWanlaiModel(session.directory, modelID)
      }
      throw error
    })
    return { model, previous, catalogValidated: true }
  }
  return {
    model: await selectedWanlaiModel(session.directory, modelID, variant),
    previous,
    catalogValidated: true,
  }
}

function updateRemoteSessionState(input: {
  session_id: string
  directory: string
  model_selection?: Awaited<ReturnType<typeof selectedSessionModel>>
  permission_mode?: RemotePermissionMode
  replace_permission?: boolean
}) {
  return inDirectory(
    input.directory,
    Effect.sync(() =>
      Database.transaction(
        (tx) => {
          const row = tx
            .select()
            .from(SessionTable)
            .where(eq(SessionTable.id, SessionID.make(input.session_id)))
            .get()
          if (!row) throw new ProtocolError("SESSION_NOT_FOUND", `Session ${input.session_id} not found`)
          const current = Session.fromRow(row)
          const model = remoteResumeModelPatch({
            selected: input.model_selection?.model,
            // immediate 事务内的行才是比较依据，目录校验期间发生的桌面写入不能被旧快照覆盖。
            current: storedRemoteSessionModel(current),
            catalogValidated: input.model_selection?.catalogValidated,
          })
          const permission =
            input.permission_mode !== undefined &&
            (input.replace_permission || remotePermissionMode(current) !== input.permission_mode)
              ? remotePermissionRules(current.permission, input.permission_mode)
              : undefined
          if (!model && !permission) return current

          // SyncEvent.run 继承当前数据库上下文；读取最新规则、替换 sentinel 与事件投影共享同一 immediate 事务。
          SyncEvent.run(Session.Event.Updated, {
            sessionID: current.id,
            info: {
              ...(model
                ? {
                    model: {
                      providerID: ProviderID.make(model.provider_id),
                      id: ModelID.make(model.model_id),
                      variant: model.variant,
                    },
                  }
                : {}),
              ...(permission ? { permission } : {}),
              time: { updated: Date.now() },
            },
          })
          const updated = tx.select().from(SessionTable).where(eq(SessionTable.id, current.id)).get()
          if (!updated) throw new ProtocolError("SESSION_NOT_FOUND", `Session ${input.session_id} not found`)
          return Session.fromRow(updated)
        },
        { behavior: "immediate" },
      ),
    ),
  )
}

async function readRemoteHistoryPage(input: {
  session_id: string
  direction: "forward" | "backward"
  cursor?: string
  high_water?: string | null
  limit?: number
}) {
  const session = sessionInfo(input.session_id)
  return inDirectory(
    session.directory,
    Effect.sync(() => {
      const page = MessageV2.remoteHistoryPage({
        sessionID: SessionID.make(session.id),
        direction: input.direction,
        cursor: input.cursor,
        highWater: input.high_water,
        limit: input.limit ?? 1,
      })
      return {
        session_id: session.id,
        items: page.items,
        high_water: page.highWater,
        ...(page.nextCursor ? { next_cursor: page.nextCursor } : {}),
      }
    }),
  )
}

function inDirectory<A, E, R>(directory: string, effect: Effect.Effect<A, E, R>) {
  return AppRuntime.runPromise(
    InstanceStore.Service.use((store) => store.provide({ directory }, effect as Effect.Effect<A, E, never>)),
  )
}

async function directoryState(directory: string) {
  return inDirectory(
    directory,
    Effect.gen(function* () {
      const statuses = yield* SessionStatus.Service.use((service) => service.list())
      const permissions = yield* Permission.Service.use((service) => service.list())
      const questions = yield* Question.Service.use((service) => service.list())
      return { statuses, permissions, questions }
    }),
  )
}

function statusType(value: { type: string } | undefined): RemoteSessionStatus {
  if (value?.type === "busy") return "running"
  if (value?.type === "retry") return "retry"
  return "idle"
}

function terminalReply(messages: MessageV2.WithParts[], parentID: MessageID) {
  return messages.some((message) => {
    const info = message.info
    if (info.role !== "assistant" || info.parentID !== parentID) return false
    if (info.error || typeof info.time.completed === "number") return true
    return !!info.finish && !["tool-calls", "unknown"].includes(info.finish)
  })
}

function remoteMessageFiles(message: MessageV2.WithParts | undefined) {
  return (message?.parts ?? []).flatMap((part) =>
    part.type === "file" ? [{ mime: part.mime, filename: part.filename, url: part.url }] : [],
  )
}

function sameRemoteFiles(
  existing: ReturnType<typeof remoteMessageFiles>,
  requested: readonly MessageV2.FilePartInput[],
) {
  if (existing.length !== requested.length) return false
  return existing.every((image, index) => {
    const next = requested[index]
    return !!next && image.mime === next.mime && image.filename === next.filename && image.url === next.url
  })
}

function remoteMessageAttachmentContexts(message: MessageV2.WithParts | undefined) {
  return (message?.parts ?? []).flatMap((part) =>
    part.type === "text" && part.synthetic && isRemoteAttachmentContextText(part.text) ? [part.text] : [],
  )
}

async function startLoop(directory: string, sessionID: SessionID) {
  // 权限模式由持久化 sentinel + Gateway 的 permission.asked 动态处理，loop 本身不捕获旧模式。
  const running = inDirectory(
    directory,
    SessionPrompt.Service.use((service) => service.loop({ sessionID })),
  )
  void running.catch(() => undefined)
  // 等 loop 登记为 busy 后再 ACK，避免手机紧接着 interrupt 时取消发生在 runner 注册之前。
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const current = await inDirectory(
      directory,
      SessionStatus.Service.use((service) => service.get(sessionID)),
    )
    if (current.type !== "idle") break
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

async function resolveAutomaticPermissions(directory: string) {
  const sessions = globalSessions()
  const lineage = remotePermissionLineage(sessions)
  const automaticSessions = new Set(
    sessions
      .filter((item) => item.directory === directory && remotePermissionMode(item, lineage) === "autoReview")
      .map((item) => String(item.id)),
  )
  await inDirectory(
    directory,
    Effect.gen(function* () {
      const permission = yield* Permission.Service
      const pending = yield* permission.list()
      // 显式切到 Auto-review 后处理当前会话及继承该模式的后代；Question 仍由独立服务等待用户回答。
      for (const request of pending) {
        if (!automaticSessions.has(String(request.sessionID))) continue
        yield* permission.reply({ requestID: request.id, reply: "once" })
      }
    }),
  )
}

// 所有手机操作都通过 InstanceStore 进入现有实例，确保使用同一数据库、同一 Bus 和同一执行器。
export const operations: RemoteOperations = {
  async listSessions() {
    const sessions = globalSessions()
    const permissionLineage = remotePermissionLineage(sessions)
    const directories = [...new Set(sessions.map((session) => session.directory))]
    const directoryData = new Map(
      await Promise.all(
        directories.map(async (directory) => {
          // 状态与模型目录都按 directory 去重并并行读取，同目录的多个会话共享同一份权威目录快照。
          const [state, catalog] = await Promise.all([directoryState(directory), directoryModelCatalog(directory)])
          return [directory, { state, catalog }] as const
        }),
      ),
    )
    return Promise.all(
      sessions.map(async (session) => {
        const data = directoryData.get(session.directory)
        const state = data?.state
        const waiting =
          state?.permissions.some((request) => request.sessionID === session.id) ||
          state?.questions.some((request) => request.sessionID === session.id)
        return mapSession(session, waiting ? "waiting_approval" : statusType(state?.statuses.get(session.id)), {
          model: await resolvedSessionModel(session),
          model_catalog: data?.catalog ?? [],
          permission_mode: remotePermissionMode(session, permissionLineage),
        })
      }),
    )
  },

  async modelCatalog(input) {
    // 显式目录供新建页和会话目录使用；没有会话时仍以 cwd 初始化 Provider，保证首次握手可用。
    return modelCatalog(input)
  },

  async blankProjectDefaults(input) {
    // 默认位置和递增名称与桌面侧边栏入口保持一致。
    return blankProjectOperation(() => prepareBlankProjectDefaults(input.parent))
  },

  async blankProjectExists(input) {
    return blankProjectOperation(() => ({
      parent: input.parent,
      name: input.name,
      path: resolveBlankProjectTarget(input.parent, input.name),
      exists: blankProjectPathExists(input.parent, input.name),
    }))
  },

  async blankProjectCreate(input) {
    const result = await blankProjectOperation(async () => ({
      parent: input.parent,
      name: input.name,
      path: await createBlankProject(input.parent, input.name),
    }))
    // 手机和桌面共享同一项目列表；只请求桌面加入目录，不改变桌面当前路由和会话。
    GlobalBus.emit("event", {
      directory: "global",
      payload: {
        type: ServerEvent.ProjectOpenRequested.type,
        properties: { directory: result.path },
      },
    })
    return result
  },

  async history(input) {
    const cursor = Math.max(0, input.cursor ?? 0)
    const limit = Math.min(500, Math.max(1, input.limit ?? 100))
    let skipped = 0
    let sourceBytes = 0
    let pageCursor: string | undefined
    let highWater: string | null | undefined
    const messages: MessageV2.WithParts[] = []
    let more = false
    // 旧 numeric cursor 兼容入口同样逐条走安全读取；远控 Bridge 主路径使用下方 keyset API。
    while (messages.length < limit) {
      const page = await readRemoteHistoryPage({
        session_id: input.session_id,
        direction: "forward",
        cursor: pageCursor,
        high_water: highWater,
        limit: 1,
      })
      highWater = page.high_water
      const item = page.items[0]
      if (!item) {
        more = false
        break
      }
      pageCursor = page.next_cursor
      more = !!pageCursor
      if (skipped < cursor) {
        skipped += 1
      } else {
        if (item.type === "oversized") {
          throw new ProtocolError(
            "REMOTE_HISTORY_ENTRY_TOO_LARGE",
            "A desktop message is too large to display remotely",
          )
        }
        sourceBytes += item.bytes
        if (sourceBytes > remoteHistoryResultMaxBytes) {
          throw new ProtocolError("REMOTE_HISTORY_RESULT_TOO_LARGE", "Remote history page exceeds 32 MiB")
        }
        messages.push(item.message)
      }
      if (!pageCursor) break
    }
    return {
      session_id: input.session_id,
      messages,
      ...(more ? { next_cursor: cursor + messages.length } : {}),
    }
  },

  async historyPage(input) {
    return readRemoteHistoryPage(input)
  },

  async send(input) {
    const images = input.images ?? []
    const attachments = input.attachments ?? []
    const attachmentParts = remoteAttachmentMessageParts(attachments)
    const files = [...images, ...attachmentParts.filter((part) => part.type === "file")]
    const attachmentContexts = remoteAttachmentContextTexts(attachments)
    const text = input.text.trim() ? input.text : ""
    if (!text && files.length === 0) {
      throw new ProtocolError("INVALID_REQUEST", "Message text or attachment is required")
    }
    const session = sessionInfo(input.session_id)
    const sessionID = SessionID.make(session.id)
    const requestKey = input.request_id ? remoteRequestKey(input.request_id) : undefined
    const messages = requestKey
      ? await inDirectory(
          session.directory,
          Session.Service.use((service) => service.messages({ sessionID })),
        )
      : []
    const existing = requestKey
      ? messages.find((message) => message.info.role === "user" && message.info.remoteRequestKey === requestKey)
      : undefined
    const existingText = existing?.parts
      .flatMap((part) => (part.type === "text" && !part.ignored && !part.synthetic ? [part.text] : []))
      .join("\n")
    const existingFiles = remoteMessageFiles(existing)
    const existingAttachmentContexts = remoteMessageAttachmentContexts(existing)
    if (
      existing &&
      (existingText !== text ||
        !sameRemoteFiles(existingFiles, files) ||
        JSON.stringify(existingAttachmentContexts) !== JSON.stringify(attachmentContexts) ||
        (existing.info.role === "user" ? existing.info.remoteClientMessageID : undefined) !== input.client_message_id)
    ) {
      throw new ProtocolError("REQUEST_ID_CONFLICT", "request_id was already used with different message input")
    }
    if (
      existing &&
      existingText === text &&
      sameRemoteFiles(existingFiles, files) &&
      JSON.stringify(existingAttachmentContexts) === JSON.stringify(attachmentContexts)
    ) {
      const status = await inDirectory(
        session.directory,
        SessionStatus.Service.use((service) => service.get(sessionID)),
      )
      // 写库后、loop 启动前崩溃时，重试必须补启动；已在执行或已有终态回复时只返回原 ACK。
      if (status.type === "idle" && !terminalReply(messages, existing.info.id)) {
        await startLoop(session.directory, sessionID)
      }
      return { message_id: existing.info.id }
    }
    const status = await inDirectory(
      session.directory,
      SessionStatus.Service.use((service) => service.get(sessionID)),
    )
    if (status.type !== "idle") throw new ProtocolError("SESSION_BUSY", `Session ${session.id} is busy`)
    const selectedModel = await resolvedSessionModel(session)
    if (!selectedModel) throw new ProtocolError("MODEL_NOT_AVAILABLE", "No model is available for this session")

    // 远控消息显式携带桌面已确认的 model/variant，不能让 Prompt.lastModel 再回退到旧消息或 provider 默认值。
    const message = await inDirectory(
      session.directory,
      SessionPrompt.Service.use((service) =>
        service.prompt({
          sessionID,
          model: {
            providerID: ProviderID.make(selectedModel.provider_id),
            modelID: ModelID.make(selectedModel.model_id),
          },
          variant: selectedModel.variant,
          ...(existing ? { messageID: existing.info.id } : {}),
          noReply: true,
          remoteRequestKey: requestKey,
          remoteClientMessageID: input.client_message_id,
          // 原文件、提取正文和扫描页一次性写入同一用户消息，ACK 返回时模型上下文已经完整持久化。
          parts: [...(text ? [{ type: "text" as const, text }] : []), ...images, ...attachmentParts],
        }),
      ),
    )
    await startLoop(session.directory, sessionID)
    return { message_id: message.info.id }
  },

  async getAttachment(input) {
    const session = globalSessions().find((item) => item.id === input.session_id)
    // 附件入口对不存在的会话继续返回禁止访问，避免通过错误码枚举桌面会话；有效会话再进入其权威目录。
    if (!session) throw new ProtocolError("attachment_forbidden", "Attachment does not belong to this session")
    // 附件记录属于目标会话的项目数据库；即使请求从另一个当前工作区发起，也必须先切换目录再完成整段校验与解码。
    return inDirectory(
      session.directory,
      Effect.sync(() => {
        const row = Database.use((db) =>
          db
            .select()
            .from(PartTable)
            .where(eq(PartTable.id, PartID.make(input.attachment_id)))
            .get(),
        )
        if (!row) throw new ProtocolError("attachment_not_found", "Attachment not found")
        // part ID 全局唯一；命中其他会话时明确拒绝，不能让已认证设备跨 session 枚举文件正文。
        if (String(row.session_id) !== input.session_id) {
          throw new ProtocolError("attachment_forbidden", "Attachment does not belong to this session")
        }
        const message = Database.use((db) =>
          db
            .select({ data: MessageTable.data, sessionID: MessageTable.session_id })
            .from(MessageTable)
            .where(eq(MessageTable.id, row.message_id))
            .get(),
        )
        if (
          String(message?.sessionID) !== input.session_id ||
          message?.data.role !== "user" ||
          row.data.type !== "file"
        ) {
          throw new ProtocolError("attachment_forbidden", "Attachment is not a user file")
        }
        const part = {
          ...row.data,
          id: row.id,
          sessionID: row.session_id,
          messageID: row.message_id,
        } as MessageV2.FilePart
        if (isRemoteDerivedAttachment(part)) {
          throw new ProtocolError(
            "attachment_forbidden",
            "Derived attachment content is not independently downloadable",
          )
        }
        const data = remoteStoredAttachmentData(part)
        const filename = remoteStoredAttachmentFilename(part.filename)
        if (!data || !filename) {
          throw new ProtocolError("attachment_expired", "Attachment content is no longer available")
        }
        return {
          attachment_id: input.attachment_id,
          filename,
          mime_type: part.mime,
          size_bytes: data.sizeBytes,
          base64: data.base64,
          sha256: data.sha256,
        }
      }),
    )
  },

  async create(input) {
    if (!input.directory.trim()) throw new ProtocolError("INVALID_REQUEST", "Session directory is required")
    if (input.variant !== undefined && !input.model_id) {
      throw new ProtocolError("INVALID_REQUEST", "A reasoning effort requires a model")
    }
    const sessionID = input.request_id ? SessionID.make(remoteSessionID(input.request_id)) : undefined
    const existing = sessionID ? remoteIdempotencySession(sessionID) : undefined
    if (existing) {
      validateRemoteCreateRetry(existing, input)
      return mapSession(existing, "idle", {
        model: await resolvedSessionModel(existing),
        model_catalog: await directoryModelCatalog(existing.directory),
        permission_mode: remotePermissionMode(existing),
      })
    }
    const selectedModel = input.model_id
      ? await selectedWanlaiModel(input.directory, input.model_id, input.variant)
      : undefined
    const permission = input.permission_mode ? remotePermissionRules(undefined, input.permission_mode) : undefined
    const session = await inDirectory(
      input.directory,
      Session.Service.use((service) =>
        service.create({
          ...(sessionID ? { id: sessionID } : {}),
          ...(input.title ? { title: input.title } : {}),
          ...(selectedModel
            ? {
                model: {
                  providerID: ProviderID.make(selectedModel.provider_id),
                  id: ModelID.make(selectedModel.model_id),
                  variant: selectedModel.variant,
                },
              }
            : {}),
          ...(permission ? { permission } : {}),
        }),
      ),
    ).catch((error) => {
      // 不同目录的并发请求可能由底层 project 边界拒绝；若主键已经落库，仍统一按 request_id 冲突判定。
      const raced = sessionID ? remoteIdempotencySession(sessionID) : undefined
      if (!raced) throw error
      return raced
    })
    if (sessionID) validateRemoteCreateRetry(session, input)
    return mapSession(session, "idle", {
      // 底层 create 会在并发相同 ID 时返回先落库的记录；ACK 只能投影该实际记录，不能回显本次请求模型。
      model: await resolvedSessionModel(session),
      model_catalog: await directoryModelCatalog(session.directory),
      permission_mode: remotePermissionMode(session),
    })
  },

  async resume(input) {
    const session = sessionInfo(input.session_id)
    // 全部输入校验必须先于 Session.Event.Updated；任一设置非法时数据库和事件流都保持原样。
    if (input.variant !== undefined && !input.model_id) {
      throw new ProtocolError("set_codex_model_rejected", "A reasoning effort requires a model")
    }
    if (
      input.permission_mode !== undefined &&
      input.permission_mode !== "default" &&
      input.permission_mode !== "autoReview"
    ) {
      throw new ProtocolError("set_permission_mode_rejected", `Unsupported permission mode: ${input.permission_mode}`)
    }
    const modelSelection = input.model_id
      ? await selectedSessionModel(session, input.model_id, input.variant)
      : undefined
    const permissionMode = input.permission_mode
    const updated = await updateRemoteSessionState({
      session_id: session.id,
      directory: session.directory,
      model_selection: modelSelection,
      permission_mode: permissionMode,
    })
    if (permissionMode === "autoReview") await resolveAutomaticPermissions(session.directory)
    return mapSession(updated, "idle", {
      // ACK 必须来自事务后会话；不能用事务前 selectedModel 覆盖桌面并发写入后的真实状态。
      model: await resolvedSessionModel(updated),
      model_catalog: await directoryModelCatalog(updated.directory),
      permission_mode: remotePermissionMode(updated),
    })
  },

  async abort(input) {
    const session = sessionInfo(input.session_id)
    await inDirectory(
      session.directory,
      SessionPrompt.Service.use((service) => service.cancel(SessionID.make(session.id), { resumeQueued: false })),
    )
  },

  async setModel(input) {
    const session = sessionInfo(input.session_id)
    // 独立 setter 与 resume 共用档位缺省/null/不兼容语义，避免两条入口在下一次 prompt 时选到不同模型配置。
    const { model, previous } = await selectedSessionModel(session, input.model_id, input.variant)
    await inDirectory(
      session.directory,
      Session.Service.use((service) =>
        service.setModel({
          sessionID: SessionID.make(session.id),
          model: {
            providerID: ProviderID.make(model.provider_id),
            id: ModelID.make(model.model_id),
            variant: model.variant,
          },
        }),
      ),
    )
    return { model, ...(previous ? { previous_model: previous } : {}) }
  },

  async setPermissionMode(input) {
    const session = sessionInfo(input.session_id)
    if (input.mode !== "default" && input.mode !== "autoReview") {
      throw new ProtocolError("set_permission_mode_rejected", `Unsupported permission mode: ${input.mode}`)
    }
    // 用户主动切换会写入本会话显式 sentinel；事务内只替换该规则并保留同时新增的桌面原生权限。
    const updated = await updateRemoteSessionState({
      session_id: session.id,
      directory: session.directory,
      permission_mode: input.mode,
      replace_permission: true,
    })
    // 独立 setter 与 resume 复用同一待审批收束逻辑，避免两条入口的 Auto-review 行为分叉。
    if (input.mode === "autoReview") await resolveAutomaticPermissions(session.directory)
    return { mode: remotePermissionMode(updated) }
  },

  async permissionMode(input) {
    return remotePermissionMode(sessionInfo(input.session_id))
  },

  async permissionReply(input) {
    const session = sessionInfo(input.session_id)
    await inDirectory(
      session.directory,
      Effect.gen(function* () {
        const service = yield* Permission.Service
        const pending = yield* service.list()
        if (
          !pending.some(
            (request) => String(request.id) === input.request_id && String(request.sessionID) === session.id,
          )
        ) {
          return yield* Effect.fail(
            new ProtocolError("REQUEST_ALREADY_RESOLVED", `Permission ${input.request_id} is no longer pending`),
          )
        }
        yield* service.reply({
          requestID: PermissionID.make(input.request_id),
          reply: input.reply,
          message: input.message,
        })
      }),
    )
  },

  async reject(input) {
    const session = sessionInfo(input.session_id)
    await inDirectory(
      session.directory,
      Effect.gen(function* () {
        const permission = yield* Permission.Service
        const question = yield* Question.Service
        const permissions = yield* permission.list()
        if (
          permissions.some(
            (request) => String(request.id) === input.request_id && String(request.sessionID) === session.id,
          )
        ) {
          yield* permission.reply({
            requestID: PermissionID.make(input.request_id),
            reply: "reject",
            message: input.message,
          })
          return
        }
        const questions = yield* question.list()
        if (
          questions.some(
            (request) => String(request.id) === input.request_id && String(request.sessionID) === session.id,
          )
        ) {
          yield* question.reject(QuestionID.make(input.request_id))
          return
        }
        return yield* Effect.fail(
          new ProtocolError("REQUEST_ALREADY_RESOLVED", `Request ${input.request_id} is no longer pending`),
        )
      }),
    )
  },

  async questionReply(input) {
    const session = sessionInfo(input.session_id)
    await inDirectory(
      session.directory,
      Effect.gen(function* () {
        const service = yield* Question.Service
        const pending = yield* service.list()
        if (
          !pending.some(
            (request) => String(request.id) === input.request_id && String(request.sessionID) === session.id,
          )
        ) {
          return yield* Effect.fail(
            new ProtocolError("REQUEST_ALREADY_RESOLVED", `Question ${input.request_id} is no longer pending`),
          )
        }
        yield* service.reply({ requestID: QuestionID.make(input.request_id), answers: input.answers })
      }),
    )
  },

  async questionReject(input) {
    const session = sessionInfo(input.session_id)
    await inDirectory(
      session.directory,
      Effect.gen(function* () {
        const service = yield* Question.Service
        const pending = yield* service.list()
        if (
          !pending.some(
            (request) => String(request.id) === input.request_id && String(request.sessionID) === session.id,
          )
        ) {
          return yield* Effect.fail(
            new ProtocolError("REQUEST_ALREADY_RESOLVED", `Question ${input.request_id} is no longer pending`),
          )
        }
        yield* service.reject(QuestionID.make(input.request_id))
      }),
    )
  },

  async snapshot() {
    const sessions = await operations.listSessions()
    const states = await Promise.all(
      [...new Set(sessions.map((session) => session.directory))].map((directory) => directoryState(directory)),
    )
    // 快照携带当前待审批项，手机重连后无需依赖可能已经丢失的实时 asked 事件。
    return {
      sessions,
      permissions: states.flatMap((state) =>
        state.permissions.map((request) => ({
          session_id: String(request.sessionID),
          request_id: String(request.id),
          permission: request.permission,
          patterns: request.patterns,
          metadata: request.metadata,
        })),
      ),
      questions: states.flatMap((state) =>
        state.questions.map((request) => ({
          session_id: String(request.sessionID),
          request_id: String(request.id),
          questions: request.questions,
        })),
      ),
    }
  },
}

export * as RemoteOperations from "./operations"
