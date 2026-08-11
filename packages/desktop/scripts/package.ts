#!/usr/bin/env bun
import { $ } from "bun"

// 打安装包默认 prod（与 CI publish.yml 一致）；显式 WANLAICODE_CHANNEL=dev 时保留 dev 便于同装多版本。
Bun.env.WANLAICODE_CHANNEL ??= "prod"
Bun.env.OPENCODE_CHANNEL ??= Bun.env.WANLAICODE_CHANNEL

const target = process.argv[2]
const builderFlag =
  target === "win" ? "--win" : target === "mac" ? "--mac" : target === "linux" ? "--linux" : ""

await $`bun run build`
await $`electron-builder ${builderFlag} --config electron-builder.config.ts`
