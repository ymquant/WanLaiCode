import WebSocket from "ws"
import crypto from "node:crypto"
import os from "node:os"
import childProcess from "node:child_process"
import { Effect } from "effect"
import { InstallationLocal, InstallationVersion } from "@opencode-ai/core/installation/version"
import { Flag } from "@opencode-ai/core/flag/flag"
import * as Log from "@opencode-ai/core/util/log"
import { Auth } from "@/auth"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { AppRuntime } from "@/effect/app-runtime"
import { WanlaiCodeAuth } from "@/provider/wanlaicode"
import { WanlaiCodeRefreshCoordinator } from "@/provider/wanlaicode-refresh-coordinator"
import { operations } from "./operations"
import {
  bridgeEvent,
  bridgeMessages,
  bridgeSessionList,
  bridgeToolUpdate,
  dispatchRemotePayload,
  eventSessionID,
  ProtocolError,
  protocolError,
  remoteHistorySessionID,
  streamRemoteHistoryPayload,
} from "./protocol"

const log = Log.create({ service: "remote-control" })
const credentialPrefix = Auth.REMOTE_CONTROL_CREDENTIAL_PREFIX
const reconnectMinMs = 1_000
const reconnectMaxMs = 30_000
const presenceDefaultTTLSeconds = 75
const presenceSweepMs = 1_000
const relayObservedPresenceSessionID = "relay-observed"
const relayOutboundQueueLimit = 32
const relayDeliveryAckTimeoutMs = 15_000
export const relayOutboundQueueMaxBytes = 64 * 1024 * 1024
export const relayCompletedCacheEntryMaxBytes = 256 * 1024
export const relayCompletedCacheMaxBytes = 12 * 1024 * 1024
export const relayCompletedCacheTTLms = 10 * 60_000
const relayCompletedCacheMaxEntries = 1_000
const relayResponseFallbackErrors = new Set([
  "RELAY_PAYLOAD_TOO_LARGE",
  "RELAY_REQUEST_ID_TOO_LONG",
  "INVALID_RELAY_FRAGMENT",
])
const remoteBridgeMutationTypes = new Set([
  "input",
  "start",
  "interrupt",
  "stop_session",
  "approve",
  "approve_always",
  "reject",
  "answer",
  "set_codex_model",
  "set_permission_mode",
  // 创建目录和 git 仓库属于写操作，relay 必须缓存完成结果以抵御 ACK 丢失后的重放。
  "create_blank_project",
])
const remoteNativeMutationTypes = new Set([
  "session.send",
  "session.create",
  "session.abort",
  "permission.reply",
  "question.reply",
  "question.reject",
  "session.model.set",
  "session.permission_mode.set",
  "set_codex_model",
  "set_permission_mode",
])
// 桌面与 Flutter 共用固定分片预算：512KiB 原始块、64MiB 总缓存、512 片和 60 秒续租 TTL。
export const relayFragmentThresholdBytes = 512 * 1024
export const relayFragmentMaxAssembledBytes = 64 * 1024 * 1024
export const relayFragmentTTLms = 60_000
const relayFragmentMaxCount = 512
const relayFragmentMaxAssemblies = 32
const relayFragmentMaxBufferedBytes = 64 * 1024 * 1024
const relayFragmentMaxBase64Characters = Math.ceil(relayFragmentThresholdBytes / 3) * 4
const relayInboundQueueLimit = 32
export const relayInboundQueueMaxBytes = relayFragmentMaxAssembledBytes
const historyEventBufferLimit = 256
const historyEventBufferMaxBytes = relayFragmentMaxAssembledBytes
// 回合路由只服务于实时 delta 与迟到终态；固定上限可覆盖长会话，同时避免桌面常驻后无限增长。
const remoteTurnRouteMaxEntries = 20_000
const invalidDeviceCredential = "REMOTE_CONTROL_INVALID_DEVICE_CREDENTIAL"
const localRemoteControlEndpoint = "http://127.0.0.1:8080/api/v1/remote-control"
const pendingDeviceCredential = "__wanlaicode_remote_registration_pending__"
const bridgeOnlyEventsCapability = "bridge_only_events"

type JsonObject = Record<string, unknown>
type RemoteDeviceIdentity = { deviceID: string; token?: string }
type RemoteDeviceCredential = { deviceID: string; token: string }

type RelayCompletion = { fingerprint: string; result: JsonObject[] }

// completed 只保留短期、可重放的变更结果；按字节和 TTL 双重限制，避免图片历史把桌面内存撑满。
export class RelayCompletionCache {
  private entries = new Map<string, RelayCompletion & { bytes: number; expiresAt: number }>()
  private totalBytes = 0

  constructor(
    private readonly options: {
      entryMaxBytes?: number
      maxBytes?: number
      ttlMs?: number
      maxEntries?: number
    } = {},
  ) {}

  get size() {
    return this.entries.size
  }

  get bytes() {
    return this.totalBytes
  }

  get(key: string, now = Date.now()) {
    this.prune(now)
    const entry = this.entries.get(key)
    if (!entry) return
    return { fingerprint: entry.fingerprint, result: entry.result }
  }

  set(key: string, value: RelayCompletion, now = Date.now()) {
    this.prune(now)
    const bytes = Buffer.byteLength(JSON.stringify(value.result), "utf8")
    if (bytes > (this.options.entryMaxBytes ?? relayCompletedCacheEntryMaxBytes)) return false
    this.delete(key)
    const maxBytes = this.options.maxBytes ?? relayCompletedCacheMaxBytes
    const maxEntries = this.options.maxEntries ?? relayCompletedCacheMaxEntries
    while (this.entries.size > 0 && (this.totalBytes + bytes > maxBytes || this.entries.size >= maxEntries)) {
      this.delete(this.entries.keys().next().value ?? "")
    }
    if (bytes > maxBytes) return false
    this.entries.set(key, {
      ...value,
      bytes,
      expiresAt: now + (this.options.ttlMs ?? relayCompletedCacheTTLms),
    })
    this.totalBytes += bytes
    return true
  }

  clear() {
    this.entries.clear()
    this.totalBytes = 0
  }

  private delete(key: string) {
    const entry = this.entries.get(key)
    if (!entry) return
    this.entries.delete(key)
    this.totalBytes = Math.max(0, this.totalBytes - entry.bytes)
  }

  private prune(now: number) {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt > now) continue
      this.delete(key)
    }
  }
}

// bridge.fragment 是 relay payload 内层 wire schema；request_id 始终表示重组后的逻辑请求。
export type RelayFragmentPayload = {
  type: "bridge.fragment"
  fragment_id: string
  fragment_index: number
  fragment_count: number
  data: string
  request_id?: string
}

export type RelayFragmentState = {
  assemblies: Map<
    string,
    {
      fragmentCount: number
      requestID?: string
      chunks: Map<number, Buffer>
      bytes: number
      expiresAt: number
    }
  >
  bufferedBytes: number
  ttlMs: number
  maxAssembledBytes: number
  maxBufferedBytes: number
  maxAssemblies: number
}

export type RelayPayloadResult = { type: "pending" } | { type: "ready"; payload: unknown; requestID?: string }

// relay 编码失败由调用方按“请求回错、事件丢弃”处理，不能从 fire-and-forget 异步入口继续抛出。
type RelaySendResult =
  | { type: "sent" }
  | { type: "unavailable" }
  | { type: "rejected"; error: { code: string; message: string } }

type RelayOutboundJob = {
  targetDeviceID: string
  payload: JsonObject
  requestID?: string
  bytes: number
  released?: boolean
  resolve: (result: RelaySendResult) => void
}

type PendingRelayDelivery = {
  socket: WebSocket
  targetDeviceID: string
  requestID: string
  finish: (result: RelaySendResult) => void
}

type RelayInboundJob = {
  sourceDeviceID: string
  payload: unknown
  requestID: string
  bytes: number
  generation: number
  lifecycle: number
  presenceRevision: number
  observedAt: number
  socket?: WebSocket
  released?: boolean
  cancelled: Promise<void>
  cancel: () => void
  resolve: () => void
}

type HistoryEventBarrier = {
  deviceID: string
  sessionID: string
  lifecycle: number
  events: Array<{ event: GlobalEvent; coalescedFile: boolean; bytes: number }>
  bytes: number
}

type PendingFileEvent = {
  event: GlobalEvent
  targetDeviceID?: string
  replayBarrier?: HistoryEventBarrier
  lifecycle: number
  timer: ReturnType<typeof setTimeout>
  release: () => void
  promise: Promise<void>
}

export type RemoteControlConnection = {
  id: string
  device_id: string
  name: string
  platform?: string
  online: boolean
  last_connected_at?: string
}

export type PendingPairing = {
  pairing_id: string
  name: string
  platform?: string
  requested_at?: string
}

export type PairingInfo = {
  pairing_id: string
  secret: string
  expires_at: string
  qr: string
}

export type RemoteControlStatus = {
  state: "auth_required" | "disconnected" | "connecting" | "connected" | "error"
  device_id: string
  device_name: string
  error?: string
  pairing?: PairingInfo
  pending_pairings: PendingPairing[]
  connections: RemoteControlConnection[]
}

function object(value: unknown): JsonObject | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  return value as JsonObject
}

function string(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function number(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function validRelayRequestID(value: unknown): value is string {
  return typeof value === "string" && Buffer.byteLength(value, "utf8") >= 1 && Buffer.byteLength(value, "utf8") <= 512
}

// completed 缓存只服务可能产生副作用的命令；查询仍共享 inflight，但完成后必须释放大历史结果。
export function remotePayloadMutates(value: unknown) {
  const payload = object(value)
  const type = string(payload?.type)
  if (type === "bridge.client_message") {
    const messageType = string(object(payload?.message)?.type)
    return remoteBridgeMutationTypes.has(messageType ?? "")
  }
  return remoteNativeMutationTypes.has(type ?? "")
}

// 小 payload 保持既有 relay 信封完全不变；大 payload 才按 JSON 的 UTF-8 原始字节透明分片。
export function relayEnvelopes(
  targetDeviceID: string,
  payload: JsonObject,
  requestID?: string,
  createFragmentID: () => string = () => crypto.randomUUID(),
) {
  // 编码端与入站分片的 512 字符约束必须闭合，避免生成手机能发出却无法在桌面重组的信封。
  if (requestID && !validRelayRequestID(requestID)) {
    throw new ProtocolError("RELAY_REQUEST_ID_TOO_LONG", "relay request_id must not exceed 512 characters")
  }
  const bytes = Buffer.from(JSON.stringify(payload), "utf8")
  if (bytes.byteLength <= relayFragmentThresholdBytes) {
    return [
      {
        type: "relay",
        target_device_id: targetDeviceID,
        ...(requestID ? { request_id: requestID } : {}),
        payload,
      },
    ]
  }
  if (bytes.byteLength > relayFragmentMaxAssembledBytes) {
    throw new ProtocolError("RELAY_PAYLOAD_TOO_LARGE", `relay payload exceeds ${relayFragmentMaxAssembledBytes} bytes`)
  }

  // fragment_id 标识整组逻辑消息，外层 request_id 则逐片生成，避免后端幂等缓存吞掉同组后续片。
  const fragmentID = createFragmentID()
  if (!fragmentID || fragmentID.length > 128) {
    throw new ProtocolError("INVALID_RELAY_FRAGMENT", "fragment_id must be 1-128 characters")
  }
  const fragmentCount = Math.ceil(bytes.byteLength / relayFragmentThresholdBytes)
  return Array.from({ length: fragmentCount }, (_, fragmentIndex) => {
    const outerRequestID = `fragment:${fragmentID}:${fragmentIndex}`
    const start = fragmentIndex * relayFragmentThresholdBytes
    const fragment: RelayFragmentPayload = {
      type: "bridge.fragment",
      fragment_id: fragmentID,
      fragment_index: fragmentIndex,
      fragment_count: fragmentCount,
      data: bytes.subarray(start, start + relayFragmentThresholdBytes).toString("base64"),
      ...(requestID ? { request_id: requestID } : {}),
    }
    return {
      type: "relay",
      target_device_id: targetDeviceID,
      request_id: outerRequestID,
      payload: fragment,
    }
  })
}

// 重组状态同时限制单消息、全局缓存和并发组数，防止大量不完整分片长期占用桌面内存。
export function createRelayFragmentState(
  options: Partial<Pick<RelayFragmentState, "ttlMs" | "maxAssembledBytes" | "maxBufferedBytes" | "maxAssemblies">> = {},
): RelayFragmentState {
  return {
    assemblies: new Map(),
    bufferedBytes: 0,
    ttlMs: options.ttlMs ?? relayFragmentTTLms,
    maxAssembledBytes: options.maxAssembledBytes ?? relayFragmentMaxAssembledBytes,
    maxBufferedBytes: options.maxBufferedBytes ?? relayFragmentMaxBufferedBytes,
    maxAssemblies: options.maxAssemblies ?? relayFragmentMaxAssemblies,
  }
}

function deleteRelayFragmentAssembly(state: RelayFragmentState, key: string) {
  const assembly = state.assemblies.get(key)
  if (!assembly) return
  state.bufferedBytes = Math.max(0, state.bufferedBytes - assembly.bytes)
  state.assemblies.delete(key)
}

// TTL 使用最后一片的接收时间续租；清理函数也由网关周期调用，静默连接不会残留过期缓存。
export function pruneRelayFragmentAssemblies(state: RelayFragmentState, now = Date.now()) {
  const expired = [...state.assemblies.entries()]
    .filter(([, assembly]) => assembly.expiresAt <= now)
    .map(([key]) => key)
  expired.forEach((key) => deleteRelayFragmentAssembly(state, key))
  return expired.length
}

export function clearRelayFragmentAssemblies(state: RelayFragmentState) {
  state.assemblies.clear()
  state.bufferedBytes = 0
}

function invalidRelayFragment(message: string): never {
  throw new ProtocolError("INVALID_RELAY_FRAGMENT", message)
}

// Node 的 base64 解码器会宽松忽略非法字符，因此必须先校验规范编码再分配重组缓存。
function decodeRelayFragmentData(value: unknown) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > relayFragmentMaxBase64Characters ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    return invalidRelayFragment("fragment data must be canonical base64")
  }
  const bytes = Buffer.from(value, "base64")
  if (bytes.toString("base64") !== value) return invalidRelayFragment("fragment data must be canonical base64")
  if (bytes.byteLength > relayFragmentThresholdBytes) {
    return invalidRelayFragment(`fragment data exceeds ${relayFragmentThresholdBytes} bytes`)
  }
  return bytes
}

