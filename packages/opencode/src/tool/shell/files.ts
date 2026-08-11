import { Effect, Option } from "effect"
import path from "path"
import { AppFileSystem } from "@opencode-ai/core/filesystem"

// 单次命令最多记录的变更文件数。批处理脚本可能触碰上千文件,元数据要有硬上限。
export const MAX_TRACKED_FILE_CHANGES = 50
// unlink 的独立额度:change 与 unlink 不共用同一个 50 条池子。
// 原因是两者后果不对称——change 少报一条只是少一行可点开的产物(信息缺失),
// unlink 少报一条会让 UI 永久留一行点不开的残留(错误状态)。
// 若共用总额度,"生成 50 个文件同时删掉一个已收录文件"会让清理事件被挤掉。
export const MAX_TRACKED_FILE_UNLINKS = 20
// 目录深度上限。
export const FILE_SCAN_MAX_DEPTH = 4
// 目录项枚举预算:无论仓库多大,单次扫描最多枚举这么多目录项(含 stat 次数上界)。
// 这是性能护栏的关键——只靠 MAX_TRACKED_FILE_CHANGES 无法约束"零命中的只读命令",
// 那种情况下旧实现会把整棵树走完。BFS + 预算保证代价与仓库规模无关。
export const FILE_SCAN_ENTRY_BUDGET = 4_000
// 扫描时跳过的目录名(点目录另有统一规则)。
export const FILE_SCAN_SKIP_DIRS = new Set(["node_modules", "dist", "build", "out", "target", "vendor", "__pycache__"])
// 部分文件系统 mtime 粒度为秒,取 since 时留 1s 容差,否则同秒内写入会被漏掉。
export const MTIME_GRANULARITY_MS = 1_000

/**
 * shell 执行期间该 cwd 内发生变更的文件。
 *
 * - `change`:命令结束后 mtime >= since,即"在本命令的时间窗内被写过且此刻存在"。
 * - `unlink`:命令开始时存在、结束后已消失,即"在本命令的时间窗内消失"。
 *
 * 两者都来自命令前后的真实文件系统状态,不是对命令行或正文的猜测,
 * 因此比正文启发式可靠得多。
 *
 * **已知限制(证据强度的准确表述)**:这是「时间窗 + 目录」证据,不是「进程」证据。
 * mtime 只能证明某文件在本命令运行期间被改过,**不能**证明是本命令的进程改的。
 * 同一 cwd 上有其它写入者(并发的另一个 shell、编辑器保存、watcher、构建进程)时,
 * 它们的写入会被归到时间窗覆盖它的那条命令上;后台命令的时间窗跨整个进程生命周期,
 * 因此更容易覆盖到他人的写入。
 *
 * 当前接受这个限制:归属可能错,但「文件存在且刚被改过」这一事实是真的,
 * 对 UI 的用途(给出可点开的产物行)仍然成立。要做到进程级准确归属,需要
 * watcher 事件按执行窗口隔离、进程级文件审计,或对同 cwd 的扫描串行化并避免时间窗重叠
 * —— 都超出本 PR 范围。见 test "已知限制:他进程在同 cwd 的写入会被算作本命令产物"。
 */
export interface ShellFileChange {
  path: string
  event: "change" | "unlink"
}

/**
 * BFS 枚举 cwd 下的文件路径,只读目录项、不做 stat。
 *
 * 用途是命令执行前的「基线快照」:与执行后的扫描做差集即可得到被删除的文件,
 * 无需在服务端维护任何跨调用状态。BFS 保证预算耗尽时优先覆盖浅层
 * (产物几乎总落在 cwd 根或一层子目录),而非深挖单条路径。
 */
