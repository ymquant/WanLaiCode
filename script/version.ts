#!/usr/bin/env bun

import { Script } from "@opencode-ai/script"
import { $ } from "bun"
import { fileURLToPath } from "url"

const dir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(dir)

/**
 * `gh release view` exit !=0 时区分"release 不存在"和"其他错"。
 * 不存在 → 返回 false（调用方走 create 分支）
 * 其他错（auth / network / 5xx / rate limit ...）→ throw（让 version job 红 fail 暴露真错，
 * 不要被 view-then-create 兜底掩盖）。
 */
async function releaseExists(tag: string, repoArg: string = ""): Promise<boolean> {
  const cmd = repoArg
    ? $`gh release view ${tag} --json tagName --repo ${repoArg}`.nothrow().quiet()
    : $`gh release view ${tag} --json tagName`.nothrow().quiet()
  const result = await cmd
  if (result.exitCode === 0) return true
  const stderr = result.stderr.toString().toLowerCase()
  // gh "release not found" 是 case-sensitive 但小写正则双保险
  if (stderr.includes("release not found") || stderr.includes("not found")) {
    return false
  }
  // 其他失败：吐 stderr + 抛
  console.error(`gh release view failed (exit ${result.exitCode}):\n${result.stderr.toString()}`)
  throw new Error(`gh release view for ${tag} failed: not a "not found" error`)
}

/**
 * 把所有 package.json 的 "version" 字段刷成目标版本，然后跑 bun install 让 bun.lock 同步。
 * 之前在 publish.ts 里，每次发版要跑两遍（一次为 tag commit，一次为 main sync commit）。
 * 改成"先打 tag 再合回 main"后只需要在 version job 里跑一次。
 */
async function prepareReleaseFiles(version: string) {
  const pkgjsons = await Array.fromAsync(
    new Bun.Glob("**/package.json").scan({ absolute: true }),
  ).then((arr) => arr.filter((x) => !x.includes("node_modules") && !x.includes("dist")))

  for (const file of pkgjsons) {
    let pkg = await Bun.file(file).text()
    pkg = pkg.replaceAll(/"version": "[^"]+"/g, `"version": "${version}"`)
    console.log("updated:", file)
    await Bun.file(file).write(pkg)
  }
  await $`bun install`
}

const output = [`version=${Script.version}`]
const triggerSha = process.env.GITHUB_SHA ?? (await $`git rev-parse HEAD`.text()).trim()
// build / publish job 要 checkout 的 SHA：默认沿用触发 SHA（preview 模式），
// release 模式下会被改写为 tag commit SHA。
let buildSha = triggerSha

if (!Script.preview) {
  // changelog 用触发 SHA 当 cutoff —— release commit 自身只是版本号 bump，不进 changelog。
  await $`bun script/changelog.ts --to ${triggerSha}`
  const file = `${process.cwd()}/UPCOMING_CHANGELOG.md`
  const body = await Bun.file(file)
    .text()
    .catch(() => "No notable changes")
  const tmpDir = process.env.RUNNER_TEMP ?? "/tmp"
  const notesFile = `${tmpDir}/opencode-release-notes.txt`
  await Bun.write(notesFile, body)

  // rerun 幂等：远程已有 tag → 不重新 commit/push，复用上次的 tag SHA。
  // GitHub 拒绝改已发布 tag（--force-with-lease 会被 stale info 挡掉，--force 又会污染所有 fetch 过的本地）。
  await $`git fetch origin --tags`
  const remoteTagSha =
    (await $`git ls-remote --tags origin refs/tags/v${Script.version}`.text()).trim().split(/\s+/)[0] ?? ""
  // 一次性查 release 状态，下面 (a) 一致性守护 (b) 是否要 create 都复用同一个判断，
  // 避免两次 gh release view 之间状态被人工动而读到不一致结果。
  const releaseAlreadyExists = await releaseExists(`v${Script.version}`)

  // 一致性守护：release 已发布但 tag 被人工删掉。继续往下会用新 SHA 打新 tag，
  // 与老 release.target_commitish 指向的 SHA 分叉，artifact 跟 tag 永远对不上。
  // fail-fast 让 operator 先 align（删 release 或把 tag 挂回原 commit）再 rerun。
  if (!remoteTagSha && releaseAlreadyExists) {
    console.error(
      `Inconsistent state: release v${Script.version} exists but tag is missing.\n` +
        `Manually align before rerun, e.g.:\n` +
        `  gh release delete v${Script.version} --yes\n` +
        `  # or re-create the tag pointing at the release's original target_commitish`,
    )
    process.exit(1)
  }

  if (remoteTagSha) {
    buildSha = remoteTagSha
    console.log(`reusing existing tag v${Script.version} at ${buildSha}`)
  } else {
    // 首次发版：在触发 SHA 之上打 release commit + tag，把 tag 推到 origin。
    // 不推任何分支 —— main 是否合上这条线由后面的 publish.ts merge-back 决定。
    await prepareReleaseFiles(Script.version)
    // 防御：极端情况下触发 SHA 上 package.json 版本号已经是目标版本（例如手工提前
    // bump 过），prepareReleaseFiles 不会产生改动，裸跑 git commit -am 会以 exit 1
    // 让 version job 整段红掉。看一眼 working tree 再决定是否 commit。
    const hasChanges = (await $`git status --porcelain`.text()).trim().length > 0
    if (hasChanges) {
      await $`git commit -am ${`release: v${Script.version}`}`
    } else {
      console.log(`no version changes to commit; tagging triggerSha directly`)
    }
    await $`git tag v${Script.version}`
    await $`git push origin refs/tags/v${Script.version} --no-verify`
    buildSha = (await $`git rev-parse HEAD`.text()).trim()
    console.log(`created tag v${Script.version} at ${buildSha}`)
  }

  // rerun 幂等：同 tag release 已存在时 `gh release create` 会因冲突退 1 让 version job 整段红掉。
  // 复用上面已经查好的 releaseAlreadyExists —— 已存在的不改写，保留首次发布的人工编辑痕迹。
  if (!releaseAlreadyExists) {
    await $`gh release create v${Script.version} -d --target ${buildSha} --title ${`v${Script.version}`} --notes-file ${notesFile}`
  }
  const release = await $`gh release view v${Script.version} --json tagName,databaseId`.json()
  output.push(`release=${release.databaseId}`)
  output.push(`tag=${release.tagName}`)
} else if (Script.channel === "beta") {
  if (!(await releaseExists(`v${Script.version}`, process.env.GH_REPO!))) {
    await $`gh release create v${Script.version} -d --title ${`v${Script.version}`} --repo ${process.env.GH_REPO}`
  }
  const release =
    await $`gh release view v${Script.version} --json tagName,databaseId --repo ${process.env.GH_REPO}`.json()
  output.push(`release=${release.databaseId}`)
  output.push(`tag=${release.tagName}`)
}

output.push(`sha=${buildSha}`)
output.push(`repo=${process.env.GH_REPO}`)

if (process.env.GITHUB_OUTPUT) {
  await Bun.write(process.env.GITHUB_OUTPUT, output.join("\n"))
}

process.exit(0)
