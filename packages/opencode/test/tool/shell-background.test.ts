import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Layer, ManagedRuntime } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { tmpdir } from "os"
import { ShellBackground } from "../../src/tool/shell/background"
import { Truncate } from "@/tool/truncate"
import { WithInstance } from "../../src/project/with-instance"
import path from "path"

const runtime = ManagedRuntime.make(Layer.mergeAll(ShellBackground.defaultLayer))
const dir = path.join(__dirname, "../..")

// 测试辅助:register 现在返回拒绝联合,断言未被拒绝并解包出 { id, exit }
function registerOk(bg: ShellBackground.Interface, input: Parameters<ShellBackground.Interface["register"]>[0]) {
  return Effect.gen(function* () {
    const r = yield* bg.register(input)
    if (r.rejected) throw new Error("unexpected background register rejection")
    return r
  })
}

function echoSpec(text: string): ReturnType<typeof ChildProcess.make> {
  if (process.platform === "win32") {
    return ChildProcess.make("powershell", ["-NoProfile", "-Command", `Write-Output '${text}'`], { stdin: "ignore" })
  }
  return ChildProcess.make("/bin/sh", ["-c", `printf '%s\\n' '${text}'`], { stdin: "ignore" })
}

function sleepSpec(): ReturnType<typeof ChildProcess.make> {
  if (process.platform === "win32") {
    return ChildProcess.make("powershell", ["-NoProfile", "-Command", "Start-Sleep -Seconds 30"], { stdin: "ignore" })
  }
  return ChildProcess.make("/bin/sh", ["-c", "sleep 30"], { stdin: "ignore" })
}

// 子进程输出后等待父测试显式放行，保证 detach() 一定先于退出。
function gatedEcho(text: string) {
  const gate = path.join(tmpdir(), `wanlaicode-shell-background-${crypto.randomUUID()}`)
  const code =
    'process.stdout.write(Bun.argv[1] + "\\n"); const gate = Bun.file(Bun.argv[2]); while (!(await gate.exists())) await Bun.sleep(10); await gate.delete()'
  return {
    spec: ChildProcess.make(process.execPath, ["-e", code, text, gate], { stdin: "ignore" }),
    release: Effect.promise(() => Bun.write(gate, "")).pipe(Effect.asVoid),
  }
}

// 一次性写出 bytes 字节(单次 write,易触发"单 chunk 顶过上限"溢出场景),用 bun 直接执行
function bigSpec(bytes: number): ReturnType<typeof ChildProcess.make> {
  const code = "process.stdout.write(String.fromCharCode(97).repeat(Number(Bun.argv[1])))"
  return ChildProcess.make(process.execPath, ["-e", code, String(bytes)], { stdin: "ignore" })
}

