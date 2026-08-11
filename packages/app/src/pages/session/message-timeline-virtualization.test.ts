import { describe, expect, test } from "bun:test"

// contain-intrinsic-size: auto 的「last remembered size」只在元素已经带着该属性渲染过时
// 才会被记录。活跃轮没有这两个属性，回合结束瞬间切换过去时浏览器没有可用的记忆尺寸，
// 只能用兜底值 —— 长回合真实高度可达几千 px，会当场塌陷，把用户的阅读位置顶走。
// 推迟到「不再是最新轮」靠的是时机而非提前记住尺寸：那一刻由用户发下一条消息触发，
// 视口已被跟随钉在底部、该轮仍与视口相交，于是在同一次布局里完成渲染与尺寸记录。
describe("message timeline virtualization", () => {
  test("keeps the latest turn out of content-visibility even after it finishes", async () => {
    const source = await Bun.file(new URL("./message-timeline.tsx", import.meta.url)).text()
    const anchorSource = await Bun.file(new URL("./timeline-turn-anchor.tsx", import.meta.url)).text()

    // 虚拟化样式已经下沉到真实 DOM 锚点组件；测试必须跟随生产职责边界，不能继续读取旧宿主文件。
    expect(anchorSource).toContain('"content-visibility": props.active || props.latest ? undefined : "auto"')
    expect(anchorSource).toContain(
      '"contain-intrinsic-size": props.active || props.latest ? undefined : "auto 500px"',
    )
    // 聚合后的列表行以 turnID 为身份，最新轮判断必须读取可能因分页回填而变化的根消息 accessor。
    expect(source).toContain("const isLatestTurn = createMemo(() => lastRenderedUserMessageID() === messageID())")
  })

  test("keeps retry status anchored to the original assistant turn", async () => {
    const source = await Bun.file(new URL("./message-timeline.tsx", import.meta.url)).text()

    // 失败 attempt 的 step-finish 不能移走活动锚点，否则 retry 文案会从原用户消息下方消失。
    expect(source).toContain('if (sessionStatus().type === "retry") return last')
  })

  test("hands confirmed scroll gestures to the user-priority auto-scroll path", async () => {
    const source = await Bun.file(new URL("./message-timeline.tsx", import.meta.url)).text()
    const scrollHandler = source.slice(
      source.indexOf("onScroll={(e) => {"),
      source.indexOf("onClick={props.onAutoScrollInteraction}"),
    )

    // onScroll 只有通过手势时间窗后才进入这里；此时必须显式调用 user 路径，不能再按普通程序滚动处理。
    expect(scrollHandler).toContain("if (!props.hasScrollGesture()) return")
    expect(scrollHandler).toContain("props.onAutoScrollHandleUserScroll()")
    expect(scrollHandler).not.toContain("props.onAutoScrollHandleScroll()")
    // scroll 事件只能消费输入入口记录的方向，不能再用未知方向重开控制窗口并把轻微向上滚动拉回底部。
    expect(scrollHandler).not.toContain("props.onMarkScrollGesture(e.currentTarget)")
  })

  test("starts the user-control window before timeline scrolling", async () => {
    const source = await Bun.file(new URL("../session.tsx", import.meta.url)).text()
    const gesture = source.slice(
      source.indexOf("const markTimelineScrollGesture"),
      source.indexOf("let scrollStateFrame"),
    )

    // wheel/touch/拖拽的默认滚动尚未发生时就必须取消待执行的自动置底帧。
    expect(gesture).toContain("markScrollGesture(target)")
    expect(gesture).toContain("autoScroll.beginUserControl(direction)")
    expect(source).toContain("onMarkScrollGesture={markTimelineScrollGesture}")
  })

  test("keeps stronger scrollbar colors scoped to the chat timeline ScrollView", async () => {
    const source = await Bun.file(new URL("./message-timeline.tsx", import.meta.url)).text()

    expect(source).toContain('"--scroll-view-thumb-color": "color-mix(in srgb, var(--text-strong) 54%, transparent)"')
    expect(source).toContain('"--scroll-view-thumb-active-color":')
    expect(source).toContain('"--scroll-view-thumb-dark-color": "var(--text-weak)"')
    expect(source).toContain('"--scroll-view-thumb-active-dark-color": "color-mix(in srgb, var(--text-strong) 68%, transparent)"')
    expect(source).not.toContain(':root[data-color-scheme="dark"] .scroll-view')
  })

  test("keeps the macOS chat header spacer available to native window hit testing", async () => {
    const source = await Bun.file(new URL("./message-timeline.tsx", import.meta.url)).text()
    const spacer = source.slice(source.indexOf("chat header 末尾的 drag spacer"), source.indexOf("<ConversationMinimap"))

    // Electron 只有在元素参与 Chromium 命中测试时才会识别 app-region:drag；pointer-events:none 会让空白顶栏完全拖不动。
    expect(spacer).toContain('class="flex-1 min-w-0 self-stretch"')
    expect(spacer).toContain('"-webkit-app-region": "drag"')
    expect(spacer).not.toContain('class="flex-1 min-w-0 self-stretch pointer-events-none"')
  })
})
