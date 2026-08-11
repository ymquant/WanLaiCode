// 收件箱条目指令(对照 Codex cron developer instructions 里的 ::inbox-item)。
// 模型在回复末尾用一条独立成行的 remark-directive 给出「这次跑出了什么」,
// 收件箱列表据此显示标题与摘要,不必去读整个会话。
//
// Codex 的原文约束(逐字):
//   - Directives MUST be on their own line.
//   - Output exactly ONE inbox-item directive.
//   - DO NOT place commas between arguments.
// 属性用空格分隔:::inbox-item{title="…" summary="…"}

export type InboxItem = { title?: string; summary?: string }

// 独立成行的 ::inbox-item{...}。行首允许空白(模型偶尔缩进),行内出现的不算(与 Codex 的
// leafDirective 语法一致 —— 只有独占一行才是 leaf directive)。
const DIRECTIVE_LINE = /^[ \t]*::inbox-item\{([^}\n]*)\}[ \t]*$/gm

// 属性解析:扫描 key="value" 对,不关心分隔符。Codex 用 mdast 解析,属性间写逗号会静默丢属性;
// 我们有意做得更宽松 —— 提示词仍按 Codex 要求不许用逗号,但模型真写了也能解出来,
// 让「摘要丢了」这种可避免的损失不发生(见 test/automation/inbox.test.ts 的对应用例)。
function parseAttrs(raw: string): InboxItem {
  const out: InboxItem = {}
  for (const m of raw.matchAll(/([a-zA-Z][\w-]*)="([^"]*)"/g)) {
    const key = m[1].toLowerCase()
    const value = m[2].trim()
    if (!value) continue
    if (key === "title") out.title = value
    // description/subtitle 是 Codex 渲染层认的同义字段,一并接受
    else if (key === "summary" || key === "description" || key === "subtitle") out.summary = value
  }
  return out
}

// 从助手正文里取收件箱条目。Codex 提示词要求「恰好一条」,但它的解析实现并不限一条;
// 我们取**最后一条**有效的 —— 模型偶尔会先写一条再改主意重写,最后那条才是它的结论。
// 没有指令时返回 undefined(静默,不造兜底条目、不报错,与 Codex 一致)。
export function parseInboxItem(text: string): InboxItem | undefined {
  let found: InboxItem | undefined
  for (const m of text.matchAll(DIRECTIVE_LINE)) {
    const item = parseAttrs(m[1])
    if (item.title || item.summary) found = item
  }
  return found
}

// 把指令行从展示文本里剥掉(对照 Codex 渲染层的 /^::[a-zA-Z0-9-]+.*$/gm)。
// 只剥 ::inbox-item —— 不动其它可能的指令,避免误伤正文里的 :: 用法。
export function stripInboxDirective(text: string): string {
  return text
    .replace(DIRECTIVE_LINE, "")
    // 指令行删掉后常留下尾部空行,收敛成最多一个空行并去掉首尾空白
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

export * as AutomationInbox from "./inbox"
