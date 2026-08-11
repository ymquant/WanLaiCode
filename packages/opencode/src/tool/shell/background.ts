import { Cause, Context, Deferred, Effect, Fiber, Layer, Scope, Stream } from "effect"
import { createWriteStream, type WriteStream } from "node:fs"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import * as Truncate from "../truncate"
import { InstanceState } from "@/effect/instance-state"
import * as Log from "@opencode-ai/core/util/log"
import { createShellOutputDecoder } from "@/shell/output"
import type { ShellFileChange } from "./files"

const log = Log.create({ service: "shell-background" })

export const MAX_PER_SESSION = 8
// 已读完(consumed)后台条目的软上限:刚读完的命令仍可被再次 bash-output 读到;
// 仅当已读完条目超过此软上限时,才回收最旧的若干,保证"刚读完还能 re-read"
export const MAX_EXITED_SOFT = 8
// 未读已退出条目的硬上限:正常情况下读过即回收,绝不丢未读输出;
// 仅当"未读且已退出"的条目超过此上限时,才驱逐最旧的未读条目(并记日志),防止极端无界增长
export const MAX_EXITED_HARD_CAP = 64

// 三个 shell 工具(shell / bash-output / kill-shell)共享的后台元数据形状。
// 集中一处声明,避免各处 inline 重复定义导致字段漂移;UI 侧仍按 Record 读(跨包不便复用)。
export interface ShellBackgroundMeta {
  processStatus?: "running" | "exited" | "rejected"
  truncated?: boolean
  description?: string
  background?: boolean
  backgroundId?: string
  exit?: number | null
  outputPath?: string
  output?: string
  files?: ShellFileChange[]
}

type Spec = ReturnType<typeof ChildProcess.make>
// end:本块末尾在逻辑流中的累计字节位置(本块覆盖字节区间 [end - size, end))
type Chunk = { text: string; size: number; end: number }

// 单条后台进程记录。单 owner(drain fiber 写、工具调用读),JS 单线程下无锁安全。
interface Entry {
  id: string
  sessionID: string
  command: string
  description: string
  startedAt: number
  status: "running" | "exited"
  exitCode: number | null
  // 退出后是否保留:显式后台 / 超时转后台 = true;前台命令 = false(退出即由 finalize 移除)
  retain: boolean
  background: boolean
  list: Chunk[] // 内存尾部缓冲(容量 keep 字节)
  retained: number // list 当前字节数
  total: number // 累计输出字节数(逻辑流位置)
  readCursor: number // bash-output 增量读游标(逻辑流位置)
  consumed: boolean // 是否已被 read 至少一次(failure/输出已透给模型);pruneExited 据此判定可回收
  truncated: boolean
  outputPath?: string // 溢出文件路径
  sink?: WriteStream
  // spawn/drain 启动失败:进程根本没起来或 drain 异常,仅在 drain catchCause 里设。
  // 这是"命令未能运行"的硬失败,前台据此抛 "Command failed to start"
  spawnFailure?: string
  // 溢出文件写入错误:写入期/flush 期磁盘满等,仅在 sink 'error' 监听里设。
  // 命令本身可能成功跑完,只是落盘失败 → 当作"输出可能不完整"的警告,绝不当失败丢弃输出
  sinkError?: string
  exit: Deferred.Deferred<number | null>
  // #7/#8 与 exit 解耦的 flush 完成信号:进程退出立即完成 exit,sink flush 完成后再完成 flushed
  flushed: Deferred.Deferred<void>
  onChunk?: (text: string) => Effect.Effect<void>
  // #B2 spawn 完成信号(不持有进程 handle):kill/cleanup 先 await 此 Deferred 再读 killFn,
  // 消除"kill 早于 spawn"的时序假设;失败/中断路径也会被 ensuring 兜底完成,防止永挂。
  spawned: Deferred.Deferred<void>
  // #B2 当前可用的 kill 能力(闭包捕获进程 handle)。进程退出/条目删除时置 undefined 释放 handle,
  // 避免已退出条目仍滞留 map 供 re-read 时长期 pin 住一个死进程 handle。
  killFn?: (opts?: ChildProcess.KillOptions) => Effect.Effect<void>
  // 命令工作目录,供进程退出后补扫产物(claimFileScan)。缺失则不补扫。
  cwd?: string
  // 执行前的文件基线快照,供补扫时做差集产出 unlink。
  // 没有它,补扫只能看见"还在的文件",detach 之后被后台命令删除的旧产物无法回收,
  // 输出区会永久留一行点不开的残留(与前台路径的 before 快照同一用途)。
  baseline?: ReadonlySet<string>
  // 补扫状态机:idle → in-flight → done。
  // 必须区分"有人开始扫"和"扫成功了":若扫描中途被中止/取消,files 没有提交出去,
  // 状态要回到 idle 允许后续重试,否则产物永久漏报。
  scanState: "idle" | "in-flight" | "done"
}

