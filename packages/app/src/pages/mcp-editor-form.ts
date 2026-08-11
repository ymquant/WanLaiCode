import type { McpManagementDetail, McpManagementForm, McpManagementSaveInput } from "@opencode-ai/sdk/v2"

type LocalForm = Extract<McpManagementForm, { type: "local" }>
type RemoteForm = Extract<McpManagementForm, { type: "remote" }>

type DraftFields = {
  name: string
  timeout: string
}

export type McpLocalDraft = Omit<LocalForm, "cwd" | "timeout"> &
  DraftFields & {
    cwd: string
  }

export type McpRemoteDraft = Omit<RemoteForm, "bearer_token_env" | "oauth" | "timeout"> &
  DraftFields & {
    bearer_token_env: string
    bearer_token_configured: boolean
    oauth: {
      enabled: boolean
      client_id: string
      client_secret_env: string
      client_secret_configured: boolean
      scope: string
      redirect_uri: string
    }
  }

export type McpDraft = McpLocalDraft | McpRemoteDraft
export type McpDraftType = McpDraft["type"]
export type McpDraftErrors = Record<string, McpDraftError>
export type McpDraftError =
  | "name_required"
  | "name_invalid"
  | "command_required"
  | "url_invalid"
  | "env_invalid"
  | "key_required"
  | "value_required"
  | "duplicate_key"
  | "authorization_conflict"
  | "redirect_uri_invalid"
  | "timeout_invalid"

const validName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const validEnv = /^[A-Za-z_][A-Za-z0-9_]*$/

export function isMcpRowEmpty(row: { key: string; value: string }) {
  return !row.key.trim() && !row.value.trim()
}

export function isMcpFieldValidationVisible(
  path: string,
  touchedFields: ReadonlySet<string>,
  validateAll: boolean,
) {
  return validateAll || touchedFields.has(path)
}

export function createEmptyMcpDraft(type: "local"): McpLocalDraft
export function createEmptyMcpDraft(type: "remote"): McpRemoteDraft
export function createEmptyMcpDraft(type: McpDraftType): McpDraft
export function createEmptyMcpDraft(type: McpDraftType): McpDraft {
  if (type === "local") {
    return {
      name: "",
      type: "local",
      command: "",
      args: [""],
      environment: [{ key: "", value: "" }],
      inherited_environment: [""],
      cwd: "",
      timeout: "",
    }
  }

  return {
    name: "",
    type: "remote",
    url: "",
    bearer_token_env: "",
    bearer_token_configured: false,
    headers: [{ key: "", value: "" }],
    environment_headers: [{ key: "", env: "" }],
    oauth: {
      enabled: true,
      client_id: "",
      client_secret_env: "",
      client_secret_configured: false,
      scope: "",
      redirect_uri: "",
    },
    timeout: "",
  }
}

export function createEditorDrafts() {
  return {
    local: createEmptyMcpDraft("local"),
    remote: createEmptyMcpDraft("remote"),
  }
}

function timeoutToDraft(timeout: McpManagementForm["timeout"]) {
  return timeout === undefined ? "" : String(timeout)
}

function oauthToDraft(oauth: RemoteForm["oauth"] | false | undefined): McpRemoteDraft["oauth"] {
  if (oauth === false) {
    return {
      enabled: false,
      client_id: "",
      client_secret_env: "",
      client_secret_configured: false,
      scope: "",
      redirect_uri: "",
    }
  }
  if (!oauth) {
    return {
      enabled: true,
      client_id: "",
      client_secret_env: "",
      client_secret_configured: false,
      scope: "",
      redirect_uri: "",
    }
  }
  return {
    enabled: oauth.enabled,
    client_id: oauth.client_id ?? "",
    client_secret_env: oauth.client_secret_env ?? "",
    client_secret_configured: oauth.client_secret_configured ?? false,
    scope: oauth.scope ?? "",
    redirect_uri: oauth.redirect_uri ?? "",
  }
}