export const snapshotFiles = Effect.fn("ShellFiles.snapshot")(function* (fs: AppFileSystem.Interface, cwd: string) {
  const found = new Set<string>()
  let budget = FILE_SCAN_ENTRY_BUDGET
  const queue: { dir: string; depth: number }[] = [{ dir: cwd, depth: 0 }]
  while (queue.length > 0 && budget > 0) {
    const current = queue.shift()!
    const entries = yield* fs.readDirectoryEntries(current.dir).pipe(Effect.catch(() => Effect.succeed([])))
    for (const entry of entries) {
      if (budget <= 0) break
      budget--
      if (entry.type === "directory") {
        if (current.depth >= FILE_SCAN_MAX_DEPTH) continue
        if (FILE_SCAN_SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue
        queue.push({ dir: path.join(current.dir, entry.name), depth: current.depth + 1 })
        continue
      }
      if (entry.type !== "file") continue
      found.add(path.join(current.dir, entry.name))
    }
  }
  return found
})

/**
 * 扫描 cwd,得出本轮的 change / unlink 事件。
 *
 * 为什么需要:shell / Python / PowerShell 产出的文件既没有工具 diff 也没有附件,
 * 此前 UI 只能靠扫正文提及来猜,而正文无法区分「本轮生成」「引用既有文件」
 * 「目录清单」「生成失败」「原计划输出」,必然在误报与漏报之间摆动。
 *
 * 为什么用 mtime 扫描而不是订阅 FileWatcher:后者看着更省事,但实测不可行 ——
 * watcher 的 flush 走模块级 Bus.publish,PubSub 由 InstanceState 按 directory 分键,
 * 而 Effect fiber 不携带 Instance 的 ALS;叠加 100ms 防抖与 parcel 订阅建立耗时在
 * Windows 上的抖动,订阅侧收不到稳定事件(多档 settle 值实测均为空且非单调)。
 * mtime 扫描不依赖原生 binding、无防抖、无跨 runtime 服务解析,完全确定可测。
 *
 * 设计取舍:
 * - change 不区分 add/modify:mtime 无法区分两者,而 UI 只关心「这个文件能打开」。
 * - unlink 来自与 before 快照的差集,并逐个 stat 复核。复核是必须的:预算截断会让
 *   after 少枚举一些仍然存在的文件,若不复核就会把它们误报成删除,进而错删 UI 里的正确行。
 * - 只扫 cwd 内:命令写到 cwd 外的文件不归本轮(与 external_directory 授权边界一致)。
 * - 目录项预算 + 深度上限 + 跳过 node_modules/点目录,保证代价与仓库规模无关。
 */
export const scanChangedFiles = Effect.fn("ShellFiles.scan")(function* (
  // fs 由调用方在工具定义作用域传入,而不是在这里 yield 服务:
  // 否则 AppFileSystem.Service 会进入 execute 的 requirement 通道,
  // 与三个工具声明的 Effect<..., never, never> 冲突。
  fs: AppFileSystem.Interface,
  cwd: string,
  since: number,
  before?: ReadonlySet<string>,
) {
  const found: ShellFileChange[] = []
  const seen = new Set<string>()
  let budget = FILE_SCAN_ENTRY_BUDGET
  const queue: { dir: string; depth: number }[] = [{ dir: cwd, depth: 0 }]
  while (queue.length > 0 && budget > 0 && found.length < MAX_TRACKED_FILE_CHANGES) {
    const current = queue.shift()!
    const entries = yield* fs.readDirectoryEntries(current.dir).pipe(Effect.catch(() => Effect.succeed([])))
    for (const entry of entries) {
      if (budget <= 0 || found.length >= MAX_TRACKED_FILE_CHANGES) break
      budget--
      const full = path.join(current.dir, entry.name)
      if (entry.type === "directory") {
        if (current.depth >= FILE_SCAN_MAX_DEPTH) continue
        if (FILE_SCAN_SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue
        queue.push({ dir: full, depth: current.depth + 1 })
        continue
      }
      if (entry.type !== "file") continue
      seen.add(full)
      const stat = yield* fs.stat(full).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (!stat) continue
      if (Option.getOrElse(stat.mtime, () => new Date(0)).getTime() < since) continue
      found.push({ path: full, event: "change" })
    }
  }
  if (!before) return found
  // before 里有、本次没枚举到的候选,逐个复核确认真的不存在,才算删除。
  // 复核失败(权限等)时按"仍存在"处理而非 existsSafe 的 false:误报删除会让 UI 错删正确的行,
  // 漏报删除只是留一行旧条目,前者更糟。
  //
  // unlink 走**独立额度**而不是继续消耗 found 的总额度:否则 change 填满 50 条后
  // 这里会立即 break,"生成 50 个文件同时删掉一个已收录文件"的清理事件被挤掉,
  // UI 永久留一行点不开的残留。
  const unlinks: ShellFileChange[] = []
  for (const candidate of before) {
    if (unlinks.length >= MAX_TRACKED_FILE_UNLINKS) break
    if (seen.has(candidate)) continue
    const exists = yield* fs.exists(candidate).pipe(Effect.catch(() => Effect.succeed(true)))
    if (exists) continue
    unlinks.push({ path: candidate, event: "unlink" })
  }
  // unlink 排在前面:下游若再做截断,先保住修正类事件。
  return [...unlinks, ...found]
})

export * as ShellFiles from "./files"
