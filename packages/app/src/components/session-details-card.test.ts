import { describe, expect, test } from "bun:test"

// 不直接 import session-details-card.tsx —— 该文件经由
// @opencode-ai/ui/dropdown-menu -> @kobalte/core 触发 client-only API，
// 在 bun test 环境（Solid SSR runtime）下会抛错。
// 此测试改为对 .tsx 源做静态 sanity 校验，保证 P3-refactor 关键结构 / 文案不漂移。

describe("SessionDetailsCard source sanity", () => {
  test("exports expected sections + helper, container provides auto-divider", async () => {
    const source = await Bun.file(new URL("./session-details-card.tsx", import.meta.url)).text()
    // exports
    expect(source).toContain("export const SessionDetailsCard")
    expect(source).toContain("export const ProgressSection")
    expect(source).toContain("export const GitSection")
    expect(source).toContain("export const OutputSection")
    expect(source).toContain("export const SourcesSection")
    expect(source).toContain("export function progressCounts")
    // container chrome + adjacent-sibling divider
    expect(source).toContain('data-component="session-details-card"')
    expect(source).toContain("[&>section+section]:border-t")
    // section markers
    expect(source).toContain('data-section="progress"')
    expect(source).toContain('data-section="git"')
    expect(source).toContain('data-section="output"')
    expect(source).toContain('data-section="sources"')
    expect(source).toContain('language.t("branch.details.card.title")')
    expect(source).toContain("group/env-header")
    expect(source).toContain("group/output-header")
    expect(source).toContain("group/sources-header")
    expect(source).toContain("SectionToggleHeader")
    expect(source).toContain('data-section-open={sectionOpen() ? "true" : "false"}')
    expect(source).toContain('chevron-right')
    expect(source).toContain("rotate-90")
    expect(source).toContain("aria-expanded")
    expect(source).toContain('language.t("branch.details.card.output")')
    expect(source).toContain('language.t("branch.details.card.output.none")')
    expect(source).toContain('language.t("branch.details.card.output.showMore"')
    expect(source).toContain('language.t("branch.details.card.output.collapse")')
    expect(source).toContain('language.t("branch.details.card.sources")')
    expect(source).toContain('language.t("branch.details.card.sources.none")')
    expect(source).toContain("openHttpUrl")
    expect(source).toContain('name="globe"')
  })

  test("progressCounts signature unchanged", async () => {
    const source = await Bun.file(new URL("./session-details-card.tsx", import.meta.url)).text()
    expect(source).toMatch(/export\s+function\s+progressCounts\s*\(.*Todo/)
    expect(source).toContain('"completed"')
    expect(source).toContain('"cancelled"')
  })

  test("PR row icons: create uses github, existing PR uses git-pull-request", async () => {
    const source = await Bun.file(new URL("./session-details-card.tsx", import.meta.url)).text()
    expect(source).toContain('from "@/components/session-details-card-pr"')
    expect(source).toContain('from "@/components/session-details-card-git-ops"')
    expect(source).toContain('group/gitops')
    expect(source).toContain('name="ellipsis-horizontal"')
    expect(source).toContain('language.t("branch.details.card.gitOps")')
    expect(source).toContain('when={prState() === "exists"}')
    expect(source).toContain('when={prState() === "create"}')
    expect(source).toContain("existingPrTitle()")
    expect(source).toContain('language.t("branch.details.card.openPullRequest")')
    expect(source).toContain('onOpenPullRequest?.(url)')
    expect(source).toContain("onRefreshPullRequest?.()")
    expect(source).toContain("prReadinessPending")
    expect(source).toContain("prReadinessFailed")
    expect(source).toContain("prRefreshPending")
    expect(source).toContain("refreshPullRequest")
    expect(source).toContain('when={prState() === "loading"}')
    const existsBlock = source.slice(
      source.indexOf('when={prState() === "exists"}'),
      source.indexOf('when={prState() === "create"}'),
    )
    const createBlock = source.slice(
      source.indexOf('when={prState() === "create"}'),
      source.indexOf("<Match when={true}>"),
    )
    expect(existsBlock).toContain('name="git-pull-request"')
    expect(existsBlock).toContain('name="square-arrow-top-right"')
    expect(createBlock).toContain('name="github"')
    expect(createBlock).not.toContain('name="git-pull-request"')
    expect(source).toContain('when={prState() === "gh-cli"}')
    expect(source).toContain('when={prState() === "gh-auth"}')
    expect(source).toContain("onPastePromptText")
    expect(source).toContain('branch.details.card.installGhCliPrompt')
    expect(source).toContain('branch.details.card.installGhCliClickHint')
    expect(source).toContain('branch.details.card.authGhCliPrompt')
  })
})
