import { describe, expect, test } from "bun:test"
import {
  cleanCommitMessage,
  formatDiffContext,
  formatStyleContext,
  GENERIC_GENERATE_FAILED,
  GenerateFailedError,
  isSensitiveDiffPath,
  localeLanguageHint,
  localeToBcp47,
  mergePullRequestDiffs,
  MAX_DIFF_CONTEXT,
  MAX_PREVIOUS_CONTEXT,
  parsePullRequestJson,
  sanitizeGenerateErrorMessage,
  truncatePrevious,
} from "@/project/vcs-generate"
import type { Vcs } from "@/project/vcs"

const diff = (file: string, patch: string, additions = 1, deletions = 0): Vcs.FileDiff => ({
  file,
  patch,
  additions,
  deletions,
})

describe("formatDiffContext", () => {
  test("returns empty string for no files", () => {
    expect(formatDiffContext([])).toBe("")
  })

  test("includes file stats and patches", () => {
    const text = formatDiffContext([diff("src/a.ts", "+line\n-line", 2, 1)])
    expect(text).toContain("src/a.ts (+2/-1)")
    expect(text).toContain("+line")
  })

  test("truncates large patches within budget", () => {
    const patch = "x".repeat(MAX_DIFF_CONTEXT)
    const text = formatDiffContext([diff("big.ts", patch)])
    expect(text.length).toBeLessThanOrEqual(MAX_DIFF_CONTEXT + 128)
    expect(text).toContain("...(truncated)")
  })

  test("omits patch content for sensitive env files", () => {
    const text = formatDiffContext([diff(".env", "SECRET=abc", 1, 0), diff("src/a.ts", "+line", 1, 0)])
    expect(text).toContain(".env (+1/-0)")
    expect(text).toContain("patch omitted — sensitive file")
    expect(text).not.toContain("SECRET=abc")
    expect(text).toContain("+line")
  })

  test("keeps .env.example patch content", () => {
    const text = formatDiffContext([diff(".env.example", "FOO=bar", 1, 0)])
    expect(text).toContain("FOO=bar")
  })
})

describe("isSensitiveDiffPath", () => {
  test("denies env secrets and allows env examples", () => {
    expect(isSensitiveDiffPath(".env")).toBe(true)
    expect(isSensitiveDiffPath(".env.local")).toBe(true)
    expect(isSensitiveDiffPath("packages/app/.env.production")).toBe(true)
    expect(isSensitiveDiffPath("config.env")).toBe(true)
    expect(isSensitiveDiffPath(".env.example")).toBe(false)
    expect(isSensitiveDiffPath("packages/app/.env.example")).toBe(false)
    expect(isSensitiveDiffPath(".envrc")).toBe(false)
    expect(isSensitiveDiffPath("src/a.ts")).toBe(false)
  })

  test("denies common credential paths", () => {
    expect(isSensitiveDiffPath("secrets/id_rsa")).toBe(true)
    expect(isSensitiveDiffPath("certs/server.pem")).toBe(true)
    expect(isSensitiveDiffPath("credentials.json")).toBe(true)
    expect(isSensitiveDiffPath(".codex/auth.json")).toBe(true)
    expect(isSensitiveDiffPath("wanlaicode.json")).toBe(true)
    expect(isSensitiveDiffPath(".wanlaicode/wanlaicode.jsonc")).toBe(true)
    expect(isSensitiveDiffPath("config/secrets.yaml")).toBe(true)
    expect(isSensitiveDiffPath("deploy/production.secret")).toBe(true)
  })
})

describe("sanitizeGenerateErrorMessage", () => {
  test("allows known public messages", () => {
    expect(sanitizeGenerateErrorMessage(new GenerateFailedError({ message: "No changes to summarize" }))).toBe(
      "No changes to summarize",
    )
  })

  test("redacts provider and internal error details", () => {
    expect(sanitizeGenerateErrorMessage(new Error("401 Unauthorized: sk-proj-abc123"))).toBe(GENERIC_GENERATE_FAILED)
    expect(sanitizeGenerateErrorMessage(new GenerateFailedError({ message: "401 Unauthorized: sk-proj-abc123" }))).toBe(
      GENERIC_GENERATE_FAILED,
    )
  })
})

