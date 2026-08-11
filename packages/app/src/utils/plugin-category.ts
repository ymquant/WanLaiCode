// 插件分类(category)是第三方 marketplace / 官方 registry 的 manifest 自由文本字段,
// 后端(本地与远程 registry)都不本地化它——locale 协商只覆盖 display_name / description。
// 这里按「规范化名 → i18n key」做尽力翻译,未收录的分类回退英文原文(与汉化前一致),
// 不会因 registry 新增分类而显示 key 名或空白。键用小写,匹配前对原始值做 trim + 小写 + 折叠空格。
const CATEGORY_KEY = {
  "business & operations": "plugins.category.business",
  communication: "plugins.category.communication",
  creativity: "plugins.category.creativity",
  "data & analytics": "plugins.category.dataAnalytics",
  design: "plugins.category.design",
  "developer tools": "plugins.category.developerTools",
  "education & research": "plugins.category.education",
  engineering: "plugins.category.engineering",
  finance: "plugins.category.finance",
  lifestyle: "plugins.category.lifestyle",
  other: "plugins.category.other",
  productivity: "plugins.category.productivity",
  research: "plugins.category.research",
  security: "plugins.category.security",
  travel: "plugins.category.travel",
} as const

export type PluginCategoryKey = (typeof CATEGORY_KEY)[keyof typeof CATEGORY_KEY]

function normalize(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, " ")
}

// 已知分类返回其 i18n key;未收录返回 undefined。
export function pluginCategoryKey(raw: string): PluginCategoryKey | undefined {
  return CATEGORY_KEY[normalize(raw) as keyof typeof CATEGORY_KEY]
}

// 把原始分类文本翻成展示标签:已知分类走 translate,未知分类回退原文。
export function pluginCategoryLabel(
  raw: string,
  translate: (key: PluginCategoryKey) => string,
): string {
  const key = pluginCategoryKey(raw)
  return key ? translate(key) : raw
}
