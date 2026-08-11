// 前端计划模型(镜像后端 ScheduleConfig)+ 人类可读摘要

export type ScheduleMode = "interval" | "hourly" | "daily" | "weekdays" | "weekly" | "custom"
export type WeekdayCode = "SU" | "MO" | "TU" | "WE" | "TH" | "FR" | "SA"

export interface ScheduleConfig {
  mode: ScheduleMode
  // 「间隔」模式:每隔 N 分钟(对照 Codex intervalMinutes / FREQ=MINUTELY)
  intervalMinutes: number
  intervalHours: number
  weekdays: WeekdayCode[]
  time: string
  customRrule: string
}

export const ALL_WEEKDAYS: WeekdayCode[] = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"]
export const SCHEDULE_MODES: ScheduleMode[] = ["interval", "hourly", "daily", "weekdays", "weekly", "custom"]

// 小时(00..23)与分钟(00..59)两级选项,支持精确到任意分钟
export const HOUR_SLOTS: string[] = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, "0"))
export const MINUTE_SLOTS: string[] = Array.from({ length: 60 }, (_, i) => String(i).padStart(2, "0"))

// 把 "HH:MM" 拆成小时/分钟两段(非法/越界输入夹取到合法范围)
export function splitTime(t: string): { hour: string; minute: string } {
  const [h, m] = (t || "").split(":")
  const hour = String(Math.min(23, Math.max(0, Math.trunc(Number(h)) || 0))).padStart(2, "0")
  const minute = String(Math.min(59, Math.max(0, Math.trunc(Number(m)) || 0))).padStart(2, "0")
  return { hour, minute }
}

// 用小时/分钟拼回 "HH:MM"
export function joinTime(hour: string, minute: string): string {
  return `${hour}:${minute}`
}

// WeekdayCode → i18n automation.weekday.N(1=周一..7=周日)
export const WEEKDAY_TO_NUM: Record<WeekdayCode, number> = { MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6, SU: 7 }

export function defaultSchedule(): ScheduleConfig {
  return { mode: "daily", intervalMinutes: 30, intervalHours: 24, weekdays: [...ALL_WEEKDAYS], time: "09:00", customRrule: "" }
}

// 把任意来源(SDK 新对象 / 模板旧格式)统一成 ScheduleConfig
export function coerceSchedule(raw: unknown, kind?: string): ScheduleConfig {
  if (raw && typeof raw === "object" && "mode" in raw) {
    const r = raw as Partial<ScheduleConfig>
    return {
      ...defaultSchedule(),
      ...r,
      mode: r.mode ?? "daily",
      weekdays: r.weekdays && r.weekdays.length ? r.weekdays : [...ALL_WEEKDAYS],
    }
  }
  const old = (raw ?? {}) as { minute?: number; time?: string; weekday?: number }
  const base = defaultSchedule()
  if (kind === "hourly" || old.minute !== undefined) return { ...base, mode: "hourly", intervalHours: 1 }
  if (kind === "weekly" || old.weekday !== undefined) {
    const code = (["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const)[((old.weekday ?? 1) - 1) % 7]
    return { ...base, mode: "weekly", weekdays: [code], time: old.time ?? "09:00" }
  }
  return { ...base, mode: "daily", time: old.time ?? "09:00" }
}

type Translate = (key: string) => string

// 计划摘要(对照 Codex scheduleSummary)
export function scheduleSummary(c: ScheduleConfig, t: Translate): string {
  switch (c.mode) {
    case "interval": {
      const n = Math.max(1, c.intervalMinutes || 1)
      return `${t("automation.schedule.every")} ${n} ${t("automation.schedule.minutes")}`
    }
    case "hourly":
      return c.intervalHours <= 1
        ? t("automation.schedule.hourly")
        : `${t("automation.schedule.every")} ${c.intervalHours} ${t("automation.schedule.hours")}`
    case "daily":
      return `${t("automation.schedule.daily")} ${c.time}`
    case "weekdays":
      return `${t("automation.schedule.weekdays")} ${c.time}`
    case "weekly":
      return `${t(`automation.weekday.${WEEKDAY_TO_NUM[c.weekdays[0] ?? "MO"]}`)} ${c.time}`
    case "custom":
      return t("automation.schedule.custom")
  }
}
