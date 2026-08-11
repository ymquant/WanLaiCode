import { For, Show, createMemo, onCleanup, onMount, type Component } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@opencode-ai/ui/button"
import { DockPrompt } from "@opencode-ai/ui/dock-prompt"
import { Icon } from "@opencode-ai/ui/icon"
import type { QuestionAnswer, QuestionRequest } from "@opencode-ai/sdk/v2"
import { useLanguage } from "@/context/language"
import { QuestionOption } from "@/pages/session/composer/question-option"
import { QuestionCustomRow } from "@/pages/session/composer/question-custom-row"
import { measureQuestionHeight } from "@/pages/session/composer/question-dock-height"
import { createQuestionReply, questionAnswersWithSelection } from "@/pages/session/composer/question-reply"
import {
  pickQuestionFocus,
  resolveQuestionKey,
  type QuestionKeyState,
} from "@/pages/session/composer/question-keyboard"
import { makeEventListener } from "@solid-primitives/event-listener"
import { createResizeObserver } from "@solid-primitives/resize-observer"

// 立即响应模式的按钮自己吃掉 Enter：面板根节点的委托 keydown 不能把它再当成一次 advance
const stopEnter = (event: KeyboardEvent) => {
  if (event.key === "Enter") event.stopPropagation()
}

const cache = new Map<
  string,
  { tab: number; answers: QuestionAnswer[]; custom: string[]; customOn: boolean[]; visited: number[] }
>()

