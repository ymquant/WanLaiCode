import PROMPT_COMMIT from "@/agent/prompt/commit-message.txt"
import PROMPT_PR from "@/agent/prompt/pull-request.txt"
import { Agent } from "@/agent/agent"
import { InstanceState } from "@/effect/instance-state"
import { Git } from "@/git"
import { Provider } from "@/provider/provider"
import { Vcs } from "@/project/vcs"
import { LLM } from "@/session/llm"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, SessionID } from "@/session/schema"
import { zod } from "@/util/effect-zod"
import { withStatics } from "@/util/schema"
import { Wildcard } from "@/util/wildcard"
import { NamedError } from "@opencode-ai/core/util/error"
import { Effect, Schedule, Schema } from "effect"
import * as Stream from "effect/Stream"
import path from "path"
import z from "zod"

export const MAX_DIFF_CONTEXT = 12_000
export const MAX_PREVIOUS_CONTEXT = 2048
export const COMMIT_HISTORY_LIMIT = 30
export const BRANCH_COMMIT_HISTORY_LIMIT = 20

const SENSITIVE_PATCH_OMITTED = "(patch omitted — sensitive file)"

// Codex permission profiles deny-read globs under :workspace_roots:
// https://developers.openai.com/codex/permissions
const SENSITIVE_DENY_GLOBS = [
  "**/.env",
  "**/.env.*",
  "**/*.env",
  "**/credentials.json",
  "**/credentials.*.json",
  "**/auth.json",
  "**/wanlaicode.json",
  "**/wanlaicode.jsonc",
  "**/opencode.json",
  "**/opencode.jsonc",
  "**/secrets.json",
  "**/secrets.yaml",
  "**/secrets.yml",
  "**/*.secret",
  "**/*.pem",
  "**/*.p12",
  "**/*.pfx",
  "**/id_rsa",
  "**/id_ed25519",
] as const

const SENSITIVE_ALLOW_GLOBS = ["**/.env.example", "**/*.env.example"] as const

const LOCALE_BCP47: Record<string, string> = {
  zh: "zh-Hans",
  zht: "zh-Hant",
  en: "en",
  ko: "ko",
  de: "de",
  es: "es",
  fr: "fr",
  da: "da",
  ja: "ja",
  pl: "pl",
  ru: "ru",
  ar: "ar",
  no: "nb-NO",
  br: "pt-BR",
  th: "th",
  bs: "bs",
  tr: "tr",
}
const LOCALE_LANGUAGE: Record<string, string> = {
  zh: "Simplified Chinese (简体中文)",
  zht: "Traditional Chinese (繁體中文)",
  en: "English",
  ja: "Japanese (日本語)",
  ko: "Korean (한국어)",
  de: "German",
  es: "Spanish",
  fr: "French",
  da: "Danish",
  pl: "Polish",
  ru: "Russian",
  ar: "Arabic",
  no: "Norwegian",
  br: "Brazilian Portuguese",
  th: "Thai",
  bs: "Bosnian",
  tr: "Turkish",
}

const VCS_GENERATE_SESSION = SessionID.make("ses_vcs_generate")

export const GenerateFailedError = NamedError.create(
  "VcsGenerateFailedError",
  z.object({
    message: z.string(),
  }),
)

export function normalizeDiffPath(file: string) {
  return file.replaceAll("\\", "/")
}

export function isSensitiveDiffPath(file: string) {
  const normalized = normalizeDiffPath(file)
  const base = path.posix.basename(normalized)
  if (SENSITIVE_ALLOW_GLOBS.some((pattern) => Wildcard.match(normalized, pattern))) return false
  if (base === ".env") return true
  if (base.startsWith(".env.") && base !== ".env.example") return true
  if (base.endsWith(".env") && base !== ".env.example") return true
  if (base === "credentials.json" || /^credentials\.[^.]+\.json$/.test(base)) return true
  if (
    base === "auth.json" ||
    base === "wanlaicode.json" ||
    base === "wanlaicode.jsonc" ||
    base === "opencode.json" ||
    base === "opencode.jsonc" ||
    base === "secrets.json" ||
    base === "secrets.yaml" ||
    base === "secrets.yml"
  ) {
    return true
  }
  if (/\.secret$/.test(base)) return true
  if (/\.(pem|p12|pfx)$/.test(base)) return true
  if (base === "id_rsa" || base === "id_ed25519") return true
  return SENSITIVE_DENY_GLOBS.some((pattern) => Wildcard.match(normalized, pattern))
}

export function redactSensitiveDiffs(files: Vcs.FileDiff[]) {
  return files.map((file) => (isSensitiveDiffPath(file.file) ? { ...file, patch: undefined } : file))
}

