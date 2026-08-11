import { describe, expect, test } from "bun:test"
import { Effect, Layer, ManagedRuntime } from "effect"
import path from "path"
import fs from "fs/promises"
import { ShellTool } from "../../src/tool/shell"
import { BashOutputTool } from "../../src/tool/bash-output"
import { Instance } from "../../src/project/instance"
import { SessionID, MessageID } from "../../src/session/schema"
import type { Permission } from "../../src/permission"
import { Config } from "@/config/config"
import { Truncate } from "@/tool/truncate"
import { Agent } from "../../src/agent/agent"
import { Session } from "../../src/session/session"
import { Plugin } from "../../src/plugin"
import { ShellBackground } from "../../src/tool/shell/background"
import { MAX_TRACKED_FILE_CHANGES, MTIME_GRANULARITY_MS, ShellFiles } from "../../src/tool/shell/files"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { tmpdir } from "../fixture/fixture"

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

const ctx = {
  sessionID: SessionID.make("ses_files"),
  messageID: MessageID.make(""),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  metadata: () => Effect.void,
  ask: (_input: Permission.AskInput) => Effect.void,
  extra: {},
} as never

// 返回 files 事件全量（含 event），路径相对化便于断言。
function shellEvents(dir: string, command: string, params: Record<string, unknown> = {}) {
  return Instance.restore(
    { directory: dir, worktree: dir, project: { id: "test", vcs: undefined } as never },
    () =>
      runtime.runPromise(
        Effect.gen(function* () {
          const info = yield* (yield* ShellTool).init()
          const result = yield* info.execute({ command, description: "t", ...params } as never, ctx)
          const meta = result.metadata as { files?: { path: string; event: string }[]; backgroundId?: string }
          return {
            backgroundId: meta.backgroundId,
            files: (meta.files ?? []).map((f) => ({
              path: path.relative(dir, f.path).replaceAll("\\", "/"),
              event: f.event,
            })),
          }
        }),
      ),
  )
}

// 只关心 change 路径的用例走这个投影。
async function shell(dir: string, command: string) {
  const result = await shellEvents(dir, command)
  return result.files.filter((f) => f.event === "change").map((f) => f.path)
}

// 读一次 bash-output，返回它带出的 files 事件（相对路径）。
function bashOutput(dir: string, id: string) {
  return Instance.restore(
    { directory: dir, worktree: dir, project: { id: "test", vcs: undefined } as never },
    () =>
      runtime.runPromise(
        Effect.gen(function* () {
          const info = yield* (yield* BashOutputTool).init()
          const result = yield* info.execute({ id } as never, ctx)
          const meta = result.metadata as { files?: { path: string; event: string }[]; processStatus?: string }
          return {
            status: meta.processStatus,
            files: (meta.files ?? []).map((f) => ({
              path: path.relative(dir, f.path).replaceAll("\\", "/"),
              event: f.event,
            })),
          }
        }),
      ),
  )
}

// 轮询 bash-output 直到进程退出，返回退出那次读到的 files。
// 补扫只在进程退出后发生，所以必须等到 exited 才有产物。
async function backgroundFiles(dir: string, id: string) {
  for (let i = 0; i < 40; i++) {
    const read = await bashOutput(dir, id)
    if (read.status === "exited") return read.files
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`background process ${id} did not exit in time`)
}

const write = (name: string, body = "hi") =>
  process.platform === "win32" ? `Set-Content -Path '${name}' -Value '${body}'` : `echo ${body} > '${name}'`

