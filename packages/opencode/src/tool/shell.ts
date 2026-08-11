import { Clock, Deferred, Effect, Option } from "effect"
import os from "os"
import * as Tool from "./tool"
import path from "path"
import * as Log from "@opencode-ai/core/util/log"
import { containsPath, type InstanceContext } from "../project/instance-context"
import { InstanceState } from "@/effect/instance-state"
import { lazy } from "@/util/lazy"
import { Language, type Node } from "web-tree-sitter"

import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { fileURLToPath } from "url"
import { Config } from "@/config/config"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Shell } from "@/shell/shell"
import { ShellID } from "./shell/id"

import * as Truncate from "./truncate"
import { Plugin } from "@/plugin"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { ShellPrompt, type Parameters } from "./shell/prompt"
import { BashArity } from "@/permission/arity"
import { withWindowsUtf8ShellEnv } from "@/shell/output"
import { ShellBackground, MAX_PER_SESSION, type ShellBackgroundMeta } from "./shell/background"
import { ShellFiles } from "./shell/files"
import { Agent } from "@/agent/agent"
import { Session } from "@/session/session"
import { Permission } from "@/permission"

export { Parameters } from "./shell/prompt"

const MAX_METADATA_LENGTH = 30_000
// 单次命令最多记录的变更文件数。批处理脚本可能触碰上千文件,元数据要有硬上限。
const MAX_TRACKED_FILE_CHANGES = 50
// mtime 扫描的目录深度上限,避免深层大仓遍历拖慢每次 shell 调用。
const FILE_SCAN_MAX_DEPTH = 4
// 扫描时跳过的目录名(点目录另有统一规则)。
const FILE_SCAN_SKIP_DIRS = new Set(["node_modules", "dist", "build", "out", "target", "vendor", "__pycache__"])
// 部分文件系统 mtime 粒度为秒,取 since 时留 1s 容差,否则同秒内写入会被漏掉。
const MTIME_GRANULARITY_MS = 1_000
const DEFAULT_TIMEOUT = Flag.WANLAICODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS || 2 * 60 * 1000
const CWD = new Set(["cd", "chdir", "popd", "pushd", "push-location", "set-location"])
const FILES = new Set([
  ...CWD,
  "rm",
  "cp",
  "mv",
  "mkdir",
  "touch",
  "chmod",
  "chown",
  "cat",
  // Leave PowerShell aliases out for now. Common ones like cat/cp/mv/rm/mkdir
  // already hit the entries above, and alias normalization should happen in one
  // place later so we do not risk double-prompting.
  "get-content",
  "set-content",
  "add-content",
  "copy-item",
  "move-item",
  "remove-item",
  "new-item",
  "rename-item",
])
const CMD_FILES = new Set([
  "copy",
  "del",
  "dir",
  "erase",
  "md",
  "mkdir",
  "move",
  "rd",
  "ren",
  "rename",
  "rmdir",
  "type",
])
const FLAGS = new Set(["-destination", "-literalpath", "-path"])
const SWITCHES = new Set(["-confirm", "-debug", "-force", "-nonewline", "-recurse", "-verbose", "-whatif"])

type Part = {
  type: string
  text: string
}

type Scan = {
  dirs: Set<string>
  patterns: Set<string>
  always: Set<string>
}

export const log = Log.create({ service: "shell-tool" })

const resolveWasm = (asset: string) => {
  if (asset.startsWith("file://")) return fileURLToPath(asset)
  if (asset.startsWith("/") || /^[a-z]:/i.test(asset)) return asset
  const url = new URL(asset, import.meta.url)
  return fileURLToPath(url)
}

function parts(node: Node) {
  const out: Part[] = []
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    if (!child) continue
    if (child.type === "command_elements") {
      for (let j = 0; j < child.childCount; j++) {
        const item = child.child(j)
        if (!item || item.type === "command_argument_sep" || item.type === "redirection") continue
        out.push({ type: item.type, text: item.text })
      }
      continue
    }
    if (
      child.type !== "command_name" &&
      child.type !== "command_name_expr" &&
      child.type !== "word" &&
      child.type !== "string" &&
      child.type !== "raw_string" &&
      child.type !== "concatenation"
    ) {
      continue
    }
    out.push({ type: child.type, text: child.text })
  }
  return out
}

