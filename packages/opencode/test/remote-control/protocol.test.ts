import { describe, expect, test } from "bun:test"
import crypto from "node:crypto"
import type { MessageV2 } from "@/session/message-v2"
import { MessageID } from "@/session/schema"
import { WanlaiCodeAuth } from "@/provider/wanlaicode"
import {
  ProtocolError,
  bridgeEvent,
  bridgeHistory,
  bridgeMessages,
  bridgeToolUpdate,
  dispatchRemotePayload,
  remoteAttachmentInputs,
  remoteImageParts,
  remoteInputAttachments,
  streamRemoteHistoryPayload,
  type RemoteOperations,
  type RemoteSession,
  bridgeHistoryImageBudgetBytes,
} from "@/remote-control/protocol"
import {
  applyPresenceEvent,
  authoritativeBridgeEventReady,
  mobileNetworkHost,
  mobilePairingApi,
  mobilePairingDeepLink,
  prunePresenceSessions,
  relayAllowed as gatewayRelayAllowed,
  relayErrorPayload,
  relayRequestKey,
  remoteSocketCloseAction,
  remoteAuthRequired,
  remoteControlApiEndpoint,
  remoteControlAvailable,
  remoteRegistrationDecision,
  relayEnvelopes,
  relayFragmentMaxAssembledBytes,
  rotatedRemoteDeviceID,
  type RemoteControlConnection,
} from "@/remote-control/gateway"

const session: RemoteSession = {
  id: "ses_mobile",
  directory: "/tmp/project",
  title: "Mobile session",
  status: "idle",
  created_at: 1,
  updated_at: 2,
  model: { provider_id: "wanlaicode", model_id: "model", variant: "high", context_window: 200_000 },
  // 会话目录故意比顶层兼容目录多一个模型，用于验证协议不会混用两个选择范围。
  model_catalog: [
    { provider_id: "wanlaicode", model_id: "model", reasoning_efforts: ["low", "high"], context_window: 200_000 },
    {
      provider_id: "wanlaicode",
      model_id: "session-only-model",
      reasoning_efforts: ["medium"],
      context_window: 100_000,
    },
  ],
  permission_mode: "default",
}

