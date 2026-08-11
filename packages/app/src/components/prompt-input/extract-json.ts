import { largePaste } from "./paste"

const LARGE_JSON_EXTRACTION_CHARS = 64_000
const MAX_LARGE_TEXT_JSON_CANDIDATES = 200
const MAX_LARGE_TEXT_JSON_SCAN_CHARS = 64_000

export type JsonSegment = {
  start: number
  end: number
  json: string
}

export type PasteSegment =
  | { type: "json"; content: string; start: number; end: number }
  | { type: "text"; content: string; rawContent: string; start: number; end: number }

export type PasteStrategy =
  | { type: "default"; segments: PasteSegment[] }
  | { type: "mixed-json"; segments: PasteSegment[]; textMode: "inline" | "attachment" }

function matchJsonEnd(text: string, start: number, maxScanChars = Number.POSITIVE_INFINITY) {
  const open = text[start]
  if (open !== "{" && open !== "[") return

  const close = open === "{" ? "}" : "]"
  let depth = 0
  let inString = false
  let escape = false
  const limit = Math.min(text.length, start + maxScanChars)

  for (let i = start; i < limit; i++) {
    const char = text[i]
    if (inString) {
      if (escape) {
        escape = false
        continue
      }
      if (char === "\\") {
        escape = true
        continue
      }
      if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === open) {
      depth += 1
      continue
    }
    if (char === close) {
      depth -= 1
      if (depth === 0) return i + 1
    }
  }
}

function hasLikelyJsonShape(text: string) {
  const trimmed = text.trim()
  if (!trimmed) return false
  if (
    ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) &&
    /^[\[{]\s*(?:[\]}]|"|[\[{]|-?\d|true\b|false\b|null\b)/.test(trimmed)
  ) {
    return true
  }
  return /[\[{]\s*(?:"[^"\\]*(?:\\.[^"\\]*)*"\s*:|[\[{]|")/.test(text)
}

function isObjectOrArray(value: unknown) {
  return typeof value === "object" && value !== null
}

function collapseRemainder(parts: string[]) {
  return parts
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

export function remainderWithoutSegments(text: string, segments: JsonSegment[]) {
  if (segments.length === 0) return text

  const parts: string[] = []
  let last = 0
  for (const segment of segments) {
    parts.push(text.slice(last, segment.start))
    last = segment.end
  }
  parts.push(text.slice(last))
  return collapseRemainder(parts)
}

export function extractJsonSegments(text: string) {
  const largeText = text.length >= LARGE_JSON_EXTRACTION_CHARS
  if (largeText && !hasLikelyJsonShape(text)) {
    return {
      segments: [],
      remainder: text,
    }
  }

  const segments: JsonSegment[] = []
  let cursor = 0
  let candidates = 0

  while (cursor < text.length) {
    const brace = text.indexOf("{", cursor)
    const bracket = text.indexOf("[", cursor)
    const start =
      brace === -1 ? bracket : bracket === -1 ? brace : Math.min(brace, bracket)
    if (start === -1) break
    candidates += 1
    if (largeText && candidates > MAX_LARGE_TEXT_JSON_CANDIDATES) break

    const end = matchJsonEnd(text, start, largeText ? MAX_LARGE_TEXT_JSON_SCAN_CHARS : Number.POSITIVE_INFINITY)
    if (end === undefined) {
      cursor = start + 1
      continue
    }

    const candidate = text.slice(start, end)
    try {
      const parsed = JSON.parse(candidate)
      if (!isObjectOrArray(parsed)) {
        cursor = start + 1
        continue
      }
      segments.push({ start, end, json: candidate })
      cursor = end
    } catch {
      cursor = start + 1
    }
  }

  return {
    segments,
    remainder: remainderWithoutSegments(text, segments),
  }
}

/** Split pasted text into ordered json/text segments for sequential attachment handling. */
export function splitPasteSegments(text: string): PasteSegment[] {
  const { segments } = extractJsonSegments(text)
  if (segments.length === 0) {
    if (!text) return []
    return [{ type: "text", content: text, rawContent: text, start: 0, end: text.length }]
  }

  const result: PasteSegment[] = []
  let last = 0

  for (const segment of segments) {
    if (segment.start > last) {
      const rawContent = text.slice(last, segment.start)
      if (rawContent) result.push({ type: "text", content: rawContent.trim(), rawContent, start: last, end: segment.start })
    }
    result.push({ type: "json", content: segment.json, start: segment.start, end: segment.end })
    last = segment.end
  }

  if (last < text.length) {
    const rawContent = text.slice(last)
    if (rawContent) result.push({ type: "text", content: rawContent.trim(), rawContent, start: last, end: text.length })
  }

  return result
}

export function pasteStrategy(segments: PasteSegment[]): PasteStrategy {
  const jsonCount = segments.filter((segment) => segment.type === "json").length
  const text = segments
    .flatMap((segment) => (segment.type === "text" && segment.content ? [segment.content] : []))
    .join("\n\n")
    .trim()

  if (!text) return { type: "default", segments }

  if (jsonCount < 2) {
    if (jsonCount >= 1 && largePaste(text)) {
      return {
        type: "mixed-json",
        segments,
        textMode: "attachment",
      }
    }
    return { type: "default", segments }
  }

  return {
    type: "mixed-json",
    segments,
    textMode: largePaste(text) ? "attachment" : "inline",
  }
}

/** True when the paste is a single JSON object/array with no leftover non-JSON text. */
export function isPureJsonPaste(text: string) {
  const extracted = extractJsonSegments(text)
  return extracted.segments.length === 1 && extracted.remainder === ""
}
