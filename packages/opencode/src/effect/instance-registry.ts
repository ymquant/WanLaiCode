import { Duration, Effect } from "effect"

const DISPOSE_TIMEOUT_MS = 15000

// 排空活跃回合的安全上限：绝大多数生成远小于此，超时才放弃等待、交由后续 teardown 强制取消
// （防某个 drainer 或卡死回合无限拖住拆除）。上限置于 registry 层，对所有 drainer 统一兜底。
const DRAIN_TIMEOUT = Duration.minutes(5)

const disposers = new Set<(directory: string) => Promise<void>>()

export function registerDisposer(disposer: (directory: string) => Promise<void>) {
  disposers.add(disposer)
  return () => {
    disposers.delete(disposer)
  }
}

export async function disposeInstance(directory: string) {
  await Promise.allSettled(
    [...disposers].map((disposer) =>
      Promise.race([
        disposer(directory),
        new Promise<void>((resolve) => setTimeout(resolve, DISPOSE_TIMEOUT_MS)),
      ]),
    ),
  )
}

// Drainer：在实例被 dispose/reload（churn）拆掉资源之前，先让该目录里正在跑的回合
// 自然结束，避免被动中断砍断生成。仅 churn 路径调用，shutdown（disposeAll）不调，
// 关 App 时不为长回合拖住关闭。reason 用于诊断日志，标明本次拆除的触发来源。
const drainers = new Set<(directory: string, reason: string) => Effect.Effect<void>>()

export function registerDrainer(drainer: (directory: string, reason: string) => Effect.Effect<void>) {
  drainers.add(drainer)
  return () => {
    drainers.delete(drainer)
  }
}

export const drainInstance = (directory: string, reason: string): Effect.Effect<void> =>
  Effect.forEach([...drainers], (drainer) => Effect.ignore(drainer(directory, reason)), {
    concurrency: "unbounded",
    discard: true,
  }).pipe(Effect.timeout(DRAIN_TIMEOUT), Effect.ignore)
