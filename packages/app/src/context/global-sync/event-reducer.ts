import { Binary } from "@opencode-ai/core/util/binary"
import { produce, reconcile, type SetStoreFunction, type Store } from "solid-js/store"
import type {
  Goal,
  Message,
  Part,
  PermissionRequest,
  Project,
  QuestionRequest,
  Session,
  SessionStatus,
  SnapshotFileDiff,
  Todo,
} from "@opencode-ai/sdk/v2/client"
import type { PermissionReviewState, State, VcsCache } from "./types"
import type { createPermissionReviewLifecycle } from "./permission-review-lifecycle"
import { trimSessions } from "./session-trim"
import { clearRemovalSettlement, dropSessionCaches, settleRemovalByEvent } from "./session-cache"
import { diffs as list, message as clean } from "@/utils/diffs"
import { mergeLivePartSnapshot } from "./part-merge"
import { findMessageIndexByID, preserveKnownMessageTurnIdentity, upsertMessage } from "../message-order"

// patch/step-start 只是渲染噪音；step-finish 是前端释放运行态需要的完成信号，不能过滤。
const SKIP_PARTS = new Set(["patch", "step-start"])

const isSameSkillPart = (a: Part, b: Part) =>
  a.type === "text" &&
  b.type === "text" &&
  !!a.metadata?.skill &&
  !!b.metadata?.skill &&
  JSON.stringify(a.metadata.skill) === JSON.stringify(b.metadata.skill)

export function applyGlobalEvent(input: {
  event: { type: string; properties?: unknown }
  project: Project[]
  setGlobalProject: (next: Project[] | ((draft: Project[]) => Project[])) => void
  setConfigMode: (mode: "ask" | "auto_review" | "full_access") => void
  refresh: () => void
  refreshConfig?: () => void
}) {
  if (input.event.type === "global.config.updated") {
    input.refreshConfig?.()
    return
  }
  if (input.event.type === "global.disposed" || input.event.type === "server.connected") {
    input.refresh()
    return
  }

  if (input.event.type === "permission.mode.updated") {
    const properties = input.event.properties as { mode: "ask" | "auto_review" | "full_access" }
    input.setConfigMode(properties.mode)
    return
  }

  if (input.event.type !== "project.updated") return
  const properties = input.event.properties as Project
  const result = Binary.search(input.project, properties.id, (s) => s.id)
  if (result.found) {
    // 整条替换而非 spread merge：后端 Info 用 optionalOmitUndefined 编码，
    // 字段值变为 undefined 时 wire 上直接省略 key（例如 git 仓库被删后 vcs 不再出现），
    // spread 合并无法把旧值清掉，UI 会停留在过期状态。
    //
    // 这里依赖一个不变式：后端所有 emitUpdated 调用都基于 fromRow 发送完整 Info（见
    // packages/opencode/src/project/project.ts 的 fromDirectory / update / setVcs 等）。
    // 如果未来引入「partial project.updated」语义，需要同步调整这里为字段级 merge，
    // 否则会丢失未在 wire 上出现的字段。
    input.setGlobalProject(
      produce((draft) => {
        draft[result.index] = properties
      }),
    )
    return
  }
  input.setGlobalProject(
    produce((draft) => {
      draft.splice(result.index, 0, properties)
    }),
  )
}

function cleanupSessionCaches(
  setStore: SetStoreFunction<State>,
  sessionID: string,
  setSessionTodo?: (sessionID: string, todos: Todo[] | undefined) => void,
  setSessionGoal?: (sessionID: string, goal: Goal | undefined) => void,
  clearPermissionReviewSession?: (sessionID: string) => void,
) {
  if (!sessionID) return
  clearPermissionReviewSession?.(sessionID)
  setSessionTodo?.(sessionID, undefined)
  setSessionGoal?.(sessionID, undefined)
  setStore(
    produce((draft) => {
      dropSessionCaches(draft, [sessionID])
    }),
  )
}

