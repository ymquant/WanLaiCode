const PREFERRED_KEYS = [
  "name",
  "id",
  "title",
  "type",
  "key",
  "path",
  "url",
  "message",
  "city",
  "ok",
  "success",
  "status",
  "code",
]

export function sanitizeTitlePart(value: string) {
  return value
    .trim()
    .replace(/[\u0000-\u001F\u007F<>:"/\\|?*]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
}

function primitiveLabel(value: unknown) {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value)
}

function summaryFromObject(value: Record<string, unknown>) {
  for (const key of PREFERRED_KEYS) {
    if (!(key in value)) continue
    const label = primitiveLabel(value[key])
    if (label === undefined) continue
    const sanitized = sanitizeTitlePart(label)
    if (!sanitized) continue
    if (key === "name" || key === "title" || key === "id") return sanitized
    return sanitizeTitlePart(`${key}-${sanitized}`) || sanitized
  }

  for (const [key, entry] of Object.entries(value)) {
    const label = primitiveLabel(entry)
    if (label === undefined) continue
    const sanitized = sanitizeTitlePart(`${key}-${label}`)
    if (sanitized) return sanitized
  }
}

function summaryFromValue(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    const length = sanitizeTitlePart(String(value.length))
    return length ? `array-${length}` : "array"
  }
  if (typeof value === "object" && value !== null) return summaryFromObject(value as Record<string, unknown>)
}

function uniqueTitle(base: string, used: Set<string>) {
  if (!used.has(base)) {
    used.add(base)
    return base
  }

  let index = 2
  while (used.has(`${base}-${index}`)) index += 1
  const next = `${base}-${index}`
  used.add(next)
  return next
}

/** Build distinguishable display titles for a batch of pasted JSON segments. */
export function jsonAttachmentTitles(segments: string[]) {
  const used = new Set<string>()
  return segments.map((segment, index) => {
    let parsed: unknown
    try {
      parsed = JSON.parse(segment)
    } catch {
      parsed = undefined
    }

    const summary = parsed === undefined ? undefined : summaryFromValue(parsed)
    const base = summary || `JSON-${index + 1}`
    return `${uniqueTitle(base, used)}.json`
  })
}
