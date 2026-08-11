import { $ } from "bun"
import { BRANDS, MAIN_BRAND_ID, resolveBrandIdFromEnv } from "@opencode-ai/brand/table"
import { resolveChannel } from "./utils"

const arg = process.argv[2]
const channel = arg === "dev" || arg === "beta" || arg === "prod" || arg === "canary" ? arg : resolveChannel()
const brandId = resolveBrandIdFromEnv(process.env)
const brandInfo = BRANDS[brandId]

// 选 icon source dir：
//  1. 显式 iconDirName 最强（数据 override）
//  2. main brand 兜底走 channel（兼容 wanlai 历史的 dev/beta/prod 三套图标）
//     canary 与 prod 是同一个 App，无独立图标目录，复用 prod。
//  3. sub-brand 默认用 id 当 dir 名
const iconChannel = channel === "canary" ? "prod" : channel
const dirName = brandInfo.iconDirName ?? (brandId === MAIN_BRAND_ID ? iconChannel : brandId)
const src = `./icons/${dirName}`
const dest = "resources/icons"

await $`rm -rf ${dest}`
await $`cp -R ${src} ${dest}`
console.log(`Copied ${brandId}/${channel} icons from ${src} to ${dest}`)
