import { Effect, Exit, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./kill-shell.txt"
import { ShellBackground, type ShellBackgroundMeta } from "./shell/background"
import { ShellFiles } from "./shell/files"
import * as Truncate from "./truncate"
import { Agent } from "@/agent/agent"
import { AppFileSystem } from "@opencode-ai/core/filesystem"

const Parameters = Schema.Struct({
  id: Schema.String.annotate({ description: "要停止的后台 shell 的 id(形如 bash_1)" }),
})

export const KillShellTool = Tool.define(
  "kill-shell",
  Effect.gen(function* () {
    const background = yield* ShellBackground.Service
    const trunc = yield* Truncate.Service
    const agentService = yield* Agent.Service
    // 在工具定义作用域解析一次:execute 声明 Effect<..., never, never>,
    // 不能在其内部 yield 服务(会把依赖漏进 requirement 通道)。
    const fs = yield* AppFileSystem.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (
        params: Schema.Schema.Type<typeof Parameters>,
        ctx: Tool.Context,
      ): Effect.Effect<Tool.ExecuteResult<ShellBackgroundMeta>> =>
        Effect.gen(function* () {
          // #1 传入 sessionID,kill 内部校验会话归属,防止跨会话越权 kill
          const res = yield* background.kill(params.id, ctx.sessionID)
          if (!res.found) {
            return ShellBackground.notFoundResult(params.id, "it may have already exited, or the id is wrong")
          }

          // #B1/#B2 尾部输出过 Truncate.output(tail 方向),统一上限/hint;
          // 进程曾溢出(res.truncated)时完整输出已在 res.outputPath,复用该路径不再另写文件
          const agentInfo = yield* agentService.get(ctx.agent)
          const capped = res.tail
            ? yield* trunc.output(
                res.tail,
                { direction: "tail", existingPath: res.truncated ? res.outputPath : undefined },
                agentInfo,
              )
            : undefined

          // wasRunning:进程是否被本次 kill 主动停止;false 表示已自然退出,未发任何信号
          const stoppedMsg = res.wasRunning
            ? `Stopped background process ${params.id}.`
            : `Background process ${params.id} had already exited (not killed).`
          const output = capped ? `${stoppedMsg}\n\n${capped.content}` : stoppedMsg
          // kill() 内部已 await exit + flush,此处进程必定已退出,可以安全补扫产物。
          // 被 kill 掉的后台命令也可能已经写出文件(例如中途生成了部分报表),不能因为它是
          // 被停止的就跳过——判据始终是文件系统状态,不是命令的结局。
          // 同 bash-output:传 baseline 才能产出 unlink(被 kill 前命令可能已删掉旧产物),
          // 且 claim 必须与 complete/release 配对,否则中止的扫描会永久堵住重试。
          const scan = yield* background.claimFileScan(params.id, ctx.sessionID)
          const files = scan
            ? yield* ShellFiles.scanChangedFiles(
                fs,
                scan.cwd,
                scan.since - ShellFiles.MTIME_GRANULARITY_MS,
                scan.baseline,
              ).pipe(
                // 同 bash-output:用 Exit.isSuccess 而非 _tag 字面量,避免写错 tag 名却无类型错误。
                Effect.onExit((exit) =>
                  Exit.isSuccess(exit)
                    ? background.completeFileScan(params.id)
                    : background.releaseFileScan(params.id),
                ),
              )
            : []
          return {
            title: params.id,
            metadata: {
              backgroundId: params.id,
              processStatus: "exited" as const,
              exit: res.exitCode,
              ...ShellBackground.truncatedMeta(capped),
              ...(files.length > 0 ? { files } : {}),
            },
            output,
          }
        }),
    }
  }),
)

export * as KillShell from "./kill-shell"
