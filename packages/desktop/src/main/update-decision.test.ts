import { describe, expect, test } from "bun:test"

import { resolveUpdateDecision } from "./update-decision"

describe("resolveUpdateDecision", () => {
  test("无已下载、远端有可用更新 → 下载远端版本", () => {
    expect(
      resolveUpdateDecision({ downloaded: undefined, remoteVersion: "0.0.21", remoteAvailable: true }),
    ).toEqual({ action: "download", version: "0.0.21" })
  })

  test("无已下载、远端无可用更新 → 不更新", () => {
    expect(
      resolveUpdateDecision({ downloaded: undefined, remoteVersion: "0.0.20", remoteAvailable: false }),
    ).toEqual({ action: "none" })
  })

  // 核心回归：已下载中间版本后线上又发了更新版本，必须顶替而不是返回旧的已下载版本。
  test("已下载 0.0.21、远端已是 0.0.22 → 顶替并下载 0.0.22", () => {
    expect(
      resolveUpdateDecision({ downloaded: "0.0.21", remoteVersion: "0.0.22", remoteAvailable: true }),
    ).toEqual({ action: "download", version: "0.0.22", supersedes: "0.0.21" })
  })

  test("已下载 0.0.21、远端仍是 0.0.21 → 沿用已下载缓存，不重复下载", () => {
    expect(
      resolveUpdateDecision({ downloaded: "0.0.21", remoteVersion: "0.0.21", remoteAvailable: true }),
    ).toEqual({ action: "use-cached", version: "0.0.21" })
  })

  test("已下载 0.0.21、远端报无可用更新（如回滚到当前版本）→ 沿用已下载缓存，不降级", () => {
    expect(
      resolveUpdateDecision({ downloaded: "0.0.21", remoteVersion: "0.0.20", remoteAvailable: false }),
    ).toEqual({ action: "use-cached", version: "0.0.21" })
  })

  test("已下载、远端版本缺失 → 沿用已下载缓存", () => {
    expect(
      resolveUpdateDecision({ downloaded: "0.0.21", remoteVersion: undefined, remoteAvailable: true }),
    ).toEqual({ action: "use-cached", version: "0.0.21" })
  })
})