export function cleanupDroppedSessionCaches(
  store: Store<State>,
  setStore: SetStoreFunction<State>,
  next: Session[],
  setSessionTodo?: (sessionID: string, todos: Todo[] | undefined) => void,
  setSessionGoal?: (sessionID: string, goal: Goal | undefined) => void,
  clearPermissionReviewSession?: (sessionID: string) => void,
) {
  const keep = new Set(next.map((item) => item.id))
  const stale = [
    ...Object.keys(store.message),
    ...Object.keys(store.session_diff),
    ...Object.keys(store.session_suggestion),
    ...Object.keys(store.todo),
    ...Object.keys(store.permission),
    ...Object.keys(store.permission_review ?? {}),
    ...Object.keys(store.question),
    ...Object.keys(store.session_status),
    ...Object.keys(store.session_status_known),
    ...Object.values(store.part)
      .map((parts) => parts?.find((part) => !!part?.sessionID)?.sessionID)
      .filter((sessionID): sessionID is string => !!sessionID),
  ].filter((sessionID, index, list) => !keep.has(sessionID) && list.indexOf(sessionID) === index)
  if (stale.length === 0) return
  for (const sessionID of stale) {
    clearPermissionReviewSession?.(sessionID)
    setSessionTodo?.(sessionID, undefined)
    setSessionGoal?.(sessionID, undefined)
  }
  setStore(
    produce((draft) => {
      dropSessionCaches(draft, stale)
    }),
  )
}

