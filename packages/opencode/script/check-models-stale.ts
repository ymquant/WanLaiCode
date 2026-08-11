// promote（canary 候选转正）路径的模型目录陈旧闸门。
//
// 为什么单独有这么一个脚本：op=promote 时 version job 被 `if: inputs.op != 'promote'` 跳过，
// build-electron 因 needs 连带跳过，整条转正链路只搬 S3 对象、改 release —— 全程不执行
// generate.ts。于是 generate.ts 里那道"≥90 天拒绝用于 prod 发版"的硬拦对
// "canary 候选转正成正式版"这条主发布路径完全失效：陈旧目录能一路走到 prod，
// 唯一信号只是几天前那次 canary run 里的一条 ::warning::。
//
// --meta <path>：可选，不传时读当前 checkout 的 meta（下面的局限即针对这种默认用法）。
// publish.yml 的 promote 路径会 git show 出候选 release targetCommitish 那一刻的
// meta 文件传进来，校验"candidate 构建时"而非"转正当下"的新鲜度，把下面这条局限
// 在有条件时补上；取不到候选 commit 时 workflow 就不传这个参数，回落到默认行为。
//
// 判据的局限（默认用法下有意接受）：不传 --meta 时，这里读的是转正时刻仓库里的 meta，
// 而不是候选产物里烤进去的那份。canary 构建之后有人刷新过 pinned 的话，这道闸门会
// 放行一个烤了旧数据的候选。它是廉价可得的下界（现在就陈旧 ⇒ 更早构建时必然也陈旧），
// 不是精确判据；精确判据要从候选产物里读回快照，成本远高于收益。
import path from "path"
import { fileURLToPath } from "url"

import { classifyStaleness, REFRESH_HINT, STALE_FAIL_DAYS } from "./models-catalog"

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

function parseMetaArg(argv: string[]): string | undefined {
  const i = argv.indexOf("--meta")
  if (i === -1) return undefined
  const value = argv[i + 1]
  // 同时挡住"漏填值"和"值恰好是下一个 flag"，防止参数错位被静默吞掉。
  if (!value || value.startsWith("--")) throw new Error("--meta 需要跟一个文件路径")
  return value
}

const metaArg = parseMetaArg(process.argv.slice(2))
const metaPath = metaArg ? path.resolve(metaArg) : path.join(dir, "src/provider/models-pinned.meta.json")

const warn = (msg: string) => console.warn(process.env.GITHUB_ACTIONS ? `::warning::${msg}` : `[models] ${msg}`)

const metaFile = Bun.file(metaPath)
if (!(await metaFile.exists())) {
  warn(`缺少 ${path.basename(metaPath)}，无法判断 pinned 目录的新鲜度`)
  process.exit(0)
}

// 与 generate.ts 同款降级：meta 自身坏掉不该把发版拦死，只告警。
let meta: { fetchedAt?: unknown; providers?: unknown }
try {
  meta = JSON.parse(await metaFile.text())
} catch (e) {
  warn(`${path.basename(metaPath)} 解析失败（${(e as Error).message}），无法判断 pinned 目录的新鲜度`)
  process.exit(0)
}

const verdict = classifyStaleness(meta.fetchedAt, Date.now())
const detail = `pinned 模型目录抓取于 ${meta.fetchedAt}（${verdict.days ?? "?"} 天前，${meta.providers ?? "?"} 个 provider）`

if (verdict.level === "fail") {
  console.error(`::error::${detail}，超过 ${STALE_FAIL_DAYS} 天，拒绝转正为正式发版。${REFRESH_HINT}`)
  process.exit(1)
}
if (verdict.level === "warn") {
  warn(verdict.reason ? `${verdict.reason}，无法判断 pinned 目录的新鲜度` : `${detail}，建议刷新。${REFRESH_HINT}`)
  process.exit(0)
}
console.log(detail)
