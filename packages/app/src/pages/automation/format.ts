// 下次/上次运行的相对时间标签(对照 Codex format-automation-next-run-label)

type Translate = (key: string) => string

// 目录 → 项目名(取路径末段)。同时按 "/" 与 "\\" 切分,兼容 Windows 反斜杠路径(如 C:\repo\project)
export function projectName(dir: string | null | undefined): string {
  if (!dir) return ""
  const parts = dir.split(/[/\\]/).filter(Boolean)
  return parts[parts.length - 1] ?? dir
}

const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`)

function dayDiff(a: Date, b: Date) {
  const da = new Date(a.getFullYear(), a.getMonth(), a.getDate())
  const db = new Date(b.getFullYear(), b.getMonth(), b.getDate())
  return Math.round((da.getTime() - db.getTime()) / 86_400_000)
}

// 时间:H:mm(小时无前导零,对照 Codex "9:00")
const hhmm = (d: Date) => `${d.getHours()}:${pad(d.getMinutes())}`
const weekdayKey = (d: Date) => `automation.weekday.${((d.getDay() + 6) % 7) + 1}`

// {label} at {time} 的本地化包装(zh: "{label}(时间: {t})" / en: "{label} at {t}")
const atTime = (t: Translate, label: string, time: string) =>
  t("automation.nextRun.atTime").replace("{label}", label).replace("{t}", time)

// 下次运行:今天/明天/星期X(时间: H:mm)
export function nextRunLabel(enabled: boolean, nextRunAt: number | string | null, t: Translate): string {
  if (!enabled) return "-"
  const ts = typeof nextRunAt === "number" ? nextRunAt : null
  if (ts == null) return t("automation.nextRun.none")
  const d = new Date(ts)
  const time = hhmm(d)
  const diff = dayDiff(d, new Date())
  if (diff <= 0) return atTime(t, t("automation.nextRun.today"), time)
  if (diff === 1) return atTime(t, t("automation.nextRun.tomorrow"), time)
  if (diff > 1 && diff < 7) return atTime(t, t(weekdayKey(d)), time)
  return atTime(t, `${d.getMonth() + 1}/${d.getDate()}`, time)
}

// 上次运行:从未=「-」;否则 {today|M/D}(时间: H:mm)
export function lastRunLabel(lastRunAt: number | string | null, t: Translate): string {
  const ts = typeof lastRunAt === "number" ? lastRunAt : null
  if (ts == null) return "-"
  const d = new Date(ts)
  const time = hhmm(d)
  const diff = dayDiff(new Date(), d)
  if (diff <= 0) return atTime(t, t("automation.nextRun.today"), time)
  return atTime(t, `${d.getMonth() + 1}/${d.getDate()}`, time)
}
