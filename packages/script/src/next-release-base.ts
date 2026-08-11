import semver from "semver"

// 从一组版本号（可带 v 前缀 / 草稿 / 预发布）取最大语义版本，按 bump 递增到下一个「干净正式版」。
//
// B-pure：canary 候选不再用预发布版号，改用真实正式版基线递增出的干净正式版（如 0.0.25）。
// 版本账本 = GH releases（含 draft）：传入的 tags 来自 `gh release list`（不排除 draft），
// 已撤回（转回 draft）的号仍在账本里参与比较，故其号不会被复用 —— 避免两个候选撞同一版本号。
//
// 规则：
//   1. 剥 v 前缀；
//   2. 过滤非法（保留合法 semver，含预发布如 0.0.25-canary.x —— 预发布参与比较）；
//   3. 取最大 semver 作基线（空集兜底 0.0.0）；
//   4. 按 bump（major/minor/patch，默认 patch）调 semver.inc 递增。
//      预发布基线做 patch/minor/major inc 时落到其对应的 release 版（如 0.0.25-canary → 0.0.25）。
export function nextReleaseBase(tags: string[], bump?: string): string {
  const valid = tags
    .map((t) => t.replace(/^v/, ""))
    .filter((t): t is string => !!semver.valid(t))

  const base = valid.sort(semver.rcompare)[0] ?? "0.0.0"

  const t = bump?.toLowerCase()
  const release: semver.ReleaseType = t === "major" ? "major" : t === "minor" ? "minor" : "patch"

  return semver.inc(base, release) ?? base
}
