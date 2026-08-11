import { describe, expect, test } from "bun:test"

import {
  assertFinalized,
  buildCopySource,
  extractVersion,
  isPerArchManifest,
  isTopLevelLiveManifest,
  isUpdaterManifest,
  normalizeVersion,
} from "./promote-s3"

describe("normalizeVersion", () => {
  test("去掉前缀 v", () => {
    expect(normalizeVersion("v1.2.3")).toBe("1.2.3")
  })
  test("裸版本恒等（发布链路）", () => {
    expect(normalizeVersion("1.2.3")).toBe("1.2.3")
  })
  test("去首尾空白再去 v", () => {
    expect(normalizeVersion("  v0.0.10 ")).toBe("0.0.10")
  })
  test("只去最前面一个 v，不动版本里其它字符", () => {
    expect(normalizeVersion("v1.2.3-beta")).toBe("1.2.3-beta")
  })
})

describe("isUpdaterManifest", () => {
  test("latest*.yml / *.json 是 manifest", () => {
    expect(isUpdaterManifest("prod/1.2.0/latest.yml")).toBe(true)
    expect(isUpdaterManifest("prod/1.2.0/latest-mac.yml")).toBe(true)
    expect(isUpdaterManifest("prod/1.2.0/latest-linux-arm64.yml")).toBe(true)
    expect(isUpdaterManifest("prod/1.2.0/latest-mac.json")).toBe(true)
  })
  test("安装包 / blockmap 不是 manifest", () => {
    expect(isUpdaterManifest("prod/1.2.0/WanLaiCode.dmg")).toBe(false)
    expect(isUpdaterManifest("prod/1.2.0/WanLaiCode.dmg.blockmap")).toBe(false)
    expect(isUpdaterManifest("prod/1.2.0/WanLaiCode.exe")).toBe(false)
  })
  test("需要 / 前缀，避免顶层裸文件误判", () => {
    expect(isUpdaterManifest("latest.yml")).toBe(false)
  })
})

describe("isPerArchManifest", () => {
  test("带 arch 后缀的 per-arch yml 命中（未 finalize）", () => {
    expect(isPerArchManifest("latest-mac-x86_64.yml")).toBe(true)
    expect(isPerArchManifest("latest-mac-aarch64.yml")).toBe(true)
    expect(isPerArchManifest("latest-x86_64.yml")).toBe(true)
    expect(isPerArchManifest("latest-linux-x86_64.yml")).toBe(true)
  })
  test("合法标准名不误伤 —— 尤其 latest-linux-arm64.yml（arm64 ≠ aarch64）", () => {
    expect(isPerArchManifest("latest.yml")).toBe(false)
    expect(isPerArchManifest("latest-mac.yml")).toBe(false)
    expect(isPerArchManifest("latest-linux.yml")).toBe(false)
    expect(isPerArchManifest("latest-linux-arm64.yml")).toBe(false)
  })
  test("非 yml / 安装包不命中", () => {
    expect(isPerArchManifest("latest-mac.json")).toBe(false)
    expect(isPerArchManifest("WanLaiCode.dmg")).toBe(false)
  })
})

describe("isTopLevelLiveManifest", () => {
  test("顶层 latest*.yml 命中", () => {
    expect(isTopLevelLiveManifest("latest.yml")).toBe(true)
    expect(isTopLevelLiveManifest("latest-mac.yml")).toBe(true)
    expect(isTopLevelLiveManifest("latest-linux-arm64.yml")).toBe(true)
  })
  test("子目录副本（含 /）排除 —— staging 版本目录里的 latest 不算 live", () => {
    expect(isTopLevelLiveManifest("1.2.0/latest.yml")).toBe(false)
  })
  test("非 yml 不命中", () => {
    expect(isTopLevelLiveManifest("WanLaiCode.dmg")).toBe(false)
    expect(isTopLevelLiveManifest("latest-mac.json")).toBe(false)
  })
})

describe("buildCopySource", () => {
  test("形如 /bucket/key，percent-encode 但保留 /", () => {
    expect(buildCopySource("bkt", "prod/1.2.0/WanLaiCode.dmg")).toBe("/bkt/prod/1.2.0/WanLaiCode.dmg")
  })
  test("对空格等字符编码，路径分隔 / 不被编码", () => {
    expect(buildCopySource("bkt", "prod/1.2.0/a b.dmg")).toBe("/bkt/prod/1.2.0/a%20b.dmg")
  })
})

describe("assertFinalized", () => {
  const prefix = "prod/1.2.0/"
  test("残留 per-arch yml → 抛错，文案含具体文件名", () => {
    expect(() =>
      assertFinalized([`${prefix}latest-mac-x86_64.yml`, `${prefix}WanLaiCode.dmg`], prefix, "bkt"),
    ).toThrow(/latest-mac-x86_64\.yml/)
  })
  test("已 finalize 的标准 staging → 不抛（含 latest-linux-arm64.yml 不误伤）", () => {
    expect(() =>
      assertFinalized(
        [
          `${prefix}latest.yml`,
          `${prefix}latest-mac.yml`,
          `${prefix}latest-linux-arm64.yml`,
          `${prefix}WanLaiCode.dmg`,
        ],
        prefix,
        "bkt",
      ),
    ).not.toThrow()
  })
})

describe("extractVersion", () => {
  test("抓行首 version 字段", () => {
    expect(extractVersion("version: 1.3.0\nfiles:\n  - url: a")).toBe("1.3.0")
  })
  test("无 version 行返回 <unknown>", () => {
    expect(extractVersion("files:\n  - url: a")).toBe("<unknown>")
  })
})
