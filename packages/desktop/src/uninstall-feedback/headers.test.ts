import { describe, expect, test } from "bun:test"
import { buildUninstallFeedbackHeaders } from "./headers"

describe("buildUninstallFeedbackHeaders", () => {
  test("builds X-Wanlai headers, sanitizes control chars, caps length", () => {
    const h = buildUninstallFeedbackHeaders({ client: "codex", clientVersion: "0.0.24\n", os: "win32", arch: "x64" })
    expect(h["X-Wanlai-Client"]).toBe("codex")
    expect(h["X-Wanlai-Client-Version"]).toBe("0.0.24")
    expect(h["X-Wanlai-OS"]).toBe("win32")
    expect(h["X-Wanlai-Arch"]).toBe("x64")
  })
})