function relayFragmentPayload(value: unknown) {
  const input = object(value)
  if (input?.type !== "bridge.fragment") return
  const fragmentID = string(input.fragment_id)
  const fragmentIndex = number(input.fragment_index)
  const fragmentCount = number(input.fragment_count)
  const requestID = input.request_id === undefined ? undefined : string(input.request_id)
  if (!fragmentID || fragmentID.length > 128) return invalidRelayFragment("fragment_id must be 1-128 characters")
  if (fragmentIndex === undefined || !Number.isInteger(fragmentIndex) || fragmentIndex < 0) {
    return invalidRelayFragment("fragment_index must be a non-negative integer")
  }
  if (
    fragmentCount === undefined ||
    !Number.isInteger(fragmentCount) ||
    fragmentCount < 2 ||
    fragmentCount > relayFragmentMaxCount
  ) {
    return invalidRelayFragment(`fragment_count must be an integer between 2 and ${relayFragmentMaxCount}`)
  }
  if (fragmentIndex >= fragmentCount) return invalidRelayFragment("fragment_index must be less than fragment_count")
  if (input.request_id !== undefined && !validRelayRequestID(input.request_id)) {
    return invalidRelayFragment("fragment request_id must be 1-512 characters")
  }
  return {
    fragmentID,
    fragmentIndex,
    fragmentCount,
    requestID,
    bytes: decodeRelayFragmentData(input.data),
  }
}

// 非分片直接透传；分片完成后才恢复逻辑 request_id，确保缓存与业务分发看不到逐片外层 ID。
export function acceptRelayPayload(
  state: RelayFragmentState,
  sourceDeviceID: string,
  payload: unknown,
  outerRequestID?: string,
  now = Date.now(),
): RelayPayloadResult {
  pruneRelayFragmentAssemblies(state, now)
  const fragment = relayFragmentPayload(payload)
  if (!fragment) return { type: "ready", payload, requestID: outerRequestID }
  // 外层 ID 必须与片号一一对应，既防止服务端幂等键吞片，也拒绝跨组伪造或错配。
  const expectedOuterRequestID = `fragment:${fragment.fragmentID}:${fragment.fragmentIndex}`
  if (outerRequestID !== expectedOuterRequestID) {
    return invalidRelayFragment("fragment outer request_id does not match fragment_id and fragment_index")
  }
  // 除末片外均必须占满 512KiB，保证片号到字节偏移的映射唯一并与编码端固定切片规则闭合。
  if (
    fragment.fragmentIndex < fragment.fragmentCount - 1 &&
    fragment.bytes.byteLength !== relayFragmentThresholdBytes
  ) {
    return invalidRelayFragment(`non-final fragment data must contain exactly ${relayFragmentThresholdBytes} bytes`)
  }
  const key = JSON.stringify([sourceDeviceID, fragment.fragmentID])
  const current = state.assemblies.get(key)
  if (current && (current.fragmentCount !== fragment.fragmentCount || current.requestID !== fragment.requestID)) {
    deleteRelayFragmentAssembly(state, key)
    return invalidRelayFragment("fragment metadata conflicts with an existing assembly")
  }
  if (!current && state.assemblies.size >= state.maxAssemblies) {
    return invalidRelayFragment("too many fragment assemblies are pending")
  }
  const assembly = current ?? {
    fragmentCount: fragment.fragmentCount,
    requestID: fragment.requestID,
    chunks: new Map<number, Buffer>(),
    bytes: 0,
    expiresAt: now + state.ttlMs,
  }
  const duplicate = assembly.chunks.get(fragment.fragmentIndex)
  if (duplicate && !duplicate.equals(fragment.bytes)) {
    deleteRelayFragmentAssembly(state, key)
    return invalidRelayFragment("fragment data conflicts with an existing index")
  }
  if (!duplicate) {
    if (assembly.bytes + fragment.bytes.byteLength > state.maxAssembledBytes) {
      deleteRelayFragmentAssembly(state, key)
      return invalidRelayFragment(`assembled payload exceeds ${state.maxAssembledBytes} bytes`)
    }
    if (state.bufferedBytes + fragment.bytes.byteLength > state.maxBufferedBytes) {
      deleteRelayFragmentAssembly(state, key)
      return invalidRelayFragment(`fragment buffer exceeds ${state.maxBufferedBytes} bytes`)
    }
    assembly.chunks.set(fragment.fragmentIndex, fragment.bytes)
    assembly.bytes += fragment.bytes.byteLength
    state.bufferedBytes += fragment.bytes.byteLength
  }
  assembly.expiresAt = now + state.ttlMs
  state.assemblies.set(key, assembly)
  if (assembly.chunks.size < assembly.fragmentCount) return { type: "pending" }

  // 所有片齐全后按索引拼回原始字节，再用 fatal UTF-8 解码保证损坏数据不会被替换字符掩盖。
  const bytes = Buffer.concat(
    Array.from({ length: assembly.fragmentCount }, (_, index) => assembly.chunks.get(index)!),
    assembly.bytes,
  )
  deleteRelayFragmentAssembly(state, key)
  if (bytes.byteLength <= relayFragmentThresholdBytes) {
    return invalidRelayFragment("fragmented payload must exceed the relay threshold")
  }
  let decoded: string
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    return invalidRelayFragment("assembled payload is not valid UTF-8")
  }
  try {
    const restored = object(JSON.parse(decoded))
    if (!restored) return invalidRelayFragment("assembled payload must be a JSON object")
    return { type: "ready", payload: restored, requestID: assembly.requestID }
  } catch (error) {
    if (error instanceof ProtocolError) throw error
    return invalidRelayFragment("assembled payload is not valid JSON")
  }
}

export type PresenceSessionState = Map<string, Map<string, number>>

// presence 必须按设备内的 WS session 聚合，旧连接离线不能覆盖同设备仍在线的新连接。
export function applyPresenceEvent(
  state: PresenceSessionState,
  input: {
    deviceID: string
    presence: string
    sessionID?: string
    ttlSeconds?: number
  },
  now = Date.now(),
) {
  const sessions = state.get(input.deviceID) ?? new Map<string, number>()
  if (input.presence === "online") {
    const sessionID = input.sessionID || "legacy"
    const ttlSeconds = Math.min(300, Math.max(1, Math.floor(input.ttlSeconds ?? presenceDefaultTTLSeconds)))
    sessions.set(sessionID, now + ttlSeconds * 1_000)
    state.set(input.deviceID, sessions)
    return true
  }
  if (input.presence !== "offline") return sessions.size > 0
  if (input.sessionID) sessions.delete(input.sessionID)
  else sessions.clear()
  if (sessions.size > 0) {
    state.set(input.deviceID, sessions)
    return true
  }
  state.delete(input.deviceID)
  return false
}

// 断网时后端可能送不到 offline，桌面按本地接收时间清掉过期租约，避免永久显示手机在线。
export function prunePresenceSessions(state: PresenceSessionState, now = Date.now()) {
  const offline: string[] = []
  for (const [deviceID, sessions] of state) {
    for (const [sessionID, expiresAt] of sessions) {
      if (expiresAt <= now) sessions.delete(sessionID)
    }
    if (sessions.size > 0) continue
    state.delete(deviceID)
    offline.push(deviceID)
  }
  return offline
}

export type RemoteSocketCloseAction = "auth_required" | "refresh_token" | "reconnect" | "stop"

// 后端关闭原因是稳定协议：撤销后停止循环，token 到期先刷新，1013 和网络断开才进入退避重连。
export function remoteSocketCloseAction(code: number, reason: string): RemoteSocketCloseAction {
  if (reason === "REMOTE_CONTROL_AUTH_REVOKED") return "auth_required"
  if (reason === "TOKEN_EXPIRED") return "refresh_token"
  if (code === 1008) return "stop"
  return "reconnect"
}

// 工作区与独立 CLI 都能执行会话，但远控控制面只能由桌面 sidecar 唯一持有，避免同一命令被重复消费。
export function remoteControlAvailable(workspaceID: string | undefined, client: string | undefined) {
  return !workspaceID && client === "desktop"
}

// refresh token 已撤销与本地凭证缺失都需要停连并回到重新登录，不能进入普通网络退避。
export function remoteAuthRequired(error: unknown) {
  return (
    WanlaiCodeAuth.isOAuthExpiredError(error) ||
    (error instanceof Error && error.message === "WANLAICODE_OAUTH_REQUIRED")
  )
}

function remoteDeviceRecoveryRequired(error: unknown) {
  return error instanceof ProtocolError && error.code === "REMOTE_CONTROL_DEVICE_RECOVERY_REQUIRED"
}

// local 构建只把远控控制面指向本机后端；普通模型、OAuth 和购买端点仍使用品牌正式配置。
export function remoteControlApiEndpoint(input: { brandEndpoint: string; override?: string; local?: boolean }) {
  return (input.override || (input.local ? localRemoteControlEndpoint : input.brandEndpoint)).replace(/\/+$/, "")
}

function remoteControlEndpoint() {
  return remoteControlApiEndpoint({
    brandEndpoint: WanlaiCodeAuth.resolveConfig().endpoints.remoteControl,
    override: process.env.WANLAICODE_REMOTE_CONTROL_API,
    local: InstallationLocal,
  })
}

function privateIPv4(address: string) {
  const parts = address.split(".").map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false
  if (parts[0] === 10 || (parts[0] === 192 && parts[1] === 168)) return true
  return parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31
}

// 各平台只返回手机可解析的 Bonjour 名或真实网卡地址，不能凭空给普通 hostname 追加 .local。
export function mobileNetworkHost(input: {
  platform: NodeJS.Platform
  bonjour?: string
  hostname?: string
  addresses?: string[]
}) {
  const bonjour = input.bonjour?.trim().replace(/\.local$/i, "")
  if (input.platform === "darwin" && bonjour) return `${bonjour}.local`
  const hostname = input.hostname?.trim()
  if (hostname?.toLowerCase().endsWith(".local")) return hostname
  const addresses = (input.addresses ?? []).map((item) => item.trim()).filter(Boolean)
  return addresses.find(privateIPv4) ?? addresses[0]
}

function localNetworkHost() {
  let bonjour: string | undefined
  if (process.platform === "darwin") {
    try {
      // macOS 的 LocalHostName 才是 Bonjour 广播名，os.hostname() 可能只是不可解析的内核短名。
      bonjour = childProcess
        .execFileSync("/usr/sbin/scutil", ["--get", "LocalHostName"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 1_000,
        })
        .trim()
    } catch {}
  }
  const addresses = Object.values(os.networkInterfaces()).flatMap((items) =>
    (items ?? []).filter((item) => !item.internal && item.family === "IPv4").map((item) => item.address),
  )
  return mobileNetworkHost({ platform: process.platform, bonjour, hostname: os.hostname(), addresses })
}

// 二维码必须广告手机可访问的 API；本机回环地址只供桌面调用，不能直接交给手机。
export function mobilePairingApi(
  remoteControlEndpoint: string,
  options: { override?: string; localHost?: string } = {},
) {
  const override = options.override?.trim()
  const endpoint = new URL(override || remoteControlEndpoint.replace(/\/remote-control\/?$/, ""))
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
    throw new Error("Remote control mobile API must use HTTP or HTTPS")
  }
  const localOnly = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::", "[::]", "::1", "[::1]"])
  if (localOnly.has(endpoint.hostname.toLowerCase())) {
    if (override) throw new Error("Remote control mobile API override must use a reachable LAN or HTTPS hostname")
    const localHost = options.localHost?.trim() || localNetworkHost()
    if (!localHost || localOnly.has(localHost.toLowerCase())) {
      throw new Error("Remote control mobile API requires a LAN or Bonjour hostname")
    }
    endpoint.hostname = localHost
  }
  endpoint.pathname = endpoint.pathname.replace(/\/+$/, "")
  endpoint.search = ""
  endpoint.hash = ""
  return endpoint.toString().replace(/\/$/, "")
}

// 桌面端只生成万来品牌协议；参数由 URL API 编码，避免 API 地址或一次性密钥破坏二维码结构。
export function mobilePairingDeepLink(input: { api: string; pairingID: string; secret: string }) {
  const link = new URL("wanlai://pair")
  link.searchParams.set("api", input.api)
  link.searchParams.set("pairing_id", input.pairingID)
  link.searchParams.set("secret", input.secret)
  return link.toString()
}

// 设备令牌丢失时仅轮换远控身份，不改动全局机器 ID 或桌面账号登录态。
export function rotatedRemoteDeviceID(baseDeviceID: string, nonce: string = crypto.randomUUID()) {
  return crypto.createHash("sha256").update(`wanlaicode-remote-control|${baseDeviceID}|${nonce}`).digest("hex")
}

export function remoteRegistrationDecision(input: {
  existingToken?: string
  issuedToken?: string
  pending: boolean
  created?: boolean
}): { type: "ready"; token: string } | { type: "rotate" } | { type: "blocked" } | { type: "invalid" } {
  const token = input.existingToken || input.issuedToken
  if (token) return { type: "ready", token }
  if (input.created === false) return { type: input.pending ? "blocked" : "rotate" }
  return { type: "invalid" }
}

function boolean(value: unknown) {
  return value === true
}

function data(value: unknown) {
  return object(value)?.data ?? value
}

// Bridge 错误必须保留原会话 ID，手机才能只更新发起请求的聊天页。
export function relayErrorPayload(payload: unknown, error: { code: string; message: string }) {
  const input = object(payload)
  const message = object(input?.message)
  const sessionID = string(message?.sessionId) ?? string(message?.session_id)
  if (input?.type !== "bridge.client_message") return { type: "error", ...error }
  return {
    type: "bridge.server_message",
    message: {
      type: "error",
      message: error.message,
      errorCode: error.code,
      ...(sessionID ? { sessionId: sessionID } : {}),
    },
  }
}

function deviceInfo(deviceID?: string) {
  const headers = WanlaiCodeAuth.softwareHeaders()
  return {
    id: deviceID ?? headers["X-Wanlai-Device-Id"],
    name: headers["X-Wanlai-Device-Name"],
    os: headers["X-Wanlai-OS"],
    arch: headers["X-Wanlai-Arch"],
  }
}

function connection(value: unknown): RemoteControlConnection | undefined {
  const item = object(value)
  const mobile = object(item?.mobile_device)
  const id = string(item?.id)
  const deviceID = string(mobile?.device_id)
  if (!item || !mobile || !id || !deviceID) return
  return {
    id,
    device_id: deviceID,
    name: string(mobile.device_name) ?? "Mobile device",
    platform: string(mobile.platform),
    online: false,
    last_connected_at: string(mobile.last_seen_at),
  }
}

function connections(value: unknown) {
  const body = data(value)
  const items = Array.isArray(body) ? body : Array.isArray(object(body)?.items) ? object(body)?.items : []
  return (items as unknown[]).map(connection).filter((item): item is RemoteControlConnection => !!item)
}

