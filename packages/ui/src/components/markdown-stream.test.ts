import { describe, expect, test } from "bun:test"
import { marked } from "marked"
import { createMarkdownStream, stream } from "./markdown-stream"

describe("markdown stream", () => {
  test("heals incomplete emphasis while streaming", () => {
    expect(stream("hello **world", true)).toEqual([{ raw: "hello **world", src: "hello **world**", mode: "live" }])
    expect(stream("say `code", true)).toEqual([{ raw: "say `code", src: "say `code`", mode: "live" }])
  })

  test("keeps incomplete links non-clickable until they finish", () => {
    expect(stream("see [docs](https://example.com/gu", true)).toEqual([
      { raw: "see [docs](https://example.com/gu", src: "see docs", mode: "live" },
    ])
  })

  test("splits an unfinished trailing code fence from stable content", () => {
    expect(stream("before\n\n```ts\nconst x = 1", true)).toEqual([
      // 代码围栏之前的完整段落已经不会被后续字符改变，应进入稳定缓存。
      { raw: "before\n\n", src: "before\n\n", mode: "full" },
      { raw: "```ts\nconst x = 1", src: "```ts\nconst x = 1", mode: "live" },
    ])
  })

  test("only reparses the growing tail after a stable block is formed", () => {
    const update = createMarkdownStream()
    const first = update("first paragraph\n\nsecond para", true)
    const next = update("first paragraph\n\nsecond paragraph grows", true)

    // 第一段的 raw/src/mode 在后续 token 到达时保持不变，解析层可直接命中块缓存。
    expect(first[0]).toEqual({ raw: "first paragraph\n\n", src: "first paragraph\n\n", mode: "full" })
    expect(next[0]).toEqual(first[0])
    expect(next.at(-1)?.raw).toBe("second paragraph grows")
    expect(next.map((block) => block.raw).join("")).toBe("first paragraph\n\nsecond paragraph grows")
  })

  test("keeps incremental blocks when streaming completes", () => {
    const update = createMarkdownStream()
    const text = "first paragraph\n\nsecond paragraph"
    update(text, true)
    const completed = update(text, false)

    // 结束态只合并最后一个活动块，不退回整篇一次性重解析。
    expect(completed.every((block) => block.mode === "full")).toBe(true)
    expect(completed.map((block) => block.raw).join("")).toBe(text)
  })

  test("preserves top-level markdown semantics across stable chunks", async () => {
    const text =
      "# Heading\n\nParagraph with **bold**.\n\n- first\n- second\n\n> quote\n> continued\n\n```ts\nconst value = 1\n```\n\nFinal paragraph."
    const blocks = createMarkdownStream()(text, true)

    // 稳定块只在 marked 的顶层 token 边界拆分，拼接后的 HTML 必须与整篇解析一致。
    expect((await Promise.all(blocks.map((block) => marked.parse(block.src)))).join("")).toBe(await marked.parse(text))
  })

  test.each([
    ["ordered", "Steps:\n\n1. build\n2. test\n3. ship\n"],
    ["unordered", "Tasks:\n\n- build\n- test\n- ship\n"],
    ["nested", "Plan:\n\n1. build\n   - unit\n   - integration\n2. ship\n"],
  ])("preserves %s list source across incremental chunks", async (_name, text) => {
    const update = createMarkdownStream()

    // 逐字符覆盖真实揭示边界；每一步重建源都必须等于当前原文，不能把 marked 规范化后的 token.raw 带入下一轮。
    for (let end = 1; end <= text.length; end++) {
      const current = text.slice(0, end)
      expect(
        update(current, true)
          .map((block) => block.raw)
          .join(""),
      ).toBe(current)
    }

    const completed = update(text, false)
    expect(completed.map((block) => block.raw).join("")).toBe(text)
    expect((await Promise.all(completed.map((block) => marked.parse(block.src)))).join("")).toBe(
      await marked.parse(text),
    )
  })

  test("groups long prose into bounded cache chunks", () => {
    const text = Array.from({ length: 500 }, (_, index) => `Paragraph ${index}.\n\n`).join("")
    const blocks = createMarkdownStream()(text, true)

    // 不能退化成每个段落一个缓存项；稳定前缀按 2 KiB 聚合，最后只保留一个活动尾块。
    expect(blocks.length).toBeLessThan(8)
    // 普通短段落组成的可变稳定块必须受 2 KiB 上限约束，避免块封口时批量重挂载过多 DOM。
    expect(Math.max(...blocks.slice(0, -1).map((block) => block.raw.length))).toBeLessThanOrEqual(2 * 1024)
    expect(blocks.map((block) => block.raw).join("")).toBe(text)
  })

  test("keeps reference-style markdown as one block", () => {
    expect(stream("[docs][1]\n\n[1]: https://example.com", true)).toEqual([
      {
        raw: "[docs][1]\n\n[1]: https://example.com",
        src: "[docs][1]\n\n[1]: https://example.com",
        mode: "live",
      },
    ])
  })
})
