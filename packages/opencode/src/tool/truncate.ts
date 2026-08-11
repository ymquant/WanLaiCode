import { NodePath } from "@effect/platform-node"
import { Cause, Duration, Effect, Layer, Option, Schedule, Context } from "effect"
import path from "path"
import type { Agent } from "../agent/agent"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { evaluate } from "@/permission/evaluate"
import { Config } from "@/config/config"
import { Identifier } from "../id/id"
import * as Log from "@opencode-ai/core/util/log"
import { ToolID } from "./schema"
import { TRUNCATION_DIR } from "./truncation-dir"

const log = Log.create({ service: "truncation" })
const RETENTION = Duration.days(7)

export const MAX_LINES = 2000
export const MAX_BYTES = 50 * 1024
export const DIR = TRUNCATION_DIR
export const GLOB = path.join(TRUNCATION_DIR, "*")

export type Result = { content: string; truncated: false } | { content: string; truncated: true; outputPath: string }

export interface Options {
  maxLines?: number
  maxBytes?: number
  direction?: "head" | "tail"
  /**
   * 调用方已把完整输出落到此文件时传入(如 shell 流式溢出已写盘):
   * 截断预览时复用该路径、不再另写文件,且始终视为已截断(完整输出在该文件里)。
   */
  existingPath?: string
  /**
   * 仅预览模式:进程仍在后台运行,完整输出尚不可用(还在落盘)。
   * 此时只按上限裁剪内存尾部预览,不写文件、不复用 existingPath、不输出 "saved to file" 提示
   * (完整输出由调用方经 bash-output 后续获取);返回 truncated 恒为 false(无文件可指向)。
   */
  previewOnly?: boolean
}

function hasTaskTool(agent?: Agent.Info) {
  if (!agent?.permission) return false
  return evaluate("task", "*", agent.permission).action !== "deny"
}

export interface Interface {
  readonly cleanup: () => Effect.Effect<void>
  readonly write: (text: string) => Effect.Effect<string>
  /**
   * Returns output unchanged when it fits within the limits, otherwise writes the full text
   * to the truncation directory and returns a preview plus a hint to inspect the saved file.
   */
  readonly output: (text: string, options?: Options, agent?: Agent.Info) => Effect.Effect<Result>
  /**
   * Resolved truncation limits: values from `tool_output` in opencode config, or MAX_LINES / MAX_BYTES if unset.
   */
  readonly limits: () => Effect.Effect<{ maxLines: number; maxBytes: number }>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Truncate") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service

    const cleanup = Effect.fn("Truncate.cleanup")(function* () {
      const cutoff = Identifier.timestamp(
        Identifier.create("tool", "ascending", Date.now() - Duration.toMillis(RETENTION)),
      )
      const entries = yield* fs.readDirectory(TRUNCATION_DIR).pipe(
        Effect.map((all) => all.filter((name) => name.startsWith("tool_"))),
        Effect.catch(() => Effect.succeed([])),
      )
      for (const entry of entries) {
        if (Identifier.timestamp(entry) >= cutoff) continue
        yield* fs.remove(path.join(TRUNCATION_DIR, entry)).pipe(Effect.catch(() => Effect.void))
      }
    })

    const write = Effect.fn("Truncate.write")(function* (text: string) {
      const file = path.join(TRUNCATION_DIR, ToolID.ascending())
      yield* fs.ensureDir(TRUNCATION_DIR).pipe(Effect.orDie)
      yield* fs.writeFileString(file, text).pipe(Effect.orDie)
      return file
    })

    const limits = Effect.fn("Truncate.limits")(function* () {
      const configSvc = yield* Effect.serviceOption(Config.Service)
      if (Option.isNone(configSvc)) return { maxLines: MAX_LINES, maxBytes: MAX_BYTES }
      const cfg = yield* configSvc.value.get().pipe(Effect.catch(() => Effect.succeed(undefined)))
      return {
        maxLines: cfg?.tool_output?.max_lines ?? MAX_LINES,
        maxBytes: cfg?.tool_output?.max_bytes ?? MAX_BYTES,
      }
    })

