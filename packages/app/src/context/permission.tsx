import { createEffect, createMemo, onCleanup } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { createSimpleContext } from "@opencode-ai/ui/context"
import type { PermissionRequest } from "@opencode-ai/sdk/v2/client"
import { Persist, persisted } from "@/utils/persist"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "./global-sync"
import { useParams } from "@solidjs/router"
import { decode64 } from "@/utils/base64"
import {
  acceptKey,
  directoryAcceptKey,
  isDirectoryAutoAccepting,
  autoRespondsPermission,
  autoReviewCacheSnapshot,
  ensureAutoReviewBaseline,
  legacySessionAutoReviewMigration,
  pendingAutoReviewIntent,
  recordAutoReviewPersisted,
  restoreAutoReviewCache,
  takeAutoReviewBaseline,
  type AutoReviewCacheSnapshot,
  type PendingAutoReviewAuthority,
  REMOTE_AUTO_REVIEW_PERMISSION,
  remoteAutoReviewMode,
} from "./permission-auto-respond"

type PermissionRespondFn = (input: {
  sessionID: string
  permissionID: string
  response: "once" | "always" | "reject"
  directory?: string
}) => void

export type PermissionMode = "ask" | "auto_review" | "full_access"

export function resolvePermissionMode(value: unknown): PermissionMode {
  if (value === "ask" || value === "auto_review" || value === "full_access") return value
  return "auto_review"
}

function isNonAllowRule(rule: unknown) {
  if (!rule) return false
  if (typeof rule === "string") return rule !== "allow"
  if (typeof rule !== "object") return false
  if (Array.isArray(rule)) return false

  for (const action of Object.values(rule)) {
    if (action !== "allow") return true
  }

  return false
}

function hasPermissionPromptRules(permission: unknown) {
  if (!permission) return false
  if (typeof permission === "string") return permission !== "allow"
  if (typeof permission !== "object") return false
  if (Array.isArray(permission)) return false

  const config = permission as Record<string, unknown>
  return Object.values(config).some(isNonAllowRule)
}