describe("tool.shell-background", () => {
  test("register a quick command, read output and exit code", async () => {
    await WithInstance.provide({
      directory: dir,
      fn: async () => {
        await runtime.runPromise(
          Effect.gen(function* () {
            const bg = yield* ShellBackground.Service
            const sessionID = "ses_test"
            const { id, exit } = yield* registerOk(bg, {
              sessionID,
              command: "echo hi",
              description: "echo",
              background: false,
              spec: echoSpec("hello-bg"),
            })
            const code = yield* Deferred.await(exit)
            expect(code).toBe(0)
            // #1 传入正确的 sessionID
            const out = yield* bg.read(id, sessionID)
            expect(out.found).toBe(true)
            expect(out.status).toBe("exited")
            expect(out.chunk).toContain("hello-bg")
          }),
        )
      },
    })
  })

  test("kill a long-running background command", async () => {
    await WithInstance.provide({
      directory: dir,
      fn: async () => {
        await runtime.runPromise(
          Effect.gen(function* () {
            const bg = yield* ShellBackground.Service
            const sessionID = "ses_kill"
            const { id, exit } = yield* registerOk(bg, {
              sessionID,
              command: "sleep 30",
              description: "sleep",
              background: false,
              spec: sleepSpec(),
            })
            // #1 传入正确的 sessionID
            const killed = yield* bg.kill(id, sessionID)
            expect(killed.found).toBe(true)
            const code = yield* Deferred.await(exit)
            expect(code).not.toBe(0)
            const out = yield* bg.read(id, sessionID)
            expect(out.status).toBe("exited")
          }),
        )
      },
    })
  })

  test("background cap rejects extra background registrations but never foreground", async () => {
    await WithInstance.provide({
      directory: dir,
      fn: async () => {
        await runtime.runPromise(
          Effect.gen(function* () {
            const bg = yield* ShellBackground.Service
            const sid = "ses_cap"
            const ids: string[] = []

            // 填满后台槽
            for (let i = 0; i < ShellBackground.MAX_PER_SESSION; i++) {
              const { id } = yield* registerOk(bg, {
                sessionID: sid,
                command: "sleep 30",
                description: "long bg",
                background: true,
                spec: sleepSpec(),
              })
              ids.push(id)
            }

            // 后台已满:再注册后台被拒绝
            const over = yield* bg.register({
              sessionID: sid,
              command: "sleep 30",
              description: "over limit",
              background: true,
              spec: sleepSpec(),
            })
            expect(over.rejected).toBe(true)

            // 前台命令不受上限影响,仍可注册成功
            const fg = yield* bg.register({
              sessionID: sid,
              command: "sleep 30",
              description: "fg",
              background: false,
              spec: sleepSpec(),
            })
            expect(fg.rejected).toBe(false)

            for (const id of ids) yield* bg.kill(id, sid)
            if (!fg.rejected) yield* bg.kill(fg.id, sid)
          }),
        )
      },
    })
  })

  // #1/A2 未读输出永不丢:旧策略会把已退出保留条目硬砍到 8 个,丢最旧的;新策略保留全部未读
  test("pruneExited preserves unread exited entries beyond the old per-session cap", async () => {
    if (process.platform === "win32") return // 12 个串行真实进程由下方规模更小的 Windows 软上限用例覆盖
    await WithInstance.provide({
      directory: dir,
      fn: async () => {
        await runtime.runPromise(
          Effect.gen(function* () {
            const bg = yield* ShellBackground.Service
            const sid = "ses_prune_unread"
            const ids: string[] = []
            // 顺序注册→detach(retain=true)→等退出,共 12 个;已退出条目不占运行上限,故不触发 cap。
            // 每个退出时都跑 pruneExited(retain=true),旧策略会砍到 8 个,新策略保留全部未读。
            for (let i = 0; i < 12; i++) {
              const echo = gatedEcho(`line-${i}`)
              const r = yield* registerOk(bg, {
                sessionID: sid,
                command: "echo",
                description: "quick",
                background: true,
                spec: echo.spec,
              })
              yield* bg.detach(r.id)
              yield* echo.release
              yield* Deferred.await(r.exit)
              ids.push(r.id)
            }
            // 12 > 旧上限 8:全部未读条目仍可读,无丢失
            for (let i = 0; i < ids.length; i++) {
              const out = yield* bg.read(ids[i], sid)
              expect(out.found).toBe(true)
              expect(out.chunk).toContain(`line-${i}`)
            }
          }),
        )
      },
    })
  }, 15_000)

  // #B3:已读完(consumed)的条目不因兄弟进程退出就立刻消失,软上限内仍可被再次读到(re-read)
  test("read exited entry remains re-readable after a sibling exits (soft cap)", async () => {
    await WithInstance.provide({
      directory: dir,
      fn: async () => {
        await runtime.runPromise(
          Effect.gen(function* () {
            const bg = yield* ShellBackground.Service
            const sid = "ses_prune_read"
            const firstEcho = gatedEcho("consume-me")
            const a = yield* registerOk(bg, {
              sessionID: sid,
              command: "echo",
              description: "consume",
              background: true,
              spec: firstEcho.spec,
            })
            yield* bg.detach(a.id)
            yield* firstEcho.release
            yield* Deferred.await(a.exit)
            // 读完 a:readCursor=total,consumed=true
            const first = yield* bg.read(a.id, sid)
            expect(first.found).toBe(true)
            expect(first.chunk).toContain("consume-me")
            // 再注册并 detach 一个会退出的兄弟条目,触发 pruneExited
            const secondEcho = gatedEcho("trigger")
            const b = yield* registerOk(bg, {
              sessionID: sid,
              command: "echo",
              description: "trigger",
              background: true,
              spec: secondEcho.spec,
            })
            yield* bg.detach(b.id)
            yield* secondEcho.release
            yield* Deferred.await(b.exit)
            // #B3 a 已读完但在软上限内 → 兄弟退出后仍可 re-read(旧策略会立刻回收 a 返回 not found)。
            // 增量读已无新内容(chunk 空属预期),关键是 found 仍为 true、状态/退出码仍可取
            const afterA = yield* bg.read(a.id, sid)
            expect(afterA.found).toBe(true)
            expect(afterA.status).toBe("exited")
            const afterB = yield* bg.read(b.id, sid)
            expect(afterB.found).toBe(true)
          }),
        )
      },
    })
  }, 15_000)

  // #A5:运行期间被读过一次的后台条目,退出后在补扫产物之前不得被软上限回收。
  // 危险链:read() 无条件置 consumed → 该条目退出瞬间即"已读" → 旧策略按软上限把最旧的删掉
  // → claimFileScan 再也拿不到条目 → 后台命令写出的文件永久不进输出区。
  test("exited-but-unscanned entry survives soft-cap reclaim until its file scan is claimed", async () => {
    await WithInstance.provide({
      directory: dir,
      fn: async () => {
        await runtime.runPromise(
          Effect.gen(function* () {
            const bg = yield* ShellBackground.Service
            const sid = "ses_scan_before_prune"

            // 目标条目:最先注册(pruneExited 按 startedAt 升序回收,最旧者首当其冲),
            // 带 cwd 表示"有补扫机会待兑现"。
            // 用 sleep + kill 驱动退出,而不是 gate 文件:kill() 内部 await exit + flush,
            // 时序确定;且 kill 正是生产里"已退出但尚未 claim"窗口的真实来源(kill-shell 先 kill 再 claim)。
            const t = yield* registerOk(bg, {
              sessionID: sid,
              command: "python gen.py",
              description: "writes a file late",
              background: true,
              spec: sleepSpec(),
              cwd: dir,
            })
            yield* bg.detach(t.id)
            // kill() 置 consumed=true 且 readCursor=total,但不置 scanned ——
            // 这正是危险状态:输出已透出、产物尚未上报。
            yield* bg.kill(t.id, sid)

            // 填满已读桶:注册并读完 MAX_EXITED_SOFT 个兄弟条目,把目标挤出软上限。
            // 兄弟不带 cwd,按 !e.cwd 归入已读桶,正好充当挤压压力。
            // 需要 MAX_EXITED_SOFT + 1 个兄弟:pruneExited 在「进程退出」时刻跑,而 kill() 是在
            // await exit 之后才置 consumed,所以正在退出的那个兄弟当时还不算已读。
            // 第 i 个兄弟退出时已读桶 = 目标 1 + 兄弟 0..i-1 = i+1,需 i+1 > 8 → 第 9 个(i=8)才触发回收。
            // 少一个就只到 8,`8 - 8 = 0` 不回收,本用例会退化成空测试(去掉修复也通过)。
            for (let i = 0; i <= ShellBackground.MAX_EXITED_SOFT; i++) {
              const s = yield* registerOk(bg, {
                sessionID: sid,
                command: "echo",
                description: "sibling",
                background: true,
                spec: sleepSpec(),
              })
              yield* bg.detach(s.id)
              // 兄弟不带 cwd,按 !e.cwd 直接归入已读桶,充当把目标挤出软上限的压力。
              yield* bg.kill(s.id, sid)
            }

            // 目标必须仍在:补扫机会尚未兑现,不得被当作可回收的已读条目
            const scan = yield* bg.claimFileScan(t.id, sid)
            expect(scan).toBeDefined()
            expect(scan?.cwd).toBe(dir)

            // 兑现之后才允许按已读回收(claim-once 同时保证不会重复补扫)
            expect(yield* bg.claimFileScan(t.id, sid)).toBeUndefined()
          }),
        )
      },
    })
  }, 30_000)

  // #A6:claim-once 必须表示"扫描成功完成",而不是"有人开始扫"。
  // 危险链:bash-output 领取许可后在 scanChangedFiles 期间被中止/取消 → 本次没有提交 files
  // → 若此时已不可逆置位,后续调用永远拿不到许可 → 后台产物永久漏报。
  test("released file scan can be claimed again; completed one cannot", async () => {
    await WithInstance.provide({
      directory: dir,
      fn: async () => {
        await runtime.runPromise(
          Effect.gen(function* () {
            const bg = yield* ShellBackground.Service
            const sid = "ses_scan_release"
            const r = yield* registerOk(bg, {
              sessionID: sid,
              command: "python gen.py",
              description: "writes files",
              background: true,
              spec: sleepSpec(),
              cwd: dir,
            })
            yield* bg.detach(r.id)
            yield* bg.kill(r.id, sid)

            // 第一次领取成功
            expect(yield* bg.claimFileScan(r.id, sid)).toBeDefined()
            // 持有期间不得二次领取(并发 bash-output 不该各自扫一遍)
            expect(yield* bg.claimFileScan(r.id, sid)).toBeUndefined()

            // 扫描中止 → release 退回 idle → 必须能重新领取,否则产物永久漏报
            yield* bg.releaseFileScan(r.id)
            const retry = yield* bg.claimFileScan(r.id, sid)
            expect(retry).toBeDefined()
            expect(retry?.cwd).toBe(dir)

            // 成功完成后不可再领取(否则同一批文件会被上报第二遍)
            yield* bg.completeFileScan(r.id)
            expect(yield* bg.claimFileScan(r.id, sid)).toBeUndefined()
            // done 之后 release 不得把它退回 idle
            yield* bg.releaseFileScan(r.id)
            expect(yield* bg.claimFileScan(r.id, sid)).toBeUndefined()
          }),
        )
      },
    })
  }, 30_000)

  // #B3:已读完条目超过软上限 MAX_EXITED_SOFT 时,只回收最旧的,最近的保留
  test("pruneExited reclaims oldest consumed entries beyond the soft cap, keeps recent", async () => {
    await WithInstance.provide({
      directory: dir,
      fn: async () => {
        await runtime.runPromise(
          Effect.gen(function* () {
            const bg = yield* ShellBackground.Service
            const sid = "ses_prune_softcap"
            const ids: string[] = []
            // 注册并读完 (MAX_EXITED_SOFT + 1) 个已退出保留条目,全部 consumed
            for (let i = 0; i < ShellBackground.MAX_EXITED_SOFT + 1; i++) {
              const echo = gatedEcho(`soft-${i}`)
              const r = yield* registerOk(bg, {
                sessionID: sid,
                command: "echo",
                description: "softcap",
                background: true,
                spec: echo.spec,
              })
              yield* bg.detach(r.id)
              yield* echo.release
              yield* Deferred.await(r.exit)
              const out = yield* bg.read(r.id, sid)
              expect(out.found).toBe(true)
              ids.push(r.id)
            }
            // 再 detach 一个会退出的条目,触发 pruneExited:consumed 数 = SOFT+1 > SOFT → 回收最旧 1 个
            const triggerEcho = gatedEcho("trigger")
            const trigger = yield* registerOk(bg, {
              sessionID: sid,
              command: "echo",
              description: "trigger",
              background: true,
              spec: triggerEcho.spec,
            })
            yield* bg.detach(trigger.id)
            yield* triggerEcho.release
            yield* Deferred.await(trigger.exit)
            // 最旧的(ids[0])被回收,最近的(ids[last])保留
            const oldest = yield* bg.read(ids[0], sid)
            expect(oldest.found).toBe(false)
            const newest = yield* bg.read(ids[ids.length - 1], sid)
            expect(newest.found).toBe(true)
          }),
        )
      },
    })
  }, 30_000)

  // #A3:已退出条目 detach 不置 retain;调用方 finalize 后条目真正删除,不留幽灵
  test("detach of an already-exited entry does not retain; finalize truly removes it", async () => {
    await WithInstance.provide({
      directory: dir,
      fn: async () => {
        await runtime.runPromise(
          Effect.gen(function* () {
            const bg = yield* ShellBackground.Service
            const sid = "ses_already_exited"
            const r = yield* registerOk(bg, {
              sessionID: sid,
              command: "echo done",
              description: "quick exit",
              background: false,
              spec: echoSpec("already-exited-out"),
            })
            // 等进程退出后再 detach:命中 already-exited 分支
            yield* Deferred.await(r.exit)
            const d = yield* bg.detach(r.id)
            expect(d).toBe("already-exited")
            // #A3 retain 未被置真 → finalize 真正删除条目(若误 retain,finalize 会是 no-op)
            yield* bg.finalize(r.id)
            const after = yield* bg.read(r.id, sid)
            expect(after.found).toBe(false)
          }),
        )
      },
    })
  }, 15_000)

  // #A1:spawn 失败只填 failure(=spawnFailure),sinkError 保持空;成功命令二者皆空,不被误报失败
  test.skipIf(process.platform === "win32")(
    "spawn failure populates failure but not sinkError; success reports neither",
    async () => {
      await WithInstance.provide({
        directory: dir,
        fn: async () => {
          await runtime.runPromise(
            Effect.gen(function* () {
              const bg = yield* ShellBackground.Service
              const sid = "ses_failure_split"
              // spawn 失败:不存在的 cwd 让 drain fiber 内 spawn 失败
              const badSpec = ChildProcess.make("/bin/sh", ["-c", "echo hi"], {
                cwd: path.join(dir, "no-such-dir-xyz"),
                stdin: "ignore",
              })
              const fail = yield* registerOk(bg, {
                sessionID: sid,
                command: "echo hi",
                description: "spawn fail",
                background: true,
                spec: badSpec,
              })
              yield* bg.detach(fail.id)
              yield* Deferred.await(fail.exit)
              const failSnap = yield* bg.snapshot(fail.id)
              expect(failSnap.failure).toBeTruthy() // spawnFailure → failure
              expect(failSnap.sinkError).toBeUndefined() // 落盘错误独立,未被混入

              // 成功命令:failure 与 sinkError 都应为空(不被误报为 spawn 失败)
              const ok = yield* registerOk(bg, {
                sessionID: sid,
                command: "echo ok",
                description: "success",
                background: true,
                spec: echoSpec("success-out"),
              })
              yield* bg.detach(ok.id)
              yield* Deferred.await(ok.exit)
              const okSnap = yield* bg.snapshot(ok.id)
              expect(okSnap.failure).toBeUndefined()
              expect(okSnap.sinkError).toBeUndefined()
              expect(okSnap.output).toContain("success-out")
            }),
          )
        },
      })
    },
    15_000,
  )

  // B1:单个 chunk 顶过字节上限时,溢出文件仍含完整输出(含触发溢出的那个 chunk),无丢失
  test.skipIf(process.platform === "win32")("overflow file contains complete output when a chunk crosses the byte limit", async () => {
    await WithInstance.provide({
      directory: dir,
      fn: async () => {
        await runtime.runPromise(
          Effect.gen(function* () {
            const bg = yield* ShellBackground.Service
            const sid = "ses_overflow_complete"
            const byteCount = Truncate.MAX_BYTES + 20000 // > 50KB,迫使溢出建文件
            const { id, exit } = yield* registerOk(bg, {
              sessionID: sid,
              command: "big",
              description: "big single write",
              background: false,
              spec: bigSpec(byteCount),
            })
            yield* Deferred.await(exit)
            yield* bg.awaitFlush(id)
            const snap = yield* bg.snapshot(id)
            expect(snap.outputPath).toBeTruthy()
            const saved = yield* Effect.promise(() => Bun.file(snap.outputPath!).text())
            expect(Buffer.byteLength(saved, "utf-8")).toBe(byteCount)
          }),
        )
      },
    })
  }, 15_000)

  // #1 跨会话越权拒绝:sessionA 注册的进程,sessionB 不能 read/kill
  test("cross-session read and kill are rejected", async () => {
    await WithInstance.provide({
      directory: dir,
      fn: async () => {
        await runtime.runPromise(
          Effect.gen(function* () {
            const bg = yield* ShellBackground.Service
            const sessionA = "ses_cross_a"
            const sessionB = "ses_cross_b"

            const { id } = yield* registerOk(bg, {
              sessionID: sessionA,
              command: "sleep 30",
              description: "long sleep",
              background: false,
              spec: sleepSpec(),
            })

            // sessionB 尝试 read sessionA 的进程,应返回 found:false
            const readResult = yield* bg.read(id, sessionB)
            expect(readResult.found).toBe(false)

            // sessionB 尝试 kill sessionA 的进程,应返回 found:false(进程未被误杀)
            const killResult = yield* bg.kill(id, sessionB)
            expect(killResult.found).toBe(false)

            // sessionA 自己可以正常 kill
            const killOk = yield* bg.kill(id, sessionA)
            expect(killOk.found).toBe(true)
          }),
        )
      },
    })
  })

  // #4a filter 字面量匹配:灾难回溯 pattern 被视为字面量字符串,不阻塞事件循环
  test("filter treats catastrophic-looking pattern as literal string, completes immediately", async () => {
    await WithInstance.provide({
      directory: dir,
      fn: async () => {
        await runtime.runPromise(
          Effect.gen(function* () {
            const bg = yield* ShellBackground.Service
            const sessionID = "ses_redos"

            const { id, exit } = yield* registerOk(bg, {
              sessionID,
              command: "echo redos-test",
              description: "echo",
              background: false,
              spec: echoSpec("a".repeat(2000)),
            })

            yield* Deferred.await(exit)

            const start = Date.now()
            // "(a+)+" 作为字面量查找,不会触发 ReDoS;输出行不含该字面量,结果为空
            const out = yield* bg.read(id, sessionID, { filter: "(a+)+" })
            expect(Date.now() - start).toBeLessThan(100)
            expect(out.found).toBe(true)
            expect(out.chunk).not.toContain("[warning:")
            // 没有行包含字面量 "(a+)+",输出为空
            expect(out.chunk.trim()).toBe("")
          }),
        )
      },
    })
  })


  // #4 filter 字面量匹配:含目标子串的行保留,不含的行过滤掉,不会抛出异常
  test("filter literal match: keeps lines containing the string, drops others", async () => {
    await WithInstance.provide({
      directory: dir,
      fn: async () => {
        await runtime.runPromise(
          Effect.gen(function* () {
            const bg = yield* ShellBackground.Service
            const sessionID = "ses_filter"

            const { id, exit } = yield* registerOk(bg, {
              sessionID,
              command: "echo filter-test",
              description: "echo",
              background: false,
              spec: echoSpec("filter-test-output"),
            })

            yield* Deferred.await(exit)

            // 字面量 "filter-test" 匹配输出行
            const hit = yield* bg.read(id, sessionID, { filter: "filter-test" })
            expect(hit.found).toBe(true)
            expect(hit.chunk).toContain("filter-test-output")

            // 字面量 "no-match" 不匹配,输出为空
            const miss = yield* bg.read(id, sessionID, { filter: "no-match" })
            expect(miss.found).toBe(true)
            expect(miss.chunk.trim()).toBe("")
          }),
        )
      },
    })
  })
})
