import { createSimpleContext } from "@opencode-ai/ui/context"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { useParams } from "@solidjs/router"
import { batch, createEffect, createMemo, on, untrack } from "solid-js"
import { createStore, produce, type SetStoreFunction } from "solid-js/store"
import { useModels } from "@/context/models"
import { isWanlaiCodeNoEntitlementProvider, useProviders } from "@/hooks/use-providers"
import { isFreeModel } from "@/components/model-filter"
import { Persist, persisted, scopedInstance } from "@/utils/persist"
import { cycleModelVariant, getConfiguredAgentVariant, resolveModelVariant } from "./model-variant"
import { resolveModelSwitchNotice } from "./model-switch-notice"
import { useSDK } from "./sdk"
import { useSync } from "./sync"

export type ModelKey = { providerID: string; modelID: string; variant?: string }

export type PendingSessionModel = {
  sessionID: string
  directory: string
  model: ModelKey
  version: number
}

export type ModelSwitchNotice = {
  afterMessageID: string
  from: ModelKey
  to: ModelKey
}

type State = {
  agent?: string
  model?: ModelKey
  variant?: string | null
  modelSwitchNotice?: ModelSwitchNotice
}

type Saved = {
  session: Record<string, State | undefined>
}

const WORKSPACE_KEY = "__workspace__"
const handoff = new Map<string, State>()

const handoffKey = (dir: string, id: string) => `${dir}\n${id}`

const migrate = (value: unknown) => {
  if (!value || typeof value !== "object") return { session: {} }

  const item = value as {
    session?: Record<string, State | undefined>
    pick?: Record<string, State | undefined>
  }

  if (item.session && typeof item.session === "object") return { session: item.session }
  if (!item.pick || typeof item.pick !== "object") return { session: {} }

  return {
    session: Object.fromEntries(Object.entries(item.pick).filter(([key]) => key !== WORKSPACE_KEY)),
  }
}

const clone = (value: State | undefined) => {
  if (!value) return undefined
  return {
    ...value,
    model: value.model ? { ...value.model } : undefined,
    modelSwitchNotice: value.modelSwitchNotice
      ? {
          afterMessageID: value.modelSwitchNotice.afterMessageID,
          from: { ...value.modelSwitchNotice.from },
          to: { ...value.modelSwitchNotice.to },
        }
      : undefined,
  } satisfies State
}

// 模型与 variant 一起比较，避免只看 modelID 时把远端推理档位更新误判为重复事件。
const sameModelKey = (left: ModelKey | undefined, right: ModelKey | undefined) =>
  left?.providerID === right?.providerID &&
  left?.modelID === right?.modelID &&
  (left?.variant ?? undefined) === (right?.variant ?? undefined)

export function resolvePendingModelSync(pending: PendingSessionModel | undefined, sessionID: string, model: ModelKey) {
  // 只有同一会话的 pending 才能拦截旧服务端事件；其他会话始终采用自己的服务端模型。
  if (!pending || pending.sessionID !== sessionID) return "apply" as const
  if (sameModelKey(pending.model, model)) return "confirm" as const
  return "defer" as const
}

export function retainDeferredServerModel(
  baselines: Map<string, ModelKey | undefined>,
  key: string,
  action: ReturnType<typeof resolvePendingModelSync>,
  model: ModelKey,
) {
  // pending 期间收到的不匹配模型仍是最新服务端事实；本地 PATCH 失败时必须优先回到它。
  if (action === "defer") baselines.set(key, model)
}

export function enqueueSessionModelTask<T>(queues: Map<string, Promise<void>>, key: string, task: () => Promise<T>) {
  const previous = queues.get(key) ?? Promise.resolve()
  // 同一会话的模型 PATCH 严格按用户操作顺序执行，不同 key 仍保持并行。
  const request = previous.then(task, task)
  const tail = request.then(
    () => undefined,
    () => undefined,
  )
  queues.set(key, tail)
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key)
  })
  return request
}