export interface Interface {
  // #5 上限在 register 内原子判定(仅后台):rejected:true 表示已达上限未注册
  readonly register: (input: {
    sessionID: string
    command: string
    description: string
    spec: Spec
    background: boolean
    // 命令的工作目录。仅用于进程退出后补扫产物(见 claimFileScan)。
    // 可选:未提供时 claimFileScan 不发许可,即"没有工作目录就不补扫",
    // 而不是回退到某个默认目录去扫——扫错目录会把无关文件报成本轮产物。
    cwd?: string
    // 执行前的文件基线,由调用方(shell.ts)在 run 之前拍好后透传进来。
    // 补扫要产出 unlink 就必须有它;不在这里现拍,因为注册时命令可能已开始写文件。
    baseline?: ReadonlySet<string>
    onChunk?: (text: string) => Effect.Effect<void>
  }) => Effect.Effect<
    | { rejected: true }
    | { rejected: false; id: string; exit: Deferred.Deferred<number | null> }
  >
  readonly read: (
    id: string,
    sessionID: string,
    opts?: { filter?: string },
  ) => Effect.Effect<{
    found: boolean
    status: "running" | "exited"
    exitCode: number | null
    chunk: string
    truncated: boolean
    outputPath?: string
    // #A1 spawn/drain 失败原因(=spawnFailure),供 bash-output 显示真实失败而非"无输出"
    failure?: string
    // #A1 溢出文件写入错误(=sinkError):非失败,作为"输出可能不完整"的警告附加
    sinkError?: string
  }>
  readonly snapshot: (id: string) => Effect.Effect<{
    found: boolean
    status: "running" | "exited"
    exitCode: number | null
    output: string
    truncated: boolean
    outputPath?: string
    // #A1 spawn/drain 失败原因(=spawnFailure),供前台 run() 判断并报错
    failure?: string
    // #A1 溢出文件写入错误(=sinkError):非失败,前台仅在 output 末尾加一行警告
    sinkError?: string
  }>
  // #5/#3 detach 原子判上限(超时转后台路径)。返回值区分三态:
  // "detached":成功转后台仍在运行;"already-exited":转后台前进程已退出(当作正常完成,不报后台);
  // "cap-rejected":已达上限拒绝转后台(或条目不存在)
  readonly detach: (id: string) => Effect.Effect<"detached" | "already-exited" | "cap-rejected">
  // #B2 返回内存尾部 + 截断标志/溢出文件路径(来自 entry),供 kill-shell 走 Truncate.output 并指向完整文件
  // wasRunning:调用时进程是否仍在运行(false 表示已自然退出,未发任何信号);exitCode:进程最终退出码
  readonly kill: (
    id: string,
    sessionID: string,
  ) => Effect.Effect<{ found: boolean; wasRunning: boolean; exitCode: number | null; tail: string; truncated: boolean; outputPath?: string }>
  // #7/#8 等待该条目 sink flush 完成(找不到/无则立即返回),保证文件已写完整再读
  readonly awaitFlush: (id: string) => Effect.Effect<void>
  // 领取一次「进程已退出,可以扫描产物」的许可。
  // 后台进程从 run() 返回时仍在运行,前台那次扫描只能看到 detach 之前写入的文件;
  // 真正的产物要等进程退出后由 bash-output / kill-shell 补扫。返回 undefined 表示
  // 尚未退出、会话不匹配、已有人正在扫、或已扫完。
  //
  // 领取成功后调用方**必须**配对调用 completeFileScan(成功)或 releaseFileScan(失败/中止),
  // 否则该条目会永久停在 in-flight,后续补扫不再进行。用 Effect.onExit 保证配对。
  readonly claimFileScan: (
    id: string,
    sessionID: string,
  ) => Effect.Effect<{ cwd: string; since: number; baseline?: ReadonlySet<string> } | undefined>
  // 扫描成功完成:置 done,此后不再重复扫描(claim-once 的真实语义)。
  readonly completeFileScan: (id: string) => Effect.Effect<void>
  // 扫描未完成(中止/取消/失败):退回 idle,允许后续 bash-output / kill-shell 重试。
  readonly releaseFileScan: (id: string) => Effect.Effect<void>
  readonly cleanupSession: (sessionID: string) => Effect.Effect<void>
  readonly finalize: (id: string) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ShellBackground") {}

type State = {
  scope: Scope.Scope
  map: Map<string, Entry>
  counter: number
  limits: { maxLines: number; maxBytes: number }
}

// 该 session 正在运行的后台条目数;excludeId 用于排除自身(detach 转后台时本条目已计入)
function runningBackground(s: State, sessionID: string, excludeId?: string) {
  return [...s.map.values()].filter(
    (e) => e.id !== excludeId && e.sessionID === sessionID && e.background && e.status === "running",
  ).length
}

// 内存尾部缓冲拼成完整文本;snapshot / kill / 溢出种子复用,避免重复表达式
function tailText(entry: Entry) {
  return entry.list.map((c) => c.text).join("")
}

// #C 关闭 sink 并等待 flush 完成:用 suspend 在运行时读取 entry.sink(避免构造期捕获 undefined),
// 取出并清空(防止重复 end),挂 error 监听防出错时永挂;end 回调或 error 任一触发即 resolve。
// 成功路径与 ensuring 兜底共用,语义一致(无 sink 时为 no-op)。
function endSink(entry: Entry): Effect.Effect<void> {
  return Effect.suspend(() => {
    const sink = entry.sink
    if (!sink) return Effect.void
    entry.sink = undefined
    return Effect.promise(
      () =>
        new Promise<void>((resolve) => {
          sink.end(() => resolve())
          sink.on("error", () => resolve())
        }),
    )
  })
}

// #C bash-output / kill-shell 共用的"未找到后台进程"早返回结果(仅括号内原因不同)。
export function notFoundResult(id: string, reason: string) {
  return {
    title: id,
    metadata: { processStatus: "exited" as const, truncated: false },
    output: `Background process ${id} not found (${reason}).`,
  }
}

// #C sink 落盘失败的统一警告串(shell / bash-output 共用):非失败,仅提示输出可能不完整。
export function sinkWarning(sinkError: string) {
  return `[warning: ${sinkError}; output may be incomplete]`
}

// #C 由 Truncate.Result 构造统一的截断元数据片段:truncated + (仅截断时)outputPath。
// 三工具(shell / bash-output / kill-shell)装配后台元数据时复用,避免各处重复三元判断。
export function truncatedMeta(capped?: Truncate.Result): Pick<ShellBackgroundMeta, "truncated" | "outputPath"> {
  return capped?.truncated ? { truncated: true, outputPath: capped.outputPath } : { truncated: false }
}

// #B3 回收已退出且保留的后台条目,避免 map 无界增长。策略:
//   1)已被读完(consumed 且 readCursor >= total)的条目保留最近 MAX_EXITED_SOFT 个,
//      只回收超出软上限的最旧者 —— 这样刚读完的命令仍可被再次 bash-output 读到,
//      不会因某个兄弟进程一退出就立刻消失而返回 "not found";
//   2)未读条目永不丢弃,除非"未读且已退出"的数量超过硬上限 MAX_EXITED_HARD_CAP,
//      此时才驱逐最旧的若干未读条目(并记日志说明)。running 条目永不驱逐。
//
// #A5 已退出但补扫尚未成功完成(scanState !== "done")的条目一律归入"未读桶",不受软上限回收:
// `consumed` 只代表"输出已透出",不代表"产物已上报"。read() 无条件置 consumed,
// 因此"运行期间被 bash-output 轮询过一次、之后无新输出"的后台命令在退出瞬间就是
// consumed 状态;若按软上限回收,它会在任何人补扫之前被删除,产物永久丢失。
// 注意判据是 done 而非"领取过":in-flight 的扫描可能被中止并退回 idle 重试,
// 此时条目仍需保留,否则重试机会连同条目一起消失。
function pruneExited(s: State, sessionID: string) {
  const exited = [...s.map.values()]
    .filter((e) => e.sessionID === sessionID && e.status === "exited" && e.retain)
    .sort((a, b) => a.startedAt - b.startedAt)
  // 已被消费(读过且游标追平 total,含 failure 已透出)且补扫机会已兑现的条目。
  // 无 cwd 的条目没有补扫机会可言(claimFileScan 不发许可),按已读处理,否则永不可回收。
  const isConsumed = (e: Entry) => e.consumed && e.readCursor >= e.total && (e.scanState === "done" || !e.cwd)
  const consumed = exited.filter(isConsumed)
  const unread = exited.filter((e) => !isConsumed(e))
  // 已读完:保留最近 MAX_EXITED_SOFT 个,回收更旧的(slice 配 Math.max 防止欠上限时误删)
  for (const e of consumed.slice(0, Math.max(0, consumed.length - MAX_EXITED_SOFT))) s.map.delete(e.id)
  // 未读:永不丢弃,除非超过硬上限才驱逐最旧的(正常路径永不到达)
  for (const e of unread.slice(0, Math.max(0, unread.length - MAX_EXITED_HARD_CAP))) {
    log.error("evicting unread exited background entry over hard cap", { id: e.id, sessionID })
    s.map.delete(e.id)
  }
}

// #9 返回 [from, total) 的内存可见文本,O(新增字节):跳过游标前的整块,仅 join 游标之后的块。
// 首个部分块按字节切(UTF-8 安全)。若 from 早于内存尾部起点,只能给尾部并标记截断。
function slice(entry: Entry, from: number): { text: string; truncated: boolean } {
  const retainedStart = entry.total - entry.retained
  const start = Math.max(from, retainedStart)
  const truncated = from < retainedStart
  if (start >= entry.total) return { text: "", truncated }
  const text = entry.list
    .filter((chunk) => chunk.end > start) // 跳过整块在游标前的块
    .map((chunk) => {
      const chunkStart = chunk.end - chunk.size
      if (chunkStart >= start) return chunk.text // 整块在游标之后
      // 首个部分块:按字节切掉游标之前部分(UTF-8 安全:用 Buffer)
      return Buffer.from(chunk.text, "utf-8").subarray(start - chunkStart).toString("utf-8")
    })
    .join("")
  return { text, truncated }
}

// filter 只做字面量子串匹配(不支持正则),彻底消除 ReDoS 风险
function applyFilter(text: string, filter?: string) {
  if (!filter) return text
  return text
    .split("\n")
    .filter((line) => line.includes(filter))
    .join("\n")
}

export const layer: Layer.Layer<Service, never, ChildProcessSpawner | Truncate.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner
    const trunc = yield* Truncate.Service

