#!/usr/bin/env bun

// 把 staging 版本目录 `<channelPath>/<version>/` 下所有对象 server-side CopyObject 到
// `<channelPath>/` 根，让 auto-updater 的 latest*.yml 一次性切到目标版本。
//
// 两个调用方，同一段逻辑，只是喂进去的版本号不同：
//   - 发布（publish.yml）：用新版本号 → live 切到新版
//   - 回退（revoke-publish.yml）：用旧版本号 → live 切回早先预留的旧版
// 脚本本身不区分发布/回退，只认"把 <channelPath>/<version>/ 复制到 <channelPath>/"。
//
// 切换前先读一遍当前 live 的 latest*.yml 版本，打日志 + 写 step summary，让"从哪个
// 版本切到哪个版本"对操作者可见（回退时尤其重要）。这步是只读的，不影响 live。
//
// 安全：listStagingKeys 在任何 copy 之前先校验目标 staging 非空，空则抛错退出 ——
// 此时 live 一个文件都没动，所以"回退到不存在的版本"不会破坏现网。
//
// 复制分两阶段，避免中间态：
//   阶段 1: installer / blockmap 等所有非 yml/json 文件先到 live
//   阶段 2: latest*.yml / latest*.json 再到 live
// auto-updater 拉取顺序是 yml → 据 yml 里的 url 拉 installer。yml 后切，保证当
// updater 见到新 yml 时对应 installer 已经在 live，不会出现 yml 指向还没复制完的
// installer 的 404 短窗。

import { appendFileSync } from "node:fs"

import {
  CopyObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3"

import { resolveChannel, resolveChannelPath } from "./utils"

type Config = {
  s3: S3Client
  bucket: string
  channelPath: string
  version: string
  livePrefix: string
  stagingPrefix: string
}

type LiveManifest = { name: string; version: string }

function loadConfig(): Config {
  const rawVersion = Bun.env.WANLAICODE_VERSION
  if (!rawVersion) throw new Error("WANLAICODE_VERSION is required")
  const version = normalizeVersion(rawVersion)

  const endpoint = Bun.env.S3_ENDPOINT
  const bucket = Bun.env.S3_BUCKET
  if (!endpoint || !bucket) throw new Error("S3_ENDPOINT and S3_BUCKET are required")

  // GitHub Actions vars 未配置时 env 是空字符串而非 undefined，?? 不会兜底；
  // AWS SDK 对空 region 直接 "Region is missing"，必须用 || 把空串也走默认值。
  const region = Bun.env.S3_REGION || "us-east-1"
  const accessKeyId = Bun.env.AWS_ACCESS_KEY_ID
  const secretAccessKey = Bun.env.AWS_SECRET_ACCESS_KEY
  if (!accessKeyId || !secretAccessKey) throw new Error("AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are required")

  // 目标 S3 目录由 channel + brand 经 resolveChannelPath() 推导（发布/回退同一套，零 drift）。
  // 回退（revoke-publish.yml）把下拉选的目录映射成 WANLAICODE_CHANNEL/_BRAND 传入，
  // 例：prod→prod、canary→canary、prod-codex→(channel=prod, brand=codex)。
  const channel = resolveChannel()
  if (channel === "dev") throw new Error("promote-s3 should not run for dev channel")
  const channelPath = resolveChannelPath()

  const s3 = new S3Client({
    endpoint,
    region,
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true,
  })

  return {
    s3,
    bucket,
    channelPath,
    version,
    livePrefix: `${channelPath}/`,
    stagingPrefix: `${channelPath}/${version}/`,
  }
}

// 容错：回退时操作者可能手填 `v1.2.3`；S3 staging 目录用的是裸版本号，统一去前缀 v。
// 发布走 version.ts 产出的裸版本，去前缀是恒等，无副作用。
export function normalizeVersion(raw: string): string {
  return raw.trim().replace(/^v/, "")
}

// updater 元数据：latest 开头的 yml / json
export function isUpdaterManifest(key: string): boolean {
  return /\/latest.*\.(yml|json)$/.test(key)
}

// staging 里残留的 per-arch yml（latest*-x86_64.yml / -aarch64.yml）—— 未 finalize 的标志。
// 注意 arch 限定 x86_64|aarch64，不会误伤合法标准名 latest-linux-arm64.yml（arm64 ≠ aarch64）。
export function isPerArchManifest(name: string): boolean {
  return /^latest.*-(x86_64|aarch64)\.yml$/.test(name)
}

// live 根下顶层的 latest*.yml（rest = key 去掉 livePrefix 后的部分）。
// rest 不含 "/" 以排除 `<version>/latest*.yml` 这种 staging 子目录副本。
export function isTopLevelLiveManifest(rest: string): boolean {
  return !rest.includes("/") && /^latest.*\.yml$/.test(rest)
}

// CopySource 是 "/bucket/key" 形式且需 percent-encode；key 内 "/" 必须保留。
export function buildCopySource(bucket: string, srcKey: string): string {
  return `/${bucket}/${srcKey.split("/").map(encodeURIComponent).join("/")}`
}

async function fetchText(cfg: Config, key: string): Promise<string> {
  const r = await cfg.s3.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: key }))
  if (!r.Body) throw new Error(`empty body for ${key}`)
  return await r.Body.transformToString()
}

