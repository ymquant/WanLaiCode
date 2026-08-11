import { createHash } from "crypto"
import { and, desc, eq, gt, isNull, lt, ne } from "drizzle-orm"
import { RRule } from "rrule"
import { Database } from "@/storage/db"
import { Identifier } from "@/id/id"
import { AutomationTable, AutomationRunTable } from "./automation.sql"
import { defaultScheduleConfig } from "./schema"
import type {
  AutomationID,
  AutomationRunID,
  CreateInput,
  ExecutionEnvironment,
  Info,
  ReasoningEffort,
  RunInfo,
  RunStatus,
  RunTrigger,
  NotificationPolicy,
  ScheduleConfig,
  TemplateKind,
  UpdateInput,
  WeekdayCode,
} from "./schema"

type Row = typeof AutomationTable.$inferSelect
type RunRow = typeof AutomationRunTable.$inferSelect

// 兼容旧格式 schedule_config(无 mode 字段),按旧 schedule_kind 归一化为新模型
function normalizeScheduleConfig(raw: unknown, kind: string): ScheduleConfig {
  if (raw && typeof raw === "object" && "mode" in raw) {
    const cfg = raw as ScheduleConfig
    // 兜底 intervalMinutes(新增字段,旧记录无此键)
    return { ...cfg, intervalMinutes: cfg.intervalMinutes ?? 30 }
  }
  const old = (raw ?? {}) as { minute?: number; time?: string; weekday?: number }
  const base = defaultScheduleConfig()
  if (kind === "hourly" || old.minute !== undefined) return { ...base, mode: "hourly", intervalHours: 1 }
  if (kind === "weekly" || old.weekday !== undefined) {
    const code = (["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const)[((old.weekday ?? 1) - 1) % 7]
    return { ...base, mode: "weekly", weekdays: [code], time: old.time ?? "09:00" }
  }
  return { ...base, mode: "daily", time: old.time ?? "09:00" }
}

function fromRow(row: Row): Info {
  return {
    id: row.id,
    title: row.title,
    enabled: row.enabled,
    template: row.template as TemplateKind,
    scheduleConfig: normalizeScheduleConfig(row.schedule_config, row.schedule_kind),
    prompt: row.prompt,
    projectID: row.project_id,
    directory: row.directory,
    threadSessionID: row.thread_session_id ?? null,
    executionEnvironment: (row.execution_environment ?? "worktree") as ExecutionEnvironment,
    agent: row.agent,
    model: row.model,
    reasoningEffort: (row.reasoning_effort as ReasoningEffort | null) ?? null,
    notificationPolicy: (row.notification_policy as NotificationPolicy) ?? null,
    lastRunAt: row.last_run_at,
    nextRunAt: row.next_run_at,
    time: { created: row.time_created, updated: row.time_updated },
  }
}

function fromRunRow(row: RunRow): RunInfo {
  return {
    id: row.id,
    automationID: row.automation_id,
    sessionID: row.session_id,
    directory: row.directory,
    trigger: row.trigger as RunTrigger,
    status: row.status as RunStatus,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    error: row.error,
    readAt: row.read_at ?? null,
    archivedAt: row.archived_at ?? null,
    archivedReason: row.archived_reason ?? null,
    inboxTitle: row.inbox_title ?? null,
    inboxSummary: row.inbox_summary ?? null,
  }
}

// 星期代码 → JS getDay()(0=周日..6=周六)
const WEEKDAY_INDEX: Record<WeekdayCode, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 }

function parseTime(time: string): [number, number] {
  const [h, m] = (time || "00:00").split(":").map(Number)
  return [Number.isFinite(h) ? h : 0, Number.isFinite(m) ? m : 0]
}

// RRULE 按「本地墙钟」展开(对照 Codex:不写 DTSTART、不把本地时刻转 UTC,BYHOUR/BYMINUTE
// 直接当用户所在时区的墙上时间)。rrule 库内部按 UTC 展开,因此把 from 的本地字段搬到 UTC 面
// 送进去,再把结果的 UTC 字段搬回本地面 —— 使 custom 与 daily/weekly 等结构化模式时区语义一致。
function nextByWallClockRrule(rule: string, from: number): number | null {
  const local = new Date(from)
  const asUTC = new Date(
    Date.UTC(
      local.getFullYear(),
      local.getMonth(),
      local.getDate(),
      local.getHours(),
      local.getMinutes(),
      local.getSeconds(),
    ),
  )
  const opts = RRule.parseString(rule)
  // 用户显式写了 DTSTART/TZID 时交给库按其语义处理,不做墙钟搬移
  if (opts.dtstart || /DTSTART/i.test(rule)) {
    const occ = new RRule({ ...opts, dtstart: opts.dtstart ?? new Date(from) }).after(new Date(from), false)
    return occ ? occ.getTime() : null
  }
  opts.dtstart = asUTC
  // UNTIL 是绝对 UTC 时刻,必须搬到同一面再比较,否则东八区的
  // UNTIL=…T02:00Z 会把本该执行的当天 09:00 那次判成超期,规则提前一天永久停排。
  if (opts.until) {
    const u = opts.until
    opts.until = new Date(
      Date.UTC(u.getFullYear(), u.getMonth(), u.getDate(), u.getHours(), u.getMinutes(), u.getSeconds()),
    )
  }
  const occ = new RRule(opts).after(asUTC, false)
  if (!occ) return null
  return new Date(
    occ.getUTCFullYear(),
    occ.getUTCMonth(),
    occ.getUTCDate(),
    occ.getUTCHours(),
    occ.getUTCMinutes(),
    occ.getUTCSeconds(),
  ).getTime()
}

// 排期抖动上限(对照 Codex 的 TM=120):把「所有人都卡在 09:00:00」摊开到 09:00:00–09:02:00。
const JITTER_SECONDS = 120

// 是否给该计划加抖动(对照 Codex cN):墙钟型计划(每天/工作日/每周/每 N 小时)加,
// 「每隔 N 分钟」这类间隔型不加 —— 间隔型要的就是准点节奏,抖动会累积成漂移。
function jitterEligible(config: ScheduleConfig): boolean {
  if (config.mode === "interval") return false
  if (config.mode !== "custom") return true
  const rule = config.customRrule.toUpperCase()
  // 一次性规则(COUNT=1)与分钟/秒级频率不抖
  if (/\bCOUNT=1\b/.test(rule)) return false
  return !/FREQ=(MINUTELY|SECONDLY)/.test(rule)
}

// 确定性抖动:同一个(自动化, 目标时刻)永远得到同一个偏移,重启/重算不会来回跳。
// 对照 Codex 的 lN(sha256 前 4 字节 % 120 * 1000);Codex 另存一个 .run-jitter-salt 让不同安装
// 错开,本项目是单机桌面端、automation id 本身已唯一,不引入 salt 文件。
function scheduleJitter(automationID: string, at: number): number {
  const digest = createHash("sha256").update(`${automationID}:${at}`).digest()
  return (digest.readUInt32BE(0) % JITTER_SECONDS) * 1000
}

// 落库用的下次运行时刻:computeNextRun 的纯结果 + 确定性抖动。
// computeNextRun 保持纯粹(工具侧校验「这条排期到底能不能算出将来时刻」要用它,测试也断言精确时刻)。
export function nextRunAtFor(automationID: string, config: ScheduleConfig, from: number): number | null {
  const base = computeNextRun(config, from)
  if (base === null) return null
  return jitterEligible(config) ? base + scheduleJitter(automationID, base) : base
}

// 计算下次运行(本地时区)。结构化模式直接算;custom 走 RRULE 库。
// 返回 null 表示「无法排期」(非法/已耗尽的 RRULE),调用方必须把 next_run_at 落成 NULL,
// 绝不能回退成 from —— 那会让 next_run_at=now、被调度器每个 tick 立刻命中而无限触发。
export function computeNextRun(config: ScheduleConfig, from: number): number | null {
  const next = new Date(from)
  next.setSeconds(0, 0)
  const [h, m] = parseTime(config.time)

  switch (config.mode) {
    case "interval": {
      // 每隔 N 分钟(对照 Codex FREQ=MINUTELY;INTERVAL=N)
      const minutes = Math.max(1, Math.floor(config.intervalMinutes || 1))
      return next.getTime() + minutes * 60_000
    }
    case "hourly": {
      const interval = Math.max(1, Math.floor(config.intervalHours || 1))
      next.setMinutes(0)
      if (next.getTime() <= from) next.setHours(next.getHours() + 1)
      // 对齐到从午夜起每 interval 小时
      while (next.getHours() % interval !== 0 || next.getTime() <= from) {
        next.setHours(next.getHours() + 1)
      }
      return next.getTime()
    }
    case "daily": {
      next.setHours(h, m, 0, 0)
      if (next.getTime() <= from) next.setDate(next.getDate() + 1)
      return next.getTime()
    }
    case "weekdays": {
      next.setHours(h, m, 0, 0)
      if (next.getTime() <= from) next.setDate(next.getDate() + 1)
      while (next.getDay() === 0 || next.getDay() === 6) next.setDate(next.getDate() + 1)
      return next.getTime()
    }
    case "weekly": {
      // 只认 weekdays[0]:上游把「用户没选星期」表达成 weekdays=全 7 天
      // (schema.ts defaultScheduleConfig / schedule.ts defaultSchedule),
      // 且前端星期控件是单选、摘要也只渲染 weekdays[0]。
      // 若这里改成「取全部里最近的一个」,未选星期的每周自动化会静默退化成每天运行。
      // 需要「每周一三五」这类多天排期请用 custom 模式的 RRULE(BYDAY=MO,WE,FR)。
      const target = WEEKDAY_INDEX[config.weekdays[0] ?? "MO"]
      next.setHours(h, m, 0, 0)
      const delta = (target - next.getDay() + 7) % 7
      next.setDate(next.getDate() + delta)
      if (next.getTime() <= from) next.setDate(next.getDate() + 7)
      return next.getTime()
    }
    case "custom": {
      const str = config.customRrule.replace(/^RRULE:/i, "").trim()
      if (!str) return null
      try {
        return nextByWallClockRrule(str, from)
      } catch {
        return null
      }
    }
  }
}

export function create(input: CreateInput): Info {
  const now = Date.now()
  const id = Identifier.ascending("automation") as AutomationID
  Database.use((db) =>
    db
      .insert(AutomationTable)
      .values({
        id,
        title: input.title,
        enabled: input.enabled ?? true,
        template: input.template ?? "custom",
        schedule_kind: input.scheduleConfig.mode,
        schedule_config: input.scheduleConfig,
        prompt: input.prompt,
        project_id: input.projectID ?? null,
        directory: input.cwd ?? null,
        thread_session_id: input.threadSessionID ?? null,
        execution_environment: input.executionEnvironment ?? "local",
        agent: input.agent ?? null,
        model: input.model ?? null,
        reasoning_effort: input.reasoningEffort ?? null,
        notification_policy: input.notificationPolicy ?? null,
        last_run_at: null,
        next_run_at: nextRunAtFor(id, input.scheduleConfig, now),
        time_created: now,
        time_updated: now,
      })
      .run(),
  )
  return get(id)!
}

export function list(): Info[] {
  return Database.use((db) => db.select().from(AutomationTable).all().map(fromRow))
}

export function get(id: AutomationID): Info | undefined {
  const row = Database.use((db) => db.select().from(AutomationTable).where(eq(AutomationTable.id, id)).get())
  return row ? fromRow(row) : undefined
}

export function update(id: AutomationID, patch: UpdateInput): Info | undefined {
  const set: Partial<Row> = { time_updated: Date.now() }
  if (patch.title !== undefined) set.title = patch.title
  if (patch.enabled !== undefined) set.enabled = patch.enabled
  if (patch.template !== undefined) set.template = patch.template
  if (patch.prompt !== undefined) set.prompt = patch.prompt
  if (patch.projectID !== undefined) set.project_id = patch.projectID
  if (patch.cwd !== undefined) set.directory = patch.cwd
  if (patch.threadSessionID !== undefined) set.thread_session_id = patch.threadSessionID
  if (patch.executionEnvironment !== undefined) set.execution_environment = patch.executionEnvironment
  if (patch.agent !== undefined) set.agent = patch.agent
  if (patch.model !== undefined) set.model = patch.model
  if (patch.reasoningEffort !== undefined) set.reasoning_effort = patch.reasoningEffort
  if (patch.notificationPolicy !== undefined) set.notification_policy = patch.notificationPolicy
  if (patch.scheduleConfig !== undefined) {
    set.schedule_config = patch.scheduleConfig
    set.schedule_kind = patch.scheduleConfig.mode
    set.next_run_at = nextRunAtFor(id, patch.scheduleConfig, Date.now())
  } else if (patch.enabled === true) {
    // 与 setEnabled 同口径:恢复启用必须以「现在」为基准重排,否则暂停期间过期的
    // next_run_at 会被保留,一恢复就立刻补跑一次时间点已失效的运行。
    // update 是第二条入口(PATCH /automation/:id 开放了 enabled 字段),不能只在 setEnabled 里防。
    const current = get(id)
    if (current) set.next_run_at = nextRunAtFor(id, current.scheduleConfig, Date.now())
  }
  const row = Database.use((db) =>
    db.update(AutomationTable).set(set).where(eq(AutomationTable.id, id)).returning().get(),
  )
  return row ? fromRow(row) : undefined
}

export function remove(id: AutomationID): void {
  Database.use((db) => db.delete(AutomationTable).where(eq(AutomationTable.id, id)).run())
}

export function setEnabled(id: AutomationID, enabled: boolean): Info | undefined {
  const current = get(id)
  if (!current) return undefined
  // 恢复启用时必须以「现在」为基准重排(对照 Codex:status 变化即重算)。
  // 否则暂停期间过期的 next_run_at 会被保留,一恢复就立刻补跑一次时间点已失效的运行。
  const set: Partial<Row> = { enabled, time_updated: Date.now() }
  if (enabled) set.next_run_at = nextRunAtFor(id, current.scheduleConfig, Date.now())
  const row = Database.use((db) =>
    db.update(AutomationTable).set(set).where(eq(AutomationTable.id, id)).returning().get(),
  )
  return row ? fromRow(row) : undefined
}

export function markRun(id: AutomationID, at: number): void {
  const current = get(id)
  if (!current) return
  Database.use((db) =>
    db
      .update(AutomationTable)
      .set({ last_run_at: at, next_run_at: nextRunAtFor(id, current.scheduleConfig, at) })
      .where(eq(AutomationTable.id, id))
      .run(),
  )
}

// 抢占式推进排期:只有 next_run_at 仍等于调度器读到的那个值时才推进,并返回是否抢到。
// 这是跨进程互斥的唯一防线 —— scheduler 的 inflight 只是进程内 Set,桌面端与
// 终端 `wanlaicode serve` 同时在跑时两个进程会在同一 tick 各看到同一条 due 记录。
// SQLite 单连接内 UPDATE…WHERE 是原子的,输的那一方 changes=0 直接放弃本轮。
//
// **只写 next_run_at,不写 last_run_at**(对照 Codex 的 kr/Er 分工):抢到之后还要过
// 运行门禁,被门挡住的那次不算「跑过」,而 last_run_at 是冷却基线,提前写会让
// 「用户刚在该对话活动过就不打断」的冷却判断整体偏移。真正开始跑时才 markLastRun。
export function claimRun(id: AutomationID, expectedNextRunAt: number | null, at: number): boolean {
  // next_run_at 为空 = 没有排期,不存在「本轮」可抢;调度器也不会把它列进 due。
  if (expectedNextRunAt === null) return false
  const current = get(id)
  if (!current) return false
  const advanced = nextRunAtFor(id, current.scheduleConfig, at)
  // 抢占必须让排期真的往前走:否则同一个值两个进程都能匹配成功、双双认为自己抢到。
  // 正常的到期路径一定满足(旧值已过期,从 now 重算必然更晚);不满足说明这条不是真的到期。
  if (advanced !== null && advanced <= expectedNextRunAt) return false
  const rows = Database.use((db) =>
    db
      .update(AutomationTable)
      .set({ next_run_at: advanced })
      .where(and(eq(AutomationTable.id, id), eq(AutomationTable.next_run_at, expectedNextRunAt)))
      .returning({ id: AutomationTable.id })
      .all(),
  )
  return rows.length > 0
}

// 把下次运行改到指定时刻(被运行门禁挡住时用),不动 last_run_at。
// 对照 Codex 的 CN(kr):门禁挡住只调排期,冷却基线保持不变。
export function deferRun(id: AutomationID, nextRunAt: number): void {
  Database.use((db) =>
    db.update(AutomationTable).set({ next_run_at: nextRunAt }).where(eq(AutomationTable.id, id)).run(),
  )
}

// 记录「本次真的跑了」。与 markRun 的区别是不重算排期(排期已由 claimRun 推进)。
export function markLastRun(id: AutomationID, at: number): void {
  Database.use((db) => db.update(AutomationTable).set({ last_run_at: at }).where(eq(AutomationTable.id, id)).run())
}

// 该自动化当前是否已有在跑的运行(手动「立即运行」连点去重)。
// 只认「还在超时窗口内」的 running 记录:进程被杀留下的僵尸 running 不该永久挡住手动触发。
export function activeRun(automationID: AutomationID, staleAfterMs: number): RunInfo | undefined {
  const cutoff = Date.now() - staleAfterMs
  const row = Database.use((db) =>
    db
      .select()
      .from(AutomationRunTable)
      .where(
        and(
          eq(AutomationRunTable.automation_id, automationID),
          eq(AutomationRunTable.status, "running"),
          gt(AutomationRunTable.started_at, cutoff),
        ),
      )
      .orderBy(desc(AutomationRunTable.started_at), desc(AutomationRunTable.id))
      .get(),
  )
  return row ? fromRunRow(row) : undefined
}

export function startRun(input: {
  automationID: AutomationID
  trigger: RunTrigger
  sessionID?: string | null
  directory?: string | null
}): RunInfo {
  const id = Identifier.ascending("automation_run") as AutomationRunID
  const now = Date.now()
  const sessionID = input.sessionID ?? null
  const directory = input.directory ?? null
  Database.use((db) =>
    db
      .insert(AutomationRunTable)
      .values({
        id,
        automation_id: input.automationID,
        session_id: sessionID,
        directory,
        trigger: input.trigger,
        status: "running",
        started_at: now,
        finished_at: null,
        error: null,
      })
      .run(),
  )
  return {
    id,
    automationID: input.automationID,
    sessionID,
    directory,
    readAt: null,
    archivedAt: null,
    archivedReason: null,
    inboxTitle: null,
    inboxSummary: null,
    trigger: input.trigger,
    status: "running",
    startedAt: now,
    finishedAt: null,
    error: null,
  }
}

export function finishRun(id: AutomationRunID, patch: { status: RunStatus; sessionID?: string; error?: string }): void {
  // session_id 只在显式传入时覆盖:startRun 已绑定会话,缺省写 null 会把用户点进会话的入口抹掉
  const set: Partial<RunRow> = { status: patch.status, error: patch.error ?? null, finished_at: Date.now() }
  if (patch.sessionID !== undefined) set.session_id = patch.sessionID
  Database.use((db) => db.update(AutomationRunTable).set(set).where(eq(AutomationRunTable.id, id)).run())
}

// 收尾上次进程被杀留下的 running 记录。**必须带年龄门槛**:这条在每次 Server.listen 时执行,
// 而 serve/web/acp 多个入口共用同一个库 —— 无条件全表 UPDATE 会让新起的进程把另一个进程
// **正在跑**的运行标成失败(详情页变红点而任务还在跑)。只收超过 staleAfterMs 的,
// 更年轻的那些由它们自己的超时路径落终态。
export function markInterruptedRuns(now = Date.now(), staleAfterMs = 30 * 60_000): number {
  return Database.use((db) =>
    db
      .update(AutomationRunTable)
      .set({
        status: "error",
        error: "Automation run was interrupted before it could finish.",
        finished_at: now,
      })
      .where(and(eq(AutomationRunTable.status, "running"), lt(AutomationRunTable.started_at, now - staleAfterMs)))
      .returning({ id: AutomationRunTable.id })
      .all(),
  ).length
}

// 运行历史上限:高频自动化一天可产生上千条,详情页只需要最近的若干条(最新在前)
const RUN_HISTORY_LIMIT = 50

// 返回该自动化的运行历史,**含已归档**。归档与否是展示态,交给前端过滤:
// 服务端若默认滤掉已归档,UI 上就没有任何入口能看到它们,unarchiveRun 也就永远不可达 ——
// 归档会变成不可撤销的单向操作。RunInfo.archivedAt 已随记录返回,前端据此分组。
export function listRuns(automationID: AutomationID): RunInfo[] {
  return Database.use((db) =>
    db
      .select()
      .from(AutomationRunTable)
      .where(eq(AutomationRunTable.automation_id, automationID))
      // id 是递增标识符,作为次级排序键让同一毫秒内创建的多条运行也有确定顺序
      .orderBy(desc(AutomationRunTable.started_at), desc(AutomationRunTable.id))
      .limit(RUN_HISTORY_LIMIT)
      .all()
      .map(fromRunRow),
  )
}

// ---------- 收件箱(对照 Codex 的 automation_runs 未读/归档) ----------

// 未读判据(对照 Codex 的未读计数 SQL:read_at IS NULL AND status IN ('PENDING_REVIEW','ACCEPTED')):
// 已归档的不计,还在跑的也不计 —— 只有「跑完了但用户还没看」才算未读。
function unreadWhere() {
  return and(
    isNull(AutomationRunTable.read_at),
    isNull(AutomationRunTable.archived_at),
    ne(AutomationRunTable.status, "running"),
  )
}

export function unreadCount(): number {
  return Database.use((db) =>
    db.select({ id: AutomationRunTable.id }).from(AutomationRunTable).where(unreadWhere()).all(),
  ).length
}

// 有未读运行的自动化 ID 集合(侧栏给对应条目挂小红点)
export function unreadAutomationIDs(): AutomationID[] {
  const rows = Database.use((db) =>
    db.select({ automationID: AutomationRunTable.automation_id }).from(AutomationRunTable).where(unreadWhere()).all(),
  )
  return [...new Set(rows.map((r) => r.automationID))]
}

export function setRunRead(id: AutomationRunID, read: boolean): void {
  Database.use((db) =>
    db
      .update(AutomationRunTable)
      .set({ read_at: read ? Date.now() : null })
      .where(eq(AutomationRunTable.id, id))
      .run(),
  )
}

// 全部标记已读。不传 automationID 则覆盖所有自动化(对照 Codex 的 mark-all-read:
// 连已归档的也一并标已读,避免取消归档后又冒出未读)。
export function markAllRead(automationID?: AutomationID): number {
  const now = Date.now()
  return Database.use((db) =>
    db
      .update(AutomationRunTable)
      .set({ read_at: now })
      // 必须排除 running:正在跑的运行还没结果可看,提前写 read_at 会让它跑完后
      // 永远不算未读(finishRun 不会清 read_at),用户就再也看不到这次结果/失败。
      .where(
        and(
          isNull(AutomationRunTable.read_at),
          ne(AutomationRunTable.status, "running"),
          ...(automationID ? [eq(AutomationRunTable.automation_id, automationID)] : []),
        ),
      )
      .returning({ id: AutomationRunTable.id })
      .all(),
  ).length
}

// 归档一条运行。reason 为 null 表示用户手动归档(当前唯一的调用路径);
// 保留 reason 形参供将来的自动归档使用。
// 用 COALESCE 语义保证首次原因不被后续覆盖(对照 Codex)。
export function archiveRun(id: AutomationRunID, reason: string | null = null): void {
  const current = Database.use((db) =>
    db.select().from(AutomationRunTable).where(eq(AutomationRunTable.id, id)).get(),
  )
  if (!current) return
  Database.use((db) =>
    db
      .update(AutomationRunTable)
      .set({ archived_at: Date.now(), archived_reason: current.archived_reason ?? reason })
      .where(eq(AutomationRunTable.id, id))
      .run(),
  )
}

// 取消归档:同时补上 read_at(对照 Codex 的 unarchive 用 COALESCE 补已读),
// 否则取消归档会凭空多出一条未读。
export function unarchiveRun(id: AutomationRunID): void {
  const current = Database.use((db) =>
    db.select().from(AutomationRunTable).where(eq(AutomationRunTable.id, id)).get(),
  )
  if (!current) return
  Database.use((db) =>
    db
      .update(AutomationRunTable)
      .set({ archived_at: null, archived_reason: null, read_at: current.read_at ?? Date.now() })
      .where(eq(AutomationRunTable.id, id))
      .run(),
  )
}

// 归档某自动化下所有已结束的运行(还在跑的不动)。返回归档条数供 toast 显示。
export function archiveAllRuns(automationID: AutomationID): number {
  const now = Date.now()
  return Database.use((db) =>
    db
      .update(AutomationRunTable)
      .set({ archived_at: now })
      .where(
        and(
          eq(AutomationRunTable.automation_id, automationID),
          isNull(AutomationRunTable.archived_at),
          ne(AutomationRunTable.status, "running"),
        ),
      )
      .returning({ id: AutomationRunTable.id })
      .all(),
  ).length
}

// 落模型给出的收件箱标题/摘要(::inbox-item 指令解析结果)
export function setRunInboxItem(id: AutomationRunID, item: { title?: string; summary?: string }): void {
  Database.use((db) =>
    db
      .update(AutomationRunTable)
      .set({ inbox_title: item.title ?? null, inbox_summary: item.summary ?? null })
      .where(eq(AutomationRunTable.id, id))
      .run(),
  )
}

export interface RunSession {
  sessionID: string
  automationID: AutomationID
  status: RunStatus
}

// 所有「自动化产生的会话」映射(供侧栏给会话打时钟图标/运行中转圈)。按 started_at 升序,
// 同一会话多次运行时后者(最新)在数组末尾,前端建 Map 时自然取最新状态。
export function listRunSessions(): RunSession[] {
  return Database.use((db) =>
    db.select().from(AutomationRunTable).orderBy(AutomationRunTable.started_at, AutomationRunTable.id).all(),
  )
    .filter((r) => r.session_id)
    .map((r) => ({ sessionID: r.session_id!, automationID: r.automation_id, status: r.status as RunStatus }))
}

export * as Automation from "./automation"