    const output = Effect.fn("Truncate.output")(function* (text: string, options: Options = {}, agent?: Agent.Info) {
      const resolved = yield* limits()
      const maxLines = options.maxLines ?? resolved.maxLines
      const maxBytes = options.maxBytes ?? resolved.maxBytes
      const direction = options.direction ?? "head"
      const lines = text.split("\n")
      const totalBytes = Buffer.byteLength(text, "utf-8")

      // 既无既有溢出文件、又未超限:原样返回(不截断、不写文件)
      if (!options.existingPath && lines.length <= maxLines && totalBytes <= maxBytes) {
        return { content: text, truncated: false } as const
      }

      const out: string[] = []
      let i = 0
      let bytes = 0
      let hitBytes = false

      if (direction === "head") {
        for (i = 0; i < lines.length && i < maxLines; i++) {
          const size = Buffer.byteLength(lines[i], "utf-8") + (i > 0 ? 1 : 0)
          if (bytes + size > maxBytes) {
            hitBytes = true
            break
          }
          out.push(lines[i])
          bytes += size
        }
      } else {
        for (i = lines.length - 1; i >= 0 && out.length < maxLines; i--) {
          const size = Buffer.byteLength(lines[i], "utf-8") + (out.length > 0 ? 1 : 0)
          if (bytes + size > maxBytes) {
            // 单行 salvage:累计行后预览仍为空且当前(尾)行本身超过字节上限,
            // 整行丢弃会让 tail 预览为空(漏掉最后一行所有内容);改为保留该行最后 maxBytes 字节,
            // 并做 UTF-8 边界修正(跳过开头的续字节 0x80..0xBF),避免切坏多字节字符。
            if (out.length === 0) {
              const buf = Buffer.from(lines[i], "utf-8")
              let start = Math.max(0, buf.length - maxBytes)
              while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++
              out.unshift(buf.subarray(start).toString("utf-8"))
              bytes += buf.length - start
            }
            hitBytes = true
            break
          }
          out.unshift(lines[i])
          bytes += size
        }
      }

      const preview = out.join("\n")
      // 本次预览是否真的丢了内容:超字节上限,或行数被砍。仅当确有丢失才显示 "...N truncated..." 横幅;
      // existingPath 复用且预览未丢内容(完整尾部已展示)时省略横幅,避免 "...0 lines truncated..." 误导
      const cut = hitBytes || out.length < lines.length
      const removed = hitBytes ? totalBytes - bytes : lines.length - out.length
      const unit = hitBytes ? "bytes" : "lines"
      const banner = cut ? `...${removed} ${unit} truncated...\n\n` : ""

      // previewOnly:进程仍在后台运行,完整输出尚未写完;只给裁剪后的尾部预览 + 截断横幅,
      // 不写文件、不复用 existingPath、不输出 "saved to file" 提示;truncated 恒为 false(无文件可指向)。
      if (options.previewOnly) {
        return {
          content: direction === "head" ? `${preview}\n\n${banner}`.trimEnd() : `${banner}${preview}`,
          truncated: false,
        } as const
      }

      // 复用既有完整溢出文件(existingPath),否则新写一份完整文本
      const file = options.existingPath ?? (yield* write(text))

      const hint = hasTaskTool(agent)
        ? `The tool call succeeded but the output was truncated. Full output saved to: ${file}\nUse the Task tool to have explore agent process this file with Grep and Read (with offset/limit). Do NOT read the full file yourself - delegate to save context.`
        : `The tool call succeeded but the output was truncated. Full output saved to: ${file}\nUse Grep to search the full content or Read with offset/limit to view specific sections.`

      return {
        content:
          direction === "head" ? `${preview}\n\n${banner}${hint}` : `${banner}${hint}\n\n${preview}`,
        truncated: true,
        outputPath: file,
      } as const
    })

    yield* cleanup().pipe(
      Effect.catchCause((cause) => {
        log.error("truncation cleanup failed", { cause: Cause.pretty(cause) })
        return Effect.void
      }),
      Effect.repeat(Schedule.spaced(Duration.hours(1))),
      Effect.delay(Duration.minutes(1)),
      Effect.forkScoped,
    )

    return Service.of({ cleanup, write, output, limits })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(AppFileSystem.defaultLayer), Layer.provide(NodePath.layer))

export * as Truncate from "./truncate"
