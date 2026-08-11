import { $ } from "bun"

import { MAIN_BRAND_ID, resolveBrandIdFromEnv, type BrandId } from "@opencode-ai/brand/table"

export type Channel = "dev" | "beta" | "prod" | "canary"

export function resolveChannel(): Channel {
  const raw = Bun.env.WANLAICODE_CHANNEL ?? Bun.env.OPENCODE_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod" || raw === "canary") return raw
  return "dev"
}

// 维持外部 API 名字 `Brand`，类型从 BRANDS 推导（加新 brand 自动展开 union）。
export type Brand = BrandId

export function resolveBrand(): Brand {
  return resolveBrandIdFromEnv(Bun.env)
}

export function resolveChannelPath(): string {
  const channel = resolveChannel()
  const brand = resolveBrand()
  // main brand 走 plain channel（兼容现网 prod/、beta/）；sub-brand 拼 `-<brand>` 后缀新开 channel。
  return brand === MAIN_BRAND_ID ? channel : `${channel}-${brand}`
}

export const SIDECAR_BINARIES: Array<{ rustTarget: string; ocBinary: string; assetExt: string }> = [
  {
    rustTarget: "aarch64-apple-darwin",
    ocBinary: "opencode-darwin-arm64",
    assetExt: "zip",
  },
  {
    rustTarget: "x86_64-apple-darwin",
    ocBinary: "opencode-darwin-x64-baseline",
    assetExt: "zip",
  },
  {
    rustTarget: "aarch64-pc-windows-msvc",
    ocBinary: "opencode-windows-arm64",
    assetExt: "zip",
  },
  {
    rustTarget: "x86_64-pc-windows-msvc",
    ocBinary: "opencode-windows-x64-baseline",
    assetExt: "zip",
  },
  {
    rustTarget: "x86_64-unknown-linux-gnu",
    ocBinary: "opencode-linux-x64-baseline",
    assetExt: "tar.gz",
  },
  {
    rustTarget: "aarch64-unknown-linux-gnu",
    ocBinary: "opencode-linux-arm64",
    assetExt: "tar.gz",
  },
]

export const RUST_TARGET = Bun.env.RUST_TARGET

function nativeTarget() {
  const { platform, arch } = process
  if (platform === "darwin") return arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin"
  if (platform === "win32") return arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc"
  if (platform === "linux") return arch === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu"
  throw new Error(`Unsupported platform: ${platform}/${arch}`)
}

export function getCurrentSidecar(target = RUST_TARGET ?? nativeTarget()) {
  const binaryConfig = SIDECAR_BINARIES.find((b) => b.rustTarget === target)
  if (!binaryConfig) throw new Error(`Sidecar configuration not available for Rust target '${target}'`)

  return binaryConfig
}

export async function copyBinaryToSidecarFolder(source: string) {
  const dir = `resources`
  await $`mkdir -p ${dir}`
  const dest = windowsify(`${dir}/opencode-cli`)
  await $`cp ${source} ${dest}`
  // 无 Azure 凭据时不签名（也避免 self-hosted runner 上 pwsh 不存在导致 spawn ENOENT）
  if (process.platform === "win32" && process.env.GITHUB_ACTIONS === "true" && process.env.AZURE_CLIENT_ID) {
    await $`pwsh -NoLogo -NoProfile -ExecutionPolicy Bypass -File ../../script/sign-windows.ps1 ${dest}`
  }
  if (process.platform === "darwin") await $`codesign --force --sign - ${dest}`

  console.log(`Copied ${source} to ${dest}`)
}

export function windowsify(path: string) {
  if (path.endsWith(".exe")) return path
  return `${path}${process.platform === "win32" ? ".exe" : ""}`
}