describe("shell 产物的 mtime 结构化证据", () => {
  test("记录命令真实创建的文件", async () => {
    await using tmp = await tmpdir()
    const files = await shell(tmp.path, write("artifact.xlsx"))
    expect(files).toContain("artifact.xlsx")
  }, 30_000)

  test("只读命令不产出任何条目", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await fs.writeFile(path.join(dir, "existing.pdf"), "old")
        // mtime 推到过去，模拟「上一轮或更早就存在的文件」
        const past = new Date(Date.now() - 60_000)
        await fs.utimes(path.join(dir, "existing.pdf"), past, past)
      },
    })
    const files = await shell(tmp.path, process.platform === "win32" ? "Get-ChildItem" : "ls -la")
    expect(files).toEqual([])
  }, 30_000)

  test("引用既有文件不算产物：只有被写的那个进列表", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await fs.writeFile(path.join(dir, "existing.pdf"), "old")
        const past = new Date(Date.now() - 60_000)
        await fs.utimes(path.join(dir, "existing.pdf"), past, past)
      },
    })
    const files = await shell(tmp.path, write("out.docx"))
    expect(files).toContain("out.docx")
    expect(files).not.toContain("existing.pdf")
  }, 30_000)

  test("失败命令不产出条目（正文兜底在此处会误报）", async () => {
    await using tmp = await tmpdir()
    // 命令声称要写 report.pdf 但实际失败，磁盘上不存在该文件
    const files = await shell(
      tmp.path,
      process.platform === "win32" ? "Write-Output '无法保存到 report.pdf'; exit 1" : "echo '无法保存到 report.pdf'; exit 1",
    )
    expect(files).not.toContain("report.pdf")
  }, 30_000)

  test("跳过 node_modules 等噪声目录", async () => {
    await using tmp = await tmpdir()
    const nm = path.join(tmp.path, "node_modules", "pkg")
    await fs.mkdir(nm, { recursive: true })
    const files = await shell(tmp.path, write(path.join("node_modules", "pkg", "junk.txt").replaceAll("\\", "/")))
    expect(files.some((f) => f.includes("node_modules"))).toBe(false)
  }, 30_000)

  test("条目数不超过硬上限", async () => {
    await using tmp = await tmpdir()
    const cmd =
      process.platform === "win32"
        ? "1..80 | ForEach-Object { Set-Content -Path \"f$_.txt\" -Value x }"
        : "for i in $(seq 1 80); do echo x > f$i.txt; done"
    const files = await shell(tmp.path, cmd)
    expect(files.length).toBeGreaterThan(0)
    expect(files.length).toBeLessThanOrEqual(50)
  }, 30_000)

  test("shell 删除文件产出 unlink 事件", async () => {
    // themanforfree 第四轮：只有 change 的话，第一轮生成、第二轮删除会在输出区留下点不开的残留。
    await using tmp = await tmpdir({
      init: async (dir) => {
        await fs.writeFile(path.join(dir, "report.pdf"), "old")
        const past = new Date(Date.now() - 60_000)
        await fs.utimes(path.join(dir, "report.pdf"), past, past)
      },
    })
    const result = await shellEvents(
      tmp.path,
      process.platform === "win32" ? "Remove-Item report.pdf" : "rm report.pdf",
    )
    expect(result.files).toContainEqual({ path: "report.pdf", event: "unlink" })
  }, 30_000)

  test("未被删除的既有文件不得被误报为 unlink", async () => {
    // unlink 靠 before/after 差集得出，若不复核存在性，预算截断会误删 UI 里的正确行。
    await using tmp = await tmpdir({
      init: async (dir) => {
        for (const name of ["keep_a.pdf", "keep_b.pdf", "keep_c.pdf"]) {
          await fs.writeFile(path.join(dir, name), "old")
          const past = new Date(Date.now() - 60_000)
          await fs.utimes(path.join(dir, name), past, past)
        }
      },
    })
    const result = await shellEvents(tmp.path, write("out.docx"))
    expect(result.files.filter((f) => f.event === "unlink")).toEqual([])
    expect(result.files).toContainEqual({ path: "out.docx", event: "change" })
  }, 30_000)

  test("只读命令在宽树上不会全表遍历：受目录项预算约束", async () => {
    // 旧实现 DFS 无预算，零命中的只读命令会走完整棵树（themanforfree 第四轮的性能意见）。
    // 这里造一棵远超预算的树，断言只读命令仍然零条目且能在超时内返回。
    await using tmp = await tmpdir({
      init: async (dir) => {
        const past = new Date(Date.now() - 60_000)
        for (let d = 0; d < 60; d++) {
          const sub = path.join(dir, `d${d}`)
          await fs.mkdir(sub, { recursive: true })
          for (let f = 0; f < 100; f++) {
            const file = path.join(sub, `f${f}.txt`)
            await fs.writeFile(file, "x")
            await fs.utimes(file, past, past)
          }
        }
      },
    })
    const started = Date.now()
    const files = await shell(tmp.path, process.platform === "win32" ? "Get-ChildItem" : "ls -la")
    expect(files).toEqual([])
    // 6000 个文件全 stat 一遍在 Windows 上远超这个时间；预算生效时只枚举约 4000 个目录项。
    expect(Date.now() - started).toBeLessThan(20_000)
  }, 60_000)

  test("显式后台：detach 之后写出的产物由 bash-output 补扫", async () => {
    // themanforfree 第四轮：进程仍在运行时 run() 就返回，前台那次扫描看不到之后写的文件。
    // 这里让后台命令先睡再写，断言 shell 那轮拿不到、bash-output 在退出后能拿到。
    await using tmp = await tmpdir()
    const command =
      process.platform === "win32"
        ? "Start-Sleep -Milliseconds 1500; Set-Content -Path 'late.xlsx' -Value x"
        : "sleep 1.5; echo x > late.xlsx"
    const started = await shellEvents(tmp.path, command, { run_in_background: true })
    expect(started.backgroundId).toBeTruthy()
    // detach 时文件还不存在，所以初始元数据不该包含它
    expect(started.files.map((f) => f.path)).not.toContain("late.xlsx")

    const late = await backgroundFiles(tmp.path, started.backgroundId!)
    expect(late.map((f) => f.path)).toContain("late.xlsx")
  }, 30_000)

  test("claim-once：同一后台进程重复 bash-output 只补扫一次", async () => {
    await using tmp = await tmpdir()
    const command =
      process.platform === "win32"
        ? "Start-Sleep -Milliseconds 800; Set-Content -Path 'once.xlsx' -Value x"
        : "sleep 0.8; echo x > once.xlsx"
    const started = await shellEvents(tmp.path, command, { run_in_background: true })
    const first = await backgroundFiles(tmp.path, started.backgroundId!)
    expect(first.map((f) => f.path)).toContain("once.xlsx")
    // 第二次读同一个 id 不应再带 files（否则每次轮询都重扫一遍 cwd）
    const second = await backgroundFiles(tmp.path, started.backgroundId!)
    expect(second).toEqual([])
  }, 30_000)

  // detach 之后的删除同样要能回收：补扫必须拿到执行前的基线才可能产出 unlink。
  // 少了基线，后台 `sleep; rm report.xlsx` 删掉的旧产物在输出区留一行点不开的残留。
  test("后台 detach 之后删除的文件由补扫产出 unlink", async () => {
    await using tmp = await tmpdir()
    // 先造出一个"上一轮已收录"的产物，并把 mtime 推到过去，确保它不会被当作本轮 change
    await fs.writeFile(path.join(tmp.path, "report.xlsx"), "old")
    const past = new Date(Date.now() - 60_000)
    await fs.utimes(path.join(tmp.path, "report.xlsx"), past, past)

    const command =
      process.platform === "win32"
        ? "Start-Sleep -Milliseconds 1200; Remove-Item -Force 'report.xlsx'"
        : "sleep 1.2; rm -f report.xlsx"
    const started = await shellEvents(tmp.path, command, { run_in_background: true })
    expect(started.backgroundId).toBeTruthy()
    // detach 时文件还在，初始元数据不该有 unlink
    expect(started.files.filter((f) => f.event === "unlink")).toEqual([])

    const after = await backgroundFiles(tmp.path, started.backgroundId!)
    expect(after).toContainEqual({ path: "report.xlsx", event: "unlink" })
  }, 30_000)

  // 证明 bash-output 真的走完了 claim → complete 配对，而不是停在 in-flight。
  // 这条不可省：claimFileScan 对 in-flight 和 done 的返回值都是 undefined，
  // 所以「补扫带出了产物」并不能证明 completeFileScan 执行过。
  // 用 release 作判别器——它只回退 in-flight：
  //   · 已 done  → release 是 no-op，claim 仍返回 undefined（期望）
  //   · 卡 in-flight → release 退回 idle，claim 会重新发许可（说明 onExit 没生效）
  // 若 Effect.onExit 的成功分支写错（例如 tag 名不对），条目会永久停在 in-flight，
  // pruneExited 也永远不把它算作已兑现，只有这条断言能发现。
  test("补扫成功后条目进入 done：release 不能把它退回可领取状态", async () => {
    await using tmp = await tmpdir()
    const command =
      process.platform === "win32"
        ? "Start-Sleep -Milliseconds 600; Set-Content -Path 'done.xlsx' -Value x"
        : "sleep 0.6; echo x > done.xlsx"
    const started = await shellEvents(tmp.path, command, { run_in_background: true })
    const files = await backgroundFiles(tmp.path, started.backgroundId!)
    expect(files.map((f) => f.path)).toContain("done.xlsx")

    const reclaimable = await Instance.restore(
      { directory: tmp.path, worktree: tmp.path, project: { id: "test", vcs: undefined } as never },
      () =>
        runtime.runPromise(
          Effect.gen(function* () {
            const bg = yield* ShellBackground.Service
            yield* bg.releaseFileScan(started.backgroundId!)
            // 用字面量而非 ctx.sessionID:ctx 整体是 as never,取属性无法通过类型检查
            return yield* bg.claimFileScan(started.backgroundId!, "ses_files")
          }),
        ),
    )
    expect(reclaimable).toBeUndefined()
  }, 30_000)

  // 固化一条**已知限制**：mtime 扫描给出的是「该 cwd 内某文件在本命令时间窗内被写过」,
  // 不是「该文件由本命令的进程写入」。同一 cwd 并发运行两个 shell 时归属会互串。
  // 这条用例断言的是**当前真实行为**（会串），而不是期望行为——目的是让限制变成
  // 有断言约束的已知事实：若将来改为进程级归属，这条会失败并提醒更新契约。
  // 直接对 scanChangedFiles 断言，不起任何 shell 进程：被测机制是「mtime 能否证明写入者」，
  // 与写入方是否为 shell 无关。这样既去掉了时序依赖，也不会因多占一个常驻进程而
  // 拖慢同批其它用例的 shell spawn（起 sleep 进程的写法曾让同文件另一条用例偶发失败）。
  test("已知限制：他进程在同 cwd 的写入会被算作本命令产物（非进程级证据）", async () => {
    await using tmp = await tmpdir()
    // 模拟「某条命令的时间窗从此刻开始」，该命令自身不写任何文件
    const since = Date.now() - MTIME_GRANULARITY_MS
    // 由完全无关的进程（这里即测试自身）在同一 cwd 写入
    await fs.writeFile(path.join(tmp.path, "other.xlsx"), "written by someone else")

    const found = await runtime.runPromise(
      Effect.gen(function* () {
        const fsi = yield* AppFileSystem.Service
        const changes = yield* ShellFiles.scanChangedFiles(fsi, tmp.path, since)
        return changes.map((f) => path.relative(tmp.path, f.path).replaceAll("\\", "/"))
      }),
    )
    // 断言当前真实行为：扫描无法区分写入者，他人的写入照样被报为本命令产物
    expect(found).toContain("other.xlsx")
  }, 30_000)

  // change 与 unlink 不共用额度：命令写满 MAX_TRACKED_FILE_CHANGES 个文件的同时删掉一个已收录文件,
  // 清理事件不能被挤掉，否则 UI 永久留一行点不开的残留。
  test("change 填满硬上限时 unlink 仍不被挤掉", async () => {
    await using tmp = await tmpdir()
    await fs.writeFile(path.join(tmp.path, "doomed.pdf"), "old")
    const past = new Date(Date.now() - 60_000)
    await fs.utimes(path.join(tmp.path, "doomed.pdf"), past, past)

    // 生成远多于硬上限的文件，同时删掉 doomed.pdf
    const n = MAX_TRACKED_FILE_CHANGES + 10
    const command =
      process.platform === "win32"
        ? `1..${n} | ForEach-Object { Set-Content -Path "bulk_$_.txt" -Value x }; Remove-Item -Force 'doomed.pdf'`
        : `for i in $(seq 1 ${n}); do echo x > "bulk_$i.txt"; done; rm -f doomed.pdf`
    const result = await shellEvents(tmp.path, command)

    expect(result.files).toContainEqual({ path: "doomed.pdf", event: "unlink" })
    // change 侧仍受各自上限约束，不会因为让路 unlink 而失控
    expect(result.files.filter((f) => f.event === "change").length).toBeLessThanOrEqual(MAX_TRACKED_FILE_CHANGES)
  }, 60_000)
})
