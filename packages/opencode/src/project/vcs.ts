import fs from "node:fs"
import path from "node:path"
import { Effect, Layer, Context, Schema, Stream, Scope } from "effect"
import { formatPatch, structuredPatch } from "diff"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { InstanceState } from "@/effect/instance-state"
import { FileWatcher } from "@/file/watcher"
import { Git } from "@/git"
import * as Log from "@opencode-ai/core/util/log"
import { Process } from "@/util/process"
import { which } from "@/util/which"
import { zod } from "@/util/effect-zod"
import { NonNegativeInt, withStatics } from "@/util/schema"
import { NamedError } from "@opencode-ai/core/util/error"
import z from "zod"

const log = Log.create({ service: "vcs" })
const PATCH_CONTEXT_LINES = 20
const MAX_PATCH_BYTES = 10_000_000
const MAX_TOTAL_PATCH_BYTES = 10_000_000

const emptyPatch = (file: string) => formatPatch(structuredPatch(file, file, "", "", "", "", { context: 0 }))

const nums = (list: Git.Stat[]) =>
  new Map(list.map((item) => [item.file, { additions: item.additions, deletions: item.deletions }] as const))

const merge = (...lists: Git.Item[][]) => {
  const out = new Map<string, Git.Item>()
  lists.flat().forEach((item) => {
    if (!out.has(item.file)) out.set(item.file, item)
  })
  return [...out.values()]
}

const emptyBatch = () => ({ patches: new Map<string, string>(), capped: false })

const patchOpts = (ignoreWhitespace: boolean, maxOutputBytes: number): Git.PatchOptions => ({
  context: PATCH_CONTEXT_LINES,
  maxOutputBytes,
  ignoreWhitespace,
})

const parseQuotedPath = (value: string) => {
  let out = ""
  for (let idx = 1; idx < value.length; idx++) {
    const char = value[idx]
    if (char === '"') return { value: out, end: idx + 1 }
    if (char !== "\\") {
      out += char
      continue
    }

    const next = value[++idx]
    if (next === "t") out += "\t"
    else if (next === "n") out += "\n"
    else if (next === "r") out += "\r"
    else if (next === '"' || next === "\\") out += next
    else out += next ?? ""
  }
}

const parsePathToken = (value: string) => {
  if (!value.startsWith('"')) return value.split("\t")[0]
  return parseQuotedPath(value)?.value ?? value
}

const fileFromDiffPath = (value: string | undefined) => {
  if (!value || value === "/dev/null") return
  const file = parsePathToken(value)
  if (file.startsWith("a/") || file.startsWith("b/")) return file.slice(2)
  return file
}

const fileFromGitHeader = (header: string) => {
  if (header.startsWith('"')) {
    const first = parseQuotedPath(header)
    const second = first ? header.slice(first.end).trimStart() : undefined
    if (!second) return
    if (!second.startsWith('"')) return fileFromDiffPath(second)
    return fileFromDiffPath(parseQuotedPath(second)?.value)
  }

  const separator = header.indexOf(" b/")
  if (separator === -1) return
  return fileFromDiffPath(header.slice(separator + 1))
}

const fileFromPatchChunk = (chunk: string) => {
  const next = /^\+\+\+ (.+)$/m.exec(chunk)?.[1]
  const before = /^--- (.+)$/m.exec(chunk)?.[1]
  const file = fileFromDiffPath(next) ?? fileFromDiffPath(before)
  if (file) return file

  const header = /^diff --git (.+)$/m.exec(chunk)?.[1]
  return fileFromGitHeader(header ?? "")
}

const splitGitPatch = (patch: Git.Patch) => {
  const starts = [...patch.text.matchAll(/(?:^|\n)diff --git /g)].map((match) =>
    match[0].startsWith("\n") ? match.index + 1 : match.index,
  )
  const chunks = starts.map((start, index) => patch.text.slice(start, starts[index + 1] ?? patch.text.length))
  if (!patch.truncated) return chunks
  return chunks.slice(0, -1)
}

type PatchSource = "head" | "index" | "cached"

const batchPatches = Effect.fnUntraced(function* (
  git: Git.Interface,
  cwd: string,
  ref: string,
  list: Git.Item[],
  source: PatchSource,
  ignoreWhitespace: boolean,
) {
  if (list.length === 0) return { patches: new Map<string, string>(), capped: false }

  const opts = patchOpts(ignoreWhitespace, MAX_TOTAL_PATCH_BYTES)
  const result =
    source === "head"
      ? yield* git.patchAll(cwd, ref, opts)
      : source === "index"
        ? yield* git.patchAllWorktree(cwd, opts)
        : yield* git.patchAllCached(cwd, opts)
  if (result.truncated) log.warn("batched patch exceeded byte limit", { max: MAX_TOTAL_PATCH_BYTES })

  return {
    patches: splitGitPatch(result).reduce((acc, patch, index) => {
      const file = fileFromPatchChunk(patch) ?? list[index]?.file
      if (!file) return acc
      acc.set(file, (acc.get(file) ?? "") + patch)
      return acc
    }, new Map<string, string>()),
    capped: result.truncated,
  }
})

