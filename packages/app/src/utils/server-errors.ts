export type ConfigInvalidError = {
  name: "ConfigInvalidError"
  data: {
    path?: string
    message?: string
    issues?: Array<{ message: string; path: string[] }>
  }
}

export type ProviderModelNotFoundError = {
  name: "ProviderModelNotFoundError"
  data: {
    providerID: string
    modelID: string
    suggestions?: string[]
  }
}

type Translator = (key: string, vars?: Record<string, string | number>) => string

function tr(translator: Translator | undefined, key: string, text: string, vars?: Record<string, string | number>) {
  if (!translator) return text
  const out = translator(key, vars)
  if (!out || out === key) return text
  return out
}

const VCS_GENERATE_ERROR_KEYS: Record<string, string> = {
  "No changes to summarize": "dialog.gitGenerate.error.noChanges",
  "No branch changes to summarize": "dialog.gitGenerate.error.noBranchChanges",
  "Failed to generate commit message": "dialog.gitGenerate.error.commitFailed",
  "Failed to generate pull request title": "dialog.gitGenerate.error.prTitleFailed",
  "Empty model response": "dialog.gitGenerate.error.emptyResponse",
  "Failed to generate content": "dialog.gitGenerate.error.generic",
}

function parseReadableVcsGenerateMessage(message: string, translate?: Translator) {
  const key = VCS_GENERATE_ERROR_KEYS[message]
  if (!key) return message
  return tr(translate, key, message)
}

export function formatServerError(error: unknown, translate?: Translator, fallback?: string): string {
  if (isConfigInvalidErrorLike(error)) return parseReadableConfigInvalidError(error, translate)
  if (isProviderModelNotFoundErrorLike(error)) return parseReadableProviderModelNotFoundError(error, translate)
  if (error instanceof Error && error.message) {
    if (looksLikeStack(error.message)) return tr(translate, "error.chain.unknown", "Unknown error")
    return parseReadableVcsGenerateMessage(error.message, translate)
  }
  if (typeof error === "string" && error) return parseReadableVcsGenerateMessage(error, translate)
  // 兼容 hey-api / SDK 直接 throw 的 response body 对象：
  //   - NamedError.toObject() 形状：{ name, data: { message } }
  //   - SDK 包装：{ error: <body> }（递归解包）
  //   - 退化形状：{ message } / { error: "..." }
  if (typeof error === "object" && error) {
    const obj = error as Record<string, unknown>
    if (obj.data && typeof obj.data === "object") {
      const d = obj.data as Record<string, unknown>
      if (typeof d.message === "string" && d.message) return parseReadableVcsGenerateMessage(d.message, translate)
    }
    if ("error" in obj) {
      const nested = formatServerError(obj.error, translate, "")
      if (nested) return nested
    }
    if (typeof obj.message === "string" && obj.message) return parseReadableVcsGenerateMessage(obj.message, translate)
  }
  if (fallback) return fallback
  return tr(translate, "error.chain.unknown", "Unknown error")
}

function isConfigInvalidErrorLike(error: unknown): error is ConfigInvalidError {
  if (typeof error !== "object" || error === null) return false
  const o = error as Record<string, unknown>
  return o.name === "ConfigInvalidError" && typeof o.data === "object" && o.data !== null
}

function isProviderModelNotFoundErrorLike(error: unknown): error is ProviderModelNotFoundError {
  if (typeof error !== "object" || error === null) return false
  const o = error as Record<string, unknown>
  return o.name === "ProviderModelNotFoundError" && typeof o.data === "object" && o.data !== null
}

export function parseReadableConfigInvalidError(errorInput: ConfigInvalidError, translator?: Translator) {
  const file = errorInput.data.path && errorInput.data.path !== "config" ? errorInput.data.path : "config"
  const detail = errorInput.data.message?.trim() ?? ""
  const issues = (errorInput.data.issues ?? [])
    .map((issue) => {
      const msg = issue.message.trim()
      if (!issue.path.length) return msg
      return `${issue.path.join(".")}: ${msg}`
    })
    .filter(Boolean)
  const msg = issues.length ? issues.join("\n") : detail
  if (!msg) return tr(translator, "error.chain.configInvalid", `Config file at ${file} is invalid`, { path: file })
  return tr(translator, "error.chain.configInvalidWithMessage", `Config file at ${file} is invalid: ${msg}`, {
    path: file,
    message: msg,
  })
}

function parseReadableProviderModelNotFoundError(errorInput: ProviderModelNotFoundError, translator?: Translator) {
  const p = errorInput.data.providerID.trim()
  const m = errorInput.data.modelID.trim()
  const list = (errorInput.data.suggestions ?? []).map((v) => v.trim()).filter(Boolean)
  const body = tr(translator, "error.chain.modelNotFound", `Model not found: ${p}/${m}`, { provider: p, model: m })
  const tail = tr(translator, "error.chain.checkConfig", "Check your config (wanlaicode.json) provider/model names")
  if (list.length) {
    const suggestions = list.slice(0, 5).join(", ")
    return [body, tr(translator, "error.chain.didYouMean", `Did you mean: ${suggestions}`, { suggestions }), tail].join(
      "\n",
    )
  }
  return [body, tail].join("\n")
}

function looksLikeStack(message: string): boolean {
  return (
    /\n\s+at\s/.test(message) ||
    message.includes("file://") ||
    /\.js:\d/.test(message) ||
    message.includes("app.asar")
  )
}

export function isCancellation(error: unknown): boolean {
  if (error && typeof error === "object" && "name" in error && (error as { name?: string }).name === "AbortError")
    return true
  const message = String(error instanceof Error ? error.message : error).toLowerCase()
  return /\b499\b/.test(message) || message.includes("empty response body") || message.includes("aborted")
}