    const state = yield* InstanceState.make<State>(
      Effect.fn("ShellBackground.state")(function* () {
        const scope = yield* Scope.Scope
        const limits = yield* trunc.limits()
        return { scope, map: new Map(), counter: 0, limits }
      }),
    )

    const register: Interface["register"] = (input) =>
      InstanceState.useEffect(state, (s) =>
        Effect.gen(function* () {
          // #5 先完成所有挂起操作(Deferred.make),使下方"cap 检查 → s.map.set"之间纯同步、无 yield,
          // 形成真正的原子临界区。Effect 单线程下同步段不会被打断,并发 register 因此串行,不会绕过上限。
          const exit = yield* Deferred.make<number | null>()
          const flushed = yield* Deferred.make<void>()
          // #B2 spawn 完成信号:drain fiber spawn 成功后置 killFn 再完成;kill()/cleanup await 它取得 kill 能力,
          // 消除轮询时序假设,且不通过 Deferred 长期持有进程 handle
          const spawned = yield* Deferred.make<void>()

          // ── 原子临界区开始:以下到 s.map.set 之间不得有任何 yield ──
          // 仅后台受限,前台永不受限;此时本条目尚未加入 map,runningBackground 统计的是其它后台条目。
          if (input.background && runningBackground(s, input.sessionID) >= MAX_PER_SESSION) {
            return { rejected: true as const }
          }
          s.counter += 1
          const id = `bash_${s.counter}`
          const keep = s.limits.maxBytes * 2
          const maxBytes = s.limits.maxBytes
          const entry: Entry = {
            id,
            sessionID: input.sessionID,
            command: input.command,
            description: input.description,
            startedAt: Date.now(),
            status: "running",
            exitCode: null,
            retain: false,
            background: input.background,
            list: [],
            retained: 0,
            total: 0,
            readCursor: 0,
            consumed: false,
            truncated: false,
            exit,
            flushed,
            onChunk: input.onChunk,
            spawned,
            cwd: input.cwd,
            baseline: input.baseline,
            scanState: "idle",
          }
          s.map.set(id, entry)
          // ── 原子临界区结束 ──

          // drain:在 instance scope 内 fork 一个长生命周期 fiber,拥有进程直到退出或 scope 关闭
          const drain = Effect.scoped(
            Effect.gen(function* () {
              const handle = yield* spawner.spawn(input.spec)
              // #B2 spawn 成功:先挂上 kill 能力(可变字段,不进 Deferred),再完成 spawned 信号
              entry.killFn = (opts) => handle.kill(opts).pipe(Effect.orDie)
              yield* Deferred.succeed(spawned, undefined)

              // pump fiber:持续读取进程输出,写入内存缓冲并按需创建溢出文件
              const output = createShellOutputDecoder()
              const recordOutput = (chunk: string) =>
                Effect.gen(function* () {
                  if (!chunk) return
                  // 先入内存尾部缓冲并累加字节位置(裁剪在溢出判定之后做,确保种子文件含完整内容)
                  const size = Buffer.byteLength(chunk, "utf-8")
                  entry.total += size
                  // #9 记录本块末尾累计字节位置,供 slice 跳过游标前的整块
                  entry.list.push({ text: chunk, size, end: entry.total })
                  entry.retained += size

                  // #2 溢出判定放在裁剪之前:此刻 list 尚未裁剪(溢出阈值 maxBytes < 裁剪阈值 keep),
                  // 用完整 tailText(entry) 作为文件种子(含触发溢出的本块),确保无丢失;
                  // 已溢出则把本块追加到 sink。两路互斥,本块恰好写入文件一次。
                  if (!entry.sink && !entry.outputPath && entry.retained > maxBytes) {
                    entry.outputPath = yield* trunc.write(tailText(entry))
                    entry.truncated = true
                    entry.sink = createWriteStream(entry.outputPath, { flags: "a" })
                    // #A1/#6 写入期错误隔离:磁盘满/ENOSPC 等在写入/flush 阶段触发,无监听会成为未捕获异常崩溃进程。
                    // 记录到 entry.sinkError(写盘失败,非命令失败)并记日志,绝不抛出、绝不丢弃已有输出。
                    entry.sink.on("error", (err) => {
                      entry.sinkError = entry.sinkError ?? `background output file write failed: ${err.message}`
                      log.error("background sink write error", { id, err })
                    })
                  } else if (entry.sink) {
                    entry.sink.write(chunk)
                  }

                  // 裁剪内存尾部缓冲到容量 keep(被裁掉的块已落入溢出文件,不丢数据)。
                  // list.shift 是 O(n),但 list 长度受 keep 字节上限约束(块数 = keep/块大小,通常很小),
                  // 实际并非 O(n^2) 热路径;保留简单实现,不引入环形缓冲增加复杂度与出错面。
                  while (entry.retained > keep && entry.list.length > 1) {
                    const item = entry.list.shift()
                    if (!item) break
                    entry.retained -= item.size
                    entry.truncated = true
                  }

                  // onChunk 回调错误隔离:回调失败只记日志,不影响 drain 与输出累积
                  if (entry.onChunk)
                    yield* entry.onChunk(chunk).pipe(
                      Effect.catchCause((cause) =>
                        Effect.sync(() => log.error("onChunk callback failed", { id, cause })),
                      ),
                    )
                })
              const pump = yield* Stream.runForEach(handle.all, (chunk) => recordOutput(output.decode(chunk)))
                .pipe(Effect.andThen(() => recordOutput(output.flush())))
                .pipe(Effect.forkScoped)

              const code = yield* handle.exitCode.pipe(Effect.orElseSucceed(() => null))
              yield* Fiber.join(pump) // 确保末尾输出全部排空
              entry.status = "exited"
              entry.exitCode = code
              // #B2 进程已退出,尽早释放进程 handle(条目可能仍滞留 map 供 re-read,不应再 pin 死 handle)
              entry.killFn = undefined
              // #1 仅保留型(后台/超时转后台)条目退出才需回收;前台退出 retain=false 由 finalize 移除,
              // 调 pruneExited 纯属浪费(全 map 遍历+排序),加守卫跳过
              if (entry.retain) pruneExited(s, entry.sessionID)

              // #7/#8 解耦:进程退出后立即完成 exit Deferred,不被慢 flush 阻塞,
              // 避免前台 race 对已退出进程误选超时分支
              yield* Deferred.succeed(exit, code)

              // #C 之后再 flush sink(endSink 含 error 监听防永挂,标记已 end 防 ensuring 重复),flush 完成时完成 flushed
              yield* endSink(entry)
              yield* Deferred.succeed(entry.flushed, undefined)
            }),
          ).pipe(
            // #3a/#A1 先捕获 spawn/drain 失败并记录 spawnFailure,再完成 exit Deferred:
            // 若顺序相反,exit Deferred 完成后 main fiber 可能在 catchCause 之前读取 snapshot,
            // 导致 snap.failure = undefined,前台 spawn 失败被掩盖为"正常空输出"。
            // 这里只设 spawnFailure(进程没起来/drain 异常),不碰 sinkError(那是落盘失败)。
            Effect.catchCause((cause) =>
              Effect.sync(() => {
                entry.status = "exited"
                // 纯中断 Cause(hasInterruptsOnly)是 scope 关闭时的正常清理,不是 spawn/drain 失败,
                // 不写入 spawnFailure;否则并发观测的 run() 会读到"Command failed to start: Interrupted: ..."
                if (!Cause.hasInterruptsOnly(cause)) {
                  log.error("background drain failed", { id, cause })
                  entry.spawnFailure = Cause.pretty(cause)
                }
                // #B2 失败退出:释放进程 handle(若已 spawn)
                entry.killFn = undefined
                // #1 失败退出:仅保留型条目需回收(同上守卫)
                if (entry.retain) pruneExited(s, entry.sessionID)
              }),
            ),
            // ensuring 在成功/失败/中断三条路径均执行,保证资源不泄漏
            Effect.ensuring(
              // #B2 释放进程 handle:任何路径退出后都不再 pin 住死 handle(成功路径已置空,此处幂等)
              Effect.sync(() => {
                entry.killFn = undefined
              }).pipe(
                // #C 兜底关闭 sink(endSink 含 error 监听防永挂;成功路径已 end → no-op)
                Effect.andThen(endSink(entry)),
                // #B2 兜底完成 spawned,防 spawn 失败/中断时 kill/cleanup await 永挂(幂等:spawn 成功已 succeed)
                Effect.andThen(Deferred.succeed(spawned, undefined)),
                // 兜底:失败路径完成 exit Deferred(幂等:成功路径已 succeed code)
                Effect.andThen(Deferred.succeed(exit, null)),
                // #7/#8 兜底完成 flushed,防异常路径 awaitFlush 永挂(幂等:成功路径已 succeed)
                Effect.andThen(Deferred.succeed(entry.flushed, undefined)),
                Effect.asVoid,
              ),
            ),
          )

          yield* drain.pipe(Effect.forkIn(s.scope))
          return { rejected: false as const, id, exit }
        }),
      )

