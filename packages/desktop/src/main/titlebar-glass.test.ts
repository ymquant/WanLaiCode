import { describe, expect, test } from "bun:test"
import { resolveTitlebarWindowBackground, useGlassTitlebar } from "./titlebar-glass"

describe("useGlassTitlebar", () => {
  test("glass=true + mica → glass titlebar", () => {
    expect(useGlassTitlebar({ glass: true }, "mica")).toBe(true)
  })

  test("glass=false + mica → 非 glass（禁止因系统 Mica 强制透明）", () => {
    // 守住审查回归：非 wanlai / 登录窗路径传 glass=false 时不得走透明底。
    expect(useGlassTitlebar({ glass: false }, "mica")).toBe(false)
  })

  test("glass 缺省 + mica → 非 glass", () => {
    expect(useGlassTitlebar({}, "mica")).toBe(false)
  })

  test("glass=true + none → 非 glass（无 Mica 能力时不透明）", () => {
    expect(useGlassTitlebar({ glass: true }, "none")).toBe(false)
  })
})

describe("resolveTitlebarWindowBackground", () => {
  test("glass+mica 返回透明底", () => {
    expect(resolveTitlebarWindowBackground({ glass: true, backgroundColor: "#f6f6f6" }, "mica")).toBe(
      "#00000000",
    )
  })

  test("glass=false + mica 仍返回主题实色", () => {
    expect(
      resolveTitlebarWindowBackground({ glass: false, backgroundColor: "rgb(204, 204, 204)" }, "mica"),
    ).toBe("rgb(204, 204, 204)")
  })

  test("无 backgroundColor 且非 glass 时返回 undefined", () => {
    expect(resolveTitlebarWindowBackground({ glass: false }, "mica")).toBeUndefined()
  })
})
