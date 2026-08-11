import { describe, expect, test } from "bun:test"
import { Effect, Layer, ManagedRuntime } from "effect"
import { BashOutputTool } from "../../src/tool/bash-output"
import { ShellTool } from "../../src/tool/shell"
import { WithInstance } from "../../src/project/with-instance"
import { SessionID, MessageID } from "../../src/session/schema"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Plugin } from "../../src/plugin"
import { Truncate } from "@/tool/truncate"
import { Config } from "@/config/config"
import { Agent } from "../../src/agent/agent"
import { Session } from "../../src/session/session"
import { ShellBackground } from "../../src/tool/shell/background"
import path from "path"

// 共享 runtime,确保 bash 与 bash-output 拿到同一个 ShellBackground 实例
const runtime = ManagedRuntime.make(
  Layer.mergeAll(
    CrossSpawnSpawner.defaultLayer,
    AppFileSystem.defaultLayer,
    Plugin.defaultLayer,
    Truncate.defaultLayer,
    Config.defaultLayer,
    Agent.defaultLayer,
    Session.defaultLayer,
    ShellBackground.defaultLayer,
  ),
)

const projectRoot = path.join(__dirname, "../..")

const ctx = {
  sessionID: SessionID.make("ses_bo"),
  messageID: MessageID.make(""),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

describe("tool.bash-output", () => {
  test("reads output of a backgrounded command", async () => {
    if (process.platform === "win32") return // PowerShell 输出不会在 500ms 内 flush,与 shell-background 同类跨平台限制
    await WithInstance.provide({
      directory: projectRoot,
      fn: async () => {
        // 在同一 WithInstance + 同一 runtime 下 init 两个工具,共享 ShellBackground 状态
        const bash = await runtime.runPromise(ShellTool.pipe(Effect.flatMap((i) => i.init())))
        const bashOutput = await runtime.runPromise(BashOutputTool.pipe(Effect.flatMap((i) => i.init())))

        const started = await Effect.runPromise(
          bash.execute(
            {
              command:
                process.platform === "win32"
                  ? "Write-Output bg-line; Start-Sleep -Seconds 5"
                  : "echo bg-line; sleep 5",
              description: "bg with output",
              run_in_background: true,
            },
            ctx,
          ),
        )

        const id = String(started.metadata.backgroundId)
        // 给进程一点时间产出首行
        await new Promise((r) => setTimeout(r, 500))

        const out = await Effect.runPromise(bashOutput.execute({ id }, ctx))
        expect(out.output).toContain("bg-line")
        expect(out.metadata.processStatus).toBe("running")
      },
    })
  }, 15_000)

  test("returns not-found message for unknown id", async () => {
    await WithInstance.provide({
      directory: projectRoot,
      fn: async () => {
        const bashOutput = await runtime.runPromise(BashOutputTool.pipe(Effect.flatMap((i) => i.init())))
        const out = await Effect.runPromise(bashOutput.execute({ id: "bash_99999" }, ctx))
        // found:false 路径:应包含 id 且 processStatus 为 "exited"
        expect(out.output).toContain("bash_99999")
        expect(out.metadata.processStatus).toBe("exited")
      },
    })
  })

  // #B1:读路径(bash-output)超过 maxLines 上限时,统一走 Truncate.output 截断到文件,
  // 不再绕过上限一次性灌爆 context;metadata 带出 truncated + outputPath
  test.skipIf(process.platform === "win32")("bash-output caps output exceeding maxLines and writes a file", async () => {
    await WithInstance.provide({
      directory: projectRoot,
      fn: async () => {
        const bash = await runtime.runPromise(ShellTool.pipe(Effect.flatMap((i) => i.init())))
        const bashOutput = await runtime.runPromise(BashOutputTool.pipe(Effect.flatMap((i) => i.init())))
        const id2 = SessionID.make("ses_bo_trunc")
        const bigCtx = { ...ctx, sessionID: id2 }
        const lineCount = 2500 // > Truncate.MAX_LINES(2000)
        // 先快速产出大量行,再 sleep 保活,确保 detach 时仍在运行 → 拿到后台 id
        const started = await Effect.runPromise(
          bash.execute(
            { command: `seq ${lineCount}; sleep 2`, description: "many lines then sleep", run_in_background: true },
            bigCtx,
          ),
        )
        const id = String(started.metadata.backgroundId)
        expect(id).toMatch(/^bash_\d+$/)
        // 给进程时间把所有行产出
        await new Promise((r) => setTimeout(r, 600))
        const out = await Effect.runPromise(bashOutput.execute({ id }, bigCtx))
        // 截断生效:输出含标准 hint + 文件路径,metadata 标 truncated 且带 outputPath
        expect(out.metadata.truncated).toBe(true)
        expect(out.metadata.outputPath).toBeTruthy()
        expect(out.output).toMatch(/Full output saved to:\s+\S+/)
        // 截断后内存里返回的行数远小于 lineCount(没有一次性灌爆)
        const newlineCount = (out.output.match(/\n/g) || []).length
        expect(newlineCount).toBeLessThan(lineCount)
      },
    })
  }, 15_000)
})
