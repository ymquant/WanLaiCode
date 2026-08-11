import { describe, expect, test } from "bun:test"

import { buildCopySource, deriveDestKey, normalizeVersion } from "./stage-canary-to-prod-s3"

describe("normalizeVersion", () => {
  test("去掉前缀 v", () => {
    expect(normalizeVersion("v1.2.3")).toBe("1.2.3")
  })
  test("裸版本恒等", () => {
    expect(normalizeVersion("1.2.3")).toBe("1.2.3")
  })
  test("去首尾空白再去 v", () => {
    expect(normalizeVersion("  v0.0.25 ")).toBe("0.0.25")
  })
})

describe("buildCopySource", () => {
  test("形如 /bucket/key，percent-encode 但保留 /", () => {
    expect(buildCopySource("bkt", "canary/0.0.25/WanLaiCode.dmg")).toBe("/bkt/canary/0.0.25/WanLaiCode.dmg")
  })
  test("对空格等字符编码，路径分隔 / 不被编码", () => {
    expect(buildCopySource("bkt", "canary/0.0.25/a b.dmg")).toBe("/bkt/canary/0.0.25/a%20b.dmg")
  })
})

describe("deriveDestKey（canary/<version>/ → prod/<version>/，保留版本子路径）", () => {
  const srcPrefix = "canary/0.0.25/"
  const destPrefix = "prod/0.0.25/"

  test("安装包：换通道前缀，版本子路径与文件名保留", () => {
    expect(deriveDestKey(`${srcPrefix}WanLaiCode.dmg`, srcPrefix, destPrefix)).toBe("prod/0.0.25/WanLaiCode.dmg")
  })
  test("manifest：latest*.yml 同样落 prod/<version>/", () => {
    expect(deriveDestKey(`${srcPrefix}latest-mac.yml`, srcPrefix, destPrefix)).toBe("prod/0.0.25/latest-mac.yml")
  })
  test("不落 prod/ 根（与直接转正区分）—— 仍带版本子目录", () => {
    const dest = deriveDestKey(`${srcPrefix}latest.yml`, srcPrefix, destPrefix)
    expect(dest.startsWith("prod/0.0.25/")).toBe(true)
    expect(dest).not.toBe("prod/latest.yml")
  })
})
