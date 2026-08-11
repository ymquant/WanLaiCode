import { describe, expect, test } from "bun:test"
import { FileIgnore } from "./ignore"

describe("watcherPatterns", () => {
  test("保留裸目录名（根级字面路径忽略，所有后端可靠）", () => {
    const patterns = FileIgnore.watcherPatterns()
    expect(patterns).toContain("node_modules")
    expect(patterns).toContain("target")
    expect(patterns).toContain(".vs")
  })

  test("追加 **/name 与 **/name/** 两条 glob 覆盖任意深度嵌套目录及其内容", () => {
    const patterns = FileIgnore.watcherPatterns()
    for (const folder of ["node_modules", "target", "dist", "build", ".vs"]) {
      expect(patterns).toContain(`**/${folder}`)
      expect(patterns).toContain(`**/${folder}/**`)
    }
  })

  test("保留 FILES 里已有的 glob", () => {
    const patterns = FileIgnore.watcherPatterns()
    expect(patterns).toContain("**/*.log")
    expect(patterns).toContain("**/coverage/**")
  })

  test("是 PATTERNS 的超集（永不劣于基线）", () => {
    const patterns = new Set(FileIgnore.watcherPatterns())
    for (const p of FileIgnore.PATTERNS) expect(patterns.has(p)).toBe(true)
  })
})

describe("match 仍按路径分段忽略嵌套目录", () => {
  test("嵌套 node_modules / target 被忽略", () => {
    expect(FileIgnore.match("packages/foo/node_modules/bar.js")).toBe(true)
    expect(FileIgnore.match("crates/foo/target/debug/x.rlib")).toBe(true)
    expect(FileIgnore.match(".vs/Proj/x.db")).toBe(true)
  })
  test("普通源码文件不被忽略", () => {
    expect(FileIgnore.match("packages/foo/src/index.ts")).toBe(false)
  })
})
