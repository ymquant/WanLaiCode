#!/usr/bin/env bun

// 刷新入库的模型目录兜底快照 src/provider/models-pinned.json。
//
// 为什么需要它：generate.ts 构建时要从 models.dev 取模型目录，而公司网络到该域名
// 直连被 reset、走 INTERNAL_PROXY 也不通（2026-07-29 实测），于是发版对一个取不到的
// 外网地址形成硬依赖。入库一份 pinned 目录做兜底，让构建在拿不到网络时仍能出正确产物。
//
// 用法（路径按仓库根书写，从仓库根直接可执行；仓库根另有一个不相关的 script/ 目录，
// 写成 `bun script/refresh-models-pinned.ts` 会解析到那边而失败）：
//   bun packages/opencode/script/refresh-models-pinned.ts                 # 从 models.dev 拉最新
//   bun packages/opencode/script/refresh-models-pinned.ts --from a.json   # 用已下载的文件
//   bun packages/opencode/script/refresh-models-pinned.ts --from a.json --source "https://models.dev/api.json"
//
// 办公室网络拉不到时，在能出网的机器上执行：
//   curl -fsS https://models.dev/api.json > /tmp/api.json
// 拷回来用 --from 指定，并用 --source 标注真实来源（否则 meta 里只会记下本地文件名，
// 看不出数据究竟从哪来）。
//
// 刷新节奏：刻意没做成定时 CI —— 本仓库的 runner 与发版机同批、同样连不通 models.dev，
// 定时任务只会在同一个网络上重复失败。改由人在需要时手动跑：构建日志超过 30 天会告警，
// 超过 90 天且 prod 发版会直接拦下。见 docs/testing/release-checklist.md。

import path from "path"
import { fileURLToPath } from "url"

import { parseCatalog, serializeCatalog } from "./models-catalog"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const dir = path.resolve(__dirname, "..")

const PINNED = path.join(dir, "src/provider/models-pinned.json")
const META = path.join(dir, "src/provider/models-pinned.meta.json")
const SOURCE = (process.env.WANLAICODE_MODELS_URL ?? process.env.OPENCODE_MODELS_URL) || "https://models.dev"

function parseArgs(argv: string[]): { from?: string; source?: string } {
  const pick = (flag: string) => {
    const i = argv.indexOf(flag)
    if (i === -1) return undefined
    const value = argv[i + 1]
    // 同时挡住"漏填值"和"值恰好是下一个 flag"：后者会让 `--source --from x` 这类顺序
    // 把字面量 "--from" 当成来源标注静默写进 meta，正是本脚本要杜绝的情况。
    if (!value || value.startsWith("--")) throw new Error(`${flag} 需要跟一个值`)
    return value
  }
  return { from: pick("--from"), source: pick("--source") }
}

async function loadRaw(from?: string, sourceLabel?: string): Promise<{ raw: string; origin: string }> {
  if (from) {
    const file = Bun.file(from)
    if (!(await file.exists())) throw new Error(`文件不存在: ${from}`)
    // 只记文件名不记完整路径：完整路径会把本地目录结构写进仓库，且对读者无意义。
    return { raw: await file.text(), origin: sourceLabel ?? `file:${path.basename(from)}` }
  }
  const url = `${SOURCE}/api.json`
  // 网络层异常（SSL reset / 连不上）若不接住会裸崩成一堆调用栈，而这个脚本的典型使用者
  // 正是在拉不到时来救场的人，报错必须直说下一步怎么办。
  const res = await fetch(url).catch((e: Error) => {
    throw new Error(
      `请求 ${url} 失败：${e.message}。若本机连不上 models.dev，` +
        `请在能出网的机器上执行 curl -fsS ${url} > /tmp/api.json，` +
        `再用 --from /tmp/api.json --source ${url} 重跑。`,
    )
  })
  // fetch 对非 2xx 不抛错，错误页会被当成正文写进快照。
  if (!res.ok) throw new Error(`${url} 返回 HTTP ${res.status}，拒绝写入`)
  return { raw: await res.text(), origin: sourceLabel ?? url }
}

const args = parseArgs(process.argv.slice(2))
// --source 只用来标注"这个文件是从哪弄来的"。单独使用会让 meta 记下一个并非实际抓取
// 地址的来源，而这份 provenance 正是要保证可追溯的东西——直接联网时来源就是抓取地址，
// 不该被覆盖。要换抓取地址请用 WANLAICODE_MODELS_URL。
if (args.source && !args.from) {
  throw new Error("--source 只在配合 --from 时有意义；要改变抓取地址请设 WANLAICODE_MODELS_URL")
}
const loaded = await loadRaw(args.from, args.source)
const catalog = parseCatalog(loaded.raw, loaded.origin)
const body = serializeCatalog(catalog)

const hasher = new Bun.CryptoHasher("sha256")
hasher.update(body)
const sha256 = hasher.digest("hex")

await Bun.write(PINNED, body)
await Bun.write(
  META,
  JSON.stringify(
    {
      // generate.ts 读这个时间判断陈旧程度；刷新时必须一并更新，否则告警会失真。
      fetchedAt: new Date().toISOString(),
      source: loaded.origin,
      providers: Object.keys(catalog).length,
      sha256,
    },
    null,
    2,
  ) + "\n",
)

console.log(`已写入 ${path.relative(dir, PINNED)}`)
console.log(`  providers: ${Object.keys(catalog).length}`)
console.log(`  source:    ${loaded.origin}`)
console.log(`  sha256:    ${sha256}`)