function source(node: Node) {
  return (node.parent?.type === "redirected_statement" ? node.parent.text : node.text).trim()
}

function commands(node: Node) {
  return node.descendantsOfType("command").filter((child): child is Node => Boolean(child))
}

function unquote(text: string) {
  if (text.length < 2) return text
  const first = text[0]
  const last = text[text.length - 1]
  if ((first === '"' || first === "'") && first === last) return text.slice(1, -1)
  return text
}

function home(text: string) {
  if (text === "~") return os.homedir()
  if (text.startsWith("~/") || text.startsWith("~\\")) return path.join(os.homedir(), text.slice(2))
  return text
}

function envValue(key: string) {
  if (process.platform !== "win32") return process.env[key]
  const name = Object.keys(process.env).find((item) => item.toLowerCase() === key.toLowerCase())
  return name ? process.env[name] : undefined
}

function auto(key: string, cwd: string, shell: string) {
  const name = key.toUpperCase()
  if (name === "HOME") return os.homedir()
  if (name === "PWD") return cwd
  if (name === "PSHOME") return path.dirname(shell)
}

function expand(text: string, cwd: string, shell: string) {
  const out = unquote(text)
    .replace(/\$\{env:([^}]+)\}/gi, (_, key: string) => envValue(key) || "")
    .replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/gi, (_, key: string) => envValue(key) || "")
    .replace(/\$(HOME|PWD|PSHOME)(?=$|[\\/])/gi, (_, key: string) => auto(key, cwd, shell) || "")
  return home(out)
}

function provider(text: string) {
  const match = text.match(/^([A-Za-z]+)::(.*)$/)
  if (match) {
    if (match[1].toLowerCase() !== "filesystem") return
    return match[2]
  }
  const prefix = text.match(/^([A-Za-z]+):(.*)$/)
  if (!prefix) return text
  if (prefix[1].length === 1) return text
  return
}

function dynamic(text: string, ps: boolean) {
  if (text.startsWith("(") || text.startsWith("@(")) return true
  if (text.includes("$(") || text.includes("${") || text.includes("`")) return true
  if (ps) return /\$(?!env:)/i.test(text)
  return text.includes("$")
}

