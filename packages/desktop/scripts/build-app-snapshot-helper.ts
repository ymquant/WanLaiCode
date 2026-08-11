#!/usr/bin/env bun
import { $ } from "bun"
import { rm } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

if (process.platform !== "darwin") process.exit(0)

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const source = join(root, "native/app-snapshot-helper.m")
const output = join(root, "native/swift-build/app-snapshot-helper")
const moduleCache = join(root, "native/node_modules/.cache/app-snapshot-helper")

await rm(join(root, "native/swift-build/module-cache"), { recursive: true, force: true })
await $`mkdir -p ${dirname(output)}`
await $`mkdir -p ${moduleCache}`
await $`xcrun clang -fobjc-arc -fmodules -fmodules-cache-path=${moduleCache} -mmacosx-version-min=12.0 ${source} -O -framework Cocoa -framework ApplicationServices -o ${output}`
