import { describe, expect, it } from "bun:test"
import {
  BRANDS,
  type BrandRecord,
  brandNameCn,
  brandNameEn,
  brandNameForLocale,
  getBrand,
  MAIN_BRAND_ID,
  resolveBrandIdFromEnv,
} from "./index"

describe("brand", () => {
  it("defaults to wanlai when VITE_BRAND not set", () => {
    expect(getBrand().id).toBe("wanlai")
    expect(brandNameCn()).toBe("万来Code")
    expect(brandNameEn()).toBe("WanLaiCode")
  })

  it("brandNameForLocale switches by locale prefix", () => {
    expect(brandNameForLocale("zh-CN")).toBe("万来Code")
    expect(brandNameForLocale("en-US")).toBe("WanLaiCode")
    expect(brandNameForLocale("zh-Hant")).toBe("万来Code")
    expect(brandNameForLocale("de-DE")).toBe("WanLaiCode")
  })

  it("brand info exposes URL scheme", () => {
    expect(getBrand().urlScheme).toBe("wanlaicode")
  })
})

describe("brand registry openness", () => {
  it("falls back to MAIN_BRAND_ID when env value is not a registered brand", () => {
    // 模块加载时缓存 RESOLVED，不能在测试里改 env 直接观察；这里测纯函数 resolveBrandIdFromEnv
    expect(resolveBrandIdFromEnv({ WANLAICODE_BRAND: "this-does-not-exist" })).toBe("wanlai")
    expect(resolveBrandIdFromEnv({ WANLAICODE_BRAND: undefined })).toBe("wanlai")
    expect(resolveBrandIdFromEnv({})).toBe("wanlai")
  })

  it("accepts any registered brand id from env", () => {
    expect(resolveBrandIdFromEnv({ WANLAICODE_BRAND: "wanlai" })).toBe("wanlai")
    expect(resolveBrandIdFromEnv({ WANLAICODE_BRAND: "codex" })).toBe("codex")
  })

  it("MAIN_BRAND_ID points at a registered brand", () => {
    expect(BRANDS[MAIN_BRAND_ID]).toBeDefined()
  })

  it("codex entry carries ui.footerShowUpgrade flag", () => {
    expect(BRANDS.codex.ui?.footerShowUpgrade).toBe(true)
    // wanlai 没设 ui，记录类型也不暴露这个 key —— 走 BrandRecord lens 验证缺省
    const wanlaiAsRecord: BrandRecord = BRANDS.wanlai
    expect(wanlaiAsRecord.ui).toBeUndefined()
  })

  it("each brand declares its own backend endpoint", () => {
    expect(BRANDS.wanlai.backend.apiBase).toBe("https://api.wanlai.ai/v1")
    expect(BRANDS.wanlai.backend.siteUrl).toBe("https://wanlai.ai")
    expect(BRANDS.codex.backend.apiBase).toBe("https://api2.wanlai.ai/v1")
    expect(BRANDS.codex.backend.siteUrl).toBe("https://codex.wanlai.ai")
    expect(BRANDS.wanlai.backend.registryUrl).toBe("https://plugin.wanlai.ai")
    expect(BRANDS.codex.backend.registryUrl).toBe("https://plugin.wanlai.ai")
  })
})
