import { describe, expect, test } from "bun:test"
import type { PermissionRequest, Session } from "@opencode-ai/sdk/v2/client"
import { base64Encode } from "@opencode-ai/core/util/encode"
import {
  acceptKey,
  autoReviewCacheSnapshot,
  autoRespondsPermission,
  ensureAutoReviewBaseline,
  isDirectoryAutoAccepting,
  legacySessionAutoReviewMigration,
  legacySessionAutoReviewMode,
  legacySessionAutoReviewSource,
  REMOTE_AUTO_REVIEW_PERMISSION,
  recordAutoReviewPersisted,
  restoreAutoReviewCache,
  takeAutoReviewBaseline,
} from "./permission-auto-respond"

const session = (input: { id: string; parentID?: string; remoteMode?: "allow" | "deny" }) =>
  ({
    id: input.id,
    parentID: input.parentID,
    // 专用规则模拟手机或桌面写入的持久化 Auto-review 状态。
    permission: input.remoteMode
      ? [{ permission: REMOTE_AUTO_REVIEW_PERMISSION, pattern: "*", action: input.remoteMode }]
      : undefined,
  }) as Session

const permission = (sessionID: string) =>
  ({
    sessionID,
  }) as Pick<PermissionRequest, "sessionID">

describe("autoRespondsPermission", () => {
  test("uses a parent session's directory-scoped auto-accept", () => {
    const directory = "/tmp/project"
    const sessions = [session({ id: "root" }), session({ id: "child", parentID: "root" })]
    const autoAccept = {
      [`${base64Encode(directory)}/root`]: true,
    }

    expect(autoRespondsPermission(autoAccept, sessions, permission("child"), directory)).toBe(true)
  })

  test("uses a parent session's legacy auto-accept key", () => {
    const sessions = [session({ id: "root" }), session({ id: "child", parentID: "root" })]

    expect(autoRespondsPermission({ root: true }, sessions, permission("child"), "/tmp/project")).toBe(true)
  })

  test("defaults to requiring approval when no lineage override exists", () => {
    const sessions = [session({ id: "root" }), session({ id: "child", parentID: "root" }), session({ id: "other" })]
    const autoAccept = {
      other: true,
    }

    expect(autoRespondsPermission(autoAccept, sessions, permission("child"), "/tmp/project")).toBe(false)
  })

  test("inherits a parent session's false override", () => {
    const directory = "/tmp/project"
    const sessions = [session({ id: "root" }), session({ id: "child", parentID: "root" })]
    const autoAccept = {
      [`${base64Encode(directory)}/root`]: false,
    }

    expect(autoRespondsPermission(autoAccept, sessions, permission("child"), directory)).toBe(false)
  })

  test("prefers a child override over parent override", () => {
    const directory = "/tmp/project"
    const sessions = [session({ id: "root" }), session({ id: "child", parentID: "root" })]
    const autoAccept = {
      [`${base64Encode(directory)}/root`]: false,
      [`${base64Encode(directory)}/child`]: true,
    }

    expect(autoRespondsPermission(autoAccept, sessions, permission("child"), directory)).toBe(true)
  })

  test("falls back to directory-level auto-accept", () => {
    const directory = "/tmp/project"
    const sessions = [session({ id: "root" })]
    const autoAccept = {
      [`${base64Encode(directory)}/*`]: true,
    }

    expect(autoRespondsPermission(autoAccept, sessions, permission("root"), directory)).toBe(true)
  })

  test("session-level override takes precedence over directory-level", () => {
    const directory = "/tmp/project"
    const sessions = [session({ id: "root" })]
    const autoAccept = {
      [`${base64Encode(directory)}/*`]: true,
      [`${base64Encode(directory)}/root`]: false,
    }

    expect(autoRespondsPermission(autoAccept, sessions, permission("root"), directory)).toBe(false)
  })

  test("server auto-review rule overrides stale local default", () => {
    const sessions = [session({ id: "root", remoteMode: "allow" })]

    // 手机切到自动审查后，即使浏览器旧缓存仍是 false，桌面也必须立即自动响应。
    expect(autoRespondsPermission({ root: false }, sessions, permission("root"), "/tmp/project")).toBe(true)
  })

  test("server default rule overrides stale local auto-review", () => {
    const sessions = [session({ id: "root", remoteMode: "deny" })]

    // 手机切回默认后，旧的本地 true 不能继续静默放行后续权限。
    expect(autoRespondsPermission({ root: true }, sessions, permission("root"), "/tmp/project")).toBe(false)
  })

  test("child session inherits the parent's server auto-review rule", () => {
    const sessions = [session({ id: "root", remoteMode: "allow" }), session({ id: "child", parentID: "root" })]

    // 子会话沿用桌面原有 lineage 语义，避免主会话已自动审查而子任务重新卡住。
    expect(autoRespondsPermission({}, sessions, permission("child"), "/tmp/project")).toBe(true)
  })

  test("pending disable immediately overrides a stale server allow rule", () => {
    const directory = "/tmp/project"
    const sessions = [session({ id: "root", remoteMode: "allow" })]
    const pending = {
      [acceptKey("root", directory)]: {
        sessionID: "root",
        directory,
        enabled: false,
        persisted: false,
        version: 1,
      },
    }

    // PATCH 与 session.updated 尚未完成时，禁用操作也必须立即阻止旧 allow 继续放行。
    expect(autoRespondsPermission({ root: true }, sessions, permission("root"), directory, pending)).toBe(false)
  })

  test("pending enable waits for persistence and then overrides a stale deny rule", () => {
    const directory = "/tmp/project"
    const sessions = [session({ id: "root", remoteMode: "deny" })]
    const key = acceptKey("root", directory)
    const pending = {
      [key]: {
        sessionID: "root",
        directory,
        enabled: true,
        persisted: false,
        version: 1,
      },
    }

    // 启用前半程保持 fail-closed，PATCH 成功后临时权威值应覆盖仍未刷新的旧 deny。
    expect(autoRespondsPermission({}, sessions, permission("root"), directory, pending)).toBe(false)
    pending[key].persisted = true
    expect(autoRespondsPermission({}, sessions, permission("root"), directory, pending)).toBe(true)
  })

  test("pending authority from another session does not affect the current session", () => {
    const directory = "/tmp/project"
    const sessions = [session({ id: "a" }), session({ id: "b", remoteMode: "allow" })]
    const pending = {
      [acceptKey("a", directory)]: {
        sessionID: "a",
        directory,
        enabled: false,
        persisted: false,
        version: 1,
      },
    }

    // 每会话独立的覆盖状态确保 A 的请求不会遮蔽 B 的服务端权威值。
    expect(autoRespondsPermission({}, sessions, permission("b"), directory, pending)).toBe(true)
  })

  test("a child server rule takes precedence over a parent pending transition", () => {
    const directory = "/tmp/project"
    const sessions = [session({ id: "root" }), session({ id: "child", parentID: "root", remoteMode: "deny" })]
    const pending = {
      [acceptKey("root", directory)]: {
        sessionID: "root",
        directory,
        enabled: true,
        persisted: true,
        version: 1,
      },
    }

    // 扫描根会话 pending 权限时不能越过子会话自己的 deny sentinel。
    expect(autoRespondsPermission({}, sessions, permission("child"), directory, pending)).toBe(false)
  })
})

