import { describe, expect, test } from "bun:test"
import { ProtocolError } from "@/remote-control/protocol"
import { operations } from "@/remote-control/operations"
import { MessageV2 } from "@/session/message-v2"
import { WanlaiCodeRefreshCoordinator } from "@/provider/wanlaicode-refresh-coordinator"
import {
  acceptRelayPayload,
  createRelayFragmentState,
  gateway,
  pruneRelayFragmentAssemblies,
  RelayCompletionCache,
  remotePayloadMutates,
  relayEnvelopes,
  relayCompletedCacheEntryMaxBytes,
  relayCompletedCacheMaxBytes,
  relayCompletedCacheTTLms,
  relayFragmentMaxAssembledBytes,
  relayFragmentThresholdBytes,
  relayFragmentTTLms,
  relayOutboundQueueMaxBytes,
  type RelayFragmentPayload,
} from "@/remote-control/gateway"

function fragment(payload: unknown) {
  return payload as RelayFragmentPayload
}

// 所有协议错误断言统一校验稳定错误码，避免只验证“抛了异常”而漏掉手机依赖的错误语义。
function expectProtocolError(run: () => unknown, code: string, message?: string) {
  try {
    run()
    throw new Error("缺少预期的远控协议错误")
  } catch (error) {
    expect(error).toBeInstanceOf(ProtocolError)
    expect((error as ProtocolError).code).toBe(code)
    if (message) expect((error as Error).message).toBe(message)
  }
}

function expectFragmentError(run: () => unknown, message?: string) {
  expectProtocolError(run, "INVALID_RELAY_FRAGMENT", message)
}

// 测试输入也按正式 wire 规则生成外层 ID，只有专门的畸形用例才绕过该辅助函数。
function fragmentWireRequestID(payload: unknown) {
  const value = fragment(payload)
  return `fragment:${value.fragment_id}:${value.fragment_index}`
}

function acceptFragment(
  state: ReturnType<typeof createRelayFragmentState>,
  sourceDeviceID: string,
  payload: unknown,
  now = Date.now(),
) {
  return acceptRelayPayload(state, sourceDeviceID, payload, fragmentWireRequestID(payload), now)
}

type GatewayHarness = {
  socket?: FakeSocket
  devices: Array<{ id: string; device_id: string; name: string; online: boolean }>
  running: boolean
  state: string
  lastError?: string
  observedAccount?: string | null
  connectedAccount?: string
  pairing?: { pairing_id: string; secret: string; expires_at: string; qr: string }
  lifecycle: number
  completed: RelayCompletionCache
  inflight: Map<string, unknown>
  pendingRelayDelivery?: unknown
  socketCredentials: WeakMap<
    FakeSocket,
    {
      type: "oauth"
      access: string
      refresh: string
      softwareToken?: string
      expires: number
    }
  >
  relayAckTimeoutMs: number
  relayQueueBytes: number
  relayQueueMaxBytes: number
  relayInboundQueue: unknown[]
  relayInboundQueueBytes: number
  relayInboundQueueMaxBytes: number
  activeInboundRelayJob?: unknown
  historyEventBufferBytes: number
  historyEventBufferCount: number
  historyEventBarriers: Map<string, unknown>
  presence: Map<string, Map<string, number>>
  presenceRevision: Map<string, number>
  connectionRefreshRevision: number
  revokedDeviceConnections: Map<string, string | undefined>
  revokedConnectionIDs: Set<string>
  validateAccount: () => Promise<boolean>
  authChanged: () => Promise<void>
  accountKey: () => Promise<string>
  currentOAuthCredential: () => Promise<
    | {
        type: "oauth"
        access: string
        refresh: string
        softwareToken?: string
        expires: number
      }
    | undefined
  >
  oauthCredential: () => Promise<{
    token: string
    credential: {
      type: "oauth"
      access: string
      refresh: string
      softwareToken?: string
      expires: number
    }
  }>
  connect: () => Promise<void>
  connectOnce: (generation: number) => Promise<void>
  ensureRegistered: (account?: string) => Promise<{ deviceID: string; token: string }>
  request: (path: string) => Promise<unknown>
  inflightRequest: (
    key: string,
    fingerprint: string,
    execute: () => Promise<Record<string, unknown>[]>,
    conflict: () => Record<string, unknown>[],
    persistCompleted: boolean,
  ) => Promise<Record<string, unknown>[]>
  authoritativeBridgeEvent: (...input: unknown[]) => Promise<Record<string, unknown>[]>
  relay: (
    targetDeviceID: string,
    payload: Record<string, unknown>,
    requestID?: string,
  ) => Promise<{ type: string; error?: { code: string; message: string } }>
  handleMessage: (message: string, socket?: FakeSocket) => Promise<void>
  handleRelay: (envelope: Record<string, unknown>, socket?: FakeSocket) => Promise<void>
  processInboundRelay: (job: { requestID: string; payload: unknown }) => Promise<void>
  beginHistoryEventBarrier: (
    deviceID: string,
    sessionID: string,
  ) => {
    deviceID: string
    sessionID: string
    lifecycle: number
    events: Array<unknown>
    bytes: number
  }
  finishHistoryEventBarrier: (
    barrier: { deviceID: string; sessionID: string; lifecycle: number; events: Array<unknown>; bytes: number },
    replay: boolean,
  ) => Promise<void>
  handleSocketClose: (socket: FakeSocket, code: number, reason: string) => Promise<void>
  handleSocketOpen: (socket: FakeSocket, generation: number) => void
  handleSocketError: (socket: FakeSocket, generation: number, error: Error) => void
  clearAccountState: (accountAvailable: boolean) => void
  ensureReady: (options?: { resetPendingIdentity?: boolean }) => Promise<void>
  assertAvailable: () => void
  refreshConnections: (expectedAccount?: string) => Promise<void>
  enqueueForwardEvent: (event: { payload: unknown }) => Promise<void>
  forwardEvent: (event: { payload: unknown }, coalescedFile?: boolean, targetDeviceID?: string) => Promise<void>
  createPairing: () => Promise<{ pairing_id: string; secret: string; expires_at: string; qr: string }>
  removeConnection: (connectionID: string) => Promise<void>
  stop: () => void
}

type FakeSocket = {
  readyState: number
  send(message: string, callback?: (error?: Error) => void): void
  close(code?: number, reason?: string): void
}

// 每个 Gateway 行为测试都创建独立实例，避免改写导出的单例并污染其他远控测试。
function createGatewayHarness() {
  const Constructor = gateway.constructor as unknown as new () => GatewayHarness
  return new Constructor()
}

function attachSocket(subject: GatewayHarness, onEnvelope?: (envelope: Record<string, unknown>) => void) {
  const sent: Record<string, unknown>[] = []
  subject.socket = {
    readyState: 1,
    send(message, callback) {
      const envelope = JSON.parse(message) as Record<string, unknown>
      sent.push(envelope)
      callback?.()
      onEnvelope?.(envelope)
    },
    close() {
      this.readyState = 3
    },
  }
  return sent
}

function acknowledge(subject: GatewayHarness, envelope: Record<string, unknown>) {
  return subject.handleMessage(
    JSON.stringify({
      type: "relay.accepted",
      target_device_id: envelope.target_device_id,
      request_id: envelope.request_id,
    }),
  )
}

function attachAckingSocket(subject: GatewayHarness) {
  return attachSocket(subject, (envelope) => queueMicrotask(() => void acknowledge(subject, envelope)))
}

