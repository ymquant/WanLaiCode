import { InvalidMemoryError, type Draft } from "./schema"

const indexHeader = "# Memory Index\n\n"
const namePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const indexPattern = /^- \[([^\]\r\n]+)\]\(([a-z0-9]+(?:-[a-z0-9]+)*)\.md\) — ([^\r\n]+)$/

export type IndexItem = {
  name: string
  title: string
  summary: string
}

export type DetailContent = {
  title: string
  summary: string
  detail: string
}

function invalid(kind: "index" | "detail", reason: string): never {
  throw new InvalidMemoryError({ message: `Invalid memory ${kind}: ${reason}` })
}

function inline(value: string, field: "title" | "summary") {
  const result = value.trim().replace(/\s+/g, " ")
  const max = field === "title" ? 120 : 300
  if (!result || result.length > max) invalid("detail", `${field} must be between 1 and ${max} characters`)
  if (field === "title" && result.includes("]")) invalid("detail", "title cannot contain ]")
  return result
}

export function validateName(name: string) {
  if (!namePattern.test(name)) invalid("detail", "name must be ASCII kebab-case")
  return name
}

export function validateDraft(input: Draft): Draft {
  const detail = input.detail.trim()
  if (!detail || detail.length > 12_000) invalid("detail", "body must be between 1 and 12000 characters")
  return {
    name: validateName(input.name),
    title: inline(input.title, "title"),
    summary: inline(input.summary, "summary"),
    detail,
  }
}

export function parseIndex(text: string): IndexItem[] {
  if (!text.trim()) return []
  const lines = text.replaceAll("\r\n", "\n").split("\n")
  if (lines.shift() !== "# Memory Index") invalid("index", "missing header")

  return lines.flatMap((line) => {
    if (!line.trim()) return []
    const match = line.match(indexPattern)
    if (!match) return invalid("index", `malformed entry: ${line}`)
    return [{ title: match[1]!, name: match[2]!, summary: match[3]! }]
  })
}

export function serializeIndex(entries: IndexItem[]) {
  if (entries.length === 0) return indexHeader
  return indexHeader + entries.map((entry) => `- [${inline(entry.title, "title")}](${validateName(entry.name)}.md) — ${inline(entry.summary, "summary")}`).join("\n") + "\n"
}

export function parseDetail(text: string): DetailContent {
  const normalized = text.replaceAll("\r\n", "\n")
  const lines = normalized.split("\n")
  const heading = lines[0]?.match(/^# (.+)$/)
  if (!heading) return invalid("detail", "missing H1 title")
  if (lines[1] !== "") return invalid("detail", "title must be followed by a blank line")
  const quote = lines[2]?.match(/^> (.+)$/)
  if (!quote) return invalid("detail", "missing summary blockquote")
  if (lines[3] !== "") return invalid("detail", "summary must be followed by a blank line")
  const detail = lines.slice(4).join("\n").trim()
  if (!detail) return invalid("detail", "missing body")
  return {
    title: inline(heading[1]!, "title"),
    summary: inline(quote[1]!, "summary"),
    detail,
  }
}

export function serializeDetail(input: DetailContent) {
  const detail = input.detail.trim()
  if (!detail || detail.length > 12_000) invalid("detail", "body must be between 1 and 12000 characters")
  return `# ${inline(input.title, "title")}\n\n> ${inline(input.summary, "summary")}\n\n${detail}\n`
}

export const MemoryDocuments = {
  parseIndex,
  serializeIndex,
  parseDetail,
  serializeDetail,
  validateName,
  validateDraft,
}