const history = {
  info: {
    id: "msg_assistant",
    sessionID: session.id,
    role: "assistant",
    time: { created: 2, completed: 3 },
    parentID: "msg_user",
    modelID: "model",
    providerID: "wanlaicode",
    mode: "build",
    path: { cwd: "/tmp/project", root: "/tmp/project" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    finish: "stop",
  },
  parts: [
    { id: "prt_text", sessionID: session.id, messageID: "msg_assistant", type: "text", text: "done" },
    {
      id: "prt_reason",
      sessionID: session.id,
      messageID: "msg_assistant",
      type: "reasoning",
      text: "thinking",
      originalText: "original thinking",
      metadata: { provider: "wanlaicode" },
      time: { start: 2, end: 3 },
    },
    {
      id: "prt_tool",
      sessionID: session.id,
      messageID: "msg_assistant",
      type: "tool",
      callID: "call_1",
      tool: "bash",
      state: {
        status: "completed",
        input: { command: "pwd" },
        output: "/tmp/project",
        title: "pwd",
        metadata: { exit: 0 },
        time: { start: 2, end: 3 },
        attachments: [
          {
            id: "prt_tool_file",
            sessionID: session.id,
            messageID: "msg_assistant",
            type: "file",
            mime: "image/png",
            filename: "tool.png",
            url: "data:image/png;base64,AA==",
          },
        ],
      },
    },
    {
      id: "prt_file",
      sessionID: session.id,
      messageID: "msg_assistant",
      type: "file",
      mime: "text/plain",
      filename: "a.txt",
      url: "file:///a.txt",
    },
    { id: "prt_step", sessionID: session.id, messageID: "msg_assistant", type: "step-start", snapshot: "snapshot" },
  ],
} as unknown as MessageV2.WithParts

// 测试图片只保留协议所需的文件头；远控层负责 MIME 魔数和大小校验，不承担完整图片解码。
function imageBase64(mime: "image/png" | "image/jpeg" | "image/gif" | "image/webp", size?: number) {
  const magic = {
    "image/png": [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    "image/jpeg": [0xff, 0xd8, 0xff],
    "image/gif": [0x47, 0x49, 0x46, 0x38],
    "image/webp": [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50],
  }[mime]
  const bytes = Buffer.alloc(Math.max(size ?? magic.length, magic.length))
  bytes.set(magic)
  return bytes.toString("base64")
}

function attachmentPayload(filename: string, mimeType: string, bytes: Buffer, extra: Record<string, unknown> = {}) {
  return {
    filename,
    mimeType,
    sizeBytes: bytes.length,
    base64: bytes.toString("base64"),
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    ...extra,
  }
}

// 历史分块测试复用真实 MessageV2 用户图片形状，保证覆盖 data URL 筛选、大小校验和 Bridge 序号生成。
function userImageMessage(id: string, encoded: string): MessageV2.WithParts {
  return {
    info: {
      id,
      sessionID: session.id,
      role: "user",
      time: { created: 4 },
      agent: "build",
      model: { providerID: "wanlaicode", modelID: "model" },
    },
    parts: [
      { id: `${id}_text`, sessionID: session.id, messageID: id, type: "text", text: `image ${id}` },
      {
        id: `${id}_image`,
        sessionID: session.id,
        messageID: id,
        type: "file",
        mime: "image/png",
        filename: `${id}.png`,
        url: `data:image/png;base64,${encoded}`,
      },
    ],
  } as unknown as MessageV2.WithParts
}

// assistant file 与 tool attachment 使用相同 data URL 形状，便于验证统一预算不会只覆盖用户图片。
function assistantAttachmentMessage(id: string, bytes: number, kind: "file" | "tool"): MessageV2.WithParts {
  const url = `data:image/png;base64,${Buffer.alloc(bytes, 1).toString("base64")}`
  const attachment = {
    id: `${id}_attachment`,
    sessionID: session.id,
    messageID: id,
    type: "file" as const,
    mime: "image/png",
    filename: `${id}.png`,
    url,
  }
  return {
    info: {
      id,
      sessionID: session.id,
      role: "assistant",
      time: { created: 4, completed: 5 },
      parentID: `user_${id}`,
      modelID: "model",
      providerID: "wanlaicode",
      mode: "build",
      path: { cwd: session.directory, root: session.directory },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      finish: "stop",
    },
    parts:
      kind === "file"
        ? [attachment]
        : [
            {
              id: `${id}_tool`,
              sessionID: session.id,
              messageID: id,
              type: "tool",
              callID: `${id}_call`,
              tool: "image_generation",
              state: {
                status: "completed",
                input: {},
                output: "done",
                title: "Generate image",
                time: { start: 4, end: 5 },
                attachments: [attachment],
              },
            },
          ],
  } as unknown as MessageV2.WithParts
}

type HistoryPageInput = Parameters<RemoteOperations["historyPage"]>[0]

function historyMessageKey(message: MessageV2.WithParts) {
  return { id: message.info.id, time: message.info.time.created }
}

function encodeHistoryKey(key: ReturnType<typeof historyMessageKey>) {
  return Buffer.from(JSON.stringify(key), "utf8").toString("base64url")
}

function decodeHistoryKey(value: string) {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as ReturnType<typeof historyMessageKey>
}

function compareHistoryKey(left: ReturnType<typeof historyMessageKey>, right: ReturnType<typeof historyMessageKey>) {
  return left.time - right.time || left.id.localeCompare(right.id)
}

// 测试 fake 复刻生产 keyset/high-water 语义，使并发增删测试不会退回不稳定 offset。
function historyPageFromMessages(messages: readonly MessageV2.WithParts[], input: HistoryPageInput) {
  const sorted = [...messages].sort((left, right) =>
    compareHistoryKey(historyMessageKey(left), historyMessageKey(right)),
  )
  const capturedHighWater = input.high_water === undefined ? sorted.at(-1) : undefined
  const highWater =
    input.high_water === undefined
      ? capturedHighWater
        ? encodeHistoryKey(historyMessageKey(capturedHighWater))
        : null
      : input.high_water
  if (highWater === null) return { session_id: input.session_id, items: [], high_water: null }
  const highWaterKey = decodeHistoryKey(highWater)
  const cursorKey = input.cursor ? decodeHistoryKey(input.cursor) : undefined
  const bounded = sorted.filter((message) => {
    const key = historyMessageKey(message)
    if (compareHistoryKey(key, highWaterKey) > 0) return false
    if (!cursorKey) return true
    return input.direction === "backward"
      ? compareHistoryKey(key, cursorKey) < 0
      : compareHistoryKey(key, cursorKey) > 0
  })
  if (input.direction === "backward") bounded.reverse()
  const limit = input.limit ?? 1
  const page = bounded.slice(0, limit)
  const more = bounded.length > page.length
  return {
    session_id: input.session_id,
    items: page.map((message) => ({
      type: "message" as const,
      message,
      bytes: Buffer.byteLength(JSON.stringify(message), "utf8"),
    })),
    high_water: highWater,
    ...(more && page.length > 0 ? { next_cursor: encodeHistoryKey(historyMessageKey(page.at(-1)!)) } : {}),
  }
}

function fakeOperations() {
  const calls: Array<{ type: string; value: unknown }> = []
  const operations: RemoteOperations = {
    listSessions: async () => [session],
    // 协议 fake 也提供权威模型与权限入口，测试返回值必须和生产 RemoteOperations 保持同形。
    modelCatalog: async () => [
      {
        provider_id: "wanlaicode",
        model_id: "model",
        reasoning_efforts: ["low", "high"],
        context_window: 200_000,
      },
    ],
    // 空白项目 fake 保留完整调用参数，协议测试不接触测试机真实 Documents。
    blankProjectDefaults: async (input) => {
      calls.push({ type: "blankProjectDefaults", value: input })
      return { parent: input.parent ?? "/Users/developer/Documents", name: "New project 2" }
    },
    blankProjectExists: async (input) => {
      calls.push({ type: "blankProjectExists", value: input })
      return { ...input, path: `${input.parent}/${input.name}`, exists: false }
    },
    blankProjectCreate: async (input) => {
      calls.push({ type: "blankProjectCreate", value: input })
      return { ...input, path: `${input.parent}/${input.name}` }
    },
    history: async () => ({ session_id: session.id, messages: [history] }),
    historyPage: async (input) => historyPageFromMessages([history], input),
    send: async (input) => {
      calls.push({ type: "send", value: input })
      return { message_id: "msg_user" }
    },
    getAttachment: async (input) => {
      calls.push({ type: "getAttachment", value: input })
      return {
        attachment_id: input.attachment_id,
        filename: "notes.txt",
        mime_type: "text/plain",
        size_bytes: 5,
        base64: Buffer.from("notes").toString("base64"),
        sha256: "ab".repeat(32),
      }
    },
    create: async (input) => {
      calls.push({ type: "create", value: input })
      return session
    },
    resume: async (input) => {
      calls.push({ type: "resume", value: input })
      // fake 直接投影提交后的会话，让契约测试能确认 session_created 没有回显更新前的缓存。
      const variant = input.variant === undefined ? session.model?.variant : input.variant
      return {
        ...session,
        model: input.model_id
          ? {
              provider_id: "wanlaicode",
              model_id: input.model_id,
              ...(typeof variant === "string" ? { variant } : {}),
              context_window: 200_000,
            }
          : session.model,
        permission_mode: input.permission_mode ?? session.permission_mode,
      }
    },
    abort: async (input) => void calls.push({ type: "abort", value: input }),
    setModel: async (input) => {
      calls.push({ type: "setModel", value: input })
      return {
        model: {
          provider_id: "wanlaicode",
          model_id: input.model_id,
          ...(typeof input.variant === "string" ? { variant: input.variant } : {}),
          context_window: 200_000,
        },
        previous_model: session.model,
      }
    },
    setPermissionMode: async (input) => {
      calls.push({ type: "setPermissionMode", value: input })
      return { mode: input.mode }
    },
    permissionMode: async () => session.permission_mode,
    permissionReply: async (input) => void calls.push({ type: "permission", value: input }),
    reject: async (input) => void calls.push({ type: "reject", value: input }),
    questionReply: async (input) => void calls.push({ type: "question", value: input }),
    questionReject: async (input) => void calls.push({ type: "question.reject", value: input }),
    snapshot: async () => ({ sessions: [session], permissions: [], questions: [] }),
  }
  return { calls, operations }
}

// 历史测试统一走 Gateway 使用的 async iterable，防止回归到一次性聚合所有分页的旧入口。
async function collectHistory(payload: unknown, operations: RemoteOperations) {
  const stream = streamRemoteHistoryPayload(payload, operations)
  if (!stream) throw new Error("缺少历史流")
  const result: Record<string, unknown>[] = []
  for await (const item of stream) result.push(item)
  return result
}

describe("remote-control wanlai protocol", () => {
  // 本地桌面只连 127.0.0.1，但二维码必须转换为手机可访问的 Bonjour API。
  test("pairing QR 把回环 API 转为本地网络地址并允许显式覆盖", () => {
    expect(
      mobilePairingApi("http://127.0.0.1:8080/api/v1/remote-control", {
        localHost: "jiaohongendeMacBook-Pro-70.local",
      }),
    ).toBe("http://jiaohongendemacbook-pro-70.local:8080/api/v1")
    expect(
      mobilePairingApi("https://api.example.com/api/v1/remote-control", {
        override: "http://192.168.31.13:8080/api/v1/",
      }),
    ).toBe("http://192.168.31.13:8080/api/v1")
    expect(
      remoteControlApiEndpoint({
        brandEndpoint: "https://api.wanlai.ai/api/v1/remote-control",
        local: true,
      }),
    ).toBe("http://127.0.0.1:8080/api/v1/remote-control")
    expect(
      mobilePairingApi("http://0.0.0.0:8080/api/v1/remote-control", {
        localHost: "192.168.31.13",
      }),
    ).toBe("http://192.168.31.13:8080/api/v1")
    expect(() =>
      mobilePairingApi("http://127.0.0.1:8080/api/v1/remote-control", {
        override: "http://0.0.0.0:8080/api/v1",
      }),
    ).toThrow("reachable LAN")
  })

  test("pairing QR 使用 wanlai 协议并只携带完整配对参数", () => {
    // 二维码参数含 URL 和一次性密钥，必须逐项断言，防止品牌切换时遗漏或意外泄漏额外字段。
    const link = new URL(
      mobilePairingDeepLink({
        api: "https://api.wanlai.ai/api/v1",
        pairingID: "pair_0123456789",
        secret: "secret_0123456789",
      }),
    )
    expect(link.protocol).toBe("wanlai:")
    expect(link.host).toBe("pair")
    expect(Object.fromEntries(link.searchParams)).toEqual({
      api: "https://api.wanlai.ai/api/v1",
      pairing_id: "pair_0123456789",
      secret: "secret_0123456789",
    })
    expect([...link.searchParams.keys()]).toHaveLength(3)
  })

  test("跨平台二维码主机只选择真实 Bonjour 名或局域网地址", () => {
    expect(
      mobileNetworkHost({
        platform: "darwin",
        bonjour: "Wanlai-Mac.local",
        hostname: "Wanlai-Mac",
        addresses: ["192.168.31.13"],
      }),
    ).toBe("Wanlai-Mac.local")
    expect(
      mobileNetworkHost({
        platform: "win32",
        hostname: "DESKTOP-ABC",
        addresses: ["203.0.113.8", "10.0.0.25"],
      }),
    ).toBe("10.0.0.25")
    expect(mobileNetworkHost({ platform: "linux", hostname: "build-host", addresses: [] })).toBeUndefined()
  })

  // 同设备多条 WS 的 presence 必须聚合，并在收不到 offline 时依靠 TTL 回收。
  test("presence session 聚合旧连接离线并清理过期租约", () => {
    const state = new Map<string, Map<string, number>>()
    expect(
      applyPresenceEvent(state, { deviceID: "phone", presence: "online", sessionID: "old", ttlSeconds: 75 }, 1_000),
    ).toBe(true)
    expect(
      applyPresenceEvent(state, { deviceID: "phone", presence: "online", sessionID: "new", ttlSeconds: 75 }, 2_000),
    ).toBe(true)
    expect(applyPresenceEvent(state, { deviceID: "phone", presence: "offline", sessionID: "old" }, 3_000)).toBe(true)
    expect(prunePresenceSessions(state, 76_999)).toEqual([])
    expect(prunePresenceSessions(state, 77_000)).toEqual(["phone"])
  })

  // 关闭帧决定是否刷新、停连或退避，避免撤权后继续用旧 JWT 无限重连。
  test("WebSocket close reason 映射稳定恢复动作", () => {
    expect(remoteSocketCloseAction(1008, "REMOTE_CONTROL_AUTH_REVOKED")).toBe("auth_required")
    expect(remoteSocketCloseAction(1008, "TOKEN_EXPIRED")).toBe("refresh_token")
    expect(remoteSocketCloseAction(1013, "REMOTE_CONTROL_SUBSCRIPTION_OVERFLOW")).toBe("reconnect")
    expect(remoteSocketCloseAction(1008, "UNKNOWN_POLICY")).toBe("stop")
  })

  test("仅桌面宿主启用远控且刷新凭证失效后要求重新登录", () => {
    expect(remoteControlAvailable(undefined, "desktop")).toBe(true)
    expect(remoteControlAvailable("wrk_remote", "desktop")).toBe(false)
    expect(remoteControlAvailable(undefined, "cli")).toBe(false)
    expect(remoteControlAvailable(undefined, undefined)).toBe(false)
    expect(remoteAuthRequired(new WanlaiCodeAuth.OAuthExpiredError("expired"))).toBe(true)
    expect(remoteAuthRequired(new Error("temporary network error"))).toBe(false)
  })

  // 轮换只改变远控设备 ID，相同输入可确定性验证且不暴露原机器 ID。
  test("无效设备凭证使用远控专用身份轮换", () => {
    const first = rotatedRemoteDeviceID("machine-id", "nonce-a")
    expect(first).toBe(rotatedRemoteDeviceID("machine-id", "nonce-a"))
    expect(first).not.toBe(rotatedRemoteDeviceID("machine-id", "nonce-b"))
    expect(first).not.toContain("machine-id")
  })

  // 恢复 ID 已经落盘后若服务端不再补发 token，必须停在同一 ID 等待人工恢复，不能继续随机轮换。
  test("设备注册恢复在响应丢失后阻止无界身份轮换", () => {
    expect(
      remoteRegistrationDecision({
        existingToken: "saved-token",
        pending: false,
        created: false,
      }),
    ).toEqual({ type: "ready", token: "saved-token" })
    expect(
      remoteRegistrationDecision({
        issuedToken: "new-token",
        pending: true,
        created: true,
      }),
    ).toEqual({ type: "ready", token: "new-token" })
    expect(remoteRegistrationDecision({ pending: false, created: false })).toEqual({ type: "rotate" })
    expect(remoteRegistrationDecision({ pending: true, created: false })).toEqual({ type: "blocked" })
    expect(remoteRegistrationDecision({ pending: true, created: true })).toEqual({ type: "invalid" })
  })

  test("client_capabilities 收到桌面在线握手", async () => {
    const result = await dispatchRemotePayload(
      { type: "bridge.client_message", message: { type: "client_capabilities", protocolVersion: 1 } },
      fakeOperations().operations,
    )
    expect(result[0]).toMatchObject({
      type: "bridge.server_message",
      message: {
        type: "system",
        subtype: "remote_ready",
        provider: "claude",
        protocolVersion: 1,
        capabilities: [
          "session_sync",
          "permission_sync",
          "question_sync",
          "image_input",
          "file_input_v1",
          "permission_mode",
          "model_selection",
        ],
      },
    })
  })

  test("空白项目 Bridge RPC 返回桌面默认值、存在检查和创建路径", async () => {
    const fake = fakeOperations()
    const defaults = await dispatchRemotePayload(
      { type: "bridge.client_message", message: { type: "get_blank_project_defaults", requestId: "blank-1" } },
      fake.operations,
    )
    const exists = await dispatchRemotePayload(
      {
        type: "bridge.client_message",
        message: {
          type: "check_blank_project_exists",
          requestId: "blank-2",
          parent: "/Users/developer/Documents",
          name: "New project 2",
        },
      },
      fake.operations,
    )
    const created = await dispatchRemotePayload(
      {
        type: "bridge.client_message",
        message: {
          type: "create_blank_project",
          requestId: "blank-3",
          parent: "/Users/developer/Documents",
          name: "New project 2",
        },
      },
      fake.operations,
    )

    expect(defaults).toMatchObject([
      {
        type: "bridge.server_message",
        message: {
          type: "blank_project_result",
          requestId: "blank-1",
          action: "defaults",
          success: true,
          parent: "/Users/developer/Documents",
          name: "New project 2",
        },
      },
    ])
    expect(exists).toMatchObject([
      {
        message: {
          type: "blank_project_result",
          requestId: "blank-2",
          action: "exists",
          success: true,
          path: "/Users/developer/Documents/New project 2",
          exists: false,
        },
      },
    ])
    expect(created).toMatchObject([
      {
        message: {
          type: "blank_project_result",
          requestId: "blank-3",
          action: "create",
          success: true,
          path: "/Users/developer/Documents/New project 2",
        },
      },
    ])
    expect(fake.calls.slice(0, 3).map((call) => call.type)).toEqual([
      "blankProjectDefaults",
      "blankProjectExists",
      "blankProjectCreate",
    ])
  })

  test("空白项目失败通过同一 requestId 返回稳定错误码", async () => {
    const fake = fakeOperations()
    fake.operations.blankProjectCreate = async () => {
      throw new ProtocolError("project_exists", "Directory already exists")
    }
    const result = await dispatchRemotePayload(
      {
        type: "bridge.client_message",
        message: {
          type: "create_blank_project",
          requestId: "blank-conflict",
          parent: "/Users/developer/Documents",
          name: "Taken",
        },
      },
      fake.operations,
    )
    expect(result).toMatchObject([
      {
        message: {
          type: "blank_project_result",
          requestId: "blank-conflict",
          action: "create",
          success: false,
          errorCode: "project_exists",
        },
      },
    ])
  })

  test("get_attachment 保留请求标识并把成功或鉴权失败都收束为 attachment_content", async () => {
    const fake = fakeOperations()
    const success = await dispatchRemotePayload(
      {
        type: "bridge.client_message",
        message: {
          type: "get_attachment",
          sessionId: session.id,
          attachmentId: "prt_mobile_file",
          requestId: "attachment-request-1",
        },
      },
      fake.operations,
    )
    expect(fake.calls).toEqual([
      {
        type: "getAttachment",
        value: { session_id: session.id, attachment_id: "prt_mobile_file" },
      },
    ])
    expect(success).toMatchObject([
      {
        type: "bridge.server_message",
        message: {
          type: "attachment_content",
          sessionId: session.id,
          attachmentId: "prt_mobile_file",
          requestId: "attachment-request-1",
          filename: "notes.txt",
          mimeType: "text/plain",
          sizeBytes: 5,
          base64: Buffer.from("notes").toString("base64"),
        },
      },
    ])

    const forbidden = await dispatchRemotePayload(
      {
        type: "bridge.client_message",
        message: {
          type: "get_attachment",
          sessionId: session.id,
          attachmentId: "prt_other_session",
          requestId: "attachment-request-2",
        },
      },
      {
        ...fakeOperations().operations,
        getAttachment: async () => {
          throw new ProtocolError("attachment_forbidden", "Attachment does not belong to this session")
        },
      },
    )
    expect(forbidden).toMatchObject([
      {
        type: "bridge.server_message",
        message: {
          type: "attachment_content",
          attachmentId: "prt_other_session",
          requestId: "attachment-request-2",
          errorCode: "attachment_forbidden",
          error: "Attachment does not belong to this session",
        },
      },
    ])
  })

  test("未批准或已移除设备不能 relay", () => {
    const connections: RemoteControlConnection[] = [
      { id: "conn_1", device_id: "mobile_1", name: "Phone", online: true },
    ]
    expect(gatewayRelayAllowed("mobile_1", connections)).toBe(true)
    expect(gatewayRelayAllowed("mobile_2", connections)).toBe(false)
    expect(gatewayRelayAllowed("mobile_1", [])).toBe(false)
  })

  test("会话列表固定使用 claude UI 标记并保留原 sessionID", async () => {
    const fake = fakeOperations()
    let catalogInput: { directory?: string } | undefined
    const originalModelCatalog = fake.operations.modelCatalog
    fake.operations.modelCatalog = async (input) => {
      catalogInput = input
      return originalModelCatalog(input)
    }
    const result = await dispatchRemotePayload(
      { type: "bridge.client_message", message: { type: "list_sessions", projectPath: session.directory } },
      fake.operations,
    )
    expect(result[0]?.type).toBe("bridge.server_message")
    if (!result[0] || !("message" in result[0])) throw new Error("缺少 bridge.server_message")
    expect(result[0].message).toMatchObject({
      type: "session_list",
      capabilities: ["start_request_idempotency", "file_input_v1"],
      codexModels: ["model"],
      codexModelReasoningEfforts: { model: ["low", "high"] },
      codexModelContextWindows: { model: 200_000 },
      sessions: [
        {
          id: session.id,
          claudeSessionId: session.id,
          provider: "claude",
          permissionMode: "acceptEdits",
          // 字段存在且为空用于区分新协议权威快照与旧版 pendingPermission 单指针。
          pendingRequests: [],
          codexModels: ["model", "session-only-model"],
          codexModelReasoningEfforts: { model: ["low", "high"], "session-only-model": ["medium"] },
          codexModelContextWindows: { model: 200_000, "session-only-model": 100_000 },
          codexSettings: {
            model: "model",
            modelReasoningEffort: "high",
            modelContextWindow: 200_000,
            codexPermissionsMode: "default",
          },
        },
      ],
    })
    expect(catalogInput).toEqual({ directory: session.directory })
  })

  test("历史映射完整保留回合、reasoning、file、tool 和 result 权威字段", async () => {
    const result = await collectHistory(
      { type: "bridge.client_message", message: { type: "get_history", sessionId: session.id } },
      fakeOperations().operations,
    )
    if (!result[0] || !("message" in result[0])) throw new Error("缺少 history bridge.server_message")
    const snapshot = result[0].message as Record<string, unknown>
    expect(snapshot.type).toBe("history_snapshot")
    const entries = snapshot.messages as Array<{ seq: number; message: Record<string, unknown> }>
    const assistant = entries.find((entry) => entry.message.type === "assistant")?.message
    const toolResult = entries.find((entry) => entry.message.type === "tool_result")?.message
    const terminal = entries.find((entry) => entry.message.type === "result")?.message
    const content = (assistant?.message as { content: Array<Record<string, unknown>> }).content
    expect(assistant).toMatchObject({ turnId: "msg_user", sessionId: session.id })
    expect(content).toContainEqual({
      type: "reasoning",
      id: "prt_reason",
      text: "thinking",
      originalText: "original thinking",
      metadata: { provider: "wanlaicode" },
      time: { start: 2, end: 3 },
    })
    expect(content).toContainEqual({
      type: "file",
      id: "prt_file",
      url: "file:///a.txt",
      mimeType: "text/plain",
      filename: "a.txt",
    })
    expect(content).toContainEqual(
      expect.objectContaining({
        type: "tool_use",
        id: "call_1",
        name: "bash",
        status: "completed",
        title: "pwd",
        input: { command: "pwd" },
        output: "/tmp/project",
        metadata: { exit: 0 },
        attachments: [expect.objectContaining({ type: "file", filename: "tool.png", mimeType: "image/png" })],
        time: { start: 2, end: 3 },
        start: 2,
        end: 3,
        isError: false,
      }),
    )
    expect(toolResult).toMatchObject({
      turnId: "msg_user",
      toolUseId: "call_1",
      toolName: "bash",
      status: "completed",
      title: "pwd",
      input: { command: "pwd" },
      output: "/tmp/project",
      metadata: { exit: 0 },
      time: { start: 2, end: 3 },
      start: 2,
      end: 3,
      isError: false,
    })
    expect(terminal).toMatchObject({
      type: "result",
      turnId: "msg_user",
      cost: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      duration: 1,
      turnStartedAt: "1970-01-01T00:00:00.002Z",
      turnCompletedAt: "1970-01-01T00:00:00.003Z",
      stopReason: "stop",
    })
  })

  test("实时权威工具错误保留错误状态、附件和回合归属", () => {
    const failed = {
      ...history,
      info: {
        ...history.info,
        id: "msg_assistant_failed",
        parentID: "msg_user_failed",
        time: { created: 10, completed: 20 },
        error: { name: "UnknownError", data: { message: "turn failed" } },
      },
      parts: [
        {
          id: "prt_tool_failed",
          sessionID: session.id,
          messageID: "msg_assistant_failed",
          type: "tool",
          callID: "call_failed",
          tool: "image_generation",
          metadata: { provider: "wanlaicode", shared: "part" },
          state: {
            status: "error",
            input: { prompt: "WanlaiCode" },
            error: "generation failed",
            title: "Generate image",
            metadata: { retryable: false, shared: "state" },
            time: { start: 11, end: 19 },
            attachments: [
              {
                id: "prt_partial_image",
                sessionID: session.id,
                messageID: "msg_assistant_failed",
                type: "file",
                mime: "image/png",
                filename: "partial.png",
                url: "data:image/png;base64,AA==",
              },
            ],
          },
        },
      ],
    } as unknown as MessageV2.WithParts

    const messages = bridgeMessages(failed)
    expect(messages.find((message) => message.type === "assistant")).toMatchObject({
      turnId: "msg_user_failed",
      message: {
        content: [
          {
            type: "tool_use",
            id: "call_failed",
            status: "error",
            error: "generation failed",
            metadata: { provider: "wanlaicode", retryable: false, shared: "state" },
            partMetadata: { provider: "wanlaicode", shared: "part" },
            time: { start: 11, end: 19 },
            isError: true,
          },
        ],
      },
    })
    expect(messages.find((message) => message.type === "tool_result")).toMatchObject({
      turnId: "msg_user_failed",
      toolUseId: "call_failed",
      status: "error",
      title: "Generate image",
      input: { prompt: "WanlaiCode" },
      error: "generation failed",
      content: "generation failed",
      metadata: { provider: "wanlaicode", retryable: false, shared: "state" },
      partMetadata: { provider: "wanlaicode", shared: "part" },
      attachments: [expect.objectContaining({ filename: "partial.png", mimeType: "image/png" })],
      start: 11,
      end: 19,
      isError: true,
    })
    expect(messages.find((message) => message.type === "result")).toMatchObject({
      turnId: "msg_user_failed",
      subtype: "error",
      duration: 10,
      turnStartedAt: "1970-01-01T00:00:00.010Z",
      turnCompletedAt: "1970-01-01T00:00:00.020Z",
    })
  })

  test("实时 pending/running 工具发送完整 assistant 快照并保留并发工具", () => {
    const running = {
      ...history,
      info: { ...history.info, id: "msg_assistant_running", time: { created: 10 } },
      parts: [
        {
          id: "prt_tool_pending",
          sessionID: session.id,
          messageID: "msg_assistant_running",
          type: "tool",
          callID: "call_pending",
          tool: "bash",
          state: { status: "pending", input: { command: "pwd" }, raw: "" },
        },
        {
          id: "prt_tool_running",
          sessionID: session.id,
          messageID: "msg_assistant_running",
          type: "tool",
          callID: "call_running",
          tool: "read",
          state: { status: "running", input: { filePath: "a.txt" }, title: "Read a.txt", time: { start: 11 } },
        },
      ],
    } as unknown as MessageV2.WithParts

    const update = bridgeToolUpdate(running, "call_pending")
    const content = ((update[0]?.message as Record<string, unknown>).content ?? []) as Array<Record<string, unknown>>
    expect(content).toMatchObject([
      { type: "tool_use", id: "call_pending", status: "pending" },
      { type: "tool_use", id: "call_running", status: "running" },
    ])
    expect(update.some((message) => message.type === "tool_result")).toBe(false)
    expect(
      authoritativeBridgeEventReady("message.part.updated", {
        part: { type: "tool", state: { status: "pending" } },
      }),
    ).toBe(true)
    expect(
      authoritativeBridgeEventReady("message.part.updated", {
        part: { type: "tool", state: { status: "running" } },
      }),
    ).toBe(true)
  })

  test("超过 500 条原生消息仍返回完整权威 snapshot，并按展开后的 Bridge 条目编号", async () => {
    const messages = Array.from({ length: 501 }, (_, index) => ({
      ...history,
      info: { ...history.info, id: `msg_assistant_${index}` },
      parts: history.parts.map((part) => ({ ...part, id: `${part.id}_${index}`, messageID: `msg_assistant_${index}` })),
    })) as unknown as MessageV2.WithParts[]
    const pages = { forward: 0, backward: 0 }
    const fake = fakeOperations()
    const operations: RemoteOperations = {
      ...fake.operations,
      historyPage: async (input) => {
        pages[input.direction] += 1
        return historyPageFromMessages(messages, input)
      },
    }
    const result = await collectHistory(
      { type: "bridge.client_message", message: { type: "get_history_delta", sessionId: session.id, sinceSeq: 999 } },
      operations,
    )
    const chunks = result.map((item) => item.message as Record<string, unknown>)
    const entries = chunks.flatMap((chunk) => chunk.messages as Array<{ seq: number }>)
    expect(chunks[0]).toMatchObject({ type: "history_snapshot", fromSeq: 0 })
    expect(chunks.slice(1).every((chunk) => chunk.type === "history_delta")).toBe(true)
    expect(entries).toHaveLength(1_503)
    expect(entries.map((entry) => entry.seq)).toEqual(Array.from({ length: 1_503 }, (_, index) => index + 1))
    expect(chunks.at(-1)).toMatchObject({ toSeq: 1_503, status: "idle" })
    expect(pages).toEqual({ forward: 501, backward: 501 })
  })

  test("多页文本总响应超过 64MiB 时仍按单个有界块逐步产出", async () => {
    const pageCount = 6
    const textBytes = 12 * 1024 * 1024
    const messageAt = (index: number) =>
      ({
        info: {
          id: `msg_stream_large_${index}`,
          sessionID: session.id,
          role: "user",
          time: { created: index + 1 },
          agent: "build",
          model: { providerID: "wanlaicode", modelID: "model" },
        },
        parts: [
          {
            id: `prt_stream_large_${index}`,
            sessionID: session.id,
            messageID: `msg_stream_large_${index}`,
            type: "text",
            text: `${index}:`.padEnd(textBytes, "x"),
          },
        ],
      }) as unknown as MessageV2.WithParts
    const fake = fakeOperations()
    const metadata = Array.from({ length: pageCount }, (_, index) => {
      const message = messageAt(index)
      return { ...message, parts: [] } as MessageV2.WithParts
    })
    const operations: RemoteOperations = {
      ...fake.operations,
      historyPage: async (input) => {
        const page = historyPageFromMessages(metadata, input)
        return {
          ...page,
          // metadata 全部来自正常消息，此处只替换正文以模拟分页时才 hydrate 大 payload。
          items: page.items.map((item) => {
            const index = Number(item.message.info.id.slice("msg_stream_large_".length))
            return { ...item, message: messageAt(index), bytes: textBytes }
          }),
        }
      },
    }
    const stream = streamRemoteHistoryPayload(
      { type: "bridge.client_message", message: { type: "get_history", sessionId: session.id } },
      operations,
    )
    if (!stream) throw new Error("缺少大历史流")
    let totalTextBytes = 0
    let maxChunkBytes = 0
    const types: string[] = []
    let finalStatus: unknown
    for await (const envelope of stream) {
      const chunk = envelope.message as Record<string, unknown>
      if (chunk.type !== "history_snapshot" && chunk.type !== "history_delta") continue
      types.push(chunk.type as string)
      finalStatus = chunk.status ?? finalStatus
      maxChunkBytes = Math.max(maxChunkBytes, Buffer.byteLength(JSON.stringify(envelope), "utf8"))
      for (const entry of chunk.messages as Array<{ message: { text?: string } }>) {
        totalTextBytes += Buffer.byteLength(entry.message.text ?? "", "utf8")
      }
    }
    expect(totalTextBytes).toBe(pageCount * textBytes)
    expect(totalTextBytes).toBeGreaterThan(64 * 1024 * 1024)
    expect(maxChunkBytes).toBeLessThan(32 * 1024 * 1024)
    expect(types).toEqual(["history_snapshot", "history_delta", "history_delta"])
    expect(finalStatus).toBe("idle")
  })

  test("较早分页的唯一图片在后续分页无图时仍按全历史预算保留", async () => {
    const encoded = imageBase64("image/png", 1024 * 1024)
    const messages = Array.from({ length: 10 }, (_, index) => {
      if (index === 0) return userImageMessage("msg_cross_page_image", encoded)
      const id = `msg_cross_page_text_${index}`
      return {
        info: {
          id,
          sessionID: session.id,
          role: "user",
          time: { created: index + 1 },
          agent: "build",
          model: { providerID: "wanlaicode", modelID: "model" },
        },
        parts: [{ id: `${id}_text`, sessionID: session.id, messageID: id, type: "text", text: `text ${index}` }],
      } as unknown as MessageV2.WithParts
    })
    const fake = fakeOperations()
    const operations: RemoteOperations = {
      ...fake.operations,
      historyPage: async (input) => historyPageFromMessages(messages, input),
    }
    const result = await collectHistory(
      { type: "bridge.client_message", message: { type: "get_history", sessionId: session.id } },
      operations,
    )
    const entries = result
      .map((item) => item.message as { messages?: Array<{ message: Record<string, unknown> }> })
      .flatMap((chunk) => chunk.messages ?? [])
    const image = entries.find((entry) => entry.message.userMessageUuid === "msg_cross_page_image")?.message
    expect(image).toMatchObject({ imageCount: 1, images: [{ url: `data:image/png;base64,${encoded}` }] })
  })

  test("冻结 high-water 后并发追加和删除不会造成重复、跳页或纳入新消息", async () => {
    const user = (index: number) =>
      ({
        info: {
          id: `msg_keyset_${index}`,
          sessionID: session.id,
          role: "user",
          time: { created: index },
          agent: "build",
          model: { providerID: "wanlaicode", modelID: "model" },
        },
        parts: [
          {
            id: `prt_keyset_${index}`,
            sessionID: session.id,
            messageID: `msg_keyset_${index}`,
            type: "text",
            text: `message ${index}`,
          },
        ],
      }) as unknown as MessageV2.WithParts
    const messages = [user(1), user(2), user(3), user(4)]
    const fake = fakeOperations()
    let backwardCalls = 0
    let forwardCalls = 0
    const highWaters = new Set<string | null>()
    const backwardIDs: string[] = []
    const operations: RemoteOperations = {
      ...fake.operations,
      historyPage: async (input) => {
        const page = historyPageFromMessages(messages, input)
        highWaters.add(page.high_water)
        if (input.direction === "backward") {
          backwardCalls += 1
          backwardIDs.push(...page.items.flatMap((item) => (item.type === "message" ? [item.message.info.id] : [])))
          if (backwardCalls === 1) messages.push(user(5))
        } else {
          forwardCalls += 1
          if (forwardCalls === 1) messages.splice(0, 1)
        }
        return page
      },
    }

    const result = await collectHistory(
      { type: "bridge.client_message", message: { type: "get_history", sessionId: session.id } },
      operations,
    )
    const ids = result
      .map((item) => item.message as { messages?: Array<{ message: { userMessageUuid?: string } }> })
      .flatMap((chunk) => chunk.messages ?? [])
      .flatMap((entry) => (entry.message.userMessageUuid ? [entry.message.userMessageUuid] : []))
    expect(backwardIDs).toEqual(["msg_keyset_4", "msg_keyset_3", "msg_keyset_2", "msg_keyset_1"])
    expect(ids).toEqual(["msg_keyset_1", "msg_keyset_2", "msg_keyset_3", "msg_keyset_4"])
    expect(highWaters.size).toBe(1)
  })

  test("历史 job 失效后在当前页边界停止反向预扫", async () => {
    const messages = Array.from({ length: 4 }, (_, index) => ({
      ...userImageMessage(`msg_cancel_${index}`, imageBase64("image/png")),
      info: { ...userImageMessage(`msg_cancel_${index}`, imageBase64("image/png")).info, time: { created: index } },
    })) as MessageV2.WithParts[]
    const fake = fakeOperations()
    let calls = 0
    let active = true
    let releasePage: () => void = () => undefined
    const operations: RemoteOperations = {
      ...fake.operations,
      historyPage: async (input) => {
        calls += 1
        if (calls === 2) await new Promise<void>((resolve) => (releasePage = resolve))
        return historyPageFromMessages(messages, input)
      },
    }
    const stream = streamRemoteHistoryPayload(
      { type: "bridge.client_message", message: { type: "get_history", sessionId: session.id } },
      operations,
      { active: () => active },
    )
    if (!stream) throw new Error("缺少可取消历史流")
    const next = stream[Symbol.asyncIterator]().next()
    while (calls < 2) await Bun.sleep(0)
    active = false
    releasePage()
    expect(await next).toEqual({ done: true, value: undefined })
    expect(calls).toBe(2)
  })

  test("预读取判定 oversized 的消息直接生成有界占位而不进入映射", async () => {
    const fake = fakeOperations()
    const operations: RemoteOperations = {
      ...fake.operations,
      historyPage: async (input) => ({
        session_id: input.session_id,
        items: [{ type: "oversized", messageID: MessageID.make("msg_oversized_source") }],
        high_water: "frozen-oversized",
      }),
    }
    const result = await collectHistory(
      { type: "bridge.client_message", message: { type: "get_history", sessionId: session.id } },
      operations,
    )
    expect(result[0]).toMatchObject({
      message: {
        type: "history_snapshot",
        messages: [
          {
            seq: 1,
            message: {
              type: "error",
              errorCode: "REMOTE_HISTORY_ENTRY_TOO_LARGE",
              messageUuid: "msg_oversized_source",
            },
          },
        ],
      },
    })
  })

  test("重连 snapshot 恢复完整 permission 和 AskUserQuestion", async () => {
    const fake = fakeOperations()
    const operations: RemoteOperations = {
      ...fake.operations,
      snapshot: async () => ({
        sessions: [{ ...session, status: "waiting_approval" }],
        permissions: [
          {
            session_id: session.id,
            request_id: "per_reconnect",
            permission: "bash",
            patterns: ["git status"],
            metadata: { cwd: session.directory },
          },
        ],
        questions: [
          {
            session_id: session.id,
            request_id: "que_reconnect",
            questions: [
              {
                question: "Choose mode",
                header: "Mode",
                options: [{ label: "Fast", description: "Run fast" }],
                multiple: false,
                custom: true,
              },
            ],
          },
        ],
      }),
    }
    const list = await dispatchRemotePayload(
      { type: "bridge.client_message", message: { type: "list_sessions" } },
      operations,
    )
    expect(list[0]).toMatchObject({
      message: {
        sessions: [
          {
            id: session.id,
            pendingPermission: { toolUseId: "per_reconnect" },
            pendingRequests: [
              { toolUseId: "per_reconnect", requestKind: "permission" },
              { toolUseId: "que_reconnect", requestKind: "question" },
            ],
          },
        ],
      },
    })
    const restored = await collectHistory(
      { type: "bridge.client_message", message: { type: "get_history", sessionId: session.id } },
      operations,
    )
    expect(restored.slice(1)).toMatchObject([
      {
        message: {
          type: "permission_request",
          requestKind: "permission",
          toolUseId: "per_reconnect",
          sessionId: session.id,
        },
      },
      {
        message: {
          type: "permission_request",
          requestKind: "question",
          toolUseId: "que_reconnect",
          toolName: "AskUserQuestion",
          sessionId: session.id,
          input: { questions: [{ header: "Mode", custom: true }] },
        },
      },
    ])
  })

  test("模型与权限命令进入桌面权威操作并返回可同步确认", async () => {
    const fake = fakeOperations()
    const model = await dispatchRemotePayload(
      {
        type: "bridge.client_message",
        message: {
          type: "set_codex_model",
          sessionId: session.id,
          model: "model-next",
          modelReasoningEffort: "high",
        },
      },
      fake.operations,
    )
    const permission = await dispatchRemotePayload(
      {
        type: "bridge.client_message",
        message: {
          type: "set_permission_mode",
          sessionId: session.id,
          mode: "acceptEdits",
          codexPermissionsMode: "autoReview",
        },
      },
      fake.operations,
    )

    expect(model[0]).toMatchObject({
      message: {
        type: "system",
        subtype: "set_codex_model",
        sessionId: session.id,
        model: "model-next",
        previousModel: "model",
        modelReasoningEffort: "high",
        modelContextWindow: 200_000,
      },
    })
    expect(permission[0]).toMatchObject({
      message: {
        type: "system",
        subtype: "set_permission_mode",
        sessionId: session.id,
        codexPermissionsMode: "autoReview",
        approvalsReviewer: "auto_review",
      },
    })
    expect(fake.calls).toEqual([
      {
        type: "setModel",
        value: { session_id: session.id, model_id: "model-next", variant: "high" },
      },
      {
        type: "setPermissionMode",
        value: { session_id: session.id, mode: "autoReview" },
      },
    ])
  })

  test("Bridge 与 native 模型 setter 拒绝空档位且不产生调用或事件", async () => {
    const fake = fakeOperations()

    // 两种 envelope 都必须在进入 operations 前失败；抛错路径不会返回任何 ACK/system 事件。
    await expect(
      dispatchRemotePayload(
        {
          type: "bridge.client_message",
          message: {
            type: "set_codex_model",
            sessionId: session.id,
            model: "model-next",
            modelReasoningEffort: "",
          },
        },
        fake.operations,
      ),
    ).rejects.toMatchObject({ code: "set_codex_model_rejected" })
    await expect(
      dispatchRemotePayload(
        {
          type: "session.model.set",
          session_id: session.id,
          model_id: "model-next",
          model_reasoning_effort: "",
        },
        fake.operations,
      ),
    ).rejects.toMatchObject({ code: "set_codex_model_rejected" })
    expect(fake.calls).toEqual([])
  })

  test("Bridge start 与 native create 拒绝所有来源的显式非法模型", async () => {
    const fake = fakeOperations()
    const invalidModels: unknown[] = ["", null, 42]
    const sources = ["top", "camel", "snake"] as const
    const envelopes = ["bridge", "native"] as const

    for (const envelope of envelopes) {
      for (const source of sources) {
        for (const model of invalidModels) {
          const setting =
            source === "top"
              ? { model }
              : source === "camel"
                ? { codexSettings: { model } }
                : { codex_settings: { model } }
          const payload =
            envelope === "bridge"
              ? {
                  type: "bridge.client_message",
                  message: {
                    type: "start",
                    projectPath: session.directory,
                    clientRequestId: `invalid_${source}_${String(model)}`,
                    ...setting,
                  },
                }
              : {
                  type: "session.create",
                  directory: session.directory,
                  request_id: `invalid_${source}_${String(model)}`,
                  ...setting,
                }

          // 显式非法值不能降级成默认模型；18 种入口组合都必须在 operations.create 前失败。
          await expect(dispatchRemotePayload(payload, fake.operations)).rejects.toMatchObject({
            code: "set_codex_model_rejected",
          })
        }
      }
    }
    expect(fake.calls).toEqual([])
  })

  test("权限 setter 统一接受嵌套与顶层的 snake/camel 字段且拒绝缺失模式", async () => {
    const fake = fakeOperations()
    const payloads = [
      {
        type: "session.permission_mode.set",
        session_id: session.id,
        codex_permissions_mode: "autoReview",
      },
      {
        type: "session.permission_mode.set",
        session_id: session.id,
        codex_settings: { codex_permissions_mode: "default" },
      },
      {
        type: "set_permission_mode",
        sessionId: session.id,
        codexSettings: { codexPermissionsMode: "autoReview" },
      },
      {
        type: "session.permission_mode.set",
        session_id: session.id,
        codexSettings: { codex_permissions_mode: "default" },
      },
      { type: "session.permission_mode.set", session_id: session.id, mode: "autoReview" },
      { type: "session.permission_mode.set", session_id: session.id, permissionMode: "autoReview" },
      { type: "session.permission_mode.set", session_id: session.id, permission_mode: "autoReview" },
    ]
    for (const payload of payloads) await dispatchRemotePayload(payload, fake.operations)

    expect(fake.calls).toEqual(
      ["autoReview", "default", "autoReview", "default", "autoReview", "autoReview", "autoReview"].map((mode) => ({
        type: "setPermissionMode",
        value: { session_id: session.id, mode },
      })),
    )
    // 缺失 mode 必须在进入 operations 前失败，不能借旧行为静默把会话改回 default。
    await expect(
      dispatchRemotePayload({ type: "session.permission_mode.set", session_id: session.id }, fake.operations),
    ).rejects.toEqual(new ProtocolError("INVALID_REQUEST", "Permission mode is required"))
    expect(fake.calls).toHaveLength(7)
  })

  test("start、create 与权限 setter 拒绝矛盾或不受支持的 Codex 权限组合", async () => {
    const fake = fakeOperations()
    const payloads = [
      {
        type: "bridge.client_message",
        message: {
          type: "start",
          projectPath: session.directory,
          clientRequestId: "conflicting_start",
          codexPermissionsMode: "autoReview",
          approvalsReviewer: "user",
        },
      },
      {
        type: "session.create",
        directory: session.directory,
        request_id: "unsupported_create_policy",
        codex_settings: {
          codex_permissions_mode: "default",
          approval_policy: "never",
          approvals_reviewer: "user",
        },
      },
      {
        type: "bridge.client_message",
        message: {
          type: "set_permission_mode",
          sessionId: session.id,
          codexPermissionsMode: "default",
          sandboxMode: "danger-full-access",
          approvalsReviewer: "user",
        },
      },
      {
        type: "session.permission_mode.set",
        session_id: session.id,
        codex_permissions_mode: "default",
        approvals_reviewer: "auto_review",
        approval_policy: "on-request",
        sandbox_mode: "workspace-write",
      },
    ]

    // 四条入口都必须在调用 operations 前完成整组校验，不能只读取 codexPermissionsMode 后忽略其余矛盾字段。
    for (const payload of payloads) {
      await expect(dispatchRemotePayload(payload, fake.operations)).rejects.toMatchObject({
        code: "set_permission_mode_rejected",
      })
    }
    expect(fake.calls).toEqual([])
  })

  test("start、create、resume 与 setter 拒绝 canonical mode 和 Codex mode 冲突", async () => {
    const fake = fakeOperations()
    const payloads = [
      {
        type: "bridge.client_message",
        message: {
          type: "start",
          projectPath: session.directory,
          clientRequestId: "canonical_conflict_start",
          permissionMode: "default",
          codexPermissionsMode: "autoReview",
        },
      },
      {
        type: "session.create",
        directory: session.directory,
        request_id: "canonical_conflict_create",
        permission_mode: "autoReview",
        codex_settings: { codex_permissions_mode: "default" },
      },
      {
        type: "bridge.client_message",
        message: {
          type: "resume_session",
          sessionId: session.id,
          mode: "default",
          codexSettings: { codexPermissionsMode: "autoReview" },
        },
      },
      {
        type: "session.permission_mode.set",
        session_id: session.id,
        mode: "autoReview",
        codex_permissions_mode: "default",
      },
    ]

    // 四个状态入口都必须在 operations 前拒绝同一事实的相反取值，不能依赖字段覆盖顺序静默选边。
    for (const payload of payloads) {
      await expect(dispatchRemotePayload(payload, fake.operations)).rejects.toMatchObject({
        code: "set_permission_mode_rejected",
      })
    }
    expect(fake.calls).toEqual([])
  })

  test("手机 input、审批和问题回答进入同一个 sessionID", async () => {
    const fake = fakeOperations()
    const inputAck = await dispatchRemotePayload(
      {
        type: "bridge.client_message",
        message: {
          type: "input",
          sessionId: session.id,
          text: "hello",
          clientMessageId: "mobile-message-1",
          baseSeq: 99,
        },
      },
      fake.operations,
      { request_scope: "account/mobile" },
    )
    await dispatchRemotePayload(
      {
        type: "bridge.client_message",
        message: {
          type: "answer",
          sessionId: session.id,
          toolUseId: "que_2",
          result:
            '{"questions":[{"question":"Color"},{"question":"Mode"}],"answers":{"Color":"Red, Blue","Mode":"Fast"}}',
        },
      },
      fake.operations,
    )
    const approved = await dispatchRemotePayload(
      { type: "bridge.client_message", message: { type: "approve", sessionId: session.id, id: "per_1" } },
      fake.operations,
    )
    await dispatchRemotePayload(
      {
        type: "bridge.client_message",
        message: { type: "answer", sessionId: session.id, toolUseId: "que_1", result: '{"answers":[["A"]]}' },
      },
      fake.operations,
    )
    await dispatchRemotePayload(
      {
        type: "bridge.client_message",
        message: { type: "answer", sessionId: session.id, toolUseId: "que_3", result: "Color: Red, Blue\nMode: Fast" },
      },
      fake.operations,
    )
    expect(inputAck[0]).toMatchObject({
      message: { type: "input_ack", sessionId: session.id, clientMessageId: "mobile-message-1", queued: false },
    })
    // baseSeq 只是手机本地视图，桌面没有分配权威 seq 时绝不能伪装成 acceptedSeq 回写并覆盖缓存。
    expect((inputAck[0] as { message: Record<string, unknown> }).message).not.toHaveProperty("acceptedSeq")
    expect(approved[0]).toMatchObject({ message: { type: "permission_resolved", sessionId: session.id } })
    expect(fake.calls).toEqual([
      {
        type: "send",
        value: {
          session_id: session.id,
          text: "hello",
          client_message_id: "mobile-message-1",
          request_id: `["account/mobile","${session.id}","mobile-message-1"]`,
        },
      },
      {
        type: "question",
        value: { session_id: session.id, request_id: "que_2", answers: [["Red", "Blue"], ["Fast"]] },
      },
      { type: "permission", value: { session_id: session.id, request_id: "per_1", reply: "once" } },
      { type: "question", value: { session_id: session.id, request_id: "que_1", answers: [["A"]] } },
      {
        type: "question",
        value: { session_id: session.id, request_id: "que_3", answers: [["Red", "Blue"], ["Fast"]] },
      },
    ])
  })

  test("input 分发失败同时返回 input_rejected 和用户可见 error", async () => {
    const verify = async (input: Record<string, unknown>, expected: { code: string; message: string }) => {
      const fake = fakeOperations()
      const operations: RemoteOperations = {
        ...fake.operations,
        send: async (value) => {
          if (expected.code === "INVALID_REMOTE_IMAGE") return fake.operations.send(value)
          throw new ProtocolError(expected.code, expected.message)
        },
      }
      const result = await dispatchRemotePayload(
        { type: "bridge.client_message", message: { type: "input", ...input } },
        operations,
      )
      expect(result).toMatchObject([
        {
          type: "bridge.server_message",
          message: {
            type: "input_rejected",
            sessionId: input.sessionId,
            clientMessageId: input.clientMessageId,
            reason: expected.message,
          },
        },
        {
          type: "bridge.server_message",
          message: {
            type: "error",
            sessionId: input.sessionId,
            errorCode: expected.code,
            message: expected.message,
          },
        },
      ])
      return fake.calls
    }

    await verify(
      { sessionId: session.id, clientMessageId: "mobile-busy", text: "busy" },
      { code: "SESSION_BUSY", message: "Session is busy" },
    )
    await verify(
      { sessionId: "missing-session", clientMessageId: "mobile-missing", text: "missing" },
      { code: "SESSION_NOT_FOUND", message: "Session missing-session not found" },
    )
    const imageCalls = await verify(
      {
        sessionId: session.id,
        clientMessageId: "mobile-bad-image",
        text: "bad image",
        images: [{ mimeType: "image/png", base64: "not-base64" }],
      },
      { code: "INVALID_REMOTE_IMAGE", message: "Image 1 must use canonical Base64" },
    )
    expect(imageCalls).toEqual([])
  })

  test("手机图片经过校验后以 data URL 进入同一个用户消息", async () => {
    const fake = fakeOperations()
    const images = (["image/png", "image/jpeg", "image/gif", "image/webp"] as const).map((mimeType) => ({
      mimeType,
      base64: imageBase64(mimeType),
    }))
    await dispatchRemotePayload(
      {
        type: "bridge.client_message",
        message: {
          type: "input",
          sessionId: session.id,
          text: "compare these",
          clientMessageId: "mobile-images-1",
          images,
        },
      },
      fake.operations,
      { request_scope: "account/mobile" },
    )

    expect(fake.calls[0]).toMatchObject({
      type: "send",
      value: {
        session_id: session.id,
        text: "compare these",
        request_id: `["account/mobile","${session.id}","mobile-images-1"]`,
        images: [
          { type: "file", mime: "image/png", filename: "mobile-image-1.png" },
          { type: "file", mime: "image/jpeg", filename: "mobile-image-2.jpg" },
          { type: "file", mime: "image/gif", filename: "mobile-image-3.gif" },
          { type: "file", mime: "image/webp", filename: "mobile-image-4.webp" },
        ],
      },
    })
    const sent = (fake.calls[0]?.value as { images: MessageV2.FilePartInput[] }).images
    expect(sent[0]?.url).toBe(`data:image/png;base64,${images[0]?.base64}`)
  })

  test("图片校验拒绝非规范 Base64、伪造 MIME、单张过大和总量过大", () => {
    const png = imageBase64("image/png")
    expect(() => remoteImageParts([{ mimeType: "image/png", base64: `${png}\n` }])).toThrow("must use canonical Base64")
    expect(() => remoteImageParts([{ mimeType: "image/jpeg", base64: png }])).toThrow("MIME type does not match")
    expect(() => remoteImageParts(Array.from({ length: 6 }, () => ({ mimeType: "image/png", base64: png })))).toThrow(
      "At most 5 images",
    )
    expect(() =>
      remoteImageParts([{ mimeType: "image/png", base64: imageBase64("image/png", 4 * 1024 * 1024 + 1) }]),
    ).toThrow("exceeds 4 MiB")
    expect(() =>
      remoteImageParts(
        Array.from({ length: 3 }, () => ({
          mimeType: "image/png",
          base64: imageBase64("image/png", 3 * 1024 * 1024),
        })),
      ),
    ).toThrow("exceed 8 MiB")
  })

  test("普通文件、提取正文和 PDF 扫描页通过同一 input 投递，并去重旧 images", async () => {
    const fake = fakeOperations()
    const pngBytes = Buffer.from(imageBase64("image/png"), "base64")
    const pdfBytes = Buffer.from("%PDF-1.7\nmobile attachment")
    const pageBytes = Buffer.from([0xff, 0xd8, 0xff, 0x00])
    const image = attachmentPayload("screen.png", "image/png", pngBytes)
    const pdf = attachmentPayload("report.pdf", "application/pdf", pdfBytes, {
      extractedText: "第一章：附件正文",
      derivedImages: [{ pageNumber: 1, mimeType: "image/jpeg", base64: pageBytes.toString("base64") }],
    })

    await dispatchRemotePayload(
      {
        type: "bridge.client_message",
        message: {
          type: "input",
          sessionId: session.id,
          clientMessageId: "mobile-files-1",
          text: "",
          // 新手机为兼容旧桌面会重复发送图片；桌面必须以 attachments 为权威并删除旧副本。
          images: [{ mimeType: "image/png", base64: image.base64 }],
          attachments: [image, pdf],
        },
      },
      fake.operations,
      { request_scope: "account/mobile" },
    )

    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0]).toMatchObject({
      type: "send",
      value: {
        session_id: session.id,
        text: "",
        client_message_id: "mobile-files-1",
        attachments: [
          { filename: "screen.png", mimeType: "image/png", sizeBytes: pngBytes.length },
          {
            filename: "report.pdf",
            mimeType: "application/pdf",
            sizeBytes: pdfBytes.length,
            extractedText: "第一章：附件正文",
            derivedImages: [{ pageNumber: 1, mimeType: "image/jpeg" }],
          },
        ],
      },
    })
    expect((fake.calls[0]?.value as { images?: unknown[] }).images).toBeUndefined()
  })

  test("原生 session.send 与 Bridge input 复用同一文件校验和去重结果", async () => {
    const fake = fakeOperations()
    const pngBytes = Buffer.from(imageBase64("image/png"), "base64")
    const image = attachmentPayload("native.png", "image/png", pngBytes)
    const result = await dispatchRemotePayload(
      {
        type: "session.send",
        session_id: session.id,
        text: "native file",
        request_id: "native-file-1",
        images: [{ mimeType: "image/png", base64: image.base64 }],
        attachments: [image],
      },
      fake.operations,
      { request_scope: "account/native" },
    )
    expect(result).toMatchObject([{ type: "ack", data: { message_id: "msg_user" } }])
    expect(fake.calls[0]).toMatchObject({
      type: "send",
      value: {
        session_id: session.id,
        text: "native file",
        request_id: '["account/native","native-file-1"]',
        attachments: [{ filename: "native.png", mimeType: "image/png" }],
      },
    })
    expect((fake.calls[0]?.value as { images?: unknown[] }).images).toBeUndefined()
  })

  test("普通文件校验拒绝路径文件名、伪 MIME、尺寸摘要不符和超限派生内容", () => {
    const textBytes = Buffer.from("hello")
    const valid = attachmentPayload("notes.txt", "text/plain", textBytes)
    expect(remoteAttachmentInputs([valid])).toMatchObject([
      {
        filename: "notes.txt",
        mimeType: "text/plain",
        sizeBytes: 5,
        sha256: valid.sha256,
      },
    ])
    expect(() => remoteAttachmentInputs([{ ...valid, filename: "../notes.txt" }])).toThrow("unsafe filename")
    expect(() => remoteAttachmentInputs([{ ...valid, filename: ".wanlai-mobile-derived-1-page-1.jpg" }])).toThrow(
      "unsafe filename",
    )
    expect(() => remoteAttachmentInputs([{ ...valid, mimeType: "text/plain;charset=utf-8" }])).toThrow(
      "invalid MIME type",
    )
    expect(() => remoteAttachmentInputs([{ ...valid, sizeBytes: 4 }])).toThrow("sizeBytes does not match")
    expect(() => remoteAttachmentInputs([{ ...valid, base64: `${valid.base64}\n` }])).toThrow("canonical Base64")
    expect(() => remoteAttachmentInputs([{ ...valid, sha256: "00".repeat(32) }])).toThrow("SHA-256 does not match")
    expect(() =>
      remoteAttachmentInputs([attachmentPayload("fake.png", "image/png", Buffer.from([0xff, 0xd8, 0xff, 0x00]))]),
    ).toThrow("MIME type does not match")
    expect(() =>
      remoteAttachmentInputs(Array.from({ length: 6 }, (_, index) => ({ ...valid, filename: `${index}.txt` }))),
    ).toThrow("At most 5 attachments")
    expect(() =>
      remoteAttachmentInputs([
        attachmentPayload("large.bin", "application/octet-stream", Buffer.alloc(4 * 1024 * 1024 + 1)),
      ]),
    ).toThrow("exceeds 4 MiB")
    expect(() =>
      remoteAttachmentInputs(
        Array.from({ length: 3 }, (_, index) =>
          attachmentPayload(`${index}.bin`, "application/octet-stream", Buffer.alloc(3 * 1024 * 1024)),
        ),
      ),
    ).toThrow("exceed 8 MiB")
    expect(() => remoteAttachmentInputs([{ ...valid, extractedText: "x".repeat(128 * 1024 + 1) }])).toThrow(
      "exceeds 128K characters",
    )
    expect(() =>
      remoteAttachmentInputs([
        {
          ...valid,
          derivedImages: Array.from({ length: 4 }, (_, index) => ({
            pageNumber: index + 1,
            mimeType: "image/jpeg",
            base64: Buffer.from([0xff, 0xd8, 0xff]).toString("base64"),
          })),
        },
      ]),
    ).toThrow("at most 3 derived images")
  })

  test("images 与 attachments 的联合数量和字节预算无法通过双字段绕过", () => {
    const png = imageBase64("image/png")
    const files = Array.from({ length: 5 }, (_, index) =>
      attachmentPayload(`${index}.txt`, "text/plain", Buffer.from(`file-${index}`)),
    )
    expect(() => remoteInputAttachments([{ mimeType: "image/png", base64: png }], files)).toThrow(
      "At most 5 attachments",
    )
    const large = attachmentPayload("large.bin", "application/octet-stream", Buffer.alloc(4 * 1024 * 1024))
    expect(() =>
      remoteInputAttachments([{ mimeType: "image/png", base64: imageBase64("image/png", 4 * 1024 * 1024) }], [large]),
    ).not.toThrow()
    expect(() =>
      remoteInputAttachments(
        [{ mimeType: "image/png", base64: imageBase64("image/png", 4 * 1024 * 1024) }],
        [large, attachmentPayload("extra.txt", "text/plain", Buffer.from("x"))],
      ),
    ).toThrow("exceed 8 MiB")
    const derivedPage = imageBase64("image/jpeg", 3 * 1024 * 1024)
    expect(() =>
      remoteInputAttachments(
        undefined,
        Array.from({ length: 3 }, (_, index) =>
          attachmentPayload(`${index}.pdf`, "application/pdf", Buffer.from("%PDF-1.7"), {
            derivedImages: [{ pageNumber: 1, mimeType: "image/jpeg", base64: derivedPage }],
          }),
        ),
      ),
    ).toThrow("Derived images exceed 8 MiB")
  })

  test("用户图片在历史和实时消息中保留 data URL", () => {
    const encoded = imageBase64("image/png")
    const user = {
      info: {
        id: "msg_user_image",
        sessionID: session.id,
        role: "user",
        time: { created: 4 },
        agent: "build",
        model: { providerID: "wanlaicode", modelID: "model" },
      },
      parts: [
        { id: "prt_user_text", sessionID: session.id, messageID: "msg_user_image", type: "text", text: "look" },
        {
          id: "prt_user_image",
          sessionID: session.id,
          messageID: "msg_user_image",
          type: "file",
          mime: "image/png",
          filename: "mobile-image-1.png",
          url: `data:image/png;base64,${encoded}`,
        },
      ],
    } as unknown as MessageV2.WithParts

    expect(bridgeMessages(user)[0]).toMatchObject({
      type: "user_input",
      turnId: "msg_user_image",
      text: "look",
      imageCount: 1,
      // 原生图片继续使用旧 images 契约，普通文件在线引用不能制造重复图片附件。
      images: [{ mimeType: "image/png", url: `data:image/png;base64,${encoded}` }],
    })
  })

  test("用户普通文件在实时与历史中只发送 attachment 引用，提取正文和派生页不重复展示", () => {
    const pdf = Buffer.from("%PDF-1.7\nprivate body")
    const page = Buffer.from([0xff, 0xd8, 0xff, 0x00])
    const user = {
      info: {
        id: "msg_user_file",
        sessionID: session.id,
        role: "user",
        time: { created: 4 },
        agent: "build",
        model: { providerID: "wanlaicode", modelID: "model" },
      },
      parts: [
        { id: "prt_user_prompt", sessionID: session.id, messageID: "msg_user_file", type: "text", text: "review" },
        {
          id: "prt_user_pdf",
          sessionID: session.id,
          messageID: "msg_user_file",
          type: "file",
          mime: "application/pdf",
          filename: "report.pdf",
          url: `data:application/pdf;base64,${pdf.toString("base64")}`,
        },
        {
          id: "prt_user_context",
          sessionID: session.id,
          messageID: "msg_user_file",
          type: "text",
          synthetic: true,
          text: "[Mobile attachment extracted content: report.pdf]\nsecret body",
        },
        {
          id: "prt_user_page",
          sessionID: session.id,
          messageID: "msg_user_file",
          type: "file",
          mime: "image/jpeg",
          filename: ".wanlai-mobile-derived-1-page-1.jpg",
          url: `data:image/jpeg;base64,${page.toString("base64")}`,
        },
      ],
    } as unknown as MessageV2.WithParts

    const expected = {
      type: "user_input",
      text: "review",
      imageCount: 0,
      attachmentCount: 1,
      attachments: [
        {
          id: "prt_user_pdf",
          url: "attachment://prt_user_pdf",
          filename: "report.pdf",
          mimeType: "application/pdf",
          sizeBytes: pdf.length,
          sha256: crypto.createHash("sha256").update(pdf).digest("hex"),
        },
      ],
    }
    expect(bridgeMessages(user)[0]).toMatchObject(expected)
    const historyEntry = (
      bridgeHistory({ session_id: session.id, messages: [user] })[0]?.messages as Array<{
        message: Record<string, unknown>
      }>
    )[0]?.message
    expect(historyEntry).toMatchObject(expected)
    expect(historyEntry).not.toHaveProperty("images")
  })

  test("同文手机消息在实时与历史中透传各自 clientMessageId", () => {
    const user = (id: string, clientMessageId: string) =>
      ({
        info: {
          id,
          sessionID: session.id,
          role: "user",
          time: { created: 4 },
          agent: "build",
          model: { providerID: "wanlaicode", modelID: "model" },
          remoteClientMessageID: clientMessageId,
        },
        parts: [{ id: `${id}_text`, sessionID: session.id, messageID: id, type: "text", text: "same text" }],
      }) as unknown as MessageV2.WithParts
    const messages = [user("msg_same_1", "mobile-same-1"), user("msg_same_2", "mobile-same-2")]

    expect(messages.flatMap(bridgeMessages).map((message) => message.clientMessageId)).toEqual([
      "mobile-same-1",
      "mobile-same-2",
    ])
    const historyMessages = bridgeHistory({ session_id: session.id, messages }).flatMap(
      (chunk) => chunk.messages as Array<{ message: Record<string, unknown> }>,
    )
    expect(historyMessages.map((entry) => entry.message.clientMessageId)).toEqual(["mobile-same-1", "mobile-same-2"])
  })

  test("无法嵌入的图片和文件使用安全文件名占位且不会静默消失", () => {
    const encoded = imageBase64("image/png")
    const files = [
      ...Array.from({ length: 6 }, (_, index) => ({
        id: `prt_valid_${index}`,
        sessionID: session.id,
        messageID: "msg_files",
        type: "file" as const,
        mime: "image/png",
        filename: `valid-${index + 1}.png`,
        url: `data:image/png;base64,${encoded}`,
      })),
      {
        id: "prt_local",
        sessionID: session.id,
        messageID: "msg_files",
        type: "file" as const,
        mime: "image/png",
        filename: "local\nimage.png",
        url: "file:///Users/developer/secret.png",
      },
      {
        id: "prt_broken",
        sessionID: session.id,
        messageID: "msg_files",
        type: "file" as const,
        mime: "image/png",
        filename: "broken.png",
        url: "data:image/png;base64,AAAA",
      },
      {
        id: "prt_document",
        sessionID: session.id,
        messageID: "msg_files",
        type: "file" as const,
        mime: "application/pdf",
        filename: "document.pdf",
        url: "https://private.example/token",
      },
    ]
    const user = {
      info: {
        id: "msg_files",
        sessionID: session.id,
        role: "user",
        time: { created: 4 },
        agent: "build",
        model: { providerID: "wanlaicode", modelID: "model" },
      },
      parts: files,
    } as unknown as MessageV2.WithParts
    const mapped = bridgeMessages(user)[0] as Record<string, unknown>

    expect(mapped.images).toHaveLength(5)
    expect(mapped.imageCount).toBe(8)
    expect(mapped.text).toContain("[File: valid-6.png]")
    expect(mapped.text).toContain("[File: local image.png]")
    expect(mapped.text).toContain("[File: broken.png]")
    expect(mapped.text).toContain("[File: document.pdf]")
    expect(JSON.stringify(mapped)).not.toContain("/Users/developer")
    expect(JSON.stringify(mapped)).not.toContain("private.example")
  })

  test("桌面已有 5MiB 图片可同步，历史按倒序保留最新图片且不超过总预算", () => {
    const encoded = imageBase64("image/png", 5 * 1024 * 1024)
    const histories = Array.from({ length: 5 }, (_, index) => userImageMessage(`msg_desktop_image_${index}`, encoded))

    // 5 MiB 超过手机新附件的 4 MiB 输入限制，但属于桌面既有历史的 10 MiB 兼容范围，不能被误删。
    const mapped = bridgeMessages(histories[0]!)[0] as unknown as {
      imageCount: number
      images: Array<{ mimeType: string; url: string }>
    }
    expect(mapped.imageCount).toBe(1)
    // 桌面旧历史图片保持既有字段，新增普通文件协议不能要求旧记录具备附件 ID。
    expect(mapped.images[0]).toEqual({ mimeType: "image/png", url: `data:image/png;base64,${encoded}` })

    // 五张各 5 MiB 的图片只能保留最新三张；较旧消息仍保留 imageCount 与文本，不出现破图或静默丢失。
    const chunks = bridgeHistory({ session_id: session.id, messages: histories }, "running")
    const entries = chunks.flatMap(
      (chunk) => chunk.messages as Array<{ seq: number; message: Record<string, unknown> }>,
    )
    expect(entries.map((entry) => entry.message.imageCount)).toEqual([1, 1, 1, 1, 1])
    expect(entries.map((entry) => Array.isArray(entry.message.images))).toEqual([false, false, true, true, true])
    const retainedBytes = entries.reduce((total, entry) => {
      const images = Array.isArray(entry.message.images) ? entry.message.images : []
      return (
        total +
        images.reduce((subtotal, image) => {
          const url = (image as { url: string }).url
          return subtotal + Buffer.from(url.slice(url.indexOf(",") + 1), "base64").byteLength
        }, 0)
      )
    }, 0)
    expect(retainedBytes).toBe(15 * 1024 * 1024)
    expect(chunks.at(-1)?.status).toBe("running")
  })

  test("assistant file 与 tool attachments 共用同一历史 data URL 预算", () => {
    const oldFile = assistantAttachmentMessage(
      "msg_old_assistant_file",
      Math.floor(bridgeHistoryImageBudgetBytes * 0.625),
      "file",
    )
    const newTool = assistantAttachmentMessage(
      "msg_new_tool_attachment",
      Math.floor(bridgeHistoryImageBudgetBytes * 0.25),
      "tool",
    )
    const entries = bridgeHistory({ session_id: session.id, messages: [oldFile, newTool] }).flatMap(
      (chunk) => chunk.messages as Array<{ message: Record<string, unknown> }>,
    )
    const oldAssistant = entries
      .map((entry) => entry.message)
      .find((message) => message.type === "assistant" && message.messageUuid === "msg_old_assistant_file")!
    const oldContent = ((oldAssistant.message as Record<string, unknown>).content as Array<Record<string, unknown>>)[0]!
    expect(oldContent).toMatchObject({
      type: "file",
      url: "",
      metadata: { remoteOmitted: true, omittedReason: "history_attachment_budget" },
    })

    const newAssistant = entries
      .map((entry) => entry.message)
      .find((message) => message.type === "assistant" && message.messageUuid === "msg_new_tool_attachment")!
    const newToolUse = ((newAssistant.message as Record<string, unknown>).content as Array<Record<string, unknown>>)[0]!
    const newResult = entries
      .map((entry) => entry.message)
      .find((message) => message.type === "tool_result" && message.toolUseId === "msg_new_tool_attachment_call")!
    expect(((newToolUse.attachments as Array<Record<string, unknown>>)[0]?.url as string).startsWith("data:")).toBe(
      true,
    )
    expect(((newResult.attachments as Array<Record<string, unknown>>)[0]?.url as string).startsWith("data:")).toBe(true)
  })

  test("大文本历史按 snapshot 和 delta 分块后可完整重建", () => {
    const histories = Array.from({ length: 3 }, (_, index) => {
      const id = `msg_large_text_${index}`
      return {
        ...userImageMessage(id, imageBase64("image/png")),
        parts: [
          {
            id: `${id}_text`,
            sessionID: session.id,
            messageID: id,
            type: "text",
            text: `${index}:`.padEnd(12 * 1024 * 1024, "x"),
          },
        ],
      } as unknown as MessageV2.WithParts
    })

    // 大文本触发多块，但每条记录仍低于单条预算；模拟手机依次应用 snapshot 和所有 delta。
    const chunks = bridgeHistory({ session_id: session.id, messages: histories }, "running")
    expect(chunks.length).toBeGreaterThan(1)
    const reconstructed: Array<{ seq: number; message: Record<string, unknown> }> = []
    let previousToSeq = 0
    chunks.forEach((chunk, index) => {
      const entries = chunk.messages as Array<{ seq: number; message: Record<string, unknown> }>
      if (index === 0) {
        expect(chunk.type).toBe("history_snapshot")
        expect(chunk.fromSeq).toBe(0)
        reconstructed.length = 0
      } else {
        expect(chunk.type).toBe("history_delta")
        expect(chunk.fromSeq).toBe(previousToSeq + 1)
      }
      reconstructed.push(...entries)
      previousToSeq = chunk.toSeq as number

      // 每个逻辑 Bridge 包和实际 relay 分片都必须低于 64 MiB，并能走正式编码器完成发送。
      const relayPayload = { type: "bridge.server_message", message: chunk }
      expect(Buffer.byteLength(JSON.stringify(relayPayload), "utf8")).toBeLessThan(relayFragmentMaxAssembledBytes)
      const envelopes = relayEnvelopes("mobile-1", relayPayload, "history-request", () => `history-${index}`)
      expect(envelopes.length).toBeGreaterThan(1)
      expect(
        envelopes.every(
          (envelope) => Buffer.byteLength(JSON.stringify(envelope), "utf8") < relayFragmentMaxAssembledBytes,
        ),
      ).toBe(true)
    })

    expect(reconstructed.map((entry) => entry.seq)).toEqual([1, 2, 3])
    expect(reconstructed.every((entry) => entry.message.type === "user_input")).toBe(true)
    expect(chunks.at(-1)?.status).toBe("running")
  })

  test("单条历史超过块预算时保留序号并降级为有界错误", () => {
    // 单条文本本身达到 32 MiB 后，不能让整个历史请求失败或突破 relay 上限。
    const oversized = {
      ...userImageMessage("msg_oversized_history", imageBase64("image/png")),
      parts: [
        {
          id: "msg_oversized_history_text",
          sessionID: session.id,
          messageID: "msg_oversized_history",
          type: "text",
          text: "x".repeat(32 * 1024 * 1024),
        },
      ],
    } as unknown as MessageV2.WithParts
    const chunks = bridgeHistory({ session_id: session.id, messages: [oversized] })
    const entries = chunks[0]?.messages as Array<{ seq: number; message: Record<string, unknown> }>

    expect(chunks).toHaveLength(1)
    expect(entries).toEqual([
      {
        seq: 1,
        message: {
          type: "error",
          errorCode: "REMOTE_HISTORY_ENTRY_TOO_LARGE",
          message: "A desktop message is too large to display on mobile",
          sessionId: session.id,
        },
      },
    ])
    expect(Buffer.byteLength(JSON.stringify(chunks[0]), "utf8")).toBeLessThan(relayFragmentMaxAssembledBytes)
  })

  test("start 和 session.create 消费设置，无设置 resume 只恢复既有权威会话", async () => {
    const fake = fakeOperations()
    const started = await dispatchRemotePayload(
      {
        type: "bridge.client_message",
        message: {
          type: "start",
          projectPath: session.directory,
          clientRequestId: "start_1",
          model: "model",
          codexSettings: { modelReasoningEffort: "high", codexPermissionsMode: "autoReview" },
        },
      },
      fake.operations,
      { request_scope: "account/mobile" },
    )
    await dispatchRemotePayload(
      {
        type: "session.create",
        directory: session.directory,
        title: "Native configured session",
        request_id: "native_start_1",
        model_id: "model",
        model_reasoning_effort: "low",
        codex_settings: { codex_permissions_mode: "default" },
      },
      fake.operations,
      { request_scope: "account/mobile" },
    )
    const resumed = await dispatchRemotePayload(
      {
        type: "bridge.client_message",
        message: { type: "resume_session", sessionId: session.id, projectPath: session.directory },
      },
      fake.operations,
    )
    expect(started[0]).toMatchObject({
      message: {
        type: "system",
        subtype: "session_created",
        sessionId: session.id,
        clientRequestId: "start_1",
      },
    })
    expect(resumed[0]).toMatchObject({ message: { type: "system", subtype: "session_created", sessionId: session.id } })
    if (!resumed[0] || !("message" in resumed[0])) throw new Error("缺少 resume session_created")
    expect(resumed[0].message).not.toHaveProperty("clientRequestId")
    expect(fake.calls[0]).toEqual({
      type: "create",
      value: {
        directory: session.directory,
        title: undefined,
        request_id: '["account/mobile","start_1"]',
        model_id: "model",
        variant: "high",
        permission_mode: "autoReview",
      },
    })
    expect(fake.calls[1]).toEqual({
      type: "create",
      value: {
        directory: session.directory,
        title: "Native configured session",
        request_id: '["account/mobile","native_start_1"]',
        model_id: "model",
        variant: "low",
        permission_mode: "default",
      },
    })
    // 无设置恢复仍统一进入 resume 入口，但不能凭 session_created 的默认字段反向写入任何状态。
    expect(fake.calls[2]).toEqual({ type: "resume", value: { session_id: session.id } })
  })

  test("模型和推理档位可以分布在 camel 与 snake 设置容器", async () => {
    const fake = fakeOperations()
    await dispatchRemotePayload(
      {
        type: "bridge.client_message",
        message: {
          type: "start",
          projectPath: session.directory,
          codexSettings: { model: "model" },
          codex_settings: { model_reasoning_effort: "low" },
        },
      },
      fake.operations,
    )
    await dispatchRemotePayload(
      {
        type: "bridge.client_message",
        message: {
          type: "resume_session",
          sessionId: session.id,
          codex_settings: { model: "model" },
          codexSettings: { modelReasoningEffort: "high" },
        },
      },
      fake.operations,
    )

    // 两个容器按语义字段合并，创建与恢复都必须把完整模型设置一次性交给状态层。
    expect(fake.calls).toEqual([
      {
        type: "create",
        value: { directory: session.directory, title: undefined, model_id: "model", variant: "low" },
      },
      { type: "resume", value: { session_id: session.id, model_id: "model", variant: "high" } },
    ])
  })

  test("模型别名在两个设置容器冲突时拒绝整个事务", async () => {
    const fake = fakeOperations()
    await expect(
      dispatchRemotePayload(
        {
          type: "bridge.client_message",
          message: {
            type: "resume_session",
            sessionId: session.id,
            codexSettings: { model: "model" },
            codex_settings: { model_id: "model-other" },
          },
        },
        fake.operations,
      ),
    ).rejects.toMatchObject({ code: "set_codex_model_rejected" })

    // 冲突必须在 operations 前结束，不能只提交被优先读取的 camel 容器。
    expect(fake.calls).toEqual([])
  })

  test("start 携带 sessionId 时通过一次 resume 应用已有会话设置", async () => {
    const fake = fakeOperations()
    const payloads = [
      { type: "start", sessionId: session.id, clientRequestId: "resume-empty" },
      {
        type: "start",
        sessionId: session.id,
        clientRequestId: "resume-model",
        model: "model-next",
        modelReasoningEffort: "low",
      },
      {
        type: "start",
        sessionId: session.id,
        clientRequestId: "resume-permission",
        codexPermissionsMode: "autoReview",
      },
      {
        type: "start",
        sessionId: session.id,
        clientRequestId: "resume-combined",
        model: "session-only-model",
        modelReasoningEffort: "medium",
        codexPermissionsMode: "default",
      },
    ]

    // 已有会话的 start 不能只查列表并静默丢设置；每条请求都以一次 resume 作为原子状态边界。
    const responses = []
    for (const message of payloads) {
      responses.push(await dispatchRemotePayload({ type: "bridge.client_message", message }, fake.operations))
    }

    expect(fake.calls).toEqual([
      { type: "resume", value: { session_id: session.id } },
      {
        type: "resume",
        value: { session_id: session.id, model_id: "model-next", variant: "low" },
      },
      {
        type: "resume",
        value: { session_id: session.id, permission_mode: "autoReview" },
      },
      {
        type: "resume",
        value: {
          session_id: session.id,
          model_id: "session-only-model",
          variant: "medium",
          permission_mode: "default",
        },
      },
    ])
    expect(responses.map((items) => items[0])).toEqual(
      payloads.map((message) =>
        expect.objectContaining({
          message: expect.objectContaining({
            type: "system",
            subtype: "session_created",
            sessionId: session.id,
            clientRequestId: message.clientRequestId,
          }),
        }),
      ),
    )
  })

  test("start 恢复已有会话时在进入 operations 前拒绝无效设置", async () => {
    const fake = fakeOperations()
    const payloads = [
      { type: "start", sessionId: session.id, modelReasoningEffort: "high" },
      { type: "start", sessionId: session.id, model: "" },
      { type: "start", sessionId: session.id, permissionMode: "" },
    ]

    // 恢复路径不能把错误设置解释为“不修改”；校验失败时不允许产生部分状态写入。
    for (const message of payloads) {
      await expect(
        dispatchRemotePayload({ type: "bridge.client_message", message }, fake.operations),
      ).rejects.toBeInstanceOf(ProtocolError)
    }
    expect(fake.calls).toEqual([])
  })

  test("start 重发沿用稳定 request_id 并在每次 ACK 回显原始 clientRequestId", async () => {
    const fake = fakeOperations()
    const persisted = new Map<string, RemoteSession>()
    const attempts: string[] = []
    fake.operations.create = async (input) => {
      const requestID = input.request_id ?? ""
      attempts.push(requestID)
      const existing = persisted.get(requestID)
      if (existing) return existing
      // fake 用稳定 request_id 模拟 operations 的唯一会话落库，重发只能命中同一条记录。
      persisted.set(requestID, session)
      return session
    }
    const payload = {
      type: "bridge.client_message",
      message: {
        type: "start",
        projectPath: session.directory,
        clientRequestId: "mobile-start:001",
      },
    }
    const context = { request_scope: "account/mobile" }
    const first = await dispatchRemotePayload(payload, fake.operations, context)
    const retried = await dispatchRemotePayload(payload, fake.operations, context)

    expect(attempts).toEqual(['["account/mobile","mobile-start:001"]', '["account/mobile","mobile-start:001"]'])
    expect(persisted.size).toBe(1)
    for (const result of [first, retried]) {
      expect(result[0]).toMatchObject({
        type: "bridge.server_message",
        message: {
          type: "system",
          subtype: "session_created",
          sessionId: session.id,
          clientRequestId: "mobile-start:001",
        },
      })
    }
  })

  test("resume_session 原子提交仅模型、仅审批或两者组合并回显最终会话", async () => {
    const fake = fakeOperations()
    const modelOnly = await dispatchRemotePayload(
      {
        type: "bridge.client_message",
        message: {
          type: "resume_session",
          sessionId: session.id,
          model: "model-next",
          modelReasoningEffort: "low",
        },
      },
      fake.operations,
    )
    const permissionOnly = await dispatchRemotePayload(
      {
        type: "bridge.client_message",
        message: {
          type: "resume_session",
          sessionId: session.id,
          approvalPolicy: "on-request",
          approvalsReviewer: "auto_review",
          sandboxMode: "workspace-write",
        },
      },
      fake.operations,
    )
    const combined = await dispatchRemotePayload(
      {
        type: "bridge.client_message",
        message: {
          type: "resume_session",
          sessionId: session.id,
          model: "session-only-model",
          modelReasoningEffort: "medium",
          codexSettings: {
            codexPermissionsMode: "default",
            approvalPolicy: "on-request",
            approvalsReviewer: "user",
            sandboxMode: "workspace-write",
            executionMode: "default",
          },
        },
      },
      fake.operations,
    )

    // 三种 payload 都必须各自收敛为一次 resume 调用，协议层不得拆成 model/permission 两次写入。
    expect(fake.calls).toEqual([
      {
        type: "resume",
        value: { session_id: session.id, model_id: "model-next", variant: "low" },
      },
      {
        type: "resume",
        value: { session_id: session.id, permission_mode: "autoReview" },
      },
      {
        type: "resume",
        value: {
          session_id: session.id,
          model_id: "session-only-model",
          variant: "medium",
          permission_mode: "default",
        },
      },
    ])
    expect(modelOnly[0]).toMatchObject({
      message: {
        type: "system",
        subtype: "session_created",
        model: "model-next",
        modelReasoningEffort: "low",
        codexPermissionsMode: "default",
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandboxMode: "workspace-write",
        codexSettings: { codexPermissionsMode: "default", approvalsReviewer: "user" },
      },
    })
    expect(permissionOnly[0]).toMatchObject({
      message: {
        type: "system",
        subtype: "session_created",
        model: "model",
        modelReasoningEffort: "high",
        codexPermissionsMode: "autoReview",
        approvalPolicy: "on-request",
        approvalsReviewer: "auto_review",
        sandboxMode: "workspace-write",
        codexSettings: { codexPermissionsMode: "autoReview", approvalsReviewer: "auto_review" },
      },
    })
    expect(combined[0]).toMatchObject({
      message: {
        type: "system",
        subtype: "session_created",
        model: "session-only-model",
        modelReasoningEffort: "medium",
        codexPermissionsMode: "default",
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandboxMode: "workspace-write",
        codexSettings: { codexPermissionsMode: "default", approvalsReviewer: "user" },
      },
    })
  })

  test("resume_session 区分缺省档位与显式 null", async () => {
    const fake = fakeOperations()
    const omitted = await dispatchRemotePayload(
      {
        type: "bridge.client_message",
        message: { type: "resume_session", sessionId: session.id, model: "model-next" },
      },
      fake.operations,
    )
    const cleared = await dispatchRemotePayload(
      {
        type: "bridge.client_message",
        message: {
          type: "resume_session",
          sessionId: session.id,
          model: "model-next",
          modelReasoningEffort: null,
        },
      },
      fake.operations,
    )

    // 缺省字段不能被序列化成 null；状态层据此决定沿用旧档位还是明确清空。
    expect(fake.calls).toEqual([
      { type: "resume", value: { session_id: session.id, model_id: "model-next" } },
      { type: "resume", value: { session_id: session.id, model_id: "model-next", variant: null } },
    ])
    expect(omitted[0]).toMatchObject({ message: { model: "model-next", modelReasoningEffort: "high" } })
    expect(cleared[0]).toMatchObject({ message: { model: "model-next", modelReasoningEffort: null } })
  })

  test("resume_session 在 variant 缺模型或审批组合不受支持时不进入状态层", async () => {
    const fake = fakeOperations()
    // 缺字段、错误类型、空档位及不受支持审批都在事务入口前失败，防止先应用合法的另一半设置。
    await expect(
      dispatchRemotePayload(
        {
          type: "bridge.client_message",
          message: { type: "resume_session", sessionId: session.id, modelReasoningEffort: "high" },
        },
        fake.operations,
      ),
    ).rejects.toMatchObject({ code: "set_codex_model_rejected" })
    await expect(
      dispatchRemotePayload(
        {
          type: "bridge.client_message",
          message: { type: "resume_session", sessionId: session.id, permissionMode: "" },
        },
        fake.operations,
      ),
    ).rejects.toMatchObject({ code: "set_permission_mode_rejected" })
    await expect(
      dispatchRemotePayload(
        {
          type: "bridge.client_message",
          message: { type: "resume_session", sessionId: session.id, mode: 42 },
        },
        fake.operations,
      ),
    ).rejects.toMatchObject({ code: "set_permission_mode_rejected" })
    await expect(
      dispatchRemotePayload(
        {
          type: "bridge.client_message",
          message: {
            type: "resume_session",
            sessionId: session.id,
            model: 42,
            codexSettings: { model: "model-next" },
          },
        },
        fake.operations,
      ),
    ).rejects.toMatchObject({ code: "set_codex_model_rejected" })
    await expect(
      dispatchRemotePayload(
        {
          type: "bridge.client_message",
          message: {
            type: "resume_session",
            sessionId: session.id,
            model: "model-next",
            modelReasoningEffort: "",
          },
        },
        fake.operations,
      ),
    ).rejects.toMatchObject({ code: "set_codex_model_rejected" })
    await expect(
      dispatchRemotePayload(
        {
          type: "bridge.client_message",
          message: {
            type: "resume_session",
            sessionId: session.id,
            model: "model-next",
            approvalPolicy: "never",
            approvalsReviewer: "user",
            sandboxMode: "danger-full-access",
          },
        },
        fake.operations,
      ),
    ).rejects.toMatchObject({ code: "set_permission_mode_rejected" })
    expect(fake.calls).toEqual([])
  })

  test("旧 start 的 Claude permissionMode 降级为 default 而不拒绝创建", async () => {
    const fake = fakeOperations()
    await dispatchRemotePayload(
      {
        type: "bridge.client_message",
        message: {
          type: "start",
          projectPath: session.directory,
          clientRequestId: "legacy_start",
          permissionMode: "bypassPermissions",
        },
      },
      fake.operations,
    )
    expect(fake.calls[0]).toEqual({
      type: "create",
      value: {
        directory: session.directory,
        title: undefined,
        request_id: '["bridge","legacy_start"]',
        permission_mode: "default",
      },
    })
  })

  test("recent_sessions 回显筛选上下文，不支持的 skill input 返回明确错误", async () => {
    const recent = await dispatchRemotePayload(
      {
        type: "bridge.client_message",
        message: {
          type: "list_recent_sessions",
          projectPath: session.directory,
          provider: "claude",
          requestScope: "project",
          searchQuery: "mobile",
        },
      },
      fakeOperations().operations,
    )
    expect(recent[0]).toMatchObject({
      message: {
        type: "recent_sessions",
        projectPath: session.directory,
        requestScope: "project",
        sessions: [{ sessionId: session.id }],
      },
    })
    const rejected = await dispatchRemotePayload(
      {
        type: "bridge.client_message",
        message: {
          type: "input",
          sessionId: session.id,
          clientMessageId: "mobile-skill-rejected",
          text: "use skill",
          skills: [{ name: "review" }],
        },
      },
      fakeOperations().operations,
    )
    expect(rejected).toMatchObject([
      {
        message: {
          type: "input_rejected",
          sessionId: session.id,
          clientMessageId: "mobile-skill-rejected",
          reason:
            "Remote input supports files and images, but skills, mentions, and legacy image fields are unavailable",
        },
      },
      {
        message: {
          type: "error",
          sessionId: session.id,
          errorCode: "UNSUPPORTED_INPUT_ATTACHMENT",
        },
      },
    ])
  })

  test("recent_sessions 只返回根会话，避免子代理在手机成为额外顶层会话", async () => {
    const fake = fakeOperations()
    fake.operations.listSessions = async () => [
      session,
      {
        ...session,
        id: "ses_child",
        parent_id: session.id,
        title: "Child agent",
      },
    ]

    const recent = await dispatchRemotePayload(
      {
        type: "bridge.client_message",
        message: { type: "list_recent_sessions", provider: "claude" },
      },
      fake.operations,
    )

    expect(recent[0]).toMatchObject({
      message: {
        type: "recent_sessions",
        sessions: [{ sessionId: session.id }],
      },
    })
  })

  test("reject 交给 pending permission/question 分流，旧命令明确 unsupported", async () => {
    const fake = fakeOperations()
    await dispatchRemotePayload(
      { type: "bridge.client_message", message: { type: "reject", sessionId: session.id, id: "que_1" } },
      fake.operations,
    )
    expect(fake.calls[0]).toEqual({
      type: "reject",
      value: { session_id: session.id, request_id: "que_1", message: undefined },
    })
    await expect(
      dispatchRemotePayload(
        { type: "bridge.client_message", message: { type: "git_push", projectPath: session.directory } },
        fake.operations,
      ),
    ).rejects.toEqual(new ProtocolError("unsupported_message", "git_push"))
  })

  test("实时 delta、error、permission、question 和 resolved 都携带当前 turnId", () => {
    const events = [
      { payload: { type: "message.part.delta", properties: { sessionID: session.id, field: "text", delta: "x" } } },
      {
        payload: {
          type: "session.error",
          properties: { sessionID: session.id, error: { name: "ProviderError", message: "failed" } },
        },
      },
      {
        payload: {
          type: "permission.asked",
          properties: { id: "per_1", sessionID: session.id, permission: "bash", patterns: [], metadata: {} },
        },
      },
      { payload: { type: "question.asked", properties: { id: "que_1", sessionID: session.id, questions: [] } } },
      { payload: { type: "permission.replied", properties: { requestID: "per_1", sessionID: session.id } } },
      { payload: { type: "question.rejected", properties: { requestID: "que_1", sessionID: session.id } } },
    ]
    const mapped = events.flatMap((event) => bridgeEvent(event, undefined, "msg_user"))
    expect(mapped.every((message) => message.sessionId === session.id)).toBe(true)
    expect(mapped.every((message) => message.turnId === "msg_user")).toBe(true)
    expect(
      mapped.find((message) => message.toolUseId === "per_1" && message.type === "permission_request"),
    ).toMatchObject({
      requestKind: "permission",
    })
    expect(
      mapped.find((message) => message.toolUseId === "que_1" && message.type === "permission_request"),
    ).toMatchObject({
      requestKind: "question",
    })
    expect(bridgeMessages(history).every((message) => message.sessionId === session.id)).toBe(true)
    expect(
      bridgeEvent(
        {
          payload: {
            type: "message.part.delta",
            properties: { sessionID: session.id, field: "text", delta: "thought" },
          },
        },
        "reasoning",
        "msg_user",
      )[0],
    ).toMatchObject({ type: "thinking_delta", sessionId: session.id, turnId: "msg_user" })
    expect(
      bridgeEvent(
        {
          payload: {
            type: "session.error",
            properties: { sessionID: session.id, error: { name: "ProviderError", message: "failed" } },
          },
        },
        undefined,
        "msg_user",
      )[0],
    ).toMatchObject({
      type: "error",
      errorCode: "ProviderError",
      message: "failed",
      sessionId: session.id,
      turnId: "msg_user",
    })
  })

  test("半成品文本不提前占用 messageUuid，附件、工具状态和终态发送权威消息", () => {
    expect(
      authoritativeBridgeEventReady("message.updated", {
        info: { role: "assistant", time: { created: 1 } },
      }),
    ).toBe(false)
    expect(
      authoritativeBridgeEventReady("message.part.updated", {
        part: { type: "text", text: "partial" },
      }),
    ).toBe(false)
    expect(
      authoritativeBridgeEventReady("message.part.updated", {
        part: { type: "file", mime: "image/png" },
      }),
    ).toBe(true)
    expect(
      authoritativeBridgeEventReady("message.part.updated", {
        part: { type: "tool", state: { status: "completed" } },
      }),
    ).toBe(true)
    expect(
      authoritativeBridgeEventReady("message.updated", {
        info: { role: "assistant", time: { created: 1, completed: 2 } },
      }),
    ).toBe(true)
  })

  test("relay 错误对 ccpocket 可见且 request_id 按账号和来源设备隔离", () => {
    expect(
      relayErrorPayload(
        { type: "bridge.client_message", message: { type: "input", sessionId: session.id } },
        { code: "REMOTE_CONTROL_RELAY_FORBIDDEN", message: "Device is not approved" },
      ),
    ).toMatchObject({
      type: "bridge.server_message",
      message: {
        type: "error",
        errorCode: "REMOTE_CONTROL_RELAY_FORBIDDEN",
        sessionId: session.id,
      },
    })
    expect(relayRequestKey("account_a", "mobile_a", "req_1")).toBe(relayRequestKey("account_a", "mobile_a", "req_1"))
    expect(relayRequestKey("account_a", "mobile_a", "req_1")).not.toBe(
      relayRequestKey("account_a", "mobile_b", "req_1"),
    )
    expect(relayRequestKey("account_a", "mobile_a", "req_1")).not.toBe(
      relayRequestKey("account_b", "mobile_a", "req_1"),
    )
  })
})
