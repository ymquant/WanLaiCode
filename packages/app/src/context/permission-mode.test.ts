import { beforeAll, describe, expect, mock, test } from "bun:test"
import { dict as zh } from "../i18n/zh"
import type { PermissionMode } from "./permission"
import { applyGlobalEvent } from "./global-sync/event-reducer"
import * as realPersistModule from "@/utils/persist"

// mock.module 前先快照真实导出,好让 mock 工厂把没 stub 的导出原样转发。
// bun:test 的 mock.module 是 process 级污染:漏掉的导出会让同一进程里后续
// 加载的 test 文件(utils/persist.test.ts、context/terminal.test.ts)拿到残缺模块。
const realPersistExports = { ...realPersistModule }

type PermissionContext = {
  mode: () => PermissionMode
  setMode: (next: PermissionMode) => Promise<unknown>
  flush: () => Promise<void>
}

type PendingRequest = {
  promise: Promise<void>
  resolve: () => void
  reject: (error: Error) => void
}

let initPermission: () => PermissionContext
let resolvePermissionMode: typeof import("./permission").resolvePermissionMode
let globalSync: {
  data: { config: { permission_mode?: PermissionMode } }
  readonly backendConfigReady: boolean
  readonly backendConfigSnapshot: { permission_mode?: PermissionMode } | undefined
  readonly permissionModeEventRevision: number
  set: (scope: "config", key: "permission_mode", value: PermissionMode) => void
  updateConfig: (config: { permission_mode: PermissionMode }) => Promise<void>
}
let permissionModeEventRevision = 0
let persistedPermissionMode: PermissionMode
let backendConfigSnapshot: { permission_mode?: PermissionMode } | undefined

beforeAll(async () => {
  // 权限 Provider 合并了会话级 Auto-review 后会读取路由、SDK 与持久化状态；
  // 此处提供最小运行环境，让用例只验证权限模式的并发写入协议。
  // 同理:只给 useParams 会让后续文件(prompt-input/submit.test.ts)拿不到 useNavigate
  mock.module("@solidjs/router", () => ({ useParams: () => ({}), useNavigate: () => () => undefined }))
  mock.module("@/context/global-sdk", () => ({
    useGlobalSDK: () => ({
      event: { listen: () => () => undefined },
      client: {
        permission: { respond: () => Promise.resolve(), list: () => Promise.resolve({ data: [] }) },
        session: { update: () => Promise.resolve({}) },
      },
    }),
  }))
  mock.module("@/utils/persist", () => ({
    ...realPersistExports,
    persisted: (_options: unknown, state: [unknown, unknown]) => [...state, undefined, () => true],
  }))
  mock.module("@opencode-ai/ui/context", () => ({
    createSimpleContext: (input: { init: () => PermissionContext }) => {
      initPermission = input.init
      return { use: () => undefined, provider: () => undefined }
    },
  }))
  mock.module("./global-sync", () => ({ useGlobalSync: () => globalSync }))

  const permission = await import("./permission")
  resolvePermissionMode = permission.resolvePermissionMode
})