    const read: Interface["read"] = (id, sessionID, opts) =>
      InstanceState.useEffect(state, (s) =>
        Effect.sync(() => {
          const entry = s.map.get(id)
          // #1 不存在或会话不匹配均视为未找到,防止跨会话越权读取
          if (!entry || entry.sessionID !== sessionID)
            return { found: false, status: "exited" as const, exitCode: null, chunk: "", truncated: false }
          const { text, truncated } = slice(entry, entry.readCursor)
          entry.readCursor = entry.total
          entry.consumed = true // 已透出(含 failure),允许 pruneExited 后续回收
          return {
            found: true,
            status: entry.status,
            exitCode: entry.exitCode,
            chunk: applyFilter(text, opts?.filter),
            // #5 truncated 只反映本次读取区间是否有字节被内存裁剪丢失,不粘滞历史
            truncated,
            // #5 outputPath 仅在本次读取确有截断时附带,引导用户查看完整文件
            outputPath: truncated ? entry.outputPath : undefined,
            // #A1 透出 spawn/drain 失败原因(spawnFailure),供 bash-output 显示真实失败
            failure: entry.spawnFailure,
            // #A1 透出落盘失败(sinkError),供 bash-output 加"输出可能不完整"警告
            sinkError: entry.sinkError,
          }
        }),
      )

