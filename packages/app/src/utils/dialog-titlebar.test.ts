import { describe, expect, test } from "bun:test"
import { mixWithBlack, resolveDialogTitlebarChrome } from "./dialog-titlebar"

describe("mixWithBlack", () => {
  test("按 alpha 与黑色混合", () => {
    expect(mixWithBlack("#ffffff", 0.2)).toBe("rgb(204, 204, 204)")
    expect(mixWithBlack("rgb(255, 255, 255)", 0.5)).toBe("rgb(128, 128, 128)")
  })
})

describe("resolveDialogTitlebarChrome", () => {
  const base = {
    themeId: "wanlai-theme" as string | undefined,
    desktopOs: "windows" as string | undefined,
    windowsBackdrop: "mica" as string | undefined,
    backgroundColor: "#ffffff",
    colorScheme: "light" as const,
  }

  test("wanlai + mica + Dialog 打开：保持 glass，不压暗（防侧栏闪烁）", () => {
    const next = resolveDialogTitlebarChrome({ ...base, active: true })
    expect(next.skipDialogDim).toBe(true)
    expect(next.glass).toBe(true)
    expect(next.backgroundColor).toBe("#ffffff")
  })

  test("非 wanlai 主题 + Dialog 打开：关闭 glass，压暗 caption", () => {
    // 守住审查回归：不能因修 Mica 闪烁而丢掉其它主题的原生按钮压暗。
    const next = resolveDialogTitlebarChrome({
      ...base,
      active: true,
      themeId: "oc-dark",
      windowsBackdrop: "none",
    })
    expect(next.skipDialogDim).toBe(false)
    expect(next.glass).toBe(false)
    expect(next.backgroundColor).toBe("rgb(204, 204, 204)")
  })

  test("wanlai + Win10/无 Mica + Dialog 打开：仍压暗 caption", () => {
    const next = resolveDialogTitlebarChrome({
      ...base,
      active: true,
      windowsBackdrop: "none",
    })
    expect(next.skipDialogDim).toBe(false)
    expect(next.glass).toBe(false)
    expect(next.backgroundColor).toBe("rgb(204, 204, 204)")
  })

  test("Dialog 关闭时 wanlai + mica：glass 开启且不压暗", () => {
    const next = resolveDialogTitlebarChrome({ ...base, active: false })
    expect(next.skipDialogDim).toBe(false)
    expect(next.glass).toBe(true)
    expect(next.backgroundColor).toBe("#ffffff")
  })

  test("暗色方案 Dialog 压暗使用 0.5 alpha", () => {
    const next = resolveDialogTitlebarChrome({
      ...base,
      active: true,
      themeId: "oc-dark",
      windowsBackdrop: "none",
      colorScheme: "dark",
      backgroundColor: "#ffffff",
    })
    expect(next.backgroundColor).toBe("rgb(128, 128, 128)")
  })
})
