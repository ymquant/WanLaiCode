import type { ErrorCategory } from "./error-codes"
import { resolveError } from "./resolve"
import { reasonFromMessage } from "./parse-reason"

export type ErrorMessageMap = Partial<Record<ErrorCategory | "group_disabled", string>>

const GROUP_DISABLED_PATTERN = /image generation is not enabled for this group/i

function messageFromCause(cause: unknown) {
  if (typeof cause === "string") return cause.trim()
  if (cause instanceof Error && cause.message.trim()) return cause.message.trim()
  if (cause && typeof cause === "object") {
    const obj = cause as Record<string, unknown>
    if (typeof obj.message === "string" && obj.message.trim()) return obj.message.trim()
    if (obj.data && typeof obj.data === "object") {
      const data = obj.data as Record<string, unknown>
      if (typeof data.message === "string" && data.message.trim()) return data.message.trim()
    }
  }
  return String(cause ?? "").trim() || undefined
}

function localizedCategoryMessage(messages: ErrorMessageMap | undefined, category: ErrorCategory) {
  const localized = messages?.[category]?.trim()
  return localized || undefined
}

export function localizeErrorMessage(cause: unknown, messages: ErrorMessageMap | undefined): string | undefined {
  if (!messages) return undefined
  const raw = messageFromCause(cause)
  if (!raw) return undefined

  if (GROUP_DISABLED_PATTERN.test(raw)) {
    const localized = messages.group_disabled?.trim()
    if (localized) return localized
  }

  const reason = reasonFromMessage(raw)
  if (reason) {
    const byReason = resolveError({ reason, message: raw })
    if (byReason.category !== "unknown") {
      const localized = localizedCategoryMessage(messages, byReason.category)
      if (localized) return localized
    }
  }

  const resolved = resolveError(cause, { trustHeuristics: true })
  if (resolved.category !== "unknown") {
    const localized = localizedCategoryMessage(messages, resolved.category)
    if (localized) return localized
  }

  return undefined
}

export function readableErrorMessage(cause: unknown, messages: ErrorMessageMap | undefined): string {
  return localizeErrorMessage(cause, messages) ?? messageFromCause(cause) ?? String(cause)
}
