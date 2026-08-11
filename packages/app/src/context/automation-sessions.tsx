import { createContext, createEffect, createResource, onCleanup, type ParentProps, useContext } from "solid-js"
import { useGlobalSDK } from "./global-sdk"
import { useLanguage } from "./language"

// 自动化产生的会话 → 最新运行状态。供侧栏 ThreadRow 给会话打时钟图标 / 运行中转圈。
type RunStatus = "running" | "success" | "error"

// 自适应轮询:有运行中任务时快轮询(实时转圈 + 检测完成),空闲时降频(仅探测新触发的运行)。
const POLL_RUNNING_MS = 4000
const POLL_IDLE_MS = 20000
// 自动化配置只有增删改才会变(都走显式 refetch),不需要跟着运行态快轮询
const POLL_CONFIG_MS = 60000

type AutomationSessionsValue = {
  status: (sessionID: string) => RunStatus | undefined
  // 所有自动化运行会话的 ID —— 侧栏「自动化」区据此把用户手动开的会话排除掉
  sessionIDs: () => ReadonlySet<string>
  // 自动化配置的运行目录 —— 侧栏据此找出不属于任何项目的 global 自动化目录
  directories: () => ReadonlyArray<{ directory?: string | null }>
  // 收件箱未读:总数给侧栏区块打红点,ID 集合给具体自动化打红点
  unreadTotal: () => number
  unreadIDs: () => ReadonlySet<string>
  refetch: () => void
}

const AutomationSessionsContext = createContext<AutomationSessionsValue>()

export function AutomationSessionsProvider(props: ParentProps) {
  const globalSDK = useGlobalSDK()
  const language = useLanguage()
  const [map, { refetch }] = createResource(async () => {
    const m = new Map<string, { automationID: string; status: RunStatus }>()
    try {
      const res = await globalSDK.client.automation.runSessions()
      if (!res.error)
        for (const r of res.data ?? []) m.set(r.sessionID, { automationID: r.automationID, status: r.status as RunStatus })
    } catch {
      // SDK 在错误响应时可能抛异常,这里兜住,避免根级 provider 崩溃整页
    }
    return m
  })

  // 自动化配置本身(只取目录):侧栏要靠它定位 global 自动化那个隐藏运行目录
  const [automations, { refetch: refetchAutomations }] = createResource(async () => {
    try {
      const res = await globalSDK.client.automation.list()
      return res.error ? [] : (res.data ?? [])
    } catch {
      return []
    }
  })

  // 收件箱未读状态。跟运行态同频刷新 —— 一次运行跑完就会多出一条未读,
  // 用户期望红点立刻出现,而不是等下一个慢轮询。
  const [unread, { refetch: refetchUnread }] = createResource(async () => {
    try {
      const res = await globalSDK.client.automation.unread()
      return res.error ? { total: 0, automationIDs: [] as string[] } : (res.data ?? { total: 0, automationIDs: [] })
    } catch {
      return { total: 0, automationIDs: [] as string[] }
    }
  })

  // 运行完成时发一条系统通知(对照 Codex)。
  // 判据必须是「某次运行从 running 变成结束」这个真实事件,**不能用未读数增长** ——
  // createResource 首跑时 latest 还是 undefined(取值 0),HTTP 回来后 0→N 会被当成增长,
  // 于是每次启动都为历史未读误弹一条;用户点「标为未读」同样会让总数上涨、给自己弹通知。
  let prevStatuses: Map<string, RunStatus> | undefined
  createEffect(() => {
    const current = map.latest
    if (!current) return
    const previous = prevStatuses
    prevStatuses = new Map([...current].map(([id, v]) => [id, v.status]))
    // 首个已解析快照没有对照基线,只记录不通知(它们是历史运行,不是刚跑完的)
    if (!previous) return

    const finished: RunStatus[] = []
    for (const [sessionID, { automationID, status }] of current) {
      if (status === "running" || previous.get(sessionID) !== "running") continue
      // 通知策略 failed_runs_only:成功的运行不打扰(与后端自动标已读同口径)
      const policy = automations.latest?.find((a) => a.id === automationID)?.notificationPolicy
      if (policy === "failed_runs_only" && status === "success") continue
      finished.push(status)
    }
    if (finished.length === 0) return
    window.api?.showNotification?.(
      language.t("automation.notify.title"),
      language.t("automation.notify.body").replace("{count}", String(finished.length)),
    )
  })

  const refetchAll = () => {
    void refetch()
    void refetchAutomations()
    void refetchUnread()
  }

  const hasRunning = () => {
    const m = map()
    if (!m) return false
    for (const v of m.values()) if (v.status === "running") return true
    return false
  }
  // 运行态变化时重建定时器,切换快/慢轮询;手动触发运行可调用 refetch 立即刷新
  createEffect(() => {
    const timer = setInterval(() => {
      void refetch()
      void refetchUnread()
    }, hasRunning() ? POLL_RUNNING_MS : POLL_IDLE_MS)
    onCleanup(() => clearInterval(timer))
  })
  // 配置单独用慢定时器兜底(捕捉别处新建/删除的自动化),不跟运行态的 4s 快轮询
  const configTimer = setInterval(() => void refetchAutomations(), POLL_CONFIG_MS)
  onCleanup(() => clearInterval(configTimer))

  const EMPTY_IDS: ReadonlySet<string> = new Set()

  return (
    <AutomationSessionsContext.Provider
      value={{
        status: (id) => map()?.get(id)?.status,
        sessionIDs: () => {
          const m = map()
          return m ? new Set(m.keys()) : EMPTY_IDS
        },
        directories: () => automations.latest ?? [],
        // SDK 的 number 会带上 "NaN"/"Infinity" 这类字面量(Effect Schema 的序列化形态),取值时收窄
        unreadTotal: () => {
          const total = unread.latest?.total
          return typeof total === "number" ? total : 0
        },
        unreadIDs: () => {
          const ids = unread.latest?.automationIDs
          return ids?.length ? new Set(ids) : EMPTY_IDS
        },
        refetch: refetchAll,
      }}
    >
      {props.children}
    </AutomationSessionsContext.Provider>
  )
}

export function useAutomationSessions() {
  return useContext(AutomationSessionsContext)
}
