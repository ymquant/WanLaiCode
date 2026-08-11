import { describe, expect, test } from "bun:test"
import {
  REMOTE_CONTROL_STATUS_QUERY_KEY,
  REMOTE_CONTROL_STATUS_REFETCH_INTERVAL_MS,
  remoteControlPhonePresence,
} from "./remote-control"

describe("remote control phone presence", () => {
  test("未完成首次请求或没有绑定设备时不显示状态点", () => {
    // 手机入口始终可用，但隐藏态不能在首次请求期间错误闪现灰色离线点。
    expect(remoteControlPhonePresence()).toBe("hidden")
    expect(remoteControlPhonePresence([])).toBe("hidden")
  })

  test("已绑定设备全部离线时显示手机离线", () => {
    // 多台历史绑定设备都没有有效 presence 租约时，聚合状态必须保持离线。
    expect(remoteControlPhonePresence([{ online: false }, { online: false }])).toBe("offline")
  })

  test("任一已绑定设备在线时显示手机在线", () => {
    // 一台手机在线即可接收桌面消息，不能被同账号下其他离线手机覆盖。
    expect(remoteControlPhonePresence([{ online: false }, { online: true }])).toBe("online")
    expect(remoteControlPhonePresence([{ online: true }, { online: false }])).toBe("online")
  })

  test("主工具栏与设置页共享同一秒级状态查询", () => {
    // 固定共享 key 和轮询间隔，避免两个入口逐步演化出不同的在线状态。
    expect(REMOTE_CONTROL_STATUS_QUERY_KEY).toEqual(["remote-control", "status"])
    expect(REMOTE_CONTROL_STATUS_REFETCH_INTERVAL_MS).toBe(1_000)
  })
})
