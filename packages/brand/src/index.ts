import { BRANDS, type BrandId, type BrandRecord, MAIN_BRAND_ID, resolveBrandIdFromEnv } from "./table"

export { BRANDS, MAIN_BRAND_ID, resolveBrandIdFromEnv }
export type { BrandId, BrandRecord }

function resolveBrandId(): BrandId {
  // 双路径解析：
  //  - Vite/electron-vite 构建时把 VITE_BRAND 烤进 bundle（import.meta.env.VITE_BRAND）
  //  - Node 端（electron-builder.config.ts、scripts、unit test）走 process.env.WANLAICODE_BRAND
  const fromImportMeta =
    typeof import.meta !== "undefined" && (import.meta as any).env?.VITE_BRAND
  // 接受任何已注册的 brand id（不再硬卡 "wanlai" | "codex"）。typeof string 守卫是
  // 为了既兜底 `import.meta.env` 不存在（&& 短路返 false）也给后面的 `as BrandId` 类型 narrow。
  if (typeof fromImportMeta === "string" && fromImportMeta in BRANDS) return fromImportMeta as BrandId
  const fromProcess =
    typeof process !== "undefined" ? process.env?.WANLAICODE_BRAND : undefined
  return resolveBrandIdFromEnv({ WANLAICODE_BRAND: fromProcess })
}

// 模块加载时算一次缓存。后续 getBrand() 返回同一个对象，避免 React/Solid 频繁重算。
const RESOLVED: BrandRecord = BRANDS[resolveBrandId()]
Object.freeze(RESOLVED)

export function getBrand(): BrandRecord {
  return RESOLVED
}

export function brandNameCn(): string {
  return RESOLVED.nameCn
}

export function brandNameEn(): string {
  return RESOLVED.nameEn
}

/**
 * Locale-aware brand name：zh-* locale 用 CN，其他 locale 用 EN。
 * 用于 i18n placeholder 注入。
 * `zh` prefix 故意宽松，覆盖 zh / zh-CN / zh-Hans / zh-Hant / zh-TW / zh-HK / zh-yue 全部中文变体。
 */
export function brandNameForLocale(locale: string): string {
  return locale.toLowerCase().startsWith("zh") ? RESOLVED.nameCn : RESOLVED.nameEn
}
