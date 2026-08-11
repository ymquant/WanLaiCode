import type { FilePart } from "@opencode-ai/sdk/v2"

export function attached(part: FilePart) {
  if (part.url.startsWith("data:")) return true
  if (!part.url.startsWith("file://")) return false
  if (part.source?.text?.start === undefined) return true
  return part.source.text.start === part.source.text.end
}

export function inline(part: FilePart) {
  if (attached(part)) return false
  return part.source?.text?.start !== undefined && part.source?.text?.end !== undefined
}

export function kind(part: FilePart) {
  return part.mime.startsWith("image/") ? "image" : "file"
}