export function applyDirectoryEvent(input: {
  event: { type: string; properties?: unknown }
  store: Store<State>
  setStore: SetStoreFunction<State>
  push: (directory: string) => void
  directory: string
  loadLsp: () => void
  vcsCache?: VcsCache
  setSessionTodo?: (sessionID: string, todos: Todo[] | undefined) => void
  setSessionGoal?: (sessionID: string, goal: Goal | undefined) => void
  permissionReviewLifecycle?: ReturnType<typeof createPermissionReviewLifecycle>
}) {
  const event = input.event
  switch (event.type) {
    case "server.instance.disposed": {
      input.push(input.directory)
      return
    }
    // 插件启停/装卸改变可用命令(addon skills)与 hook。addon.changed 经实例 Bus
    // 发出,带的是实例 directory(非 "global"),所以在按目录的 reducer 里处理:
    // 重新 bootstrap 该实例,刷新 store.command 等。
    case "addon.changed": {
      input.push(input.directory)
      return
    }
    case "session.created": {
      const info = (event.properties as { info: Session }).info
      // 会话重新可访问：作废旧一轮移除竞争的残留标记，下一轮归档/删除正常结算
      clearRemovalSettlement(input.directory, info.id)
      const result = Binary.search(input.store.session, info.id, (s) => s.id)
      if (result.found) {
        input.setStore("session", result.index, reconcile(info))
        break
      }
      const next = input.store.session.slice()
      next.splice(result.index, 0, info)
      const trimmed = trimSessions(next, { limit: input.store.limit, permission: input.store.permission })
      input.setStore("session", reconcile(trimmed, { key: "id" }))
      cleanupDroppedSessionCaches(
        input.store,
        input.setStore,
        trimmed,
        input.setSessionTodo,
        input.setSessionGoal,
        (sessionID) => input.permissionReviewLifecycle?.clearSession(input.directory, sessionID),
      )
      if (!info.parentID) input.setStore("sessionTotal", (value) => value + 1)
      break
    }
    case "session.updated": {
      const info = (event.properties as { info: Session }).info
      const result = Binary.search(input.store.session, info.id, (s) => s.id)
      if (info.time.archived !== undefined) {
        if (result.found) {
          input.setStore(
            "session",
            produce((draft) => {
              draft.splice(result.index, 1)
            }),
          )
        }
        cleanupSessionCaches(
          input.setStore,
          info.id,
          input.setSessionTodo,
          input.setSessionGoal,
          (sessionID) => input.permissionReviewLifecycle?.clearSession(input.directory, sessionID),
        )
        if (info.parentID) break
        // 与本地终态结算竞争：先到者递减，后到者跳过
        if (settleRemovalByEvent(input.directory, info.id))
          input.setStore("sessionTotal", (value) => Math.max(0, value - 1))
        break
      }
      // 未归档的 updated（含 unarchive 恢复插入）：会话可访问，作废旧移除标记
      clearRemovalSettlement(input.directory, info.id)
      if (result.found) {
        input.setStore("session", result.index, reconcile(info))
        break
      }
      const next = input.store.session.slice()
      next.splice(result.index, 0, info)
      const trimmed = trimSessions(next, { limit: input.store.limit, permission: input.store.permission })
      input.setStore("session", reconcile(trimmed, { key: "id" }))
      cleanupDroppedSessionCaches(
        input.store,
        input.setStore,
        trimmed,
        input.setSessionTodo,
        input.setSessionGoal,
        (sessionID) => input.permissionReviewLifecycle?.clearSession(input.directory, sessionID),
      )
      break
    }
    case "session.deleted": {
      const info = (event.properties as { info: Session }).info
      const result = Binary.search(input.store.session, info.id, (s) => s.id)
      if (result.found) {
        input.setStore(
          "session",
          produce((draft) => {
            draft.splice(result.index, 1)
          }),
        )
      }
      cleanupSessionCaches(
        input.setStore,
        info.id,
        input.setSessionTodo,
        input.setSessionGoal,
        (sessionID) => input.permissionReviewLifecycle?.clearSession(input.directory, sessionID),
      )
      if (info.parentID) break
      // found=false 不代表已处理（可能是分页未加载的条目被删），默认递减；
      // 仅与本地终态结算竞争时由后到方跳过
      if (settleRemovalByEvent(input.directory, info.id))
        input.setStore("sessionTotal", (value) => Math.max(0, value - 1))
      break
    }
    case "session.diff": {
      const props = event.properties as { sessionID: string; diff: SnapshotFileDiff[] }
      input.setStore("session_diff", props.sessionID, reconcile(list(props.diff), { key: "file" }))
      break
    }
    case "session.suggestion": {
      const props = event.properties as { sessionID: string; text: string }
      input.setStore("session_suggestion", props.sessionID, props.text)
      break
    }
    case "todo.updated": {
      const props = event.properties as { sessionID: string; todos: Todo[] }
      input.setStore("todo", props.sessionID, reconcile(props.todos, { key: "id" }))
      input.setSessionTodo?.(props.sessionID, props.todos)
      break
    }
    case "session.goal.updated": {
      const props = event.properties as { sessionID: string; goal: Goal }
      input.setSessionGoal?.(props.sessionID, props.goal)
      break
    }
    case "session.goal.cleared": {
      const props = event.properties as { sessionID: string }
      input.setSessionGoal?.(props.sessionID, undefined)
      break
    }
    case "session.status": {
      const props = event.properties as { sessionID: string; status: SessionStatus }
      // 实时事件只证明它携带的会话状态权威；不能把全局 ready 置真后误判其它缺失 key。
      input.setStore("session_status_known", props.sessionID, true)
      if (props.status.type === "idle") {
        input.setStore(
          "session_status",
          produce((draft) => {
            delete draft[props.sessionID]
          }),
        )
        break
      }
      input.setStore("session_status", props.sessionID, reconcile(props.status))
      break
    }
    case "message.updated": {
      const incoming = clean((event.properties as { info: Message }).info)
      const messages = input.store.message[incoming.sessionID]
      if (!messages) {
        // First message for this session — always a new message
        if (incoming.role === "user")
          input.setStore(
            "session_suggestion",
            produce((draft) => {
              delete draft[incoming.sessionID]
            }),
          )
        input.setStore("message", incoming.sessionID, [incoming])
        break
      }
      // 同 ID 更新仍按消息身份定位；普通消息继续按创建时间归位，修复远控消息 ID 不具备时间顺序的问题。
      const index = findMessageIndexByID(messages, incoming.id)
      // optimistic steer 已经保存权威目标；旧后端回显缺字段时必须原位继承，不能在 ACK 瞬间拆成第二个顶层 turn。
      const info = preserveKnownMessageTurnIdentity(index < 0 ? undefined : messages[index], incoming)
      const manualSteer = info.role === "user" && info.steerTargetTurnID !== undefined
      const sameTimestampSnapshot = messages.every((message) => message.time.created === info.time.created)
      if (index !== -1) {
        // Message already exists — this is an update/re-send (e.g. summary patch), do NOT clear suggestion
        if (manualSteer) input.setStore("message", info.sessionID, index, reconcile(info))
        else input.setStore("message", info.sessionID, reconcile(upsertMessage(messages, info), { key: "id" }))
        break
      }
      // Message not found in store — it's genuinely new
      if (info.role === "user")
        input.setStore(
          "session_suggestion",
          produce((draft) => {
            delete draft[info.sessionID]
          }),
        )
      input.setStore(
        "message",
        info.sessionID,
        // assistant 事件必须保留 SSE 首见位置；普通 user 事件仍可按创建时间纠正远控旧 ID 的顺序。
        reconcile(
          manualSteer || info.role === "assistant" || sameTimestampSnapshot
            ? [...messages, info]
            : upsertMessage(messages, info),
          {
            key: "id",
          },
        ),
      )
      break
    }
    case "message.removed": {
      const props = event.properties as { sessionID: string; messageID: string }
      input.setStore(
        produce((draft) => {
          const messages = draft.message[props.sessionID]
          if (messages) {
            // 时间线不再按消息 ID 排序，删除事件必须按真实数组索引定位。
            const index = messages.findIndex((message) => message.id === props.messageID)
            if (index !== -1) messages.splice(index, 1)
          }
          delete draft.part[props.messageID]
          // revert/undo 后建议来源已不存在，一并清除
          delete draft.session_suggestion[props.sessionID]
        }),
      )
      break
    }
    case "message.part.updated": {
      const part = (event.properties as { part: Part }).part
      if (SKIP_PARTS.has(part.type)) break
      const parts = input.store.part[part.messageID]
      if (!parts) {
        input.setStore("part", part.messageID, [part])
        break
      }
      const result = Binary.search(parts, part.id, (p) => p.id)
      if (result.found) {
        input.setStore("part", part.messageID, result.index, reconcile(mergeLivePartSnapshot(parts[result.index], part)))
        break
      }
      const withoutEquivalentSkill = parts.filter((item) => !isSameSkillPart(item, part))
      if (withoutEquivalentSkill.length !== parts.length) {
        const next = [...withoutEquivalentSkill]
        const target = Binary.search(next, part.id, (p) => p.id)
        next.splice(target.index, 0, part)
        input.setStore("part", part.messageID, reconcile(next))
        break
      }
      input.setStore(
        "part",
        part.messageID,
        produce((draft) => {
          draft.splice(result.index, 0, part)
        }),
      )
      break
    }
    case "message.part.removed": {
      const props = event.properties as { messageID: string; partID: string }
      const parts = input.store.part[props.messageID]
      if (!parts) break
      const result = Binary.search(parts, props.partID, (p) => p.id)
      if (result.found) {
        input.setStore(
          produce((draft) => {
            const list = draft.part[props.messageID]
            if (!list) return
            const next = Binary.search(list, props.partID, (p) => p.id)
            if (!next.found) return
            list.splice(next.index, 1)
            if (list.length === 0) delete draft.part[props.messageID]
          }),
        )
      }
      break
    }
    case "message.part.delta": {
      const props = event.properties as { messageID: string; partID: string; field: string; delta: string }
      const parts = input.store.part[props.messageID]
      if (!parts) break
      const result = Binary.search(parts, props.partID, (p) => p.id)
      if (!result.found) break
      input.setStore(
        "part",
        props.messageID,
        produce((draft) => {
          const part = draft[result.index]
          const field = props.field as keyof typeof part
          const existing = part[field] as string | undefined
          ;(part[field] as string) = (existing ?? "") + props.delta
        }),
      )
      break
    }
    case "vcs.branch.updated": {
      const props = event.properties as { branch?: string }
      if (props.branch === undefined) {
        const next = {
          ...input.store.vcs,
          branch: undefined,
          default_branch: undefined,
        }
        input.setStore("vcs", next)
        if (input.vcsCache) input.vcsCache.setStore("value", next)
        break
      }
      if (input.store.vcs?.branch === props.branch) break
      const next = { ...input.store.vcs, branch: props.branch }
      input.setStore("vcs", next)
      if (input.vcsCache) input.vcsCache.setStore("value", next)
      break
    }
    case "permission.asked": {
      const permission = event.properties as PermissionRequest
      const permissions = input.store.permission[permission.sessionID]
      if (!permissions) {
        input.setStore("permission", permission.sessionID, [permission])
        break
      }
      const result = Binary.search(permissions, permission.id, (p) => p.id)
      if (result.found) {
        input.setStore("permission", permission.sessionID, result.index, reconcile(permission))
        break
      }
      input.setStore(
        "permission",
        permission.sessionID,
        produce((draft) => {
          draft.splice(result.index, 0, permission)
        }),
      )
      break
    }
    case "permission.replied": {
      const props = event.properties as { sessionID: string; requestID: string }
      const permissions = input.store.permission[props.sessionID]
      if (!permissions) break
      const result = Binary.search(permissions, props.requestID, (p) => p.id)
      if (!result.found) break
      input.setStore(
        "permission",
        props.sessionID,
        produce((draft) => {
          draft.splice(result.index, 1)
        }),
      )
      break
    }
    case "permission.review.started":
    case "permission.review.approved":
    case "permission.review.denied":
    case "permission.review.escalated":
    case "permission.review.failed": {
      const props = event.properties as {
        reviewID: string
        permissionID: string
        sessionID: string
        summary: string
        startedAt?: number
        completedAt?: number
        risk?: PermissionReviewState["risk"]
        reason?: string
      }
      const status =
        event.type === "permission.review.started"
          ? "reviewing"
          : event.type.replace("permission.review.", "") as Exclude<PermissionReviewState["status"], "reviewing">
      if (!input.store.permission_review) input.setStore("permission_review", {})
      const reviews = input.store.permission_review[props.sessionID]
      const result = Binary.search(reviews ?? [], props.reviewID, (review) => review.id)
      const existing = result.found ? reviews?.[result.index] : undefined
      const review: PermissionReviewState = {
        id: props.reviewID,
        permissionID: props.permissionID,
        sessionID: props.sessionID,
        status,
        risk: props.risk,
        reason: props.reason,
        summary: props.summary,
        startedAt: existing?.startedAt ?? props.startedAt ?? props.completedAt ?? Date.now(),
        completedAt: props.completedAt,
      }
      if (!reviews) {
        input.setStore("permission_review", props.sessionID, [review])
        input.permissionReviewLifecycle?.sync({
          directory: input.directory,
          review,
          remove: (reviewID) =>
            input.setStore("permission_review", props.sessionID, (items) =>
              (items ?? []).filter((item) => item.id !== reviewID),
            ),
        })
        break
      }
      if (result.found) {
        input.setStore("permission_review", props.sessionID, result.index, reconcile(review))
        input.permissionReviewLifecycle?.sync({
          directory: input.directory,
          review,
          remove: (reviewID) =>
            input.setStore("permission_review", props.sessionID, (items) =>
              (items ?? []).filter((item) => item.id !== reviewID),
            ),
        })
        break
      }
      input.setStore(
        "permission_review",
        props.sessionID,
        produce((draft) => {
          draft.splice(result.index, 0, review)
        }),
      )
      input.permissionReviewLifecycle?.sync({
        directory: input.directory,
        review,
        remove: (reviewID) =>
          input.setStore("permission_review", props.sessionID, (items) =>
            (items ?? []).filter((item) => item.id !== reviewID),
          ),
      })
      break
    }
    case "question.asked": {
      const question = event.properties as QuestionRequest
      const questions = input.store.question[question.sessionID]
      if (!questions) {
        input.setStore("question", question.sessionID, [question])
        break
      }
      const result = Binary.search(questions, question.id, (q) => q.id)
      if (result.found) {
        input.setStore("question", question.sessionID, result.index, reconcile(question))
        break
      }
      input.setStore(
        "question",
        question.sessionID,
        produce((draft) => {
          draft.splice(result.index, 0, question)
        }),
      )
      break
    }
    case "question.replied":
    case "question.rejected": {
      const props = event.properties as { sessionID: string; requestID: string }
      const questions = input.store.question[props.sessionID]
      if (!questions) break
      const result = Binary.search(questions, props.requestID, (q) => q.id)
      if (!result.found) break
      input.setStore(
        "question",
        props.sessionID,
        produce((draft) => {
          draft.splice(result.index, 1)
        }),
      )
      break
    }
    case "lsp.updated": {
      input.loadLsp()
      break
    }
  }
}
