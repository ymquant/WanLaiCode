import { describe, expect, test } from "bun:test"
import {
  findPromptLinkMatches,
  normalizePromptHref,
  serializePromptLink,
  stripFileLocationSuffix,
} from "./prompt-links"

describe("prompt markdown references", () => {
  test("区分网页链接和本地文件引用", () => {
    const text =
      "PR: [#515](https://github.com/ymquant/wanlaicodex/pull/515) 文件: [prompt-input.tsx](/repo/packages/app/src/components/prompt-input.tsx:2180)"
    expect(findPromptLinkMatches(text).map((item) => ({ kind: item.kind, text: item.displayText, href: item.href }))).toEqual([
      {
        kind: "link",
        text: "#515",
        href: "https://github.com/ymquant/wanlaicodex/pull/515",
      },
      {
        kind: "file",
        text: "prompt-input.tsx",
        href: "/repo/packages/app/src/components/prompt-input.tsx:2180",
      },
    ])
  })

  test("忽略插件协议并保留带括号的 URL", () => {
    const text = "[@插件](plugin://demo) [文档](https://example.com/a_(draft))"
    expect(findPromptLinkMatches(text)).toEqual([
      {
        start: 21,
        end: 56,
        displayText: "文档",
        href: "https://example.com/a_(draft)",
        kind: "link",
      },
    ])
  })

  test("识别裸 URL 并保留纯文本提交形式", () => {
    expect(findPromptLinkMatches("查看 https://127.0.0.1:5173/ 以及 www.example.com/docs。")).toEqual([
      {
        start: 3,
        end: 26,
        displayText: "https://127.0.0.1:5173/",
        href: "https://127.0.0.1:5173/",
        kind: "link",
        plain: true,
      },
      {
        start: 30,
        end: 50,
        displayText: "www.example.com/docs",
        href: "www.example.com/docs",
        kind: "link",
        plain: true,
      },
    ])
  })

  test("root-relative 与协议相对地址保持网页链接语义", () => {
    const text = "[Docs](/docs) [设置](/settings/profile) [资源](/assets/app.js) [CDN](//cdn.example.com/app.js)"

    // 四类地址都会经过同一 DOM 节点链路；这里锁定入口分类，后续恢复和提交不能再生成 file-reference。
    expect(findPromptLinkMatches(text).map((item) => ({ kind: item.kind, href: item.href }))).toEqual([
      { kind: "link", href: "/docs" },
      { kind: "link", href: "/settings/profile" },
      { kind: "link", href: "/assets/app.js" },
      { kind: "link", href: "//cdn.example.com/app.js" },
    ])
    expect(normalizePromptHref(" /docs ")).toBe("/docs")
    expect(normalizePromptHref("//cdn.example.com/app.js")).toBe("https://cdn.example.com/app.js")
  })

  test("可信 POSIX 根与行号路径仍按本地文件处理", () => {
    const text = "[用户文件](/Users/developer/project/README.md) [仓库文件](/repo/src/main.ts:12) [挂载文件](/mnt/output.log)"

    // 修复站内链接时保留本 PR 的绝对文件能力，避免两个交互目标互相回归。
    expect(findPromptLinkMatches(text).map((item) => ({ kind: item.kind, href: item.href }))).toEqual([
      { kind: "file", href: "/Users/developer/project/README.md" },
      { kind: "file", href: "/repo/src/main.ts:12" },
      { kind: "file", href: "/mnt/output.log" },
    ])
  })

  test("编辑后仍能还原 Markdown，并移除文件行号后缀", () => {
    expect(serializePromptLink("新的标题", "https://example.com/docs")).toBe("[新的标题](https://example.com/docs)")
    expect(stripFileLocationSuffix("/repo/src/main.ts:12:4")).toBe("/repo/src/main.ts")
    expect(stripFileLocationSuffix("/repo/src/main.ts#L12-L15")).toBe("/repo/src/main.ts")
  })
})