const nativePatch = Effect.fnUntraced(function* (
  git: Git.Interface,
  cwd: string,
  ref: string | undefined,
  item: Git.Item,
  source: PatchSource,
  ignoreWhitespace: boolean,
) {
  const opts = patchOpts(ignoreWhitespace, MAX_PATCH_BYTES)
  if (item.code === "??" || !ref) {
    const untracked = yield* git.patchUntracked(cwd, item.file, opts)
    if (!untracked.truncated && untracked.text) return untracked.text
    if (untracked.truncated) log.warn("patch exceeded byte limit", { file: item.file, max: MAX_PATCH_BYTES })
    return emptyPatch(item.file)
  }

  const result =
    source === "head"
      ? yield* git.patch(cwd, ref, item.file, opts)
      : source === "index"
        ? yield* git.patchWorktree(cwd, item.file, opts)
        : yield* git.patchCached(cwd, item.file, opts)
  if (!result.truncated && result.text) return result.text

  if (result.truncated) log.warn("patch exceeded byte limit", { file: item.file, max: MAX_PATCH_BYTES })
  return emptyPatch(item.file)
})

const totalPatch = (file: string, patch: string, total: number) => {
  if (total + Buffer.byteLength(patch) <= MAX_TOTAL_PATCH_BYTES) return { patch, capped: false }
  log.warn("total patch budget exceeded", { file, max: MAX_TOTAL_PATCH_BYTES })
  return { patch: emptyPatch(file), capped: true }
}

const patchForItem = Effect.fnUntraced(function* (
  git: Git.Interface,
  cwd: string,
  ref: string | undefined,
  item: Git.Item,
  batch: { patches: Map<string, string>; capped: boolean },
  capped: boolean,
  source: PatchSource,
  ignoreWhitespace: boolean,
) {
  if (capped) return emptyPatch(item.file)

  const batched = batch.patches.get(item.file)
  if (batched !== undefined) return batched
  if (item.code !== "??" && batch.capped) return emptyPatch(item.file)
  return yield* nativePatch(git, cwd, ref, item, source, ignoreWhitespace)
})

const files = Effect.fnUntraced(function* (
  git: Git.Interface,
  cwd: string,
  ref: string | undefined,
  list: Git.Item[],
  map: Map<string, { additions: number; deletions: number }>,
  batch: { patches: Map<string, string>; capped: boolean },
  source: PatchSource,
  ignoreWhitespace: boolean,
) {
  const next: FileDiff[] = []
  let total = 0
  let capped = false

  for (const item of list.toSorted((a, b) => a.file.localeCompare(b.file))) {
    const stat = map.get(item.file) ?? (item.status === "added" ? yield* git.statUntracked(cwd, item.file) : undefined)
    const patch = yield* patchForItem(git, cwd, ref, item, batch, capped, source, ignoreWhitespace)
    const result: { patch: string; capped: boolean } = capped
      ? { patch, capped: true }
      : totalPatch(item.file, patch, total)
    capped = capped || result.capped
    if (!capped) {
      total += Buffer.byteLength(result.patch)
      capped = total >= MAX_TOTAL_PATCH_BYTES
    }
    next.push({
      file: item.file,
      patch: result.patch,
      additions: stat?.additions ?? 0,
      deletions: stat?.deletions ?? 0,
      status: item.status,
    })
  }

  return next
})

/** Parent `git diff` lists submodule roots only; collect per-file diffs inside each submodule worktree. */
const diffAgainstRefCore = Effect.fnUntraced(function* (git: Git.Interface, cwd: string, ref: string, ignoreWhitespace: boolean) {
  const opts = { ignoreWhitespace }
  const [list, stats, extra] = yield* Effect.all(
    [git.diff(cwd, ref, opts), git.stats(cwd, ref, opts), git.status(cwd)],
    { concurrency: 3 },
  )
  return yield* files(
    git,
    cwd,
    ref,
    merge(
      list,
      extra.filter((item) => item.code === "??"),
    ),
    nums(stats),
    yield* batchPatches(git, cwd, ref, list, "head", ignoreWhitespace),
    "head",
    ignoreWhitespace,
  )
})

const appendSubmoduleNestedDiffs = Effect.fnUntraced(function* (
  git: Git.Interface,
  parentCwd: string,
  parentRef: string | undefined,
  list: FileDiff[],
) {
  const expandNested = parentRef === undefined || parentRef === "HEAD"
  if (!expandNested) return list

  const out: FileDiff[] = [...list]
  const parentResolved = path.resolve(parentCwd)

  for (const row of list) {
    if (!row.file) continue
    const rel = row.file.replace(/\\/g, "/").replace(/\/+$/, "")
    if (!rel || rel === "." || rel === "..") continue

    const nestedAbs = path.resolve(parentCwd, rel)
    if (nestedAbs === parentResolved) continue

    let hasGit = false
    try {
      hasGit = fs.existsSync(path.join(nestedAbs, ".git"))
    } catch {
      continue
    }
    if (!hasGit) continue

    const nestedHasHead = yield* git.hasHead(nestedAbs)
    const nestedFiles = nestedHasHead
      ? yield* diffAgainstRefCore(git, nestedAbs, "HEAD", false)
      : yield* files(git, nestedAbs, undefined, yield* git.status(nestedAbs), new Map(), emptyBatch(), "head", false)

    const prefix = `${rel}/`
    for (const n of nestedFiles) {
      const sub = n.file.replace(/^\/+/, "").replace(/\\/g, "/")
      if (!sub) continue
      const nf = `${prefix}${sub}`.replace(/\/+/g, "/")
      if (out.some((x) => x.file === nf)) continue
      out.push({
        file: nf,
        patch: n.patch,
        additions: n.additions,
        deletions: n.deletions,
        status: n.status,
      })
    }
  }

  return out
})