describe("truncatePrevious", () => {
  test("returns undefined for empty input", () => {
    expect(truncatePrevious(undefined)).toBeUndefined()
    expect(truncatePrevious("   ")).toBeUndefined()
  })

  test("truncates long regenerate context", () => {
    const long = "x".repeat(MAX_PREVIOUS_CONTEXT + 100)
    const out = truncatePrevious(long)
    expect(out?.length).toBeLessThan(long.length)
    expect(out).toContain("...(truncated)")
  })
})

describe("cleanCommitMessage", () => {
  test("keeps first non-empty line", () => {
    expect(cleanCommitMessage("\nfeat(app): 添加按钮\n")).toBe("feat(app): 添加按钮")
  })

  test("strips surrounding quotes", () => {
    expect(cleanCommitMessage('"fix(ui): 修复样式"')).toBe("fix(ui): 修复样式")
  })
})

describe("parsePullRequestJson", () => {
  test("parses raw json", () => {
    expect(parsePullRequestJson('{"title":"feat(app): 标题","body":"说明"}')).toEqual({
      title: "feat(app): 标题",
      body: "说明",
    })
  })

  test("parses fenced json", () => {
    const text = '```json\n{"title":"fix","body":"desc"}\n```'
    expect(parsePullRequestJson(text)).toEqual({ title: "fix", body: "desc" })
  })
})

describe("localeLanguageHint", () => {
  test("maps known locales", () => {
    expect(localeLanguageHint("zh")).toContain("简体中文")
    expect(localeLanguageHint("en")).toBe("English")
  })

  test("returns raw locale when unknown", () => {
    expect(localeLanguageHint("xx")).toBe("xx")
  })
})

describe("localeToBcp47", () => {
  test("maps app locales to BCP47 tags", () => {
    expect(localeToBcp47("zh")).toBe("zh-Hans")
    expect(localeToBcp47("zht")).toBe("zh-Hant")
    expect(localeToBcp47("en")).toBe("en")
  })
})

describe("mergePullRequestDiffs", () => {
  test("combines branch and pending stats/patches for the same file", () => {
    const merged = mergePullRequestDiffs(
      [diff("a.ts", "+committed", 5, 0)],
      [diff("a.ts", "+pending", 1, 0)],
    )
    expect(merged).toHaveLength(1)
    expect(merged[0]?.additions).toBe(6)
    expect(merged[0]?.patch).toContain("+committed")
    expect(merged[0]?.patch).toContain("+pending")
  })

  test("keeps branch-only and pending-only files", () => {
    const merged = mergePullRequestDiffs(
      [diff("branch.ts", "+branch", 2, 0)],
      [diff("pending.ts", "+pending", 3, 1)],
    )
    expect(merged.map((file) => file.file)).toEqual(["branch.ts", "pending.ts"])
    expect(merged.find((file) => file.file === "branch.ts")?.patch).toBe("+branch")
    expect(merged.find((file) => file.file === "pending.ts")?.additions).toBe(3)
  })
})

describe("formatStyleContext", () => {
  test("includes history and locale when present", () => {
    const text = formatStyleContext({
      commits: "feat(app): 添加按钮\nfix(ui): 修复样式",
      locale: "zh",
    })
    expect(text).toContain("User interface locale: zh")
    expect(text).toContain("feat(app): 添加按钮")
    expect(text).toContain("closely match format")
  })

  test("falls back when no history", () => {
    const text = formatStyleContext({ commits: "", locale: "en" })
    expect(text).toContain("project default conventions")
    expect(text).toContain("User interface locale: en")
  })
})
