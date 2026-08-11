import { describe, expect, test } from "bun:test"
import { relativeTimeUnit } from "./relative-time"

describe("relativeTimeUnit", () => {
  const now = Date.UTC(2026, 4, 6, 12, 0, 0)

  test("< 1 分钟 → now", () => {
    expect(relativeTimeUnit(now - 30 * 1000, now)).toEqual({ unit: "now", value: 0 })
  })

  test("分钟级", () => {
    expect(relativeTimeUnit(now - 5 * 60 * 1000, now)).toEqual({ unit: "min", value: 5 })
  })

  test("小时级", () => {
    expect(relativeTimeUnit(now - 3 * 60 * 60 * 1000, now)).toEqual({ unit: "hour", value: 3 })
  })

  test("天级", () => {
    expect(relativeTimeUnit(now - 2 * 24 * 60 * 60 * 1000, now)).toEqual({ unit: "day", value: 2 })
  })

  test("周级", () => {
    expect(relativeTimeUnit(now - 14 * 24 * 60 * 60 * 1000, now)).toEqual({ unit: "week", value: 2 })
  })

  test("月级", () => {
    expect(relativeTimeUnit(now - 90 * 24 * 60 * 60 * 1000, now)).toEqual({ unit: "month", value: 3 })
  })

  test("年级", () => {
    expect(relativeTimeUnit(now - 730 * 24 * 60 * 60 * 1000, now)).toEqual({ unit: "year", value: 2 })
  })
})
