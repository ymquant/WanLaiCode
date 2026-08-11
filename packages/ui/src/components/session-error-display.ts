import { resolveError } from "@opencode-ai/core/error/resolve"
import { reasonFromMessage } from "@opencode-ai/core/error/parse-reason"

const IMAGE_FAILURE_PREFIX =
  /^(?:图片生成失败|圖片生成失敗|Image generation failed|Image generation failed:)\s*[:：]?\s*/i
const IMAGE_LOADING_PREFIX =
  /^(?:正在生成更细致的图片|正在生成更細緻的圖片|Generating a more detailed image\.?\s*Please wait\.?)\s*$/i

type Translate = (key: string) => string

function localizedCategoryText(raw: string, t: Translate) {
  const reason = reasonFromMessage(raw)
  if (reason) {
    const byReason = resolveError({ reason, message: raw })
    if (byReason.category !== "unknown") return t(`errors.category.${byReason.category}`)
  }

  const resolved = resolveError({ message: raw }, { trustHeuristics: true })
  if (resolved.category !== "unknown") return t(`errors.category.${resolved.category}`)
  return raw
}

export function displaySessionErrorText(raw: string, t: Translate) {
  const text = raw.trim()
  if (!text) return text
  return localizedCategoryText(text, t)
}

export function displayImageFailureText(text: string, t: Translate) {
  const trimmed = text.trim()
  if (!trimmed) return trimmed

  if (IMAGE_LOADING_PREFIX.test(trimmed)) return t("prompt.imageGeneration.message.loading")

  const match = trimmed.match(IMAGE_FAILURE_PREFIX)
  if (!match) return displaySessionErrorText(trimmed, t)

  const body = trimmed.slice(match[0].length).trim()
  if (!body) return t("ui.sessionTurn.error.imageGenerationFailed").replace(/[:：]\s*$/, "")
  return `${t("ui.sessionTurn.error.imageGenerationFailed")}${displaySessionErrorText(body, t)}`
}

export function displayToolErrorText(error: unknown, t: Translate) {
  if (typeof error === "string") return displaySessionErrorText(error, t)
  if (error instanceof Error && error.message) return displaySessionErrorText(error.message, t)
  if (error && typeof error === "object") {
    const obj = error as Record<string, unknown>
    if (typeof obj.message === "string" && obj.message.trim()) return displaySessionErrorText(obj.message, t)
    if (typeof obj.error === "string" && obj.error.trim()) return displaySessionErrorText(obj.error, t)
    if (obj.error && typeof obj.error === "object") {
      const nested = obj.error as Record<string, unknown>
      if (typeof nested.message === "string" && nested.message.trim()) {
        return displaySessionErrorText(nested.message, t)
      }
    }
  }
  return displaySessionErrorText(String(error ?? ""), t)
}
