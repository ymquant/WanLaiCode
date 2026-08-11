#!/usr/bin/env bun

// 合并 staging 里的 per-arch latest*.yml：build matrix 上传时已经把每个平台的
// 各 arch yml 改名成 latest*-<arch>.yml 避开同名互盖，本脚本扫描 staging、按 base
// 名分组、files[] 取并集后写回 base 名（再删 per-arch 副本），避免 promote-s3.ts
// 把 per-arch 带到 live。
//
// 所有平台统一走 per-arch → 合并的路径，即使当前 win/linux 矩阵单 arch（合并是恒等），
// 也跑这条流程：保持代码无平台分支，未来加 win/linux 的 arm64 不用改脚本。
//
// electron-updater 的平台 ↔ 文件名约定（来自其 Provider.ts 的 getChannelFilePrefix）：
//   Windows    → latest.yml                （单文件，多 arch 共用 files[]）
//   macOS      → latest-mac.yml            （单文件，多 arch 共用 files[]）
//   Linux x64  → latest-linux.yml          （单 arch 文件）
//   Linux arm64→ latest-linux-arm64.yml    （单 arch 文件）
// upload-staging-s3.ts 给每个平台原始 yml 加 -<arch>.yml 后缀，本脚本的正则
// /^(latest.*)-(x86_64|aarch64)\.yml$/ 把后缀剥掉成 base 名 → 上面四个目标文件名。
// win/mac 两 arch 的 base 同名 (latest / latest-mac) → 自动合并到一个 files[]；
// linux x64 和 arm64 的 base 不同 (latest-linux / latest-linux-arm64) → 自动保持
// 分文件。约定天然契合，脚本里没有任何 platform 特判。
//
// 不依赖 Actions artifact 做中转：私库 Free 计划 500 MB 配额吃不消，且 S3 staging
// 本就保存着完整产物，原地读写更轻量。

import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3"

import { resolveChannel, resolveChannelPath } from "./utils"

const version = process.env.WANLAICODE_VERSION
if (!version) throw new Error("WANLAICODE_VERSION is required")

const endpoint = process.env.S3_ENDPOINT
const bucket = process.env.S3_BUCKET
if (!endpoint || !bucket) throw new Error("S3_ENDPOINT and S3_BUCKET are required")

const region = process.env.S3_REGION || "us-east-1"
const accessKeyId = process.env.AWS_ACCESS_KEY_ID
const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY
if (!accessKeyId || !secretAccessKey) throw new Error("AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are required")

const channel = resolveChannel()
const channelPath = resolveChannelPath()
if (channel === "dev") throw new Error("finalize-latest-yml should not run for dev channel")

type FileEntry = {
  url: string
  sha512: string
  size: number
  blockMapSize?: number
}

type LatestYml = {
  version: string
  files: FileEntry[]
  releaseDate: string
}

function parse(content: string): LatestYml {
  const lines = content.split("\n")
  let version = ""
  let releaseDate = ""
  const files: FileEntry[] = []
  let current: Partial<FileEntry> | undefined

  const flush = () => {
    if (current?.url && current.sha512 && current.size) files.push(current as FileEntry)
    current = undefined
  }

  for (const line of lines) {
    const indented = line.startsWith("    ") || line.startsWith("  -")
    if (line.startsWith("version:")) version = line.slice("version:".length).trim()
    else if (line.startsWith("releaseDate:"))
      releaseDate = line.slice("releaseDate:".length).trim().replace(/^'|'$/g, "")
    else if (line.trim().startsWith("- url:")) {
      flush()
      current = { url: line.trim().slice("- url:".length).trim() }
    } else if (indented && current && line.trim().startsWith("sha512:"))
      current.sha512 = line.trim().slice("sha512:".length).trim()
    else if (indented && current && line.trim().startsWith("size:"))
      current.size = Number(line.trim().slice("size:".length).trim())
    else if (indented && current && line.trim().startsWith("blockMapSize:"))
      current.blockMapSize = Number(line.trim().slice("blockMapSize:".length).trim())
    else if (!indented && current) flush()
  }
  flush()

  return { version, files, releaseDate }
}

function serialize(data: LatestYml): string {
  const lines = [`version: ${data.version}`, "files:"]
  for (const file of data.files) {
    lines.push(`  - url: ${file.url}`)
    lines.push(`    sha512: ${file.sha512}`)
    lines.push(`    size: ${file.size}`)
    if (file.blockMapSize) lines.push(`    blockMapSize: ${file.blockMapSize}`)
  }
  lines.push(`releaseDate: '${data.releaseDate}'`)
  return lines.join("\n") + "\n"
}

const s3 = new S3Client({
  endpoint,
  region,
  credentials: { accessKeyId, secretAccessKey },
  forcePathStyle: true,
})

const prefix = `${channelPath}/${version}/`

async function fetchText(key: string): Promise<string> {
  const r = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
  if (!r.Body) throw new Error(`empty body for ${key}`)
  return await r.Body.transformToString()
}

// 按 base 文件名分组 per-arch yml：latest-mac-{x86_64,aarch64}.yml → "latest-mac.yml"
// 正则要求 yml 文件名 latest 开头且以 -<arch>.yml 结尾，匹配 upload-staging-s3.ts
// 的命名约定；installer / blockmap 等其它产物名不会被卷入。
const list = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }))
const ymlKeys = (list.Contents ?? [])
  .map((o) => o.Key)
  .filter((k): k is string => !!k && /\/latest.*\.yml$/.test(k))

if (ymlKeys.length === 0) {
  // staging 一个 yml 都没有：要么 upload-staging-s3 根本没跑，要么 build 矩阵全失败
  // 没产出 yml。任一情况都说明 upstream 流程坏了，往后跑也只会把空 staging 切到 live，
  // 必须立刻红 fail 防止把 live 推坏。
  throw new Error(`No latest*.yml under s3://${bucket}/${prefix}; upload-staging-s3 likely did not run`)
}

const groups = new Map<string, string[]>()
for (const key of ymlKeys) {
  const filename = key.slice(prefix.length)
  const m = filename.match(/^(latest.*)-(x86_64|aarch64)\.yml$/)
  if (!m) continue
  const baseName = `${m[1]}.yml`
  const arr = groups.get(baseName) ?? []
  arr.push(key)
  groups.set(baseName, arr)
}

if (groups.size === 0) {
  // staging 里只剩合并版本（不带 arch 后缀），说明 finalize 已经在之前的 publish job
  // 跑过了一遍，per-arch 副本被自己删掉了。手动 re-run publish job 时会进这里，no-op 即可。
  console.log("no per-arch latest*.yml found; finalize already complete on a previous run")
  process.exit(0)
}

console.log(`channel=${channelPath} version=${version} merging ${groups.size} yml group(s)`)

for (const [baseName, keys] of groups) {
  const ymls = (await Promise.all(keys.map(fetchText))).map(parse)
  const base = ymls[0]
  const merged = serialize({
    version: base.version,
    files: ymls.flatMap((y) => y.files),
    releaseDate: base.releaseDate,
  })
  const mergedKey = `${prefix}${baseName}`
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: mergedKey,
      Body: new TextEncoder().encode(merged),
    }),
  )
  console.log(`wrote merged ${baseName} <- ${keys.length} per-arch yml`)

  // 清理 per-arch，promote-s3.ts 看到的 staging 只剩合并版 + installer / blockmap
  for (const key of keys) {
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
    console.log(`deleted ${key}`)
  }
}

console.log("finalize complete")
