import { createEffect, createMemo, on, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import type { Goal, GoalStatus, PermissionRequest, QuestionRequest, Todo } from "@opencode-ai/sdk/v2"
import { useParams } from "@solidjs/router"
import { showToast } from "@opencode-ai/ui/toast"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { sessionPermissionRequest, sessionQuestionRequest, withoutPermission } from "./session-request-tree"
import { goalModeActive, todoState } from "./session-goal-state"
export { goalModeActive, todoState } from "./session-goal-state"

export function createSessionComposerState(options?: { closeMs?: number | (() => number); working?: () => boolean }) {
  const params = useParams()
  const sdk = useSDK()
  const sync = useSync()
  const globalSync = useGlobalSync()
  const language = useLanguage()

  const questionRequest = createMemo((): QuestionRequest | undefined => {
    return sessionQuestionRequest(sync.data.session, sync.data.question, params.id)
  })

  const permissionRequest = createMemo((): PermissionRequest | undefined =>
    sessionPermissionRequest(sync.data.session, sync.data.permission, params.id),
  )

  const blocked = createMemo(() => {
    const id = params.id
    if (!id) return false
    return !!permissionRequest() || !!questionRequest()
  })

  const todos = createMemo((): Todo[] => {
    const id = params.id
    if (!id) return []
    return globalSync.data.session_todo[id] ?? []
  })

  const done = createMemo(
    () => todos().length > 0 && todos().every((todo) => todo.status === "completed" || todo.status === "cancelled"),
  )

  // 运行态由 session 页面统一按消息/part 语义计算；这里不再直接依赖 session_status，
  // 否则失败回合的残留 busy 会让底部 dock 和输入框表现不一致。
  const live = createMemo(() => !!options?.working?.() || blocked())

  const goal = createMemo((): Goal | undefined => {
    const id = params.id
    if (!id) return undefined
    return globalSync.data.session_goal[id]
  })

  const goalStatus = createMemo((): GoalStatus | undefined => goal()?.status)

  const [store, setStore] = createStore({
    responding: undefined as string | undefined,
    // 初始值保持惰性，挂载后的 effect 会立即用 todos/live 校准；
    // 避免页面初始化阶段过早读取外部 working 闭包。
    dock: false,
    closing: false,
    opening: false,
    pendingGoalObjective: undefined as string | undefined,
  })

  const isGoalModeActive = createMemo(() =>
    goalModeActive({ goal: goal(), pendingObjective: store.pendingGoalObjective }),
  )

  const permissionResponding = createMemo(() => {
    const perm = permissionRequest()
    if (!perm) return false
    return store.responding === perm.id
  })

  const decide = (response: "once" | "always" | "reject") => {
    const perm = permissionRequest()
    if (!perm) return
    if (store.responding === perm.id) return

    setStore("responding", perm.id)
    sdk.client.permission
      .respond({ sessionID: perm.sessionID, permissionID: perm.id, response })
      .then(() => {
        // respond 返回成功即代表服务端已解决（或本就无 pending 的孤儿态，路由仍回 200）。
        // 不等 permission.replied 事件，直接从本地 store 摘掉这条，按钮在任何情况下都立即生效。
        // 与事件归约里的 splice 幂等：随后若 permission.replied 到达，Binary.search 找不到即 no-op。
        const [, setChild] = globalSync.child(sdk.directory, { bootstrap: false })
        setChild("permission", perm.sessionID, (list) =>
          withoutPermission(list as PermissionRequest[] | undefined, perm.id),
        )
      })
      .catch((err: unknown) => {
        const description = err instanceof Error ? err.message : String(err)
        showToast({ title: language.t("common.requestFailed"), description })
      })
      .finally(() => {
        setStore("responding", (id) => (id === perm.id ? undefined : id))
      })
  }

  let timer: number | undefined
  let raf: number | undefined

  const closeMs = () => {
    const value = options?.closeMs
    if (typeof value === "function") return Math.max(0, value())
    if (typeof value === "number") return Math.max(0, value)
    return 400
  }

  const scheduleClose = () => {
    if (timer) window.clearTimeout(timer)
    timer = window.setTimeout(() => {
      setStore({ dock: false, closing: false })
      timer = undefined
    }, closeMs())
  }

  // Progress 段的清空策略：
  //  - 前端不做任何自动擦除（无论 agent 进入 idle，还是用户发新消息）。
  //  - 唯一的覆盖时机是模型调 TodoWrite，由后端 update() 自带 delete + insert，
  //    pull 回前端时自然覆盖列表。
  //  - 模型不调 TodoWrite 时，列表保持上次状态供回看。

  createEffect(
    on(
      () => [todos().length, done(), live()] as const,
      ([count, complete, active]) => {
        if (raf) cancelAnimationFrame(raf)
        raf = undefined

        const next = todoState({
          count,
          done: complete,
          live: active,
        })

        if (next === "hide") {
          if (timer) window.clearTimeout(timer)
          timer = undefined
          setStore({ dock: false, closing: false, opening: false })
          return
        }

        if (next === "open") {
          if (timer) window.clearTimeout(timer)
          timer = undefined
          const hidden = !store.dock || store.closing
          setStore({ dock: true, closing: false })
          if (hidden) {
            setStore("opening", true)
            raf = requestAnimationFrame(() => {
              setStore("opening", false)
              raf = undefined
            })
            return
          }
          setStore("opening", false)
          return
        }

        setStore({ dock: true, opening: false, closing: true })
        if (!timer) scheduleClose()
      },
    ),
  )

  onCleanup(() => {
    if (!timer) return
    window.clearTimeout(timer)
  })

  onCleanup(() => {
    if (!raf) return
    cancelAnimationFrame(raf)
  })

  return {
    blocked,
    questionRequest,
    permissionRequest,
    permissionResponding,
    decide,
    todos,
    goal,
    goalStatus,
    isGoalModeActive,
    pendingGoalObjective: () => store.pendingGoalObjective,
    setPendingGoalObjective: (value: string | undefined) => setStore("pendingGoalObjective", value),
    dock: () => store.dock,
    closing: () => store.closing,
    opening: () => store.opening,
  }
}

export type SessionComposerState = ReturnType<typeof createSessionComposerState>