    const snapshot: Interface["snapshot"] = (id) =>
      InstanceState.useEffect(state, (s) =>
        Effect.sync(() => {
          const entry = s.map.get(id)
          if (!entry)
            return { found: false, status: "exited" as const, exitCode: null, output: "", truncated: false }
          return {
            found: true,
            status: entry.status,
            exitCode: entry.exitCode,
            output: tailText(entry),
            truncated: entry.truncated,
            outputPath: entry.outputPath,
            // #A1 透出 spawn/drain 失败(spawnFailure),供前台 run() 判断并抛错
            failure: entry.spawnFailure,
            // #A1 透出落盘失败(sinkError),供前台 run() 在 output 末尾加警告
            sinkError: entry.sinkError,
          }
        }),
      )

    const detach: Interface["detach"] = (id) =>
      InstanceState.useEffect(state, (s) =>
        Effect.sync(() => {
          const entry = s.map.get(id)
          if (!entry) return "cap-rejected" as const
          entry.onChunk = undefined // 停止向已结算的前台 part 推送
          // #A3 detach 到此处的微秒窗口里进程可能已退出:此时这条命令是 inline 交付给模型的
          //   (不给后台 id),retain 应保持 false,让调用方读完最终输出后显式 finalize 真正删除条目;
          //   若误置 retain=true,consumed 永不翻转、finalize 成 no-op,会堆成幽灵条目并打 ERROR 噪音。
          if (entry.status === "exited") {
            return "already-exited" as const
          }
          // #5 与状态变更原子判上限:统计其它后台条目(排除自身),已达上限则拒绝转后台
          if (runningBackground(s, entry.sessionID, entry.id) >= MAX_PER_SESSION) return "cap-rejected" as const
          entry.retain = true // 转后台,退出后仍保留
          entry.background = true // 超时转后台后计入后台上限
          return "detached" as const
        }),
      )

