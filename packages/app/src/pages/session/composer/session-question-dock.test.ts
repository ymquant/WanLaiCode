import { describe, expect, test } from "bun:test"
import { questionAnswersWithSelection } from "./question-reply"

const dock = () => Bun.file(new URL("./session-question-dock.tsx", import.meta.url)).text()

describe("session question dock", () => {
  test("builds a complete answer payload for single-option submit", () => {
    const answers = questionAnswersWithSelection(["first", "second"], [["old"]], 1, ["selected"])

    expect(answers).toEqual([["old"], ["selected"]])
  })

  test("keeps the reply mutations in their own module so the panel stays under the line cap", async () => {
    const source = await dock()
    const reply = await Bun.file(new URL("./question-reply.ts", import.meta.url)).text()

    expect(source).toContain(
      'import { createQuestionReply, questionAnswersWithSelection } from "@/pages/session/composer/question-reply"',
    )
    expect(source).not.toContain("useMutation")
    expect(reply).toContain("export function questionAnswersWithSelection")
    expect(reply).toContain("mutationFn")
  })

  test("row keys only fire from the option list or the panel root", async () => {
    const source = await dock()
    const nav = source.slice(source.indexOf("const nav = "), source.indexOf("const selectOption"))

    expect(nav).toContain(`el !== root && !el.closest('[data-slot="question-options"]')`)
    expect(nav).toContain(`event.key !== "Escape"`)
    expect(nav.indexOf("resolveQuestionKey")).toBeGreaterThan(nav.indexOf("question-options"))
  })

  test("a swallowed auto repeat also loses the native button activation", async () => {
    const source = await dock()
    const nav = source.slice(source.indexOf("const nav = "), source.indexOf("const selectOption"))
    const swallowed = nav.slice(nav.indexOf('if (action.kind === "none")'), nav.indexOf("switch (action.kind)"))

    expect(swallowed).toContain("if (event.repeat) event.preventDefault()")
  })

  test("opening the custom row never writes an empty answer", async () => {
    const source = await dock()
    const open = source.slice(source.indexOf("const customOpen"), source.indexOf("const customEscape"))

    expect(open).toContain("if (input().trim()) customUpdate(input(), true)")
  })

  test("clearing the custom text drops only the answer the custom row wrote", async () => {
    const source = await dock()
    const update = source.slice(source.indexOf("const customUpdate"), source.indexOf("const clamp"))

    expect(update).toContain("current.some((item) => item.trim() === prev) ? [] : current")
  })

  test("the arrow up exit lands on a real option row", async () => {
    const source = await dock()
    const exit = source.slice(source.indexOf("const customExit"), source.indexOf("const keyState"))
    const row = await Bun.file(new URL("./question-custom-row.tsx", import.meta.url)).text()

    expect(exit).toContain("const target = options().length - 1")
    expect(exit).toContain("focus(target)")
    expect(exit).not.toContain("customOpen")
    expect(row).toContain("shouldExitCustomRow")
    expect(row).toContain("props.onExit()")
    expect(source).toContain("onExit={customExit}")
  })

  test("the custom textarea keeps an accessible name from the reused option key", async () => {
    const source = await dock()
    const row = await Bun.file(new URL("./question-custom-row.tsx", import.meta.url)).text()

    expect(source).toContain('label={language.t("ui.messagePart.option.typeOwnAnswer")}')
    expect(row).toContain("aria-label={props.label}")
  })

  test("single-question option clicks submit immediately instead of only highlighting", async () => {
    const source = await Bun.file(new URL("./session-question-dock.tsx", import.meta.url)).text()

    expect(source).toContain("if (total() === 1)")
    expect(source).toContain(
      "void reply(questionAnswersWithSelection(questions(), store.answers, store.tab, [opt.label]))",
    )
  })

  test("neither mode asks the option row for a trailing arrow", async () => {
    const source = await dock()

    expect(source).not.toContain("arrow=")
  })

  test("uses the question header as the panel title", async () => {
    const source = await Bun.file(new URL("./session-question-dock.tsx", import.meta.url)).text()

    expect(source).toContain("question()?.header")
    expect(source).toContain('data-slot="question-header-title"')
  })

  test("renders a pager with prev and next arrows instead of segments", async () => {
    const source = await Bun.file(new URL("./session-question-dock.tsx", import.meta.url)).text()

    expect(source).toContain('data-slot="question-pager"')
    expect(source).toContain('name="chevron-left"')
    expect(source).toContain('name="chevron-right"')
    expect(source).not.toContain("question-progress-segment")
  })

  test("routes keyboard events through the pure key model", async () => {
    const source = await Bun.file(new URL("./session-question-dock.tsx", import.meta.url)).text()

    expect(source).toContain("resolveQuestionKey")
    expect(source).toContain('case "customFocus"')
  })

  test("submits on plain enter without a cmd enter branch", async () => {
    const source = await Bun.file(new URL("./session-question-dock.tsx", import.meta.url)).text()

    expect(source).toContain('aria-keyshortcuts="Enter"')
    expect(source).not.toContain("Meta+Enter")
    expect(source).not.toContain("metaKey")
  })

  test("moves the custom answer row into the footer tray", async () => {
    const source = await Bun.file(new URL("./session-question-dock.tsx", import.meta.url)).text()
    const footer = source.slice(source.indexOf("footer={"), source.indexOf('data-slot="question-text-row"'))

    expect(footer).toContain("<QuestionCustomRow")
    expect(footer).toContain('data-slot="question-footer-actions"')
  })

  test("keeps the custom answer row in its own component", async () => {
    const source = await Bun.file(new URL("./session-question-dock.tsx", import.meta.url)).text()
    const row = await Bun.file(new URL("./question-custom-row.tsx", import.meta.url)).text()

    expect(source).toContain('import { QuestionCustomRow } from "@/pages/session/composer/question-custom-row"')
    expect(source).not.toContain('data-slot="question-custom-input"')
    expect(row).toContain('data-slot="question-custom"')
    expect(row).toContain('data-slot="question-custom-input"')
  })

  test("renders the multi select hint even when the question text is hidden", async () => {
    const source = await Bun.file(new URL("./session-question-dock.tsx", import.meta.url)).text()
    const row = source.slice(
      source.indexOf('<div data-slot="question-text-row">'),
      source.indexOf('<div data-slot="question-options"'),
    )

    expect(row).toContain("<Show when={showText()}>")
    expect(row.indexOf('data-slot="question-hint"')).toBeGreaterThan(row.indexOf("</Show>"))
  })

  test("only the explicit custom open turns editing on", async () => {
    const source = await Bun.file(new URL("./session-question-dock.tsx", import.meta.url)).text()
    const open = source.slice(source.indexOf("const customOpen"), source.indexOf("const customEscape"))

    expect(source).toContain("pickQuestionFocus")
    expect(source.match(/setStore\("editing", true\)/g)).toHaveLength(1)
    expect(open).toContain('setStore("editing", true)')
  })

  test("resizes the restored custom answer outside of typing", async () => {
    const row = await Bun.file(new URL("./question-custom-row.tsx", import.meta.url)).text()
    const effect = row.slice(row.indexOf("createEffect("), row.indexOf("return ("))

    expect(effect).toContain("props.value")
    expect(effect).toContain("resizeInput(field)")
  })

  test("tabbing into the custom textarea still opens editing so customOn gets set", async () => {
    const source = await Bun.file(new URL("./session-question-dock.tsx", import.meta.url)).text()
    const footer = source.slice(source.indexOf("<QuestionCustomRow"), source.indexOf("onCommit={commitCustom}"))
    const onFocus = footer.slice(footer.indexOf("onFocus={"))

    expect(onFocus).toContain("customOpen()")
  })

  test("clicking the custom row outside the textarea prevents the default focus-to-body action", async () => {
    const row = await Bun.file(new URL("./question-custom-row.tsx", import.meta.url)).text()
    const handler = row.slice(row.indexOf("onMouseDown={"), row.indexOf("onSubmit={"))

    expect(handler.match(/e\.preventDefault\(\)/g)).toHaveLength(2)
    expect(handler).toContain("e.target !== field")
  })

  test("footer no longer overlaps the option list", async () => {
    const css = await Bun.file(new URL("../../../../../ui/src/components/message-part.css", import.meta.url)).text()
    const footer = css.slice(
      css.indexOf('[data-slot="question-footer"] {'),
      css.indexOf('[data-slot="question-footer-actions"]'),
    )

    expect(footer).not.toContain("margin-top: -24px")
    expect(footer).not.toContain("z-index: 20")
    expect(footer).toContain("justify-content: space-between")
  })

  test("panel adopts the squircle radius bump when supported", async () => {
    const css = await Bun.file(new URL("../../../../../ui/src/components/message-part.css", import.meta.url)).text()

    expect(css).toContain("@supports (corner-shape: superellipse(1.5))")
  })

  test("key badges are monospaced", async () => {
    const css = await Bun.file(new URL("../../../../../ui/src/components/message-part.css", import.meta.url)).text()
    const rule = css.slice(css.indexOf('[data-slot="question-key"] {'))

    expect(rule.slice(0, 400)).toContain("var(--font-family-mono)")
  })

  test("the dark primary button stays a tinted neutral instead of a white slab", async () => {
    const css = await Bun.file(new URL("../../../../../ui/src/components/message-part.css", import.meta.url)).text()
    const dark = css.slice(css.indexOf(':root[data-color-scheme="dark"] [data-component="dock-prompt"]'))
    const rule = dark.slice(
      dark.indexOf('[data-slot="question-footer"] [data-component="button"][data-variant="primary"] {'),
      dark.indexOf('[data-slot="question-footer"] [data-component="button"]:disabled'),
    )

    expect(rule).not.toContain("background-color: #ffffff")
    expect(rule).not.toContain("rgba(255, 255, 255, 0.9)")
    expect(rule).not.toContain("color: #101010")
    expect(rule).toContain("background-color: rgba(255, 255, 255, 0.18)")
  })

  test("question panel suppresses the default focus outline", async () => {
    const css = await Bun.file(new URL("../../../../../ui/src/components/message-part.css", import.meta.url)).text()
    const block = css.slice(
      css.indexOf('[data-component="dock-prompt"][data-kind="question"] {'),
      css.indexOf('[data-slot="question-body"]'),
    )

    expect(block).toContain("outline: none")
  })

  test("every chip that keeps the saturated token gets a neutral dark override", async () => {
    const css = await Bun.file(new URL("../../../../../ui/src/components/message-part.css", import.meta.url)).text()
    const light = css.slice(
      css.indexOf('[data-component="dock-prompt"][data-kind="question"] {'),
      css.indexOf("@supports (corner-shape: superellipse(1.5))"),
    )
    const dark = css.slice(
      css.indexOf(':root[data-color-scheme="dark"] [data-component="dock-prompt"][data-kind="question"] {'),
    )
    const block = dark.slice(0, dark.indexOf('[data-component="question-answers"]'))
    const neutral = block.slice(block.indexOf('[data-slot="question-key"]'), block.indexOf("#232323"))

    // --surface-interactive-weak 暗色是饱和藏青，剩下的用法只能是 chip 底，且必须逐个被压成中性底
    expect(light.match(/var\(--surface-interactive-weak\)/g)).toHaveLength(3)
    for (const slot of ["question-key", "question-option-badge", "question-option-recommend"]) {
      expect(neutral).toContain(`[data-slot="${slot}"]`)
    }
  })

  test("custom answer row focuses onto the same overlay as the option rows", async () => {
    const css = await Bun.file(new URL("../../../../../ui/src/components/message-part.css", import.meta.url)).text()
    const rule = css.slice(
      css.indexOf('[data-slot="question-custom"]:focus-within {'),
      css.indexOf('[data-slot="question-custom-input"]'),
    )

    expect(rule).toContain("background-color: var(--surface-base-hover)")
    // 面板刚把蓝色焦点全部去掉，这里的 --surface-interactive-weak 暗色是饱和藏青
    expect(rule).not.toContain("var(--surface-interactive-weak)")
    expect(rule).toContain("border-radius: 12px")
  })

  test("the pager arrows and the close button really grey out when disabled", async () => {
    const css = await Bun.file(new URL("../../../../../ui/src/components/message-part.css", import.meta.url)).text()
    const rule = css.slice(
      css.indexOf('[data-slot="question-pager-nav"] [data-component="icon"],'),
      css.indexOf('[data-slot="question-content"]'),
    )

    // icon.css 里 color: var(--icon-base) 是直接声明，按钮上的 color 继承值打不过它
    expect(rule).toContain('[data-slot="question-close"] [data-component="icon"]')
    expect(rule).toContain("color: currentColor")
  })

  test("the header hover fills ride the translucent overlay in both schemes", async () => {
    const css = await Bun.file(new URL("../../../../../ui/src/components/message-part.css", import.meta.url)).text()
    const light = css.slice(
      css.indexOf('[data-component="dock-prompt"][data-kind="question"] {'),
      css.indexOf("@supports (corner-shape: superellipse(1.5))"),
    )
    const dark = css.slice(
      css.indexOf(':root[data-color-scheme="dark"] [data-component="dock-prompt"][data-kind="question"] {'),
    )
    const nav = light.slice(
      light.indexOf('[data-slot="question-pager-nav"] {'),
      light.indexOf('[data-slot="question-close"] {'),
    )
    const close = light.slice(
      light.indexOf('[data-slot="question-close"] {'),
      light.indexOf('[data-slot="question-pager-nav"] [data-component="icon"]'),
    )

    expect(nav).toContain("background-color: var(--surface-base-hover)")
    expect(close).toContain("background-color: var(--surface-base-hover)")
    expect(light).not.toContain("background-color: var(--background-base)")
    expect(dark).not.toContain('[data-slot="question-pager-nav"]:hover:not(:disabled)')
  })

  test("the dark block carries no rule for the ghost button the footer no longer renders", async () => {
    const css = await Bun.file(new URL("../../../../../ui/src/components/message-part.css", import.meta.url)).text()
    const dark = css.slice(
      css.indexOf(':root[data-color-scheme="dark"] [data-component="dock-prompt"][data-kind="question"] {'),
    )
    const block = dark.slice(0, dark.indexOf('[data-component="question-answers"]'))

    expect(block).not.toContain('[data-variant="ghost"]')
  })

  test("the action cluster stays right aligned when the custom row is absent", async () => {
    const css = await Bun.file(new URL("../../../../../ui/src/components/message-part.css", import.meta.url)).text()
    const rule = css.slice(
      css.indexOf('[data-slot="question-footer-actions"] {'),
      css.indexOf('[data-slot="question-key"] {'),
    )

    // custom: false 的题只剩这一个 flex 子元素，space-between 会把它甩到左边
    expect(rule).toContain("margin-left: auto")
  })

  test("the custom row marks itself with the pencil badge instead of a number", async () => {
    const row = await Bun.file(new URL("./question-custom-row.tsx", import.meta.url)).text()
    const css = await Bun.file(new URL("../../../../../ui/src/components/message-part.css", import.meta.url)).text()

    expect(row).toContain('import { QuestionMarker } from "@/pages/session/composer/question-marker"')
    expect(row).toContain('<QuestionMarker variant="pencil" selected={props.picked} />')
    expect(row).not.toContain("question-custom-index")
    expect(css).not.toContain("question-custom-index")
  })

  test("a long pasted answer scrolls inside the custom row instead of squeezing the options", async () => {
    const css = await Bun.file(new URL("../../../../../ui/src/components/message-part.css", import.meta.url)).text()
    const rule = css.slice(
      css.indexOf('[data-slot="question-custom-input"] {'),
      css.indexOf('[data-slot="question-footer"] {'),
    )

    expect(rule).toContain("max-height: 128px")
    expect(rule).toContain("overflow-y: auto")
    expect(rule).not.toContain("overflow: hidden")
  })

  test("a single choice single question panel enters the immediate response mode", async () => {
    const source = await dock()

    expect(source).toContain("const immediate = createMemo(() => total() === 1 && !multi())")
  })

  test("the immediate response mode keeps one secondary button and drops the submit button", async () => {
    const source = await dock()
    const actions = source.slice(
      source.indexOf('<div data-slot="question-footer-actions">'),
      source.indexOf('<div data-slot="question-text-row">'),
    )

    expect(actions).toContain("when={immediate()}")
    expect(actions).toContain('language.t("ui.question.action.skip")')
    expect(actions).toContain('input().trim() ? language.t("ui.common.next")')
    // 提交按钮必须留在 fallback 分支里：immediate() 为真时不能渲染它
    expect(actions.indexOf("fallback={")).toBeLessThan(actions.indexOf('language.t("ui.common.submit")'))
    expect(actions.indexOf('language.t("ui.common.submit")')).toBeLessThan(
      actions.indexOf('language.t("ui.question.action.skip")'),
    )
  })

  test("the immediate response next button commits the free text and advances instead of rejecting it", async () => {
    const source = await dock()
    const actions = source.slice(
      source.indexOf('<div data-slot="question-footer-actions">'),
      source.indexOf('<div data-slot="question-text-row">'),
    )
    const helper = source.slice(source.indexOf("const commitAndAdvance"), source.indexOf("const back ="))

    // 按钮文案「下一步」承诺带着输入前进：onClick 不能在有输入时仍然无条件 reject
    expect(actions).toContain("onClick={() => (input().trim() ? commitAndAdvance() : void reject())}")
    expect(helper).toContain("commitCustom()")
    expect(helper).toContain("next()")
    expect(source).toContain("onEnter={commitAndAdvance}")
  })

  test("the immediate response buttons swallow enter so the panel cannot advance twice", async () => {
    const source = await dock()

    expect(source).toContain('if (event.key === "Enter") event.stopPropagation()')
    expect(source.match(/onKeyDown=\{stopEnter\}/g)).toHaveLength(2)
  })

  test("the close button sits beside the pager in every mode", async () => {
    const source = await dock()
    const header = source.slice(source.indexOf("header={"), source.indexOf("footer={"))

    expect(header).toContain('data-slot="question-close"')
    expect(header).toContain('name="close-small"')
    expect(header).toContain('aria-label={language.t("ui.common.dismiss")}')
    expect(header).toContain("<Show when={total() > 1}>")
    // × 不再依附立即响应模式：四种模式的标题行结构一致
    expect(header).not.toContain("immediate()")
    expect(header).toContain('data-slot="question-header-right"')
    expect(header.indexOf('data-slot="question-pager"')).toBeLessThan(header.indexOf('data-slot="question-close"'))
  })

  test("the escape shortcut moves onto the close button when the ghost dismiss button goes away", async () => {
    const source = await dock()
    const header = source.slice(source.indexOf("header={"), source.indexOf("footer={"))
    const actions = source.slice(
      source.indexOf('<div data-slot="question-footer-actions">'),
      source.indexOf('<div data-slot="question-text-row">'),
    )

    expect(header).toContain('aria-keyshortcuts="Escape"')
    expect(actions).not.toContain('variant="ghost"')
    expect(actions).not.toContain('language.t("ui.common.dismiss")')
    expect(actions).not.toContain("Escape")
    expect(actions).not.toContain('language.t("ui.question.key.escape")')
  })

  test("the header right cluster keeps the pager and the close button on one row", async () => {
    const css = await Bun.file(new URL("../../../../../ui/src/components/message-part.css", import.meta.url)).text()
    const rule = css.slice(
      css.indexOf('[data-slot="question-header-right"] {'),
      css.indexOf('[data-slot="question-pager"] {'),
    )

    expect(rule).toContain("display: flex")
    expect(rule).toContain("align-items: center")
    expect(rule).toContain("flex-shrink: 0")
  })

  test("the close button is a ghost icon button with a focus ring", async () => {
    const css = await Bun.file(new URL("../../../../../ui/src/components/message-part.css", import.meta.url)).text()
    const rule = css.slice(css.indexOf('[data-slot="question-close"] {'), css.indexOf('[data-slot="question-content"]'))

    expect(rule).toContain("border-radius: var(--radius-md)")
    expect(rule).toContain("outline: none")
    expect(rule).toContain("&:focus-visible")
    expect(rule).toContain("&:hover:not(:disabled)")
  })

  test("the dark picked badge is a tinted neutral rather than a white dot", async () => {
    const css = await Bun.file(new URL("../../../../../ui/src/components/message-part.css", import.meta.url)).text()
    const dark = css.slice(
      css.indexOf(':root[data-color-scheme="dark"] [data-component="dock-prompt"][data-kind="question"] {'),
    )
    const block = dark.slice(0, dark.indexOf('[data-component="question-answers"]'))
    const rule = block.slice(block.indexOf('[data-slot="question-marker"][data-picked="true"] {')).slice(0, 260)

    expect(block).toContain('[data-slot="question-marker"][data-picked="true"]')
    expect(rule).toContain("background-color: rgba(255, 255, 255, 0.22)")
    expect(rule).toContain("color: rgba(255, 255, 255, 0.95)")
    expect(rule).not.toContain("var(--text-strong)")
    expect(rule).not.toContain("color: #101010")
  })

  test("the dark picked badge note no longer claims parity with the primary button", async () => {
    const css = await Bun.file(new URL("../../../../../ui/src/components/message-part.css", import.meta.url)).text()
    const dark = css.slice(
      css.indexOf(':root[data-color-scheme="dark"] [data-component="dock-prompt"][data-kind="question"] {'),
    )
    const block = dark.slice(0, dark.indexOf('[data-component="question-answers"]'))

    // 徽章 0.22 叠行底约 #4f4f4f，primary 按钮 0.18 叠 tray 约 #323232，两者差着一个半色阶
    expect(block).not.toContain("与 primary 按钮同一套中性亮底")
  })

  test("the immediate mode enter shares the visible button's verdict when nothing is answered", async () => {
    const source = await dock()
    const state = source.slice(source.indexOf("const keyState"), source.indexOf("const nav = "))

    expect(state).toContain("immediate: immediate()")
    expect(state).toContain("answered:")
    expect(state).toContain("input().trim()")
  })

  test("keeps question choices inside a bounded scroll area", async () => {
    const css = await Bun.file(new URL("../../../../../ui/src/components/message-part.css", import.meta.url)).text()
    const prompt = css.slice(css.indexOf('[data-component="dock-prompt"][data-kind="question"]'), css.indexOf('[data-slot="question-body"]'))
    const options = css.slice(css.indexOf('[data-slot="question-options"]'), css.indexOf('[data-slot="question-option"]'))

    expect(prompt).toContain("max-height: min(var(--question-prompt-max-height, 100dvh), 560px);")
    expect(options).toContain("overflow-y: auto;")
    expect(options).toContain("scrollbar-width: thin;")
    expect(options).toContain("padding: 0 8px 4px;")
  })
})
