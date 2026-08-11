#!/usr/bin/env bun

import { rm } from "fs/promises"
import path from "path"
import { parseArgs } from "util"

const root = path.resolve(import.meta.dir, "..")
const file = path.join(root, "UPCOMING_CHANGELOG.md")

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    from: { type: "string", short: "f" },
    to: { type: "string", short: "t" },
    variant: { type: "string", default: "low" },
    quiet: { type: "boolean", default: false },
    print: { type: "boolean", default: false },
    thinking: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
  allowPositionals: true,
})
const args = [...positionals]
if (values.from) args.push("--from", values.from)
if (values.to) args.push("--to", values.to)

if (values.help) {
  console.log(`
Usage: bun script/changelog.ts [options]

Generates UPCOMING_CHANGELOG.md by running the opencode changelog command.

Options:
  -f, --from <version>   Starting version (default: latest non-draft GitHub release)
  -t, --to <ref>         Ending ref (default: HEAD)
      --variant <name>   Thinking variant for opencode run (default: low)
      --quiet            Suppress opencode command output unless it fails
      --thinking         Stream model reasoning to the terminal
      --print            Print the generated UPCOMING_CHANGELOG.md after success
  -h, --help             Show this help message
`)
  process.exit(0)
}

await rm(file, { force: true })

// Three modes:
//   - OPENCODE_API_KEY set    → upstream opencode/* model
//   - wanlaicode triplet set  → fork's OpenAI-compatible gateway
//   - neither                 → git log fallback
const wanlaicode =
  !process.env.OPENCODE_API_KEY &&
  process.env.WANLAICODE_LLM_API_KEY &&
  process.env.WANLAICODE_LLM_BASE_URL &&
  process.env.WANLAICODE_CHANGELOG_MODEL

if (!process.env.OPENCODE_API_KEY && !wanlaicode) {
  const repo = process.env.GH_REPO
  let from = values.from ? (values.from.startsWith("v") ? values.from : `v${values.from}`) : ""
  if (!from && repo) {
    const tagProc = Bun.spawn(
      ["gh", "release", "list", "--repo", repo, "--limit", "1", "--json", "tagName", "--exclude-drafts"],
      { stdout: "pipe", stderr: "pipe" },
    )
    const tagText = await new Response(tagProc.stdout).text()
    await tagProc.exited
    if (tagProc.exitCode === 0) {
      try {
        from = (JSON.parse(tagText || "[]")[0]?.tagName as string) ?? ""
      } catch {
        from = ""
      }
    }
  }
  const to = values.to ?? "HEAD"
  const range = from ? `${from}..${to}` : `${to}~30..${to}`
  const logProc = Bun.spawn(["git", "log", "--pretty=format:- %s (%h)", "--no-merges", range], {
    stdout: "pipe",
    stderr: "pipe",
    cwd: root,
  })
  const log = (await new Response(logProc.stdout).text()).trim()
  await logProc.exited
  await Bun.write(file, `## Changes\n\n${log || "_No notable changes._"}\n`)
  if (values.print) process.stdout.write(await Bun.file(file).text())
  process.exit(0)
}

// opencode 的 command frontmatter `model:` 优先于 CLI --model（见
// packages/opencode/src/session/prompt.ts taskModel），所以派生一份改了 model 行的命令
// 文件让 opencode 加载。派生文件在 .opencode/.gitignore 里忽略。
let commandName = "changelog"
if (wanlaicode) {
  const src = path.join(root, ".opencode/command/changelog.md")
  const dst = path.join(root, ".opencode/command/changelog-wanlaicode.md")
  const text = await Bun.file(src).text()
  let rewritten = text.replace(/^(model:\s*).+$/m, `$1wanlaicode/${process.env.WANLAICODE_CHANGELOG_MODEL}`)
  if (rewritten === text) {
    console.error("[changelog] could not find model: line in changelog.md frontmatter")
    process.exit(1)
  }
  // 注入语言指令：私有 fork 内部团队默认中文 changelog。section 标题保留英文便于 grep。
  const langDirective =
    "**Output language**: write all bullet content in Simplified Chinese (中文)." +
    " Keep section headers (`## Core`, `### Improvements`, etc.) in English.\n\n"
  const withLang = rewritten.replace(/(<changelog_input>)/, `${langDirective}$1`)
  if (withLang === rewritten) {
    console.error("[changelog] could not find <changelog_input> marker to inject language directive")
    process.exit(1)
  }
  await Bun.write(dst, withLang)
  commandName = "changelog-wanlaicode"
}

const quiet = values.quiet
const cmd = ["opencode", "run", "--variant", values.variant]
if (values.thinking) cmd.push("--thinking")
cmd.push("--command", commandName, "--", ...args)

// 始终 pipe opencode stdio：继承 TTY 时它会切到 TUI 模式（清屏 + \r 覆盖），在
// reasoning 模型第一个 chunk 出来前看上去像"卡死"。pipe 强制走行式流输出。
const proc = Bun.spawn(cmd, {
  cwd: root,
  stdin: "inherit",
  stdout: "pipe",
  stderr: "pipe",
})

const captured = { out: "", err: "" }
const drain = async (
  stream: ReadableStream<Uint8Array>,
  forward: NodeJS.WriteStream,
  field: "out" | "err",
) => {
  const decoder = new TextDecoder()
  // @ts-expect-error Bun's ReadableStream supports async iteration
  for await (const chunk of stream) {
    const text = decoder.decode(chunk, { stream: true })
    if (quiet) captured[field] += text
    else forward.write(text)
  }
}
await Promise.all([
  drain(proc.stdout, process.stdout, "out"),
  drain(proc.stderr, process.stderr, "err"),
])
const code = await proc.exited

if (code === 0) {
  if (values.print) process.stdout.write(await Bun.file(file).text())
  process.exit(0)
}

if (quiet) {
  if (captured.out) process.stdout.write(captured.out)
  if (captured.err) process.stderr.write(captured.err)
}

process.exit(code)