    const kill: Interface["kill"] = (id, sessionID) =>
      InstanceState.useEffect(state, (s) =>
        Effect.gen(function* () {
          const entry = s.map.get(id)
          // #1 不存在或会话不匹配均视为未找到,防止跨会话越权 kill
          if (!entry || entry.sessionID !== sessionID)
            return { found: false, wasRunning: false, exitCode: null, tail: "", truncated: false }
          // 调用时捕获运行状态:进程可能已自然退出,此时不发任何信号
          const wasRunning = entry.status === "running"
          if (wasRunning) {
            // #B2 先 await spawned(spawn 完成)再取 killFn:消除"kill 早于 spawn"时序假设,且不长期持有 handle
            yield* Deferred.await(entry.spawned)
            const killFn = entry.killFn
            if (killFn) yield* killFn({ forceKillAfter: "3 seconds" })
          }
          // #A3 等进程真正退出(SIGTERM 优雅退出的输出也要收齐;最多 ~3s 到 SIGKILL)+ sink flush 完成,
          // 再读最终尾部/截断标志/文件路径。这样 kill-shell 拿到的是完整最终输出,
          // 且此刻 status 确为 exited(kill-shell 的 processStatus:"exited" 名副其实)。
          yield* Deferred.await(entry.exit)
          yield* Deferred.await(entry.flushed)
          // kill() 已读取了全部输出:标记为已消费,让 pruneExited 下次将本条目归入已读桶(软上限 8)
          // 而非未读桶(硬上限 64),避免每个 kill-without-bash-output 用掉一个硬上限槽位
          entry.consumed = true
          entry.readCursor = entry.total
          // #B2 带出 entry 的截断标志与溢出文件路径,让 kill-shell 走 Truncate.output 并指向完整文件
          return {
            found: true,
            wasRunning,
            exitCode: entry.exitCode,
            tail: tailText(entry),
            truncated: entry.truncated,
            outputPath: entry.outputPath,
          }
        }),
      )

