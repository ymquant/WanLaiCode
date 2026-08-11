#!/usr/bin/env bun

import { Script } from "@opencode-ai/script"
import { $ } from "bun"
import { fileURLToPath } from "url"

console.log("=== publishing ===\n")

const dir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(dir)
const tag = `v${Script.version}`

// 上游这里跑 cli / sdk / plugin 的 npm publish + docker / aur / brew 推送，
// fork 不发这些包，删除。
//
// 上游这里跑 finalize-latest-json.ts + finalize-latest-yml.ts 把多 arch yml
// 合并后上传到 GitHub Release。S3 publish 模式下 electron-builder 已经直接
// 把每平台 latest*.yml 上传到 S3；单 arch matrix 不需要合并，删除。

// 先把 release 从 draft 切成 public：build/promote 都成功了，artifact 在 release 上，
// 用户能拿到才是发版的本体。merge-back 失败也不要挡住这一步 —— 大不了 main 上的
// merge commit 后面人工补，对用户不影响。
// B-pure：canary 候选保持 draft —— version.ts 已为它建好 draft release + tag，但翻 public
// 留给 Phase 3 的 promote（手动把 canary 转正）。prod/beta 正式发布照旧直接 undraft。
if (Script.release && Script.channel !== "canary") {
  await $`gh release edit ${tag} --draft=false --repo ${process.env.GH_REPO}`
}

// tag 是否已经在 main 里 —— 走 GitHub API，不依赖本地浅历史。
//
// 为什么必须放在 deepen 之前：promote 的 rerun 场景下 tag 早已合入（首次运行就 merge 成功了，
// 失败的是后面的 mirror step），但 fetch-depth 500 的浅仓库算不出 merge-base，
// 于是一头扎进下面的 deepen 循环 —— 而 deepen 的大 pack 必被 runner 的 ~35s 单流截断打死，
// 让「rerun 失败 job」这个标准恢复手段对 promote 彻底失效（实测 run 30156382000）。
//
// 判据：compare/main...tag 的 status 为 behind（tag 的 commit 全在 main 里）或 identical。
// API 失败（网络抖）不阻断，返回 false 降级走下面的本地路径。
async function isTagInMain(): Promise<boolean> {
  const repo = process.env.GH_REPO
  if (!repo) return false
  const res = await $`gh api repos/${repo}/compare/main...${tag} --jq .status`.nothrow().quiet()
  if (res.exitCode !== 0) return false
  const status = res.text().trim()
  return status === "behind" || status === "identical"
}

// deepen 单批 fetch 带重试：runner 的网络截断是概率性的，同一批重试往往就过。
// 批量取 200 而非 1000 —— 小包能在 ~35s 窗口内拉完，是这里能不能扛住截断的关键。
async function fetchDeepen(): Promise<void> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await $`git fetch --deepen=200 origin main refs/tags/${tag}`.nothrow()
    if (res.exitCode === 0) return
    if (attempt === 3) throw new Error(`git fetch --deepen=200 连续 3 次失败，网络异常`)
    console.log(`deepen fetch 失败 (${attempt}/3)，2s 后重试...`)
    await new Promise((resolve) => setTimeout(resolve, 2_000))
  }
}