const diffAgainstRef = Effect.fnUntraced(function* (git: Git.Interface, cwd: string, ref: string, ignoreWhitespace: boolean) {
  const base = yield* diffAgainstRefCore(git, cwd, ref, ignoreWhitespace)
  return yield* appendSubmoduleNestedDiffs(git, cwd, ref, base)
})

/** Unstaged diff: take `git status --porcelain` rows where the worktree column changed (`??` or `code[1] !== " "`), pair with worktree `numstat`, and build index-side patches vs `HEAD`. */
const diffUnstaged = Effect.fnUntraced(function* (git: Git.Interface, cwd: string, ignoreWhitespace: boolean) {
  if (!(yield* git.hasHead(cwd))) return []
  const opts = { ignoreWhitespace }
  const [status, stats] = yield* Effect.all([git.status(cwd), git.statsWorktree(cwd, opts)], { concurrency: 2 })
  const list = status.filter((item) => item.code === "??" || item.code[1] !== " ")
  const tracked = list.filter((item) => item.code !== "??")
  return yield* files(
    git,
    cwd,
    "HEAD",
    list,
    nums(stats),
    yield* batchPatches(git, cwd, "HEAD", tracked, "index", ignoreWhitespace),
    "index",
    ignoreWhitespace,
  )
})

/** Staged diff: take `git status --porcelain` rows where the index column shows a staged change (`code[0]` not space/`?`), pair with `--cached` `numstat`, and build cached patches vs `HEAD`. */
const diffStaged = Effect.fnUntraced(function* (git: Git.Interface, cwd: string, ignoreWhitespace: boolean) {
  if (!(yield* git.hasHead(cwd))) return []
  const opts = { ignoreWhitespace }
  const [status, stats] = yield* Effect.all([git.status(cwd), git.statsCached(cwd, opts)], { concurrency: 2 })
  const list = status.filter((item) => item.code[0] !== " " && item.code[0] !== "?")
  return yield* files(
    git,
    cwd,
    "HEAD",
    list,
    nums(stats),
    yield* batchPatches(git, cwd, "HEAD", list, "cached", ignoreWhitespace),
    "cached",
    ignoreWhitespace,
  )
})

export const Mode = Schema.Literals(["unstaged", "staged", "worktree", "branch"]).pipe(withStatics((s) => ({ zod: zod(s) })))
export type Mode = Schema.Schema.Type<typeof Mode>

export const Event = {
  BranchUpdated: BusEvent.define(
    "vcs.branch.updated",
    Schema.Struct({
      branch: Schema.optional(Schema.String),
    }),
  ),
}

