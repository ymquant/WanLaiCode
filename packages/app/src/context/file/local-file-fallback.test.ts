import { describe, expect, mock, test } from "bun:test"
import { readFileContentWithLocalFallback } from "./local-file-fallback"

describe("local file content fallback", () => {
  test("服务端拒绝工作区外绝对路径后使用桌面只读通道", async () => {
    const readLocal = mock(async () => ({ type: "text" as const, content: "const value = 1" }))

    await expect(
      readFileContentWithLocalFallback({
        path: "/Users/developer/other/highlight.test.ts",
        readWorkspace: () => Promise.reject(new Error("Access denied")),
        readLocal,
      }),
    ).resolves.toEqual({ type: "text", content: "const value = 1" })
    expect(readLocal).toHaveBeenCalledWith("/Users/developer/other/highlight.test.ts")
  })

  test("相对路径读取失败时不绕过工作区边界", async () => {
    const readLocal = mock(async () => ({ type: "text" as const, content: "private" }))
    const error = new Error("Request failed")

    await expect(
      readFileContentWithLocalFallback({
        path: "src/highlight.ts",
        readWorkspace: () => Promise.reject(error),
        readLocal,
      }),
    ).rejects.toBe(error)
    expect(readLocal).not.toHaveBeenCalled()
  })

  test("服务端成功时不重复读取本机文件", async () => {
    const readLocal = mock(async () => ({ type: "text" as const, content: "local" }))

    await expect(
      readFileContentWithLocalFallback({
        path: "C:/Users/developer/other/highlight.ts",
        readWorkspace: async () => ({ type: "text", content: "server" }),
        readLocal,
      }),
    ).resolves.toEqual({ type: "text", content: "server" })
    expect(readLocal).not.toHaveBeenCalled()
  })
})
