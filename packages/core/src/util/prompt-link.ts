/**
 * Prompt 链接的共享解析契约。
 *
 * 编辑器输入态与已发送消息展示态必须使用同一套边界、协议和文件路径判断，
 * 否则发送前可点击的结构化引用会在持久化后退化为 Markdown 原文。
 */
export type PromptLinkKind = "link" | "file"

export type PromptLinkMatch = {
  start: number
  end: number
  displayText: string
  href: string
  kind: PromptLinkKind
  plain?: boolean
}

function unescapeMarkdown(value: string) {
  return value.replace(/\\([\\\[\]()<>])/g, "$1")
}

const posixFileRoot =
  /^\/(?:Applications|Library|System|Users|Volumes|data|dev|etc|home|mnt|opt|private|proc|repo|root|run|sbin|srv|tmp|usr|var|workspace|workspaces)(?:\/|$)/

function isPosixFilePath(value: string) {
  // `/docs`、`/assets/app.js` 是合法的站内 URL；只有可信系统根或显式行号后缀才按 POSIX 绝对文件处理。
  if (!value.startsWith("/") || value.startsWith("//")) return false
  if (posixFileRoot.test(value)) return true
  return /(?::\d+(?::\d+)?|#L\d+(?:-L?\d+)?)$/i.test(value)
}

function isFilePath(value: string) {
  if (/^file:\/\//i.test(value)) return true
  if (/^(?:\/[A-Za-z]:[\\/]|[A-Za-z]:[\\/]|\\\\)/.test(value)) return true
  if (isPosixFilePath(value)) return true
  if (/^(?:\.\.?(?:[\\/])|[^\s/]+[\\/])/.test(value)) return true
  return /(?:[\\/]\w+){1,}\/[^\\/]+\.[A-Za-z0-9]{1,12}(?::\d+(?::\d+)?)?(?:#L\d+(?:-L?\d+)?)?$/i.test(value)
}

function classifyHref(href: string): PromptLinkKind | undefined {
  if (/^(?:https?:\/\/|www\.)/i.test(href)) return "link"
  if (/^(?:mailto:|tel:)/i.test(href)) return "link"
  if (/^(?:plugin|skill|agent|thread|subagent|mcp-resource|chatgpt-conversation):\/\//i.test(href)) return undefined
  // 协议相对 URL 与非文件根的 `/...` 必须先进入网页链路，不能被通用路径规则降级成文件引用。
  if (/^\/\//.test(href)) return "link"
  if (/^\/(?![A-Za-z]:[\\/])/.test(href) && !isPosixFilePath(href)) return "link"
  if (isFilePath(href)) return "file"
  return undefined
}

export function normalizePromptHref(value: string) {
  const next = value.trim()
  if (/^https?:\/\//i.test(next)) return next
  if (/^www\./i.test(next)) return `https://${next}`
  if (/^\/\//.test(next)) return `https:${next}`
  // root-relative 链接没有独立主机，但编辑保存时仍应保持原始 Markdown 语义。
  if (/^\/(?!\/)/.test(next) && !isPosixFilePath(next)) return next
  return undefined
}

function closingBracket(text: string, start: number) {
  for (let index = start; index < text.length; index += 1) {
    if (text[index] === "\\") {
      index += 1
      continue
    }
    if (text[index] === "]") return index
  }
  return -1
}

function closingParenthesis(text: string, start: number) {
  let depth = 1
  for (let index = start; index < text.length; index += 1) {
    if (text[index] === "\\") {
      index += 1
      continue
    }
    if (text[index] === "(") depth += 1
    if (text[index] !== ")") continue
    depth -= 1
    if (depth === 0) return index
  }
  return -1
}

function trimPlainUrl(value: string) {
  let result = value.replace(/[.,!?;:，。！？；：]+$/g, "")
  while (result.endsWith(")") && (result.match(/\(/g)?.length ?? 0) < (result.match(/\)/g)?.length ?? 0)) {
    result = result.slice(0, -1)
  }
  return result
}

function plainUrlAt(text: string, index: number) {
  // 裸 URL 只在独立文本边界触发，避免把路径或 Markdown 目标地址中的片段重复高亮。
  if (index > 0 && /[\w./:@-]/.test(text[index - 1] ?? "")) return undefined
  const raw = text.slice(index).match(/^(?:https?:\/\/|www\.)[^\s<>"'`]+/i)?.[0]
  if (!raw) return undefined
  const href = trimPlainUrl(raw)
  if (!href) return undefined
  return {
    start: index,
    end: index + href.length,
    displayText: href,
    href,
  }
}

export function findPromptLinkMatches(text: string): PromptLinkMatch[] {
  // 逐个扫描成对的 []()，只把网页和本地文件协议交给结构化节点，避免吞掉插件、技能和会话引用。
  const result: PromptLinkMatch[] = []
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "[") {
      const labelEnd = closingBracket(text, index + 1)
      if (labelEnd !== -1 && text[labelEnd + 1] === "(") {
        const hrefEnd = closingParenthesis(text, labelEnd + 2)
        if (hrefEnd !== -1) {
          const displayText = unescapeMarkdown(text.slice(index + 1, labelEnd))
          const rawHref = text.slice(labelEnd + 2, hrefEnd).trim()
          const href = unescapeMarkdown(rawHref.replace(/^<|>$/g, ""))
          const kind = classifyHref(href)
          if (displayText && kind) {
            result.push({
              start: index,
              end: hrefEnd + 1,
              displayText,
              href,
              kind,
            })
          }
          index = hrefEnd
          continue
        }
      }
    }

    const plain = plainUrlAt(text, index)
    if (!plain) continue
    result.push({ ...plain, kind: "link", plain: true })
    index = plain.end - 1
  }
  return result
}

export function serializePromptLink(displayText: string, href: string) {
  // 保持 Markdown 原文可逆：菜单编辑只改显示文本或目标地址，不把链接降级成普通字符串。
  return `[${displayText.replace(/([\\\]])/g, "\\$1")}](${href.replace(/[\\)]/g, "\\$&")})`
}

export function stripFileLocationSuffix(value: string) {
  // 文件打开链路只消费真实路径；行列号继续留在持久化文本里供模型理解。
  return value
    .replace(/(?:#L\d+(?:-L?\d+)?|:\d+(?::\d+)?)$/i, "")
    .replace(/\s*\(\s*line\s+\d+\s*\)$/i, "")
}
