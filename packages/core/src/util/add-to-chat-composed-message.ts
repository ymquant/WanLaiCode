/**
 * Separator between excerpt block and user-typed body in composed messages.
 * Used by app prompt submit when merging add-to-chat excerpts into the outgoing user text.
 */
export const ADD_TO_CHAT_BODY_SEPARATOR = "\n\n---\n\n"

/**
 * Stable wire-protocol marker for each excerpt block's first line (not translated).
 * Display copy uses i18n in the UI only.
 */
export const ADD_TO_CHAT_EXCERPT_SENTINEL = "<!--as-mentioned-earlier-->"

/** Closing line for each excerpt block (compose wire format). Body may contain blank lines. */
export const ADD_TO_CHAT_EXCERPT_END_SENTINEL = "<!--/as-mentioned-earlier-->"

/** Legacy first-line headings (numbered + old locale-specific titles). */
const LEGACY_EXCERPT_HEADING_LINE =
  /^(?:(?:Excerpt|摘录|摘錄)\s+\d+|前面提到|As mentioned earlier)\s*$/u

const isExcerptBlockHeadingLine = (line: string) =>
  line.trim() === ADD_TO_CHAT_EXCERPT_SENTINEL || LEGACY_EXCERPT_HEADING_LINE.test(line.trimEnd())

const isExcerptBlockEndLine = (line: string) => line.trim() === ADD_TO_CHAT_EXCERPT_END_SENTINEL

function parseAddToChatExcerptHeadEndDelimited(head: string): string[] | null {
  if (!head.includes(ADD_TO_CHAT_EXCERPT_END_SENTINEL)) return null
  const excerpts: string[] = []
  const lines = head.split("\n")
  let i = 0
  while (i < lines.length) {
    const heading = lines[i] ?? ""
    if (!isExcerptBlockHeadingLine(heading)) {
      i += 1
      continue
    }
    i += 1
    const bodyLines: string[] = []
    while (i < lines.length) {
      const line = lines[i] ?? ""
      if (isExcerptBlockEndLine(line)) {
        i += 1
        break
      }
      bodyLines.push(line)
      i += 1
    }
    excerpts.push(bodyLines.join("\n").trimEnd())
  }
  if (excerpts.length === 0) return null
  return excerpts
}

export type ParsedAddToChatUserMessage = {
  excerpts: string[]
  /** User text after the separator (may be empty). */
  body: string
}

/**
 * If the message matches the add-to-chat compose shape, returns excerpt bodies + remainder.
 * Otherwise returns null (render as plain user text).
 */
export function parseAddToChatUserMessageDisplay(full: string): ParsedAddToChatUserMessage | null {
  const idx = full.indexOf(ADD_TO_CHAT_BODY_SEPARATOR)
  if (idx === -1) return null
  const head = full.slice(0, idx).trimEnd()
  const body = full.slice(idx + ADD_TO_CHAT_BODY_SEPARATOR.length)
  if (!head) return null
  const fromEndDelimited = parseAddToChatExcerptHeadEndDelimited(head)
  const excerpts =
    fromEndDelimited ??
    head.split(/\n\n+/u).flatMap((block) => {
      const lines = block.split("\n")
      if (lines.length === 0) return []
      const first = lines[0] ?? ""
      if (!isExcerptBlockHeadingLine(first)) return []
      return [lines.slice(1).join("\n").trimEnd()]
    })
  if (excerpts.length === 0) return null
  return { excerpts, body }
}

/** Wire-format user text (excerpt blocks + separator + body), matching {@link parseAddToChatUserMessageDisplay}. */
export function composeAddToChatUserMessage(snippets: string[], bodyText: string) {
  if (snippets.length === 0) return bodyText
  const head = snippets
    .map(
      (snippet) =>
        `${ADD_TO_CHAT_EXCERPT_SENTINEL}\n${snippet.trimEnd()}\n${ADD_TO_CHAT_EXCERPT_END_SENTINEL}`,
    )
    .join("\n\n")
  return `${head}${ADD_TO_CHAT_BODY_SEPARATOR}${bodyText}`
}