describe("legacySessionAutoReviewMode", () => {
  test("directory fallback is never migrated into a session sentinel", () => {
    const directory = "/tmp/project"
    const sessions = [session({ id: "root" })]
    const autoAccept = { [`${base64Encode(directory)}/*`]: true }

    // 目录开启时打开会话不能产生可迁移值；随后关闭目录也不会给该会话残留 allow sentinel。
    expect(legacySessionAutoReviewMode(autoAccept, sessions, "root", directory)).toBeUndefined()
    autoAccept[`${base64Encode(directory)}/*`] = false
    expect(legacySessionAutoReviewMode(autoAccept, sessions, "root", directory)).toBeUndefined()
  })

  test("explicit parent session cache remains migratable", () => {
    const directory = "/tmp/project"
    const sessions = [session({ id: "root" }), session({ id: "child", parentID: "root" })]

    // 父会话精确键仍按旧语义向子会话继承，避免修复目录 fallback 时破坏已有迁移。
    expect(legacySessionAutoReviewMode({ [acceptKey("root", directory)]: true }, sessions, "child", directory)).toBe(
      true,
    )
    expect(
      legacySessionAutoReviewSource({ [acceptKey("root", directory)]: true }, sessions, "child", directory),
    ).toEqual({ sessionID: "root", enabled: true })
  })

  test("a child legacy false remains migratable when the parent already allows auto-review", () => {
    const directory = "/tmp/project"
    const sessions = [session({ id: "root", remoteMode: "allow" }), session({ id: "child", parentID: "root" })]
    const autoAccept = { [acceptKey("child", directory)]: false }

    // 父级 allow 只是继承态，不能阻止子级旧 false 迁移成自己的 deny sentinel。
    expect(legacySessionAutoReviewMigration(autoAccept, sessions, "child", directory)).toEqual({
      sessionID: "child",
      enabled: false,
    })

    const migrated = [sessions[0], session({ id: "child", parentID: "root", remoteMode: "deny" })]
    expect(autoRespondsPermission(autoAccept, migrated, permission("child"), directory)).toBe(false)
  })

  test("an existing direct sentinel prevents stale cache migration for that source session", () => {
    const directory = "/tmp/project"
    const sessions = [session({ id: "root", remoteMode: "allow" })]
    const autoAccept = { [acceptKey("root", directory)]: false }

    // 同会话已有服务端权威值时不再用浏览器旧缓存覆盖它。
    expect(legacySessionAutoReviewMigration(autoAccept, sessions, "root", directory)).toBeUndefined()
  })

  test("an unloaded parent source is not migrated or trusted for automatic approval", () => {
    const directory = "/tmp/project"
    const sessions = [session({ id: "child", parentID: "root" })]
    const autoAccept = { [acceptKey("root", directory)]: true }

    // root 可能因有界列表裁剪而缺失；未知的服务端 deny 必须优先于残留浏览器 allow，保持人工审批。
    expect(legacySessionAutoReviewMigration(autoAccept, sessions, "child", directory)).toBeUndefined()
    expect(autoRespondsPermission(autoAccept, sessions, permission("child"), directory)).toBe(false)
  })
})

