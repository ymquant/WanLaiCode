import { base64Encode } from "@opencode-ai/core/util/encode"

// 远控与桌面 UI 共用的 session 规则标记；规则名不会匹配任何真实工具权限。
export const REMOTE_AUTO_REVIEW_PERMISSION = "__wanlai_remote_auto_review"

export function acceptKey(sessionID: string, directory?: string) {
  if (!directory) return sessionID
  return `${base64Encode(directory)}/${sessionID}`
}

export function directoryAcceptKey(directory: string) {
  return `${base64Encode(directory)}/*`
}

function accepted(autoAccept: Record<string, boolean>, sessionID: string, directory?: string) {
  const value = explicitlyAccepted(autoAccept, sessionID, directory)
  const directoryKey = directory ? directoryAcceptKey(directory) : undefined
  return value ?? (directoryKey ? autoAccept[directoryKey] : undefined)
}

export function isDirectoryAutoAccepting(autoAccept: Record<string, boolean>, directory: string) {
  const key = directoryAcceptKey(directory)
  return autoAccept[key] ?? false
}

type SessionWithPermissions = {
  id: string
  parentID?: string
  permission?: Array<{ permission?: string; pattern?: string; action?: string }>
}

export type PendingAutoReviewAuthority = {
  sessionID: string
  directory: string
  enabled: boolean
  persisted: boolean
  version: number
}

export type AutoReviewCacheSnapshot = {
  scoped: boolean | undefined
  legacy: boolean | undefined
}

function sessionLineage(session: SessionWithPermissions[], sessionID: string) {
  const parent = session.reduce((acc, item) => {
    if (item.parentID) acc.set(item.id, item.parentID)
    return acc
  }, new Map<string, string>())
  const seen = new Set([sessionID])
  const ids = [sessionID]

  for (const id of ids) {
    const parentID = parent.get(id)
    if (!parentID || seen.has(parentID)) continue
    seen.add(parentID)
    ids.push(parentID)
  }

  return ids
}

function explicitlyAccepted(autoAccept: Record<string, boolean>, sessionID: string, directory?: string) {
  // 迁移只承认会话精确键；目录通配键是 fallback，不能固化成某个会话的服务端状态。
  const key = acceptKey(sessionID, directory)
  return autoAccept[key] ?? (key === sessionID ? undefined : autoAccept[sessionID])
}

export function legacySessionAutoReviewSource(
  autoAccept: Record<string, boolean>,
  session: SessionWithPermissions[],
  sessionID: string,
  directory?: string,
) {
  // 返回真正拥有旧缓存值的祖先，迁移时不能把继承值固化成当前子会话的显式 sentinel。
  for (const id of sessionLineage(session, sessionID)) {
    const enabled = explicitlyAccepted(autoAccept, id, directory)
    if (enabled !== undefined) return { sessionID: id, enabled }
  }
}

export function legacySessionAutoReviewMode(
  autoAccept: Record<string, boolean>,
  session: SessionWithPermissions[],
  sessionID: string,
  directory?: string,
) {
  // 对外保留原布尔查询语义；迁移写入方使用 source 中的真实归属会话。
  return legacySessionAutoReviewSource(autoAccept, session, sessionID, directory)?.enabled
}

export function legacySessionAutoReviewMigration(
  autoAccept: Record<string, boolean>,
  session: SessionWithPermissions[],
  sessionID: string,
  directory?: string,
) {
  const source = legacySessionAutoReviewSource(autoAccept, session, sessionID, directory)
  if (!source) return
  // 只检查旧值真正所属会话的直接 sentinel；祖先继承态不能吞掉子会话自己的 false 覆盖。
  const target = session.find((item) => item.id === source.sessionID)
  // 有界 session store 未加载 source 时无法证明服务端没有 sentinel，必须等待权威会话数据后再迁移。
  if (!target) return
  if (directRemoteAutoReviewMode(target) !== undefined) return
  return source
}

export function autoReviewCacheSnapshot(
  autoAccept: Record<string, boolean>,
  sessionID: string,
  directory: string,
): AutoReviewCacheSnapshot {
  return {
    scoped: autoAccept[acceptKey(sessionID, directory)],
    legacy: autoAccept[sessionID],
  }
}

export function confirmedAutoReviewCache(enabled: boolean): AutoReviewCacheSnapshot {
  // PATCH 成功后的浏览器缓存统一收敛到目录作用域键，旧的无目录键不再继续参与继承。
  return { scoped: enabled, legacy: undefined }
}

