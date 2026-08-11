import type {
  Config,
  Goal,
  OpencodeClient,
  Path,
  Project,
  ProviderAuthResponse,
  ProviderListResponse,
  Todo,
} from "@opencode-ai/sdk/v2/client"
import { showToast } from "@opencode-ai/ui/toast"
import { getFilename } from "@opencode-ai/core/util/path"
import { batch, createContext, createMemo, getOwner, onCleanup, onMount, type ParentProps, untrack, useContext } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import { useLanguage } from "@/context/language"
import type { InitError } from "../pages/error"
import { useGlobalSDK } from "./global-sdk"
import {
  bootstrapDirectory,
  bootstrapGlobal,
  clearProviderRev,
  loadGlobalConfigQuery,
  loadPathQuery,
  loadProvidersQuery,
} from "./global-sync/bootstrap"
import { createChildStoreManager } from "./global-sync/child-store"
import { applyDirectoryEvent, applyGlobalEvent, cleanupDroppedSessionCaches } from "./global-sync/event-reducer"
import { createPermissionReviewLifecycle } from "./global-sync/permission-review-lifecycle"
import { clearSessionPrefetchDirectory } from "./global-sync/session-prefetch"
import { estimateRootSessionTotal, loadRootSessionsWithFallback } from "./global-sync/session-load"
import { trimSessions } from "./global-sync/session-trim"
import type { ProjectMeta } from "./global-sync/types"
import { SESSION_RECENT_LIMIT } from "./global-sync/types"
import { resolveError } from "@opencode-ai/core/error/resolve"
import { formatServerError } from "@/utils/server-errors"
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/solid-query"
import { createRefreshQueue } from "./global-sync/queue"
import { directoryKey, providerListWithFallback } from "./global-sync/utils"
import { isScratchSessionPath } from "@/utils/scratch"
import { clearPurchasePlansCache } from "./purchase-plans"

type GlobalStore = {
  ready: boolean
  error?: InitError
  path: Path
  project: Project[]
  session_todo: {
    [sessionID: string]: Todo[]
  }
  session_goal: {
    [sessionID: string]: Goal
  }
  provider: ProviderListResponse
  provider_auth: ProviderAuthResponse
  config: Config
  reload: undefined | "pending" | "complete"
}

// re-export query 工厂保持外部调用方 import 路径不变（实现见 global-sync-queries.ts）
import { loadLspQuery, loadMcpQuery, loadSessionsQueryKey, lspQueryKey, mcpQueryKey } from "./global-sync-queries"
export { loadLspQuery, loadMcpQuery, loadSessionsQueryKey, lspQueryKey, mcpQueryKey }

