type PromptPlaceholderInput = {
  mode: "normal" | "shell"
  commentCount: number
  example: string
  suggest: boolean
  imageGeneration?: boolean
  goalMode?: boolean
  t: (key: string, params?: Record<string, string>) => string
}

export function promptPlaceholder(input: PromptPlaceholderInput) {
  if (input.mode === "shell") return input.t("prompt.placeholder.shell", { example: input.example })
  if (input.goalMode) return input.t("prompt.placeholder.goal")
  if (input.imageGeneration) return input.t("prompt.imageGeneration.placeholder")
  if (input.commentCount > 1) return input.t("prompt.placeholder.summarizeComments")
  if (input.commentCount === 1) return input.t("prompt.placeholder.summarizeComment")
  if (!input.suggest) return input.t("prompt.placeholder.simple")
  return input.t("prompt.placeholder.normal", { example: input.example })
}
