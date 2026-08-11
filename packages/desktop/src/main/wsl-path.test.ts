import { beforeEach, describe, expect, mock, test } from "bun:test"

const execFileSync = mock((_cmd: string, args: string[]) => Buffer.from(args.at(-1) ?? ""))

mock.module("node:child_process", () => ({
  execFile: () => {},
  execFileSync,
}))

const { wslPath } = await import("./wsl-path")

describe("wslPath", () => {
  beforeEach(() => {
    execFileSync.mockClear()
  })

  test("passes tilde paths as wslpath argv without shell", () => {
    if (process.platform !== "win32") return
    expect(wslPath("~\"; calc; #", "windows")).toBe("~\"; calc; #")
    expect(execFileSync).toHaveBeenCalledWith("wsl", ["-e", "wslpath", "-w", "~\"; calc; #"])
  })

  test("rejects control characters", () => {
    if (process.platform !== "win32") return
    expect(() => wslPath("bad\npath", "windows")).toThrow("Invalid path")
    expect(execFileSync).not.toHaveBeenCalled()
  })
})