export const SessionQuestionDock: Component<{ request: QuestionRequest; onSubmit: () => void }> = (props) => {
  const language = useLanguage()

  const questions = createMemo(() => props.request.questions)
  const total = createMemo(() => questions().length)

  const cached = cache.get(props.request.id)
  const [store, setStore] = createStore({
    tab: cached?.tab ?? 0,
    answers: cached?.answers ?? ([] as QuestionAnswer[]),
    custom: cached?.custom ?? ([] as string[]),
    customOn: cached?.customOn ?? ([] as boolean[]),
    visited: cached?.visited ?? [0],
    editing: false,
    focus: 0,
  })

  let root: HTMLDivElement | undefined
  let customRef: HTMLTextAreaElement | undefined
  let optsRef: HTMLButtonElement[] = []
  let replied = false
  let focusFrame: number | undefined

  const question = createMemo(() => questions()[store.tab])
  const options = createMemo(() => question()?.options ?? [])
  const input = createMemo(() => store.custom[store.tab] ?? "")
  const on = createMemo(() => store.customOn[store.tab] === true)
  const multi = createMemo(() => question()?.multiple === true)
  const customEnabled = createMemo(() => question()?.custom !== false)
  const count = createMemo(() => options().length + (customEnabled() ? 1 : 0))

  const last = createMemo(() => store.tab >= total() - 1)
  // 单选单题：点选项即提交，动作区的主按钮退化成「跳过/下一步」
  const immediate = createMemo(() => total() === 1 && !multi())

  const customUpdate = (value: string, selected: boolean = on()) => {
    const prev = input().trim()
    const next = value.trim()

    setStore("custom", store.tab, value)
    if (!selected) return

    if (multi()) {
      setStore("answers", store.tab, (current = []) => {
        const removed = prev ? current.filter((item) => item.trim() !== prev) : current
        if (!next) return removed
        if (removed.some((item) => item.trim() === next)) return removed
        return [...removed, next]
      })
      return
    }

    setStore("answers", store.tab, (current = []) => {
      if (next) return [next]
      // 清空输入只撤掉自由输入自己写进去的那条答案，不动已选中的选项：否则 blur/退出路径路过一次就把选择清了
      return prev && current.some((item) => item.trim() === prev) ? [] : current
    })
  }

  const clamp = (i: number) => Math.max(0, Math.min(count() - 1, i))

  const pickFocus = (tab: number = store.tab) => {
    const list = questions()[tab]?.options ?? []
    return pickQuestionFocus({
      optionCount: list.length,
      selected: list.findIndex((item) => store.answers[tab]?.includes(item.label) ?? false),
      customOn: store.customOn[tab] === true,
    })
  }

  const focus = (i: number) => {
    const target = clamp(i)
    setStore("focus", target)
    // 先取消旧帧再判断分支：否则 customOpen 分支漏取消，旧帧后到时会把焦点从输入框抢走
    if (focusFrame !== undefined) cancelAnimationFrame(focusFrame)
    focusFrame = undefined
    if (options().length > 0 && target === options().length) {
      customOpen()
      return
    }
    focusFrame = requestAnimationFrame(() => {
      focusFrame = undefined
      // 零选项的题没有可落焦的按钮，退回面板根节点，否则焦点落到 body，委托 keydown 再也收不到事件
      ;(optsRef[target] ?? root)?.focus()
    })
  }

  onMount(() => {
    // 零选项的题没有选项按钮，焦点兜底到面板本身，保证委托 keydown 仍能收到事件
    if (root) root.tabIndex = -1

    let raf: number | undefined
    const update = () => {
      if (raf !== undefined) cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        raf = undefined
        if (root) measureQuestionHeight(root)
      })
    }

    update()

    makeEventListener(window, "resize", update)

    const dock = root?.closest('[data-component="session-prompt-dock"]')
    const scroller = document.querySelector(".scroll-view__viewport")
    createResizeObserver([dock, scroller], update)

    onCleanup(() => {
      if (raf !== undefined) cancelAnimationFrame(raf)
    })

    focus(pickFocus())
  })

  onCleanup(() => {
    if (focusFrame !== undefined) cancelAnimationFrame(focusFrame)
    if (replied) return
    cache.set(props.request.id, {
      tab: store.tab,
      answers: store.answers.map((a) => (a ? [...a] : [])),
      custom: store.custom.map((s) => s ?? ""),
      customOn: store.customOn.map((b) => b ?? false),
      visited: [...store.visited],
    })
  })

  const { sending, reply, reject } = createQuestionReply({
    requestID: () => props.request.id,
    sessionID: () => props.request.sessionID,
    onSubmit: () => props.onSubmit(),
    onReplied: () => {
      replied = true
      cache.delete(props.request.id)
    },
  })

  const submit = () => void reply(questions().map((_, i) => store.answers[i] ?? []))

  const revisited = createMemo(() => store.visited.filter((i) => i === store.tab).length > 1)

  // 切题的唯一入口：editing 在这里显式复位，不依赖焦点事件
  const goto = (tab: number) => {
    setStore("tab", tab)
    setStore("visited", (list) => [...list, tab])
    setStore("editing", false)
    focus(pickFocus(tab))
  }

  const picked = (answer: string) => store.answers[store.tab]?.includes(answer) ?? false

  const pick = (answer: string) => {
    setStore("answers", store.tab, [answer])
    setStore("customOn", store.tab, false)
    setStore("editing", false)
  }

  const toggle = (answer: string) => {
    setStore("answers", store.tab, (current = []) => {
      if (current.includes(answer)) return current.filter((item) => item !== answer)
      return [...current, answer]
    })
  }

  // editing 的唯一写真点：只有用户明确要编辑（点自由输入行 / 数字键 N+1 / 键盘模型落到该行）才进入
  const customOpen = () => {
    if (sending()) return
    if (!store.editing) {
      setStore("editing", true)
      if (!on()) setStore("customOn", store.tab, true)
      // 空输入不写答案：单选分支会把已选项覆盖成空，「路过」自由输入行不该动答案
      if (input().trim()) customUpdate(input(), true)
    }
    customRef?.focus()
  }

  // 退出编辑不能回焦自由输入行本身：blur→回焦→再次进入编辑会形成抢焦死循环，目标必须是真实选项下标（pickFocus 保证不越界到 options().length）
  const customEscape = () => {
    setStore("editing", false)
    customRef?.blur()
    focus(pickFocus())
  }

  // ↑ 退出：目标固定为最后一个真实选项（与「末项按 ↓ 进自由输入」对称），同样不能落回自由输入行本身
  const customExit = () => {
    const target = options().length - 1
    if (target < 0) return
    setStore("editing", false)
    customRef?.blur()
    focus(target)
  }

  const keyState = (): QuestionKeyState => ({
    tab: store.tab,
    total: total(),
    optionCount: options().length,
    multi: multi(),
    custom: customEnabled(),
    focus: store.focus,
    selected: options().findIndex((item) => picked(item.label)),
    editing: store.editing,
    immediate: immediate(),
    answered: (store.answers[store.tab]?.length ?? 0) > 0 || !!input().trim(),
  })

  const nav = (event: KeyboardEvent) => {
    if (event.defaultPrevented) return
    if (sending()) return
    // 自由输入框内的按键归 textarea 自己处理，面板导航不得截走用户正在打的字
    if (event.target === customRef) return

    const el = event.target instanceof HTMLElement ? event.target : null
    if (!el || !el.closest('[data-component="dock-prompt"]')) return
    // 行级按键只服务选项区与面板本体（零选项题焦点落在 root）：footer/pager/× 的按钮要留给原生 Enter/Space 激活，
    // 否则焦点在这些按钮上按 Enter 会被 advance 抢走变成提交。Escape 是全局撤销，任何焦点位置都放行
    if (event.key !== "Escape" && el !== root && !el.closest('[data-slot="question-options"]')) return

    const action = resolveQuestionKey(event, keyState())
    if (action.kind === "none") {
      // 键盘模型吞掉的自动重复，默认动作也必须一起吞：选项行是 <button>，长按 Enter 的每次重复都会再触发一次原生 click
      if (event.repeat) event.preventDefault()
      return
    }
    event.preventDefault()

    switch (action.kind) {
      case "reject":
        void reject()
        return
      case "advance":
        next()
        return
      case "tab":
        jump(action.tab)
        return
      case "focus":
        focus(action.index)
        return
      case "select": {
        const opt = options()[action.index]
        if (!opt) return
        pick(opt.label)
        focus(action.index)
        return
      }
      case "pick":
        selectOption(action.index)
        return
      case "toggle": {
        const opt = options()[action.index]
        if (!opt) return
        toggle(opt.label)
        focus(action.index)
        return
      }
      case "customFocus":
        customOpen()
        return
    }
  }

  const selectOption = (optIndex: number) => {
    if (sending()) return

    const opt = options()[optIndex]
    if (!opt) return
    if (multi()) {
      setStore("editing", false)
      toggle(opt.label)
      return
    }
    pick(opt.label)
    if (total() === 1) {
      void reply(questionAnswersWithSelection(questions(), store.answers, store.tab, [opt.label]))
      return
    }
    if (last()) return
    goto(store.tab + 1)
  }

  // blur/提交时的被动收尾：这里同样不能回焦自由输入行，否则与 blur 互相抢焦
  const commitCustom = () => {
    setStore("editing", false)
    customUpdate(input())
  }

  const next = () => {
    if (sending()) return
    if (store.editing) commitCustom()

    if (store.tab >= total() - 1) {
      submit()
      return
    }

    goto(store.tab + 1)
  }

  // Enter 与立即响应模式下「下一步」按钮共用同一条路径：先落自由文本再前进/提交
  const commitAndAdvance = () => {
    commitCustom()
    next()
  }

  const back = () => {
    if (sending()) return
    if (store.tab <= 0) return
    goto(store.tab - 1)
  }

  const jump = (tab: number) => {
    if (sending()) return
    goto(tab)
  }

  const pagerLabel = () =>
    language.t("session.question.progress", { current: Math.min(store.tab + 1, total()), total: total() })

  const hint = () => {
    if (!multi()) return language.t("ui.question.singleHint")
    const chosen = store.answers[store.tab]?.length ?? 0
    if (chosen === 0) return language.t("ui.question.multiHint")
    return language.t("ui.question.multiHint.selected", { count: chosen })
  }

  const title = () => question()?.header || question()?.question || ""
  const showText = () => {
    const info = question()
    return !!info?.header && info.header !== info.question
  }

  return (
    <DockPrompt
      kind="question"
      ref={(el) => (root = el)}
      onKeyDown={nav}
      header={
        <>
          <div data-slot="question-header-title">{title()}</div>
          <div data-slot="question-header-right">
            <Show when={total() > 1}>
              <div data-slot="question-pager">
                <button
                  type="button"
                  data-slot="question-pager-nav"
                  data-dir="prev"
                  disabled={sending() || store.tab <= 0}
                  onClick={back}
                  aria-label={language.t("ui.common.back")}
                >
                  <Icon name="chevron-left" size="small" />
                </button>
                <span data-slot="question-pager-label">{pagerLabel()}</span>
                <button
                  type="button"
                  data-slot="question-pager-nav"
                  data-dir="next"
                  disabled={sending() || last()}
                  onClick={() => jump(store.tab + 1)}
                  aria-label={language.t("ui.common.next")}
                >
                  <Icon name="chevron-right" size="small" />
                </button>
              </div>
            </Show>
            <button
              type="button"
              data-slot="question-close"
              disabled={sending()}
              onClick={reject}
              onKeyDown={stopEnter}
              aria-label={language.t("ui.common.dismiss")}
              aria-keyshortcuts="Escape"
            >
              <Icon name="close-small" size="small" />
            </button>
          </div>
        </>
      }
      footer={
        <>
          <Show when={customEnabled()}>
            <QuestionCustomRow
              label={language.t("ui.messagePart.option.typeOwnAnswer")}
              value={input()}
              placeholder={language.t("ui.question.custom.placeholder")}
              picked={on() && !!input().trim()}
              disabled={sending()}
              ref={(el) => (customRef = el)}
              onOpen={customOpen}
              onFocus={() => {
                setStore("focus", options().length)
                customOpen() // Tab 会直接聚焦 textarea 不经过 onOpen，customOn 置位必须在这里补上
              }}
              onCommit={commitCustom}
              onInput={(value) => customUpdate(value)}
              onEscape={customEscape}
              onExit={customExit}
              onEnter={commitAndAdvance}
            />
          </Show>
          <div data-slot="question-footer-actions">
            <Show
              when={immediate()}
              fallback={
                <Button
                  variant={last() ? "primary" : "secondary"}
                  size="normal"
                  disabled={sending()}
                  onClick={next}
                  aria-keyshortcuts="Enter"
                >
                  {last() ? language.t("ui.common.submit") : language.t("ui.common.next")}
                  <span data-slot="question-key">⏎</span>
                </Button>
              }
            >
              <Button
                variant="secondary"
                size="normal"
                disabled={sending()}
                onClick={() => (input().trim() ? commitAndAdvance() : void reject())}
                onKeyDown={stopEnter}
              >
                {input().trim() ? language.t("ui.common.next") : language.t("ui.question.action.skip")}
              </Button>
            </Show>
          </div>
        </>
      }
    >
      <div data-slot="question-text-row">
        <Show when={showText()}>
          <div data-slot="question-text">{question()?.question}</div>
        </Show>
        <div data-slot="question-hint">{hint()}</div>
      </div>
      <div data-slot="question-options" role={multi() ? "group" : "radiogroup"}>
        <For each={options()}>
          {(opt, i) => (
            <QuestionOption
              index={i()}
              multi={multi()}
              picked={picked(opt.label)}
              label={opt.label}
              description={opt.description}
              badge={revisited() && picked(opt.label) ? language.t("ui.question.badge.selected") : undefined}
              recommendLabel={language.t("ui.question.badge.recommended")}
              disabled={sending()}
              ref={(el) => (optsRef[i()] = el)}
              onFocus={() => setStore("focus", i())}
              onClick={() => selectOption(i())}
            />
          )}
        </For>
      </div>
    </DockPrompt>
  )
}
