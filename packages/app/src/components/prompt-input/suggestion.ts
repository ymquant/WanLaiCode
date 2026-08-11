export type GhostSuggestionInput = {
  suggestion: string | undefined
  /**
   * Must be `true` whenever the prompt is in any non-default state — including
   * typed text, image attachments, or content loaded via history navigation.
   * Callers should use `prompt.dirty()` to satisfy this contract.
   */
  dirty: boolean
  dismissed: boolean
  working: boolean
  mode: "normal" | "shell"
  /** Whether an image-generation model is currently active. */
  imageGeneration: boolean
  popover: boolean
  enabled: boolean
  suppressed?: boolean
}

export function ghostSuggestion(input: GhostSuggestionInput) {
  if (!input.enabled) return undefined
  if (!input.suggestion?.trim()) return undefined
  if (input.suppressed) return undefined
  if (input.dismissed) return undefined
  if (input.dirty) return undefined
  if (input.working) return undefined
  if (input.mode !== "normal") return undefined
  if (input.imageGeneration) return undefined
  if (input.popover) return undefined
  return input.suggestion
}

export type AcceptSuggestionKeyInput = {
  key: string
  shiftKey: boolean
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
}

export function isAcceptSuggestionKey(event: AcceptSuggestionKeyInput) {
  if (event.key !== "Tab" && event.key !== "ArrowRight") return false
  return !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey
}
