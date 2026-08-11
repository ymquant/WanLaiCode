export type PerfReport = Record<string, number | string>

type PerfMeterOptions = {
  enabled?: boolean
  intervalMs?: number
  now?: () => number
  report?: (scope: string, row: PerfReport) => void
}

const PERF_KEY = "wanlaicode:perf"
export const PERF_REPORT_EVENT = "wanlaicode:perf-report"

const storageValue = () => {
  if (typeof localStorage === "undefined") return
  try {
    return localStorage.getItem(PERF_KEY) ?? undefined
  } catch {
    return
  }
}

const queryValue = () => {
  if (typeof location === "undefined") return
  return new URLSearchParams(location.search).get("perf") ?? undefined
}

const enabledBy = (value: string | undefined, scope: string) => {
  if (!value) return false
  if (value === "1" || value === "true" || value === "*") return true
  return value
    .split(",")
    .map((item) => item.trim())
    .includes(scope)
}

export const isPerfMeterEnabled = (scope: string) => enabledBy(storageValue(), scope) || enabledBy(queryValue(), scope)

const publishReport = (scope: string, row: PerfReport) => {
  if (typeof window === "undefined") return
  if (typeof CustomEvent === "undefined") return
  window.dispatchEvent(new CustomEvent(PERF_REPORT_EVENT, { detail: { scope, row } }))
}

export function createPerfMeter(scope: string, options: PerfMeterOptions = {}) {
  const enabled = options.enabled ?? isPerfMeterEnabled(scope)
  const now =
    options.now ??
    (() => {
      if (typeof performance !== "undefined") return performance.now()
      return Date.now()
    })
  const report =
    options.report ??
    ((name: string, row: PerfReport) => {
      console.debug(`[perf:${name}]`, row)
    })

  let counts: Record<string, number> = {}
  let samples: Record<string, { count: number; max: number; sum: number }> = {}
  let last = now()
  let dirty = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const reset = (at: number) => {
    counts = {}
    samples = {}
    last = at
    dirty = false
  }

  const flush = () => {
    if (!enabled) return
    if (timer) clearTimeout(timer)
    timer = undefined
    if (!dirty) return

    const at = now()
    const row = {
      window_ms: Math.round(at - last),
      ...Object.fromEntries(Object.entries(counts).map(([key, value]) => [`${key}_count`, value])),
      ...Object.fromEntries(
        Object.entries(samples).flatMap(([key, value]) => [
          [`${key}_avg`, Math.round((value.sum / value.count) * 100) / 100],
          [`${key}_max`, Math.round(value.max * 100) / 100],
        ]),
      ),
    }
    report(scope, row)
    publishReport(scope, row)
    reset(at)
  }

  const schedule = () => {
    if (!enabled) return
    if (timer) return
    timer = setTimeout(flush, options.intervalMs ?? 1_000)
  }

  const count = (key: string, value = 1) => {
    if (!enabled) return
    counts[key] = (counts[key] ?? 0) + value
    dirty = true
    schedule()
  }

  const observe = (key: string, value: number) => {
    if (!enabled) return
    const sample = samples[key]
    samples[key] = sample
      ? { count: sample.count + 1, max: Math.max(sample.max, value), sum: sample.sum + value }
      : { count: 1, max: value, sum: value }
    dirty = true
    schedule()
  }

  const mark = (name: string) => {
    if (!enabled) return
    if (typeof performance === "undefined") return
    performance.mark?.(`wanlaicode:${scope}:${name}`)
  }

  const close = () => {
    flush()
  }

  return { enabled, count, observe, mark, close }
}
