import { $ } from "bun"

await $`bun ./scripts/copy-icons.ts ${(process.env.WANLAICODE_CHANNEL ?? process.env.OPENCODE_CHANNEL) ?? "dev"}`
await $`bun ./scripts/build-app-snapshot-helper.ts`

await $`cd ../addon && bun run build`
await $`cd ../opencode && bun script/build-node.ts`