export const { use: usePermission, provider: PermissionProvider } = createSimpleContext({
  name: "Permission",
  init: () => {
    const params = useParams()
    const globalSDK = useGlobalSDK()
    const globalSync = useGlobalSync()

    // 权限模式的本地选择保持乐观显示，但只有最新一次后端写入成功后才确认；
    // 这样快速切换与远端配置事件不会把旧请求的结果覆盖到当前选择。
    const readMode = () => resolvePermissionMode(globalSync.data.config.permission_mode)
    let confirmedMode = globalSync.backendConfigReady
      ? resolvePermissionMode(globalSync.backendConfigSnapshot?.permission_mode)
      : undefined
    let confirmedEventRevision = globalSync.permissionModeEventRevision
    let observedBackendConfigReady = globalSync.backendConfigReady
    let observedBackendConfigSnapshot = globalSync.backendConfigSnapshot
    let latestModeRequest = 0
    let latestSelectedMode = confirmedMode ?? readMode()
    let fallbackMode = latestSelectedMode
    let pendingModeRequests = 0
    let modeWrite = Promise.resolve()
    let latestModeWrite = Promise.resolve()

    const syncConfirmedMode = () => {
      const eventChanged = confirmedEventRevision !== globalSync.permissionModeEventRevision
      const snapshotChanged =
        globalSync.backendConfigReady &&
        (!observedBackendConfigReady || observedBackendConfigSnapshot !== globalSync.backendConfigSnapshot)
      observedBackendConfigReady = globalSync.backendConfigReady
      observedBackendConfigSnapshot = globalSync.backendConfigSnapshot

      if (eventChanged) {
        confirmedEventRevision = globalSync.permissionModeEventRevision
        confirmedMode = readMode()
      }
      if (!eventChanged && snapshotChanged) {
        confirmedMode = resolvePermissionMode(globalSync.backendConfigSnapshot?.permission_mode)
      }
      if (!eventChanged && !snapshotChanged) return
      if (pendingModeRequests > 0) {
        globalSync.set("config", "permission_mode", latestSelectedMode)
        return
      }
      latestSelectedMode = confirmedMode ?? fallbackMode
      fallbackMode = latestSelectedMode
      globalSync.set("config", "permission_mode", latestSelectedMode)
    }

    const mode = () => {
      syncConfirmedMode()
      if (pendingModeRequests > 0) return latestSelectedMode
      return readMode()
    }

    const settleModeRequest = (request: number) => {
      pendingModeRequests -= 1
      if (request !== latestModeRequest) {
        globalSync.set("config", "permission_mode", latestSelectedMode)
        return
      }
      latestSelectedMode = confirmedMode ?? fallbackMode
      fallbackMode = latestSelectedMode
      globalSync.set("config", "permission_mode", latestSelectedMode)
    }

    const permissionsEnabled = createMemo(() => {
      const directory = decode64(params.dir)
      if (!directory) return false
      const [store] = globalSync.child(directory)
      return hasPermissionPromptRules(store.config.permission)
    })

    const [store, setStore, _, ready] = persisted(
      {
        ...Persist.global("permission", ["permission.v3"]),
        migrate(value) {
          if (!value || typeof value !== "object" || Array.isArray(value)) return value

          const data = value as Record<string, unknown>
          if (data.autoAccept) return value

          return {
            ...data,
            autoAccept:
              typeof data.autoAcceptEdits === "object" && data.autoAcceptEdits && !Array.isArray(data.autoAcceptEdits)
                ? data.autoAcceptEdits
                : {},
          }
        },
      },
      createStore({
        autoAccept: {} as Record<string, boolean>,
      }),
    )

    // When config has permission: "allow", auto-enable directory-level auto-accept
    createEffect(() => {
      if (!ready()) return
      const directory = decode64(params.dir)
      if (!directory) return
      const [childStore] = globalSync.child(directory)
      const perm = childStore.config.permission
      if (typeof perm === "string" && perm === "allow") {
        const key = directoryAcceptKey(directory)
        if (store.autoAccept[key] === undefined) {
          setStore(
            produce((draft) => {
              draft.autoAccept[key] = true
            }),
          )
        }
      }
    })

    const MAX_RESPONDED = 1000
    const RESPONDED_TTL_MS = 60 * 60 * 1000
    const responded = new Map<string, number>()
    const authorityVersion = new Map<string, number>()
    const sessionAutoReviewQueue = new Map<string, Promise<void>>()
    const sessionAutoReviewBaseline = new Map<string, AutoReviewCacheSnapshot>()
    // 每个会话独立保存切换中的权威覆盖，避免 A 会话的 PATCH 状态影响 B 会话权限判断。
    const [pendingAuthority, setPendingAuthority] = createStore<Record<string, PendingAutoReviewAuthority | undefined>>(
      {},
    )

    function pruneResponded(now: number) {
      for (const [id, ts] of responded) {
        if (now - ts < RESPONDED_TTL_MS) break
        responded.delete(id)
      }

      for (const id of responded.keys()) {
        if (responded.size <= MAX_RESPONDED) break
        responded.delete(id)
      }
    }

    const respond: PermissionRespondFn = (input) => {
      globalSDK.client.permission.respond(input).catch(() => {
        responded.delete(input.permissionID)
      })
    }

    function persistSessionAutoReview(sessionID: string, directory: string, enabled: boolean) {
      const key = acceptKey(sessionID, directory)
      const previous = sessionAutoReviewQueue.get(key) ?? Promise.resolve()
      // 同一会话的迁移和快速连续切换按触发顺序写入，防止较早的 PATCH 最后到达并覆盖新意图。
      const request = previous
        .then(() =>
          globalSDK.client.session.update({
            sessionID,
            directory,
            permission: [
              {
                permission: REMOTE_AUTO_REVIEW_PERMISSION,
                pattern: "*",
                action: enabled ? "allow" : "deny",
              },
            ],
          }),
        )
        .then((response) => {
          // 串行队列中每次成功都推进权威基线，后续失败必须回到最近成功值而非最初或乐观值。
          recordAutoReviewPersisted(sessionAutoReviewBaseline, key, enabled)
          return response
        })
      const tail = request.then(
        () => undefined,
        () => undefined,
      )
      sessionAutoReviewQueue.set(key, tail)
      void tail.then(() => {
        if (sessionAutoReviewQueue.get(key) === tail) sessionAutoReviewQueue.delete(key)
      })
      return request
    }

    const migratedSessionAutoReview = new Set<string>()
    createEffect(() => {
      if (!ready()) return
      const directory = decode64(params.dir)
      const sessionID = params.id
      if (!directory || !sessionID) return
      const [childStore] = globalSync.child(directory, { bootstrap: false })
      // 精确 true/false 都迁移到真实所属会话；祖先 sentinel 不得遮蔽更近子会话的旧拒绝值。
      const legacy = legacySessionAutoReviewMigration(store.autoAccept, childStore.session, sessionID, directory)
      if (!legacy) return
      const key = acceptKey(legacy.sessionID, directory)
      if (pendingAuthority[key]) return
      if (migratedSessionAutoReview.has(key)) return
      migratedSessionAutoReview.add(key)
      // 父级值写回父会话、子级值写回子会话，保持原有“最近显式值优先”的继承语义。
      void persistSessionAutoReview(legacy.sessionID, directory, legacy.enabled).catch(() =>
        migratedSessionAutoReview.delete(key),
      )
    })

    createEffect(() => {
      // PATCH 成功后保留临时权威值，直到全局 session store 确认同值；切换页面也能按原会话完成清理。
      for (const pending of Object.values(pendingAuthority)) {
        if (!pending?.persisted) continue
        const [childStore] = globalSync.child(pending.directory, { bootstrap: false })
        if (remoteAutoReviewMode(childStore.session, pending.sessionID) !== pending.enabled) continue
        const key = acceptKey(pending.sessionID, pending.directory)
        setPendingAuthority(key, undefined)
        sessionAutoReviewBaseline.delete(key)
      }
    })

    function respondOnce(permission: PermissionRequest, directory?: string) {
      const now = Date.now()
      const hit = responded.has(permission.id)
      responded.delete(permission.id)
      responded.set(permission.id, now)
      pruneResponded(now)
      if (hit) return
      respond({
        sessionID: permission.sessionID,
        permissionID: permission.id,
        response: "once",
        directory,
      })
    }

    function isAutoAccepting(sessionID: string, directory?: string) {
      const session = directory ? globalSync.child(directory, { bootstrap: false })[0].session : []
      // 菜单即时展示用户最新意图，真正自动响应仍由 persisted 权威门禁控制。
      const intent = pendingAutoReviewIntent(pendingAuthority, session, sessionID, directory)
      if (intent !== undefined) return intent
      return autoRespondsPermission(store.autoAccept, session, { sessionID }, directory, pendingAuthority)
    }

    function isAutoAcceptingDirectory(directory: string) {
      return isDirectoryAutoAccepting(store.autoAccept, directory)
    }

    function shouldAutoRespond(permission: PermissionRequest, directory?: string) {
      const session = directory ? globalSync.child(directory, { bootstrap: false })[0].session : []
      return autoRespondsPermission(store.autoAccept, session, permission, directory, pendingAuthority)
    }

    function bumpAuthorityVersion(sessionID: string, directory?: string) {
      const key = acceptKey(sessionID, directory)
      const next = (authorityVersion.get(key) ?? 0) + 1
      authorityVersion.set(key, next)
      return next
    }

    function beginSessionAutoReview(sessionID: string, directory: string, enabled: boolean) {
      const key = acceptKey(sessionID, directory)
      const version = bumpAuthorityVersion(sessionID, directory)
      // 一组快速连续切换只捕获一次已确认基线，不能把前一条乐观值当成下一条失败时的恢复目标。
      ensureAutoReviewBaseline(
        sessionAutoReviewBaseline,
        key,
        autoReviewCacheSnapshot(store.autoAccept, sessionID, directory),
      )
      // 本地缓存负责即时 UI；pendingAuthority 单独决定是否具备自动响应权威。
      setPendingAuthority(key, { sessionID, directory, enabled, persisted: false, version })
      setStore(
        produce((draft) => {
          draft.autoAccept[key] = enabled
          delete draft.autoAccept[sessionID]
        }),
      )
      return { key, version, request: persistSessionAutoReview(sessionID, directory, enabled) }
    }

    function markSessionAutoReviewPersisted(key: string, version: number) {
      const pending = pendingAuthority[key]
      if (!pending || pending.version !== version) return false
      // 只有对应版本的 PATCH 成功后，启用状态才获得自动响应权限。
      setPendingAuthority(key, { ...pending, persisted: true })
      return true
    }

    function rollbackSessionAutoReview(key: string, sessionID: string, directory: string, version: number) {
      if (pendingAuthority[key]?.version !== version) return
      // 请求失败时撤销该版本的乐观缓存和权威覆盖，恢复切换前的真实本地状态。
      setPendingAuthority(key, undefined)
      const baseline =
        takeAutoReviewBaseline(sessionAutoReviewBaseline, key) ??
        autoReviewCacheSnapshot(store.autoAccept, sessionID, directory)
      setStore(
        produce((draft) => {
          restoreAutoReviewCache(draft.autoAccept, sessionID, directory, baseline)
        }),
      )
    }

    const unsubscribe = globalSDK.event.listen((e) => {
      const event = e.details
      if (event?.type !== "permission.asked") return

      const perm = event.properties
      if (!shouldAutoRespond(perm, e.name)) return

      respondOnce(perm, e.name)
    })
    onCleanup(unsubscribe)

    function enableDirectory(directory: string) {
      const key = directoryAcceptKey(directory)
      setStore(
        produce((draft) => {
          draft.autoAccept[key] = true
        }),
      )

      globalSDK.client.permission
        .list({ directory })
        .then((x) => {
          if (!isAutoAcceptingDirectory(directory)) return
          for (const perm of x.data ?? []) {
            if (!perm?.id) continue
            if (!shouldAutoRespond(perm, directory)) continue
            respondOnce(perm, directory)
          }
        })
        .catch(() => undefined)
    }

    function disableDirectory(directory: string) {
      const key = directoryAcceptKey(directory)
      setStore(
        produce((draft) => {
          draft.autoAccept[key] = false
        }),
      )
    }

    function enable(sessionID: string, directory: string) {
      const transition = beginSessionAutoReview(sessionID, directory, true)
      void transition.request.then(
        () => {
          if (!markSessionAutoReviewPersisted(transition.key, transition.version)) return
          // 仅扫描 Permission endpoint；Question 使用独立协议，Auto-review 永远不会自动回答提问。
          void globalSDK.client.permission
            .list({ directory })
            .then((x) => {
              if (authorityVersion.get(transition.key) !== transition.version) return
              for (const perm of x.data ?? []) {
                if (!perm?.id) continue
                if (!shouldAutoRespond(perm, directory)) continue
                respondOnce(perm, directory)
              }
            })
            // pending 列表读取失败不回滚已成功持久化的 Auto-review，只等待后续实时事件。
            .catch(() => undefined)
        },
        () => rollbackSessionAutoReview(transition.key, sessionID, directory, transition.version),
      )
    }

    function disable(sessionID: string, directory?: string) {
      if (directory) {
        const transition = beginSessionAutoReview(sessionID, directory, false)
        void transition.request
          .then(() => markSessionAutoReviewPersisted(transition.key, transition.version))
          .catch(() => rollbackSessionAutoReview(transition.key, sessionID, directory, transition.version))
        return
      }

      // 无目录的旧调用只更新 legacy key；无法定位服务端实例时不发起 session PATCH。
      bumpAuthorityVersion(sessionID)
      setStore(
        produce((draft) => {
          draft.autoAccept[sessionID] = false
        }),
      )
    }

    return {
      mode,
      setMode(next: PermissionMode) {
        syncConfirmedMode()
        const request = ++latestModeRequest
        latestSelectedMode = next
        pendingModeRequests += 1
        globalSync.set("config", "permission_mode", next)
        const update = modeWrite.then(async () => {
          const eventRevision = globalSync.permissionModeEventRevision
          try {
            await globalSync.updateConfig({ permission_mode: next })
          } catch (error) {
            syncConfirmedMode()
            settleModeRequest(request)
            throw error
          }

          syncConfirmedMode()
          if (eventRevision === globalSync.permissionModeEventRevision) confirmedMode = next
          settleModeRequest(request)
        })
        modeWrite = update.catch(() => undefined)
        latestModeWrite = update
        return update
      },
      async flush() {
        while (true) {
          const target = latestModeWrite
          const result = await target.then(
            () => ({ ok: true as const }),
            (error: unknown) => ({ ok: false as const, error }),
          )
          if (target !== latestModeWrite) continue
          if (!result.ok) throw result.error
          return
        }
      },
      ready,
      respond,
      autoResponds(permission: PermissionRequest, directory?: string) {
        return shouldAutoRespond(permission, directory)
      },
      isAutoAccepting,
      isAutoAcceptingDirectory,
      toggleAutoAccept(sessionID: string, directory: string) {
        if (isAutoAccepting(sessionID, directory)) {
          disable(sessionID, directory)
          return
        }

        enable(sessionID, directory)
      },
      toggleAutoAcceptDirectory(directory: string) {
        if (isAutoAcceptingDirectory(directory)) {
          disableDirectory(directory)
          return
        }
        enableDirectory(directory)
      },
      enableAutoAccept(sessionID: string, directory: string) {
        if (isAutoAccepting(sessionID, directory)) return
        enable(sessionID, directory)
      },
      disableAutoAccept(sessionID: string, directory?: string) {
        disable(sessionID, directory)
      },
      permissionsEnabled,
      isPermissionAllowAll(directory: string) {
        const [childStore] = globalSync.child(directory)
        const perm = childStore.config.permission
        return typeof perm === "string" && perm === "allow"
      },
    }
  },
})
