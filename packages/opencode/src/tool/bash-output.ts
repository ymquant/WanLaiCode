import { Effect, Exit, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./bash-output.txt"
import { ShellBackground, type ShellBackgroundMeta } from "./shell/background"
import { ShellFiles } from "./shell/files"
import * as Truncate from "./truncate"
import { Agent } from "@/agent/agent"
import { AppFileSystem } from "@opencode-ai/core/filesystem"

const Parameters = Schema.Struct({
  id: Schema.String.annotate({ description: "后台 shell 的 id(形如 bash_1)" }),
  filter: Schema.optional(Schema.String).annotate({
    description: "可选过滤字符串,仅返回包含该字符串的输出行(字面量匹配,不支持正则)",
  }),
})

export const BashOutputTool = Tool.define(
  "bash-output",
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
          // #1 传入 sessionID,read 内部校验会话归属,防止跨会话越权读取
          const res = yield* background.read(params.id, ctx.sessionID, { filter: params.filter })

          // id 不存在(已清理或输入有误)
          if (!res.found) {
            return ShellBackground.notFoundResult(params.id, "it may have been cleaned up, or the id is wrong")
          }

          // #B1 增量输出统一过 Truncate.output(tail 方向):与前台同一上限/hint,杜绝单次灌爆 context。
          // 本次读取丢过内存字节(res.truncated)时,完整输出已在 res.outputPath,复用该路径不再另写文件。
          const agentInfo = yield* agentService.get(ctx.agent)
          const capped = yield* trunc.output(
            res.chunk || "(no new output since last read)",
            { direction: "tail", existingPath: res.truncated ? res.outputPath : undefined },
            agentInfo,
          )

          // #A1 spawn/drain 失败(failure)透出真实失败信息,避免模型误以为"成功跑完无输出"
          const failureNote = res.failure ? `\n\n[command failed: ${res.failure}]` : ""
          // #A1 落盘失败(sinkError)是警告而非失败:输出可能不完整,但不丢弃已读到的内容
          const sinkNote = res.sinkError ? `\n\n${ShellBackground.sinkWarning(res.sinkError)}` : ""
          // 进程状态行
          const statusLine =
            res.status === "exited" ? `\n\n[process exited with code ${res.exitCode}]` : "\n\n[process still running]"

          // 进程已退出时补扫产物:前台那次扫描发生在 detach 之前,看不到后台进程之后写的文件
          // (例如 `sleep 5 && python gen.py report.xlsx`)。claim-once 保证反复 bash-output 只扫一次。
          //
          // 传入 scan.baseline(执行前快照)使补扫也能产出 unlink:后台命令
          // `sleep 2; rm report.xlsx` 删掉的是前面轮次已收录的产物,没有基线就没有删除信号,
          // 输出区会永久留一行点不开的残留。
          //
          // claim 与 complete/release 必须配对:扫描若被中止/取消,状态退回 idle 允许后续重试,
          // 否则本次没提交 files、后续又因已领取而永不重扫,产物永久漏报。
          const scan = yield* background.claimFileScan(params.id, ctx.sessionID)
          const files = scan
            ? yield* ShellFiles.scanChangedFiles(
                fs,
                scan.cwd,
                scan.since - ShellFiles.MTIME_GRANULARITY_MS,
                scan.baseline,
              ).pipe(
                // 用 Exit.isSuccess 而非比较 _tag 字面量:tag 名写错不会有类型错误,
                // 只会让 complete 永不执行、条目永久停在 in-flight(测试也难以察觉)。
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
              processStatus: res.status,
              exit: res.exitCode,
              ...ShellBackground.truncatedMeta(capped),
              ...(files.length > 0 ? { files } : {}),
            },
            output: capped.content + failureNote + sinkNote + statusLine,
          }
        }),
    }
  }),
)

export * as BashOutput from "./bash-output"