function createGlobalSync() {
  const globalSDK = useGlobalSDK()
  const language = useLanguage()
  const owner = getOwner()
  if (!owner) throw new Error("GlobalSync must be created within owner")

  const sdkCache = new Map<string, OpencodeClient>()
  const booting = new Map<string, Promise<void>>()
  const sessionLoads = new Map<string, Promise<void>>()
  const sessionMeta = new Map<string, { limit: number }>()
  const permissionReviewLifecycle = createPermissionReviewLifecycle()
  const queryClient = useQueryClient()

  const [configQuery, providerQuery, pathQuery] = useQueries(() => ({
    queries: [
      loadGlobalConfigQuery(globalSDK.client),
      loadProvidersQuery(null, globalSDK.client, queryClient),
      loadPathQuery(null, globalSDK.client),
    ],
  }))
  const backendConfigSnapshot = createMemo(() => {
    configQuery.dataUpdatedAt
    const config = untrack(() => configQuery.data)
    if (config === undefined) return
    return { ...config }
  })

  const [globalStore, setGlobalStore] = createStore<GlobalStore>({
    get ready() {
      return bootstrap.isPending
    },
    project: [],
    session_todo: {},
    session_goal: {},
    provider_auth: {},
    get path() {
      const EMPTY = { state: "", config: "", worktree: "", directory: "", home: "" }
      if (pathQuery.isLoading) return EMPTY
      return pathQuery.data ?? EMPTY
    },
    get provider() {
      const EMPTY = { all: [], connected: [], default: {} }
      return (
        providerListWithFallback({
          current: providerQuery.data,
          previous: queryClient.getQueryData<ProviderListResponse>([null, "providers"]),
        }) ?? EMPTY
      )
    },
    get config() {
      if (configQuery.isLoading) return {}
      return configQuery.data ?? {}
    },
    get reload() {
      return updateConfigMutation.isPending ? "pending" : undefined
    },
  })
  let bootedAt = 0
  let bootingRoot = false
  let eventFrame: number | undefined
  let eventTimer: ReturnType<typeof setTimeout> | undefined
  let permissionModeEventRevision = 0

  onCleanup(() => {
    if (eventFrame !== undefined) cancelAnimationFrame(eventFrame)
    if (eventTimer !== undefined) clearTimeout(eventTimer)
  })

  const setProjects = (next: Project[] | ((draft: Project[]) => Project[])) => {
    setGlobalStore("project", next)
  }

  const setBootStore = ((...input: unknown[]) => {
    if (input[0] === "project" && Array.isArray(input[1])) {
      setProjects(input[1] as Project[])
      return input[1]
    }
    return (setGlobalStore as (...args: unknown[]) => unknown)(...input)
  }) as typeof setGlobalStore

  const bootstrap = useQuery(() => ({
    queryKey: ["bootstrap"],
    queryFn: async () => {
      await bootstrapGlobal({
        globalSDK: globalSDK.client,
        requestFailedTitle: language.t("common.requestFailed"),
        translate: language.t,
        formatMoreCount: (count) => language.t("common.moreCountSuffix", { count }),
        setGlobalStore: setBootStore,
        queryClient,
      })
      bootedAt = Date.now()
      return bootedAt
    },
  }))

  const set = ((...input: unknown[]) => {
    if (input[0] === "project" && (Array.isArray(input[1]) || typeof input[1] === "function")) {
      setProjects(input[1] as Project[] | ((draft: Project[]) => Project[]))
      return input[1]
    }
    return (setGlobalStore as (...args: unknown[]) => unknown)(...input)
  }) as typeof setGlobalStore

  const setSessionTodo = (sessionID: string, todos: Todo[] | undefined) => {
    if (!sessionID) return
    if (!todos) {
      setGlobalStore(
        "session_todo",
        produce((draft) => {
          delete draft[sessionID]
        }),
      )
      return
    }
    setGlobalStore("session_todo", sessionID, reconcile(todos, { key: "id" }))
  }

  const setSessionGoal = (sessionID: string, goal: Goal | undefined) => {
    if (!sessionID) return
    if (!goal) {
      setGlobalStore(
        "session_goal",
        produce((draft) => {
          delete draft[sessionID]
        }),
      )
      return
    }
    setGlobalStore("session_goal", sessionID, reconcile(goal))
  }

  const paused = () => untrack(() => globalStore.reload) !== undefined

  const refetchProviderQueries = async () => {
    const isProviderQuery = (query: { queryKey: readonly unknown[] }) => query.queryKey[1] === "providers"
    await queryClient.fetchQuery({
      ...loadProvidersQuery(null, globalSDK.client, queryClient),
      staleTime: 0,
    })
    await queryClient.refetchQueries({
      predicate: (query) => isProviderQuery(query) && query.queryKey[0] !== null,
      type: "all",
    })
  }

  const queue = createRefreshQueue({
    paused,
    key: directoryKey,
    bootstrap: () => queryClient.fetchQuery({ queryKey: ["bootstrap"] }),
    bootstrapInstance,
  })

  const sdkFor = (directory: string) => {
    const key = directoryKey(directory)
    const cached = sdkCache.get(key)
    if (cached) return cached
    const sdk = globalSDK.createClient({
      directory,
      throwOnError: true,
    })
    sdkCache.set(key, sdk)
    return sdk
  }

  const children = createChildStoreManager({
    owner,
    isBooting: (directory) => booting.has(directory),
    isLoadingSessions: (directory) => sessionLoads.has(directory),
    onBootstrap: (directory) => {
      void bootstrapInstance(directory)
    },
    onDispose: (directory) => {
      const key = directoryKey(directory)
      queue.clear(key)
      sessionMeta.delete(key)
      sdkCache.delete(key)
      clearProviderRev(key)
      clearSessionPrefetchDirectory(key)
      permissionReviewLifecycle.clearDirectory(key)
    },
    translate: language.t,
    getSdk: sdkFor,
    queryClient,
    global: {
      provider: () => globalStore.provider,
    },
  })

  // 强制让某 directory 的 session 列表重新从服务端拉取
  // 场景：跨目录 fork（worktree fork）让源项目下出现了新会话，但 query 缓存命中旧结果，sidebar 不会显示
  async function refreshSessions(directory: string) {
    const key = directoryKey(directory)
    sessionMeta.delete(key)
    await queryClient.invalidateQueries({ queryKey: loadSessionsQueryKey(key) })
    await loadSessions(directory)
  }

  async function loadSessions(directory: string) {
    const key = directoryKey(directory)
    const pending = sessionLoads.get(key)
    if (pending) return pending

    children.pin(key)
    const [store, setStore] = children.child(directory, { bootstrap: false })
    const meta = sessionMeta.get(key)
    if (meta && meta.limit >= store.limit) {
      const next = trimSessions(store.session, {
        limit: store.limit,
        permission: store.permission,
      })
      if (next.length !== store.session.length) {
        setStore("session", reconcile(next, { key: "id" }))
        cleanupDroppedSessionCaches(
          store,
          setStore,
          next,
          setSessionTodo,
          setSessionGoal,
          (sessionID) => permissionReviewLifecycle.clearSession(key, sessionID),
        )
      }
      children.unpin(key)
      return
    }

    const limit = Math.max(store.limit + SESSION_RECENT_LIMIT, SESSION_RECENT_LIMIT)
    const promise = queryClient
      .fetchQuery({
        queryKey: loadSessionsQueryKey(key),
        queryFn: () =>
          loadRootSessionsWithFallback({
            directory,
            limit,
            list: (query) => globalSDK.client.session.list(query),
          })
            .then((x) => {
              const nonArchived = (x.data ?? [])
                .filter((s) => !!s?.id)
                .filter((s) => !s.time?.archived)
                .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
              const limit = store.limit
              const childSessions = store.session.filter((s) => !!s.parentID)
              const sessions = trimSessions([...nonArchived, ...childSessions], {
                limit,
                permission: store.permission,
              })
              batch(() => {
                setStore(
                  "sessionTotal",
                  estimateRootSessionTotal({
                    count: nonArchived.length,
                    limit: x.limit,
                    limited: x.limited,
                  }),
                )
                setStore("session", reconcile(sessions, { key: "id" }))
                cleanupDroppedSessionCaches(
                  store,
                  setStore,
                  sessions,
                  setSessionTodo,
                  setSessionGoal,
                  (sessionID) => permissionReviewLifecycle.clearSession(key, sessionID),
                )
              })
              sessionMeta.set(key, { limit })
            })
            .catch((err) => {
              console.error("Failed to load sessions", err)
              if (isScratchSessionPath(directory)) return
              const project = getFilename(directory)
              // 用 resolveError 精确分类后端认证/权益/额度错误；其余保留 formatServerError 兜底
              const sessionListResolved = resolveError(err)
              showToast({
                variant: "error",
                title: language.t("toast.session.listFailed.title", { project }),
                description: sessionListResolved.category !== "unknown"
                  ? language.t(sessionListResolved.messageKey as any)
                  : formatServerError(err, language.t),
              })
            })
            .then(() => null),
      })
      .then(() => {})

    sessionLoads.set(key, promise)
    void promise.finally(() => {
      sessionLoads.delete(key)
      children.unpin(key)
    })
    return promise
  }

  async function bootstrapInstance(directory: string) {
    const key = directoryKey(directory)
    if (!key) return
    const pending = booting.get(key)
    if (pending) return pending

    children.pin(key)
    const promise = Promise.resolve().then(async () => {
      const child = children.ensureChild(directory)
      const cache = children.vcsCache.get(key)
      if (!cache) return
      const sdk = sdkFor(directory)
      await bootstrapDirectory({
        directory,
        global: {
          config: globalStore.config,
          path: globalStore.path,
          project: globalStore.project,
          provider: globalStore.provider,
        },
        sdk,
        store: child[0],
        setStore: child[1],
        vcsCache: cache,
        loadSessions,
        translate: language.t,
        queryClient,
      })
    })

    booting.set(key, promise)
    void promise.finally(() => {
      booting.delete(key)
      children.unpin(key)
    })
    return promise
  }

  const unsub = globalSDK.event.listen((e) => {
    const directory = e.name
    const key = directoryKey(directory)
    const event = e.details
    const recent = bootingRoot || Date.now() - bootedAt < 1500

    if (directory === "global") {
      applyGlobalEvent({
        event,
        project: globalStore.project,
        refresh: () => {
          if (recent) return
          bootstrap.refetch()
        },
        refreshConfig: () => {
          void configQuery.refetch()
        },
        setGlobalProject: setProjects,
        setConfigMode: (mode) => {
          permissionModeEventRevision += 1
          setGlobalStore("config", "permission_mode", mode)
        },
      })
      // 登录、退出登录和切换账号都会 dispose 全局实例；必须先清套餐，不能被启动期 recent 分支提前返回。
      if (event.type === "global.disposed") clearPurchasePlansCache(queryClient)
      if (event.type === "server.connected" || event.type === "global.disposed") {
        if (recent) return
        void refetchProviderQueries().catch((error) => console.error("Failed to refresh providers", error))
        for (const directory of Object.keys(children.children)) {
          queue.push(directory)
        }
      }
      const userCenterEvent = event as { type?: string; properties?: { resources?: string[] } }
      // 套餐缓存可能包含上一账号的购买地址；登录失效时立即删除，禁止跨账号复用。
      if (userCenterEvent.type === "wanlaicode.user-center.auth.expired") clearPurchasePlansCache(queryClient)
      if (userCenterEvent.type === "wanlaicode.user-center.changed") {
        const resources = new Set(
          (userCenterEvent.properties?.resources?.length ? userCenterEvent.properties.resources : ["status"])
            .map((item) => item.trim().toLowerCase())
            .filter(Boolean),
        )
        // 套餐或身份变化后让下一位消费者重新获取；普通页面切换继续命中同一份缓存。
        if (resources.has("purchase_plans") || resources.has("status")) clearPurchasePlansCache(queryClient)
        if (
          resources.has("models") ||
          resources.has("providers") ||
          resources.has("entitlements") ||
          resources.has("api_key") ||
          resources.has("status")
        ) {
          void refetchProviderQueries().catch((error) => console.error("Failed to refresh providers", error))
        }
      }
      return
    }

    const existing = children.children[key]
    if (!existing) return
    children.mark(key)
    const [store, setStore] = existing
    applyDirectoryEvent({
      event,
      directory,
      store,
      setStore,
      push: queue.push,
      setSessionTodo,
      setSessionGoal,
      permissionReviewLifecycle,
      vcsCache: children.vcsCache.get(key),
      loadLsp: () => {
        void queryClient.fetchQuery(loadLspQuery(key, sdkFor(directory)))
      },
    })
  })

  onCleanup(unsub)
  onCleanup(() => {
    queue.dispose()
  })
  onCleanup(() => {
    permissionReviewLifecycle.dispose()
    for (const directory of Object.keys(children.children)) {
      children.disposeDirectory(directoryKey(directory))
    }
  })

  onMount(() => {
    if (typeof requestAnimationFrame === "function") {
      eventFrame = requestAnimationFrame(() => {
        eventFrame = undefined
        eventTimer = setTimeout(() => {
          eventTimer = undefined
          void globalSDK.event.start()
        }, 0)
      })
    } else {
      eventTimer = setTimeout(() => {
        eventTimer = undefined
        void globalSDK.event.start()
      }, 0)
    }
  })

  const projectApi = {
    loadSessions,
    refreshSessions,
    meta(directory: string, patch: ProjectMeta) {
      children.projectMeta(directory, patch)
    },
    icon(directory: string, value: string | undefined) {
      children.projectIcon(directory, value)
    },
  }

  const updateConfigMutation = useMutation(() => ({
    mutationFn: (config: Config) => globalSDK.client.global.config.update({ config }),
    onSuccess: async (_, config) => {
      if (config.provider || config.disabled_providers) {
        await refetchProviderQueries()
      }
      if (Object.keys(config).every((key) => key === "instruction_import" || key === "rules")) return
      await bootstrap.refetch()
    },
  }))

  return {
    data: globalStore,
    set,
    get ready() {
      return globalStore.ready
    },
    get error() {
      return globalStore.error
    },
    get permissionModeEventRevision() {
      return permissionModeEventRevision
    },
    get backendConfigReady() {
      return backendConfigSnapshot() !== undefined
    },
    get backendConfigSnapshot() {
      return backendConfigSnapshot()
    },
    child: children.child,
    peek: children.peek,
    // 只读已存在的 child store，不会 ensureChild 创建空 store / pin 引用——用于跨 store 兜底搜索
    hasChild: (directory: string) => !!children.children[directoryKey(directory)],
    // 已 bootstrap 的所有 child store directory key 列表——用于跨 store 找 session
    childDirectories: () => Object.keys(children.children),
    // bootstrap,
    updateConfig: updateConfigMutation.mutateAsync,
    config: {
      get loading() {
        return configQuery.isLoading
      },
      get error() {
        return configQuery.isError
      },
      refetch: configQuery.refetch,
    },
    project: projectApi,
    todo: {
      set: setSessionTodo,
    },
    goal: {
      set: setSessionGoal,
    },
  }
}

const GlobalSyncContext = createContext<ReturnType<typeof createGlobalSync>>()

export function GlobalSyncProvider(props: ParentProps) {
  const value = createGlobalSync()
  return <GlobalSyncContext.Provider value={value}>{props.children}</GlobalSyncContext.Provider>
}

export function useGlobalSync() {
  const context = useContext(GlobalSyncContext)
  if (!context) throw new Error("useGlobalSync must be used within GlobalSyncProvider")
  return context
}
