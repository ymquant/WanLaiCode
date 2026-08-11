import { describe, expect, test } from "bun:test"
import { parseInboxItem, stripInboxDirective } from "../../src/automation/inbox"
import { runContract } from "../../src/automation/message"

describe("parseInboxItem", () => {
  test("取出独立成行的指令", () => {
    const text = ['今天有三条重要新闻。', '', '::inbox-item{title="3 条 AI 新闻" summary="含两条芯片消息,建议先看第一条"}'].join(
      "\n",
    )
    expect(parseInboxItem(text)).toEqual({ title: "3 条 AI 新闻", summary: "含两条芯片消息,建议先看第一条" })
  })

  test("行首缩进也认(模型偶尔缩进)", () => {
    expect(parseInboxItem('  ::inbox-item{title="x" summary="y"}')).toEqual({ title: "x", summary: "y" })
  })

  // 对照 Codex:只有独占一行才是 leaf directive,行内出现的不算
  test("行内出现的不算", () => {
    expect(parseInboxItem('正文里提到 ::inbox-item{title="x"} 这种写法')).toBeUndefined()
  })

  test("没有指令时返回 undefined,不造兜底条目", () => {
    expect(parseInboxItem("就是一段普通回复")).toBeUndefined()
    expect(parseInboxItem("")).toBeUndefined()
  })

  // Codex 明令 DO NOT place commas between arguments,它的 mdast 解析器遇到逗号会静默丢属性。
  // 我们不走 mdast,所以有意做得更宽松:提示词仍按 Codex 要求不许用逗号,但模型真写了也能解出来
  // —— 让「摘要丢了」这种可避免的损失不发生,是改进而不是偏差。
  test("逗号分隔也能解出(比 Codex 宽松,有意为之)", () => {
    expect(parseInboxItem('::inbox-item{title="标题",summary="摘要"}')).toEqual({
      title: "标题",
      summary: "摘要",
    })
  })

  test("多条时取最后一条(模型改主意重写过)", () => {
    const text = ['::inbox-item{title="旧" summary="旧摘要"}', '::inbox-item{title="新" summary="新摘要"}'].join("\n")
    expect(parseInboxItem(text)).toEqual({ title: "新", summary: "新摘要" })
  })

  test("空属性值视为未给", () => {
    expect(parseInboxItem('::inbox-item{title="" summary="有摘要"}')).toEqual({ summary: "有摘要" })
    expect(parseInboxItem('::inbox-item{title="" summary=""}')).toBeUndefined()
  })

  test("接受 description/subtitle 作为 summary 的同义字段", () => {
    expect(parseInboxItem('::inbox-item{title="a" description="b"}')?.summary).toBe("b")
    expect(parseInboxItem('::inbox-item{title="a" subtitle="c"}')?.summary).toBe("c")
  })
})

describe("stripInboxDirective", () => {
  test("剥掉指令行并收敛空行", () => {
    const text = ['结论在此。', '', '::inbox-item{title="x" summary="y"}'].join("\n")
    expect(stripInboxDirective(text)).toBe("结论在此。")
  })

  test("指令在中间时不留空洞", () => {
    const text = ['前', '::inbox-item{title="x"}', '后'].join("\n")
    expect(stripInboxDirective(text)).toBe("前\n\n后")
  })

  test("不动行内的 :: 用法与其它指令", () => {
    expect(stripInboxDirective("看 ::inbox-item{a} 这种")).toBe("看 ::inbox-item{a} 这种")
    expect(stripInboxDirective("::other-directive{x=\"1\"}")).toBe('::other-directive{x="1"}')
  })

  test("没有指令时原样返回(仅去首尾空白)", () => {
    expect(stripInboxDirective("  普通回复  ")).toBe("普通回复")
  })
})

// 契约与解析器必须配套:契约里给模型的示例格式,解析器得认
describe("运行契约与解析器配套", () => {
  test("契约要求模型输出 ::inbox-item,且示例格式能被解析器认出", () => {
    const contract = runContract("atm_x")
    expect(contract).toContain("::inbox-item")
    const sample = contract.split("\n").find((l) => l.trim().startsWith("::inbox-item"))!
    expect(parseInboxItem(sample)).toBeDefined()
    expect(parseInboxItem(sample)?.title).toBeTruthy()
    expect(parseInboxItem(sample)?.summary).toBeTruthy()
  })

  test("契约说明这一行不会显示在正文里,剥离函数确实会剥掉它", () => {
    const sample = runContract("atm_x")
      .split("\n")
      .find((l) => l.trim().startsWith("::inbox-item"))!
    expect(stripInboxDirective(`结论。\n${sample}`)).toBe("结论。")
  })
})