export function relayAllowed(sourceDeviceID: string | undefined, items: RemoteControlConnection[]) {
  if (!sourceDeviceID) return false
  return items.some((item) => item.device_id === sourceDeviceID)
}

// 幂等键同时隔离账号和来源设备，避免不同手机复用相同 request_id 时串用缓存结果。
export function relayRequestKey(account: string, sourceDeviceID: string, requestID: string) {
  return JSON.stringify([account, sourceDeviceID, requestID])
}

// 用户附件与每个 tool 状态都发送权威完整快照，手机可按 messageUuid 原位替换并保持并发工具不丢失。
export function authoritativeBridgeEventReady(type: string | undefined, properties: unknown) {
  const value = object(properties)
  if (type === "session.status") return object(value?.status)?.type === "idle"
  if (type === "message.updated") {
    const info = object(value?.info)
    if (info?.role === "user") return true
    const time = object(info?.time)
    return info?.role === "assistant" && (!!number(time?.completed) || !!info.error)
  }
  if (type === "message.part.updated") {
    const part = object(value?.part)
    const state = object(part?.state)
    // 用户消息 info 会先于附件 part 落库；图片 part 到达时必须再取一次权威消息，避免手机实时漏图。
    if (part?.type === "file") return true
    return part?.type === "tool" && typeof state?.status === "string"
  }
  return false
}

class Gateway {
  private socket?: WebSocket
  private reconnect?: ReturnType<typeof setTimeout>
  private pairingPoll?: ReturnType<typeof setInterval>
  private accountPoll?: ReturnType<typeof setInterval>
  private presenceSweep?: ReturnType<typeof setInterval>
  private tokenRenewal?: ReturnType<typeof setTimeout>
  private accountValidation?: Promise<boolean>
  private running = false
  private attempts = 0
  private state: RemoteControlStatus["state"] = "disconnected"
  private lastError?: string
  private pairing?: PairingInfo
  private pending = new Map<string, PendingPairing>()
  private devices: RemoteControlConnection[] = []
  // 每台手机独立记录能力；旧客户端不声明该能力时继续发送原生 sync.event 兼容消息。
  private deviceCapabilities = new Map<string, Set<string>>()
  private completed = new RelayCompletionCache()
  private inflight = new Map<string, { fingerprint: string; promise: Promise<JsonObject[]> }>()
  private requestStateGeneration = 0
  private relayQueue: RelayOutboundJob[] = []
  private relayQueueRunning = false
  private relayQueueBytes = 0
  private relayQueueMaxBytes = relayOutboundQueueMaxBytes
  private activeRelayJob?: RelayOutboundJob
  private relayInboundQueue: RelayInboundJob[] = []
  private relayInboundRunning = false
  private relayInboundQueueBytes = 0
  private relayInboundQueueMaxBytes = relayInboundQueueMaxBytes
  private relayInboundGeneration = 0
  private activeInboundRelayJob?: RelayInboundJob
  private historyEventBarriers = new Map<string, HistoryEventBarrier>()
  private historyEventBufferBytes = 0
  private historyEventBufferCount = 0
  private pendingRelayDelivery?: PendingRelayDelivery
  private relayAckTimeoutMs = relayDeliveryAckTimeoutMs
  // 组装缓存归属当前桌面账号生命周期，退出、换号和停止 sidecar 时统一清空。
  private fragments = createRelayFragmentState()
  private presence: PresenceSessionState = new Map()
  private presenceRevision = new Map<string, number>()
  private connectionRefreshRevision = 0
  private revokedDeviceConnections = new Map<string, string | undefined>()
  private revokedConnectionIDs = new Set<string>()
  private partTypes = new Map<string, "text" | "reasoning">()
  private messageTurnIDs = new Map<string, string>()
  private partTurnIDs = new Map<string, string>()
  private requestTurnIDs = new Map<string, string>()
  private sessionTurnIDs = new Map<string, string>()
  private eventForwardChains = new Map<string, Promise<void>>()
  private sessionListForwardChain?: Promise<void>
  private pendingFileEvents = new Map<string, PendingFileEvent>()
  // 失效关闭帧必须绑定创建该 socket 时的 OAuth 代次，不能在回调到达时重新读取并误伤新登录。
  private socketCredentials = new WeakMap<WebSocket, Extract<Auth.Info, { type: "oauth" }>>()
  private connectedAccount?: string
  private observedAccount?: string | null
  private remoteDeviceID?: string
  private registration?: { account: string; promise: Promise<RemoteDeviceCredential> }
  private connection?: Promise<void>
  private lifecycle = 0
  private unsubscribe?: () => void

  status(): RemoteControlStatus {
    // 设置页轮询状态时顺便触发账号核验，缩短登录、退出后的连接切换延迟。
    if (this.running) void this.validateAccount()
    const device = deviceInfo(this.remoteDeviceID)
    return {
      state: this.state,
      device_id: device.id,
      device_name: device.name,
      ...(this.lastError ? { error: this.lastError } : {}),
      ...(this.pairing ? { pairing: this.pairing } : {}),
      pending_pairings: [...this.pending.values()],
      connections: this.devices,
    }
  }

  start() {
    if (this.running) return
    if (!remoteControlAvailable(Flag.WANLAICODE_WORKSPACE_ID, Flag.WANLAICODE_CLIENT)) {
      this.state = "disconnected"
      this.lastError = "REMOTE_CONTROL_DESKTOP_ONLY"
      return
    }
    this.running = true
    // Gateway 只建立出站连接；订阅同一 GlobalBus 后，桌面与手机天然共享一份会话状态。
    const handler = (event: GlobalEvent) => void this.enqueueForwardEvent(event)
    GlobalBus.on("event", handler)
    this.unsubscribe = () => GlobalBus.off("event", handler)
    // Auth.Service 没有变更订阅能力，轻量轮询用于兜住所有登录/退出入口。
    this.accountPoll = setInterval(() => void this.validateAccount(), 1_000)
    // presence 租约统一由一个轻量扫描器回收，避免每台手机的每条 WS 都长期持有独立 Timer。
    this.presenceSweep = setInterval(() => this.sweepPresence(), presenceSweepMs)
    void this.connect()
  }

  stop() {
    this.lifecycle += 1
    this.connectionRefreshRevision += 1
    this.running = false
    if (this.reconnect) clearTimeout(this.reconnect)
    if (this.pairingPoll) clearInterval(this.pairingPoll)
    if (this.accountPoll) clearInterval(this.accountPoll)
    if (this.presenceSweep) clearInterval(this.presenceSweep)
    if (this.tokenRenewal) clearTimeout(this.tokenRenewal)
    this.reconnect = undefined
    this.pairingPoll = undefined
    this.accountPoll = undefined
    this.presenceSweep = undefined
    this.tokenRenewal = undefined
    this.unsubscribe?.()
    this.unsubscribe = undefined
    this.clearInboundRelayQueue()
    this.clearRelayOutbound({ code: "REMOTE_CONTROL_STOPPED", message: "Remote control gateway stopped" })
    this.socket?.close(1000, "desktop shutdown")
    this.socket = undefined
    this.connectedAccount = undefined
    this.observedAccount = undefined
    this.remoteDeviceID = undefined
    this.registration = undefined
    this.connection = undefined
    this.clearPresenceState()
    this.revokedDeviceConnections.clear()
    this.revokedConnectionIDs.clear()
    this.clearPendingFileEvents()
    this.clearTurnRoutingState()
    this.clearRequestState()
    clearRelayFragmentAssemblies(this.fragments)
    this.state = "disconnected"
  }

  // 只读取当前持久化 OAuth 凭据，不触发刷新；关闭帧与建连 CAS 都需要据此比较精确代次。
  private async currentOAuthCredential() {
    const auth = await AppRuntime.runPromise(Auth.Service.use((service) => service.get("wanlaicode")))
    return auth?.type === "oauth" ? auth : undefined
  }

  private async oauthCredential(force = false) {
    const auth = await this.currentOAuthCredential()
    if (!auth) throw new Error("WANLAICODE_OAUTH_REQUIRED")
    if (WanlaiCodeRefreshCoordinator.isCredentialInvalid(auth)) {
      throw WanlaiCodeAuth.oauthExpiredError("oauth credential revision is invalid")
    }
    if (!force && auth.softwareToken && auth.expires * 1000 > Date.now() + 60_000) {
      return { token: auth.softwareToken, credential: auth }
    }
    const refreshed = await WanlaiCodeRefreshCoordinator.refresh({ reason: "remote-control" })
    // 刷新结果与原账号资料组合成 socket 快照；失效判断只读取三元组，不会受资料异步补全影响。
    return {
      token: refreshed.softwareToken,
      credential: {
        ...auth,
        access: refreshed.runtimeKey,
        refresh: refreshed.refreshToken,
        softwareToken: refreshed.softwareToken,
        expires: refreshed.expires,
      },
    }
  }

  private async oauthToken(force = false) {
    return (await this.oauthCredential(force)).token
  }

