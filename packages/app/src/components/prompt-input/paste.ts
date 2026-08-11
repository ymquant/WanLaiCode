const LARGE_PASTE_CHARS = 8000
const LARGE_PASTE_BREAKS = 120
export const MIN_RESTORABLE_PASTE_CHARS = 5000
export const MAX_RESTORABLE_PASTE_CHARS = 25000

export function largePaste(text: string) {
  if (text.length >= LARGE_PASTE_CHARS) return true
  let breaks = 0
  for (const char of text) {
    if (char !== "\n") continue
    breaks += 1
    if (breaks >= LARGE_PASTE_BREAKS) return true
  }
  return false
}

export function normalizePaste(text: string) {
  if (!text.includes("\r")) return text
  return text.replace(/\r\n?/g, "\n")
}

export function pasteMode(text: string) {
  if (largePaste(text)) return "attachment"
  if (text.includes("\n") || text.includes("\r")) return "manual"
  return "native"
}

function fileBaseName(line: string) {
  let value = line.trim()
  if (!value) return ""
  if (/^file:\/\//i.test(value)) {
    value = value.slice("file://".length)
    try {
      value = decodeURIComponent(value)
    } catch {
      // 非法转义就按原样比对，不因此把正文误判成路径
    }
  }
  value = value.replace(/[\\/]+$/, "")
  const cut = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"))
  return cut === -1 ? value : value.slice(cut + 1)
}

/**
 * 粘贴文件时，text/plain 是否只是这些文件的路径或文件名。
 *
 * 访达/资源管理器复制文件会把路径一并放进剪贴板；那不是用户要粘的正文，
 * 插进编辑器只会变成噪音。判据刻意收紧到「每一行都恰好是某个所粘文件」，
 * 正文里顺带提到文件名（如「见 shot.png 这张图」）不会命中。
 */
export function isFileListText(text: string, fileNames: string[]) {
  const names = new Set(fileNames.map((name) => name.trim()).filter(Boolean))
  if (names.size === 0) return false

  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  if (lines.length === 0) return false

  return lines.every((line) => names.has(fileBaseName(line)))
}

export function canRestorePastedText(characterCount: number | undefined) {
  return (
    characterCount !== undefined &&
    characterCount >= MIN_RESTORABLE_PASTE_CHARS &&
    characterCount <= MAX_RESTORABLE_PASTE_CHARS
  )
}

// ChatGPT 会把临时粘贴文本中的 text 代码围栏去掉，再放回可编辑文本框。
export function restorePastedTextContent(text: string) {
  return text.replace(/^```text\r?\n([\s\S]*?)\r?\n```\r?\n?$/, "$1")
}

/** Remove one orchestrator @anchor (exact text part or whole line), never a prose substring. */
export function removeExactPastedAnchorParts<T extends { type: string; content?: string }>(parts: T[], anchor: string) {
  if (!anchor.startsWith("@") || anchor.length < 2) return parts

  let removed = false
  const strip = (content: string) => {
    if (removed) return content

    const mid = `\n${anchor}\n`
    const midAt = content.indexOf(mid)
    if (midAt !== -1) {
      removed = true
      return content.slice(0, midAt + 1) + content.slice(midAt + mid.length)
    }
    if (content.startsWith(`${anchor}\n`)) {
      removed = true
      return content.slice(anchor.length + 1)
    }
    if (content.endsWith(`\n${anchor}`)) {
      removed = true
      return content.slice(0, -(anchor.length + 1))
    }
    if (content === anchor || content === `${anchor}\n`) {
      removed = true
      return ""
    }
    return content
  }

  return parts.flatMap((part) => {
    if (part.type !== "text" || typeof part.content !== "string") return [part]
    const next = strip(part.content)
    if (next === part.content) return [part]
    if (!next) return []
    return [{ ...part, content: next }]
  })
}
