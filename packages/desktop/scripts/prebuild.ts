#!/usr/bin/env bun
import { $ } from "bun"

import { resolveChannel } from "./utils"

const channel = resolveChannel()
await $`bun ./scripts/copy-icons.ts ${channel}`
await $`bun ./scripts/build-app-snapshot-helper.ts`

await $`cd ../addon && bun run build`
await $`cd ../opencode && bun script/build-node.ts`
