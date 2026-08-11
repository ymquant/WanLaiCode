import { expect, test } from "bun:test"
import { isLikelyLanguage } from "./language-detect"

test("中文文本 + zh-Hans → 已是目标语言（跳过翻译）", () => {
  expect(isLikelyLanguage("这是一段中文推理，分析了项目结构和入口文件。", "zh-Hans")).toBe(true)
})

test("英文文本 + zh-Hans → 非目标语言（需翻译）", () => {
  expect(isLikelyLanguage("I need to inspect the key files first.", "zh-Hans")).toBe(false)
})

test("英文文本 + en → 已是英文（跳过翻译）", () => {
  expect(isLikelyLanguage("I need to inspect the key files first.", "en")).toBe(true)
})

test("拉丁语系目标（de）→ 检测不可靠，默认需翻译", () => {
  expect(isLikelyLanguage("I need to inspect the key files first.", "de")).toBe(false)
})

test("空白文本 → 跳过翻译", () => {
  expect(isLikelyLanguage("   \n  ", "zh-Hans")).toBe(true)
})

test("繁体 tag zh-Hant 同样按汉字判断", () => {
  expect(isLikelyLanguage("這是一段繁體中文的推理內容。", "zh-Hant")).toBe(true)
})

test("韩文文本 + zh-Hans → 非中文（需翻译，回归 bug 修复）", () => {
  expect(isLikelyLanguage("이것은 한국어로 작성된 추론 텍스트입니다.", "zh-Hans")).toBe(false)
})

test("韩文文本 + ko → 已是韩文（跳过翻译）", () => {
  expect(isLikelyLanguage("이것은 한국어로 작성된 추론 텍스트입니다.", "ko")).toBe(true)
})