export function truncatePrevious(text: string | undefined, max = MAX_PREVIOUS_CONTEXT) {
  const trimmed = text?.trim()
  if (!trimmed) return undefined
  if (trimmed.length <= max) return trimmed
  return `${trimmed.slice(0, max)}\n...(truncated)`
}

export function formatDiffContext(files: Vcs.FileDiff[], max = MAX_DIFF_CONTEXT) {
  if (files.length === 0) return ""
  const safe = redactSensitiveDiffs(files)
  const header = safe.map((f) => `${f.file} (+${f.additions}/-${f.deletions})`).join("\n")
  let budget = max - header.length - 64
  const patches: string[] = []
  for (const file of safe) {
    const patch = isSensitiveDiffPath(file.file)
      ? SENSITIVE_PATCH_OMITTED
      : file.patch?.trim()
    if (!patch || budget <= 0) continue
    const prefix = `\n--- ${file.file} ---\n`
    if (budget <= prefix.length) break
    const available = budget - prefix.length
    const slice =
      patch.length > available
        ? `${patch.slice(0, Math.max(0, available - 20))}\n...(truncated)`
        : patch
    const chunk = `${prefix}${slice}`
    patches.push(chunk)
    budget -= chunk.length
  }
  return `Changed files:\n${header}\n\nDiffs:${patches.join("")}`
}

