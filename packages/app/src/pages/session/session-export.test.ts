import { describe, expect, mock, test } from "bun:test"
import { exportSessionTranscript } from "./session-export"

describe("exportSessionTranscript", () => {
  test("does not report success or start a browser download when the desktop save is cancelled", async () => {
    const save = mock(async () => null)
    const download = mock(() => {})

    expect(await exportSessionTranscript({ filename: "session.md", content: "content", save, download })).toBe(false)
    expect(save).toHaveBeenCalledWith({ defaultPath: "session.md", content: "content" })
    expect(download).not.toHaveBeenCalled()
  })

  test("reports success after the desktop save completes", async () => {
    const save = mock(async () => "/tmp/session.md")
    const download = mock(() => {})

    expect(await exportSessionTranscript({ filename: "session.md", content: "content", save, download })).toBe(true)
    expect(download).not.toHaveBeenCalled()
  })

  test("uses the browser download fallback when native saving is unavailable", async () => {
    const download = mock(() => {})

    expect(await exportSessionTranscript({ filename: "session.md", content: "content", download })).toBe(true)
    expect(download).toHaveBeenCalledWith("session.md", "content")
  })
})