export const { use: useLocal, provider: LocalProvider } = createSimpleContext({
  name: "Local",
  init: () => {
    const params = useParams()
    const sdk = useSDK()
    const sync = useSync()
    const providers = useProviders()
    const models = useModels()

    const id = createMemo(() => params.id || undefined)
    const list = createMemo(() => sync.data.agent.filter((item) => item.mode !== "subagent" && !item.hidden))
    const connected = createMemo(() => new Set(providers.connected().map((item) => item.id)))

    // 按目录重键 + Proxy 透传：常驻树下 directory 是运行期信号，模型选择随目录切换
    const savedScoped = scopedInstance(
      () => sdk.directory,
      (dir) =>
        persisted(
          {
            ...Persist.workspace(dir, "model-selection", ["model-selection.v1"]),
            migrate,
          },
          createStore<Saved>({
            session: {},
          }),
        ),
    )
    const saved = new Proxy({} as Saved, {
      get: (_, key) => (savedScoped()[0] as Record<PropertyKey, unknown>)[key],
    }) as Saved
    const setSaved = ((...args: unknown[]) =>
      (savedScoped()[1] as (...a: unknown[]) => void)(...args)) as SetStoreFunction<Saved>

    const [store, setStore] = createStore<{
      current?: string
      draft?: State
      last?: {
        type: "agent" | "model" | "variant"
        agent?: string
        model?: ModelKey | null
        variant?: string | null
      }
      // 每个目录/会话独立保存 pending，路由切换不能丢失仍在执行的 A 会话请求。
      pendingModels: Record<string, PendingSessionModel | undefined>
    }>({
      current: list()[0]?.name,
      draft: undefined,
      last: undefined,
      pendingModels: {},
    })
    const sessionModelQueues = new Map<string, Promise<void>>()
    const sessionModelVersions = new Map<string, number>()
    const sessionModelBaseline = new Map<string, ModelKey | undefined>()
    const deferredSessionModelRollback = new Map<string, ModelKey | undefined>()

    // 常驻树下这些瞬态选择（新建页模型/Agent 草稿）不随组件重建，切目录时显式重置，
    // 避免 A 项目新建页的选择带进 B 项目
    createEffect(
      on(
        () => sdk.directory,
        () => {
          setStore({ current: list()[0]?.name, draft: undefined, last: undefined })
        },
        { defer: true },
      ),
    )

    const validModel = (model: ModelKey) => {
      const provider = providers.all().find((item) => item.id === model.providerID)
      if (provider && isWanlaiCodeNoEntitlementProvider(provider)) {
        const info = provider.models[model.modelID]
        return !!info && connected().has(model.providerID)
      }
      return !!provider?.models[model.modelID] && connected().has(model.providerID)
    }

    const firstModel = (...items: Array<() => ModelKey | undefined>) => {
      for (const item of items) {
        const model = item()
        if (!model) continue
        if (validModel(model)) return model
      }
    }

    const pickAgent = (name: string | undefined) => {
      const items = list()
      if (items.length === 0) return undefined
      return items.find((item) => item.name === name) ?? items[0]
    }

    createEffect(() => {
      const items = list()
      if (items.length === 0) {
        if (store.current !== undefined) setStore("current", undefined)
        return
      }
      if (items.some((item) => item.name === store.current)) return
      setStore("current", items[0]?.name)
    })

    const scope = createMemo<State | undefined>(() => {
      const session = id()
      if (!session) return store.draft
      return saved.session[session] ?? handoff.get(handoffKey(sdk.directory, session))
    })

    function readServerSessionModel(sessionID: string) {
      // Promise 回调显式按请求会话读取，避免切到 B 后把 B 的当前模型回滚进 A。
      const model = sync.data.session.find((item) => item.id === sessionID)?.model
      if (!model) return undefined
      return {
        providerID: model.providerID,
        modelID: model.id,
        variant: model.variant,
      }
    }

    const serverSessionModel = createMemo<ModelKey | undefined>(() => {
      const sessionID = id()
      if (!sessionID) return undefined
      return readServerSessionModel(sessionID)
    })

    function applyServerSessionModel(sessionID: string, model: ModelKey) {
      const current = untrack(() => saved.session[sessionID])
      const selected = current?.model ? { ...current.model, variant: current.variant ?? undefined } : undefined
      if (sameModelKey(selected, model)) return
      // 手机切换模型后直接更新桌面持久化选择，下一条桌面消息和菜单显示都会采用新值。
      setSaved("session", sessionID, {
        ...(current ?? {}),
        model: { providerID: model.providerID, modelID: model.modelID },
        variant: model.variant ?? null,
      })
    }

    function restoreLocalSessionModel(sessionID: string, model: ModelKey | undefined) {
      if (model) {
        applyServerSessionModel(sessionID, model)
        return
      }
      const current = untrack(() => saved.session[sessionID])
      if (!current?.model && current?.variant == null) return
      // 旧会话在服务端尚无 model 时，失败回滚必须移除乐观显式值，让原有 Agent/工作区 fallback 重新生效。
      setSaved("session", sessionID, { ...(current ?? {}), model: undefined, variant: null })
    }

    function clearPendingSessionModel(key: string) {
      setStore(
        produce((draft) => {
          delete draft.pendingModels[key]
        }),
      )
    }

    function pruneSessionModelBaseline(key: string) {
      // Promise 队列的 tail 清理发生在当前回调之后，下一轮微任务再判断是否仍需保留回滚基线。
      void Promise.resolve().then(() => {
        if (sessionModelQueues.has(key) || store.pendingModels[key]) return
        sessionModelBaseline.delete(key)
      })
    }

    createEffect(() => {
      const sessionID = id()
      if (!sessionID) return
      const key = handoffKey(sdk.directory, sessionID)
      if (deferredSessionModelRollback.has(key)) {
        // 请求在其他目录页面失败时延迟写回，避免动态 saved proxy 把 A 的回滚误写进 B 的持久化空间。
        const rollback = deferredSessionModelRollback.get(key)
        deferredSessionModelRollback.delete(key)
        restoreLocalSessionModel(sessionID, rollback)
      }
      const model = serverSessionModel()
      if (!model) return
      const pending = untrack(() => store.pendingModels[key])
      const action = resolvePendingModelSync(pending, sessionID, model)
      retainDeferredServerModel(sessionModelBaseline, key, action, model)
      if (action === "defer") return
      // 同会话匹配事件只清理该 key；A 的确认不能删除 B 的进行中请求。
      if (action === "confirm") {
        clearPendingSessionModel(key)
        pruneSessionModelBaseline(key)
      }
      applyServerSessionModel(sessionID, model)
    })

    function persistSessionModel(sessionID: string, state: State, previousModel?: ModelKey) {
      if (!state.model) return
      const directory = sdk.directory
      const key = handoffKey(directory, sessionID)
      const next = {
        providerID: state.model.providerID,
        modelID: state.model.modelID,
        variant: state.variant ?? undefined,
      } satisfies ModelKey
      const version = (sessionModelVersions.get(key) ?? 0) + 1
      sessionModelVersions.set(key, version)
      deferredSessionModelRollback.delete(key)
      if (!sessionModelBaseline.has(key)) {
        // 首次请求优先使用服务端已确认值；旧会话尚无 Session.model 时回退到操作前的桌面选择。
        sessionModelBaseline.set(key, readServerSessionModel(sessionID) ?? previousModel)
      }
      setStore("pendingModels", key, { sessionID, directory, model: next, version })
      const request = enqueueSessionModelTask(sessionModelQueues, key, async () => {
        const response = await sdk.client.session.update({
          sessionID,
          directory,
          model: { id: next.modelID, providerID: next.providerID, variant: next.variant },
        })
        const model = response.data?.model
        // 每次成功都推进队列基线，随后较新的失败才能回到最近一次真正持久化的模型。
        sessionModelBaseline.set(
          key,
          model ? { providerID: model.providerID, modelID: model.id, variant: model.variant } : { ...next },
        )
        return response
      })
      void request
        .then((response) => {
          const pending = untrack(() => store.pendingModels[key])
          if (!pending || pending.version !== version) {
            pruneSessionModelBaseline(key)
            return
          }
          clearPendingSessionModel(key)
          // 回包属于旧目录时只完成状态机；重新进入该目录后由 session store 应用权威模型。
          if (directory === sdk.directory) {
            const model = response.data?.model
            if (model) {
              applyServerSessionModel(sessionID, {
                providerID: model.providerID,
                modelID: model.id,
                variant: model.variant,
              })
            }
          }
          pruneSessionModelBaseline(key)
        })
        .catch(() => {
          const pending = untrack(() => store.pendingModels[key])
          if (!pending || pending.version !== version) return
          clearPendingSessionModel(key)
          // 最新请求失败才回滚；旧请求失败后仍由队列中的更新继续决定最终状态。
          const baseline = sessionModelBaseline.get(key)
          if (directory === sdk.directory) restoreLocalSessionModel(sessionID, baseline)
          else deferredSessionModelRollback.set(key, baseline)
          pruneSessionModelBaseline(key)
        })
    }

    createEffect(() => {
      const session = id()
      if (!session) return

      const key = handoffKey(sdk.directory, session)
      const next = handoff.get(key)
      if (!next) return
      if (saved.session[session] !== undefined) {
        handoff.delete(key)
        return
      }

      setSaved("session", session, clone(next))
      handoff.delete(key)
    })

    const configuredModel = () => {
      if (!sync.data.config.model) return
      const [providerID, modelID] = sync.data.config.model.split("/")
      const model = { providerID, modelID }
      if (validModel(model)) return model
    }

    const recentModel = () => {
      for (const item of models.recent.list()) {
        if (validModel(item)) return item
      }
    }

    const defaultModel = () => {
      const defaults = providers.default()
      for (const provider of providers.connected()) {
        const configured = defaults[provider.id]
        if (configured) {
          const model = { providerID: provider.id, modelID: configured }
          if (validModel(model)) return model
        }

        const first = isWanlaiCodeNoEntitlementProvider(provider)
          ? (Object.values(provider.models).find((item) =>
              // main 的免费模型判定依赖后端倍率元数据；远控默认模型选择必须完整透传。
              isFreeModel({ id: item.id, provider, wanlaicode: item.wanlaicode }),
            ) ??
            Object.values(provider.models)[0])
          : Object.values(provider.models)[0]
        if (!first) continue
        const model = { providerID: provider.id, modelID: first.id }
        if (validModel(model)) return model
      }
    }

    const fallback = createMemo<ModelKey | undefined>(() => configuredModel() ?? recentModel() ?? defaultModel())

    const agent = {
      list,
      current() {
        return pickAgent(scope()?.agent ?? store.current)
      },
      set(name: string | undefined) {
        const previousModel = currentModelKey()
        const item = pickAgent(name)
        if (!item) {
          setStore("current", undefined)
          return
        }

        batch(() => {
          setStore("current", item.name)
          setStore("last", {
            type: "agent",
            agent: item.name,
            model: item.model,
            variant: item.variant ?? null,
          })
          const prev = scope()
          const next = {
            agent: item.name,
            model: item.model ?? prev?.model,
            variant: item.variant ?? prev?.variant,
          } satisfies State
          const session = id()
          if (session) {
            setSaved("session", session, next)
            persistSessionModel(session, next, previousModel)
            return
          }
          setStore("draft", next)
        })
      },
      move(direction: 1 | -1) {
        const items = list()
        if (items.length === 0) {
          setStore("current", undefined)
          return
        }

        let next = items.findIndex((item) => item.name === agent.current()?.name) + direction
        if (next < 0) next = items.length - 1
        if (next >= items.length) next = 0
        const item = items[next]
        if (!item) return
        agent.set(item.name)
      },
    }

    const current = () => {
      const item = firstModel(
        () => scope()?.model,
        () => agent.current()?.model,
        fallback,
      )
      if (!item) return undefined
      return models.find(item)
    }

    const currentModelKey = () => {
      const item = current()
      if (!item) return undefined
      return {
        providerID: item.provider.id,
        modelID: item.id,
        variant: scope()?.variant ?? undefined,
      } satisfies ModelKey
    }

    const configured = () => {
      const item = agent.current()
      const model = current()
      if (!item || !model) return undefined
      return getConfiguredAgentVariant({
        agent: { model: item.model, variant: item.variant },
        model: { providerID: model.provider.id, modelID: model.id, variants: model.variants },
      })
    }

    const selected = () => scope()?.variant

    const snapshot = () => {
      const model = current()
      return {
        agent: agent.current()?.name,
        model: model ? { providerID: model.provider.id, modelID: model.id } : undefined,
        variant: selected(),
      } satisfies State
    }

    const write = (next: Partial<State>) => {
      const previousModel = currentModelKey()
      const state = {
        ...(scope() ?? { agent: agent.current()?.name }),
        ...next,
      } satisfies State

      const session = id()
      if (session) {
        setSaved("session", session, state)
        persistSessionModel(session, state, previousModel)
        return
      }
      setStore("draft", state)
    }

    const recent = createMemo(() => models.recent.list().map(models.find).filter(Boolean))

    const model = {
      ready: models.ready,
      current,
      recent,
      list: models.list,
      cycle(direction: 1 | -1) {
        const items = recent()
        const item = current()
        if (!item) return

        const index = items.findIndex((entry) => entry?.provider.id === item.provider.id && entry?.id === item.id)
        if (index === -1) return

        let next = index + direction
        if (next < 0) next = items.length - 1
        if (next >= items.length) next = 0

        const entry = items[next]
        if (!entry) return
        model.set({ providerID: entry.provider.id, modelID: entry.id })
      },
      set(item: ModelKey | undefined, options?: { recent?: boolean; afterMessageID?: string }) {
        batch(() => {
          const prev = current()
          const from = prev ? { providerID: prev.provider.id, modelID: prev.id } : undefined
          setStore("last", {
            type: "model",
            agent: agent.current()?.name,
            model: item ?? null,
            variant: selected(),
          })
          const action = resolveModelSwitchNotice({ from, to: item, afterMessageID: options?.afterMessageID })
          if (action.type === "create") write({ model: item, modelSwitchNotice: action.notice })
          else if (action.type === "clear") write({ model: item, modelSwitchNotice: undefined })
          else write({ model: item })
          if (!item) return
          models.setVisibility(item, true)
          if (!options?.recent) return
          models.recent.push(item)
        })
      },
      visible(item: ModelKey) {
        return models.visible(item)
      },
      setVisibility(item: ModelKey, visible: boolean) {
        models.setVisibility(item, visible)
      },
      variant: {
        configured,
        selected,
        current() {
          return resolveModelVariant({
            variants: this.list(),
            selected: this.selected(),
            configured: this.configured(),
          })
        },
        list() {
          const item = current()
          if (!item?.variants) return []
          return Object.keys(item.variants)
        },
        set(value: string | undefined) {
          batch(() => {
            const model = current()
            setStore("last", {
              type: "variant",
              agent: agent.current()?.name,
              model: model ? { providerID: model.provider.id, modelID: model.id } : null,
              variant: value ?? null,
            })
            write({ variant: value ?? null })
            // 目录级选择之外再记一份按 provider/model 的全局档位，
            // 供离开目录后只剩全局 recent 可用的场景（如快捷聊天）恢复推理档位。
            if (model) models.variant.set({ providerID: model.provider.id, modelID: model.id }, value)
          })
        },
        cycle() {
          const items = this.list()
          if (items.length === 0) return
          this.set(
            cycleModelVariant({
              variants: items,
              selected: this.selected(),
              configured: this.configured(),
            }),
          )
        },
      },
    }

    const result = {
      slug: createMemo(() => base64Encode(sdk.directory)),
      model,
      modelSwitchNotice: () => scope()?.modelSwitchNotice,
      agent,
      session: {
        reset() {
          setStore("draft", undefined)
        },
        promote(dir: string, session: string) {
          const next = clone(snapshot())
          if (!next) return

          if (dir === sdk.directory) {
            setSaved("session", session, next)
            setStore("draft", undefined)
            return
          }

          handoff.set(handoffKey(dir, session), next)
          setStore("draft", undefined)
        },
        restore(msg: { sessionID: string; agent: string; model: ModelKey }) {
          const session = id()
          if (!session) return
          if (msg.sessionID !== session) return
          if (saved.session[session] !== undefined) return
          if (handoff.has(handoffKey(sdk.directory, session))) return

          setSaved("session", session, {
            agent: msg.agent,
            model: msg.model,
            variant: msg.model?.variant ?? null,
          })
        },
      },
    }
    return result
  },
})