export const Info = Schema.Struct({
  branch: Schema.optional(Schema.String),
  default_branch: Schema.optional(Schema.String),
  gh_cli: Schema.optional(Schema.Boolean),
  git_installed: Schema.optional(Schema.Boolean),
  local_git: Schema.optional(Schema.Boolean),
})
  .annotate({ identifier: "VcsInfo" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type Info = Schema.Schema.Type<typeof Info>

export const FileDiff = Schema.Struct({
  file: Schema.String,
  patch: Schema.String,
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
  status: Schema.optional(Schema.Literals(["added", "deleted", "modified"])),
})
  .annotate({ identifier: "VcsFileDiff" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type FileDiff = Schema.Schema.Type<typeof FileDiff>

export const CreateBranchInput = Schema.Struct({
  name: Schema.String.annotate({ description: "Full branch name to create and check out (e.g. 'codex/my-feature')" }),
})
  .annotate({ identifier: "VcsCreateBranchInput" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type CreateBranchInput = Schema.Schema.Type<typeof CreateBranchInput>

export const CreateBranchOutput = Schema.Struct({
  branch: Schema.String,
})
  .annotate({ identifier: "VcsCreateBranchOutput" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type CreateBranchOutput = Schema.Schema.Type<typeof CreateBranchOutput>

export const SwitchBranchInput = Schema.Struct({
  name: Schema.String.annotate({ description: "Branch name to switch to" }),
})
  .annotate({ identifier: "VcsSwitchBranchInput" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type SwitchBranchInput = Schema.Schema.Type<typeof SwitchBranchInput>

export const ListBranchesOutput = Schema.Struct({
  current: Schema.optional(Schema.String),
  branches: Schema.Array(Schema.String),
})
  .annotate({ identifier: "VcsListBranchesOutput" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type ListBranchesOutput = Schema.Schema.Type<typeof ListBranchesOutput>

export const CommitInput = Schema.Struct({
  message: Schema.String.annotate({ description: "Commit message" }),
  stageAll: Schema.optional(
    Schema.Boolean.annotate({ description: "If true (default), runs `git add -A` before committing." }),
  ),
  files: Schema.optional(
    Schema.Array(Schema.String).annotate({
      description: "If set, runs `git add --` for these paths instead of `git add -A`.",
    }),
  ),
})
  .annotate({ identifier: "VcsCommitInput" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type CommitInput = Schema.Schema.Type<typeof CommitInput>

export const CommitOutput = Schema.Struct({
  hash: Schema.String,
  branch: Schema.optional(Schema.String),
})
  .annotate({ identifier: "VcsCommitOutput" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type CommitOutput = Schema.Schema.Type<typeof CommitOutput>

export const PushInput = Schema.Struct({
  force: Schema.optional(
    Schema.Boolean.annotate({ description: "If true, use `--force-with-lease` to force-push the current branch." }),
  ),
})
  .annotate({ identifier: "VcsPushInput" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type PushInput = Schema.Schema.Type<typeof PushInput>

export const PushOutput = Schema.Struct({
  branch: Schema.optional(Schema.String),
  output: Schema.String,
})
  .annotate({ identifier: "VcsPushOutput" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type PushOutput = Schema.Schema.Type<typeof PushOutput>

export const CreatePullRequestInput = Schema.Struct({
  title: Schema.optional(Schema.String.annotate({ description: "Pull request title" })),
  body: Schema.optional(Schema.String.annotate({ description: "Pull request body" })),
  draft: Schema.optional(Schema.Boolean.annotate({ description: "If true, create the pull request as a draft." })),
  web: Schema.optional(Schema.Boolean.annotate({ description: "If true, open the pull request form in the browser." })),
  fill: Schema.optional(
    Schema.Boolean.annotate({ description: "If true and title/body are omitted, use commit info via `gh pr create --fill`." }),
  ),
})
  .annotate({ identifier: "VcsCreatePullRequestInput" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type CreatePullRequestInput = Schema.Schema.Type<typeof CreatePullRequestInput>

export const CreatePullRequestOutput = Schema.Struct({
  url: Schema.optional(Schema.String),
  output: Schema.String,
  branch: Schema.optional(Schema.String),
})
  .annotate({ identifier: "VcsCreatePullRequestOutput" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type CreatePullRequestOutput = Schema.Schema.Type<typeof CreatePullRequestOutput>

export const ExistingPullRequest = Schema.Struct({
  title: Schema.String,
  url: Schema.String,
})
  .annotate({ identifier: "VcsExistingPullRequest" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type ExistingPullRequest = Schema.Schema.Type<typeof ExistingPullRequest>

export const PullRequestReadiness = Schema.Struct({
  git_repo: Schema.Boolean,
  gh_cli: Schema.Boolean,
  gh_authenticated: Schema.Boolean,
  remote: Schema.Boolean,
  branch: Schema.optional(Schema.String),
  has_commits: Schema.Boolean,
  worktree_changes: Schema.Boolean,
  staged_changes: Schema.Boolean,
  unpushed_commits: Schema.Boolean,
  branch_on_remote: Schema.Boolean,
  existing_pull_request: Schema.optional(ExistingPullRequest),
})
  .annotate({ identifier: "VcsPullRequestReadiness" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type PullRequestReadiness = Schema.Schema.Type<typeof PullRequestReadiness>

export const PullRequestStatus = Schema.Struct({
  git_repo: Schema.Boolean,
  gh_cli: Schema.Boolean,
  gh_authenticated: Schema.Boolean,
  branch: Schema.optional(Schema.String),
  existing_pull_request: Schema.optional(ExistingPullRequest),
})
  .annotate({ identifier: "VcsPullRequestStatus" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type PullRequestStatus = Schema.Schema.Type<typeof PullRequestStatus>

export const CreateBranchFailedError = (() => {
  class Err extends Error {
    readonly _tag = "VcsCreateBranchFailedError"
    constructor(message: string) {
      super(message)
    }
  }
  return Err
})()

export const SwitchBranchFailedError = (() => {
  class Err extends Error {
    readonly _tag = "VcsSwitchBranchFailedError"
    constructor(message: string) {
      super(message)
    }
  }
  return Err
})()

export const CommitFailedError = NamedError.create(
  "VcsCommitFailedError",
  z.object({
    message: z.string(),
  }),
)

export const PushFailedError = NamedError.create(
  "VcsPushFailedError",
  z.object({
    message: z.string(),
  }),
)

export const CreatePullRequestFailedError = NamedError.create(
  "VcsCreatePullRequestFailedError",
  z.object({
    message: z.string(),
  }),
)

export const isVcsOperationFailedError = (error: unknown) =>
  CommitFailedError.isInstance(error) ||
  PushFailedError.isInstance(error) ||
  CreatePullRequestFailedError.isInstance(error)

export const toVcsOperationError = (
  cause: unknown,
  ErrorType: typeof CommitFailedError | typeof PushFailedError | typeof CreatePullRequestFailedError,
) =>
  isVcsOperationFailedError(cause)
    ? cause
    : new ErrorType({
        message: cause instanceof Error ? cause.message : String(cause),
      })

export type DiffOptions = {
  readonly ignoreWhitespace?: boolean
}

const githubUrlFromText = (text: string) => {
  const match = text.match(/https:\/\/github\.com\/[^\s)>"]+/i)
  if (!match) return undefined
  return match[0].replace(/[)\].,]+$/, "")
}

export const existingPullRequestFromGhOutput = (output: string): ExistingPullRequest | undefined => {
  const url = githubUrlFromText(output)
  if (!url) return undefined
  if (!/already exists/i.test(output)) return undefined
  return { title: url, url }
}

export const existingPullRequestFromGhView = (text: string): ExistingPullRequest | undefined => {
  const trimmed = text.trim()
  if (!trimmed) return undefined
  const data = JSON.parse(trimmed) as { title?: string; url?: string; state?: string }
  const state = data.state?.trim().toUpperCase()
  if (state && state !== "OPEN") return undefined
  const url = data.url?.trim()
  if (!url) return undefined
  const title = data.title?.trim()
  return { title: title || url, url }
}

export const existingPullRequestFromGhList = (text: string): ExistingPullRequest | undefined => {
  const trimmed = text.trim()
  if (!trimmed || trimmed === "[]") return undefined
  const data = JSON.parse(trimmed) as Array<{ title?: string; url?: string }>
  const first = data[0]
  if (!first) return undefined
  const url = first.url?.trim()
  if (!url) return undefined
  const title = first.title?.trim()
  return { title: title || url, url }
}

export const pullRequestCreateArgs = (input: CreatePullRequestInput): string[] => {
  const title = input.title?.trim() ?? ""
  const body = input.body?.trim() ?? ""
  const args = ["pr", "create"]
  if (input.web) {
    args.push("--web")
    return args
  }
  if (input.draft) args.push("--draft")
  if (title && body) {
    args.push("--title", title, "--body", body)
  } else if (title) {
    args.push("--title", title, "--body", "")
  } else if (body) {
    args.push("--fill", "--body", body)
  } else if (input.fill ?? true) {
    args.push("--fill")
  }
  return args
}

/** `gh pr view` does not support `--state`; filter OPEN in code and fall back to `gh pr list`. */
export const findExistingOpenPullRequest = async (
  gh: string,
  cwd: string,
  branch: string,
): Promise<ExistingPullRequest | undefined> => {
  const view = await Process.text([gh, "pr", "view", "--json", "title,url,state"], { cwd, nothrow: true })
  if (view.code === 0) {
    try {
      const fromView = existingPullRequestFromGhView(view.text)
      if (fromView) return fromView
    } catch {
      /* invalid JSON */
    }
  }
  const list = await Process.text(
    [gh, "pr", "list", "--head", branch, "--state", "open", "--json", "title,url", "-L", "1"],
    { cwd, nothrow: true },
  )
  if (list.code !== 0) return undefined
  try {
    return existingPullRequestFromGhList(list.text)
  } catch {
    return undefined
  }
}

export interface Interface {
  readonly init: () => Effect.Effect<void>
  readonly branch: () => Effect.Effect<string | undefined>
  readonly defaultBranch: () => Effect.Effect<string | undefined>
  readonly diff: (mode: Mode, options?: DiffOptions) => Effect.Effect<FileDiff[]>
  readonly createBranch: (input: CreateBranchInput) => Effect.Effect<CreateBranchOutput>
  readonly switchBranch: (input: SwitchBranchInput) => Effect.Effect<CreateBranchOutput>
  readonly listBranches: () => Effect.Effect<ListBranchesOutput>
  readonly commit: (input: CommitInput) => Effect.Effect<CommitOutput, InstanceType<typeof CommitFailedError>>
  readonly push: (input?: PushInput) => Effect.Effect<PushOutput, InstanceType<typeof PushFailedError>>
  readonly createPullRequest: (
    input: CreatePullRequestInput,
  ) => Effect.Effect<CreatePullRequestOutput, InstanceType<typeof CreatePullRequestFailedError>>
  readonly pullRequestReadiness: () => Effect.Effect<PullRequestReadiness>
  readonly pullRequestStatus: () => Effect.Effect<PullRequestStatus>
}

interface State {
  current: string | undefined
  root: Git.Base | undefined
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Vcs") {}

export const layer: Layer.Layer<Service, never, Git.Service | Bus.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const git = yield* Git.Service
    const bus = yield* Bus.Service
    const scope = yield* Scope.Scope

    const isGitRepo = Effect.fn("Vcs.isGitRepo")(function* (cwd: string) {
      const dotGit = path.join(cwd, ".git")
      return yield* Effect.sync(() => {
        try {
          return fs.existsSync(dotGit)
        } catch {
          return false
        }
      })
    })

    const state = yield* InstanceState.make<State>(
      Effect.fn("Vcs.state")(function* (ctx) {
        const get = Effect.fnUntraced(function* () {
          if (!(yield* isGitRepo(ctx.directory))) return
          return yield* git.branch(ctx.directory)
        })
        const gitRepo = yield* isGitRepo(ctx.directory)
        const [current, root] = gitRepo
          ? yield* Effect.all([git.branch(ctx.directory), git.defaultBranch(ctx.directory)], { concurrency: 2 })
          : [undefined, undefined]
        const value = { current, root }
        log.info("initialized", { branch: value.current, default_branch: value.root?.name })

        // 仅在本目录有本地 .git 时 publish 初始 BranchUpdated：前端有 vcs 持久化缓存
        // （per-workspace localStorage），需要主动同步 branch；非 git 目录不应广播，
        // 否则会污染 bus 订阅测试并在 instance 启动时误触发无关 handler。
        if (gitRepo) yield* bus.publish(Event.BranchUpdated, { branch: value.current })

        yield* bus.subscribe(FileWatcher.Event.Updated).pipe(
          Stream.filter((evt) => evt.properties.file.endsWith("HEAD")),
          Stream.runForEach((_evt) =>
            Effect.gen(function* () {
              const next = yield* get()
              if (next !== value.current) {
                log.info("branch changed", { from: value.current, to: next })
                value.current = next
                yield* bus.publish(Event.BranchUpdated, { branch: next })
              }
            }),
          ),
          Effect.forkScoped,
        )

        return value
      }),
    )

    const ensureFresh = Effect.fn("Vcs.ensureFresh")(function* () {
      const cached = yield* InstanceState.get(state)
      if (cached.current) return cached
      const ctx = yield* InstanceState.context
      if (!(yield* isGitRepo(ctx.directory))) return cached
      yield* InstanceState.invalidate(state)
      return yield* InstanceState.get(state)
    })

    return Service.of({
      init: Effect.fn("Vcs.init")(function* () {
        yield* InstanceState.get(state).pipe(Effect.forkIn(scope))
      }),
      branch: Effect.fn("Vcs.branch")(function* () {
        return (yield* ensureFresh()).current
      }),
      defaultBranch: Effect.fn("Vcs.defaultBranch")(function* () {
        return (yield* ensureFresh()).root?.name
      }),
      diff: Effect.fn("Vcs.diff")(function* (mode: Mode, options?: DiffOptions) {
        const ignoreWhitespace = options?.ignoreWhitespace === true
        const value = yield* InstanceState.get(state)
        const ctx = yield* InstanceState.context
        if (!(yield* isGitRepo(ctx.directory))) return []
        if (mode === "unstaged") return yield* diffUnstaged(git, ctx.directory, ignoreWhitespace)
        if (mode === "staged") return yield* diffStaged(git, ctx.directory, ignoreWhitespace)
        if (mode === "worktree") {
          if (!(yield* git.hasHead(ctx.directory))) return []
          return yield* diffAgainstRef(git, ctx.directory, "HEAD", ignoreWhitespace)
        }

        if (!value.root) return []
        if (value.current && value.current === value.root.name) return []
        const ref = yield* git.mergeBase(ctx.directory, value.root.ref)
        if (!ref) return []
        return yield* diffAgainstRef(git, ctx.directory, ref, ignoreWhitespace)
      }),
      createBranch: Effect.fn("Vcs.createBranch")(function* (input: CreateBranchInput) {
        const ctx = yield* InstanceState.context
        if (!(yield* isGitRepo(ctx.directory))) {
          throw new CreateBranchFailedError("This project is not a git repository")
        }
        const name = input.name.trim()
        if (!name) throw new CreateBranchFailedError("Branch name is required")
        if (name.endsWith("/")) throw new CreateBranchFailedError("Branch name cannot end with '/'")
        // Security: even with argv (no shell), git may treat a leading `-` as a CLI option (e.g. `--upload-pack=...`).
        // Why no `--` after `switch -c`: the next token after `-c` is parsed as the new branch name; inserting `--`
        // there would create a branch literally named `--`. Rejecting `-` prefixes is enough to block this injection path.
        if (name.startsWith("-")) throw new CreateBranchFailedError("Branch name cannot start with '-'")

        const switchResult = yield* git.run(["switch", "-c", name], { cwd: ctx.directory })
        const result =
          switchResult.exitCode === 0
            ? switchResult
            : yield* git.run(["checkout", "-b", name], { cwd: ctx.directory })

        if (result.exitCode !== 0) {
          const stderr = result.stderr.toString("utf8").trim()
          const stdout = result.text().trim()
          throw new CreateBranchFailedError(stderr || stdout || "Failed to create branch")
        }

        const value = yield* InstanceState.get(state)
        if (name !== value.current) {
          value.current = name
          yield* bus.publish(Event.BranchUpdated, { branch: name })
        }
        return { branch: name }
      }),
      switchBranch: Effect.fn("Vcs.switchBranch")(function* (input: SwitchBranchInput) {
        const ctx = yield* InstanceState.context
        if (!(yield* isGitRepo(ctx.directory))) {
          throw new SwitchBranchFailedError("This project is not a git repository")
        }
        const name = input.name.trim()
        if (!name) throw new SwitchBranchFailedError("Branch name is required")
        if (name.startsWith("-")) throw new SwitchBranchFailedError("Branch name cannot start with '-'")
        // `git switch` accepts `--` as end-of-options. Do not use `--` on the `checkout` fallback: after `--`, git
        // treats the argument as a pathspec (checking out paths from HEAD), not a branch name. The `-` prefix check
        // above still blocks option-style injection for both code paths.

        const switchResult = yield* git.run(["switch", "--", name], { cwd: ctx.directory })
        const result =
          switchResult.exitCode === 0
            ? switchResult
            : yield* git.run(["checkout", name], { cwd: ctx.directory })

        if (result.exitCode !== 0) {
          const stderr = result.stderr.toString("utf8").trim()
          const stdout = result.text().trim()
          throw new SwitchBranchFailedError(stderr || stdout || "Failed to switch branch")
        }

        const value = yield* InstanceState.get(state)
        if (name !== value.current) {
          value.current = name
          yield* bus.publish(Event.BranchUpdated, { branch: name })
        }
        return { branch: name }
      }),
      commit: Effect.fn("Vcs.commit")(function* (input: CommitInput) {
        const ctx = yield* InstanceState.context
        if (!(yield* isGitRepo(ctx.directory)))
          return yield* Effect.fail(new CommitFailedError({ message: "This project is not a git repository" }))
        const message = input.message.trim()
        if (!message) return yield* Effect.fail(new CommitFailedError({ message: "Commit message is required" }))

        if (input.files?.length) {
          const add = yield* git.run(["add", "--", ...input.files], { cwd: ctx.directory })
          if (add.exitCode !== 0) {
            const stderr = add.stderr.toString("utf8").trim()
            return yield* Effect.fail(new CommitFailedError({ message: stderr || "Failed to stage changes" }))
          }
        } else if (input.stageAll !== false) {
          const add = yield* git.run(["add", "-A"], { cwd: ctx.directory })
          if (add.exitCode !== 0) {
            const stderr = add.stderr.toString("utf8").trim()
            return yield* Effect.fail(new CommitFailedError({ message: stderr || "Failed to stage changes" }))
          }
        }

        const commitResult = yield* git.run(["commit", "-m", message], { cwd: ctx.directory })
        if (commitResult.exitCode !== 0) {
          const stderr = commitResult.stderr.toString("utf8").trim()
          const stdout = commitResult.text().trim()
          return yield* Effect.fail(new CommitFailedError({ message: stderr || stdout || "Failed to commit" }))
        }

        const hashResult = yield* git.run(["rev-parse", "--short", "HEAD"], { cwd: ctx.directory })
        const hash = hashResult.exitCode === 0 ? hashResult.text().trim() : ""
        const value = yield* InstanceState.get(state)
        return { hash, branch: value.current }
      }),
      push: Effect.fn("Vcs.push")(function* (input?: PushInput) {
        const ctx = yield* InstanceState.context
        if (!(yield* isGitRepo(ctx.directory)))
          return yield* Effect.fail(new PushFailedError({ message: "This project is not a git repository" }))
        const value = yield* InstanceState.get(state)
        const branch = value.current

        const base = ["push", "--porcelain"]
        if (input?.force) base.push("--force-with-lease")
        const args = branch ? [...base, "-u", "origin", branch] : base
        const result = yield* git.run(args, { cwd: ctx.directory })
        const stdout = result.text()
        const stderr = result.stderr.toString("utf8")
        if (result.exitCode !== 0) {
          const combined = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n")
          return yield* Effect.fail(new PushFailedError({ message: combined || "Failed to push" }))
        }
        return { branch, output: (stdout || stderr).trim() }
      }),
      createPullRequest: Effect.fn("Vcs.createPullRequest")(function* (input: CreatePullRequestInput) {
        const ctx = yield* InstanceState.context
        if (!(yield* isGitRepo(ctx.directory))) {
          return yield* Effect.fail(new CreatePullRequestFailedError({ message: "This project is not a git repository" }))
        }
        const gh = which("gh")
        if (!gh) return yield* Effect.fail(new CreatePullRequestFailedError({ message: "GitHub CLI is not installed" }))
        const args = pullRequestCreateArgs(input)

        const result = yield* Effect.promise(() =>
          Process.text([gh, ...args], { cwd: ctx.directory, nothrow: true }),
        )
        const output = [result.text.trim(), result.stderr.toString("utf8").trim()].filter(Boolean).join("\n")
        const value = yield* InstanceState.get(state)
        if (result.code !== 0) {
          const existing = existingPullRequestFromGhOutput(output)
          if (existing) return { url: existing.url, output, branch: value.current }
          return yield* Effect.fail(
            new CreatePullRequestFailedError({
              message: output.split(/\r?\n/)[0]?.trim() || "Failed to create pull request",
            }),
          )
        }
        return {
          url: githubUrlFromText(output),
          output,
          branch: value.current,
        }
      }),
      pullRequestReadiness: Effect.fn("Vcs.pullRequestReadiness")(function* () {
        const ctx = yield* InstanceState.context
        const gh = which("gh")
        const gh_cli = !!gh
        let gh_authenticated = false
        if (gh) {
          const auth = yield* Effect.promise(() =>
            Process.text([gh, "auth", "status"], { cwd: ctx.directory, nothrow: true }),
          )
          gh_authenticated = auth.code === 0
        }

        const git_repo = yield* isGitRepo(ctx.directory)
        if (!git_repo) {
          return {
            git_repo: false,
            gh_cli,
            gh_authenticated,
            remote: false,
            has_commits: false,
            worktree_changes: false,
            staged_changes: false,
            unpushed_commits: false,
            branch_on_remote: false,
          }
        }

        const value = yield* ensureFresh()
        const branch = value.current
        const remoteResult = yield* git.run(["remote"], { cwd: ctx.directory })
        const remote = remoteResult.exitCode === 0 && remoteResult.text().trim().length > 0
        const has_commits = yield* git.hasHead(ctx.directory)
        const status = yield* git.status(ctx.directory)
        const worktree_changes = status.some((item) => item.code === "??" || item.code[1] !== " ")
        const staged_changes = status.some((item) => item.code[0] !== " " && item.code[0] !== "?")

        let unpushed_commits = false
        let branch_on_remote = false
        if (branch && remote) {
          const upstream = yield* git.run(["rev-parse", "--verify", "@{u}"], { cwd: ctx.directory })
          if (upstream.exitCode === 0) {
            branch_on_remote = true
            const ahead = yield* git.run(["rev-list", "--count", "@{u}..HEAD"], { cwd: ctx.directory })
            unpushed_commits =
              ahead.exitCode === 0 && Number.parseInt(ahead.text().trim(), 10) > 0
          } else {
            const ls = yield* git.run(["ls-remote", "--heads", "origin", branch], { cwd: ctx.directory })
            branch_on_remote = ls.exitCode === 0 && ls.text().trim().length > 0
            if (branch_on_remote) {
              const ahead = yield* git.run(["rev-list", "--count", `origin/${branch}..HEAD`], { cwd: ctx.directory })
              unpushed_commits =
                ahead.exitCode === 0 && Number.parseInt(ahead.text().trim(), 10) > 0
            } else {
              const unpushed = yield* git.run(
                ["rev-list", "--count", "HEAD", "--not", "--remotes=origin"],
                { cwd: ctx.directory },
              )
              unpushed_commits =
                unpushed.exitCode === 0 && Number.parseInt(unpushed.text().trim(), 10) > 0
            }
          }
        }

        let existing_pull_request: ExistingPullRequest | undefined
        if (gh && gh_authenticated && branch) {
          existing_pull_request = yield* Effect.promise(() =>
            findExistingOpenPullRequest(gh, ctx.directory, branch),
          )
        }

        return {
          git_repo,
          gh_cli,
          gh_authenticated,
          remote,
          branch,
          has_commits,
          worktree_changes,
          staged_changes,
          unpushed_commits,
          branch_on_remote,
          existing_pull_request,
        }
      }),
      pullRequestStatus: Effect.fn("Vcs.pullRequestStatus")(function* () {
        const ctx = yield* InstanceState.context
        const gh = which("gh")
        const gh_cli = !!gh
        let gh_authenticated = false
        if (gh) {
          const auth = yield* Effect.promise(() =>
            Process.text([gh, "auth", "status"], { cwd: ctx.directory, nothrow: true }),
          )
          gh_authenticated = auth.code === 0
        }

        const git_repo = yield* isGitRepo(ctx.directory)
        if (!git_repo) {
          return { git_repo: false, gh_cli, gh_authenticated }
        }

        const value = yield* ensureFresh()
        const branch = value.current
        let existing_pull_request: ExistingPullRequest | undefined
        if (gh && gh_authenticated && branch) {
          existing_pull_request = yield* Effect.promise(() =>
            findExistingOpenPullRequest(gh, ctx.directory, branch),
          )
        }

        return {
          git_repo: true,
          gh_cli,
          gh_authenticated,
          branch,
          existing_pull_request,
        }
      }),
      listBranches: Effect.fn("Vcs.listBranches")(function* () {
        const ctx = yield* InstanceState.context
        if (!(yield* isGitRepo(ctx.directory))) return { current: undefined, branches: [] }

        const refsResult = yield* git.run(
          ["for-each-ref", "--format=%(refname:short)", "refs/heads"],
          { cwd: ctx.directory },
        )
        const all =
          refsResult.exitCode === 0
            ? Array.from(
                new Set(
                  refsResult
                    .text()
                    .split("\n")
                    .map((s) => s.trim())
                    .filter(Boolean),
                ),
              )
            : []

        // 排除已在其它 worktree 检出的分支：在当前目录 `git checkout` 它会被 git 直接拒绝
        // ("already checked out at ..."), 在 UI 列表里展示徒增困扰，干脆从来源端过滤掉。
        const claimedByOtherWorktree = new Set<string>()
        const worktreesResult = yield* git.run(["worktree", "list", "--porcelain"], { cwd: ctx.directory })
        // macOS / Linux 上 `git worktree list` 输出可能是 realpath（如 /private/var/...），
        // 而 ctx.directory 可能是软链（如 /var/...）；用 fs.realpathSync + 去 trailing slash 归一化后比对，
        // 否则主 worktree 自身会被误判为「其它 worktree」，导致当前分支被错误地加入 claimedByOtherWorktree。
        const normalizePath = (p: string) => {
          try {
            return fs.realpathSync(p).replace(/\/+$/, "")
          } catch {
            return p.replace(/\/+$/, "")
          }
        }
        const currentDirNormalized = normalizePath(ctx.directory)
        if (worktreesResult.exitCode === 0) {
          let currentPath: string | undefined
          let currentBranch: string | undefined
          const flush = () => {
            if (currentPath && currentBranch && normalizePath(currentPath) !== currentDirNormalized) {
              const short = currentBranch.startsWith("refs/heads/")
                ? currentBranch.slice("refs/heads/".length)
                : currentBranch
              claimedByOtherWorktree.add(short)
            }
            currentPath = undefined
            currentBranch = undefined
          }
          for (const line of worktreesResult.text().split("\n")) {
            const trimmed = line.trim()
            if (!trimmed) {
              flush()
              continue
            }
            if (trimmed.startsWith("worktree ")) {
              flush()
              currentPath = trimmed.slice("worktree ".length).trim()
            } else if (trimmed.startsWith("branch ")) {
              currentBranch = trimmed.slice("branch ".length).trim()
            }
          }
          flush()
        }

        const value = yield* InstanceState.get(state)
        const branches = all.filter((b) => b === value.current || !claimedByOtherWorktree.has(b))
        return { current: value.current, branches }
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Git.defaultLayer), Layer.provide(Bus.layer))

export * as Vcs from "./vcs"
