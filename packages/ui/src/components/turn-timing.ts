// 「处理中 / 已处理」计时的起点计算。
// 计时应反映「本次连续处理时长」，而不是「从 user 消息创建到现在的墙钟」：
// 会话被暂停（app 关闭）、或目标模式长时间自主续跑时，时间线上会留下很大的间隔，
// 若从最初的 user 消息算起会把几十小时的闲置也计入，显示成 7227m/2459m 这类异常值。
//
// 关键：本项目 agent 循环每一步都新建一条 assistant 消息，某步以 finish==="tool-calls"
// 收尾后要等「工具执行完」才创建下一条消息——这段大间隔是活动时间而非闲置。
// 因此只有当大间隔前的那条消息「不是工具循环进行中」时，才把它当暂停/恢复来重置起点，
// 避免把单个长耗时工具步（build/test/install）误判成暂停而让计时中途回跳、总时长少算。

/** 相邻活动间隔超过该阈值，且间隔前不是工具循环进行中，才视为「暂停后恢复」并从恢复点重新起算。 */
export const RESUME_GAP_MS = 10 * 60_000

export type TurnActivity = {
  /** 该消息的创建时刻 */
  created: number
  /**
   * 这条消息之后的空档是否属于「工具循环执行中」（该消息 finish==="tool-calls"）。
   * 为 true 时其后的大空档是工具在跑（活动时间），不据此重置起点。
   */
  toolLoopContinues: boolean
}

/**
 * 计算回合「有效起点」：本回合最后一段连续活动的起点。
 * @param activities 该回合时间线（user 消息 + 各 assistant 步），可无序、可含非数字时间戳
 */
export function effectiveTurnStart(activities: readonly TurnActivity[]): number | undefined {
  const sorted = activities
    .filter((activity) => typeof activity?.created === "number")
    .sort((a, b) => a.created - b.created)
  if (sorted.length === 0) return undefined
  let start = sorted[0]!.created
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!
    const current = sorted[i]!
    if (current.created - prev.created > RESUME_GAP_MS && !prev.toolLoopContinues) {
      start = current.created
    }
  }
  return start
}
