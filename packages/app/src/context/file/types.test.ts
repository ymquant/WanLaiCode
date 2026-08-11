import { describe, expect, test } from "bun:test"
import { applyFileLoadError, type FileState } from "./types"

describe("file load state", () => {
  test("成功加载后再次读取失败会清除旧内容并允许重试", () => {
    const state: FileState = {
      path: "src/example.ts",
      name: "example.ts",
      loaded: true,
      loading: true,
      content: { type: "text", content: "旧内容" },
    }

    applyFileLoadError(state, "文件不存在")

    expect(state).toEqual({
      path: "src/example.ts",
      name: "example.ts",
      loaded: false,
      loading: false,
      content: undefined,
      error: "文件不存在",
    })
  })
})
