import { $ } from "bun"
import semver from "semver"
import path from "path"
import { nextReleaseBase } from "./next-release-base"

const rootPkgPath = path.resolve(import.meta.dir, "../../../package.json")
const rootPkg = await Bun.file(rootPkgPath).json()
const expectedBunVersion = rootPkg.packageManager?.split("@")[1]

if (!expectedBunVersion) {
  throw new Error("packageManager field not found in root package.json")
}

// relax version requirement
const expectedBunVersionRange = `^${expectedBunVersion}`

if (!semver.satisfies(process.versions.bun, expectedBunVersionRange)) {
  throw new Error(`This script requires bun@${expectedBunVersionRange}, but you are using bun@${process.versions.bun}`)
}

const env = {
  OPENCODE_CHANNEL: (process.env["WANLAICODE_CHANNEL"] ?? process.env["OPENCODE_CHANNEL"]),
  OPENCODE_BUMP: (process.env["WANLAICODE_BUMP"] ?? process.env["OPENCODE_BUMP"]),
  OPENCODE_VERSION: (process.env["WANLAICODE_VERSION"] ?? process.env["OPENCODE_VERSION"]),
  OPENCODE_RELEASE: (process.env["WANLAICODE_RELEASE"] ?? process.env["OPENCODE_RELEASE"]),
}
const CHANNEL = await (async () => {
  if (env.OPENCODE_CHANNEL) return env.OPENCODE_CHANNEL
  if (env.OPENCODE_BUMP) return "latest"
  if (env.OPENCODE_VERSION && !env.OPENCODE_VERSION.startsWith("0.0.0-")) return "latest"
  return await $`git branch --show-current`.text().then((x) => x.trim())
})()
// B-pure：canary 不再是 preview —— 它走「干净正式版号 + 真实发布流程」（version.ts 的 !preview 路径
// 建 draft release + tag，promote 时才翻 public）。beta/dev/分支仍是 preview（独立 appId，不与 prod 比较）。
const IS_PREVIEW = CHANNEL !== "latest" && CHANNEL !== "canary"

// 计算下一个正式版基线版本号（从 GitHub Release / npm registry 拉最新版，再按 bump 递增）。
// canary 与正式发布共用：canary 与 prod 同 appId，版本号必须基于真实正式版基线，
// 否则低于 prod，订阅内测的用户无法原地升级。
const computeReleaseBase = async (): Promise<string> => {
  const versionFrom = process.env["RELEASE_VERSION_FROM"]

  if (versionFrom === "github") {
    // fork mode: 从 GitHub Release tag 拉，npm registry 不可用。
    // 按 CHANNEL 分流「是否含 draft」：
    // - canary：--limit 100 含 draft（不带 --exclude-drafts）。GH releases 是版本号账本，
    //   canary 候选经 version.ts 建的 draft release + tag 也算账；撤回（转回 draft）的号仍在
    //   账本里参与最大版本比较，故其号不会被复用 —— 候选单调、不复用撤回号。
    // - prod/latest（else）：--limit 1 --exclude-drafts，只取最新一个 public release。
    //   prod 必须排除 draft 以保 version.ts 的 rerun 幂等：某平台 build 失败 → publish 跳过 →
    //   draft release 停留，重跑时若把该 draft 算进账本会被 bump 过它（跳号 + 孤儿草稿），
    //   排除后卡住的同号 draft 会被 version.ts 的 releaseAlreadyExists/remoteTagSha 复用而非 bump 过。
    const repo = process.env["GH_REPO"]
    if (!repo) throw new Error("RELEASE_VERSION_FROM=github requires GH_REPO env")
    // gh release list 是版本号账本的唯一来源，命令失败（网络/鉴权）时必须硬失败：
    // 静默回退 0.0.0 会 patch 成 0.0.1，撞上历史遗留的 v0.0.1 tag 并复用其古董 commit，
    // 导致 build 去编译改名前的旧代码发版。宁可让 version job 报错中断，也不产出错误基线。
    // 注意：命令成功但返回空数组（真的还没有 release）仍是合法的首发场景，不在此拦截。
    const out = await (CHANNEL === "canary"
      ? $`gh release list --repo ${repo} --limit 100 --json tagName`
      : $`gh release list --repo ${repo} --limit 1 --json tagName --exclude-drafts`)
      .text()
      .catch((e) => {
        throw new Error(`[Script.version] gh release list 失败，拒绝回退到 0.0.0 基线（避免复用历史 tag 编译旧代码）: ${e}`)
      })
    // 不给 out 兜底 "[]"：成功的 gh release list --json 至少输出 "[]"，空 stdout 属异常，
    // 应落入 JSON.parse 抛错走硬失败，而非被静默解析成空数组回退 0.0.0。
    let releases: Array<{ tagName?: string }> = []
    try {
      releases = JSON.parse(out)
    } catch (e) {
      throw new Error(`[Script.version] gh release list 返回非 JSON 输出，拒绝回退到 0.0.0 基线: ${e}`)
    }
    const tags = releases.map((r) => r.tagName).filter((t): t is string => !!t)
    return nextReleaseBase(tags, env.OPENCODE_BUMP)
  }

  // 上游 / 默认行为：从 npm registry 拉
  const npmVersion: string = await fetch("https://registry.npmjs.org/opencode-ai/latest")
    .then((res) => {
      if (!res.ok) throw new Error(res.statusText)
      return res.json()
    })
    .then((data: any) => data.version)
  return nextReleaseBase([npmVersion], env.OPENCODE_BUMP)
}

// preview 版本号时间戳后缀（YYYYMMDDHHMM，单调递增、无前导零，作 semver 数字预发布标识符合法）。
const previewStamp = () => new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")

const VERSION = await (async () => {
  if (env.OPENCODE_VERSION) return env.OPENCODE_VERSION
  if (IS_PREVIEW) {
    // beta/dev/分支等 preview：独立 appId，不与 prod 比较，用 0.0.0- 时间戳即可。
    // B-pure：canary 不再走这里 —— 它落到末尾 computeReleaseBase()，拿干净正式版号。
    return `0.0.0-${CHANNEL}-${previewStamp()}`
  }
  // latest（正式发布）与 canary 候选都从这里取「干净正式版号」（如 0.0.25）。
  return await computeReleaseBase()
})()

const bot = ["actions-user", "opencode", "opencode-agent[bot]"]
const teamPath = path.resolve(import.meta.dir, "../../../.github/TEAM_MEMBERS")
const team = [
  ...(await Bun.file(teamPath)
    .text()
    .then((x) => x.split(/\r?\n/).map((x) => x.trim()))
    .then((x) => x.filter((x) => x && !x.startsWith("#")))
    .catch(() => [] as string[])), // fork 已删 TEAM_MEMBERS
  ...bot,
]

export const Script = {
  get channel() {
    return CHANNEL
  },
  get version() {
    return VERSION
  },
  get preview() {
    return IS_PREVIEW
  },
  get release(): boolean {
    return !!env.OPENCODE_RELEASE
  },
  get team() {
    return team
  },
}
console.log(`opencode script`, JSON.stringify(Script, null, 2))
