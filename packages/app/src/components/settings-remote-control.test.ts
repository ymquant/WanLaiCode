import { describe, expect, test } from "bun:test"
import {
  nextRemoteControlAuthExpiredBoundary,
  nextRemoteControlPendingPairing,
  remoteControlAccountReady,
  remoteControlAccountState,
  remoteControlPairingDialogCanClose,
  remoteControlPairingDialogView,
  remoteControlVisibleState,
} from "./settings-remote-control"

describe("settings remote control auth projection", () => {
  test("只有 OAuth 账号登录可以创建手机配对", () => {
    // API Key 能调用模型但没有用户身份，不能被误判为手机远控登录。
    expect(remoteControlAccountReady({ authenticated: true, auth_type: "oauth" })).toBe(true)
    expect(remoteControlAccountReady({ authenticated: true, auth_type: "api" })).toBe(false)
    expect(remoteControlAccountReady({ authenticated: true })).toBe(false)
    expect(remoteControlAccountReady({ authenticated: false })).toBe(false)
  })

  test("账号状态请求失败时显示连接异常而不是未登录", () => {
    // 请求失败时旧 OAuth 缓存也不再可信，必须禁止配对并显示可重试的连接异常。
    expect(remoteControlAccountState(undefined, true, false)).toBe("loading")
    expect(remoteControlAccountState(undefined, false, true)).toBe("error")
    expect(remoteControlAccountState({ authenticated: true, auth_type: "oauth" }, false, true)).toBe("error")
    expect(remoteControlAccountState({ authenticated: false, oauth_reauth_required: true }, false, false)).toBe(
      "reauth_required",
    )
    // auth.expired 事件应立即压过仍在缓存中的成功响应，不等待 refetch 才关闭配对入口。
    expect(remoteControlAccountState({ authenticated: true, auth_type: "oauth" }, false, false, true)).toBe(
      "reauth_required",
    )
  })

  test("账号已登录时不把网关待恢复状态显示成未登录", () => {
    // 网关会在后台恢复连接，同时保留远控认证异常的真实语义，不能伪装成普通未连接。
    expect(remoteControlVisibleState("auth_required", "ready")).toBe("remote_auth_required")
    expect(remoteControlVisibleState("auth_required", "auth_required")).toBe("auth_required")
    expect(remoteControlVisibleState("disconnected", "reauth_required")).toBe("remote_auth_required")
  })

  test("重新登录后的新轮询响应会解除撤权边界", () => {
    // 事件前缓存和失败轮询都保持锁定，只有 dataUpdatedAt 前进后的有效 OAuth 响应可以恢复配对。
    const base = {
      current: true,
      boundaryUpdatedAt: 100,
      status: { authenticated: true, auth_type: "oauth" as const },
    }
    expect(nextRemoteControlAuthExpiredBoundary({ ...base, dataUpdatedAt: 100, failed: false })).toBe(true)
    expect(nextRemoteControlAuthExpiredBoundary({ ...base, dataUpdatedAt: 101, failed: true })).toBe(true)
    expect(nextRemoteControlAuthExpiredBoundary({ ...base, dataUpdatedAt: 101, failed: false })).toBe(false)
  })

  test("明确撤权时不被网关连接缓存覆盖", () => {
    // 连接 socket 仍可能短暂存在，但凭据已经失效时必须先显示重新认证。
    expect(remoteControlVisibleState("connected", "reauth_required")).toBe("remote_auth_required")
    expect(remoteControlVisibleState("connected", "auth_required")).toBe("connected")
    expect(remoteControlVisibleState("connecting", "reauth_required")).toBe("remote_auth_required")
    expect(remoteControlVisibleState("error", "loading")).toBe("error")
    expect(remoteControlVisibleState(undefined, "ready", true)).toBe("connecting")
    // 首次网关请求失败没有缓存 state，必须显示错误并由组件禁用配对操作。
    expect(remoteControlVisibleState(undefined, "ready", false, true)).toBe("error")
  })
})

describe("settings remote control pairing dialog", () => {
  const first = { pairing_id: "pairing-1", name: "Android phone", platform: "android" }
  const second = { pairing_id: "pairing-2", name: "iPhone", platform: "ios" }

  test("同一弹窗从有效二维码切换到对应设备授权", () => {
    // 其他配对请求不能抢占当前二维码；只有相同 ID 的 claim 才能切换为允许连接。
    expect(
      remoteControlPairingDialogView({ pairingID: first.pairing_id, expiresIn: 60, pendingPairings: [second] }),
    ).toEqual({ kind: "qr" })
    expect(
      remoteControlPairingDialogView({
        pairingID: first.pairing_id,
        expiresIn: 60,
        pendingPairings: [second, first],
      }),
    ).toEqual({ kind: "pending", pairing: first })
  })

  test("二维码过期后结束弹窗，但已扫码请求仍可确认", () => {
    // pending 已由手机持有一次性密钥，倒计时恰好归零时仍应优先展示明确的允许或拒绝操作。
    expect(
      remoteControlPairingDialogView({ pairingID: first.pairing_id, expiresIn: 0, pendingPairings: [first] }),
    ).toEqual({ kind: "pending", pairing: first })
    expect(
      remoteControlPairingDialogView({ pairingID: first.pairing_id, expiresIn: 0, pendingPairings: [] }),
    ).toEqual({ kind: "expired" })
  })

  test("秒级轮询不会重复打开同一请求，并按队列顺序处理后续设备", () => {
    // 正在显示或执行关闭动画时不再抢占；旧栈真正退出后跳过已展示 ID，选择下一个未处理请求。
    expect(nextRemoteControlPendingPairing([first, second], new Set(), first.pairing_id)).toBeUndefined()
    expect(
      nextRemoteControlPendingPairing(
        [first, second],
        new Set([first.pairing_id]),
        undefined,
        "dialog-first",
        "dialog-first",
      ),
    ).toBeUndefined()
    expect(
      nextRemoteControlPendingPairing(
        [first, second],
        new Set([first.pairing_id]),
        undefined,
        "dialog-first",
        "settings-dialog",
      ),
    ).toEqual(second)
    expect(nextRemoteControlPendingPairing([first], new Set([first.pairing_id]))).toBeUndefined()
  })

  test("旧审批完成回调不能关闭后来打开的设备弹窗", () => {
    // pairing 或 stack 任一不匹配都说明当前已不是原弹窗，异步完成回调必须失效。
    expect(
      remoteControlPairingDialogCanClose({
        pairingID: first.pairing_id,
        activePairingID: first.pairing_id,
        pairingDialogStackID: "dialog-first",
        activeDialogStackID: "dialog-first",
      }),
    ).toBe(true)
    expect(
      remoteControlPairingDialogCanClose({
        pairingID: first.pairing_id,
        activePairingID: second.pairing_id,
        pairingDialogStackID: "dialog-second",
        activeDialogStackID: "dialog-second",
      }),
    ).toBe(false)
    expect(
      remoteControlPairingDialogCanClose({
        pairingID: first.pairing_id,
        activePairingID: first.pairing_id,
        pairingDialogStackID: "dialog-first",
        activeDialogStackID: "dialog-second",
      }),
    ).toBe(false)
  })
})
