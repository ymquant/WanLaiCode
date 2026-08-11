import { describe, expect, test } from "bun:test"
import { findPromptLinkMatches } from "@opencode-ai/core/util/prompt-link"
import { resolveUserPromptLinkTarget } from "./user-prompt-link-target"

describe("已发送用户消息链接", () => {
  test("发送后只展示文件名和 URL，不再展示 Markdown 路径原文", async () => {
    const text =
      "[session-steer-timeline.md](/Users/developer/project/docs/session-steer-timeline.md)\nhttps://github.com/ymquant/wanlaicodex/pull/531"
    const links = findPromptLinkMatches(text)

    // 解析与展示测试直接消费 core 的生产实现，锁定输入态和消息态共享的结构化结果。
    expect(links.map((item) => ({ text: item.displayText, kind: item.kind }))).toEqual([
      { text: "session-steer-timeline.md", kind: "file" },
      { text: "https://github.com/ymquant/wanlaicodex/pull/531", kind: "link" },
    ])

    const component = await Bun.file(new URL("./user-prompt-link.tsx", import.meta.url)).text()
    const messagePart = await Bun.file(new URL("./message-part.tsx", import.meta.url)).text()

    // 生产组件必须把显示文字与 href 分开，并在用户消息分段器中实际消费，避免只修解析却仍输出原文。
    expect(component).toContain('data-href={props.href}')
    expect(component).toContain('{props.text}</span>')
    expect(component).toContain('<Icon name="file-reference"')
    expect(component).toContain('<Icon name="github"')
    expect(messagePart).toContain('<UserPromptLink text={segment.text} href={segment.href} kind={segment.linkKind} />')
  })

  test("点击目标规范化网页地址并解析绝对、相对和 file URL", () => {
    // 点击解析只决定宿主回调的目标，不复制渲染层的打开逻辑。
    expect(resolveUserPromptLinkTarget({ kind: "link", href: "www.example.com/docs", directory: "/repo" })).toEqual({
      type: "external",
      value: "https://www.example.com/docs",
    })
    expect(
      resolveUserPromptLinkTarget({ kind: "file", href: "/repo/src/main.ts:12:4", directory: "/repo" }),
    ).toEqual({ type: "local", value: "/repo/src/main.ts", kind: "file" })
    expect(
      resolveUserPromptLinkTarget({ kind: "file", href: "docs/readme.md", directory: "/repo" }),
    ).toEqual({ type: "local", value: "/repo/docs/readme.md", kind: "file" })
    expect(
      resolveUserPromptLinkTarget({ kind: "file", href: "file:///repo/My%20File.md#L2", directory: "/repo" }),
    ).toEqual({ type: "local", value: "/repo/My File.md", kind: "file" })
  })

  test("特殊协议继续交给既有插件和会话引用节点", () => {
    // 普通链接解析器必须跳过内部协议，避免覆盖 HighlightedText 中已有的专用可点击组件。
    expect(
      findPromptLinkMatches(
        "[@插件](plugin://demo@market) [技能](skill://demo) [会话](chatgpt-conversation://ses_1)",
      ),
    ).toEqual([])
  })
})
