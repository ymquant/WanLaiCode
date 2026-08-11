#!/usr/bin/env bun

// B-pure promote 第一步：把测过的 canary 候选「字节」复制进 prod 的版本 staging 目录。
//
// 为什么需要这一步：
//   正式 prod 发布（publish.yml channel=prod）会先把产物上传到 `prod/<version>/` staging，
//   再由 promote-s3.ts 从该 staging 复制到 `prod/` 根。回退（revoke-publish.yml）也依赖
//   `prod/<version>/` staging 存在才能切回去。但 canary→prod 转正若直接把 canary/<version>/
//   copy 到 prod/ 根，就**从不生成 prod/<version>/**，导致 promoted 的版本没有 prod staging，
//   revoke-publish 无法回退到它。
//
// 本脚本做的事：server-side CopyObject 把 `canary/<version>/` 下所有对象复制到
// `prod/<version>/`（**保留版本子路径**，destKey = `prod/<version>/<rest>`）。
// 复制完成后，再跑标准 promote-s3.ts（channel=prod、同版本号）从 `prod/<version>/` 复制到
// `prod/` 根 —— 这样 promoted 版本与正常 prod 发布布局完全一致，prod/<version>/ 存在，
// revoke-publish 可回退它。
//
// 仅主品牌：promote 是主品牌专属流程（codex 子品牌走 publish-subbrand 从 tag 重建，不在此）。
// 故 src/dest 用字面 `canary` / `prod`，不引 brand 维度。
//
// 安全：源 `canary/<version>/` 为空则抛错退出 —— 候选必须存在（promote 只搬已有候选）。
// 此时未发生任何 copy，prod 不受影响。
//
// 幂等：覆盖式 CopyObject，同字节再复制一遍无害，中途失败可直接重跑整个 promote。

import {
  CopyObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3"

// B-pure promote 固定：源 canary、目标 prod（均主品牌，字面值，不引 brand）。
const SRC_CHANNEL = "canary"
const DEST_CHANNEL = "prod"

type Config = {
  s3: S3Client
  bucket: string
  version: string
  srcPrefix: string
  destPrefix: string
}

// 容错：操作者可能手填 `v1.2.3`；S3 staging 目录用裸版本号，统一去前缀 v。
export function normalizeVersion(raw: string): string {
  return raw.trim().replace(/^v/, "")
}

// CopySource 是 "/bucket/key" 形式且需 percent-encode；key 内 "/" 必须保留。
export function buildCopySource(bucket: string, srcKey: string): string {
  return `/${bucket}/${srcKey.split("/").map(encodeURIComponent).join("/")}`
}

// destKey 推导：把源 key（canary/<version>/<rest>）的 srcPrefix 换成 destPrefix，
// 即 `prod/<version>/<rest>` —— 保留版本子路径（与正常 prod 发布的 staging 布局一致）。
export function deriveDestKey(srcKey: string, srcPrefix: string, destPrefix: string): string {
  return `${destPrefix}${srcKey.slice(srcPrefix.length)}`
}

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

  const s3 = new S3Client({
    endpoint,
    region,
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true,
  })

  return {
    s3,
    bucket,
    version,
    srcPrefix: `${SRC_CHANNEL}/${version}/`,
    destPrefix: `${DEST_CHANNEL}/${version}/`,
  }
}

async function listSrcKeys(cfg: Config): Promise<string[]> {
  // 桌面产物每平台 ~4 文件 × 5 平台 = 20 个左右，远低于 ListObjectsV2 单页 1000 上限，不分页。
  const list = await cfg.s3.send(new ListObjectsV2Command({ Bucket: cfg.bucket, Prefix: cfg.srcPrefix }))
  const keys = (list.Contents ?? [])
    .map((o) => o.Key)
    .filter((k): k is string => !!k && k !== cfg.srcPrefix)
  if (keys.length === 0) {
    throw new Error(`No objects found under s3://${cfg.bucket}/${cfg.srcPrefix}; canary 候选不存在，无法 stage 到 prod`)
  }
  return keys
}

async function copyToProdStaging(cfg: Config, sourceKey: string): Promise<void> {
  const destKey = deriveDestKey(sourceKey, cfg.srcPrefix, cfg.destPrefix)
  await cfg.s3.send(
    new CopyObjectCommand({
      Bucket: cfg.bucket,
      Key: destKey,
      CopySource: buildCopySource(cfg.bucket, sourceKey),
    }),
  )
  console.log(`staged ${sourceKey} -> ${destKey}`)
}

async function main(): Promise<void> {
  const cfg = loadConfig()

  // 源为空则抛错退出，此时 prod 未动 —— 防止「stage 不存在的候选」。
  const keys = await listSrcKeys(cfg)

  console.log(`staging ${keys.length} 个对象: ${cfg.srcPrefix} -> ${cfg.destPrefix}`)
  for (const key of keys) await copyToProdStaging(cfg, key)
  console.log("stage canary -> prod staging complete")
}

// 直接 `bun stage-canary-to-prod-s3.ts` 运行时才执行；被测试 import 时只取纯函数，不触发 main。
if (import.meta.main) await main()