export function detailToDraft(detail: McpManagementDetail): McpDraft {
  if (detail.config.type === "local") {
    return {
      name: detail.name,
      type: "local",
      command: detail.config.command,
      args: detail.config.args.length ? [...detail.config.args] : [""],
      environment: detail.config.environment.length
        ? detail.config.environment.map((entry) => ({ ...entry }))
        : [{ key: "", value: "" }],
      inherited_environment: detail.config.inherited_environment.length ? [...detail.config.inherited_environment] : [""],
      cwd: detail.config.cwd ?? "",
      timeout: timeoutToDraft(detail.config.timeout),
    }
  }

  return {
    name: detail.name,
    type: "remote",
    url: detail.config.url,
    bearer_token_env: detail.config.bearer_token_env ?? "",
    bearer_token_configured: detail.config.bearer_token_configured ?? false,
    headers: detail.config.headers.length
      ? detail.config.headers.map((entry) => ({ ...entry }))
      : [{ key: "", value: "" }],
    environment_headers: detail.config.environment_headers.length
      ? detail.config.environment_headers.map((entry) => ({ ...entry }))
      : [{ key: "", env: "" }],
    oauth: oauthToDraft(detail.config.oauth),
    timeout: timeoutToDraft(detail.config.timeout),
  }
}

function pairs<T extends { key: string }>(items: T[]) {
  return items
    .map((item) => Object.fromEntries(Object.entries(item).map(([key, value]) => [key, value.trim()])) as unknown as T)
    .filter((item) => Object.values(item).some(Boolean))
}

function values(items: string[]) {
  return items.map((item) => item.trim()).filter(Boolean)
}

function optional(value: string) {
  return value.trim() || undefined
}

function isAuthorization(value: string) {
  return value.trim().toLowerCase() === "authorization"
}

function timeoutValue(value: string) {
  return value.trim() ? Number(value) : undefined
}

function oauthToSave(oauth: McpRemoteDraft["oauth"]) {
  if (!oauth.enabled) return false as const
  const client_id = optional(oauth.client_id)
  const client_secret_env = optional(oauth.client_secret_env)
  const client_secret_configured = client_secret_env ? undefined : oauth.client_secret_configured || undefined
  const scope = optional(oauth.scope)
  const redirect_uri = optional(oauth.redirect_uri)
  if (!client_id && !client_secret_env && !client_secret_configured && !scope && !redirect_uri) return
  return {
    enabled: true as const,
    ...(client_id ? { client_id } : {}),
    ...(client_secret_env ? { client_secret_env } : {}),
    ...(client_secret_configured ? { client_secret_configured } : {}),
    ...(scope ? { scope } : {}),
    ...(redirect_uri ? { redirect_uri } : {}),
  }
}

export function draftToSaveInput(draft: McpDraft, originalName?: string): McpManagementSaveInput {
  const name = draft.name.trim()
  const original_name = optional(originalName ?? "")
  const timeout = timeoutValue(draft.timeout)

  if (draft.type === "local") {
    return {
      name,
      original_name,
      config: {
        type: "local",
        command: draft.command.trim(),
        args: values(draft.args),
        environment: pairs(draft.environment),
        inherited_environment: values(draft.inherited_environment),
        cwd: optional(draft.cwd),
        timeout,
      },
    }
  }

  const bearer_token_env = optional(draft.bearer_token_env)
  const oauth = oauthToSave(draft.oauth)
  return {
    name,
    original_name,
    config: {
      type: "remote",
      url: draft.url.trim(),
      ...(bearer_token_env ? { bearer_token_env } : {}),
      ...(!bearer_token_env && draft.bearer_token_configured ? { bearer_token_configured: true } : {}),
      headers: pairs(draft.headers).filter((entry) => !isAuthorization(entry.key)),
      environment_headers: pairs(draft.environment_headers).filter((entry) => !isAuthorization(entry.key)),
      ...(oauth === undefined ? {} : { oauth }),
      ...(timeout === undefined ? {} : { timeout }),
    },
  }
}

function isHttpUrl(value: string) {
  if (!URL.canParse(value)) return false
  return ["http:", "https:"].includes(new URL(value).protocol)
}

function validateTimeout(value: string) {
  if (!value.trim()) return false
  const timeout = Number(value)
  return !Number.isInteger(timeout) || timeout <= 0
}