    // 进程已退出且补扫处于 idle 时,交出 cwd + 扫描起点 + 基线,并原子置 in-flight。
    // 同步临界区内完成判定与置位,并发的 bash-output 不会各自拿到一次许可。
    // since 用 startedAt:后台产物可能在命令开始后的任意时刻写入,起点必须回到命令开始,
    // 而不是补扫发生的时刻。baseline 透传执行前快照,使补扫也能产出 unlink。
    const claimFileScan: Interface["claimFileScan"] = (id, sessionID) =>
      InstanceState.useEffect(state, (s) =>
        Effect.sync(() => {
          const entry = s.map.get(id)
          if (!entry || entry.sessionID !== sessionID) return undefined
          // 只有 idle 才可领取:in-flight 表示已有调用方正在扫(不重复扫),done 表示已扫完。
          if (entry.status !== "exited" || entry.scanState !== "idle") return undefined
          const cwd = entry.cwd
          if (!cwd) return undefined
          entry.scanState = "in-flight"
          return { cwd, since: entry.startedAt, baseline: entry.baseline }
        }),
      )

    const completeFileScan: Interface["completeFileScan"] = (id) =>
      InstanceState.useEffect(state, (s) =>
        Effect.sync(() => {
          const entry = s.map.get(id)
          if (!entry) return
          entry.scanState = "done"
          // baseline 已用完,释放引用:大目录下这个 Set 可能上千条,
          // 条目还会滞留 map 供 re-read,没必要继续持有。
          entry.baseline = undefined
        }),
      )