function deferred(): PendingRequest {
  let resolve: () => void = () => undefined
  let reject: (error: Error) => void = () => undefined
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function permissionContext(
  initial: PermissionMode,
  requests: PendingRequest[],
  options?: { backendConfigReady?: boolean },
) {
  permissionModeEventRevision = 0
  persistedPermissionMode = initial
  backendConfigSnapshot = options?.backendConfigReady === false ? undefined : { permission_mode: initial }
  globalSync = {
    data: { config: { permission_mode: initial } },
    get backendConfigReady() {
      return backendConfigSnapshot !== undefined
    },
    get backendConfigSnapshot() {
      return backendConfigSnapshot
    },
    get permissionModeEventRevision() {
      return permissionModeEventRevision
    },
    set: (_scope, _key, value) => {
      globalSync.data.config.permission_mode = value
    },
    updateConfig: (config) => {
      const next = requests.shift()
      if (!next) throw new Error("missing request")
      return next.promise.then(() => {
        persistedPermissionMode = config.permission_mode
      })
    },
  }
  return initPermission()
}

function loadBackendConfig(mode: PermissionMode) {
  backendConfigSnapshot = { permission_mode: mode }
  globalSync.data.config.permission_mode = mode
}

function permissionModeUpdated(mode: PermissionMode) {
  applyGlobalEvent({
    event: { type: "permission.mode.updated", properties: { mode } },
    project: [],
    refresh() {},
    setGlobalProject() {},
    setConfigMode(next) {
      permissionModeEventRevision += 1
      globalSync.set("config", "permission_mode", next)
    },
  })
}

describe("resolvePermissionMode", () => {
  test("defaults to auto review when the server has not configured a mode", () => {
    expect(resolvePermissionMode(undefined)).toBe("auto_review")
  })

  test("keeps ask mode", () => {
    expect(resolvePermissionMode("ask")).toBe("ask")
  })

  test("keeps full access mode", () => {
    expect(resolvePermissionMode("full_access")).toBe("full_access")
  })
})

test("renders all permission modes without legacy auto accept", async () => {
  const source = await Bun.file(new URL("../components/prompt-input.tsx", import.meta.url)).text()

  expect(source).toContain('value="ask"')
  expect(source).toContain('value="auto_review"')
  expect(source).toContain('value="full_access"')
  expect(source).toContain("if (value === \"full_access\") confirmFullAccess()")
  expect(source).toContain('onConfirm={() => updatePermissionMode("full_access")}')
  expect(source).not.toContain("setAccepting")
})

test("matches the approved Chinese permission mode copy", () => {
  expect(zh["prompt.permission.default"]).toBe("请求批准")
  expect(zh["prompt.permission.default.description"]).toBe("编辑外部文件和使用互联网时始终询问")
  expect(zh["prompt.permission.auto"]).toBe("替我审批")
  expect(zh["prompt.permission.auto.description"]).toBe("仅对检测到的风险操作请求批准")
  expect(zh["prompt.permission.full"]).toBe("完全访问权限")
  expect(zh["prompt.permission.full.description"]).toBe("可不受限制地访问互联网和您电脑上的任何文件")
})

test("keeps the newer mode when an earlier optimistic update fails after a server sync", async () => {
  const first = deferred()
  const second = deferred()
  const permission = permissionContext("auto_review", [first, second])

  const firstUpdate = permission.setMode("ask")
  const secondUpdate = permission.setMode("full_access")
  permissionModeUpdated("full_access")
  first.reject(new Error("ask update failed"))

  await expect(firstUpdate).rejects.toThrow("ask update failed")
  second.resolve()
  await secondUpdate
  expect(permission.mode()).toBe("full_access")
})

test("does not roll back a mode synchronized by a server event", async () => {
  const request = deferred()
  const permission = permissionContext("auto_review", [request])

  const update = permission.setMode("ask")
  permissionModeUpdated("full_access")
  request.reject(new Error("ask update failed"))

  await expect(update).rejects.toThrow("ask update failed")
  expect(permission.mode()).toBe("full_access")
})

test("does not roll back a mode confirmed by a same-value server event", async () => {
  const request = deferred()
  const permission = permissionContext("auto_review", [request])

  const update = permission.setMode("ask")
  permissionModeUpdated("ask")
  request.reject(new Error("ask update failed"))

  await expect(update).rejects.toThrow("ask update failed")
  expect(permission.mode()).toBe("ask")
})

test("does not roll back a value selected again by a newer request", async () => {
  const first = deferred()
  const second = deferred()
  const third = deferred()
  const permission = permissionContext("auto_review", [first, second, third])

  const firstUpdate = permission.setMode("ask")
  const secondUpdate = permission.setMode("full_access")
  const thirdUpdate = permission.setMode("ask")
  first.reject(new Error("first ask update failed"))
  await expect(firstUpdate).rejects.toThrow("first ask update failed")
  second.resolve()
  await secondUpdate
  third.resolve()
  await thirdUpdate
  expect(permission.mode()).toBe("ask")
})

test("serializes reverse successful writes so the final stricter ask choice wins", async () => {
  const first = deferred()
  const second = deferred()
  const permission = permissionContext("auto_review", [first, second])

  const permissive = permission.setMode("full_access")
  const stricter = permission.setMode("ask")
  second.resolve()
  first.resolve()
  await Promise.all([permissive, stricter])

  expect(permission.mode()).toBe("ask")
  expect(persistedPermissionMode).toBe("ask")
})

test("rolls consecutive failed writes back to the last backend-confirmed mode", async () => {
  const first = deferred()
  const second = deferred()
  const permission = permissionContext("full_access", [first, second])

  const ask = permission.setMode("ask")
  const autoReview = permission.setMode("auto_review")
  first.reject(new Error("ask update failed"))
  await expect(ask).rejects.toThrow("ask update failed")
  second.reject(new Error("auto review update failed"))
  await expect(autoReview).rejects.toThrow("auto review update failed")

  expect(permission.mode()).toBe("full_access")
})

test("uses the backend mode loaded after provider initialization as the confirmed rollback value", async () => {
  const request = deferred()
  const permission = permissionContext("auto_review", [request], { backendConfigReady: false })
  loadBackendConfig("full_access")
  expect(permission.mode()).toBe("full_access")

  const update = permission.setMode("ask")
  request.reject(new Error("ask update failed"))
  await expect(update).rejects.toThrow("ask update failed")

  expect(permission.mode()).toBe("full_access")
})

test("adopts the first backend snapshot while an optimistic write is pending", async () => {
  const request = deferred()
  const permission = permissionContext("auto_review", [request], { backendConfigReady: false })

  const update = permission.setMode("ask")
  loadBackendConfig("full_access")
  request.reject(new Error("ask update failed"))
  await expect(update).rejects.toThrow("ask update failed")

  expect(permission.mode()).toBe("full_access")
})

test("flush waits for the latest write added while it is already waiting", async () => {
  const first = deferred()
  const second = deferred()
  const permission = permissionContext("full_access", [first, second])
  const ask = permission.setMode("ask")
  let flushed = false
  const flushing = permission.flush().then(() => {
    flushed = true
  })
  const autoReview = permission.setMode("auto_review")

  first.resolve()
  await ask
  await Promise.resolve()
  expect(flushed).toBe(false)

  second.resolve()
  await Promise.all([autoReview, flushing])
  expect(flushed).toBe(true)
  expect(permission.mode()).toBe("auto_review")
})

test("flush exposes the latest write failure and the serial queue continues", async () => {
  const first = deferred()
  const second = deferred()
  const permission = permissionContext("full_access", [first, second])
  const ask = permission.setMode("ask")

  first.reject(new Error("ask update failed"))
  await expect(ask).rejects.toThrow("ask update failed")
  await expect(permission.flush()).rejects.toThrow("ask update failed")

  const autoReview = permission.setMode("auto_review")
  second.resolve()
  await autoReview
  await permission.flush()
  expect(permission.mode()).toBe("auto_review")
})