export function cleanCommitMessage(text: string) {
  const line = text
    .replace(/<think>[\s\S]*?(?:<\/think>\s*|$)/g, "")
    .split("\n")
    .map((item) => item.trim())
    .find((item) => item.length > 0)
  if (!line) return ""
  return line.replace(/^["'`]+|["'`]+$/g, "").trim()
}

export function parsePullRequestJson(text: string) {
  const trimmed = text.trim()
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim()
  const source = fenced || trimmed
  const start = source.indexOf("{")
  const end = source.lastIndexOf("}")
  if (start === -1 || end <= start) return undefined
  try {
    return z.object({ title: z.string(), body: z.string() }).parse(JSON.parse(source.slice(start, end + 1)))
  } catch {
    return undefined
  }
}

export function localeLanguageHint(locale?: string) {
  const trimmed = locale?.trim()
  if (!trimmed) return undefined
  return LOCALE_LANGUAGE[trimmed] ?? trimmed
}

export function localeToBcp47(locale?: string) {
  const trimmed = locale?.trim()
  if (!trimmed) return undefined
  return LOCALE_BCP47[trimmed] ?? trimmed
}

export function formatStyleContext(input: { commits: string; locale?: string }) {
  const localeHint = localeLanguageHint(input.locale?.trim())
  const history = input.commits.trim()
  const localeLine = input.locale?.trim()
    ? localeHint
      ? `User interface locale: ${input.locale.trim()} (${localeHint})`
      : `User interface locale: ${input.locale.trim()}`
    : ""
  const historyLine = history
    ? `Repository commit history (closely match format, tone, scope naming, and language):\n${history}`
    : "Repository commit history: (none — follow project default conventions and UI locale for language)"
  return [localeLine, historyLine].filter(Boolean).join("\n\n")
}

export const GenerateLocale = Schema.optional(
  Schema.String.annotate({
    description: "User interface locale (e.g. zh, en, zht). Used for language when commit history is absent.",
  }),
)

export const GenerateCommitMessageInput = Schema.Struct({
  stageAll: Schema.optional(
    Schema.Boolean.annotate({ description: "If true (default), summarize unstaged changes (same as commit with stageAll)." }),
  ),
  files: Schema.optional(
    Schema.Array(Schema.String).annotate({
      description: "If set with stageAll=false, summarize only these paths from staged and unstaged diffs.",
    }),
  ),
  previous: Schema.optional(Schema.String.annotate({ description: "Previous message to avoid repeating when regenerating." })),
  locale: GenerateLocale,
})
  .annotate({ identifier: "VcsGenerateCommitMessageInput" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type GenerateCommitMessageInput = Schema.Schema.Type<typeof GenerateCommitMessageInput>

export const GenerateCommitMessageOutput = Schema.Struct({
  message: Schema.String,
})
  .annotate({ identifier: "VcsGenerateCommitMessageOutput" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type GenerateCommitMessageOutput = Schema.Schema.Type<typeof GenerateCommitMessageOutput>

export const GeneratePullRequestInput = Schema.Struct({
  previousTitle: Schema.optional(Schema.String),
  previousBody: Schema.optional(Schema.String),
  includePendingChanges: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "If true, include uncommitted worktree changes (vs HEAD) in addition to branch diff. Used before commit-push-and-create pre-steps.",
    }),
  ),
  locale: GenerateLocale,
})
  .annotate({ identifier: "VcsGeneratePullRequestInput" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type GeneratePullRequestInput = Schema.Schema.Type<typeof GeneratePullRequestInput>

export const GeneratePullRequestOutput = Schema.Struct({
  title: Schema.String,
  body: Schema.String,
})
  .annotate({ identifier: "VcsGeneratePullRequestOutput" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type GeneratePullRequestOutput = Schema.Schema.Type<typeof GeneratePullRequestOutput>

const fail = (message: string) => new GenerateFailedError({ message })

export const GENERIC_GENERATE_FAILED = "Failed to generate content"

const PUBLIC_GENERATE_ERRORS = new Set([
  "No changes to summarize",
  "No branch changes to summarize",
  "Failed to generate commit message",
  "Failed to generate pull request title",
  "Empty model response",
  GENERIC_GENERATE_FAILED,
])

export function sanitizeGenerateErrorMessage(cause: unknown) {
  if (GenerateFailedError.isInstance(cause) && PUBLIC_GENERATE_ERRORS.has(cause.data.message)) {
    return cause.data.message
  }
  return GENERIC_GENERATE_FAILED
}

export const toGenerateError = (cause: unknown) => fail(sanitizeGenerateErrorMessage(cause))

const withGenerateErrors = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.catchDefect((defect) => Effect.fail(toGenerateError(defect))),
    Effect.catch((cause) => Effect.fail(toGenerateError(cause))),
  )

const commitDiff = (input: GenerateCommitMessageInput) =>
  Effect.gen(function* () {
    const vcs = yield* Vcs.Service
    if (input.stageAll !== false) return yield* vcs.diff("worktree")
    if (input.files?.length) {
      const [unstaged, staged] = yield* Effect.all([vcs.diff("unstaged"), vcs.diff("staged")], { concurrency: 2 })
      const paths = new Set(input.files)
      const merged = new Map<string, Vcs.FileDiff>()
      for (const file of [...staged, ...unstaged]) {
        if (paths.has(file.file)) merged.set(file.file, file)
      }
      return [...merged.values()]
    }
    return yield* vcs.diff("staged")
  })

const gitCommitSubjects = (limit: number, range?: string) =>
  Effect.gen(function* () {
    const git = yield* Git.Service
    const ctx = yield* InstanceState.context
    const args = range
      ? ["log", range, "--no-merges", "--format=%s", "-n", String(limit)]
      : ["log", "--no-merges", "--format=%s", "-n", String(limit)]
    const result = yield* git.run(args, { cwd: ctx.directory })
    if (result.exitCode !== 0) return ""
    return result.text().trim()
  })

const streamLlmText = (input: { prompt: string; user: string; locale?: string; maxOutputTokens?: number }) =>
  Effect.gen(function* () {
    const agents = yield* Agent.Service
    const provider = yield* Provider.Service
    const llm = yield* LLM.Service

    const base = yield* agents.get("title")
    const picked = yield* provider.defaultModel()
    const smallModel =
      (yield* provider.getSmallModel(picked.providerID)) ??
      (yield* provider.getModel(picked.providerID, picked.modelID))
    const defaultModel = yield* provider.getModel(picked.providerID, picked.modelID)
    const language = localeToBcp47(input.locale)
    const baseTokens = input.maxOutputTokens ?? 512

    const attempts = [
      { model: smallModel, small: true, maxOutputTokens: baseTokens },
      ...(baseTokens < 1024 ? [{ model: smallModel, small: true, maxOutputTokens: 1024 }] : []),
      ...(defaultModel.id !== smallModel.id
        ? [{ model: defaultModel, small: true, maxOutputTokens: baseTokens }]
        : []),
      { model: defaultModel, small: false, maxOutputTokens: Math.max(baseTokens, 1024) },
    ]

    for (const attempt of attempts) {
      const messageID = MessageID.ascending()
      const user: MessageV2.User = {
        id: messageID,
        sessionID: VCS_GENERATE_SESSION,
        role: "user",
        // VCS 文案生成虽然不落入普通会话，也应提供完整的独立回合身份供统一消息契约使用。
        turnID: messageID,
        time: { created: Date.now() },
        agent: base.name,
        model: { providerID: attempt.model.providerID, modelID: attempt.model.id },
        language,
      }

      const text = yield* llm
        .stream({
          agent: { ...base, prompt: input.prompt },
          user,
          system: [],
          small: attempt.small,
          tools: {},
          model: attempt.model,
          sessionID: VCS_GENERATE_SESSION,
          retries: 2,
          maxOutputTokens: attempt.maxOutputTokens,
          messages: [{ role: "user", content: input.user }],
        })
        .pipe(
          Stream.tap((e) => (e.type === "error" ? Effect.fail(e.error) : Effect.void)),
          Stream.filter((e): e is Extract<LLM.Event, { type: "text-delta" }> => e.type === "text-delta"),
          Stream.map((e) => e.text),
          Stream.mkString,
          Effect.retry({
            schedule: Schedule.both(Schedule.exponential("2 seconds"), Schedule.recurs(2)),
          }),
          Effect.catch(() => Effect.succeed("")),
        )

      if (text.trim()) return text
    }

    return yield* Effect.fail(fail("Empty model response"))
  })

export const generateCommitMessage = (input: GenerateCommitMessageInput) =>
  withGenerateErrors(
    Effect.gen(function* () {
      const files = yield* commitDiff(input)
      if (files.length === 0) return yield* Effect.fail(fail("No changes to summarize"))

      const diffContext = formatDiffContext(files)
      const recentCommits = yield* gitCommitSubjects(COMMIT_HISTORY_LIMIT)
      const styleContext = formatStyleContext({ commits: recentCommits, locale: input.locale })
      const previous = truncatePrevious(input.previous)
      const user = [
        styleContext,
        diffContext,
        previous ? `\nPrevious attempt (write a different message):\n${previous}` : "",
        "\nGenerate one commit message.",
      ]
        .filter(Boolean)
        .join("\n\n")

      const raw = yield* streamLlmText({ prompt: PROMPT_COMMIT, user, locale: input.locale })
      const message = cleanCommitMessage(raw)
      if (!message) return yield* Effect.fail(fail("Failed to generate commit message"))
      return { message } satisfies GenerateCommitMessageOutput
    }),
  )

const mergeFileDiffs = (branch: Vcs.FileDiff, worktree: Vcs.FileDiff): Vcs.FileDiff => {
  const branchPatch = branch.patch?.trim()
  const worktreePatch = worktree.patch?.trim()
  const patch = [branchPatch, worktreePatch].filter(Boolean).join("\n")
  return {
    file: branch.file,
    patch,
    additions: branch.additions + worktree.additions,
    deletions: branch.deletions + worktree.deletions,
    status: worktree.status ?? branch.status,
  }
}

export const mergePullRequestDiffs = (branchDiff: Vcs.FileDiff[], worktreeDiff: Vcs.FileDiff[]) => {
  if (worktreeDiff.length === 0) return branchDiff
  const pending = new Map(worktreeDiff.map((file) => [file.file, file]))
  const merged = new Map<string, Vcs.FileDiff>()
  for (const file of branchDiff) {
    const worktree = pending.get(file.file)
    merged.set(file.file, worktree ? mergeFileDiffs(file, worktree) : file)
    pending.delete(file.file)
  }
  for (const file of pending.values()) merged.set(file.file, file)
  return [...merged.values()].toSorted((a, b) => a.file.localeCompare(b.file))
}

export const generatePullRequest = (input: GeneratePullRequestInput) =>
  withGenerateErrors(
    Effect.gen(function* () {
      const vcs = yield* Vcs.Service
      const [branchDiff, defaultBranch, branch] = yield* Effect.all([
        vcs.diff("branch"),
        vcs.defaultBranch(),
        vcs.branch(),
      ])
      const files =
        input.includePendingChanges === true
          ? mergePullRequestDiffs(branchDiff, yield* vcs.diff("worktree"))
          : branchDiff
      if (files.length === 0) return yield* Effect.fail(fail("No branch changes to summarize"))

      const diffContext = formatDiffContext(files)
      const base = defaultBranch ?? "main"
      const range = branch && branch !== base ? `${base}..HEAD` : undefined
      const [branchCommits, repoCommits] = yield* Effect.all([
        gitCommitSubjects(BRANCH_COMMIT_HISTORY_LIMIT, range),
        gitCommitSubjects(COMMIT_HISTORY_LIMIT),
      ])
      const styleCommits = [branchCommits, repoCommits].filter(Boolean).join("\n")
      const styleContext = formatStyleContext({ commits: styleCommits, locale: input.locale })
      const previousTitle = truncatePrevious(input.previousTitle)
      const previousBody = truncatePrevious(input.previousBody)
      const user = [
        styleContext,
        branch ? `Branch: ${branch} -> ${base}` : "",
        diffContext,
        branchCommits ? `\nCommits on this branch:\n${branchCommits}` : "",
        previousTitle || previousBody
          ? `\nPrevious attempt (write a different title and description):\nTitle: ${previousTitle ?? ""}\nBody:\n${previousBody ?? ""}`
          : "",
        "\nGenerate pull request title and body as JSON with title and body fields.",
      ]
        .filter(Boolean)
        .join("\n\n")

      const raw = yield* streamLlmText({ prompt: PROMPT_PR, user, locale: input.locale, maxOutputTokens: 2048 })
      const parsed = parsePullRequestJson(raw)
      if (!parsed?.title.trim()) return yield* Effect.fail(fail("Failed to generate pull request title"))
      return { title: parsed.title.trim(), body: parsed.body.trim() } satisfies GeneratePullRequestOutput
    }),
  )

export * as VcsGenerate from "./vcs-generate"
