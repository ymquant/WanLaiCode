#!/usr/bin/env bun

import { Script } from "@opencode-ai/script"
import { execFileSync } from "child_process"
import fs from "fs"
import os from "os"
import path from "path"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = path.resolve(__dirname, "..")

process.chdir(dir)

await import("./generate.ts")

// Load migrations from migration directories
const migrationDirs = (
  await fs.promises.readdir(path.join(dir, "migration"), {
    withFileTypes: true,
  })
)
  .filter((entry) => entry.isDirectory() && /^\d{4}\d{2}\d{2}\d{2}\d{2}\d{2}/.test(entry.name))
  .map((entry) => entry.name)
  .sort()

const migrations = await Promise.all(
  migrationDirs.map(async (name) => {
    const file = path.join(dir, "migration", name, "migration.sql")
    const sql = await Bun.file(file).text()
    const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(name)
    const timestamp = match
      ? Date.UTC(
          Number(match[1]),
          Number(match[2]) - 1,
          Number(match[3]),
          Number(match[4]),
          Number(match[5]),
          Number(match[6]),
        )
      : 0
    return { sql, timestamp, name }
  }),
)
console.log(`Loaded ${migrations.length} migrations`)

const bunDir = path.resolve(dir, "../../node_modules/.bun")
const openaiDirs: string[] = []
if (fs.existsSync(bunDir)) {
  for (const entry of await fs.promises.readdir(bunDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const openaiDir = path.join(bunDir, entry.name, "node_modules", "openai")
    if (fs.existsSync(path.join(openaiDir, "client.mjs"))) openaiDirs.push(openaiDir)
  }
}

const sample = openaiDirs[0]
if (sample && !fs.existsSync(path.join(sample, "streaming.mjs"))) {
  const version = JSON.parse(await fs.promises.readFile(path.join(sample, "package.json"), "utf8")).version
  console.log(`Repairing incomplete openai@${version} from registry.npmjs.org...`)
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "openai-repair-"))
  const tgz = path.join(tmp, "package.tgz")
  const response = await fetch(`https://registry.npmjs.org/openai/-/openai-${version}.tgz`)
  if (!response.ok) throw new Error(`Failed to download openai@${version}: ${response.status}`)
  await Bun.write(tgz, await response.arrayBuffer())
  const extractDir = path.join(tmp, "extract")
  await fs.promises.mkdir(extractDir)
  execFileSync("tar", ["-xzf", tgz, "-C", extractDir], { stdio: "inherit" })
  const source = path.join(extractDir, "package")
  for (const openaiDir of openaiDirs) {
    await fs.promises.cp(source, openaiDir, { recursive: true })
    console.log(`Repaired ${openaiDir}`)
  }
}

await Bun.build({
  target: "node",
  entrypoints: ["./src/node.ts"],
  outdir: "./dist/node",
  format: "esm",
  sourcemap: "linked",
  external: ["jsonc-parser", "@lydell/node-pty"],
  define: {
    OPENCODE_MIGRATIONS: JSON.stringify(migrations),
    OPENCODE_CHANNEL: `'${Script.channel}'`,
  },
  files: {
    "opencode-web-ui.gen.ts": "",
  },
})

console.log("Build complete")
