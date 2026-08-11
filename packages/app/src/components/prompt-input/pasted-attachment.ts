/** Aligned with LARGE_JSON_EXTRACTION_CHARS in extract-json.ts; preview opens at or below this size. */
export const PASTED_PREVIEW_MAX_CHARS = 64_000

export type PastedAttachmentKind = "json" | "text"

export function isPastedTextPath(path: string) {
  const normalized = path.replace(/\\/g, "/")
  return /(?:^|\/)\.wanlaicode\/pasted-text\//i.test(normalized)
}

export function pastedAttachmentKind(path: string): PastedAttachmentKind | undefined {
  if (!isPastedTextPath(path)) return
  const lower = path.toLowerCase()
  if (lower.endsWith(".json")) return "json"
  if (lower.endsWith(".txt")) return "text"
}

export function canPreviewPastedAttachment(contentLength: number) {
  return contentLength <= PASTED_PREVIEW_MAX_CHARS
}

export function isValidPastedJson(content: string) {
  try {
    JSON.parse(content)
    return true
  } catch {
    return false
  }
}

/** 关闭不强制保存成功：非法 JSON 等保存失败时仍允许丢弃草稿并关闭。 */
export async function closePastedAttachmentPreview(input: {
  dirty: boolean
  onSave: () => Promise<boolean>
  onClose: () => void
}) {
  if (input.dirty) await input.onSave()
  input.onClose()
}
