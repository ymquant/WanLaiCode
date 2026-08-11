import { describe, expect, test } from "bun:test"
import { formatServerError, isCancellation } from "./server-errors"

describe("formatServerError", () => {
  test("formats object errors without returning [object Object]", () => {
    expect(formatServerError({ error: { message: "Invalid API key" } })).toBe("Invalid API key")
    expect(formatServerError({ message: { detail: "bad" } }, undefined, "Request failed")).toBe("Request failed")
  })

  test("extracts NamedError.toObject() shape: { name, data: { message } }", () => {
    expect(
      formatServerError({
        name: "VcsCreateBranchFailedError",
        data: { message: "Branch 'codex/test1' already exists" },
      }),
    ).toBe("Branch 'codex/test1' already exists")
  })

  test("unwraps SDK-wrapped NamedError: { error: { name, data: { message } } }", () => {
    expect(
      formatServerError({
        error: { name: "Unknown", data: { message: "fatal: not a valid object name HEAD" } },
      }),
    ).toBe("fatal: not a valid object name HEAD")
  })

  test("prefers data.message over sibling top-level message", () => {
    expect(
      formatServerError({
        name: "Foo",
        data: { message: "from data" },
        message: "from top",
      }),
    ).toBe("from data")
  })

  test("含 stack/文件路径特征的 message 不原样返回，降级通用文案", () => {
    const tr = (k: string) => (k === "error.chain.unknown" ? "出错了" : k)
    const err = new Error(
      "SyntaxError: Unexpected end of JSON input\n  at JSON.parse (<anonymous>)\n  at file:///D:/x/app.asar/out/main/chunks/node-DO4OQJ46.js:1:1",
    )
    const out = formatServerError(err, tr)
    expect(out).toBe("出错了")
    expect(out).not.toContain("app.asar")
    expect(out).not.toContain(".js:")
  })

  test("translates known VCS generate error messages", () => {
    const tr = (k: string) =>
      ({
        "dialog.gitGenerate.error.noChanges": "没有可总结的更改",
        "dialog.gitGenerate.error.generic": "生成内容失败",
      })[k] ?? k
    expect(formatServerError(new Error("No changes to summarize"), tr)).toBe("没有可总结的更改")
    expect(formatServerError({ data: { message: "Failed to generate content" } }, tr)).toBe("生成内容失败")
  })

  test("普通单行 message 仍原样返回", () => {
    const out = formatServerError(new Error("Model not available"))
    expect(out).toBe("Model not available")
  })
})

describe("isCancellation", () => {
  test("识别 499 / empty response body / AbortError", () => {
    expect(isCancellation(new Error("opencode server GET /x → 499: (empty response body)"))).toBe(true)
    expect(isCancellation(new Error("The operation was aborted"))).toBe(true)
    const abort = new Error("aborted")
    abort.name = "AbortError"
    expect(isCancellation(abort)).toBe(true)
  })
  test("普通错误不算取消", () => {
    expect(isCancellation(new Error("Model not available"))).toBe(false)
  })
})
