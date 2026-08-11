import { describe, expect, test } from "bun:test"

import { isBrandInstaller, isReleaseArtifact } from "./upload-staging-s3"

const WANLAI = "WanLaiCode"
const CODEX = "CodexWanLai"

describe("isReleaseArtifact 放行本 brand 的安装包", () => {
  test.each([
    "WanLaiCode-desktop-win-x64.exe",
    "WanLaiCode-desktop-mac-arm64.dmg",
    "WanLaiCode-desktop-mac-arm64.zip",
    "WanLaiCode-desktop-mac-x64.dmg",
    "WanLaiCode-desktop-linux-x86_64.AppImage",
    "WanLaiCode-desktop-linux-amd64.deb",
    "WanLaiCode-desktop-linux-x86_64.rpm",
  ])("%s", (name) => {
    expect(isReleaseArtifact(name, WANLAI)).toBe(true)
  })

  // blockmap 是安装包名后再缀 .blockmap，前缀与后缀两条判断都要过
  test("blockmap 带完整安装包名前缀", () => {
    expect(isReleaseArtifact("WanLaiCode-desktop-win-x64.exe.blockmap", WANLAI)).toBe(true)
  })
})

describe("isReleaseArtifact 放行 updater 元数据（不带 brand 前缀）", () => {
  test.each(["latest.yml", "latest-mac.yml", "latest-linux.yml", "latest-x86_64.yml", "latest-mac-aarch64.yml"])(
    "%s",
    (name) => {
      expect(isReleaseArtifact(name, WANLAI)).toBe(true)
    },
  )
})

describe("isReleaseArtifact 拦截跨 brand 残留", () => {
  // Windows 是 clean:false，dist/ 会留着上一次别的 brand 构建的安装包。
  // v0.1.5 发版就是这样把 CodexWanLai 的包混进了主 brand 的 canary/ 通道。
  test.each([
    "CodexWanLai-desktop-win-x64.exe",
    "CodexWanLai-desktop-win-x64.exe.blockmap",
    "CodexWanLai-desktop-mac-arm64.dmg",
  ])("%s 不进主 brand 通道", (name) => {
    expect(isReleaseArtifact(name, WANLAI)).toBe(false)
  })

  test("反向同样成立：子 brand 构建不带走主 brand 的包", () => {
    expect(isReleaseArtifact("WanLaiCode-desktop-win-x64.exe", CODEX)).toBe(false)
    expect(isReleaseArtifact("CodexWanLai-desktop-win-x64.exe", CODEX)).toBe(true)
    // updater 元数据两个 brand 都放行——文件名本就不带 brand
    expect(isReleaseArtifact("latest.yml", CODEX)).toBe(true)
  })
})

describe("isReleaseArtifact 拦截非 release 产物", () => {
  test.each(["builder-effective-config.yaml", "builder-debug.yml", "WanLaiCode-something.txt"])(
    "%s",
    (name) => {
      expect(isReleaseArtifact(name, WANLAI)).toBe(false)
    },
  )
})

describe("isReleaseArtifact 前缀匹配以 - 为界", () => {
  // 防 startsWith 误判：若不带分隔符，"WanLaiCode" 会把 "WanLaiCodeX" 的产物一并放行
  test("前缀是另一名字的真前缀时必须拦截", () => {
    expect(isReleaseArtifact("WanLaiCodeX-desktop-win-x64.exe", WANLAI)).toBe(false)
  })
  test("恰好等于前缀但无分隔符也拦截", () => {
    expect(isReleaseArtifact("WanLaiCode.exe", WANLAI)).toBe(false)
  })
})

// "过滤后一个安装包都不剩" 是比误放行更危险的形态：发版全绿、release 与 S3 都没有安装包，
// electron-updater 用户拿到指向不存在文件的 latest.yml。isReleaseArtifact 对不带前缀的
// latest*.yml 无条件放行、dist/ 里恒有它，所以 files.length > 0 拦不住这种情况，
// 必须另有一个"安装包本体"判据。
describe("isBrandInstaller 只认本 brand 的安装包本体", () => {
  test.each([
    "WanLaiCode-desktop-win-x64.exe",
    "WanLaiCode-desktop-mac-arm64.dmg",
    "WanLaiCode-desktop-mac-arm64.zip",
    "WanLaiCode-desktop-linux-x64.AppImage",
    "WanLaiCode-desktop-linux-x64.deb",
    "WanLaiCode-desktop-linux-x64.rpm",
  ])("放行 %s", (name) => {
    expect(isBrandInstaller(name, WANLAI)).toBe(true)
  })

  // updater 元数据与差异块不是安装包本体：只剩它们时守卫必须判定为"没有安装包"。
  test.each(["latest.yml", "latest-mac.yml", "latest-linux.yml", "latest.json"])("排除 updater 元数据 %s", (name) => {
    expect(isBrandInstaller(name, WANLAI)).toBe(false)
  })

  test("排除 blockmap（依附安装包，不能单独充数）", () => {
    expect(isBrandInstaller("WanLaiCode-desktop-win-x64.exe.blockmap", WANLAI)).toBe(false)
  })

  test("排除别的 brand 的安装包", () => {
    expect(isBrandInstaller("CodexWanLai-desktop-win-x64.exe", WANLAI)).toBe(false)
    expect(isBrandInstaller("WanLaiCode-desktop-win-x64.exe", CODEX)).toBe(false)
  })

  // 命名模板一旦漂移（分隔符/desktop 段改动），前缀过滤会退化成空集，
  // 这正是守卫要抓的场景。
  test("前缀对但命名漂移到不带 - 分隔符时不算安装包", () => {
    expect(isBrandInstaller("WanLaiCode.exe", WANLAI)).toBe(false)
  })

  // 真实故障形态的复现：dist/ 里只剩 updater 元数据 + 别的 brand 的包。
  test("只剩元数据与跨 brand 残留时，本 brand 没有任何安装包", () => {
    const dist = ["latest.yml", "latest-mac.yml", "CodexWanLai-desktop-win-x64.exe"]
    expect(dist.some((name) => isBrandInstaller(name, WANLAI))).toBe(false)
    // 而按 isReleaseArtifact 过滤后数组非空 —— 单靠它无法发现问题。
    expect(dist.filter((name) => isReleaseArtifact(name, WANLAI)).length).toBeGreaterThan(0)
  })
})