// latest*.yml 里 version 字段是行首 `version: x.y.z`，直接抓首个匹配行，无需完整解析 files[]。
export function extractVersion(yml: string): string {
  for (const line of yml.split("\n")) {
    if (line.startsWith("version:")) return line.slice("version:".length).trim()
  }
  return "<unknown>"
}

// 切换前当前 live 版本：列 live 根下顶层（不含子目录）的 latest*.yml，逐个读 version。
// 全新 channel 还没 live 文件时返回空数组（首次发布场景），不报错。
async function readLiveVersions(cfg: Config): Promise<LiveManifest[]> {
  const list = await cfg.s3.send(new ListObjectsV2Command({ Bucket: cfg.bucket, Prefix: cfg.livePrefix }))
  const manifestKeys = (list.Contents ?? [])
    .map((o) => o.Key)
    .filter((k): k is string => {
      if (!k) return false
      return isTopLevelLiveManifest(k.slice(cfg.livePrefix.length))
    })

  const manifests: LiveManifest[] = []
  for (const key of manifestKeys) {
    manifests.push({ name: key.slice(cfg.livePrefix.length), version: extractVersion(await fetchText(cfg, key)) })
  }
  return manifests
}

async function listStagingKeys(cfg: Config): Promise<string[]> {
  // 桌面产物每平台 ~4 文件 × 5 平台 = 20 个左右，远低于 ListObjectsV2 单页 1000 上限，不分页。
  const list = await cfg.s3.send(new ListObjectsV2Command({ Bucket: cfg.bucket, Prefix: cfg.stagingPrefix }))
  const keys = (list.Contents ?? [])
    .map((o) => o.Key)
    .filter((k): k is string => !!k && k !== cfg.stagingPrefix)
  if (keys.length === 0) throw new Error(`No objects found under s3://${cfg.bucket}/${cfg.stagingPrefix}; nothing to promote`)
  return keys
}

// 合法的 promote 目标（发布或回退）staging 必然已被 finalize-latest-yml.ts 合并过，
// 只剩 electron-updater 认的标准名 yml。若还残留带 arch 后缀的 per-arch yml
// （latest*-x86_64.yml / -aarch64.yml），说明该版本发布中途失败、从未 finalize：
// 直接 copy 会把 per-arch 带到 live 却不生成合并的 latest-mac.yml，使 updater 指针不一致。
// 这里硬失败拦住（回退 workflow 的 version 是 free-text，可能误填这种半成品版本）。
export function assertFinalized(keys: string[], stagingPrefix: string, bucket: string): void {
  const perArch = keys.map((k) => k.slice(stagingPrefix.length)).filter(isPerArchManifest)
  if (perArch.length > 0) {
    throw new Error(
      `staging s3://${bucket}/${stagingPrefix} 残留未合并的 per-arch manifest: ` +
        `${perArch.join(", ")}；该版本未完成 finalize，不能作为 promote 目标。`,
    )
  }
}

