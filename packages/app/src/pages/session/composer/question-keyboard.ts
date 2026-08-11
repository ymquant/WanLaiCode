export type QuestionKeyState = {
  tab: number
  total: number
  optionCount: number
  multi: boolean
  custom: boolean
  focus: number
  selected: number
  editing: boolean
  immediate: boolean
  answered: boolean
}

export type QuestionFocusState = {
  optionCount: number
  selected: number
  customOn: boolean
}

export type QuestionKeyEvent = Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "repeat">

export type CustomRowKeyEvent = Pick<KeyboardEvent, "key" | "shiftKey"> & {
  selectionStart: number | null
  selectionEnd: number | null
}

export type QuestionKeyAction =
  | { kind: "none" }
  | { kind: "reject" }
  | { kind: "advance" }
  | { kind: "tab"; tab: number }
  | { kind: "focus"; index: number }
  | { kind: "select"; index: number }
  | { kind: "pick"; index: number }
  | { kind: "toggle"; index: number }
  | { kind: "customFocus" }

const NONE: QuestionKeyAction = { kind: "none" }

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

const lastRow = (state: QuestionKeyState) => state.optionCount + (state.custom ? 1 : 0) - 1

function digit(state: QuestionKeyState, index: number): QuestionKeyAction {
  if (index < state.optionCount) return state.multi ? { kind: "toggle", index } : { kind: "pick", index }
  if (state.custom && index === state.optionCount) return { kind: "customFocus" }
  return NONE
}

function vertical(state: QuestionKeyState, step: number): QuestionKeyAction {
  const last = lastRow(state)
  if (last < 0) return NONE

  if (state.multi) {
    const index = clamp(state.focus + step, 0, last)
    return index === state.focus ? NONE : { kind: "focus", index }
  }

  if (state.optionCount === 0) return state.custom ? { kind: "customFocus" } : NONE
  if (step > 0 && state.custom && state.selected === state.optionCount - 1) return { kind: "customFocus" }

  const from = state.selected === -1 ? (step > 0 ? -1 : state.optionCount) : state.selected
  const index = clamp(from + step, 0, state.optionCount - 1)
  return index === state.selected ? NONE : { kind: "select", index }
}

function edge(state: QuestionKeyState, index: number): QuestionKeyAction {
  if (state.multi) return index === state.focus ? NONE : { kind: "focus", index }
  const bounded = clamp(index, 0, Math.max(0, state.optionCount - 1))
  if (state.optionCount === 0) return NONE
  return bounded === state.selected ? NONE : { kind: "select", index: bounded }
}

// 落焦永远给真实选项行：customOn 故意不参与计算，程序化落到自由输入行会把面板锁进编辑态
export function pickQuestionFocus(state: QuestionFocusState): number {
  if (state.optionCount <= 0) return 0
  return clamp(state.selected, 0, state.optionCount - 1)
}

// ↑ 只在光标塌缩于首字符前时让给面板：此时 textarea 内本就无处可去；多行或光标在中途仍归 textarea 自己移动光标
export function shouldExitCustomRow(event: CustomRowKeyEvent): boolean {
  if (event.key !== "ArrowUp" || event.shiftKey) return false
  return event.selectionStart === 0 && event.selectionEnd === 0
}

export function resolveQuestionKey(event: QuestionKeyEvent, state: QuestionKeyState): QuestionKeyAction {
  if (event.key === "Escape") return { kind: "reject" }
  if (state.editing) return NONE
  if (event.altKey || event.ctrlKey || event.metaKey) return NONE

  // 长按 Enter / 数字键的自动重复必须吞掉：否则一次长按会连着把整张表单带空答案提交完；方向键的重复是连续移动，照常放行
  if (event.key === "Enter") {
    if (event.repeat) return NONE
    // 立即响应模式下可见按钮在无答案时写着「跳过」，Enter 必须给出同一个结果而不是提交一个空答案
    return state.immediate && !state.answered ? { kind: "reject" } : { kind: "advance" }
  }

  if (event.key >= "1" && event.key <= "9") return event.repeat ? NONE : digit(state, Number(event.key) - 1)

  if (event.key === " ") {
    if (!state.multi) return NONE
    if (state.focus < state.optionCount) return { kind: "toggle", index: state.focus }
    return state.custom ? { kind: "customFocus" } : NONE
  }

  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
    if (state.total <= 1) return NONE
    const tab = clamp(state.tab + (event.key === "ArrowRight" ? 1 : -1), 0, state.total - 1)
    return tab === state.tab ? NONE : { kind: "tab", tab }
  }

  if (event.key === "ArrowDown") return vertical(state, 1)
  if (event.key === "ArrowUp") return vertical(state, -1)

  if (event.key === "Home") return edge(state, 0)
  if (event.key === "End") return edge(state, state.multi ? lastRow(state) : state.optionCount - 1)

  return NONE
}