if (Script.release && !Script.preview && Script.channel !== "canary") {
  // build/publish job 都已经基于 tag commit checkout，到这里 build 已成功 + release 已 public。
  // 现在把 tag 合回 main：让 main 始终能看到 "release: vX" 这个版本同步 commit，
  // tag 也进入 main 链，不再悬空。
  //
  // 并发：publish workflow 自身被 concurrency group 串行了，但其他 PR 可以在 build 期间
  // 继续 merge 到 main。下面用 fetch → merge → push 的乐观循环吸收 push 被 reject 的场景。
  const maxAttempts = 5
  // 已合入则整个 merge-back 环节（含 deepen）直接跳过 —— rerun 的常态就是这条路。
  let merged = await isTagInMain()
  if (merged) console.log(`${tag} 已在 main 中（API 判定），跳过 merge-back`)
  for (let attempt = 1; !merged && attempt <= maxAttempts; attempt++) {
    // nothrow + 显式判退出码：这条 fetch 网络失败（几 KB 也会 EOF，v0.1.5 promote 实证）
    // 若直接抛异常会中断整个脚本，外层乐观循环根本轮不到重试——发版链里"看似有重试
    // 实则裸奔"的点。失败按一次 attempt 计入循环，与 push reject 同等对待。
    const fetched = await $`git fetch origin main --no-tags`.nothrow()
    if (fetched.exitCode !== 0) {
      console.log(`git fetch origin main 失败 (attempt ${attempt}/${maxAttempts})，2s 后重试...`)
      await new Promise((resolve) => setTimeout(resolve, 2_000))
      continue
    }
    // -f 丢弃工作树残留：setup-bun 在 publish job (Linux) 跑 `bun install`
    // 时不带 --frozen-lockfile，若跟 tag commit 上 (macOS 生成) 的 bun.lock
    // 跨平台漂移就会把 bun.lock 改脏，裸 `git checkout -B` 被 "local changes
    // would be overwritten" 拒绝。这时 release 已被切成 public（上面 L24），
    // 但 tag 没合回 main —— 正是 32b4bf36b6 当年用 --discard-changes 修过的同
    // 类悬空 tag 状态。这份漂移出来的 bun.lock 是 setup-bun 的局部副作用，
    // 跟即将 merge 的 tag commit 无关，丢弃安全。
    await $`git checkout -f -B main origin/main`

    // shallow checkout（fetch-depth: 500）下，若 tag 的分叉点落在深度窗口外（典型：promote
    // 一个搁置较久的 canary 候选），merge-base 算不出来：下面的幂等检查会失真，merge 也会把
    // 「历史不足」误报成内容冲突。这里分批 deepen 补齐到可达为止，不会退回 --unshallow
    // 全量单包的老问题。批次上限 100 × 200 = 20000 commit，与原先 20 × 1000 等价。
    for (let deepen = 1; deepen <= 100; deepen++) {
      const base = await $`git merge-base refs/tags/${tag} HEAD`.nothrow().quiet()
      if (base.exitCode === 0) break
      const shallow = (await $`git rev-parse --is-shallow-repository`.quiet().text()).trim()
      if (shallow !== "true") break
      console.log(`merge-base unreachable in shallow history, deepening (${deepen}/100)...`)
      await fetchDeepen()
    }

    // 上一次 rerun 已经合过 → 跳过（merge-base 检查保证幂等）。
    const isAncestor = await $`git merge-base --is-ancestor refs/tags/${tag} HEAD`.nothrow().quiet()
    if (isAncestor.exitCode === 0) {
      console.log(`${tag} already merged into main, skipping`)
      merged = true
      break
    }

    const mergeMsg = `Merge tag '${tag}' into main`
    const mergeResult = await $`git merge --no-ff --no-edit -m ${mergeMsg} refs/tags/${tag}`.nothrow()
    if (mergeResult.exitCode !== 0) {
      await $`git merge --abort`.nothrow().quiet()
      console.error("=== merge conflict ===")
      console.error(`Failed to merge ${tag} into main (conflict). Release is published; main has not been advanced.`)
      console.error(`Resolve manually:`)
      console.error(`  git fetch origin main && git checkout main`)
      console.error(`  git merge --no-ff ${tag}`)
      console.error(`  # resolve conflicts (likely bun.lock), then`)
      console.error(`  git push origin main`)
      process.exit(1)
    }

    const push = await $`git push origin HEAD:main --no-verify`.nothrow()
    if (push.exitCode === 0) {
      console.log(`merged ${tag} into main (attempt ${attempt}/${maxAttempts})`)
      merged = true
      break
    }

    // push 被 reject —— main 在 fetch 和 push 之间又被推进了一格。重置后重试。
    console.log(`push rejected on attempt ${attempt}/${maxAttempts}, main moved; retrying...`)
    await $`git reset --hard origin/main`.nothrow().quiet()
    await new Promise((resolve) => setTimeout(resolve, 2_000))
  }
  if (!merged) {
    console.error(
      `Failed to push merge after ${maxAttempts} attempts. Release is published; main has not been advanced.`,
    )
    process.exit(1)
  }
}
