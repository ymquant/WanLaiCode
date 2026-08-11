import * as Log from "@opencode-ai/core/util/log"
import { WorkspaceContext } from "@/control-plane/workspace-context"
import { Automation } from "./automation"
import { execute } from "./run"
import type { Info } from "./schema"

const log = Log.create({ service: "automation-scheduler" })

// 扫描间隔与每轮并发上限(对照 Codex:tick 30s、每 tick 最多起 3 个)。
// 60s 的 tick 会让「每隔 N 分钟」的自动化最多迟到一整分钟;30s 把抖动砍半。
// 上限是为了避免应用启动后一次性补跑十几个错过的自动化把机器打满 —— 没跑到的
// 下一个 tick 还在 due 列表里,只是排后面。
const TICK_MS = 30_000
const MAX_PER_TICK = 3

// 在自动化所属实例上下文里执行一次调度运行。与手动运行共用 run.ts 的 execute,
// 仅 trigger="schedule" 且在起 run 之前推进 next_run_at(避免长任务执行期间被重复触发)。
async function runScheduled(automation: Info): Promise<void> {
  await WorkspaceContext.provide({
    fn: () => execute({ automation, trigger: "schedule", advanceSchedule: true }),
  })
}

let timer: ReturnType<typeof setInterval> | undefined
// 进行中的自动化 ID(同一进程内防止重复触发;nextRunAt 推进是持久化的主防线)
const inflight = new Set<string>()

async function tick(): Promise<void> {
  const now = Date.now()
  // 周期性收尾僵尸 running。markInterruptedRuns 带 30 分钟年龄门槛(避免误杀别的进程正在跑的),
  // 若只在启动时清一次,「重启前不到 30 分钟启动的运行」就没有任何路径会再收尾它 ——
  // 它会永久停在 running:侧栏会话一直转圈、详情页每 3 秒空轮询、该次运行永不计入未读、
  // 且 activeRun 会在 30 分钟内一直挡住用户手动「立即运行」。
  try {
    const settled = Automation.markInterruptedRuns(now)
    if (settled > 0) log.warn("settled stale automation runs", { count: settled })
  } catch (err) {
    log.error("stale run sweep failed", { error: err instanceof Error ? err.message : String(err) })
  }

  let due: Info[]
  try {
    due = Automation.list().filter((a) => a.enabled && a.nextRunAt != null && a.nextRunAt <= now && !inflight.has(a.id))
  } catch (err) {
    log.error("scheduler scan failed", { error: err instanceof Error ? err.message : String(err) })
    return
  }
  // 先到期的先跑,再截断到本轮上限:否则 list() 的插入顺序会让某个自动化长期被挤在后面
  const batch = due.sort((a, b) => a.nextRunAt! - b.nextRunAt!).slice(0, MAX_PER_TICK)
  if (due.length > batch.length)
    log.info("automation batch capped", { due: due.length, running: batch.length, deferred: due.length - batch.length })
  for (const a of batch) {
    inflight.add(a.id)
    void runScheduled(a)
      .catch((err) =>
        log.error("scheduled run failed", {
          automationID: a.id,
          error: err instanceof Error ? err.message : String(err),
        }),
      )
      .finally(() => inflight.delete(a.id))
  }
}

// 启动后台调度循环(幂等:重复调用只保留一个定时器)。仅在真正 serve 时调用,
// 避免 `bun dev generate` 等构建期进程被 setInterval 挂住无法退出。
export function ensureScheduler(): void {
  if (timer) return
  const interrupted = Automation.markInterruptedRuns()
  if (interrupted > 0) log.warn("marked interrupted automation runs", { count: interrupted })
  timer = setInterval(() => void tick(), TICK_MS)
  log.info("automation scheduler started", { tickMs: TICK_MS })
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer)
  timer = undefined
}

export * as AutomationScheduler from "./scheduler"
