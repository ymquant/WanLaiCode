// Brand metadata 单 source of truth：所有 brand 字面量集中在 BRANDS map，
// 加新 brand = 加一条 entry + 在下游加 logo 组件 + 在 publish-subbrand.yml 的 choice 加一行。
//
// 这个文件**纯数据 + Node-loadable**：模块顶不能 import.meta、不能浏览器 API。
// `brand/index.ts` 在它之上叠一层 Vite-injected env 解析（前端运行时用）。

export interface BrandRecord {
  /** Env key (WANLAICODE_BRAND) 和 map key，也是 default iconDirName */
  id: string
  /** 中文显示名（macOS Dock / Windows 任务栏 / 应用内 CN locale） */
  nameCn: string
  /** 英文显示名 */
  nameEn: string
  /** URL scheme —— 所有 brand 共享 wanlaicode://（appId 一致互装即覆盖） */
  urlScheme: string
  /** electron-builder artifactName 文件名前缀（ASCII-only：GH Release API 丢非 ASCII） */
  artifactPrefix: string
  /**
   * OS-level icon source dir under packages/desktop/icons/.
   * 默认行为（未设时）：
   *  - main brand：按 channel 选 dev/beta/prod（兼容历史）
   *  - sub-brand：用 id 当 dir 名
   * 显式 override 用于例如同一 brand 几套 icon 共用一个目录的场景。
   */
  iconDirName?: string
  /**
   * UI 行为 flag。每加一个 brand-specific UI 分支就抽到这里数据化。
   */
  ui?: {
    /** 侧边栏右下角入口替换为"升级"按钮（代替 brand mark + 名字） */
    footerShowUpgrade?: boolean
  }
  /**
   * 鉴权 + API endpoint。opencode 的 WanlaiCodeAuth.defaultConfig 直接 import
   * getBrand() 拿这里的值；CLI 单跑没设 WANLAICODE_BRAND 时 fallback 到主 brand。
   */
  backend: {
    /** API endpoint（含 /v1） */
    apiBase: string
    /** 鉴权 + 用户中心 site URL */
    siteUrl: string
    /** 插件市场后端 host root（不含 /api/v1）；未设时由 wanlaicode.ts 从 apiBase 派生 */
    registryUrl?: string
  }
}

export const BRANDS = {
  wanlai: {
    id: "wanlai",
    nameCn: "万来Code",
    nameEn: "WanLaiCode",
    urlScheme: "wanlaicode",
    artifactPrefix: "WanLaiCode",
    // iconDirName 不设 —— 走 channel 兜底
    backend: {
      apiBase: "https://api.wanlai.ai/v1",
      siteUrl: "https://wanlai.ai",
      registryUrl: "https://plugin.wanlai.ai",
    },
  },
  codex: {
    id: "codex",
    nameCn: "Codex（万来）",
    nameEn: "Codex (Wanlai)",
    urlScheme: "wanlaicode",
    artifactPrefix: "CodexWanLai",
    iconDirName: "codex",
    ui: {
      footerShowUpgrade: true,
    },
    backend: {
      apiBase: "https://api2.wanlai.ai/v1",
      siteUrl: "https://codex.wanlai.ai",
      registryUrl: "https://plugin.wanlai.ai",
    },
  },
} as const satisfies Record<string, BrandRecord>

Object.freeze(BRANDS.wanlai)
Object.freeze(BRANDS.codex)
Object.freeze(BRANDS)

/**
 * 主品牌 id：full publish workflow 跑的那个；同时是 brand 解析的 default fallback
 * （env 没传或传了不认识的值都走它）。
 */
export const MAIN_BRAND_ID = "wanlai" as const

export type BrandId = keyof typeof BRANDS

/**
 * 从 env 解析 brand id。env 值是注册表里的 key 才接受；否则 fallback MAIN_BRAND_ID。
 * 这样未来加 brand 只需要往 BRANDS 加 entry，env 解析不用动。
 */
export function resolveBrandIdFromEnv(env: { WANLAICODE_BRAND?: string | undefined }): BrandId {
  const raw = env.WANLAICODE_BRAND
  if (raw && raw in BRANDS) return raw as BrandId
  return MAIN_BRAND_ID
}