function validatePairRows(rows: Array<{ key: string; value: string }>, field: string, errors: McpDraftErrors) {
  rows.forEach((row, index) => {
    if (isMcpRowEmpty(row)) return
    if (!row.key.trim() && row.value.trim()) errors[`${field}.${index}.key`] = "key_required"
    if (row.key.trim() && !row.value.trim()) errors[`${field}.${index}.value`] = "value_required"
  })
}

function validateEnvPairRows(rows: Array<{ key: string; env: string }>, field: string, errors: McpDraftErrors) {
  rows.forEach((row, index) => {
    if (isMcpRowEmpty({ key: row.key, value: row.env })) return
    if (!row.key.trim() && row.env.trim()) errors[`${field}.${index}.key`] = "key_required"
    if (row.key.trim() && !row.env.trim()) errors[`${field}.${index}.env`] = "value_required"
    if (row.env.trim() && !validEnv.test(row.env.trim())) errors[`${field}.${index}.env`] = "env_invalid"
  })
}

function validateDuplicates(entries: Array<{ key: string; path: string }>, errors: McpDraftErrors) {
  const seen = new Set<string>()
  entries.forEach((entry) => {
    const key = entry.key.trim().toLowerCase()
    if (!key) return
    if (seen.has(key)) errors[entry.path] = "duplicate_key"
    seen.add(key)
  })
}

function validateBase(draft: McpDraft, errors: McpDraftErrors) {
  const name = draft.name.trim()
  if (!name) errors.name = "name_required"
  if (name && !validName.test(name)) errors.name = "name_invalid"
  if (validateTimeout(draft.timeout)) errors.timeout = "timeout_invalid"
}

export function validateMcpDraft(draft: McpDraft): McpDraftErrors {
  const errors: McpDraftErrors = {}
  validateBase(draft, errors)

  if (draft.type === "local") {
    if (!draft.command.trim()) errors.command = "command_required"
    validatePairRows(draft.environment, "environment", errors)
    draft.environment.forEach((entry, index) => {
      if (entry.key.trim() && !validEnv.test(entry.key.trim())) errors[`environment.${index}.key`] = "env_invalid"
    })
    draft.inherited_environment.forEach((env, index) => {
      if (env.trim() && !validEnv.test(env.trim())) errors[`inherited_environment.${index}`] = "env_invalid"
    })
    validateDuplicates(
      [
        ...draft.environment.map((entry, index) => ({ key: entry.key, path: `environment.${index}.key` })),
        ...draft.inherited_environment.map((key, index) => ({
          key,
          path: `inherited_environment.${index}`,
        })),
      ],
      errors,
    )
    return errors
  }

  if (!isHttpUrl(draft.url.trim())) errors.url = "url_invalid"
  validatePairRows(draft.headers, "headers", errors)
  validateEnvPairRows(draft.environment_headers, "environment_headers", errors)
  if (draft.bearer_token_env.trim() && !validEnv.test(draft.bearer_token_env.trim())) {
    errors.bearer_token_env = "env_invalid"
  }
  if (draft.oauth.client_secret_env.trim() && !validEnv.test(draft.oauth.client_secret_env.trim())) {
    errors["oauth.client_secret_env"] = "env_invalid"
  }
  validateDuplicates(
    [
      ...draft.headers.map((entry, index) => ({ key: entry.key, path: `headers.${index}.key` })),
      ...draft.environment_headers.map((entry, index) => ({
        key: entry.key,
        path: `environment_headers.${index}.key`,
      })),
    ],
    errors,
  )
  draft.headers.forEach((entry, index) => {
    if (isAuthorization(entry.key)) {
      errors[`headers.${index}.key`] = "authorization_conflict"
    }
  })
  draft.environment_headers.forEach((entry, index) => {
    if (isAuthorization(entry.key)) {
      errors[`environment_headers.${index}.key`] = "authorization_conflict"
    }
  })
  if (draft.oauth.redirect_uri.trim() && !isHttpUrl(draft.oauth.redirect_uri.trim())) {
    errors["oauth.redirect_uri"] = "redirect_uri_invalid"
  }
  return errors
}
