// Codex 风格相对时间：纯函数返回"单位 + 数值"，文案由调用方走 i18n
const MIN = 60 * 1000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const WEEK = 7 * DAY
const MONTH = 30 * DAY
const YEAR = 365 * DAY

export type RelativeUnit = "now" | "min" | "hour" | "day" | "week" | "month" | "year"

export function relativeTimeUnit(when: number, now = Date.now()): { unit: RelativeUnit; value: number } {
  const diff = Math.max(0, now - when)
  if (diff < MIN) return { unit: "now", value: 0 }
  if (diff < HOUR) return { unit: "min", value: Math.floor(diff / MIN) }
  if (diff < DAY) return { unit: "hour", value: Math.floor(diff / HOUR) }
  if (diff < WEEK) return { unit: "day", value: Math.floor(diff / DAY) }
  if (diff < MONTH) return { unit: "week", value: Math.floor(diff / WEEK) }
  if (diff < YEAR) return { unit: "month", value: Math.floor(diff / MONTH) }
  return { unit: "year", value: Math.floor(diff / YEAR) }
}
