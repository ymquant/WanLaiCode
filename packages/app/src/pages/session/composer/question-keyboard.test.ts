import { describe, expect, test } from "bun:test"
import { pickQuestionFocus, resolveQuestionKey, shouldExitCustomRow, type QuestionKeyState } from "./question-keyboard"

const base: QuestionKeyState = {
  tab: 0,
  total: 3,
  optionCount: 4,
  multi: false,
  custom: true,
  focus: 0,
  selected: -1,
  editing: false,
  immediate: false,
  answered: false,
}

const key = (
  k: string,
  mods: Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "repeat", boolean>> = {},
) => ({
  key: k,
  metaKey: mods.metaKey ?? false,
  ctrlKey: mods.ctrlKey ?? false,
  altKey: mods.altKey ?? false,
  shiftKey: mods.shiftKey ?? false,
  repeat: mods.repeat ?? false,
})

describe("resolveQuestionKey", () => {
  test("digit key on single choice picks and advances", () => {
    expect(resolveQuestionKey(key("2"), base)).toEqual({ kind: "pick", index: 1 })
  })

  test("digit key on multi choice toggles without advancing", () => {
    expect(resolveQuestionKey(key("2"), { ...base, multi: true })).toEqual({ kind: "toggle", index: 1 })
  })

  test("digit key past the option count focuses the custom row", () => {
    expect(resolveQuestionKey(key("5"), base)).toEqual({ kind: "customFocus" })
  })

  test("digit key past the custom row does nothing", () => {
    expect(resolveQuestionKey(key("6"), base)).toEqual({ kind: "none" })
  })

  test("digit key past the option count does nothing when custom is off", () => {
    expect(resolveQuestionKey(key("5"), { ...base, custom: false })).toEqual({ kind: "none" })
  })

  test("arrow down on single choice moves the selection", () => {
    expect(resolveQuestionKey(key("ArrowDown"), { ...base, selected: 1 })).toEqual({ kind: "select", index: 2 })
  })

  test("arrow down with nothing selected picks the first option", () => {
    expect(resolveQuestionKey(key("ArrowDown"), base)).toEqual({ kind: "select", index: 0 })
  })

  test("arrow down past the last option focuses the custom row", () => {
    expect(resolveQuestionKey(key("ArrowDown"), { ...base, selected: 3 })).toEqual({ kind: "customFocus" })
  })

  test("arrow down past the last option stays put when custom is off", () => {
    expect(resolveQuestionKey(key("ArrowDown"), { ...base, selected: 3, custom: false })).toEqual({ kind: "none" })
  })

  test("arrow up on single choice moves the selection back", () => {
    expect(resolveQuestionKey(key("ArrowUp"), { ...base, selected: 2 })).toEqual({ kind: "select", index: 1 })
  })

  test("arrow keys on multi choice move focus only", () => {
    expect(resolveQuestionKey(key("ArrowDown"), { ...base, multi: true, focus: 1 })).toEqual({
      kind: "focus",
      index: 2,
    })
  })

  test("space toggles the focused option on multi choice", () => {
    expect(resolveQuestionKey(key(" "), { ...base, multi: true, focus: 2 })).toEqual({ kind: "toggle", index: 2 })
  })

  test("space on the custom row focuses the custom input", () => {
    expect(resolveQuestionKey(key(" "), { ...base, multi: true, focus: 4 })).toEqual({ kind: "customFocus" })
  })

  test("space does nothing on single choice", () => {
    expect(resolveQuestionKey(key(" "), base)).toEqual({ kind: "none" })
  })

  test("arrow right moves to the next question", () => {
    expect(resolveQuestionKey(key("ArrowRight"), base)).toEqual({ kind: "tab", tab: 1 })
  })

  test("arrow left on the first question does nothing", () => {
    expect(resolveQuestionKey(key("ArrowLeft"), base)).toEqual({ kind: "none" })
  })

  test("arrow right on a single question form does nothing", () => {
    expect(resolveQuestionKey(key("ArrowRight"), { ...base, total: 1 })).toEqual({ kind: "none" })
  })

  test("plain enter advances", () => {
    expect(resolveQuestionKey(key("Enter"), base)).toEqual({ kind: "advance" })
  })

  test("cmd enter is not a submit shortcut anymore", () => {
    expect(resolveQuestionKey(key("Enter", { metaKey: true }), base)).toEqual({ kind: "none" })
  })

  test("held enter does not advance again", () => {
    expect(resolveQuestionKey(key("Enter", { repeat: true }), base)).toEqual({ kind: "none" })
  })

  test("enter on an unanswered immediate panel rejects like the skip button next to it", () => {
    expect(resolveQuestionKey(key("Enter"), { ...base, total: 1, immediate: true, answered: false })).toEqual({
      kind: "reject",
    })
  })

  test("enter on an answered immediate panel still submits", () => {
    expect(resolveQuestionKey(key("Enter"), { ...base, total: 1, immediate: true, answered: true })).toEqual({
      kind: "advance",
    })
  })

  test("enter on a multi step panel advances even with nothing answered", () => {
    expect(resolveQuestionKey(key("Enter"), { ...base, immediate: false, answered: false })).toEqual({
      kind: "advance",
    })
  })

  test("a held enter on an unanswered immediate panel rejects nothing", () => {
    expect(
      resolveQuestionKey(key("Enter", { repeat: true }), { ...base, total: 1, immediate: true, answered: false }),
    ).toEqual({ kind: "none" })
  })

  test("held digit key does not pick again", () => {
    expect(resolveQuestionKey(key("2", { repeat: true }), base)).toEqual({ kind: "none" })
    expect(resolveQuestionKey(key("5", { repeat: true }), base)).toEqual({ kind: "none" })
  })

  test("held arrow keys keep moving", () => {
    expect(resolveQuestionKey(key("ArrowDown", { repeat: true }), { ...base, selected: 1 })).toEqual({
      kind: "select",
      index: 2,
    })
    expect(resolveQuestionKey(key("ArrowRight", { repeat: true }), base)).toEqual({ kind: "tab", tab: 1 })
  })

  test("escape rejects", () => {
    expect(resolveQuestionKey(key("Escape"), base)).toEqual({ kind: "reject" })
  })

  test("escape rejects even while editing the custom input", () => {
    expect(resolveQuestionKey(key("Escape"), { ...base, editing: true })).toEqual({ kind: "reject" })
  })

  test("editing swallows every other key", () => {
    expect(resolveQuestionKey(key("ArrowDown"), { ...base, editing: true })).toEqual({ kind: "none" })
    expect(resolveQuestionKey(key("3"), { ...base, editing: true })).toEqual({ kind: "none" })
  })

  test("home and end jump to the edges", () => {
    expect(resolveQuestionKey(key("Home"), { ...base, selected: 2 })).toEqual({ kind: "select", index: 0 })
    expect(resolveQuestionKey(key("End"), { ...base, selected: 0 })).toEqual({ kind: "select", index: 3 })
    expect(resolveQuestionKey(key("End"), { ...base, multi: true, focus: 0 })).toEqual({ kind: "focus", index: 4 })
  })
})

