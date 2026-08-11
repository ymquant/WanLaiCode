import { describe, expect, test } from "bun:test"

// 消息流的「DOM 稳定性」不变量：
// 浏览器滚动锚定依赖锚点元素持续存在。任何在流式结束瞬间销毁重建大段 DOM 的写法，
// 都会让锚点消失、补偿失效，正在向上滚动阅读的用户被直接顶飞。
describe("message part DOM stability", () => {
  const source = () => Bun.file(new URL("./message-part.tsx", import.meta.url)).text()

  test("never swaps between PacedMarkdown and Markdown on streaming state", async () => {
    const text = await source()

    // PacedMarkdown 在 streaming=false 时由 createPacedValue 立即同步完整文本，
    // 与直接渲染 Markdown 等价，因此必须常驻，不能用 Show/fallback 切换。
    expect(text).not.toContain("when={streaming()}")

    // 正文与思考两处都必须把 streaming 作为 prop 传给常驻的 PacedMarkdown
    const pacedUsages = text.match(/<PacedMarkdown\b/g) ?? []
    expect(pacedUsages.length).toBe(2)
    expect(text).toContain("streaming={streaming()}")
  })

  test("createPacedValue still syncs full text when not live", async () => {
    const text = await source()

    // 上面那条不变量成立的前提：非 live 时立即 sync 完整文本。
    // 若这段逻辑被改动，常驻 PacedMarkdown 就不再等价于 Markdown。
    const paced = text.slice(text.indexOf("const run = ()"), text.indexOf("function PacedMarkdown"))
    expect(paced).toContain("if (!live?.()) {")
    expect(paced).toContain("sync(text)")
  })

  test("reports final markdown only after its DOM update reaches a paint", async () => {
    const text = await source()
    const markdown = await Bun.file(new URL("./markdown.tsx", import.meta.url)).text()

    // 后端终态和最终 Markdown 的异步解析不是同一个提交点；必须由渲染器在 DOM 更新并经过一帧绘制后确认，
    // 否则 SessionTurn 会先折叠“处理中”，用户随后才看到最后一批正文，形成短暂空状态。
    expect(text).toContain("onRenderSettled?: (text: string) => void")
    expect(markdown).toContain("requestAnimationFrame(() => {")
    // 单次 rAF 仍在绘制前；必须存在第二帧，确保用户至少看见一帧完整正文与运行态共存。
    expect(markdown).toContain("settledPaintFrame = requestAnimationFrame(() => {")
    expect(markdown).toContain("local.onRenderSettled?.(renderedText)")
    expect(text).toContain("onTextRendered?: (input: { partID: string; text: string }) => void")
    // 绘制确认必须透传 Markdown 当次真正提交的版本；异步回调时重新读取 part() 会把尚未绘制的迟到 delta
    // 冒充成已绘制版本，导致“处理中”与最终正文在同一帧一起消失/出现。
    expect(text).toContain("onRenderSettled={(renderedText) =>")
    expect(text).toContain("props.onTextRendered?.({ partID: part().id, text: renderedText })")
    expect(text).not.toContain('onRenderSettled={() => props.onTextRendered?.({ partID: part().id, text: part().text ?? "" })}')
  })
})
