import { describe, expect, test } from "bun:test"
import { canShellOwnTitle, terminalTabLabel } from "./terminal-label"

const t = (key: string, vars?: Record<string, string | number | boolean>) => {
  if (key === "terminal.title.numbered") return `Terminal ${vars?.number}`
  if (key === "terminal.title") return "Terminal"
  return key
}

describe("terminalTabLabel", () => {
  test("returns custom title unchanged", () => {
    const label = terminalTabLabel({ title: "server", titleNumber: 3, t })
    expect(label).toBe("server")
  })

  test("normalizes default numbered title", () => {
    const label = terminalTabLabel({ title: "Terminal 2", titleNumber: 2, t })
    expect(label).toBe("Terminal 2")
  })

  test("uses project name for default numbered title", () => {
    const label = terminalTabLabel({ title: "Terminal 2", titleNumber: 2, projectName: "wanlaicodex", t })
    expect(label).toBe("wanlaicodex 2")
  })

  test("uses project name for shell-owned terminal title", () => {
    const label = terminalTabLabel({ title: "bash", titleNumber: 2, projectName: "wanlaicodex", shellOwnsTitle: true, t })
    expect(label).toBe("wanlaicodex 2")
  })

  test("keeps non-shell custom terminal title", () => {
    const label = terminalTabLabel({
      title: "server",
      titleNumber: 3,
      projectName: "wanlaicodex",
      shellOwnsTitle: false,
      t,
    })
    expect(label).toBe("server")
  })

  test("keeps legacy custom terminal title", () => {
    const label = terminalTabLabel({ title: "server", titleNumber: 3, projectName: "wanlaicodex", t })
    expect(label).toBe("server")
  })

  test("falls back to generic title", () => {
    const label = terminalTabLabel({ title: "", titleNumber: 0, t })
    expect(label).toBe("Terminal")
  })
})

describe("terminal title ownership", () => {
  test("rejects shell title updates when shell does not own title", () => {
    expect(canShellOwnTitle({ shellOwnsTitle: false })).toBe(false)
  })

  test("accepts shell title updates when shell owns title", () => {
    expect(canShellOwnTitle({ shellOwnsTitle: true })).toBe(true)
  })
})
