#!/usr/bin/env bun

// 把当前平台 electron-builder 产出 (packages/desktop/dist/*) 上传到 S3 staging 路径
// <channel>/<version>/。每个 matrix 平台跑这一步，把自家产物推到同一个版本目录。
// 待全部平台成功后由 publish job 的 promote-s3.ts 一次性 server-side copy 到 <channel>/ 根，
// 让 auto-updater 跨平台原子看到新版本。
//
// 单独写脚本而不复用 electron-builder 的 publish：electron-builder 的 publish.path 同时
// 锁定"上传位置"和"baked 进 app-update.yml 的拉取位置"，要解耦就只能 --publish never +
// 自写上传。

import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3"
import fs from "node:fs/promises"
import path from "node:path"

import { BRANDS } from "@opencode-ai/brand/table"

import { resolveBrand, resolveChannel, resolveChannelPath } from "./utils"

// 白名单：只上传 release 必需文件，其它 dist/ 下任何 electron-builder 留的元数据
// (builder-effective-config.yaml / builder-debug.yml ...) 一律不进 S3。
//   - 安装包后缀          .dmg / .zip / .exe / .AppImage / .deb / .rpm
//   - 增量更新差异块       *.blockmap （每个 installer 一份）
//   - updater 入口元数据   latest*.yml / latest*.json
//
// 安装包还必须以本次构建的 brand 前缀开头（与 electron-builder.config.ts 的 artifactName
// 同源）：Windows 的 checkout 是 clean:false（保留 node_modules 做增量安装），dist/ 因此会
// 残留上一次别的 brand 构建的安装包，只按后缀放行会把它一起传走，落进本 brand 的通道。
// 实证：v0.1.5 发版时 canary/ 混入了 CodexWanLai-desktop-win-x64.exe，而该 run 的
// trigger-subbrand 是 skipped、根本没构建子 brand。
// latest*.yml 由 electron-builder 按本次构建生成、文件名不带 brand 前缀，照常放行。
export function isReleaseArtifact(name: string, artifactPrefix: string): boolean {
  if (/^latest.*\.(yml|json)$/.test(name)) return true
  if (!name.startsWith(`${artifactPrefix}-`)) return false
  return /\.(dmg|zip|exe|AppImage|deb|rpm|blockmap)$/.test(name)
}

// 安装包本体判据（不含 latest*.yml 与 blockmap），用于"过滤后至少要有一个本 brand 安装包"
// 的守卫。isReleaseArtifact 对不带前缀的 latest*.yml 无条件放行，dist/ 里恒有它，所以
// files.length > 0 拦不住"安装包被前缀全滤掉"——那会只传 updater 元数据然后全绿，
// promote 后 live 的 latest.yml 指向一个不存在的安装包。
export function isBrandInstaller(name: string, artifactPrefix: string): boolean {
  if (!name.startsWith(`${artifactPrefix}-`)) return false
  return /\.(dmg|zip|exe|AppImage|deb|rpm)$/.test(name)
}

async function main() {
  const version = Bun.env.WANLAICODE_VERSION
  if (!version) throw new Error("WANLAICODE_VERSION is required")

  const endpoint = Bun.env.S3_ENDPOINT
  const bucket = Bun.env.S3_BUCKET
  if (!endpoint || !bucket) throw new Error("S3_ENDPOINT and S3_BUCKET are required")

  // GitHub Actions vars 未配置时 env 是空字符串而非 undefined，?? 不会兜底；
  // AWS SDK 对空 region 直接 "Region is missing"，必须用 || 把空串也走默认值。
  const region = Bun.env.S3_REGION || "us-east-1"
  const accessKeyId = Bun.env.AWS_ACCESS_KEY_ID
  const secretAccessKey = Bun.env.AWS_SECRET_ACCESS_KEY
  if (!accessKeyId || !secretAccessKey) throw new Error("AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are required")

  const channel = resolveChannel()
  const channelPath = resolveChannelPath()
  if (channel === "dev") throw new Error("upload-staging-s3 should not run for dev channel")

  // 所有 latest*.yml 都加 arch 后缀进 staging，由 publish job 的 finalize-latest-yml.ts
  // 统一读 per-arch yml 合并写回 base 名（再删 per-arch）。即使当前 win/linux 矩阵单 arch
  // 合并是恒等，也走同一条路径，保持逻辑对称，未来加 win/linux 的 arm64 不用改脚本。
  const rustTarget = Bun.env.RUST_TARGET
  const archSuffix = rustTarget?.startsWith("x86_64-")
    ? "x86_64"
    : rustTarget?.startsWith("aarch64-")
      ? "aarch64"
      : undefined
  // 兜底显式 throw：matrix 配错 / 新加平台忘了带 target 时，rustTarget 有值但 archSuffix
  // 落不到任何分支 → mac latest-mac.yml 不加后缀 → 两个 arch 在 staging 互盖，回到老
  // bug 但更隐蔽（不报错）。直接红 fail 强制补 matrix 配置。
  if (rustTarget && !archSuffix) {
    throw new Error(`Unrecognized RUST_TARGET=${rustTarget}; expected x86_64-* or aarch64-* prefix`)
  }
  function stagingKeyName(name: string): string {
    if (archSuffix && /^latest.*\.yml$/.test(name)) {
      return `${name.slice(0, -".yml".length)}-${archSuffix}.yml`
    }
    return name
  }

  // 当前构建的 brand 前缀（electron-builder.config.ts 的 artifactName 用同一个值命名产物）。
  const artifactPrefix = BRANDS[resolveBrand()].artifactPrefix

  const distDir = path.resolve(import.meta.dir, "..", "dist")
  const files = (await fs.readdir(distDir, { withFileTypes: true }))
    .filter((e) => e.isFile() && isReleaseArtifact(e.name, artifactPrefix))
    .map((e) => e.name)
  if (files.length === 0) throw new Error(`No files in ${distDir}; did electron-builder run?`)
  if (!files.some((name) => isBrandInstaller(name, artifactPrefix))) {
    throw new Error(
      `No ${artifactPrefix}-* installer in ${distDir}; 只剩 updater 元数据说明命名约定与 artifactPrefix 已经漂移，` +
        `继续上传会让 latest.yml 指向不存在的安装包`,
    )
  }

  const s3 = new S3Client({
    endpoint,
    region,
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true,
  })

  console.log(`brand=${resolveBrand()} prefix=${artifactPrefix} channel=${channelPath} version=${version} uploading ${files.length} file(s)`)

  for (const name of files) {
    const stagingName = stagingKeyName(name)
    const key = `${channelPath}/${version}/${stagingName}`
    const body = new Uint8Array(await Bun.file(path.join(distDir, name)).arrayBuffer())
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body }))
    const renamedHint = stagingName === name ? "" : ` (renamed from ${name})`
    console.log(`uploaded ${stagingName}${renamedHint} (${body.byteLength} bytes) -> ${key}`)
  }

  console.log("upload complete")
}

if (import.meta.main) await main()