export function ensureAutoReviewBaseline(
  baselines: Map<string, AutoReviewCacheSnapshot>,
  key: string,
  snapshot: AutoReviewCacheSnapshot,
) {
  // 一组连续切换只捕获一次起点，后续乐观值不能覆盖仍待确认的权威基线。
  if (!baselines.has(key)) baselines.set(key, snapshot)
}

export function recordAutoReviewPersisted(
  baselines: Map<string, AutoReviewCacheSnapshot>,
  key: string,
  enabled: boolean,
) {
  // 只有已存在切换事务时才推进基线；后台 legacy 迁移不需要额外保留回滚状态。
  if (baselines.has(key)) baselines.set(key, confirmedAutoReviewCache(enabled))
}

export function takeAutoReviewBaseline(baselines: Map<string, AutoReviewCacheSnapshot>, key: string) {
  const snapshot = baselines.get(key)
  baselines.delete(key)
  return snapshot
}

export function restoreAutoReviewCache(
  autoAccept: Record<string, boolean>,
  sessionID: string,
  directory: string,
  snapshot: AutoReviewCacheSnapshot,
) {
  const key = acceptKey(sessionID, directory)
  // 失败时精确恢复最后一次已确认快照，不能恢复前一条仍属乐观状态的值。
  if (snapshot.scoped === undefined) delete autoAccept[key]
  else autoAccept[key] = snapshot.scoped
  if (snapshot.legacy === undefined) delete autoAccept[sessionID]
  else autoAccept[sessionID] = snapshot.legacy
}

export function pendingAutoReviewIntent(
  pending: Record<string, PendingAutoReviewAuthority | undefined>,
  session: SessionWithPermissions[],
  sessionID: string,
  directory?: string,
) {
  const byID = new Map(session.map((item) => [item.id, item]))
  // UI 展示最近的 pending 意图，但不能越过子会话已有的显式服务端 sentinel。
  for (const id of sessionLineage(session, sessionID)) {
    const transition = pending[acceptKey(id, directory)]
    if (transition) return transition.enabled
    if (directRemoteAutoReviewMode(byID.get(id)) !== undefined) return undefined
  }
  return undefined
}

function pendingAutoReviewMode(
  pending: Record<string, PendingAutoReviewAuthority | undefined>,
  session: SessionWithPermissions[],
  sessionID: string,
  directory?: string,
) {
  const byID = new Map(session.map((item) => [item.id, item]))
  // 禁用立即生效、启用等待 PATCH；更近的子会话服务端状态仍优先于父级 pending。
  for (const id of sessionLineage(session, sessionID)) {
    const transition = pending[acceptKey(id, directory)]
    if (transition) return transition.enabled && transition.persisted
    if (directRemoteAutoReviewMode(byID.get(id)) !== undefined) return undefined
  }
  return undefined
}

function directRemoteAutoReviewMode(session: SessionWithPermissions | undefined) {
  // 单会话只读取最后一条专用规则，供 lineage 决策保持“子级优先父级”的顺序。
  const rule = session?.permission?.findLast(
    (item) => item.permission === REMOTE_AUTO_REVIEW_PERMISSION && item.pattern === "*",
  )
  if (rule?.action === "allow") return true
  if (rule?.action === "deny") return false
  return undefined
}

export function remoteAutoReviewMode(session: SessionWithPermissions[], sessionID: string) {
  const byID = new Map(session.map((item) => [item.id, item]))
  for (const id of sessionLineage(session, sessionID)) {
    const mode = directRemoteAutoReviewMode(byID.get(id))
    if (mode !== undefined) return mode
  }
  return undefined
}

export function autoRespondsPermission(
  autoAccept: Record<string, boolean>,
  session: SessionWithPermissions[],
  permission: { sessionID: string },
  directory?: string,
  pending: Record<string, PendingAutoReviewAuthority | undefined> = {},
) {
  // 本地进行中的切换优先级最高，屏蔽尚未通过 session.updated 刷新的旧服务端 sentinel。
  const pendingMode = pendingAutoReviewMode(pending, session, permission.sessionID, directory)
  if (pendingMode !== undefined) return pendingMode

  // 服务器 session 规则优先于浏览器旧缓存，确保手机切换后桌面立即采用同一状态。
  const remoteMode = remoteAutoReviewMode(session, permission.sessionID)
  if (remoteMode !== undefined) return remoteMode

  const loaded = new Set(session.map((item) => item.id))
  const value = sessionLineage(session, permission.sessionID)
    // 被裁剪的祖先可能已有手机写入的 deny sentinel；在它重新加载前不能信任浏览器旧 allow 缓存。
    .filter((id) => loaded.has(id))
    .map((id) => accepted(autoAccept, id, directory))
    .find((item): item is boolean => item !== undefined)
  return value ?? false
}