  private async accountKey() {
    const auth = await this.currentOAuthCredential()
    if (!auth) throw new Error("WANLAICODE_OAUTH_REQUIRED")
    // 刷新协调器已经撤销的 OAuth 代次不能只凭账号哈希继续通过核验，否则旧 socket 仍可消费手机命令。
    if (WanlaiCodeRefreshCoordinator.isCredentialInvalid(auth)) {
      throw WanlaiCodeAuth.oauthExpiredError("oauth credential revision is invalid")
    }
    const identity = auth.accountId ?? auth.accountEmail
    if (identity) return crypto.createHash("sha256").update(identity).digest("hex").slice(0, 24)
    const payload = auth.softwareToken?.split(".")[1]
    if (!payload) throw new Error("WANLAICODE_ACCOUNT_ID_REQUIRED")
    const claims = object(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")))
    const subject = string(claims?.sub) ?? string(claims?.uuid)
    if (!subject) throw new Error("WANLAICODE_ACCOUNT_ID_REQUIRED")
    return crypto.createHash("sha256").update(subject).digest("hex").slice(0, 24)
  }

  // 账号变化必须原子清理旧白名单、配对和幂等结果，旧 WS 关闭后不能继续操作当前桌面会话。
  private clearAccountState(accountAvailable: boolean) {
    this.lifecycle += 1
    this.connectionRefreshRevision += 1
    if (this.reconnect) clearTimeout(this.reconnect)
    if (this.tokenRenewal) clearTimeout(this.tokenRenewal)
    this.reconnect = undefined
    this.tokenRenewal = undefined
    this.stopPairingPoll()
    this.pairing = undefined
    this.pending.clear()
    this.devices = []
    this.deviceCapabilities.clear()
    this.presence.clear()
    this.presenceRevision.clear()
    this.revokedDeviceConnections.clear()
    this.revokedConnectionIDs.clear()
    this.clearTurnRoutingState()
    this.clearPendingFileEvents()
    this.clearRequestState()
    this.clearInboundRelayQueue()
    this.clearRelayOutbound({ code: "REMOTE_CONTROL_ACCOUNT_CHANGED", message: "Remote control account changed" })
    clearRelayFragmentAssemblies(this.fragments)
    this.attempts = 0
    this.lastError = undefined
    this.connectedAccount = undefined
    this.deviceCapabilities.clear()
    // 无有效凭据时同步清空观察值；同一账号稍后恢复后也能被轮询识别为新的可连接边界。
    if (!accountAvailable) this.observedAccount = null
    this.remoteDeviceID = undefined
    this.registration = undefined
    this.connection = undefined
    const socket = this.socket
    this.socket = undefined
    socket?.close(4001, "account changed")
    this.state = accountAvailable ? "disconnected" : "auth_required"
  }

  private clearPendingFileEvents() {
    this.pendingFileEvents.forEach((pending) => {
      clearTimeout(pending.timer)
      // 生命周期失效时必须释放链上的合并屏障，后续旧 Promise 才能完成并被代次检查丢弃。
      pending.release()
    })
    this.pendingFileEvents.clear()
  }

  private clearTurnRoutingState() {
    this.partTypes.clear()
    this.messageTurnIDs.clear()
    this.partTurnIDs.clear()
    this.requestTurnIDs.clear()
    this.sessionTurnIDs.clear()
    this.eventForwardChains.clear()
    // 账号生命周期切换后，新账号的列表刷新不能继续等待旧账号尚未结束的快照任务。
    this.sessionListForwardChain = undefined
  }

  private enqueueForwardEvent(
    event: GlobalEvent,
    coalescedFile = false,
    targetDeviceID?: string,
    replayBarrier?: HistoryEventBarrier,
    expectedLifecycle = this.lifecycle,
  ) {
    // 所有同会话事件继续共用原有链，确保 session.created/updated 不会被后续消息或状态越过。
    const chainKey = eventSessionID(event) ?? "__global__"
    const previous = this.eventForwardChains.get(chainKey) ?? Promise.resolve()
    const properties = object(object(event.payload)?.properties)
    const eventType = string(object(event.payload)?.type)
    const updatesSessionProjection =
      eventType?.startsWith("session.") || eventType?.startsWith("permission.") || eventType?.startsWith("question.")
    // 事件到达时固定已有列表屏障；旧快照必须先发送，随后终态/审批事件才能成为手机上的最终状态。
    const sessionListBarrier = updatesSessionProjection ? this.sessionListForwardChain : undefined
    const part = object(properties?.part)
    const messageID = string(part?.messageID)
    const fileKey =
      !coalescedFile && part?.type === "file" && chainKey !== "__global__" && messageID
        ? JSON.stringify([chainKey, messageID])
        : undefined
    const existingFile = fileKey ? this.pendingFileEvents.get(fileKey) : undefined
    if (existingFile && existingFile.lifecycle === expectedLifecycle) {
      // 同一用户消息的连续图片 part 只更新待发送快照，并把 25ms 合并窗口延后到最后一个 part。
      existingFile.event = event
      existingFile.targetDeviceID = targetDeviceID
      existingFile.replayBarrier = replayBarrier
      clearTimeout(existingFile.timer)
      existingFile.timer = setTimeout(existingFile.release, 25)
      return existingFile.promise
    }

    let releaseFile: (() => void) | undefined
    const fileDelay = fileKey
      ? new Promise<void>((resolve) => {
          releaseFile = resolve
        })
      : undefined
    const pendingFile =
      fileKey && fileDelay && releaseFile
        ? ({
            event,
            targetDeviceID,
            replayBarrier,
            lifecycle: expectedLifecycle,
            timer: setTimeout(releaseFile, 25),
            release: releaseFile,
            promise: Promise.resolve(),
          } satisfies PendingFileEvent)
        : undefined
    // 同一会话按 GlobalBus 到达顺序执行；全局 session_list 由独立任务链串行，不改变会话内顺序。
    const current = previous
      .catch((error) => {
        log.warn("remote bridge event queue recovered", {
          sessionID: chainKey === "__global__" ? undefined : chainKey,
          error: error instanceof Error ? error.message : String(error),
        })
      })
      .then(async () => {
        if (pendingFile && fileKey && fileDelay) {
          await fileDelay
          if (this.pendingFileEvents.get(fileKey) === pendingFile) this.pendingFileEvents.delete(fileKey)
        }
        if (!this.running || expectedLifecycle !== this.lifecycle) return
        const nextEvent = pendingFile?.event ?? event
        await this.forwardEvent(
          nextEvent,
          coalescedFile || !!pendingFile,
          pendingFile?.targetDeviceID ?? targetDeviceID,
          pendingFile?.replayBarrier ?? replayBarrier,
          expectedLifecycle,
          sessionListBarrier,
        )
      })
    if (pendingFile && fileKey) {
      pendingFile.promise = current
      this.pendingFileEvents.set(fileKey, pendingFile)
    }
    this.eventForwardChains.set(chainKey, current)
    const cleanup = () => {
      if (this.eventForwardChains.get(chainKey) === current) this.eventForwardChains.delete(chainKey)
    }
    // 成功与失败都显式消费，避免 finally 派生出的 rejected Promise 变成未处理异常。
    void current.then(cleanup, (error) => {
      cleanup()
      log.warn("remote bridge event forwarding failed", {
        sessionID: chainKey === "__global__" ? undefined : chainKey,
        error: error instanceof Error ? error.message : String(error),
      })
    })
    return current
  }

  private enqueueSessionListTask<T>(task: () => Promise<T>) {
    const previous = this.sessionListForwardChain ?? Promise.resolve()
    // 快照读取与最终 ACK 发送必须在同一条链内完成，不能只串行读取后让旧响应在链外迟到。
    const result = previous.then(task, task)
    const tail = result.then(
      () => undefined,
      () => undefined,
    )
    this.sessionListForwardChain = tail
    void tail.then(() => {
      if (this.sessionListForwardChain === tail) this.sessionListForwardChain = undefined
    })
    return result
  }

  private rememberTurnRoute(routes: Map<string, string>, key: string | undefined, turnID: string | undefined) {
    if (!key || !turnID) return
    // Map 的插入顺序同时充当轻量 LRU；重复命中先删除再写回，保留最近仍可能收到迟到事件的回合。
    routes.delete(key)
    routes.set(key, turnID)
    while (routes.size > remoteTurnRouteMaxEntries) {
      const oldest = routes.keys().next().value
      if (!oldest) break
      routes.delete(oldest)
    }
  }

  private recordTurnRouting(
    type: string | undefined,
    sessionID: string | undefined,
    properties: JsonObject | undefined,
  ) {
    if (!type || !properties) return
    const info = object(properties.info)
    if (type === "message.updated" && info) {
      const messageID = string(info.id)
      const turnID = info.role === "user" ? messageID : string(info.parentID)
      this.rememberTurnRoute(this.messageTurnIDs, messageID, turnID)
      // 排队中的下一条 user message 不能抢占当前 assistant 的会话级错误归属；只由 assistant 激活 fallback。
      if (info.role === "assistant" && sessionID && turnID) this.sessionTurnIDs.set(sessionID, turnID)
    }

    const part = object(properties.part)
    const partID = string(part?.id) ?? string(properties.partID)
    if (type === "message.part.updated") {
      const messageID = string(part?.messageID)
      const turnID = messageID ? this.messageTurnIDs.get(messageID) : undefined
      this.rememberTurnRoute(this.partTurnIDs, partID, turnID)
    }
    if (type === "message.part.removed" && partID) {
      this.partTypes.delete(partID)
      this.partTurnIDs.delete(partID)
    }
    if (type === "permission.asked" || type === "question.asked") {
      const requestID = string(properties.id)
      const toolMessageID = string(object(properties.tool)?.messageID)
      const turnID = toolMessageID ? this.messageTurnIDs.get(toolMessageID) : undefined
      this.rememberTurnRoute(this.requestTurnIDs, requestID, turnID)
    }
    if (type === "session.status" && sessionID) {
      const statusType = string(object(properties.status)?.type)
      if (statusType !== "busy" && statusType !== "retry") {
        // idle 代表旧 assistant 已结束；下一回合尚未创建 assistant 前的错误不能继承上一回合。
        this.sessionTurnIDs.delete(sessionID)
      }
    }
    if (type === "session.deleted" && sessionID) this.sessionTurnIDs.delete(sessionID)
  }

  private eventTurnID(type: string | undefined, sessionID: string | undefined, properties: JsonObject | undefined) {
    if (!type || !properties) return sessionID ? this.sessionTurnIDs.get(sessionID) : undefined
    const info = object(properties.info)
    const directMessageID = string(info?.id)
    if (info?.role === "user" && directMessageID) return directMessageID
    const parentID = string(info?.parentID)
    if (parentID) return parentID

    const part = object(properties.part)
    const partID = string(part?.id) ?? string(properties.partID)
    const partTurnID = partID ? this.partTurnIDs.get(partID) : undefined
    if (partTurnID) return partTurnID
    const partMessageID = string(part?.messageID)
    const messageTurnID = partMessageID ? this.messageTurnIDs.get(partMessageID) : undefined
    if (messageTurnID) return messageTurnID

    const requestID = string(properties.requestID) ?? string(properties.id)
    const requestTurnID = requestID ? this.requestTurnIDs.get(requestID) : undefined
    if (requestTurnID) return requestTurnID

    // permission/question 事件会回指触发它的 assistant message；优先使用该精确关系，再回退到会话当前回合。
    const toolMessageID = string(object(properties.tool)?.messageID)
    const toolTurnID = toolMessageID ? this.messageTurnIDs.get(toolMessageID) : undefined
    return toolTurnID ?? (sessionID ? this.sessionTurnIDs.get(sessionID) : undefined)
  }

  private clearRequestState() {
    this.requestStateGeneration += 1
    this.completed.clear()
    this.inflight.clear()
  }

  private validateAccount() {
    if (this.accountValidation) return this.accountValidation
    const lifecycle = this.lifecycle
    this.accountValidation = this.accountKey()
      .catch(() => undefined)
      .then((account) => {
        // 显式登录、退出或换号会推进 lifecycle；旧账号核验完成后不得再覆盖新认证状态。
        if (lifecycle !== this.lifecycle) return false
        const observed = account ?? null
        this.observedAccount = observed
        if (!this.connectedAccount) {
          // accountKey 已拒绝失效代次；只要当前凭据有效，就允许同账号重新认证后从 auth_required 恢复。
          if (account && this.state === "auth_required") {
            this.state = "disconnected"
            this.lastError = undefined
            if (this.running) void this.connect()
          }
          return !!account
        }
        if (account === this.connectedAccount) return true
        this.clearAccountState(!!account)
        if (account && this.running) void this.connect()
        return false
      })
      .finally(() => {
        this.accountValidation = undefined
      })
    return this.accountValidation
  }

  async authChanged() {
    const account = await this.accountKey().catch(() => undefined)
    this.observedAccount = account ?? null
    // OAuth callback/delete 是权威认证边界；即使账号哈希相同，也要废弃仍绑定旧 token 的连接与在途建连。
    this.clearAccountState(!!account)
    if (account && this.running) void this.connect()
  }

  private async scheduleTokenRenewal(expected?: { socket: WebSocket; generation: number }) {
    if (this.tokenRenewal) clearTimeout(this.tokenRenewal)
    this.tokenRenewal = undefined
    const target = expected ?? (this.socket ? { socket: this.socket, generation: this.lifecycle } : undefined)
    if (!target) return
    const auth = await AppRuntime.runPromise(Auth.Service.use((service) => service.get("wanlaicode"))).catch(
      () => undefined,
    )
    if (!this.socketEventActive(target.socket, target.generation)) return
    if (!auth || auth.type !== "oauth") return
    // JWT 到期前一分钟刷新并重建 WS，避免等后端按 exp 主动关闭后才恢复远控。
    const delay = Math.min(2_147_000_000, Math.max(1_000, auth.expires * 1_000 - Date.now() - 60_000))
    this.tokenRenewal = setTimeout(() => {
      this.tokenRenewal = undefined
      void this.renewSocketToken(target)
    }, delay)
  }

  private async renewSocketToken(expected: { socket: WebSocket; generation: number }) {
    await this.oauthToken().catch(() => undefined)
    // 旧定时器刷新期间发生换号或重连时，只允许关闭它最初绑定的 socket。
    if (this.socketEventActive(expected.socket, expected.generation))
      expected.socket.close(4002, "oauth token refreshed")
  }

  private async storedIdentity(account?: string) {
    const key = `${credentialPrefix}:${account ?? (await this.accountKey())}`
    const auth = await AppRuntime.runPromise(Auth.Service.use((service) => service.get(key)))
    if (auth?.type !== "wellknown" || !auth.key || !auth.token) return
    return {
      deviceID: auth.key,
      token: auth.token,
      pending: auth.token === pendingDeviceCredential,
    }
  }

  private async credential(account?: string): Promise<RemoteDeviceCredential | undefined> {
    const stored = await this.storedIdentity(account)
    if (!stored || stored.pending) return
    return { deviceID: stored.deviceID, token: stored.token }
  }

  private async saveCredential(credential: RemoteDeviceCredential, account: string) {
    const key = `${credentialPrefix}:${account}`
    // Auth.Service 使用 0600 的 auth.json，复用它可以避免 device_token 进入 renderer 或普通设置存储。
    await AppRuntime.runPromise(
      Auth.Service.use((service) =>
        service.set(key, { type: "wellknown", key: credential.deviceID, token: credential.token }),
      ),
    )
  }

  private async savePendingIdentity(deviceID: string, account: string) {
    const key = `${credentialPrefix}:${account}`
    // 随机恢复 ID 必须先落盘再请求服务端；响应丢失后重试同一 ID，不能继续制造新设备。
    await AppRuntime.runPromise(
      Auth.Service.use((service) =>
        service.set(key, { type: "wellknown", key: deviceID, token: pendingDeviceCredential }),
      ),
    )
  }

  private async removeCredential(account: string) {
    const key = `${credentialPrefix}:${account}`
    // 仅删除当前账号的远控令牌，OAuth 与其他 provider 凭证必须完整保留。
    await AppRuntime.runPromise(Auth.Service.use((service) => service.remove(key)))
  }

  private async request(
    path: string,
    init: RequestInit = {},
    refresh = true,
    identity?: RemoteDeviceIdentity,
  ): Promise<unknown> {
    const credential = identity ?? (await this.credential().catch(() => undefined))
    const remoteDevice = deviceInfo(credential?.deviceID ?? this.remoteDeviceID)
    const response = await WanlaiCodeAuth.createFetch("WanlaiCode.remote-control")(
      `${remoteControlEndpoint()}${path}`,
      {
        ...init,
        headers: {
          ...Object.fromEntries(new Headers(init.headers)),
          ...WanlaiCodeAuth.softwareHeaders(),
          "X-Wanlai-Device-Id": remoteDevice.id,
          Authorization: `Bearer ${await this.oauthToken()}`,
          ...(credential?.token ? { "X-Wanlai-Device-Token": credential.token } : {}),
          "Content-Type": "application/json",
        },
      },
    )
    const body = response.ok ? undefined : object(await response.json().catch(() => undefined))
    const reason = string(body?.reason) ?? string(body?.code)
    if (response.status === 401 && refresh && reason !== invalidDeviceCredential) {
      await this.oauthToken(true)
      return this.request(path, init, false, identity)
    }
    if (!response.ok) {
      // 保留后端 reason，手机或设置页可区分连接已撤销、设备凭证失效和普通网络错误。
      throw new ProtocolError(
        reason ?? `REMOTE_CONTROL_HTTP_${response.status}`,
        string(body?.message) ?? `Remote control request failed (${response.status})`,
      )
    }
    if (response.status === 204) return {}
    return response.json() as Promise<unknown>
  }

  private async registerDevice(identity: RemoteDeviceIdentity) {
    const device = deviceInfo(identity.deviceID)
    const result = object(
      data(
        await this.request(
          "/devices/register",
          {
            method: "POST",
            body: JSON.stringify({
              device_id: device.id,
              device_type: "desktop",
              device_name: device.name,
              platform: `${device.os} ${device.arch}`.slice(0, 64),
              app_version: InstallationVersion,
            }),
          },
          true,
          identity,
        ),
      ),
    )
    return result
  }

  private async registerRotatedDevice(account: string) {
    const stored = await this.storedIdentity(account)
    if (!stored?.pending) await this.savePendingIdentity(rotatedRemoteDeviceID(deviceInfo().id), account)
    return this.registerCurrentDevice(account)
  }

  private async registerCurrentDevice(account: string): Promise<RemoteDeviceCredential> {
    const stored = await this.storedIdentity(account)
    const existing = stored && !stored.pending ? { deviceID: stored.deviceID, token: stored.token } : undefined
    const deviceID = stored?.deviceID ?? deviceInfo().id
    let result: JsonObject | undefined
    try {
      result = await this.registerDevice({ deviceID, token: existing?.token })
    } catch (error) {
      if (!(error instanceof ProtocolError) || error.code !== invalidDeviceCredential || !existing) throw error
      // 服务端明确拒绝旧令牌时做一次有界身份轮换，不能拿同一失效凭证无限重连。
      await this.removeCredential(account)
      return this.registerRotatedDevice(account)
    }
    const decision = remoteRegistrationDecision({
      existingToken: existing?.token,
      issuedToken: string(result?.device_token),
      pending: stored?.pending ?? false,
      created: typeof result?.created === "boolean" ? result.created : undefined,
    })
    if (decision.type === "rotate") {
      // 原稳定 ID 已存在但本地令牌丢失时只允许进入一次持久化恢复轮换。
      return this.registerRotatedDevice(account)
    }
    if (decision.type === "blocked") {
      throw new ProtocolError(
        "REMOTE_CONTROL_DEVICE_RECOVERY_REQUIRED",
        "Remote control device registration response was lost; clear the pending device before retrying",
      )
    }
    if (decision.type === "invalid") throw new Error("Remote control registration did not return device_token")
    const credential = { deviceID, token: decision.token }
    if (!existing || stored?.pending) await this.saveCredential(credential, account)
    return credential
  }

  private async ensureRegistered(account?: string): Promise<RemoteDeviceCredential> {
    account ??= await this.accountKey()
    const current = this.registration
    if (current?.account === account) return current.promise
    const generation = this.lifecycle
    let entry: { account: string; promise: Promise<RemoteDeviceCredential> }
    const promise = this.registerCurrentDevice(account)
      .then(async (credential) => {
        // 账号切换或 stop 后的迟到注册只能留在原账号安全存储，不能覆盖当前运行态身份。
        if (!this.running || generation !== this.lifecycle || (await this.accountKey()) !== account) {
          throw new Error("REMOTE_CONTROL_ACCOUNT_CHANGED")
        }
        this.remoteDeviceID = credential.deviceID
        return credential
      })
      .finally(() => {
        if (this.registration === entry) this.registration = undefined
      })
    entry = { account, promise }
    this.registration = entry
    return promise
  }

  private async refreshConnections(expectedAccount?: string) {
    const revision = ++this.connectionRefreshRevision
    const lifecycle = this.lifecycle
    const account = expectedAccount ?? (await this.accountKey())
    // 账号读取本身也可能跨越换号；任何网络请求前先确认它仍属于入口时捕获的代次。
    if (revision !== this.connectionRefreshRevision || lifecycle !== this.lifecycle) return
    const refreshed = connections(await this.request("/connections"))
    const currentAccount = await this.accountKey().catch(() => undefined)
    // 只允许当前账号、生命周期里的最后一次请求提交，旧 GET 不能覆盖更晚的撤权或配对结果。
    if (revision !== this.connectionRefreshRevision || lifecycle !== this.lifecycle || currentAccount !== account)
      return
    const visible = refreshed.filter((item) => {
      if (this.revokedConnectionIDs.has(item.id)) return false
      if (!this.revokedDeviceConnections.has(item.device_id)) return true
      const revokedConnectionID = this.revokedDeviceConnections.get(item.device_id)
      return !!revokedConnectionID && item.id !== revokedConnectionID
    })
    const approved = new Set(visible.map((item) => item.device_id))
    // 撤销的设备同时失去真实与 synthetic 租约，避免短 TTL 内重绑同 ID 时继承旧在线状态。
    for (const deviceID of this.presence.keys()) {
      if (!approved.has(deviceID)) this.presence.delete(deviceID)
    }
    for (const deviceID of this.presenceRevision.keys()) {
      if (!approved.has(deviceID)) this.presenceRevision.delete(deviceID)
    }
    this.devices = visible.map((item) => ({
      ...item,
      online: (this.presence.get(item.device_id)?.size ?? 0) > 0 || item.online,
    }))
    // 旧 connection 消失或同 device_id 出现新 connection 后释放设备墓碑，避免阻塞用户重新配对同一手机。
    for (const [deviceID, revokedConnectionID] of this.revokedDeviceConnections) {
      const replacements = refreshed.filter(
        (item) =>
          item.device_id === deviceID && item.id !== revokedConnectionID && !this.revokedConnectionIDs.has(item.id),
      )
      if (!refreshed.some((item) => item.device_id === deviceID) || (revokedConnectionID && replacements.length > 0)) {
        this.revokedDeviceConnections.delete(deviceID)
      }
    }
    for (const connectionID of this.revokedConnectionIDs) {
      if (!refreshed.some((item) => item.id === connectionID)) this.revokedConnectionIDs.delete(connectionID)
    }
  }

  private revokeConnectionState(connectionID?: string, sourceDeviceID?: string) {
    const revoked = this.devices.filter(
      (item) => item.id === connectionID || item.device_id === connectionID || item.device_id === sourceDeviceID,
    )
    // 先推进刷新代次并写墓碑，再清本地白名单；任何已在途的旧列表响应都会失去提交资格。
    this.connectionRefreshRevision += 1
    if (connectionID) this.revokedConnectionIDs.add(connectionID)
    revoked.forEach((item) => {
      this.revokedConnectionIDs.add(item.id)
      this.revokedDeviceConnections.set(item.device_id, item.id)
    })
    if (sourceDeviceID && (connectionID || !this.revokedDeviceConnections.has(sourceDeviceID))) {
      this.revokedDeviceConnections.set(sourceDeviceID, connectionID)
    }
    const revokedDeviceIDs = new Set(revoked.map((item) => item.device_id))
    if (sourceDeviceID) revokedDeviceIDs.add(sourceDeviceID)
    revokedDeviceIDs.forEach((deviceID) => {
      this.presence.delete(deviceID)
      this.presenceRevision.delete(deviceID)
      this.revokeRelayOutbound(deviceID)
    })
    this.devices = this.devices.filter(
      (item) => !revokedDeviceIDs.has(item.device_id) && item.id !== connectionID && item.device_id !== connectionID,
    )
    this.clearInboundRelayQueue()
    clearRelayFragmentAssemblies(this.fragments)
    this.clearRequestState()
  }

  private scheduleReconnect() {
    if (!this.running || this.reconnect) return
    const delay = Math.min(reconnectMaxMs, reconnectMinMs * 2 ** this.attempts)
    this.attempts += 1
    this.reconnect = setTimeout(() => {
      this.reconnect = undefined
      void this.connect()
    }, delay)
  }

  private connect() {
    if (this.connection) return this.connection
    const generation = this.lifecycle
    const pending = this.connectOnce(generation).finally(() => {
      if (this.connection === pending) this.connection = undefined
    })
    this.connection = pending
    return pending
  }

  private socketEventActive(socket: WebSocket, generation: number) {
    // CLOSING/CLOSED 阶段只等待 close 回调收尾，不能再让迟到 error 改写关闭原因或触发重复清理。
    return (
      this.running && generation === this.lifecycle && socket === this.socket && socket.readyState === WebSocket.OPEN
    )
  }

  private handleSocketOpen(socket: WebSocket, generation: number) {
    // WebSocket 构造后仍可能发生换号或新连接替换；旧 open 不能把新生命周期错误标成 connected。
    if (!this.socketEventActive(socket, generation)) return
    this.state = "connected"
    this.attempts = 0
    this.lastError = undefined
    void this.scheduleTokenRenewal({ socket, generation })
    void this.pollCurrentPairing().catch((error) =>
      log.warn("pairing state recovery failed", { error: error instanceof Error ? error.message : String(error) }),
    )
  }

  private handleSocketError(socket: WebSocket, generation: number, error: Error) {
    // 旧 socket 的迟到 error 不能清掉新连接正在等待的 ACK 或关闭新连接的出站队列。
    if (!this.socketEventActive(socket, generation)) return
    this.lastError = error.message
    this.clearInboundRelayQueue()
    this.clearRelayOutbound({ code: "REMOTE_CONTROL_RELAY_SOCKET_ERROR", message: error.message })
    // close 回调可能稍后才到，先撤销在线租约可阻止该窗口继续向已失效 socket 扇出事件。
    this.clearPresenceState()
    clearRelayFragmentAssemblies(this.fragments)
    socket.close(1011, "REMOTE_CONTROL_RELAY_SOCKET_ERROR")
  }

  private async connectOnce(generation: number) {
    if (!this.running || this.socket?.readyState === WebSocket.OPEN || this.socket?.readyState === WebSocket.CONNECTING)
      return
    this.state = "connecting"
    this.lastError = undefined
    try {
      const account = await this.accountKey()
      if (this.connectedAccount && this.connectedAccount !== account) {
        this.clearAccountState(true)
        if (this.running) void this.connect()
        return
      }
      const oauth = await this.oauthCredential()
      const credential = await this.ensureRegistered(account)
      await this.refreshConnections(account)
      if (!this.running || generation !== this.lifecycle) return
      if ((await this.accountKey()) !== account) {
        // 首次连接尚未写 connectedAccount 时也要识别账号切换，否则状态会永久停在 connecting。
        this.clearAccountState(true)
        if (this.running) void this.connect()
        return
      }
      const currentOAuth = await this.currentOAuthCredential().catch(() => undefined)
      if (!this.running || generation !== this.lifecycle) return
      if (!currentOAuth || WanlaiCodeRefreshCoordinator.isCredentialInvalid(currentOAuth)) {
        // 建连期间凭据被退出或明确撤销时停止当前链，不能继续用入口处捕获的旧 JWT 创建 socket。
        this.clearAccountState(false)
        return
      }
      if (
        WanlaiCodeRefreshCoordinator.credentialRevision(currentOAuth) !==
        WanlaiCodeRefreshCoordinator.credentialRevision(oauth.credential)
      ) {
        // 同账号的新登录可能发生在注册/列表请求期间；清空旧链后立即用最新凭据重新开始。
        this.clearAccountState(true)
        if (this.running) void this.connect()
        return
      }
      const url = new URL(`${remoteControlEndpoint()}/ws`)
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
      const socket = new WebSocket(url, "wanlai-remote-control", {
        headers: {
          ...WanlaiCodeAuth.softwareHeaders(),
          "X-Wanlai-Device-Id": credential.deviceID,
          Authorization: `Bearer ${oauth.token}`,
          "X-Wanlai-Device-Token": credential.token,
        },
      })
      this.connectedAccount = account
      this.socket = socket
      this.socketCredentials.set(socket, oauth.credential)
      socket.on("open", () => this.handleSocketOpen(socket, generation))
      socket.on("message", (message) => void this.handleMessage(message.toString(), socket))
      socket.on("error", (error) => this.handleSocketError(socket, generation, error))
      socket.on("close", (code, reason) => void this.handleSocketClose(socket, code, reason.toString()))
    } catch (error) {
      if (generation !== this.lifecycle) return
      const authRequired = remoteAuthRequired(error)
      const recoveryRequired = remoteDeviceRecoveryRequired(error)
      if (authRequired) this.clearAccountState(false)
      this.state = authRequired ? "auth_required" : "error"
      this.lastError =
        this.state === "auth_required" ? undefined : error instanceof Error ? error.message : String(error)
      // 恢复 ID 已存在时自动重连只会重复同一失败；等待用户在设置页主动创建新配对后再轮换。
      if (!authRequired && !recoveryRequired) this.scheduleReconnect()
    }
  }

  private updateDevicePresence(deviceID: string, online: boolean, createdAt?: string) {
    this.devices = this.devices.map((item) =>
      item.device_id === deviceID
        ? {
            ...item,
            online,
            ...(createdAt ? { last_connected_at: createdAt } : {}),
          }
        : item,
    )
  }

  private clearPresenceState() {
    this.presence.clear()
    this.presenceRevision.clear()
    // relay socket 断开后重新握手，旧能力不能跨连接继承到可能已降级的客户端。
    this.deviceCapabilities.clear()
    this.devices = this.devices.map((item) => ({ ...item, online: false }))
  }

  private rememberDeviceCapabilities(sourceDeviceID: string, payload: unknown) {
    const input = object(payload)
    const message = object(input?.message)
    if (input?.type !== "bridge.client_message" || message?.type !== "client_capabilities") return
    const requested = Array.isArray(message.capabilities)
      ? message.capabilities.filter((item): item is string => typeof item === "string")
      : []
    this.deviceCapabilities.set(sourceDeviceID, new Set(requested))
  }

  private supportsBridgeOnlyEvents(deviceID: string) {
    return this.deviceCapabilities.get(deviceID)?.has(bridgeOnlyEventsCapability) === true
  }

  private observeRelayPresence(
    deviceID: string,
    revision: number,
    lifecycle: number,
    generation: number,
    observedAt: number,
    socket?: WebSocket,
  ) {
    // relay 前若已收到真实 presence 或连接已切换，迟到的账号核验结果不能把设备错误复活。
    if (
      lifecycle !== this.lifecycle ||
      generation !== this.relayInboundGeneration ||
      (socket && socket !== this.socket) ||
      (this.presenceRevision.get(deviceID) ?? 0) !== revision
    ) {
      return
    }
    // 排队或账号核验不能延长旧 relay 的在线寿命；超过接收时刻租约后不再延迟复活手机。
    if (observedAt + presenceDefaultTTLSeconds * 1_000 <= Date.now()) return
    const online = applyPresenceEvent(
      this.presence,
      {
        deviceID,
        presence: "online",
        sessionID: relayObservedPresenceSessionID,
        ttlSeconds: presenceDefaultTTLSeconds,
      },
      observedAt,
    )
    this.updateDevicePresence(deviceID, online)
  }

  private sweepPresence() {
    // 租约到期只影响对应设备；其他手机的在线状态和当前桌面 WS 均保持不变。
    prunePresenceSessions(this.presence).forEach((deviceID) => this.updateDevicePresence(deviceID, false))
    // 复用现有秒级扫描器回收半包，避免为远控分片额外创建常驻 Timer。
    pruneRelayFragmentAssemblies(this.fragments)
  }

  private async handleSocketClose(socket: WebSocket, code: number, reason: string) {
    // 账号切换时旧 socket 的迟到 close 事件不能覆盖新账号状态或重连计划。
    if (this.socket !== socket) return
    const lifecycle = this.lifecycle
    const closeStillCurrent = () => this.running && lifecycle === this.lifecycle && !this.socket
    this.socket = undefined
    this.clearInboundRelayQueue()
    this.clearRelayOutbound({
      code: "REMOTE_CONTROL_RELAY_SOCKET_CLOSED",
      message: reason || `Remote control WebSocket closed (${code})`,
    })
    if (this.tokenRenewal) clearTimeout(this.tokenRenewal)
    this.tokenRenewal = undefined
    this.clearPresenceState()
    clearRelayFragmentAssemblies(this.fragments)
    if (!this.running) {
      this.state = "disconnected"
      return
    }

    const action = remoteSocketCloseAction(code, reason)
    if (action === "auth_required") {
      const credential = this.socketCredentials.get(socket)
      // 后端明确撤销当前 socket 的授权后同步全局认证结论，用户中心 status 随即要求重新登录。
      if (credential) WanlaiCodeRefreshCoordinator.markCredentialInvalid(credential)
      const currentOAuth = await this.currentOAuthCredential().catch(() => undefined)
      if (!closeStillCurrent()) return
      if (
        credential &&
        currentOAuth &&
        !WanlaiCodeRefreshCoordinator.isCredentialInvalid(currentOAuth) &&
        WanlaiCodeRefreshCoordinator.credentialRevision(currentOAuth) !==
          WanlaiCodeRefreshCoordinator.credentialRevision(credential)
      ) {
        // 旧 socket 的迟到撤权只保留旧代次墓碑；当前新登录仍有效时直接重建远控连接。
        this.clearAccountState(true)
        if (this.running) void this.connect()
        return
      }
      this.clearAccountState(false)
      this.lastError = "REMOTE_CONTROL_AUTH_REVOKED: 登录状态已被服务端撤销"
      return
    }
    if (action === "stop") {
      this.state = "error"
      this.lastError = reason || `REMOTE_CONTROL_WS_POLICY_${code}`
      return
    }

    this.state = "disconnected"
    if (action === "refresh_token") {
      try {
        // TOKEN_EXPIRED 必须先强制刷新 JWT，再建立下一条 WS，不能继续复用已到期 token。
        await this.oauthToken(true)
        if (!closeStillCurrent()) return
        this.lastError = undefined
      } catch (error) {
        if (!closeStillCurrent()) return
        if (remoteAuthRequired(error)) {
          this.clearAccountState(false)
          this.lastError = "WANLAICODE_OAUTH_REQUIRED: 登录已过期，请重新登录"
          return
        }
        const accountValid = await this.validateAccount()
        if (!closeStillCurrent()) return
        if (!accountValid) {
          this.clearAccountState(false)
          return
        }
        this.state = "error"
        this.lastError = error instanceof Error ? error.message : String(error)
      }
    } else if (reason) {
      this.lastError = reason
    }
    if (!closeStillCurrent()) return
    this.scheduleReconnect()
  }

  private relay(targetDeviceID: string, payload: JsonObject, requestID?: string): Promise<RelaySendResult> {
    if (this.socket?.readyState !== WebSocket.OPEN) return Promise.resolve({ type: "unavailable" })
    let bytes: number
    try {
      bytes = Buffer.byteLength(JSON.stringify(payload), "utf8")
    } catch (error) {
      return Promise.resolve({ type: "rejected", error: protocolError(error) })
    }
    if (bytes > relayFragmentMaxAssembledBytes) {
      return Promise.resolve({
        type: "rejected",
        error: {
          code: "RELAY_PAYLOAD_TOO_LARGE",
          message: `relay payload exceeds ${relayFragmentMaxAssembledBytes} bytes`,
        },
      })
    }
    if (this.relayQueueBytes + bytes > this.relayQueueMaxBytes) {
      const error = {
        code: "REMOTE_CONTROL_RELAY_QUEUE_BYTES_EXCEEDED",
        message: "Remote control relay queue byte budget was exceeded",
      }
      // 当前执行和待发送 payload 共用 64MiB 预算；超限后必须重连，让手机用权威历史修复未发送事件。
      this.failRelayQueue(error)
      return Promise.resolve({ type: "rejected", error })
    }
    if (this.relayQueue.length + (this.relayQueueRunning ? 1 : 0) >= relayOutboundQueueLimit) {
      const error = { code: "REMOTE_CONTROL_RELAY_QUEUE_FULL", message: "Remote control relay queue is full" }
      // 数量溢出同样意味着主动事件可能缺失，不能只丢最终 idle。
      this.failRelayQueue(error)
      return Promise.resolve({ type: "rejected", error })
    }
    return new Promise((resolve) => {
      this.relayQueueBytes += bytes
      this.relayQueue.push({ targetDeviceID, payload, requestID, bytes, resolve })
      void this.drainRelayQueue()
    })
  }

  // 单 worker 让整个桌面连接始终只有一个未确认 envelope，避免历史分片压入本地 ws 缓冲。
  private async drainRelayQueue() {
    if (this.relayQueueRunning) return
    this.relayQueueRunning = true
    try {
      for (;;) {
        const job = this.relayQueue.shift()
        if (!job) return
        this.activeRelayJob = job
        let result: RelaySendResult
        try {
          result = await this.deliverRelay(job.targetDeviceID, job.payload, job.requestID)
        } catch (error) {
          result = { type: "rejected", error: protocolError(error) }
        } finally {
          this.releaseRelayJob(job)
          if (this.activeRelayJob === job) this.activeRelayJob = undefined
        }
        job.resolve(result)
      }
    } finally {
      this.relayQueueRunning = false
      if (this.relayQueue.length > 0) void this.drainRelayQueue()
    }
  }

  private async deliverRelay(
    targetDeviceID: string,
    payload: JsonObject,
    requestID?: string,
  ): Promise<RelaySendResult> {
    let envelopes: JsonObject[]
    try {
      envelopes = relayEnvelopes(targetDeviceID, payload, requestID)
    } catch (error) {
      return { type: "rejected", error: protocolError(error) }
    }
    for (const envelope of envelopes) {
      const result = await this.deliverRelayEnvelope(envelope)
      // 任一片未获后端交付确认时立即停止，当前逻辑消息的后续片绝不能继续写入。
      if (result.type !== "sent") return result
    }
    return { type: "sent" }
  }

  private deliverRelayEnvelope(envelope: JsonObject): Promise<RelaySendResult> {
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.resolve({ type: "unavailable" })
    const targetDeviceID = string(envelope.target_device_id)
    const requestID = string(envelope.request_id) ?? `delivery:${crypto.randomUUID()}`
    if (!targetDeviceID || !validRelayRequestID(requestID)) {
      return Promise.resolve({
        type: "rejected",
        error: { code: "INVALID_RELAY_REQUEST_ID", message: "relay request_id must contain 1-512 UTF-8 bytes" },
      })
    }

    return new Promise((resolve) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout>
      const finish = (result: RelaySendResult) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (this.pendingRelayDelivery?.finish === finish) this.pendingRelayDelivery = undefined
        resolve(result)
      }
      timer = setTimeout(() => {
        const error = {
          code: "REMOTE_CONTROL_RELAY_ACK_TIMEOUT",
          message: "Relay delivery acknowledgement timed out",
        }
        // ACK 丢失时无法判断目标是否已收到，必须清队列并断线重连，随后用权威历史覆盖可能的缺口。
        this.clearRelayOutbound(error)
        if (this.socket === socket) socket.close(1013, error.code)
      }, this.relayAckTimeoutMs)
      this.pendingRelayDelivery = { socket, targetDeviceID, requestID, finish }
      try {
        socket.send(JSON.stringify({ ...envelope, request_id: requestID }), (error) => {
          if (!error) return
          const info = { code: "REMOTE_CONTROL_RELAY_SEND_FAILED", message: error.message }
          this.clearRelayOutbound(info)
          if (this.socket === socket) socket.close(1011, info.code)
        })
      } catch (error) {
        const info = protocolError(error)
        this.clearRelayOutbound(info)
        if (this.socket === socket) socket.close(1011, "REMOTE_CONTROL_RELAY_SEND_FAILED")
      }
    })
  }

  private clearRelayOutbound(error: { code: string; message: string }) {
    if (this.activeRelayJob) this.releaseRelayJob(this.activeRelayJob)
    this.pendingRelayDelivery?.finish({ type: "rejected", error })
    this.pendingRelayDelivery = undefined
    this.relayQueue.splice(0).forEach((job) => {
      this.releaseRelayJob(job)
      job.resolve({ type: "rejected", error })
    })
  }

  private revokeRelayOutbound(deviceID: string) {
    const error = {
      code: "REMOTE_CONTROL_DEVICE_REVOKED",
      message: "Remote control device was revoked",
    }
    // 单 worker 的 active envelope 只能通过 pending finish 中断；deliverRelay 会据此停止后续分片。
    if (this.activeRelayJob?.targetDeviceID === deviceID && this.pendingRelayDelivery?.targetDeviceID === deviceID) {
      this.pendingRelayDelivery.finish({ type: "rejected", error })
    }
    const retained: RelayOutboundJob[] = []
    this.relayQueue.splice(0).forEach((job) => {
      if (job.targetDeviceID !== deviceID) {
        retained.push(job)
        return
      }
      this.releaseRelayJob(job)
      job.resolve({ type: "rejected", error })
    })
    this.relayQueue.push(...retained)
  }

  private releaseRelayJob(job: RelayOutboundJob) {
    if (job.released) return
    job.released = true
    this.relayQueueBytes = Math.max(0, this.relayQueueBytes - job.bytes)
  }

  private failRelayQueue(error: { code: string; message: string }) {
    this.lastError = `${error.code}: ${error.message}`
    this.clearRelayOutbound(error)
    this.socket?.close(1013, error.code)
  }

  // 请求响应过大或编码失败时回传有界错误；合法逻辑 request_id 原样保留，便于手机完成请求配对。
  private async relayRequestResponse(
    targetDeviceID: string,
    requestPayload: unknown,
    responsePayload: JsonObject,
    requestID?: string,
  ) {
    const outcome = await this.relay(targetDeviceID, responsePayload, requestID)
    if (outcome.type !== "rejected") return outcome.type === "sent"
    if (!relayResponseFallbackErrors.has(outcome.error.code)) {
      // 交付错误、ACK 超时和连接关闭已经说明传输不可用；继续发送 fallback 只会重复等待并放大积压。
      return false
    }
    const fallbackRequestID = validRelayRequestID(requestID) ? requestID : undefined
    let fallback = await this.relay(targetDeviceID, relayErrorPayload(requestPayload, outcome.error), fallbackRequestID)
    if (fallback.type === "rejected") {
      // 恶意超长 sessionId 可能令 Bridge 形态错误仍过大，最终退回不引用原请求的固定小信封。
      fallback = await this.relay(targetDeviceID, { type: "error", ...outcome.error }, fallbackRequestID)
    }
    if (fallback.type === "rejected") {
      log.warn("remote request error relay dropped", {
        deviceID: targetDeviceID,
        requestID: fallbackRequestID,
        code: fallback.error.code,
        error: fallback.error.message,
      })
    }
    return false
  }

  // 主动事件没有等待中的请求可回错，编码失败只记录有界上下文并丢弃当前事件。
  private async relayEvent(targetDeviceID: string, payload: JsonObject, eventType?: string) {
    // forwardEvent 可能在数据库读取或其他手机 ACK 上等待；真正入队前必须复核目标仍在线且未被撤权。
    if (!this.devices.some((item) => item.device_id === targetDeviceID && item.online)) return false
    const outcome = await this.relay(targetDeviceID, payload)
    if (outcome.type !== "rejected") return outcome.type === "sent"
    log.warn("remote event relay dropped", {
      deviceID: targetDeviceID,
      eventType,
      code: outcome.error.code,
      error: outcome.error.message,
    })
    return false
  }

  private async handleRelay(envelope: JsonObject, socket?: WebSocket) {
    const source = string(envelope.source_device_id) ?? string(envelope.device_id) ?? string(envelope.sender_device_id)
    const presenceRevision = source ? (this.presenceRevision.get(source) ?? 0) : 0
    const lifecycle = this.lifecycle
    const inboundGeneration = this.relayInboundGeneration
    if (lifecycle !== this.lifecycle || inboundGeneration !== this.relayInboundGeneration) return
    if (socket && (socket !== this.socket || socket.readyState !== WebSocket.OPEN)) return
    const outerRequestID = string(envelope.request_id)
    // relay 必须带明确来源且来源仍在已绑定列表；删除设备后缓存中的连接也会同步移除。
    if (!source || !relayAllowed(source, this.devices)) {
      if (source) {
        await this.relayRequestResponse(
          source,
          envelope.payload,
          relayErrorPayload(envelope.payload, {
            code: "REMOTE_CONTROL_RELAY_FORBIDDEN",
            message: "Device is not approved",
          }),
          validRelayRequestID(envelope.request_id) ? outerRequestID : undefined,
        )
      }
      return
    }
    if (!validRelayRequestID(envelope.request_id)) {
      await this.relayRequestResponse(
        source,
        envelope.payload,
        relayErrorPayload(envelope.payload, {
          code: "INVALID_RELAY_REQUEST_ID",
          message: "relay request_id must contain 1-512 UTF-8 bytes",
        }),
      )
      return
    }
    // 分片在幂等缓存和业务协议之前完成重组，后续逻辑只看到原 payload 与逻辑 request_id。
    let restored: RelayPayloadResult
    try {
      restored = acceptRelayPayload(this.fragments, source, envelope.payload, outerRequestID)
    } catch (error) {
      await this.relayRequestResponse(
        source,
        envelope.payload,
        relayErrorPayload(envelope.payload, protocolError(error)),
        outerRequestID,
      )
      return
    }
    if (restored.type === "pending") return
    const payload = restored.payload
    const requestID = restored.requestID
    if (!validRelayRequestID(requestID)) {
      const error = {
        code: "INVALID_RELAY_REQUEST_ID",
        message: "relay request_id must contain 1-512 UTF-8 bytes",
      }
      await this.relayRequestResponse(source, payload, relayErrorPayload(payload, error))
      return
    }
    // 先记住手机能力，再进入有界业务队列；握手本身的 ACK 也必须使用同一来源隔离。
    this.rememberDeviceCapabilities(source, payload)
    return this.enqueueInboundRelay(source, payload, requestID, presenceRevision, socket)
  }

  private enqueueInboundRelay(
    sourceDeviceID: string,
    payload: unknown,
    requestID: string,
    presenceRevision: number,
    socket?: WebSocket,
  ) {
    let bytes: number
    try {
      bytes = Buffer.byteLength(JSON.stringify(payload), "utf8")
    } catch (error) {
      const info = protocolError(error)
      return this.relayRequestResponse(sourceDeviceID, payload, relayErrorPayload(payload, info), requestID).then(
        () => undefined,
      )
    }
    if (
      bytes > this.relayInboundQueueMaxBytes ||
      this.relayInboundQueueBytes + bytes > this.relayInboundQueueMaxBytes
    ) {
      this.failInboundRelayQueue({
        code: "REMOTE_CONTROL_INBOUND_QUEUE_BYTES_EXCEEDED",
        message: "Remote control inbound queue byte budget was exceeded",
      })
      return Promise.resolve()
    }
    if (this.relayInboundQueue.length + (this.activeInboundRelayJob ? 1 : 0) >= relayInboundQueueLimit) {
      this.failInboundRelayQueue({
        code: "REMOTE_CONTROL_INBOUND_QUEUE_FULL",
        message: "Remote control inbound queue is full",
      })
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      let cancel: () => void = () => undefined
      const cancelled = new Promise<void>((cancelResolve) => (cancel = cancelResolve))
      this.relayInboundQueueBytes += bytes
      this.relayInboundQueue.push({
        sourceDeviceID,
        payload,
        requestID,
        bytes,
        generation: this.relayInboundGeneration,
        lifecycle: this.lifecycle,
        presenceRevision,
        observedAt: Date.now(),
        socket,
        cancelled,
        cancel,
        resolve,
      })
      void this.drainInboundRelayQueue()
    })
  }

  // 所有完整逻辑请求共用单 worker；分片 pending 和 ACK/presence 控制帧不会进入该队列。
  private async drainInboundRelayQueue() {
    if (this.relayInboundRunning) return
    this.relayInboundRunning = true
    try {
      for (;;) {
        const job = this.relayInboundQueue.shift()
        if (!job) return
        this.activeInboundRelayJob = job
        try {
          // 账号核验进入同一个有界 worker；close/撤销时 cancel race 立即释放旧核验，不再并发保留任意 payload。
          const accountValid = await Promise.race([this.validateAccount(), job.cancelled.then(() => false)])
          if (accountValid && this.inboundRelayJobActive(job)) {
            // 核验完成且 socket/授权仍有效后再续租，旧连接的迟到结果不能恢复手机在线状态。
            this.observeRelayPresence(
              job.sourceDeviceID,
              job.presenceRevision,
              job.lifecycle,
              job.generation,
              job.observedAt,
              job.socket,
            )
            await this.processInboundRelay(job)
          }
        } catch (error) {
          if (this.inboundRelayJobActive(job)) {
            await this.relayRequestResponse(
              job.sourceDeviceID,
              job.payload,
              relayErrorPayload(job.payload, protocolError(error)),
              job.requestID,
            )
          }
        } finally {
          this.releaseInboundRelayJob(job)
          if (this.activeInboundRelayJob === job) this.activeInboundRelayJob = undefined
          job.resolve()
        }
      }
    } finally {
      this.relayInboundRunning = false
      if (this.relayInboundQueue.length > 0) void this.drainInboundRelayQueue()
    }
  }

  private inboundRelayJobActive(job: RelayInboundJob) {
    return (
      job.generation === this.relayInboundGeneration &&
      job.lifecycle === this.lifecycle &&
      (!job.socket || (job.socket === this.socket && job.socket.readyState === WebSocket.OPEN)) &&
      relayAllowed(job.sourceDeviceID, this.devices)
    )
  }

  private releaseInboundRelayJob(job: RelayInboundJob) {
    if (job.released) return
    job.released = true
    this.relayInboundQueueBytes = Math.max(0, this.relayInboundQueueBytes - job.bytes)
  }

  private historyEventBarrierKey(deviceID: string, sessionID: string) {
    return JSON.stringify([deviceID, sessionID])
  }

  private beginHistoryEventBarrier(deviceID: string, sessionID: string) {
    const key = this.historyEventBarrierKey(deviceID, sessionID)
    const barrier: HistoryEventBarrier = { deviceID, sessionID, lifecycle: this.lifecycle, events: [], bytes: 0 }
    this.historyEventBarriers.set(key, barrier)
    return barrier
  }

  private bufferHistoryEvent(
    deviceID: string,
    sessionID: string,
    event: GlobalEvent,
    coalescedFile: boolean,
    replayBarrier?: HistoryEventBarrier,
  ) {
    const barrier = this.historyEventBarriers.get(this.historyEventBarrierKey(deviceID, sessionID))
    if (!barrier) return false
    // 当前 drain 批次只绕过自身 barrier；同一时刻从 GlobalBus 新到的事件仍追加到下一批。
    if (barrier === replayBarrier) return false
    if (barrier.events.some((item) => item.event === event && item.coalescedFile === coalescedFile)) return true
    let bytes: number
    try {
      bytes = Buffer.byteLength(JSON.stringify(event), "utf8")
    } catch {
      bytes = historyEventBufferMaxBytes + 1
    }
    if (
      bytes > historyEventBufferMaxBytes ||
      this.historyEventBufferBytes + bytes > historyEventBufferMaxBytes ||
      this.historyEventBufferCount >= historyEventBufferLimit
    ) {
      // snapshot 期间事件无法安全丢弃；缓冲溢出时断线，手机重连后重新请求权威历史。
      this.failInboundRelayQueue({
        code: "REMOTE_CONTROL_HISTORY_EVENT_BUFFER_EXCEEDED",
        message: "Remote history event buffer limit was exceeded",
      })
      return true
    }
    barrier.events.push({ event, coalescedFile, bytes })
    barrier.bytes += bytes
    this.historyEventBufferBytes += bytes
    this.historyEventBufferCount += 1
    return true
  }

  private async finishHistoryEventBarrier(barrier: HistoryEventBarrier, replay: boolean) {
    const key = this.historyEventBarrierKey(barrier.deviceID, barrier.sessionID)
    if (this.historyEventBarriers.get(key) !== barrier) return
    if (!replay || barrier.lifecycle !== this.lifecycle) {
      this.historyEventBarriers.delete(key)
      this.historyEventBufferBytes = Math.max(0, this.historyEventBufferBytes - barrier.bytes)
      this.historyEventBufferCount = Math.max(0, this.historyEventBufferCount - barrier.events.length)
      return
    }
    // snapshot 和 pending 状态全部 ACK 后分批 drain；重放 await 期间的新事件进入下一批，不能越过旧事件。
    for (;;) {
      if (barrier.lifecycle !== this.lifecycle || this.historyEventBarriers.get(key) !== barrier) return
      const events = barrier.events.splice(0)
      barrier.bytes = 0
      if (events.length === 0) {
        // 检查与删除之间没有 await，JS 事件循环无法在这里插入遗漏事件。
        this.historyEventBarriers.delete(key)
        return
      }
      for (let index = 0; index < events.length; index += 1) {
        const item = events[index]!
        if (barrier.lifecycle !== this.lifecycle || this.historyEventBarriers.get(key) !== barrier) return
        try {
          await this.forwardEvent(item.event, item.coalescedFile, barrier.deviceID, barrier, barrier.lifecycle)
        } catch (error) {
          // 重放失败后无法证明手机状态完整，统一断线清理并让重连重新获取权威 snapshot。
          this.failInboundRelayQueue({
            code: "REMOTE_CONTROL_HISTORY_REPLAY_FAILED",
            message: error instanceof Error ? error.message : "Remote history event replay failed",
          })
          throw error
        }
        // 正在 await 的事件继续计入全局预算，只有交付完成后才允许后续事件复用这部分容量。
        this.historyEventBufferBytes = Math.max(0, this.historyEventBufferBytes - item.bytes)
        this.historyEventBufferCount = Math.max(0, this.historyEventBufferCount - 1)
      }
    }
  }

  private clearHistoryEventBarriers() {
    this.historyEventBarriers.clear()
    this.historyEventBufferBytes = 0
    this.historyEventBufferCount = 0
  }

  private clearInboundRelayQueue() {
    this.relayInboundGeneration += 1
    if (this.activeInboundRelayJob) {
      this.activeInboundRelayJob.cancel()
      this.releaseInboundRelayJob(this.activeInboundRelayJob)
      this.activeInboundRelayJob.resolve()
    }
    this.relayInboundQueue.splice(0).forEach((job) => {
      job.cancel()
      this.releaseInboundRelayJob(job)
      job.resolve()
    })
    this.clearHistoryEventBarriers()
  }

  private failInboundRelayQueue(error: { code: string; message: string }) {
    this.lastError = `${error.code}: ${error.message}`
    this.clearInboundRelayQueue()
    this.clearRelayOutbound(error)
    this.clearPresenceState()
    clearRelayFragmentAssemblies(this.fragments)
    this.socket?.close(1013, error.code)
  }

  private async processInboundRelay(job: RelayInboundJob) {
    const { sourceDeviceID: source, payload, requestID } = job
    const historySessionID = remoteHistorySessionID(payload)
    const history = streamRemoteHistoryPayload(payload, operations, {
      active: () => this.inboundRelayJobActive(job),
    })
    if (history) {
      const barrier = historySessionID ? this.beginHistoryEventBarrier(source, historySessionID) : undefined
      let replayBufferedEvents = true
      // 历史 async iterable 每产出一个有界块就立即 relay 并等待 ACK，不再构造完整 result 数组。
      try {
        for await (const item of history) {
          if (!this.inboundRelayJobActive(job)) return
          const response = { ...item, request_id: requestID }
          if (!(await this.relayRequestResponse(source, payload, response, requestID))) {
            replayBufferedEvents = false
            return
          }
        }
      } catch (error) {
        // snapshot 未完整生成时 fail-close，避免手机停留在已 ACK 的残缺 reset 且继续接收实时更新。
        replayBufferedEvents = false
        this.failInboundRelayQueue({
          code: "REMOTE_CONTROL_HISTORY_SYNC_FAILED",
          message: error instanceof Error ? error.message : "Remote history synchronization failed",
        })
        throw error
      } finally {
        if (barrier) {
          await this.finishHistoryEventBarrier(barrier, replayBufferedEvents && this.inboundRelayJobActive(job))
        }
      }
      return
    }
    const execute = () =>
      dispatchRemotePayload(payload, operations, {
        request_scope: JSON.stringify([this.connectedAccount ?? "", source]),
      })
        .then((items) => items.map((item) => ({ ...item, ...(requestID ? { request_id: requestID } : {}) })))
        .catch((error) => {
          // input 业务错误已在 protocol 层变成 input_rejected + error；这里只兜底 envelope 级和非 input 异常。
          const info = protocolError(error)
          return [{ ...relayErrorPayload(payload, info), request_id: requestID }]
        })
    const cacheKey = relayRequestKey(this.connectedAccount ?? "", source, requestID)
    const fingerprint = crypto
      .createHash("sha256")
      .update(JSON.stringify(payload ?? null))
      .digest("hex")
    const conflict = () => [
      {
        ...relayErrorPayload(payload, {
          code: "REQUEST_ID_CONFLICT",
          message: "request_id was already used with a different payload",
        }),
        request_id: requestID,
      },
    ]
    const bridgeMessage = object(object(payload)?.message)
    if (string(object(payload)?.type) === "bridge.client_message" && string(bridgeMessage?.type) === "list_sessions") {
      // 主动刷新和显式列表请求共用完整发送链，保证慢请求不能在较新的实时 session_list 之后回退手机状态。
      await this.enqueueSessionListTask(async () => {
        if (!this.inboundRelayJobActive(job)) return
        // 列表请求仍复用通用 inflight 去重和统一错误降级，任务链只额外约束快照到发送的时序。
        const result = await this.inflightRequest(cacheKey, fingerprint, execute, conflict, false)
        for (const item of result) {
          if (!this.inboundRelayJobActive(job)) return
          if (!(await this.relayRequestResponse(source, payload, item, requestID))) return
        }
      })
      return
    }
    const cached = this.completed.get(cacheKey)
    const result = cached
      ? cached.fingerprint === fingerprint
        ? cached.result
        : conflict()
      : await this.inflightRequest(cacheKey, fingerprint, execute, conflict, remotePayloadMutates(payload))
    // 同一请求的多条普通响应同样逐项等待 ACK，避免输入失败等组合响应在传输层并发。
    for (const item of result) {
      if (!this.inboundRelayJobActive(job)) return
      if (!(await this.relayRequestResponse(source, payload, item, requestID))) break
    }
  }

  private async inflightRequest(
    requestKey: string,
    fingerprint: string,
    execute: () => Promise<JsonObject[]>,
    conflict: () => JsonObject[],
    persistCompleted: boolean,
  ) {
    const existing = this.inflight.get(requestKey)
    if (existing) return existing.fingerprint === fingerprint ? existing.promise : conflict()
    const generation = this.requestStateGeneration
    const promise = execute().then((result) => {
      if (persistCompleted && generation === this.requestStateGeneration) {
        this.completed.set(requestKey, { fingerprint, result })
      }
      return result
    })
    this.inflight.set(requestKey, { fingerprint, promise })
    try {
      return await promise
    } finally {
      if (this.inflight.get(requestKey)?.promise === promise) this.inflight.delete(requestKey)
    }
  }

  private async handleMessage(raw: string, socket?: WebSocket) {
    let message: JsonObject | undefined
    try {
      message = object(JSON.parse(raw))
    } catch {
      return
    }
    const type = string(message?.type)
    if (!message || !type) return
    // 账号切换或 token 续期后的旧 socket，以及进入 CLOSING 的当前 socket，迟到消息都不能再改变状态。
    if (socket && (socket !== this.socket || socket.readyState !== WebSocket.OPEN)) return
    if (type === "relay") return this.handleRelay(message, socket)
    if (type === "relay.accepted") {
      const pending = this.pendingRelayDelivery
      if (
        pending &&
        string(message.target_device_id) === pending.targetDeviceID &&
        string(message.request_id) === pending.requestID
      ) {
        pending.finish({ type: "sent" })
      }
      return
    }
    if (type === "error") {
      const error = object(message.error)
      const info = {
        code: string(error?.code) ?? "REMOTE_CONTROL_ERROR",
        message: string(error?.message) ?? "Relay failed",
      }
      const pending = this.pendingRelayDelivery
      if (pending && string(message.request_id) === pending.requestID) pending.finish({ type: "rejected", error: info })
      this.lastError = `${info.code}: ${info.message}`
      return
    }
    if (type === "pairing.requested") {
      const pairing = object(message.pairing)
      const mobile = object(pairing?.mobile_device)
      const pairingID = string(pairing?.pairing_id)
      if (!pairingID) return
      this.pending.set(pairingID, {
        pairing_id: pairingID,
        name: string(mobile?.device_name) ?? "Mobile device",
        platform: string(mobile?.platform),
        requested_at: string(pairing?.updated_at),
      })
      return
    }
    if (type === "pairing.approved" || type === "pairing.rejected" || type === "pairing.expired") {
      const pairingID = string(object(message.pairing)?.pairing_id)
      if (pairingID) this.pending.delete(pairingID)
      if (pairingID && this.pairing?.pairing_id === pairingID) {
        this.pairing = undefined
        this.stopPairingPoll()
      }
      if (type === "pairing.approved") await this.refreshConnections().catch(() => undefined)
      return
    }
    if (type === "presence") {
      const source = string(message.source_device_id)
      if (!source) return
      const presenceType = string(message.presence) ?? ""
      if (presenceType !== "online" && presenceType !== "offline") return
      this.presenceRevision.set(source, (this.presenceRevision.get(source) ?? 0) + 1)
      const sessions = this.presence.get(source)
      sessions?.delete(relayObservedPresenceSessionID)
      if (sessions?.size === 0) this.presence.delete(source)
      const online = applyPresenceEvent(this.presence, {
        deviceID: source,
        presence: presenceType,
        sessionID: string(message.presence_session_id),
        ttlSeconds: number(message.presence_ttl_seconds),
      })
      // presence 的服务端时间只用于展示；租约过期始终按本地接收时间计算，避免两端时钟偏差。
      this.updateDevicePresence(source, online, string(message.created_at))
      return
    }
    if (type === "device.removed") {
      // 设备撤销后旧设备的变更 ACK 不能继续命中幂等缓存；下一条请求必须重新走授权与执行边界。
      const connectionID = string(message.connection_id)
      const removedDeviceID =
        string(message.source_device_id) ?? this.devices.find((item) => item.id === connectionID)?.device_id
      // 撤销是授权代次边界：active/queued 命令和所有半包统一失效，其他设备可在当前连接上重新发起。
      this.revokeConnectionState(connectionID, removedDeviceID)
      await this.refreshConnections().catch(() => undefined)
    }
  }

  private async forwardEvent(
    event: GlobalEvent,
    coalescedFile = false,
    targetDeviceID?: string,
    replayBarrier?: HistoryEventBarrier,
    expectedLifecycle?: number,
    sessionListBarrier?: Promise<void>,
  ) {
    if (expectedLifecycle !== undefined && expectedLifecycle !== this.lifecycle) return
    const type = string(object(event.payload)?.type)
    const updatesGlobalSessionList =
      type === "session.created" || type === "session.updated" || type === "session.deleted"
    if (type === "wanlaicode.user-center.auth.expired") {
      // OAuth 过期事件即使账号 ID 未变也要重建 WS，让刷新协调器提供新的 JWT。
      this.clearAccountState(true)
      if (this.running) void this.connect()
      return
    }
    const sessionID = eventSessionID(event)
    const properties = object(object(event.payload)?.properties)
    // 文件合并已经在会话事件链中完成，这里只负责记录最终快照的 message/part 与用户回合关系。
    this.recordTurnRouting(type, sessionID, properties)
    if (type === "permission.asked" && sessionID) {
      const requestID = string(properties?.id)
      const mode = await operations.permissionMode({ session_id: sessionID }).catch(() => "default" as const)
      if (mode === "autoReview" && requestID) {
        // Auto-review 只消费 Permission.asked；Question.asked 不经过该分支，始终保留给手机用户回答。
        const resolved = await operations
          .permissionReply({ session_id: sessionID, request_id: requestID, reply: "once" })
          .then(() => true)
          .catch((error) => {
            log.warn("remote auto-review permission failed", {
              sessionID,
              requestID,
              error: error instanceof Error ? error.message : String(error),
            })
            return false
          })
        if (resolved) return
      }
    }
    // 只约束向手机发送的投影顺序；桌面本地 Auto-review 已在上方立即处理，不受慢 ACK 阻塞。
    if (sessionListBarrier) await sessionListBarrier
    if (expectedLifecycle !== undefined && expectedLifecycle !== this.lifecycle) return
    // 本地 auto-review 不依赖 relay 在线；只有需要向手机转发的事件才继续校验账号与 WebSocket。
    if (!(await this.validateAccount())) return
    // validateAccount、权威历史读取与 relay ACK 都可能跨越账号切换，任何 await 后都要重新核对代次。
    if ((expectedLifecycle !== undefined && expectedLifecycle !== this.lifecycle) || this.state !== "connected") return
    const part = object(properties?.part)
    const isFilePart = type === "message.part.updated" && part?.type === "file"
    const targetDevices = this.devices.filter(
      (item) => item.online && (!targetDeviceID || item.device_id === targetDeviceID),
    )
    if (targetDevices.length === 0) return
    const bufferedDevices = sessionID
      ? targetDevices.filter((device) =>
          this.bufferHistoryEvent(device.device_id, sessionID, event, coalescedFile, replayBarrier),
        ).length
      : 0
    // 所有目标都在应用 snapshot 时无需提前映射大权威消息；结束后定向重放会读取最新状态。
    if (bufferedDevices === targetDevices.length) return
    const native = { type: "sync.event", event }
    const partID = string(part?.id) ?? string(properties?.partID)
    if (type === "message.part.updated" && partID && (part?.type === "text" || part?.type === "reasoning")) {
      this.partTypes.set(partID, part.type)
    }
    const turnID = this.eventTurnID(type, sessionID, properties)
    const direct = bridgeEvent(event, partID ? this.partTypes.get(partID) : undefined, turnID)
    const authoritative = await this.authoritativeBridgeEvent(type, sessionID, event).catch((error) => {
      log.warn("remote bridge event mapping failed", {
        type,
        sessionID,
        error: error instanceof Error ? error.message : String(error),
      })
      return []
    })
    if (expectedLifecycle !== undefined && expectedLifecycle !== this.lifecycle) return
    const bridgeUpdates = [...authoritative, ...direct]
    // 离线设备不参与主动扇出，否则它的 ACK 超时会阻塞所有在线手机；重连后由握手和权威 snapshot 补齐。
    for (const device of targetDevices) {
      if (expectedLifecycle !== undefined && expectedLifecycle !== this.lifecycle) return
      if (sessionID && this.bufferHistoryEvent(device.device_id, sessionID, event, coalescedFile, replayBarrier))
        continue
      // 原生 file 事件含同一 data URL，Bridge 用户消息已经覆盖手机消费者，避免附件被重复中转。
      // 新客户端只消费 Bridge 投影；旧客户端仍保留 sync.event，避免协议降级时丢状态。
      if (!isFilePart && !this.supportsBridgeOnlyEvents(device.device_id)) {
        await this.relayEvent(device.device_id, native, type)
        if (expectedLifecycle !== undefined && expectedLifecycle !== this.lifecycle) return
        if (sessionID && this.bufferHistoryEvent(device.device_id, sessionID, event, coalescedFile, replayBarrier))
          continue
      }
      for (const message of bridgeUpdates) {
        if (expectedLifecycle !== undefined && expectedLifecycle !== this.lifecycle) return
        if (sessionID && this.bufferHistoryEvent(device.device_id, sessionID, event, coalescedFile, replayBarrier))
          break
        await this.relayEvent(
          device.device_id,
          { type: "bridge.server_message", message },
          string(message.type) ?? type,
        )
      }
    }
    if (!updatesGlobalSessionList) return
    await this.enqueueSessionListTask(async () => {
      if (expectedLifecycle !== undefined && expectedLifecycle !== this.lifecycle) return
      const message = bridgeSessionList(
        await operations.snapshot(),
        // 顶层兼容目录使用所有活动目录的安全交集；每个 session item 另带自身目录的完整模型目录。
        await operations.modelCatalog(),
      )
      if (expectedLifecycle !== undefined && expectedLifecycle !== this.lifecycle) return
      // 列表快照按任务链顺序逐设备 ACK；历史 barrier 中的设备稍后用同一链定向读取最新快照。
      for (const device of targetDevices) {
        if (expectedLifecycle !== undefined && expectedLifecycle !== this.lifecycle) return
        if (sessionID && this.bufferHistoryEvent(device.device_id, sessionID, event, coalescedFile, replayBarrier))
          continue
        await this.relayEvent(device.device_id, { type: "bridge.server_message", message }, "session_list")
      }
    })
  }

  private async authoritativeBridgeEvent(type: string | undefined, sessionID: string | undefined, event: GlobalEvent) {
    if (!sessionID) return []
    const properties = object(object(event.payload)?.properties)
    if (!authoritativeBridgeEventReady(type, properties)) return []
    const eventPart = object(properties?.part)
    const messageID = string(object(properties?.info)?.id) ?? string(object(properties?.part)?.messageID)
    const message = await this.findAuthoritativeHistoryMessage(sessionID, messageID)
    if (!message) return []
    if (type === "message.part.updated") {
      if (message.info.role === "user" || eventPart?.type === "file") return bridgeMessages(message)
      const callID = string(eventPart?.callID)
      return callID ? bridgeToolUpdate(message, callID) : []
    }
    // idle 前补发权威完整消息与 result，手机据此收束 streaming；随后 direct 再发送 status:idle。
    return bridgeMessages(message)
  }

  private async findAuthoritativeHistoryMessage(sessionID: string, messageID?: string) {
    let pageCursor: string | undefined
    let highWater: string | null | undefined
    // 实时事件通常位于历史末端；从最新向前小页扫描可尽快命中，同时不再聚合完整历史。
    for (;;) {
      const page = await operations.historyPage({
        session_id: sessionID,
        cursor: pageCursor,
        high_water: highWater,
        limit: 1,
        direction: "backward",
      })
      highWater = page.high_water
      if (messageID) {
        const found = page.items.find((item) => item.type === "message" && item.message.info.id === messageID)
        if (found?.type === "message") return found.message
      } else {
        const latestAssistant = page.items.find(
          (item) => item.type === "message" && item.message.info.role === "assistant",
        )
        if (latestAssistant?.type === "message") return latestAssistant.message
      }
      if (page.next_cursor === undefined) return
      pageCursor = page.next_cursor
    }
  }

  async createPairing() {
    // 用户主动点击创建配对时才允许清掉失败的恢复标记并再轮换一次，后台重连不会无界注册设备。
    await this.ensureReady({ resetPendingIdentity: true })
    const scope = await this.captureAccountOperation()
    const result = object(data(await this.request("/pairings", { method: "POST", body: "{}" })))
    await this.assertAccountOperationActive(scope)
    const pairingID = string(result?.pairing_id)
    const secret = string(result?.pairing_secret)
    const expiresAt = string(result?.expires_at)
    if (!pairingID || !secret || !expiresAt) throw new Error("Remote control pairing response is incomplete")
    const api = mobilePairingApi(remoteControlEndpoint(), {
      // 本地联调可显式指定固定 LAN 地址；未指定时回环地址会自动转换为 Bonjour 主机名。
      override: process.env.WANLAICODE_REMOTE_CONTROL_MOBILE_API,
    })
    this.pairing = {
      pairing_id: pairingID,
      secret,
      expires_at: expiresAt,
      qr: mobilePairingDeepLink({ api, pairingID, secret }),
    }
    this.startPairingPoll()
    return this.pairing
  }

  async approvePairing(pairingID: string) {
    this.assertAvailable()
    const scope = await this.captureAccountOperation()
    await this.request(`/pairings/${encodeURIComponent(pairingID)}/approve`, { method: "POST", body: "{}" })
    await this.assertAccountOperationActive(scope)
    this.pending.delete(pairingID)
    if (this.pairing?.pairing_id === pairingID) this.pairing = undefined
    this.stopPairingPoll()
    await this.refreshConnections(scope.account)
  }

  async rejectPairing(pairingID: string) {
    this.assertAvailable()
    const scope = await this.captureAccountOperation()
    await this.request(`/pairings/${encodeURIComponent(pairingID)}/reject`, { method: "POST", body: "{}" })
    await this.assertAccountOperationActive(scope)
    this.pending.delete(pairingID)
    if (this.pairing?.pairing_id === pairingID) this.pairing = undefined
    this.stopPairingPoll()
  }

  async removeConnection(connectionID: string) {
    this.assertAvailable()
    const scope = await this.captureAccountOperation()
    const deviceID = this.devices.find((item) => item.id === connectionID || item.device_id === connectionID)?.device_id
    await this.request(`/connections/${encodeURIComponent(connectionID)}`, { method: "DELETE" })
    await this.assertAccountOperationActive(scope)
    // 桌面主动解绑与服务端推送使用同一撤权边界，DELETE 返回后立即取消旧手机的在途命令。
    this.revokeConnectionState(connectionID, deviceID)
  }

  async listConnections() {
    await this.ensureReady()
    await this.refreshConnections()
    return this.devices
  }

  private async ensureReady(options: { resetPendingIdentity?: boolean } = {}) {
    this.assertAvailable()
    if (!this.running) this.start()
    if (!(await this.validateAccount())) throw new Error("WANLAICODE_OAUTH_REQUIRED")
    const account = await this.accountKey()
    try {
      await this.ensureRegistered(account)
    } catch (error) {
      if (!options.resetPendingIdentity || !remoteDeviceRecoveryRequired(error)) throw error
      // pending 只在用户显式重试时删除；下一次注册会先持久化一个新的恢复 ID。
      await this.removeCredential(account)
      await this.ensureRegistered(account)
    }
    if (!this.socket || this.socket.readyState > WebSocket.OPEN) void this.connect()
    const started = Date.now()
    while (this.socket?.readyState !== WebSocket.OPEN) {
      if (Date.now() - started > 10_000) throw new Error("Remote control WebSocket is not ready")
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }

  private startPairingPoll() {
    this.stopPairingPoll()
    this.pairingPoll = setInterval(() => void this.pollCurrentPairing().catch(() => undefined), 1_000)
  }

  private assertAvailable() {
    if (!remoteControlAvailable(Flag.WANLAICODE_WORKSPACE_ID, Flag.WANLAICODE_CLIENT)) {
      throw new ProtocolError("REMOTE_CONTROL_DESKTOP_ONLY", "Remote control is only available in the desktop host")
    }
  }

  private async captureAccountOperation() {
    const lifecycle = this.lifecycle
    const account = await this.accountKey()
    if (lifecycle !== this.lifecycle) {
      throw new ProtocolError("REMOTE_CONTROL_ACCOUNT_CHANGED", "Remote control account changed during the request")
    }
    return { lifecycle, account }
  }

  private async accountOperationActive(scope: { lifecycle: number; account: string }) {
    if (scope.lifecycle !== this.lifecycle) return false
    return (await this.accountKey().catch(() => undefined)) === scope.account
  }

  private async assertAccountOperationActive(scope: { lifecycle: number; account: string }) {
    if (await this.accountOperationActive(scope)) return
    // 旧账号的服务端操作可能已经完成，但绝不能把迟到结果写入新账号当前的桌面状态。
    throw new ProtocolError("REMOTE_CONTROL_ACCOUNT_CHANGED", "Remote control account changed during the request")
  }

  private stopPairingPoll() {
    if (this.pairingPoll) clearInterval(this.pairingPoll)
    this.pairingPoll = undefined
  }

  private async pollCurrentPairing() {
    const current = this.pairing
    if (!current) return
    if (Date.parse(current.expires_at) <= Date.now()) {
      this.pending.delete(current.pairing_id)
      this.pairing = undefined
      this.stopPairingPoll()
      return
    }
    const scope = await this.captureAccountOperation()
    if (this.pairing !== current) return
    const pairing = object(data(await this.request(`/pairings/${encodeURIComponent(current.pairing_id)}`)))
    if (!(await this.accountOperationActive(scope)) || this.pairing !== current) return
    const mobile = object(pairing?.mobile_device)
    const status = string(pairing?.status)
    if (status === "pending" && mobile) {
      this.pending.set(current.pairing_id, {
        pairing_id: current.pairing_id,
        name: string(mobile.device_name) ?? "Mobile device",
        platform: string(mobile.platform),
        requested_at: string(pairing?.updated_at),
      })
      return
    }
    if (status === "approved") await this.refreshConnections(scope.account)
    if (!(await this.accountOperationActive(scope)) || this.pairing !== current) return
    if (status === "approved" || status === "rejected" || status === "expired") {
      this.pending.delete(current.pairing_id)
      this.pairing = undefined
      this.stopPairingPoll()
    }
  }
}

export const gateway = new Gateway()

export const RemoteControlGateway = {
  start: () => gateway.start(),
  stop: () => gateway.stop(),
  status: () => gateway.status(),
  createPairing: () => gateway.createPairing(),
  approvePairing: (pairingID: string) => gateway.approvePairing(pairingID),
  rejectPairing: (pairingID: string) => gateway.rejectPairing(pairingID),
  listConnections: () => gateway.listConnections(),
  removeConnection: (connectionID: string) => gateway.removeConnection(connectionID),
  authChanged: () => gateway.authChanged(),
}