function prefix(text: string) {
  const match = /[?*[]/.exec(text)
  if (!match) return text
  if (match.index === 0) return
  return text.slice(0, match.index)
}

function pathArgs(list: Part[], ps: boolean, cmd = false) {
  if (!ps) {
    return list
      .slice(1)
      .filter(
        (item) =>
          !item.text.startsWith("-") &&
          !(cmd && item.text.startsWith("/")) &&
          !(list[0]?.text === "chmod" && item.text.startsWith("+")),
      )
      .map((item) => item.text)
  }

  const out: string[] = []
  let want = false
  for (const item of list.slice(1)) {
    if (want) {
      out.push(item.text)
      want = false
      continue
    }
    if (item.type === "command_parameter") {
      const flag = item.text.toLowerCase()
      if (SWITCHES.has(flag)) continue
      want = FLAGS.has(flag)
      continue
    }
    out.push(item.text)
  }
  return out
}

function preview(text: string) {
  if (text.length <= MAX_METADATA_LENGTH) return text
  return "...\n\n" + text.slice(-MAX_METADATA_LENGTH)
}

const parse = Effect.fn("ShellTool.parse")(function* (command: string, ps: boolean) {
  const tree = yield* Effect.promise(() => parser().then((p) => (ps ? p.ps : p.bash).parse(command)))
  if (!tree) throw new Error("Failed to parse command")
  return tree
})

const ask = Effect.fn("ShellTool.ask")(function* (ctx: Tool.Context, scan: Scan) {
  if (scan.dirs.size > 0) {
    const globs = Array.from(scan.dirs).map((dir) => {
      if (process.platform === "win32") return AppFileSystem.normalizePathPattern(path.join(dir, "*"))
      return path.join(dir, "*")
    })
    yield* ctx.ask({
      permission: "external_directory",
      patterns: globs,
      always: globs,
      metadata: {},
    })
  }

  if (scan.patterns.size === 0) return
  yield* ctx.ask({
    permission: ShellID.ToolID,
    patterns: Array.from(scan.patterns),
    always: Array.from(scan.always),
    metadata: {},
  })
})

function cmd(shell: string, command: string, cwd: string, env: NodeJS.ProcessEnv) {
  if (process.platform === "win32" && Shell.ps(shell)) {
    return ChildProcess.make(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
      cwd,
      env,
      stdin: "ignore",
      detached: false,
    })
  }

  return ChildProcess.make(command, [], {
    shell,
    cwd,
    env,
    stdin: "ignore",
    detached: process.platform !== "win32",
  })
}
const parser = lazy(async () => {
  const { Parser } = await import("web-tree-sitter")
  const { default: treeWasm } = await import("web-tree-sitter/tree-sitter.wasm" as string, {
    with: { type: "wasm" },
  })
  const treePath = resolveWasm(treeWasm)
  await Parser.init({
    locateFile() {
      return treePath
    },
  })
  const { default: bashWasm } = await import("tree-sitter-bash/tree-sitter-bash.wasm" as string, {
    with: { type: "wasm" },
  })
  const { default: psWasm } = await import("tree-sitter-powershell/tree-sitter-powershell.wasm" as string, {
    with: { type: "wasm" },
  })
  const bashPath = resolveWasm(bashWasm)
  const psPath = resolveWasm(psWasm)
  const [bashLanguage, psLanguage] = await Promise.all([Language.load(bashPath), Language.load(psPath)])
  const bash = new Parser()
  bash.setLanguage(bashLanguage)
  const ps = new Parser()
  ps.setLanguage(psLanguage)
  return { bash, ps }
})

