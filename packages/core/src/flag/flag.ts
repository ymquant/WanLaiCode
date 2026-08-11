import { Config } from "effect"
import { InstallationChannel } from "../installation/version"

/** Read WANLAICODE_* with OPENCODE_* fallback during the env rename rollout. */
export function env(key: string) {
  const wanlai = `WANLAICODE_${key}`
  const legacy = `OPENCODE_${key}`
  return process.env[wanlai] ?? process.env[legacy]
}

function truthy(key: string) {
  const value = env(key)?.toLowerCase()
  return value === "true" || value === "1"
}

function falsy(key: string) {
  const value = env(key)?.toLowerCase()
  return value === "false" || value === "0"
}

// Channels that default to the new effect-httpapi server backend. The legacy
// hono backend remains the default for stable (`prod`/`latest`) installs.
const HTTPAPI_DEFAULT_ON_CHANNELS = new Set(["dev", "beta", "local"])

function number(key: string) {
  const value = env(key)
  if (!value) return undefined
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

const WANLAICODE_EXPERIMENTAL = truthy("EXPERIMENTAL")
const WANLAICODE_DISABLE_CLAUDE_CODE = truthy("DISABLE_CLAUDE_CODE")
const WANLAICODE_DISABLE_CLAUDE_CODE_SKILLS = WANLAICODE_DISABLE_CLAUDE_CODE || truthy("DISABLE_CLAUDE_CODE_SKILLS")
const copy = env("EXPERIMENTAL_DISABLE_COPY_ON_SELECT")

export const Flag = {
  OTEL_EXPORTER_OTLP_ENDPOINT: process.env["OTEL_EXPORTER_OTLP_ENDPOINT"],
  OTEL_EXPORTER_OTLP_HEADERS: process.env["OTEL_EXPORTER_OTLP_HEADERS"],

  WANLAICODE_AUTO_SHARE: truthy("AUTO_SHARE"),
  WANLAICODE_AUTO_HEAP_SNAPSHOT: truthy("AUTO_HEAP_SNAPSHOT"),
  WANLAICODE_GIT_BASH_PATH: env("GIT_BASH_PATH"),
  WANLAICODE_CONFIG: env("CONFIG"),
  WANLAICODE_CONFIG_CONTENT: env("CONFIG_CONTENT"),
  WANLAICODE_DISABLE_AUTOUPDATE: truthy("DISABLE_AUTOUPDATE"),
  WANLAICODE_ALWAYS_NOTIFY_UPDATE: truthy("ALWAYS_NOTIFY_UPDATE"),
  WANLAICODE_DISABLE_PRUNE: truthy("DISABLE_PRUNE"),
  WANLAICODE_DISABLE_TERMINAL_TITLE: truthy("DISABLE_TERMINAL_TITLE"),
  WANLAICODE_SHOW_TTFD: truthy("SHOW_TTFD"),
  WANLAICODE_PERMISSION: env("PERMISSION"),
  WANLAICODE_DISABLE_DEFAULT_PLUGINS: truthy("DISABLE_DEFAULT_PLUGINS"),
  // 测试用：跳过 Config.load 触发的 @opencode-ai/plugin npm install。Windows self-hosted
  // 上 arborist.reify 偶发 hang 90s+ 导致 Plugin.init 测试 timeout。
  WANLAICODE_DISABLE_NPM_INSTALL: truthy("DISABLE_NPM_INSTALL"),
  WANLAICODE_DISABLE_LSP_DOWNLOAD: truthy("DISABLE_LSP_DOWNLOAD"),
  WANLAICODE_ENABLE_EXPERIMENTAL_MODELS: truthy("ENABLE_EXPERIMENTAL_MODELS"),
  WANLAICODE_DISABLE_AUTOCOMPACT: truthy("DISABLE_AUTOCOMPACT"),
  WANLAICODE_DISABLE_MODELS_FETCH: truthy("DISABLE_MODELS_FETCH"),
  WANLAICODE_DISABLE_MODELS_SNAPSHOT: truthy("DISABLE_MODELS_SNAPSHOT"),
  WANLAICODE_DISABLE_MOUSE: truthy("DISABLE_MOUSE"),
  WANLAICODE_DISABLE_CLAUDE_CODE,
  WANLAICODE_DISABLE_CLAUDE_CODE_PROMPT: WANLAICODE_DISABLE_CLAUDE_CODE || truthy("DISABLE_CLAUDE_CODE_PROMPT"),
  WANLAICODE_DISABLE_CLAUDE_CODE_SKILLS,
  WANLAICODE_DISABLE_EXTERNAL_SKILLS: truthy("DISABLE_EXTERNAL_SKILLS"),
  WANLAICODE_FAKE_VCS: env("FAKE_VCS"),
  WANLAICODE_SERVER_PASSWORD: env("SERVER_PASSWORD"),
  WANLAICODE_SERVER_USERNAME: env("SERVER_USERNAME"),
  WANLAICODE_ENABLE_QUESTION_TOOL: truthy("ENABLE_QUESTION_TOOL"),

  // Experimental
  WANLAICODE_EXPERIMENTAL,
  WANLAICODE_EXPERIMENTAL_FILEWATCHER: truthy("EXPERIMENTAL_FILEWATCHER"),
  WANLAICODE_EXPERIMENTAL_DISABLE_FILEWATCHER: truthy("EXPERIMENTAL_DISABLE_FILEWATCHER"),
  WANLAICODE_EXPERIMENTAL_ICON_DISCOVERY: WANLAICODE_EXPERIMENTAL || truthy("EXPERIMENTAL_ICON_DISCOVERY"),
  WANLAICODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT:
    copy === undefined ? process.platform === "win32" : truthy("EXPERIMENTAL_DISABLE_COPY_ON_SELECT"),
  WANLAICODE_ENABLE_EXA: truthy("ENABLE_EXA") || WANLAICODE_EXPERIMENTAL || truthy("EXPERIMENTAL_EXA"),
  WANLAICODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS: number("EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS"),
  WANLAICODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX: number("EXPERIMENTAL_OUTPUT_TOKEN_MAX"),
  WANLAICODE_EXPERIMENTAL_OXFMT: WANLAICODE_EXPERIMENTAL || truthy("EXPERIMENTAL_OXFMT"),
  WANLAICODE_EXPERIMENTAL_LSP_TY: truthy("EXPERIMENTAL_LSP_TY"),
  WANLAICODE_EXPERIMENTAL_LSP_TOOL: WANLAICODE_EXPERIMENTAL || truthy("EXPERIMENTAL_LSP_TOOL"),
  WANLAICODE_EXPERIMENTAL_PLAN_MODE: WANLAICODE_EXPERIMENTAL || truthy("EXPERIMENTAL_PLAN_MODE"),
  WANLAICODE_EXPERIMENTAL_MARKDOWN: !falsy("EXPERIMENTAL_MARKDOWN"),
  WANLAICODE_MODELS_URL: env("MODELS_URL"),
  WANLAICODE_MODELS_PATH: env("MODELS_PATH"),
  WANLAICODE_DISABLE_EMBEDDED_WEB_UI: truthy("DISABLE_EMBEDDED_WEB_UI"),
  WANLAICODE_DB: env("DB"),
  WANLAICODE_DISABLE_CHANNEL_DB: truthy("DISABLE_CHANNEL_DB"),
  WANLAICODE_SKIP_MIGRATIONS: truthy("SKIP_MIGRATIONS"),
  WANLAICODE_STRICT_CONFIG_DEPS: truthy("STRICT_CONFIG_DEPS"),

  WANLAICODE_WORKSPACE_ID: env("WORKSPACE_ID"),
  // Defaults to true on dev/beta/local channels so internal users exercise the
  // new effect-httpapi server backend. Stable (`prod`/`latest`) installs stay
  // on the legacy hono backend until the rollout is complete. An explicit env
  // var ("true"/"1" or "false"/"0") always wins, providing an opt-in for
  // stable users and an escape hatch for dev/beta users.
  WANLAICODE_EXPERIMENTAL_HTTPAPI:
    truthy("EXPERIMENTAL_HTTPAPI") ||
    (!falsy("EXPERIMENTAL_HTTPAPI") && HTTPAPI_DEFAULT_ON_CHANNELS.has(InstallationChannel)),
  WANLAICODE_EXPERIMENTAL_WORKSPACES: WANLAICODE_EXPERIMENTAL || truthy("EXPERIMENTAL_WORKSPACES"),
  WANLAICODE_EXPERIMENTAL_EVENT_SYSTEM: WANLAICODE_EXPERIMENTAL || truthy("EXPERIMENTAL_EVENT_SYSTEM"),

  // Evaluated at access time (not module load) because tests, the CLI, and
  // external tooling set these env vars at runtime.
  get WANLAICODE_DISABLE_PROJECT_CONFIG() {
    return truthy("DISABLE_PROJECT_CONFIG")
  },
  get WANLAICODE_TUI_CONFIG() {
    return env("TUI_CONFIG")
  },
  get WANLAICODE_CONFIG_DIR() {
    return env("CONFIG_DIR")
  },
  get WANLAICODE_PURE() {
    return truthy("PURE")
  },
  get WANLAICODE_PLUGIN_META_FILE() {
    return env("PLUGIN_META_FILE")
  },
  get WANLAICODE_CLIENT() {
    return env("CLIENT") ?? "cli"
  },
}