describe("shouldExitCustomRow", () => {
  const caret = (key: string, at = 0, to = at, shiftKey = false) => ({
    key,
    shiftKey,
    selectionStart: at,
    selectionEnd: to,
  })

  test("arrow up leaves the empty custom row", () => {
    expect(shouldExitCustomRow(caret("ArrowUp"))).toBe(true)
  })

  test("arrow up leaves the row when the caret sits before the first character", () => {
    expect(shouldExitCustomRow(caret("ArrowUp", 0))).toBe(true)
  })

  test("arrow up stays inside the row while the caret has somewhere to go", () => {
    expect(shouldExitCustomRow(caret("ArrowUp", 3))).toBe(false)
    expect(shouldExitCustomRow(caret("ArrowUp", 5))).toBe(false)
  })

  test("shift arrow up keeps extending the selection", () => {
    expect(shouldExitCustomRow(caret("ArrowUp", 0, 0, true))).toBe(false)
  })

  test("a selection anchored at the start is not an exit", () => {
    expect(shouldExitCustomRow(caret("ArrowUp", 0, 3))).toBe(false)
  })

  test("other keys never exit", () => {
    expect(shouldExitCustomRow(caret("ArrowDown"))).toBe(false)
    expect(shouldExitCustomRow(caret("Enter"))).toBe(false)
  })
})

describe("pickQuestionFocus", () => {
  test("lands on the option this question already answered", () => {
    expect(pickQuestionFocus({ optionCount: 4, selected: 2, customOn: false })).toBe(2)
  })

  test("lands on the first option when nothing is answered yet", () => {
    expect(pickQuestionFocus({ optionCount: 4, selected: -1, customOn: false })).toBe(0)
  })

  test("never lands on the custom row even when the question has a custom answer", () => {
    expect(pickQuestionFocus({ optionCount: 4, selected: -1, customOn: true })).not.toBe(4)
    expect(pickQuestionFocus({ optionCount: 4, selected: -1, customOn: true })).toBe(0)
    expect(pickQuestionFocus({ optionCount: 4, selected: 3, customOn: true })).toBe(3)
  })

  test("falls back to the panel row zero when the question has no options", () => {
    expect(pickQuestionFocus({ optionCount: 0, selected: -1, customOn: true })).toBe(0)
  })
})