async function copyToLive(cfg: Config, sourceKey: string): Promise<void> {
  const destKey = `${cfg.channelPath}/${sourceKey.slice(cfg.stagingPrefix.length)}`
  await cfg.s3.send(
    new CopyObjectCommand({
      Bucket: cfg.bucket,
      Key: destKey,
      CopySource: buildCopySource(cfg.bucket, sourceKey),
    }),
  )
  console.log(`promoted ${sourceKey} -> ${destKey}`)
}

function liveVersionsLabel(liveVersions: LiveManifest[]): string {
  if (liveVersions.length === 0) return "(无 live manifest)"
  return liveVersions.map((v) => `${v.name}=${v.version}`).join(", ")
}

// step summary：在 run 页面展示「切换前 live 版本 → 目标版本」+ 已 promote 的对象。
function writeStepSummary(cfg: Config, liveVersions: LiveManifest[], assetKeys: string[], manifestKeys: string[]): void {
  const summaryPath = Bun.env.GITHUB_STEP_SUMMARY
  if (!summaryPath) return

  const liveLine =
    liveVersions.length === 0
      ? "_(无 live manifest)_"
      : liveVersions.map((v) => `\`${v.name}\` = \`${v.version}\``).join(", ")
  const names = (keys: string[]) => keys.map((k) => k.slice(cfg.stagingPrefix.length)).sort()

  const lines = [
    `## Promote 到 live`,
    ``,
    `- **channelPath**: \`${cfg.channelPath}\``,
    `- **切换前 live 版本**: ${liveLine}`,
    `- **切换到版本**: \`${cfg.version}\``,
    ``,
    `### 已 promote 的对象（${assetKeys.length + manifestKeys.length} 个）`,
    ``,
    ...names(assetKeys).map((n) => `- \`${n}\``),
    ...names(manifestKeys).map((n) => `- \`${n}\` _(manifest)_`),
    ``,
  ]
  appendFileSync(summaryPath, lines.join("\n") + "\n")
}

async function main(): Promise<void> {
  const cfg = loadConfig()

  // 切换前先读当前 live 版本（只读，不动 live），用于日志 / summary 的「从→到」展示。
  // 这是纯展示功能：读失败（瞬时 S3 错误、list 后对象被并发删除等）只降级，绝不中断
  // promote —— 否则一个展示性的读会阻断本可成功的发布。
  let liveVersions: LiveManifest[] = []
  try {
    liveVersions = await readLiveVersions(cfg)
  } catch (e) {
    console.warn(`读取当前 live 版本失败，跳过「从→到」展示: ${e}`)
  }

  // 目标 staging：空则抛错退出，此时 live 未动 —— 防止切到不存在的版本。
  const keys = await listStagingKeys(cfg)
  // 目标必须已 finalize；残留 per-arch yml 说明该版本未完成发布，不能 promote。
  assertFinalized(keys, cfg.stagingPrefix, cfg.bucket)

  const assetKeys = keys.filter((k) => !isUpdaterManifest(k))
  const manifestKeys = keys.filter(isUpdaterManifest)

  console.log(`channel=${cfg.channelPath} 当前 live=${liveVersionsLabel(liveVersions)} -> 目标=${cfg.version}`)
  console.log(`promoting ${assetKeys.length} asset(s) + ${manifestKeys.length} manifest(s)`)

  // 阶段 1：installer / blockmap 等先到 live
  for (const key of assetKeys) await copyToLive(cfg, key)
  // 阶段 2：updater manifest（latest*.yml / *.json）后到 live —— 此时引用的 installer 已就位
  for (const key of manifestKeys) await copyToLive(cfg, key)

  writeStepSummary(cfg, liveVersions, assetKeys, manifestKeys)
  console.log("promote complete")
}

// 直接 `bun promote-s3.ts` 运行时才执行；被测试 import 时只取纯函数，不触发 main。
if (import.meta.main) await main()
