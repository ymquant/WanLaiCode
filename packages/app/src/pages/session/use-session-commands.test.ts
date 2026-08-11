import { describe, expect, test } from "bun:test"
import { goalSlashAliasesForLocale, goalSlashForLocale } from "./goal-slash"

describe("goalSlashForLocale", () => {
  test("uses the current display language as the primary slash", () => {
    expect(goalSlashForLocale("zh")).toBe("目标")
    expect(goalSlashForLocale("zht")).toBe("目標")
    expect(goalSlashForLocale("en")).toBe("goal")
    expect(goalSlashForLocale("ja")).toBe("目標")
    expect(goalSlashForLocale("de")).toBe("ziel")
  })

  test("keeps Chinese and English aliases available across locales", () => {
    expect(goalSlashAliasesForLocale("zh")).toEqual(["goal", "目標"])
    expect(goalSlashAliasesForLocale("en")).toEqual(["目标", "目標"])
    expect(goalSlashAliasesForLocale("de")).toEqual(["goal", "目标", "目標"])
  })
})