describe("Auto-review rollback baseline", () => {
  test("two failed rapid transitions restore the state before both optimistic updates", () => {
    const directory = "/tmp/project"
    const key = acceptKey("root", directory)
    const autoAccept = { [key]: false }
    const baselines = new Map()
    ensureAutoReviewBaseline(baselines, key, autoReviewCacheSnapshot(autoAccept, "root", directory))

    // enable 与 disable 都失败时，第二次失败不能把第一次从未持久化的乐观 true 恢复回来。
    autoAccept[key] = true
    autoAccept[key] = false
    restoreAutoReviewCache(autoAccept, "root", directory, takeAutoReviewBaseline(baselines, key)!)
    expect(autoAccept).toEqual({ [key]: false })
  })

  test("a later failure restores the most recent successful transition", () => {
    const directory = "/tmp/project"
    const key = acceptKey("root", directory)
    const autoAccept = { [key]: false }
    const baselines = new Map()
    ensureAutoReviewBaseline(baselines, key, autoReviewCacheSnapshot(autoAccept, "root", directory))

    // 第一条 enable 已成功、随后 disable 失败时，权威基线应停留在已持久化的 true。
    recordAutoReviewPersisted(baselines, key, true)
    autoAccept[key] = false
    restoreAutoReviewCache(autoAccept, "root", directory, takeAutoReviewBaseline(baselines, key)!)
    expect(autoAccept).toEqual({ [key]: true })
  })
})

describe("isDirectoryAutoAccepting", () => {
  test("returns true when directory key is set", () => {
    const directory = "/tmp/project"
    const autoAccept = { [`${base64Encode(directory)}/*`]: true }
    expect(isDirectoryAutoAccepting(autoAccept, directory)).toBe(true)
  })

  test("returns false when directory key is not set", () => {
    expect(isDirectoryAutoAccepting({}, "/tmp/project")).toBe(false)
  })

  test("returns false when directory key is explicitly false", () => {
    const directory = "/tmp/project"
    const autoAccept = { [`${base64Encode(directory)}/*`]: false }
    expect(isDirectoryAutoAccepting(autoAccept, directory)).toBe(false)
  })
})
