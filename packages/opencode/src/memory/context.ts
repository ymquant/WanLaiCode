import type { Entry } from "./schema"

export type SelectInput = {
  entries: Entry[]
  query?: string
  maxEntries?: number
  maxChars?: number
}

const defaultMaxEntries = 8
const defaultMaxChars = 4000
const guidance =
  "The following items are memory summaries only. Read a detail with memory_read before relying on it. Current user instructions and repository evidence take precedence."

function words(text: string | undefined) {
  return new Set((text ?? "").toLowerCase().match(/[\p{L}\p{N}_/-]+/gu) ?? [])
}

function relevance(query: Set<string>, entry: Entry) {
  const content = words(`${entry.name} ${entry.title} ${entry.summary}`)
  return Array.from(query).filter((word) => content.has(word)).length
}

export function format(entries: Entry[]) {
  if (entries.length === 0) return ""
  const body = entries
    .map((entry) => `- [${entry.scope}/${entry.name}] ${entry.title} — ${entry.summary}`)
    .join("\n")
  return `<wanlaicode-memory-index>\n${guidance}\n${body}\n</wanlaicode-memory-index>`
}

export function select(input: SelectInput) {
  const maxEntries = input.maxEntries ?? defaultMaxEntries
  const maxChars = input.maxChars ?? defaultMaxChars
  const query = words(input.query)
  const selected: Entry[] = []
  const ranked = input.entries
    .map((entry, index) => ({ entry, index, relevance: relevance(query, entry) }))
    .toSorted(
      (a, b) =>
        b.relevance - a.relevance ||
        Number(b.entry.scope === "project") - Number(a.entry.scope === "project") ||
        a.index - b.index,
    )

  for (const item of ranked) {
    if (selected.length >= maxEntries) break
    const next = [...selected, item.entry]
    if (format(next).length > maxChars) continue
    selected.push(item.entry)
  }
  return selected
}

export const MemoryContext = {
  select,
  format,
}
