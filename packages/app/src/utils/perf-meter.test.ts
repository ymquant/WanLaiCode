import { describe, expect, test } from "bun:test"
import { createPerfMeter, PERF_REPORT_EVENT } from "./perf-meter"

describe("createPerfMeter", () => {
  test("stays silent when disabled", () => {
    const reports: unknown[] = []
    const meter = createPerfMeter("test", {
      enabled: false,
      report: (_scope, row) => reports.push(row),
    })

    meter.count("event")
    meter.observe("duration_ms", 3)
    meter.close()

    expect(reports).toEqual([])
  })

  test("reports count and sample summaries when flushed", () => {
    const reports: unknown[] = []
    let at = 100
    const meter = createPerfMeter("test", {
      enabled: true,
      now: () => at,
      report: (_scope, row) => reports.push(row),
    })

    meter.count("event", 2)
    meter.observe("duration_ms", 3)
    meter.observe("duration_ms", 7)
    at = 150
    meter.close()

    expect(reports).toEqual([
      {
        window_ms: 50,
        event_count: 2,
        duration_ms_avg: 5,
        duration_ms_max: 7,
      },
    ])
  })

  test("publishes reports to browser listeners", () => {
    if (typeof window === "undefined") return

    const reports: unknown[] = []
    const listener = (event: Event) => reports.push((event as CustomEvent).detail)
    let at = 100

    window.addEventListener(PERF_REPORT_EVENT, listener)
    const meter = createPerfMeter("test", {
      enabled: true,
      now: () => at,
      report: () => {},
    })

    meter.count("event")
    at = 125
    meter.close()
    window.removeEventListener(PERF_REPORT_EVENT, listener)

    expect(reports).toEqual([
      {
        scope: "test",
        row: {
          window_ms: 25,
          event_count: 1,
        },
      },
    ])
  })
})
