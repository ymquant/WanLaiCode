import { describe, expect, test } from "bun:test"
import { HOUR_SLOTS, MINUTE_SLOTS, splitTime, joinTime } from "./schedule"

describe("schedule 时间选择(精确到分钟)", () => {
  test("HOUR_SLOTS 为 00..23 共 24 项", () => {
    expect(HOUR_SLOTS).toHaveLength(24)
    expect(HOUR_SLOTS[0]).toBe("00")
    expect(HOUR_SLOTS[9]).toBe("09")
    expect(HOUR_SLOTS[23]).toBe("23")
  })

  test("MINUTE_SLOTS 为 00..59 共 60 项,可选任意分钟而非 15 分钟刻度", () => {
    expect(MINUTE_SLOTS).toHaveLength(60)
    expect(MINUTE_SLOTS[0]).toBe("00")
    // 关键:非 15 倍数的分钟也在列表里
    expect(MINUTE_SLOTS).toContain("37")
    expect(MINUTE_SLOTS[59]).toBe("59")
  })

  test("splitTime 把 HH:MM 拆成小时/分钟,非 15 倍数分钟原样保留", () => {
    expect(splitTime("08:37")).toEqual({ hour: "08", minute: "37" })
    expect(splitTime("23:59")).toEqual({ hour: "23", minute: "59" })
  })

  test("splitTime 对非法/缺省输入安全归零", () => {
    expect(splitTime("")).toEqual({ hour: "00", minute: "00" })
    expect(splitTime("99:99")).toEqual({ hour: "23", minute: "59" })
  })

  test("joinTime 拼回 HH:MM", () => {
    expect(joinTime("08", "37")).toBe("08:37")
  })

  test("splitTime/joinTime 往返不丢失精度", () => {
    const t = "21:50"
    const { hour, minute } = splitTime(t)
    expect(joinTime(hour, minute)).toBe(t)
  })
})
