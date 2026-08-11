import { describe, expect, test } from "bun:test"
import { ensureTerminalTextContrast, getContrastRatio } from "./terminal"

describe("ensureTerminalTextContrast", () => {
  test("keeps bright yellow when it already passes contrast on dark terminal backgrounds", () => {
    const brightYellow = ensureTerminalTextContrast({
      background: "#191515",
      preferred: "#d9a441",
      fallback: "#d9a441",
    })

    expect(brightYellow).toBe("#d9a441")
    expect(getContrastRatio(brightYellow, "#191515")).toBeGreaterThanOrEqual(4.5)
  })

  test("falls back to a darker amber for light terminal backgrounds", () => {
    const brightYellow = ensureTerminalTextContrast({
      background: "rgb(252, 252, 252)",
      preferred: "#FFC508",
      fallback: "#9a6700",
    })

    expect(brightYellow).toBe("#9a6700")
    expect(getContrastRatio("#FFC508", "rgb(252, 252, 252)")).toBeLessThan(4.5)
    expect(getContrastRatio(brightYellow, "rgb(252, 252, 252)")).toBeGreaterThanOrEqual(4.5)
  })

  test("uses the same darker amber fallback for light-theme yellow number highlighting", () => {
    const yellow = ensureTerminalTextContrast({
      background: "#ffffff",
      preferred: "#FFC508",
      fallback: "#9a6700",
    })

    expect(yellow).toBe("#9a6700")
    expect(getContrastRatio(yellow, "#ffffff")).toBeGreaterThanOrEqual(4.5)
  })

  test("falls back from white ansi text to readable foreground on light terminal backgrounds", () => {
    const white = ensureTerminalTextContrast({
      background: "#ffffff",
      preferred: "#ffffff",
      fallback: "#211e1e",
    })

    expect(white).toBe("#211e1e")
    expect(getContrastRatio(white, "#ffffff")).toBeGreaterThanOrEqual(4.5)
  })
})
