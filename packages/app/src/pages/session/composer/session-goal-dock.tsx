import type { Goal, GoalStatus } from "@opencode-ai/sdk/v2"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Show, createEffect, createSignal, onCleanup } from "solid-js"
import { useLanguage } from "@/context/language"

export function goalStatusLabelKey(status: GoalStatus): string {
  switch (status) {
    case "active":
      return "session.goal.status.active"
    case "paused":
      return "session.goal.status.paused"
    case "blocked":
      return "session.goal.status.blocked"
    case "usageLimited":
      return "session.goal.status.usageLimited"
    case "budgetLimited":
      return "session.goal.status.budgetLimited"
    case "complete":
      return "session.goal.status.complete"
    default:
      // 兜底：未知/缺失状态按「进行中的目标」显示，绝不返回 undefined（否则 language.t(undefined) 会让整个 app 白屏崩溃）
      return "session.goal.status.active"
  }
}

// 1:1 复刻 Codex 时长格式（composer chunk 的 md/hd）：3s / 1m 21s / 1h 5m 3s；trim 零单位，最小 0s
export function formatElapsed(seconds: number): string {
  const i = Math.max(0, Math.floor(seconds))
  if (i < 1) return "0s"
  if (i < 60) return `${i}s`
  const day = Math.floor(i / 86400)
  const hour = Math.floor(i / 3600) % 24
  const min = Math.floor((i % 3600) / 60)
  const sec = i % 60
  if (day > 0 || hour > 0) {
    const parts: string[] = []
    if (day > 0) parts.push(`${day}d`)
    if (hour > 0) parts.push(`${hour}h`)
    if (min > 0) parts.push(`${min}m`)
    if (sec > 0) parts.push(`${sec}s`)
    return parts.join(" ")
  }
  return sec === 0 ? `${min}m` : `${min}m ${sec}s`
}

export function SessionGoalDock(props: {
  goal: Goal
  onEdit: () => void
  onToggleStatus: () => void
  onClear: () => void
}) {
  const language = useLanguage()
  const paused = () => props.goal.status === "paused"
  const statusLabel = () => language.t(goalStatusLabelKey(props.goal.status))

  // active 时计时每秒 live 跳（复刻 Codex xd：timeUsedSeconds*1000 + now − updatedAt）
  const [now, setNow] = createSignal(Date.now())
  createEffect(() => {
    if (props.goal.status !== "active") return
    setNow(Date.now()) // 暂停期间 now 冻结，恢复时先复位，避免 now-updatedAt 为大负数把时长钳成 0
    const id = setInterval(() => setNow(Date.now()), 1000)
    onCleanup(() => clearInterval(id))
  })
  const elapsed = () => {
    const g = props.goal
    const ms =
      g.status === "active" ? g.timeUsedSeconds * 1000 + Math.max(0, now() - g.updatedAt) : g.timeUsedSeconds * 1000
    return formatElapsed(Math.max(0, ms) / 1000)
  }

  return (
    // 复刻 Codex：目标条比输入框窄、左右内缩留白（mx-4），贴在输入框上方——
    // 圆上角 / 四周 border（底边作为与输入框之间的分隔）/ bg 与输入框同色 / 无间隙直接坐在输入框上
    <div
      data-component="session-goal-dock"
      class="relative mx-4 overflow-clip rounded-t-[16px] border-x border-t border-b border-border-weak-base bg-background-strong text-text-base"
    >
      <div class="flex items-center justify-between gap-2 px-3 py-2">
        {/* 1:1 复刻 Codex 控制卡 _d：左侧 靶心图标 +（状态 + objective 截断 + 「• 时长」）行内一排 */}
        <div class="flex min-w-0 flex-1 items-center gap-2">
          <Icon name="target" size="small" class="shrink-0 text-text-weak" aria-hidden="true" />
          <div class="flex min-w-0 flex-1 items-center text-14-regular leading-4">
            <span class="shrink-0 text-text-base" data-slot="session-goal-status">
              {statusLabel()}
            </span>
            <span
              class="ml-1 min-w-0 truncate text-text-weak"
              data-slot="session-goal-objective"
              title={props.goal.objective}
            >
              {props.goal.objective}
            </span>
            <span class="ml-1.5 shrink-0 text-text-weak tabular-nums" data-slot="session-goal-elapsed">
              {"• "}
              {elapsed()}
            </span>
          </div>
        </div>
        <div class="flex shrink-0 items-center gap-1">
          <IconButton
            data-action="session-goal-edit"
            icon="edit"
            size="normal"
            variant="ghost"
            aria-label={language.t("session.goal.edit")}
            onClick={() => props.onEdit()}
          />
          <Show when={props.goal.status === "active" || props.goal.status === "paused"}>
            <IconButton
              data-action="session-goal-toggle"
              icon={paused() ? "run" : "pause"}
              size="normal"
              variant="ghost"
              aria-label={paused() ? language.t("session.goal.resume") : language.t("session.goal.pause")}
              onClick={() => props.onToggleStatus()}
            />
          </Show>
          <IconButton
            data-action="session-goal-clear"
            icon="trash"
            size="normal"
            variant="ghost"
            aria-label={language.t("session.goal.clear")}
            onClick={() => props.onClear()}
          />
        </div>
      </div>
    </div>
  )
}
