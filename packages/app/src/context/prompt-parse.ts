// 纯函数模块——不依赖 Solid.js 响应式,可在 bun test 环境直接 import。
// 把含 `[@<name>](plugin://<addonKey>)` 和 `[<displayName>](skill://<name>)` markdown 链接
// 的纯文本拆成混合 parts:
//   plugin link → PluginAttachmentPart(content 用 display_name)
//   skill link  → SkillPart(content 用 wire text `/<name> `)
// 用于 ?prompt=... 进入散对话时,把预填文本还原成 chip 形态。
import type { ContentPart, Prompt } from "./prompt"
import { parseMentionLinks } from "@opencode-ai/core/util/mention"
import { findPromptLinkMatches } from "@/utils/prompt-links"

const SKILL_LINK_REGEX = /\[([^\]]+)\]\(skill:\/\/([^)]+)\)/g

type AnyMentionMatch = {
  index: number
  raw: string
  type: "plugin" | "skill"
  display: string // 链接内的显示文本
  key: string // plugin: addonKey; skill: skill name
}

function collectMentionMatches(text: string): AnyMentionMatch[] {
  const matches: AnyMentionMatch[] = []
  for (const link of parseMentionLinks(text, ["plugin"])) {
    matches.push({
      index: link.start,
      raw: text.slice(link.start, link.end),
      type: "plugin",
      display: link.label,
      key: link.id,
    })
  }
  for (const m of text.matchAll(SKILL_LINK_REGEX)) {
    if (m.index === undefined) continue
    matches.push({ index: m.index, raw: m[0], type: "skill", display: m[1], key: m[2] })
  }
  matches.sort((a, b) => a.index - b.index)
  return matches
}

// resolveDisplayName 可选:传入时按 addonKey 查 display_name(从 addon.available 缓存),
// miss 或不传则用 markdown 链接里那段 lowercase name 兜底。
export function parsePromptWithPluginMentions(
  text: string,
  resolveDisplayName?: (addonKey: string) => string | undefined,
): Prompt {
  const parts: ContentPart[] = []
  let cursor = 0
  let position = 0
  const pushText = (content: string) => {
    let textCursor = 0
    for (const link of findPromptLinkMatches(content)) {
      const before = content.slice(textCursor, link.start)
      if (before) {
        parts.push({ type: "text", content: before, start: position, end: position + before.length })
        position += before.length
      }
      const part =
        link.kind === "file"
          ? {
              type: "file-reference" as const,
              path: link.href,
              href: link.href,
              content: link.displayText,
              start: position,
              end: position + link.displayText.length,
            }
          : {
              type: "link" as const,
              href: link.href,
              ...(link.plain ? { plain: true } : {}),
              content: link.displayText,
              start: position,
              end: position + link.displayText.length,
            }
      parts.push(part)
      position += link.displayText.length
      textCursor = link.end
    }
    const after = content.slice(textCursor)
    if (after) {
      parts.push({ type: "text", content: after, start: position, end: position + after.length })
      position += after.length
    }
  }

  for (const m of collectMentionMatches(text)) {
    if (m.index < cursor) continue // overlapping (shouldn't happen, skip)
    if (m.index > cursor) {
      const slice = text.slice(cursor, m.index)
      pushText(slice)
    }
    if (m.type === "plugin") {
      const content = resolveDisplayName?.(m.key)?.trim() || m.display
      parts.push({
        type: "plugin",
        name: m.display,
        addonKey: m.key,
        content,
        start: position,
        end: position + content.length,
      })
      position += content.length
    } else {
      // skill: wire text 是 `/<name> ` — 与 skillCommandText() 一致
      const content = `/${m.key} `
      parts.push({
        type: "skill",
        name: m.key,
        content,
        start: position,
        end: position + content.length,
      })
      position += content.length
    }
    cursor = m.index + m.raw.length
  }
  if (cursor < text.length) {
    const slice = text.slice(cursor)
    pushText(slice)
  }
  if (parts.length === 0) parts.push({ type: "text", content: "", start: 0, end: 0 })
  return parts
}