export const ShellTool = Tool.define(
  ShellID.ToolID,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const spawner = yield* ChildProcessSpawner
    const fs = yield* AppFileSystem.Service
    const trunc = yield* Truncate.Service
    const plugin = yield* Plugin.Service
    const background = yield* ShellBackground.Service
    const agentService = yield* Agent.Service
    const sessions = yield* Session.Service

    const cygpath = Effect.fn("ShellTool.cygpath")(function* (shell: string, text: string) {
      const lines = yield* spawner
        .lines(ChildProcess.make(shell, ["-lc", 'cygpath -w -- "$1"', "_", text]))
        .pipe(Effect.catch(() => Effect.succeed([] as string[])))
      const file = lines[0]?.trim()
      if (!file) return
      return AppFileSystem.normalizePath(file)
    })

    const resolvePath = Effect.fn("ShellTool.resolvePath")(function* (text: string, root: string, shell: string) {
      if (process.platform === "win32") {
        if (Shell.posix(shell) && text.startsWith("/") && AppFileSystem.windowsPath(text) === text) {
          const file = yield* cygpath(shell, text)
          if (file) return file
        }
        return AppFileSystem.normalizePath(path.resolve(root, AppFileSystem.windowsPath(text)))
      }
      return path.resolve(root, text)
    })

    const argPath = Effect.fn("ShellTool.argPath")(function* (arg: string, cwd: string, ps: boolean, shell: string) {
      const text = ps ? expand(arg, cwd, shell) : home(unquote(arg))
      const file = text && prefix(text)
      if (!file || dynamic(file, ps)) return
      const next = ps ? provider(file) : file
      if (!next) return
      return yield* resolvePath(next, cwd, shell)
    })

    const collect = Effect.fn("ShellTool.collect")(function* (
      root: Node,
      cwd: string,
      ps: boolean,
      shell: string,
      instance: InstanceContext,
    ) {
      const scan: Scan = {
        dirs: new Set<string>(),
        patterns: new Set<string>(),
        always: new Set<string>(),
      }
      const shellKind = ShellID.toKind(Shell.name(shell))

      for (const node of commands(root)) {
        const command = parts(node)
        const tokens = command.map((item) => item.text)
        const cmd = ps || shellKind === "cmd" ? tokens[0]?.toLowerCase() : tokens[0]

        if (cmd && (FILES.has(cmd) || (shellKind === "cmd" && CMD_FILES.has(cmd)))) {
          for (const arg of pathArgs(command, ps, shellKind === "cmd")) {
            const resolved = yield* argPath(arg, cwd, ps, shell)
            log.info("resolved path", { arg, resolved })
            if (!resolved || containsPath(resolved, instance)) continue
            const dir = (yield* fs.isDir(resolved)) ? resolved : path.dirname(resolved)
            scan.dirs.add(dir)
          }
        }

        if (tokens.length && (!cmd || !CWD.has(cmd))) {
          scan.patterns.add(source(node))
          scan.always.add(BashArity.prefix(tokens).join(" ") + " *")
        }
      }

      return scan
    })

    const shellEnv = Effect.fn("ShellTool.shellEnv")(function* (ctx: Tool.Context, cwd: string) {
      const extra = yield* plugin.trigger(
        "shell.env",
        { cwd, sessionID: ctx.sessionID, callID: ctx.callID },
        { env: {} },
      )
      return withWindowsUtf8ShellEnv({
        ...process.env,
        ...extra.env,
      })
    })

    const run = Effect.fn("ShellTool.run")(function* (
      input: {
        shell: string
        command: string
        cwd: string
        env: NodeJS.ProcessEnv
        timeout: number
        description: string
        backgroundMode: boolean
        // 执行前的文件基线,透传给后台 entry 供补扫产出 unlink。
        baseline?: ReadonlySet<string>
      },
      ctx: Tool.Context,
    ) {
      const spec = cmd(input.shell, input.command, input.cwd, input.env)

      yield* ctx.metadata({ metadata: { output: "", description: input.description } })

      // #C run() 内多处"拒绝/未转后台"早返回共用同一结果形状(title + rejected 元数据 + 文案)
      const rejectedResult = (output: string) => ({
        title: input.description,
        metadata: { description: input.description, processStatus: "rejected" as const, truncated: false },
        output,
      })
      // #C 后台进程数达上限的统一文案(register 原子拒绝 + 显式后台 detach 防御性 cap-rejected 共用)
      const capMessage = `Background process limit (${MAX_PER_SESSION}) reached for this session. Stop some background commands with kill-shell before starting a new one.`

      // #2/#3 canMonitor:agent/session 同时未 deny bash-output 与 kill-shell 才可监控/停止后台进程。
      // 惰性计算并缓存(合并 session+agent 权限),仅在两条后台路径真正触发时算一次,
      // 避免在普通前台命令热路径上多做一次 session DB 读取。
      let monitorCache: boolean | undefined
      const canMonitor = Effect.fnUntraced(function* () {
        if (monitorCache !== undefined) return monitorCache
        // agent.get 与 session.get 无依赖,可并行
        const [agentInfo, sessionInfo] = yield* Effect.all(
          [agentService.get(ctx.agent), sessions.get(ctx.sessionID).pipe(Effect.orElseSucceed(() => undefined))],
          { concurrency: "unbounded" },
        )
        const merged = Permission.merge(agentInfo?.permission ?? [], sessionInfo?.permission ?? [])
        monitorCache =
          Permission.evaluate("bash-output", "*", merged).action !== "deny" &&
          Permission.evaluate("kill-shell", "*", merged).action !== "deny"
        return monitorCache
      })

      // #2 显式后台:无监控能力则不转后台,直接提示(不 register)
      if (input.backgroundMode && !(yield* canMonitor())) {
        return rejectedResult(
          "Cannot run in background: this agent/session does not have bash-output and kill-shell enabled, so the background command cannot be monitored or stopped. Remove run_in_background, or enable these tools.",
        )
      }

      let liveOutput = ""
      const onChunk = input.backgroundMode
        ? undefined
        : (text: string) => {
            liveOutput = preview(liveOutput + text)
            return ctx.metadata({ metadata: { output: liveOutput, description: input.description } })
          }

      // #5 上限在 register 内与注册原子判定(仅后台);前台永不受限
      const reg = yield* background.register({
        sessionID: ctx.sessionID,
        command: input.command,
        description: input.description,
        background: input.backgroundMode,
        cwd: input.cwd,
        baseline: input.baseline,
        spec,
        onChunk,
      })
      if (reg.rejected) {
        return rejectedResult(capMessage)
      }
      const { id, exit } = reg

      // #B1 完成(非转后台)路径统一的输出/元数据组装:截断走 Truncate.output(tail 方向),
      // 流式已溢出则复用该文件路径,否则按内存输出截断;落盘失败(sinkError)仅作警告附加,绝不丢输出。
      // background 传入时额外标后台元数据(超时转后台仍把已产出的快照 inline 给模型)。
      const inlineResult = Effect.fnUntraced(function* (
        snap: {
          output: string
          exitCode: number | null
          truncated: boolean
          outputPath?: string
          sinkError?: string
        },
        metaLines: string[],
        backgrounded?: { id: string },
      ) {
        const agentInfo = yield* agentService.get(ctx.agent)
        // #A2 backgrounded(超时转后台仍在运行):完整输出仍在落盘,只裁剪内存尾部预览(previewOnly),
        // 不复用 existingPath、不打 "Full output saved to file";完整输出由模型经 bash-output 后续获取。
        // 其余(已结束:exit / abort / stopped / already-exited)才走 existingPath 截断并指向完整文件。
        const capped = yield* trunc.output(
          snap.output || "(no output)",
          backgrounded ? { direction: "tail", previewOnly: true } : { direction: "tail", existingPath: snap.outputPath },
          agentInfo,
        )
        let output = capped.content
        if (snap.sinkError) output += `\n\n${ShellBackground.sinkWarning(snap.sinkError)}`
        if (metaLines.length > 0) output += "\n\n<shell_metadata>\n" + metaLines.join("\n") + "\n</shell_metadata>"
        return {
          title: input.description,
          metadata: {
            output: preview(snap.output),
            exit: snap.exitCode,
            description: input.description,
            ...ShellBackground.truncatedMeta(capped),
            ...(backgrounded
              ? { background: true, backgroundId: backgrounded.id, processStatus: "running" as const }
              : {}),
          } satisfies ShellBackgroundMeta,
          output,
        }
      })

      if (input.backgroundMode) {
        // #A4 显式后台按 detach 三态分别处理,不再硬编码 processStatus:"running"
        const detached = yield* background.detach(id)
        if (detached === "cap-rejected") {
          // register 已原子判过 cap,理论不可达;防御性 kill 进程后清理条目,绝不留孤儿
          yield* background.kill(id, ctx.sessionID)
          yield* background.awaitFlush(id)
          yield* background.finalize(id)
          return rejectedResult(capMessage)
        }
        if (detached === "already-exited") {
          // 转后台前命令已瞬间完成:读最终输出 inline 上报,finalize 删除条目(retain=false),不给后台 id
          yield* background.awaitFlush(id)
          const snap = yield* background.snapshot(id)
          yield* background.finalize(id)
          if (snap.failure) throw new Error(`Command failed to start: ${snap.failure}`)
          return yield* inlineResult(snap, [
            `Command completed immediately (exit ${snap.exitCode}); not moved to background.`,
          ])
        }
        // detached === "detached":真正转后台
        return {
          title: input.description,
          metadata: {
            output: "",
            description: input.description,
            background: true,
            backgroundId: id,
            processStatus: "running" as const,
            truncated: false,
          } satisfies ShellBackgroundMeta,
          output: `Command started in the background (${id}). Use bash-output(id="${id}") to view progress, kill-shell(id="${id}") to stop.`,
        }
      }

      const timeoutRace = Effect.sleep(`${input.timeout + 100} millis`).pipe(Effect.as("timeout" as const))
      // 手搓 AbortSignal→Effect 桥:这里需要 abort 作为 race 的一个分支"获胜并返回 'abort' 信号",
      // 之后再 kill+flush 保留输出。util/abort 的 raceAbort 语义不契合——它会让 effect 以 AbortError 失败、
      // 中断进而跳过保留输出的逻辑;故保留手写桥,不复用 raceAbort。
      const abort = Effect.callback<"abort">((resume) => {
        if (ctx.abort.aborted) return resume(Effect.succeed("abort" as const))
        const handler = () => resume(Effect.succeed("abort" as const))
        ctx.abort.addEventListener("abort", handler, { once: true })
        return Effect.sync(() => ctx.abort.removeEventListener("abort", handler))
      })
      const waitExit = Deferred.await(exit).pipe(Effect.as("exit" as const))

      const outcome = yield* Effect.raceAll([waitExit, timeoutRace, abort])

      // 在 snapshot 之前完成所有需要 kill/detach 的动作并 flush,得到本次结局 disposition。
      // #4 凡是要把 outputPath 交给模型的路径(含两条 timeout-kill)都在此 awaitFlush,保证文件写完整;
      // 仅"真正转后台"(timeout-detached)不 flush——进程仍在跑,文件还会继续写。
      const prepare = Effect.fnUntraced(function* () {
        if (outcome === "abort") {
          yield* background.kill(id, ctx.sessionID) // 先 kill 让进程退出并排空
          yield* background.awaitFlush(id)
          return { kind: "abort" as const }
        }
        if (outcome === "exit") {
          yield* background.awaitFlush(id)
          return { kind: "exit" as const }
        }
        // outcome === "timeout"
        // #2/#3 当前 agent/session 须能监控(bash-output + kill-shell)才允许转后台;否则 kill 不转后台
        if (!(yield* canMonitor())) {
          yield* background.kill(id, ctx.sessionID)
          yield* background.awaitFlush(id)
          return {
            kind: "stopped" as const,
            // #B1 补"增大 timeout"行动指引,避免模型原样重试导致死循环(与 cap-rejected 分支一致)
            reason: `Command timed out after ${input.timeout} ms; this agent cannot monitor background commands, stopped. If the command needs more time, you can retry with a larger timeout value in milliseconds.`,
          }
        }
        // #5/#3 detach 原子判上限并识别"已退出";返回三态
        const detached = yield* background.detach(id)
        // #3 超时赢得 race 到 detach 之间进程已退出:当作正常完成,不报后台
        if (detached === "already-exited") {
          yield* background.awaitFlush(id)
          return { kind: "exit" as const }
        }
        if (detached === "cap-rejected") {
          yield* background.kill(id, ctx.sessionID)
          yield* background.awaitFlush(id)
          return {
            kind: "stopped" as const,
            reason: `Command timed out after ${input.timeout} ms; background process limit (${MAX_PER_SESSION}) reached, stopped. Free slots with kill-shell, or increase the timeout.`,
          }
        }
        // detached === "detached":真正转后台
        return { kind: "detached" as const }
      })
      const disposition = yield* prepare()

      const snap = yield* background.snapshot(id)
      // 转后台条目保留给 bash-output;其余(abort/exit/stopped)从 map 移除。
      // #A3 already-exited 转 exit 时 retain=false,finalize 真正删除条目(不再幽灵滞留)
      if (disposition.kind !== "detached") yield* background.finalize(id)
      // #A1 前台正常退出 spawn 失败(spawnFailure):不能当成"成功跑完无输出"掩盖错误
      if (disposition.kind === "exit" && snap.failure) throw new Error(`Command failed to start: ${snap.failure}`)

      const metaLines =
        disposition.kind === "abort"
          ? ["User aborted the command"]
          : disposition.kind === "stopped"
            ? [disposition.reason]
            : disposition.kind === "detached"
              ? [
                  `Command exceeded the ${input.timeout} ms timeout and is still running; moved to background (${id}). Use bash-output(id="${id}") to view progress, kill-shell(id="${id}") to stop.`,
                ]
              : []

      // #B1 截断/横幅统一回归 Truncate.output;仅"真正转后台"额外标 background 元数据
      return yield* inlineResult(snap, metaLines, disposition.kind === "detached" ? { id } : undefined)
    })

    return () =>
      Effect.gen(function* () {
        const cfg = yield* config.get()
        const shell = Shell.acceptable(cfg.shell)
        const name = Shell.name(shell)
        const limits = yield* trunc.limits()
        const prompt = ShellPrompt.render(name, process.platform, limits)
        log.info("shell tool using shell", { shell })

        return {
          description: prompt.description,
          parameters: prompt.parameters,
          execute: (params: Parameters, ctx: Tool.Context) =>
            Effect.gen(function* () {
              const executeInstance = yield* InstanceState.context
              const cwd = params.workdir
                ? yield* resolvePath(params.workdir, executeInstance.directory, shell)
                : executeInstance.directory
              if (params.timeout !== undefined && params.timeout < 0) {
                throw new Error(`Invalid timeout value: ${params.timeout}. Timeout must be a positive number.`)
              }
              const timeout = params.timeout ?? DEFAULT_TIMEOUT
              const ps = Shell.ps(shell)
              yield* Effect.scoped(
                Effect.gen(function* () {
                  const tree = yield* Effect.acquireRelease(parse(params.command, ps), (tree) =>
                    Effect.sync(() => tree.delete()),
                  )
                  const scan = yield* collect(tree.rootNode, cwd, ps, shell, executeInstance)
                  if (!containsPath(cwd, executeInstance)) scan.dirs.add(cwd)
                  yield* ask(ctx, scan)
                }),
              )

              // 在 run() 外层收集执行期间的真实文件变更事件。放在这里而不是 run() 内部,
              // 是因为 run() 有 5 个 return 出口(exit/abort/stopped/detached/already-exited),
              // 逐个插入既易漏又会重复;execute 层一次包裹可保证每次调用恰好收集一次。
              return yield* Effect.scoped(
                Effect.gen(function* () {
                  // 减 1s 容差:部分文件系统 mtime 粒度为秒,命令在同一秒内写入时
                  // mtime 可能略早于 startedAt,不留容差会漏掉刚生成的文件。
                  const since = (yield* Clock.currentTimeMillis) - ShellFiles.MTIME_GRANULARITY_MS
                  // 执行前的基线快照(只读目录项、不 stat),用于在执行后识别被删除的文件。
                  // 没有它就没有 unlink 信号:mtime 扫描只能看见"还在的文件",
                  // 而输出区跨轮累积,shell 删掉的旧产物会永久留一行点不开的残留。
                  const before = yield* ShellFiles.snapshotFiles(fs, cwd)
                  const result = (yield* run(
                    {
                      shell,
                      command: params.command,
                      cwd,
                      env: yield* shellEnv(ctx, cwd),
                      timeout,
                      description: params.description,
                      backgroundMode: params.run_in_background === true,
                      baseline: before,
                    },
                    ctx,
                  )) as Tool.ExecuteResult
                  // 命令结束后立即扫描,不需要任何等待窗口:mtime 在 write 返回时就已落盘。
                  // 注意后台/超时转后台时进程仍在运行,这里只能看到 detach 之前的产物;
                  // 其余产物由 bash-output / kill-shell 在进程退出后补扫(claimFileScan)。
                  const files = yield* ShellFiles.scanChangedFiles(fs, cwd, since, before)
                  if (files.length === 0) return result
                  return { ...result, metadata: { ...result.metadata, files } }
                }),
              )
            }),
        }
      })
  }),
)