    const releaseFileScan: Interface["releaseFileScan"] = (id) =>
      InstanceState.useEffect(state, (s) =>
        Effect.sync(() => {
          const entry = s.map.get(id)
          // 仅回退 in-flight;done 不可逆(已成功上报,重扫会把同一批文件报第二遍)。
          if (!entry || entry.scanState !== "in-flight") return
          entry.scanState = "idle"
        }),
      )

    // #7/#8 等待 sink flush 完成:找不到或无 flush 需求时立即返回
    const awaitFlush: Interface["awaitFlush"] = (id) =>
      InstanceState.useEffect(state, (s) =>
        Effect.gen(function* () {
          const entry = s.map.get(id)
          if (!entry) return
          yield* Deferred.await(entry.flushed)
        }),
      )

    const finalize: Interface["finalize"] = (id) =>
      InstanceState.useEffect(state, (s) =>
        Effect.sync(() => {
          const entry = s.map.get(id)
          if (!entry || entry.retain) return // 已转后台的不移除
          entry.killFn = undefined // #B2 删除前释放进程 handle(防御)
          s.map.delete(id)
        }),
      )

    // #A2 cleanupSession:子代理/会话结束时彻底清理该 session 的全部条目。
    // running 的先 kill(并行),然后无论 running 还是 exited-retained 一律从 map 删除,
    // 否则 exited 且 retain 的后台记录会永久泄漏。
    const cleanupSession: Interface["cleanupSession"] = (sessionID) =>
      InstanceState.useEffect(state, (s) =>
        Effect.gen(function* () {
          const owned = [...s.map.values()].filter((e) => e.sessionID === sessionID)
          // 并行 kill 所有仍在运行的进程
          yield* Effect.forEach(
            owned.filter((e) => e.status === "running"),
            (entry) =>
              Effect.gen(function* () {
                // #B2 await spawned 再取 killFn(消除"kill 早于 spawn"时序假设)
                yield* Deferred.await(entry.spawned)
                const killFn = entry.killFn
                if (killFn) yield* killFn({ forceKillAfter: "3 seconds" })
              }),
            { concurrency: "unbounded" },
          )
          // 等待所有条目 drain/flush 完成再删除:确保溢出文件写完整,
          // 避免调用方在 cleanupSession 返回后立即读文件时拿到截断内容
          yield* Effect.forEach(owned, (entry) => Deferred.await(entry.flushed), { concurrency: "unbounded" })
          // 全部从 map 删除(running 已 kill,exited-retained 也清掉)
          for (const entry of owned) s.map.delete(entry.id)
        }),
      )

    return Service.of({
      register,
      read,
      snapshot,
      detach,
      kill,
      awaitFlush,
      claimFileScan,
      completeFileScan,
      releaseFileScan,
      finalize,
      cleanupSession,
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(CrossSpawnSpawner.defaultLayer),
  Layer.provide(Truncate.defaultLayer),
)

export * as ShellBackground from "./background"
