import type { Part } from "@opencode-ai/sdk/v2"
import { restoreEditorFromUserParts } from "@/utils/prompt"

export function sessionTimelinePreview(input: {
  parts: Part[]
  directory: string
  attachmentName: string
  addToChatLabel: string
  maxLength?: number
}) {
  const restored = restoreEditorFromUserParts(input.parts, {
    directory: input.directory,
    attachmentName: input.attachmentName,
  })
  const preview = restored.prompt
    .map((part) => {
      if (part.type === "image") return `[image:${part.filename}]`
      return part.content
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim()
  const text = preview || (restored.addToChatSnippets.length > 0 ? input.addToChatLabel : "")
  const limit = input.maxLength ?? 200
  if (text.length <= limit) return text
  return text.slice(0, limit) + "..."
}
