// Plugin marketplace stats(安装次数 / 评分 / 评价数)。
// 当前: 按 addonKey 哈希生成稳定 mock(同一插件刷新前后数字一致)。
// 未来: 把 mockStatsFor 换成调真实后端 API(可能是 GET /addon/:key/stats 或 marketplace
// 元数据接口附带)。调用方签名不变 —— UI 不用改。

export interface MarketplaceStats {
  /** 总安装次数 */
  installs: number
  /** 平均评分 0..5,一位小数 */
  rating: number
  /** 评价总数 */
  reviewCount: number
}

// 用一个简单 FNV-1a-ish 32 位 hash 做种子,稳定且零依赖。
function hashSeed(input: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

// mulberry32 PRNG —— 给定 seed 得到稳定的 0..1 序列
function mulberry32(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6D2B79F5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1) >>> 0
    t ^= (t + Math.imul(t ^ (t >>> 7), t | 61)) >>> 0
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * 根据 addon key 生成稳定 mock stats。同一 key 多次调用结果一致,
 * 不同 key 在合理范围内分布(安装数 log-scale,评分偏正态)。
 */
export function mockStatsFor(addonKey: string): MarketplaceStats {
  const rand = mulberry32(hashSeed(addonKey))
  // 安装数 log-scale 分布在 5e2 .. 3e6 之间,长尾感更接近真实 marketplace
  const installs = Math.round(Math.exp(rand() * (Math.log(3_000_000) - Math.log(500)) + Math.log(500)))
  // 评分 3.6 .. 4.9,主要集中在 4+
  const rating = Math.round((3.6 + rand() * 1.3) * 10) / 10
  // 评价数 ~ 0.5% - 5% 安装数,且至少 5 条
  const reviewRate = 0.005 + rand() * 0.045
  const reviewCount = Math.max(5, Math.round(installs * reviewRate))
  return { installs, rating, reviewCount }
}

/** 千分位 + K/M 简写。例: 1234 -> "1.2K"; 1500000 -> "1.5M"; 950 -> "950" */
export function formatInstallCount(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) {
    const k = n / 1000
    return `${k >= 10 ? Math.round(k) : k.toFixed(1).replace(/\.0$/, "")}K`
  }
  const m = n / 1_000_000
  return `${m >= 10 ? Math.round(m) : m.toFixed(1).replace(/\.0$/, "")}M`
}

/** 评价数简写规则同 install 但保留小数更克制一些 */
export function formatReviewCount(n: number): string {
  return formatInstallCount(n)
}

/** 后端把数字字段序列化为 number | "NaN" | "Infinity" | "-Infinity"，这里规范化为有限数。 */
export function finiteNum(v: number | string): number {
  return typeof v === "number" && isFinite(v) ? v : 0
}
