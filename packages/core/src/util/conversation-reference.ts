export const CONVERSATION_REFERENCE_SCHEME = "chatgpt-conversation"

const referencePattern = /\[((?:\\.|[^\\\]])*)\]\(chatgpt-conversation:\/\/([A-Za-z0-9._~!$&'()*+,;=:@%/-]+)\)/g

const escapeLabel = (value: string) =>
  value
    .replace(/\\/g, "\\\\")
    .replace(/\]/g, "\\]")
    .replace(/[\r\n]+/g, " ")

const unescapeLabel = (value: string) => value.replace(/\\([\\\]])/g, "$1")

export function buildConversationReference(input: { id: string; title: string }) {
  const title = input.title.trim() || "Conversation"
  return `[${escapeLabel(title)}](${CONVERSATION_REFERENCE_SCHEME}://${encodeURIComponent(input.id)})`
}

export function parseConversationReferences(text: string) {
  return Array.from(text.matchAll(referencePattern)).flatMap((match) => {
    if (match.index === undefined) return []
    try {
      return [
        {
          start: match.index,
          end: match.index + match[0].length,
          raw: match[0],
          title: unescapeLabel(match[1] ?? ""),
          id: decodeURIComponent(match[2] ?? ""),
        },
      ]
    } catch {
      return []
    }
  })
}
