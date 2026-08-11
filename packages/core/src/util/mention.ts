/**
 * 提及(mention)scheme 的统一、可扩展解析/构造层。
 * 纯文本处理,不依赖任何 Node.js / 平台特定库,可安全用于浏览器端。
 *
 * 本层只覆盖「以内联 markdown 链接 `[<sigil>label](<scheme>://<id>)` 出现在 wire 文本里」
 * 的提及。当前仅 plugin;未来若 app/mcp/skill 也走内联链接,只需在 MENTION_SCHEMES 加一行,
 * 解析 / 构造 / 分类全部自动覆盖。
 * 注意:file/agent 走独立 RequestPart、command 走专用 API、skill 走 `/name`+metadata,
 * 它们不是内联链接,刻意不纳入本层。
 */

/** 内联提及链接的 scheme 注册表(单一来源)。每项 = { 前缀, sigil }。 */
export const MENTION_SCHEMES = {
  plugin: { prefix: "plugin://", sigil: "@" },
} as const

export type MentionKind = keyof typeof MENTION_SCHEMES

/** 把 scheme 前缀(如 "plugin://")转成正则/匹配用的 scheme token(如 "plugin")。 */
function schemeToken(prefix: string): string {
  return prefix.replace(/:\/\/$/, "")
}

/** scheme token → kind 的反查表(由注册表派生,与正则的 scheme 捕获组一致)。 */
const SCHEME_TOKEN_TO_KIND: Record<string, MentionKind> = Object.fromEntries(
  (Object.keys(MENTION_SCHEMES) as MentionKind[]).map((kind) => [schemeToken(MENTION_SCHEMES[kind].prefix), kind]),
) as Record<string, MentionKind>

export interface MentionLink {
  kind: MentionKind
  sigil: string
  /** `[<sigil>label]` 里的 label(显示名)。 */
  label: string
  /** `scheme://` 之后的 id(plugin 即 addonKey = `name@marketplace`)。 */
  id: string
  /** 在传入文本中的起止位置(便于切分/高亮)。 */
  start: number
  end: number
}

/** 给定形如 `scheme://id` 的 path,返回其 kind(未知 → undefined)。 */
export function mentionKindForPath(path: string): MentionKind | undefined {
  for (const kind of Object.keys(MENTION_SCHEMES) as MentionKind[]) {
    if (path.startsWith(MENTION_SCHEMES[kind].prefix)) return kind
  }
  return undefined
}

/** 构造 wire 链接 `[<sigil><label>](<prefix><id>)`(后缀如空格/prompt 由调用方拼)。 */
export function buildMentionLink(kind: MentionKind, label: string, id: string): string {
  const { prefix, sigil } = MENTION_SCHEMES[kind]
  return `[${sigil}${label}](${prefix}${id})`
}

/** 注册表驱动的规范正则(每次返回新实例,避免 g-flag 的 lastIndex 共享态)。 */
export function createMentionRegex(): RegExp {
  const esc = (c: string) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const sigils = [...new Set(Object.values(MENTION_SCHEMES).map((s) => s.sigil))].map(esc).join("")
  const schemes = Object.values(MENTION_SCHEMES)
    .map((s) => esc(schemeToken(s.prefix)))
    .join("|")
  return new RegExp(`\\[([${sigils}])([^\\]]+)\\]\\((${schemes}):\\/\\/([^)\\s]+)\\)`, "g")
}

/** 抽出所有合法内联提及链接(sigil 与 scheme 配对正确者),保持出现顺序。kinds 可选,只取指定类型。 */
export function parseMentionLinks(text: string, kinds?: readonly MentionKind[]): MentionLink[] {
  const re = createMentionRegex()
  const out: MentionLink[] = []
  for (const m of text.matchAll(re)) {
    if (m.index === undefined) continue
    const sigil = m[1]
    const label = m[2]
    const scheme = m[3]
    const id = m[4]
    const kind = SCHEME_TOKEN_TO_KIND[scheme]
    if (!kind) continue
    if (MENTION_SCHEMES[kind].sigil !== sigil) continue
    if (kinds && !kinds.includes(kind)) continue
    out.push({ kind, sigil, label, id, start: m.index, end: m.index + m[0].length })
  }
  return out
}

// ---- plugin 专用薄封装 ----

/** 构造 plugin 提及链接 `[@<displayName>](plugin://<addonKey>)`。 */
export function buildPluginMention(displayName: string, addonKey: string): string {
  return buildMentionLink("plugin", displayName, addonKey)
}

/** 提取文本中所有 plugin 提及的 addonKey,保持出现顺序、去重。 */
export function parsePluginMentionKeys(text: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const link of parseMentionLinks(text, ["plugin"])) {
    const key = link.id
    if (key && !seen.has(key)) {
      seen.add(key)
      out.push(key)
    }
  }
  return out
}
