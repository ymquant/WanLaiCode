import { describe, expect, test } from "bun:test"
import { Effect, Layer, ManagedRuntime } from "effect"
import { KillShellTool } from "../../src/tool/kill-shell"
import { ShellTool } from "../../src/tool/shell"
import { BashOutputTool } from "../../src/tool/bash-output"
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
import { tmpdir } from "../fixture/fixture"
import fs from "fs/promises"
import path from "path"

// 共享 runtime,确保 bash、kill-shell、bash-output 拿到同一个 ShellBackground 实例
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
  sessionID: SessionID.make("ses_kill"),
  messageID: MessageID.make(""),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

describe("tool.kill-shell", () => {
  test("kills a background command and returns tail output", async () => {
    await WithInstance.provide({
      directory: projectRoot,
      fn: async () => {
        // 在同一 WithInstance + 同一 runtime 下 init 三个工具,共享 ShellBackground 状态
        const bash = await runtime.runPromise(ShellTool.pipe(Effect.flatMap((i) => i.init())))
        const kill = await runtime.runPromise(KillShellTool.pipe(Effect.flatMap((i) => i.init())))
        const bashOutput = await runtime.runPromise(BashOutputTool.pipe(Effect.flatMap((i) => i.init())))

        // 先输出再长 sleep,以便 kill 时 tail 有内容可返回
        const started = await Effect.runPromise(
          bash.execute(
            {
              command:
                process.platform === "win32"
                  ? "Start-Sleep -Milliseconds 750; Write-Output killing-tail; Start-Sleep -Seconds 30"
                  : "sleep 0.75; echo killing-tail; sleep 30",
              description: "long sleep with output",
              run_in_background: true,
            },
            ctx,
          ),
        )

        const id = String(started.metadata.backgroundId)

        await Effect.runPromise(
          Effect.gen(function* () {
            while (true) {
              const out = yield* bashOutput.execute({ id }, ctx)
              if (out.output.includes("killing-tail")) return
              yield* Effect.sleep(50)
            }
          }).pipe(Effect.timeout("15 seconds")),
        )

        const killed = await Effect.runPromise(kill.execute({ id }, ctx))
        // kill 结果应包含 id
        expect(killed.output).toContain(id)
        // kill 结果应包含命令产出的尾部输出
        expect(killed.output).toContain("killing-tail")
        expect(killed.metadata.processStatus).toBe("exited")

        // bash-output 验证进程已退出
        const out = await Effect.runPromise(bashOutput.execute({ id }, ctx))
        expect(out.metadata.processStatus).toBe("exited")
      },
    })
  }, 30_000)

  // #A3 kill 等进程真正退出 + flush,收齐进程收到 SIGTERM 后的优雅退出输出(不再只返回 SIGTERM 时刻的尾部)
  test.skipIf(process.platform === "win32")("kill captures output emitted after SIGTERM (graceful exit)", async () => {
    await WithInstance.provide({
      directory: projectRoot,
      fn: async () => {
        const bash = await runtime.runPromise(ShellTool.pipe(Effect.flatMap((i) => i.init())))
        const kill = await runtime.runPromise(KillShellTool.pipe(Effect.flatMap((i) => i.init())))
        const termCtx = { ...ctx, sessionID: SessionID.make("ses_kill_term") }
        // 收到 TERM 后先打印 marker 再退出;否则空转。kill 必须等到这行优雅退出输出
        const started = await Effect.runPromise(
          bash.execute(
            {
              command: "trap 'echo TERM_MARKER; exit 0' TERM; echo STARTED; while true; do sleep 0.2; done",
              description: "trap term then exit",
              run_in_background: true,
            },
            termCtx,
          ),
        )
        const id = String(started.metadata.backgroundId)
        // 等 STARTED 先产出,确保进程已进入循环
        await new Promise((r) => setTimeout(r, 400))
        const killed = await Effect.runPromise(kill.execute({ id }, termCtx))
        // #A3:kill 返回的输出包含 SIGTERM 之后的优雅退出行,且此刻 status 名副其实为 exited
        expect(killed.output).toContain("TERM_MARKER")
        expect(killed.metadata.processStatus).toBe("exited")
      },
    })
  }, 15_000)

  // kill-shell 是 bash-output 的同类补扫入口,此前 files 路径完全没有覆盖。
  // 「kill 前已删除」:后台命令先删掉上一轮已收录的产物再长眠,kill 时的补扫必须带出 unlink。
  // 缺基线透传时这条会失败——正是 bash-output 那条缺陷在 kill 入口上的同构形态。
  test("kill 时补扫带出被删除文件的 unlink", async () => {
    await using tmp = await tmpdir()
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const bash = await runtime.runPromise(ShellTool.pipe(Effect.flatMap((i) => i.init())))
        const kill = await runtime.runPromise(KillShellTool.pipe(Effect.flatMap((i) => i.init())))
        const killCtx = { ...ctx, sessionID: SessionID.make("ses_kill_unlink") }

        // 造一个"上一轮已收录"的产物,mtime 推到过去,避免被当成本轮 change
        await fs.writeFile(path.join(tmp.path, "doomed.pdf"), "old")
        const past = new Date(Date.now() - 60_000)
        await fs.utimes(path.join(tmp.path, "doomed.pdf"), past, past)

        // 先删除,再长眠:确保 kill 时删除已发生、进程仍在运行(kill 才有意义)
        const started = await Effect.runPromise(
          bash.execute(
            {
              command:
                process.platform === "win32"
                  ? "Remove-Item -Force 'doomed.pdf'; Start-Sleep -Seconds 30"
                  : "rm -f doomed.pdf; sleep 30",
              description: "delete then sleep",
              run_in_background: true,
            },
            killCtx,
          ),
        )
        const id = String(started.metadata.backgroundId)
        // 等删除真正落盘
        await new Promise((r) => setTimeout(r, 600))

        const killed = await Effect.runPromise(kill.execute({ id }, killCtx))
        const files = ((killed.metadata as { files?: { path: string; event: string }[] }).files ?? []).map((f) => ({
          path: path.relative(tmp.path, f.path).replaceAll("\\", "/"),
          event: f.event,
        }))
        expect(files).toContainEqual({ path: "doomed.pdf", event: "unlink" })
      },
    })
  }, 30_000)

  test("returns not-found message for unknown id", async () => {
    await WithInstance.provide({
      directory: projectRoot,
      fn: async () => {
        const kill = await runtime.runPromise(KillShellTool.pipe(Effect.flatMap((i) => i.init())))
        const out = await Effect.runPromise(kill.execute({ id: "bash_99999" }, ctx))
        // found:false 路径:应包含 id 且提示友好
        expect(out.output).toContain("bash_99999")
        expect(out.metadata.processStatus).toBe("exited")
      },
    })
  })
})