describe("remote-control relay fragmentation", () => {
  test("512KiB 以内保留原 relay 信封且不生成分片 ID", () => {
    const overhead = Buffer.byteLength(JSON.stringify({ value: "" }), "utf8")
    const payload = { value: "x".repeat(relayFragmentThresholdBytes - overhead) }
    expect(Buffer.byteLength(JSON.stringify(payload), "utf8")).toBe(relayFragmentThresholdBytes)
    const envelopes = relayEnvelopes("mobile-1", payload, "logical-1", () => {
      throw new Error("小消息不应生成分片 ID")
    })
    expect(envelopes).toEqual([
      {
        type: "relay",
        target_device_id: "mobile-1",
        request_id: "logical-1",
        payload,
      },
    ])
    const event = { type: "sync.event", event: { type: "session.updated" } }
    expect(
      relayEnvelopes("mobile-1", event, undefined, () => {
        throw new Error("无 request_id 的小事件也不应生成分片 ID")
      }),
    ).toEqual([{ type: "relay", target_device_id: "mobile-1", payload: event }])
  })

  test("大 payload 按 UTF-8 bytes 分片并使用逐片唯一外层 request_id", () => {
    const payload = { text: `prefix-${"你".repeat(180_000)}-suffix` }
    const envelopes = relayEnvelopes("mobile-1", payload, "logical-1", () => "fragment-1")
    expect(envelopes).toHaveLength(2)
    expect(envelopes.map((item) => item.request_id)).toEqual(["fragment:fragment-1:0", "fragment:fragment-1:1"])
    expect(envelopes.map((item) => fragment(item.payload).fragment_index)).toEqual([0, 1])
    for (const envelope of envelopes) {
      expect(fragment(envelope.payload)).toMatchObject({
        type: "bridge.fragment",
        fragment_id: "fragment-1",
        fragment_count: 2,
        request_id: "logical-1",
      })
      expect(Buffer.from(fragment(envelope.payload).data, "base64").byteLength).toBeLessThanOrEqual(
        relayFragmentThresholdBytes,
      )
    }
    expect(Buffer.from(fragment(envelopes[0].payload).data, "base64").byteLength).toBe(relayFragmentThresholdBytes)

    // 桌面主动同步的大事件没有逻辑请求，内层 request_id 必须保持缺省。
    const events = relayEnvelopes("mobile-1", payload, undefined, () => "fragment-event")
    expect(events.every((item) => !("request_id" in fragment(item.payload)))).toBe(true)
    expect(events.map((item) => item.request_id)).toEqual(["fragment:fragment-event:0", "fragment:fragment-event:1"])
  })

  test("乱序和重复分片只组装一次并恢复逻辑 request_id", () => {
    const payload = { text: `开始-${"界".repeat(180_000)}-结束` }
    const envelopes = relayEnvelopes("mobile-1", payload, "logical-2", () => "fragment-2")
    const state = createRelayFragmentState()
    expect(acceptFragment(state, "mobile-1", envelopes[1].payload, 1)).toEqual({ type: "pending" })
    const buffered = state.bufferedBytes
    expect(acceptFragment(state, "mobile-1", envelopes[1].payload, 2)).toEqual({
      type: "pending",
    })
    expect(state.bufferedBytes).toBe(buffered)
    expect(acceptFragment(state, "mobile-1", envelopes[0].payload, 3)).toEqual({
      type: "ready",
      payload,
      requestID: "logical-2",
    })
    expect(state.assemblies.size).toBe(0)
    expect(state.bufferedBytes).toBe(0)
  })

  test("相同 fragment_id 按来源设备隔离", () => {
    const payload = { value: "x".repeat(relayFragmentThresholdBytes) }
    const envelopes = relayEnvelopes("mobile-1", payload, "logical-3", () => "shared-fragment")
    const state = createRelayFragmentState()
    expect(acceptFragment(state, "mobile-a", envelopes[0].payload, 1)).toEqual({ type: "pending" })
    expect(acceptFragment(state, "mobile-b", envelopes[1].payload, 2)).toEqual({ type: "pending" })
    expect(state.assemblies.size).toBe(2)
    expect(acceptFragment(state, "mobile-a", envelopes[1].payload, 3)).toMatchObject({
      type: "ready",
      requestID: "logical-3",
    })
    expect(state.assemblies.size).toBe(1)
  })

  test("TTL 清理过期半包并释放缓存字节", () => {
    const payload = { value: "x".repeat(relayFragmentThresholdBytes) }
    const envelopes = relayEnvelopes("mobile-1", payload, "logical-4", () => "fragment-ttl")
    const state = createRelayFragmentState({ ttlMs: 10 })
    expect(acceptFragment(state, "mobile-1", envelopes[0].payload, 100)).toEqual({ type: "pending" })
    expect(state.bufferedBytes).toBeGreaterThan(0)
    expect(pruneRelayFragmentAssemblies(state, 109)).toBe(0)
    expect(pruneRelayFragmentAssemblies(state, 110)).toBe(1)
    expect(state.assemblies.size).toBe(0)
    expect(state.bufferedBytes).toBe(0)
    expect(acceptFragment(state, "mobile-1", envelopes[1].payload, 111)).toEqual({ type: "pending" })
  })

  test("logical request_id 在 512 字符边界可往返，超限返回独立稳定错误", () => {
    // 允许的最大 ID 必须经过分片编码和乱序重组后原样恢复，证明两端约束闭合。
    const requestID = "r".repeat(512)
    const payload = { value: "x".repeat(relayFragmentThresholdBytes) }
    const envelopes = relayEnvelopes("mobile-1", payload, requestID, () => "fragment-request-id")
    const state = createRelayFragmentState()
    expect(acceptFragment(state, "mobile-1", envelopes[1].payload)).toEqual({ type: "pending" })
    expect(acceptFragment(state, "mobile-1", envelopes[0].payload)).toEqual({
      type: "ready",
      payload,
      requestID,
    })

    expectProtocolError(
      () => relayEnvelopes("mobile-1", { type: "ack" }, "r".repeat(513)),
      "RELAY_REQUEST_ID_TOO_LONG",
      "relay request_id must not exceed 512 characters",
    )
  })

  test("默认重组上限覆盖 64MiB 且状态维持有界", () => {
    const state = createRelayFragmentState()
    expect(relayFragmentMaxAssembledBytes).toBeGreaterThanOrEqual(64 * 1024 * 1024)
    expect(state.maxAssembledBytes).toBe(relayFragmentMaxAssembledBytes)
    expect(state.maxBufferedBytes).toBeGreaterThanOrEqual(state.maxAssembledBytes)
    expect(state.maxAssemblies).toBeGreaterThan(0)
    expect(relayFragmentTTLms).toBe(60_000)
  })

  test("入站分片严格校验外层 request_id 与非末片 512KiB 大小", () => {
    const shortFirst = {
      type: "bridge.fragment",
      fragment_id: "fragment-wire-shape",
      fragment_index: 0,
      fragment_count: 2,
      data: Buffer.from("short").toString("base64"),
    }
    // 缺失、错组和错片的外层 ID 都必须在写入组装缓存前稳定拒绝。
    for (const outerRequestID of [undefined, "fragment:other:0", "fragment:fragment-wire-shape:1"]) {
      expectFragmentError(
        () => acceptRelayPayload(createRelayFragmentState(), "mobile-1", shortFirst, outerRequestID),
        "fragment outer request_id does not match fragment_id and fragment_index",
      )
    }
    expectFragmentError(
      () => acceptFragment(createRelayFragmentState(), "mobile-1", shortFirst),
      `non-final fragment data must contain exactly ${relayFragmentThresholdBytes} bytes`,
    )

    // 末片允许小于 512KiB，确保固定块约束不会误伤正常的最后一片。
    const shortFinal = { ...shortFirst, fragment_index: 1 }
    expect(acceptFragment(createRelayFragmentState(), "mobile-1", shortFinal)).toEqual({ type: "pending" })
  })

  test("非法 count、index、base64 和逻辑 request_id 返回稳定 ProtocolError", () => {
    const valid = {
      type: "bridge.fragment",
      fragment_id: "fragment-invalid",
      fragment_index: 0,
      fragment_count: 2,
      data: Buffer.from("a").toString("base64"),
      request_id: "logical-invalid",
    }
    const invalid = [
      { ...valid, fragment_count: 1 },
      { ...valid, fragment_count: 2.5 },
      { ...valid, fragment_count: 513 },
      { ...valid, fragment_index: -1 },
      { ...valid, fragment_index: 2 },
      { ...valid, fragment_index: 0.5 },
      { ...valid, data: "not-base64" },
      { ...valid, data: "YQ" },
      { ...valid, data: "A".repeat(Math.ceil(relayFragmentThresholdBytes / 3) * 4 + 4) },
      { ...valid, request_id: 42 },
      { ...valid, request_id: "r".repeat(513) },
      { ...valid, fragment_id: "" },
    ]
    // 外层 ID 保持合法，保证每个断言实际命中对应的内层字段校验。
    invalid.forEach((item) =>
      expectFragmentError(() =>
        acceptRelayPayload(createRelayFragmentState(), "mobile-1", item, fragmentWireRequestID(item)),
      ),
    )
  })

  test("同组元数据或同索引内容冲突会销毁已缓存组装", () => {
    // 非末片使用完整固定块，使该测试只关注同一组装键下的元数据和内容冲突。
    const first = {
      type: "bridge.fragment",
      fragment_id: "fragment-conflict",
      fragment_index: 0,
      fragment_count: 2,
      data: Buffer.alloc(relayFragmentThresholdBytes, "a").toString("base64"),
      request_id: "logical-conflict",
    }
    const state = createRelayFragmentState()
    expect(acceptFragment(state, "mobile-1", first, 1)).toEqual({ type: "pending" })
    expectFragmentError(
      () => acceptFragment(state, "mobile-1", { ...first, fragment_count: 3 }, 2),
      "fragment metadata conflicts with an existing assembly",
    )
    expect(state.assemblies.size).toBe(0)
    expect(state.bufferedBytes).toBe(0)

    expect(acceptFragment(state, "mobile-1", first, 3)).toEqual({ type: "pending" })
    expectFragmentError(
      () =>
        acceptFragment(
          state,
          "mobile-1",
          { ...first, data: Buffer.alloc(relayFragmentThresholdBytes, "b").toString("base64") },
          4,
        ),
      "fragment data conflicts with an existing index",
    )
    expect(state.assemblies.size).toBe(0)
    expect(state.bufferedBytes).toBe(0)
  })

  test("单组、全局字节和并发组数上限拒绝恶意半包", () => {
    // 使用允许短块的末片，避免固定非末片规则掩盖缓存容量断言。
    const part = (id: string, data: string) => ({
      type: "bridge.fragment",
      fragment_id: id,
      fragment_index: 1,
      fragment_count: 2,
      data: Buffer.from(data).toString("base64"),
    })
    expectFragmentError(() =>
      acceptFragment(createRelayFragmentState({ maxAssembledBytes: 1 }), "mobile-1", part("too-large", "ab")),
    )
    expectFragmentError(() =>
      acceptFragment(createRelayFragmentState({ maxBufferedBytes: 1 }), "mobile-1", part("buffer-full", "ab")),
    )

    const state = createRelayFragmentState({ maxAssemblies: 1 })
    expect(acceptFragment(state, "mobile-1", part("first", "a"))).toEqual({ type: "pending" })
    expectFragmentError(() => acceptFragment(state, "mobile-1", part("second", "b")))
    expect(state.assemblies.size).toBe(1)
  })

  test("损坏的 UTF-8 和 JSON 在完整组装后仍返回稳定 ProtocolError", () => {
    const chunks = (id: string, bytes: Buffer) =>
      [bytes.subarray(0, relayFragmentThresholdBytes), bytes.subarray(relayFragmentThresholdBytes)].map(
        (data, index) => ({
          type: "bridge.fragment",
          fragment_id: id,
          fragment_index: index,
          fragment_count: 2,
          data: data.toString("base64"),
        }),
      )

    const invalidUTF8 = chunks("invalid-utf8", Buffer.alloc(relayFragmentThresholdBytes + 1, 0xff))
    const utf8State = createRelayFragmentState()
    expect(acceptFragment(utf8State, "mobile-1", invalidUTF8[0])).toEqual({ type: "pending" })
    expectFragmentError(
      () => acceptFragment(utf8State, "mobile-1", invalidUTF8[1]),
      "assembled payload is not valid UTF-8",
    )

    const invalidJSON = chunks("invalid-json", Buffer.from("x".repeat(relayFragmentThresholdBytes + 1), "utf8"))
    const jsonState = createRelayFragmentState()
    expect(acceptFragment(jsonState, "mobile-1", invalidJSON[0])).toEqual({ type: "pending" })
    expectFragmentError(
      () => acceptFragment(jsonState, "mobile-1", invalidJSON[1]),
      "assembled payload is not valid JSON",
    )
  })

  test("出站分片必须逐片等待 matching relay.accepted", async () => {
    const subject = createGatewayHarness()
    const sent = attachSocket(subject)
    const delivery = subject.relay("mobile-1", { value: "x".repeat(relayFragmentThresholdBytes) }, "logical-ack")
    expect(sent).toHaveLength(1)

    // 错目标、错 ID 或旧 socket 的回执都不能打开窗口，第二片必须继续留在桌面队列中。
    await subject.handleMessage(
      JSON.stringify({ type: "relay.accepted", target_device_id: "mobile-2", request_id: sent[0]?.request_id }),
    )
    await subject.handleMessage(
      JSON.stringify({ type: "relay.accepted", target_device_id: "mobile-1", request_id: "wrong-request" }),
    )
    const staleSocket: FakeSocket = { readyState: 1, send() {}, close() {} }
    await subject.handleMessage(
      JSON.stringify({
        type: "relay.accepted",
        target_device_id: "mobile-1",
        request_id: sent[0]?.request_id,
      }),
      staleSocket,
    )
    await Bun.sleep(0)
    expect(sent).toHaveLength(1)

    await acknowledge(subject, sent[0]!)
    await Bun.sleep(0)
    expect(sent).toHaveLength(2)
    await acknowledge(subject, sent[1]!)
    await expect(delivery).resolves.toEqual({ type: "sent" })
    expect(sent.map((envelope) => fragment(envelope.payload).fragment_index)).toEqual([0, 1])
    expect(subject.pendingRelayDelivery).toBeUndefined()
    expect(subject.relayQueueBytes).toBe(0)
  })

  test("服务端 relay 错误会终止当前逻辑消息的剩余分片", async () => {
    const subject = createGatewayHarness()
    const sent = attachSocket(subject)
    const delivery = subject.relay("mobile-1", { value: "x".repeat(relayFragmentThresholdBytes) }, "logical-error")
    expect(sent).toHaveLength(1)

    await subject.handleMessage(
      JSON.stringify({
        type: "error",
        request_id: sent[0]?.request_id,
        error: { code: "REMOTE_CONTROL_TARGET_OFFLINE", message: "target offline" },
      }),
    )
    await expect(delivery).resolves.toMatchObject({
      type: "rejected",
      error: { code: "REMOTE_CONTROL_TARGET_OFFLINE" },
    })
    expect(sent).toHaveLength(1)
    expect(subject.pendingRelayDelivery).toBeUndefined()
    expect(subject.relayQueueBytes).toBe(0)
  })

  test("relay ACK 超时会清理 pending 并停止后续分片", async () => {
    const subject = createGatewayHarness()
    subject.relayAckTimeoutMs = 5
    const sent = attachSocket(subject)
    const closes: Array<{ code?: number; reason?: string }> = []
    subject.socket!.close = function (code, reason) {
      closes.push({ code, reason })
      this.readyState = 2
    }
    const delivery = subject.relay("mobile-1", { value: "x".repeat(relayFragmentThresholdBytes) }, "logical-timeout")
    const queued = subject.relay("mobile-1", { type: "sync.event", value: "queued" })

    await expect(delivery).resolves.toMatchObject({
      type: "rejected",
      error: { code: "REMOTE_CONTROL_RELAY_ACK_TIMEOUT" },
    })
    await expect(queued).resolves.toMatchObject({
      type: "rejected",
      error: { code: "REMOTE_CONTROL_RELAY_ACK_TIMEOUT" },
    })
    expect(sent).toHaveLength(1)
    expect(closes).toEqual([{ code: 1013, reason: "REMOTE_CONTROL_RELAY_ACK_TIMEOUT" }])
    expect(subject.pendingRelayDelivery).toBeUndefined()
    expect(subject.relayQueueBytes).toBe(0)
  })

  test("WebSocket close 会解除等待并停止当前逻辑消息", async () => {
    const subject = createGatewayHarness()
    const sent = attachSocket(subject)
    const socket = subject.socket!
    const delivery = subject.relay("mobile-1", { value: "x".repeat(relayFragmentThresholdBytes) }, "logical-close")
    expect(sent).toHaveLength(1)

    await subject.handleSocketClose(socket, 1006, "fake server closed")
    await expect(delivery).resolves.toMatchObject({
      type: "rejected",
      error: { code: "REMOTE_CONTROL_RELAY_SOCKET_CLOSED" },
    })
    expect(sent).toHaveLength(1)
    expect(subject.pendingRelayDelivery).toBeUndefined()
    expect(subject.relayQueueBytes).toBe(0)
  })

  test("REMOTE_CONTROL_AUTH_REVOKED 会标记关闭 socket 捕获的 OAuth 代次", async () => {
    WanlaiCodeRefreshCoordinator.resetForTest()
    const subject = createGatewayHarness()
    subject.running = true
    attachSocket(subject)
    const socket = subject.socket!
    const credential = {
      type: "oauth" as const,
      access: "sk-old",
      refresh: "R0",
      softwareToken: "jwt-old",
      expires: 100,
    }
    subject.socketCredentials.set(socket, credential)
    subject.currentOAuthCredential = async () => credential

    // 关闭帧只标记其自身快照；真实实现不会在异步 close 到达时重读并污染新登录。
    await subject.handleSocketClose(socket, 1008, "REMOTE_CONTROL_AUTH_REVOKED")

    expect(WanlaiCodeRefreshCoordinator.isCredentialInvalid(credential)).toBe(true)
    expect(subject.state).toBe("auth_required")
    WanlaiCodeRefreshCoordinator.resetForTest()
  })

  test("旧 socket 撤权晚于同账号新登录时只失效旧代次并重连", async () => {
    WanlaiCodeRefreshCoordinator.resetForTest()
    const subject = createGatewayHarness()
    subject.running = true
    attachSocket(subject)
    const socket = subject.socket!
    const previous = {
      type: "oauth" as const,
      access: "sk-old",
      refresh: "R0",
      softwareToken: "jwt-old",
      expires: 100,
    }
    const current = {
      type: "oauth" as const,
      access: "sk-new",
      refresh: "R1",
      softwareToken: "jwt-new",
      expires: 200,
    }
    subject.socketCredentials.set(socket, previous)
    subject.currentOAuthCredential = async () => current
    let connects = 0
    subject.connect = async () => void (connects += 1)

    // callback 已落盘新代次后，旧连接的迟到关闭帧不能把桌面重新打回未登录。
    await subject.handleSocketClose(socket, 1008, "REMOTE_CONTROL_AUTH_REVOKED")

    expect(WanlaiCodeRefreshCoordinator.isCredentialInvalid(previous)).toBe(true)
    expect(WanlaiCodeRefreshCoordinator.isCredentialInvalid(current)).toBe(false)
    expect(subject.state).toBe("disconnected")
    expect(subject.lastError).toBeUndefined()
    expect(connects).toBe(1)
    WanlaiCodeRefreshCoordinator.resetForTest()
  })

  test("建连异步阶段结束时发现同账号凭据已更新会废弃旧链并重连", async () => {
    const subject = createGatewayHarness()
    subject.running = true
    subject.lifecycle = 5
    const previous = {
      type: "oauth" as const,
      access: "sk-old",
      refresh: "R0",
      softwareToken: "jwt-old",
      expires: 100,
    }
    const current = {
      type: "oauth" as const,
      access: "sk-new",
      refresh: "R1",
      softwareToken: "jwt-new",
      expires: 200,
    }
    subject.accountKey = async () => "account-1"
    subject.oauthCredential = async () => ({ token: previous.softwareToken, credential: previous })
    subject.ensureRegistered = async () => ({ deviceID: "desktop-1", token: "device-token" })
    subject.refreshConnections = async () => undefined
    subject.currentOAuthCredential = async () => current
    let connects = 0
    subject.connect = async () => void (connects += 1)

    // 注册和连接列表请求跨越新登录时，旧 JWT 不能再进入 WebSocket 握手。
    await subject.connectOnce(5)

    expect(subject.socket).toBeUndefined()
    expect(subject.lifecycle).toBe(6)
    expect(subject.state).toBe("disconnected")
    expect(connects).toBe(1)
  })

  test("旧 socket 的迟到 open/error 不能污染当前连接或清除新 pending", async () => {
    const subject = createGatewayHarness()
    subject.running = true
    subject.lifecycle = 7
    subject.state = "connecting"
    subject.lastError = "current state"
    const sent = attachSocket(subject)
    const current = subject.socket!
    const currentCloses: Array<{ code?: number; reason?: string }> = []
    current.close = function (code, reason) {
      currentCloses.push({ code, reason })
      this.readyState = 2
    }
    const stale: FakeSocket = { readyState: 1, send() {}, close() {} }
    const delivery = subject.relay("mobile-1", { type: "sync.event", value: "current" }, "current-pending")
    expect(subject.pendingRelayDelivery).toBeDefined()

    subject.handleSocketOpen(stale, 7)
    subject.handleSocketOpen(current, 6)
    subject.handleSocketError(stale, 7, new Error("stale socket error"))
    subject.handleSocketError(current, 6, new Error("stale lifecycle error"))
    expect(subject.state).toBe("connecting")
    expect(subject.lastError).toBe("current state")
    expect(subject.pendingRelayDelivery).toBeDefined()
    expect(currentCloses).toEqual([])

    await acknowledge(subject, sent[0]!)
    await expect(delivery).resolves.toEqual({ type: "sent" })
    expect(subject.relayQueueBytes).toBe(0)
    subject.running = false
  })

  test("当前 lifecycle 的 socket error 会清队列并关闭当前连接", async () => {
    const subject = createGatewayHarness()
    subject.running = true
    subject.lifecycle = 9
    attachSocket(subject)
    const current = subject.socket!
    const closes: Array<{ code?: number; reason?: string }> = []
    current.close = function (code, reason) {
      closes.push({ code, reason })
      this.readyState = 2
    }
    const delivery = subject.relay("mobile-1", { type: "sync.event", value: "current" }, "current-error")

    subject.handleSocketError(current, 9, new Error("current socket failed"))
    await expect(delivery).resolves.toMatchObject({
      type: "rejected",
      error: { code: "REMOTE_CONTROL_RELAY_SOCKET_ERROR", message: "current socket failed" },
    })
    expect(subject.lastError).toBe("current socket failed")
    expect(subject.relayQueueBytes).toBe(0)
    expect(closes).toEqual([{ code: 1011, reason: "REMOTE_CONTROL_RELAY_SOCKET_ERROR" }])
    subject.running = false
  })

  test("fail-close 后处于 CLOSING 的当前 socket 不再消费迟到命令", async () => {
    const subject = createGatewayHarness()
    subject.running = true
    subject.lifecycle = 10
    attachSocket(subject)
    const current = subject.socket!
    subject.devices = [{ id: "connection-1", device_id: "mobile-1", name: "Phone", online: true }]
    subject.validateAccount = async () => true
    const executed: string[] = []
    subject.processInboundRelay = async (job) => void executed.push(job.requestID)
    current.close = function () {
      this.readyState = 2
    }

    subject.handleSocketError(current, 10, new Error("fail close"))
    // close 事件尚未回调时 socket identity 仍相同，但 readyState 门禁必须立即阻止业务重新入队。
    await subject.handleMessage(
      JSON.stringify({
        type: "relay",
        source_device_id: "mobile-1",
        request_id: "late-after-fail-close",
        payload: { type: "sync.snapshot" },
      }),
      current,
    )
    expect(executed).toEqual([])
    expect(subject.relayInboundQueue).toHaveLength(0)
    expect(subject.activeInboundRelayJob).toBeUndefined()
    subject.running = false
  })

  test("出站队列溢出会 fail-close 并触发后续权威重连恢复", async () => {
    const subject = createGatewayHarness()
    const sent: Record<string, unknown>[] = []
    const closes: Array<{ code?: number; reason?: string }> = []
    subject.socket = {
      readyState: 1,
      send(message, callback) {
        sent.push(JSON.parse(message) as Record<string, unknown>)
        callback?.()
      },
      close(code, reason) {
        closes.push({ code, reason })
        this.readyState = 2
      },
    }

    const queued = Array.from({ length: 32 }, (_, index) => subject.relay("mobile-1", { type: "sync.event", index }))
    expect(sent).toHaveLength(1)
    const overflow = await subject.relay("mobile-1", { type: "sync.event", index: 32 })
    expect(overflow).toMatchObject({ type: "rejected", error: { code: "REMOTE_CONTROL_RELAY_QUEUE_FULL" } })
    expect(closes).toEqual([{ code: 1013, reason: "REMOTE_CONTROL_RELAY_QUEUE_FULL" }])
    expect(await Promise.all(queued)).toEqual(
      Array.from({ length: 32 }, () => ({
        type: "rejected",
        error: { code: "REMOTE_CONTROL_RELAY_QUEUE_FULL", message: "Remote control relay queue is full" },
      })),
    )
    expect(subject.pendingRelayDelivery).toBeUndefined()
    expect(subject.relayQueueBytes).toBe(0)
  })

  test("出站总字节预算覆盖 active 与 queued，并在逐项成功后精确释放", async () => {
    const subject = createGatewayHarness()
    const sent = attachSocket(subject)
    const firstPayload = { value: "a".repeat(100) }
    const secondPayload = { value: "b".repeat(120) }
    const firstBytes = Buffer.byteLength(JSON.stringify(firstPayload), "utf8")
    const secondBytes = Buffer.byteLength(JSON.stringify(secondPayload), "utf8")
    subject.relayQueueMaxBytes = firstBytes + secondBytes

    const first = subject.relay("mobile-1", firstPayload, "byte-release-first")
    const second = subject.relay("mobile-1", secondPayload, "byte-release-second")
    expect(sent).toHaveLength(1)
    expect(subject.relayQueueBytes).toBe(firstBytes + secondBytes)

    await acknowledge(subject, sent[0]!)
    await expect(first).resolves.toEqual({ type: "sent" })
    await Bun.sleep(0)
    expect(sent).toHaveLength(2)
    expect(subject.relayQueueBytes).toBe(secondBytes)

    await acknowledge(subject, sent[1]!)
    await expect(second).resolves.toEqual({ type: "sent" })
    expect(subject.relayQueueBytes).toBe(0)
    expect(relayOutboundQueueMaxBytes).toBe(relayFragmentMaxAssembledBytes)
  })

  test("出站总字节超限会清 active/queued 并以 1013 fail-close", async () => {
    const subject = createGatewayHarness()
    const closes: Array<{ code?: number; reason?: string }> = []
    attachSocket(subject)
    subject.socket!.close = function (code, reason) {
      closes.push({ code, reason })
      this.readyState = 2
    }
    const payload = { value: "x".repeat(100) }
    const bytes = Buffer.byteLength(JSON.stringify(payload), "utf8")
    subject.relayQueueMaxBytes = bytes * 2

    const active = subject.relay("mobile-1", payload, "byte-overflow-active")
    const queued = subject.relay("mobile-1", payload, "byte-overflow-queued")
    expect(subject.relayQueueBytes).toBe(bytes * 2)
    const overflow = await subject.relay("mobile-1", payload, "byte-overflow-trigger")

    expect(overflow).toMatchObject({
      type: "rejected",
      error: { code: "REMOTE_CONTROL_RELAY_QUEUE_BYTES_EXCEEDED" },
    })
    await expect(active).resolves.toMatchObject({
      type: "rejected",
      error: { code: "REMOTE_CONTROL_RELAY_QUEUE_BYTES_EXCEEDED" },
    })
    await expect(queued).resolves.toMatchObject({
      type: "rejected",
      error: { code: "REMOTE_CONTROL_RELAY_QUEUE_BYTES_EXCEEDED" },
    })
    expect(subject.relayQueueBytes).toBe(0)
    expect(closes).toEqual([{ code: 1013, reason: "REMOTE_CONTROL_RELAY_QUEUE_BYTES_EXCEEDED" }])
  })

  test("completed 缓存按单条、总字节、TTL 和 FIFO 保持有界", () => {
    expect(relayCompletedCacheEntryMaxBytes).toBe(256 * 1024)
    expect(relayCompletedCacheMaxBytes).toBe(12 * 1024 * 1024)
    expect(relayCompletedCacheTTLms).toBe(10 * 60_000)
    const cache = new RelayCompletionCache({ entryMaxBytes: 96, maxBytes: 150, ttlMs: 10, maxEntries: 2 })
    expect(cache.set("first", { fingerprint: "one", result: [{ value: "a".repeat(30) }] }, 100)).toBe(true)
    expect(cache.set("second", { fingerprint: "two", result: [{ value: "b".repeat(30) }] }, 101)).toBe(true)
    expect(cache.set("third", { fingerprint: "three", result: [{ value: "c".repeat(30) }] }, 102)).toBe(true)
    expect(cache.get("first", 103)).toBeUndefined()
    expect(cache.get("third", 109)).toMatchObject({ fingerprint: "three" })
    expect(cache.get("third", 112)).toBeUndefined()
    expect(cache.bytes).toBe(0)

    const byteBudget = new RelayCompletionCache({ entryMaxBytes: 96, maxBytes: 70, ttlMs: 100, maxEntries: 10 })
    expect(byteBudget.set("older", { fingerprint: "one", result: [{ value: "a".repeat(30) }] }, 1)).toBe(true)
    expect(byteBudget.set("newer", { fingerprint: "two", result: [{ value: "b".repeat(30) }] }, 2)).toBe(true)
    expect(byteBudget.get("older", 3)).toBeUndefined()
    expect(byteBudget.get("newer", 3)).toBeDefined()
    expect(byteBudget.bytes).toBeLessThanOrEqual(70)

    const defaults = new RelayCompletionCache()
    expect(
      defaults.set("oversized", {
        fingerprint: "large",
        result: [{ value: "x".repeat(relayCompletedCacheEntryMaxBytes) }],
      }),
    ).toBe(false)
    expect(defaults.size).toBe(0)
  })

  test("只读请求仅共享 inflight，变更结果才进入 completed 且 stop 会清理", async () => {
    const subject = createGatewayHarness()
    let executeCalls = 0
    let release: (value: Record<string, unknown>[]) => void = () => undefined
    const execute = () => {
      executeCalls += 1
      return new Promise<Record<string, unknown>[]>((resolve) => {
        release = resolve
      })
    }
    const first = subject.inflightRequest("read", "same", execute, () => [{ type: "conflict" }], false)
    const second = subject.inflightRequest("read", "same", execute, () => [{ type: "conflict" }], false)
    expect(executeCalls).toBe(1)
    release([{ type: "snapshot" }])
    expect(await first).toEqual([{ type: "snapshot" }])
    expect(await second).toEqual([{ type: "snapshot" }])
    expect(subject.completed.size).toBe(0)

    await subject.inflightRequest(
      "write",
      "same",
      async () => [{ type: "ack" }],
      () => [{ type: "conflict" }],
      true,
    )
    expect(subject.completed.size).toBe(1)
    expect(remotePayloadMutates({ type: "bridge.client_message", message: { type: "get_history" } })).toBe(false)
    expect(remotePayloadMutates({ type: "bridge.client_message", message: { type: "input" } })).toBe(true)
    // 只读默认值和重名检查不缓存，真正创建目录必须按写操作抵御 relay 重放。
    expect(
      remotePayloadMutates({ type: "bridge.client_message", message: { type: "get_blank_project_defaults" } }),
    ).toBe(false)
    expect(
      remotePayloadMutates({ type: "bridge.client_message", message: { type: "check_blank_project_exists" } }),
    ).toBe(false)
    expect(remotePayloadMutates({ type: "bridge.client_message", message: { type: "create_blank_project" } })).toBe(
      true,
    )
    subject.stop()
    expect(subject.completed.size).toBe(0)
    expect(subject.inflight.size).toBe(0)
  })

  test("换号与设备撤销都会清空 completed", async () => {
    const accountChanged = createGatewayHarness()
    accountChanged.completed.set("account", { fingerprint: "one", result: [{ type: "ack" }] })
    accountChanged.clearAccountState(false)
    expect(accountChanged.completed.size).toBe(0)

    const revoked = createGatewayHarness()
    revoked.completed.set("device", { fingerprint: "two", result: [{ type: "ack" }] })
    revoked.refreshConnections = async () => undefined
    await revoked.handleMessage(JSON.stringify({ type: "device.removed", connection_id: "connection-1" }))
    expect(revoked.completed.size).toBe(0)
  })

  test("账号轮询只在 auth_required 时恢复首次登录或同账号重新认证", async () => {
    const subject = createGatewayHarness()
    subject.running = true
    subject.state = "auth_required"
    subject.observedAccount = null
    subject.accountKey = async () => "account-1"
    let connects = 0
    subject.connect = async () => void (connects += 1)

    // 本地 OAuth 从缺失变为存在时必须离开“未登录”，并主动建立远控连接。
    await expect(subject.validateAccount()).resolves.toBe(true)
    expect(subject.state).toBe("disconnected")
    expect(connects).toBe(1)

    // 正常未连接状态重复轮询不会再次建连。
    await expect(subject.validateAccount()).resolves.toBe(true)
    expect(connects).toBe(1)

    // 同账号重新认证后即使哈希未变，只要当前代次有效也必须恢复。
    subject.state = "auth_required"
    await expect(subject.validateAccount()).resolves.toBe(true)
    expect(connects).toBe(2)
  })

  test("凭据临时缺失后同一账号恢复时会重新连接", async () => {
    const subject = createGatewayHarness()
    subject.running = true
    subject.state = "connected"
    subject.connectedAccount = "account-1"
    subject.observedAccount = "account-1"
    attachSocket(subject)
    subject.clearAccountState(false)
    expect(subject.observedAccount).toBeNull()

    subject.accountKey = async () => "account-1"
    let connects = 0
    subject.connect = async () => void (connects += 1)

    // 文件瞬时读取失败与真实退出都会先进入无账号态；凭据恢复后不能因账号哈希相同永久卡住。
    await expect(subject.validateAccount()).resolves.toBe(true)
    expect(subject.state).toBe("disconnected")
    expect(connects).toBe(1)
  })

  test("账号轮询发现当前 OAuth 代次失效时立即断开旧连接", async () => {
    WanlaiCodeRefreshCoordinator.resetForTest()
    const subject = createGatewayHarness()
    subject.running = true
    subject.state = "connected"
    subject.connectedAccount = "account-1"
    subject.observedAccount = "account-1"
    subject.devices = [{ id: "connection-1", device_id: "mobile-1", name: "Phone", online: true }]
    attachSocket(subject)
    const closes: Array<{ code?: number; reason?: string }> = []
    subject.socket!.close = function (code, reason) {
      closes.push({ code, reason })
      this.readyState = 3
    }
    const credential = {
      type: "oauth" as const,
      access: "sk-revoked",
      refresh: "R-revoked",
      softwareToken: "jwt-revoked",
      expires: 100,
    }
    subject.currentOAuthCredential = async () => credential
    WanlaiCodeRefreshCoordinator.markCredentialInvalid(credential)

    try {
      // 失效注册表是权威撤权边界，不能等账号 ID 变化才清理 socket、设备与入站任务。
      await expect(subject.validateAccount()).resolves.toBe(false)
      expect(subject.state).toBe("auth_required")
      expect(subject.connectedAccount).toBeUndefined()
      expect(subject.devices).toEqual([])
      expect(closes).toEqual([{ code: 4001, reason: "account changed" }])
    } finally {
      WanlaiCodeRefreshCoordinator.resetForTest()
    }
  })

  test("显式登录通知可以让同账号重新认证后恢复连接", async () => {
    const subject = createGatewayHarness()
    subject.running = true
    subject.state = "auth_required"
    subject.observedAccount = "account-1"
    subject.accountKey = async () => "account-1"
    let connects = 0
    subject.connect = async () => void (connects += 1)

    // 用户重新登录同一账号时身份哈希不变，必须依靠 OAuth callback 的显式通知恢复。
    await subject.authChanged()
    expect(connects).toBe(1)
  })

  test("显式登录通知会关闭同账号旧 socket 后立即重连", async () => {
    const subject = createGatewayHarness()
    subject.running = true
    subject.observedAccount = "account-1"
    subject.accountKey = async () => "account-1"
    attachSocket(subject)
    const closes: Array<{ code?: number; reason?: string }> = []
    subject.socket!.close = function (code, reason) {
      closes.push({ code, reason })
      this.readyState = 3
    }
    let connects = 0
    subject.connect = async () => void (connects += 1)

    // OAuth callback 是新的认证边界，不能让 OPEN 状态掩盖同账号 token 已替换的事实。
    await subject.authChanged()

    expect(closes).toEqual([{ code: 4001, reason: "account changed" }])
    expect(subject.state).toBe("disconnected")
    expect(connects).toBe(1)
  })

  test("不同 request_id 的完整入站请求由单 worker 串行执行", async () => {
    const subject = createGatewayHarness()
    subject.devices = [{ id: "connection-1", device_id: "mobile-1", name: "Phone", online: true }]
    subject.validateAccount = async () => true
    const started: string[] = []
    const releases = new Map<string, () => void>()
    let active = 0
    let maxActive = 0
    subject.processInboundRelay = async (job) => {
      started.push(job.requestID)
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise<void>((resolve) => releases.set(job.requestID, resolve))
      active -= 1
    }

    const first = subject.handleRelay({
      type: "relay",
      source_device_id: "mobile-1",
      request_id: "inbound-first",
      payload: { type: "sync.snapshot", index: 1 },
    })
    await Bun.sleep(0)
    const second = subject.handleRelay({
      type: "relay",
      source_device_id: "mobile-1",
      request_id: "inbound-second",
      payload: { type: "sync.snapshot", index: 2 },
    })
    await Bun.sleep(0)
    expect(started).toEqual(["inbound-first"])
    expect(subject.relayInboundQueue).toHaveLength(1)

    releases.get("inbound-first")?.()
    await first
    await Bun.sleep(0)
    expect(started).toEqual(["inbound-first", "inbound-second"])
    releases.get("inbound-second")?.()
    await second
    expect(maxActive).toBe(1)
    expect(subject.relayInboundQueueBytes).toBe(0)
  })

  test("入站 active 与 queued 超过总字节预算时清空并以 1013 fail-close", async () => {
    const subject = createGatewayHarness()
    attachSocket(subject)
    subject.devices = [{ id: "connection-1", device_id: "mobile-1", name: "Phone", online: true }]
    subject.validateAccount = async () => true
    const closes: Array<{ code?: number; reason?: string }> = []
    subject.socket!.close = function (code, reason) {
      closes.push({ code, reason })
      this.readyState = 2
    }
    let releaseActive: () => void = () => undefined
    subject.processInboundRelay = () => new Promise<void>((resolve) => (releaseActive = resolve))
    const payload = { type: "sync.snapshot", data: "x".repeat(64) }
    const bytes = Buffer.byteLength(JSON.stringify(payload), "utf8")
    subject.relayInboundQueueMaxBytes = bytes * 2

    const active = subject.handleRelay({
      type: "relay",
      source_device_id: "mobile-1",
      request_id: "inbound-byte-active",
      payload,
    })
    await Bun.sleep(0)
    const queued = subject.handleRelay({
      type: "relay",
      source_device_id: "mobile-1",
      request_id: "inbound-byte-queued",
      payload,
    })
    await Bun.sleep(0)
    await subject.handleRelay({
      type: "relay",
      source_device_id: "mobile-1",
      request_id: "inbound-byte-overflow",
      payload,
    })

    expect(subject.relayInboundQueue).toHaveLength(0)
    expect(subject.relayInboundQueueBytes).toBe(0)
    expect(closes).toEqual([{ code: 1013, reason: "REMOTE_CONTROL_INBOUND_QUEUE_BYTES_EXCEEDED" }])
    expect(subject.devices[0]?.online).toBe(false)
    await Promise.all([active, queued])
    releaseActive()
    await Bun.sleep(0)
  })

  test("慢账号核验期间完整请求仍受 32 项队列上限约束", async () => {
    const subject = createGatewayHarness()
    attachSocket(subject)
    subject.devices = [{ id: "connection-1", device_id: "mobile-1", name: "Phone", online: true }]
    const closes: Array<{ code?: number; reason?: string }> = []
    subject.socket!.close = function (code, reason) {
      closes.push({ code, reason })
      this.readyState = 2
    }
    // 故意让首个 worker 停在账号核验，证明后续请求先记入有界队列而不是游离在异步核验外。
    subject.validateAccount = () => new Promise<boolean>(() => undefined)
    const active = subject.handleRelay({
      type: "relay",
      source_device_id: "mobile-1",
      request_id: "slow-validation-0",
      payload: { type: "sync.snapshot", index: 0 },
    })
    await Bun.sleep(0)
    expect(subject.activeInboundRelayJob).toBeDefined()
    const requests = [
      active,
      ...Array.from({ length: 32 }, (_, index) =>
        subject.handleRelay({
          type: "relay",
          source_device_id: "mobile-1",
          request_id: `slow-validation-${index + 1}`,
          payload: { type: "sync.snapshot", index: index + 1 },
        }),
      ),
    ]

    await Promise.all(requests)
    expect(subject.relayInboundQueue).toHaveLength(0)
    expect(subject.relayInboundQueueBytes).toBe(0)
    expect(closes).toEqual([{ code: 1013, reason: "REMOTE_CONTROL_INBOUND_QUEUE_FULL" }])
    await Bun.sleep(0)
    expect(subject.activeInboundRelayJob).toBeUndefined()
  })

  test("设备撤销会取消核验中的 active 与 queued 并立即拒绝新请求", async () => {
    const subject = createGatewayHarness()
    const sent = attachAckingSocket(subject)
    subject.devices = [{ id: "connection-1", device_id: "mobile-1", name: "Phone", online: true }]
    subject.refreshConnections = async () => undefined
    subject.validateAccount = () => new Promise<boolean>(() => undefined)
    const executed: string[] = []
    subject.processInboundRelay = async (job) => void executed.push(job.requestID)

    const active = subject.handleRelay({
      type: "relay",
      source_device_id: "mobile-1",
      request_id: "revoked-active",
      payload: { type: "sync.snapshot", index: 1 },
    })
    await Bun.sleep(0)
    const queued = subject.handleRelay({
      type: "relay",
      source_device_id: "mobile-1",
      request_id: "revoked-queued",
      payload: { type: "sync.snapshot", index: 2 },
    })
    await Bun.sleep(0)
    expect(subject.relayInboundQueue).toHaveLength(1)

    // 撤销事件必须先收紧本地授权，再异步刷新连接列表，避免刷新窗口继续接受旧手机命令。
    await subject.handleMessage(JSON.stringify({ type: "device.removed", connection_id: "connection-1" }))
    await Promise.all([active, queued])
    expect(subject.devices).toEqual([])
    expect(subject.relayInboundQueue).toHaveLength(0)
    expect(subject.relayInboundQueueBytes).toBe(0)
    expect(executed).toEqual([])

    await subject.handleRelay({
      type: "relay",
      source_device_id: "mobile-1",
      request_id: "revoked-new",
      payload: { type: "sync.snapshot", index: 3 },
    })
    expect(executed).toEqual([])
    expect(sent.at(-1)?.payload).toMatchObject({
      type: "error",
      code: "REMOTE_CONTROL_RELAY_FORBIDDEN",
    })
  })

  test("设备撤销会定向终止其出站分片且不打断其他手机队列", async () => {
    const subject = createGatewayHarness()
    const sent = attachSocket(subject)
    subject.devices = [
      { id: "connection-1", device_id: "mobile-1", name: "Phone 1", online: true },
      { id: "connection-2", device_id: "mobile-2", name: "Phone 2", online: true },
    ]
    subject.refreshConnections = async () => undefined
    const revoked = subject.relay("mobile-1", { value: "x".repeat(relayFragmentThresholdBytes) }, "revoked-outbound")
    const retained = subject.relay("mobile-2", { type: "sync.event", value: "retained" }, "retained-outbound")
    expect(sent.map((item) => item.target_device_id)).toEqual(["mobile-1"])

    // 首片尚未 ACK 时撤权，active delivery 必须结束且不能再把后续分片发给旧手机。
    await subject.handleMessage(
      JSON.stringify({
        type: "device.removed",
        connection_id: "connection-1",
        source_device_id: "mobile-1",
      }),
    )
    await expect(revoked).resolves.toMatchObject({
      type: "rejected",
      error: { code: "REMOTE_CONTROL_DEVICE_REVOKED" },
    })
    await Bun.sleep(0)
    expect(sent.map((item) => item.target_device_id)).toEqual(["mobile-1", "mobile-2"])
    await acknowledge(subject, sent[1]!)
    await expect(retained).resolves.toEqual({ type: "sent" })
    expect(sent.filter((item) => item.target_device_id === "mobile-1")).toHaveLength(1)
  })

  test("主动事件在首个 envelope 等待期间撤权后不会继续入队后续 Bridge 更新", async () => {
    const subject = createGatewayHarness()
    const sent = attachSocket(subject)
    subject.devices = [{ id: "connection-1", device_id: "mobile-1", name: "Phone", online: true }]
    subject.state = "connected"
    subject.validateAccount = async () => true
    subject.refreshConnections = async () => undefined
    subject.authoritativeBridgeEvent = async () => [
      { type: "assistant", sessionId: "session-1", message: { role: "assistant", content: [] } },
    ]
    const forwarding = subject.forwardEvent({
      payload: { type: "test.revoked_during_event", properties: { sessionID: "session-1" } },
    })
    await Bun.sleep(0)
    expect(sent).toHaveLength(1)

    // native 事件等待 ACK 时撤权，预先计算出的 bridgeUpdates 也必须在真正入队前重新核验授权。
    await subject.handleMessage(
      JSON.stringify({
        type: "device.removed",
        connection_id: "connection-1",
        source_device_id: "mobile-1",
      }),
    )
    await forwarding
    expect(sent).toHaveLength(1)
    expect(sent[0]?.payload).toMatchObject({ type: "sync.event" })
  })

  test("设备撤销后的新连接刷新胜出且旧响应不能恢复已撤销 connection", async () => {
    const subject = createGatewayHarness()
    const oldConnection = {
      id: "connection-old",
      mobile_device: { device_id: "mobile-1", device_name: "Phone" },
    }
    const newConnection = {
      id: "connection-new",
      mobile_device: { device_id: "mobile-1", device_name: "Phone" },
    }
    subject.devices = [{ id: "connection-old", device_id: "mobile-1", name: "Phone", online: true }]
    subject.accountKey = async () => "account-1"
    const responses: Array<(value: unknown) => void> = []
    subject.request = () => new Promise<unknown>((resolve) => responses.push(resolve))

    // 先挂起旧列表请求，再撤销设备并让撤销后的权威刷新先完成，模拟真实网络乱序。
    const stale = subject.refreshConnections("account-1")
    expect(responses).toHaveLength(1)
    const removed = subject.handleMessage(
      JSON.stringify({
        type: "device.removed",
        connection_id: "connection-old",
        source_device_id: "mobile-1",
      }),
    )
    await Bun.sleep(0)
    expect(responses).toHaveLength(2)
    responses[1]?.([oldConnection, newConnection])
    await removed

    expect(subject.devices.map((item) => item.id)).toEqual(["connection-new"])
    expect(subject.revokedDeviceConnections.has("mobile-1")).toBe(false)
    responses[0]?.([oldConnection])
    await stale
    expect(subject.devices.map((item) => item.id)).toEqual(["connection-new"])
  })

  test("旧账号迟到的配对与解绑响应不能覆盖新账号状态", async () => {
    const pairingSubject = createGatewayHarness()
    let pairingAccount = "account-a"
    pairingSubject.lifecycle = 1
    pairingSubject.accountKey = async () => pairingAccount
    pairingSubject.ensureReady = async () => undefined
    let resolvePairing: (value: unknown) => void = () => undefined
    pairingSubject.request = () => new Promise<unknown>((resolve) => (resolvePairing = resolve))
    const creating = pairingSubject.createPairing()
    await Bun.sleep(0)

    // A 的 POST 在途时切到 B，并先建立 B 自己的配对状态；A 的响应不得生成或覆盖当前二维码。
    pairingAccount = "account-b"
    pairingSubject.lifecycle = 2
    pairingSubject.pairing = {
      pairing_id: "pairing-b",
      secret: "secret-b",
      expires_at: "2099-01-01T00:00:00.000Z",
      qr: "wanlai://pair?account=b",
    }
    resolvePairing({
      pairing_id: "pairing-a",
      pairing_secret: "secret-a",
      expires_at: "2099-01-01T00:00:00.000Z",
    })
    await expect(creating).rejects.toMatchObject({ code: "REMOTE_CONTROL_ACCOUNT_CHANGED" })
    expect(pairingSubject.pairing?.pairing_id).toBe("pairing-b")

    const removalSubject = createGatewayHarness()
    let removalAccount = "account-a"
    removalSubject.lifecycle = 3
    removalSubject.assertAvailable = () => undefined
    removalSubject.accountKey = async () => removalAccount
    removalSubject.devices = [{ id: "connection-a", device_id: "mobile-shared", name: "Phone A", online: true }]
    let resolveRemoval: (value: unknown) => void = () => undefined
    removalSubject.request = () => new Promise<unknown>((resolve) => (resolveRemoval = resolve))
    const removing = removalSubject.removeConnection("connection-a")
    await Bun.sleep(0)

    // DELETE 等待期间 B 绑定了同 device_id 的新 connection，A 的迟到成功不能把 B 一并墓碑或移除。
    removalAccount = "account-b"
    removalSubject.lifecycle = 4
    removalSubject.devices = [{ id: "connection-b", device_id: "mobile-shared", name: "Phone B", online: true }]
    resolveRemoval({})
    await expect(removing).rejects.toMatchObject({ code: "REMOTE_CONTROL_ACCOUNT_CHANGED" })
    expect(removalSubject.devices.map((item) => item.id)).toEqual(["connection-b"])
  })

  test("历史 barrier 在 snapshot ACK 后只向原请求手机重放实时事件", async () => {
    const subject = createGatewayHarness()
    const sent = attachAckingSocket(subject)
    subject.devices = [
      { id: "connection-1", device_id: "mobile-1", name: "Phone 1", online: true },
      { id: "connection-2", device_id: "mobile-2", name: "Phone 2", online: true },
    ]
    subject.state = "connected"
    subject.validateAccount = async () => true
    const barrier = subject.beginHistoryEventBarrier("mobile-1", "session-1")
    const event = {
      payload: {
        type: "test.history_barrier",
        properties: { sessionID: "session-1", value: "live" },
      },
    }

    // mobile-1 正在应用权威历史时先缓存事件，未请求历史的 mobile-2 仍应正常收到实时扇出。
    await subject.forwardEvent(event)
    expect(sent.map((item) => item.target_device_id)).toEqual(["mobile-2"])
    await subject.relay(
      "mobile-1",
      {
        type: "bridge.server_message",
        message: { type: "history_snapshot", sessionId: "session-1", messages: [], reason: "reset" },
      },
      "history-snapshot-1",
    )
    await subject.finishHistoryEventBarrier(barrier, true)

    expect(sent.map((item) => item.target_device_id)).toEqual(["mobile-2", "mobile-1", "mobile-1"])
    expect(sent.map((item) => (item.payload as { type: string }).type)).toEqual([
      "sync.event",
      "bridge.server_message",
      "sync.event",
    ])
    expect(sent.filter((item) => item.target_device_id === "mobile-2")).toHaveLength(1)
    expect(subject.historyEventBufferCount).toBe(0)
    expect(subject.historyEventBufferBytes).toBe(0)
  })

  test("历史 barrier 重放期间的新事件进入下一批且不会越过旧事件", async () => {
    const subject = createGatewayHarness()
    const sent = attachAckingSocket(subject)
    subject.devices = [{ id: "connection-1", device_id: "mobile-1", name: "Phone", online: true }]
    subject.state = "connected"
    subject.validateAccount = async () => true
    let markReplayStarted: () => void = () => undefined
    const replayStarted = new Promise<void>((resolve) => (markReplayStarted = resolve))
    let releaseFirstReplay: () => void = () => undefined
    const firstReplayBlocked = new Promise<void>((resolve) => (releaseFirstReplay = resolve))
    subject.authoritativeBridgeEvent = async (...input) => {
      const event = input[2] as { payload?: { properties?: { value?: string } } }
      if (event.payload?.properties?.value === "first") {
        markReplayStarted()
        await firstReplayBlocked
      }
      return []
    }
    const event = (value: string) => ({
      payload: { type: "test.history_barrier", properties: { sessionID: "session-1", value } },
    })
    const barrier = subject.beginHistoryEventBarrier("mobile-1", "session-1")
    await subject.forwardEvent(event("first"))

    const finish = subject.finishHistoryEventBarrier(barrier, true)
    await replayStarted
    // 第一批仍在 await 时到达的事件必须继续缓存，不能先于旧事件直接发往手机。
    await subject.forwardEvent(event("second"))
    expect(sent).toEqual([])
    releaseFirstReplay()
    await finish

    expect(
      sent.map(
        (item) =>
          (item.payload as { event: { payload: { properties: { value: string } } } }).event.payload.properties.value,
      ),
    ).toEqual(["first", "second"])
    expect(subject.historyEventBufferCount).toBe(0)
    expect(subject.historyEventBufferBytes).toBe(0)
  })

  test("历史 barrier 重放等待期间切换账号会丢弃旧事件", async () => {
    const subject = createGatewayHarness()
    const sent = attachAckingSocket(subject)
    subject.devices = [{ id: "connection-1", device_id: "mobile-1", name: "Phone", online: true }]
    subject.state = "connected"
    subject.validateAccount = async () => true
    const barrier = subject.beginHistoryEventBarrier("mobile-1", "session-1")
    await subject.forwardEvent({
      payload: { type: "test.history_barrier", properties: { sessionID: "session-1", value: "old-account" } },
    })
    let markValidationStarted!: () => void
    const validationStarted = new Promise<void>((resolve) => {
      markValidationStarted = resolve
    })
    let releaseValidation!: () => void
    const validationGate = new Promise<void>((resolve) => {
      releaseValidation = resolve
    })
    subject.validateAccount = async () => {
      markValidationStarted()
      await validationGate
      return true
    }

    const finish = subject.finishHistoryEventBarrier(barrier, true)
    await validationStarted
    subject.lifecycle += 1
    releaseValidation()
    await finish

    // 重放内部 await 结束时必须再次核对 barrier 代次，不能借新账号 socket 发送旧缓存。
    expect(sent).toEqual([])
  })

  test("历史 barrier 重放失败会清理缓存并以 1013 触发权威重连", async () => {
    const subject = createGatewayHarness()
    attachSocket(subject)
    const closes: Array<{ code?: number; reason?: string }> = []
    subject.socket!.close = function (code, reason) {
      closes.push({ code, reason })
      this.readyState = 2
    }
    subject.devices = [{ id: "connection-1", device_id: "mobile-1", name: "Phone", online: true }]
    subject.state = "connected"
    subject.validateAccount = async () => true
    const barrier = subject.beginHistoryEventBarrier("mobile-1", "session-1")
    await subject.forwardEvent({
      payload: { type: "test.history_barrier", properties: { sessionID: "session-1", value: "buffered" } },
    })
    // 模拟权威事件映射失败，验证不能留下永久只进不出的 barrier，也不能保持残缺连接在线。
    subject.forwardEvent = async () => {
      throw new Error("replay mapping failed")
    }

    await expect(subject.finishHistoryEventBarrier(barrier, true)).rejects.toThrow("replay mapping failed")
    expect(subject.historyEventBarriers.size).toBe(0)
    expect(subject.historyEventBufferCount).toBe(0)
    expect(subject.historyEventBufferBytes).toBe(0)
    expect(subject.devices[0]?.online).toBe(false)
    expect(closes).toEqual([{ code: 1013, reason: "REMOTE_CONTROL_HISTORY_REPLAY_FAILED" }])
  })

  test("历史首块 ACK 后下一页失败会丢弃实时缓存并以 1013 重连", async () => {
    const subject = createGatewayHarness()
    const sent = attachSocket(subject)
    const closes: Array<{ code?: number; reason?: string }> = []
    subject.socket!.close = function (code, reason) {
      closes.push({ code, reason })
      this.readyState = 2
    }
    subject.devices = [{ id: "connection-1", device_id: "mobile-1", name: "Phone", online: true }]
    subject.state = "connected"
    subject.validateAccount = async () => true
    const originalHistoryPage = operations.historyPage
    let forwardPages = 0
    const message = (id: string, text: string) =>
      ({
        info: {
          id,
          sessionID: "session-1",
          role: "user",
          time: { created: 1 },
          agent: "build",
          model: { providerID: "test", modelID: "test-model" },
        },
        parts: [{ id: `${id}-part`, sessionID: "session-1", messageID: id, type: "text", text }],
      }) as MessageV2.WithParts
    operations.historyPage = async (input) => {
      if (input.direction === "backward") {
        return { session_id: "session-1", items: [], high_water: "history-high-water" }
      }
      forwardPages += 1
      if (forwardPages === 1) {
        // 两条 17 MiB 消息会跨过 32 MiB chunk，让生成器先等待首个 snapshot ACK 再请求下一页。
        return {
          session_id: "session-1",
          items: [
            { type: "message", message: message("message-1", "a".repeat(17 * 1024 * 1024)), bytes: 17 * 1024 * 1024 },
            { type: "message", message: message("message-2", "b".repeat(17 * 1024 * 1024)), bytes: 17 * 1024 * 1024 },
          ],
          next_cursor: "history-next",
          high_water: "history-high-water",
        }
      }
      throw new Error("history page failed")
    }

    try {
      const handling = subject.handleRelay({
        type: "relay",
        source_device_id: "mobile-1",
        request_id: "history-stream-failure",
        payload: {
          type: "bridge.client_message",
          message: { type: "get_history", sessionId: "session-1" },
        },
      })
      await Bun.sleep(0)
      expect(sent).toHaveLength(1)
      expect(sent[0]?.payload).toMatchObject({ type: "bridge.fragment", request_id: "history-stream-failure" })
      await subject.forwardEvent({
        payload: { type: "test.history_barrier", properties: { sessionID: "session-1", value: "live" } },
      })
      expect(subject.historyEventBufferCount).toBe(1)

      const fragmentCount = (sent[0]?.payload as { fragment_count: number }).fragment_count
      for (let index = 0; index < fragmentCount; index += 1) {
        await acknowledge(subject, sent[index]!)
        await Bun.sleep(0)
      }
      await handling
      expect(sent).toHaveLength(fragmentCount)
      expect(subject.historyEventBarriers.size).toBe(0)
      expect(subject.historyEventBufferCount).toBe(0)
      expect(subject.historyEventBufferBytes).toBe(0)
      expect(closes).toEqual([{ code: 1013, reason: "REMOTE_CONTROL_HISTORY_SYNC_FAILED" }])
    } finally {
      operations.historyPage = originalHistoryPage
    }
  })

  test("重复 pending 分片不进入业务队列也不触发 32 项数量上限", async () => {
    const subject = createGatewayHarness()
    const sent = attachSocket(subject)
    subject.devices = [{ id: "connection-1", device_id: "mobile-1", name: "Phone", online: true }]
    subject.validateAccount = async () => true
    const payload: RelayFragmentPayload = {
      type: "bridge.fragment",
      fragment_id: "pending-does-not-queue",
      fragment_index: 0,
      fragment_count: 128,
      data: Buffer.alloc(relayFragmentThresholdBytes, 1).toString("base64"),
      request_id: "pending-logical-request",
    }
    const envelope = {
      type: "relay",
      source_device_id: "mobile-1",
      request_id: fragmentWireRequestID(payload),
      payload,
    }

    for (let index = 0; index < 128; index += 1) await subject.handleRelay(envelope)
    expect(subject.relayInboundQueue).toHaveLength(0)
    expect(subject.relayInboundQueueBytes).toBe(0)
    expect(subject.activeInboundRelayJob).toBeUndefined()
    expect(sent).toEqual([])
  })

  test("桌面重连后手机握手建立租约并在真实 offline 后停止主动扇出", async () => {
    const subject = createGatewayHarness()
    attachSocket(subject)
    const oldSocket = subject.socket!
    subject.devices = [{ id: "connection-1", device_id: "mobile-1", name: "Phone", online: true }]
    await subject.handleSocketClose(oldSocket, 1006, "network lost")
    expect(subject.devices[0]?.online).toBe(false)

    const sent = attachAckingSocket(subject)
    const currentSocket = subject.socket!
    subject.state = "connected"
    subject.validateAccount = async () => true
    await subject.handleMessage(
      JSON.stringify({
        type: "relay",
        source_device_id: "mobile-1",
        request_id: "capabilities-after-reconnect",
        payload: { type: "bridge.client_message", message: { type: "client_capabilities" } },
      }),
      currentSocket,
    )
    expect(subject.devices[0]?.online).toBe(true)
    expect(subject.presence.get("mobile-1")?.has("relay-observed")).toBe(true)

    sent.length = 0
    await subject.forwardEvent({ payload: { type: "test.after_handshake", value: 1 } })
    expect(sent.map((envelope) => envelope.target_device_id)).toEqual(["mobile-1"])

    await subject.handleMessage(
      JSON.stringify({
        type: "presence",
        source_device_id: "mobile-1",
        presence: "online",
        presence_session_id: "mobile-session-new",
        presence_ttl_seconds: 75,
      }),
      currentSocket,
    )
    expect(subject.presence.get("mobile-1")?.has("relay-observed")).toBe(false)
    await subject.handleMessage(
      JSON.stringify({
        type: "presence",
        source_device_id: "mobile-1",
        presence: "offline",
        presence_session_id: "mobile-session-new",
      }),
      currentSocket,
    )
    expect(subject.devices[0]?.online).toBe(false)
    sent.length = 0
    await subject.forwardEvent({ payload: { type: "test.after_offline", value: 2 } })
    expect(sent).toEqual([])
  })

  test("relay 后到的真实 offline 不会被迟到账号核验重新复活", async () => {
    const subject = createGatewayHarness()
    attachAckingSocket(subject)
    const currentSocket = subject.socket!
    subject.devices = [{ id: "connection-1", device_id: "mobile-1", name: "Phone", online: false }]
    let resolveValidation: (value: boolean) => void = () => undefined
    subject.validateAccount = () => new Promise<boolean>((resolve) => (resolveValidation = resolve))

    const relay = subject.handleMessage(
      JSON.stringify({
        type: "relay",
        source_device_id: "mobile-1",
        request_id: "capabilities-before-offline",
        payload: { type: "bridge.client_message", message: { type: "client_capabilities" } },
      }),
      currentSocket,
    )
    await Bun.sleep(0)
    await subject.handleMessage(
      JSON.stringify({
        type: "presence",
        source_device_id: "mobile-1",
        presence: "offline",
        presence_session_id: "mobile-session-old",
      }),
      currentSocket,
    )
    resolveValidation(true)
    await relay
    expect(subject.devices[0]?.online).toBe(false)
    expect(subject.presence.get("mobile-1")?.has("relay-observed") ?? false).toBe(false)
  })

  test("旧 socket 的迟到手机握手不能给新连接恢复 synthetic 在线租约", async () => {
    const subject = createGatewayHarness()
    const oldSent = attachAckingSocket(subject)
    const oldSocket = subject.socket!
    subject.devices = [{ id: "connection-1", device_id: "mobile-1", name: "Phone", online: false }]
    let resolveValidation: (value: boolean) => void = () => undefined
    subject.validateAccount = () => new Promise<boolean>((resolve) => (resolveValidation = resolve))

    const stale = subject.handleMessage(
      JSON.stringify({
        type: "relay",
        source_device_id: "mobile-1",
        request_id: "stale-socket-capabilities",
        payload: { type: "bridge.client_message", message: { type: "client_capabilities" } },
      }),
      oldSocket,
    )
    await Bun.sleep(0)
    attachAckingSocket(subject)
    resolveValidation(true)
    await stale

    expect(oldSent).toEqual([])
    expect(subject.devices[0]?.online).toBe(false)
    expect(subject.presence.get("mobile-1")?.has("relay-observed") ?? false).toBe(false)
  })

  test("handleRelay 对多个响应逐项等待 ACK", async () => {
    const subject = createGatewayHarness()
    const sent = attachSocket(subject)
    subject.devices = [{ id: "connection-1", device_id: "mobile-1", name: "Phone", online: true }]
    subject.validateAccount = async () => true
    subject.inflightRequest = async () => [
      { type: "ack", index: 1 },
      { type: "ack", index: 2 },
      { type: "ack", index: 3 },
    ]
    const handling = subject.handleRelay({
      type: "relay",
      source_device_id: "mobile-1",
      request_id: "logical-burst",
      payload: { type: "sync.snapshot" },
    })
    await Bun.sleep(0)
    expect(sent).toHaveLength(1)
    for (let index = 0; index < 3; index += 1) {
      await acknowledge(subject, sent[index]!)
      await Bun.sleep(0)
      expect(sent).toHaveLength(Math.min(index + 2, 3))
    }
    await expect(handling).resolves.toBeUndefined()
    expect(sent.map((envelope) => (envelope.payload as { index: number }).index)).toEqual([1, 2, 3])
  })

  test("handleRelay 首个响应交付失败后不再发送剩余结果", async () => {
    const subject = createGatewayHarness()
    const sent = attachSocket(subject, (envelope) =>
      queueMicrotask(
        () =>
          void subject.handleMessage(
            JSON.stringify({
              type: "error",
              request_id: envelope.request_id,
              error: { code: "REMOTE_CONTROL_TARGET_OFFLINE", message: "target offline" },
            }),
          ),
      ),
    )
    subject.devices = [{ id: "connection-1", device_id: "mobile-1", name: "Phone", online: true }]
    subject.validateAccount = async () => true
    subject.inflightRequest = async () => [
      { type: "ack", index: 1 },
      { type: "ack", index: 2 },
      { type: "ack", index: 3 },
    ]

    await subject.handleRelay({
      type: "relay",
      source_device_id: "mobile-1",
      request_id: "logical-delivery-error",
      payload: { type: "sync.snapshot" },
    })
    expect(sent).toHaveLength(1)
    expect(sent[0]?.payload).toEqual({ type: "ack", index: 1 })
    expect(subject.pendingRelayDelivery).toBeUndefined()
  })

  test("handleRelay 保留 protocol 生成的 input_rejected 与用户可见 error", async () => {
    const subject = createGatewayHarness()
    const sent = attachAckingSocket(subject)
    subject.devices = [{ id: "connection-1", device_id: "mobile-1", name: "Phone", online: true }]
    subject.validateAccount = async () => true

    await subject.handleRelay({
      type: "relay",
      source_device_id: "mobile-1",
      request_id: "logical-input-rejected",
      payload: {
        type: "bridge.client_message",
        message: {
          type: "input",
          sessionId: "session-1",
          clientMessageId: "mobile-invalid-image",
          text: "invalid image",
          images: [{ mimeType: "image/png", base64: "not-base64" }],
        },
      },
    })

    expect(sent).toHaveLength(2)
    expect(sent.map((envelope) => envelope.request_id)).toEqual(["logical-input-rejected", "logical-input-rejected"])
    expect(sent.map((envelope) => (envelope.payload as { message: Record<string, unknown> }).message.type)).toEqual([
      "input_rejected",
      "error",
    ])
    expect((sent[0]?.payload as { message: Record<string, unknown> }).message).toMatchObject({
      sessionId: "session-1",
      clientMessageId: "mobile-invalid-image",
      reason: "Image 1 must use canonical Base64",
    })
  })

  test("非分片超长 UTF-8 request_id 在业务分发前被拒绝", async () => {
    const subject = createGatewayHarness()
    const sent = attachAckingSocket(subject)
    subject.devices = [{ id: "connection-1", device_id: "mobile-1", name: "Phone", online: true }]
    subject.validateAccount = async () => true
    let dispatched = 0
    subject.inflightRequest = async () => {
      dispatched += 1
      return []
    }

    await subject.handleRelay({
      type: "relay",
      source_device_id: "mobile-1",
      request_id: "界".repeat(171),
      payload: { type: "sync.snapshot" },
    })
    expect(dispatched).toBe(0)
    expect(sent).toHaveLength(1)
    expect(sent[0]?.payload).toMatchObject({ type: "error", code: "INVALID_RELAY_REQUEST_ID" })
  })

  test("handleRelay 将超过 64MiB 的响应降级为保留 request_id 的小错误", async () => {
    const subject = createGatewayHarness()
    // 仅替换账号核验与业务执行，仍走真实 Gateway.relay 编码和回退路径。
    const sent = attachAckingSocket(subject)
    subject.devices = [{ id: "connection-1", device_id: "mobile-1", name: "Phone", online: true }]
    subject.validateAccount = async () => true
    subject.inflightRequest = async () => [{ type: "sync.snapshot", data: "x".repeat(relayFragmentMaxAssembledBytes) }]
    const request = {
      type: "bridge.client_message",
      message: { type: "list_sessions", sessionId: "session-1" },
    }

    await expect(
      subject.handleRelay({
        type: "relay",
        source_device_id: "mobile-1",
        request_id: "logical-large-response",
        payload: request,
      }),
    ).resolves.toBeUndefined()

    expect(sent).toHaveLength(1)
    expect(sent[0]).toEqual({
      type: "relay",
      target_device_id: "mobile-1",
      request_id: "logical-large-response",
      payload: {
        type: "bridge.server_message",
        message: {
          type: "error",
          message: `relay payload exceeds ${relayFragmentMaxAssembledBytes} bytes`,
          errorCode: "RELAY_PAYLOAD_TOO_LARGE",
          sessionId: "session-1",
        },
      },
    })
  })

  test("forwardEvent 对超过 64MiB 的主动事件记录后丢弃且 Promise 正常完成", async () => {
    const subject = createGatewayHarness()
    // 未知事件只生成 native sync.event，便于精确验证超限事件不会发送半包或向上抛错。
    const sent = attachSocket(subject)
    subject.devices = [{ id: "connection-1", device_id: "mobile-1", name: "Phone", online: true }]
    subject.state = "connected"
    subject.validateAccount = async () => true

    await expect(
      subject.forwardEvent({
        payload: { type: "test.oversized", data: "x".repeat(relayFragmentMaxAssembledBytes) },
      }),
    ).resolves.toBeUndefined()
    expect(sent).toEqual([])
  })

  test("主动事件只扇出在线设备，离线设备不会用 ACK timeout 阻塞连续事件", async () => {
    const subject = createGatewayHarness()
    subject.relayAckTimeoutMs = 5
    const sent = attachSocket(subject, (envelope) => {
      if (envelope.target_device_id === "mobile-online") {
        queueMicrotask(() => void acknowledge(subject, envelope))
      }
    })
    const closes: Array<{ code?: number; reason?: string }> = []
    subject.socket!.close = function (code, reason) {
      closes.push({ code, reason })
      this.readyState = 2
    }
    subject.devices = [
      { id: "connection-offline", device_id: "mobile-offline", name: "Offline", online: false },
      { id: "connection-online", device_id: "mobile-online", name: "Online", online: true },
    ]
    subject.state = "connected"
    subject.validateAccount = async () => true

    await Promise.all([
      subject.forwardEvent({ payload: { type: "test.first", value: 1 } }),
      subject.forwardEvent({ payload: { type: "test.second", value: 2 } }),
    ])
    expect(sent).toHaveLength(2)
    expect(sent.map((envelope) => envelope.target_device_id)).toEqual(["mobile-online", "mobile-online"])
    expect(closes).toEqual([])
    expect(subject.relayQueueBytes).toBe(0)
  })

  test("同一会话事件等待前一条完成，不同会话仍可并行映射", async () => {
    const subject = createGatewayHarness()
    subject.running = true
    const calls: string[] = []
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    subject.forwardEvent = async (event) => {
      const payload = event.payload as { type: string; properties: { sessionID: string } }
      if (payload.type === "first") await firstGate
      calls.push(`${payload.properties.sessionID}:${payload.type}`)
    }

    const first = subject.enqueueForwardEvent({
      payload: { type: "first", properties: { sessionID: "session-1" } },
    })
    const second = subject.enqueueForwardEvent({
      payload: { type: "second", properties: { sessionID: "session-1" } },
    })
    const other = subject.enqueueForwardEvent({
      payload: { type: "other", properties: { sessionID: "session-2" } },
    })

    await other
    expect(calls).toEqual(["session-2:other"])
    releaseFirst()
    await Promise.all([first, second])
    // session-1 必须保持原始事件顺序，session-2 不需要等待它的慢历史读取。
    expect(calls).toEqual(["session-2:other", "session-1:first", "session-1:second"])
  })

  test("文件合并屏障阻止同会话终态越过用户图片", async () => {
    const subject = createGatewayHarness()
    subject.running = true
    const calls: string[] = []
    subject.forwardEvent = async (event, coalescedFile) => {
      const payload = event.payload as {
        type: string
        properties: { part?: { id?: string } }
      }
      calls.push(`${payload.type}:${payload.properties.part?.id ?? "terminal"}:${coalescedFile}`)
    }
    const fileEvent = (partID: string) => ({
      payload: {
        type: "message.part.updated",
        properties: {
          sessionID: "session-1",
          part: { id: partID, messageID: "message-1", type: "file" },
        },
      },
    })

    const first = subject.enqueueForwardEvent(fileEvent("file-1"))
    const second = subject.enqueueForwardEvent(fileEvent("file-2"))
    const terminal = subject.enqueueForwardEvent({
      payload: { type: "session.error", properties: { sessionID: "session-1" } },
    })
    await Promise.all([first, second, terminal])

    // 合并后的最新 file 必须先占据原始队列位置，终态只能在图片消息完成后继续。
    expect(calls).toEqual(["message.part.updated:file-2:true", "session.error:terminal:false"])
  })

  test("账号生命周期变化会丢弃仍在等待核验的旧主动事件", async () => {
    const subject = createGatewayHarness()
    const sent = attachAckingSocket(subject)
    subject.running = true
    subject.state = "connected"
    subject.devices = [{ id: "connection-new", device_id: "mobile-new", name: "New phone", online: true }]
    let releaseValidation!: () => void
    const validationGate = new Promise<void>((resolve) => {
      releaseValidation = resolve
    })
    subject.validateAccount = async () => {
      await validationGate
      return true
    }

    const pending = subject.enqueueForwardEvent({
      payload: { type: "session.error", properties: { sessionID: "session-old" } },
    })
    await Bun.sleep(0)
    subject.lifecycle += 1
    releaseValidation()
    await pending

    // 旧账号事件完成 await 后也不能借用新生命周期的 socket 或设备白名单继续发送。
    expect(sent).toEqual([])
  })

  test("同一用户消息的连续 file event 合并一次并抑制原生 data URL 重复发送", async () => {
    const subject = createGatewayHarness()
    const sent = attachAckingSocket(subject)
    subject.devices = [{ id: "connection-1", device_id: "mobile-1", name: "Phone", online: true }]
    subject.running = true
    subject.state = "connected"
    subject.validateAccount = async () => true
    let authoritativeCalls = 0
    // 隔离历史存储依赖，只保留 forwardEvent 的定时合并、原生事件抑制和 Bridge 发送路径。
    subject.authoritativeBridgeEvent = async () => {
      authoritativeCalls += 1
      return [{ type: "user_input", sessionId: "session-1", userMessageUuid: "message-1", imageCount: 2 }]
    }
    const fileEvent = (partID: string) => ({
      payload: {
        type: "message.part.updated",
        properties: {
          sessionID: "session-1",
          part: {
            id: partID,
            sessionID: "session-1",
            messageID: "message-1",
            type: "file",
            mime: "image/png",
            url: "data:image/png;base64,iVBORw0KGgo=",
          },
        },
      },
    })

    const first = subject.enqueueForwardEvent(fileEvent("file-1"))
    const second = subject.enqueueForwardEvent(fileEvent("file-2"))
    expect(sent).toEqual([])
    await Promise.all([first, second])
    subject.running = false

    expect(authoritativeCalls).toBe(1)
    const relays = sent
    expect(relays).toHaveLength(1)
    expect(relays[0]).toMatchObject({
      type: "relay",
      target_device_id: "mobile-1",
      payload: {
        type: "bridge.server_message",
        message: { type: "user_input", userMessageUuid: "message-1", imageCount: 2 },
      },
    })
    expect(JSON.stringify(relays)).not.toContain("sync.event")
    expect(JSON.stringify(relays)).not.toContain("data:image/png")
  })

  test("Auto-review 对每个 permission.asked 动态读持久化模式且不消费 Question", async () => {
    const subject = createGatewayHarness()
    subject.validateAccount = async () => false
    const originalPermissionMode = operations.permissionMode
    const originalPermissionReply = operations.permissionReply
    let mode: "default" | "autoReview" = "default"
    const modeReads: string[] = []
    const replies: string[] = []
    operations.permissionMode = async (input) => {
      modeReads.push(input.session_id)
      return mode
    }
    operations.permissionReply = async (input) => {
      replies.push(input.request_id)
    }
    const permissionEvent = (requestID: string) => ({
      payload: {
        type: "permission.asked",
        properties: {
          id: requestID,
          sessionID: "session-dynamic-mode",
          permission: "bash",
          patterns: ["git status"],
          metadata: {},
        },
      },
    })

    try {
      await subject.forwardEvent(permissionEvent("permission-default-before"))
      mode = "autoReview"
      await subject.forwardEvent(permissionEvent("permission-auto"))
      await subject.forwardEvent({
        payload: {
          type: "question.asked",
          properties: { id: "question-manual", sessionID: "session-dynamic-mode", questions: [] },
        },
      })
      // 同一运行回合切回 default 后，下一条权限必须立即恢复人工审批，不能沿用 loop 启动时快照。
      mode = "default"
      await subject.forwardEvent(permissionEvent("permission-default-after"))
    } finally {
      operations.permissionMode = originalPermissionMode
      operations.permissionReply = originalPermissionReply
    }

    expect(modeReads).toEqual(["session-dynamic-mode", "session-dynamic-mode", "session-dynamic-mode"])
    expect(replies).toEqual(["permission-auto"])
  })

  test("实时 session_list 顶层使用安全兼容目录而不随事件目录漂移", async () => {
    const subject = createGatewayHarness()
    const sent = attachAckingSocket(subject)
    subject.devices = [{ id: "connection-1", device_id: "mobile-1", name: "Phone", online: true }]
    subject.running = true
    subject.state = "connected"
    subject.validateAccount = async () => true
    subject.authoritativeBridgeEvent = async () => []
    const originalSnapshot = operations.snapshot
    const originalModelCatalog = operations.modelCatalog
    const catalogInputs: Array<{ directory?: string } | undefined> = []
    operations.snapshot = async () => ({ sessions: [], permissions: [], questions: [] })
    operations.modelCatalog = async (input) => {
      catalogInputs.push(input)
      return [
        {
          provider_id: "wanlaicode",
          model_id: "global-model",
          reasoning_efforts: ["high"],
          context_window: 200_000,
        },
      ]
    }

    try {
      await subject.forwardEvent({
        payload: {
          type: "session.updated",
          properties: { sessionID: "session-catalog", info: { id: "session-catalog" } },
        },
      })
    } finally {
      operations.snapshot = originalSnapshot
      operations.modelCatalog = originalModelCatalog
    }

    const sessionList = sent
      .map((envelope) => envelope.payload as Record<string, unknown>)
      .find(
        (payload) =>
          payload.type === "bridge.server_message" &&
          (payload.message as Record<string, unknown> | undefined)?.type === "session_list",
      )
    expect(catalogInputs).toEqual([undefined])
    expect(sessionList).toMatchObject({
      message: { codexModels: ["global-model"], codexModelReasoningEfforts: { "global-model": ["high"] } },
    })
  })

  test("慢 session_list 快照不能让同会话后续消息越过 session.updated", async () => {
    const subject = createGatewayHarness()
    const sent = attachAckingSocket(subject)
    subject.devices = [{ id: "connection-1", device_id: "mobile-1", name: "Phone", online: true }]
    subject.running = true
    subject.state = "connected"
    subject.validateAccount = async () => true
    subject.authoritativeBridgeEvent = async () => []
    const originalSnapshot = operations.snapshot
    const originalModelCatalog = operations.modelCatalog
    let releaseSnapshot: () => void = () => undefined
    let markSnapshotStarted: () => void = () => undefined
    const snapshotStarted = new Promise<void>((resolve) => (markSnapshotStarted = resolve))
    const snapshotDelay = new Promise<void>((resolve) => (releaseSnapshot = resolve))
    operations.snapshot = async () => {
      markSnapshotStarted()
      await snapshotDelay
      return { sessions: [], permissions: [], questions: [] }
    }
    operations.modelCatalog = async () => []

    try {
      const sessionUpdate = subject.enqueueForwardEvent({
        payload: {
          type: "session.updated",
          properties: { sessionID: "session-ordered", info: { id: "session-ordered" } },
        },
      })
      await snapshotStarted
      const messageUpdate = subject.enqueueForwardEvent({
        payload: {
          type: "message.updated",
          properties: {
            sessionID: "session-ordered",
            info: {
              id: "message-ordered",
              sessionID: "session-ordered",
              role: "assistant",
              parentID: "user-ordered",
            },
          },
        },
      })
      await Bun.sleep(0)
      const beforeRelease = sent
        .map((envelope) => envelope.payload as Record<string, unknown>)
        .filter((payload) => payload.type === "sync.event")
        .map((payload) => ((payload.event as Record<string, unknown>).payload as Record<string, unknown>).type)
      expect(beforeRelease).toEqual(["session.updated"])

      releaseSnapshot()
      await Promise.all([sessionUpdate, messageUpdate])
    } finally {
      releaseSnapshot()
      operations.snapshot = originalSnapshot
      operations.modelCatalog = originalModelCatalog
    }

    const eventTypes = sent
      .map((envelope) => envelope.payload as Record<string, unknown>)
      .filter((payload) => payload.type === "sync.event")
      .map((payload) => ((payload.event as Record<string, unknown>).payload as Record<string, unknown>).type)
    expect(eventTypes).toEqual(["session.updated", "message.updated"])
  })

  test("慢 list_sessions 响应不能在较新的实时 session_list 之后回退", async () => {
    const subject = createGatewayHarness()
    const sent = attachAckingSocket(subject)
    subject.devices = [{ id: "connection-1", device_id: "mobile-1", name: "Phone", online: true }]
    subject.running = true
    subject.state = "connected"
    subject.validateAccount = async () => true
    subject.authoritativeBridgeEvent = async () => []
    const originalSnapshot = operations.snapshot
    const originalModelCatalog = operations.modelCatalog
    let snapshotCalls = 0
    let releaseFirstSnapshot: () => void = () => undefined
    let markFirstSnapshotStarted: () => void = () => undefined
    const firstSnapshotStarted = new Promise<void>((resolve) => (markFirstSnapshotStarted = resolve))
    const firstSnapshotDelay = new Promise<void>((resolve) => (releaseFirstSnapshot = resolve))
    const remoteSession = (id: string, title: string, updatedAt: number) => ({
      id,
      directory: `/tmp/${id}`,
      title,
      status: "idle" as const,
      created_at: 1,
      updated_at: updatedAt,
      model_catalog: [],
      permission_mode: "default" as const,
    })
    operations.snapshot = async () => {
      snapshotCalls += 1
      if (snapshotCalls === 1) {
        markFirstSnapshotStarted()
        await firstSnapshotDelay
        return { sessions: [remoteSession("session-old", "Old snapshot", 1)], permissions: [], questions: [] }
      }
      return { sessions: [remoteSession("session-new", "New snapshot", 2)], permissions: [], questions: [] }
    }
    operations.modelCatalog = async () => []

    try {
      const requested = subject.handleRelay({
        type: "relay",
        source_device_id: "mobile-1",
        request_id: "slow-session-list",
        payload: { type: "bridge.client_message", message: { type: "list_sessions" } },
      })
      await firstSnapshotStarted
      const realtime = subject.enqueueForwardEvent({
        payload: { type: "session.updated", properties: { sessionID: "session-new", info: { id: "session-new" } } },
      })
      await Bun.sleep(0)
      expect(snapshotCalls).toBe(1)
      releaseFirstSnapshot()
      await Promise.all([requested, realtime])
    } finally {
      releaseFirstSnapshot()
      operations.snapshot = originalSnapshot
      operations.modelCatalog = originalModelCatalog
    }

    const sessionLists = sent
      .map((envelope) => envelope.payload as Record<string, unknown>)
      .filter(
        (payload) =>
          payload.type === "bridge.server_message" &&
          (payload.message as Record<string, unknown> | undefined)?.type === "session_list",
      )
      .map((payload) => payload.message as { sessions: Array<{ name: string }> })
    expect(sessionLists.map((message) => message.sessions[0]?.name)).toEqual(["Old snapshot", "New snapshot"])
  })

  test("慢旧列表先于较新的终态和审批事件发送", async () => {
    const subject = createGatewayHarness()
    const sent = attachAckingSocket(subject)
    subject.devices = [{ id: "connection-1", device_id: "mobile-1", name: "Phone", online: true }]
    subject.running = true
    subject.state = "connected"
    subject.validateAccount = async () => true
    subject.authoritativeBridgeEvent = async () => []
    const originalSnapshot = operations.snapshot
    const originalModelCatalog = operations.modelCatalog
    let releaseSnapshot: () => void = () => undefined
    let markSnapshotStarted: () => void = () => undefined
    const snapshotStarted = new Promise<void>((resolve) => (markSnapshotStarted = resolve))
    const snapshotDelay = new Promise<void>((resolve) => (releaseSnapshot = resolve))
    operations.snapshot = async () => {
      markSnapshotStarted()
      await snapshotDelay
      return {
        sessions: [
          {
            id: "session-order",
            directory: "/tmp/session-order",
            title: "Old running snapshot",
            status: "running" as const,
            created_at: 1,
            updated_at: 1,
            model_catalog: [],
            permission_mode: "default" as const,
          },
        ],
        permissions: [],
        questions: [],
      }
    }
    operations.modelCatalog = async () => []

    try {
      const requested = subject.handleRelay({
        type: "relay",
        source_device_id: "mobile-1",
        request_id: "slow-projection-list",
        payload: { type: "bridge.client_message", message: { type: "list_sessions" } },
      })
      await snapshotStarted
      const idle = subject.enqueueForwardEvent({
        payload: {
          type: "session.status",
          properties: { sessionID: "session-order", status: { type: "idle" } },
        },
      })
      const permission = subject.enqueueForwardEvent({
        payload: {
          type: "permission.asked",
          properties: { sessionID: "session-order", id: "permission-order", permission: "bash" },
        },
      })
      await Bun.sleep(0)
      // 快照未完成前，较新的 idle 和 Permission 都必须停在同一个列表屏障之后。
      expect(sent).toHaveLength(0)
      releaseSnapshot()
      await Promise.all([requested, idle, permission])
    } finally {
      releaseSnapshot()
      operations.snapshot = originalSnapshot
      operations.modelCatalog = originalModelCatalog
    }

    const projectionOrder = sent
      .map((envelope) => envelope.payload as Record<string, unknown>)
      .flatMap((payload) => {
        if (payload.type !== "bridge.server_message") return []
        const type = (payload.message as Record<string, unknown> | undefined)?.type
        return type === "session_list" || type === "status" || type === "permission_request" ? [type] : []
      })
    expect(projectionOrder).toEqual(["session_list", "status", "permission_request"])
  })

  test("不同会话的 session_list 快照跨会话串行发送且不会被慢旧快照回退", async () => {
    const subject = createGatewayHarness()
    const sent = attachAckingSocket(subject)
    subject.devices = [{ id: "connection-1", device_id: "mobile-1", name: "Phone", online: true }]
    subject.running = true
    subject.state = "connected"
    subject.validateAccount = async () => true
    subject.authoritativeBridgeEvent = async () => []
    const originalSnapshot = operations.snapshot
    const originalModelCatalog = operations.modelCatalog
    let snapshotCalls = 0
    let releaseFirstSnapshot: () => void = () => undefined
    let markFirstSnapshotStarted: () => void = () => undefined
    const firstSnapshotStarted = new Promise<void>((resolve) => (markFirstSnapshotStarted = resolve))
    const firstSnapshotDelay = new Promise<void>((resolve) => (releaseFirstSnapshot = resolve))
    const remoteSession = (id: string, title: string, updatedAt: number) => ({
      id,
      directory: `/tmp/${id}`,
      title,
      status: "idle" as const,
      created_at: 1,
      updated_at: updatedAt,
      model_catalog: [],
      permission_mode: "default" as const,
    })
    operations.snapshot = async () => {
      snapshotCalls += 1
      if (snapshotCalls === 1) {
        markFirstSnapshotStarted()
        // 第一份旧快照在读取后人为阻塞，第二个 session.updated 可用于复现原先的跨链反序。
        await firstSnapshotDelay
        return { sessions: [remoteSession("session-old", "Old snapshot", 1)], permissions: [], questions: [] }
      }
      return { sessions: [remoteSession("session-new", "New snapshot", 2)], permissions: [], questions: [] }
    }
    operations.modelCatalog = async () => []
    const event = (sessionID: string) => ({
      payload: { type: "session.updated", properties: { sessionID, info: { id: sessionID } } },
    })

    try {
      const first = subject.enqueueForwardEvent(event("session-old"))
      await firstSnapshotStarted
      const second = subject.enqueueForwardEvent(event("session-new"))
      await Promise.resolve()
      // 第二条事件必须停在共享 session_list 链上，不能提前捕获并发送较新的全局状态。
      expect(snapshotCalls).toBe(1)
      releaseFirstSnapshot()
      await Promise.all([first, second])
    } finally {
      releaseFirstSnapshot()
      operations.snapshot = originalSnapshot
      operations.modelCatalog = originalModelCatalog
    }

    const sessionLists = sent
      .map((envelope) => envelope.payload as Record<string, unknown>)
      .filter(
        (payload) =>
          payload.type === "bridge.server_message" &&
          (payload.message as Record<string, unknown> | undefined)?.type === "session_list",
      )
      .map((payload) => payload.message as { sessions: Array<{ name: string }> })
    expect(sessionLists.map((message) => message.sessions[0]?.name)).toEqual(["Old snapshot", "New snapshot"])
  })

  test("实时 delta、错误和审批沿用 assistant parentID 作为稳定 turnId", async () => {
    const subject = createGatewayHarness()
    const sent = attachAckingSocket(subject)
    subject.devices = [{ id: "connection-1", device_id: "mobile-1", name: "Phone", online: true }]
    subject.running = true
    subject.state = "connected"
    subject.validateAccount = async () => true
    // 本测试只验证实时路由缓存，权威历史映射由 protocol.test.ts 单独覆盖。
    subject.authoritativeBridgeEvent = async () => []

    await subject.forwardEvent({
      payload: {
        type: "message.updated",
        properties: {
          sessionID: "session-1",
          info: { id: "user-1", sessionID: "session-1", role: "user" },
        },
      },
    })
    await subject.forwardEvent({
      payload: {
        type: "message.updated",
        properties: {
          sessionID: "session-1",
          info: { id: "assistant-1", sessionID: "session-1", role: "assistant", parentID: "user-1" },
        },
      },
    })
    await subject.forwardEvent({
      payload: {
        type: "message.part.updated",
        properties: {
          sessionID: "session-1",
          part: {
            id: "reasoning-1",
            sessionID: "session-1",
            messageID: "assistant-1",
            type: "reasoning",
            text: "",
          },
        },
      },
    })
    await subject.forwardEvent({
      payload: {
        type: "message.part.delta",
        properties: {
          sessionID: "session-1",
          partID: "reasoning-1",
          field: "text",
          delta: "正在检查",
        },
      },
    })
    await subject.forwardEvent({
      payload: {
        type: "permission.asked",
        properties: {
          id: "permission-1",
          sessionID: "session-1",
          permission: "bash",
          patterns: [],
          metadata: {},
          tool: { messageID: "assistant-1", callID: "call-1" },
        },
      },
    })
    await subject.forwardEvent({
      payload: {
        type: "message.updated",
        properties: {
          sessionID: "session-1",
          info: { id: "user-2", sessionID: "session-1", role: "user" },
        },
      },
    })
    await subject.forwardEvent({
      payload: {
        type: "permission.replied",
        properties: {
          sessionID: "session-1",
          requestID: "permission-1",
          reply: "once",
        },
      },
    })
    await subject.forwardEvent({
      payload: {
        type: "session.error",
        properties: {
          sessionID: "session-1",
          error: { name: "ProviderError", message: "failed" },
        },
      },
    })
    await subject.forwardEvent({
      payload: {
        type: "session.status",
        properties: { sessionID: "session-1", status: { type: "idle" } },
      },
    })
    await subject.forwardEvent({
      payload: {
        type: "session.error",
        properties: {
          sessionID: "session-1",
          error: { name: "NextTurnError", message: "before assistant" },
        },
      },
    })

    const bridgeMessages = sent
      .map((envelope) => envelope.payload as Record<string, unknown>)
      .filter((payload) => payload.type === "bridge.server_message")
      .map((payload) => payload.message as Record<string, unknown>)
    expect(bridgeMessages.find((message) => message.type === "thinking_delta")).toMatchObject({
      text: "正在检查",
      turnId: "user-1",
    })
    expect(bridgeMessages.find((message) => message.type === "permission_request")).toMatchObject({
      toolUseId: "permission-1",
      turnId: "user-1",
    })
    expect(bridgeMessages.find((message) => message.type === "permission_resolved")).toMatchObject({
      toolUseId: "permission-1",
      turnId: "user-1",
    })
    expect(bridgeMessages.find((message) => message.type === "error")).toMatchObject({
      errorCode: "ProviderError",
      turnId: "user-1",
    })
    const errors = bridgeMessages.filter((message) => message.type === "error")
    expect(errors).toHaveLength(2)
    expect(errors[1]).toMatchObject({ errorCode: "NextTurnError" })
    expect(errors[1]).not.toHaveProperty("turnId")
  })
})
